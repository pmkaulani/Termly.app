import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useDialog } from '../../contexts/DialogContext';
import { ShieldIcon, UploadIcon, CheckIcon, ClockIcon } from '../CommonIcons';

function displayDate(value) {
  if (!value) return 'Not specified';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? 'Not specified' : date.toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function PerpetualLicensePanel({ profile, isAdmin, onActivated }) {
  const inputRef = useRef(null);
  const { alert, confirm } = useDialog();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  if (!isAdmin) return null;

  const licenseType = String(profile?.licenseType || profile?.license_type || 'subscription').toLowerCase();
  const licenseStatus = String(profile?.licenseStatus || profile?.license_status || '').toLowerCase();
  const isPerpetual = licenseType === 'perpetual' && licenseStatus === 'active';
  const isSuspended = licenseType === 'perpetual' && licenseStatus === 'suspended';
  const schoolId = profile?.school_id || profile?.schoolId;

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    // Reset immediately so the same file can be selected again after a failed attempt.
    event.target.value = '';
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.json') || file.size > 64 * 1024) {
      alert({ title: 'Invalid licence file', message: 'Choose a Termly .json licence file smaller than 64 KB.', variant: 'warning' });
      return;
    }

    let licenseDocument;
    try {
      licenseDocument = JSON.parse(await file.text());
    } catch {
      alert({ title: 'Invalid licence file', message: 'The selected file is not valid JSON.', variant: 'danger' });
      return;
    }

    const payload = licenseDocument?.payload;
    if (!payload || !licenseDocument.signature || payload.product !== 'termly' || payload.licenseType !== 'perpetual') {
      alert({ title: 'Invalid licence file', message: 'This file does not contain a Termly perpetual licence.', variant: 'danger' });
      return;
    }
    if (!schoolId || String(payload.schoolId).toLowerCase() !== String(schoolId).toLowerCase()) {
      alert({ title: 'Licence belongs to another school', message: 'This licence was issued for a different Termly school ID. Ask Termly to issue a licence for this exact school installation.', variant: 'danger' });
      return;
    }

    const accepted = await confirm({
      title: 'Activate lifetime Termly licence',
      message: `Activate ${payload.licenseId || 'this licence'} for ${profile.schoolName || profile.school_name || 'this school'}? This removes the subscription expiry and applies the features included in the signed licence.`,
      confirmText: 'Activate licence',
    });
    if (!accepted) return;

    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase.functions.invoke('activate-perpetual-license', {
        body: { licenseDocument },
      });
      if (error) throw new Error(error.message || 'The licensing service rejected the request.');
      if (!data?.success) throw new Error(data?.error || 'Licence activation was not confirmed.');
      await onActivated?.();
      setMessage(`Lifetime licence ${data.licenseId || payload.licenseId} activated successfully.`);
    } catch (error) {
      console.error('[TERMLY LICENCE] Activation failed:', error);
      alert({ title: 'Licence activation failed', message: error?.message || 'Could not activate this licence. Check the server configuration and try again.', variant: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="termly-license-heading">
      <div className="card-header">
        <h3 id="termly-license-heading"><ShieldIcon size={20} /> Termly Product Licence</h3>
        <span style={{
          fontSize: '0.7rem', fontWeight: 800, padding: '5px 10px', borderRadius: 20,
          background: isPerpetual ? 'rgba(16,185,129,.12)' : 'var(--bg)',
          color: isPerpetual ? '#059669' : 'var(--text-light)',
          border: `1px solid ${isPerpetual ? 'rgba(16,185,129,.28)' : 'var(--border)'}`,
        }}>
          {isPerpetual ? 'LIFETIME LICENCE' : licenseStatus === 'suspended' ? 'LICENCE SUSPENDED' : 'SUBSCRIPTION'}
        </span>
      </div>
      <div className="card-body">
        {isPerpetual ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#059669', fontWeight: 700 }}>
              <CheckIcon size={18} /> This school has a perpetual Termly licence.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12 }}>
              <div style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                <div style={{ color: 'var(--text-light)', fontSize: '.7rem', marginBottom: 4 }}>Licence reference</div>
                <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{profile.licenseReference || profile.license_reference || profile.licenseId || profile.license_id || 'Recorded'}</div>
              </div>
              <div style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                <div style={{ color: 'var(--text-light)', fontSize: '.7rem', marginBottom: 4 }}>Support coverage through</div>
                <div style={{ fontWeight: 700 }}>{displayDate(profile.licenseSupportUntil || profile.license_support_until)}</div>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: '.78rem', lineHeight: 1.6, color: 'var(--text-light)' }}>
              The purchased Termly version does not expire. The support-through date is separate and does not lock the app, parent portal, staff portal or school records.
            </p>
          </div>
        ) : isSuspended ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p role="status" style={{ margin: 0, color: '#b45309', fontSize: '.84rem', fontWeight: 700 }}>This perpetual licence is suspended by the Termly platform administrator.</p>
            <p style={{ margin: 0, color: 'var(--text-light)', fontSize: '.78rem', lineHeight: 1.6 }}>Uploading the original licence again will not remove a platform suspension. Contact Termly support or your school platform administrator to request a review.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, color: 'var(--text-light)', fontSize: '.82rem', lineHeight: 1.6 }}>
              Activate a signed lifetime licence supplied by Termly. The licence is bound to this school's installation and works without a recurring subscription check.
            </p>
            <div style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--text-light)', fontSize: '.7rem', marginBottom: 4 }}>School installation ID</div>
              <div style={{ fontSize: '.82rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{schoolId || 'Unavailable — reload the school profile'}</div>
            </div>
            <input ref={inputRef} type="file" accept=".json,application/json" onChange={handleFileChange} style={{ display: 'none' }} />
            <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={busy || !schoolId}>
              {busy ? <ClockIcon size={15} /> : <UploadIcon size={15} />}
              {busy ? ' Verifying and activating…' : ' Upload lifetime licence'}
            </button>
            {message && <p role="status" style={{ margin: 0, color: '#059669', fontSize: '.78rem', fontWeight: 700 }}>{message}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
