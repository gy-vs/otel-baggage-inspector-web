// W3C Baggage (https://www.w3.org/TR/baggage/) parser and serializer.
//
// Grammar implemented:
//   baggage-string  = list-members 0OWS
//   list-member     = key OWS "=" OWS value *( OWS ";" OWS property )
//   key             = token ; percent-encoded
//   value           = *bagcooked / %x22 *bagdqtext %x22
//   property        = key [ OWS "=" OWS value ]
//   token           = 1*tchar
//   tchar           = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" /
//                     "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
//   bag-octet       = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
//   bagcooked       = bag-octet / pct-encoded
//   bagdq-char      = %x09 / %x20 / bag-octet / pct-encoded
//   pct-encoded     = "%" HEXDIG HEXDIG
//
// Parsing is strict on grammar (the workbench exists to surface problems),
// but never throws: invalid members are reported with a reason and dropped.
// Order of valid members is preserved. Duplicate keys keep the first member
// (per the "list with unique keys" requirement) and later ones are reported.

import { percentDecode, percentEncode, utf8ByteLength } from './encoding.js';

export const DEFAULT_LIMITS = Object.freeze({
  // 0 means unlimited. These mirror common propagator defaults; the workbench
  // allows shrinking them per service so overflow behavior can be exercised.
  maxTotalBytes: 8192,
  maxMembers: 100,
  maxMemberBytes: 4096,
});

const TOKEN_CHARS = new Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
// bag-octet: printable ASCII excluding '"' (0x22), ',' (0x2C), ';' (0x3B), '\\' (0x5C)
function isBagOctet(c) {
  const code = c.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x7e && c !== '"' && c !== ',' && c !== ';' && c !== '\\')
  );
}
// bagdq-char: bag-octet plus SP and HT
function isDqChar(c) {
  return c === ' ' || c === '\t' || isBagOctet(c);
}

function isToken(s) {
  if (s.length === 0) return false;
  for (const c of s) {
    if (!TOKEN_CHARS.has(c)) return false;
  }
  return true;
}

// Validate raw value text: every '%' must be a valid pct-encoded triplet,
// every other character must be allowed (quoted vs unquoted charset).
function validateValueRaw(raw, quoted) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '%') {
      if (i + 2 >= raw.length || !isHexChar(raw[i + 1]) || !isHexChar(raw[i + 2])) {
        return { ok: false, reason: 'bad-percent-encoding' };
      }
      i += 2;
    } else if (!(quoted ? isDqChar(c) : isBagOctet(c))) {
      return { ok: false, reason: 'bad-value-charset' };
    }
  }
  return { ok: true };
}

