#!/usr/bin/env node
import { createPrivateKey, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSignedLicense } from './license-utils.mjs';

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function usage() {
  console.log(`Usage:
  TERMLY_LICENSE_KEY_PASSPHRASE='...' node tools/licensing/issue-perpetual-license.mjs \\
    --private-key termly-license-keys/private-key.pem \\
    --school-id <school-uuid> --school-name "School Name" \\
    [--reference RECEIPT-OR-INVOICE] [--support-until YYYY-MM-DD] \\
    [--features '*'|feature_a,feature_b] [--out school-license.json]

The licence is perpetual and contains no application expiry. support-until is informational only.`);
}

const privatePath = getArg('--private-key');
const schoolId = getArg('--school-id');
const schoolName = getArg('--school-name');
const reference = getArg('--reference', '');
const supportUntil = getArg('--support-until', null);
const featuresArg = getArg('--features', '*');
const passphrase = process.env.TERMLY_LICENSE_KEY_PASSPHRASE;

if (!privatePath || !schoolId || !schoolName || !passphrase) {
  usage();
  console.error('\nMissing required arguments or TERMLY_LICENSE_KEY_PASSPHRASE.');
  process.exit(1);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) {
  throw new Error('--school-id must be a valid UUID copied from the Termly school record.');
}
if (supportUntil) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(supportUntil)) {
    throw new Error('--support-until must use YYYY-MM-DD.');
  }
  const [year, month, day] = supportUntil.split('-').map(Number);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day) {
    throw new Error('--support-until is not a valid calendar date.');
  }
}
const features = featuresArg === '*' ? ['*'] : [...new Set(featuresArg.split(',').map((item) => item.trim()).filter(Boolean))];
if (features.length === 0 || (features.includes('*') && features.length > 1)) {
  throw new Error('--features must be * alone or a comma-separated list of feature keys.');
}

const privatePem = await readFile(path.resolve(privatePath), 'utf8');
const privateKey = createPrivateKey({ key: privatePem, format: 'pem', passphrase });
const issuedAt = new Date().toISOString();
const payload = {
  schemaVersion: 1,
  product: 'termly',
  licenseId: `TLY-${randomUUID().toUpperCase()}`,
  schoolId,
  schoolName: schoolName.trim(),
  licenseType: 'perpetual',
  issuedAt,
  supportUntil,
  reference: String(reference || '').trim() || null,
  entitlements: { level: 'full', features },
};

const document = createSignedLicense(payload, privateKey);
const outPath = path.resolve(getArg('--out', `${schoolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'school'}-termly-license.json`));
await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Issued ${payload.licenseId} for ${payload.schoolName} (${payload.schoolId}).`);
console.log(`Licence file: ${outPath}`);
console.log('This file may be delivered to the named school. Never deliver the private signing key.');
