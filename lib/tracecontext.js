// W3C Trace Context support: traceparent and tracestate.
// https://www.w3.org/TR/trace-context/
//
// traceparent = 00-trace-id-parent-id-trace-flags
// The workbench deterministically derives new span IDs per hop; trace IDs
// propagate unchanged (or a new trace starts at the root).

import { utf8ByteLength } from './encoding.js';

const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ALL_ZERO_16 = '0000000000000000';
const ALL_ZERO_32 = '0'.repeat(32);
const VERSION_FF = 'ff';

export function parseTraceparent(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const error = (detail) => ({ ok: false, reason: 'invalid-traceparent', detail });
  if (!value) return error('missing or empty traceparent');
  const parts = value.split('-');
  if (parts.length !== 4) return error('expected version-trace-parent-flags with 4 fields');
  const [version, traceId, spanId, flags] = parts;
  if (!/^[0-9a-f]{2}$/.test(version)) return error(`invalid version ${version}`);
  if (version === VERSION_FF) return error('version ff is forbidden');
  if (!HEX32.test(traceId)) return error('trace-id must be 32 lowercase hex chars');
  if (traceId === ALL_ZERO_32) return error('trace-id must not be all zero');
  if (!HEX16.test(spanId)) return error('parent-id must be 16 lowercase hex chars');
  if (spanId === ALL_ZERO_16) return error('parent-id must not be all zero');
  if (!/^[0-9a-f]{2}$/.test(flags)) return error('trace-flags must be 2 lowercase hex chars');
  return { ok: true, version, traceId, spanId, flags };
}

export function formatTraceparent({ version = '00', traceId, spanId, flags = '01' }) {
  return `${version}-${traceId}-${spanId}-${flags}`;
}

// tracestate member: "key=value"
// key = lcalpha 0*255( lcalpha / DIGIT / "_" / "-" / "*" / "/" / "@")
//     / ( lcalpha / DIGIT ) 0*240( lcalpha / DIGIT / "_" / "-" / "*" / "/" ) "@" lcalpha 0*13( lcalpha / DIGIT / "_" / "-" / "*" / "/" )
// value = 0*255(chr) nblk-chr = printable ASCII minus ',' '='; trimmed.
const TSTATE_KEY = /^[a-z][a-z0-9_*.\/@-]{0,255}$|^[a-z0-9][a-z0-9_*.\/-]{0,240}@[a-z][a-z0-9_*.\/-]{0,13}$/;
function isValidTstateValue(v) {
  if (v.length === 0 || v.length > 256) return false;
  if (/^[\s]|[\s]$/.test(v)) return false;
  for (const c of v) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return false;
    if (c === ',' || c === '=') return false;
  }
  return true;
}

// Parse tracestate header values (multiple fields combined with ',').
// Returns { members: [{key, value, raw}], dropped: [{reason, raw}] }.
export function parseTracestate(headerValues) {
  const values = (Array.isArray(headerValues) ? headerValues : [headerValues])
    .filter((v) => v != null)
    .map(String);
  const members = [];
  const dropped = [];
  const seen = new Set();
  for (const text of values) {
    for (const part0 of text.split(',')) {
      const part = part0.trim();
      if (part === '') {
        dropped.push({ reason: 'tracestate-empty-member', raw: part0 });
        continue;
      }
      const eq = part.indexOf('=');
      const key = eq < 0 ? '' : part.slice(0, eq);
      const val = eq < 0 ? '' : part.slice(eq + 1);
      if (!TSTATE_KEY.test(key) || !isValidTstateValue(val)) {
        dropped.push({ reason: 'invalid-tracestate', raw: part });
        continue;
      }
      if (seen.has(key)) {
        dropped.push({ reason: 'tracestate-duplicate-key', key, raw: part });
        continue;
      }
      seen.add(key);
      members.push({ key, value: val, raw: `${key}=${val}` });
    }
  }
  return { members, dropped };
}

export function serializeTracestate(members) {
  return members.map((m) => (m.raw != null ? m.raw : `${m.key}=${m.value}`)).join(',');
}

// Enforce the spec limits: at most 32 members, total list at most 512 bytes.
// Greedily keep the prefix that fits (order carries priority in tracestate).
export function applyTracestateLimits(members, { maxMembers = 32, maxTotalBytes = 512 } = {}) {
  const kept = [];
  const dropped = [];
  let bytes = 0;
  for (const m of members) {
    const raw = m.raw != null ? m.raw : `${m.key}=${m.value}`;
    const extra = (kept.length ? 1 : 0) + utf8ByteLength(raw);
    if (kept.length >= maxMembers) {
      dropped.push({ reason: 'tracestate-member-limit', key: m.key, detail: 'tracestate holds at most 32 members' });
      continue;
    }
    if (bytes + extra > maxTotalBytes) {
      dropped.push({ reason: 'tracestate-total-limit', key: m.key, detail: 'tracestate total length exceeds 512 bytes' });
      continue;
    }
    bytes += extra;
    kept.push(m);
  }
  return { members: kept, dropped, bytes };
}
