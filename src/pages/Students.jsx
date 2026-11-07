import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { getStudents, addStudent, updateStudent, archiveStudent, transferStudents } from '../data/studentStore';
import { getFees } from '../data/financeStore';
import { getClassList, getCBC, getCoreCompetencies } from '../data/academicsStore';
import { getPrintHeader, getSchoolProfile } from '../data/coreStore';
import { TERM_FEE } from '../data/seedData';
import { sanitizeName, sanitizeString } from '../utils/sanitize';
import { exportNEMIS, downloadCSV, nemisFilename } from '../utils/nemisExport';
import Loader from '../components/Common/Loader';
import { CBC_STRUCTURE, CBC_CORE_COMPETENCIES, getLevelForGrade } from '../data/seedData';
import {
  LeafIcon, BookIcon, GraduationIcon, RocketIcon, CalendarIcon,
  PrintIcon, RefreshIcon, SearchIcon, StudentIcon, EditIcon, 
  DeleteIcon, PlusIcon, FlagIcon, UploadIcon, AlertIcon
} from '../components/CommonIcons';
import { useDialog } from '../contexts/DialogContext';
import Select from '../components/Common/Select';
import SkeletonTable from '../components/Common/SkeletonTable';
import StudentImporter from '../components/StudentImporter';
import { Helmet } from 'react-helmet-async';

function getCurrentTermLabel() {
  const now = new Date();
  const m = now.getMonth();
  const y = now.getFullYear();
  let term, range;
  if (m <= 3)      { term = 1; range = 'Jan – Apr'; }
  else if (m <= 7) { term = 2; range = 'May – Aug'; }
  else             { term = 3; range = 'Sep – Dec'; }
  return `Term ${term}, ${y}  ·  ${range}`;
}

