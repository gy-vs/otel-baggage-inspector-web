import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/index.js';

let base;
let server;

before(async () => {
  const app = buildApp();
  server = app.server;
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const j = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test('health and sample seed', async () => {
  const h = await j('GET', '/api/health');
  assert.equal(h.data.ok, true);
  const cfg = await j('GET', '/api/configs/sample');
  assert.ok(cfg.data.revision >= 1);
  assert.equal(cfg.data.config.services.length, 6);
});

test('run pins revision and replay is stable; old rev still runnable', async () => {
  const r1 = await j('POST', '/api/runs', {
    configId: 'sample',
    input: { startService: 'edge-gateway', baggageHeaders: ['user-id=u1'] },
  });
  assert.equal(r1.status, 201);
  const r2 = await j('POST', '/api/runs', {
    configId: 'sample',
    input: { startService: 'edge-gateway', baggageHeaders: ['user-id=u1'] },
  });
  assert.equal(r2.status, 200); // reused
  assert.equal(r2.data.runId, r1.data.runId);
  assert.equal(r2.data.result.resultHash, r1.data.result.resultHash);

  // advance graph
  const head = (await j('GET', '/api/configs/sample')).data;
  const nextConfig = { ...head.config, services: [...head.config.services, { id: 'extra' }] };
  const saved = await j('PUT', '/api/configs/sample', { config: nextConfig, expectedRevision: head.revision });
  assert.equal(saved.status, 200);

  // old revision still runnable
  const old = await j('POST', '/api/runs', {
    configId: 'sample', revision: r1.data.revision,
    input: { startService: 'edge-gateway', baggageHeaders: ['user-id=u1'] },
  });
  assert.equal(old.data.revision, r1.data.revision);
  assert.equal(old.data.result.resultHash, r1.data.result.resultHash);
});

test('PUT with stale expectedRevision returns 409 and current revision', async () => {
  const head = (await j('GET', '/api/configs/cas')).data ?? null;
  const create = await j('PUT', '/api/configs/cas', {
    config: { services: [{ id: 'a' }] }, expectedRevision: 0,
  });
  const conflict = await j('PUT', '/api/configs/cas', {
    config: { services: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
    expectedRevision: create.data.revision - 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.currentRevision, create.data.revision);
});

test('invalid config returns 400 with detailed errors', async () => {
  const res = await j('PUT', '/api/configs/bad', {
    config: { services: [] }, expectedRevision: 0,
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.data.errors));
});

test('redacted export endpoint strips values; full run retains them for on-screen audit', async () => {
  const run = await j('POST', '/api/runs', {
    configId: 'sample',
    input: { startService: 'edge-gateway', baggageHeaders: ['session-id=SESS-XYZ,user-id=u9'] },
  });
  const full = await j('GET', `/api/runs/${run.data.runId}`);
  // full run is useful for the UI (values present before deletion at that hop)
  assert.ok(JSON.stringify(full.data).includes('SESS-XYZ'));

  const redacted = await j('GET', `/api/runs/${run.data.runId}?export=redacted`);
  assert.equal(redacted.data.redacted, true);
  assert.ok(!JSON.stringify(redacted.data).includes('SESS-XYZ'));
});

test('frontend is served', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Baggage'));
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
});
