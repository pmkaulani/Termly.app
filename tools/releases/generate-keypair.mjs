#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, publicKeyId } from './release-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args['out-dir'] || 'termly-release-keys');
const passphrase = process.env.TERMLY_RELEASE_KEY_PASSPHRASE || '';
if (passphrase.length < 16) throw new Error('Set TERMLY_RELEASE_KEY_PASSPHRASE to a unique passphrase of at least 16 characters.');
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !args.force) {
  throw new Error(`Refusing to overwrite non-empty key directory ${outDir}; pass --force only when you intend to rotate keys.`);
}
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
});
const privatePath = path.join(outDir, 'release-private-key.pem');
const publicPath = path.join(outDir, 'release-public-key.pem');
const writeFlag = args.force ? 'w' : 'wx';
fs.writeFileSync(privatePath, privateKey, { mode: 0o600, flag: writeFlag });
fs.writeFileSync(publicPath, publicKey, { mode: 0o644, flag: writeFlag });
fs.chmodSync(outDir, 0o700);
fs.chmodSync(privatePath, 0o600);
fs.chmodSync(publicPath, 0o644);
console.log(JSON.stringify({ keyId: publicKeyId(publicKey), privateKey: privatePath, publicKey: publicPath, note: 'Keep the encrypted private key and passphrase in Termly/vendor custody. Only copy the public key to school hosts.' }, null, 2));
