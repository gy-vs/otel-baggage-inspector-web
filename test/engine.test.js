import test from 'node:test';
import assert from 'node:assert/strict';
import { processHop, runGraph, mergeConfig, DEFAULT_LIMITS, REDACTED } from '../src/engine.js';

const baseConfig = () => mergeConfig({}, {});
const input = (baggage, extra = {}) => ({
  baggage,
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  tracestate: '',
  ...extra,
});

test('duplicate keys: first wins, later dropped with reason', () => {
  const hop = processHop({ input: input('a=1,b=2,a=3'), config: baseConfig(), seed: 's' });
  const a = hop.members.filter((m) => m.key === 'a');
  assert.equal(a[0].status, 'preserved');
  assert.equal(a[0].value, '1');
  assert.equal(a[1].status, 'dropped');
  assert.equal(a[1].reason, 'duplicate-key');
  assert.equal(hop.output.baggage, 'a=1, b=2');
});

test('sensitive keys are dropped and redacted everywhere in the record', () => {
  const config = mergeConfig({ sensitive: ['password'] }, {});
  const hop = processHop({ input: input('user=1,password=hunter2'), config, seed: 's' });
  const pw = hop.members.find((m) => m.key === 'password');
  assert.equal(pw.status, 'dropped');
  assert.equal(pw.reason, 'sensitive-removed');
  assert.equal(pw.value, REDACTED);
  assert.equal(hop.input.baggageRedacted, true);
  assert.ok(!JSON.stringify(hop).includes('hunter2'), 'no sensitive value anywhere in the hop record');
});

test('allowlist drops non-listed keys', () => {
  const config = mergeConfig({ allowlist: ['keep'] }, {});
  const hop = processHop({ input: input('keep=1,drop=2'), config, seed: 's' });
  assert.equal(hop.members.find((m) => m.key === 'keep').status, 'preserved');
  const dropped = hop.members.find((m) => m.key === 'drop');
  assert.equal(dropped.status, 'dropped');
  assert.equal(dropped.reason, 'not-in-allowlist');
});

test('rename rewrites the key; collisions drop the later member', () => {
  const config = mergeConfig({ renames: { user_id: 'uid' } }, {});
  const hop = processHop({ input: input('user_id=42'), config, seed: 's' });
  assert.equal(hop.members[0].outKey, 'uid');
  assert.equal(hop.members[0].renamedFrom, 'user_id');
  assert.equal(hop.output.baggage, 'uid=42');

  const clash = processHop({ input: input('uid=1,user_id=2'), config, seed: 's' });
  const renamed = clash.members.find((m) => m.key === 'user_id');
  assert.equal(renamed.status, 'dropped');
  assert.equal(renamed.reason, 'rename-collision');
  assert.equal(clash.output.baggage, 'uid=1');
});

test('set overwrites existing keys and records the previous value', () => {
  const config = mergeConfig({ set: { env: 'prod', injected: 'yes' } }, {});
  const hop = processHop({ input: input('env=dev'), config, seed: 's' });
  const env = hop.members.find((m) => m.key === 'env');
  assert.equal(env.status, 'overwritten');
  assert.equal(env.value, 'prod');
  assert.equal(env.previousValue, 'dev');
  const injected = hop.members.find((m) => m.key === 'injected');
  assert.equal(injected.status, 'added');
  assert.equal(hop.output.baggage, 'env=prod, injected=yes');
});

test('member count limit drops from the tail', () => {
  const config = mergeConfig({ limits: { maxMembers: 2 } }, {});
  const hop = processHop({ input: input('a=1,b=2,c=3'), config, seed: 's' });
  assert.equal(hop.members.find((m) => m.key === 'c').reason, 'too-many-members');
  assert.equal(hop.output.baggage, 'a=1, b=2');
});

test('per-member size limit drops the oversized member', () => {
  const config = mergeConfig({ limits: { maxMemberBytes: 10 } }, {});
  const hop = processHop({ input: input(`big=${'x'.repeat(50)},ok=1`), config, seed: 's' });
  assert.equal(hop.members.find((m) => m.key === 'big').reason, 'member-too-large');
  assert.equal(hop.output.baggage, 'ok=1');
});

test('total length limit truncates from the tail until it fits', () => {
  const config = mergeConfig({ limits: { maxTotalBytes: 12 } }, {});
  const hop = processHop({ input: input('aa=1,bb=2,cc=3,dd=4'), config, seed: 's' });
  const dropped = hop.members.filter((m) => m.status === 'dropped').map((m) => m.key);
  assert.deepEqual(dropped.sort(), ['cc', 'dd'], 'tail members dropped');
  assert.ok(hop.members.filter((m) => m.status === 'dropped').every((m) => m.reason === 'total-length-exceeded'));
  assert.ok(Buffer.byteLength(hop.output.baggage) <= 12);
  assert.equal(hop.output.baggage, 'aa=1, bb=2');
});

test('bad encoding survives with issues; unicode decodes and re-encodes', () => {
  const hop = processHop({ input: input('bad=%ZZ,city=%E4%B8%AD'), config: baseConfig(), seed: 's' });
  const bad = hop.members.find((m) => m.key === 'bad');
  assert.equal(bad.status, 'preserved');
  assert.ok(bad.issues.includes('invalid-percent-encoding'));
  const city = hop.members.find((m) => m.key === 'city');
  assert.equal(city.value, '中');
  assert.ok(hop.output.baggage.includes('city=%E4%B8%AD'), 'unicode re-encoded canonically');
});

