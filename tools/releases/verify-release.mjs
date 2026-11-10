#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCT, UPDATER_VERSION, VERSION_RE, parseArgs, stableStringify, sha256File,
  safeRelativePath, assertInside, publicKeyId, listRegularFiles, compareSemver,
} from './release-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args['release-dir'] || args._[0] || '');
const publicKeyPath = path.resolve(args['public-key'] || '');
if (!args['release-dir'] && !args._[0]) throw new Error('Provide --release-dir.');
if (!args['public-key']) throw new Error('Provide --public-key pointing to the vendor public verification key.');
if (!fs.existsSync(root)) throw new Error('Release directory does not exist.');
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Release directory must be a real directory, not a symlink.');
if (!fs.existsSync(publicKeyPath)) throw new Error('Release public key file does not exist.');
const manifestPath = path.join(root, 'release-manifest.json');
const signaturePath = path.join(root, 'release-manifest.sig');
if (!fs.existsSync(manifestPath) || !fs.existsSync(signaturePath)) throw new Error('Release manifest or detached signature is missing.');
const raw = fs.readFileSync(manifestPath);
if (raw.length > 2 * 1024 * 1024) throw new Error('Release manifest exceeds the 2 MiB limit.');
const manifest = JSON.parse(raw.toString('utf8'));
if (manifest.schemaVersion !== 1 || manifest.product !== PRODUCT) throw new Error('Unsupported release manifest schema or product.');
if (!VERSION_RE.test(String(manifest.version || ''))) throw new Error('Release version is not valid semantic versioning.');
if (!['stable', 'preview'].includes(manifest.channel)) throw new Error('Unsupported release channel.');
if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('Invalid release creation timestamp.');
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 3 || manifest.artifacts.length > 100000) throw new Error('Invalid release artifact list.');
if (!Array.isArray(manifest.migrations) || manifest.migrations.length > 1000) throw new Error('Invalid release migrations list.');
if (!['none', 'backward-compatible'].includes(manifest.migrationPolicy)) throw new Error('Invalid migration policy.');
if (manifest.migrations.length && manifest.migrationPolicy !== 'backward-compatible') throw new Error('Database migrations must be explicitly attested as backward-compatible.');
if (manifest.migrations.some((m) => !m || typeof m.path !== 'string' || m.transactional !== true || !/^migrations\/[A-Za-z0-9_.-]+\.sql$/.test(m.path))) throw new Error('Migrations must be simple .sql files and declared transactional.');
const publicKeyText = fs.readFileSync(publicKeyPath, 'utf8');
if (publicKeyId(publicKeyText) !== manifest.releaseKeyId) throw new Error('Release key ID does not match the configured public key.');
const signature = Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64');
const valid = crypto.verify(null, Buffer.from(stableStringify(manifest), 'utf8'), crypto.createPublicKey(publicKeyText), signature);
if (!valid) throw new Error('Release signature verification failed.');
if (compareSemver(UPDATER_VERSION, String(manifest.minimumUpdaterVersion || '0.0.0')) < 0) throw new Error('This updater is too old for the release.');

const expected = new Map();
for (const artifact of manifest.artifacts) {
  if (!artifact || !safeRelativePath(artifact.path) || expected.has(artifact.path)) throw new Error('Unsafe or duplicate artifact path in manifest.');
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new Error(`Invalid digest or size for ${artifact.path}`);
  const full = assertInside(root, path.join(root, ...artifact.path.split('/')));
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact is missing or not a regular file: ${artifact.path}`);
  if (stat.size !== artifact.size || sha256File(full) !== artifact.sha256) throw new Error(`Artifact digest or size mismatch: ${artifact.path}`);
  expected.set(artifact.path, artifact);
}
const actual = listRegularFiles(root).filter((p) => !['release-manifest.json', 'release-manifest.sig'].includes(p));
if (actual.length !== expected.size || actual.some((p) => !expected.has(p))) throw new Error('Release contains unlisted files or is missing signed files.');
for (const migration of manifest.migrations) if (!expected.has(migration.path)) throw new Error(`Migration is not in the signed artifacts list: ${migration.path}`);
for (const required of ['Dockerfile', 'nginx.conf', 'dist/index.html']) if (!expected.has(required)) throw new Error(`Release is missing required artifact ${required}.`);
console.log(JSON.stringify({ ok: true, product: PRODUCT, version: manifest.version, channel: manifest.channel, migrations: manifest.migrations, artifactCount: expected.size, releaseKeyId: manifest.releaseKeyId }));
