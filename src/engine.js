// Propagation engine: per-hop transform pipeline and graph execution.
// Everything here is deterministic — identical (graph revision, entry)
// always yields byte-identical results.
import { parseBaggage, serializeBaggage, serializeMember, memberByteLength } from './baggage.js';
import {
  parseTraceparent,
  formatTraceparent,
  parseTracestate,
  serializeTracestate,
  deriveId,
} from './tracecontext.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxTotalBytes: 8192,
  maxMembers: 180,
  maxMemberBytes: 1024,
});

export const REDACTED = '[REDACTED]';

const MAX_HOPS_PER_RUN = 500;

// Effective config for a hop = target service config, overridden per-edge.
export function mergeConfig(serviceConfig = {}, edgeOverrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(serviceConfig.limits || {}), ...(edgeOverrides.limits || {}) };
  return {
    allowlist: edgeOverrides.allowlist !== undefined ? edgeOverrides.allowlist : (serviceConfig.allowlist ?? null),
    renames: { ...(serviceConfig.renames || {}), ...(edgeOverrides.renames || {}) },
    sensitive: edgeOverrides.sensitive !== undefined ? edgeOverrides.sensitive : (serviceConfig.sensitive || []),
    set: { ...(serviceConfig.set || {}), ...(edgeOverrides.set || {}) },
    limits,
  };
}

// Rebuild a raw baggage header with the values of the given keys replaced
// by REDACTED. Non-redacted members keep their original raw encoding.
function redactRawBaggage(header, keysToRedact) {
  const { members } = parseBaggage(header);
  return members
    .map((m) => {
      if (keysToRedact.has(m.key)) {
        let out = `${m.key}=${REDACTED}`;
        for (const p of m.properties) {
          out += '; ' + p.key + (p.rawValue !== null ? '=' + p.rawValue : '');
        }
        return out;
      }
      let out = `${m.key}=${m.rawValue}`;
      for (const p of m.properties) {
        out += '; ' + p.key + (p.rawValue !== null ? '=' + p.rawValue : '');
      }
      return out;
    })
    .join(', ');
}

