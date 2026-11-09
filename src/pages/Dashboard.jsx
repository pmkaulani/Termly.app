import { useState, useEffect } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { getStudents } from '../data/studentStore';
import { getFeeSummary, getFees } from '../data/financeStore';
import { getAttendanceSummary, getTodayStr, getSchoolStructure, getMarks, getAttendance, getPeriods, setActivePeriod } from '../data/academicsStore';
import { getTeachers } from '../data/staffStore';
import { getSchoolProfile, subscribeToChanges, getPlatformSettings, checkIsSubscriptionActive, getPortalActivity } from '../data/coreStore';
import { getUsers } from '../data/authStore';
import Loader from '../components/Common/Loader';
import {
  StudentIcon, TeacherIcon, CardIcon, BookIcon, UserIcon, SchoolIcon,
  RocketIcon, AlertIcon, LogoutIcon, ClockIcon, SearchIcon, DashboardIcon,
  LeafIcon, GraduationIcon, ChevronDownIcon, CheckIcon
} from '../components/CommonIcons';
import SetupWizard from '../components/SetupWizard';
import SyncIndicator from '../components/Common/SyncIndicator';
import { Helmet } from 'react-helmet-async';
import Select from '../components/Common/Select';
import { useFeatures } from '../contexts/FeaturesContext';


