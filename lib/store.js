// In-memory persistent store for config revisions and simulation runs.
//
// Concurrency model:
//   - Each config PUT must include expectedRevision; stale writes get HTTP 409.
//   - Every accepted write creates a new revision; older revisions remain
//     readable and runnable ("old runs never overwrite the new graph").
//   - Runs pin the exact revision they executed against.

import { createHash } from 'node:crypto';
import { validateConfig, normalizeConfig } from './config.js';
import { simulate } from './simulate.js';
import { sha256Hex, stableStringify } from './hash.js';

function configFingerprint(config) {
  return sha256Hex(stableStringify(config));
}

export function createStore() {
  const configs = new Map(); // id -> { id, revisions: [{revision, createdAt, fingerprint, config}], headRevision }
  const runs = new Map(); // runId -> run record
  let runSeq = 0;
  let cfgSeq = 0;

  function head(configId) {
    const rec = configs.get(configId);
    if (!rec) return null;
    return rec.revisions.find((r) => r.revision === rec.headRevision);
  }

  function createConfig({ id, config }) {
    const errors = validateConfig(config);
    if (errors.length) return { error: 'invalid-config', errors };
    const normalized = normalizeConfig(config);
    cfgSeq += 1;
    const revision = cfgSeq;
    const rec = {
      id,
      revisions: [{ revision, fingerprint: configFingerprint(normalized), config: normalized }],
      headRevision: revision,
    };
    configs.set(id, rec);
    return { configId: id, revision, fingerprint: rec.revisions[0].fingerprint, config: normalized };
  }

  // expectedRevision '0' or undefined means "must not exist yet".
  function putConfig(id, config, expectedRevision) {
    const errors = validateConfig(config);
    if (errors.length) return { error: 'invalid-config', errors };
    const normalized = normalizeConfig(config);
    const fp = configFingerprint(normalized);
    let rec = configs.get(id);

    if (!rec) {
      if (expectedRevision != null && expectedRevision !== 0) {
        return { error: 'conflict', currentRevision: 0, detail: 'config does not exist' };
      }
      cfgSeq += 1;
      const created = { id, revisions: [], headRevision: cfgSeq };
      configs.set(id, created);
      rec = created;
    } else if (Number(expectedRevision) !== rec.headRevision) {
      return {
        error: 'conflict',
        currentRevision: rec.headRevision,
        detail: `expected revision ${rec.headRevision}, got ${expectedRevision}`,
      };
    } else {
      cfgSeq += 1;
    }
    rec.revisions.push({ revision: cfgSeq, fingerprint: fp, config: normalized });
    rec.headRevision = cfgSeq;
    return { configId: id, revision: cfgSeq, fingerprint: fp, config: normalized };
  }

  function getConfig(id, revision) {
    const rec = configs.get(id);
    if (!rec) return null;
    if (revision == null) {
      return head(id);
    }
    return rec.revisions.find((r) => r.revision === Number(revision)) ?? null;
  }

  function listRevisions(id) {
    const rec = configs.get(id);
    if (!rec) return null;
    return {
      configId: id,
      headRevision: rec.headRevision,
      revisions: rec.revisions.map((r) => ({ revision: r.revision, fingerprint: r.fingerprint })),
    };
  }

  function listConfigs() {
    return [...configs.values()].map((rec) => ({
      configId: rec.id,
      headRevision: rec.headRevision,
      name: head(rec.id).config.name,
      revisions: rec.revisions.length,
    }));
  }

  // Run a simulation. Pinned revision is recorded; an explicit revision may
  // run an older graph even while a newer one exists. Inputs that produce the
  // same fingerprint against the same revision return the same stored run
  // (deterministic replay — no duplicate records).
  function runSimulation({ configId, revision, input, labels = {} }) {
    const rev = getConfig(configId, revision);
    if (!rev) return { error: 'not-found', detail: `no such config/revision: ${configId}@${revision}` };
    const inputFp = sha256Hex(stableStringify(input ?? {}));
    const key = `${configId}:${rev.revision}:${inputFp}:${sha256Hex(stableStringify(labels))}`;
    for (const run of runs.values()) {
      if (run.simKey === key) {
        return { ...run, reused: true };
      }
    }
    const result = simulate(input ?? {}, rev.config);
    if (!result.ok) return { error: 'simulation-failed', detail: result.error };
    runSeq += 1;
    const runId = `run-${runSeq}`;
    const record = {
      runId,
      simKey: key,
      configId,
      configName: rev.config.name,
      revision: rev.revision,
      configFingerprint: rev.fingerprint,
      headRevisionAtRun: configs.get(configId).headRevision,
      input,
      inputFingerprint: inputFp,
      labels,
      result: { seed: result.seed, hops: result.hops, services: result.services, resultHash: result.resultHash },
    };
    runs.set(runId, record);
    return { ...record, reused: false };
  }

  function getRun(runId) {
    return runs.get(runId) ?? null;
  }

  function listRuns() {
    return [...runs.values()].map((r) => ({
      runId: r.runId,
      configId: r.configId,
      configName: r.configName,
      revision: r.revision,
      headRevisionAtRun: r.headRevisionAtRun,
      resultHash: r.result.resultHash,
      stale: r.revision !== configs.get(r.configId)?.headRevision,
      labels: r.labels,
    }));
  }

  return {
    createConfig,
    putConfig,
    getConfig,
    listRevisions,
    listConfigs,
    runSimulation,
    getRun,
    listRuns,
  };
}