// Run one hop: parse -> dedupe -> sensitive removal -> allowlist -> rename
// -> set/overwrite -> limits. Returns a fully self-describing hop record.
// collect.sensitiveValues (optional Set) receives the real values of
// sensitive-dropped members OUT OF BAND, so the caller can scrub them from
// the rest of the run record (entry headers, earlier hops) — they are never
// part of the returned record itself.
export function processHop({ input, config, seed, collect }) {
  const events = [];
  const droppedSensitiveKeys = new Set();

  // 1. parse
  const { members, diagnostics } = parseBaggage(input.baggage);
  for (const d of diagnostics) events.push({ type: 'parse', ...d });
  const entries = members.map((m) => ({
    key: m.key,
    outKey: m.key,
    value: m.value,
    rawValue: m.rawValue,
    properties: m.properties,
    issues: m.issues,
    status: null,
    reason: null,
    origin: 'header',
  }));

  // 2. duplicate keys: first occurrence wins, later ones dropped.
  const seenKeys = new Set();
  for (const e of entries) {
    if (e.status) continue;
    if (seenKeys.has(e.key)) {
      e.status = 'dropped';
      e.reason = 'duplicate-key';
      events.push({ type: 'drop', key: e.key, reason: 'duplicate-key' });
    } else {
      seenKeys.add(e.key);
    }
  }

  // 3. sensitive key removal (values redacted everywhere in the record).
  const sensitive = new Set(config.sensitive || []);
  for (const e of entries) {
    if (e.status) continue;
    if (sensitive.has(e.key)) {
      e.status = 'dropped';
      e.reason = 'sensitive-removed';
      if (collect?.sensitiveValues) {
        if (e.value) collect.sensitiveValues.add(e.value);
        for (const p of e.properties || []) {
          if (p.value) collect.sensitiveValues.add(p.value);
        }
      }
      e.value = REDACTED;
      e.rawValue = REDACTED;
      for (const p of e.properties || []) {
        if (p.value !== null) {
          p.value = REDACTED;
          p.rawValue = REDACTED;
        }
      }
      droppedSensitiveKeys.add(e.key);
      events.push({ type: 'drop', key: e.key, reason: 'sensitive-removed' });
    }
  }

  // 4. allowlist
  if (config.allowlist !== null && config.allowlist !== undefined) {
    const allowed = new Set(config.allowlist);
    for (const e of entries) {
      if (e.status) continue;
      if (!allowed.has(e.key)) {
        e.status = 'dropped';
        e.reason = 'not-in-allowlist';
        events.push({ type: 'drop', key: e.key, reason: 'not-in-allowlist' });
      }
    }
  }

  // 5. renames (collisions: first surviving key wins)
  const taken = new Set();
  for (const e of entries) {
    if (e.status) continue;
    const newKey = config.renames[e.key] ?? e.key;
    if (newKey !== e.key) {
      e.renamedFrom = e.key;
      e.outKey = newKey;
      events.push({ type: 'rename', from: e.key, to: newKey });
    }
    if (taken.has(e.outKey)) {
      e.status = 'dropped';
      e.reason = 'rename-collision';
      events.push({ type: 'drop', key: e.outKey, reason: 'rename-collision' });
    } else {
      taken.add(e.outKey);
    }
  }

  // 6. set / overwrite (applied in sorted-key order for determinism)
  for (const k of Object.keys(config.set || {}).sort()) {
    const v = String(config.set[k]);
    const existing = entries.find((e) => !e.status && e.outKey === k);
    if (existing) {
      existing.previousValue = existing.value;
      existing.value = v;
      existing.rawValue = null;
      existing.status = 'overwritten';
      existing.reason = 'set-by-config';
      events.push({ type: 'overwrite', key: k, previousValue: existing.previousValue });
    } else {
      entries.push({
        key: k,
        outKey: k,
        value: v,
        rawValue: null,
        properties: [],
        issues: [],
        status: 'added',
        reason: 'set-by-config',
        origin: 'set',
      });
      taken.add(k);
      events.push({ type: 'add', key: k });
    }
  }

  // 7. limits
  const limits = config.limits;
  const survivors = () => entries.filter((e) => e.status !== 'dropped');

  for (const e of survivors()) {
    const size = memberByteLength({ key: e.outKey, value: e.value, rawValue: e.rawValue, properties: e.properties, issues: e.issues });
    e.serializedBytes = size;
    if (size > limits.maxMemberBytes) {
      e.status = 'dropped';
      e.reason = 'member-too-large';
      events.push({ type: 'drop', key: e.outKey, reason: 'member-too-large', bytes: size, limit: limits.maxMemberBytes });
    }
  }
  // member count: drop from the tail
  let live = survivors();
  if (live.length > limits.maxMembers) {
    const excess = live.slice(limits.maxMembers);
    for (const e of excess) {
      e.status = 'dropped';
      e.reason = 'too-many-members';
      events.push({ type: 'drop', key: e.outKey, reason: 'too-many-members', limit: limits.maxMembers });
    }
  }
  // total length: drop from the tail until it fits
  const totalBytes = () => {
    const s = serializeBaggage(
      survivors().map((e) => ({ key: e.outKey, value: e.value, rawValue: e.rawValue, properties: e.properties, issues: e.issues }))
    );
    return Buffer.byteLength(s, 'utf8');
  };
  while (survivors().length > 0 && totalBytes() > limits.maxTotalBytes) {
    const liveNow = survivors();
    const victim = liveNow[liveNow.length - 1];
    victim.status = 'dropped';
    victim.reason = 'total-length-exceeded';
    events.push({ type: 'drop', key: victim.outKey, reason: 'total-length-exceeded', limit: limits.maxTotalBytes });
  }

  for (const e of entries) {
    if (!e.status) e.status = 'preserved';
  }

  // trace context
  const tp = parseTraceparent(input.traceparent);
  for (const d of tp.diagnostics) events.push({ type: 'trace', ...d });
  let outCtx;
  let traceEvent;
  if (tp.context) {
    outCtx = {
      version: tp.context.version,
      traceId: tp.context.traceId,
      spanId: deriveId(`${seed}|span`, 16),
      flags: tp.context.flags,
      sampled: tp.context.sampled,
    };
    traceEvent = 'trace-continued';
  } else {
    outCtx = {
      version: '00',
      traceId: deriveId(`${seed}|trace`, 32),
      spanId: deriveId(`${seed}|span`, 16),
      flags: '01',
      sampled: true,
    };
    traceEvent = 'new-trace';
  }
  events.push({ type: 'trace', code: traceEvent, traceId: outCtx.traceId, spanId: outCtx.spanId });

  const ts = parseTracestate(input.tracestate);
  for (const d of ts.diagnostics) events.push({ type: 'tracestate', ...d });

  const outputMembers = survivors();
  const outputBaggage = serializeBaggage(
    outputMembers.map((e) => ({ key: e.outKey, value: e.value, rawValue: e.rawValue, properties: e.properties, issues: e.issues }))
  );

  const inputBaggageRecord =
    droppedSensitiveKeys.size > 0 ? redactRawBaggage(input.baggage, droppedSensitiveKeys) : (input.baggage ?? '');

  return {
    input: {
      baggage: inputBaggageRecord,
      baggageRedacted: droppedSensitiveKeys.size > 0,
      traceparent: input.traceparent ?? '',
      tracestate: input.tracestate ?? '',
    },
    output: {
      baggage: outputBaggage,
      traceparent: formatTraceparent(outCtx),
      tracestate: serializeTracestate(ts.members),
    },
    members: entries.map((e) => ({
      key: e.key,
      outKey: e.outKey,
      value: e.value,
      properties: e.properties,
      issues: e.issues,
      status: e.status,
      reason: e.reason,
      ...(e.renamedFrom ? { renamedFrom: e.renamedFrom } : {}),
      ...(e.previousValue !== undefined ? { previousValue: e.previousValue } : {}),
      ...(e.serializedBytes !== undefined ? { serializedBytes: e.serializedBytes } : {}),
    })),
    events,
    trace: {
      traceId: outCtx.traceId,
      spanId: outCtx.spanId,
      parentSpanId: tp.context ? tp.context.spanId : null,
      sampled: outCtx.sampled,
      continued: !!tp.context,
    },
    limitsApplied: limits,
  };
}

