import React, { useState, useEffect } from 'react';
import { getSchemaStatus, runSchemaMigration } from '../../../data/coreStore';
import { RefreshIcon, ActivityIcon } from '../../../components/Common/Icons';
import { RocketIcon } from '../../../components/CommonIcons';

export default function MigrationsTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sql, setSql] = useState('');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);

  const loadStatus = async () => {
    setLoading(true);
    const s = await getSchemaStatus();
    setStatus(s);
    setLoading(false);
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleMigrate = async () => {
    if (!sql.trim()) return;
    if (!window.confirm("CRITICAL: You are about to execute raw SQL on the production database. Continue?")) return;

    setExecuting(true);
    setResult(null);
    try {
      const res = await runSchemaMigration(sql);
      setResult({ success: true, data: res });
      await loadStatus();
      setSql('');
    } catch (err) {
      setResult({ success: false, error: err.message });
    } finally {
      setExecuting(false);
    }
  };

  if (loading) return <div className="p-12 text-center">Loading schema status...</div>;

  return (
    <div className="migrations-tab">
      <div className="migration-header">
        <div className="migration-info">
          <h3>Database Schema Versioning</h3>
          <p>Maintain and update the global Supabase schema for all tenants.</p>
        </div>
        <div className="version-badge" style={{ background: status.outdated ? '#FEE2E2' : '#ECFDF5', color: status.outdated ? '#EF4444' : '#10B981' }}>
          v{status.currentVersion} / v{status.requiredVersion}
          {status.outdated && <span className="pulse-dot"></span>}
        </div>
      </div>

      {status.outdated && (
        <div className="migration-warning">
          <ShieldIcon size={20} />
          <div>
            <strong>Update Required:</strong> The database schema is behind the current frontend version. 
            Some features may malfunction until you apply the latest patches.
          </div>
        </div>
      )}

      <div className="sql-console">
        <div className="console-header">
          <span>SQL Execution Console</span>
          <button onClick={loadStatus} title="Refresh Status"><RefreshIcon size={14} /></button>
        </div>
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94A3B8' }}>
          <ShieldIcon size={32} style={{ margin: '0 auto 16px', color: '#EF4444' }} />
          <h4 style={{ color: '#F8FAFC', marginBottom: 8, fontSize: '1.1rem' }}>Client-Side Migrations Disabled</h4>
          <p style={{ maxWidth: 400, margin: '0 auto', lineHeight: 1.5 }}>
            Direct schema migrations from the frontend have been disabled for security reasons. 
            Please use the <strong>Supabase CLI</strong> (<code>supabase db push</code>) or the 
            Supabase dashboard to apply schema changes.
          </p>
        </div>
        <div className="console-footer">
          <div className="sql-hint">Access restricted due to security policies.</div>
          <button 
            className="exec-btn" 
            disabled={true}
          >
            <RocketIcon size={16} /> Run SQL Patch
          </button>
        </div>
      </div>

      <style>{`
        .migrations-tab { padding: 24px; }
        .migration-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
        .migration-info h3 { font-size: 1.25rem; font-weight: 800; margin-bottom: 4px; color: #1e293b; }
        .migration-info p { font-size: 0.9rem; color: #64748b; }
        
        .version-badge {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 16px; border-radius: 100px; font-weight: 800; font-size: 0.85rem;
        }
        .pulse-dot { width: 8px; height: 8px; background: #ef4444; border-radius: 50%; animation: pulse 1.5s infinite; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: 0.5; } 100% { transform: scale(1); opacity: 1; } }

        .migration-warning {
          display: flex; gap: 12px; padding: 16px; background: #FFF7ED; border: 1px solid #FFEDD5;
          border-radius: 12px; color: #9A3412; font-size: 0.9rem; margin-bottom: 24px;
        }

        .sql-console {
          background: #0F172A; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.2);
        }
        .console-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 12px 20px; background: #1E293B; color: #94A3B8; font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
        }
        .console-header button { background: none; border: none; color: #64748b; cursor: pointer; }
        .console-header button:hover { color: white; }
        
        textarea {
          width: 100%; min-height: 250px; background: transparent; border: none;
          padding: 20px; color: #E2E8F0; font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.9rem; outline: none; resize: vertical; line-height: 1.6;
        }
        
        .console-footer {
          display: flex; justify-content: space-between; align-items: center;
          padding: 16px 20px; background: #1E293B;
        }
        .sql-hint { font-size: 0.75rem; color: #64748b; font-style: italic; }
        
        .exec-btn {
          display: flex; align-items: center; gap: 8px; padding: 10px 20px;
          background: #5B3EF5; color: white; border: none; border-radius: 8px;
          font-weight: 700; cursor: pointer; transition: all 0.2s;
        }
        .exec-btn:hover:not(:disabled) { background: #4A32D4; transform: translateY(-1px); }
        .exec-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .execution-result { margin-top: 24px; border-radius: 12px; overflow: hidden; }
        .result-header { padding: 10px 16px; font-size: 0.8rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
        pre { padding: 16px; font-size: 0.85rem; overflow-x: auto; font-family: monospace; }
        
        .execution-result.success { background: #ECFDF5; color: #065F46; border: 1px solid #D1FAE5; }
        .execution-result.success .result-header { background: #D1FAE5; }
        .execution-result.error { background: #FEF2F2; color: #991B1B; border: 1px solid #FEE2E2; }
        .execution-result.error .result-header { background: #FEE2E2; }
      `}</style>
    </div>
  );
}
