// In-memory store: graphs with immutable revisions, runs pinned to the
// revision they were created against. Old runs are never mutated or
// overwritten by graph edits.
import { createHash, randomUUID } from 'node:crypto';
import { runGraph, topoOrder, scrubRunRecord } from './engine.js';

// Stable JSON: object keys sorted recursively. Used for content hashing so
// that identical (graph, entry) pairs always produce identical run ids.
export function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function contentHash(obj) {
  return createHash('sha256').update(canonicalize(obj)).digest('hex');
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LIMIT_KEYS = ['maxTotalBytes', 'maxMembers', 'maxMemberBytes'];

function validateConfig(config, where) {
  if (config === undefined || config === null) return;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new HttpError(400, 'BAD_CONFIG', `${where}: config must be an object`);
  }
  if (config.allowlist !== undefined && config.allowlist !== null && !Array.isArray(config.allowlist)) {
    throw new HttpError(400, 'BAD_CONFIG', `${where}: allowlist must be an array or null`);
  }
  for (const name of ['renames', 'set']) {
    if (config[name] !== undefined && (typeof config[name] !== 'object' || Array.isArray(config[name]))) {
      throw new HttpError(400, 'BAD_CONFIG', `${where}: ${name} must be an object`);
    }
  }
  if (config.sensitive !== undefined && !Array.isArray(config.sensitive)) {
    throw new HttpError(400, 'BAD_CONFIG', `${where}: sensitive must be an array`);
  }
  if (config.limits !== undefined) {
    if (typeof config.limits !== 'object' || Array.isArray(config.limits)) {
      throw new HttpError(400, 'BAD_CONFIG', `${where}: limits must be an object`);
    }
    for (const k of Object.keys(config.limits)) {
      if (!LIMIT_KEYS.includes(k)) {
        throw new HttpError(400, 'BAD_CONFIG', `${where}: unknown limit "${k}"`);
      }
      const v = config.limits[k];
      if (!Number.isInteger(v) || v < 1) {
        throw new HttpError(400, 'BAD_CONFIG', `${where}: limit ${k} must be a positive integer`);
      }
    }
  }
}

