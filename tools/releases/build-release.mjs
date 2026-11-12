#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCT, VERSION_RE, parseArgs, stableStringify, sha256File, publicKeyId,
  copyTreeNoLinks, listRegularFiles,
} from './release-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const source = path.resolve(args.source || process.cwd());
const version = String(args.version || '');
const channel = String(args.channel || 'stable');
const out = path.resolve(args.out || path.join(source, 'release-bundles', `termly-${version}`));
const privateKeyPath = path.resolve(args['private-key'] || 'termly-release-keys/release-private-key.pem');
const passphrase = process.env.TERMLY_RELEASE_KEY_PASSPHRASE || '';
if (!VERSION_RE.test(version)) throw new Error('--version must be a semantic version such as 1.2.3.');
if (!['stable', 'preview'].includes(channel)) throw new Error('--channel must be stable or preview.');
if (!passphrase) throw new Error('Set TERMLY_RELEASE_KEY_PASSPHRASE before signing a release.');
if (!fs.existsSync(path.join(source, 'dist'))) throw new Error('Missing dist/. Run npm run build before creating a release bundle.');
if (!fs.existsSync(path.join(source, 'deployment/school-hosted/nginx.conf'))) throw new Error('Missing Phase 2 school-hosted Nginx configuration.');
if (!fs.existsSync(privateKeyPath)) throw new Error(`Private signing key not found: ${privateKeyPath}`);
if (fs.existsSync(out)) {
  if (!args.force) throw new Error(`Release output already exists: ${out}. Choose another path or pass --force to replace it.`);
  fs.rmSync(out, { recursive: true, force: true });
}

const migrationNames = [...new Set(args.migrations)].sort();
if (migrationNames.length && !args['confirm-backward-compatible-migrations']) {
  throw new Error('Migrations require --confirm-backward-compatible-migrations after review for backward compatibility and transaction safety.');
}
const migrationSource = path.join(source, 'supabase/migrations');
for (const name of migrationNames) {
  if (!/^[A-Za-z0-9_.-]+\.sql$/.test(name) || name.startsWith('.')) throw new Error(`Unsafe migration filename: ${name}`);
  const full = path.join(migrationSource, name);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Migration must be a regular file: ${name}`);
  const sql = fs.readFileSync(full, 'utf8');
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) throw new Error(`Migration ${name} contains explicit transaction control; the updater wraps each migration in one transaction.`);
  if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql)) throw new Error(`Migration ${name} uses CREATE INDEX CONCURRENTLY, which cannot run in the updater's transaction.`);
  if (/^\s*\\/m.test(sql)) throw new Error(`Migration ${name} contains a psql client meta-command, which is not accepted in signed automated migrations.`);
}

fs.mkdirSync(out, { recursive: true });
copyTreeNoLinks(path.join(source, 'dist'), path.join(out, 'dist'));
fs.copyFileSync(path.join(source, 'deployment/school-hosted/nginx.conf'), path.join(out, 'nginx.conf'), fs.constants.COPYFILE_EXCL);
const dockerfile = `FROM nginx:stable-alpine\nCOPY nginx.conf /etc/nginx/conf.d/default.conf\nCOPY dist/ /usr/share/nginx/html/\nEXPOSE 8080\nHEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1\n`;
fs.writeFileSync(path.join(out, 'Dockerfile'), dockerfile, { flag: 'wx' });
fs.mkdirSync(path.join(out, 'migrations'), { recursive: true });
for (const name of migrationNames) fs.copyFileSync(path.join(migrationSource, name), path.join(out, 'migrations', name), fs.constants.COPYFILE_EXCL);

const artifacts = listRegularFiles(out).map((relativePath) => {
  const full = path.join(out, ...relativePath.split('/'));
  return { path: relativePath, sha256: sha256File(full), size: fs.statSync(full).size };
});
const privateKey = crypto.createPrivateKey({ key: fs.readFileSync(privateKeyPath, 'utf8'), format: 'pem', passphrase });
const publicKey = crypto.createPublicKey(privateKey);
const manifest = {
  schemaVersion: 1,
  product: PRODUCT,
  version,
  channel,
  createdAt: new Date().toISOString(),
  minimumUpdaterVersion: '1.0.0',
  migrationPolicy: migrationNames.length ? 'backward-compatible' : 'none',
  migrations: migrationNames.map((name) => ({ path: `migrations/${name}`, transactional: true })),
  artifacts,
  releaseKeyId: publicKeyId(publicKey),
};
const canonical = Buffer.from(stableStringify(manifest), 'utf8');
const signature = crypto.sign(null, canonical, privateKey).toString('base64');
fs.writeFileSync(path.join(out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(out, 'release-manifest.sig'), `${signature}\n`, { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ output: out, version, channel, artifactCount: artifacts.length, migrations: migrationNames, releaseKeyId: manifest.releaseKeyId }, null, 2));
