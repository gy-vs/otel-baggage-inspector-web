// Service graph configuration: validation and normalization.
//
// A config describes:
//   services: per-service baggage policy
//     - limits: maxTotalBytes / maxMembers / maxMemberBytes (0 = unlimited)
//     - allowlist: when non-empty, only listed keys survive ingress
//     - rename: ordered {from, to} rules (case-sensitive by default)
//     - sensitiveKeys: keys deleted at ingress; values never appear in exports
//     - ignoreCase: make allowlist/rename/sensitive matching case-insensitive
//   edges: calls between services
//     - transform: addMembers / setMembers / deleteKeys / renameKeys / dropAll
//     - retries: number of retry attempts (>0 yields extra attempt hops)
//     - retrySpan: 'reuse' (same span id) | 'new' (fresh deterministic span)
//   join services may declare merge: 'isolate' (default; branches stay
//   independent) or 'union' (incoming baggage lists combined; conflict =
//   duplicate keys after merge, first arrival wins).

import { DEFAULT_LIMITS } from './baggage.js';

const VALID_REASONS_EVENTS = true; // (documented in simulate.js)

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['config must be an object'];
  }
  const services = cfg.services;
  const edges = cfg.edges ?? [];

  if (!Array.isArray(services) || services.length === 0) {
    errors.push('services must be a non-empty array');
  }

  const ids = new Set();
  if (Array.isArray(services)) {
    for (const [i, svc] of services.entries()) {
      const where = `services[${i}]`;
      if (!svc || typeof svc !== 'object') {
        errors.push(`${where} must be an object`);
        continue;
      }
      if (typeof svc.id !== 'string' || svc.id.trim() === '') {
        errors.push(`${where}.id must be a non-empty string`);
      } else if (ids.has(svc.id)) {
        errors.push(`${where}.id duplicate: ${svc.id}`);
      } else {
        ids.add(svc.id);
      }
      if (svc.limits !== undefined) {
        validateLimits(svc.limits, `${where}.limits`, errors);
      }
      if (svc.allowlist !== undefined && svc.allowlist !== null && !strArray(svc.allowlist)) {
        errors.push(`${where}.allowlist must be an array of strings (or null)`);
      }
      if (svc.sensitiveKeys !== undefined && !strArray(svc.sensitiveKeys)) {
        errors.push(`${where}.sensitiveKeys must be an array of strings`);
      }
      if (svc.ignoreCase !== undefined && typeof svc.ignoreCase !== 'boolean') {
        errors.push(`${where}.ignoreCase must be boolean`);
      }
      if (svc.merge !== undefined && svc.merge !== 'isolate' && svc.merge !== 'union') {
        errors.push(`${where}.merge must be 'isolate' or 'union'`);
      }
      if (svc.rename !== undefined) validateRenames(svc.rename, `${where}.rename`, errors);
    }
  }

  if (!Array.isArray(edges)) {
    errors.push('edges must be an array');
  } else if (ids.size > 0) {
    if (Array.isArray(services)) {
      for (const [i, edge] of edges.entries()) {
        const where = `edges[${i}]`;
        if (!edge || typeof edge !== 'object') {
          errors.push(`${where} must be an object`);
          continue;
        }
        if (!ids.has(edge.from)) errors.push(`${where}.from unknown service: ${edge.from}`);
        if (!ids.has(edge.to)) errors.push(`${where}.to unknown service: ${edge.to}`);
        if (edge.from === edge.to && edge.from !== undefined) {
          errors.push(`${where}.self-loops are not allowed: ${edge.from}`);
        }
        const t = edge.transform;
        if (t !== undefined) {
          if (typeof t !== 'object' || Array.isArray(t)) {
            errors.push(`${where}.transform must be an object`);
          } else {
            if (t.addMembers !== undefined && !memberSpecArray(t.addMembers)) {
              errors.push(`${where}.transform.addMembers must be [{key, value}]`);
            }
            if (t.setMembers !== undefined && t.setMembers !== null && !memberSpecArray(t.setMembers)) {
              errors.push(`${where}.transform.setMembers must be [{key, value}] (or null)`);
            }
            if (t.deleteKeys !== undefined && !strArray(t.deleteKeys)) {
              errors.push(`${where}.transform.deleteKeys must be an array of strings`);
            }
            if (t.renameKeys !== undefined) validateRenames(t.renameKeys, `${where}.transform.renameKeys`, errors);
            if (t.dropAll !== undefined && typeof t.dropAll !== 'boolean') {
              errors.push(`${where}.transform.dropAll must be boolean`);
            }
          }
        }
        if (edge.retries !== undefined && (!Number.isInteger(edge.retries) || edge.retries < 0)) {
          errors.push(`${where}.retries must be a non-negative integer`);
        }
        if (edge.retrySpan !== undefined && !['reuse', 'new'].includes(edge.retrySpan)) {
          errors.push(`${where}.retrySpan must be 'reuse' or 'new'`);
        }
      }
    }

    // Graph structure checks: no cycles, and 'union' only on fan-in nodes.
    if (errors.length === 0) {
      const cycle = findCycle(services, edges);
      if (cycle) errors.push(`graph has a cycle involving: ${cycle.join(' -> ')}`);
      const indegree = new Map();
      for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
      for (const svc of services) {
        if (svc.merge === 'union' && (indegree.get(svc.id) ?? 0) < 2) {
          errors.push(`service ${svc.id}: merge='union' requires at least two incoming edges`);
        }
      }
    }
  }

  return errors;
}

