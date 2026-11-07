import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { getSchoolProfile, initPortalStore } from '../../data/coreStore';
import { getExamMarksForPaper, getClassList, getTeacherWorkloadSummary, getTeacherTimetable, getTimetableConfig, getPeriods, subscribeToTable } from '../../data/academicsStore';
import { getLevelForGrade } from '../../data/seedData';
import { getExams, getOpenExamsForTeacher, getExamPapers, saveExamMarks, getVirtualPaperMarks, getNotifications, markNotificationRead, markAllNotificationsRead } from '../../data/academicsStore';
import { 
  BookIcon, CheckIcon, SaveIcon, UserIcon, 
  GradingIcon, RefreshIcon, ChevronDownIcon, CalendarIcon, DashboardIcon, MenuIcon, LogoutIcon, TeacherIcon, MessageIcon
} from '../../components/CommonIcons';
import Loader from '../../components/Common/Loader';
import { useDialog } from '../../contexts/DialogContext';
import { Helmet } from 'react-helmet-async';
import { useOfflineSync, OfflineSyncBadge } from '../../hooks/useOfflineSync';
import TPDTrackerWidget from '../../components/widgets/TPDTrackerWidget';
import { saveGradingDraft } from '../../data/offlineStore';

// Premium UI Components
const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ 
    background: '#ffffff', borderRadius: '24px', padding: '24px', 
    boxShadow: '0 10px 40px -10px rgba(0,0,0,0.06)', 
    border: '1px solid rgba(255,255,255,0.4)',
    cursor: onClick ? 'pointer' : 'default',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease',
    ...style 
  }}>
    {children}
  </div>
);

const Badge = ({ children, color = '#3b82f6', bg = '#eff6ff' }) => (
  <span style={{ 
    background: bg, color: color, padding: '6px 12px', 
    borderRadius: '12px', fontSize: '0.75rem', fontWeight: 700, 
    letterSpacing: '0.5px', textTransform: 'uppercase' 
  }}>
    {children}
  </span>
);

