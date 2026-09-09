/**
 * Security Utilities for Termly
 * Uses Web Crypto API for AES-256-GCM encryption
 */




/**
 * Domain 16: Security Headers & CSP
 * In a real production environment, these are usually set at the CDN/Server level (Vercel/Nginx).
 * This function generates the <meta> tag equivalent for client-side enforcement.
 */
export function applySecurityHeaders() {
  // CSP 'self' under Electron's file:// protocol blocks all outbound
  // network requests (Supabase, fonts, etc.), so skip it entirely.
  const isElectron = navigator.userAgent.toLowerCase().includes('electron');
  if (isElectron) {
    console.log('[SECURITY] Skipping CSP in Electron (file:// protocol).');
    return;
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const supabaseDomain = supabaseUrl ? new URL(supabaseUrl).hostname : '';
  
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://*.africastalking.com https://cdn.jsdelivr.net",
    `connect-src 'self' ${supabaseUrl} wss://*.supabase.co https://*.supabase.co https://*.africastalking.com https://*.safaricom.co.ke https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com`,
    "img-src 'self' data: https://*.supabase.co https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "frame-src 'none'",
    "object-src 'none'"
  ].join('; ');

  // Inject Meta CSP
  let meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.httpEquiv = "Content-Security-Policy";
    document.head.appendChild(meta);
  }
  meta.content = csp;

  console.log('[SECURITY] Security headers applied (CSP Restricted).');
}

/**
 * Domain 1: Granular RBAC Permissions
 */
const ROLE_PERMISSIONS = {
  admin: ['*'], // All permissions
  finance: [
    'fees:read', 'fees:write', 'fees:delete',
    'students:read',
    'reports:read'
  ],
  teacher: [
    'students:read',
    'academics:read', 'academics:write',
    'attendance:read', 'attendance:write',
    'lms:read', 'lms:write'
  ],
  librarian: [
    'library:read', 'library:write',
    'students:read'
  ],
  parent: [
    'portal:read',
    'student:read'
  ]
};

export function checkPermission(role, action) {
  if (!role) return false;
  const normalizedRole = role.toLowerCase();
  const permissions = ROLE_PERMISSIONS[normalizedRole] || [];
  
  if (permissions.includes('*')) return true;
  return permissions.includes(action);
}

/**
 * Generates a secure temporary password
 * @returns {string} 12-character random string
 */
export function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) pw += chars[bytes[i] % chars.length];
  return pw;
}