export function validateGraph(doc) {
  if (!doc || typeof doc !== 'object') throw new HttpError(400, 'BAD_GRAPH', 'graph must be an object');
  const nodes = doc.nodes;
  const edges = doc.edges ?? [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new HttpError(400, 'BAD_GRAPH', 'graph needs at least one node');
  }
  if (!Array.isArray(edges)) throw new HttpError(400, 'BAD_GRAPH', 'edges must be an array');
  const nodeIds = new Set();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || n.id.trim() === '') {
      throw new HttpError(400, 'BAD_GRAPH', 'every node needs a non-empty string id');
    }
    if (nodeIds.has(n.id)) throw new HttpError(400, 'BAD_GRAPH', `duplicate node id "${n.id}"`);
    nodeIds.add(n.id);
    validateConfig(n.config, `node "${n.id}"`);
  }
  const edgeIds = new Set();
  for (const e of edges) {
    if (!e || typeof e.id !== 'string' || e.id.trim() === '') {
      throw new HttpError(400, 'BAD_GRAPH', 'every edge needs a non-empty string id');
    }
    if (edgeIds.has(e.id)) throw new HttpError(400, 'BAD_GRAPH', `duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
    if (!nodeIds.has(e.source)) throw new HttpError(400, 'BAD_GRAPH', `edge "${e.id}": unknown source "${e.source}"`);
    if (!nodeIds.has(e.target)) throw new HttpError(400, 'BAD_GRAPH', `edge "${e.id}": unknown target "${e.target}"`);
    if (e.source === e.target) throw new HttpError(400, 'BAD_GRAPH', `edge "${e.id}": self-loops are not allowed`);
    if (e.attempts !== undefined && (!Number.isInteger(e.attempts) || e.attempts < 1 || e.attempts > 5)) {
      throw new HttpError(400, 'BAD_GRAPH', `edge "${e.id}": attempts must be an integer between 1 and 5`);
    }
    validateConfig(e.overrides, `edge "${e.id}" overrides`);
  }
  try {
    topoOrder({ nodes, edges });
  } catch (err) {
    if (err.code === 'CYCLE') throw new HttpError(400, 'CYCLE', 'graph must be a DAG (cycle detected)');
    throw err;
  }
  return { name: typeof doc.name === 'string' ? doc.name : 'graph', nodes, edges };
}

export class Store {
  constructor() {
    this.graphs = new Map(); // id -> { id, revision, current, revisions: Map<number, snapshot> }
    this.runs = new Map(); // runId -> run
  }

  createGraph(doc) {
    const graph = validateGraph(doc);
    const id = 'g-' + randomUUID().slice(0, 8);
    const snapshot = structuredClone(graph);
    this.graphs.set(id, { id, revision: 1, current: graph, revisions: new Map([[1, snapshot]]) });
    return { id, revision: 1, graph };
  }

  getGraph(id) {
    const g = this.graphs.get(id);
    if (!g) throw new HttpError(404, 'NOT_FOUND', `graph "${id}" not found`);
    return { id, revision: g.revision, graph: g.current };
  }

  listGraphs() {
    return [...this.graphs.values()].map((g) => ({
      id: g.id,
      revision: g.revision,
      name: g.current.name,
      nodeCount: g.current.nodes.length,
      edgeCount: g.current.edges.length,
    }));
  }

  getRevision(id, rev) {
    const g = this.graphs.get(id);
    if (!g) throw new HttpError(404, 'NOT_FOUND', `graph "${id}" not found`);
    const snapshot = g.revisions.get(rev);
    if (!snapshot) throw new HttpError(404, 'NOT_FOUND', `graph "${id}" has no revision ${rev}`);
    return { id, revision: rev, graph: snapshot };
  }

  listRevisions(id) {
    const g = this.graphs.get(id);
    if (!g) throw new HttpError(404, 'NOT_FOUND', `graph "${id}" not found`);
    return [...g.revisions.keys()].sort((a, b) => a - b);
  }

  // Optimistic concurrency: expectedRevision must match the current one,
  // otherwise 409 — a concurrent editor wins, the loser must rebase.
  updateGraph(id, doc, expectedRevision) {
    const g = this.graphs.get(id);
    if (!g) throw new HttpError(404, 'NOT_FOUND', `graph "${id}" not found`);
    if (expectedRevision !== g.revision) {
      throw new HttpError(
        409,
        'REVISION_CONFLICT',
        `revision conflict: expected ${expectedRevision}, current is ${g.revision}`
      );
    }
    const graph = validateGraph(doc);
    const next = g.revision + 1;
    g.current = graph;
    g.revision = next;
    g.revisions.set(next, structuredClone(graph));
    return { id, revision: next, graph };
  }

  // A run is pinned to the graph revision current at creation time. The
  // snapshot is stored inside the run, so later edits never affect it.
  // runId is a content hash: identical (graph, entry) -> identical run.
  createRun(graphId, entry) {
    const g = this.graphs.get(graphId);
    if (!g) throw new HttpError(404, 'NOT_FOUND', `graph "${graphId}" not found`);
    if (!entry || typeof entry.node !== 'string') {
      throw new HttpError(400, 'BAD_ENTRY', 'entry.node is required');
    }
    if (!g.current.nodes.some((n) => n.id === entry.node)) {
      throw new HttpError(400, 'BAD_ENTRY', `unknown entry node "${entry.node}"`);
    }
    const headers = entry.headers || {};
    const snapshot = structuredClone(g.current);
    const runId = 'r-' + contentHash({ graph: snapshot, entry: { node: entry.node, headers } }).slice(0, 16);
    const existing = this.runs.get(runId);
    if (existing) return { run: existing, existing: true };

    const { hops, joins, sensitiveValues } = runGraph(snapshot, { node: entry.node, headers }, runId);
    const run = scrubRunRecord(
      {
        runId,
        graphId,
        revision: g.revision,
        entry: { node: entry.node, headers: { ...headers } },
        hops,
        joins,
        graphSnapshot: snapshot,
      },
      sensitiveValues
    );
    this.runs.set(runId, run);
    return { run, existing: false };
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, 'NOT_FOUND', `run "${runId}" not found`);
    return run;
  }

  listRuns(graphId) {
    const all = [...this.runs.values()];
    const filtered = graphId ? all.filter((r) => r.graphId === graphId) : all;
    return filtered.map((r) => ({
      runId: r.runId,
      graphId: r.graphId,
      revision: r.revision,
      entry: r.entry,
      hopCount: r.hops.length,
    }));
  }

  getHop(runId, hopId) {
    const run = this.getRun(runId);
    const hop = run.hops.find((h) => h.hopId === hopId);
    if (!hop) throw new HttpError(404, 'NOT_FOUND', `run "${runId}" has no hop "${hopId}"`);
    return { run, hop };
  }

  // Compare any two hops (possibly from different runs/revisions).
  compare(refA, refB) {
    const parse = (ref) => {
      const [runId, hopId] = String(ref || '').split(':');
      if (!runId || !hopId) throw new HttpError(400, 'BAD_REF', 'hop refs must look like "runId:hopId"');
      return this.getHop(runId, hopId);
    };
    const a = parse(refA);
    const b = parse(refB);

    const index = (hop) => {
      const m = new Map();
      const counts = new Map();
      for (const member of hop.members) {
        // duplicate keys get occurrence suffixes so both sides stay comparable
        const n = (counts.get(member.outKey) || 0) + 1;
        counts.set(member.outKey, n);
        m.set(n === 1 ? member.outKey : `${member.outKey}#${n}`, member);
      }
      return m;
    };
    const am = index(a.hop);
    const bm = index(b.hop);
    const keys = [...new Set([...am.keys(), ...bm.keys()])].sort();
    const members = keys.map((key) => {
      const x = am.get(key);
      const y = bm.get(key);
      let change;
      if (!x) change = 'only-in-b';
      else if (!y) change = 'only-in-a';
      else if (x.status !== y.status) change = 'status-changed';
      else if (x.value !== y.value) change = 'value-changed';
      else change = 'same';
      return {
        key,
        a: x ? { status: x.status, value: x.value, reason: x.reason } : null,
        b: y ? { status: y.status, value: y.value, reason: y.reason } : null,
        change,
      };
    });
    const summarize = ({ run, hop }) => ({
      runId: run.runId,
      revision: run.revision,
      hopId: hop.hopId,
      pathId: hop.pathId,
      edge: `${hop.source} -> ${hop.target}`,
      attempt: hop.attempt,
      output: hop.output,
      trace: hop.trace,
    });
    return { a: summarize(a), b: summarize(b), members };
  }

  // Export is safe by construction: sensitive values were redacted when the
  // hop was recorded, so nothing secret can leak here.
  exportRun(runId) {
    const run = this.getRun(runId);
    return {
      format: 'baggage-workbench-export/v1',
      runId: run.runId,
      graphId: run.graphId,
      revision: run.revision,
      sensitiveValuesRedacted: true,
      entry: run.entry,
      joins: run.joins,
      hops: run.hops,
    };
  }
}
