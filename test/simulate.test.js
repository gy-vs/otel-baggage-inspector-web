import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, normalizeConfig } from '../lib/config.js';
import { simulate } from '../lib/simulate.js';

function cfg(raw) {
  const errors = validateConfig(raw);
  assert.equal(errors.length, 0, `config should validate: ${errors.join('; ')}`);
  return normalizeConfig(raw);
}
function run(rawConfig, input) {
  const r = simulate(input, cfg(rawConfig));
  assert.ok(r.ok, r.error);
  return r;
}
function outKeys(r, hopNo) {
  return r.hops[hopNo].outgoing.members.map((m) => m.key);
}
function findHop(hops, predicate) {
  return hops.find(predicate);
}

// ---------- determinism ----------

test('identical input + config produces identical hops and hash', () => {
  const c = cfg({
    services: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b', transform: { addMembers: [{ key: 'x', value: '1' }] } }],
  });
  const input = { startService: 'a', baggageHeaders: ['k=v'], traceparent: '00-11111111111111111111111111111111-2222222222222222-01' };
  const r1 = simulate(input, c);
  const r2 = simulate(input, c);
  assert.equal(r1.resultHash, r2.resultHash);
  assert.equal(JSON.stringify(r1.hops), JSON.stringify(r2.hops));
  assert.notEqual(r1.hops[0].trace.spanId, '0000000000000000');
});

// ---------- duplicate keys / case ----------

test('duplicate keys keep first; different case coexist', () => {
  const r = run(
    { services: [{ id: 'a' }], edges: [] },
    { startService: 'a', baggageHeaders: ['k=first,k=second,K=third'] }
  );
  const root = r.hops[0];
  assert.deepEqual(root.outgoing.members.map((m) => [m.key, m.value]), [['k', 'first'], ['K', 'third']]);
  assert.ok(root.events.some((e) => e.reason === 'duplicate-key'));
});

// ---------- bad encoding / unicode ----------

test('bad percent encoding dropped; unicode survives and propagates', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b' }],
    },
    { startService: 'a', baggageHeaders: ['ok=1,bad=%zz,city=%E5%8C%97%E4%BA%AC,emoji=%F0%9F%98%80'] }
  );
  const hopB = findHop(r.hops, (h) => h.serviceId === 'b');
  assert.ok(hopB, 'hop b must exist');
  assert.deepEqual(outKeys(r, hopB.hopNo), ['ok', 'city', 'emoji']);
  const city = hopB.outgoing.members.find((m) => m.key === 'city');
  assert.equal(city.value, '北京');
  assert.match(hopB.outgoing.baggage, /city=%E5%8C%97%E4%BA%AC/);
  const rootEv = r.hops[0].events.find((e) => e.reason === 'bad-percent-encoding');
  assert.ok(rootEv);
});

// ---------- limits: truncation ----------

test('total-size limit drops overflowing members by prefix-fit, with reason and sizes', () => {
  const r = run(
    {
      services: [
        { id: 'a', limits: { maxTotalBytes: 24, maxMembers: 0, maxMemberBytes: 0 } },
      ],
      edges: [],
    },
    { startService: 'a', baggageMembers: [{ key: 'a', value: '1' }, { key: 'b', value: '22' }, { key: 'c', value: '333' }] }
  );
  const root = r.hops[0];
  // "a=1"=3, ",b=22"=5 -> 8; ",c=333"=6 -> 14, actually all fit under 24.
  assert.deepEqual(root.outgoing.members.map((m) => m.key), ['a', 'b', 'c']);
  assert.ok(root.outgoing.byteSize <= 24);

  const r2 = run(
    { services: [{ id: 'a', limits: { maxTotalBytes: 10, maxMembers: 0, maxMemberBytes: 0 } }], edges: [] },
    { startService: 'a', baggageMembers: [{ key: 'a', value: '1' }, { key: 'b', value: '22' }, { key: 'c', value: '333' }] }
  );
  const root2 = r2.hops[0];
  assert.deepEqual(root2.outgoing.members.map((m) => m.key), ['a', 'b']);
  const ev = root2.dropped.find((d) => d.reason === 'total-size-limit');
  assert.equal(ev.key, 'c');
  assert.ok(ev.bytes > 10);
  assert.ok(root2.outgoing.byteSize <= 10);
});

test('member-size limit drops oversized single member', () => {
  const r = run(
    { services: [{ id: 'a', limits: { maxTotalBytes: 0, maxMembers: 0, maxMemberBytes: 10 } }], edges: [] },
    { startService: 'a', baggageMembers: [{ key: 'k', value: 'x'.repeat(50) }, { key: 'ok', value: '1' }] }
  );
  assert.deepEqual(outKeys(r, 0), ['ok']);
  assert.equal(r.hops[0].dropped[0].reason, 'member-size-limit');
});

