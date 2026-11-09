import { useState, useEffect } from 'react';
import { getStudents } from '../data/studentStore';
import { getAttendance, markAttendance, markAttendanceBatch, getAttendanceSummary, getTodayStr, getSubjectAssignments } from '../data/academicsStore';
import { getSchoolProfile, isFeatureEnabled, getPrintHeader } from '../data/coreStore';
import { queueSmsBatch } from '../data/smsStore';;
import { CBC_STRUCTURE } from '../data/seedData';
import { 
  CheckIcon, ClockIcon, CrossIcon, PrintIcon, DashboardIcon, FlagIcon, PlatformZapIcon, SendIcon 
} from '../components/CommonIcons';
import { dispatchSMS, generateAttendanceMessage } from '../utils/sms';
import Select from '../components/Common/Select';
import { Helmet } from 'react-helmet-async';
import FeatureGate from '../components/FeatureGate';
import { useDialog } from '../contexts/DialogContext';

import { useFeature } from '../contexts/FeaturesContext';

export default function Attendance({ currentUser, currentPeriodId }) {
  const { alert, confirm } = useDialog();
  const [selectedClass, setSelectedClass] = useState('All');
  const [streamFilter, setStreamFilter] = useState('All');
  const [selectedSession, setSelectedSession] = useState('Morning');
  const [selectedDate, setSelectedDate] = useState(getTodayStr());
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const [reportType, setReportType] = useState('day');
  const [students, setStudents] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [summary, setSummary] = useState({ present: 0, late: 0, absent: 0, total: 0, percentage: 0 });
  const [profile, setProfile] = useState({ streams: [], activeClasses: [] });
  const [assignments, setAssignments] = useState({});
  const [loading, setLoading] = useState(true);
  const [alertModal, setAlertModal] = useState({ open: false, sending: false });
  const [showUpgrade, setShowUpgrade] = useState(false);
  
  const { enabled: hasAccess, loading: featureLoading } = useFeature('attendance');

  const userRole = currentUser?.role?.toLowerCase() || 'teacher';
  const isTeacher = userRole === 'teacher';

  useEffect(() => { 
    if (!hasAccess) return;
    const init = async () => {
      setLoading(true);
      try {
        const [p, a] = await Promise.all([getSchoolProfile(), getSubjectAssignments()]);
        setProfile(p);
        setAssignments(a);
        await refresh();
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    };
    init();
  }, [selectedClass, streamFilter, selectedSession, selectedDate, currentPeriodId, hasAccess]);

  if (featureLoading) return <div className="p-4"><div className="spinner"></div></div>;
  if (!hasAccess) return <FeatureGate featureName="Attendance" />;


  const calcSummary = (attData, studentList) => {
    let present = 0, late = 0, absent = 0;
    studentList.forEach(s => {
      const status = attData[s.id]?.[selectedSession] || attData[s.id]; // Fallback to flat if legacy
      if (status === 'present') present++;
      else if (status === 'late') late++;
      else if (status === 'absent') absent++;
    });
    const total = studentList.length;
    const pct = total > 0 ? (((present + late) / total) * 100).toFixed(1) : 0;
    return { present, late, absent, total, percentage: Number(pct) };
  };

  const refresh = async () => {
    try {
      const [allStudents, att] = await Promise.all([getStudents(), getAttendance()]);
      let filtered = selectedClass === 'All' ? allStudents : allStudents.filter(s => s.class === selectedClass);
      if (streamFilter !== 'All') {
        filtered = filtered.filter(s => s.stream === streamFilter);
      }
      setStudents(filtered);
      const dayData = att[selectedDate] || {};
      setAttendance(dayData);
      setSummary(calcSummary(dayData, filtered));
    } catch(err) { console.error(err); }
  };

  const handleMark = async (studentId, status) => {
    // Optimistic UI Update
    const currentStudentAtt = attendance[studentId] || {};
    const newAtt = { 
      ...attendance, 
      [studentId]: typeof currentStudentAtt === 'string' ? status : { ...currentStudentAtt, [selectedSession]: status }
    };
    setAttendance(newAtt);
    setSummary(calcSummary(newAtt, students));

    // Fire and forget
    markAttendance(selectedDate, studentId, status, selectedSession).catch(async (err) => {
      alert({ title: 'Attendance Error', message: err.message, variant: 'danger' });
      await refresh();
    });
  };

  const markAllPresent = async () => {
    if (students.length === 0) return;

    const scope = [
      selectedClass === 'All' ? 'all classes' : selectedClass,
      streamFilter === 'All' ? 'all streams' : streamFilter + ' stream',
      selectedSession.toLowerCase(),
      selectedDate,
    ].join(' · ');
    const ok = await confirm({
      title: 'Mark all students present?',
      message: 'This will mark ' + students.length + ' students as present for ' + scope + '. Check the class and session before continuing.',
      confirmText: 'Mark all present',
      variant: 'warning',
    });
    if (!ok) return;

    setLoading(true);
    try {
      await markAttendanceBatch(selectedDate, students, 'present', selectedSession);
      await refresh();
    } catch(err) { alert({ title: 'Attendance Error', message: err.message, variant: 'danger' }); }
    finally { setLoading(false); }
  };

  const handlePrint = async () => {
    setLoading(true);
    try {
      const allAtt = await getAttendance();
      const students = await getStudents();
      const profile = await getSchoolProfile();
      const header = await getPrintHeader();

      let dates = [];
      const cur = new Date(selectedDate);

      if (reportType === 'day') {
        dates = [selectedDate];
      } else if (reportType === 'week') {
        // Get Mon-Fri of the week containing selectedDate
        const day = cur.getDay();
        const diff = cur.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(cur.setDate(diff));
        for(let i=0; i<5; i++) {
          const d = new Date(mon);
          d.setDate(mon.getDate() + i);
          dates.push(d.toISOString().split('T')[0]);
        }
      } else if (reportType === 'month') {
        const year = cur.getFullYear();
        const month = cur.getMonth();
        const lastDay = new Date(year, month + 1, 0).getDate();
        for(let i=1; i<=lastDay; i++) {
          const d = new Date(year, month, i);
          if (d.getDay() !== 0 && d.getDay() !== 6) {
            dates.push(d.toISOString().split('T')[0]);
          }
        }
      }

      const filteredStudents = selectedClass === 'All' ? students : students.filter(s => s.class === selectedClass);
      const finalStudents = streamFilter === 'All' ? filteredStudents : filteredStudents.filter(s => s.stream === streamFilter);

      const printWin = window.open('', '_blank');
      printWin.document.write(`<html><head><title>Attendance Report</title>
        <style>
          @page { margin: 0; }
          body { font-family: sans-serif; padding: 15mm; color: #333; }
          .header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #eee; padding-bottom: 15px; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 0.85rem; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
          th { background: #f9f9f9; }
          .student-name { text-align: left; }
          .present { color: #10b981; font-weight: bold; }
          .absent { color: #ef4444; font-weight: bold; }
          .late { color: #f59e0b; font-weight: bold; }
          .footer { margin-top: 30px; font-size: 0.8rem; color: #777; border-top: 1px solid #eee; padding-top: 10px; }
        </style>
      </head><body>`);
      
      printWin.document.write(header);
      printWin.document.write(`
        <div class="header">
          <h2>Attendance Report (${reportType.toUpperCase()})</h2>
          <p><strong>Class:</strong> ${selectedClass} | <strong>Stream:</strong> ${streamFilter}</p>
          <p><strong>Date:</strong> ${dates[0]} ${dates.length > 1 ? ' to ' + dates[dates.length-1] : ''}</p>
        </div>
        <table>
          <thead>
            <tr>
              <th rowspan="2">#</th>
              <th rowspan="2">Adm No</th>
              <th rowspan="2" class="student-name">Student Name</th>
              ${dates.map(d => `<th>${new Date(d).toLocaleDateString(undefined, {weekday:'short', day:'numeric'})}</th>`).join('')}
              <th rowspan="2">Rate</th>
            </tr>
          </thead>
          <tbody>
            ${finalStudents.map((s, idx) => {
              let presentCount = 0;
              let trackedDays = 0;
              const row = dates.map(d => {
                const record = allAtt[d]?.[s.id];
                const status = typeof record === 'string' ? record : record?.[selectedSession];
                if (status) trackedDays++;
                if (status === 'present' || status === 'late') presentCount++;
                const char = status === 'present' ? 'P' : status === 'late' ? 'L' : status === 'absent' ? 'A' : '—';
                const cls = status || '';
                return `<td class="${cls}">${char}</td>`;
              }).join('');
              const rate = trackedDays > 0 ? ((presentCount / trackedDays) * 100).toFixed(0) : '0';
              return `<tr>
                <td>${idx+1}</td>
                <td><code>${s.admNo}</code></td>
                <td class="student-name">${s.name}</td>
                ${row}
                <td><strong>${rate}%</strong></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="footer">
          School Management System — Generated on ${new Date().toLocaleString()}
        </div>
      </body></html>`);
      printWin.document.close();
      printWin.print();
    } catch(err) { alert({ title: 'Print Error', message: err.message, variant: 'danger' }); }
    finally { setLoading(false); setShowPrintOptions(false); }
  };

  const handleSendSMS = async () => {
    const absentees = students.filter(s => (attendance[s.id]?.[selectedSession] || attendance[s.id]) === 'absent');
    if (absentees.length === 0) {
      alert({ title: 'No Absentees', message: 'There are no students marked absent today.', variant: 'info' });
      return;
    }

    const ok = await confirm({
      title: 'Send SMS Alerts',
      message: `Send absence notification to parents of ${absentees.length} students?`,
      confirmText: 'Send Now',
      variant: 'primary'
    });

    if (ok) {
      setLoading(true);
      try {
        let sentCount = 0;
        for (const s of absentees) {
          const msg = generateAttendanceMessage(s.name, 'absent', selectedDate);
          await dispatchSMS(s.parentPhone, msg);
          sentCount++;
        }
        alert({ title: 'SMS Dispatched', message: `${sentCount} SMS alerts sent successfully.`, variant: 'success' });
      } catch (err) {
        alert({ title: 'SMS Error', message: err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="animate-in">
      <Helmet>
        <title>Student Attendance Tracking | Termly — Daily Records</title>
        <meta name="description" content="Mark daily student attendance, track late arrivals, and generate attendance reports." />
      </Helmet>
      <div className="page-header">
        <div className="page-header-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '-0.5px' }}>Attendance</h2>
              <p className="text-muted">Mark and track daily attendance</p>
            </div>
            {loading && <span className="text-muted" style={{ fontSize: '0.85rem' }}>Loading...</span>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" onClick={handleSendSMS} disabled={loading}>
              <SendIcon size={16} /> Send SMS Alerts
            </button>
            <button className="btn btn-ghost" onClick={() => setShowPrintOptions(true)} disabled={loading}>
              <PrintIcon size={16} /> Print Report
            </button>
            <button className="btn btn-success" onClick={markAllPresent} disabled={loading}>
              <CheckIcon size={16} /> Mark All Present
            </button>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="kpi-grid">
        <div className="kpi-card green">
          <div className="kpi-icon green"><CheckIcon size={20} /></div>
          <div className="kpi-value">{summary.present}</div>
          <div className="kpi-label">Present</div>
        </div>
        <div className="kpi-card orange">
          <div className="kpi-icon orange"><ClockIcon size={20} /></div>
          <div className="kpi-value">{summary.late}</div>
          <div className="kpi-label">Late</div>
        </div>
        <div className="kpi-card red">
          <div className="kpi-icon red"><CrossIcon size={20} /></div>
          <div className="kpi-value">{summary.absent}</div>
          <div className="kpi-label">Absent</div>
        </div>
        <div className="kpi-card purple">
          <div className="kpi-icon purple"><DashboardIcon size={20} /></div>
          <div className="kpi-value">{summary.percentage}%</div>
          <div className="kpi-label">Attendance Rate</div>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-bar" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Class:</label>
          <Select 
            value={selectedClass} 
            onChange={e => { setSelectedClass(e.target.value); setStreamFilter('All'); }}
            options={[
              { id: 'All', label: 'All Classes' },
              ...Object.entries(CBC_STRUCTURE).flatMap(([levelName, levelData]) => {
                const isMatch = (g1, g2) => g1?.toLowerCase().trim() === g2?.toLowerCase().trim();
                const activeInLevel = levelData.grades.filter(g => 
                  (profile.activeClasses || []).some(ac => isMatch(ac, g))
                );
                return activeInLevel.map(g => {
                  const isMyClass = assignments[g] && Object.values(assignments[g]).some(streams => 
                    typeof streams === 'string' ? streams === currentUser?.id :
                    Object.values(streams).some(tid => tid === currentUser?.id)
                  );
                  return { id: g, label: isMyClass && isTeacher ? `[My Class] ${g}` : g };
                });
              })
            ]}
            style={{ minWidth: 160 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Stream:</label>
          <Select 
            value={streamFilter} 
            onChange={(e) => setStreamFilter(e.target.value)}
            options={[
              { id: 'All', label: 'All Streams' },
              ...(selectedClass !== 'All' 
                 ? (profile.streamsPerClass?.[selectedClass] || [])
                 : Array.from(new Set(
                     Object.entries(profile.streamsPerClass || {})
                       .filter(([cls]) => (profile.activeClasses || []).includes(cls))
                       .flatMap(([, streams]) => streams)
                   ))
              ).map(stream => ({ id: stream, label: stream }))
            ]}
            style={{ minWidth: 140 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Session:</label>
          <Select 
            value={selectedSession} 
            onChange={(e) => setSelectedSession(e.target.value)}
            options={[
              { id: 'Morning', label: 'Morning Session' },
              { id: 'Afternoon', label: 'Afternoon Session' },
              { id: 'Evening', label: 'Evening Session' }
            ]}
            style={{ minWidth: 140 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Date:</label>
          <input type="date" className="form-input" style={{ width: 'auto', padding: '6px 12px' }} value={selectedDate} onChange={e => setSelectedDate(e.target.value)} />
        </div>
        <div style={{ flex: 1 }} />
        <span className="text-muted" style={{ fontSize: '0.85rem' }}>{students.length} students</span>
      </div>

      {/* Attendance Table */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <table className="data-table responsive-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Adm No</th>
                <th>Name</th>
                <th>Class</th>
                <th>Stream</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {students.length === 0 ? (
                <tr><td colSpan="6" className="text-center text-muted" style={{ padding: '40px' }}>No students found</td></tr>
              ) : (
                students.map((s, i) => {
                  const studentAtt = attendance[s.id] || {};
                  const status = typeof studentAtt === 'string' ? studentAtt : (studentAtt[selectedSession] || '');
                  return (
                    <tr key={s.id}>
                      <td data-label="#" className="text-muted">{i + 1}</td>
                      <td data-label="Adm No"><code style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>{s.admNo}</code></td>
                      <td data-label="Name"><strong>{s.name}</strong></td>
                      <td data-label="Class"><span className="badge badge-info">{s.class}</span></td>
                      <td data-label="Stream">{s.stream || '—'}</td>
                      <td data-label="Status">
                        <div className="attendance-toggle">
                          <button className={status === 'present' ? 'present' : ''} onClick={() => handleMark(s.id, 'present')}>
                            Present
                          </button>
                          <button className={status === 'late' ? 'late' : ''} onClick={() => handleMark(s.id, 'late')}>
                            Late
                          </button>
                          <button className={status === 'absent' ? 'absent' : ''} onClick={() => handleMark(s.id, 'absent')}>
                            Absent
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      {/* Modal for Print Options */}
      {showPrintOptions && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 400 }}>
            <div className="modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}><PrintIcon size={20} /> Print Attendance Report</h3>
              <button className="btn-close" style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', display: 'flex', alignItems: 'center' }} onClick={() => setShowPrintOptions(false)}><CrossIcon size={20} /></button>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              <div className="form-group" style={{ marginBottom: 15 }}>
                <label className="form-label" style={{ display: 'block', marginBottom: 8, fontSize: '0.85rem', fontWeight: 600 }}>Report Type</label>
                <Select 
                  value={reportType} 
                  onChange={e => setReportType(e.target.value)}
                  options={[
                    { id: 'day', label: 'Daily Report (Single Day)' },
                    { id: 'week', label: 'Weekly Report (Mon - Fri)' },
                    { id: 'month', label: 'Monthly Report (Whole Month)' }
                  ]}
                  style={{ width: '100%' }}
                />
                <p style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: 8, lineHeight: 1.4 }}>
                  The report will be based on the week or month containing the currently selected date: <strong>{selectedDate}</strong>
                </p>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={handlePrint}>Generate Printout</button>
                <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setShowPrintOptions(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual SMS Alerts Modal */}
      {alertModal.open && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 450 }}>
            <div className="modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}><PlatformZapIcon size={20} color="var(--ro)" /> Absence Alerts</h3>
              <button className="btn-close" style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', display: 'flex', alignItems: 'center' }} onClick={() => setAlertModal({ open: false })}><CrossIcon size={20} /></button>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-main)', marginBottom: 15 }}>
                You are about to send <strong>{summary.absent}</strong> SMS alerts to parents of absent students for <strong>{selectedDate}</strong>.
              </p>
              
              <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg)', padding: 12, borderRadius: 8, border: '1px solid var(--border)', marginBottom: 20 }}>
                {students.filter(s => (attendance[s.id]?.[selectedSession] || attendance[s.id]) === 'absent').map(s => (
                  <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{s.name} ({s.class})</span>
                    <span style={{ color: 'var(--text-light)' }}>{s.parent_phone || 'No Phone'}</span>
                  </div>
                ))}
              </div>

              <div style={{ padding: 12, borderRadius: 8, background: 'rgba(59,130,246,0.05)', border: '1px solid var(--primary)', marginBottom: 20 }}>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 600 }}>Message Preview:</p>
                <p style={{ margin: '6px 0 0', fontSize: '0.8rem', fontStyle: 'italic', color: 'var(--text-main)' }}>
                  "Termly Alert: [Student Name] is marked ABSENT today ({selectedDate}). Please contact the school for details."
                </p>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button 
                  className="btn btn-primary" 
                  style={{ flex: 2, justifyContent: 'center' }}
                  disabled={alertModal.sending || summary.absent === 0}
                  onClick={async () => {
                    setAlertModal(prev => ({ ...prev, sending: true }));
                    try {
                      const messages = students
                        .filter(s => attendance[s.id] === 'absent' && s.parent_phone)
                        .map(s => ({
                          phone: s.parent_phone,
                          message: `Termly Alert: ${s.name} is marked ABSENT today (${selectedDate}). Please contact the school for details.`,
                          type: 'attendance'
                        }));
                      
                      if (messages.length > 0) {
                        await queueSmsBatch(messages);
                        alert({ title: 'Success', message: `Successfully queued ${messages.length} alerts.`, variant: 'success' });
                      } else {
                        alert({ title: 'No Numbers', message: "No valid parent phone numbers found.", variant: 'warning' });
                      }
                      setAlertModal({ open: false, sending: false });
                    } catch (err) {
                      alert({ title: 'SMS Error', message: err.message, variant: 'danger' });
                      setAlertModal(prev => ({ ...prev, sending: false }));
                    }
                  }}
                >
                  {alertModal.sending ? 'Sending...' : 'Confirm & Send Alerts'}
                </button>
                <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setAlertModal({ open: false })}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showUpgrade && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 9999, background: 'rgba(255,255,255,0.95)',
          overflowY: 'auto',
          backdropFilter: 'blur(10px)'
        }}>
          <div style={{ position: 'absolute', top: 30, right: 30, zIndex: 10001 }}>
            <button className="btn btn-ghost" onClick={() => setShowUpgrade(false)} style={{ fontSize: '1.5rem' }}>&times;</button>
          </div>
          <FeatureGate featureName="Communications" />
        </div>
      )}
    </div>
  );
}
