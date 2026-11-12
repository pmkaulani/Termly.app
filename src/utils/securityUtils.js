/**
 * Security Utilities for Termly
 * Uses Web Crypto API for AES-256-GCM encryption
 */
import { getTermlyRuntimeConfig } from '../lib/runtimeConfig';

/**
 * Domain 16: Security Headers & CSP
 * Production reverse proxies should also set security response headers.
 */
export function applySecurityHeaders() {
  // CSP 'self' under Electron's file:// protocol blocks outbound API requests.
  // The school-hosted remote-server Electron mode is served over HTTPS and is not file://.
  const isPackagedFileElectron = navigator.userAgent.toLowerCase().includes('electron') && window.location.protocol === 'file:';
  if (isPackagedFileElectron) {
    console.log('[SECURITY] Renderer is using the bundled file:// shell; CSP is managed by the packaged shell.');
    return;
  }

  const { supabaseUrl } = getTermlyRuntimeConfig();
  let supabaseOrigin = '';
  let realtimeOrigin = '';
  try {
    const parsed = new URL(supabaseUrl);
    supabaseOrigin = parsed.origin;
    realtimeOrigin = parsed.protocol === 'https:'
      ? `wss://${parsed.host}`
      : `ws://${parsed.host}`;
  } catch {
    // Runtime validation will display a useful configuration error.
  }

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://*.africastalking.com https://cdn.jsdelivr.net",
    `connect-src 'self' ${supabaseOrigin} ${realtimeOrigin} https://*.supabase.co wss://*.supabase.co https://*.africastalking.com https://*.safaricom.co.ke https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com`,
    `img-src 'self' data: ${supabaseOrigin} https://*.supabase.co https://*.googleusercontent.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "frame-src 'none'",
    "object-src 'none'"
  ].join('; ');

  let meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    document.head.appendChild(meta);
  }
  meta.content = csp;
  console.log('[SECURITY] Runtime-aware Content Security Policy applied.');
}

const ROLE_PERMISSIONS = {
  admin: ['*'],
  finance: ['fees:read', 'fees:write', 'fees:delete', 'students:read', 'reports:read'],
  teacher: ['students:read', 'academics:read', 'academics:write', 'attendance:read', 'attendance:write', 'lms:read', 'lms:write'],
  librarian: ['library:read', 'library:write', 'students:read'],
  parent: ['portal:read', 'student:read']
};

export function checkPermission(role, action) {
  if (!role) return false;
  const permissions = ROLE_PERMISSIONS[role.toLowerCase()] || [];
  return permissions.includes('*') || permissions.includes(action);
}

export function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) pw += chars[bytes[i] % chars.length];
  return pw;
}
