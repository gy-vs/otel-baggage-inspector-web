// W3C Baggage (https://www.w3.org/TR/baggage/) parsing and serialization.
// Pure and deterministic: no clocks, no randomness, no I/O.
//
// Design decisions (documented in README):
//  - Member order is preserved exactly as received.
//  - Duplicate keys are NOT dropped by the parser; later occurrences are
//    flagged so the engine can emit a deterministic "duplicate-key" drop event.
//  - Invalid percent-encoding / invalid UTF-8 never throws: the raw value
//    is kept verbatim and the member is flagged with an issue.
//  - Keys are case-sensitive per the spec ("Foo" and "foo" are distinct).

// token chars per RFC 7230 (baggage keys and property keys)
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// baggage-octet: %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
// i.e. visible ASCII except DQUOTE, COMMA, SEMICOLON, BACKSLASH.
// Note: '%' (0x25) is technically a baggage-octet, but we still encode it
// as %25 on output — a raw '%' is indistinguishable from the start of a
// percent-encoded sequence, so emitting it would break decode symmetry.
function isBaggageOctet(byte) {
  return (
    byte === 0x21 ||
    (byte >= 0x23 && byte <= 0x2b && byte !== 0x25) ||
    (byte >= 0x2d && byte <= 0x3a) ||
    (byte >= 0x3c && byte <= 0x5b) ||
    (byte >= 0x5d && byte <= 0x7e)
  );
}

const HEX = '0123456789ABCDEF';

// Canonical percent-encode of a JS string: UTF-8 bytes, pass through
// baggage-octets, everything else becomes %XX (uppercase hex).
export function encodeValue(str) {
  const bytes = Buffer.from(str, 'utf8');
  let out = '';
  for (const b of bytes) {
    out += isBaggageOctet(b) ? String.fromCharCode(b) : '%' + HEX[b >> 4] + HEX[b & 15];
  }
  return out;
}

// Decode a percent-encoded byte string.
// Returns { value, issues } — never throws. On any malformed sequence the
// raw input is returned verbatim and issues describe what went wrong.
export function decodeValue(raw) {
  const issues = [];
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '%') {
      const h = raw.slice(i + 1, i + 3);
      if (h.length === 2 && /^[0-9A-Fa-f]{2}$/.test(h)) {
        bytes.push(parseInt(h, 16));
        i += 2;
      } else {
        issues.push('invalid-percent-encoding');
        return { value: raw, issues }; // keep raw verbatim
      }
    } else {
      const code = ch.codePointAt(0);
      if (code > 0x7f) {
        // Raw non-ASCII byte in the header: not legal per spec, but keep it
        // (encoded as UTF-8) rather than dropping the member.
        issues.push('raw-non-ascii');
        const buf = Buffer.from(ch, 'utf8');
        for (const b of buf) bytes.push(b);
      } else {
        bytes.push(code);
      }
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return { value: decoder.decode(Buffer.from(bytes)), issues };
  } catch {
    issues.push('invalid-utf8');
    return { value: raw, issues };
  }
}

function parseProperty(segment) {
  const eq = segment.indexOf('=');
  if (eq === -1) {
    return { key: segment.trim(), value: null, rawValue: null, issues: [] };
  }
  const key = segment.slice(0, eq).trim();
  const rawValue = segment.slice(eq + 1).trim();
  const { value, issues } = decodeValue(rawValue);
  return { key, value, rawValue, issues };
}

// Parse a baggage header value.
// Returns { members, diagnostics } where members preserve received order:
//   { key, value, rawValue, properties: [...], issues: [...], duplicateOf: string|null }
export function parseBaggage(header) {
  const members = [];
  const diagnostics = [];
  if (header == null || String(header).trim() === '') {
    return { members, diagnostics };
  }
  const seen = new Map(); // key -> first index
  const segments = String(header).split(',');
  segments.forEach((rawSeg, segIdx) => {
    const seg = rawSeg.trim();
    if (seg === '') {
      // OWS / empty entries between commas are tolerated silently.
      return;
    }
    const parts = seg.split(';');
    const kv = parts[0];
    const eq = kv.indexOf('=');
    if (eq === -1) {
      diagnostics.push({ code: 'malformed-member', segment: seg, index: segIdx });
      return; // member cannot be parsed at all -> dropped by parser
    }
    const key = kv.slice(0, eq).trim();
    const rawValue = kv.slice(eq + 1).trim();
    const issues = [];
    if (!TOKEN_RE.test(key)) issues.push('invalid-key');
    const decoded = decodeValue(rawValue);
    issues.push(...decoded.issues);
    const properties = [];
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      if (p === '') continue;
      const prop = parseProperty(p);
      if (!TOKEN_RE.test(prop.key)) prop.issues.push('invalid-key');
      properties.push(prop);
    }
    const member = {
      key,
      value: decoded.value,
      rawValue,
      properties,
      issues,
      duplicateOf: null,
    };
    if (seen.has(key)) {
      member.duplicateOf = key;
      diagnostics.push({ code: 'duplicate-key', key, index: segIdx });
    } else {
      seen.set(key, members.length);
    }
    members.push(member);
  });
  return { members, diagnostics };
}

// Canonical serialization. Members with invalid encoding keep their raw
// value verbatim (we cannot safely re-encode what we could not decode).
export function serializeMember(member) {
  const value =
    member.issues && member.issues.includes('invalid-percent-encoding')
      ? member.rawValue
      : encodeValue(member.value);
  let out = `${member.key}=${value}`;
  for (const p of member.properties || []) {
    out += '; ' + p.key;
    if (p.value !== null && p.value !== undefined) {
      out += '=' + (p.rawValue !== null && p.rawValue !== undefined && p.issues?.includes('invalid-percent-encoding')
        ? p.rawValue
        : encodeValue(p.value));
    }
  }
  return out;
}

export function serializeBaggage(members) {
  return members.map(serializeMember).join(', ');
}

// Byte length of a serialized member (used for per-member limits).
export function memberByteLength(member) {
  return Buffer.byteLength(serializeMember(member), 'utf8');
}
