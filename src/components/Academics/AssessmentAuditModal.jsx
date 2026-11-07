import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { _currentSchoolId } from '../../data/coreStore';

export default function AssessmentAuditModal({ isOpen, onClose, examName }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen || !_currentSchoolId) return;

    const fetchLogs = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('audit_logs')
          .select('id, user_id, action, target_type, target_id, details, created_at')
          .eq('school_id', _currentSchoolId)
          .in('action', ['marks_updated', 'mark_change', 'marks_saved', 'assessment_status_change'])
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) throw error;
        setLogs(data || []);
      } catch (err) {
        console.warn('Could not fetch audit logs:', err.message);
        setLogs([]);
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredLogs = logs.filter(log => {
    if (!search) return true;
    const s = search.toLowerCase();
    const detailsStr = JSON.stringify(log.details || {}).toLowerCase();
    return detailsStr.includes(s) || (log.action || '').toLowerCase().includes(s);
  });

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(15, 23, 42, 0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      backdropFilter: 'blur(3px)',
      padding: '16px'
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '800px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
        border: '1px solid #e2e8f0',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#f8fafc'
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
              Marks Audit & Change History
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#64748b' }}>
              Audit trail of mark entries, adjustments, and exam status transitions
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.4rem',
              cursor: 'pointer',
              color: '#64748b',
              padding: '4px'
            }}
          >
            ×
          </button>
        </div>

        {/* Search Bar */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #e2e8f0', background: '#ffffff' }}>
          <input
            type="text"
            placeholder="Search audit trail by student, subject, or user..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontSize: '0.85rem'
            }}
          />
        </div>

        {/* Content */}
        <div style={{ padding: '16px 20px', overflow: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
              Loading audit records...
            </div>
          ) : filteredLogs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
              No audit logs recorded for this criteria.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr style={{ background: '#f1f5f9' }}>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Date / Time</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Action</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Details</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map(log => {
                  const d = log.details || {};
                  return (
                    <tr key={log.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: '#64748b' }}>
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <span style={{
                          background: log.action.includes('status') ? '#eff6ff' : '#f0fdf4',
                          color: log.action.includes('status') ? '#1d4ed8' : '#15803d',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontWeight: 600,
                          fontSize: '0.72rem'
                        }}>
                          {log.action}
                        </span>
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {d.studentName && <strong>{d.studentName} — </strong>}
                        {d.subject && <span>{d.subject}: </span>}
                        {d.oldMark !== undefined && d.newMark !== undefined ? (
                          <span>
                            <del style={{ color: '#ef4444' }}>{d.oldMark}</del> → <strong style={{ color: '#10b981' }}>{d.newMark}</strong>
                          </span>
                        ) : d.oldStatus && d.newStatus ? (
                          <span>Status changed: {d.oldStatus} → {d.newStatus}</span>
                        ) : (
                          <span>{JSON.stringify(d)}</span>
                        )}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#64748b', fontStyle: d.reason ? 'normal' : 'italic' }}>
                        {d.reason || 'Not specified'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'flex-end',
          background: '#f8fafc'
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              color: '#475569',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer'
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
