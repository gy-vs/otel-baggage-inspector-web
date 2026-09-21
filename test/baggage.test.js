import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBaggage, serializeBaggage, encodeValue, decodeValue } from '../src/baggage.js';

test('member order and properties are preserved', () => {
  const { members } = parseBaggage('b=2;p1=x;p2,a=1,c=3;note=hi');
  assert.deepEqual(members.map((m) => m.key), ['b', 'a', 'c']);
  assert.deepEqual(
    members[0].properties.map((p) => [p.key, p.value]),
    [['p1', 'x'], ['p2', null]]
  );
  assert.deepEqual(
    members[2].properties.map((p) => [p.key, p.value]),
    [['note', 'hi']]
  );
});

test('percent-decoding: space, comma, lowercase hex', () => {
  const { members } = parseBaggage('k=a%20b%2Cc%3Bd');
  assert.equal(members[0].value, 'a b,c;d');
  const lower = parseBaggage('k=%2c%3b');
  assert.equal(lower.members[0].value, ',;');
});

test('bad percent-encoding is flagged, raw value kept', () => {
  for (const raw of ['%ZZ', '%A', '100%', 'a%2']) {
    const { members } = parseBaggage(`k=${raw}`);
    assert.equal(members.length, 1);
    assert.ok(members[0].issues.includes('invalid-percent-encoding'), raw);
    assert.equal(members[0].value, raw, 'raw value preserved verbatim');
  }
});

test('unicode percent-encoding decodes to UTF-8', () => {
  const { members } = parseBaggage('city=%E4%B8%AD%E6%96%87');
  assert.equal(members[0].value, '中文');
});

test('invalid UTF-8 byte sequence is flagged', () => {
  const { members } = parseBaggage('k=%FF%FE');
  assert.ok(members[0].issues.includes('invalid-utf8'));
});

test('duplicate keys: parser keeps both, flags the later one', () => {
  const { members, diagnostics } = parseBaggage('a=1,b=2,a=3');
  assert.equal(members.length, 3);
  assert.equal(members[2].duplicateOf, 'a');
  assert.ok(diagnostics.some((d) => d.code === 'duplicate-key' && d.key === 'a'));
});

test('keys are case-sensitive: Foo and foo are distinct', () => {
  const { members, diagnostics } = parseBaggage('Foo=1,foo=2,FOO=3');
  assert.equal(members.length, 3);
  assert.ok(!diagnostics.some((d) => d.code === 'duplicate-key'));
  assert.deepEqual(members.map((m) => m.key), ['Foo', 'foo', 'FOO']);
});

test('key-only property (flag) has null value', () => {
  const { members } = parseBaggage('k=v;flag;other=x');
  assert.deepEqual(members[0].properties[0], { key: 'flag', value: null, rawValue: null, issues: [] });
});

test('malformed member without "=" is reported and skipped', () => {
  const { members, diagnostics } = parseBaggage('oops,a=1');
  assert.deepEqual(members.map((m) => m.key), ['a']);
  assert.ok(diagnostics.some((d) => d.code === 'malformed-member'));
});

test('encodeValue uses canonical uppercase percent-encoding', () => {
  assert.equal(encodeValue('a b,c;d\\e"f'), 'a%20b%2Cc%3Bd%5Ce%22f');
  assert.equal(encodeValue('100%'), '100%25', 'bare % is encoded for decode symmetry');
  assert.equal(encodeValue('中文'), '%E4%B8%AD%E6%96%87');
  assert.equal(encodeValue("!#$&'()*+-./09:AZ[]^_`az{}~"), "!#$&'()*+-./09:AZ[]^_`az{}~");
});

test('decodeValue rejects truncated sequences deterministically', () => {
  assert.deepEqual(decodeValue('%'), { value: '%', issues: ['invalid-percent-encoding'] });
  assert.deepEqual(decodeValue('%1'), { value: '%1', issues: ['invalid-percent-encoding'] });
  assert.deepEqual(decodeValue('%41'), { value: 'A', issues: [] });
});

test('serialize -> parse roundtrip is stable', () => {
  const original = 'user_id=42;trace=1,session=abc%20def,city=%E4%B8%AD%E6%96%87,flag=';
  const once = serializeBaggage(parseBaggage(original).members);
  const twice = serializeBaggage(parseBaggage(once).members);
  assert.equal(once, twice, 'serialization is a fixed point');
  assert.equal(once, 'user_id=42; trace=1, session=abc%20def, city=%E4%B8%AD%E6%96%87, flag=');
});

test('empty and whitespace-only headers parse to zero members', () => {
  assert.equal(parseBaggage('').members.length, 0);
  assert.equal(parseBaggage('   ').members.length, 0);
  assert.equal(parseBaggage(null).members.length, 0);
  assert.equal(parseBaggage('a=1,,b=2,').members.length, 2);
});