export default function Dashboard({ currentUser, onLogout, currentPeriodId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [periods, setPeriods] = useState([]);
  const [isAccountActive, setIsAccountActive] = useState(true);
  const [dataLoadErrors, setDataLoadErrors] = useState([]);
  const [showWizard, setShowWizard] = useState(false);
  const { features } = useFeatures();
  const feat = (slug) => features[slug]?.enabled === true;

  useEffect(() => {
    const loadData = async () => {
      try {
        const loadErrors = [];
        const wrap = async (p, fb = [], label = 'Dashboard data') => { try { return await p; } catch(e) { console.error(label, e); loadErrors.push(label + ': ' + (e?.message || 'load failed')); return fb; } };
        const [students, fees, marks, teachers, profile, attendance, adminUsers, platformSettings, allPeriods, portalActivity] = await Promise.all([
          wrap(getStudents(), [], 'Students'), wrap(getFees(), {}, 'Fees'), wrap(getMarks(), {}, 'Marks'), wrap(getTeachers(), [], 'Teachers'),
          wrap(getSchoolProfile(), {}, 'School profile'), wrap(getAttendance(), {}, 'Attendance'), wrap(getUsers(), [], 'Staff users'),
          wrap(getPlatformSettings(), {}, 'Platform settings'), wrap(getPeriods(), [], 'Academic periods'), wrap(getPortalActivity(5), [], 'Portal activity')
        ]);
        
        const prof = profile || {};
        const active = await wrap(checkIsSubscriptionActive(prof), true);
        setIsAccountActive(active);
        setPeriods(allPeriods || []);

        const todayStr = getTodayStr();
        const [feeSummary, todayAtt, schoolStructure] = await Promise.all([
          wrap(getFeeSummary(fees, students, prof), { totalExpected:0, totalCollected:0, totalOutstanding:0, fullyPaid:0, partialPaid:0, unpaid:0 }, 'Fee summary'),
          wrap(getAttendanceSummary(todayStr, attendance, students, 'Morning'), { present:0, late:0, absent:0, total:students.length, percentage:0 }, 'Attendance summary'),
          wrap(getSchoolStructure(students, marks, prof), {}, 'School structure')
        ]);
        const allPayments = [];
        students.forEach(s => {
          const f = fees[s.id];
          if (f?.payments) f.payments.forEach(p => allPayments.push({ ...p, studentName: s.name, studentClass: s.class, admNo: s.admNo }));
        });
        allPayments.sort((a, b) => new Date(b.date) - new Date(a.date));
        const collectionRate = feeSummary.totalExpected > 0
          ? ((feeSummary.totalCollected / feeSummary.totalExpected) * 100).toFixed(1) : 0;
        setDataLoadErrors(loadErrors);
        const newData = {
          dataLoadErrors: loadErrors,
          totalStudents: students.length, totalTeachers: teachers.length,
          collectionRate: Number(collectionRate), feeSummary,
          attendance: todayAtt, recentPayments: allPayments.slice(0, 5),
          portalActivity: portalActivity || [],
          schoolStructure, profile: prof, adminUsers: adminUsers || [], platformSettings: platformSettings || {},
          studentsList: students || [],
          teachersList: teachers || [],
          attendanceRaw: attendance || {},
          marksRaw: marks || {},
        };
        setData(newData);
        setShowWizard(!prof?.setup_completed);
      } catch (err) {
        console.error(err);
        setDataLoadErrors([err?.message || 'Dashboard data could not be loaded.']);
        setData({
          totalStudents: 0, totalTeachers: 0, collectionRate: 0,
          feeSummary: { totalExpected:0, totalCollected:0, totalOutstanding:0, fullyPaid:0, partialPaid:0, unpaid:0 },
          attendance: { present:0, late:0, absent:0, total:0, percentage:0 },
          recentPayments: [], schoolStructure: {}, profile: {},
          adminUsers: [], platformSettings: {},
          studentsList: [], teachersList: [], attendanceRaw: {}, marksRaw: {},
        });
      } finally { setLoading(false); }
    };
    loadData();
    let debounceTimer = null;
    const debouncedLoadData = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        loadData();
      }, 500);
    };

    const handlePeriodChange = () => {
      setLoading(true);
      debouncedLoadData();
    };
    const handleProfileChange = () => {
      debouncedLoadData();
    };
    window.addEventListener('periodChanged', handlePeriodChange);
    window.addEventListener('schoolProfileChanged', handleProfileChange);
    const unsubs = [
      subscribeToChanges('students', debouncedLoadData), subscribeToChanges('teachers', debouncedLoadData),
      subscribeToChanges('payments', debouncedLoadData), subscribeToChanges('attendance', debouncedLoadData),
      subscribeToChanges('marks', debouncedLoadData),
      subscribeToChanges('users', debouncedLoadData)
    ];
    return () => {
      window.removeEventListener('periodChanged', handlePeriodChange);
      window.removeEventListener('schoolProfileChanged', handleProfileChange);
      unsubs.forEach(u => u());
    };
  }, [currentPeriodId, currentUser]);

  if (loading || !data) {
    return <Loader />;
  }

  const role = currentUser?.role?.toLowerCase() || 'teacher';
  const isTeacher = role === 'teacher';
  const isFinance  = role === 'finance';
  const isLibrarian = role === 'librarian';
  const formatKSh  = (n) => `KSh ${Number(n).toLocaleString()}`;

  const levelColors = {
    'Early Years':       { bg: '#ECFDF5', color: '#059669', accent: '#10B981', gradient: 'linear-gradient(135deg,#34D399,#10B981)' },
    'Upper Primary':     { bg: '#EFF6FF', color: '#1D4ED8', accent: '#3B82F6', gradient: 'linear-gradient(135deg,#60A5FA,#3B82F6)' },
    'Junior Secondary':  { bg: '#F5F3FF', color: '#6D28D9', accent: '#8B5CF6', gradient: 'linear-gradient(135deg,#A78BFA,#7C3AED)' },
    'Senior Secondary':  { bg: '#FFF1F2', color: '#BE123C', accent: '#F43F5E', gradient: 'linear-gradient(135deg,#FB7185,#E11D48)' },
  };
  const levelIcons = { 
    'Early Years':      <LeafIcon size={14} />,
    'Upper Primary':    <BookIcon size={14} />,
    'Junior Secondary': <GraduationIcon size={14} />,
    'Senior Secondary': <RocketIcon size={14} /> 
  };

  const plan = data.profile?.subscription_plan || data.profile?.subscriptionPlan || 'Starter Plan';
  const pricing = data.platformSettings?.pricing || {};
  const planKey = Object.keys(pricing).find(k => k.toLowerCase() === plan.toLowerCase());
  const seatLimit = planKey ? (pricing[planKey].admins || 5) : 5;
  const totalStaff = data.adminUsers?.length || 0;
  
  const kpis = [
    { icon:<StudentIcon size={20} />, label:'Total Students',    value: data.totalStudents,       color:'#0EA5E9', bg:'#E0F2FE',  show: true          },
    { icon:<TeacherIcon size={20} />, label:'Teaching Staff',    value: data.totalTeachers,       color:'#8B5CF6', bg:'#F5F3FF',  show: !isFinance && !isLibrarian },
    { icon:<CardIcon size={20} />,    label:'Fee Collection',      value: `${data.collectionRate}%`, color:'#10B981', bg:'#ECFDF5',  show: !isTeacher && !isLibrarian && feat('fees') },
    { icon:<BookIcon size={20} />,    label:"Today's Attendance", value: `${data.attendance.percentage}%`, color:'#F59E0B', bg:'#FFFBEB', show: !isFinance && !isLibrarian && feat('attendance') },
    { icon:<UserIcon size={20} />,    label:'Seat Usage',        value: `${totalStaff}/${seatLimit}`, color:'#64748b', bg:'#f1f5f9', show: !isTeacher && !isFinance && !isLibrarian },
  ].filter(k => k.show);

  return (
    <div className="animate-fade-up">
      <Helmet>
        <title>Dashboard | Termly - High Performance School Management</title>
        <meta name="description" content="View school-wide performance, student count, and attendance at a glance." />
      </Helmet>
      {showWizard && (
        <SetupWizard 
          profile={data.profile} 
          totalStudents={data.totalStudents} 
          onComplete={() => {
            setShowWizard(false);
          }} 
        />
      )}

      {/* Page Header */}
      <div className="page-header">
        <div className="page-header-actions">
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
                  {data.profile?.schoolName || 'Dashboard'}
                </h2>
              </div>
              <div className="inline-flex" style={{ gap: 10, alignItems: 'center' }}>
                {!isAccountActive && (
                  <div style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', padding: '6px 14px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, border: '1px solid var(--danger)', display:'flex', alignItems:'center', gap:5 }}>
                    <AlertIcon size={14} /> Subscription Expired
                  </div>
                )}
                {onLogout && (
                  <button onClick={onLogout} className="btn btn-ghost btn-sm">
                    <LogoutIcon size={14} /> Sign Out
                  </button>
                )}
              </div>
            </div>
            <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>Welcome back, <strong>{currentUser?.name || 'User'}</strong> - here's what's happening today.</p>
          </div>
        </div>
      </div>

      {dataLoadErrors.length > 0 && (
        <div role="alert" className="card" style={{ marginBottom: 16, border: '1px solid var(--warning, #d97706)', padding: 14 }}>
          <strong>Some dashboard information could not be loaded.</strong>
          <div style={{ fontSize: '0.82rem', marginTop: 6 }}>{dataLoadErrors.join(' • ')}</div>
          <div style={{ fontSize: '0.75rem', marginTop: 4, color: 'var(--text-muted)' }}>Numbers for failed sources may be incomplete. Check your connection and reload before making operational decisions.</div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid" style={{ '--kpi-cols': kpis.length }}>
        {kpis.map((k, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-card-top">
              <div className="kpi-icon" style={{ background: k.bg, color: k.color }}>
                {k.icon}
              </div>
            </div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>



      {/* Main Grid - Recent Activity + Portal Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18, marginBottom: 24 }}>

        {/* Recent Activity / Payments — only if fees module is enabled */}
        {feat('fees') && (
        <div className="card">
          <div className="card-header">
            <h3><ClockIcon size={18} /> Recent Activity</h3>
            {!isTeacher && <Link to="/fees" className="btn btn-ghost btn-sm">View All</Link>}
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {(data.recentPayments?.length || 0) === 0 ? (
              <div className="empty-state" style={{ padding: '40px 20px' }}>
                <div className="empty-state-icon" style={{ marginBottom: 12, opacity: 0.5 }}><CardIcon size={40} /></div>
                <p style={{ margin: '0 0 16px 0', fontSize: '0.85rem' }}>No fee payments recorded this term.</p>
                <Link to="/fees" className="btn btn-primary btn-sm">
                  Record First Payment
                </Link>
              </div>
            ) : (
              (data.recentPayments || []).map((p, i) => (
                <div className="activity-item" key={i} style={{ padding: '11px 18px' }}>
                  <div className="activity-icon"><CardIcon size={18} /></div>
                  <div className="activity-body">
                    <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--primary)' }}>{p.admNo}</div>
                    <div className="activity-title">{p.studentName}</div>
                    <div className="activity-sub">{p.studentClass} - {p.method}</div>
                  </div>
                  <div className="activity-time">{p.date}</div>
                </div>
              ))
            )}
          </div>
        </div>
        )}

        {/* Portal Activity Feed — only if teacher or parent portal is enabled */}
        {(feat('teacher_portal') || feat('parent_portal')) && (
        <div className="card">
          <div className="card-header">
            <h3><RocketIcon size={18} /> Portal Activity</h3>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {(data.portalActivity?.length || 0) === 0 ? (
              <div className="empty-state" style={{ padding: '40px 20px' }}>
                <div className="empty-state-icon" style={{ marginBottom: 12, opacity: 0.5 }}><RocketIcon size={40} /></div>
                <p style={{ margin: '0 0 16px 0', fontSize: '0.85rem' }}>No portal activity yet.</p>
              </div>
            ) : (
              (data.portalActivity || []).map((a, i) => (
                <div className="activity-item" key={i} style={{ padding: '11px 18px' }}>
                  <div className="activity-icon" style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}>
                    {a.actor_type === 'parent' ? <UserIcon size={14} /> : <TeacherIcon size={14} />}
                  </div>
                  <div className="activity-body">
                    <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      {a.actor_name || 'System User'}
                    </div>
                    <div className="activity-title" style={{ fontSize: '0.85rem' }}>
                      {typeof a.action === 'string' 
                        ? a.action.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/_/g, ' ').trim() || 'System Action'
                        : 'System Action'}
                    </div>
                    <div className="activity-sub">
                      {typeof a.target_type === 'string'
                        ? a.target_type.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/_/g, ' ').trim() || 'General Event'
                        : 'General Event'}
                    </div>
                  </div>
                  <div className="activity-time">{a.date}</div>
                </div>
              ))
            )}
          </div>
        </div>
        )}

      </div>

      {/* CBC Structure */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div className="flex-center gap-3">
            <div className="icon-box-primary"><SchoolIcon size={20} /></div>
            <div>
              <h3 style={{ margin: 0 }}>CBC School Structure</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-light)', margin: 0 }}>Distributed across 4 Key Stages</p>
            </div>
          </div>
          <span className="badge badge-info">{data.totalStudents} Students</span>
        </div>
        <div className="card-body">
            {Object.keys(data.schoolStructure).length === 0 ? (
              <div className="empty-state" style={{ padding: '60px 20px', textAlign: 'center' }}>
                <div className="empty-state-icon" style={{ marginBottom: 16, opacity: 0.5 }}><StudentIcon size={64} /></div>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--text)' }}>Your School is Empty</h4>
                <p style={{ margin: '0 0 20px 0', fontSize: '0.88rem', color: 'var(--text-secondary)', maxWidth: 300, marginInline: 'auto' }}>
                  Add your students to sessions to see the CBC structure and academic analytics.
                </p>
                <Link to="/students" className="btn btn-primary">
                  + Add Students Now
                </Link>
              </div>
            ) : (
              <div className="cbc-structure-grid">
                {Object.entries(data.schoolStructure).map(([levelName, levelData]) => {
                  const colors = levelColors[levelName] || levelColors['Early Years'];
                  const icon   = levelIcons[levelName] || <BookIcon size={14} />;
                  return (
                    <div key={levelName} className="cbc-level-card-refined">
                      <div className="cbc-level-header-refined" style={{ background: colors.gradient }}>
                        <span className="cbc-level-icon-glow">{icon}</span>
                        <div>
                          <div className="cbc-level-name-alt">{levelName}</div>
                          <div className="cbc-level-count-alt">{levelData.totalStudents} Students</div>
                        </div>
                      </div>
                      <div className="cbc-grades-list-refined">
                        {Object.entries(levelData.grades).map(([grade, info]) => {
                          const perfColor = info.avgPerformance >= 70 ? 'var(--success)' : info.avgPerformance >= 50 ? 'var(--warning)' : 'var(--danger)';
                          return (
                            <div key={grade} className="cbc-grade-row-refined">
                              <span className="grade-indicator" style={{ background: colors.accent }} />
                              <span className="grade-name">{grade}</span>
                              <div className="grade-stats-box">
                                <span className="count-pill" style={{ display:'flex', alignItems:'center', gap:4 }}>{info.count} <UserIcon size={10} /></span>
                                {info.avgPerformance > 0 && (
                                  <span className="perf-pill" style={{ borderColor: perfColor, color: perfColor }}>
                                    {info.avgPerformance}%
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>

      {/* Bottom row - Attendance + Fee summary */}
      <div className="dashboard-grid-2">

        {/* Attendance — only if attendance feature is enabled */}
        {!isFinance && feat('attendance') && (
          <div className="card">
            <div className="card-header">
              <div className="flex-center gap-3">
                <div className="icon-box-orange"><BookIcon size={20} /></div>
                <h3 style={{ margin: 0 }}>Today's Attendance</h3>
              </div>
              <Link to="/attendance" className="btn btn-ghost btn-sm">Mark Now</Link>
            </div>
            <div className="card-body">
              <div className="flex-around text-center" style={{ marginBottom: 20 }}>
                {[
                  { val: data.attendance.present, label: 'Present', color: 'var(--success)' },
                  { val: data.attendance.late,    label: 'Late',    color: 'var(--warning)' },
                  { val: data.attendance.absent,  label: 'Absent',  color: 'var(--danger)'  },
                ].map((s, i) => (
                  <div key={i} className="stat-group">
                    <div style={{ fontSize: '1.6rem', fontWeight: 800, color: s.color }}>{s.val}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-light)', fontWeight: 500 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div className="rate-circle-container">
                <div className="rate-circle" style={{ borderColor: data.attendance.percentage >= 90 ? 'var(--success)' : 'var(--warning)' }}>
                  <span className="rate-val">{data.attendance.percentage}%</span>
                  <span className="rate-label">Rate</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Fee Overview — only if fees feature is enabled */}
        {!isTeacher && feat('fees') && (
          <div className="card">
            <div className="card-header">
              <div className="flex-center gap-3">
                <div className="icon-box-success"><CardIcon size={20} /></div>
                <h3 style={{ margin: 0 }}>Fee Collection</h3>
              </div>
              <Link to="/fees" className="btn btn-ghost btn-sm">View All</Link>
            </div>
            <div className="card-body">
              <div className="flex-around text-center" style={{ marginBottom: 20 }}>
                {[
                  { val: data.feeSummary.fullyPaid,   label: 'Fully Paid', color: 'var(--success)' },
                  { val: data.feeSummary.partialPaid, label: 'Partial',    color: 'var(--warning)' },
                  { val: data.feeSummary.unpaid,      label: 'Unpaid',     color: 'var(--danger)'  },
                ].map((s, i) => (
                  <div key={i} className="stat-group">
                    <div style={{ fontSize: '1.6rem', fontWeight: 800, color: s.color }}>{s.val}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-light)', fontWeight: 500 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div className="progress-container-lg">
                <div className="progress-fill-glow" style={{ width: `${data.collectionRate}%` }} />
              </div>
              <div className="flex-between" style={{ marginTop: 8 }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-light)', fontWeight: 600 }}>
                  {data.collectionRate}% Collected
                </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {formatKSh(data.feeSummary.totalCollected)} of {formatKSh(data.feeSummary.totalExpected)}
                </span>
              </div>
            </div>
          </div>
        )}

      </div>

      <style>{`
        @media (max-width: 768px) {
          .page-header { flex-direction: column !important; align-items: flex-start !important; gap: 15px !important; }
          .page-header-actions { width: 100% !important; justify-content: space-between !important; gap: 10px !important; }
          .kpi-grid { grid-template-columns: 1fr 1fr !important; gap: 12px !important; }
          .kpi-card { padding: 15px !important; }
          .hero-title { font-size: 1.25rem !important; }
          .hero-subtitle { font-size: 0.85rem !important; }
          .cbc-structure-grid { grid-template-columns: 1fr !important; }
          .dashboard-grid-2 { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 480px) {
          .kpi-grid { grid-template-columns: 1fr !important; }
          .page-header-actions { flex-direction: column !important; align-items: stretch !important; }
          .inline-flex { width: 100% !important; justify-content: flex-end !important; }
        }
      `}</style>
    </div>
  );
}
