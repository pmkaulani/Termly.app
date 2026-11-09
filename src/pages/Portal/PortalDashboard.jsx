import React, { useState, useEffect, useCallback } from 'react';
import { 
  LogoutIcon, BookIcon, CheckIcon, 
  MessageIcon, ActivityIcon, 
  CardIcon, UserIcon, HistoryIcon,
  TeacherIcon, ChevronRightIcon,
  ClockIcon, SchoolIcon, BellIcon
} from '../../components/CommonIcons';
import { Helmet } from 'react-helmet-async';
// Student assignments and submissions are loaded from the secured cloud RPC.

import { getStudentExamResults, getGradeForScore, getStudentProfile, getAnnouncements, getSubjectDetails, getStudentCBCProgress, getPeriods, getStudentAssignments } from '../../data/academicsStore';
import { generateReportCard, downloadReportCardPDF, downloadCBCReportCardPDF } from '../../utils/reportCard';
import { printReceipt, printFeeStatement } from '../../utils/receiptPrint';
import { getStudentBooks } from '../../data/libraryStore';
import { getFees } from '../../data/financeStore';
import { getSchoolProfile, initPortalStore } from '../../data/coreStore';;
import { supabase } from '../../lib/supabase';
import Loader from '../../components/Common/Loader';
import NotificationCenter from '../../components/Common/NotificationCenter';
import { CardSkeleton, TableSkeleton } from '../../components/Common/Skeletons';
import { t } from '../../utils/i18n';
import { useIdleTimeout } from '../../hooks/useIdleTimeout';
import { subscribe, unsubscribeAll } from '../../utils/realtimeManager';

// Premium UI Components
const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ 
    background: '#ffffff', borderRadius: '24px', padding: '24px', 
    boxShadow: '0 10px 40px -10px rgba(0,0,0,0.08)', 
    border: '1px solid rgba(255,255,255,0.4)',
    cursor: onClick ? 'pointer' : 'default',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease',
    ...style 
  }}>
    {children}
  </div>
);

const Badge = ({ children, color = '#1a73e8', bg = '#eff6ff' }) => (
  <span style={{ 
    background: bg, color: color, padding: '6px 12px', 
    borderRadius: '12px', fontSize: '0.75rem', fontWeight: 700, 
    letterSpacing: '0.5px', textTransform: 'uppercase' 
  }}>
    {children}
  </span>
);

// Helper to clean and format class & stream without duplication
function formatClassStreamDisplay(rawClass = '', rawStream = '') {
  let cls = (rawClass || '').trim();
  let stm = (rawStream || '').trim();

  if (!cls) return { displayClass: 'N/A', displayStream: stm || 'General', full: 'N/A' };

  if (stm && cls.toLowerCase().endsWith(stm.toLowerCase())) {
    cls = cls.substring(0, cls.length - stm.length).trim();
  } else if (cls.includes(' ')) {
    const parts = cls.split(/\s+/);
    const lastPart = parts[parts.length - 1];
    if (parts.length > 1 && !/^(1|2|3|4|5|6|7|8|[A-D])$/i.test(lastPart)) {
      if (stm && lastPart.toLowerCase() !== stm.toLowerCase()) {
        cls = parts.slice(0, -1).join(' ');
      } else if (!stm) {
        cls = parts.slice(0, -1).join(' ');
        stm = lastPart;
      }
    }
  }

  const cleanClass = cls || rawClass;
  const cleanStream = stm || 'General';
  const full = (cleanStream && cleanStream !== 'General') ? `${cleanClass} ${cleanStream}` : cleanClass;

  return { displayClass: cleanClass, displayStream: cleanStream, full };
}

