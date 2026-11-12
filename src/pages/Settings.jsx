import { useState, useEffect, useRef } from 'react';
import { getSchoolProfile, refreshSchoolProfile, saveSchoolProfile, importData, exportData, getCurrentAuthUser, getCurrentPeriodId, getPortalAccessSettings, updatePortalAccessSettings } from '../data/coreStore';
import { applyFeeStructure, getPeriods, createPeriod, setActivePeriod, subscribeToTable } from '../data/academicsStore';
import { testMpesaConnection } from '../data/financeStore';
import { testSmsConnection } from '../data/smsStore';
import { supabase } from '../lib/supabase';
import { TERM_FEE } from '../data/seedData';
import { getUserRole } from '../data/authStore';
import { getExams, createExam, deleteExam, deleteAllExams, previewClassPromotion, promoteClasses, updateExam, releaseExamToParents } from '../data/academicsStore';
import { CBC_STRUCTURE, JSS_RUBRIC_8, PRIMARY_RUBRIC_4 } from '../data/seedData';
import Select from '../components/Common/Select';
import { Helmet } from 'react-helmet-async';
import { useDialog } from '../contexts/DialogContext';
import { useFeature } from '../contexts/FeaturesContext';
import Cropper from 'react-easy-crop';
import getCroppedImg from '../utils/cropImage';
import ImageUploadField from '../components/Common/ImageUploadField';
import PerpetualLicensePanel from '../components/settings/PerpetualLicensePanel';
import SchoolHostedMaintenancePanel from '../components/settings/SchoolHostedMaintenancePanel';
import SchoolHostedHealthPanel from '../components/settings/SchoolHostedHealthPanel';
import { uploadSchoolLogo } from '../lib/storageHelpers';
import {
  ClockIcon, CheckIcon, SaveIcon, SchoolIcon, ImageIcon, FolderIcon,
  BookIcon, CardIcon, DiamondIcon, PhoneIcon, RefreshIcon, CrossIcon, PlusIcon,
  CalendarIcon, DownloadIcon, UploadIcon, PlatformZapIcon, ShieldIcon,
  EyeIcon, EyeOffIcon, RocketIcon
} from '../components/CommonIcons';

