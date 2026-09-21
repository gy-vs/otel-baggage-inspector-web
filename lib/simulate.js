// Deterministic baggage/trace-context propagation simulator.
//
// Pure function of (input, normalizedConfig): no randomness, no clock.
//
// Per-hop processing model:
//   sender applies edge transform (set / add / delete / rename / drop-all),
//   serializes onto the wire -> receiver hop:
//     1. parse incoming headers (baggage, traceparent, tracestate)
//     2. service sensitive-key deletion
//     3. service allowlist filtering
//     4. service key rename (ordered rules, case sensitivity configurable)
//     5. egress limits: per-member size, member count, total byte size
// Fork: outgoing frames are deep-cloned per edge, branches never share state.
// Join 'isolate' (default): each arrival keeps flowing independently — headers
//   are never merged implicitly.
// Join 'union': explicit merge of all arrivals; duplicate keys keep the first
//   arrival and later ones are reported as merge-conflict.
// Retries: replays of the same edge/frame; baggage result is identical;
//   span id is reused or freshly derived per attempt depending on retrySpan.

import {
  parseBaggage,
  serializeBaggage,
  serializeMember,
  memberByteLength,
} from './baggage.js';
import {
  parseTraceparent,
  formatTraceparent,
  parseTracestate,
  serializeTracestate,
  applyTracestateLimits,
} from './tracecontext.js';
import { percentDecode, percentEncode, utf8ByteLength } from './encoding.js';
import { deriveId, sha256Hex, stableStringify } from './hash.js';

const MAX_HOPS = 500;

const TOKEN_CHARS = new Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
function isToken(s) {
  if (!s) return false;
  for (const c of s) if (!TOKEN_CHARS.has(c)) return false;
  return true;
}
function canonicalKey(key) {
  // Key must serialize as a token; percent-encode anything outside tchar.
  return isToken(key) ? key : percentEncode(key);
}
function makeMember(key, value, properties = []) {
  return {
    key: canonicalKey(String(key)),
    value: value == null ? '' : String(value),
    encodedValue: null, // force canonical percent-encoding on serialization
    quoted: false,
    properties: properties.map((p) => ({
      key: canonicalKey(p.key),
      value: p.value ?? '',
      encodedValue: null,
      quoted: false,
    })),
  };
}

function clone(v) {
  return structuredClone(v);
}

// ---------- config graph helpers ----------

