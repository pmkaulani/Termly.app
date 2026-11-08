import { useState, useEffect } from 'react';
import { getTeachers, addTeacher, updateTeacher, deleteTeacher, getTeacherWorkload, getTeacherPerformance, setTeacherLeaveStatus, isStaffCodeAvailable } from '../data/staffStore';
import { getPrintHeader, getPrintFooter, getSchoolProfile, getPlatformSettings } from '../data/coreStore';
import Avatar from '../components/Common/Avatar';
import ImageUploadField from '../components/Common/ImageUploadField';
import TeacherImporter from '../components/TeacherImporter';
import { uploadPersonPhoto, deletePersonPhoto } from '../lib/storageHelpers';
import { getUsers } from '../data/authStore';
import { getCurrentPeriodDetails } from '../data/academicsStore';
import { getTeacherAssignments, assignTeacher, removeTeacherAssignment, getClassStreams, initializeStreams } from '../data/academicsStore';
import { sanitizeName, sanitizeString } from '../utils/sanitize';
import Loader from '../components/Common/Loader';
import { CBC_STRUCTURE, getSubjectsForGrade, getLevelForGrade } from '../data/seedData';
import { 
  TeacherIcon, RocketIcon, AlertIcon, LogoutIcon, ClockIcon, SearchIcon, DashboardIcon,
  LeafIcon, GraduationIcon, PlusIcon, EditIcon, DeleteIcon, SchoolIcon, PrintIcon, PhoneIcon, BookIcon,
  ChevronDownIcon, CheckIcon, EyeIcon, EyeOffIcon
} from '../components/CommonIcons';
import { useDialog } from '../contexts/DialogContext';
import Select from '../components/Common/Select';
import { Helmet } from 'react-helmet-async';