test('member-count limit drops tail members', () => {
  const r = run(
    { services: [{ id: 'a', limits: { maxTotalBytes: 0, maxMembers: 2, maxMemberBytes: 0 } }], edges: [] },
    { startService: 'a', baggageMembers: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }, { key: 'c', value: '3' }] }
  );
  assert.deepEqual(outKeys(r, 0), ['a', 'b']);
  assert.equal(r.hops[0].dropped.find((d) => d.reason === 'member-count-limit').key, 'c');
});

// ---------- allowlist / rename / sensitive ----------

test('service allowlist, rename and sensitive deletion', () => {
  const r = run(
    {
      services: [
        {
          id: 'a',
          sensitiveKeys: ['secret'],
          allowlist: ['keep', 'ren', 'secret'], // sensitive removed before allowlist
          rename: [{ from: 'ren', to: 'renamed' }],
        },
      ],
      edges: [],
    },
    { startService: 'a', baggageMembers: [{ key: 'keep', value: '1' }, { key: 'drop', value: '2' }, { key: 'ren', value: '3' }, { key: 'secret', value: 's3cr3t' }] }
  );
  const root = r.hops[0];
  assert.deepEqual(root.outgoing.members.map((m) => m.key), ['keep', 'renamed']);
  const reasons = root.dropped.map((d) => d.reason).sort();
  assert.deepEqual(reasons, ['not-in-allowlist', 'sensitive-key-removed']);
});

test('rename chains in declared order; rename collision overwrites earlier member', () => {
  const r = run(
    {
      services: [{ id: 'a', rename: [{ from: 'x', to: 'y' }, { from: 'y', to: 'z' }] }],
      edges: [],
    },
    { startService: 'a', baggageMembers: [{ key: 'x', value: '1' }] }
  );
  assert.deepEqual(outKeys(r, 0), ['z']);

  const r2 = run(
    { services: [{ id: 'a', rename: [{ from: 'x', to: 'y' }] }], edges: [] },
    { startService: 'a', baggageMembers: [{ key: 'x', value: '1' }, { key: 'y', value: '2' }] }
  );
  assert.deepEqual(outKeys(r2, 0), ['y']);
  const moved = r2.hops[0].outgoing.members.find((m) => m.key === 'y');
  assert.equal(moved.value, '1'); // renamed member wins over the pre-existing y
  assert.ok(r2.hops[0].dropped.some((d) => d.reason === 'rename-collision'));
});

test('ignoreCase matches keys case-insensitively', () => {
  const r = run(
    { services: [{ id: 'a', ignoreCase: true, sensitiveKeys: ['TOKEN'], allowlist: ['user-id'] }], edges: [] },
    { startService: 'a', baggageMembers: [{ key: 'token', value: 't' }, { key: 'User-Id', value: 'u' }] }
  );
  assert.deepEqual(outKeys(r, 0), ['User-Id']);
  assert.equal(r.hops[0].dropped.find((d) => d.reason === 'sensitive-key-removed').key, 'token');
});

// ---------- edge transforms ----------

test('edge add/delete/rename/set/dropAll and add overwrite', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
      edges: [
        { from: 'a', to: 'b', transform: { addMembers: [{ key: 'new', value: 'n' }, { key: 'k', value: 'overwritten' }] } },
        { from: 'a', to: 'c', transform: { deleteKeys: ['k'], renameKeys: [{ from: 'm', to: 'm2' }] } },
        { from: 'a', to: 'd', transform: { setMembers: [{ key: 'only', value: '1' }] } },
        { from: 'a', to: 'e', transform: { dropAll: true } },
      ],
    },
    { startService: 'a', baggageMembers: [{ key: 'k', value: 'orig' }, { key: 'm', value: 'v' }] }
  );
  const b = findHop(r.hops, (h) => h.serviceId === 'b');
  const kMember = b.outgoing.members.find((x) => x.key === 'k');
  assert.equal(kMember.value, 'overwritten');
  assert.ok(b.events.some((e) => e.reason === 'overwritten'));
  assert.ok(b.outgoing.members.some((m) => m.key === 'new'));

  const c = findHop(r.hops, (h) => h.serviceId === 'c');
  assert.deepEqual(c.outgoing.members.map((m) => m.key), ['m2']);
  assert.ok(c.events.some((e) => e.reason === 'edge-deleted' && e.key === 'k'));

  const d = findHop(r.hops, (h) => h.serviceId === 'd');
  assert.deepEqual(d.outgoing.members.map((m) => m.key), ['only']);
  assert.ok(d.events.some((e) => e.reason === 'replaced'));

  const e = findHop(r.hops, (h) => h.serviceId === 'e');
  assert.equal(e.outgoing.members.length, 0);
  assert.ok(e.events.some((ev) => ev.reason === 'drop-all'));
});