function topoOrder(services, edges) {
  const indeg = new Map(services.map((s) => [s.id, 0]));
  const adj = new Map(services.map((s) => [s.id, []]));
  for (const e of edges) {
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const queue = services.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const v of adj.get(id)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  return order;
}

// ---------- transforms ----------

// Apply one edge transform to a member list.
// Returns { members, events }.
function applyEdgeTransform(members, transform, edgeLabel) {
  if (!transform) return { members, events: [] };
  const events = [];
  let list = members.map((m) => ({ ...m, properties: [...m.properties] }));

  if (transform.dropAll) {
    for (const m of list) {
      events.push({ phase: 'edge-transform', type: 'dropped', key: m.key, reason: 'drop-all', detail: `${edgeLabel}: dropAll` });
    }
    list = [];
  }

  if (transform.setMembers) {
    for (const m of list) {
      events.push({ phase: 'edge-transform', type: 'dropped', key: m.key, reason: 'replaced', detail: `${edgeLabel}: setMembers replaced the baggage list` });
    }
    list = transform.setMembers.map((m) => makeMember(m.key, m.value, m.properties));
    for (const m of list) {
      events.push({ phase: 'edge-transform', type: 'added', key: m.key, detail: `${edgeLabel}: setMembers` });
    }
  }

  // deletes
  for (const key of transform.deleteKeys) {
    const ck = canonicalKey(key);
    const idx = list.findIndex((m) => m.key === ck);
    if (idx === -1) {
      events.push({ phase: 'edge-transform', type: 'delete-unmatched', key: ck, detail: `${edgeLabel}: no such key` });
    } else {
      const [removed] = list.splice(idx, 1);
      events.push({ phase: 'edge-transform', type: 'dropped', key: removed.key, reason: 'edge-deleted', detail: `${edgeLabel}: deleted by transform` });
    }
  }

  // ordered renames on the live list (chains possible; findIndex rescans the
  // whole list per rule so output of rule N can be input of rule N+1)
  for (const r of transform.renameKeys) {
    const from = canonicalKey(r.from);
    const to = canonicalKey(r.to);
    const idx = list.findIndex((m) => m.key === from);
    if (idx === -1) continue;
    const [moved] = list.splice(idx, 1);
    const clash = list.findIndex((m) => m.key === to);
    if (clash !== -1) {
      const [victim] = list.splice(clash, 1);
      events.push({ phase: 'edge-transform', type: 'dropped', key: victim.key, reason: 'rename-collision', detail: `${edgeLabel}: overwritten when ${from} -> ${to}` });
    }
    moved.key = to;
    moved.encodedValue = null;
    list.push(moved);
    events.push({ phase: 'edge-transform', type: 'renamed', from, to, detail: edgeLabel });
  }

  // adds (ordered; same key overwrites)
  for (const spec of transform.addMembers) {
    const ck = canonicalKey(spec.key);
    const idx = list.findIndex((m) => m.key === ck);
    if (idx !== -1) {
      const [old] = list.splice(idx, 1);
      events.push({ phase: 'edge-transform', type: 'dropped', key: old.key, reason: 'overwritten', detail: `${edgeLabel}: addMembers overwrote key` });
    }
    list.push(makeMember(spec.key, spec.value, spec.properties));
    events.push({ phase: 'edge-transform', type: 'added', key: ck, detail: edgeLabel });
  }

  return { members: list, events };
}

function keyEq(a, b, ignoreCase) {
  return ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Apply receiving-service policy + egress limits.
function applyServicePolicy(members, svc, edgeEvents) {
  const events = [...edgeEvents];
  const dropped = [];
  let list = members.map((m) => ({ ...m, properties: [...m.properties] }));

  // 1. sensitive key deletion (values never copied anywhere)
  if (svc.sensitiveKeys.length) {
    list = list.filter((m) => {
      if (svc.sensitiveKeys.some((k) => keyEq(m.key, canonicalKey(k), svc.ignoreCase))) {
        events.push({ phase: 'sensitive', type: 'dropped', key: m.key, reason: 'sensitive-key-removed', detail: `service ${svc.id} deletes sensitive keys` });
        dropped.push({ key: m.key, reason: 'sensitive-key-removed', phase: 'sensitive' });
        return false;
      }
      return true;
    });
  }

  // 2. allowlist
  if (svc.allowlist && svc.allowlist.length) {
    const allowed = svc.allowlist.map(canonicalKey);
    list = list.filter((m) => {
      if (!allowed.some((a) => keyEq(a, m.key, svc.ignoreCase))) {
        events.push({ phase: 'allowlist', type: 'dropped', key: m.key, reason: 'not-in-allowlist', detail: `service ${svc.id} allowlist` });
        dropped.push({ key: m.key, reason: 'not-in-allowlist', phase: 'allowlist' });
        return false;
      }
      return true;
    });
  }

  // 3. rename (ordered; chains possible, so findIndex rescans the live list
  // after each rule — an earlier rule may have produced this rule's `from`)
  for (const r of svc.rename) {
    const from = canonicalKey(r.from);
    const to = canonicalKey(r.to);
    const idx = list.findIndex((m) => keyEq(m.key, from, svc.ignoreCase));
    if (idx === -1) continue;
    const [moved] = list.splice(idx, 1);
    const clash = list.findIndex((m) => m.key === to);
    if (clash !== -1) {
      const [victim] = list.splice(clash, 1);
      events.push({ phase: 'rename', type: 'dropped', key: victim.key, reason: 'rename-collision', detail: `service ${svc.id}: overwritten when ${from} -> ${to}` });
      dropped.push({ key: victim.key, reason: 'rename-collision', phase: 'rename' });
    }
    moved.key = to;
    moved.encodedValue = null;
    list.push(moved);
    events.push({ phase: 'rename', type: 'renamed', from, to, detail: `service ${svc.id}` });
  }

  // 4. limits: per-member size
  const limits = svc.limits;
  list = list.filter((m) => {
    if (limits.maxMemberBytes > 0 && memberByteLength(m) > limits.maxMemberBytes) {
      events.push({ phase: 'egress-limit', type: 'dropped', key: m.key, reason: 'member-size-limit', bytes: memberByteLength(m), limit: limits.maxMemberBytes, detail: `single member exceeds ${limits.maxMemberBytes} bytes` });
      dropped.push({ key: m.key, reason: 'member-size-limit', phase: 'egress-limit', bytes: memberByteLength(m) });
      return false;
    }
    return true;
  });

  // 4b. member count (tail dropped)
  if (limits.maxMembers > 0 && list.length > limits.maxMembers) {
    const excess = list.splice(limits.maxMembers);
    for (const m of excess) {
      events.push({ phase: 'egress-limit', type: 'dropped', key: m.key, reason: 'member-count-limit', limit: limits.maxMembers, detail: `more than ${limits.maxMembers} members` });
      dropped.push({ key: m.key, reason: 'member-count-limit', phase: 'egress-limit' });
    }
  }

  // 4c. total bytes, greedy prefix in current order
  if (limits.maxTotalBytes > 0) {
    const kept = [];
    let total = 0;
    for (const m of list) {
      const extra = (kept.length ? 1 : 0) + memberByteLength(m);
      if (total + extra > limits.maxTotalBytes) {
        events.push({ phase: 'egress-limit', type: 'dropped', key: m.key, reason: 'total-size-limit', bytes: total + extra, limit: limits.maxTotalBytes, detail: `header would exceed ${limits.maxTotalBytes} bytes` });
        dropped.push({ key: m.key, reason: 'total-size-limit', phase: 'egress-limit', bytes: total + extra });
        continue;
      }
      total += extra;
      kept.push(m);
    }
    list = kept;
  }

  return { members: list, events, dropped };
}

// ---------- union merge ----------

function unionMerge(frames, svc, arrivalHopNos) {
  const events = [];
  const merged = [];
  const seen = new Set();
  frames.forEach((frame, i) => {
    for (const m of frame.members) {
      if (seen.has(m.key)) {
        events.push({
          phase: 'merge', type: 'dropped', key: m.key, reason: 'merge-conflict',
          detail: `arrival ${i + 1} duplicates key already merged; first arrival wins`,
        });
      } else {
        seen.add(m.key);
        merged.push(clone(m));
      }
    }
  });
  // tracestate: concatenate unique keys in arrival order
  const tstate = [];
  const tseen = new Set();
  for (const f of frames) {
    for (const t of f.tracestate) {
      if (tseen.has(t.key)) {
        events.push({ phase: 'merge', type: 'dropped', key: t.key, reason: 'tracestate-merge-conflict', detail: 'duplicate tracestate key in merge' });
      } else {
        tseen.add(t.key);
        tstate.push(clone(t));
      }
    }
  }
  // traceparent: must be the same trace; union merge is meaningless across traces
  const traceIds = new Set(frames.map((f) => f.trace.traceId));
  const warnings = [];
  if (traceIds.size > 1) {
    warnings.push('arrivals belong to different traces; merged header keeps the first trace context');
    events.push({ phase: 'merge', type: 'trace-mismatch', reason: 'trace-mismatch-merge', detail: [...traceIds].join(', ') });
  }
  const first = frames[0];
  return {
    members: merged,
    tracestate: tstate,
    trace: clone(first.trace),
    events,
    warnings,
  };
}

// ---------- main simulator ----------

export function simulate(runInput, config, opts = {}) {
  const seed = opts.seed ?? `${sha256Hex(stableStringify(runInput))}:${sha256Hex(stableStringify(config))}`;
  const svcById = new Map(config.services.map((s) => [s.id, s]));
  const outgoing = new Map(config.services.map((s) => [s.id, []]));
  const incoming = new Map(config.services.map((s) => [s.id, []]));
  config.edges.forEach((e, i) => {
    outgoing.get(e.from).push({ ...e, edgeId: i });
    incoming.get(e.to).push({ ...e, edgeId: i });
  });

  const hops = [];
  const order = topoOrder(config.services, config.edges);

  // arrivals: serviceId -> [{ edge, frames: [frame,...] }] in config edge order
  const arrivals = new Map(config.services.map((s) => [s.id, []]));

  const rootSpecs = runInput.roots
    ? runInput.roots.map((r, i) => ({ ...r, _index: i }))
    : [{ _index: 0, service: runInput.startService ?? config.services[0].id,
         baggageHeaders: runInput.baggageHeaders, baggageMembers: runInput.baggageMembers,
         traceparent: runInput.traceparent, tracestate: runInput.tracestate }];

  for (const spec of rootSpecs) {
    const startSvc = spec.service ?? config.services[0].id;
    if (!svcById.has(startSvc)) {
      return { ok: false, error: `startService not found: ${startSvc}` };
    }
    const rootEvents = [];
    let rootMembers = [];
    if (spec.baggageHeaders !== undefined) {
      const parsed = parseBaggage(spec.baggageHeaders);
      rootMembers = parsed.members;
      for (const d of parsed.dropped) {
        rootEvents.push({ phase: 'parse', type: 'dropped', reason: d.reason, key: d.key, raw: d.raw, detail: d.detail });
      }
    } else if (spec.baggageMembers) {
      rootMembers = spec.baggageMembers.map((m) => makeMember(m.key, m.value, m.properties));
    }

    let rootTrace;
    if (spec.traceparent) {
      const tp = parseTraceparent(spec.traceparent);
      if (tp.ok) {
        rootTrace = { version: tp.version, traceId: tp.traceId, parentSpanId: tp.spanId, flags: tp.flags };
      } else {
        rootEvents.push({ phase: 'trace', type: 'invalid-traceparent', reason: 'invalid-traceparent', detail: tp.detail });
        rootTrace = newTrace(`${seed}:root${spec._index}`);
        rootEvents.push({ phase: 'trace', type: 'new-trace', traceId: rootTrace.traceId, detail: 'started a new trace' });
      }
    } else {
      rootTrace = newTrace(`${seed}:root${spec._index}`);
      rootEvents.push({ phase: 'trace', type: 'new-trace', traceId: rootTrace.traceId, detail: 'no traceparent at root; started a new trace' });
    }

    let rootTstate = [];
    if (spec.tracestate) {
      const ts = parseTracestate(spec.tracestate);
      for (const d of ts.dropped) {
        rootEvents.push({ phase: 'parse', type: 'dropped', reason: d.reason, key: d.key, raw: d.raw, detail: 'tracestate parse' });
      }
      rootTstate = ts.members;
    }

    arrivals.get(startSvc).push({
      edge: null,
      frames: [{
        members: rootMembers,
        trace: { ...rootTrace, spanId: deriveId('span', `${seed}:root${spec._index}`, 0) },
        tracestate: rootTstate,
        path: [`root${spec._index}`],
        edgeEvents: rootEvents,
      }],
    });
  }

  let hopCounter = 0;
  for (const svcId of order) {
    const svc = svcById.get(svcId);
    const groups = arrivals.get(svcId);
    if (!groups.length) continue;

    const processed = []; // frames after service policy
    for (const group of groups) {
      for (const frame of group.frames) {
        const attemptsTotal = group.edge ? group.edge.retries + 1 : 1;
        for (let attempt = 0; attempt < attemptsTotal; attempt++) {
          if (hops.length >= MAX_HOPS) {
            return { ok: false, error: `hop limit (${MAX_HOPS}) exceeded; graph likely fans out too widely under isolate joins` };
          }
          const hopNo = hopCounter++;
          const spanSeedBase = deriveId('span', seed, hopNo - attempt);
          const spanId = group.edge && group.edge.retrySpan === 'reuse'
            ? spanSeedBase
            : deriveId('span', seed, hopNo);
          const events = clone(frame.edgeEvents ?? []);
          if (attempt > 0) {
            events.push({ phase: 'retry', type: 'retry-attempt', attempt, detail: `retry attempt ${attempt} of ${group.edge.retries}` });
          }
          const tstateLimited = applyTracestateLimits(frame.tracestate);
          for (const d of tstateLimited.dropped) {
            events.push({ phase: 'parse', type: 'dropped', reason: d.reason, key: d.key, detail: d.detail });
          }
          const { members: egressMembers, events: policyEvents, dropped } = applyServicePolicy(
            frame.members, svc, events
          );
          const flags = frame.trace.flags ?? '01';
          const ingressBaggage = serializeBaggage(frame.members);
          const egressBaggage = serializeBaggage(egressMembers);
          const incomingEdges = incoming.get(svcId);
          const joinInfo = incomingEdges.length >= 2
            ? { merge: svc.merge, arrivalCount: totalFrameCount(groups), arrivalIndex: frameArrivalIndex(groups, group, frame) }
            : null;

          const hop = {
            hopNo,
            kind: group.edge ? 'transmission' : 'root',
            serviceId: svcId,
            edgeId: group.edge ? group.edge.edgeId : null,
            fromServiceId: group.edge ? group.edge.from : null,
            attempt,
            attemptsTotal,
            branchPath: [...frame.path],
            incoming: {
              members: clone(frame.members),
              baggage: ingressBaggage,
              byteSize: utf8ByteLength(ingressBaggage),
              traceparent: formatTraceparent({
                version: frame.trace.version ?? '00',
                traceId: frame.trace.traceId,
                spanId: frame.trace.parentSpanId ?? frame.trace.spanId,
                flags,
              }),
              tracestate: serializeTracestate(tstateLimited.members),
            },
            outgoing: {
              members: clone(egressMembers),
              baggage: egressBaggage,
              byteSize: utf8ByteLength(egressBaggage),
              traceparent: formatTraceparent({
                version: frame.trace.version ?? '00',
                traceId: frame.trace.traceId,
                spanId,
                flags,
              }),
              tracestate: serializeTracestate(tstateLimited.members),
            },
            trace: {
              traceId: frame.trace.traceId,
              spanId,
              parentSpanId: frame.trace.parentSpanId ?? null,
              flags,
              sampled: (parseInt(flags, 16) & 1) === 1,
              reusedSpan: Boolean(group.edge && attempt > 0 && group.edge.retrySpan === 'reuse'),
            },
            dropped,
            events: policyEvents,
            join: joinInfo,
          };
          hops.push(hop);

          if (attempt === 0) {
            processed.push({
              members: egressMembers,
              trace: { ...frame.trace, spanId, parentSpanId: frame.trace.spanId ?? frame.trace.parentSpanId },
              tracestate: tstateLimited.members,
              path: [...frame.path, hopNo],
            });
          }
        }
      }
    }

    // Join semantics: union merges explicitly; isolate keeps frames apart.
    let outputFrames;
    if (svc.merge === 'union' && incoming.get(svcId).length >= 2 && processed.length >= 2) {
      const arrivalHopNos = hops.filter((h) => h.serviceId === svcId && h.kind === 'transmission' && h.attempt === 0).map((h) => h.hopNo);
      const merged = unionMerge(processed, svc, arrivalHopNos);
      // apply the join service limits once on the merged header
      const limited = applyServicePolicy(merged.members, svc, merged.events);
      const hopNo = hopCounter++;
      const spanId = deriveId('span', seed, hopNo);
      const trace = { ...processed[0].trace, spanId, parentSpanId: processed[0].trace.spanId };
      const mergedBaggage = serializeBaggage(limited.members);
      const hop = {
        hopNo,
        kind: 'merge',
        serviceId: svcId,
        edgeId: null,
        fromServiceId: null,
        attempt: 0,
        attemptsTotal: 1,
        branchPath: processed.map((f) => f.path),
        incoming: { members: [], baggage: null, byteSize: null, traceparent: null, tracestate: null, note: `union of ${processed.length} arrivals` },
        outgoing: {
          members: clone(limited.members),
          baggage: mergedBaggage,
          byteSize: utf8ByteLength(mergedBaggage),
          traceparent: formatTraceparent({ traceId: trace.traceId, spanId, flags: trace.flags ?? '01' }),
          tracestate: serializeTracestate(merged.tracestate),
        },
        trace: { traceId: trace.traceId, spanId, parentSpanId: trace.parentSpanId ?? null, flags: trace.flags ?? '01', sampled: true, reusedSpan: false },
        dropped: limited.dropped,
        events: limited.events,
        join: { merge: 'union', arrivalCount: processed.length, arrivalHopNos, warnings: merged.warnings },
      };
      hops.push(hop);
      outputFrames = [{ members: limited.members, trace, tracestate: merged.tracestate, path: [hopNo] }];
    } else {
      outputFrames = processed;
    }

    // Fan out: clone per edge, apply the edge transform at send time.
    // branchPath records edge ids (eN) so sibling forks are distinguishable
    // even when their hop numbers coincide.
    for (const edge of outgoing.get(svcId)) {
      for (const f of outputFrames) {
        const label = `${edge.from}->${edge.to}`;
        const { members, events } = applyEdgeTransform(f.members, edge.transform, label);
        arrivals.get(edge.to).push({
          edge,
          frames: [{
            ...clone(f),
            members,
            edgeEvents: events,
            path: [...f.path, `e${edge.edgeId}`],
            trace: { ...f.trace, parentSpanId: f.trace.spanId },
          }],
        });
      }
    }
  }

  const resultHash = sha256Hex(stableStringify({
    hops: hops.map((h) => ({
      s: h.serviceId, e: h.edgeId, a: h.attempt,
      out: h.outgoing.baggage, tp: h.outgoing.traceparent, ts: h.outgoing.tracestate,
      dropped: h.dropped.map((d) => `${d.key ?? ''}:${d.reason}`),
    })),
  }));

  return {
    ok: true,
    seed,
    hops,
    services: config.services.map((s) => s.id),
    resultHash,
  };
}

function newTrace(seed) {
  return { version: '00', traceId: deriveId('trace', seed), parentSpanId: null, flags: '01' };
}
function totalFrameCount(groups) {
  return groups.reduce((n, g) => n + g.frames.length, 0);
}
function frameArrivalIndex(groups, currentGroup, frame) {
  let idx = 0;
  for (const g of groups) {
    for (const f of g.frames) {
      if (g === currentGroup && f === frame) return idx + 1;
      idx++;
    }
  }
  return idx + 1;
}
