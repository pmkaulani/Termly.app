import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PRODUCT = 'termly';
export const UPDATER_VERSION = '1.0.0';
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseArgs(argv) {
  const out = { _: [], migrations: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--migration') {
      const value = argv[++i];
      if (!value) throw new Error('--migration requires a filename');
      out.migrations.push(value);
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      if (['force', 'confirm-backward-compatible-migrations'].includes(key)) {
        out[key] = true;
      } else {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
        out[key] = value;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

export function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes its release directory: ${candidate}`);
  }
  return resolved;
}

export function compareSemver(a, b) {
  const ma = String(a).match(VERSION_RE);
  const mb = String(b).match(VERSION_RE);
  if (!ma || !mb) throw new Error('Version comparison requires valid semantic versions.');
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff) return Math.sign(diff);
  }
  const pa = ma[4] || '';
  const pb = mb[4] || '';
  if (!pa && pb) return 1;
  if (pa && !pb) return -1;
  if (pa === pb) return 0;
  return pa.localeCompare(pb, 'en', { numeric: true });
}

export function publicKeyId(publicKey) {
  const key = publicKey && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 24);
}

export function copyTreeNoLinks(sourceDir, destinationDir) {
  const source = fs.realpathSync(sourceDir);
  fs.mkdirSync(destinationDir, { recursive: true });
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      const childSrc = path.join(current, entry.name);
      const childDest = path.join(destinationDir, ...childRel.split('/'));
      const stat = fs.lstatSync(childSrc);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not permitted in release inputs: ${childRel}`);
      if (entry.isDirectory()) {
        fs.mkdirSync(childDest, { recursive: true });
        walk(childSrc, childRel);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(childDest), { recursive: true });
        fs.copyFileSync(childSrc, childDest, fs.constants.COPYFILE_EXCL);
      } else {
        throw new Error(`Unsupported release input type: ${childRel}`);
      }
    }
  };
  walk(source);
}

export function listRegularFiles(root) {
  const result = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link found in release: ${rel}`);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) result.push(rel.split(path.sep).join('/'));
      else throw new Error(`Unsupported file in release: ${rel}`);
    }
  };
  walk(root);
  return result.sort();
}
