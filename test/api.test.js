import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let server;
let base;

test.before(async () => {
  const { app } = createApp({ seed: false });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

const api = async (path, options = {}) => {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* export etc. */ }
  return { status: res.status, body, text };
};

const simpleGraph = () => ({
  name: 'svc',
  nodes: [
    { id: 'a', config: {} },
    { id: 'b', config: { sensitive: ['password'], renames: { user_id: 'uid' } } },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b' }],
});

test('graph CRUD with revisions and optimistic concurrency', async () => {
  const created = await api('/api/graphs', { method: 'POST', body: JSON.stringify(simpleGraph()) });
  assert.equal(created.status, 201);
  const gid = created.body.id;
  assert.equal(created.body.revision, 1);

  // two editors both read revision 1 and both try to save
  const edit1 = await api(`/api/graphs/${gid}`, {
    method: 'PUT',
    body: JSON.stringify({ graph: { ...simpleGraph(), name: 'svc-v2' }, expectedRevision: 1 }),
  });
  assert.equal(edit1.status, 200);
  assert.equal(edit1.body.revision, 2);

  const edit2 = await api(`/api/graphs/${gid}`, {
    method: 'PUT',
    body: JSON.stringify({ graph: { ...simpleGraph(), name: 'svc-v3' }, expectedRevision: 1 }),
  });
  assert.equal(edit2.status, 409, 'stale expectedRevision is rejected');
  assert.equal(edit2.body.error.code, 'REVISION_CONFLICT');

  // the winner's document is what survives
  const current = await api(`/api/graphs/${gid}`);
  assert.equal(current.body.graph.name, 'svc-v2');
  assert.equal(current.body.revision, 2);

  // old revision is still retrievable and immutable
  const rev1 = await api(`/api/graphs/${gid}/revisions/1`);
  assert.equal(rev1.body.graph.name, 'svc');
});

test('cyclic graphs are rejected', async () => {
  const res = await api('/api/graphs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'loop',
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'CYCLE');
});

test('runs are deterministic and idempotent (same input -> same runId)', async () => {
  const gid = (await api('/api/graphs', { method: 'POST', body: JSON.stringify(simpleGraph()) })).body.id;
  const entry = { node: 'a', headers: { baggage: 'user_id=7,password=hunter2' } };
  const r1 = await api(`/api/graphs/${gid}/runs`, { method: 'POST', body: JSON.stringify(entry) });
  assert.equal(r1.status, 201);
  const r2 = await api(`/api/graphs/${gid}/runs`, { method: 'POST', body: JSON.stringify(entry) });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.existing, true);
  assert.equal(r1.body.runId, r2.body.runId);
  assert.deepEqual(r1.body.hops, r2.body.hops);
});

test('runs are pinned to their revision; edits never rewrite old runs', async () => {
  const gid = (await api('/api/graphs', { method: 'POST', body: JSON.stringify(simpleGraph()) })).body.id;
  const entry = { node: 'a', headers: { baggage: 'user_id=7,extra=1' } };
  const run1 = (await api(`/api/graphs/${gid}/runs`, { method: 'POST', body: JSON.stringify(entry) })).body;
  assert.equal(run1.revision, 1);
  assert.ok(run1.hops[0].output.baggage.includes('uid=7'), 'rename applied at rev 1');

  // edit the graph: drop the rename
  const noRename = simpleGraph();
  noRename.nodes[1].config.renames = {};
  const edit = await api(`/api/graphs/${gid}`, {
    method: 'PUT',
    body: JSON.stringify({ graph: noRename, expectedRevision: 1 }),
  });
  assert.equal(edit.status, 200);

  // old run is untouched
  const oldRun = (await api(`/api/runs/${run1.runId}`)).body;
  assert.equal(oldRun.revision, 1);
  assert.ok(oldRun.hops[0].output.baggage.includes('uid=7'), 'old run keeps rev-1 behaviour');

  // new run uses the new revision and gets a different id
  const run2 = (await api(`/api/graphs/${gid}/runs`, { method: 'POST', body: JSON.stringify(entry) })).body;
  assert.equal(run2.revision, 2);
  assert.notEqual(run1.runId, run2.runId);
  assert.ok(run2.hops[0].output.baggage.includes('user_id=7'), 'rev 2 no longer renames');
});

test('export never contains deleted sensitive values', async () => {
  // chain a -> b -> c: the sensitive key travels through hop 1 untouched,
  // is renamed at b, and only deleted at c's ingress. Nowhere in the
  // export (entry headers, hop 1 output, member records) may the value leak.
  const graph = {
    name: 'redact',
    nodes: [
      { id: 'a', config: {} },
      { id: 'b', config: { renames: { password: 'pw' } } },
      { id: 'c', config: { sensitive: ['pw'] } },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  };
  const gid = (await api('/api/graphs', { method: 'POST', body: JSON.stringify(graph) })).body.id;
  const entry = { node: 'a', headers: { baggage: 'user_id=7,password=hunter2' } };
  const run = (await api(`/api/graphs/${gid}/runs`, { method: 'POST', body: JSON.stringify(entry) })).body;
  const res = await api(`/api/runs/${run.runId}/export`);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('hunter2'), 'sensitive value absent from export');
  assert.ok(res.text.includes('[REDACTED]'));
  assert.equal(res.body.sensitiveValuesRedacted, true);
  // GET run is scrubbed too, not just the export
  const fetched = await api(`/api/runs/${run.runId}`);
  assert.ok(!fetched.text.includes('hunter2'));
});

test('compare endpoint diffs any two hops', async () => {
  const graph = {
    name: 'cmp',
    nodes: [{ id: 'a', config: {} }, { id: 'b', config: {} }, { id: 'c', config: { sensitive: ['password'] } }],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  };
  const gid = (await api('/api/graphs', { method: 'POST', body: JSON.stringify(graph) })).body.id;
  const run = (await api(`/api/graphs/${gid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ node: 'a', headers: { baggage: 'password=hunter2,k=v' } }),
  })).body;
  const [h1, h2] = run.hops;
  const res = await api(`/api/compare?a=${run.runId}:${h1.hopId}&b=${run.runId}:${h2.hopId}`);
  assert.equal(res.status, 200);
  const pw = res.body.members.find((m) => m.key === 'password');
  assert.equal(pw.a.status, 'preserved', 'still present after hop 1');
  assert.equal(pw.b.status, 'dropped', 'dropped as sensitive at hop 2');
  assert.equal(pw.change, 'status-changed');
});

test('unknown resources return 404', async () => {
  assert.equal((await api('/api/graphs/nope')).status, 404);
  assert.equal((await api('/api/runs/nope')).status, 404);
  assert.equal((await api('/api/compare?a=x:y&b=x:y')).status, 404);
});
