import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonicalize, createSignedLicense } from '../tools/licensing/license-utils.mjs';

test('canonical JSON sorts object keys consistently but preserves array order', () => {
  assert.equal(canonicalize({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] }), '{"a":{"x":3,"y":2},"list":[2,1],"z":1}');
});

test('a signed perpetual licence verifies with the matching Ed25519 public key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const payload = {
    schemaVersion: 1, product: 'termly', licenseId: 'TLY-TEST-001',
    schoolId: '11111111-2222-4333-8444-555555555555', schoolName: 'Test School',
    licenseType: 'perpetual', issuedAt: '2026-11-10T00:00:00.000Z',
    supportUntil: '2027-11-10', reference: 'INV-001',
    entitlements: { level: 'full', features: ['*'] },
  };
  const document = createSignedLicense(payload, privateKey);
  const ok = verify(null, Buffer.from(canonicalize(document.payload)), publicKey, Buffer.from(document.signature, 'base64'));
  assert.equal(ok, true);
});

test('changing any signed claim invalidates the signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const payload = { schemaVersion: 1, product: 'termly', licenseType: 'perpetual', schoolId: 'abc' };
  const document = createSignedLicense(payload, privateKey);
  document.payload.schoolId = 'other';
  const ok = verify(null, Buffer.from(canonicalize(document.payload)), publicKey, Buffer.from(document.signature, 'base64'));
  assert.equal(ok, false);
});
