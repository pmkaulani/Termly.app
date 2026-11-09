/**
 * Termly runtime configuration.
 *
 * Cloud deployments can continue to use VITE_* build-time values.
 * A school-hosted deployment supplies public connection settings through
 * public/termly-runtime-config.js, which is generated per installation.
 * Never put a database password, JWT secret, service-role key, or Supabase
 * secret key in this file: it is intentionally readable by every browser.
 */
const env = import.meta.env || {};

function readWindowConfig() {
  if (typeof window === 'undefined') return {};
  const value = window.__TERMLY_RUNTIME_CONFIG__;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function getTermlyRuntimeConfig() {
  const runtime = readWindowConfig();
  return {
    supabaseUrl: String(runtime.supabaseUrl || env.VITE_SUPABASE_URL || (env.MODE === 'test' ? 'http://127.0.0.1:54321' : '')).trim(),
    supabaseAnonKey: String(runtime.supabaseAnonKey || env.VITE_SUPABASE_ANON_KEY || (env.MODE === 'test' ? 'mock-anon-key' : '')).trim(),
    deploymentMode: String(runtime.deploymentMode || env.VITE_DEPLOYMENT_MODE || 'cloud').trim().toLowerCase(),
    allowInsecureLan: runtime.allowInsecureLan === true,
  };
}

export function isPrivateNetworkHost(hostname = '') {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) {
    return true;
  }

  // IPv6 loopback and unique-local addresses. Link-local is intentionally not accepted.
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;

  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function validateTermlyRuntimeConfig(config = getTermlyRuntimeConfig(), mode = env.MODE || 'production') {
  const errors = [];
  const urlValue = String(config.supabaseUrl || '').trim();
  const key = String(config.supabaseAnonKey || '').trim();
  const deploymentMode = String(config.deploymentMode || 'cloud').toLowerCase();

  if (!urlValue) errors.push('Supabase URL is missing. Set the school runtime configuration or VITE_SUPABASE_URL.');
  if (!key) errors.push('Supabase publishable/anon key is missing.');
  if (!['cloud', 'school-hosted'].includes(deploymentMode)) errors.push('Deployment mode must be cloud or school-hosted.');

  if (urlValue) {
    try {
      const parsed = new URL(urlValue);
      if (!['https:', 'http:'].includes(parsed.protocol)) errors.push('Supabase URL must use HTTPS (or explicitly authorised HTTP on a private school LAN).');
      if (parsed.username || parsed.password) errors.push('Supabase URL must not contain a username or password.');
      if (parsed.search || parsed.hash) errors.push('Supabase URL must not contain a query string or fragment.');
      if (parsed.protocol === 'http:' && mode !== 'test') {
        const allowedLocalHttp = (deploymentMode === 'school-hosted' && config.allowInsecureLan === true && isPrivateNetworkHost(parsed.hostname)) || (mode === 'development' && isPrivateNetworkHost(parsed.hostname));
        if (!allowedLocalHttp) errors.push('HTTP is not allowed here. Use HTTPS, or explicitly enable HTTP only for a private school-hosted LAN endpoint.');
      }
    } catch {
      errors.push('Supabase URL is not a valid absolute URL.');
    }
  }

  const lowerKey = key.toLowerCase();
  if (key && (lowerKey.includes('service_role') || lowerKey.startsWith('sb_secret_'))) {
    errors.push('A Supabase secret/service-role key was supplied. Only a publishable/anon key may be used in the browser.');
  }

  return { valid: errors.length === 0, errors };
}

// Allow the PWA/service worker to keep this file fresh after an installer change.
export function getTermlyDeploymentMode() {
  return getTermlyRuntimeConfig().deploymentMode;
}
