import { useCallback, useEffect, useState } from 'react';

const STATUS_URL = '/termly-health-status.json';

function formatDate(value) {
  if (!value) return 'Not checked yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(value) {
  if (value === 'healthy' || value === 'ok') return 'Healthy';
  if (value === 'degraded' || value === 'warning') return 'Needs attention';
  if (value === 'critical') return 'Action required';
  return 'Unknown';
}

function statusColor(value) {
  if (value === 'healthy' || value === 'ok') return 'var(--success, #15803d)';
  if (value === 'critical') return 'var(--danger, #b91c1c)';
  if (value === 'degraded' || value === 'warning') return 'var(--warning, #a16207)';
  return 'var(--text-light)';
}

export default function SchoolHostedHealthPanel() {
  const isSchoolHosted = typeof window !== 'undefined'
    && String(window.__TERMLY_RUNTIME_CONFIG__?.deploymentMode || '').toLowerCase() === 'school-hosted';
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!isSchoolHosted) return undefined;
    const controller = new AbortController();
    setLoading(true);
    fetch(`${STATUS_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Health status request failed (${response.status}).`);
      const value = await response.json();
      if (!value || value.product !== 'termly' || value.schemaVersion !== 1 || !Array.isArray(value.checks)) {
        throw new Error('Invalid host health report.');
      }
      setReport(value);
      setUnavailable(false);
    }).catch((error) => {
      if (error.name !== 'AbortError') setUnavailable(true);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [isSchoolHosted, refreshKey]);

  if (!isSchoolHosted) return null;

  const overall = report?.overall || 'unknown';
  const checkedAt = report?.checkedAt ? new Date(report.checkedAt) : null;
  const monitorStale = !checkedAt || Number.isNaN(checkedAt.getTime()) || (Date.now() - checkedAt.getTime()) > 15 * 60 * 1000;
  const displayedOverall = monitorStale && !loading ? 'degraded' : overall;
  const cardStyle = {
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 14,
    background: 'var(--bg-card)',
    minWidth: 0,
  };
  const muted = { color: 'var(--text-light)', fontSize: '0.78rem', lineHeight: 1.55 };

  return (
    <section className="card" aria-labelledby="termly-health-title">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 id="termly-health-title">Server health</h3>
          <p style={muted}>Automated checks for this school's Termly installation.</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      <div className="card-body">
        <div style={{ ...cardStyle, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={muted}>Overall status</div>
            <div style={{ fontWeight: 750, fontSize: '1rem', color: statusColor(displayedOverall) }}>
              {loading && !report ? 'Loading…' : (monitorStale ? 'Monitoring stale' : statusLabel(displayedOverall))}
            </div>
          </div>
          <div style={{ ...muted, textAlign: 'right' }}>Last checked<br />{formatDate(report?.checkedAt)}</div>
        </div>
        {monitorStale && report && !loading && (
          <p role="status" style={{ ...muted, color: 'var(--warning, #a16207)' }}>
            This report is more than 15 minutes old. The monitoring timer may have stopped; ask the server administrator to inspect it.
          </p>
        )}
        {unavailable && (
          <p role="status" style={{ ...muted, color: 'var(--danger, #b91c1c)' }}>
            The host has not published a health report. Ask the server administrator to check the Phase 6 monitor service.
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          {(report?.checks || []).map((item) => (
            <div key={item.id} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: '0.86rem' }}>{item.label}</strong>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor(item.status) }}>{statusLabel(item.status)}</span>
              </div>
              <p style={{ ...muted, margin: '8px 0 0' }}>{item.message}</p>
            </div>
          ))}
        </div>
        <p style={{ ...muted, marginBottom: 0, marginTop: 12 }}>
          The report contains operational status only. Detailed diagnostics are generated separately by an authorised server administrator.
        </p>
      </div>
    </section>
  );
}