export default function PortalDashboard({ user, onLogout }) {
  const [localUser, setLocalUser] = useState(user);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('home');
  const [lastSync, setLastSync] = useState(null);
  const [lang, setLang] = useState('en');
  // Never display sample notices as if they were genuine school notifications.
  const [notifications, setNotifications] = useState([]);

  const classInfo = formatClassStreamDisplay(localUser?.class, localUser?.stream);

  // Session idle timeout (20 mins inactivity)
  useIdleTimeout(() => {
    alert(t('idleWarning', lang));
    if (onLogout) onLogout();
  }, 20 * 60 * 1000);

  // Data states
  const [assignments, setAssignments] = useState([]);
  const [mySubmissions, setMySubmissions] = useState({});
  const [examResults, setExamResults] = useState([]);
  const [cbcProgress, setCbcProgress] = useState([]);
  const [myBooks, setMyBooks] = useState([]);
  const [bookLoadError, setBookLoadError] = useState('');
  const [academic, setAcademic] = useState({ average: 0, grade: 'N/A', rank: '-', color: '#667781' });
  const [feeBalance, setFeeBalance] = useState(0);
  const [feeSummary, setFeeSummary] = useState({ billed: 0, paid: 0 });
  const [payments, setPayments] = useState([]);
  const [notices, setNotices] = useState([]);
  const [schoolProfile, setSchoolProfile] = useState(null);
  const [subjectTeachers, setSubjectTeachers] = useState([]);
  const [selectedSubjectDetail, setSelectedSubjectDetail] = useState(null);

  // M-Pesa state
  const [showMpesaModal, setShowMpesaModal] = useState(false);
  const [mpesaPhone, setMpesaPhone] = useState(user.parent_phone || '');
  const [mpesaAmount, setMpesaAmount] = useState('');
  const [isSTKPushing, setIsSTKPushing] = useState(false);

  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const isDesktop = windowWidth > 768;
  const isLargeDesktop = windowWidth > 992;

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Helper to reload fee data
  const refreshFees = useCallback(async () => {
    try {
      const activeId = localUser?.id || user.id;
      const myFee = await getFees(activeId);
      if (myFee) {
        setFeeBalance(myFee.balance || 0);
        setFeeSummary({ billed: myFee.billed || 0, paid: myFee.paid || 0 });
        setMpesaAmount((myFee.balance || 0) > 0 ? myFee.balance : 0);
        const sortedPayments = (myFee.payments || [])
          .filter(p => p.status !== 'Voided')
          .sort((a, b) => new Date(b.date) - new Date(a.date));
        setPayments(sortedPayments);
        setLastSync(new Date());
      }
    } catch (e) { console.warn('Fee refresh error:', e); }
  }, [localUser?.id, user.id]);

  // Helper to reload exam results
  const refreshResults = useCallback(async () => {
    try {
      const activeId = localUser?.id || user.id;
      const activeClass = localUser?.class || user.class;
      const examRes = await getStudentExamResults(activeId);
      setExamResults(examRes);
      if (examRes.length > 0) {
        const avg = examRes.reduce((acc, curr) => acc + (curr.total_marks / (curr.total_subjects || 1)), 0) / examRes.length;
        const { grade, color } = getGradeForScore(avg, activeClass, schoolProfile);
        setAcademic({ average: avg.toFixed(1), grade, color, rank: examRes[0].class_position });
      }
      setLastSync(new Date());
    } catch (e) { console.warn('Results refresh error:', e); }
  }, [localUser?.id, user.id, localUser?.class, user.class, schoolProfile]);

  useEffect(() => {
    async function init() {
      const activeId = localUser?.id || user.id;
      const activeSchoolId = localUser?.school_id || user.school_id || user.schoolId;
      const activeClass = localUser?.class || user.class;

      setLoading(true);
      try {
        initPortalStore(activeSchoolId, activeId);

        const [profile, freshStudent, examRes, schoolNotices, teachers, cbcData] = await Promise.all([
          getSchoolProfile().catch(() => null),
          getStudentProfile(activeId).catch(() => localUser),
          getStudentExamResults(activeId).catch(() => []),
          getAnnouncements(activeSchoolId).catch(() => []),
          getSubjectDetails(activeId).catch(() => []),
          getStudentCBCProgress(activeId).catch(() => [])
        ]);
        
        setSchoolProfile(profile);
        if (freshStudent && freshStudent.id === activeId) setLocalUser(freshStudent);
        setSubjectTeachers(teachers);
        
        const asts = activeId ? await getStudentAssignments(activeId) : [];
        setAssignments(Array.isArray(asts) ? asts : []);
        setExamResults(examRes);
        setCbcProgress(cbcData);
        setNotices(schoolNotices);
        const subMap = {};
        (Array.isArray(asts) ? asts : []).forEach((assignment) => {
          if (assignment.submission) subMap[assignment.id] = assignment.submission;
        });
        setMySubmissions(subMap);

        try {
          const books = await getStudentBooks(activeId);
          setMyBooks(Array.isArray(books) ? books : []);
          setBookLoadError('');
        } catch (bookError) {
          console.warn('[Portal] Library loans could not be loaded:', bookError);
          setMyBooks([]);
          setBookLoadError('We could not load the library records right now. Please refresh or contact the school library.');
        }
        
        if (examRes.length > 0) {
          const avg = examRes.reduce((acc, curr) => {
            if (curr.mean_score !== undefined && curr.mean_score !== null) return acc + Number(curr.mean_score);
            return acc + (Number(curr.total_marks || 0) / Math.max(Number(curr.total_subjects || 1), 1));
          }, 0) / examRes.length;
          const { grade, color } = getGradeForScore(avg, activeClass, profile);
          setAcademic({ average: avg.toFixed(1), grade, color, rank: examRes[0].class_position || '-' });
        }

        const myFee = await getFees(activeId).catch(() => null);
        if (myFee) {
          setFeeBalance(myFee.balance || 0);
          setFeeSummary({
            billed: myFee.billed || 0,
            paid: myFee.paid || 0
          });
          setMpesaAmount((myFee.balance || 0) > 0 ? myFee.balance : 0);
          const sortedPayments = (myFee.payments || [])
            .filter(p => p.status !== 'Voided')
            .sort((a, b) => new Date(b.date) - new Date(a.date));
          setPayments(sortedPayments);
        }

        setLastSync(new Date());
      } catch (err) {
        console.error('Portal init failed:', err);
      } finally {
        setLoading(false);
      }
    }
    init();

    // Real-time subscriptions for live updates
    const activeId = localUser?.id || user.id;
    const activeSchoolId = localUser?.school_id || user.school_id || user.schoolId;
    
    const unsubFees = subscribe(`portal_fees_${activeId}`, 'fee_payments', refreshFees, { column: 'school_id', value: activeSchoolId });
    const unsubResults = subscribe(`portal_results_${activeId}`, 'exam_results', refreshResults, { column: 'student_id', value: activeId });
    const unsubAnnouncements = subscribe(`portal_notices_${activeSchoolId}`, 'announcements', async () => {
      const fresh = await getAnnouncements(activeSchoolId).catch(() => []);
      setNotices(fresh);
      setLastSync(new Date());
    }, { column: 'school_id', value: activeSchoolId });

    return () => {
      unsubFees();
      unsubResults();
      unsubAnnouncements();
    };
  }, [user, localUser?.id, localUser?.school_id, refreshFees, refreshResults]);

  const [mpesaError, setMpesaError] = useState('');

  const handleMpesaPay = async () => {
    setMpesaError('');
    const amount = parseFloat(mpesaAmount);
    if (!amount || amount <= 0) {
      setMpesaError('Enter a valid amount.');
      return;
    }
    if (!mpesaPhone || !/^2547\d{8}$/.test(mpesaPhone.replace(/\s/g, ''))) {
      setMpesaError('Enter a valid phone number in the format 2547XXXXXXXX.');
      return;
    }
    setIsSTKPushing(true);
    try {
      const { data, error } = await supabase.functions.invoke('mpesa-stk-push', {
        body: {
          action: 'push',
          payload: {
            phoneNumber: mpesaPhone.replace(/\s/g, ''),
            amount,
            accountRef: localUser?.adm_no || localUser?.id,
            description: `Fees - ${localUser?.name || 'Student'}`,
          },
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'STK push was not accepted.');
      setShowMpesaModal(false);
      alert('Payment prompt sent — check your phone to enter your M-Pesa PIN.');
    } catch (err) {
      setMpesaError(err.message || 'Could not start the payment. Please try again.');
    } finally {
      setIsSTKPushing(false);
    }
  };

  const formatDateTime = (dateStr) => {
    if (!dateStr) return 'N/A';
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' at ' + 
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  if (loading) return <Loader fullPage={true} text="Synchronizing your portal data..." />;

  return (
    <div style={{ width: '100%', background: '#f8fafc', minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: '"Inter", sans-serif' }}>
      <Helmet>
        <title>{localUser?.name || 'Dashboard'} | Parent Portal — Termly</title>
        <meta name="description" content="View academic performance, track fees, and communicate with teachers." />
      </Helmet>
      
      {/* Desktop Wrapper */}
      <div style={{ 
        width: '100%', maxWidth: '1400px', margin: '0 auto', 
        display: 'flex', flex: 1, position: 'relative'
      }}>
        
        {/* Desktop Sidebar Navigation */}
        <nav className="desktop-nav" style={{
          width: 280, padding: '32px 0', borderRight: '1px solid rgba(0,0,0,0.05)',
          display: isDesktop ? 'flex' : 'none', flexDirection: 'column', gap: 8,
          background: '#fff', position: 'sticky', top: 0, height: '100vh'
        }}>
          {/* Branding */}
          <div style={{ padding: '0 24px 32px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #10b981, #3b82f6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <SchoolIcon size={22} color="#fff" />
            </div>
            <div style={{ fontWeight: 900, fontSize: '1.4rem', color: '#0f172a', letterSpacing: '-0.5px' }}>Termly</div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '0 16px' }}>
            {[
              { id: 'home', label: 'Dashboard', icon: ActivityIcon },
              { id: 'announcements', label: 'Announcements', icon: MessageIcon },
              { id: 'academics', label: 'Academic Results', icon: BookIcon },
              { id: 'fees', label: 'Fees & Payments', icon: CardIcon },
              { id: 'profile', label: 'Student Profile', icon: UserIcon }
            ].map(tab => (
              <div 
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{ 
                  display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                  borderRadius: '12px', cursor: 'pointer',
                  background: activeTab === tab.id ? '#f0fdf4' : 'transparent',
                  color: activeTab === tab.id ? '#10b981' : '#64748b',
                  fontWeight: 700,
                  transition: 'all 0.2s ease'
                }}
              >
                <tab.icon size={20} strokeWidth={activeTab === tab.id ? 2.5 : 2} />
                <span>{tab.label}</span>
              </div>
            ))}
          </div>

          {/* User Info in Sidebar */}
          <div style={{ padding: '24px', borderTop: '1px solid #f1f5f9', marginTop: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: 20, background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#475569' }}>
                {localUser.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{localUser.name}</div>
                <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{localUser.adm_no}</div>
              </div>
            </div>
            <button onClick={onLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px', borderRadius: '10px', border: '1px solid #e2e8f0', background: 'transparent', color: '#64748b', fontWeight: 600, cursor: 'pointer' }}>
              <LogoutIcon size={18} /> Logout
            </button>
          </div>
        </nav>

        {/* Content Area */}
        <div style={{ flex: 1, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          
          {/* Header (Mobile & Tablet) */}
          {!isDesktop && (
            <div style={{ 
              background: '#fff', padding: '12px 20px', 
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              borderBottom: '1px solid #f1f5f9', position: 'sticky', top: 0, zIndex: 100
            }}>
              <div style={{ fontWeight: 900, fontSize: '1.2rem', color: '#0f172a' }}>Termly</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
                  style={{ background: '#f1f5f9', border: 'none', borderRadius: '10px', padding: '6px 10px', fontSize: '0.75rem', fontWeight: 800, color: '#334155', cursor: 'pointer' }}
                >
                  🌐 {lang === 'en' ? 'SW' : 'EN'}
                </button>
                <NotificationCenter 
                  notifications={notifications} 
                  lang={lang}
                  onMarkRead={(id) => setNotifications(n => n.map(x => x.id === id ? { ...x, read_at: new Date().toISOString() } : x))}
                  onMarkAllRead={() => setNotifications(n => n.map(x => ({ ...x, read_at: new Date().toISOString() })))}
                />
                <div onClick={onLogout} style={{ color: '#64748b', cursor: 'pointer' }}><LogoutIcon size={22} /></div>
              </div>
            </div>
          )}

          <main style={{ flex: 1, padding: isDesktop ? '48px 60px' : '24px 20px 100px' }}>
            
            {/* Multi-Child Family Switcher Banner */}
            {user?.linkedChildren && user.linkedChildren.length > 1 && (
              <div style={{
                width: '100%', marginBottom: 24, padding: '14px 20px', background: '#ffffff',
                borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,0.03)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '1rem' }}>👨‍👩‍👧‍👦</span>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#0f172a' }}>Family Portal Account</div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{user.linkedChildren.length} children linked to this phone number</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Select Student:</span>
                  {user.linkedChildren.map(child => {
                    const isSelected = (localUser?.id === child.id || localUser?.adm_no === child.adm_no);
                    return (
                      <button
                        key={child.id || child.adm_no}
                        onClick={() => setLocalUser(child)}
                        style={{
                          padding: '6px 14px',
                          borderRadius: '20px',
                          border: isSelected ? '2px solid #0EA5E9' : '1px solid #cbd5e1',
                          background: isSelected ? '#f0f9ff' : '#f8fafc',
                          color: isSelected ? '#0369a1' : '#334155',
                          fontSize: '0.8rem',
                          fontWeight: 800,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          transition: 'all 0.2s ease'
                        }}
                      >
                        <span>{child.name}</span>
                        <span style={{ fontSize: '0.7rem', opacity: 0.85, background: isSelected ? '#0284c7' : '#94a3b8', color: '#fff', padding: '1px 7px', borderRadius: '8px' }}>
                          {child.class}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Greeting Header & Top Toolbar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32, flexWrap: 'wrap', gap: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: '0.85rem', color: '#10b981', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
                    {schoolProfile?.name || 'Termly Academy'}
                  </div>
                  {lastSync && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem', color: '#94a3b8', fontWeight: 600 }}>
                      <div style={{ width: 6, height: 6, borderRadius: 3, background: '#10b981', animation: 'pulse 2s infinite' }} />
                      {t('live', lang)}
                    </div>
                  )}
                </div>
                <h1 style={{ margin: 0, fontSize: isDesktop ? '2.4rem' : '1.8rem', fontWeight: 900, color: '#0f172a', letterSpacing: '-1px' }}>
                  {t('dashboard', lang)}, {localUser.name.split(' ')[0]}
                </h1>
              </div>

              {/* Controls Toolbar (Desktop) */}
              {isDesktop && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <button
                    onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
                    style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '10px 16px', fontSize: '0.85rem', fontWeight: 700, color: '#334155', cursor: 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.03)' }}
                  >
                    🌐 {lang === 'en' ? 'Kiswahili' : 'English'}
                  </button>
                  <NotificationCenter 
                    notifications={notifications} 
                    lang={lang}
                    onMarkRead={(id) => setNotifications(n => n.map(x => x.id === id ? { ...x, read_at: new Date().toISOString() } : x))}
                    onMarkAllRead={() => setNotifications(n => n.map(x => ({ ...x, read_at: new Date().toISOString() })))}
                  />
                </div>
              )}
            </div>

            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
                  <CardSkeleton height={140} />
                  <CardSkeleton height={140} />
                  <CardSkeleton height={140} />
                </div>
                <TableSkeleton rows={4} />
              </div>
            ) : null}

            {/* HOME TAB */}
            {activeTab === 'home' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 32, animation: 'fadeIn 0.4s ease-out' }}>
                
                {/* Stats Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
                  <Card style={{ borderLeft: '4px solid #3b82f6' }}>
                    <div style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Current Class</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 900, color: '#0f172a' }}>{classInfo.full}</div>
                    <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 4 }}>Term {schoolProfile?.academic_year || '2026'}</div>
                  </Card>
                  
                  <Card style={{ borderLeft: '4px solid #ef4444' }}>
                    <div style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Fee Balance</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 900, color: feeBalance > 0 ? '#ef4444' : '#10b981' }}>
                      KES {feeBalance.toLocaleString()}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 4 }}>Last paid: {payments[0] ? new Date(payments[0].date).toLocaleDateString() : 'N/A'}</div>
                  </Card>

                  <Card style={{ borderLeft: '4px solid #10b981' }}>
                    <div style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 600, marginBottom: 8 }}>Average Grade</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 900, color: academic.color !== '#667781' ? academic.color : '#0f172a' }}>
                      {academic.grade}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 4 }}>Score: {academic.average}%</div>
                  </Card>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isLargeDesktop ? '1fr 1fr' : '1fr', gap: 32 }}>
                  {/* Left Column: Updates */}
                  <section>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800 }}>Recent Updates</h3>
                      <button onClick={() => setActiveTab('announcements')} style={{ background: 'transparent', border: 'none', color: '#3b82f6', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>View All</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {notices.length === 0 ? (
                        <div style={{ padding: '40px', textAlign: 'center', background: '#fff', borderRadius: 20, color: '#94a3b8' }}>
                          No recent announcements
                        </div>
                      ) : (
                        notices.slice(0, 3).map(n => (
                          <div key={n.id} style={{ background: '#fff', padding: 20, borderRadius: 20, border: '1px solid #f1f5f9' }}>
                            <div style={{ fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>{n.title}</div>
                            <div style={{ fontSize: '0.85rem', color: '#64748b', lineHeight: 1.5, marginBottom: 12 }}>{n.body.substring(0, 120)}...</div>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600 }}>{new Date(n.created_at).toLocaleDateString()}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>

                  {/* Right Column: Performance Preview */}
                  <section>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800 }}>Recent Results</h3>
                      <button onClick={() => setActiveTab('academics')} style={{ background: 'transparent', border: 'none', color: '#3b82f6', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>Details</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {examResults.length === 0 ? (
                        <div style={{ padding: '40px', textAlign: 'center', background: '#fff', borderRadius: 20, color: '#94a3b8' }}>
                          Results will appear here once released
                        </div>
                      ) : (
                        examResults.slice(0, 3).map(res => (
                          <div key={res.id} style={{ background: '#fff', padding: '16px 20px', borderRadius: 16, border: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <div style={{ fontWeight: 700, color: '#0f172a' }}>{res.exams?.name}</div>
                              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Term {res.exams?.term}</div>
                            </div>
                            <div style={{ fontWeight: 900, color: '#10b981', fontSize: '1.1rem' }}>{res.mean_score?.toFixed(1)}%</div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>

                  <section style={{ marginTop: 24 }}>
                    <h4 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: 14, color: '#0f172a' }}>Library Books</h4>
                    {bookLoadError ? (
                      <Card style={{ padding: '24px', color: '#b45309', background: '#fffbeb' }}>
                        <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>Library records unavailable</div>
                        <div style={{ fontSize: '0.82rem', marginTop: 6 }}>{bookLoadError}</div>
                      </Card>
                    ) : myBooks.length === 0 ? (
                      <Card style={{ padding: '32px', textAlign: 'center', color: '#94a3b8' }}>
                        <div style={{ fontSize: '0.9rem' }}>No books currently borrowed.</div>
                      </Card>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {myBooks.map(book => (
                          <Card key={book.id} style={{ padding: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                            <div style={{ minWidth: 180, flex: 1 }}>
                              <div style={{ fontWeight: 800, color: '#0f172a', fontSize: '0.95rem' }}>{book.title || 'Untitled book'}</div>
                              {book.author && <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 3 }}>By {book.author}</div>}
                              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 5 }}>
                                Copy {book.copy_code || 'N/A'}{book.issue_date ? ` · Borrowed ${new Date(book.issue_date).toLocaleDateString()}` : ''}
                              </div>
                            </div>
                            <Badge bg={book.is_overdue ? '#fef2f2' : '#f0fdf4'} color={book.is_overdue ? '#ef4444' : '#10b981'}>
                              {book.is_overdue ? 'Overdue' : 'Due'} {book.due_date ? new Date(book.due_date).toLocaleDateString() : 'date not set'}
                            </Badge>
                          </Card>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            )}
            
            {/* ANNOUNCEMENTS TAB */}
            {activeTab === 'announcements' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, animation: 'fadeIn 0.4s ease-out' }}>
                <h3 style={{ fontSize: '1.4rem', fontWeight: 900, marginBottom: 8 }}>School Announcements</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {notices.length === 0 ? (
                    <Card style={{ padding: '60px', textAlign: 'center', color: '#94a3b8' }}>
                      <div style={{ marginBottom: 16, opacity: 0.3 }}>
                        <MessageIcon size={48} />
                      </div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>No announcements yet</div>
                      <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>Check back later for school updates.</p>
                    </Card>
                  ) : (
                    notices.map(n => (
                      <Card key={n.id} style={{ padding: 32 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                          <h4 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#0f172a', flex: 1 }}>{n.title}</h4>
                          <Badge bg="#f0fdf4" color="#10b981">{new Date(n.created_at).toLocaleDateString()}</Badge>
                        </div>
                        <div style={{ 
                          fontSize: '1rem', color: '#475569', lineHeight: 1.7, 
                          background: '#f8fafc', padding: 24, borderRadius: 16, border: '1px solid #f1f5f9' 
                        }}>
                          {n.body}
                        </div>
                        <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 32, height: 32, borderRadius: 16, background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700 }}>
                            {n.author_name?.charAt(0) || 'A'}
                          </div>
                          <div>
                            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0f172a' }}>{n.author_name || 'School Administration'}</div>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600 }}>Official Update</div>
                          </div>
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ACADEMICS TAB */}
            {activeTab === 'academics' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 32, animation: 'fadeIn 0.4s ease-out' }}>
                <section>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: 16 }}>My Subjects</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
                    {localUser.subjects?.map((sub, idx) => {
                      const tInfo = subjectTeachers.find(t => t.subject_name === sub);
                      return (
                        <Card 
                          key={idx}
                          onClick={() => setSelectedSubjectDetail(tInfo || { subject_name: sub })}
                          style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px' }}
                        >
                          <div style={{ width: 44, height: 44, borderRadius: 12, background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                            <BookIcon size={20} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700, color: '#0f172a' }}>{sub}</div>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600 }}>{tInfo?.teacher_name || 'Teacher not assigned'}</div>
                          </div>
                          <ChevronRightIcon size={18} color="#cbd5e1" />
                        </Card>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: 16 }}>Detailed Exam Performance</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {examResults.map(res => (
                      <Card key={res.id} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 24 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontWeight: 800, fontSize: '1.2rem', color: '#0f172a', marginBottom: 4 }}>{res.exams?.name}</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <Badge bg="#e0e7ff" color="#4f46e5">{res.exams?.term}</Badge>
                            <Badge bg="#f1f5f9" color="#64748b">{res.exams?.exam_type}</Badge>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 40 }}>
                          <div>
                            <div style={{ fontSize: '0.7rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Average</div>
                            <div style={{ fontSize: '1.6rem', fontWeight: 900, color: '#10b981' }}>{res.mean_score?.toFixed(1)}%</div>
                          </div>
                          <div>
                            <div style={{ fontSize: '0.7rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Rank</div>
                            <div style={{ fontSize: '1.6rem', fontWeight: 900, color: '#0f172a' }}>#{res.class_position}</div>
                          </div>
                        </div>
                        </div>
                        {res.teacher_remarks && (
                          <div style={{ marginTop: '4px', padding: '16px', background: '#f8fafc', borderRadius: '12px', borderLeft: '4px solid #3b82f6' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#3b82f6', textTransform: 'uppercase', marginBottom: 4 }}>Teacher's Remarks</div>
                            <div style={{ fontSize: '0.95rem', color: '#334155', fontStyle: 'italic' }}>"{res.teacher_remarks}"</div>
                          </div>
                        )}
                        {/* Report Card Actions */}
                        <div style={{ display: 'flex', gap: 10, borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
                          <button
                            onClick={() => {
                              const marks = {};
                              (res.subjects || []).forEach(s => { marks[s.subject_name || s.name] = s.score || s.marks || 0; });
                              generateReportCard(
                                localUser,
                                marks,
                                { teacherComments: res.teacher_remarks || '', headComments: res.head_remarks || '' },
                                { schoolName: schoolProfile?.schoolName, term: res.exams?.term, year: res.academic_year || res.exams?.academic_year || new Date().getFullYear().toString() }
                              );
                            }}
                            style={{
                              padding: '8px 16px', borderRadius: 10, border: '1px solid #e2e8f0',
                              background: '#f8fafc', color: '#334155', fontSize: '0.78rem', fontWeight: 700,
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                              transition: 'all 0.15s ease'
                            }}
                          >
                            <BookIcon size={14} /> Print Report Card
                          </button>
                          <button
                            onClick={() => {
                              const marks = {};
                              (res.subjects || []).forEach(s => { marks[s.subject_name || s.name] = s.score || s.marks || 0; });
                              downloadReportCardPDF(
                                localUser,
                                marks,
                                { teacherComments: res.teacher_remarks || '', headComments: res.head_remarks || '' },
                                { schoolName: schoolProfile?.schoolName, term: res.exams?.term, year: res.exams?.year || '2026' }
                              );
                            }}
                            style={{
                              padding: '8px 16px', borderRadius: 10, border: 'none',
                              background: '#4f46e5', color: '#ffffff', fontSize: '0.78rem', fontWeight: 700,
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                              transition: 'all 0.15s ease'
                            }}
                          >
                            <CardIcon size={14} color="#fff" /> Download PDF
                          </button>
                        </div>
                      </Card>
                    ))}
                  </div>
                </section>

                <section style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: 12 }}>My Competency Progress</h3>
                  {cbcProgress.length === 0 ? (
                    <Card style={{ padding: '32px', textAlign: 'center', color: '#94a3b8', marginBottom: 24 }}>
                      <div style={{ fontSize: '0.9rem' }}>No CBC competency data recorded yet.</div>
                    </Card>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                      {cbcProgress.map((comp, idx) => {
                        const band = comp.level;
                        const isEE = band.startsWith('EE');
                        const isME = band.startsWith('ME');
                        const isAE = band.startsWith('AE');
                        const bg = isEE ? '#dcfce7' : isME ? '#dbeafe' : isAE ? '#fef9c3' : '#fee2e2';
                        const color = isEE ? '#15803d' : isME ? '#1d4ed8' : isAE ? '#a16207' : '#b91c1c';
                        const width = isEE ? '100%' : isME ? '75%' : isAE ? '50%' : '25%';
                        return (
                          <div key={idx} style={{ padding: '16px 20px', background: '#ffffff', borderRadius: 16, border: '1px solid #e2e8f0' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                              <span style={{ fontWeight: 800, color: '#0f172a' }}>{comp.subject}</span>
                              <span style={{ fontWeight: 900, fontSize: '0.85rem', padding: '4px 12px', borderRadius: 20, background: bg, color: color }}>
                                {band}
                              </span>
                            </div>
                            <div style={{ width: '100%', height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width, background: color, borderRadius: 4, transition: 'width 1s ease-out' }} />
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                        <button
                          onClick={() => downloadCBCReportCardPDF(localUser, cbcProgress, {}, schoolProfile)}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: '#4f46e5', color: '#fff', borderRadius: 12, fontWeight: 700, border: 'none', cursor: 'pointer', boxShadow: '0 4px 12px rgba(79, 70, 229, 0.25)' }}
                        >
                          <DownloadIcon size={16} />
                          Download Official CBC Report
                        </button>
                      </div>
                    </div>
                  )}
                </section>
                <section style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: 12 }}>CBC Competency Band Guide (CBAF)</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                    {[
                      { band: 'EE1', name: 'Exceeding Expectations (Upper)', desc: 'Consistently demonstrates exceptional mastery beyond targets.' },
                      { band: 'EE2', name: 'Exceeding Expectations (Standard)', desc: 'Demonstrates strong understanding above core grade expectations.' },
                      { band: 'ME1', name: 'Meeting Expectations (Upper)', desc: 'Meets core curriculum targets consistently with good application.' },
                      { band: 'ME2', name: 'Meeting Expectations (Standard)', desc: 'Meets basic grade expectations consistently.' },
                      { band: 'AE1', name: 'Approaching Expectations (Upper)', desc: 'Shows basic understanding; requires targeted practice.' },
                      { band: 'AE2', name: 'Approaching Expectations (Standard)', desc: 'Needs guidance to meet basic learning targets.' },
                      { band: 'BE1', name: 'Below Expectations (Upper)', desc: 'Requires structured intervention and teacher support.' },
                      { band: 'BE2', name: 'Below Expectations (Minimal)', desc: 'Requires immediate individualized learning support.' }
                    ].map(b => (
                      <div key={b.band} style={{ padding: '12px 16px', background: '#ffffff', borderRadius: 14, border: '1px solid #e2e8f0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontWeight: 900, fontSize: '0.85rem', padding: '2px 8px', borderRadius: 6, background: b.band.startsWith('EE') ? '#dcfce7' : b.band.startsWith('ME') ? '#dbeafe' : b.band.startsWith('AE') ? '#fef9c3' : '#fee2e2', color: b.band.startsWith('EE') ? '#15803d' : b.band.startsWith('ME') ? '#1d4ed8' : b.band.startsWith('AE') ? '#a16207' : '#b91c1c' }}>
                            {b.band}
                          </span>
                          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#334155' }}>{b.name}</span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{b.desc}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {/* FEES TAB */}
            {activeTab === 'fees' && (
              <div style={{ display: 'grid', gridTemplateColumns: isLargeDesktop ? '1fr 350px' : '1fr', gap: 32, animation: 'fadeIn 0.4s ease-out' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
                  <section>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: 16 }}>Transaction History</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {payments.map(p => (
                        <div key={p.id} style={{ background: '#fff', padding: 20, borderRadius: 20, border: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                            <div style={{ width: 44, height: 44, borderRadius: 12, background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                              <CardIcon size={20} />
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, color: '#0f172a' }}>{p.mode || 'M-Pesa Payment'}</div>
                              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{new Date(p.date).toLocaleDateString()} • {p.reference || 'Ref: N/A'}</div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                            <div style={{ fontWeight: 800, color: '#10b981', fontSize: '1.2rem' }}>+KES {p.amount.toLocaleString()}</div>
                            <button
                              onClick={() => printReceipt({ school: schoolProfile, student: localUser, payment: { ...p, created_at: p.date, totalFee: feeSummary.billed } })}
                              style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '6px 12px', fontSize: '0.75rem', fontWeight: 700, color: '#475569', cursor: 'pointer' }}
                            >
                              Receipt
                            </button>
                          </div>
                        </div>
                      ))}
                      {payments.length === 0 && <div style={{ padding: 40, textAlign: 'center', background: '#fff', borderRadius: 20, color: '#94a3b8' }}>No payment records found</div>}
                    </div>
                  </section>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <Card style={{ background: '#0f172a', color: '#fff', padding: 32, border: 'none' }}>
                    <div style={{ fontSize: '0.85rem', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', marginBottom: 12 }}>Fee Balance</div>
                    <div style={{ fontSize: '2.4rem', fontWeight: 900, marginBottom: 32 }}>KES {feeBalance.toLocaleString()}</div>
                    <button 
                      onClick={() => setShowMpesaModal(true)}
                      style={{ width: '100%', padding: '16px', borderRadius: '16px', border: 'none', background: '#10b981', color: '#fff', fontWeight: 800, fontSize: '1.1rem', cursor: 'pointer' }}
                    >
                      Pay via M-Pesa
                    </button>
                  </Card>

                  <Card>
                    <h4 style={{ margin: '0 0 16px', fontWeight: 800 }}>Fee Summary</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Total Billed</span>
                        <span style={{ fontWeight: 700 }}>KES {feeSummary.billed.toLocaleString()}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Total Paid</span>
                        <span style={{ fontWeight: 700, color: '#10b981' }}>KES {feeSummary.paid.toLocaleString()}</span>
                      </div>
                      <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem' }}>
                        <span style={{ fontWeight: 800 }}>Remaining Balance</span>
                        <span style={{ fontWeight: 900, color: feeBalance > 0 ? '#ef4444' : '#10b981' }}>KES {feeBalance.toLocaleString()}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => printFeeStatement({ 
                        school: schoolProfile, 
                        student: localUser, 
                        payments: payments.map(p => ({ ...p, status: 'Approved', created_at: p.date })), 
                        feeStructure: [{ name: 'Term Fees', amount: feeSummary.billed }] 
                      })}
                      style={{ width: '100%', marginTop: '16px', padding: '12px', borderRadius: '12px', border: '1px solid #cbd5e1', background: '#f8fafc', color: '#334155', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}
                    >
                      Print Full Statement
                    </button>
                  </Card>
                </div>
              </div>
            )}

            {/* PROFILE TAB */}
            {activeTab === 'profile' && (
              <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 32, animation: 'fadeIn 0.4s ease-out' }}>
                <Card style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ width: 80, height: 80, borderRadius: 40, background: '#f1f5f9', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 800, margin: '0 auto 20px' }}>
                    {localUser.name.charAt(0)}
                  </div>
                  <h2 style={{ margin: '0 0 4px', fontSize: '1.6rem', fontWeight: 900 }}>{localUser.name}</h2>
                  <div style={{ fontSize: '0.95rem', color: '#64748b', fontWeight: 600 }}>{localUser.adm_no}</div>
                </Card>

                <div style={{ display: 'grid', gridTemplateColumns: windowWidth > 600 ? '1fr 1fr' : '1fr', gap: 24 }}>
                  <Card>
                    <h4 style={{ margin: '0 0 16px', fontWeight: 800 }}>Academic Info</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Class</span>
                        <span style={{ fontWeight: 700 }}>{classInfo.displayClass}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Stream</span>
                        <span style={{ fontWeight: 700 }}>{classInfo.displayStream}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Curriculum</span>
                        <span style={{ fontWeight: 700 }}>8-4-4 / CBC</span>
                      </div>
                    </div>
                  </Card>
                  <Card>
                    <h4 style={{ margin: '0 0 16px', fontWeight: 800 }}>Contact Info</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Parent Phone</span>
                        <span style={{ fontWeight: 700 }}>{localUser.parent_phone}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>Email Alerts</span>
                        <span style={{ fontWeight: 700 }}>Disabled</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span style={{ color: '#64748b' }}>SMS Alerts</span>
                        <span style={{ fontWeight: 700, color: '#10b981' }}>Enabled</span>
                      </div>
                    </div>
                  </Card>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Mobile Navigation */}
      {!isDesktop && (
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, width: '100%', 
          background: '#fff', borderTop: '1px solid #f1f5f9',
          display: 'flex', justifyContent: 'space-around', padding: '12px 0 24px', zIndex: 1000
        }}>
          {[
            { id: 'home', icon: ActivityIcon },
            { id: 'announcements', icon: MessageIcon },
            { id: 'academics', icon: BookIcon },
            { id: 'fees', icon: CardIcon },
            { id: 'profile', icon: UserIcon }
          ].map(tab => (
            <div 
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{ color: activeTab === tab.id ? '#10b981' : '#94a3b8', cursor: 'pointer' }}
            >
              <tab.icon size={24} strokeWidth={activeTab === tab.id ? 2.5 : 2} />
            </div>
          ))}
        </nav>
      )}

      {/* Subject Detail Modal */}
      {selectedSubjectDetail && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(6px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 400, borderRadius: 32, padding: 32, animation: 'fadeIn 0.3s ease-out', position: 'relative' }}>
            <button 
              onClick={() => setSelectedSubjectDetail(null)}
              style={{ position: 'absolute', top: 20, right: 20, background: '#f1f5f9', border: 'none', width: 32, height: 32, borderRadius: 16, cursor: 'pointer', color: '#64748b' }}
            >
              ✕
            </button>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ 
                width: 72, height: 72, borderRadius: 24, background: '#f1f5f9',
                margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981'
              }}>
                <TeacherIcon size={32} />
              </div>
              <h3 style={{ margin: '0 0 4px', fontSize: '1.4rem', fontWeight: 900 }}>{selectedSubjectDetail.subject_name}</h3>
              <p style={{ color: '#64748b', fontWeight: 600 }}>Assigned Teacher</p>
            </div>
            
            <div style={{ background: '#f8fafc', padding: 20, borderRadius: 24, display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
              <div style={{ width: 48, height: 48, borderRadius: 14, background: 'linear-gradient(135deg, #10b981, #3b82f6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '1.2rem' }}>
                {selectedSubjectDetail.teacher_name?.charAt(0) || '?'}
              </div>
              <div>
                <div style={{ fontWeight: 800, color: '#0f172a' }}>{selectedSubjectDetail.teacher_name || 'Not assigned'}</div>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 600 }}>Subject Instructor</div>
              </div>
            </div>

            <button 
              onClick={() => setSelectedSubjectDetail(null)}
              style={{ width: '100%', padding: '16px', borderRadius: '16px', border: 'none', background: '#0f172a', color: '#fff', fontWeight: 800, fontSize: '1rem', cursor: 'pointer' }}
            >
              Close Details
            </button>
          </div>
        </div>
      )}

      {/* M-Pesa Modal */}
      {showMpesaModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(4px)', zIndex: 2000, display: 'flex', alignItems: isDesktop ? 'center' : 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: isDesktop ? 32 : '32px 32px 0 0', padding: '24px 24px 40px', animation: isDesktop ? 'fadeIn 0.3s ease-out' : 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {!isDesktop && <div style={{ width: 48, height: 5, background: '#e2e8f0', borderRadius: 3, margin: '0 auto 24px' }} />}
            <h3 style={{ margin: '0 0 8px', fontSize: '1.4rem', color: '#0f172a', fontWeight: 800 }}>M-Pesa Express</h3>
            <p style={{ margin: '0 0 24px', color: '#64748b', fontSize: '0.95rem' }}>Push an STK prompt to your phone to complete the transaction instantly.</p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <label style={{ fontSize: '0.85rem', fontWeight: 700, color: '#475569', display: 'block', marginBottom: 8 }}>Amount (KES)</label>
                <input 
                  type="number" 
                  value={mpesaAmount} 
                  onChange={(e) => setMpesaAmount(e.target.value)}
                  style={{ width: '100%', padding: '16px', borderRadius: '16px', border: '2px solid #e2e8f0', boxSizing: 'border-box', fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', outline: 'none' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.85rem', fontWeight: 700, color: '#475569', display: 'block', marginBottom: 8 }}>M-Pesa Number</label>
                <input 
                  type="text" 
                  value={mpesaPhone} 
                  onChange={(e) => setMpesaPhone(e.target.value)}
                  placeholder="2547XXXXXXXX"
                  style={{ width: '100%', padding: '16px', borderRadius: '16px', border: '2px solid #e2e8f0', boxSizing: 'border-box', fontSize: '1.1rem', outline: 'none' }}
                />
              </div>
              {mpesaError && <div style={{ color: '#ef4444', fontSize: '0.85rem', marginTop: 4 }}>{mpesaError}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button 
                  onClick={() => setShowMpesaModal(false)}
                  style={{ flex: 1, padding: '16px', borderRadius: '16px', border: 'none', background: '#f1f5f9', color: '#475569', fontWeight: 700, fontSize: '1rem', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button 
                  onClick={handleMpesaPay}
                  disabled={isSTKPushing}
                  style={{ flex: 2, padding: '16px', borderRadius: '16px', border: 'none', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', opacity: isSTKPushing ? 0.7 : 1, boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)' }}
                >
                  {isSTKPushing ? 'Sending Prompt...' : 'Pay Now'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Persistent Mobile Bottom Navigation Bar */}
      {!isDesktop && (
        <div className="mobile-bottom-nav" style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: '#ffffff',
          borderTop: '1px solid #e2e8f0',
          display: 'flex',
          justify: 'space-around',
          alignItems: 'center',
          padding: '8px 0 12px',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.06)',
          zIndex: 999
        }}>
          {[
            { id: 'home', label: t('dashboard', lang), icon: ActivityIcon },
            { id: 'academics', label: t('results', lang), icon: BookIcon },
            { id: 'fees', label: t('fees', lang), icon: CardIcon },
            { id: 'announcements', label: t('announcements', lang), icon: MessageIcon },
            { id: 'profile', label: t('profile', lang), icon: UserIcon }
          ].map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  color: isActive ? '#10b981' : '#94a3b8',
                  fontSize: '0.7rem',
                  fontWeight: isActive ? 800 : 600,
                  cursor: 'pointer',
                  padding: '4px 8px'
                }}
              >
                <tab.icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-pulse {
          animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .5; }
        }
        input:focus {
          border-color: #3b82f6 !important;
        }
        body { margin: 0; }
      `}</style>
    </div>
  );
}
