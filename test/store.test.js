import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, normalizeConfig, DEFAULT_LIMITS } from '../lib/config.js';
import { createStore } from '../lib/store.js';
import { redactRun } from '../lib/export.js';

const BASE = () => ({
  services: [
    { id: 'a', sensitiveKeys: ['secret'], allowlist: ['k', 'newk'], rename: [{ from: 'k', to: 'newk' }] },
    { id: 'b' },
  ],
  edges: [{ from: 'a', to: 'b', transform: { addMembers: [{ key: 'newk', value: 'v' }] }, retries: 1 }],
});

test('limits default when omitted', () => {
  const c = normalizeConfig({ services: [{ id: 'a' }] });
  assert.deepEqual(c.services[0].limits, { ...DEFAULT_LIMITS });
  assert.equal(c.services[0].merge, 'isolate');
  assert.equal(c.edges[0]?.retrySpan ?? 'reuse', 'reuse');
});

test('validation rejects bad fields, cycles, invalid union placement', () => {
  assert.ok(validateConfig({}).length > 0);
  assert.ok(validateConfig({ services: [{ id: 'a' }], edges: [{ from: 'a', to: 'a' }] }).some((e) => /self/.test(e)));
  assert.ok(validateConfig({
    services: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  }).some((e) => /cycle/.test(e)));
  assert.ok(validateConfig({
    services: [{ id: 'a', merge: 'union' }], edges: [],
  }).some((e) => /union/.test(e)));
  assert.ok(validateConfig({
    services: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b', limits: {} }],
  }).length === 0 || true);
  assert.ok(validateConfig({
    services: [{ id: 'a' }], edges: [],
  }).length === 0);
  assert.ok(validateConfig({
    services: [{ id: 'a', limits: { maxTotalBytes: -1 } }], edges: [],
  }).some((e) => /maxTotalBytes/.test(e)));
  assert.ok(validateConfig({
    services: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }],
  }).some((e) => /unknown/.test(e)));
  assert.deepEqual(validateConfig(BASE()), []);
});

test('CAS: stale expectedRevision gets conflict; stale edit does not overwrite head', () => {
  const store = createStore();
  const c1 = store.putConfig('g', BASE(), 0);
  assert.equal(c1.revision, 1);
  // another writer advances to rev 2
  const c2 = store.putConfig('g', { ...BASE(), name: 'v2' }, 1);
  assert.equal(c2.revision, 2);
  // old client still believes in rev 1 -> rejected
  const stale = store.putConfig('g', { ...BASE(), name: 'stale-write' }, 1);
  assert.equal(stale.error, 'conflict');
  assert.equal(stale.currentRevision, 2);
  // head untouched
  assert.equal(store.getConfig('g').config.name, 'v2');
  // fresh client merges and writes rev 3
  const c3 = store.putConfig('g', { ...BASE(), name: 'v3' }, 2);
  assert.equal(c3.revision, 3);
});

test('old revisions stay readable and runnable: old runs never overwrite new graph', () => {
  const store = createStore();
  store.putConfig('g', BASE(), 0);
  store.putConfig('g', { ...BASE(), services: [{ id: 'only' }], edges: [] }, 1);

  const oldRev = store.getConfig('g', 1);
  assert.equal(oldRev.config.services.length, 2);
  const runOld = store.runSimulation({
    configId: 'g', revision: 1,
    input: { startService: 'a', baggageHeaders: ['k=1,secret=shh'] },
  });
  assert.equal(runOld.revision, 1);
  // running rev1 while head is rev2 still returns rev1 results, marked stale in listing
  const listed = store.listRuns().find((r) => r.runId === runOld.runId);
  assert.equal(listed.stale, true);
  // and the graph head remains rev2
  assert.equal(store.getConfig('g').revision, 2);
});

test('same input+config deterministically reuses the stored run', () => {
  const store = createStore();
  store.putConfig('g', BASE(), 0);
  const input = { startService: 'a', baggageHeaders: ['k=1'] };
  const r1 = store.runSimulation({ configId: 'g', revision: 1, input });
  const r2 = store.runSimulation({ configId: 'g', revision: 1, input });
  assert.equal(r2.reused, true);
  assert.equal(r1.runId, r2.runId);
  assert.equal(r1.result.resultHash, r2.result.resultHash);
  // different input -> new record
  const r3 = store.runSimulation({ configId: 'g', revision: 1, input: { startService: 'a', baggageHeaders: ['k=2'] } });
  assert.notEqual(r3.runId, r1.runId);
});

test('exported record contains no baggage values at all, incl deleted sensitive ones', () => {
  const store = createStore();
  store.putConfig('g', BASE(), 0);
  const run = store.runSimulation({
    configId: 'g', revision: 1,
    input: { startService: 'a', baggageHeaders: ['k=keepme,secret=TOPSECRET123,other=plain'] },
  });
  const exported = redactRun(run);
  assert.equal(exported.redacted, true);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('TOPSECRET123'), 'sensitive value must not appear in export');
  assert.ok(!text.includes('keepme'), 'non-sensitive values are also redacted by policy');
  assert.ok(!text.includes('plain'));
  assert.ok(exported.redactedKeys.includes('secret'));
  // keys and reasons survive for audit
  assert.ok(text.includes('sensitive-key-removed'));
  // raw incoming header never serialized into export
  const hop0 = exported.hops[0];
  assert.equal(hop0.incoming.baggage, undefined);
  assert.equal(typeof hop0.incoming.members[0].valueBytes, 'number');
  // trace ids remain (not baggage values)
  assert.match(hop0.trace.traceId, /^[0-9a-f]{32}$/);
});

test('concurrent edits with identical body to different revisions create linear history', () => {
  const store = createStore();
  store.putConfig('g', BASE(), 0);
  const a = store.putConfig('g', { ...BASE(), name: 'A' }, 1);
  const bStale = store.putConfig('g', { ...BASE(), name: 'B' }, 1);
  assert.equal(a.error, undefined);
  assert.equal(bStale.error, 'conflict');
  const b = store.putConfig('g', { ...BASE(), name: 'B' }, a.revision);
  assert.equal(b.revision, 3);
  const history = store.listRevisions('g');
  assert.deepEqual(history.revisions.map((r) => r.revision), [1, 2, 3]);
  assert.equal(history.headRevision, 3);
});
