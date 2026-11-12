/**
 * SuperAdmin — Platform Command Tower (Operational Only)
 *
 * Final overhaul: Removed all financial logic (Money/Revenue/Payments).
 * Focused strictly on school onboarding, feature management, and system health.
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { getAllSchools, getPlatformActivities, getPlatformSettings, getPlatformStats, updatePlatformSetting, restoreSchool, subscribeToPlatformChanges, deleteSchool, deactivateSchool, wipeAllNonAdminSchools, setCurrentSchoolContext, setCurrentPeriodId, getPlatformUsageStats, getGlobalAuditLogs, updateSchoolPlan } from '../../data/coreStore';
import { getTeachersBySchool, getAllSchoolStaff, deleteTeacher } from '../../data/staffStore';

// Components
import Loader          from '../../components/Common/Loader';
import SuperAdminLoader from '../../components/Common/SuperAdminLoader';
import Select           from '../../components/Common/Select';

// Tabs
import OverviewTab        from './tabs/OverviewTab';
import SchoolsTab         from './tabs/SchoolsTab';
import SchoolDetailTab    from './tabs/SchoolDetailTab';
import ActivityTab        from './tabs/ActivityTab';
import SettingsTab        from './tabs/SettingsTab';
import AdminsTab          from './tabs/AdminsTab';
import { CrossIcon } from '../../components/CommonIcons';

// Modals
import ActivateModal    from './modals/ActivateModal';
import RegisterSchoolModal from './modals/RegisterSchoolModal';
import DeleteModal      from './modals/DeleteModal';
import StaffModal       from './modals/StaffModal';
import NEMISExportModal from './modals/NEMISExportModal';
import FeaturesModal    from './modals/FeaturesModal';
import LimitsModal      from './modals/LimitsModal';

// Shared dialog hook
import { useDialog } from '../../contexts/DialogContext';

// Utilities
import {
  useChart, GC, TC, TIP,
  fmtDate, calcExpiry, statusLabel, sPill,
} from './superAdminUtils';
import {
  CheckIcon, AlertIcon, ClockIcon, SchoolIcon,
  CardIcon, RocketIcon, ShieldIcon, SearchIcon, BookIcon, MenuIcon,
} from '../../components/CommonIcons';

// Store additions (NEMIS student fetch)
import { getStudentsBySchool } from '../../data/studentStore';

// Styles — imported once
import './SuperAdmin.css';

// ── Supabase client ─────────────────────
import { supabase } from '../../lib/supabase';

// ══════════════════════════════════════════════════════════════════════════════
export default function SuperAdmin({ currentUser, isPlatformAdmin, sidebarOpen, setSidebarOpen, onSignOut }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'overview';

  // ── Core data state ──────────────────────────────────────────────────────
  const [schools,         setSchools]         = useState([]);
  const [activity,        setActivity]        = useState([]);
  const [auditLogs,       setAuditLogs]       = useState([]);
  const [settings,        setSettings]        = useState({});
  const [pStats,          setPStats]          = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState(null);
  const [message,         setMessage]         = useState(null);

  // ── UI / filter state ────────────────────────────────────────────────────
  const [searchQuery,   setSearchQuery]   = useState('');
  const [periodFilter,  setPeriodFilter]  = useState('monthly');
  const [filterStatus,  setFilterStatus]  = useState('all');
  const [showFilter,    setShowFilter]    = useState(false);

  // ── Modal state ──────────────────────────────────────────────────────────
  const [activateModal,   setActivateModal]   = useState(null);
  const [showRegisterSchool, setShowRegisterSchool] = useState(false);
  const [activationNote,  setActivationNote]  = useState('');
  const [activating,      setActivating]      = useState(false);
  const [activateSuccess, setActivateSuccess] = useState(false);

  const [deleteModal,     setDeleteModal]     = useState(null);
  const [deleting,        setDeleting]        = useState(false);
  const [discoveryMeta,   setDiscoveryMeta]   = useState({ orphans: [], legacy: [] });
  const [staffModal,      setStaffModal]      = useState(null);
  const [loadingStaff,    setLoadingStaff]    = useState(false);
  const [featuresModal,   setFeaturesModal]   = useState(null);
  const [limitsModal,     setLimitsModal]     = useState(null);
  const [selectedSchool,  setSelectedSchool]  = useState(null);

  // ── Settings form state ──────────────────────────────────────────────────
  const [statusMsg,      setStatusMsg]      = useState('');
  const [subEndDate,     setSubEndDate]     = useState('');
  const [smsConfig,      setSmsConfig]      = useState({ senderId: '', apiKey: '' });

  // ── Chart refs ───────────────────────────────────────────────────────────
  const growChartRef = useRef(null);

  const isSuperOwner = isPlatformAdmin;

  // ── Styled dialogs ─────
  const { alert, confirm, prompt } = useDialog();

  // ── NEMIS export modal ────────────────────────────────────────────────────
  const [nemisSchool, setNemisSchool] = useState(null);

  // ══ DATA LOADING ══════════════════════════════════════════════════════
  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      // 1. Platform settings
      try {
        const cf = await getPlatformSettings();
        setSettings(cf || {});
        setStatusMsg(cf?.platform?.status_message || '');
        setSmsConfig(cf?.sms || { senderId: '', apiKey: '' });
        
        const gExp = cf?.billing?.expiry_date || cf?.billing?.term_expiry || '';
        setSubEndDate(gExp);
      } catch (e) {
        console.error('Failed to load platform settings:', e);
      }

      // 2. Parallel data fetches
      const fetch = async (fn, setter, fallback) => {
        try { const r = await fn(); setter(r || fallback); }
        catch (e) { console.warn(`Dashboard partial failure (${fn.name}):`, e); if (fallback !== undefined) setter(fallback); }
      };

      await Promise.all([
        (async () => {
          const rawSchools = await getAllSchools();
          // getAllSchools already returns schools with _studentCount and _staffCount
          const filtered = rawSchools.filter(s => !s.name?.toLowerCase().includes('Termly hq'));
          setSchools(filtered);

        })(),
        fetch(getPlatformActivities, setActivity,      []),
        fetch(getGlobalAuditLogs,    setAuditLogs,     []),
        fetch(getPlatformStats,      setPStats,         null),
      ]);
    } catch (err) {
      console.error('Overall loadData error:', err);
      setError('An unexpected error occurred while loading dashboard data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Ensure we are NOT in shadow mode when in Super Admin dashboard
    sessionStorage.removeItem('Termly_acting_as_admin');
    loadData();
  }, []);

  const setTab = (t) => { setSearchParams({ tab: t }); };

  // ── Auto-dismiss toast after 4 s ─────────────────────────────────────────
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const now            = new Date();
  const thirtyDaysAgo  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo   = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const isSchoolActive = (s) => {
    const nameLower = (s.name || '').toLowerCase();
    const planLower = (s.plan || '').toLowerCase();
    const statusLower = (s.status || '').toLowerCase();

    const profiles = Array.isArray(s.school_profiles) ? s.school_profiles : [];
    const p = profiles[0];

    // Explicit deactivation ALWAYS overrides default plan/HQ rules
    if (statusLower === 'deactivated' || statusLower === 'suspended') return false;
    if (p && (p.subscription_status === 'Deactivated' || p.subscription_status === 'Suspended')) return false;

    const perpetualProfile = profiles.find((prof) => String(prof.license_type || '').toLowerCase() === 'perpetual');
    if (perpetualProfile) {
      return String(perpetualProfile.license_status || '').toLowerCase() === 'active'
        && String(perpetualProfile.subscription_status || '').toLowerCase() === 'active'
        && statusLower === 'active';
    }

    // Termly HQ, Platform Admin, and Sandbox NEVER expire automatically
    if (nameLower.includes('termly hq') || planLower === 'platform admin' || planLower === 'sandbox') return true;

    if (profiles.length === 0) {
      return statusLower === 'active';
    }

    return profiles.some(prof => {
      const pStatus = (prof.subscription_status || '').toLowerCase();
      if (pStatus === 'deactivated' || pStatus === 'suspended') return false;
      if (pStatus === 'sandbox' || (prof.subscription_plan || '').toLowerCase() === 'sandbox') return true;

      // Enforce subscription expiry date if set (applies to Demo & Production)
      if (prof.subscription_expiry) {
        const pExp = new Date(prof.subscription_expiry);
        pExp.setHours(23, 59, 59, 999);
        if (pExp < now) return false;
      }

      if (pStatus === 'active' || pStatus === 'demo' || pStatus === 'trial' || planLower === 'demo') {
        return true;
      }

      return false;
    });
  };

  const activeSchools        = schools.filter(isSchoolActive);
  const deactSchools         = schools.filter(s => {
    const statusLower = (s.status || '').toLowerCase();
    if (statusLower === 'deactivated' || statusLower === 'suspended') return true;
    const profiles = Array.isArray(s.school_profiles) ? s.school_profiles : [];
    return profiles.some(p => p.subscription_status === 'Deactivated' || p.subscription_status === 'Suspended');
  });
  const expiredSchools       = schools.filter(s => !isSchoolActive(s) && !deactSchools.some(d => d.id === s.id));
  const newThisMonth         = schools.filter(s => {
    const d = s.created_at || s.school_profiles?.[0]?.created_at;
    return d && new Date(d) > thirtyDaysAgo;
  });
  const newLastMonth         = schools.filter(s => {
    const d = s.created_at || s.school_profiles?.[0]?.created_at;
    return d && new Date(d) > sixtyDaysAgo && new Date(d) <= thirtyDaysAgo;
  });
  const newActiveThisMonth   = activeSchools.filter(s => {
    const p = s.school_profiles?.[0];
    const d = p?.subscription_start || p?.created_at || s.created_at;
    return d && new Date(d) > thirtyDaysAgo;
  });

  const totalSchools      = schools.length;
  const activeCount       = activeSchools.length;
  const expiredCount      = expiredSchools.length;
  const newSchoolsCount   = newThisMonth.length;
  
  const activeChange      = newActiveThisMonth.length - (activeSchools.filter(s => {
    const p = s.school_profiles?.[0];
    const d = p?.subscription_start || p?.created_at || s.created_at;
    return d && new Date(d) > sixtyDaysAgo && new Date(d) <= thirtyDaysAgo;
  }).length);
  
  const activeChangeTxt   = `${activeChange >= 0 ? '↑' : '↓'} ${Math.abs(activeChange)} this month`;
  const newSchoolsTxt     = `${newThisMonth.length >= newLastMonth.length ? '↑' : '↓'} ${newThisMonth.length} this period`;

  const periodMs     = { weekly: 7*24*60*60*1000, monthly: 30*24*60*60*1000, yearly: 365*24*60*60*1000 };
  const periodCutoff = new Date(now.getTime() - (periodMs[periodFilter] || periodMs.monthly));
  const recentSchools = schools.filter(s => {
    const d = s.created_at || s.school_profiles?.[0]?.created_at;
    return !d || new Date(d) > periodCutoff;
  });

  const q = searchQuery.toLowerCase();
  const filteredSchools = schools.filter(s => {
    const p      = s.school_profiles?.[0] || {};
    const matchQ  = !q || s.name?.toLowerCase().includes(q) || p.location?.toLowerCase().includes(q);
    const matchS  = filterStatus === 'all'
      || (filterStatus === 'active'      && isSchoolActive(s))
      || (filterStatus === 'expired'     && expiredSchools.some(ex => ex.id === s.id))
      || (filterStatus === 'deactivated' && deactSchools.some(de => de.id === s.id));
    return matchQ && matchS;
  });
  const filteredActivity = activity.filter(a =>
    !q || a.description?.toLowerCase().includes(q) || a.school_name?.toLowerCase().includes(q)
  );
  const filteredAuditLogs = auditLogs.filter(log => 
    !q || log.action?.toLowerCase().includes(q) || log.schools?.name?.toLowerCase().includes(q) || log.actor_email?.toLowerCase().includes(q)
  );

  useChart(growChartRef, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 100);
    g.addColorStop(0, 'rgba(13,216,138,0.3)'); g.addColorStop(1, 'rgba(13,216,138,0)');
    const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].slice(0, now.getMonth() + 1);
    let cum = 0;
    const data = labels.map((_, mi) => {
      cum += schools.filter(s => { const d = new Date(s.created_at || s.school_profiles?.[0]?.created_at || 0); return d.getFullYear() === now.getFullYear() && d.getMonth() === mi; }).length;
      return cum;
    });
    return new window.Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor:'#a1a1aa', backgroundColor:g, borderWidth:1.5, fill:true, tension:0.4, pointRadius:0, pointHoverRadius:3 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:TIP }, scales:{ x:{grid:{color:GC},ticks:{color:TC}}, y:{grid:{color:GC},ticks:{color:TC}} } },
    });
  }, [activeTab, schools]);

  const handleUpdateSetting = async (key, value) => {
    try { 
      const newValue = (typeof value === 'object' && value !== null && !Array.isArray(value)) 
        ? { ...(settings[key] || {}), ...value } 
        : value;
      await updatePlatformSetting(key, newValue); 
      setMessage({ type:'success', text:'Settings saved.' }); 
      loadData(); 
    }
    catch (err) { setMessage({ type:'error', text: err.message }); }
  };

  const handleBulkActivate = async () => {
    const ok = await confirm({ title: 'Bulk Activate', message: 'Activate ALL schools and extend their module expiries by 4 months?', confirmText: 'Activate All' });
    if (!ok) return;
    setLoading(true);
    try {
      // Process in sequence to avoid hitting Supabase rate limits
      for (const s of schools) { await restoreSchool(s.id); }
      setMessage({ type: 'success', text: 'All schools activated.' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleBulkDeactivate = async () => {
    const ok = await confirm({ title: 'Bulk Deactivate', message: 'Deactivate ALL schools and lock their features immediately?', confirmText: 'Deactivate All', variant: 'danger' });
    if (!ok) return;
    setLoading(true);
    try {
      for (const s of schools) { await deactivateSchool(s.id); }
      setMessage({ type: 'success', text: 'All schools deactivated.' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmActivate = async () => {
    if (!activateModal) return;
    setActivating(true);
    try {
      await restoreSchool(activateModal.id, 4, activationNote);
      setMessage({ type: 'success', text: `School ${activateModal.name} activated.` });
      setActivateModal(null);
      loadData();
    } catch (err) {
      setMessage({ type:'error', text: err.message || 'Failed to activate school' });
    } finally { setActivating(false); }
  };

  const handleDeactivate = async (schoolId, name) => {
    const ok = await confirm({ title: 'Deactivate School', message: `Are you sure you want to deactivate ${name}? This will lock all their features immediately.`, confirmText: 'Deactivate', variant: 'danger' });
    if (!ok) return;
    const reason = await prompt({ title: 'Deactivation Reason', message: 'Why is this school being deactivated? (Optional)', inputPlaceholder: 'e.g. Non-payment, violation of terms...', confirmText: 'Confirm Deactivation' });
    // Note: If user cancels prompt, it returns null. We still allow empty string but check for null to abort.
    if (reason === null) return;

    try {
      await deactivateSchool(schoolId, reason);
      setMessage({ type: 'success', text: `School ${name} deactivated.` });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleRowDeleteSchool = async (schoolId, name) => {
    const ok = await confirm({ title: 'Terminate School', message: `CRITICAL: This will PERMANENTLY DELETE all data for ${name}. This action cannot be undone.`, confirmText: 'Terminate', variant: 'danger' });
    if (!ok) return;
    try {
      await deleteSchool(schoolId);
      setMessage({ type: 'success', text: `School ${name} terminated.` });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleOpenStaffModal = async (schoolId, name) => {
    setStaffModal({ id: schoolId, name, staff: [] });
    setLoadingStaff(true);
    try {
      const staff = await getAllSchoolStaff(schoolId);
      setStaffModal({ id: schoolId, name, staff: staff || [] });
    } catch (e) {
      console.error('Failed to load staff:', e);
      setMessage({ type: 'error', text: 'Failed to load staff list' });
    } finally {
      setLoadingStaff(false);
    }
  };

  const handleDeleteStaff = async (staffId) => {
    const ok = await confirm({ title: 'Remove Staff', message: 'Remove this staff member from the school?', confirmText: 'Remove', variant: 'danger' });
    if (!ok) return;
    try {
      await deleteTeacher(staffId);
      setStaffModal(prev => ({
        ...prev,
        staff: prev.staff.filter(s => s.id !== staffId)
      }));
      setMessage({ type: 'success', text: 'Staff member removed.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleUpdatePlan = async (schoolId, newPlan) => {
    try {
      await updateSchoolPlan(schoolId, newPlan);
      setMessage({ type: 'success', text: `School account plan updated to ${newPlan}.` });
      loadData();
    } catch (e) {
      console.error('Failed to update plan:', e);
      setMessage({ type: 'error', text: 'Failed to update school plan' });
    }
  };

  const handleWipeSchools = async () => {
    const verify = await prompt({ title: 'NUCLEAR OPTION: WIPE ALL SCHOOLS', message: 'This will DELETE ALL DATA for ALL schools. Only Platform Admin accounts will remain. Type "TERMINATE ALL NON-ADMIN WORKSPACES" to proceed.', inputPlaceholder: 'Type verification string...', inputLabel: 'Security Verification', confirmText: 'EXECUTE WIPE', cancelText: 'ABORT' });
    if (verify !== 'TERMINATE ALL NON-ADMIN WORKSPACES') {
      setMessage({ type:'error', text:'Wipe aborted. Verification failed.' });
      return;
    }
    try {
      setMessage({ type:'info', text:'Commencing platform-wide cleanup...' });
      const result = await wipeAllNonAdminSchools();
      setMessage({ type:'success', text:`Wipe complete. Removed ${result.totalDeleted} school(s).` });
      loadData();
    } catch (err) { setMessage({ type:'error', text: err.message }); }
  };

  const handleLoginAs = async (school) => {
    try {
      const { data: shadowCheck, error: shadowErr } = await supabase.functions.invoke('validate-shadow-session');
      if (shadowErr || !shadowCheck?.isValid) throw new Error('Shadow mode access denied.');
      const { data: period } = await supabase.from('academic_periods').select('id').eq('school_id', school.id).eq('is_active', true).maybeSingle();
      setCurrentSchoolContext(school.id, currentUser);
      if (period) setCurrentPeriodId(period.id);
      sessionStorage.setItem('Termly_school_id', school.id);
      if (period) sessionStorage.setItem('Termly_period_id', period.id);
      sessionStorage.setItem('Termly_acting_as_admin', 'true');
      window.location.href = '/dashboard';
    } catch (err) { setMessage({ type: 'error', text: 'Login As failed: ' + err.message }); }
  };

  const commonProps = {
    searchQuery, filteredSchools, filteredActivity,
    activeSchools, schools, settings, totalSchools, activeCount, expiredCount,
    newSchoolsCount, pStats,
    newSchoolsTxt, activeChangeTxt,
    recentSchools, expiredSchools, isSchoolActive,
    showFilter, setShowFilter, filterStatus, setFilterStatus,
    periodFilter, setPeriodFilter,
  };

  if (!isSuperOwner) return <div className="flex-center" style={{ minHeight:'100vh' }}>Access Restricted</div>;

  const navItems = [
    { id:'overview',      cls:'ni-v', label:'Dashboard',       icon: <CardIcon size={15} /> },
    { id:'schools',       cls:'ni-t', label:'Schools',         icon: <SchoolIcon size={15} /> },
    { id:'admins',        cls:'ni-s', label:'Admins',          icon: <ShieldIcon size={15} /> },
    { id:'activity',      cls:'ni-t', label:'Audit Log',       icon: <ClockIcon size={15} /> },
    { id:'config',        cls:'ni-d', label:'System Settings', icon: <ShieldIcon size={15} /> },
  ];

  return (
    <div className="sa-root">
      <div className={`sa-overlay${sidebarOpen ? ' show' : ''}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sa-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sb-brand">
          <div className="sb-logo"><div className="sb-logo-grid"><span></span><span></span><span></span><span></span></div></div>
          <div className="sb-brand-txt"><div className="sb-name">Termly</div><div className="sb-tag">COMMAND CENTER</div></div>
          <button className="sa-close-btn" onClick={() => setSidebarOpen(false)}><CrossIcon size={14} /></button>
        </div>
        <nav style={{ flex:1, padding:'8px 0 16px' }}>
          <div className="sidebar-sec-lbl">OPERATIONS</div>
          {navItems.map(item => (
            <button key={item.id} className={`sb-nav${activeTab === item.id ? ' on' : ''}`} onClick={() => { setTab(item.id); }}>
              <div className={`nav-ico ${item.cls}`}>{item.icon}</div>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sb-footer">
          <div className="sb-status-card">
            <div className="sb-status-row"><span className="sb-status-label">Status</span><div className="sb-status-live"><span className="sa-dot" /> Live</div></div>
            <div className="sb-status-name">{currentUser?.name || 'Administrator'}</div>
          </div>
          <button className="sb-signout-btn" onClick={onSignOut}>Sign Out</button>
        </div>
      </aside>

      <div className="sa-main">
        <div className="sa-topbar">
          <button className="sa-menu-btn" onClick={() => setSidebarOpen(o => !o)}><MenuIcon size={18} /></button>
          <div className="sa-search-wrap">
            <SearchIcon size={14} />
            <input type="text" placeholder="Search schools, activity..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            {searchQuery && <span className="sa-search-clear" onClick={() => setSearchQuery('')}><CrossIcon size={14} /></span>}
          </div>
          <div className="sa-topbar-user" style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingLeft: 12, borderLeft: '1px solid var(--edge)' }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: 'rgba(99, 102, 241, 0.15)',
              border: '1px solid rgba(99, 102, 241, 0.3)', color: '#c7d2fe',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.8rem'
            }}>
              {currentUser?.email?.[0]?.toUpperCase() || 'A'}
            </div>
            <div className="sa-user-info-text" style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
                {currentUser?.name || 'Super Admin'}
              </span>
              <span style={{ fontSize: '0.62rem', color: 'var(--sub)', lineHeight: 1.2 }}>
                {currentUser?.email || 'shulesoft8@gmail.com'}
              </span>
            </div>
          </div>
        </div>

        <div className="sa-content" style={{ background: '#050505' }}>
          <div className="sa">
            {message && <div className={`toast ${message.type === 'success' ? 'toast-ok' : 'toast-err'}`}> {message.text} </div>}
            {loading ? <SuperAdminLoader /> : (
              <>
                {activeTab === 'overview' && <OverviewTab {...commonProps} growChartRef={growChartRef} />}
                {activeTab === 'schools' && (
                  selectedSchool ? (
                    <SchoolDetailTab 
                      school={selectedSchool} 
                      onBack={() => setSelectedSchool(null)} 
                      setActivateModal={setActivateModal}
                      handleRowDeleteSchool={handleRowDeleteSchool}
                    />
                  ) : (
                    <SchoolsTab 
                      {...commonProps} 
                      handleDeactivate={handleDeactivate} 
                      handleRowDeleteSchool={handleRowDeleteSchool} 
                      setActivateModal={setActivateModal} 
                      setActivationNote={setActivationNote} 
                      setActivateSuccess={setActivateSuccess} 
                      setFeaturesModal={setFeaturesModal} 
                      onNEMISExport={setNemisSchool} 
                      handleLoginAs={handleLoginAs} 
                      handleBulkActivate={handleBulkActivate} 
                      handleBulkDeactivate={handleBulkDeactivate} 
                      handleOpenStaffModal={handleOpenStaffModal}
                      onSelectSchool={setSelectedSchool}
                      onUpdatePlan={handleUpdatePlan}
                      onOpenLimitsModal={(school) => setLimitsModal(school)}
                      onOpenRegisterSchool={() => setShowRegisterSchool(true)}
                    />
                  )
                )}
                {activeTab === 'admins' && <AdminsTab />}
                {activeTab === 'activity' && <ActivityTab filteredActivity={filteredActivity} filteredAuditLogs={filteredAuditLogs} />}
                {activeTab === 'config' && <SettingsTab statusMsg={statusMsg} setStatusMsg={setStatusMsg} subEndDate={subEndDate} setSubEndDate={setSubEndDate} smsConfig={smsConfig} setSmsConfig={setSmsConfig} handleUpdateSetting={handleUpdateSetting} updatePlatformSetting={updatePlatformSetting} loadData={loadData} setMessage={setMessage} onWipeSchools={handleWipeSchools} />}
                <div style={{ padding:'24px 0 6px', textAlign:'center', opacity:.2, borderTop:'1px solid var(--edge)', marginTop:20 }}>
                  <div style={{ fontFamily:'var(--fh)', fontSize:'.65rem', color:'var(--sub)' }}>Termly Platform Engine · {now.getFullYear()}</div>
                </div>
              </>
            )}

            <ActivateModal activateModal={activateModal} setActivateModal={setActivateModal} activationNote={activationNote} setActivationNote={setActivationNote} activating={activating} activateSuccess={activateSuccess} handleConfirmActivate={handleConfirmActivate} />
            <RegisterSchoolModal open={showRegisterSchool} onClose={() => setShowRegisterSchool(false)} onRegistered={loadData} />
            <FeaturesModal school={featuresModal} onClose={() => { setFeaturesModal(null); loadData(); }} setMessage={setMessage} />
            <LimitsModal school={limitsModal} onClose={() => setLimitsModal(null)} onUpdated={loadData} setMessage={setMessage} />
            <DeleteModal deleteModal={deleteModal} setDeleteModal={setDeleteModal} deleting={deleting} handleDeleteSchool={handleRowDeleteSchool} />
            <StaffModal 
              staffModal={staffModal} 
              setStaffModal={setStaffModal} 
              loadingStaff={loadingStaff} 
              handleDeleteStaff={handleDeleteStaff} 
            />
            <NEMISExportModal school={nemisSchool} onClose={() => setNemisSchool(null)} getStudentsBySchool={getStudentsBySchool} />
          </div>
        </div>
      </div>
    </div>
  );
}