// Topological order (Kahn). Throws Error('cycle') if the graph is not a DAG.
export function topoOrder(graph) {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = graph.nodes.map((n) => n.id).filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  const outEdges = new Map();
  for (const e of graph.edges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source).push(e);
  }
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    const next = (outEdges.get(id) || []).map((e) => e.target).sort();
    for (const t of next) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) {
        // keep the frontier sorted for deterministic traversal
        queue.push(t);
        queue.sort();
      }
    }
  }
  if (order.length !== graph.nodes.length) {
    const err = new Error('graph contains a cycle');
    err.code = 'CYCLE';
    throw err;
  }
  return order;
}

// Execute the graph. entry = { node, headers: { baggage, traceparent, tracestate } }
// runSeed pins all derived ids (span ids, trace ids) deterministically.
export function runGraph(graph, entry, runSeed) {
  const order = topoOrder(graph);
  if (!graph.nodes.some((n) => n.id === entry.node)) {
    const err = new Error(`unknown entry node: ${entry.node}`);
    err.code = 'BAD_ENTRY';
    throw err;
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map();
  for (const e of graph.edges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source).push(e);
  }
  for (const list of outEdges.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));

  const arrivals = new Map(); // nodeId -> [state]
  const start = {
    pathId: 'p1',
    baggage: entry.headers.baggage ?? '',
    traceparent: entry.headers.traceparent ?? '',
    tracestate: entry.headers.tracestate ?? '',
  };
  arrivals.set(entry.node, [start]);

  const hops = [];
  let hopCounter = 0;
  const collect = { sensitiveValues: new Set() };

  for (const nodeId of order) {
    const states = arrivals.get(nodeId) || [];
    const edges = outEdges.get(nodeId) || [];
    for (const state of states) {
      const branch = edges.length > 1;
      for (const edge of edges) {
        const config = mergeConfig(nodeById.get(edge.target)?.config, edge.overrides);
        const attempts = Math.max(1, Math.min(5, edge.attempts || 1));
        const pathId = branch ? `${state.pathId}>${edge.id}` : state.pathId;
        let lastResult = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          if (hops.length >= MAX_HOPS_PER_RUN) {
            const err = new Error('run exceeds hop limit');
            err.code = 'RUN_TOO_LARGE';
            throw err;
          }
          // A retry re-sends the SAME original headers; each attempt gets a
          // fresh span id (seed includes the attempt number) but identical
          // baggage in and out — retries are deterministic.
          const seed = `${runSeed}|${pathId}|${edge.id}|${attempt}`;
          lastResult = processHop({ input: state, config, seed, collect });
          hops.push({
            hopId: `h${++hopCounter}`,
            pathId,
            edgeId: edge.id,
            source: edge.source,
            target: edge.target,
            attempt,
            attempts,
            ...lastResult,
          });
        }
        const next = {
          pathId,
          baggage: lastResult.output.baggage,
          traceparent: lastResult.output.traceparent,
          tracestate: lastResult.output.tracestate,
        };
        if (!arrivals.has(edge.target)) arrivals.set(edge.target, []);
        arrivals.get(edge.target).push(next);
      }
    }
  }

  // Join report: nodes with >1 inbound edge keep every arriving state
  // isolated — headers are never merged across branches.
  const joins = [];
  for (const node of graph.nodes) {
    const inbound = graph.edges.filter((e) => e.target === node.id);
    if (inbound.length > 1) {
      joins.push({
        node: node.id,
        inboundEdges: inbound.map((e) => e.id).sort(),
        isolatedStates: (arrivals.get(node.id) || []).map((s) => s.pathId),
        note: 'states kept isolated; headers are never merged at joins',
      });
    }
  }

  return { hops, joins, sensitiveValues: collect.sensitiveValues };
}