test('case: Foo and foo propagate as distinct members', () => {
  const hop = processHop({ input: input('Foo=1,foo=2'), config: baseConfig(), seed: 's' });
  assert.equal(hop.members.filter((m) => m.status === 'preserved').length, 2);
  assert.equal(hop.output.baggage, 'Foo=1, foo=2');
});

test('trace context: trace id preserved, span id deterministic, flags kept', () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
  const h1 = processHop({ input: input('a=1', { traceparent: tp }), config: baseConfig(), seed: 'seed-1' });
  const h2 = processHop({ input: input('a=1', { traceparent: tp }), config: baseConfig(), seed: 'seed-1' });
  assert.equal(h1.trace.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(h1.trace.sampled, false, 'sampled flag from flags byte 00');
  assert.notEqual(h1.trace.spanId, '00f067aa0ba902b7', 'new span id per hop');
  assert.equal(h1.trace.spanId, h2.trace.spanId, 'same seed -> same span id');
  assert.ok(h1.output.traceparent.endsWith('-00'), 'flags preserved');
});

test('invalid traceparent starts a deterministic new trace', () => {
  const h1 = processHop({ input: input('a=1', { traceparent: 'garbage' }), config: baseConfig(), seed: 'seed-x' });
  const h2 = processHop({ input: input('a=1', { traceparent: 'garbage' }), config: baseConfig(), seed: 'seed-x' });
  assert.equal(h1.trace.continued, false);
  assert.equal(h1.trace.traceId, h2.trace.traceId);
  assert.ok(h1.events.some((e) => e.code === 'new-trace'));
  assert.ok(h1.events.some((e) => e.code === 'malformed-traceparent'));
});

test('tracestate is capped at 32 members with diagnostics', () => {
  const ts = Array.from({ length: 35 }, (_, i) => `k${i}=v`).join(',');
  const hop = processHop({ input: input('a=1', { tracestate: ts }), config: baseConfig(), seed: 's' });
  assert.equal(hop.output.tracestate.split(',').length, 32);
  assert.ok(hop.events.some((e) => e.code === 'tracestate-too-many-members'));
});

// ---------- graph-level behaviour ----------

const forkJoinGraph = () => ({
  name: 'fj',
  nodes: [
    { id: 'a', config: {} },
    { id: 'b', config: { renames: { x: 'y' } } },
    { id: 'c', config: {} },
    { id: 'd', config: {} },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'a', target: 'c' },
    { id: 'e3', source: 'b', target: 'd' },
    { id: 'e4', source: 'c', target: 'd' },
  ],
});

test('fork: branch state is isolated (rename in one branch does not leak)', () => {
  const { hops } = runGraph(forkJoinGraph(), { node: 'a', headers: { baggage: 'x=1' } }, 'run');
  const intoB = hops.find((h) => h.edgeId === 'e1');
  const intoC = hops.find((h) => h.edgeId === 'e2');
  assert.equal(intoB.output.baggage, 'y=1', 'branch b renamed x->y');
  assert.equal(intoC.output.baggage, 'x=1', 'branch c unaffected');
  assert.notEqual(intoB.pathId, intoC.pathId, 'branches have distinct paths');
});

test('join: states stay isolated, headers are never merged', () => {
  const { hops, joins } = runGraph(forkJoinGraph(), { node: 'a', headers: { baggage: 'x=1' } }, 'run');
  const intoD = hops.filter((h) => h.target === 'd');
  assert.equal(intoD.length, 2, 'd is entered once per inbound state');
  const baggages = intoD.map((h) => h.input.baggage).sort();
  assert.deepEqual(baggages, ['x=1', 'y=1'], 'each inbound state arrives as-is, no merge');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].node, 'd');
  assert.equal(joins[0].isolatedStates.length, 2);
});

test('retry: every attempt re-sends identical input and produces identical baggage', () => {
  const graph = {
    name: 'retry',
    nodes: [{ id: 'a', config: {} }, { id: 'b', config: { set: { seen: '1' } } }],
    edges: [{ id: 'e1', source: 'a', target: 'b', attempts: 3 }],
  };
  const { hops } = runGraph(graph, { node: 'a', headers: { baggage: 'k=v' } }, 'run');
  assert.equal(hops.length, 3);
  assert.deepEqual(hops.map((h) => h.attempt), [1, 2, 3]);
  for (const h of hops) {
    assert.equal(h.input.baggage, 'k=v', 'retry re-sends the original headers');
    assert.equal(h.output.baggage, 'k=v, seen=1');
  }
  const spanIds = new Set(hops.map((h) => h.trace.spanId));
  assert.equal(spanIds.size, 3, 'each attempt is its own span');
});

test('determinism: identical graph + entry yields byte-identical runs', () => {
  const g = forkJoinGraph();
  const entry = { node: 'a', headers: { baggage: 'x=1,z=%20', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } };
  const r1 = runGraph(g, entry, 'same-seed');
  const r2 = runGraph(g, entry, 'same-seed');
  assert.deepEqual(r1, r2);
});

test('edge overrides take precedence over service config', () => {
  const merged = mergeConfig(
    { sensitive: ['a'], limits: { maxMembers: 5 } },
    { sensitive: ['b'], limits: { maxTotalBytes: 100 } }
  );
  assert.deepEqual(merged.sensitive, ['b']);
  assert.equal(merged.limits.maxMembers, 5, 'inherited from service');
  assert.equal(merged.limits.maxTotalBytes, 100, 'overridden by edge');
  assert.equal(merged.limits.maxMemberBytes, DEFAULT_LIMITS.maxMemberBytes, 'default preserved');
});
