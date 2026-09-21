// Deterministic hashing and identifier derivation.
// The simulator is a pure function of (input, config): there is no randomness
// and no wall clock anywhere. Span/trace IDs are derived from a SHA-256
// hash so identical inputs always replay identically.

import { createHash } from 'node:crypto';

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Canonical JSON: object keys sorted recursively, arrays preserve order.
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortValue(v[k]);
    }
    return out;
  }
  return v;
}

// 16 hex chars for a span id / 32 for a trace id. Deterministic; never zero
// (spec forbids all-zero IDs), so we hash again if it happens.
export function deriveId(kind, seed, counter = 0) {
  const len = kind === 'trace' ? 32 : 16;
  const zero = '0'.repeat(len);
  let digest = sha256Hex(`${kind}:${seed}:${counter}`);
  let n = 0;
  while (digest.slice(0, len) === zero) {
    digest = sha256Hex(digest);
    if (n++ > 4) throw new Error('could not derive nonzero id');
  }
  return digest.slice(0, len);
}