function isHexChar(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// Parse one "key=value;prop;prop" member (commas already stripped, OWS
// trimming done by caller). Returns { member } or { error: {reason, detail} }.
function parseMember(rawMember) {
  // key OWS "="
  const eq = rawMember.indexOf('=');
  if (eq < 0) return { error: { reason: 'bad-key', detail: 'missing "=" in member' } };

  let keyEnd = eq;
  while (keyEnd > 0 && isOws(rawMember[keyEnd - 1])) keyEnd--;
  const key = rawMember.slice(0, keyEnd);
  if (!isToken(key)) {
    return { error: { reason: 'bad-key', detail: `key ${JSON.stringify(key)} is not a token` } };
  }

  // OWS after "="
  let pos = eq + 1;
  while (pos < rawMember.length && isOws(rawMember[pos])) pos++;

  // Read value up to the first unquoted ";" (semicolon cannot appear in values
  // at all, so quoting does not change splitting).
  let valueEnd = pos;
  while (valueEnd < rawMember.length && rawMember[valueEnd] !== ';') valueEnd++;
  let valueRaw = rawMember.slice(pos, valueEnd);
  valueRaw = trimTrailingOws(valueRaw);

  let quoted = false;
  if (valueRaw.length >= 2 && valueRaw[0] === '"' && valueRaw[valueRaw.length - 1] === '"') {
    quoted = true;
    valueRaw = valueRaw.slice(1, -1);
  }

  const vcheck = validateValueRaw(valueRaw, quoted);
  if (!vcheck.ok) {
    return { error: { reason: vcheck.reason, detail: `member ${key}=...: ${vcheck.reason}` } };
  }
  const decoded = percentDecode(valueRaw);
  if (decoded === null) {
    return { error: { reason: 'bad-percent-encoding', detail: `member ${key}: invalid UTF-8 after percent-decode` } };
  }

  // Properties
  const properties = [];
  let p = valueEnd;
  while (p < rawMember.length) {
    // at ';'
    p++; // skip ';'
    while (p < rawMember.length && isOws(rawMember[p])) p++;
    let end = p;
    while (end < rawMember.length && rawMember[end] !== ';') end++;
    let part = rawMember.slice(p, end);
    part = trimTrailingOws(part);
    if (part.length === 0) {
      return { error: { reason: 'bad-property', detail: `member ${key}: empty property` } };
    }
    const prop = parseProperty(key, part);
    if (prop.error) return { error: prop.error };
    properties.push(prop.property);
    p = end;
  }

  return {
    member: {
      key, // case-sensitive, percent form (token chars only)
      value: decoded, // percent-decoded Unicode string
      encodedValue: valueRaw, // original (unquoted inner) raw text, preserved on round trip
      quoted,
      properties, // ordered; [{key, value, encodedValue, quoted}]
    },
  };
}

function parseProperty(memberKey, part) {
  const eq = part.indexOf('=');
  let pk, pv = '', pvRaw = '', pvQuoted = false;
  if (eq < 0) {
    pk = part;
  } else {
    let kEnd = eq;
    while (kEnd > 0 && isOws(part[kEnd - 1])) kEnd--;
    pk = part.slice(0, kEnd);
    let vStart = eq + 1;
    while (vStart < part.length && isOws(part[vStart])) vStart++;
    pvRaw = trimTrailingOws(part.slice(vStart));
    if (pvRaw.length >= 2 && pvRaw[0] === '"' && pvRaw[pvRaw.length - 1] === '"') {
      pvQuoted = true;
      pvRaw = pvRaw.slice(1, -1);
    }
    const c = validateValueRaw(pvRaw, pvQuoted);
    if (!c.ok) return { error: { reason: 'bad-property', detail: `member ${memberKey}: property value ${c.reason}` } };
    const d = percentDecode(pvRaw);
    if (d === null) return { error: { reason: 'bad-property', detail: `member ${memberKey}: bad UTF-8 in property` } };
    pv = d;
  }
  if (!isToken(pk)) {
    return { error: { reason: 'bad-property', detail: `member ${memberKey}: property key ${JSON.stringify(pk)} is not a token` } };
  }
  return {
    property: { key: pk, value: pv, encodedValue: pvRaw, quoted: pvQuoted },
  };
}

function isOws(c) {
  return c === ' ' || c === '\t';
}
function trimLeadingOws(s) {
  let i = 0;
  while (i < s.length && isOws(s[i])) i++;
  return s.slice(i);
}
function trimTrailingOws(s) {
  let i = s.length;
  while (i > 0 && isOws(s[i - 1])) i--;
  return s.slice(0, i);
}

// Parse one or more baggage header field values. Multiple header fields are
// combined with "," per HTTP, which coincides with the member separator.
// Returns { members, dropped: [{reason, key?, raw?, detail}] }.
export function parseBaggage(headerValues) {
  const values = (Array.isArray(headerValues) ? headerValues : [headerValues])
    .filter((v) => v != null)
    .map(String);
  const text = values.join(',');
  const trimmed = trimTrailingOws(text);

  const members = [];
  const dropped = [];
  const seenKeys = new Set();
  if (trimmed.length === 0) return { members, dropped };

  // Commas cannot appear inside member values, so plain splitting is exact.
  const parts = trimmed.split(',');
  for (const partRaw of parts) {
    const part = trimTrailingOws(trimLeadingOws(partRaw));
    if (part.length === 0) {
      dropped.push({ reason: 'empty-member', raw: partRaw, detail: 'empty list member (e.g. trailing comma)' });
      continue;
    }
    const { member, error } = parseMember(part);
    if (error) {
      dropped.push({ raw: part, ...error });
      continue;
    }
    if (seenKeys.has(member.key)) {
      dropped.push({
        reason: 'duplicate-key',
        key: member.key,
        raw: part,
        detail: `key ${member.key} appeared more than once; first member kept`,
      });
      continue;
    }
    seenKeys.add(member.key);
    members.push(member);
  }
  return { members, dropped };
}

// Normalized serialized property text (key or key=encoded-value).
function serializeProperty(prop) {
  if (prop.value === '' && !prop.encodedValue) return prop.key;
  const encoded = prop.encodedValue != null && percentDecode(prop.encodedValue) === prop.value
    ? prop.encodedValue
    : percentEncode(prop.value);
  return `${prop.key}=${encoded}`;
}

// Normalized serialized member WITHOUT surrounding list separators.
// Preserves the original percent-encoding text (including hex casing and
// double quotes) when it still decodes to the current decoded value;
// otherwise re-encodes canonically.
export function serializeMember(member) {
  let valuePart;
  if (member.encodedValue != null && percentDecode(member.encodedValue) === member.value) {
    valuePart = member.quoted ? `"${member.encodedValue}"` : member.encodedValue;
  } else {
    valuePart = percentEncode(member.value);
  }
  let out = `${member.key}=${valuePart}`;
  for (const prop of member.properties) {
    out += ';' + serializeProperty(prop);
  }
  return out;
}

// Serialize members to a single baggage header string.
export function serializeBaggage(members) {
  return members.map(serializeMember).join(',');
}

// Byte length of a serialized header (UTF-8).
export function baggageByteLength(members) {
  return utf8ByteLength(serializeBaggage(members));
}

// Byte length of a single normalized member.
export function memberByteLength(member) {
  return utf8ByteLength(serializeMember(member));
}
