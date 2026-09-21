// HTTP API + static frontend for the baggage propagation workbench.
// Zero external dependencies: node:http only.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { createStore } from '../lib/store.js';
import { redactRun } from '../lib/export.js';
import { SAMPLE_CONFIG, SAMPLE_INPUT } from './sample.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

export function buildApp(store = createStore()) {
  // Seed the demo graph.
  const seeded = store.createConfig({ id: 'sample', config: SAMPLE_CONFIG });
  const sampleRevision = seeded.revision;

  const routes = [
    ['GET', /^\/api\/health$/, health],
    ['GET', /^\/api\/configs$/, () => json(200, { configs: store.listConfigs() })],
    ['GET', /^\/api\/configs\/([^/]+)$/, (m, req, body) =>
      getConfig(m[1], req.query.revision)],
    ['GET', /^\/api\/configs\/([^/]+)\/revisions$/, (m) =>
      json(200, store.listRevisions(m[1]) ?? notFoundBody(m[1]))],
    ['PUT', /^\/api\/configs\/([^/]+)$/, (m, req, body) =>
      putConfig(m[1], body)],
    ['POST', /^\/api\/runs$/, (m, req, body) => run(body)],
    ['GET', /^\/api\/runs$/, () => json(200, { runs: store.listRuns() })],
    ['GET', /^\/api\/runs\/([^/]+)$/, (m, req) => getRun(m[1], req.query.export)],
    ['POST', /^\/api\/sample\/run$/, () =>
      run({ configId: 'sample', revision: sampleRevision, input: SAMPLE_INPUT, labels: { demo: true } })],
  ];

  function health() {
    return json(200, { ok: true });
  }
  function getConfig(id, revision) {
    const rec = store.getConfig(id, revision);
    if (!rec) return json(404, { error: 'not-found' });
    return json(200, { configId: id, revision: rec.revision, fingerprint: rec.fingerprint, config: rec.config });
  }
  function putConfig(id, body) {
    if (!body || typeof body !== 'object' || !body.config) {
      return json(400, { error: 'bad-request', detail: 'expected {config, expectedRevision}' });
    }
    const res = store.putConfig(id, body.config, body.expectedRevision);
    if (res.error === 'invalid-config') return json(400, { error: 'invalid-config', errors: res.errors });
    if (res.error === 'conflict') {
      return json(409, { error: 'conflict', currentRevision: res.currentRevision, detail: res.detail });
    }
    return json(200, res);
  }
  function run(body) {
    if (!body || !body.configId) {
      return json(400, { error: 'bad-request', detail: 'expected {configId, revision?, input}' });
    }
    const configRec = store.getConfig(body.configId, body.revision);
    if (!configRec) return json(404, { error: 'not-found', detail: 'config/revision not found' });
    const res = store.runSimulation({
      configId: body.configId,
      revision: configRec.revision,
      input: body.input ?? {},
      labels: body.labels ?? {},
    });
    if (res.error === 'simulation-failed') return json(422, { error: res.error, detail: res.detail });
    return json(res.reused ? 200 : 201, res);
  }
  function getRun(id, exportMode) {
    const rec = store.getRun(id);
    if (!rec) return json(404, { error: 'not-found' });
    if (exportMode === 'redacted' || exportMode === 'true' || exportMode === '1') {
      return json(200, redactRun(rec));
    }
    return json(200, rec);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      req.query = Object.fromEntries(url.searchParams);
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(pattern);
        if (!m) continue;
        let body = null;
        if (method === 'PUT' || method === 'POST') {
          body = await readJson(req, res);
          if (body === undefined) return; // response already sent on error
        }
        const out = await handler(m, req, body);
        sendJson(res, out.status, out.body);
        return;
      }
      if (req.method === 'GET') {
        const served = await serveStatic(url.pathname, res);
        if (served) return;
      }
      sendJson(res, 404, { error: 'not-found', path: url.pathname });
    } catch (err) {
      sendJson(res, 500, { error: 'internal', detail: String(err && err.message || err) });
    }
  });

  async function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (rel.includes('..')) return false;
    try {
      const buf = await readFile(join(PUBLIC_DIR, rel));
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { 'content-type': types[extname(rel)] ?? 'application/octet-stream' });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  }

  return { server, store };
}

function json(status, body) {
  return { status, body };
}
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length });
  res.end(payload);
}
function readJson(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        sendJson(res, 413, { error: 'payload-too-large' });
        resolve(undefined);
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        sendJson(res, 400, { error: 'bad-json' });
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const { server } = buildApp();
  server.listen(port, () => {
    console.log(`baggage workbench listening on http://localhost:${port}`);
  });
}
