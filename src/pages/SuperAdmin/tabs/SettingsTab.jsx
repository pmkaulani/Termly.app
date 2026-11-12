import { useState } from 'react';
import { calcExpiry } from '../superAdminUtils';
import { 
  RocketIcon, RefreshIcon, ShieldIcon
} from '../../../components/CommonIcons';

export default function SettingsTab({
  statusMsg, setStatusMsg,
  subEndDate, setSubEndDate,
  smsConfig, setSmsConfig,
  handleUpdateSetting,
  loadData,
  setMessage,
  onWipeSchools,
}) {
  const S = {
    label  : { fontSize:'.52rem', color:'var(--sub)', letterSpacing:'.08em', textTransform:'uppercase', marginBottom:5, display:'block' },
    input  : { width:'100%', background:'var(--bg)', border:'1px solid var(--edge)', borderRadius:7, padding:'8px 11px', color:'var(--txt)', fontFamily:'var(--fb)', fontSize:'.78rem', outline:'none' },
    card   : { padding: 20, borderRadius: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--edge)', marginBottom: 20 }
  };

  const [saving, setSaving] = useState(false);
  const expiryInfo = calcExpiry(subEndDate);

  const handleSaveGlobal = async () => {
    setSaving(true);
    try {
      if (typeof handleUpdateSetting === 'function') {
        await handleUpdateSetting('platform', { status_message: statusMsg, global_expiry: subEndDate });
        await handleUpdateSetting('billing', { expiry_date: subEndDate, term_expiry: subEndDate });
        await handleUpdateSetting('sms', smsConfig);
        await handleUpdateSetting('global_expiry', subEndDate);
      }
      if (typeof loadData === 'function') {
        await loadData();
      }
      setMessage({ type: 'success', text: 'Platform configuration and Expiry Lock saved successfully.' });
    } catch (err) {
      console.error('Failed to save settings:', err);
      setMessage({ type: 'error', text: err?.message || 'Failed to save configuration.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tv" style={{ maxWidth: 1000, margin: '0 auto' }}>
      
      <div className="grid-2">
        
        {/* --- LEFT: CORE CONFIG --- */}
        <div>
          <div style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(99, 102, 241, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1' }}>
                <RocketIcon size={16} />
              </div>
              <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>Platform Configuration</h3>
            </div>

            <div style={{ marginBottom:14 }}>
              <label style={S.label}>Global Status Message</label>
              <input type="text" style={S.input}
                placeholder="e.g. System maintenance on Sunday 10pm–12am"
                value={statusMsg}
                onChange={e => setStatusMsg(e.target.value)} />
              <div style={{ fontSize:'.6rem', color:'var(--sub)', marginTop:4 }}>
                Shown as a banner to all schools when active.
              </div>
            </div>

            <div style={{ marginBottom:16 }}>
              <label style={S.label}>Platform Expiry Lock Date</label>
              <input type="date" style={{ ...S.input, colorScheme:'dark', fontSize: '0.85rem', padding: '10px 12px' }}
                value={subEndDate}
                onChange={e => setSubEndDate(e.target.value)} />
              {subEndDate && expiryInfo && (
                <div style={{ marginTop:12, padding:'12px 14px', borderRadius:10, background:'rgba(99, 102, 241, 0.1)', border:'1px solid rgba(99, 102, 241, 0.25)' }}>
                  <div style={{ fontSize:'.6rem', color:'var(--sub)', textTransform:'uppercase', fontWeight: 700, letterSpacing: '0.05em', marginBottom:4 }}>Target Expiry Date</div>
                  <div style={{ fontFamily:'var(--fh)', fontSize:'.92rem', fontWeight:800, color:'#fff' }}>{expiryInfo.label}</div>
                  <div style={{ fontSize:'.7rem', color: expiryInfo.color, marginTop:4, fontWeight: 600 }}>{expiryInfo.note}</div>
                </div>
              )}
            </div>

            <button 
              className="act-btn" 
              onClick={handleSaveGlobal} 
              disabled={saving}
              style={{ width:'100%', padding: '12px', opacity: saving ? 0.7 : 1, cursor: saving ? 'wait' : 'pointer' }}
            >
              {saving ? 'Saving Configuration...' : 'Save Configuration'}
            </button>
          </div>

          {/* --- DANGER ZONE --- */}
          <div style={{ ...S.card, border: '1px solid rgba(212,80,106,0.2)', background: 'rgba(212,80,106,0.02)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <RefreshIcon size={18} color="var(--ro)" />
              <div style={{ fontFamily:'var(--fh)', fontSize:'.85rem', fontWeight:800, color:'var(--ro)' }}>System Maintenance</div>
            </div>
            <p style={{ fontSize:'.68rem', color:'var(--sub)', lineHeight:1.6, marginBottom:16 }}>
              Wipe all non-admin school data. This permanently deletes all school workspaces, students, and staff records.
            </p>
            <button onClick={onWipeSchools} style={{ width:'100%', padding:'10px', borderRadius:8, background:'rgba(212,80,106,0.1)', border:'1px solid rgba(212,80,106,0.2)', color:'var(--ro)', fontSize:'.72rem', fontWeight:700, cursor:'pointer' }}>
              Terminate All School Data
            </button>
          </div>
        </div>

        {/* --- RIGHT: GATEWAYS --- */}
        <div>
          <div style={S.card}>
             <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(16, 185, 129, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
                  <ShieldIcon size={16} />
                </div>
                <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>Communication Gateways</h3>
             </div>
             
             <div style={{ marginBottom:20 }}>
                <label style={S.label}>SMS Platform API (System Alerts)</label>
                <div style={{ display:'flex', gap:8, marginBottom:8 }}>
                  <input type="text" style={{ ...S.input, flex:1 }} placeholder="Sender ID" value={smsConfig.senderId} onChange={e => setSmsConfig({...smsConfig, senderId: e.target.value.toUpperCase()})} />
                  <input type="password" style={{ ...S.input, flex:2 }} placeholder="API Key" value={smsConfig.apiKey} onChange={e => setSmsConfig({...smsConfig, apiKey: e.target.value})} />
                </div>
                <div style={{ fontSize:'.6rem', color:'var(--sub)', marginTop:4 }}>
                  Used for system-wide notifications and onboarding alerts.
                </div>
             </div>
          </div>

          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--sub)', borderRadius: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--edge)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(99, 102, 241, 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1' }}>
                <ShieldIcon size={24} />
              </div>
            </div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff' }}>Secure Infrastructure</div>
            <p style={{ fontSize: '0.68rem', marginTop: 4, color: 'var(--sub)', lineHeight: 1.5 }}>
              Platform security and integrity are managed via HQ protocols.
            </p>
          </div>
        </div>

      </div>

    </div>
  );
}
