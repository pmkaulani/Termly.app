import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stableStringify, compareSemver, safeRelativePath } from '../tools/releases/release-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'termly-release-test-'));
const write = (base, relative, value) => {
  const full = path.join(base, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, value);
  return full;
};

function makeRelease(dir, keyPair, { tamper = false, unsafePath = false } = {}) {
  write(dir, 'Dockerfile', 'FROM nginx:stable-alpine\n');
  write(dir, 'nginx.conf', 'server {}\n');
  write(dir, 'dist/index.html', '<!doctype html><title>Termly</title>');
  const artifacts = ['Dockerfile', 'nginx.conf', 'dist/index.html'].map((p) => ({
    path: p,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, p))).digest('hex'),
    size: fs.statSync(path.join(dir, p)).size,
  }));
  const manifest = {
    schemaVersion: 1,
    product: 'termly',
    version: '1.2.0',
    channel: 'stable',
    createdAt: new Date().toISOString(),
    minimumUpdaterVersion: '1.0.0',
    migrationPolicy: 'none',
    migrations: [],
    artifacts: unsafePath ? [...artifacts, { path: '../escape', sha256: 'a'.repeat(64), size: 0 }] : artifacts,
    releaseKeyId: crypto.createHash('sha256').update(keyPair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0,24),
  };
  const canonical = Buffer.from(stableStringify(manifest));
  const signature = crypto.sign(null, canonical, keyPair.privateKey);
  write(dir, 'release-manifest.json', JSON.stringify(manifest, null, 2));
  write(dir, 'release-manifest.sig', signature.toString('base64'));
  if (tamper) fs.appendFileSync(path.join(dir, 'dist/index.html'), 'tampered');
  return manifest;
}

test('canonical JSON sorts object keys recursively', () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('semver comparison rejects downgrade and permits forward version', () => {
  assert.equal(compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.2.0-alpha.1', '1.2.0'), -1);
  assert.throws(() => compareSemver('latest', '1.0.0'));
});

test('release path validation rejects traversal, absolute paths and dotfiles', () => {
  assert.equal(safeRelativePath('dist/index.html'), true);
  assert.equal(safeRelativePath('../escape'), false);
  assert.equal(safeRelativePath('/etc/passwd'), false);
  assert.equal(safeRelativePath('dist/../secret'), false);
  assert.equal(safeRelativePath('.env'), false);
  assert.equal(safeRelativePath('dist\\file.js'), false);
});

test('signed release verifies with Ed25519 public key', () => {
  const dir = temp();
  const pair = crypto.generateKeyPairSync('ed25519');
  makeRelease(dir, pair);
  const pub = path.join(path.dirname(dir), `${path.basename(dir)}-vendor-public.pem`);
  fs.writeFileSync(pub, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const result = spawnSync(node, [path.join(root, 'tools/releases/verify-release.mjs'), '--release-dir', dir, '--public-key', pub], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.version, '1.2.0');
});

test('tampered release artifact is rejected after signature verification', () => {
  const dir = temp();
  const pair = crypto.generateKeyPairSync('ed25519');
  makeRelease(dir, pair, { tamper: true });
  const pub = path.join(path.dirname(dir), `${path.basename(dir)}-vendor-public.pem`);
  fs.writeFileSync(pub, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const result = spawnSync(node, [path.join(root, 'tools/releases/verify-release.mjs'), '--release-dir', dir, '--public-key', pub], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest or size mismatch/i);
});

test('release manifest cannot sign a path traversal artifact', () => {
  const dir = temp();
  const pair = crypto.generateKeyPairSync('ed25519');
  makeRelease(dir, pair, { unsafePath: true });
  const pub = path.join(path.dirname(dir), `${path.basename(dir)}-vendor-public.pem`);
  fs.writeFileSync(pub, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const result = spawnSync(node, [path.join(root, 'tools/releases/verify-release.mjs'), '--release-dir', dir, '--public-key', pub], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe or duplicate artifact path/i);
});

test('release builder and verifier work with encrypted vendor private key', () => {
  const base = temp();
  const source = path.join(base, 'source');
  const out = path.join(base, 'termly-1.3.0');
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(source, 'deployment/school-hosted'), { recursive: true });
  fs.mkdirSync(path.join(source, 'supabase/migrations'), { recursive: true });
  write(source, 'dist/index.html', '<!doctype html><title>Termly</title>');
  write(source, 'deployment/school-hosted/nginx.conf', 'server {}\n');
  write(source, 'supabase/migrations/20261110_test.sql', 'SELECT 1;\n');
  const passphrase = 'test-only-passphrase-with-enough-length';
  const pair = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  const key = write(base, 'release-private-key.pem', pair.privateKey);
  const pub = write(base, 'release-public-key.pem', pair.publicKey);
  const built = spawnSync(node, [path.join(root, 'tools/releases/build-release.mjs'), '--source', source, '--version', '1.3.0', '--private-key', key, '--out', out, '--migration', '20261110_test.sql', '--confirm-backward-compatible-migrations'], {
    encoding: 'utf8', env: { ...process.env, TERMLY_RELEASE_KEY_PASSPHRASE: passphrase },
  });
  assert.equal(built.status, 0, built.stderr);
  const verify = spawnSync(node, [path.join(root, 'tools/releases/verify-release.mjs'), '--release-dir', out, '--public-key', pub], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).migrations.length, 1);
});


test('release key generator creates encrypted private key and refuses overwrite by default', () => {
  const dir = temp();
  const passphrase = 'another-test-passphrase-long-enough';
  const keyDir = path.join(dir, 'keys');
  const script = path.join(root, 'tools/releases/generate-keypair.mjs');
  const first = spawnSync(node, [script, '--out-dir', keyDir], { encoding: 'utf8', env: { ...process.env, TERMLY_RELEASE_KEY_PASSPHRASE: passphrase } });
  assert.equal(first.status, 0, first.stderr);
  const privatePem = fs.readFileSync(path.join(keyDir, 'release-private-key.pem'), 'utf8');
  assert.match(privatePem, /ENCRYPTED PRIVATE KEY/);
  const privateKey = crypto.createPrivateKey({ key: privatePem, format: 'pem', passphrase });
  const publicKey = crypto.createPublicKey(privateKey);
  const storedPublic = crypto.createPublicKey(fs.readFileSync(path.join(keyDir, 'release-public-key.pem'), 'utf8'));
  assert.deepEqual(publicKey.export({ type: 'spki', format: 'der' }), storedPublic.export({ type: 'spki', format: 'der' }));
  const second = spawnSync(node, [script, '--out-dir', keyDir], { encoding: 'utf8', env: { ...process.env, TERMLY_RELEASE_KEY_PASSPHRASE: passphrase } });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /refusing to overwrite/i);
});
