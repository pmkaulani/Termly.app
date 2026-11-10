import test from 'node:test';
import assert from 'node:assert/strict';
import { isSchoolAccessActive } from '../src/utils/schoolEntitlement.mjs';

const now = new Date('2026-11-10T12:00:00Z');

test('active perpetual licence ignores subscription expiry', () => {
  assert.equal(isSchoolAccessActive({
    subscriptionStatus: 'Active', subscriptionPlan: 'Perpetual',
    subscriptionExpiry: '2020-01-01T00:00:00Z', licenseType: 'perpetual', licenseStatus: 'active', licenseSupportUntil: '2020-01-01',
  }, now), true);
});

test('suspended perpetual licence stays blocked even when the signature was valid', () => {
  assert.equal(isSchoolAccessActive({
    subscriptionStatus: 'Suspended', subscriptionPlan: 'Perpetual',
    licenseType: 'perpetual', licenseStatus: 'suspended',
  }, now), false);
});

test('perpetual licence is blocked if the workspace is inactive', () => {
  assert.equal(isSchoolAccessActive({
    subscriptionStatus: 'Inactive', subscriptionPlan: 'Perpetual',
    licenseType: 'perpetual', licenseStatus: 'active',
  }, now), false);
});

test('legacy subscription expiry behaviour is preserved', () => {
  assert.equal(isSchoolAccessActive({ subscriptionStatus: 'Active', subscriptionPlan: 'Production', subscriptionExpiry: '2026-12-01' }, now), true);
  assert.equal(isSchoolAccessActive({ subscriptionStatus: 'Active', subscriptionPlan: 'Production', subscriptionExpiry: '2026-10-01' }, now), false);
});

test('platform admin remains exempt from school licence expiry rules', () => {
  assert.equal(isSchoolAccessActive({ subscriptionPlan: 'Platform Admin', subscriptionStatus: 'Inactive' }, now), true);
});

test('perpetual licence remains blocked when profile status is suspended even if school row is active', () => {
  assert.equal(isSchoolAccessActive({
    subscriptionStatus: 'Active', licenseWorkspaceStatus: 'Active', licenseSubscriptionStatus: 'Suspended',
    licenseType: 'perpetual', licenseStatus: 'active',
  }, now), false);
});
