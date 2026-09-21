import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBaggage,
  serializeBaggage,
  serializeMember,
  memberByteLength,
} from '../lib/baggage.js';

test('member order and properties are preserved', () => {
  const raw = 'a=1;p1;x=2,b=hello%20world;ttl=60;x=y';
  const { members, dropped } = parseBaggage([raw]);
  assert.equal(dropped.length, 0);
  assert.deepEqual(members.map((m) => m.key), ['a', 'b']);
  assert.equal(members[0].value, '1');
  assert.deepEqual(members[0].properties.map((p) => p.key), ['p1', 'x']);
  assert.equal(members[0].properties[0].value, '');
  assert.equal(members[0].properties[1].value, '2');
  assert.equal(members[1].value, 'hello world');
  assert.deepEqual(members[1].properties.map((p) => [p.key, p.value]), [['ttl', '60'], ['x', 'y']]);
});

test('percent-encoding round-trips Unicode and preserves original spelling', () => {
  const { members } = parseBaggage(['city=%E5%8C%97%E4%BA%AC,emoji=%F0%9F%98%80']);
  assert.equal(members[0].value, '北京');
  assert.equal(members[1].value, '😀');
  // Original percent text (uppercase hex) is preserved verbatim on serialize.
  assert.equal(serializeBaggage(members), 'city=%E5%8C%97%E4%BA%AC,emoji=%F0%9F%98%80');
});

test('re-encodes canonically when decoded value differs from wire text', () => {
  const { members } = parseBaggage(['k=%61%62']); // 'ab'
  assert.equal(members[0].value, 'ab');
  // Wire text still decodes to same value -> preserved.
  assert.equal(serializeMember(members[0]), 'k=%61%62');
  members[0].value = 'a+b';
  assert.equal(serializeMember(members[0]), 'k=a%2Bb');
});

test('malformed percent escapes are dropped with a reason', () => {
  const { members, dropped } = parseBaggage(['ok=1,bad=%zz,worse=%4,alsobad=%XY']);
  assert.deepEqual(members.map((m) => m.key), ['ok']);
  assert.deepEqual(dropped.map((d) => d.reason), ['bad-percent-encoding', 'bad-percent-encoding', 'bad-percent-encoding']);
});

test('percent bytes that decode to invalid UTF-8 are dropped', () => {
  const { members, dropped } = parseBaggage(['good=x,bad=%FF']);
  assert.deepEqual(members.map((m) => m.key), ['good']);
  assert.equal(dropped[0].reason, 'bad-percent-encoding');
  assert.match(dropped[0].detail, /UTF-8/);
});

test('duplicate keys: first member wins, later ones reported', () => {
  const { members, dropped } = parseBaggage(['k=first,k=second']);
  assert.equal(members.length, 1);
  assert.equal(members[0].value, 'first');
  assert.equal(dropped[0].reason, 'duplicate-key');
});

test('keys are case-sensitive: user-id and User-Id coexist', () => {
  const { members, dropped } = parseBaggage(['user-id=a,User-Id=b']);
  assert.deepEqual(members.map((m) => m.key), ['user-id', 'User-Id']);
  assert.equal(dropped.length, 0);
});

test('multiple header fields combine by comma and keep order', () => {
  const { members } = parseBaggage(['a=1,b=2', 'c=3']);
  assert.deepEqual(members.map((m) => m.key), ['a', 'b', 'c']);
});

test('empty members from stray commas are dropped, not fatal', () => {
  const { members, dropped } = parseBaggage(['a=1,,b=2,']);
  assert.deepEqual(members.map((m) => m.key), ['a', 'b']);
  assert.ok(dropped.some((d) => d.reason === 'empty-member'));
});

test('quoted values allow spaces and tabs; quotes are not part of value', () => {
  const { members } = parseBaggage(['k="hello world"']);
  assert.equal(members[0].value, 'hello world');
  assert.equal(members[0].quoted, true);
});

test('bad key / bad property grammar rejected with specific reasons', () => {
  assert.equal(parseBaggage(['=v']).dropped[0].reason, 'bad-key');
  assert.equal(parseBaggage(['noequals']).dropped[0].reason, 'bad-key');
  assert.equal(parseBaggage(['k=1;=badprop']).dropped[0].reason, 'bad-property');
  // comma is the list separator: "k=a,b" parses member "b" -> bad-key
  assert.equal(parseBaggage(['k=a,b']).dropped[0].reason, 'bad-key');
  // backslash cannot appear unencoded in values; 'k=a;b' is a flag prop (valid)
  assert.equal(parseBaggage(['k=a\\b']).dropped[0].reason, 'bad-value-charset');
  assert.equal(parseBaggage(['k=1;']).dropped[0].reason, 'bad-property');
});

test('member byte length is measured on serialized UTF-8', () => {
  const { members } = parseBaggage(['city=%E5%8C%97%E4%BA%AC']);
  assert.equal(memberByteLength(members[0]), 'city=%E5%8C%97%E4%BA%AC'.length);
});

test('empty header yields no members', () => {
  assert.deepEqual(parseBaggage(['']).members, []);
  assert.deepEqual(parseBaggage([]).members, []);
});

test('property without value is a flag; property bad value dropped', () => {
  const { members, dropped } = parseBaggage(['k=1;flag;goodp=v,b=2;bad=%zz']);
  assert.equal(members.length, 1);
  assert.equal(members[0].properties[0].key, 'flag');
  assert.equal(dropped[0].reason, 'bad-property');
});
