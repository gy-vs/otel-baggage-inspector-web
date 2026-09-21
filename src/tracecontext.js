// W3C Trace Context propagation. Deterministic: new span/trace ids are
// derived from a caller-supplied seed via SHA-256, never from randomness.
import { createHash } from 'node:crypto';

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header) {
  const diagnostics = [];
  if (header == null || String(header).trim() === '') {
    return { context: null, diagnostics: [{ code: 'missing-traceparent' }] };
  }
  const m = TRACEPARENT_RE.exec(String(header).trim());
  if (!m) {
    diagnostics.push({ code: 'malformed-traceparent' });
    return { context: null, diagnostics };
  }
  const [, version, traceId, spanId, flags] = m;
  if (version === 'ff') {
    diagnostics.push({ code: 'forbidden-version', version });
    return { context: null, diagnostics };
  }
  if (version !== '00') {
    diagnostics.push({ code: 'unsupported-version', version });
    return { context: null, diagnostics };
  }
  if (traceId === '0'.repeat(32)) {
    diagnostics.push({ code: 'zero-trace-id' });
    return { context: null, diagnostics };
  }
  if (spanId === '0'.repeat(16)) {
    diagnostics.push({ code: 'zero-span-id' });
    return { context: null, diagnostics };
  }
  const flagByte = parseInt(flags, 16);
  return {
    context: {
      version,
      traceId,
      spanId,
      flags,
      sampled: (flagByte & 1) === 1,
    },
    diagnostics,
  };
}

export function formatTraceparent(ctx) {
  return `${ctx.version}-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}

// Deterministic id derivation: sha256(seed) hex, sliced.
export function deriveId(seed, length) {
  let hex = '';
  let counter = 0;
  while (hex.length < length) {
    hex += createHash('sha256').update(`${seed}#${counter++}`).digest('hex');
  }
  return hex.slice(0, length);
}

const TRACESTATE_MAX_MEMBERS = 32;
const TRACESTATE_MAX_LENGTH = 512;

// Parse tracestate ("k=v,k2=v2"). Enforces the 32-member / 512-char limits
// by dropping from the tail (deterministic), recording diagnostics.
export function parseTracestate(header) {
  const diagnostics = [];
  if (header == null || String(header).trim() === '') {
    return { members: [], diagnostics };
  }
  const raw = String(header).trim();
  if (raw.length > TRACESTATE_MAX_LENGTH) {
    diagnostics.push({ code: 'tracestate-too-long', length: raw.length, limit: TRACESTATE_MAX_LENGTH });
  }
  const members = [];
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (seg === '') continue;
    const eq = seg.indexOf('=');
    if (eq === -1) {
      diagnostics.push({ code: 'malformed-tracestate-member', segment: seg });
      continue;
    }
    members.push({ key: seg.slice(0, eq).trim(), value: seg.slice(eq + 1).trim() });
  }
  if (members.length > TRACESTATE_MAX_MEMBERS) {
    diagnostics.push({
      code: 'tracestate-too-many-members',
      count: members.length,
      limit: TRACESTATE_MAX_MEMBERS,
      dropped: members.slice(TRACESTATE_MAX_MEMBERS).map((m) => m.key),
    });
    members.length = TRACESTATE_MAX_MEMBERS;
  }
  // Enforce total length by tail-dropping until it fits.
  while (members.length > 0 && serializeTracestate(members).length > TRACESTATE_MAX_LENGTH) {
    const dropped = members.pop();
    diagnostics.push({ code: 'tracestate-truncated', droppedKey: dropped.key });
  }
  return { members, diagnostics };
}

export function serializeTracestate(members) {
  return members.map((m) => `${m.key}=${m.value}`).join(',');
}