export default function Teachers({ currentUser, currentPeriodId }) {
  const isAdmin = currentUser?.role === 'Owner' || currentUser?.role === 'Admin';
  const [activeTab, setActiveTab] = useState('records');
  const [teachers, setTeachers] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [showModal, setShowModal] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState(null);
  const [showImporter, setShowImporter] = useState(false);
  const [search, setSearch] = useState('');
  const [profile, setProfile] = useState({ streams: [], activeClasses: [] });
  const [settings, setSettings] = useState({});
  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const { alert, confirm, toast } = useDialog();

  const loadData = async () => {
    setLoading(true);
    try {
      const period = await getCurrentPeriodDetails();
      const year = period?.year || 2026;
      const [tData, aData, pData, sData, uData, stData] = await Promise.all([
        getTeachers(),
        getTeacherAssignments(),
        getSchoolProfile(),
        getPlatformSettings(),
        getUsers(),
        getClassStreams(null, year)
      ]);
      setTeachers(tData || []);
      setAssignments(aData || []);
      setProfile(pData);
      setSettings(sData || {});
      setRegisteredUsers(uData || []);
      setStreams(stData || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const refresh = async () => {
    try {
      const period = await getCurrentPeriodDetails();
      const year = period?.year || 2026;
      const [tData, aData, stData] = await Promise.all([getTeachers(), getTeacherAssignments(), getClassStreams(null, year)]);
      setTeachers(tData || []);
      setAssignments(aData || []);
      setStreams(stData || []);
    } catch (err) { }
  };

  const handleSave = async (t) => {
    setLoading(true);
    try {
      const sanitized = { ...t };
      if (sanitized.name) sanitized.name = sanitizeName(sanitized.name);
      if (sanitized.staff_code) sanitized.staff_code = sanitizeString(sanitized.staff_code);
      if (sanitized.tsc_number) sanitized.tsc_number = sanitizeString(sanitized.tsc_number);

      const schoolId = profile?.school_id || profile?.schoolId;
      if (editingTeacher) {
        let photoPath = editingTeacher.photo_path;
        if (t._removePhoto && editingTeacher.photo_path) {
          try { await deletePersonPhoto(editingTeacher.photo_path); } catch(e) {}
          photoPath = null;
        } else if (t._photoBlob) {
          try {
            const upRes = await uploadPersonPhoto({
              schoolId,
              entityType: 'teachers',
              entityId: editingTeacher.id,
              fileOrBlob: t._photoBlob,
              oldPhotoPath: editingTeacher.photo_path
            });
            photoPath = upRes.photoPath;
          } catch (photoErr) {
            console.warn('Could not upload teacher portrait:', photoErr);
          }
        }
        sanitized.photo_path = photoPath;
        await updateTeacher(editingTeacher.id, sanitized);
        toast('Teacher profile updated', 'success');
      } else {
        const newTeacher = await addTeacher(sanitized);
        if (t._photoBlob && newTeacher?.id) {
          try {
            const upRes = await uploadPersonPhoto({
              schoolId,
              entityType: 'teachers',
              entityId: newTeacher.id,
              fileOrBlob: t._photoBlob
            });
            if (upRes.photoPath) {
              await updateTeacher(newTeacher.id, { photo_path: upRes.photoPath });
            }
          } catch (photoErr) {
            console.warn('Could not upload portrait for new teacher:', photoErr);
          }
        }
        toast('New teacher registered successfully', 'success');
      }
      await refresh(); setShowModal(false); setEditingTeacher(null);
    } catch(err) { alert({ title: 'Save Error', message: err.message, variant: 'danger' }); } finally { setLoading(false); }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({ 
      title: 'Remove Teacher', 
      message: 'Are you sure you want to remove this teacher? This will also unassign them from all classes.', 
      variant: 'danger' 
    });
    if (ok) { 
      setLoading(true);
      try { 
        await deleteTeacher(id); 
        await refresh(); 
        toast('Teacher record removed', 'info');
      } 
      catch(err){ alert({ title: 'Delete Error', message: err.message, variant: 'danger' }); } finally { setLoading(false); }
    }
  };

  const handleAssign = async (streamId, subject, teacherId, existingAssignmentId) => {
    try { 
      if (!teacherId) {
        if (existingAssignmentId) await removeTeacherAssignment(existingAssignmentId);
      } else {
        if (!streamId) throw new Error("Stream not initialized for this class. Promote classes in Settings.");
        await assignTeacher(teacherId, streamId, subject);
      }
      await refresh(); 
      toast('Class assignment updated', 'success');
    } catch(err){ alert({ title: 'Assignment Error', message: err.message, variant: 'danger' }); }
  };
  const handleLeaveToggle = async (id, status) => {
    try { await setTeacherLeaveStatus(id, status); await refresh(); } catch(err){ alert({ title: 'Leave Update Error', message: err.message, variant: 'danger' }); }
  };

  const getTeacherSubjects = (teacherId) => {
    const subs = new Set();
    if (Array.isArray(assignments)) {
      assignments.filter(a => a.teacher_id === teacherId && a.is_active).forEach(a => subs.add(a.subject));
    }
    return [...subs];
  };

  const getTeacherClasses = (teacherId) => {
    const cls = new Set();
    if (Array.isArray(assignments)) {
      assignments.filter(a => a.teacher_id === teacherId && a.is_active && a.stream).forEach(a => cls.add(`${a.stream.level} (${a.stream.name})`));
    }
    return [...cls];
  };

  const filteredTeachers = teachers.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) || t.phone.includes(search)
  ).sort((a, b) => {
    if (a.staff_code && b.staff_code) return a.staff_code.localeCompare(b.staff_code);
    if (a.staff_code) return -1;
    if (b.staff_code) return 1;
    return a.name.localeCompare(b.name);
  });
  const activeTeachers = teachers.filter(t => t.status === 'Active');

  const handlePrintStaff = async (type) => {
    try {
      const title = type === 'all' ? 'All Staff List' : 'Staff per Class Assignment';
      const header = await getPrintHeader(title);
      const printWin = window.open('', '_blank');

      printWin.document.write(`<html><head><title>${title}</title>
        <style>
          @page { margin: 0; }
          body { font-family: sans-serif; padding: 15mm; color: #333; }
          .header { text-align: center; margin-bottom: 20px; padding-bottom: 15px; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 0.85rem; }
          th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
          th { background: #f9f9f9; }
          .footer { margin-top: 30px; font-size: 0.8rem; color: #777; border-top: 1px solid #eee; padding-top: 10px; }
        </style>
      </head><body>`);

      printWin.document.write(header);
      
      let tableContent = '';

      if (type === 'all') {
        tableContent = `
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>TSC No.</th><th>Phone</th><th>Status</th></tr></thead>
            <tbody>
              ${filteredTeachers.map((t) => {
                return `<tr>
                  <td>${t.staff_code || '—'}</td>
                  <td><strong>${t.name}</strong></td>
                  <td>${t.tsc_number || '—'}</td>
                  <td>${t.phone}</td>
                  <td>${t.status}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`;
      } else if (type === 'by-class') {
        const classMap = {};
        const activeLevels = profile?.activeClasses || [];
        (assignments || []).filter(a => a.is_active && a.stream && (activeLevels.length === 0 || activeLevels.includes(a.stream.level))).forEach(a => {
          const cls = `${a.stream.level} (${a.stream.name})`;
          if (!classMap[cls]) classMap[cls] = new Set();
          const t = teachers.find(teach => teach.id === a.teacher_id);
          if (t) classMap[cls].add(`${t.name} <span style="font-size: 0.8em; color: #555;">(${a.subject})</span>`);
        });
        tableContent = `
          <table>
            <thead><tr><th>Class</th><th>Assigned Teachers (Subjects)</th></tr></thead>
            <tbody>
              ${Object.entries(classMap).map(([cls, names]) => `
                <tr>
                  <td><strong>${cls}</strong></td>
                  <td>${[...names].join(', ') || 'None'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`;
      }

      const footer = await getPrintFooter();
      printWin.document.write(`
        <div style="margin-top: 10px;">
          <p style="font-size: 0.8rem; color: #666; margin: 0;">Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}</p>
        </div>
        ${tableContent}
        <div class="footer">
          Termly — Academic Management System — ${new Date().getFullYear()}
        </div>
        ${footer}
      </body></html>`);
      printWin.document.close();
      printWin.document.title = title;
      printWin.print();
    } catch(err) { alert({ title: 'Print Error', message: "Print failed: " + err.message, variant: 'danger' }); }
  };

  const tabs = [
    { id: 'records', label: 'Teachers', icon: <TeacherIcon /> },
    { id: 'assignments', label: 'Assignments', icon: <BookIcon /> },
    { id: 'reports', label: 'Reports', icon: <DashboardIcon /> },
  ];

  return (
    <div className="animate-in">
      <Helmet>
        <title>Academic Staff Management | Termly — Faculty Records</title>
        <meta name="description" content="Manage teacher profiles, classroom assignments, and performance reports." />
      </Helmet>
      <div className="page-header">
        <div className="page-header-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h2>Teachers</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <p className="text-muted" style={{ margin: 0 }}>{activeTeachers.length} active teachers</p>
            </div>
          </div>
          {activeTab === 'records' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button 
                type="button"
                className="btn btn-secondary" 
                onClick={() => setShowImporter(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <UploadIcon size={16} /> Import Teachers
              </button>
              <button 
                type="button"
                className="btn btn-primary" 
                onClick={() => { setEditingTeacher(null); setShowModal(true); }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <PlusIcon size={16} /> Add Teacher
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs — horizontal pill strip */}
      {loading && teachers.length === 0 && <Loader />}
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:20, padding:'5px 6px', background:'var(--bg)', borderRadius:12, border:'1px solid var(--border)', width:'fit-content', opacity: loading ? 0.6 : 1, pointerEvents: loading ? 'none' : 'auto' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display:'inline-flex', alignItems:'center', gap:7,
              padding:'9px 20px', borderRadius:9, border:'none',
              fontFamily:'inherit', fontSize:'0.875rem', fontWeight: activeTab===tab.id ? 700 : 500,
              cursor:'pointer', transition:'all 0.15s', whiteSpace:'nowrap',
              background: activeTab===tab.id ? 'var(--bg-card)' : 'transparent',
              color: activeTab===tab.id ? 'var(--primary)' : 'var(--text-light)',
              boxShadow: activeTab===tab.id ? '0 1px 6px rgba(0,0,0,0.08)' : 'none',
            }}>
            <span style={{fontSize:'1rem'}}>{tab.icon}</span>
            <span>{tab.id === 'records' ? 'Teachers' : tab.id === 'assignments' ? 'Assignments' : 'Reports'}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'records' && (
        <RecordsTab
          teachers={filteredTeachers}
          search={search}
          setSearch={setSearch}
          total={teachers.length}
          getTeacherSubjects={getTeacherSubjects}
          getTeacherClasses={getTeacherClasses}
          onEdit={(t) => { setEditingTeacher(t); setShowModal(true); }}
          onDelete={handleDelete}
          onLeaveToggle={handleLeaveToggle}
          onPrint={() => handlePrintStaff('all')}
          isAdmin={isAdmin}
        />
      )}

      {activeTab === 'assignments' && (
        <AssignmentsTab 
          assignments={assignments} 
          teachers={teachers} 
          onAssign={handleAssign} 
          profile={profile} 
          streams={streams}
          confirm={confirm}
          alert={alert}
          toast={toast}
          setLoading={setLoading}
          refresh={refresh}
        />
      )}

      {activeTab === 'reports' && (
        <ReportsTab profile={profile} teachers={teachers} assignments={assignments} onPrintStaff={handlePrintStaff} />
      )}

      {showModal && (
        <TeacherModal teacher={editingTeacher} onSave={handleSave}
          onClose={() => { setShowModal(false); setEditingTeacher(null); }} isAdmin={isAdmin} />
      )}
      {showImporter && (
        <TeacherImporter profile={profile} onImport={() => refresh()} onClose={() => setShowImporter(false)} />
      )}
    </div>
  );
}

// ========== RECORDS TAB ==========
function RecordsTab({ teachers, search, setSearch, total, getTeacherSubjects, getTeacherClasses, onEdit, onDelete, onLeaveToggle, onPrint, isAdmin }) {
  return (
    <>
      <div className="filter-bar">
        <div className="search-bar">
          <span className="search-icon"><SearchIcon size={16} /></span>
          <input type="text" placeholder="Search teachers..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onPrint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PrintIcon size={16} /> Print List
        </button>
        <span className="text-muted" style={{ fontSize: '0.85rem' }}>
          {teachers.length} of {total}
        </span>
      </div>

      {/* Table Card */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <table className="data-table responsive-table">
            <thead>
              <tr><th>Code</th><th>Name</th>{isAdmin && <th>TSC No.</th>}<th>Phone</th><th>Subjects</th><th>Classes</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {teachers.length === 0 ? (
                <tr><td colSpan={isAdmin ? 7 : 6} className="text-center text-muted" style={{ padding: 40 }}>No teachers found</td></tr>
              ) : teachers.map(t => {
                const subs = getTeacherSubjects(t.id);
                const cls = getTeacherClasses(t.id);
                return (
                  <tr key={t.id}>
                    <td data-label="Code"><code style={{ color: 'var(--text-light)', fontSize: '0.75rem' }}>{t.staff_code || '—'}</code></td>
                    <td data-label="Name">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar photoPath={t.photo_path} name={t.name} size={34} />
                        <div>
                          <strong>{t.name}</strong>
                          {t.staff_code && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{t.staff_code}</div>}
                        </div>
                      </div>
                    </td>
                    {isAdmin && <td data-label="TSC No.">{t.tsc_number || '—'}</td>}
                    <td data-label="Phone">{t.phone}</td>
                    <td data-label="Subjects">
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent:'inherit' }}>
                        {subs.length > 0 ? subs.map(s => (
                          <span key={s} className="badge badge-info" style={{ fontSize: '0.68rem' }}>
                            {s.length > 12 ? s.substring(0, 10) + '..' : s}
                          </span>
                        )) : <span className="text-muted" style={{ fontSize: '0.8rem' }}>None</span>}
                      </div>
                    </td>
                    <td data-label="Classes">
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent:'inherit' }}>
                        {cls.length > 0 ? cls.map(c => (
                          <span key={c} className="badge badge-ghost" style={{ fontSize: '0.68rem' }}>{c}</span>
                        )) : <span className="text-muted" style={{ fontSize: '0.8rem' }}>None</span>}
                      </div>
                    </td>
                    <td data-label="Status">
                      <div style={{display:'flex', flexDirection:'column', gap:4}}>
                        <span className={`badge ${t.status === 'Active' ? 'badge-success' : 'badge-ghost'}`}>
                          {t.status === 'Active' ? '● Active' : '○ Left'}
                        </span>
                        {t.on_leave && <span className="badge badge-warning" style={{fontSize:'0.65rem'}}>🏖️ On Leave</span>}
                      </div>
                    </td>
                    <td data-label="Actions">
                      <div className="inline-flex" style={{justifyContent:'inherit'}}>
                        <button className="btn btn-ghost btn-sm" title={t.on_leave ? "Mark as Present" : "Mark as On Leave"} 
                          onClick={() => onLeaveToggle(t.id, !t.on_leave)}>
                          <ClockIcon size={14} color={t.on_leave ? 'var(--warning)' : 'currentColor'} />
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => onEdit(t)}><EditIcon size={14} /></button>
                        <button className="btn btn-ghost btn-sm" onClick={() => onDelete(t.id)}><DeleteIcon size={14} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </>
  );
}

// ========== ASSIGNMENTS TAB ==========
function AssignmentsTab({ assignments, teachers, onAssign, profile, streams, confirm, alert, toast, setLoading, refresh }) {
  const activeClasses = profile.activeClasses && profile.activeClasses.length > 0 
    ? profile.activeClasses 
    : Object.values(CBC_STRUCTURE).flatMap(l => l.grades).slice(0, 10); // Default to first 10 if none active
  const [selectedClass, setSelectedClass] = useState(activeClasses[0] || 'Grade 1');

  useEffect(() => {
    if (activeClasses.length > 0 && !activeClasses.includes(selectedClass)) {
      setSelectedClass(activeClasses[0]);
    }
  }, [activeClasses, selectedClass]);
  const rawSubjects = getSubjectsForGrade(selectedClass, profile);
  const subjects = Array.isArray(rawSubjects) ? rawSubjects : [];
  const level = getLevelForGrade(selectedClass);
  const activeTeachers = Array.isArray(teachers) ? teachers.filter(t => t.status === 'Active') : [];
  const rawStreams = profile.streamsPerClass?.[selectedClass];
  const classStreams = Array.isArray(rawStreams)
    ? rawStreams
    : (typeof rawStreams === 'number' ? Array.from({ length: rawStreams }, (_, i) => `Stream ${i + 1}`) : ['General']);
  const [selectedStream, setSelectedStream] = useState(classStreams[0] || 'General');

  useEffect(() => {
    const raw = profile.streamsPerClass?.[selectedClass];
    const currentStreams = Array.isArray(raw)
      ? raw
      : (typeof raw === 'number' ? Array.from({ length: raw }, (_, i) => `Stream ${i + 1}`) : ['General']);
    if (!currentStreams.includes(selectedStream)) {
      setSelectedStream(currentStreams[0] || 'General');
    }
  }, [selectedClass, profile, selectedStream]);

  const levelColors = { 
    'Early Years': '#10b981', 
    'Upper Primary': '#3b82f6', 
    'Junior Secondary': '#8b5cf6',
    'Senior Secondary': '#ec4899'
  };

  const activeStreamRecord = streams.find(s => s.level === selectedClass && s.name === selectedStream && s.is_active);
  const streamId = activeStreamRecord ? activeStreamRecord.id : null;

  return (
    <>
      {/* Class selector */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>Select Class:</strong>
            <Select 
              value={selectedClass} 
              onChange={e => setSelectedClass(e.target.value)}
              options={Object.entries(CBC_STRUCTURE).flatMap(([levelName, levelData]) => {
                const activeInLevel = levelData.grades.filter(g => profile.activeClasses?.includes(g));
                return activeInLevel.map(g => ({ id: g, label: g }));
              })}
              style={{ minWidth: 160 }}
            />
            <span className="badge" style={{ background: levelColors[level] + '20', color: levelColors[level], fontWeight: 600 }}>
              {level}
            </span>
            <strong style={{ fontSize: '0.85rem', whiteSpace: 'nowrap', marginLeft: 10 }}>Stream:</strong>
            <Select 
              value={selectedStream} 
              onChange={e => setSelectedStream(e.target.value)}
              options={classStreams.map(s => ({ id: s, label: s }))}
              style={{ minWidth: 120 }}
            />
            {!streamId && (
              <div className="badge badge-warning" style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px'}}>
                <AlertIcon size={14} />
                <span>Stream not initialized for 2026.</span>
                <button 
                  className="btn btn-xs btn-primary" 
                  style={{fontSize: '0.65rem', padding: '2px 8px', borderRadius: 4}}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Initialize Classes',
                      message: `Do you want to set up the default streams for ${selectedClass} in 2026?`,
                      variant: 'info'
                    });
                    if (ok) {
                      setLoading(true);
                      try {
                        const period = await getCurrentPeriodDetails();
                        await initializeStreams(period?.year || 2026);
                        toast('Classes initialized successfully', 'success');
                        await refresh();
                      } catch (err) {
                        alert({ title: 'Error', message: err.message, variant: 'danger' });
                      } finally {
                        setLoading(false);
                      }
                    }
                  }}
                >
                  Initialize Now
                </button>
                <span style={{fontSize: '0.7rem', opacity: 0.8}}>or</span>
                <a href="/settings" style={{fontSize: '0.7rem', fontWeight: 'bold', color: 'inherit', textDecoration: 'underline'}}>Promote from 2026</a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Assignment grid */}
      <div className="card">
        <div className="card-header">
          <h3>{selectedClass} ({selectedStream}) — Subject Assignments</h3>
          <span className="text-muted" style={{ fontSize: '0.82rem' }}>{subjects.length} subjects</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {/* Desktop table */}
          <table className="data-table hide-mobile">
            <thead>
              <tr><th>Subject</th><th>Assigned Teacher</th></tr>
            </thead>
            <tbody>
              {subjects.map(sub => {
                const assignment = Array.isArray(assignments) ? assignments.find(a => a.stream_id === streamId && a.subject === sub && a.is_active) : null;
                const teacherId = assignment ? assignment.teacher_id : '';

                return (
                  <tr key={sub}>
                    <td><strong>{sub}</strong></td>
                    <td>
                      <Select 
                        value={teacherId} 
                        onChange={e => onAssign(streamId, sub, e.target.value, assignment?.id)}
                        options={[
                          { id: '', label: '— Unassigned —' },
                          ...activeTeachers.map(t => ({ id: t.id, label: t.name }))
                        ]}
                        style={{ minWidth: 200 }}
                        disabled={!streamId}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Mobile cards */}
          <div className="show-mobile-only" style={{ display: 'none', padding: 12 }}>
            {subjects.map(sub => {
              const assignment = Array.isArray(assignments) ? assignments.find(a => a.stream_id === streamId && a.subject === sub && a.is_active) : null;
              const teacherId = assignment ? assignment.teacher_id : '';

              return (
                <div key={sub} style={{ marginBottom: 12, padding: 12, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 8 }}>{sub}</div>
                  <Select 
                    value={teacherId} 
                    onChange={e => onAssign(streamId, sub, e.target.value, assignment?.id)}
                    options={[
                      { id: '', label: '— Unassigned —' },
                      ...activeTeachers.map(t => ({ id: t.id, label: t.name }))
                    ]}
                    style={{ width: '100%' }}
                    disabled={!streamId}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// ========== REPORTS TAB ==========
function ReportsTab({ profile, teachers, assignments, onPrintStaff }) {
  const [selectedTeacher, setSelectedTeacher] = useState('all');
  const [data, setData] = useState({ workload: [], performance: {} });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchReports = async () => {
      try {
        const [wData, pData] = await Promise.all([getTeacherWorkload(), getTeacherPerformance()]);
        
        // If wData is an object (due to the store returning a single stub), compute the aggregate workload here
        let actualWorkload = wData;
        if (!Array.isArray(wData)) {
          const active = Array.isArray(teachers) ? teachers.filter(t => t.status === 'Active') : [];
          actualWorkload = active.map(t => {
            const tAss = (assignments || []).filter(a => a.teacher_id === t.id && a.is_active);
            const subs = new Set(tAss.map(a => a.subject));
            const cls = new Set(tAss.map(a => a.stream_id).filter(Boolean));
            return {
              id: t.id,
              name: t.name,
              phone: t.phone,
              status: t.status,
              subjectCount: subs.size,
              classCount: cls.size,
              subjectsList: [...subs]
            };
          });
        }
        
        setData({ workload: actualWorkload, performance: pData || {} });
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchReports();
  }, [teachers, assignments]);

  const handlePrintStaff = onPrintStaff;

  if (loading) {
    return <div className="text-center p-4 text-muted">Loading performance data...</div>;
  }

  const { workload, performance } = data;
  const activeTeachers = Array.isArray(teachers) ? teachers.filter(t => t.status === 'Active') : [];

  // Build per-teacher performance rows
  const getTeacherRows = (teacherId) => {
    const rows = [];
    Object.entries(performance).forEach(([, subs]) => {
      Object.entries(subs).forEach(([sub, classes]) => {
        Object.entries(classes).forEach(([cls, data]) => {
          if (data.teacherId === teacherId) rows.push({ sub, cls, ...data });
        });
      });
    });
    return rows;
  };

  const selectedRows = selectedTeacher !== 'all' ? getTeacherRows(selectedTeacher) : null;
  const selectedInfo = selectedTeacher !== 'all' ? workload.find(w => w.id === selectedTeacher) : null;
  const overallAvg = selectedRows && selectedRows.length > 0
    ? (selectedRows.reduce((s, r) => s + r.average, 0) / selectedRows.length).toFixed(1)
    : 0;

  // Print individual teacher report
  const printTeacherReport = async () => {
    if (!selectedInfo || !selectedRows) return;
    try {
      const headerStr = await getPrintHeader('Individual Teacher Performance Report — Term 1, 2026');
      const profileStr = await getSchoolProfile();
      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>Performance Report - ${selectedInfo.name}</title>
    <style>@page{margin:0}body{font-family:Arial,sans-serif;padding:15mm;color:#1e293b;max-width:700px;margin:0 auto}
    h1{color:#1e3a5f;font-size:20px;margin:0 0 4px}h2{color:#64748b;font-weight:400;margin:0 0 6px;font-size:13px}
    h3{color:#1e3a5f;font-size:15px;margin:20px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:4px}
    .info{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:12px 0 20px;font-size:12px;padding:12px;background:#f8fafc;border-radius:8px}
    .info strong{color:#64748b}
    .summary{display:flex;gap:30px;margin:16px 0;padding:14px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0}
    .summary .item{text-align:center}.summary .val{font-size:1.5rem;font-weight:700;color:#1e3a5f}.summary .label{font-size:10px;color:#64748b}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left;font-size:12px}
    th{background:#1e3a5f;color:white}
    .good{color:#10b981;font-weight:700}.avg{color:#f59e0b;font-weight:700}.low{color:#ef4444;font-weight:700}
    .footer{margin-top:30px;font-size:11px;color:#64748b}
    .sigs{display:flex;justify-content:space-between;margin-top:40px;font-size:11px}.sigs div{text-align:center}.sigs .ln{width:130px;border-top:1px solid #1e293b;margin:0 auto 5px}
    </style></head><body>
    ${headerStr}
    <div class="info">
      <div><strong>Teacher:</strong> ${selectedInfo.name}</div>
      <div><strong>Phone:</strong> ${selectedInfo.phone}</div>
      <div><strong>Status:</strong> ${selectedInfo.status}</div>
      <div><strong>Date:</strong> ${new Date().toLocaleDateString()}</div>
    </div>
    <div class="summary">
      <div class="item"><div class="val">${selectedInfo.subjectCount}</div><div class="label">Subjects</div></div>
      <div class="item"><div class="val">${selectedInfo.classCount}</div><div class="label">Classes</div></div>
      <div class="item"><div class="val">${overallAvg}%</div><div class="label">Overall Average</div></div>
    </div>
    <h3>Performance Breakdown</h3>
    <table><thead><tr><th>Subject</th><th>Class</th><th>Class Average</th><th>Pass Rate (≥70)</th><th>Students</th></tr></thead>
    <tbody>${selectedRows.map(r => {
      const cls = r.average >= 70 ? 'good' : r.average >= 55 ? 'avg' : 'low';
      return `<tr><td><strong>${r.sub}</strong></td><td>${r.cls}</td><td class="${cls}">${r.average}%</td><td>${r.passRate}%</td><td>${r.totalStudents}</td></tr>`;
    }).join('')}</tbody></table>
    <div style="margin:20px 0;font-size:12px"><strong>Principal's Comments:</strong> _______________________________________________</div>
    <div style="margin:10px 0;font-size:12px"><strong>Recommendations:</strong> _______________________________________________</div>
    <div class="sigs"><div><div class="ln"></div>Principal</div><div><div class="ln"></div>Teacher</div></div>
    <div class="footer">${profileStr.schoolName || ''} | Teacher Performance Report | Printed ${new Date().toLocaleDateString()}</div>
    </body></html>`);
    w.document.close(); 
    w.document.title = `Performance_Report_${selectedInfo.name.replace(/\s+/g, '_')}`;
    w.print();
    } catch(err) { 
      await alert({ 
        title: 'Print Failed', 
        message: err.message || 'Could not generate teacher report.', 
        variant: 'danger' 
      }); 
    }
  };

  // Print all teachers summary
  const printAllReport = async () => {
    try {
      const headerStr = await getPrintHeader('Teacher Performance & Workload Report — Term 1, 2026');
      const profileStr = await getSchoolProfile();
      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>All Teachers Report</title>
    <style>@page{margin:0}body{font-family:Arial,sans-serif;padding:15mm;color:#1e293b;max-width:900px;margin:0 auto}
    h1{color:#1e3a5f;font-size:20px;margin:0 0 4px}h2{color:#64748b;font-weight:400;margin:0 0 16px;font-size:13px}
    h3{color:#1e3a5f;font-size:15px;margin:24px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-bottom:20px}th,td{border:1px solid #e2e8f0;padding:7px 10px;text-align:left;font-size:11px}
    th{background:#1e3a5f;color:white}.footer{margin-top:30px;font-size:11px;color:#64748b}
    .good{color:#10b981;font-weight:700}.avg{color:#f59e0b;font-weight:700}.low{color:#ef4444;font-weight:700}
    </style></head><body>
    ${headerStr}
    <h3><TeacherIcon size={18} /> Teacher Workload</h3>
    <table><thead><tr><th>Teacher</th><th>Phone</th><th>Status</th><th>Subjects</th><th>Classes</th></tr></thead>
    <tbody>${workload.map(w => `<tr><td><strong>${w.name}</strong></td><td>${w.phone}</td><td>${w.status}</td><td>${w.subjectCount}</td><td>${w.classCount}</td></tr>`).join('')}</tbody></table>
    <h3><DashboardIcon size={18} /> Subject Performance by Teacher</h3>
    <table><thead><tr><th>Teacher</th><th>Subject</th><th>Class</th><th>Class Avg</th><th>Pass Rate</th></tr></thead>
    <tbody>${Object.entries(performance).flatMap(([, subs]) =>
      Object.entries(subs).flatMap(([sub, classes]) =>
        Object.entries(classes).map(([cls, data]) => {
          const cls2 = data.average >= 70 ? 'good' : data.average >= 55 ? 'avg' : 'low';
          return `<tr><td>${data.teacherName}</td><td>${sub}</td><td>${cls}</td><td class="${cls2}">${data.average}%</td><td>${data.passRate}%</td></tr>`;
        })
      )
    ).join('')}</tbody></table>
    <div class="footer">Printed on ${new Date().toLocaleDateString()} | ${profileStr.schoolName || ''}</div></body></html>`);
    w.document.close(); 
    w.document.title = 'Teacher_Performance_and_Workload_Report';
    w.print();
    } catch(err) { 
      await alert({ 
        title: 'Print Failed', 
        message: err.message || 'Could not generate staff summary.', 
        variant: 'danger' 
      }); 
    }
  };

  return (
    <>
      {/* Teacher selector + print buttons */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>Select Teacher:</strong>
            <Select 
              value={selectedTeacher} 
              onChange={e => setSelectedTeacher(e.target.value)}
              options={[
                { id: 'all', label: 'Global Summary' },
                ...activeTeachers.map(t => ({ id: t.id, label: t.name }))
              ]}
              style={{ maxWidth: 220 }}
            />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div className="btn-group">
                <button className="btn btn-ghost btn-sm" onClick={() => handlePrintStaff('all')}><BookIcon size={14} /> All List</button>
                <button className="btn btn-ghost btn-sm" onClick={() => handlePrintStaff('by-class')}><SchoolIcon size={14} /> By Class</button>
              </div>
              {selectedTeacher !== 'all' && (
                <button className="btn btn-primary btn-sm" onClick={printTeacherReport}>
                  <PrintIcon size={14} /> Print {selectedInfo?.name?.split(' ')[0]}'s Report
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={printAllReport}><PrintIcon size={14} /> Print Global Summary</button>
            </div>
          </div>
        </div>
      </div>

      {/* Individual Teacher View */}
      {selectedTeacher !== 'all' && selectedInfo && (
        <>
          {/* Summary KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--primary)' }}>{selectedInfo.subjectCount}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Subjects</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--accent)' }}>{selectedInfo.classCount}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Classes</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: Number(overallAvg) >= 70 ? '#10b981' : Number(overallAvg) >= 55 ? '#f59e0b' : '#ef4444' }}>{overallAvg}%</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Overall Average</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--text)' }}>{selectedRows.length}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Assignments</div>
            </div>
          </div>

          {/* Performance table for selected teacher */}
          <div className="card">
            <div className="card-header">
              <h3><DashboardIcon size={20} /> {selectedInfo.name} — Performance Breakdown</h3>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="data-table hide-mobile">
                <thead><tr><th>Subject</th><th>Class</th><th>Class Average</th><th>Pass Rate (≥70)</th><th>Students</th></tr></thead>
                <tbody>
                  {selectedRows.map(r => (
                    <tr key={`${r.cls}-${r.sub}`}>
                      <td><strong>{r.sub}</strong></td>
                      <td><span className="badge badge-ghost">{r.cls}</span></td>
                      <td>
                        <span style={{ fontWeight: 700, color: r.average >= 70 ? '#10b981' : r.average >= 55 ? '#f59e0b' : '#ef4444' }}>
                          {r.average}%
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, color: r.passRate >= 70 ? '#10b981' : r.passRate >= 50 ? '#f59e0b' : '#ef4444' }}>
                          {r.passRate}%
                        </span>
                      </td>
                      <td className="text-muted">{r.totalStudents}</td>
                    </tr>
                  ))}
                  {selectedRows.length > 1 && (
                    <tr style={{ fontWeight: 700, background: '#f8fafc' }}>
                      <td>Overall</td><td></td>
                      <td style={{ color: Number(overallAvg) >= 70 ? '#10b981' : Number(overallAvg) >= 55 ? '#f59e0b' : '#ef4444' }}>{overallAvg}%</td>
                      <td></td><td></td>
                    </tr>
                  )}
                </tbody>
              </table>
              {/* Mobile */}
              <div className="show-mobile-only" style={{ display: 'none', padding: 12 }}>
                {selectedRows.map(r => (
                  <div key={`${r.cls}-${r.sub}`} style={{ marginBottom: 10, padding: 12, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: '0.85rem' }}>{r.sub}</strong>
                      <span className="badge badge-ghost" style={{ fontSize: '0.68rem' }}>{r.cls}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, color: r.average >= 70 ? '#10b981' : r.average >= 55 ? '#f59e0b' : '#ef4444', fontSize: '1.1rem' }}>{r.average}%</span>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Avg</div>
                      </div>
                      <div>
                        <span style={{ fontWeight: 700, color: r.passRate >= 70 ? '#10b981' : '#f59e0b', fontSize: '1.1rem' }}>{r.passRate}%</span>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Pass Rate</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* All Teachers Summary View */}
      {selectedTeacher === 'all' && (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><h3><TeacherIcon size={20} /> Teacher Workload</h3></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="data-table hide-mobile">
                <thead><tr><th>Teacher</th><th>Phone</th><th>Status</th><th>Subjects</th><th>Classes</th><th>Details</th></tr></thead>
                <tbody>
                  {workload.map(w => (
                    <tr key={w.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedTeacher(w.id)}>
                      <td><strong style={{ color: 'var(--primary)' }}>{w.name}</strong></td>
                      <td>{w.phone}</td>
                      <td><span className={`badge ${w.status === 'Active' ? 'badge-success' : 'badge-ghost'}`}>{w.status}</span></td>
                      <td style={{ fontWeight: 700, fontSize: '1.1rem' }}>{w.subjectCount}</td>
                      <td style={{ fontWeight: 700, fontSize: '1.1rem' }}>{w.classCount}</td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {w.subjectsList.map(s => <span key={s} className="badge badge-info" style={{ fontSize: '0.65rem' }}>{s.length > 10 ? s.substring(0, 8) + '..' : s}</span>)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="show-mobile-only" style={{ display: 'none', padding: 12 }}>
                {workload.map(w => (
                  <div key={w.id} style={{ marginBottom: 12, padding: 14, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border-light)', cursor: 'pointer' }}
                    onClick={() => setSelectedTeacher(w.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ color: 'var(--primary)' }}>{w.name}</strong>
                      <span className={`badge ${w.status === 'Active' ? 'badge-success' : 'badge-ghost'}`} style={{ fontSize: '0.7rem' }}>{w.status}</span>
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.82rem' }}><PhoneIcon size={12} /> {w.phone}</div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--primary)' }}>{w.subjectCount}</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Subjects</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent)' }}>{w.classCount}</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Classes</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><h3><DashboardIcon size={20} /> All Teachers — Subject Performance</h3></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="data-table hide-mobile">
                <thead><tr><th>Teacher</th><th>Subject</th><th>Class</th><th>Class Avg</th><th>Pass Rate (≥70)</th><th>Students</th></tr></thead>
                <tbody>
                  {Object.entries(performance).flatMap(([, subs]) =>
                    Object.entries(subs).flatMap(([sub, classes]) =>
                      Object.entries(classes).map(([cls, data]) => (
                        <tr key={`${cls}-${sub}`} style={{ cursor: 'pointer' }} onClick={() => setSelectedTeacher(data.teacherId)}>
                          <td><strong style={{ color: 'var(--primary)' }}>{data.teacherName}</strong></td>
                          <td>{sub}</td>
                          <td><span className="badge badge-ghost">{cls}</span></td>
                          <td><span style={{ fontWeight: 700, color: data.average >= 70 ? '#10b981' : data.average >= 55 ? '#f59e0b' : '#ef4444' }}>{data.average}%</span></td>
                          <td><span style={{ fontWeight: 600, color: data.passRate >= 70 ? '#10b981' : data.passRate >= 50 ? '#f59e0b' : '#ef4444' }}>{data.passRate}%</span></td>
                          <td className="text-muted">{data.totalStudents}</td>
                        </tr>
                      ))
                    )
                  )}
                </tbody>
              </table>
              <div className="show-mobile-only" style={{ display: 'none', padding: 12 }}>
                {Object.entries(performance).flatMap(([, subs]) =>
                  Object.entries(subs).flatMap(([sub, classes]) =>
                    Object.entries(classes).map(([cls, data]) => (
                      <div key={`${cls}-${sub}`} style={{ marginBottom: 10, padding: 12, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border-light)', cursor: 'pointer' }}
                        onClick={() => setSelectedTeacher(data.teacherId)}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong style={{ fontSize: '0.85rem', color: 'var(--primary)' }}>{data.teacherName}</strong>
                          <span className="badge badge-ghost" style={{ fontSize: '0.68rem' }}>{cls}</span>
                        </div>
                        <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>
                        <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                          <div>
                            <span style={{ fontWeight: 700, color: data.average >= 70 ? '#10b981' : data.average >= 55 ? '#f59e0b' : '#ef4444', fontSize: '1.1rem' }}>{data.average}%</span>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Avg</div>
                          </div>
                          <div>
                            <span style={{ fontWeight: 700, color: data.passRate >= 70 ? '#10b981' : '#f59e0b', fontSize: '1.1rem' }}>{data.passRate}%</span>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Pass Rate</div>
                          </div>
                        </div>
                      </div>
                    ))
                  )
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ========== TEACHER MODAL ==========
function TeacherModal({ teacher, onSave, onClose, isAdmin }) {
  const [form, setForm] = useState(teacher || { name: '', phone: '', status: 'Active', staff_code: '' });
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState(null);
  const [validating, setValidating] = useState(false);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setValidating(true);
    setError(null);

    try {
      if (form.staff_code) {
        const available = await isStaffCodeAvailable(form.staff_code, teacher?.id);
        if (!available) {
          setError(`Staff Code "${form.staff_code}" is already in use by another active teacher.`);
          setValidating(false);
          return;
        }
      }
      onSave(form);
    } catch (err) {
      setError("Validation failed. Please try again.");
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>{teacher ? <><EditIcon size={18} /> Edit Teacher</> : <><PlusIcon size={18} /> Add New Teacher</>}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="badge badge-danger" style={{ marginBottom: 16, width: '100%', padding: '10px 12px' }}>{error}</div>}
            
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <ImageUploadField
                value={form.photoUrl || form.photo_path || form.photo}
                mode="portrait"
                shape="circle"
                size={88}
                placeholderInitials={form.name ? form.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase() : ''}
                helperText="Optional teacher portrait. JPG, PNG or WebP (max 5MB)."
                onChange={({ dataUrl, blob, remove }) => {
                  if (remove) {
                    setForm(f => ({ ...f, photo: null, photo_path: null, photoUrl: null, _photoBlob: null, _removePhoto: true }));
                  } else {
                    setForm(f => ({ ...f, photo: dataUrl, photoUrl: dataUrl, _photoBlob: blob, _removePhoto: false }));
                  }
                }}
              />
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label>Staff Code / Index</label>
                <input className="form-input" name="staff_code" value={form.staff_code || ''} onChange={handleChange} placeholder="e.g. T-001" />
              </div>
              <div className="form-group" style={{ flex: 2 }}>
                <label>Full Name *</label>
                <input className="form-input" name="name" value={form.name} onChange={handleChange} required placeholder="e.g. John Mwangi" />
              </div>
            </div>
            {isAdmin && (
              <div className="form-group">
                <label>TSC Number</label>
                <input className="form-input" name="tsc_number" value={form.tsc_number || ''} onChange={handleChange} placeholder="e.g. 123456" />
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label>Phone Number *</label>
                <input className="form-input" name="phone" value={form.phone} onChange={handleChange} required placeholder="e.g. 0722100200" />
              </div>
              <div className="form-group">
                <label>Status</label>
                <div style={{display:'flex', gap:10}}>
                  <Select 
                    name="status" 
                    value={form.status} 
                    onChange={handleChange}
                    options={[
                      { id: 'Active', label: 'Active' },
                      { id: 'Left', label: 'Left' }
                    ]}
                    style={{ flex: 1 }}
                  />
                  {form.status === 'Active' && (
                    <label style={{display:'flex', alignItems:'center', gap:6, padding:'0 10px', background:'var(--bg)', borderRadius:8, border:'1px solid var(--border)', cursor:'pointer', fontSize:'0.82rem'}}>
                      <input type="checkbox" checked={form.on_leave || false} 
                        onChange={e => setForm({...form, on_leave: e.target.checked})} 
                        style={{width:16, height:16, accentColor:'var(--warning)'}} />
                      <span>On Leave</span>
                    </label>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={validating}>
              {validating ? 'Validating...' : teacher ? 'Save Changes' : 'Add Teacher'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
