import React from 'react';
import Select from '../Common/Select';

/**
 * Compact, dense Subject Statistics Bar
 * Displays key metrics per subject or class without giant cards.
 */
export default function SubjectStatisticsBar({
  stats = {},
  subjects = [],
  selectedSubject,
  onSelectSubject,
  focusSubject = false,
  onToggleFocusSubject = null
}) {
  const currentStat = selectedSubject && stats[selectedSubject]
    ? { subject: selectedSubject, ...stats[selectedSubject] }
    : null;

  return (
    <div style={{
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: '8px',
      padding: '10px 14px',
      marginBottom: '16px',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      fontSize: '0.82rem'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: '#475569', textTransform: 'uppercase', fontSize: '0.75rem', letterSpacing: '0.04em' }}>
          Subject Stats:
        </span>
        <Select
          value={selectedSubject || 'ALL'}
          onChange={e => onSelectSubject(e.target.value === 'ALL' ? null : e.target.value)}
          options={[
            { id: 'ALL', label: 'All Subjects Summary' },
            ...subjects.map(s => ({ id: s, label: s }))
          ]}
          size="sm"
          style={{ minWidth: 200 }}
        />

        {selectedSubject && onToggleFocusSubject && (
          <button
            type="button"
            onClick={onToggleFocusSubject}
            style={{
              padding: '3px 10px',
              fontSize: '0.75rem',
              fontWeight: 600,
              borderRadius: '4px',
              border: focusSubject ? '1px solid #2563eb' : '1px solid #cbd5e1',
              background: focusSubject ? '#eff6ff' : '#ffffff',
              color: focusSubject ? '#1d4ed8' : '#475569',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px'
            }}
            title={focusSubject ? 'Show all subject columns' : `Show only ${selectedSubject} column`}
          >
            {focusSubject ? '✓ Focused (Show All)' : `Focus ${selectedSubject}`}
          </button>
        )}
      </div>

      {currentStat ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <span style={{ color: '#64748b' }}>Avg: </span>
            <strong style={{ color: '#1e293b' }}>{currentStat.average}%</strong>
            {currentStat.grade && (
              <span style={{
                marginLeft: '6px',
                padding: '1px 6px',
                borderRadius: '4px',
                fontWeight: 700,
                fontSize: '0.75rem',
                background: currentStat.gradeColor ? `${currentStat.gradeColor}18` : '#e0e7ff',
                color: currentStat.gradeColor || '#4338ca',
                border: `1px solid ${currentStat.gradeColor || '#c7d2fe'}`
              }}>
                Grade {currentStat.grade}
              </span>
            )}
          </div>
          <div>
            <span style={{ color: '#64748b' }}>High: </span>
            <strong style={{ color: '#16a34a' }}>{currentStat.highest}</strong>
          </div>
          <div>
            <span style={{ color: '#64748b' }}>Low: </span>
            <strong style={{ color: '#dc2626' }}>{currentStat.lowest}</strong>
          </div>
          <div>
            <span style={{ color: '#64748b' }}>Pass Rate: </span>
            <strong style={{ color: currentStat.passRate >= 50 ? '#16a34a' : '#dc2626' }}>{currentStat.passRate}%</strong>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <span style={{ background: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
              {currentStat.entered} Entered
            </span>
            {currentStat.absent > 0 && (
              <span style={{ background: '#fef3c7', color: '#b45309', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                {currentStat.absent} ABS
              </span>
            )}
            {currentStat.missing > 0 && (
              <span style={{ background: '#fee2e2', color: '#b91c1c', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                {currentStat.missing} Missing
              </span>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', color: '#64748b' }}>
          <span>Select any subject to view detailed averages, grades, high/low scores, and focus columns.</span>
        </div>
      )}
    </div>
  );
}
