import { sign } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function createSignedLicense(payload, privateKey) {
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const signature = sign(null, message, privateKey).toString('base64');
  return { payload, signature };
}
