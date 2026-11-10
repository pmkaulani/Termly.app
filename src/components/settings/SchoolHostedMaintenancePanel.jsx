import { useEffect, useState } from 'react';

const STATUS_URL = '/termly-update-status.json';

function formatDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SchoolHostedMaintenancePanel({ profile }) {
  const isSchoolHosted = typeof window !== 'undefined'
    && String(window.__TERMLY_RUNTIME_CONFIG__?.deploymentMode || '').toLowerCase() === 'school-hosted';
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!isSchoolHosted) return undefined;
    const controller = new AbortController();
    fetch(`${STATUS_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Update status request failed (${response.status}).`);
      const value = await response.json();
      if (!value || value.product !== 'termly' || typeof value.version !== 'string') {
        throw new Error('Invalid installed release status.');
      }
      setStatus(value);
      setUnavailable(false);
    }).catch((error) => {
      if (error.name !== 'AbortError') setUnavailable(true);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [isSchoolHosted]);

  if (!isSchoolHosted) return null;

  const licenseType = String(profile?.licenseType || profile?.license_type || 'subscription').toLowerCase();
  const supportUntil = profile?.licenseSupportUntil || profile?.license_support_until || null;
  const supportDate = supportUntil ? new Date(supportUntil) : null;
  const supportExpired = supportDate && !Number.isNaN(supportDate.getTime()) && supportDate < new Date();

  const card = {
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 18,
    background: 'var(--bg-card)',
  };
  const muted = { color: 'var(--text-light)', fontSize: '0.78rem', lineHeight: 1.55 };
  const value = { fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-main)' };

  return (
    <section className="card" aria-labelledby="termly-maintenance-title">
      <div className="card-header">
        <div>
          <h3 id="termly-maintenance-title">Termly installation &amp; maintenance</h3>
          <p style={muted}>Version and maintenance information for this school's own server.</p>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <div style={card}>
          <div style={muted}>Installed version</div>
          <div style={value}>{loading ? 'Checking…' : status?.version || (unavailable ? 'Not available' : 'Not recorded')}</div>
          <div style={muted}>{status?.channel ? `${status.channel} channel` : 'School-hosted release'}</div>
        </div>
        <div style={card}>
          <div style={muted}>Last successful update</div>
          <div style={value}>{loading ? 'Checking…' : formatDate(status?.updatedAt)}</div>
          <div style={muted}>{status?.previousVersion ? `Updated from ${status.previousVersion}` : 'Installation history is local to this server'}</div>
        </div>
        <div style={card}>
          <div style={muted}>Update support</div>
          <div style={value}>{licenseType === 'perpetual' ? (supportUntil ? formatDate(supportUntil) : 'Not recorded') : 'Covered by current service terms'}</div>
          <div style={muted}>
            {licenseType === 'perpetual'
              ? (supportExpired ? 'The support period has ended. Your purchased version remains usable.' : 'The support date does not disable your purchased version.')
              : 'Subscription status and renewal remain separate from school-hosted installation updates.'}
          </div>
        </div>
      </div>
      <div className="card-body" style={{ paddingTop: 0 }}>
        <p style={muted}>
          Updates are applied by the school's authorised server administrator using a vendor-signed release package. The updater verifies the release, checks a pre-update encrypted backup, applies only the signed migrations and checks the new service before completing. This screen does not download or install executable updates from the browser.
        </p>
        {unavailable && <p role="status" style={{ ...muted, color: 'var(--danger, #b91c1c)' }}>The server has not published its installed-version status file yet. Ask the server administrator to finish the Phase 5 updater setup.</p>}
      </div>
    </section>
  );
}
