import { useCallback, useEffect, useState } from 'react';
import { getSchoolProfile } from '../data/coreStore';
import { getMigrationBatches, recordMigrationBatch } from '../data/migrationStore';
import StudentImporter from '../components/StudentImporter';
import TeacherImporter from '../components/TeacherImporter';
import {
  UploadIcon,
  FileIcon,
  StudentIcon,
  TeacherIcon,
  AlertIcon,
  RefreshIcon
} from '../components/CommonIcons';

const DATASETS = [
  {
    key: 'students',
    title: 'Students & learners',
    description: 'Migrate admission numbers, learner details, class placement and guardian contacts.',
    icon: StudentIcon,
    available: true,
    note: 'Migration mode preserves imported student status and does not create new current-term fee invoices.'
  },
  {
    key: 'teachers',
    title: 'Teachers & staff directory',
    description: 'Migrate staff profiles, staff codes, TSC numbers, subjects and contact details.',
    icon: TeacherIcon,
    available: true,
    note: 'Imports create directory profiles only. They never create passwords, PINs or login accounts.'
  },
  {
    key: 'finance',
    title: 'Fees & payment history',
    description: 'Historical balances, invoices, receipts and payment transactions.',
    available: false,
    note: 'Requires a finance-specific reconciliation workflow. Do not import a balance as if it were a payment.'
  },
  {
    key: 'academics',
    title: 'Academic records & results',
    description: 'Academic years, terms, subjects, exams, marks and grading scales.',
    available: false,
    note: 'Requires class, period, subject and grading-scale mapping before records can be committed.'
  },
  {
    key: 'attendance',
    title: 'Attendance history',
    description: 'Daily registers, lesson sessions, attendance statuses and historical dates.',
    available: false,
    note: 'Requires a session-aware importer so half-day and lesson attendance are not changed into full-day records.'
  },
  {
    key: 'library',
    title: 'Library catalogue & loans',
    description: 'Books, physical copies, borrowers, issue dates, due dates and returned loans.',
    available: false,
    note: 'Requires catalogue and copy matching before borrower history is imported.'
  }
];

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusStyle(status) {
  if (status === 'completed') return { color: '#047857', background: '#d1fae5' };
  if (status === 'partial') return { color: '#92400e', background: '#fef3c7' };
  return { color: '#b91c1c', background: '#fee2e2' };
}

