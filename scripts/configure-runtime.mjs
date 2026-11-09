import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(here, '../deployment/school-hosted/runtime/termly-runtime-config.js');
const rl = readline.createInterface({ input, output });

function isPrivateHost(hostname = '') {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function main() {
  try {
    const supabaseUrl = (await rl.question('Supabase API base URL (recommended HTTPS, e.g. https://api.termly.school.example): ')).trim();
    const publishableKey = (await rl.question('Supabase publishable/anon key (NOT secret/service_role): ')).trim();
    if (!supabaseUrl || !publishableKey) throw new Error('Both URL and publishable/anon key are required.');

    const parsed = new URL(supabaseUrl);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP or HTTPS API URLs are supported.');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Do not include credentials, query strings or fragments in the API URL.');
    const lowerKey = publishableKey.toLowerCase();
    if (lowerKey.includes('service_role') || lowerKey.startsWith('sb_secret_')) throw new Error('A secret/service-role key cannot be used in browser configuration.');

    let allowInsecureLan = false;
    if (parsed.protocol === 'http:') {
      if (!isPrivateHost(parsed.hostname)) throw new Error('HTTP is permitted only for a private school LAN hostname/IP. Use HTTPS for public or remote access.');
      const answer = (await rl.question('WARNING: HTTP does not encrypt staff/parent traffic. Is this an isolated private LAN test only? Type YES to continue: ')).trim();
      if (answer !== 'YES') throw new Error('Configuration cancelled. Set up HTTPS before continuing.');
      allowInsecureLan = true;
    }

    const config = {
      deploymentMode: 'school-hosted',
      supabaseUrl: parsed.toString().replace(/\/$/, ''),
      supabaseAnonKey: publishableKey,
      allowInsecureLan
    };
    const source = `/* Public connection settings only. Never add server secrets here. */\nwindow.__TERMLY_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source, { mode: 0o640 });
    console.log(`\nWrote ${destination}`);
    console.log('This file contains a public publishable/anon key. It must not contain any secret/service-role key.');
    console.log('Next: run scripts/install-school-hosted-web.sh from the repository root.');
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(`Configuration not written: ${error.message}`);
  process.exitCode = 1;
});