// ---------- fork isolation ----------

test('fork: branch state is isolated and transform on one branch never leaks', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { from: 'a', to: 'b', transform: { addMembers: [{ key: 'branch', value: 'b-only' }] } },
        { from: 'a', to: 'c', transform: { deleteKeys: ['k'] } },
      ],
    },
    { startService: 'a', baggageMembers: [{ key: 'k', value: 'v' }] }
  );
  const b = findHop(r.hops, (h) => h.serviceId === 'b');
  const c = findHop(r.hops, (h) => h.serviceId === 'c');
  assert.deepEqual(b.outgoing.members.map((m) => m.key), ['k', 'branch']);
  assert.deepEqual(c.outgoing.members.map((m) => m.key), []);
  assert.notDeepEqual(b.branchPath, c.branchPath);
});

// ---------- join: isolate default ----------

test('isolate join never merges headers: both arrivals pass through separately', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'j', merge: 'isolate' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'j', transform: { addMembers: [{ key: 'fromb', value: '1' }] } },
        { from: 'c', to: 'j', transform: { addMembers: [{ key: 'fromc', value: '2' }] } },
      ],
    },
    { startService: 'a', baggageMembers: [{ key: 'k', value: 'v' }] }
  );
  const joinHops = r.hops.filter((h) => h.serviceId === 'j');
  assert.equal(joinHops.length, 2);
  const keysets = joinHops.map((h) => h.outgoing.members.map((m) => m.key).sort());
  assert.deepEqual(keysets, [['fromb', 'k'], ['fromc', 'k']]);
  assert.ok(joinHops.every((h) => h.join.merge === 'isolate' && h.join.arrivalCount === 2));
  // no merge hop
  assert.ok(!r.hops.some((h) => h.kind === 'merge'));
});

// ---------- join: explicit union ----------

test('union join merges arrivals with conflict reporting; no union hop for isolate', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'j', merge: 'union' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'j', transform: { addMembers: [{ key: 'shared', value: 'b' }, { key: 'onlyb', value: '1' }] } },
        { from: 'c', to: 'j', transform: { addMembers: [{ key: 'shared', value: 'c' }, { key: 'onlyc', value: '2' }] } },
      ],
    },
    { startService: 'a', baggageMembers: [{ key: 'k', value: 'v' }] }
  );
  const mergeHop = findHop(r.hops, (h) => h.kind === 'merge');
  assert.ok(mergeHop, 'a merge hop must exist');
  assert.equal(mergeHop.join.arrivalCount, 2);
  assert.deepEqual(mergeHop.outgoing.members.map((m) => m.key), ['k', 'shared', 'onlyb', 'onlyc']);
  const shared = mergeHop.outgoing.members.find((m) => m.key === 'shared');
  assert.equal(shared.value, 'b'); // first arrival wins
  assert.ok(mergeHop.events.some((e) => e.reason === 'merge-conflict' && e.key === 'shared'));
});

test('single root never triggers merge on a fan-in node waiting for other roots', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b' }, { id: 'j', merge: 'union' }],
      edges: [
        { from: 'a', to: 'j', transform: { addMembers: [{ key: 'ka', value: '1' }] } },
        { from: 'b', to: 'j', transform: { addMembers: [{ key: 'kb', value: '2' }] } },
      ],
    },
    { startService: 'a', baggageHeaders: ['k=v'] }
  );
  // arrival a processed normally and flows on; no merge hop because only one
  // branch ever arrived — headers are never synthesized from nothing.
  assert.ok(!r.hops.some((h) => h.kind === 'merge'));
  const hopJ = r.hops.find((h) => h.serviceId === 'j');
  assert.deepEqual(hopJ.outgoing.members.map((m) => m.key), ['k', 'ka']);
});