export default function MigrationCenter({ currentUser }) {
  const [profile, setProfile] = useState({});
  const [history, setHistory] = useState([]);
  const [sourceSystem, setSourceSystem] = useState('');
  const [migrationNotes, setMigrationNotes] = useState('');
  const [activeImporter, setActiveImporter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [notice, setNotice] = useState(null);
  const [savingLog, setSavingLog] = useState(false);

  const isAdmin = ['admin', 'owner'].includes(String(currentUser?.role || '').toLowerCase());

  const loadPage = useCallback(async () => {
    setLoading(true);
    setHistoryError('');
    try {
      const [schoolProfile, batches] = await Promise.all([
        getSchoolProfile(),
        getMigrationBatches()
      ]);
      setProfile(schoolProfile || {});
      setHistory(batches || []);
    } catch (error) {
      setHistoryError(error?.message || 'Could not load migration history.');
      try {
        const schoolProfile = await getSchoolProfile();
        setProfile(schoolProfile || {});
      } catch (_) { /* keep the page usable while the audit table is being installed */ }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPage(); }, [loadPage]);

  const handleImportComplete = async (dataset, result) => {
    setSavingLog(true);
    setNotice(null);
    try {
      const batch = await recordMigrationBatch({
        dataset,
        sourceSystem: sourceSystem.trim() || 'Legacy school system',
        sourceFilename: result?.sourceFileName || null,
        result,
        notes: migrationNotes
      });
      setHistory((items) => [batch, ...items.filter((item) => item.id !== batch.id)].slice(0, 20));
      setNotice({
        type: batch.status === 'completed' ? 'success' : batch.status === 'partial' ? 'warning' : 'danger',
        text: `Import recorded: ${batch.inserted_count} added, ${batch.updated_count} updated, ${batch.skipped_count} skipped and ${batch.failed_count} needing attention.`
      });
    } catch (error) {
      // The data import may already have committed. Never imply it was rolled back
      // because only its audit entry failed.
      setNotice({
        type: 'warning',
        text: `The records were imported, but the migration history entry could not be saved: ${error?.message || 'Unknown error'}. Apply the migration-history SQL and record this run during reconciliation.`
      });
    } finally {
      setSavingLog(false);
      await loadPage();
    }
  };

  if (!isAdmin) {
    return <div className="page-container"><div className="card" role="alert" style={{ padding: 24 }}>Administrator access is required to manage school data migrations.</div></div>;
  }

  return (
    <div className="page-container" style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 20px 48px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--primary-light)', color: 'var(--primary)' }}>
              <UploadIcon size={21} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.08em' }}>School data operations</span>
          </div>
          <h1 style={{ margin: 0, fontSize: '1.7rem', fontWeight: 850, color: 'var(--text-main)' }}>Migration Center</h1>
          <p style={{ margin: '6px 0 0', color: 'var(--text-light)', maxWidth: 760, lineHeight: 1.55 }}>
            Bring authorised records from the school's previous software into Termly. Review the source, map its columns, validate records and reconcile the result before the school switches over.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={loadPage} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <RefreshIcon size={15} /> Refresh history
        </button>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <FileIcon size={19} color="var(--primary)" />
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>Migration source details</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
          <label className="form-group" style={{ margin: 0 }}>
            <span style={{ display: 'block', fontSize: '.75rem', fontWeight: 700, marginBottom: 6 }}>Old software / source system</span>
            <input className="form-input" value={sourceSystem} onChange={(event) => setSourceSystem(event.target.value)} maxLength={160} placeholder="e.g. Legacy School Manager v4" />
          </label>
          <label className="form-group" style={{ margin: 0 }}>
            <span style={{ display: 'block', fontSize: '.75rem', fontWeight: 700, marginBottom: 6 }}>Migration notes (optional)</span>
            <input className="form-input" value={migrationNotes} onChange={(event) => setMigrationNotes(event.target.value)} maxLength={2000} placeholder="e.g. Records supplied by the school administrator" />
          </label>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: '.72rem', color: 'var(--text-light)', lineHeight: 1.5 }}>
          These details are attached to the migration audit entry. Do not put learner names, admission numbers or sensitive personal details in the notes. Termly does not upload or retain the original spreadsheet in the migration history. Imports are processed in batches; if a later batch fails, earlier successful rows remain saved. Review the result and reconcile failed rows before retrying the file.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16, marginBottom: 24 }}>
        {DATASETS.map((dataset) => {
          const Icon = dataset.icon || FileIcon;
          return (
            <div className="card" key={dataset.key} style={{ padding: 20, display: 'flex', flexDirection: 'column', minHeight: 220 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: dataset.available ? 'var(--primary-light)' : 'var(--bg)', color: dataset.available ? 'var(--primary)' : 'var(--text-light)' }}>
                  <Icon size={20} />
                </div>
                <span style={{ fontSize: '.66rem', fontWeight: 800, padding: '5px 9px', borderRadius: 20, background: dataset.available ? '#dcfce7' : 'var(--bg)', color: dataset.available ? '#166534' : 'var(--text-light)' }}>
                  {dataset.available ? 'AVAILABLE' : 'ASSISTED MIGRATION'}
                </span>
              </div>
              <h3 style={{ margin: '14px 0 5px', fontSize: '1rem', fontWeight: 800 }}>{dataset.title}</h3>
              <p style={{ margin: 0, fontSize: '.8rem', color: 'var(--text-light)', lineHeight: 1.5 }}>{dataset.description}</p>
              <p style={{ margin: '10px 0 16px', fontSize: '.72rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{dataset.note}</p>
              <div style={{ marginTop: 'auto' }}>
                {dataset.available ? (
                  <button className="btn btn-primary" style={{ width: '100%', display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 8 }} onClick={() => setActiveImporter(dataset.key)}>
                    <UploadIcon size={15} /> Import {dataset.key === 'students' ? 'students' : 'staff'}
                  </button>
                ) : (
                  <button className="btn btn-secondary" style={{ width: '100%' }} disabled title="This dataset needs a dedicated importer and reconciliation rules before it can be committed safely.">Not enabled yet</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 22 }}>
        <h2 style={{ margin: '0 0 14px', fontSize: '1rem', fontWeight: 800 }}>Recommended migration sequence</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12 }}>
          {[
            ['01', 'Assess the source', 'Agree which records the school wants migrated and who authorised access.'],
            ['02', 'Export the data', 'Use the old system’s supported reports, spreadsheets or database exports.'],
            ['03', 'Map and validate', 'Match columns, preserve identifiers and review duplicates and missing values.'],
            ['04', 'Import and reconcile', 'Compare source totals with Termly and obtain school approval before cutover.']
          ].map(([number, title, description]) => (
            <div key={number} style={{ padding: 14, borderRadius: 12, background: 'var(--bg)' }}>
              <div style={{ fontSize: '.68rem', fontWeight: 900, color: 'var(--primary)', marginBottom: 8 }}>{number}</div>
              <div style={{ fontWeight: 800, fontSize: '.84rem', marginBottom: 5 }}>{title}</div>
              <div style={{ color: 'var(--text-light)', fontSize: '.74rem', lineHeight: 1.5 }}>{description}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 16, padding: 12, borderRadius: 10, background: '#fffbeb', color: '#92400e', fontSize: '.76rem', lineHeight: 1.5 }}>
          <AlertIcon size={17} />
          <span>Do not import fee balances as payment transactions, or historical marks without their original academic period and grading scale. Those datasets need their own reconciliation steps.</span>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>Migration history</h2>
            <p style={{ margin: '4px 0 0', fontSize: '.75rem', color: 'var(--text-light)' }}>Append-only summaries for completed import runs. Original source data is not stored here.</p>
          </div>
          {savingLog && <span style={{ fontSize: '.72rem', color: 'var(--text-light)' }}>Recording import…</span>}
        </div>
        {notice && (
          <div role="status" style={{ padding: 12, borderRadius: 10, marginBottom: 14, background: notice.type === 'success' ? '#ecfdf5' : notice.type === 'danger' ? '#fef2f2' : '#fffbeb', color: notice.type === 'success' ? '#047857' : notice.type === 'danger' ? '#b91c1c' : '#92400e', fontSize: '.78rem', lineHeight: 1.5 }}>
            {notice.text}
          </div>
        )}
        {historyError ? (
          <div role="alert" style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: 14, borderRadius: 10, background: '#fffbeb', color: '#92400e', fontSize: '.78rem', lineHeight: 1.5 }}>
            <AlertIcon size={17} />
            <span>Migration history is unavailable. Apply `20261109235900_create_school_migration_batches.sql` and check administrator access. ({historyError})</span>
          </div>
        ) : loading ? (
          <div style={{ padding: 26, textAlign: 'center', color: 'var(--text-light)', fontSize: '.8rem' }}>Loading migration history…</div>
        ) : history.length === 0 ? (
          <div style={{ padding: 26, textAlign: 'center', color: 'var(--text-light)', fontSize: '.8rem' }}>No migration batches recorded for this school yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', minWidth: 720 }}>
              <thead><tr><th>When</th><th>Dataset</th><th>Source system</th><th>File type</th><th>Import result</th><th>Rows</th><th>Status</th></tr></thead>
              <tbody>
                {history.map((batch) => (
                  <tr key={batch.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(batch.created_at)}</td>
                    <td>{batch.dataset === 'students' ? 'Students' : 'Teachers'}</td>
                    <td>{batch.source_system || 'Legacy system'}</td>
                    <td style={{ textTransform: 'uppercase', fontSize: '.7rem' }}>{batch.source_filename || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '.75rem' }}>+{batch.inserted_count} / ~{batch.updated_count} / {batch.skipped_count} skipped / {batch.failed_count} failed</td>
                    <td>{batch.total_rows}</td>
                    <td><span style={{ ...statusStyle(batch.status), display: 'inline-flex', borderRadius: 20, padding: '4px 8px', fontSize: '.65rem', fontWeight: 800, textTransform: 'uppercase' }}>{batch.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {activeImporter === 'students' && (
        <StudentImporter
          profile={profile}
          mode="migration"
          onClose={() => setActiveImporter(null)}
          onImport={(result) => handleImportComplete('students', result)}
        />
      )}
      {activeImporter === 'teachers' && (
        <TeacherImporter
          profile={profile}
          onClose={() => setActiveImporter(null)}
          onImport={(result) => handleImportComplete('teachers', result)}
        />
      )}
    </div>
  );
}
