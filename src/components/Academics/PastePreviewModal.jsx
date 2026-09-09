import React from 'react';

/**
 * Preview modal for bulk pastes from Excel / Google Sheets
 */
export default function PastePreviewModal({
  isOpen,
  pasteData,
  onConfirm,
  onCancel
}) {
  if (!isOpen || !pasteData) return null;

  const { rows, cols, parsedGrid, validCount, invalidCount, startStudent, startSubject } = pasteData;

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
        maxWidth: '720px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
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
              Paste Range Preview
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#64748b' }}>
              Pasting from <strong>{startStudent}</strong> / <strong>{startSubject}</strong>
            </p>
          </div>
          <span style={{
            background: '#e0e7ff',
            color: '#4338ca',
            fontSize: '0.75rem',
            fontWeight: 700,
            padding: '4px 10px',
            borderRadius: '16px'
          }}>
            {rows} Rows × {cols} Columns
          </span>
        </div>

        {/* Status Metrics */}
        <div style={{
          padding: '12px 20px',
          background: invalidCount > 0 ? '#fffbeb' : '#f0fdf4',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          gap: '16px',
          fontSize: '0.85rem'
        }}>
          <div>
            <span style={{ color: '#64748b' }}>Valid Marks: </span>
            <strong style={{ color: '#16a34a' }}>{validCount}</strong>
          </div>
          {invalidCount > 0 && (
            <div>
              <span style={{ color: '#64748b' }}>Invalid / Out of Range: </span>
              <strong style={{ color: '#dc2626' }}>{invalidCount}</strong>
            </div>
          )}
          <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#64748b' }}>
            {invalidCount > 0 ? 'Invalid cells are highlighted in red and will be flagged.' : 'All pasted values are valid.'}
          </div>
        </div>

        {/* Preview Grid */}
        <div style={{ padding: '16px 20px', overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ background: '#f1f5f9' }}>
                <th style={{ padding: '6px 10px', border: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 700 }}>#</th>
                <th style={{ padding: '6px 10px', border: '1px solid #cbd5e1', textAlign: 'left', fontWeight: 700 }}>Student Target</th>
                {parsedGrid[0]?.cells.map((c, i) => (
                  <th key={i} style={{ padding: '6px 10px', border: '1px solid #cbd5e1', textAlign: 'center', fontWeight: 700 }}>
                    {c.subject || `Col ${i + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsedGrid.slice(0, 15).map((row, rIdx) => (
                <tr key={rIdx} style={{ background: rIdx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                  <td style={{ padding: '6px 10px', border: '1px solid #e2e8f0', color: '#64748b' }}>{rIdx + 1}</td>
                  <td style={{ padding: '6px 10px', border: '1px solid #e2e8f0', fontWeight: 600 }}>{row.studentName}</td>
                  {row.cells.map((cell, cIdx) => (
                    <td key={cIdx} style={{
                      padding: '6px 10px',
                      border: '1px solid #e2e8f0',
                      textAlign: 'center',
                      background: cell.error ? '#fee2e2' : cell.isSpecial ? '#fef3c7' : 'transparent',
                      color: cell.error ? '#b91c1c' : cell.isSpecial ? '#b45309' : '#0f172a',
                      fontWeight: cell.isSpecial || cell.error ? 700 : 500
                    }} title={cell.error || ''}>
                      {cell.displayValue}
                    </td>
                  ))}
                </tr>
              ))}
              {parsedGrid.length > 15 && (
                <tr>
                  <td colSpan={parsedGrid[0]?.cells.length + 2} style={{ textAlign: 'center', padding: '8px', color: '#64748b', fontStyle: 'italic' }}>
                    + {parsedGrid.length - 15} more rows...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px',
          background: '#f8fafc'
        }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              fontWeight: 600,
              fontSize: '0.85rem',
              color: '#475569',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 18px',
              borderRadius: '6px',
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer'
            }}
          >
            Apply Paste ({validCount} marks)
          </button>
        </div>
      </div>
    </div>
  );
}