export default function Students({ currentUser, currentPeriodId }) {
  const [students, setStudents]       = useState([]);
  const [search, setSearch]           = useState('');
  const [classFilter, setClassFilter] = useState('All');
  const [streamFilter, setStreamFilter] = useState('All');
  const [genderFilter, setGenderFilter] = useState('All');
  const [feeFilter, setFeeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('Active');
  const [showModal, setShowModal]     = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingStudent, setEditingStudent]   = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [fees, setFees]     = useState({});
  const [profile, setProfile] = useState({ activeClasses: [], streamsPerClass: {}, gradeFees: {} });
  const [loading, setLoading] = useState(true);
  const [showTransitionModal, setShowTransitionModal] = useState(false);
  const [statusMenuId, setStatusMenuId] = useState(null);
  const [statusMenuPos, setStatusMenuPos] = useState({x:0,y:0});
  const { confirm, prompt, alert, toast } = useDialog();

  const loadData = async () => {
    setLoading(true);
    try {
      const [sData, fData, pData] = await Promise.all([getStudents(), getFees(), getSchoolProfile()]);
      setStudents(sData || []); setFees(fData || {}); setProfile(pData || {});
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };
  const location = useLocation();

  useEffect(() => { loadData(); }, []);

  // Auto-open edit modal when navigating from NEMIS Audit "Fix" button
  useEffect(() => {
    if (location.state?.editStudentId && students.length > 0) {
      const targetStudent = students.find(s => s.id === location.state.editStudentId);
      if (targetStudent) {
        setEditingStudent(targetStudent);
        setShowModal(true);
        // Clear state so it doesn't re-trigger on re-render
        window.history.replaceState({}, document.title);
      }
    }
  }, [location.state, students]);
  const refresh = async () => {
    try { const [s, f] = await Promise.all([getStudents(), getFees()]); setStudents(s || []); setFees(f || {}); }
    catch (err) { console.error(err); }
  };

  const isAdmin   = currentUser?.role?.toLowerCase() === 'admin';
  const isTeacher = currentUser?.role?.toLowerCase() === 'teacher';
  const isFinance = currentUser?.role?.toLowerCase() === 'finance';
  const isLibrarian = currentUser?.role?.toLowerCase() === 'librarian';

  const filtered = students.filter(s => {
    const q = search.toLowerCase();
    const currentStatus = (s.status || 'Active').toLowerCase();
    const matchStatus = statusFilter === 'All' || currentStatus === statusFilter.toLowerCase();
    const matchSearch = (!q || (s.name||'').toLowerCase().includes(q) || (s.admNo||'').toLowerCase().includes(q) || (s.parentPhone||'').includes(q));
    const matchClass = (classFilter === 'All' || s.class === classFilter);
    const matchStream = (streamFilter === 'All' || s.stream === streamFilter);
    const matchGender = (genderFilter === 'All' || s.gender === genderFilter);
    
    let matchFee = true;
    if (feeFilter !== 'All') {
      const fd = fees[s.id] || {};
      const cv = profile.gradeFees?.[s.class];
      const cf = typeof cv === 'object' ? (Number(cv[(s.residenceType || 'day').toLowerCase()]) || Number(cv.day) || TERM_FEE) : (Number(cv) || TERM_FEE);
      const b = fd.balance !== undefined ? fd.balance : cf;
      if (feeFilter === 'Cleared') matchFee = b <= 0;
      if (feeFilter === 'Owing') matchFee = b > 0;
    }
    
    return matchStatus && matchSearch && matchClass && matchStream && matchGender && matchFee;
  });

  const handleSave = async (st) => {
    setLoading(true);
    try {
      // ** Sanitize Inputs before submitting **
      const sanitizedData = { ...st };
      if (sanitizedData.name) sanitizedData.name = sanitizeName(sanitizedData.name);
      if (sanitizedData.parent) sanitizedData.parent = sanitizeName(sanitizedData.parent);
      if (sanitizedData.admNo) sanitizedData.admNo = sanitizeString(sanitizedData.admNo);
      if (sanitizedData.notes) sanitizedData.notes = sanitizeString(sanitizedData.notes, 500);

      if (editingStudent) {
        await updateStudent(editingStudent.id, sanitizedData);
        toast('Student record updated successfully', 'success');
      } else {
        await addStudent(sanitizedData);
        toast('New student registered successfully', 'success');
      }
      await refresh(); setShowModal(false); setEditingStudent(null);
    } catch (err) {
      console.error('Student save failed:', err);
      await alert({ title: 'Save Failed', message: err.message || 'Could not save student record. Please try again.', variant: 'danger' });
    } finally { setLoading(false); }
  };
  const handleQuickStatus = async (id, newStatus) => {
    setStatusMenuId(null);
    setLoading(true);
    try {
      await archiveStudent(id, newStatus, '');
      await refresh();
      toast(`Student status changed to ${newStatus}`, 'success');
    } catch (err) {
      console.error(err);
    } finally { setLoading(false); }
  };
  const handleTransfer = async (ids, dir) => {
    setLoading(true);
    try { await transferStudents(ids, dir); await refresh(); setShowTransitionModal(false); }
    catch (err) { console.error(err); } finally { setLoading(false); }
  };
  const printClassList = async () => {
    try {
      const cls = classFilter === 'All' ? 'All Classes' : classFilter;
      const h = await getPrintHeader(`${cls} — Student List (${filtered.length})`);
      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>Class List</title><style>@page{margin:0}body{font-family:Arial;padding:15mm}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #e2e8f0;padding:8px 12px;font-size:13px;text-align:left}th{background:#0EA5E9;color:#fff}</style></head><body>${h}<table><thead><tr><th>#</th><th>Adm No</th><th>Name</th><th>Class</th><th>Gender</th><th>Parent</th><th>Phone</th></tr></thead><tbody>${filtered.map((s,i)=>`<tr><td>${i+1}</td><td>${s.admNo}</td><td>${s.name}</td><td>${s.class}</td><td>${s.gender}</td><td>${s.parent}</td><td>${s.parentPhone}</td></tr>`).join('')}</tbody></table></body></html>`);
      w.document.close(); w.print();
    } catch (err) { 
      await alert({ 
        title: 'Print Failed', 
        message: err.message || 'Could not generate print view.', 
        variant: 'danger' 
      }); 
    }
  };

  const fmtKSh = (n) => `KSh ${Number(n||0).toLocaleString()}`;
  const getLb = (grade) => {
    const lv = getLevelForGrade(grade);
    if (lv === 'Early Years')      return { cls:'early-years',     ico:<LeafIcon size={14} /> };
    if (lv === 'Upper Primary')    return { cls:'upper-primary',   ico:<BookIcon size={14} /> };
    if (lv === 'Junior Secondary') return { cls:'junior-secondary',ico:<GraduationIcon size={14} /> };
    return                                { cls:'senior-secondary',ico:<RocketIcon size={14} /> };
  };
  const initials = (n='') => n.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const pal = ['#0EA5E9','#8B5CF6','#10B981','#F59E0B','#EF4444','#F97316'];
  const avBg  = (n='') => pal[n.charCodeAt(0) % pal.length];

  return (
    <div className="animate-in">
      <Helmet>
        <title>Learner Records | Termly — Student Management</title>
        <meta name="description" content="Manage student profiles, class transfers, and fee balances." />
      </Helmet>
      {/* Header */}
      <div className="page-header">
        <div className="page-header-actions">
          <div>
            <h2>Students</h2>
            <div style={{display:'flex',alignItems:'center',gap:10,marginTop:4}}>
              <span style={{fontSize:'0.875rem',color:'var(--text-light)'}}>
                {students.length} students enrolled
              </span>
              <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'3px 11px',borderRadius:20,background:'var(--primary-light)',color:'var(--primary)',fontSize:'0.75rem',fontWeight:600}}>
                <CalendarIcon size={12} /> {getCurrentTermLabel()}
              </span>
            </div>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <button className="btn btn-ghost btn-sm" onClick={printClassList}><PrintIcon size={14} /> Print List</button>
            {isAdmin && <button className="btn btn-ghost btn-sm" onClick={()=>setShowTransitionModal(true)}><RefreshIcon size={14} /> Transitions</button>}
            {isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => {
              const csv = exportNEMIS(filtered, { includeIncomplete: true });
              downloadCSV(csv, nemisFilename(profile?.schoolName || 'School', 'Students'));
            }}><UploadIcon size={14} /> Export NEMIS</button>}
            {isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => setShowImportModal(true)}><UploadIcon size={14} /> Import CSV</button>}
            {isAdmin && <button className="btn btn-primary btn-sm" onClick={()=>{setEditingStudent(null);setShowModal(true);}}><PlusIcon size={14} /> Add Student</button>}
          </div>
        </div>
      </div>

      {/* Table card */}
      <div className="card">
        <div className="card-header" style={{flexDirection:'column',gap:12,alignItems:'stretch'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <h3 style={{margin:0}}>All Students</h3>
              <span style={{background:'var(--primary)',color:'#fff',fontSize:'0.65rem',fontWeight:700,padding:'2px 8px',borderRadius:12}}>{filtered.length}</span>
            </div>
            <div className="search-bar" style={{maxWidth:260}}>
              <span className="search-icon"><SearchIcon size={16} /></span>
              <input type="text" placeholder="Search by name, adm no, phone..." value={search} onChange={e=>setSearch(e.target.value)}/>
            </div>
          </div>
          <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center',paddingTop:4,borderTop:'1px solid var(--border-light)'}}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status</span>
              <Select 
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                options={[
                  { id: 'Active', label: 'Active' },
                  { id: 'Transferred', label: 'Transferred' },
                  { id: 'Graduated', label: 'Graduated' },
                  { id: 'All', label: 'All Records' }
                ]}
                style={{ minWidth: 120 }}
              />
            </div>
            <div style={{width:1,height:20,background:'var(--border)',flexShrink:0}}/>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Class</span>
              <Select 
                value={classFilter}
                onChange={e => { setClassFilter(e.target.value); setStreamFilter('All'); }}
                options={[
                  { id: 'All', label: 'All Classes' },
                  ...Object.entries(CBC_STRUCTURE).flatMap(([ln, ld]) => {
                    const isMatch = (g1, g2) => g1?.toLowerCase().trim() === g2?.toLowerCase().trim();
                    const active = ld.grades.filter(g => 
                      (profile.activeClasses || []).some(ac => isMatch(ac, g))
                    );
                    return active.map(g => ({ id: g, label: g }));
                  })
                ]}
                style={{ minWidth: 140 }}
              />
            </div>
            <div style={{width:1,height:20,background:'var(--border)',flexShrink:0}}/>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Stream</span>
              <Select 
                value={streamFilter} 
                onChange={e => setStreamFilter(e.target.value)}
                options={[
                  { id: 'All', label: 'All Streams' },
                  ...(classFilter !== 'All' 
                    ? (profile.streamsPerClass?.[classFilter] || []) 
                    : Array.from(new Set(
                        Object.entries(profile.streamsPerClass || {})
                          .filter(([cls]) => (profile.activeClasses || []).includes(cls))
                          .flatMap(([, streams]) => streams)
                      ))
                  ).map(s => ({ id: s, label: s }))
                ]}
                style={{ minWidth: 130 }}
              />
            </div>
            <div style={{width:1,height:20,background:'var(--border)',flexShrink:0}}/>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Gender</span>
              <Select 
                value={genderFilter} 
                onChange={e => setGenderFilter(e.target.value)}
                options={[
                  { id: 'All', label: 'All' },
                  { id: 'Male', label: 'Male' },
                  { id: 'Female', label: 'Female' }
                ]}
                style={{ minWidth: 100 }}
              />
            </div>
            <div style={{width:1,height:20,background:'var(--border)',flexShrink:0}}/>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Fees</span>
              <Select 
                value={feeFilter} 
                onChange={e => setFeeFilter(e.target.value)}
                options={[
                  { id: 'All', label: 'Any Status' },
                  { id: 'Cleared', label: 'Cleared' },
                  { id: 'Owing', label: 'With Balance' }
                ]}
                style={{ minWidth: 130 }}
              />
            </div>
          </div>
        </div>
        <div style={{opacity:loading && students.length > 0 ? 0.6 : 1, overflowX: 'auto', width: '100%', WebkitOverflowScrolling: 'touch'}}>
          {loading && students.length === 0 ? (
            <SkeletonTable rows={10} columns={7} />
          ) : (
          <table className="data-table responsive-table" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th>Adm No</th><th>Full Name</th><th>Class</th>
                <th>Enrolment</th>
                <th>Stream</th>
                <th>Category</th><th>Parent</th><th>Phone</th>
                { (isAdmin || isFinance) && <th>Fee Balance</th> }
                {isAdmin&&<th style={{textAlign:'center'}}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length===0?(
                <tr><td colSpan={10 + (isAdmin || isFinance ? 1 : 0) + (isAdmin ? 1 : 0)} style={{padding:'48px',textAlign:'center',color:'var(--text-muted)'}}>
                  <div style={{fontSize:'2rem',marginBottom:8}}><StudentIcon size={48} /></div>
                  <p>No students found with the current filters.</p>
                  {statusFilter !== 'All' && (
                    <button className="btn btn-ghost btn-sm" style={{marginTop:10}} onClick={() => setStatusFilter('All')}>
                      View All Statuses (including Transferred/Graduated)
                    </button>
                  )}
                </td></tr>
              ):filtered.map(s=>{
                const fd=fees[s.id]||{};
                const lb=getLb(s.class);
                return(
                  <tr key={s.id}>
                    <td data-label="Adm No"><code style={{fontSize:'0.78rem',color:'var(--text-light)'}}>{s.admNo}</code></td>
                    <td data-label="Full Name">
                      <div style={{display:'flex',alignItems:'center',gap:10,justifyContent:'inherit'}}>
                        <div style={{textAlign:'left'}}>
                          <div style={{fontWeight:600,color:'var(--primary)',cursor:'pointer'}} onClick={()=>setSelectedStudent(s)}>{s.name}</div>
                          <div style={{fontSize:'0.7rem',color:'var(--text-muted)'}}>{s.gender}</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Class"><span className="badge badge-info">{s.class}</span></td>
                    <td data-label="Enrolment" style={{position:'relative'}}>
                      <span 
                        onClick={isAdmin ? (e) => { 
                          e.stopPropagation(); 
                          const r = e.currentTarget.getBoundingClientRect();
                          const menuHeight = 180; // Estimated height of the menu
                          const spaceBelow = window.innerHeight - r.bottom;
                          const showUp = spaceBelow < menuHeight;
                          setStatusMenuPos({
                            x: r.left,
                            y: showUp ? r.top - menuHeight - 4 : r.bottom + 4
                          }); 
                          setStatusMenuId(statusMenuId === s.id ? null : s.id); 
                        } : undefined}
                        style={{ 
                          fontSize: '0.65rem', padding: '2px 8px', borderRadius: 6, fontWeight: 700, textTransform: 'uppercase',
                          backgroundColor: (s.status||'Active') === 'Active' ? '#ecfdf5' : s.status === 'Graduated' ? '#eff6ff' : '#f3f4f6',
                          color: (s.status||'Active') === 'Active' ? '#059669' : s.status === 'Graduated' ? '#1d4ed8' : '#4b5563',
                          border: `1px solid ${(s.status||'Active') === 'Active' ? '#10b98144' : s.status === 'Graduated' ? '#3b82f644' : '#d1d5db'}`,
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          cursor: isAdmin ? 'pointer' : 'default'
                        }}
                        title={isAdmin ? 'Click to change status' : ''}
                      >
                        {(s.status||'Active') === 'Active' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }}></span>}
                        {s.status || 'Active'}
                        {isAdmin && <span style={{fontSize:'0.5rem',marginLeft:2}}>▼</span>}
                      </span>
                      {statusMenuId === s.id && (
                        <>
                          <div style={{position:'fixed',inset:0,zIndex:9999}} onClick={()=>setStatusMenuId(null)}/>
                          <div style={{position:'fixed',top:statusMenuPos.y,left:statusMenuPos.x,zIndex:10000,background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:10,boxShadow:'0 8px 32px rgba(0,0,0,0.18)',minWidth:180,overflow:'hidden',backdropFilter:'blur(12px)'}}>
                            <div style={{padding:'8px 12px',fontSize:'0.65rem',color:'var(--text-light)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',borderBottom:'1px solid var(--border)'}}>Change Status</div>
                            {[{v:'Active',c:'#059669',bg:'#ecfdf5',icon:'●',desc:'Student is currently enrolled'},{v:'Transferred',c:'#6b7280',bg:'#f3f4f6',icon:'→',desc:'Moved to another school'},{v:'Graduated',c:'#2563eb',bg:'#eff6ff',icon:'🎓',desc:'Completed education'}]
                              .filter(o=>o.v!==(s.status||'Active'))
                              .map(o=>(
                                <div key={o.v} onClick={()=>handleQuickStatus(s.id,o.v)} style={{padding:'10px 14px',cursor:'pointer',display:'flex',alignItems:'center',gap:10,transition:'all 0.15s',borderBottom:'1px solid var(--border-light)'}}
                                  onMouseEnter={e=>{e.currentTarget.style.background=o.bg; e.currentTarget.style.transform='translateX(2px)'}}
                                  onMouseLeave={e=>{e.currentTarget.style.background='transparent'; e.currentTarget.style.transform='translateX(0)'}}
                                >
                                  <span style={{width:10,height:10,borderRadius:'50%',background:o.c,flexShrink:0,boxShadow:`0 0 6px ${o.c}44`}}></span>
                                  <div>
                                    <div style={{fontSize:'0.82rem',fontWeight:600,color:o.c}}>{o.v}</div>
                                    <div style={{fontSize:'0.65rem',color:'var(--text-light)',marginTop:1}}>{o.desc}</div>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                    </td>
                    <td data-label="Stream">
                      {(() => {
                        const isUnconfigured = s.stream && !(profile.streamsPerClass?.[s.class] || []).includes(s.stream);
                        return (
                          <span style={isUnconfigured ? { color: 'var(--warning)', borderBottom: '1px dotted var(--warning)', cursor: 'help' } : {}} title={isUnconfigured ? 'This stream is not in your school settings. Edit student to fix.' : ''}>
                            {s.stream || <span className="text-muted">—</span>}
                            {isUnconfigured && <AlertIcon size={10} style={{ marginLeft: 4 }} />}
                          </span>
                        );
                      })()}
                    </td>
                    <td data-label="Category"><span className={`badge ${s.residenceType === 'boarding' ? 'badge-accent' : 'badge-ghost'}`} style={{textTransform:'capitalize'}}>{s.residenceType === 'boarding' && s.house ? `Boarding (${s.house})` : (s.residenceType || 'day')}</span></td>
                    <td data-label="Parent">{s.parent}</td>
                    <td data-label="Phone" style={{color:'var(--text-light)',fontSize:'0.85rem'}}>{s.parentPhone}</td>
                    {(isAdmin || isFinance) && (
                      <td data-label="Fee Balance">{(()=>{const cv=profile.gradeFees?.[s.class];const cf=typeof cv==='object'?(Number(cv[(s.residenceType||'day').toLowerCase()])||Number(cv.day)||TERM_FEE):(Number(cv)||TERM_FEE);const b=fd.balance!==undefined?fd.balance:cf;return<span style={{fontWeight:700,color:b>0?'var(--danger)':'var(--success)'}}>{fmtKSh(b)}</span>;})()}</td>
                    )}
                    {isAdmin&&(
                      <td data-label="Actions" style={{textAlign:'center'}}>
                        <div style={{display:'inline-flex',gap:4}}>
                          <button className="btn btn-ghost btn-sm" onClick={()=>{setEditingStudent(s);setShowModal(true);}} title="Edit Student"><EditIcon size={14} /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {showModal&&<StudentModal student={editingStudent} profile={profile} onSave={handleSave} onClose={()=>{setShowModal(false);setEditingStudent(null);}}/>}
      {showImportModal && <StudentImporter profile={profile} onImport={async (result) => { 
        setLoading(true); 
        try {
          await refresh(); 
          setShowImportModal(false); 
        } catch (err) {
          alert({ title: 'Refresh Error', message: err.message, variant: 'danger' });
        } finally {
          setLoading(false); 
        }
      }} onClose={() => setShowImportModal(false)} />}
      {selectedStudent&&<StudentDetail student={selectedStudent} feeData={fees[selectedStudent.id]||{}} onClose={()=>setSelectedStudent(null)} onEdit={()=>{setSelectedStudent(null);setEditingStudent(selectedStudent);setShowModal(true);}} currentUser={currentUser} profile={profile}/>}
      {showTransitionModal&&<TransitionModal students={students} profile={profile} onTransfer={handleTransfer} onClose={()=>setShowTransitionModal(false)} confirm={confirm}/>}
    </div>
  );
}

function StudentModal({ student, profile, onSave, onClose }) {
  const ic=profile.activeClasses?.[0]||'Grade 1';
  const [form,setForm]=useState(student||{
    name:'',admNo:'',class:ic,stream:profile.streamsPerClass?.[ic]?.[0]||'',
    residenceType:'day', house:'',
    parent:'',parentPhone:'',gender:'Male',dob:'',joinDate:new Date().toISOString().split('T')[0],notes:'',
    birthCertNo:'',county:'',fatherName:'',fatherPhone:'',motherName:'',motherPhone:'',nemisVerified:false
  });
  const hc=(e)=>{const{name,value}=e.target;if(name==='class'){const s=profile.streamsPerClass?.[value]||[];setForm({...form,class:value,stream:s[0]||''});}else setForm({...form,[name]:value});};
  return(
    <div className="modal-overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><h3>{student ? <><EditIcon size={18} /> Edit Student</> : <><PlusIcon size={18} /> Add New Student</>}</h3><button className="modal-close" onClick={onClose}>×</button></div>
      <form onSubmit={e=>{e.preventDefault();onSave(form);}}>
        <div className="modal-body">
          <div className="form-group"><label>Full Name *</label><input className="form-input" name="name" value={form.name} onChange={hc} required placeholder="e.g. John Kamau"/></div>
          <div className="form-row">
            <div className="form-group"><label>Admission No</label><input className="form-input" name="admNo" value={form.admNo} onChange={hc} placeholder="Auto if blank"/></div>
            <div className="form-group">
              <label>Gender</label>
              <Select 
                name="gender" 
                value={form.gender} 
                onChange={hc}
                options={[{ id: 'Male', label: 'Male' }, { id: 'Female', label: 'Female' }]}
              />
            </div>
            <div className="form-group">
              <label>Residence Type</label>
              <Select 
                name="residenceType" 
                value={form.residenceType} 
                onChange={hc}
                options={[
                  { id: 'day', label: 'Day Student' }, 
                  { id: 'boarding', label: 'Boarding Student' }
                ]}
              />
            </div>
            {form.residenceType === 'boarding' && (
              <div className="form-group">
                <label>House</label>
                <Select 
                  name="house" 
                  value={form.house || ''} 
                  onChange={hc}
                  options={[
                    { id: '', label: 'Select House...' },
                    ...(profile.boardingHouses || []).map(h => ({ id: h, label: h }))
                  ]}
                />
              </div>
            )}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Class *</label>
              <Select 
                name="class" 
                value={form.class} 
                onChange={hc}
                options={Object.entries(CBC_STRUCTURE).flatMap(([ln, ld]) => {
                  const isMatch = (g1, g2) => g1?.toLowerCase().trim() === g2?.toLowerCase().trim();
                  const a = ld.grades.filter(g => 
                    (profile.activeClasses || []).some(ac => isMatch(ac, g))
                  );
                  if (!a.length) return [];
                  return a.map(g => ({ id: g, label: g }));
                })}
              />
            </div>
            <div className="form-group">
              <label>Stream</label>
              <Select 
                name="stream" 
                value={form.stream} 
                onChange={hc}
                options={[
                  { id: '', label: 'General' },
                  ...(profile.streamsPerClass?.[form.class] || []).map(s => ({ id: s, label: s }))
                ]}
              />
            </div>
            <div className="form-group">
              <label>Enrollment Status</label>
              <Select 
                name="status" 
                value={form.status || 'Active'} 
                onChange={hc}
                options={[
                  { id: 'Active', label: 'Active' },
                  { id: 'Transferred', label: 'Transferred' },
                  { id: 'Graduated', label: 'Graduated' }
                ]}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group"><label>Parent / Guardian *</label><input className="form-input" name="parent" value={form.parent} onChange={hc} required/></div>
            <div className="form-group"><label>Parent Phone *</label><input className="form-input" name="parentPhone" value={form.parentPhone} onChange={hc} required/></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Date of Birth</label><input className="form-input" type="date" name="dob" value={form.dob} onChange={hc}/></div>
            <div className="form-group"><label>Join Date</label><input className="form-input" type="date" name="joinDate" value={form.joinDate} onChange={hc}/></div>
          </div>
          <div className="form-group"><label>Notes</label><textarea className="form-input" name="notes" value={form.notes} onChange={hc} rows={2} style={{resize:'vertical'}}/></div>
          
          <div style={{marginTop:20,paddingTop:15,borderTop:'1px dashed var(--border)', background: '#f8fafc', padding: 15, borderRadius: 12}}>
            <h4 style={{fontSize:'0.75rem',fontWeight:700,color:'#0369a1',marginBottom:12,textTransform:'uppercase',letterSpacing:'0.05em', display: 'flex', alignItems: 'center', gap: 8}}>
              <FlagIcon size={14} /> Ministry (NEMIS) Compliance Data
            </h4>
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginBottom: 12 }}>Required for official government reporting and funding.</div>
            <div className="form-row">
              <div className="form-group">
                <label style={{ color: !form.upi && !form.nemis_number ? '#c2410c' : 'inherit' }}>
                  UPI / NEMIS No {!form.upi && !form.nemis_number && <span style={{ color: '#ef4444' }}>*</span>}
                </label>
                <input className="form-input" name="upi" value={form.upi || form.nemis_number || ''} onChange={hc} placeholder="Unique Personal Identifier"/>
              </div>
              <div className="form-group"><label>Birth Certificate No</label><input className="form-input" name="birthCertNo" value={form.birthCertNo} onChange={hc} placeholder="e.g. 12345678"/></div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>Father's Name</label><input className="form-input" name="fatherName" value={form.fatherName} onChange={hc}/></div>
              <div className="form-group"><label>Father's Phone</label><input className="form-input" name="fatherPhone" value={form.fatherPhone} onChange={hc}/></div>
            </div>
            <div className="form-row">
              <div className="form-group"><label>Mother's Name</label><input className="form-input" name="motherName" value={form.motherName} onChange={hc}/></div>
              <div className="form-group"><label>Mother's Phone</label><input className="form-input" name="motherPhone" value={form.motherPhone} onChange={hc}/></div>
            </div>
          </div>
        </div>
        <div className="modal-footer"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary">{student?'Save Changes':'Add Student'}</button></div>
      </form>
    </div></div>
  );
}

function StudentDetail({ student, feeData, onClose, onEdit, currentUser, profile }) {
  const [data,setData]=useState({cbc:{}});
  const [loading,setLoading]=useState(true);
  useEffect(()=>{(async()=>{try{const c=await getCBC();setData({cbc:c[student.id]||{}});}catch(e){console.error(e);}finally{setLoading(false);}})();},[student.id]);
  const isAdmin=currentUser?.role?.toLowerCase()==='admin';
  const isTeacher=currentUser?.role?.toLowerCase()==='teacher';
  const isFinance=currentUser?.role?.toLowerCase()==='finance';
  const isLibrarian=currentUser?.role?.toLowerCase()==='librarian';
  const fmtKSh=(n)=>`KSh ${Number(n||0).toLocaleString()}`;
  const lv=getLevelForGrade(student.class);
  const lb=(()=>{if(lv==='Early Years')return{cls:'early-years',ico:<LeafIcon size={14} />};if(lv==='Upper Primary')return{cls:'upper-primary',ico:<BookIcon size={14} />};if(lv==='Junior Secondary')return{cls:'junior-secondary',ico:<GraduationIcon size={14} />};return{cls:'senior-secondary',ico:<RocketIcon size={14} />};})();
  const cc=lv=>({'Exceeding Expectation':'#10B981','Meeting Expectation':'#3B82F6','Approaching Expectation':'#F59E0B','Below Expectation':'#EF4444'}[lv]||'#3B82F6');
  const cs=lv=>({'Exceeding Expectation':'EE','Meeting Expectation':'ME','Approaching Expectation':'AE','Below Expectation':'BE'}[lv]||'ME');
  const pal=['#0EA5E9','#8B5CF6','#10B981','#F59E0B','#EF4444'];
  const bg=pal[student.name.charCodeAt(0)%pal.length];
  const ini=student.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  return(
    <div className="modal-overlay" onClick={onClose}><div className="modal" style={{maxWidth:560}} onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><h3>Student Profile</h3><button className="modal-close" onClick={onClose}>×</button></div>
      <div className="modal-body">
        {loading?<p className="text-muted text-center" style={{padding:20}}>Loading...</p>:<>
          <div style={{textAlign:'center',marginBottom:18}}>
            <div style={{width:60,height:60,borderRadius:'50%',background:bg,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'1.2rem',fontWeight:700,margin:'0 auto 10px'}}>{ini}</div>
            <div style={{fontSize:'0.75rem',fontWeight:800,color:'var(--primary)',letterSpacing:'0.05em',marginBottom:4}}>{student.admNo}</div>
            <h3 style={{fontSize:'1.15rem',fontWeight:800,marginBottom:6,color:'var(--text-main)'}}>{student.name}</h3>
            <div style={{display:'flex',gap:6,justifyContent:'center',flexWrap:'wrap'}}>
              <span className="badge badge-info">{student.class} {student.stream||''}</span>
              <span className={`level-badge ${lb.cls}`}>{lb.ico} {lv}</span>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,background:'var(--bg)',borderRadius:10,padding:14,marginBottom:12,fontSize:'0.875rem'}}>
            {[{l:'Gender',v:student.gender},{l:'Residence',v:<span style={{textTransform:'capitalize'}}>{student.residenceType === 'boarding' && student.house ? `Boarding (${student.house})` : (student.residenceType || 'day')}</span>},{l:'D.O.B',v:student.dob||'—'},{l:'Parent',v:student.parent},{l:'Phone',v:student.parentPhone},{l:'Joined',v:student.joinDate||'—'},
              {l:'Birth Cert',v:student.birthCertNo||'—'},{l:'County',v:student.county||'—'},
              ...((isAdmin || isFinance)?[{l:'Fee Balance',v:(()=>{const cv=profile?.gradeFees?.[student.class];const cf=typeof cv==='object'?(Number(cv[(student.residenceType||'day').toLowerCase()])||Number(cv.day)||TERM_FEE):(Number(cv)||TERM_FEE);const b=feeData.balance!==undefined?feeData.balance:cf;return<span style={{fontWeight:700,color:b>0?'var(--danger)':'var(--success)'}}>{fmtKSh(b)}</span>;})()}]:[]),
            ].map((r,i)=>(
              <div key={i}><div style={{fontSize:'0.68rem',color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:2}}>{r.l}</div><div style={{fontWeight:500}}>{r.v}</div></div>
            ))}
          </div>
          {student.notes&&<div style={{padding:'9px 13px',background:'var(--warning-light)',borderRadius:8,fontSize:'0.85rem',marginBottom:12}}><span style={{color:'var(--warning)',fontWeight:600,marginRight:6}}>Note:</span>{student.notes}</div>}
          <div style={{borderTop:'1px solid var(--border)',paddingTop:12}}>
            <h4 style={{fontSize:'0.8rem',fontWeight:700,marginBottom:8}}><FlagIcon size={16} /> CBC Competencies</h4>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {Object.keys(data.cbc).length>0?Object.keys(data.cbc).map(sub=>{const lv=data.cbc[sub]||'Meeting Expectation';return(
                <div key={sub} style={{padding:'3px 8px',borderRadius:6,fontSize:'0.72rem',background:`${cc(lv)}15`,border:`1px solid ${cc(lv)}30`,display:'flex',gap:5,alignItems:'center'}}>
                  <span style={{fontWeight:500}}>{sub.length>16?sub.slice(0,14)+'..':sub}</span>
                  <span style={{color:cc(lv),fontWeight:700}}>{cs(lv)}</span>
                </div>);}):
                <span className="text-muted" style={{fontSize:'0.8rem'}}>No assessment data yet</span>}
            </div>
          </div>
        </>}
      </div>
      <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>Close</button>{isAdmin&&<button className="btn btn-primary" onClick={onEdit}><EditIcon size={14} /> Edit</button>}</div>
    </div></div>
  );
}

function TransitionModal({ students, profile, onTransfer, onClose }) {
  const [sel,setSel]=useState([]);
  const [cf,setCf]=useState('All');
  const [dir,setDir]=useState('promote');
  const grades=Object.values(CBC_STRUCTURE).flatMap(l=>l.grades);
  const filtered=students.filter(s=>cf==='All'||s.class===cf);
  const getNew=(c)=>{const i=grades.indexOf(c);return dir==='promote'?(i<grades.length-1?grades[i+1]:'Graduated'):(i>0?grades[i-1]:c);};
  const toggleAll=()=>setSel(sel.length===filtered.length?[]:filtered.map(s=>s.id));
  const toggle=(id)=>setSel(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
  return(
    <div className="modal-overlay" onClick={onClose}><div className="modal" style={{maxWidth:760}} onClick={e=>e.stopPropagation()}>
      <div className="modal-header"><h3><RefreshIcon size={20} /> Class Transitions</h3><button className="modal-close" onClick={onClose}>×</button></div>
      <div className="modal-body" style={{maxHeight:'65vh',overflowY:'auto'}}>
        <div style={{display:'flex',gap:14,marginBottom:18,background:'var(--bg)',padding:14,borderRadius:10,border:'1px solid var(--border)'}}>
          <div style={{flex:1}}>
            <label style={{display:'block',fontSize:'0.72rem',fontWeight:700,color:'var(--text-light)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:8}}>Action</label>
            <div style={{display:'inline-flex',background:'var(--bg-card)',padding:3,borderRadius:8,border:'1px solid var(--border)'}}>
              <button className={`btn btn-sm ${dir==='promote'?'btn-primary':'btn-ghost'}`} onClick={()=>setDir('promote')}>↑ Promote</button>
              <button className={`btn btn-sm ${dir==='demote'?'btn-primary':'btn-ghost'}`} onClick={()=>setDir('demote')}>↓ Demote</button>
            </div>
          </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Filter Class</label>
              <Select 
                value={cf} 
                onChange={e => setCf(e.target.value)}
                options={[
                  { id: 'All', label: 'All Students' },
                  ...(profile.activeClasses || []).map(c => ({ id: c, label: c }))
                ]}
              />
            </div>
        </div>
        <table className="data-table">
          <thead><tr><th style={{width:36}}><input type="checkbox" checked={filtered.length>0&&filtered.every(s=>sel.includes(s.id))} onChange={toggleAll}/></th><th>Student</th><th>Current</th><th>Target</th><th style={{textAlign:'right'}}>Status</th></tr></thead>
          <tbody>
            {filtered.map(s=>{const isSel=sel.includes(s.id);return(
              <tr key={s.id} style={{opacity:isSel?1:0.55}}>
                <td><input type="checkbox" checked={isSel} onChange={()=>toggle(s.id)}/></td>
                <td><strong>{s.name}</strong></td>
                <td><span className="badge">{s.class}</span></td>
                <td>{isSel?<span className={`badge ${dir==='promote'?'badge-success':'badge-warning'}`}>{getNew(s.class)}</span>:<span className="text-muted">—</span>}</td>
                <td style={{textAlign:'right'}}>{isSel&&<span style={{fontSize:'0.8rem',fontWeight:600,color:dir==='promote'?'var(--success)':'var(--warning)'}}>{dir==='promote'?'↑ Promoting':'↓ Demoting'}</span>}</td>
              </tr>);})}
          </tbody>
        </table>
      </div>
      <div className="modal-footer" style={{justifyContent:'space-between'}}>
        <span className="text-muted" style={{fontSize:'0.85rem'}}><strong>{sel.length}</strong> students selected</span>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${dir==='promote'?'btn-primary':'btn-accent'}`} disabled={!sel.length}
            onClick={async ()=>{
              if(await confirm({ title: `${dir==='promote'?'Promote':'Demote'} Students`, message: `Are you sure you want to ${dir==='promote'?'promote':'demote'} ${sel.length} students?` })) onTransfer(sel,dir);
            }}>
            Confirm {dir==='promote'?'Promotions':'Demotions'}
          </button>
        </div>
      </div>
    </div></div>
  );
}


