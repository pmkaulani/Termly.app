#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const outDir = path.resolve(valueAfter('--out-dir', 'termly-license-keys'));
const force = args.includes('--force');
const passphrase = process.env.TERMLY_LICENSE_KEY_PASSPHRASE;

if (!passphrase || passphrase.length < 16) {
  console.error('Set TERMLY_LICENSE_KEY_PASSPHRASE to a strong passphrase of at least 16 characters.');
  process.exit(1);
}

const privatePath = path.join(outDir, 'private-key.pem');
const publicPath = path.join(outDir, 'public-key.base64.txt');
if (!force) {
  for (const file of [privatePath, publicPath]) {
    try { await access(file, constants.F_OK); console.error(`Refusing to overwrite ${file}. Use --force only when you intend to replace the key pair.`); process.exit(1); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
});

await mkdir(outDir, { recursive: true, mode: 0o700 });
await writeFile(privatePath, privateKey, { mode: 0o600, flag: force ? 'w' : 'wx' });
await writeFile(publicPath, `${publicKey.toString('base64')}\n`, { mode: 0o644, flag: force ? 'w' : 'wx' });
await writeFile(path.join(outDir, 'KEEP-PRIVATE-KEY-OFFLINE.txt'), [
  'The private key in this folder signs paid Termly licences.',
  'Keep private-key.pem encrypted, offline and backed up separately.',
  'Never commit this folder, upload the private key to a school server, or send it to a customer.',
  'Only public-key.base64.txt belongs in the Edge Function environment.',
  '',
].join('\n'), { mode: 0o600, flag: force ? 'w' : 'wx' });

console.log(`Created encrypted private key: ${privatePath}`);
console.log(`Created public key (safe to configure on servers): ${publicPath}`);
console.log('The private key is encrypted with TERMLY_LICENSE_KEY_PASSPHRASE. Store the passphrase separately.');