// Backstop redaction: remove every occurrence of a sensitive-deleted value
// from the baggage-carrying string fields of a run record (entry headers,
// earlier hops where the key was not yet deleted, renamed copies, etc.).
// Over-redaction inside baggage strings is deliberate — the safe direction.
// Trace/span ids and key names are never touched.
export function scrubRunRecord(run, sensitiveValues) {
  const values = [...(sensitiveValues || [])].filter((v) => typeof v === 'string' && v.length > 0);
  if (values.length === 0) return run;
  values.sort((a, b) => b.length - a.length); // longest first
  const scrub = (s) => {
    if (typeof s !== 'string' || s === '') return s;
    let out = s;
    for (const v of values) out = out.split(v).join(REDACTED);
    return out;
  };
  if (run.entry?.headers?.baggage) {
    run.entry.headers.baggage = scrub(run.entry.headers.baggage);
  }
  for (const hop of run.hops || []) {
    const before = hop.input.baggage;
    hop.input.baggage = scrub(hop.input.baggage);
    if (hop.input.baggage !== before) hop.input.baggageRedacted = true;
    hop.output.baggage = scrub(hop.output.baggage);
    for (const m of hop.members || []) {
      m.value = scrub(m.value);
      if (m.previousValue !== undefined) m.previousValue = scrub(m.previousValue);
      for (const p of m.properties || []) {
        if (p.value !== null && p.value !== undefined) p.value = scrub(p.value);
      }
    }
    for (const e of hop.events || []) {
      if (e.previousValue !== undefined) e.previousValue = scrub(e.previousValue);
    }
  }
  return run;
}