export default function Settings() {
  const { alert, confirm } = useDialog();
  const { enabled: teacherPortalEnabled } = useFeature('teacher_portal');
  const { enabled: parentPortalEnabled } = useFeature('parent_portal');
  const { enabled: attendanceEnabled } = useFeature('attendance');
  const { enabled: feesEnabled } = useFeature('fees');
  const { enabled: gradingEnabled } = useFeature('grading');
  const { enabled: mpesaEnabled } = useFeature('mpesa');
  const { enabled: smsEnabled } = useFeature('communications');
  const [profile, setProfile] = useState({
    schoolName:'',motto:'',phone:'',email:'',address:'',
    logo:'',subscriptionPlan:'Pro',
    activeClasses:[],gradeFees:{},streamsPerClass:{},customSubjects:{},
    mpesa_config: { shortcode: '', consumer_key: '', consumer_secret: '' },
    sms_config: { sender_id: '', api_key: '' },
    custom_exams:[], timetable_label:'',
    gradingMode: 'percentage', // 'percentage' or 'rubric'
    rubricDescriptions: { 1: 'Below Expectation', 2: 'Approaching Expectation', 3: 'Meeting Expectation', 4: 'Exceeding Expectation' }
  });
  const [saved,setSaved]       = useState(false);
  const [loading,setLoading]   = useState(false);
  const [logoPreview,setLogoPreview] = useState('');
  
  // Crop state
  const [cropImageSrc, setCropImageSrc] = useState(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [isCropping, setIsCropping] = useState(false);

  const [activeLevel,setActiveLevel] = useState('Upper Primary');
  const [newSubject,setNewSubject]   = useState('');
  const [newStream,setNewStream]     = useState({});
  const [newHouse,setNewHouse]       = useState('');
  const [newExam, setNewExam]       = useState('');
  const [newGradeItem, setNewGradeItem] = useState({ symbol: '', min: 0, max: 100, color: '#3b82f6' });
  const [applyGradingToAll, setApplyGradingToAll] = useState(true);
  const [periods, setPeriods]     = useState([]);
  const [newPeriod, setNewPeriod] = useState({ year: new Date().getFullYear(), term: 'Term 1' });
  const [testingMpesa, setTestingMpesa] = useState(false);
  const [testingSms, setTestingSms] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [robustExams, setRobustExams] = useState([]);
  const [promotionPreview, setPromotionPreview] = useState(null);
  const [promotionLoading, setPromotionLoading] = useState(false);
  const [promotionConfirmText, setPromotionConfirmText] = useState('');
  const [showPromotionModal, setShowPromotionModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportSelection, setExportSelection] = useState({
    students: true,
    teachers: true,
    fees: true,
    payments: true,
    marks: true,
    timetable: true,
    announcements: true
  });
  const [portalSettings, setPortalSettings] = useState(null);
  const [portalSaving, setPortalSaving] = useState(false);
  const [showMpesaKey, setShowMpesaKey] = useState(false);
  const [showMpesaSec, setShowMpesaSec] = useState(false);
  const [showSmsKey, setShowSmsKey] = useState(false);
  const fileRef   = useRef(null);
  const backupRef = useRef(null);

  useEffect(()=>{
    (async()=>{
      try{
        const p=await getSchoolProfile();
        if(!p.customSubjects)  p.customSubjects={};
        if(!p.streamsPerClass) p.streamsPerClass={};
        setProfile(p); setLogoPreview(p.logo||'');
        
        const per = await getPeriods();
        setPeriods(per);

        const ex = await getExams();
        const ps = await getPortalAccessSettings();
        if (ps) setPortalSettings(ps);
        setRobustExams(ex);

        const authUser = await getCurrentAuthUser();
        if (authUser) {
          const userData = await getUserRole(authUser.id);
          setIsAdmin(['admin', 'owner'].includes(String(userData?.role || '').toLowerCase()));
        }
      }catch(e){console.error(e);}
    })();
  },[]);

  useEffect(() => {
    // Realtime Exam Sync
    const unsubExams = subscribeToTable('exams', () => {
      getExams().then(setRobustExams).catch(console.error);
    });
    return () => unsubExams();
  }, []);

  const handleSave=async(e)=>{
    if(e)e.preventDefault(); setLoading(true);
    // Sanitize negative values from configuration
    const sanitizedProfile = { ...profile };
    if (sanitizedProfile.gradingSystems) {
      Object.keys(sanitizedProfile.gradingSystems).forEach(lv => {
        sanitizedProfile.gradingSystems[lv] = sanitizedProfile.gradingSystems[lv].map(g => ({
          ...g,
          min: Math.max(0, Math.min(100, g.min)),
          max: Math.max(0, Math.min(100, g.max))
        }));
      });
    }
    if (sanitizedProfile.gradeFees) {
      Object.keys(sanitizedProfile.gradeFees).forEach(g => {
        if (typeof sanitizedProfile.gradeFees[g] === 'object') {
          sanitizedProfile.gradeFees[g].day = Math.max(0, sanitizedProfile.gradeFees[g].day);
          sanitizedProfile.gradeFees[g].boarding = Math.max(0, sanitizedProfile.gradeFees[g].boarding || 0);
        } else {
          sanitizedProfile.gradeFees[g] = Math.max(0, sanitizedProfile.gradeFees[g]);
        }
      });
    }

    try {
      const result = await saveSchoolProfile(sanitizedProfile);
      if (result?.skipped?.length) {
        setSaved(false);
        alert({ title: 'Partially Saved', message: 'Some settings were not stored because the database is missing these columns: ' + result.skipped.join(', ') + '. Apply the required schema migration before relying on those settings.', variant: 'warning' });
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (err) { alert({ title: 'Save Error', message: err.message, variant: 'danger' }); }
    finally { setLoading(false); }
  };
  const handleChange=(e)=>{const{name,value}=e.target;setProfile(p=>({...p,[name]:value}));setSaved(false);};
  const handleLogoUpload=(e)=>{
    const f=e.target.files[0];if(!f)return;
    if(f.size>2097152){alert({ title: 'Upload Limit', message: 'Logo file is too large. Max size is 2MB.', variant: 'warning' });return;}
    const r=new FileReader();
    r.onload=ev=>{
      setCropImageSrc(ev.target.result);
      setIsCropping(true);
      // Reset input so the same file can be selected again if cancelled
      if (fileRef.current) fileRef.current.value = '';
    };
    r.readAsDataURL(f);
  };
  
  const handleCropComplete = (croppedArea, croppedAreaPixels) => {
    setCroppedAreaPixels(croppedAreaPixels);
  };

  const handleCropSave = async () => {
    try {
      const croppedImage = await getCroppedImg(cropImageSrc, croppedAreaPixels);
      setLogoPreview(croppedImage);
      setProfile(p=>({...p,logo:croppedImage}));
      setSaved(false);
      setIsCropping(false);
      setCropImageSrc(null);
    } catch (e) {
      console.error(e);
      alert({ title: 'Crop Error', message: 'Failed to crop image.', variant: 'danger' });
    }
  };

  const handleCropCancel = () => {
    setIsCropping(false);
    setCropImageSrc(null);
  };
  const handleRemoveLogo = () => {
    setLogoPreview('');
    setProfile(p => ({...p, logo: null, logoUrl: null}));
    setSaved(false);
  };
  const toggleGrade=(g)=>{
    let nc=[...(profile.activeClasses||[])];
    if(nc.includes(g))nc=nc.filter(c=>c!==g);else nc.push(g);
    setProfile({...profile,activeClasses:nc});
  };
  const getLevelSubjects = (lv) => {
    if (profile.customSubjects?.[lv]) return profile.customSubjects[lv];
    const defaultSubs = CBC_STRUCTURE[lv].subjects;
    if (Array.isArray(defaultSubs)) return defaultSubs;
    // Senior Secondary - Flatten all pathways for management
    return [...new Set(Object.values(defaultSubs).flat())];
  };

  const addSubject=(lv)=>{
    if(!newSubject.trim())return;
    const cur=getLevelSubjects(lv);
    if(cur.includes(newSubject.trim()))return;
    setProfile({...profile,customSubjects:{...profile.customSubjects,[lv]:[...cur,newSubject.trim()]}});
    setNewSubject('');
  };
  const removeSubject=(lv,sub)=>{
    const cur=getLevelSubjects(lv);
    setProfile({...profile,customSubjects:{...profile.customSubjects,[lv]:cur.filter(s=>s!==sub)}});
  };
  const resetSubjects=async(lv)=>{
    if(!await confirm({ title: 'Reset Subjects', message: `Reset ${lv} subjects to defaults?`, variant: 'warning' }))return;
    const newCustom = { ...profile.customSubjects };
    delete newCustom[lv];
    setProfile({...profile,customSubjects:newCustom});
  };
  const addStream=(grade)=>{
    const val=(newStream[grade]||'').trim();if(!val)return;
    const cur=profile.streamsPerClass?.[grade]||[];
    if(cur.includes(val))return;
    setProfile({...profile,streamsPerClass:{...profile.streamsPerClass,[grade]:[...cur,val]}});
    setNewStream({...newStream,[grade]:''});
  };
  const removeStream=(grade,stream)=>{
    const cur=profile.streamsPerClass?.[grade]||[];
    setProfile({...profile,streamsPerClass:{...profile.streamsPerClass,[grade]:cur.filter(s=>s!==stream)}});
  };
  const addHouse=()=>{
    const val=newHouse.trim();if(!val)return;
    const cur=profile.boardingHouses||[];
    if(cur.includes(val))return;
    setProfile({...profile,boardingHouses:[...cur,val]});
    setNewHouse('');setSaved(false);
  };
  const removeHouse=(house)=>{
    const cur=profile.boardingHouses||[];
    setProfile({...profile,boardingHouses:cur.filter(h=>h!==house)});setSaved(false);
  };
  const handleFeeChange=(grade,type,val)=>{
    const current = profile.gradeFees?.[grade] || {};
    const updated = typeof current === 'object' ? { ...current, [type]: Number(val) } : { day: Number(current), [type]: Number(val) };
    setProfile({...profile,gradeFees:{...profile.gradeFees,[grade]:updated}});setSaved(false);
  };
  const handleTermFeeChange = (grade, termKey, type, val) => {
    const current = profile.gradeFees?.[grade] || {};
    const numVal = Math.max(0, Number(val) || 0);
    const currentTermObj = (typeof current === 'object' && current[termKey]) ? current[termKey] : {};
    const updatedTermObj = { ...currentTermObj, [type]: numVal };

    const updatedGrade = typeof current === 'object'
      ? {
          ...current,
          [type]: termKey === 'Term 1' ? numVal : (current[type] ?? 0),
          [termKey]: updatedTermObj
        }
      : {
          day: termKey === 'Term 1' && type === 'day' ? numVal : (Number(current) || 0),
          boarding: termKey === 'Term 1' && type === 'boarding' ? numVal : 0,
          [termKey]: updatedTermObj
        };

    setProfile({ ...profile, gradeFees: { ...profile.gradeFees, [grade]: updatedGrade } });
    setSaved(false);
  };
  const copyTerm1ToAll = (grade) => {
    const current = profile.gradeFees?.[grade] || {};
    const term1Obj = (typeof current === 'object' && current['Term 1']) 
      ? current['Term 1'] 
      : { day: typeof current === 'object' ? (current.day || 0) : Number(current) || 0, boarding: typeof current === 'object' ? (current.boarding || 0) : 0 };

    const updatedGrade = {
      ...(typeof current === 'object' ? current : { day: Number(current) || 0, boarding: 0 }),
      'Term 1': { ...term1Obj },
      'Term 2': { ...term1Obj },
      'Term 3': { ...term1Obj }
    };

    setProfile({ ...profile, gradeFees: { ...profile.gradeFees, [grade]: updatedGrade } });
    setSaved(false);
  };
  const runFeeApplication=async()=>{
    setLoading(true);
    try{await saveSchoolProfile(profile);await applyFeeStructure();alert({ title: 'Success', message: 'Fee structure applied to students.', variant: 'success' });}
    catch(err){alert({ title: 'Application Error', message: err.message, variant: 'danger' });}finally{setLoading(false);}
  };
  const addExam=async()=>{
    const val=newExam.trim();if(!val)return;
    const cur=robustExams.map(e => e.name);
    if(cur.includes(val))return;
    
    setLoading(true);
    try {
      const periodId = getCurrentPeriodId() || '2026';
      const status = 'draft';
      const created = await createExam(val, 'endterm', periodId, status);
      setRobustExams([...robustExams, created]);
      setNewExam('');
    } catch(err) {
      alert({ title: 'Error', message: err.message, variant: 'danger' });
    } finally {
      setLoading(false);
    }
  };
  const removeExam=async(examName)=>{
    const exam = robustExams.find(e => e.name === examName);
    if (!exam) return;
    
    if (await confirm({ title: 'Delete Exam?', message: `Are you sure you want to delete "${examName}"? This will remove all associated marks.`, variant: 'danger' })) {
      setLoading(true);
      try {
        await deleteExam(exam.id);
        setRobustExams(robustExams.filter(e => e.id !== exam.id));
      } catch(err) {
        alert({ title: 'Error', message: err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };
  const handleClearAllExams = async () => {
    if (await confirm({ 
      title: 'Clear All Exams?', 
      message: 'This will permanently delete ALL exams and their marks for this school. This cannot be undone. Are you sure you want a clean slate?', 
      variant: 'danger' 
    })) {
      setLoading(true);
      try {
        await deleteAllExams();
        setRobustExams([]);
        alert({ title: 'Success', message: 'All exams have been cleared.', variant: 'success' });
      } catch(err) {
        alert({ title: 'Error', message: err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };
  const toggleExamStatus = async (exam) => {
    const newStatus = exam.status === 'published' ? 'draft' : 'published';
    setLoading(true);
    try {
      await updateExam(exam.id, { status: newStatus });
      setRobustExams(robustExams.map(e => e.id === exam.id ? { ...e, status: newStatus } : e));
    } catch (err) {
      alert({ title: 'Error', message: err.message, variant: 'danger' });
    } finally {
      setLoading(false);
    }
  };
  const handleReleaseToggle = async (examId, isReleased) => {
    setLoading(true);
    try {
      await releaseExamToParents(examId, isReleased);
      setRobustExams(robustExams.map(e => e.id === examId ? { ...e, released_to_parents: isReleased } : e));
    } catch (err) {
      alert({ title: 'Error', message: err.message, variant: 'danger' });
    } finally {
      setLoading(false);
    }
  };
  const addGradeItem=()=>{
    if(!newGradeItem.symbol) return;
    if(newGradeItem.min >= newGradeItem.max) {
      alert({ title: 'Invalid Range', message: 'Min value must be less than max value.', variant: 'warning' });
      return;
    }
    if (applyGradingToAll) {
      const newSystems = { ...profile.gradingSystems };
      Object.keys(CBC_STRUCTURE).forEach(lv => {
        const cur = newSystems[lv] || profile.gradingSystems?.default || [];
        newSystems[lv] = [...cur, { ...newGradeItem }].sort((a,b) => b.min - a.min);
      });
      setProfile({ ...profile, gradingSystems: newSystems });
    } else {
      const cur = profile.gradingSystems?.[activeLevel] || profile.gradingSystems?.default || [];
      setProfile({
        ...profile,
        gradingSystems: {
          ...profile.gradingSystems,
          [activeLevel]: [...cur, { ...newGradeItem }].sort((a,b) => b.min - a.min)
        }
      });
    }
    setNewGradeItem({ symbol: '', min: 0, max: 100, color: '#3b82f6' });setSaved(false);
  };
  const removeGradeItem=(idx)=>{
    const cur = profile.gradingSystems?.[activeLevel] || [];
    setProfile({...profile, gradingSystems: {...profile.gradingSystems, [activeLevel]: cur.filter((_,i)=>i!==idx)}});
    setSaved(false);
  };
  const resetGrading=async()=>{
    if(!await confirm({ title: 'Reset Grading', message: `Reset ${activeLevel} grading to standard defaults?`, variant: 'warning' }))return;
    let standard = [];
    if (activeLevel === 'Junior Secondary') {
      standard = JSS_RUBRIC_8;
    } else if (activeLevel.includes('Primary') || activeLevel === 'Early Years') {
      standard = PRIMARY_RUBRIC_4;
    } else {
      // Default A-E Scale
      standard = [
        { symbol: 'A', min: 80, max: 100, color: '#16a34a' },
        { symbol: 'B', min: 65, max: 79, color: '#3b82f6' },
        { symbol: 'C', min: 50, max: 64, color: '#eab308' },
        { symbol: 'D', min: 35, max: 49, color: '#f97316' },
        { symbol: 'E', min: 0, max: 34, color: '#dc2626' },
      ];
    }
    setProfile({
      ...profile, 
      gradingSystems: { ...profile.gradingSystems, [activeLevel]: standard },
      gradingMode: (activeLevel.includes('Secondary') && activeLevel !== 'Junior Secondary') ? 'percentage' : 'rubric'
    }); 
    setSaved(false);
  };
  const updateRubric = (point, val) => {
    setProfile({
      ...profile,
      rubricDescriptions: { ...profile.rubricDescriptions, [point]: val }
    });
    setSaved(false);
  };
  const handleAddPeriod = async () => {
    setLoading(true);
    try {
      const existingYears = (periods || []).map(p => Number(p.year));
      const maxYear = Math.max(...existingYears, 0);

      await createPeriod(newPeriod.year, newPeriod.term);
      const per = await getPeriods();
      setPeriods(per);

      if (Number(newPeriod.year) > maxYear && maxYear > 0) {
        if (await confirm({ 
          title: 'New Academic Year', 
          message: `You've started ${newPeriod.year}. Would you like to promote students from ${maxYear} to the next grade level?`,
          variant: 'primary'
        })) {
          handlePreviewPromotion(maxYear, Number(newPeriod.year));
        }
      }
    } catch (err) { alert({ title: 'Configuration Error', message: err.message, variant: 'danger' }); }
    finally { setLoading(false); }
  };
  const handleSetActivePeriod = async (id) => {
    setLoading(true);
    try {
      await setActivePeriod(id);
      const per = await getPeriods();
      setPeriods(per);
    } catch (err) { alert({ title: 'Period Error', message: err.message, variant: 'danger' }); }
    finally { setLoading(false); }
  };

  const handleTestMpesa = async () => {
    setTestingMpesa(true);
    try {
      const res = await testMpesaConnection(profile.mpesa_config);
      alert({ title: 'Connection Test', message: res.message, variant: res.success ? 'success' : 'danger' });
    } finally { setTestingMpesa(false); }
  };

  const handleTestSms = async () => {
    setTestingSms(true);
    try {
      const res = await testSmsConnection(profile.sms_config);
      alert({ title: 'Connection Test', message: res.message, variant: res.success ? 'success' : 'danger' });
    } finally { setTestingSms(false); }
  };

  const handlePreviewPromotion = async (fYear, tYear) => {
    const fromYear = fYear || new Date().getFullYear();
    const toYear = tYear || (fromYear + 1);
    
    setPromotionLoading(true);
    try {
      const preview = await previewClassPromotion(fromYear, toYear);
      setPromotionPreview({ ...preview, fromYear, toYear });
      setShowPromotionModal(true);
      setPromotionConfirmText('');
    } catch (err) {
      alert({ title: 'Preview Error', message: err.message, variant: 'danger' });
    } finally {
      setPromotionLoading(false);
    }
  };

  const handleConfirmPromotion = async () => {
    const { fromYear, toYear } = promotionPreview;
    if (promotionConfirmText !== `PROMOTE ${fromYear}`) {
      alert({ title: 'Invalid Confirmation', message: `Please type exactly 'PROMOTE ${fromYear}'`, variant: 'warning' });
      return;
    }
    setPromotionLoading(true);
    try {
      const res = await promoteClasses(fromYear, toYear);
      setShowPromotionModal(false);
      alert({ title: 'Promotion Complete', message: `Successfully promoted ${res.promotedStreams} streams and graduated ${res.graduatedStudents} students to ${toYear}.`, variant: 'success' });
    } catch (err) {
      alert({ title: 'Promotion Error', message: err.message, variant: 'danger' });
    } finally {
      setPromotionLoading(false);
    }
  };

  const levels=Object.keys(CBC_STRUCTURE);

  /* shared styles */
  const sectionBox={background:'var(--bg)',borderRadius:12,padding:18,border:'1px solid var(--border)'};
  const levelBtn=(lv)=>({
    padding:'6px 14px',borderRadius:8,border:'none',fontFamily:'inherit',fontSize:'0.8rem',
    fontWeight:activeLevel===lv?700:500,cursor:'pointer',transition:'all 0.15s',whiteSpace:'nowrap',
    background:activeLevel===lv?'var(--bg-card)':'transparent',
    color:activeLevel===lv?'var(--primary)':'var(--text-light)',
    boxShadow:activeLevel===lv?'0 1px 5px rgba(0,0,0,0.08)':'none',
  });

  return (
    <div className="animate-in">
      <Helmet>
        <title>School Settings & Configuration | Termly — System Admin</title>
        <meta name="description" content="Configure school identity, academic structures, grading systems, and gateway integrations." />
      </Helmet>
      {/* Header */}
      <div className="page-header">
        <div className="page-header-actions">
          <div>
            <h2>Settings</h2>
            <p>School identity, academic structure, and system configuration</p>
          </div>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? <ClockIcon size={14} /> : saved ? <CheckIcon size={14} /> : <SaveIcon size={14} />}
            {loading ? ' Saving…' : saved ? ' Saved!' : ' Save Settings'}
          </button>
        </div>
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 24 }}>
          <PerpetualLicensePanel
            profile={profile}
            isAdmin={isAdmin}
            onActivated={async () => {
              const refreshed = await refreshSchoolProfile();
              if (refreshed) setProfile((current) => ({ ...current, ...refreshed }));
              window.dispatchEvent(new Event('schoolProfileChanged'));
            }}
          />
        </div>
      )}

      {isAdmin && <SchoolHostedMaintenancePanel profile={profile} />}
      {isAdmin && <SchoolHostedHealthPanel />}

      <div style={{display:'flex',flexDirection:'column',gap:24}}>

        {/* Identity & Branding */}
        <div className="responsive-grid-stack">

          {/* Identity */}
          <div className="card">
            <div className="card-header"><h3><SchoolIcon size={20} /> School Identity</h3></div>
            <div className="card-body">
              <div className="form-group"><label>School Name</label><input className="form-input" name="schoolName" value={profile.schoolName} onChange={handleChange} placeholder="e.g. Greenfield Academy"/></div>
              <div className="form-group"><label>School Motto</label><input className="form-input" name="motto" value={profile.motto} onChange={handleChange} placeholder="Excellence in Education"/></div>
              <div className="form-group">
                <label>School Type / Categorization</label>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  {['Day', 'Boarding', 'Mixed'].map(type => (
                    <button 
                      key={type} 
                      type="button"
                      onClick={() => setProfile({ ...profile, schoolType: type })}
                      style={{
                        flex: 1, padding: '8px', fontSize: '0.8rem', borderRadius: 8, border: '1.5px solid',
                        fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                        borderColor: profile.schoolType === type ? 'var(--primary)' : 'var(--border)',
                        background: profile.schoolType === type ? 'var(--primary-light)' : 'var(--bg)',
                        color: profile.schoolType === type ? 'var(--primary)' : 'var(--text-light)'
                      }}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Phone</label><input className="form-input" name="phone" value={profile.phone} onChange={handleChange} placeholder="07xx xxx xxx"/></div>
                <div className="form-group"><label>Email</label><input className="form-input" name="email" value={profile.email} onChange={handleChange} placeholder="admin@school.com"/></div>
              </div>
              <div className="form-group"><label>Location</label><input className="form-input" name="address" value={profile.address} onChange={handleChange} placeholder="Nairobi, Kenya"/></div>
            </div>
          </div>

          {/* Logo */}
          <div className="card">
            <div className="card-header"><h3><ImageIcon size={20} /> Visual Identity</h3></div>
            <div className="card-body">
              <ImageUploadField
                value={logoPreview}
                mode="logo"
                label="School Logo / Crest"
                shape="rectangle"
                size={120}
                maxSizeBytes={2 * 1024 * 1024}
                placeholderIcon={<SchoolIcon size={36} />}
                helperText="PNG, JPG or WebP (max 2MB). Preserves wordmark width and transparency."
                onChange={async ({ dataUrl, blob, remove }) => {
                  if (remove) {
                    handleRemoveLogo();
                    return;
                  }
                  try {
                    setLogoPreview(dataUrl);
                    let finalUrl = dataUrl;
                    const schoolId = profile.school_id || profile.schoolId;
                    if (schoolId && blob) {
                      try {
                        const res = await uploadSchoolLogo({
                          schoolId,
                          fileOrBlob: blob,
                          oldLogoUrl: profile.logo || profile.logoUrl
                        });
                        if (res?.logoUrl) finalUrl = res.logoUrl;
                      } catch (uploadErr) {
                        console.warn('Falling back to local data URL for logo:', uploadErr);
                      }
                    }
                    setProfile(p => ({ ...p, logo: finalUrl, logoUrl: finalUrl }));
                    setSaved(false);
                  } catch (err) {
                    alert({ title: 'Logo Error', message: err.message || 'Could not process logo.', variant: 'danger' });
                  }
                }}
              />

              <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 12 }}>Brand Color</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {['#4f46e5', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#0f172a'].map(color => (
                    <button
                      key={color}
                      onClick={() => { setProfile({...profile, primaryColor: color}); setSaved(false); }}
                      style={{
                        width: 32, height: 32, borderRadius: '50%', background: color, border: 'none', cursor: 'pointer',
                        boxShadow: profile.primaryColor === color || (!profile.primaryColor && color === '#4f46e5') ? `0 0 0 3px var(--bg), 0 0 0 5px ${color}` : 'none',
                        transition: 'transform 0.1s'
                      }}
                      onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                      onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                      title={color}
                    />
                  ))}
                  <div style={{ position: 'relative', width: 32, height: 32, borderRadius: '50%', overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <input 
                      type="color" 
                      value={profile.primaryColor || '#4f46e5'} 
                      onChange={e => { setProfile({...profile, primaryColor: e.target.value}); setSaved(false); }}
                      style={{ position: 'absolute', top: -10, left: -10, width: 60, height: 60, cursor: 'pointer', padding: 0, border: 'none' }}
                      title="Custom Color"
                    />
                  </div>
                </div>
              </div>

              {profile.schoolName && (
                <div style={{marginTop:24,padding:'16px',background:'var(--bg)',borderRadius:12,border:'1px solid var(--border)',display:'flex',alignItems:'center',gap:16}}>
                  <div style={{width:48,height:48,borderRadius:12,background:'var(--white)',border:'1px solid var(--border-light)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,overflow:'hidden'}}>
                    {logoPreview ? <img src={logoPreview} style={{width:'100%',height:'100%',objectFit:'contain',padding:4}}/> : <SchoolIcon size={24} color="var(--primary)" />}
                  </div>
                  <div>
                    <div style={{fontWeight:700,fontSize:'0.95rem'}}>{profile.schoolName}</div>
                    <div style={{fontSize:'0.75rem',color:'var(--text-light)',fontStyle:'italic',marginTop:2}}>{profile.motto||'Excellence in Education'}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(320px,1fr))',gap:24}}>
        {/* Module Management — only if attendance feature is enabled */}
        {attendanceEnabled && (
          <div className="card">
            <div className="card-header">
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <div style={{background:'var(--primary-light)',color:'var(--primary)',padding:8,borderRadius:10,display:'flex'}}>
                  <PlatformZapIcon size={20} />
                </div>
                <div>
                  <h3 style={{margin:0}}>Module Management</h3>
                  <p style={{fontSize:'0.75rem',color:'var(--text-light)',margin:0}}>Enable or disable major school features</p>
                </div>
              </div>
            </div>
            <div className="card-body">
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:14,background:'var(--bg-card)',borderRadius:12,border:'1px solid var(--border)'}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:'0.9rem'}}>Attendance Tracking</div>
                    <div style={{fontSize:'0.75rem',color:'var(--text-light)'}}>Manage daily student presence and reporting</div>
                  </div>
                  <label className="switch" style={{position:'relative',display:'inline-block',width:44,height:24}}>
                    <input 
                      type="checkbox" 
                      checked={profile.enabledModules?.attendance !== false} 
                      onChange={(e) => {
                        const isChecked = e.target.checked;
                        setProfile(p => ({
                          ...p,
                          enabledModules: { ...p.enabledModules, attendance: isChecked }
                        }));
                        setSaved(false);
                      }}
                      style={{opacity:0,width:0,height:0}}
                    />
                    <span 
                      style={{
                        position:'absolute',cursor:'pointer',top:0,left:0,right:0,bottom:0,
                        backgroundColor: (profile.enabledModules?.attendance !== false) ? 'var(--primary)' : 'var(--border)',
                        transition:'.3s',borderRadius:24
                      }}
                    >
                      <span 
                        style={{
                          position:'absolute',content:'""',height:18,width:18,left: 3,bottom: 3,
                          backgroundColor:'white',transition:'.3s',borderRadius:'50%',
                          transform: (profile.enabledModules?.attendance !== false) ? 'translateX(20px)' : 'translateX(0)'
                        }}
                      />
                    </span>
                  </label>
                </div>
                
                <p style={{fontSize:'0.7rem',color:'var(--text-muted)',margin:'4px 0 0',padding:'0 4px'}}>
                  Note: Disabling a module hides its navigation and dashboard widgets but preserves existing data.
                </p>
              </div>
            </div>
          </div>
        )}
        </div>

          {/* Portal Access Settings — only if at least one portal is enabled */}
          {(teacherPortalEnabled || parentPortalEnabled) && (
          <div className="card">
            <div className="card-header">
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <div style={{background:'#f3e8ff',color:'#7c3aed',padding:8,borderRadius:10,display:'flex'}}>
                  <EyeIcon size={20} />
                </div>
                <div>
                  <h3 style={{margin:0}}>Portal Access</h3>
                  <p style={{fontSize:'0.75rem',color:'var(--text-light)',margin:0}}>Control parent and teacher portal visibility</p>
                </div>
              </div>
            </div>
            <div className="card-body">
              {portalSettings ? (
                <div style={{display:'flex',flexDirection:'column',gap:14}}>
                  {[
                    { key: 'parent_portal_enabled', label: 'Parent Portal', desc: 'Allow parents to login and view student data', show: parentPortalEnabled },
                    { key: 'teacher_portal_enabled', label: 'Teacher Portal', desc: 'Allow teachers to login to their staff portal', show: teacherPortalEnabled },
                    { key: 'parent_can_view_fees', label: 'Fee Balances Visible', desc: 'Parents can view outstanding fee balances', show: parentPortalEnabled && feesEnabled },
                    { key: 'parent_can_view_results', label: 'Results Visible', desc: 'Parents can view released exam results', show: parentPortalEnabled && gradingEnabled },
                    { key: 'parent_can_view_attendance', label: 'Attendance Visible', desc: 'Parents can view attendance records', show: parentPortalEnabled && attendanceEnabled },
                    { key: 'allow_parent_self_register', label: 'Self-Registration', desc: 'Allow parents to create their own portal accounts', show: parentPortalEnabled },
                  ].filter(i => i.show).map(item => (
                    <div key={item.key} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:14,background:'var(--bg-card)',borderRadius:12,border:'1px solid var(--border)'}}>
                      <div>
                        <div style={{fontWeight:700,fontSize:'0.9rem'}}>{item.label}</div>
                        <div style={{fontSize:'0.75rem',color:'var(--text-light)'}}>{item.desc}</div>
                      </div>
                      <label className="switch" style={{position:'relative',display:'inline-block',width:44,height:24}}>
                        <input 
                          type="checkbox" 
                          checked={portalSettings[item.key] !== false}
                          onChange={async (e) => {
                            const updated = { ...portalSettings, [item.key]: e.target.checked };
                            setPortalSettings(updated);
                            setPortalSaving(true);
                            try { await updatePortalAccessSettings(updated); }
                            catch(err) { alert({ title: 'Error', message: err.message, variant: 'danger' }); }
                            finally { setPortalSaving(false); }
                          }}
                          style={{opacity:0,width:0,height:0}}
                        />
                        <span style={{
                          position:'absolute',cursor:'pointer',top:0,left:0,right:0,bottom:0,
                          backgroundColor: portalSettings[item.key] !== false ? 'var(--primary)' : 'var(--border)',
                          transition:'.3s',borderRadius:24
                        }}>
                          <span style={{
                            position:'absolute',height:18,width:18,left:3,bottom:3,
                            backgroundColor:'white',transition:'.3s',borderRadius:'50%',
                            transform: portalSettings[item.key] !== false ? 'translateX(20px)' : 'translateX(0)'
                          }} />
                        </span>
                      </label>
                    </div>
                  ))}
                  {portalSaving && <p style={{fontSize:'0.72rem',color:'var(--primary)',fontWeight:600,textAlign:'center'}}>Saving portal settings…</p>}
                </div>
              ) : (
                <p style={{fontSize:'0.85rem',color:'var(--text-muted)',textAlign:'center',padding:20}}>Loading portal settings…</p>
              )}
            </div>
          </div>
          )}

        {/* Academic Configuration */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3>Academic Configuration</h3>
              <p style={{fontSize:'0.78rem',color:'var(--text-light)',margin:'2px 0 0'}}>Classes, streams, subjects, and fee structure per level</p>
            </div>
            {/* Level tab switcher - FIXED: Scrollable on mobile */}
            <div className="scroll-x-hide" style={{padding:'4px',background:'var(--bg)',borderRadius:10,border:'1px solid var(--border)',maxWidth:'100%'}}>
              {levels.map(lv=>(
                <button key={lv} onClick={()=>setActiveLevel(lv)} style={levelBtn(lv)}>{lv}</button>
              ))}
            </div>
          </div>

          <div className="card-body">
            <div className="settings-grid-stack">

              {/* Active grades */}
              <div>
                <div style={{fontSize:'0.7rem',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:'var(--text-light)',marginBottom:10}}>Active Grades</div>
                <div style={{display:'flex',flexDirection:'column',gap:5}}>
                  {CBC_STRUCTURE[activeLevel].grades.map(grade=>{
                    const on=profile.activeClasses?.includes(grade);
                    return(
                      <label key={grade} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',borderRadius:9,cursor:'pointer',border:'1.5px solid',transition:'all 0.15s',borderColor:on?'var(--primary)':'var(--border)',background:on?'var(--primary-light)':'var(--bg)'}}>
                        <span style={{fontSize:'0.875rem',fontWeight:600,color:on?'var(--primary)':'var(--text-main)'}}>{grade}</span>
                        <input type="checkbox" checked={on} onChange={()=>toggleGrade(grade)} style={{width:15,height:15,accentColor:'var(--primary)',cursor:'pointer'}}/>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Right side */}
              <div style={{display:'flex',flexDirection:'column',gap:18}}>

                {/* Subjects */}
                <div style={sectionBox}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:'0.9rem',color:'var(--text-main)'}}>Learning Areas — {activeLevel}</div>
                      <div style={{fontSize:'0.74rem',color:'var(--text-light)',marginTop:1}}>Click × to remove a subject</div>
                    </div>
                    <button onClick={()=>resetSubjects(activeLevel)}
                      style={{padding:'5px 12px',borderRadius:7,border:'1.5px solid var(--border)',background:'var(--bg-card)',color:'var(--text-light)',fontSize:'0.78rem',fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:4}}>
                      <RefreshIcon size={14} /> Reset Defaults
                    </button>
                  </div>

                  {/* Subject pills — like screenshot */}
                  <div style={{display:'flex',flexWrap:'wrap',gap:7,marginBottom:12,minHeight:36}}>
                    {getLevelSubjects(activeLevel).map(sub=>(
                      <div key={sub} style={{display:'inline-flex',alignItems:'center',gap:5,padding:'6px 12px',borderRadius:20,background:'var(--bg-card)',border:'1.5px solid var(--border)',fontSize:'0.85rem',fontWeight:500,color:'var(--text-main)',transition:'border-color 0.15s'}}>
                        <span>{sub}</span>
                        <button onClick={()=>removeSubject(activeLevel,sub)}
                          style={{background:'none',border:'none',cursor:'pointer',padding:0,display:'flex',alignItems:'center',color:'var(--danger)',fontSize:'0.9rem',fontWeight:700,lineHeight:1,width:14,height:14,justifyContent:'center'}}>×</button>
                      </div>
                    ))}
                  </div>

                  <div style={{display:'flex',gap:8}}>
                    <input className="form-input" style={{flex:1}} value={newSubject} onChange={e=>setNewSubject(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addSubject(activeLevel)} placeholder={`Add to ${activeLevel}...`}/>
                    <button onClick={()=>addSubject(activeLevel)} style={{padding:'9px 20px',borderRadius:8,border:'none',background:'var(--text-main)',color:'#fff',fontFamily:'inherit',fontSize:'0.875rem',fontWeight:700,cursor:'pointer',flexShrink:0}}>Add</button>
                  </div>
                </div>

                {/* Streams */}
                <div style={sectionBox}>
                  <div style={{fontWeight:700,fontSize:'0.9rem',color:'var(--text-main)',marginBottom:12}}>Stream Management</div>
                  {profile.activeClasses?.filter(g=>CBC_STRUCTURE[activeLevel].grades.includes(g)).length===0?(
                    <p style={{fontSize:'0.875rem',color:'var(--text-muted)',fontStyle:'italic',textAlign:'center',padding:'16px 0'}}>Select active grades on the left to manage streams.</p>
                  ):(
                    <div className="responsive-grid-stack" style={{ gap: 12 }}>
                      {CBC_STRUCTURE[activeLevel].grades.filter(g=>profile.activeClasses?.includes(g)).map(grade=>(
                        <div key={grade} style={{background:'var(--bg-card)',padding:12,borderRadius:10,border:'1px solid var(--border)'}}>
                          <div style={{fontSize:'0.7rem',fontWeight:700,color:'var(--primary)',textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8}}>{grade} Streams</div>
                          <div style={{display:'flex',flexWrap:'wrap',gap:5,marginBottom:8,minHeight:28}}>
                            {(profile.streamsPerClass?.[grade]||[]).map(stream=>(
                              <div key={stream} style={{display:'inline-flex',alignItems:'center',gap:4,padding:'3px 9px',borderRadius:6,background:'var(--bg)',border:'1px solid var(--border)',fontSize:'0.8rem',fontWeight:600}}>
                                <span>{stream}</span>
                                <button onClick={()=>removeStream(grade,stream)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--danger)',fontSize:'0.85rem',fontWeight:700,padding:0,lineHeight:1,display:'flex',alignItems:'center'}}><CrossIcon size={12} /></button>
                              </div>
                            ))}
                            {!(profile.streamsPerClass?.[grade]||[]).length&&<span style={{fontSize:'0.75rem',color:'var(--text-muted)',fontStyle:'italic'}}>No streams yet</span>}
                          </div>
                          <div style={{display:'flex',gap:6}}>
                            <input className="form-input" style={{flex:1,fontSize:'0.82rem',padding:'6px 10px'}} value={newStream[grade]||''} onChange={e=>setNewStream({...newStream,[grade]:e.target.value})} onKeyDown={e=>e.key==='Enter'&&addStream(grade)} placeholder="New stream..."/>
                            <button onClick={()=>addStream(grade)} style={{padding:'6px 12px',borderRadius:7,border:'1.5px solid var(--border)',background:'var(--bg)',color:'var(--text-main)',fontFamily:'inherit',fontSize:'0.82rem',fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}><PlusIcon size={12} /> Add</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Boarding Houses */}
                <div style={sectionBox}>
                  <div style={{fontWeight:700,fontSize:'0.9rem',color:'var(--text-main)',marginBottom:12}}>Boarding Houses</div>
                  <div style={{background:'var(--bg-card)',padding:12,borderRadius:10,border:'1px solid var(--border)'}}>
                    <div style={{display:'flex',flexWrap:'wrap',gap:5,marginBottom:8,minHeight:28}}>
                      {(profile.boardingHouses||[]).map(house=>(
                        <div key={house} style={{display:'inline-flex',alignItems:'center',gap:4,padding:'4px 10px',borderRadius:6,background:'var(--bg)',border:'1px solid var(--border)',fontSize:'0.82rem',fontWeight:600}}>
                          <span>{house}</span>
                          <button onClick={()=>removeHouse(house)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--danger)',fontSize:'0.9rem',fontWeight:700,padding:0,lineHeight:1,display:'flex',alignItems:'center'}}><CrossIcon size={12} /></button>
                        </div>
                      ))}
                      {!(profile.boardingHouses||[]).length&&<span style={{fontSize:'0.8rem',color:'var(--text-muted)',fontStyle:'italic'}}>No houses added yet</span>}
                    </div>
                    <div style={{display:'flex',gap:6,maxWidth:300}}>
                      <input className="form-input" style={{flex:1,fontSize:'0.82rem',padding:'8px 12px'}} value={newHouse} onChange={e=>setNewHouse(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addHouse()} placeholder="e.g. Red House"/>
                      <button onClick={addHouse} style={{padding:'8px 16px',borderRadius:8,border:'none',background:'var(--text-main)',color:'#fff',fontFamily:'inherit',fontSize:'0.82rem',fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}><PlusIcon size={12} /> Add</button>
                    </div>
                  </div>
                </div>

                {/* Grading & Exams — only if grading feature is enabled */}
                {gradingEnabled && (
                <div style={sectionBox}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:15}}>
                    <div style={{fontWeight:700,fontSize:'0.9rem',color:'var(--text-main)'}}><BookIcon size={20} /> Grading & Exam Types</div>
                    {robustExams.length > 0 && (
                      <button onClick={handleClearAllExams} style={{fontSize:'0.65rem',background:'none',border:'none',color:'var(--danger)',cursor:'pointer',fontWeight:700,display:'flex',alignItems:'center',gap:4}} title="Remove all unconfigured exams">
                        <CrossIcon size={12} /> Clear All
                      </button>
                    )}
                  </div>
                  
                  <div className="responsive-grid-stack">
                    {/* Exam Names */}
                      <div style={{display:'flex',flexDirection:'column',gap:10}}>
                        <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:10,minHeight:36}}>
                          {robustExams.map(e=>(
                            <div key={e.id} style={{
                              display:'inline-flex',
                              alignItems:'center',
                              gap:10,
                              padding:'8px 16px',
                              borderRadius:24,
                              background: e.status==='published' ? 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)' : 'var(--bg-card)',
                              border: e.status==='published' ? '1.5px solid #22c55e' : '1.5px solid var(--border)',
                              fontSize:'0.82rem',
                              transition:'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                              boxShadow: e.status==='published' ? '0 4px 12px rgba(34, 197, 94, 0.15)' : 'none'
                            }}>
                              <span style={{fontWeight:700, color: 'var(--text-main)'}}>{e.name}</span>
                              
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderLeft: '1.5px solid var(--border)', paddingLeft: 10 }}>
                                {teacherPortalEnabled && (
                                <button 
                                  onClick={() => toggleExamStatus(e)}
                                  style={{ 
                                    fontSize:'0.6rem', 
                                    textTransform:'uppercase', 
                                    fontWeight:900, 
                                    padding: '4px 8px',
                                    borderRadius: 6,
                                    background: e.status === 'published' ? 'var(--primary-light)' : '#f1f5f9',
                                    color: e.status === 'published' ? 'var(--primary)' : '#64748b',
                                    border: 'none',
                                    cursor: 'pointer'
                                  }}
                                >
                                  {e.status === 'published' ? 'Open for Teachers' : 'Locked'}
                                </button>
                                )}
                                
                                {parentPortalEnabled && (
                                <button 
                                  onClick={() => handleReleaseToggle(e.id, !e.released_to_parents)}
                                  style={{ 
                                    fontSize:'0.65rem', 
                                    textTransform:'uppercase', 
                                    fontWeight:800, 
                                    padding: '5px 10px',
                                    borderRadius: 8,
                                    background: e.released_to_parents ? '#10b981' : '#f1f5f9',
                                    color: e.released_to_parents ? '#fff' : '#64748b',
                                    border: `1px solid ${e.released_to_parents ? '#059669' : '#e2e8f0'}`,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 5,
                                    transition: 'all 0.2s'
                                  }}
                                >
                                  {e.released_to_parents ? <><CheckIcon size={12} /> Results Posted</> : 'Post to Parents'}
                                </button>
                                )}
                              </div>

                              <button onClick={()=>removeExam(e.name)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--danger)',fontWeight:700,fontSize:'1.1rem', padding: 0}} title="Delete Exam">×</button>
                            </div>
                          ))}
                        </div>
                        <div style={{display:'flex',gap:6,alignItems:'center'}}>
                          <input className="form-input" style={{flex:1,fontSize:'0.82rem'}} value={newExam} onChange={e=>setNewExam(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addExam()} placeholder="e.g. End Term 1 2026"/>
                          <button onClick={addExam} className="btn btn-ghost btn-sm" style={{display:'flex',alignItems:'center',gap:4}}><PlusIcon size={14} /> Create Exam</button>
                        </div>
                      </div>

                      {/* Timetable label - WIP (module disabled)
                      <div style={{marginTop: 16}}>
                        <label style={{fontSize:'0.72rem',fontWeight:700,color:'var(--text-light)',textTransform:'uppercase',marginBottom:8,display:'block'}}>Regular Timetable Name</label>
                        <input 
                          className="form-input" 
                          style={{fontSize:'0.82rem'}} 
                          name="timetable_label"
                          value={profile.timetable_label} 
                          onChange={handleChange} 
                          placeholder="e.g. Weekly, Regular, Core Schedule"
                        />
                        <p style={{fontSize:'0.65rem',color:'var(--text-muted)',marginTop:4}}>This label appears on the main scheduling button.</p>
                      </div>
                      */}
                         {/* Grading Scale */}
                    <div>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                        <div>
                          <div style={{fontSize:'0.72rem',fontWeight:700,color:'var(--text-light)',textTransform:'uppercase'}}>Achievement Standard ({activeLevel})</div>
                          <div style={{display:'flex', gap:8, marginTop:4}}>
                            {['percentage', 'rubric'].map(mode => (
                              <button 
                                key={mode}
                                type="button"
                                onClick={() => setProfile({ ...profile, gradingMode: mode })}
                                style={{
                                  padding: '4px 10px', fontSize: '0.65rem', borderRadius: 20, border: '1px solid',
                                  fontWeight: 800, cursor: 'pointer', transition: 'all 0.15s',
                                  textTransform: 'uppercase',
                                  borderColor: profile.gradingMode === mode ? 'var(--primary)' : 'var(--border)',
                                  background: profile.gradingMode === mode ? 'var(--primary-light)' : 'transparent',
                                  color: profile.gradingMode === mode ? 'var(--primary)' : 'var(--text-light)'
                                }}
                              >
                                {mode}
                              </button>
                            ))}
                          </div>
                        </div>
                        <button onClick={resetGrading} style={{fontSize:'0.65rem',background:'none',border:'none',color:'var(--primary)',cursor:'pointer',fontWeight:700,display:'flex',alignItems:'center',gap:4}}><RefreshIcon size={12} /> Standard Rubric</button>
                      </div>

                      <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:10,maxHeight:250,overflowY:'auto',paddingRight:5}}>
                        {(profile.gradingSystems?.[activeLevel] || []).map((g,i)=>(
                          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:'var(--bg-card)',borderRadius:10,border:`1px solid ${g.color}30`,borderLeft:`4px solid ${g.color}`}}>
                            <div style={{display:'flex', alignItems:'center', gap:10}}>
                              <span style={{fontWeight:900,fontSize:'1rem',color:g.color, minWidth:24}}>{g.symbol}</span>
                              <div style={{display:'flex', flexDirection:'column'}}>
                                <span style={{fontSize:'0.82rem',fontWeight:700, color:'var(--text-main)'}}>{g.name || (g.symbol.length > 2 ? g.symbol : 'Unlabeled Level')}</span>
                                {profile.gradingMode === 'percentage' && (
                                  <span style={{fontSize:'0.65rem',color:'var(--text-light)'}}>{g.min} - {g.max}%</span>
                                )}
                              </div>
                            </div>
                            <button onClick={()=>removeGradeItem(i)} style={{background:'none',border:'none',color:'var(--danger)',fontSize:'1rem',cursor:'pointer'}}>×</button>
                          </div>
                        ))}
                        {(profile.gradingSystems?.[activeLevel] || []).length === 0 && (
                          <p style={{fontSize:'0.75rem', color:'var(--text-muted)', textAlign:'center', padding:20, background:'rgba(0,0,0,0.02)', borderRadius:12}}>Click "Standard Rubric" to load level-specific defaults.</p>
                        )}
                      </div>

                      {profile.gradingMode === 'percentage' && (
                        <div style={{display:'grid',gridTemplateColumns:'65px 1fr 1fr 40px',gap:8,alignItems:'end'}}>
                          <div style={{display:'flex',flexDirection:'column',gap:4}}>
                            <label style={{fontSize:'0.65rem',fontWeight:700,color:'var(--text-muted)'}}>GRADE</label>
                            <input className="form-input" style={{padding:'6px',fontSize:'0.82rem',textAlign:'center',height:32}} value={newGradeItem.symbol} onChange={e=>setNewGradeItem({...newGradeItem,symbol:e.target.value.toUpperCase()})} placeholder="A-"/>
                          </div>
                          <div style={{display:'flex',flexDirection:'column',gap:4}}>
                            <label style={{fontSize:'0.65rem',fontWeight:700,color:'var(--text-muted)'}}>MIN %</label>
                            <input type="number" className="form-input" style={{padding:'6px',fontSize:'0.82rem',textAlign:'center',height:32}}
                              value={newGradeItem.min} 
                              onChange={e=>setNewGradeItem({...newGradeItem,min:Number(e.target.value)})}
                              min="0" max="100"
                            />
                          </div>
                          <div style={{display:'flex',flexDirection:'column',gap:4}}>
                            <label style={{fontSize:'0.65rem',fontWeight:700,color:'var(--text-muted)'}}>MAX %</label>
                            <input type="number" className="form-input" style={{padding:'6px',fontSize:'0.82rem',textAlign:'center',height:32}}
                              value={newGradeItem.max} 
                              onChange={e=>setNewGradeItem({...newGradeItem,max:Number(e.target.value)})}
                              min="0" max="100"
                            />
                          </div>
                          <div style={{display:'flex',flexDirection:'column',gap:4}}>
                            <label style={{fontSize:'0.65rem',fontWeight:700,color:'var(--text-muted)'}}>COLOR</label>
                            <input type="color" style={{width:'100%',height:32,border:'1.5px solid var(--border)',borderRadius:8,background:'none',cursor:'pointer',padding:0}} value={newGradeItem.color} onChange={e=>setNewGradeItem({...newGradeItem,color:e.target.value})}/>
                          </div>
                          <div style={{gridColumn:'1 / span 4', display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:10}}>
                            <label style={{display:'flex', alignItems:'center', gap:8, fontSize:'0.75rem', cursor:'pointer', fontWeight:600, color:'var(--text-main)'}}>
                              <input type="checkbox" checked={applyGradingToAll} onChange={e => setApplyGradingToAll(e.target.checked)} style={{accentColor:'var(--primary)', width:16, height:16, cursor:'pointer'}} />
                              Apply to all categories
                            </label>
                            <button onClick={addGradeItem} className="btn btn-primary btn-sm" style={{height:36,fontWeight:700}}>
                              <PlusIcon size={16} /> Add Grade
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                )}

                {/* Fee Structure — only if fees feature is enabled */}
                {feesEnabled && (
                <div style={sectionBox}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:'0.9rem',color:'var(--text-main)'}}><CardIcon size={20} /> Fee Structure (Per Term)</div>
                      <div style={{fontSize:'0.74rem',color:'var(--text-light)',marginTop:1}}>Tuition per grade level</div>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={runFeeApplication} disabled={loading}>Apply Campus-wide</button>
                  </div>
                  {profile.activeClasses?.filter(g=>CBC_STRUCTURE[activeLevel].grades.includes(g)).length===0?(
                    <p style={{fontSize:'0.875rem',color:'var(--text-muted)',fontStyle:'italic',textAlign:'center',padding:'14px 0'}}>Select active grades to configure fees.</p>
                  ):(
                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14}}>
                      {CBC_STRUCTURE[activeLevel].grades.filter(g=>profile.activeClasses?.includes(g)).map(grade=>(
                        <div key={grade} style={{display:'flex',flexDirection:'column',gap:10,padding:'14px',background:'var(--bg-card)',borderRadius:12,border:'1px solid var(--border)'}}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                            <span style={{fontSize:'0.9rem',fontWeight:800,color:'var(--primary)'}}>{grade}</span>
                            <button 
                              type="button"
                              onClick={() => copyTerm1ToAll(grade)}
                              style={{ fontSize: '0.68rem', padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-light)', cursor: 'pointer', fontWeight: 600 }}
                              title="Copy Term 1 rates to Term 2 & 3"
                            >
                              Copy T1 to all
                            </button>
                          </div>

                          {['Term 1', 'Term 2', 'Term 3'].map(tKey => {
                            const termObj = typeof profile.gradeFees?.[grade] === 'object' && profile.gradeFees[grade][tKey]
                              ? profile.gradeFees[grade][tKey]
                              : {};
                            const dayVal = termObj.day !== undefined 
                              ? termObj.day 
                              : (typeof profile.gradeFees?.[grade] === 'object' ? profile.gradeFees[grade].day : profile.gradeFees?.[grade] || 0);
                            const boardingVal = termObj.boarding !== undefined 
                              ? termObj.boarding 
                              : (typeof profile.gradeFees?.[grade] === 'object' ? (profile.gradeFees[grade].boarding || 0) : 0);

                            return (
                              <div key={tKey} style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 10px', border: '1px solid var(--border)' }}>
                                <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-main)', marginBottom: 4 }}>{tKey}</div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                  <div className="form-group" style={{ margin: 0 }}>
                                    <label style={{ fontSize: '0.64rem', marginBottom: 2, color: 'var(--text-light)' }}>Day (KSh)</label>
                                    <input 
                                      type="number" 
                                      value={dayVal} 
                                      onChange={e => handleTermFeeChange(grade, tKey, 'day', e.target.value)}
                                      style={{ width: '100%', textAlign: 'right', fontWeight: 700, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.85rem', outline: 'none', background: 'var(--bg-card)', color: 'var(--text-main)', fontFamily: 'inherit' }}
                                    />
                                  </div>
                                  <div className="form-group" style={{ margin: 0 }}>
                                    <label style={{ fontSize: '0.64rem', marginBottom: 2, color: 'var(--text-light)' }}>Boarding (KSh)</label>
                                    <input 
                                      type="number" 
                                      value={boardingVal} 
                                      onChange={e => handleTermFeeChange(grade, tKey, 'boarding', e.target.value)}
                                      style={{ width: '100%', textAlign: 'right', fontWeight: 700, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.85rem', outline: 'none', background: 'var(--bg-card)', color: 'var(--text-main)', fontFamily: 'inherit' }}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}

              </div>
            </div>
          </div>
        </div>

        {/* Integrations (M-Pesa & SMS) — only if features are enabled */}
        {(mpesaEnabled || smsEnabled) && isAdmin && (
          <div className="card">
            <div className="card-header">
              <div>
                <h3><PlatformZapIcon size={20} color="var(--primary)" /> Gateway Integrations</h3>
                <p style={{fontSize:'0.78rem',color:'var(--text-light)',margin:'2px 0 0'}}>Connect your school to M-Pesa and SMS networks</p>
              </div>
            </div>
            <div className="card-body">
              <div className="responsive-grid-stack">
                
                {/* M-Pesa Daraja */}
                {mpesaEnabled && (
                <div style={sectionBox}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:15}}>
                    <div>
                      <div style={{fontWeight:800,fontSize:'1rem',color:'var(--text-main)'}}>M-Pesa (Daraja API)</div>
                      <div style={{fontSize:'0.75rem',color:'var(--text-light)'}}>Automate fee reconciliation & STK Pushes</div>
                    </div>
                    <div style={{padding:'4px 10px',borderRadius:20,background:'var(--primary-light)',color:'var(--primary)',fontSize:'0.65rem',fontWeight:700}}>Safaricom</div>
                  </div>

                  <div style={{background:'var(--bg-card)',padding:12,borderRadius:10,marginBottom:15,border:'1px solid var(--border)'}}>
                    <div style={{fontSize:'0.72rem',fontWeight:700,color:'var(--text-light)',textTransform:'uppercase',marginBottom:8}}>Setup Instructions</div>
                    <ol style={{fontSize:'0.75rem',color:'var(--text-main)',paddingLeft:16,lineHeight:1.6}}>
                      <li>Login to <a href="https://developer.safaricom.co.ke/" target="_blank" rel="noreferrer" style={{color:'var(--primary)',fontWeight:600}}>Daraja Portal</a></li>
                      <li>Create a "Lipan M-Pesa Paybill" app in My Apps</li>
                      <li>Configure MPESA_SHORTCODE, MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET and MPESA_PASSKEY as Supabase Edge Function secrets. Do not paste API secrets into the browser.</li>
                    </ol>
                  </div>

                  <div style={{display:'flex',flexDirection:'column',gap:12}}>
                    <div className="form-group">
                      <label style={{fontSize:'0.7rem'}}>Business Shortcode / Paybill</label>
                      <input className="form-input" placeholder="Configured in Supabase Edge Function secrets" value="" disabled />
                    </div>
                    <div className="form-group">
                      <label style={{fontSize:'0.7rem'}}>Consumer Key</label>
                      <div style={{ position: 'relative' }}>
                        <input className="form-input" 
                          type={showMpesaKey ? "text" : "password"} 
                          value="" readOnly placeholder="Configured in Supabase Edge Function secrets"
                          style={{ paddingRight: '40px' }}
                        />
                        <button type="button" onClick={() => setShowMpesaKey(!showMpesaKey)} style={{ position: 'absolute', right: 10, top: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)' }}>
                          {showMpesaKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="form-group">
                      <label style={{fontSize:'0.7rem'}}>Consumer Secret</label>
                      <div style={{ position: 'relative' }}>
                        <input className="form-input" 
                          type={showMpesaSec ? "text" : "password"} 
                          value="" readOnly placeholder="Configured in Supabase Edge Function secrets"
                          style={{ paddingRight: '40px' }}
                        />
                        <button type="button" onClick={() => setShowMpesaSec(!showMpesaSec)} style={{ position: 'absolute', right: 10, top: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)' }}>
                          {showMpesaSec ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                        </button>
                      </div>
                    </div>
                    
                    <div style={{display:'flex',gap:10,marginTop:10}}>
                      <button className="btn btn-ghost btn-sm" onClick={handleTestMpesa} disabled={testingMpesa}>
                        {testingMpesa ? 'Testing...' : 'Test Connection'}
                      </button>
                    </div>

                    <div style={{marginTop:12,padding:12,background:'var(--bg)',borderRadius:8,border:'1px dashed var(--border)',display:'flex',flexDirection:'column',gap:8}}>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <ShieldIcon size={18} color="var(--primary)" />
                        <p style={{fontSize:'0.68rem',color:'var(--text-light)',margin:0,fontWeight:600}}>Supabase Edge Function Secrets</p>
                      </div>
                      <p style={{fontSize:'0.65rem',color:'var(--text-light)',margin:0,lineHeight:1.4}}>
                        Daraja credentials are read by the Edge Function from Supabase secrets and are never returned to the browser or stored in this school profile. The test above checks server-side OAuth authentication; it does not initiate a payment.
                      </p>
                    </div>
                  </div>
                </div>
                )}

                {/* Africa's Talking SMS */}
                {smsEnabled && (
                <div style={sectionBox}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:15}}>
                    <div>
                      <div style={{fontWeight:800,fontSize:'1rem',color:'var(--text-main)'}}>SMS (Africa's Talking)</div>
                      <div style={{fontSize:'0.75rem',color:'var(--text-light)'}}>Send automated payment & attendance alerts</div>
                    </div>
                    <div style={{padding:'4px 10px',borderRadius:20,background:'#DCFCE7',color:'#166534',fontSize:'0.65rem',fontWeight:700}}>Africa's Talking</div>
                  </div>

                  <div style={{background:'var(--bg-card)',padding:12,borderRadius:10,marginBottom:15,border:'1px solid var(--border)'}}>
                    <div style={{fontSize:'0.72rem',fontWeight:700,color:'var(--text-light)',textTransform:'uppercase',marginBottom:8}}>Setup Instructions</div>
                    <ul style={{fontSize:'0.75rem',color:'var(--text-main)',paddingLeft:16,lineHeight:1.6}}>
                      <li>Create account at <a href="https://africastalking.com/" target="_blank" rel="noreferrer" style={{color:'#166534',fontWeight:600}}>Africa's Talking</a></li>
                      <li>Apply for a **Sender ID** (Alphanumeric)</li>
                      <li>Configure AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME and AFRICASTALKING_SENDER_ID as Supabase Edge Function secrets.</li>
                    </ul>
                  </div>

                  <div style={{display:'flex',flexDirection:'column',gap:12}}>
                    <div className="form-group">
                      <label style={{fontSize:'0.7rem'}}>Sender ID (Optional)</label>
                      <input className="form-input" placeholder="Configured in Supabase Edge Function secrets" value="" disabled />
                    </div>
                    <div className="form-group">
                      <label style={{fontSize:'0.7rem'}}>API Key</label>
                      <div style={{ position: 'relative' }}>
                        <input className="form-input" 
                          type={showSmsKey ? "text" : "password"} 
                          value="" readOnly placeholder="Configured in Supabase Edge Function secrets"
                          style={{ paddingRight: '40px' }}
                        />
                        <button type="button" onClick={() => setShowSmsKey(!showSmsKey)} style={{ position: 'absolute', right: 10, top: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)' }}>
                          {showSmsKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                        </button>
                      </div>
                    </div>
                    
                    <div style={{display:'flex',gap:10,marginTop:10}}>
                      <button className="btn btn-ghost btn-sm" onClick={handleTestSms} disabled={testingSms}>
                        {testingSms ? 'Testing...' : 'Test Connection'}
                      </button>
                    </div>

                    <div style={{marginTop:8,padding:12,background:'var(--bg)',borderRadius:8,border:'1px dashed var(--border)',display:'flex',flexDirection:'column',gap:8}}>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        <ShieldIcon size={18} color="var(--primary)" />
                        <p style={{fontSize:'0.68rem',color:'var(--text-light)',margin:0,fontWeight:600}}>Server-Side API Configuration</p>
                      </div>
                      <p style={{fontSize:'0.65rem',color:'var(--text-light)',margin:0,lineHeight:1.4}}>
                        Africa's Talking credentials are read by the Edge Function from Supabase secrets and are not returned to this browser or stored in this school profile. The test checks provider account authentication and does not send an SMS.
                      </p>
                    </div>
                  </div>
                </div>
                )}

              </div>
            </div>
          </div>
        )}

        {/* Academic Eras & Terms */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3><CalendarIcon size={20} /> Academic Eras & Terms</h3>
                <p style={{fontSize:'0.78rem',color:'var(--text-light)',margin:'2px 0 0'}}>Manage terms and set current active period</p>
              </div>
            </div>
            <div className="card-body">
              <div style={{display:'flex',flexDirection:'column',gap:12,marginBottom:20}}>
                {periods.map(p => (
                  <div key={p.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 16px',background:p.is_active?'var(--primary-light)':'var(--bg-card)',borderRadius:12,border:'1.5px solid',borderColor:p.is_active?'var(--primary)':'var(--border)'}}>
                    <div>
                      <div style={{fontWeight:700,fontSize:'0.9rem',color:p.is_active?'var(--primary)':'var(--text-main)'}}>{p.year} {p.term}</div>
                      {p.is_active && <div style={{fontSize:'0.65rem',fontWeight:800,textTransform:'uppercase',letterSpacing:'0.05em',color:'var(--primary)',marginTop:2}}>Current Active Period</div>}
                    </div>
                    {!p.is_active && (
                      <button className="btn btn-ghost btn-sm" onClick={() => handleSetActivePeriod(p.id)} disabled={loading}>Set Active</button>
                    )}
                  </div>
                ))}
              </div>

              <div style={{background:'var(--bg)',borderRadius:12,padding:16,border:'1px dashed var(--border)'}}>
                <div style={{fontSize:'0.7rem',fontWeight:700,textTransform:'uppercase',color:'var(--text-light)',marginBottom:12}}>Create New Era/Term</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:10,alignItems:'flex-end'}}>
                  <div className="form-group" style={{marginBottom:0}}>
                    <label style={{fontSize:'0.65rem'}}>Year</label>
                    <Select 
                      value={newPeriod.year} 
                      onChange={e=>setNewPeriod({...newPeriod,year:Number(e.target.value)})}
                      options={[2023,2024,2025,2026,2027].map(y=>({ id: y, label: String(y) }))}
                      style={{ width: '100%', minWidth: 100 }}
                    />
                  </div>
                  <div className="form-group" style={{marginBottom:0}}>
                    <label style={{fontSize:'0.65rem'}}>Term</label>
                    <Select 
                      value={newPeriod.term} 
                      onChange={e=>setNewPeriod({...newPeriod,term:e.target.value})}
                      options={['Term 1','Term 2','Term 3','Semester 1','Semester 2','Quarter 1','Quarter 2','Quarter 3','Quarter 4'].map(t=>({ id: t, label: t }))}
                      style={{ width: '100%', minWidth: 140 }}
                    />
                  </div>
                  <button className="btn btn-primary" onClick={handleAddPeriod} disabled={loading} style={{height:40,display:'flex',alignItems:'center',gap:6}}><PlusIcon size={16} /> Add Period</button>
                </div>
              </div>
            </div>
          </div>

          {/* Data node */}
          <div className="card">
            <div className="card-header"><h3><SaveIcon size={20} /> System Data</h3></div>
            <div className="card-body" style={{textAlign:'center',padding:'24px 20px'}}>
              <div style={{width:58,height:58,background:'var(--primary-light)',borderRadius:15,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'1.5rem',margin:'0 auto 14px'}}><SaveIcon size={32} color="var(--primary)" /></div>
              <h4 style={{fontWeight:700,fontSize:'1rem',marginBottom:6}}>Local Data Backup & Sync</h4>
              <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginBottom:15}}>
                <div style={{width:8,height:8,borderRadius:'50%',background:navigator.onLine?'#4ade80':'#fbbf24'}}></div>
                <span style={{fontSize:'0.75rem',fontWeight:600,color:'var(--text-light)'}}>
                  {navigator.onLine ? 'Cloud Sync Engine Active' : 'Offline Mode: Local Storage active'}
                </span>
              </div>
              <p style={{color:'var(--text-light)',fontSize:'0.875rem',marginBottom:22,lineHeight:1.6,maxWidth:320,margin:'0 auto 20px'}}>
                Download a complete, self-service JSON export of your school's data — including students, staff, financial records, exam results, and timetables.
              </p>
              <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
                <button className="btn btn-primary" onClick={()=>setShowExportModal(true)} style={{display:'flex',alignItems:'center',gap:6}}><DownloadIcon size={14} /> Export Data</button>
                <button className="btn btn-ghost" onClick={()=>backupRef.current.click()} style={{display:'flex',alignItems:'center',gap:6}}><UploadIcon size={14} /> Restore Backup</button>
              </div>
              <input ref={backupRef} type="file" hidden accept=".json" onChange={e=>{
                const file=e.target.files[0];if(!file)return;
                const r=new FileReader();
                r.onload=async(ev)=>{
                  if(await confirm({ title: 'Confirm Restore', message: 'Overwrite all local data with this backup? This is irreversible.', variant: 'danger' })){
                    importData(ev.target.result); window.location.reload();
                  }
                };
                r.readAsText(file);
              }}/>
            </div>
          </div>

        {/* Academic Year Promotion */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3><RocketIcon size={20} /> Academic Year Promotion</h3>
              <p style={{fontSize:'0.78rem',color:'var(--text-light)',margin:'2px 0 0'}}>Advance all active streams to the next class and carry forward teachers.</p>
            </div>
            <button 
              className="btn btn-primary" 
              onClick={() => handlePreviewPromotion()} 
              disabled={promotionLoading}
            >
              {promotionLoading ? 'Loading Preview...' : 'Preview Promotion'}
            </button>
          </div>
        </div>

      </div>

      {showPromotionModal && promotionPreview && (
        <div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:20}}>
          <div style={{background:'var(--bg)',width:'100%',maxWidth:600,borderRadius:16,boxShadow:'0 20px 40px rgba(0,0,0,0.2)',display:'flex',flexDirection:'column',maxHeight:'90vh'}}>
            <div style={{padding:'20px 24px',borderBottom:'1px solid var(--border)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <h3 style={{margin:0,fontSize:'1.2rem',display:'flex',alignItems:'center',gap:8}}><RocketIcon size={20} color="var(--primary)" /> Promotion Preview</h3>
              <button onClick={()=>setShowPromotionModal(false)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-light)',padding:4}}><CrossIcon size={20} /></button>
            </div>
            
            <div style={{padding:24,overflowY:'auto',flex:1}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:20}}>
                <div style={{background:'var(--primary-light)',padding:16,borderRadius:12,textAlign:'center'}}>
                  <div style={{fontSize:'1.5rem',fontWeight:800,color:'var(--primary)'}}>{promotionPreview.studentsPromoted}</div>
                  <div style={{fontSize:'0.75rem',fontWeight:600,color:'var(--primary)'}}>Students Moving Up</div>
                </div>
                <div style={{background:'#dcfce7',padding:16,borderRadius:12,textAlign:'center'}}>
                  <div style={{fontSize:'1.5rem',fontWeight:800,color:'#166534'}}>{promotionPreview.studentsGraduated}</div>
                  <div style={{fontSize:'0.75rem',fontWeight:600,color:'#166534'}}>Graduating</div>
                </div>
                <div style={{background:'#f3e8ff',padding:16,borderRadius:12,textAlign:'center'}}>
                  <div style={{fontSize:'1.5rem',fontWeight:800,color:'#6b21a8'}}>{promotionPreview.teachersCarriedForward}</div>
                  <div style={{fontSize:'0.75rem',fontWeight:600,color:'#6b21a8'}}>Teachers Forwarded</div>
                </div>
              </div>

              <h4 style={{margin:'0 0 12px',fontSize:'0.9rem'}}>Stream Actions</h4>
              <div style={{display:'flex',flexDirection:'column',gap:8,background:'var(--bg-card)',padding:12,borderRadius:12,border:'1px solid var(--border)'}}>
                {promotionPreview.details.map((detail, idx) => (
                  <div key={idx} style={{fontSize:'0.8rem',display:'flex',flexDirection:'column',gap:2,padding:'8px 0',borderBottom:idx===promotionPreview.details.length-1?'none':'1px solid var(--border)'}}>
                    <strong style={{color:'var(--text-main)'}}>{detail.stream}</strong>
                    <span style={{color:'var(--text-light)'}}>{detail.status}</span>
                  </div>
                ))}
              </div>

              <div style={{marginTop:24,padding:16,background:'#fee2e2',borderRadius:12,border:'1px solid #fca5a5'}}>
                <label style={{fontSize:'0.85rem',fontWeight:700,color:'#991b1b',display:'block',marginBottom:8}}>
                  Type <strong>PROMOTE {new Date().getFullYear()}</strong> to confirm
                </label>
                <input 
                  className="form-input" 
                  value={promotionConfirmText}
                  onChange={e=>setPromotionConfirmText(e.target.value)}
                  placeholder={`PROMOTE ${new Date().getFullYear()}`}
                  style={{background:'#fff',borderColor:'#fca5a5'}}
                />
              </div>
            </div>

            <div style={{padding:'16px 24px',borderTop:'1px solid var(--border)',display:'flex',justifyContent:'flex-end',gap:12,background:'var(--bg-card)',borderBottomLeftRadius:16,borderBottomRightRadius:16}}>
              <button className="btn btn-ghost" onClick={()=>setShowPromotionModal(false)}>Cancel</button>
              <button 
                className="btn btn-primary" 
                onClick={handleConfirmPromotion}
                disabled={promotionConfirmText !== `PROMOTE ${new Date().getFullYear()}` || promotionLoading}
                style={{background:promotionConfirmText === `PROMOTE ${new Date().getFullYear()}` ? '#dc2626' : 'var(--text-light)'}}
              >
                {promotionLoading ? 'Promoting...' : 'Confirm Promotion'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export Selection Modal */}
      {showExportModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 1100,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div className="card" style={{ maxWidth: 520, width: '90%', padding: 0, borderRadius: 20, overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', background: 'var(--primary-light)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: 'var(--primary)' }}>Export School Data</h3>
                <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: 'var(--text-light)' }}>Select which datasets to include in your JSON export package</p>
              </div>
              <button className="btn-icon" onClick={() => setShowExportModal(false)}><CrossIcon size={18} /></button>
            </div>
            
            <div style={{ padding: '20px 24px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 20 }}>
                {[
                  { key: 'students', label: 'Students & Enrollment' },
                  { key: 'teachers', label: 'Teachers & Staff' },
                  { key: 'fees', label: 'Fee Structures' },
                  { key: 'payments', label: 'Payment Transactions' },
                  { key: 'marks', label: 'Exam Results & Marks' },
                  { key: 'timetable', label: 'Timetable Schedules' },
                  { key: 'announcements', label: 'Announcements' }
                ].map(mod => (
                  <label key={mod.key} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                    background: exportSelection[mod.key] ? 'var(--primary-light)' : 'var(--bg)',
                    border: `1.5px solid ${exportSelection[mod.key] ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius: 12, cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700,
                    transition: 'all 0.15s ease'
                  }}>
                    <input
                      type="checkbox"
                      checked={!!exportSelection[mod.key]}
                      onChange={e => setExportSelection({ ...exportSelection, [mod.key]: e.target.checked })}
                      style={{ width: 16, height: 16, accentColor: 'var(--primary)' }}
                    />
                    <span>{mod.label}</span>
                  </label>
                ))}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const allSelected = Object.values(exportSelection).every(v => v);
                    const next = {};
                    Object.keys(exportSelection).forEach(k => { next[k] = !allSelected; });
                    setExportSelection(next);
                  }}
                >
                  {Object.values(exportSelection).every(v => v) ? 'Deselect All' : 'Select All'}
                </button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn btn-ghost" onClick={() => setShowExportModal(false)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await exportData(exportSelection);
                      setShowExportModal(false);
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <DownloadIcon size={14} /> Download Selected Data
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cropper Modal */}
      {isCropping && cropImageSrc && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', zIndex: 99999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 20
        }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: 480, height: 320, background: '#1e293b', borderRadius: 16, overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
            <Cropper
              image={cropImageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          </div>
          <div style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card)', padding: 20, borderRadius: 16, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.3)' }}>
            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, display: 'block', marginBottom: 8 }}>Zoom / Crop Adjustment</label>
              <input
                type="range"
                value={zoom}
                min={1}
                max={3}
                step={0.1}
                aria-labelledby="Zoom"
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary)' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCropCancel}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCropSave}>
                <SaveIcon size={16} /> Apply Crop
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