test('multi-root union of genuinely different traces flags trace-mismatch', () => {
  const c = cfg({
    services: [{ id: 'a' }, { id: 'b' }, { id: 'j', merge: 'union' }],
    edges: [
      { from: 'a', to: 'j', transform: { addMembers: [{ key: 'ka', value: '1' }] } },
      { from: 'b', to: 'j', transform: { addMembers: [{ key: 'kb', value: '2' }] } },
    ],
  });
  const r = simulate({
    roots: [
      { service: 'a', baggageHeaders: ['x=1'], traceparent: '00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01' },
      { service: 'b', baggageHeaders: ['y=2'], traceparent: '00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01' },
    ],
  }, c);
  assert.ok(r.ok, r.error);
  const mergeHop = r.hops.find((h) => h.kind === 'merge');
  assert.ok(mergeHop);
  assert.ok(mergeHop.join.warnings.length >= 1);
  assert.ok(mergeHop.events.some((e) => e.reason === 'trace-mismatch-merge'));
  // baggage is still merged explicitly; trace context keeps the first arrival
  assert.deepEqual(mergeHop.outgoing.members.map((m) => m.key), ['x', 'ka', 'y', 'kb']);
  assert.equal(mergeHop.trace.traceId, '11111111111111111111111111111111');
});

// ---------- retries ----------

test('retries produce extra attempt hops with identical baggage', () => {
  const r = run(
    {
      services: [{ id: 'a' }, { id: 'b', sensitiveKeys: ['s'] }],
      edges: [{ from: 'a', to: 'b', retries: 2, retrySpan: 'new' }],
    },
    { startService: 'a', baggageMembers: [{ key: 'k', value: 'v' }, { key: 's', value: 'secret' }] }
  );
  const hops = r.hops.filter((h) => h.serviceId === 'b');
  assert.equal(hops.length, 3);
  assert.deepEqual(hops.map((h) => h.attempt), [0, 1, 2]);
  const baggage = hops.map((h) => h.outgoing.baggage);
  assert.ok(baggage.every((b) => b === baggage[0]));
  // retrySpan:new -> distinct span ids
  const spanIds = new Set(hops.map((h) => h.trace.spanId));
  assert.equal(spanIds.size, 3);
  assert.ok(hops.slice(1).every((h) => h.events.some((e) => e.type === 'retry-attempt')));
});

test('retries with reuse span share the span id and flag reusedSpan', () => {
  const r = run(
    { services: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', retries: 1, retrySpan: 'reuse' }] },
    { startService: 'a', baggageHeaders: ['k=v'] }
  );
  const hops = r.hops.filter((h) => h.serviceId === 'b');
  assert.equal(new Set(hops.map((h) => h.trace.spanId)).size, 1);
  assert.equal(hops[1].trace.reusedSpan, true);
});

// ---------- trace context ----------

test('trace id propagates; invalid traceparent starts new trace with event', () => {
  const good = run(
    { services: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
    { startService: 'a', baggageHeaders: ['k=v'], traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }
  );
  assert.ok(good.hops.every((h) => h.trace.traceId === '0af7651916cd43dd8448eb211c80319c'));
  assert.equal(good.hops[0].incoming.traceparent, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  assert.notEqual(good.hops[0].trace.spanId, 'b7ad6b7169203331'); // new span at receiving service

  const bad = run(
    { services: [{ id: 'a' }], edges: [] },
    { startService: 'a', traceparent: '00-zz-b7ad6b7169203331-01' }
  );
  assert.ok(bad.hops[0].events.some((e) => e.reason === 'invalid-traceparent'));
  assert.ok(bad.hops[0].events.some((e) => e.type === 'new-trace'));
  assert.match(bad.hops[0].trace.traceId, /^[0-9a-f]{32}$/);
});

test('tracestate over 32 members / 512 bytes is limited greedily', () => {
  const members = Array.from({ length: 40 }, (_, i) => `v${i}=${'x'.repeat(40)}`);
  const r = run(
    { services: [{ id: 'a' }], edges: [] },
    { startService: 'a', tracestate: members.join(',') }
  );
  const evts = r.hops[0].events.filter((e) => /tracestate/.test(e.reason ?? ''));
  assert.ok(evts.length > 0);
  const out = r.hops[0].outgoing.tracestate;
  assert.ok(Buffer.byteLength(out) <= 512);
});

// ---------- fanout explosion guard ----------

test('excessive isolate fan-out is rejected with a deterministic error', () => {
  const services = [{ id: 'a' }, ...Array.from({ length: 12 }, (_, i) => ({ id: `l1-${i}` })),
    ...Array.from({ length: 45 }, (_, i) => ({ id: `l2-${i}` }))];
  const edges = [];
  for (let i = 0; i < 12; i++) edges.push({ from: 'a', to: `l1-${i}` });
  for (let i = 0; i < 12; i++) for (let j = 0; j < 45; j++) edges.push({ from: `l1-${i}`, to: `l2-${j}` });
  const c = cfg({ services, edges });
  const r = simulate({ startService: 'a' }, c);
  assert.equal(r.ok, false);
  assert.match(r.error, /hop limit/);
});
