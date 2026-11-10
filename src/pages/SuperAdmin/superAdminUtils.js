import { useEffect } from 'react';
import { MODULE_LABELS } from '../../data/constants';

// ── Chart.js shared constants ──────────────────────────────────────────────
export const GC  = 'rgba(255,255,255,0.05)';
export const TC  = '#71717a';
export const TIP = {
  backgroundColor : '#1C2119',
  borderColor     : 'rgba(255,255,255,.08)',
  borderWidth     : 1,
  titleColor      : '#D4DDD6',
  bodyColor       : '#5A6B5C',
};

// ── useChart hook ──────────────────────────────────────────────────────────
export function useChart(ref, factory, deps) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.Chart === 'undefined') return;
    const chart = factory(el.getContext('2d'));
    return () => chart.destroy();
  }, deps);
}

// ── Date formatter ─────────────────────────────────────────────────────────
export const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

// ── Expiry calculator ──────────────────────────────────────────────────────
export const calcExpiry = (ds) => {
  if (!ds) return null;
  const end   = new Date(ds);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((end - today) / 86400000);
  return {
    label : end.toLocaleDateString('en-KE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    note  : diff > 0 ? `${diff} days remaining` : diff === 0 ? 'Expires today' : 'Already passed',
    color : diff <= 0 ? 'var(--ro)' : diff < 30 ? 'var(--am)' : 'var(--sub)',
  };
};

// ── Status label / pill helpers ────────────────────────────────────────────
export const statusLabel = (s) => {
  if (!s) return 'Inactive';
  const map = { 
    Active: 'Active', 
    Suspended: 'Suspended', 
    Deactivated: 'Deactivated', 
    Expired: 'Expired' 
  };
  return map[s] ?? 'Deactivated';
};

export const sPill = (s) => {
  if (s === 'Active')                      return 'pill pill-v';
  if (s === 'Perpetual')                   return 'pill pill-v';
  if (s === 'Suspended')                   return 'pill pill-y';
  if (s === 'Expired' || s === 'Deactivated') return 'pill pill-r';
  return 'pill pill-s';
};

export const getStatusRefined = (p, isActive) => {
  if (String(p?.license_type || '').toLowerCase() === 'perpetual'
      && String(p?.license_status || '').toLowerCase() === 'active'
      && isActive) return 'Perpetual';
  const s = p?.subscription_status || 'Inactive';
  if (s === 'Deactivated' || s === 'Suspended') return s;
  if (isActive) return 'Active';
  if (s === 'Active') return 'Expired';
  return s;
};

// ── Feature Count ──────────────────────────────────────────────────────────
export const getFeatureCount = (school) => {
  const p = school?.school_profiles?.[0] || {};
  const settings = p.portal_settings || {};
  const modules = settings.modules || [];
  return Array.isArray(modules) ? modules.length : 0;
};

// ── Audit Log Human-Readable Formatter ────────────────────────────────────
export const formatAuditDescription = (log) => {
  if (!log) return 'System activity recorded';
  
  let rawStr = '';
  if (typeof log === 'string') {
    rawStr = log;
  } else {
    rawStr = log.description || log.action || '';
  }

  const schoolName = log?.schools?.name || log?.school_name || 'School';
  const actor = log?.actor_email || 'Super Admin';
  const actionKey = ((log?.action || '') + ' ' + rawStr).toUpperCase();

  if (actionKey.includes('PLAN_CHANGE')) {
    return `${actor} updated ${schoolName}'s subscription plan.`;
  }
  if (actionKey.includes('LIMITS_UPDATE') || actionKey.includes('LIMIT')) {
    return `${actor} updated capacity limits for ${schoolName}.`;
  }
  if (actionKey.includes('DEACTIVAT')) {
    return `${actor} deactivated ${schoolName}'s account access.`;
  }
  if (actionKey.includes('ACTIVAT') || actionKey.includes('RESTORATION')) {
    return `${actor} activated ${schoolName}'s account access.`;
  }
  if (actionKey.includes('REGISTER')) {
    return `New school "${schoolName}" was registered on the platform.`;
  }
  if (actionKey.includes('FEATURE')) {
    return `${actor} updated feature permissions for ${schoolName}.`;
  }
  if (actionKey.includes('PAYMENT_SUBMIT') || actionKey.includes('PAYMENT_APPROVE') || actionKey.includes('PAYMENT_REJECT') || actionKey.includes('PAYMENT_VOID')) {
    return `Fee payment event processed for ${schoolName}.`;
  }
  if (actionKey.includes('STUDENT_ADD') || actionKey.includes('STUDENTS_IMPORT')) {
    return `Student records updated for ${schoolName}.`;
  }

  // Fallback: If rawStr is JSON string, extract readable text
  let cleanDesc = rawStr;
  if (typeof cleanDesc === 'string' && (cleanDesc.trim().startsWith('{') || cleanDesc.trim().startsWith('['))) {
    try {
      const parsed = JSON.parse(cleanDesc);
      cleanDesc = parsed.message || parsed.description || parsed.action || 'System settings updated';
    } catch {
      cleanDesc = 'System settings updated';
    }
  }

  // Strip any UUIDs, raw IDs, technical prefixes, and JSON snippets
  cleanDesc = String(cleanDesc)
    .replace(/\{[^}]+\}/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/School\s+[0-9a-f-]+/gi, schoolName)
    .replace(/(?:admin|student|user|school|payment|id)[:_]-?[0-9a-f-]{8,}/gi, '')
    .replace(/Platform activity/gi, 'System activity')
    .replace(/\s+/g, ' ')
    .trim();

  return cleanDesc || `System activity logged for ${schoolName}`;
};

export const getRelativeTime = (dateStr) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);

  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return fmtDate(dateStr);
};
