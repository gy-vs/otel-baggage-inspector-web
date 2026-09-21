// Byte/percent-encoding helpers used by W3C baggage parsing and serialization.
// All conversions go through UTF-8 so that Unicode keys/values round-trip
// through percent-encoding exactly as required by the baggage specification.

const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Bytes(str) {
  return utf8Encoder.encode(str);
}

// Length of a string measured in UTF-8 encoded bytes.
export function utf8ByteLength(str) {
  return utf8Encoder.encode(str).length;
}

// RFC 3986 unreserved characters. Everything else in a baggage value is
// percent-encoded when we serialize from a decoded value.
const UNRESERVED = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
);

export function percentEncode(str) {
  const bytes = utf8Bytes(str);
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (UNRESERVED.has(c)) {
      out += c;
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// Percent-decode per RFC 3986. Returns null on malformed escapes or on
// percent-decoded bytes that are not valid UTF-8 (baggage requires UTF-8).
export function percentDecode(raw) {
  const bytes = new Uint8Array(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (ch > 0xff) {
      // Raw (non-encoded) non-ASCII code unit: re-encode through UTF-8
      // by re-encoding the whole source instead.
      try {
        return fatalUtf8Decoder.decode(utf8Bytes(raw));
      } catch {
        return null;
      }
    }
    if (raw[i] === '%') {
      if (i + 2 >= raw.length || !isHex(raw[i + 1]) || !isHex(raw[i + 2])) {
        return null;
      }
      bytes[n++] = parseInt(raw.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      bytes[n++] = ch;
    }
  }
  try {
    return fatalUtf8Decoder.decode(bytes.subarray(0, n));
  } catch {
    return null;
  }
}

function isHex(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