export default function MobileGrading({ user, onLogout }) {
  const { alert, confirm } = useDialog();
  const [exams, setExams] = useState([]);
  const [papers, setPapers] = useState([]);
  const [students, setStudents] = useState([]);
  
  const [selectedExamId, setSelectedExamId] = useState('');
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [marksBuffer, setMarksBuffer] = useState({});
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Timetable/Workload stats
  const [workload, setWorkload] = useState(0);
  const [schedule, setSchedule] = useState([]);
  const [config, setConfig] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [activeSubTab, setActiveSubTab] = useState('attendance'); // for attendance sub-sections if needed
  const [activePeriod, setActivePeriod] = useState(null);
  const [schoolProfile, setSchoolProfile] = useState(null);
  const [assignments_list, setAssignmentsList] = useState([]);
  const [selectedDay, setSelectedDay] = useState(new Intl.DateTimeFormat('en-US', {weekday: 'long'}).format(new Date()));
  
  const [isDesktop, setIsDesktop] = useState(window.innerWidth > 1024);

  // Notifications State
  const [notifications, setNotifications] = useState([]);
  const [notifsLoading, setNotifsLoading] = useState(false);

  // Picker State
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerType, setPickerType] = useState(null); // 'exam' or 'paper'

  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth > 1024);
    window.addEventListener('resize', handleResize);
    loadInitialData();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const { isOnline, pendingCount, isSyncing, syncNow } = useOfflineSync();

  const loadInitialData = async () => {
    try {
      setLoading(true);
      const schoolId = user.school_id || user.schoolId;
      const teacherRecordId = user.teacher_record_id || user.id;
      
      initPortalStore(schoolId, teacherRecordId);

      const [activeExams, allPeriods, profile] = await Promise.all([
        getOpenExamsForTeacher().catch(() => []),
        getPeriods().catch(() => []),
        getSchoolProfile().catch(() => null)
      ]);
      
      setSchoolProfile(profile);
      const current = allPeriods.find(p => p.is_active) || allPeriods[0];
      setActivePeriod(current);
      setExams(activeExams);
      if (activeExams.length > 0) setSelectedExamId(activeExams[0].id);

      if (current) {
        const [w, s, c, al] = await Promise.all([
          getTeacherWorkloadSummary(schoolId, current.id, teacherRecordId).catch(() => 0),
          getTeacherTimetable(schoolId, current.id, teacherRecordId).catch(() => []),
          getTimetableConfig(schoolId, current.id).catch(() => []),
          supabase.rpc('portal_get_teacher_assignments', { 
            p_school_id: schoolId, 
            p_period_id: current.id, 
            p_teacher_id: teacherRecordId 
          }).then(r => r.data || []).catch(() => [])
        ]);
        setWorkload(w);
        setSchedule(s);
        setConfig(c);
        setAssignmentsList(al);
      }
    } catch (err) {
      console.error('Staff Portal Init error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Realtime Subscriptions
  useEffect(() => {
    const schoolId = user.school_id || user.schoolId;
    if (!schoolId) return;

    // Listen for exam changes (status, new exams)
    const unsubExams = subscribeToTable('exams', () => {
      getOpenExamsForTeacher().then(setExams).catch(console.error);
    });

    return () => {
      unsubExams();
    };
  }, [user.school_id, user.schoolId]);

  useEffect(() => {
    if (!selectedPaper) return;

    // Listen for mark changes in the current paper
    const unsubMarks = subscribeToTable('exam_marks', (payload) => {
      // Only refresh if the mark belongs to our current paper
      if (payload.new?.exam_paper_id === selectedPaper.id || payload.old?.exam_paper_id === selectedPaper.id) {
        getExamMarksForPaper(selectedPaper.id).then(existingMarks => {
          const buffer = {};
          existingMarks.forEach(m => {
            buffer[m.student_id] = {
              score: m.raw_score,
              isAbsent: m.is_absent
            };
          });
          setMarksBuffer(buffer);
        }).catch(console.error);
      }
    });

    return () => {
      unsubMarks();
    };
  }, [selectedPaper]);

  useEffect(() => {
    if (selectedExamId) {
      loadTeacherPapers();
    }
  }, [selectedExamId]);

  useEffect(() => {
    if (activeTab === 'announcements') {
      loadNotifs();
    }
  }, [activeTab]);

  const loadNotifs = async () => {
    try {
      setNotifsLoading(true);
      const data = await getNotifications();
      // Filter for announcements / info if we only want school-wide news
      // For now, let's just show all notifications
      setNotifications(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setNotifsLoading(false);
    }
  };

  const loadTeacherPapers = async () => {
    try {
      setLoading(true);
      const allPapers = await getExamPapers(selectedExamId);
      setPapers(allPapers);
      setSelectedPaper(null);
      setStudents([]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handlePaperSelect = async (paper) => {
    setSelectedPaper(paper);
    try {
      setLoading(true);
      const className = paper.classes?.name || paper._className || 'Class';
      const streamName = paper.classes?.stream || paper._streamName || null;
      const subjectName = paper.tt_subjects?.name || paper._subject || null;
      const schoolId = user.school_id || user.schoolId;

      let classList, existingMarks;

      if (paper._virtual) {
        // Virtual paper: load students via RPC, marks from marks table
        const { data: studentsData } = await supabase.rpc('portal_get_students_by_class_name', {
          p_school_id: schoolId,
          p_class_name: className
        });
        classList = studentsData || [];
        existingMarks = await getVirtualPaperMarks(schoolId, className, subjectName, paper._examName);
      } else {
        // Real paper: use existing flow
        [classList, existingMarks] = await Promise.all([
          getClassList(className, paper.class_id, subjectName, streamName),
          getExamMarksForPaper(paper.id)
        ]);
      }
      
      setStudents(classList);
      const buffer = {};
      existingMarks.forEach(m => {
        buffer[m.student_id] = {
          score: m.raw_score,
          isAbsent: m.is_absent || false
        };
      });
      setMarksBuffer(buffer);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkChange = (studentId, field, value) => {
    const updatedStudentObj = {
      ...(marksBuffer[studentId] || { score: '', isAbsent: false }),
      [field]: value
    };
    setMarksBuffer({
      ...marksBuffer,
      [studentId]: updatedStudentObj
    });
    if (selectedPaper) {
      saveGradingDraft(selectedPaper.id, studentId, user.id || user.teacher_record_id, updatedStudentObj).catch(console.warn);
    }
  };

  const handleSave = async () => {
    if (!selectedPaper) return;
    
    const subjectName = selectedPaper.tt_subjects?.name || selectedPaper._subject || 'Subject';
    const confirmed = await confirm({
      title: 'Sync Marks?',
      message: `Save marks for ${students.length} students in ${subjectName}?`,
      variant: 'primary'
    });
    if (!confirmed) return;

    setSaving(true);
    try {
      const payload = Object.entries(marksBuffer).map(([studentId, data]) => ({
        student_id: studentId,
        raw_score: data.isAbsent ? null : ((data.score === '' || data.score === null || data.score === undefined) ? null : Number(data.score)),
        is_absent: data.isAbsent,
        remarks: ''
      }));
      
      if (isOnline) {
        await saveExamMarks(selectedPaper.id, payload, selectedPaper._virtual ? selectedPaper : null);
        alert({ title: 'Success', message: 'Marks Synchronized to Cloud!', variant: 'success' });
      } else {
        // Save locally to IndexedDB
        for (const [studentId, data] of Object.entries(marksBuffer)) {
          await saveGradingDraft(selectedPaper.id, studentId, user.id, data);
        }
        alert({ title: 'Saved Offline', message: 'Marks are stored on this device. Cloud sync is not yet confirmed; reconnect and retry the save before relying on them.', variant: 'warning' });
      }
    } catch (err) {
      console.error('[PORTAL] Save error, backing up locally:', err);
      // Local fallback
      for (const [studentId, data] of Object.entries(marksBuffer)) {
        await saveGradingDraft(selectedPaper.id, studentId, user.id, data);
      }
      alert({ title: 'Saved on This Device', message: 'Cloud save failed. A local backup was created, but the school database has not confirmed these marks. Reconnect and retry before leaving this page.', variant: 'warning' });
    } finally {
      setSaving(false);
    }
  };

  if (loading && exams.length === 0) return <Loader />;

  const openPicker = (type) => {
    setPickerType(type);
    setPickerOpen(true);
  };

  const selectOption = (val) => {
    if (pickerType === 'exam') {
      setSelectedExamId(val);
    } else {
      const p = papers.find(pp => pp.id === val);
      if (p) handlePaperSelect(p);
    }
    setPickerOpen(false);
  };

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: DashboardIcon },
    { id: 'grading', label: 'Grading', icon: GradingIcon },
    { id: 'schedule', label: 'Timetable', icon: CalendarIcon },
    { id: 'announcements', label: 'News', icon: MessageIcon },
    { id: 'profile', label: 'Account', icon: UserIcon }
  ];

  return (
    <div style={{ 
      width: '100%', minHeight: '100vh', background: '#f8fafc', 
      display: 'flex', flexDirection: isDesktop ? 'row' : 'column',
      fontFamily: '"Inter", -apple-system, sans-serif' 
    }}>
      <Helmet>
        <title>{user?.name || 'Dashboard'} | Staff Portal — Termly</title>
        <meta name="description" content="Manage grading, attendance, and timetable on the go." />
      </Helmet>
      
      {/* DESKTOP SIDEBAR */}
      {isDesktop && (
        <div style={{ 
          width: '280px', background: '#fff', borderRight: '1px solid #e2e8f0',
          display: 'flex', flexDirection: 'column', padding: '32px 0', position: 'sticky', top: 0, height: '100vh'
        }}>
          <div style={{ padding: '0 32px 40px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TeacherIcon size={20} color="#fff" />
            </div>
            <div style={{ fontWeight: 900, fontSize: '1.2rem', color: '#0f172a' }}>Termly</div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px' }}>
            {navItems.map(item => (
              <div 
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{ 
                  padding: '14px 16px', borderRadius: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 12,
                  background: activeTab === item.id ? '#f0fdf4' : 'transparent',
                  color: activeTab === item.id ? '#10b981' : '#64748b',
                  fontWeight: 700, transition: 'all 0.2s'
                }}
              >
                <item.icon size={22} />
                {item.label}
              </div>
            ))}
          </div>

          <div style={{ padding: '0 16px' }}>
             <div onClick={onLogout} style={{ padding: '14px 16px', borderRadius: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, color: '#ef4444', fontWeight: 700 }}>
                <LogoutIcon size={22} /> Logout
             </div>
          </div>
        </div>
      )}

      {/* MOBILE HEADER */}
      {!isDesktop && (
        <div style={{ 
          background: 'rgba(255, 255, 255, 0.8)', backdropFilter: 'blur(12px)', 
          padding: '20px 24px', position: 'sticky', top: 0, zIndex: 1000, 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '1px solid rgba(0,0,0,0.05)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ 
              background: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)', 
              color: '#fff', width: 44, height: 44, borderRadius: '14px', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', 
              fontSize: '1.4rem', fontWeight: 700, boxShadow: '0 4px 10px rgba(16, 185, 129, 0.3)'
            }}>
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.5px' }}>{user.name}</div>
              <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 500 }}>Staff Portal</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <OfflineSyncBadge isOnline={isOnline} pendingCount={pendingCount} isSyncing={isSyncing} onSync={syncNow} />
            <div onClick={onLogout} style={{ background: '#f1f5f9', padding: '10px', borderRadius: '12px', color: '#64748b', cursor: 'pointer' }}>
              <LogoutIcon size={20} />
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      <div style={{ 
        flex: 1, padding: isDesktop ? '48px 60px' : '24px 20px 100px 20px', 
        maxWidth: isDesktop ? '1000px' : '100%', boxSizing: 'border-box' 
      }}>
        
        {/* Desktop Greeting */}
        {isDesktop && (
          <div style={{ marginBottom: 40, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ margin: 0, fontSize: '2.4rem', fontWeight: 900, color: '#0f172a', letterSpacing: '-1px' }}>Welcome back, {user.name}</h1>
              <p style={{ margin: '8px 0 0', color: '#64748b', fontSize: '1.1rem' }}>Here is what's happening in your classes today.</p>
            </div>
            <OfflineSyncBadge isOnline={isOnline} pendingCount={pendingCount} isSyncing={isSyncing} onSync={syncNow} />
          </div>
        )}

        {activeTab === 'dashboard' && (
          <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? '1fr 1fr' : '1fr', gap: 20 }}>
              <Card style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: '#fff' }} onClick={() => setActiveTab('grading')}>
                <div style={{ fontSize: '0.75rem', opacity: 0.8, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Quick Action</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 800 }}>Enter Marks</div>
                <div style={{ fontSize: '0.8rem', marginTop: 12 }}>{exams.length} active sessions</div>
              </Card>
              <Card style={{ background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', color: '#fff' }} onClick={() => setActiveTab('schedule')}>
                <div style={{ fontSize: '0.75rem', opacity: 0.8, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Quick Action</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 800 }}>View Timetable</div>
                <div style={{ fontSize: '0.8rem', marginTop: 12 }}>Next: {schedule[0]?.subject || 'None'}</div>
              </Card>
            </div>

            {/* TPD Teacher Tracker Widget */}
            <TPDTrackerWidget currentTeacher={user} />

            {assignments_list.length > 0 && (
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#0f172a', marginBottom: 12 }}>My Class Assignments</h3>
                <Card style={{ padding: '20px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {assignments_list.map((a, idx) => (
                      <Badge key={idx} bg="#f0fdf4" color="#16a34a">
                        {a.subject} - {a.class_grade}{a.stream ? ` ${a.stream}` : ''}
                      </Badge>
                    ))}
                  </div>
                </Card>
              </div>
            )}
          </div>
        )}



        {activeTab === 'grading' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: isDesktop ? 32 : 20, animation: 'fadeIn 0.4s ease-out' }}>
            
            {/* My Allocations Summary */}
            {assignments_list.length > 0 && (
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#0f172a', marginBottom: 12 }}>My Allocations</h3>
                <Card style={{ padding: '20px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {assignments_list.map((a, idx) => (
                      <Badge key={idx} bg="#f0fdf4" color="#16a34a">
                        {a.subject} - {a.class_grade}{a.stream ? ` ${a.stream}` : ''}
                      </Badge>
                    ))}
                  </div>
                </Card>
              </div>
            )}
            
            <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? '1fr 2fr' : '1fr', gap: 32 }}>
               <Card style={{ padding: '24px', alignSelf: 'start' }}>
                  <h3 style={{ margin: '0 0 16px', fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>Grade Entry Setup</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    
                    <div onClick={() => openPicker('exam')} style={{ background: '#f8fafc', padding: '16px', borderRadius: '16px', border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                      <div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Examination</div>
                        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
                          {exams.find(e => e.id === selectedExamId)?.name || 'Select Exam Session'}
                        </div>
                      </div>
                      <ChevronDownIcon size={20} color="#94a3b8" />
                    </div>

                    <div onClick={() => openPicker('paper')} style={{ background: '#fff', padding: '16px', borderRadius: '16px', border: '2px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', opacity: !selectedExamId ? 0.6 : 1 }}>
                      <div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Class & Subject</div>
                        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
                          {selectedPaper ? `${selectedPaper.classes?.name || 'Class'} - ${selectedPaper.tt_subjects?.name || 'Subject'}` : 'Choose Assigned Paper'}
                        </div>
                      </div>
                      <ChevronDownIcon size={20} color="#94a3b8" />
                    </div>
                  </div>
               </Card>

               {!selectedPaper ? (
                 <div style={{ textAlign: 'center', padding: '60px 24px', color: '#64748b', background: '#fff', borderRadius: '24px', border: '1px dashed #cbd5e1' }}>
                   <GradingIcon size={48} color="#cbd5e1" style={{ margin: '0 auto 16px' }} />
                   <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>Ready for Entry</div>
                   <div style={{ fontSize: '0.9rem' }}>Select an exam and paper from the left to start entering marks.</div>
                 </div>
               ) : (
                 <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                   <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                     <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' }}>Student List ({students.length})</h3>
                     <button 
                       onClick={handleSave} 
                       disabled={saving || loading}
                       style={{ background: '#10b981', color: 'white', border: 'none', padding: '10px 24px', borderRadius: '14px', fontWeight: 700, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 12px rgba(16, 185, 129, 0.2)', cursor: 'pointer' }}
                     >
                       <SaveIcon size={18} /> {saving ? 'Saving...' : 'Sync to Cloud'}
                     </button>
                   </div>

                   <div style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
                     <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                       <thead>
                         <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                           <th style={{ padding: '12px 20px', fontSize: '0.8rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase' }}>Student Name</th>
                           <th style={{ padding: '12px 20px', fontSize: '0.8rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase' }}>ADM NO</th>
                           <th style={{ padding: '12px 20px', fontSize: '0.8rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase', width: 100, textAlign: 'center' }}>Score</th>
                         </tr>
                       </thead>
                       <tbody>
                         {students.map((s) => {
                           const data = marksBuffer[s.id] || { score: '', isAbsent: false };
                           return (
                             <tr key={s.id} style={{ borderBottom: '1px solid #f1f5f9', transition: 'background 0.2s' }}>
                               <td style={{ padding: '14px 20px', fontWeight: 700, color: '#0f172a' }}>{s.name}</td>
                               <td style={{ padding: '14px 20px', color: '#64748b', fontWeight: 600 }}>{s.adm_no}</td>
                               <td style={{ padding: '10px 20px' }}>
                                 {schoolProfile?.gradingMode === 'rubric' ? (
                                   <select
                                     value={data.score ?? ''}
                                     onChange={(e) => handleMarkChange(s.id, 'score', e.target.value)}
                                     style={{ width: '100%', padding: '10px', border: '1px solid #e2e8f0', borderRadius: '10px', fontSize: '1rem', fontWeight: 700, color: '#0f172a', background: '#fff', outline: 'none' }}
                                   >
                                     <option value="">— Select —</option>
                                     {(schoolProfile.gradingSystems?.[getLevelForGrade(selectedPaper.classes?.name || selectedPaper._className)] || []).map(g => (
                                       <option key={g.symbol} value={g.symbol}>{g.symbol}: {g.name}</option>
                                     ))}
                                   </select>
                                 ) : (
                                   <input
                                     type="number"
                                     inputMode="numeric"
                                     value={data.score ?? ''}
                                     onChange={(e) => handleMarkChange(s.id, 'score', e.target.value)}
                                     style={{ width: '100%', padding: '10px', textAlign: 'center', border: '1px solid #e2e8f0', borderRadius: '10px', fontSize: '1.1rem', fontWeight: 800, color: '#0f172a', background: '#fff', outline: 'none' }}
                                     placeholder="—"
                                   />
                                 )}
                               </td>
                             </tr>
                           );
                         })}
                       </tbody>
                     </table>
                   </div>
                 </div>
               )}
            </div>
          </div>
        )}

        {activeTab === 'schedule' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, animation: 'fadeIn 0.4s ease-out' }}>
            {/* Summary Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? '1fr 1fr 1fr' : '1fr', gap: 20 }}>
               <div style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', padding: '24px', borderRadius: '24px', color: '#fff' }}>
                  <div style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Weekly Workload</div>
                  <div style={{ fontSize: '2rem', fontWeight: 800 }}>{workload} <span style={{ fontSize: '0.9rem', color: '#94a3b8' }}>Periods</span></div>
               </div>
               <div style={{ background: '#fff', padding: '24px', borderRadius: '24px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Active Term</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#0f172a' }}>{activePeriod?.term} {activePeriod?.year}</div>
               </div>
               <div style={{ background: '#fff', padding: '24px', borderRadius: '24px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Classes Today</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#10b981' }}>{schedule.filter(s => s.day_of_week === new Intl.DateTimeFormat('en-US', {weekday: 'long'}).format(new Date())).length} Sessions</div>
               </div>
            </div>

            {/* Mobile Day Selector */}
            {!isDesktop && (
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, margin: '0 -4px' }}>
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(day => (
                  <div 
                    key={day}
                    onClick={() => setSelectedDay(day)}
                    style={{ 
                      padding: '10px 20px', borderRadius: '16px', fontSize: '0.85rem', fontWeight: 700,
                      background: selectedDay === day ? '#10b981' : '#fff',
                      color: selectedDay === day ? '#fff' : '#64748b',
                      border: selectedDay === day ? '1px solid #10b981' : '1px solid #e2e8f0',
                      whiteSpace: 'nowrap', cursor: 'pointer', transition: 'all 0.2s'
                    }}
                  >
                    {day}
                  </div>
                ))}
              </div>
            )}

            {/* Timetable Grid/Timeline */}
            <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? 'repeat(5, 1fr)' : '1fr', gap: 20 }}>
              {(isDesktop ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] : [selectedDay]).map(day => {
                const dayLessons = schedule.filter(s => s.day_of_week === day).sort((a,b) => a.slot_index - b.slot_index);
                
                // MERGING LOGIC: Combine contiguous slots of same subject/class
                const merged = [];
                if (dayLessons.length > 0) {
                  let current = { ...dayLessons[0], mergedCount: 1 };
                  for (let i = 1; i < dayLessons.length; i++) {
                    const next = dayLessons[i];
                    if (next.slot_index === current.slot_index + 1 && 
                        next.subject === current.subject && 
                        next.class_grade === current.class_grade && 
                        next.stream === current.stream) {
                      current.end_time = next.end_time;
                      current.mergedCount++;
                    } else {
                      merged.push(current);
                      current = { ...next, mergedCount: 1 };
                    }
                  }
                  merged.push(current);
                }

                return (
                  <div key={day} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {isDesktop && (
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: '#3b82f6', textTransform: 'uppercase', textAlign: 'center', background: '#eff6ff', padding: '8px', borderRadius: '12px' }}>
                        {day}
                      </div>
                    )}
                    {merged.map(s => (
                      <Card key={s.id} style={{ padding: '16px', borderLeft: '4px solid #10b981', background: '#fff' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#10b981', background: '#f0fdf4', padding: '2px 8px', borderRadius: '6px' }}>
                            {s.start_time.slice(0,5)} — {s.end_time.slice(0,5)}
                          </div>
                          {s.mergedCount > 1 && <Badge bg="#eff6ff" color="#3b82f6">Double</Badge>}
                        </div>
                        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>{s.subject}</div>
                        <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 600 }}>{s.class_grade} {s.stream}</div>
                      </Card>
                    ))}
                    {merged.length === 0 && (
                      <div style={{ padding: '40px 20px', textAlign: 'center', border: '2px dashed #e2e8f0', borderRadius: '24px', color: '#cbd5e1' }}>
                        <CalendarIcon size={32} style={{ opacity: 0.3, marginBottom: 12 }} />
                        <div style={{ fontSize: '0.8rem', fontWeight: 700 }}>No Classes</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'announcements' && (
          <div style={{ animation: 'fadeIn 0.4s ease-out', maxWidth: 600, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 900, color: '#0f172a' }}>News & Announcements</h2>
              <button 
                onClick={loadNotifs}
                disabled={notifsLoading}
                style={{ background: 'transparent', border: 'none', color: '#10b981', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, cursor: 'pointer', opacity: notifsLoading ? 0.5 : 1 }}
              >
                <RefreshIcon size={16} /> Refresh
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {notifsLoading && notifications.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>Loading announcements...</div>
              ) : notifications.length === 0 ? (
                <Card style={{ textAlign: 'center', padding: '40px 20px', borderStyle: 'dashed' }}>
                  <MessageIcon size={32} style={{ opacity: 0.3, marginBottom: 12, color: '#94a3b8' }} />
                  <div style={{ fontSize: '1rem', fontWeight: 700, color: '#64748b' }}>No Announcements</div>
                  <p style={{ margin: '8px 0 0', fontSize: '0.85rem', color: '#94a3b8' }}>You're all caught up!</p>
                </Card>
              ) : (
                notifications.map(n => (
                  <Card 
                    key={n.id} 
                    style={{ 
                      padding: '20px', 
                      borderLeft: n.read_status === 'unread' ? '4px solid #3b82f6' : '4px solid transparent',
                      background: n.read_status === 'unread' ? '#f0f9ff' : '#fff'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <div style={{ fontWeight: 800, fontSize: '1.1rem', color: n.read_status === 'unread' ? '#0f172a' : '#334155' }}>
                        {n.title}
                      </div>
                      {n.read_status === 'unread' && (
                        <button 
                          onClick={async () => {
                            await markNotificationRead(n.id);
                            loadNotifs();
                          }}
                          style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', border: 'none', padding: '4px 10px', borderRadius: '8px', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}
                        >
                          Mark Read
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                      {n.body}
                    </div>
                    <div style={{ marginTop: 12, fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600 }}>
                      {new Date(n.created_at).toLocaleString()}
                    </div>
                  </Card>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'profile' && (
          <div style={{ maxWidth: 600, margin: '0 auto', animation: 'fadeIn 0.4s ease-out' }}>
            <Card style={{ textAlign: 'center', padding: '48px 32px' }}>
              <div style={{ 
                width: 100, height: 100, borderRadius: '32px', background: 'linear-gradient(135deg, #10b981, #3b82f6)',
                color: '#fff', fontSize: '2.5rem', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 24px', boxShadow: '0 12px 24px rgba(16, 185, 129, 0.3)'
              }}>
                {user.name.charAt(0).toUpperCase()}
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: '1.8rem', color: '#0f172a', fontWeight: 900 }}>{user.name}</h2>
              <Badge bg="#dcfce7" color="#16a34a">Official Staff Member</Badge>
              
              <div style={{ marginTop: 48, display: 'flex', flexDirection: 'column', gap: 12 }}>
                 <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px', background: '#f8fafc', borderRadius: '16px' }}>
                    <span style={{ color: '#64748b', fontWeight: 600 }}>Institution</span>
                    <span style={{ color: '#0f172a', fontWeight: 800 }}>{schoolProfile?.name || 'Marete School'}</span>
                 </div>
                 <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px', background: '#f8fafc', borderRadius: '16px' }}>
                    <span style={{ color: '#64748b', fontWeight: 600 }}>Phone Number</span>
                    <span style={{ color: '#0f172a', fontWeight: 800 }}>{user.phone || '0712260057'}</span>
                 </div>
              </div>

              <button 
                onClick={onLogout}
                style={{ width: '100%', background: '#fff1f2', color: '#e11d48', border: 'none', padding: '16px', borderRadius: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', marginTop: 32 }}
               >
                 <LogoutIcon size={18} /> Sign Out of Portal
               </button>
            </Card>
          </div>
        )}
      </div>

      {/* MOBILE BOTTOM NAV */}
      {!isDesktop && (
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, width: '100%', background: 'rgba(255, 255, 255, 0.9)', 
          backdropFilter: 'blur(20px)', display: 'flex', justifyContent: 'space-around',
          padding: '12px 0 calc(12px + env(safe-area-inset-bottom))',
          borderTop: '1px solid rgba(0,0,0,0.05)', zIndex: 1000
        }}>
          {navItems.map(tab => (
            <div 
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{ 
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, 
                color: activeTab === tab.id ? '#10b981' : '#94a3b8',
                cursor: 'pointer', flex: 1
              }}
            >
              <tab.icon size={22} strokeWidth={activeTab === tab.id ? 2.5 : 2} />
              <span style={{ fontSize: '0.65rem', fontWeight: activeTab === tab.id ? 700 : 600 }}>{tab.label}</span>
            </div>
          ))}
        </nav>
      )}

      {/* Modern Picker Sheet Overlay */}
      {pickerOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(4px)', zIndex: 2000, display: 'flex', alignItems: isDesktop ? 'center' : 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: isDesktop ? 32 : '32px 32px 0 0', padding: '24px 24px 40px', maxHeight: '80vh', overflowY: 'auto', animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {!isDesktop && <div style={{ width: 48, height: 5, background: '#e2e8f0', borderRadius: 3, margin: '0 auto 24px' }} />}
            
            <h3 style={{ margin: '0 0 20px', fontSize: '1.3rem', fontWeight: 800, color: '#0f172a' }}>
              {pickerType === 'exam' ? 'Select Exam Session' : 'Select Assigned Paper'}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pickerType === 'exam' ? (
                exams.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>No active exams found.</div> :
                exams.map(e => (
                  <div 
                    key={e.id} 
                    onClick={() => selectOption(e.id)}
                    style={{ padding: '16px 20px', borderRadius: '16px', background: selectedExamId === e.id ? '#f0fdf4' : '#f8fafc', border: selectedExamId === e.id ? '2px solid #10b981' : '2px solid transparent', cursor: 'pointer' }}
                  >
                    <div style={{ fontWeight: 700, color: selectedExamId === e.id ? '#16a34a' : '#0f172a', fontSize: '1.05rem' }}>{e.name}</div>
                    <div style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 600 }}>{e.status}</div>
                  </div>
                ))
              ) : (
                papers.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>No papers assigned to you in this exam.</div> :
                papers.map(p => (
                  <div 
                    key={p.id} 
                    onClick={() => selectOption(p.id)}
                    style={{ padding: '16px 20px', borderRadius: '16px', background: selectedPaper?.id === p.id ? '#f0fdf4' : '#f8fafc', border: selectedPaper?.id === p.id ? '2px solid #10b981' : '2px solid transparent', cursor: 'pointer' }}
                  >
                    <div style={{ fontWeight: 700, color: selectedPaper?.id === p.id ? '#16a34a' : '#0f172a', fontSize: '1.05rem' }}>
                      {p.classes?.name || 'Class'} {p.classes?.stream || ''}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 600 }}>{p.tt_subjects?.name || 'Subject'}</div>
                  </div>
                ))
              )}
            </div>

            <button 
              onClick={() => setPickerOpen(false)}
              style={{ width: '100%', padding: '14px', borderRadius: '16px', border: 'none', background: '#f1f5f9', color: '#475569', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', marginTop: 24 }}
            >
              Cancel
            </button>
          </div>
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
      `}</style>
    </div>
  );
}
