import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError } from './store.js';
import { seedDemo } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ seed = true } = {}) {
  const store = new Store();
  if (seed) seedDemo(store);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const asyncWrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/graphs', (req, res, next) => {
    try {
      res.status(201).json(store.createGraph(req.body));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/graphs', asyncWrap((req, res) => {
    res.json({ graphs: store.listGraphs() });
  }));

  app.get('/api/graphs/:id', asyncWrap((req, res) => {
    res.json(store.getGraph(req.params.id));
  }));

  app.get('/api/graphs/:id/revisions', asyncWrap((req, res) => {
    res.json({ id: req.params.id, revisions: store.listRevisions(req.params.id) });
  }));

  app.get('/api/graphs/:id/revisions/:rev', asyncWrap((req, res) => {
    res.json(store.getRevision(req.params.id, Number(req.params.rev)));
  }));

  app.put('/api/graphs/:id', asyncWrap((req, res) => {
    const { graph, expectedRevision } = req.body || {};
    if (!Number.isInteger(expectedRevision)) {
      throw new HttpError(400, 'BAD_REQUEST', 'expectedRevision (integer) is required');
    }
    res.json(store.updateGraph(req.params.id, graph, expectedRevision));
  }));

  app.post('/api/graphs/:id/runs', asyncWrap((req, res) => {
    const { run, existing } = store.createRun(req.params.id, req.body || {});
    res.status(existing ? 200 : 201).json({ ...run, existing });
  }));

  app.get('/api/graphs/:id/runs', asyncWrap((req, res) => {
    res.json({ runs: store.listRuns(req.params.id) });
  }));

  app.get('/api/runs/:runId', asyncWrap((req, res) => {
    res.json(store.getRun(req.params.runId));
  }));

  app.get('/api/runs/:runId/export', asyncWrap((req, res) => {
    const data = store.exportRun(req.params.runId);
    res.setHeader('Content-Disposition', `attachment; filename="run-${req.params.runId}.json"`);
    res.json(data);
  }));

  app.get('/api/compare', asyncWrap((req, res) => {
    res.json(store.compare(req.query.a, req.query.b));
  }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'request body is not valid JSON' } });
    } else {
      console.error(err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  return { app, store };
}