function validateLimits(limits, where, errors) {
  if (typeof limits !== 'object' || Array.isArray(limits)) {
    errors.push(`${where} must be an object`);
    return;
  }
  for (const k of ['maxTotalBytes', 'maxMembers', 'maxMemberBytes']) {
    if (limits[k] === undefined) continue;
    if (!Number.isInteger(limits[k]) || limits[k] < 0) {
      errors.push(`${where}.${k} must be a non-negative integer (0 = unlimited)`);
    }
  }
}

function validateRenames(rules, where, errors) {
  if (!Array.isArray(rules)) {
    errors.push(`${where} must be an array of {from,to}`);
    return;
  }
  rules.forEach((r, i) => {
    if (!r || typeof r !== 'object' || typeof r.from !== 'string' || typeof r.to !== 'string' || !r.from || !r.to) {
      errors.push(`${where}[${i}] must be {from: string, to: string}`);
    }
  });
}

function strArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function memberSpecArray(v) {
  return Array.isArray(v) && v.every(
    (m) => m && typeof m === 'object' && typeof m.key === 'string' && m.key !== '' &&
      (m.value === undefined || typeof m.value === 'string')
  );
}

function findCycle(services, edges) {
  const adj = new Map(services.map((s) => [s.id, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(services.map((s) => [s.id, WHITE]));
  const stack = [];
  function dfs(u) {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        return [...stack.slice(stack.indexOf(v)), v];
      }
      if (color.get(v) === WHITE) {
        const c = dfs(v);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  }
  for (const s of services) {
    if (color.get(s.id) === WHITE) {
      const c = dfs(s.id);
      if (c) return c;
    }
  }
  return null;
}

// Fill defaults and return a new config object.
export function normalizeConfig(cfg) {
  const services = cfg.services.map((svc) => ({
    id: svc.id,
    limits: { ...DEFAULT_LIMITS, ...(svc.limits ?? {}) },
    allowlist: svc.allowlist ?? null,
    sensitiveKeys: svc.sensitiveKeys ?? [],
    rename: svc.rename ?? [],
    ignoreCase: svc.ignoreCase ?? false,
    merge: svc.merge ?? 'isolate',
  }));
  const edges = (cfg.edges ?? []).map((e) => ({
    from: e.from,
    to: e.to,
    transform: e.transform
      ? {
          addMembers: e.transform.addMembers ?? [],
          setMembers: e.transform.setMembers ?? null,
          deleteKeys: e.transform.deleteKeys ?? [],
          renameKeys: e.transform.renameKeys ?? [],
          dropAll: e.transform.dropAll ?? false,
        }
      : null,
    retries: e.retries ?? 0,
    retrySpan: e.retrySpan ?? 'reuse',
  }));
  return { name: cfg.name ?? 'Untitled graph', services, edges };
}

export { DEFAULT_LIMITS, VALID_REASONS_EVENTS };
