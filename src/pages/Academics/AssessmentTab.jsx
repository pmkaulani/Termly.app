import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import {
  getClassResults,
  setStudentAllMarks,
  getSubjectRankings,
  getClassList,
  getCBC,
  setCBC,
  getCoreCompetencies,
  subscribeToTable,
  getSubjectAssignments,
  getExams,
  releaseExamToParents,
  updateExamStatus,
  finalizeExam,
  unlockExam
} from '../../data/academicsStore';
import { getTeacherPerformance } from '../../data/staffStore';
import { getPrintHeader, getPrintFooter, getSchoolProfile } from '../../data/coreStore';
import {
  CBC_STRUCTURE,
  CBC_LEVELS,
  CBC_CORE_COMPETENCIES,
  STREAMS,
  getSubjectsForGrade,
  getLevelForGrade
} from '../../data/seedData';
import {
  LeafIcon, BookIcon, PrintIcon, DashboardIcon, EditIcon,
  FlagIcon, RocketIcon, TeacherIcon, SchoolIcon, SaveIcon,
  SparklesIcon, TrendUpIcon, ChartBarIcon, SettingsIcon, CrossIcon, EyeOffIcon,
  LockIcon, CheckIcon, RefreshIcon, HistoryIcon, TargetIcon
} from '../../components/CommonIcons';
import Select from '../../components/Common/Select';
import { useDialog } from '../../contexts/DialogContext';
import { getProfessionalRemark } from '../../utils/remarkUtils';
import { downloadReportCardPDF } from '../../utils/reportCard';
import { useFeature } from '../../contexts/FeaturesContext';
import {
  getGradeForScore,
  assignCompetitionRanks,
  calculateStudentSummary,
  calculatePerformanceStatistics,
  calculatePerformanceTrend
} from '../../utils/assessmentCalculations';
import MarksSpreadsheet from '../../components/Academics/MarksSpreadsheet';
import AssessmentAuditModal from '../../components/Academics/AssessmentAuditModal';

export default function AssessmentTab({ currentUser, currentPeriodId }) {
  const loadResultsRef = useRef();
  const { alert, confirm, prompt } = useDialog();
  const { enabled: hasTeacherPortal } = useFeature('teacher_portal');
  const { enabled: hasParentPortal } = useFeature('parent_portal');

  const [selectedClass, setSelectedClass] = useState(sessionStorage.getItem('grading_class') || 'All');
  const [streamFilter, setStreamFilter] = useState('All');
  const [results, setResults] = useState([]);
  const [rawMarksMap, setRawMarksMap] = useState({});
  const [showReport, setShowReport] = useState(null);
  const [activeTab, setActiveTab] = useState('marks'); // 'marks', 'review', 'analysis', 'cbc', 'competencies'
  const [subjectRankings, setSubjectRankings] = useState({});
  const [showSubjectPicker, setShowSubjectPicker] = useState(null);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [cbcData, setCbcData] = useState({});
  const [teacherPerf, setTeacherPerf] = useState({});
  const [selectedSubject, setSelectedSubject] = useState('');
  const [coreCompData, setCoreCompData] = useState({});
  const [savingStatus, setSavingStatus] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'offline' | 'error'

  const [profile, setProfile] = useState({ streams: [], activeClasses: [] });
  const [selectedPathway, setSelectedPathway] = useState('STEM');
  const [examType, setExamType] = useState('');
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState({});
  const [robustExams, setRobustExams] = useState([]);

  // Search and Review filter state
  const [reviewSearch, setReviewSearch] = useState('');
  const [reviewGradeFilter, setReviewGradeFilter] = useState('ALL');
  const [reviewPassFailFilter, setReviewPassFailFilter] = useState('ALL');

  const userRole = currentUser?.role?.toLowerCase() || 'teacher';
  const isAdmin = userRole === 'admin' || userRole === 'superadmin';
  const isTeacher = userRole === 'teacher';

  const subjects = getSubjectsForGrade(selectedClass, profile, selectedPathway);
  const level = getLevelForGrade(selectedClass);
  const isEarlyYears = level === 'Early Years';

  const currentExamObj = robustExams.find(e => e.name === examType) || null;
  const examStatus = currentExamObj?.status || 'open';
  const isFinalized = examStatus === 'finalized' || examStatus === 'published';

  // Trigger migration on load if needed
  useEffect(() => {
    import('../../data/studentStore').then(m => m.migrateExistingStudentsSubjects());
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const [p, a, e] = await Promise.all([getSchoolProfile(), getSubjectAssignments(), getExams()]);
        setProfile(p);
        setAssignments(a);
        setRobustExams(e);

        let currentExam = examType;
        if (e.length > 0) {
          const exists = e.find(ex => ex.name === examType);
          if (!exists) {
            currentExam = e[0].name;
            setExamType(currentExam);
          }
        }

        await loadResults(currentExam);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    init();

    // Real-time table subscription
    const unsubMarks = subscribeToTable('marks', () => {
      if (loadResultsRef.current) loadResultsRef.current();
    });

    return () => {
      unsubMarks();
    };
  }, [selectedClass, streamFilter, selectedPathway, examType, currentUser, currentPeriodId]);

  const loadResults = async (overrideExamType = null) => {
    loadResultsRef.current = loadResults;
    const targetExam = overrideExamType || examType;
    if (!selectedClass || selectedClass === 'All') {
      setResults([]);
      setRawMarksMap({});
      setSubjectRankings({});
      setCbcData({});
      setTeacherPerf([]);
      setCoreCompData({});
      return;
    }

    let r = await getClassResults(selectedClass, targetExam);
    if (streamFilter !== 'All') r = r.filter(s => s.stream === streamFilter);

    // Standard competition ranking with ties (1, 2, 2, 4)
    r = assignCompetitionRanks(r, 'total', 'average');
    setResults(r);

    const m = {};
    r.forEach(s => {
      m[s.id] = { ...(s.rawMarks || s.marks) };
    });
    setRawMarksMap(m);

    const [rankD, cbcD, perfD, ccD] = await Promise.all([
      getSubjectRankings(selectedClass, targetExam),
      getCBC(),
      getTeacherPerformance(targetExam),
      getCoreCompetencies()
    ]);
    setSubjectRankings(rankD);
    setCbcData(cbcD);
    setTeacherPerf(perfD);
    setCoreCompData(ccD);

    const pway = level === 'Senior Secondary' ? selectedPathway : 'STEM';
    const subs = getSubjectsForGrade(selectedClass, profile, pway);
    setSelectedSubject(subs[0] || '');
  };

  // Autosave handler for MarksSpreadsheet
  const handleAutosaveMarks = useCallback(async (updatedMarks) => {
    if (!navigator.onLine) {
      setSavingStatus('offline');
      return;
    }

    setSavingStatus('saving');
    try {
      await Promise.all(
        Object.entries(updatedMarks).map(([sid, marks]) =>
          setStudentAllMarks(sid, marks, examType)
        )
      );
      setSavingStatus('saved');
      setRawMarksMap(updatedMarks);
    } catch (err) {
      console.error('Autosave error:', err);
      setSavingStatus('error');
    }
  }, [examType]);

  const handleFinalizeAssessment = async () => {
    if (!currentExamObj) return;

    const ok = await confirm({
      title: 'Finalize Assessment?',
      message: `Finalizing "${currentExamObj.name}" will lock marks entry for teachers. Results will be locked until reopened by an administrator. Continue?`,
      variant: 'warning'
    });

    if (ok) {
      setLoading(true);
      try {
        await finalizeExam(currentExamObj.id);
        const refreshed = await getExams();
        setRobustExams(refreshed);
        alert({ title: 'Finalized', message: 'Assessment has been finalized and marks entry locked.', variant: 'success' });
      } catch (err) {
        alert({ title: 'Error', message: err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };

  const handleUnlockAssessment = async () => {
    if (!currentExamObj) return;

    const ok = await confirm({
      title: 'Unlock Assessment?',
      message: `Reopening "${currentExamObj.name}" will allow teachers to edit marks again. Are you sure you want to unlock?`,
      variant: 'primary'
    });

    if (ok) {
      setLoading(true);
      try {
        await unlockExam(currentExamObj.id, 'Administrator unlocked marks entry');
        const refreshed = await getExams();
        setRobustExams(refreshed);
        alert({ title: 'Unlocked', message: 'Assessment has been reopened for marks entry.', variant: 'success' });
      } catch (err) {
        alert({ title: 'Error', message: err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };

  const handleReleaseResults = async () => {
    if (!examType || !currentExamObj) return;
    const isCurrentlyReleased = currentExamObj.released_to_parents;

    const confirmed = await confirm({
      title: isCurrentlyReleased ? 'Hide from Parents?' : 'Post to Parents?',
      message: isCurrentlyReleased
        ? `Are you sure you want to hide results for "${currentExamObj.name}" from parents?`
        : `Are you sure you want to post results for "${currentExamObj.name}"? They will become immediately visible to parents.`,
      variant: isCurrentlyReleased ? 'warning' : 'primary'
    });

    if (confirmed) {
      setLoading(true);
      try {
        await releaseExamToParents(currentExamObj.id, !isCurrentlyReleased);
        const refreshed = await getExams();
        setRobustExams(refreshed);
        alert({
          title: isCurrentlyReleased ? 'Hidden' : 'Posted!',
          message: isCurrentlyReleased
            ? 'Results hidden from the Parent Portal.'
            : 'Results are now live on the Parent Portal.',
          variant: 'success'
        });
      } catch (err) {
        alert({ title: 'Error', message: 'Operation failed: ' + err.message, variant: 'danger' });
      } finally {
        setLoading(false);
      }
    }
  };

  const handleCBCChange = async (sid, sub, lv) => {
    try {
      await setCBC(sid, sub, lv);
      setCbcData(await getCBC());
    } catch (err) {
      alert({ title: 'Assessment Error', message: err.message, variant: 'danger' });
    }
  };

  const handleSubjectSelection = async (newSubjects) => {
    if (!showSubjectPicker) return;
    setLoading(true);
    try {
      const { updateStudent } = await import('../../data/studentStore');
      await updateStudent(showSubjectPicker.id, { subjects: newSubjects });
      setShowSubjectPicker(null);
      await loadResults();
    } catch (err) {
      alert({ title: 'Update Error', message: err.message, variant: 'danger' });
    } finally {
      setLoading(false);
    }
  };

  const getGrade = (avg) => {
    return getGradeForScore(avg, { className: selectedClass, profile });
  };

  const cbcLabel = (lv) => {
    const short = {
      'Exceeding Expectation': 'EE',
      'Meeting Expectation': 'ME',
      'Approaching Expectation': 'AE',
      'Below Expectation': 'BE'
    };
    return short[lv] || 'ME';
  };

  const cbcColor = (lv) => {
    const c = {
      'Exceeding Expectation': '#10b981',
      'Meeting Expectation': '#3b82f6',
      'Approaching Expectation': '#f59e0b',
      'Below Expectation': '#ef4444'
    };
    return c[lv] || '#3b82f6';
  };

  // Shared Excel-style CSS for print
  const excelCSS = `
    body{font-family:'Calibri','Arial',sans-serif;padding:12px;margin:0;color:#000;font-size:11px}
    h2{font-size:14px;margin:0 0 2px;text-transform:uppercase;font-weight:700}
    .sub{font-size:10px;color:#000;margin-bottom:10px}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border:1px solid #000;padding:4px 6px;text-align:center;font-size:10px}
    th{background:#fff;font-weight:700;text-transform:uppercase;font-size:9px}
    td{background:#fff}
    td.nm{text-align:left;font-weight:500;white-space:nowrap}
    .ft{margin-top:12px;font-size:9px;color:#000;display:flex;justify-content:space-between}
    @page{size:portrait;margin:0}
    @media print{body{padding:15mm}}
  `;

  const subjectAbbr = (name) => {
    const map = {
      'English': 'ENG', 'Kiswahili': 'KIS', 'Mathematics': 'MATH', 'Biology': 'BIO',
      'Physics': 'PHY', 'Chemistry': 'CHEM', 'History & Government': 'HIST', 'History': 'HIST',
      'Geography': 'GEO', 'Christian Religious Education': 'CRE', 'Islamic Religious Education': 'IRE',
      'Hindu Religious Education': 'HRE', 'Business Studies': 'BST', 'Agriculture': 'AGRI',
      'Computer Studies': 'COMP', 'Computer Science': 'COMP',
      'French': 'FRE', 'German': 'GER', 'Arabic': 'ARB', 'Art & Design': 'ART',
      'Music': 'MUS', 'Home Science': 'H/SC'
    };
    if (map[name]) return map[name];
    const words = name.split(/[\s&\/]+/).filter(w => w.length > 0);
    if (words.length >= 2) return words.map(w => w[0]).join('').toUpperCase().substring(0, 4);
    return name.substring(0, 4).toUpperCase();
  };

  const printClassList = async () => {
    try {
      let list = await getClassList(selectedClass);
      if (streamFilter !== 'All') list = list.filter(s => s.stream === streamFilter);
      list.sort((a, b) => String(a.admNo || '').localeCompare(String(b.admNo || ''), undefined, { numeric: true }));
      const sl = streamFilter === 'All' ? '' : ` - ${streamFilter}`;

      const headerStr = await getPrintHeader(`${selectedClass}${sl} CLASS LIST | ${examType} | Students: ${list.length}`);
      const footerStr = await getPrintFooter();

      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>Class List - ${selectedClass}</title>
      <style>${excelCSS}</style></head><body>
      ${headerStr}
      <table><thead><tr>
        <th style="width:30px">#</th><th style="width:70px">ADM NO</th>
        <th style="text-align:left;min-width:140px">STUDENT NAME</th>
        ${subjects.map(s => `<th>${subjectAbbr(s)}</th>`).join('')}
        <th>TTL</th><th>AVG</th><th>GRD</th>
      </tr></thead><tbody>
        ${list.map((s, i) => `<tr><td>${i + 1}</td><td>${s.admNo || ''}</td><td class="nm">${s.name}</td>${subjects.map(() => '<td></td>').join('')}<td></td><td></td><td></td></tr>`).join('')}
      </tbody></table>
      ${footerStr}
      </body></html>`);
      w.document.close();
      w.print();
    } catch (err) {
      alert({ title: 'Print Error', message: err.message, variant: 'danger' });
    }
  };

  const printClassResults = async () => {
    try {
      const sl = streamFilter === 'All' ? '' : ` - ${streamFilter}`;
      const headerStr = await getPrintHeader(`${selectedClass}${sl} STREAM RESULTS | ${examType}`);
      const footerStr = await getPrintFooter();
      const w = window.open('', '_blank');

      w.document.write(`<html><head><title>Results - ${selectedClass}</title>
      <style>${excelCSS}</style></head><body>
      ${headerStr}
      <table><thead><tr>
        <th style="width:30px">POS</th><th style="width:65px">ADM</th>
        <th style="text-align:left;min-width:130px">STUDENT NAME</th>
        ${subjects.map(s => `<th>${subjectAbbr(s)}</th>`).join('')}
        <th>TTL</th><th>AVG%</th><th>GRD</th>
      </tr></thead><tbody>
        ${results.map((s) => `<tr>
          <td>${s.rank}</td><td>${s.admNo || ''}</td><td class="nm">${s.name}</td>
          ${subjects.map(sub => {
            const raw = (s.rawMarks || s.marks)?.[sub];
            return `<td>${raw !== undefined && raw !== null ? raw : '—'}</td>`;
          }).join('')}
          <td><strong>${s.total}</strong></td><td><strong>${s.average}%</strong></td><td><strong>${s.grade}</strong></td>
        </tr>`).join('')}
      </tbody></table>
      ${footerStr}
      </body></html>`);
      w.document.close();
      w.print();
    } catch (err) {
      alert({ title: 'Print Error', message: err.message, variant: 'danger' });
    }
  };

  const printGradeResults = async () => {
    printClassResults();
  };

  const printAllReportCards = async () => {
    try {
      const w = window.open('', '_blank');
      const headerStr = await getPrintHeader(`Official Report Cards — ${selectedClass} | ${examType}`);
      const footerStr = await getPrintFooter();

      const cardsHtml = results.map(student => {
        const studentCBC = cbcData[student.id] || {};
        return `
        <div class="report-page" style="page-break-after: always; padding: 20px; font-family: sans-serif; font-size: 11px;">
          ${headerStr}
          <div style="border: 1px solid #cbd5e1; padding: 12px; margin: 12px 0; border-radius: 6px;">
            <strong>Student:</strong> ${student.name} &nbsp;|&nbsp;
            <strong>Adm No:</strong> ${student.admNo} &nbsp;|&nbsp;
            <strong>Class:</strong> ${student.class} &nbsp;|&nbsp;
            <strong>Position:</strong> ${student.rank} of ${results.length}
          </div>
          <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
            <thead>
              <tr style="background: #1e3a5f; color: white;">
                <th style="padding: 6px; border: 1px solid #cbd5e1; text-align: left;">Subject</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1;">Score</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1;">Grade</th>
                <th style="padding: 6px; border: 1px solid #cbd5e1;">Remark</th>
              </tr>
            </thead>
            <tbody>
              ${subjects.map(sub => {
                const mark = (student.rawMarks || student.marks)?.[sub] || '—';
                const g = getGrade(mark);
                return `
                <tr>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; font-weight: 600;">${sub}</td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">${mark}</td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center; font-weight: 700;">${g.grade}</td>
                  <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">${g.remarks}</td>
                </tr>`;
              }).join('')}
              <tr style="background: #f8fafc; font-weight: 700;">
                <td style="padding: 6px; border: 1px solid #cbd5e1;">Summary</td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">Total: ${student.total}</td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">Avg: ${student.average}%</td>
                <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">Grade: ${student.grade}</td>
              </tr>
            </tbody>
          </table>
          <div style="margin-top: 24px;">
            <div><strong>Teacher Remark:</strong> ${getProfessionalRemark(student.average, student.id)}</div>
            <div style="margin-top: 30px; display: flex; justify-content: space-between;">
              <div>________________________<br/>Class Teacher</div>
              <div>________________________<br/>Head Teacher</div>
            </div>
          </div>
        </div>`;
      }).join('');

      w.document.write(`<html><head><title>Report Cards - ${selectedClass}</title></head><body>${cardsHtml}${footerStr}</body></html>`);
      w.document.close();
      w.print();
    } catch (err) {
      alert({ title: 'Print Error', message: err.message, variant: 'danger' });
    }
  };

  // Filtered review results
  const reviewResults = useMemo(() => {
    return results.filter(s => {
      if (reviewSearch) {
        const query = reviewSearch.toLowerCase();
        const mName = (s.name || '').toLowerCase().includes(query);
        const mAdm = (s.admNo || s.adm_no || '').toLowerCase().includes(query);
        if (!mName && !mAdm) return false;
      }
      if (reviewGradeFilter !== 'ALL' && s.grade !== reviewGradeFilter) return false;
      if (reviewPassFailFilter === 'PASS' && !s.isPass) return false;
      if (reviewPassFailFilter === 'FAIL' && s.isPass) return false;
      return true;
    });
  }, [results, reviewSearch, reviewGradeFilter, reviewPassFailFilter]);

  return (
    <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Helmet>
        <title>Grading & Assessment Management | Termly</title>
      </Helmet>

      {/* Consolidated Toolbar: Filters, Exam Status & Quick Actions */}
      <div style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '12px 18px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '14px'
      }}>
        {/* Left Side: Class, Stream, Exam Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>Class:</label>
            <Select
              value={selectedClass}
              onChange={e => { setSelectedClass(e.target.value); setStreamFilter('All'); }}
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>Stream:</label>
            <Select
              value={streamFilter}
              onChange={e => setStreamFilter(e.target.value)}
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
              style={{ minWidth: 120 }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>Exam:</label>
            <Select
              value={examType}
              onChange={e => setExamType(e.target.value)}
              options={robustExams.map(re => ({ id: re.name, label: re.name }))}
              style={{ minWidth: 140 }}
            />
          </div>

          {/* Inline Exam Status Badge & Audit Button */}
          {examType && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '6px', borderLeft: '1px solid #e2e8f0' }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                background: isFinalized ? '#fee2e2' : '#dcfce7',
                color: isFinalized ? '#991b1b' : '#15803d',
                padding: '4px 10px',
                borderRadius: '12px',
                fontSize: '0.75rem',
                fontWeight: 700,
                border: isFinalized ? '1px solid #fecaca' : '1px solid #bbf7d0'
              }}>
                {isFinalized ? <LockIcon size={12} /> : <CheckIcon size={12} />}
                {isFinalized ? 'Locked' : 'Open for Entry'}
              </span>

              {isAdmin && (
                isFinalized ? (
                  <button
                    onClick={handleUnlockAssessment}
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: '0.75rem', color: '#2563eb', fontWeight: 600, padding: '4px 8px' }}
                    title="Reopen marks entry"
                  >
                    <RefreshIcon size={12} /> Unlock
                  </button>
                ) : (
                  <button
                    onClick={handleFinalizeAssessment}
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: '0.75rem', color: '#dc2626', fontWeight: 600, padding: '4px 8px' }}
                    title="Lock and finalize marks"
                  >
                    <LockIcon size={12} /> Finalize
                  </button>
                )
              )}

              <button
                onClick={() => setShowAuditModal(true)}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '0.75rem', color: '#475569', fontWeight: 600, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title="View mark edit history"
              >
                <HistoryIcon size={13} /> Audit Log
              </button>

              {hasParentPortal && currentExamObj?.released_to_parents && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: '#f0fdf4',
                  color: '#16a34a',
                  border: '1px solid #bbf7d0',
                  padding: '3px 8px',
                  borderRadius: '10px',
                  fontSize: '0.72rem',
                  fontWeight: 600
                }}>
                  <CheckIcon size={11} /> Published to Parents
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right Side: Reports & Print Actions */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
          <button className="btn btn-ghost btn-sm" onClick={printClassList}><PrintIcon size={14} /> Class List</button>
          <button className="btn btn-ghost btn-sm" onClick={printClassResults}><DashboardIcon size={14} /> Stream Results</button>
          <button className="btn btn-accent btn-sm" onClick={printAllReportCards}><BookIcon size={14} /> Print Report Cards</button>
        </div>
      </div>

      {/* Main Modes Tab Navigation */}
      <div style={{
        display: 'flex',
        gap: '8px',
        borderBottom: '2px solid #e2e8f0',
        paddingBottom: '2px'
      }}>
        <button
          onClick={() => setActiveTab('marks')}
          style={{
            padding: '8px 18px',
            border: 'none',
            borderBottom: activeTab === 'marks' ? '3px solid #2563eb' : '3px solid transparent',
            background: 'transparent',
            color: activeTab === 'marks' ? '#2563eb' : '#64748b',
            fontWeight: 700,
            fontSize: '0.88rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <EditIcon size={16} /> Enter Marks
        </button>

        <button
          onClick={() => setActiveTab('review')}
          style={{
            padding: '8px 18px',
            border: 'none',
            borderBottom: activeTab === 'review' ? '3px solid #2563eb' : '3px solid transparent',
            background: 'transparent',
            color: activeTab === 'review' ? '#2563eb' : '#64748b',
            fontWeight: 700,
            fontSize: '0.88rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <DashboardIcon size={16} /> Review Results
        </button>

        <button
          onClick={() => setActiveTab('analysis')}
          style={{
            padding: '8px 18px',
            border: 'none',
            borderBottom: activeTab === 'analysis' ? '3px solid #2563eb' : '3px solid transparent',
            background: 'transparent',
            color: activeTab === 'analysis' ? '#2563eb' : '#64748b',
            fontWeight: 700,
            fontSize: '0.88rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <ChartBarIcon size={16} /> Performance Analysis
        </button>

        {isEarlyYears && (
          <>
            <button
              onClick={() => setActiveTab('cbc')}
              style={{
                padding: '8px 18px',
                border: 'none',
                borderBottom: activeTab === 'cbc' ? '3px solid #2563eb' : '3px solid transparent',
                background: 'transparent',
                color: activeTab === 'cbc' ? '#2563eb' : '#64748b',
                fontWeight: 700,
                fontSize: '0.88rem',
                cursor: 'pointer'
              }}
            >
              CBC Matrix
            </button>
            <button
              onClick={() => setActiveTab('competencies')}
              style={{
                padding: '8px 18px',
                border: 'none',
                borderBottom: activeTab === 'competencies' ? '3px solid #2563eb' : '3px solid transparent',
                background: 'transparent',
                color: activeTab === 'competencies' ? '#2563eb' : '#64748b',
                fontWeight: 700,
                fontSize: '0.88rem',
                cursor: 'pointer'
              }}
            >
              Core Competencies
            </button>
          </>
        )}
      </div>

      {/* MODE 1: ENTER MARKS (SPREADSHEET) */}
      {activeTab === 'marks' && (
        selectedClass === 'All' ? (
          <div style={{
            background: '#ffffff',
            padding: '50px',
            textAlign: 'center',
            borderRadius: '8px',
            border: '1px solid #e2e8f0',
            color: '#64748b'
          }}>
            <p style={{ fontSize: '1rem', fontWeight: 600 }}>Please select a specific class from the dropdown above to enter and manage marks.</p>
          </div>
        ) : (
          <MarksSpreadsheet
            students={results}
            subjects={subjects}
            subjectConfigs={{}}
            initialMarks={rawMarksMap}
            assignments={assignments}
            currentUser={currentUser}
            profile={profile}
            selectedClass={selectedClass}
            examStatus={examStatus}
            onSaveMarks={handleAutosaveMarks}
            savingStatus={savingStatus}
            onManageSubjects={setShowSubjectPicker}
          />
        )
      )}

      {/* MODE 2: REVIEW RESULTS (CLEAN READ-ONLY) */}
      {activeTab === 'review' && (
        <div style={{
          background: '#ffffff',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px'
        }}>
          {/* Review Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="text"
                placeholder="Search student or Adm No..."
                value={reviewSearch}
                onChange={e => setReviewSearch(e.target.value)}
                style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.82rem', width: '220px' }}
              />
              <Select
                value={reviewGradeFilter}
                onChange={e => setReviewGradeFilter(e.target.value)}
                options={[
                  { id: 'ALL', label: 'All Grades' },
                  { id: 'A', label: 'Grade A' },
                  { id: 'B', label: 'Grade B' },
                  { id: 'C', label: 'Grade C' },
                  { id: 'D', label: 'Grade D' },
                  { id: 'E', label: 'Grade E' }
                ]}
                size="sm"
                style={{ minWidth: 125 }}
              />
              <Select
                value={reviewPassFailFilter}
                onChange={e => setReviewPassFailFilter(e.target.value)}
                options={[
                  { id: 'ALL', label: 'All Outcomes' },
                  { id: 'PASS', label: 'Pass Only (≥50%)' },
                  { id: 'FAIL', label: 'Fail Only (<50%)' }
                ]}
                size="sm"
                style={{ minWidth: 145 }}
              />
            </div>
            <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
              Showing {reviewResults.length} of {results.length} students
            </span>
          </div>

          {/* Results Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Rank</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Adm No</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Student Name</th>
                  {subjects.map(s => (
                    <th key={s} style={{ padding: '8px 8px', border: '1px solid #cbd5e1', textAlign: 'center' }}>{subjectAbbr(s)}</th>
                  ))}
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Total</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Average</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Grade</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {reviewResults.length === 0 ? (
                  <tr>
                    <td colSpan={subjects.length + 5} style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>
                      No students found.
                    </td>
                  </tr>
                ) : (
                  reviewResults.map(s => (
                    <tr key={s.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700 }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '24px',
                          height: '24px',
                          borderRadius: '50%',
                          background: s.rank <= 3 ? '#fef3c7' : '#f1f5f9',
                          color: s.rank <= 3 ? '#b45309' : '#64748b'
                        }}>
                          {s.rank}
                        </span>
                      </td>
                      <td style={{ padding: '6px 8px', fontWeight: 600, color: '#475569' }}>{s.admNo || s.adm_no}</td>
                      <td style={{ padding: '6px 8px', fontWeight: 600 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span>{s.name}</span>
                          <button
                            type="button"
                            onClick={() => setShowSubjectPicker(s)}
                            className="btn-icon"
                            title={`Manage subjects for ${s.name}`}
                            style={{
                              padding: '2px 4px',
                              border: 'none',
                              background: 'transparent',
                              color: '#64748b',
                              cursor: 'pointer',
                              borderRadius: '4px',
                              display: 'inline-flex',
                              alignItems: 'center'
                            }}
                          >
                            <SettingsIcon size={13} />
                          </button>
                        </div>
                      </td>
                      {subjects.map(sub => {
                        const isEnrolled = !s.subjects || s.subjects.length === 0 || s.subjects.includes(sub);
                        if (!isEnrolled) {
                          return (
                            <td key={sub} style={{ padding: '6px 8px', textAlign: 'center', color: '#94a3b8', background: '#f8fafc' }} title="Not enrolled">
                              —
                            </td>
                          );
                        }
                        const raw = (s.rawMarks || s.marks)?.[sub];
                        return (
                          <td key={sub} style={{ padding: '6px 8px', textAlign: 'center', color: raw < 50 && typeof raw === 'number' ? '#dc2626' : 'inherit' }}>
                            {raw !== undefined && raw !== null ? raw : '—'}
                          </td>
                        );
                      })}
                      <td style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700 }}>{s.total}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700 }}>{s.average}%</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 800, color: s.gradeColor || '#1e293b' }}>{s.grade}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                        <button
                          onClick={() => setShowReport(s)}
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                        >
                          Report Card
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODE 3: PERFORMANCE ANALYSIS */}
      {activeTab === 'analysis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Class Summary Metrics */}
          {(() => {
            const stats = calculatePerformanceStatistics(results, subjects, {});
            return (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '12px'
              }}>
                <div style={{ background: '#ffffff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Class Average</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#2563eb', marginTop: '4px' }}>{stats.classStats.average}%</div>
                </div>
                <div style={{ background: '#ffffff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Highest Average</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#16a34a', marginTop: '4px' }}>{stats.classStats.highest}%</div>
                </div>
                <div style={{ background: '#ffffff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Lowest Average</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#dc2626', marginTop: '4px' }}>{stats.classStats.lowest}%</div>
                </div>
                <div style={{ background: '#ffffff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Pass Rate (&ge;50%)</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: stats.classStats.passRate >= 50 ? '#16a34a' : '#dc2626', marginTop: '4px' }}>
                    {stats.classStats.passRate}%
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Subject Performance Breakdown Table */}
          <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '16px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '0.95rem', fontWeight: 700 }}>
              Subject Performance Breakdown
            </h4>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Subject</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Mean Score</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Highest</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Lowest</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Pass Rate</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Entered</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Missing / ABS</th>
                </tr>
              </thead>
              <tbody>
                {subjects.map(sub => {
                  const stat = calculatePerformanceStatistics(results, subjects, {}).subjectStats[sub];
                  if (!stat) return null;

                  return (
                    <tr key={sub} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{sub}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700 }}>{stat.average}%</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#16a34a', fontWeight: 700 }}>{stat.highest}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#dc2626', fontWeight: 700 }}>{stat.lowest}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: stat.passRate >= 50 ? '#16a34a' : '#dc2626' }}>{stat.passRate}%</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{stat.entered}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: stat.missing + stat.absent > 0 ? '#b91c1c' : '#64748b' }}>
                        {stat.missing} M / {stat.absent} ABS
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Subject Rankings / Student Leaderboard */}
          <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>
                  Subject Rankings & Student Performance — {selectedClass}
                </h4>
                <p style={{ margin: '2px 0 0 0', fontSize: '0.78rem', color: '#64748b' }}>
                  Select any subject to view the ranked leaderboard, student marks, grades, and completion.
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '0.82rem', color: '#475569', fontWeight: 600 }}>Subject:</span>
                <Select
                  value={selectedSubject || subjects[0] || ''}
                  onChange={e => setSelectedSubject(e.target.value)}
                  options={subjects.map(s => ({ id: s, label: s }))}
                  size="sm"
                  style={{ minWidth: 170 }}
                />
              </div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center', width: '50px' }}>Rank</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Student Name</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center', width: '90px' }}>Marks</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center', width: '80px' }}>Grade</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left', minWidth: '150px' }}>Performance</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const targetSub = selectedSubject || subjects[0];
                  const subList = (subjectRankings[targetSub] || [])
                    .filter(s => !s.subjects || s.subjects.length === 0 || s.subjects.includes(targetSub));

                  if (!targetSub || subList.length === 0) {
                    return (
                      <tr>
                        <td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>
                          No students enrolled or marks recorded for {targetSub || 'this subject'}.
                        </td>
                      </tr>
                    );
                  }

                  return subList.map((s, idx) => {
                    const gradeInfo = getGrade(s.mark);
                    const pct = Math.min(100, Math.max(0, s.mark || 0));

                    return (
                      <tr key={s.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '26px',
                            height: '26px',
                            borderRadius: '50%',
                            background: idx < 3 ? '#fef3c7' : '#f1f5f9',
                            color: idx < 3 ? '#d97706' : '#64748b',
                            fontSize: '0.82rem',
                            fontWeight: 700
                          }}>
                            {idx + 1}
                          </span>
                        </td>
                        <td style={{ padding: '6px 10px', fontWeight: 600 }}>{s.name}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700 }}>{s.mark}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700, color: gradeInfo.color }}>
                          {gradeInfo.grade}
                        </td>
                        <td style={{ padding: '6px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div style={{ flex: 1, height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
                              <div style={{
                                width: `${pct}%`,
                                height: '100%',
                                background: pct >= 80 ? '#16a34a' : pct >= 65 ? '#2563eb' : pct >= 50 ? '#eab308' : '#dc2626',
                                borderRadius: '4px'
                              }} />
                            </div>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600, width: '35px', textAlign: 'right' }}>
                              {pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CBC Matrix & Competencies Tabs (Early Years) */}
      {activeTab === 'cbc' && isEarlyYears && (
        <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '16px', overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Student</th>
                {subjects.map(s => <th key={s} style={{ fontSize: '0.7rem' }}>{subjectAbbr(s)}</th>)}
              </tr>
            </thead>
            <tbody>
              {results.map(s => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  {subjects.map(sub => {
                    const lv = (cbcData[s.id] || {})[sub] || 'Meeting Expectation';
                    return (
                      <td key={sub}>
                        <Select
                          value={lv}
                          onChange={e => handleCBCChange(s.id, sub, e.target.value)}
                          options={CBC_LEVELS.map(l => ({ id: l, label: l.split(' ')[0] }))}
                          variant="minimal"
                          style={{
                            padding: '2px 4px',
                            fontSize: '0.72rem',
                            border: `2px solid ${cbcColor(lv)}`,
                            borderRadius: 6,
                            background: `${cbcColor(lv)}15`,
                            color: cbcColor(lv),
                            fontWeight: 600,
                            width: '100%',
                            minWidth: 70
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Audit Modal */}
      <AssessmentAuditModal
        isOpen={showAuditModal}
        onClose={() => setShowAuditModal(false)}
        examName={examType}
      />

      {/* Subject Picker Modal */}
      {showSubjectPicker && (
        <SubjectPicker
          student={showSubjectPicker}
          allSubjects={subjects}
          onClose={() => setShowSubjectPicker(null)}
          onSave={handleSubjectSelection}
        />
      )}

      {/* Report Card Modal */}
      {showReport && (
        <ReportCardModal
          student={showReport}
          cbcData={cbcData}
          coreCompData={coreCompData}
          onClose={() => setShowReport(null)}
          getGrade={getGrade}
          cbcLabel={cbcLabel}
          cbcColor={cbcColor}
          classSize={results.length}
          subjects={subjects}
          level={level}
          isEarlyYears={isEarlyYears}
          profile={profile}
          examType={examType}
        />
      )}
    </div>
  );
}

function ReportCardModal({ student, cbcData, coreCompData, onClose, getGrade, cbcLabel, cbcColor, classSize, subjects, level, isEarlyYears, profile, examType }) {
  const { alert } = useDialog();
  const { grade } = getGrade(student.average);
  const studentCBC = cbcData[student.id] || {};
  const studentEnrolled = student.enrolledSubjects || (student.subjects && student.subjects.length > 0 ? student.subjects : subjects);

  const handlePrint = async () => {
    try {
      const headerStr = await getPrintHeader(`Report Card — ${student.name} | ${examType}`);
      const w = window.open('', '_blank');
      w.document.write(`<html><head><title>Report Card - ${student.name}</title>
      <style>
        @page{margin:0}body{font-family:Arial,sans-serif;padding:15mm;color:#1e293b;max-width:700px;margin:0 auto}
        table{width:100%;border-collapse:collapse;margin:16px 0}
        th,td{border:1px solid #cbd5e1;padding:6px 10px;font-size:11px}
        th{background:#1e3a5f;color:#ffffff;text-align:left}
      </style></head><body>
      ${headerStr}
      <div style="margin: 12px 0; border: 1px solid #cbd5e1; padding: 10px; border-radius: 6px;">
        <strong>Student Name:</strong> ${student.name} | <strong>Adm No:</strong> ${student.admNo} | <strong>Class:</strong> ${student.class} | <strong>Rank:</strong> ${student.rank} of ${classSize}
      </div>
      <table><thead><tr><th>Subject</th><th>Score</th><th>Grade</th><th>Remarks</th></tr></thead>
      <tbody>
        ${studentEnrolled.map(sub => {
          const mark = (student.rawMarks || student.marks)?.[sub] || '—';
          const g = getGrade(mark);
          return `<tr><td>${sub}</td><td style="text-align:center">${mark}</td><td style="text-align:center;font-weight:700">${g.grade}</td><td>${g.remarks}</td></tr>`;
        }).join('')}
        <tr style="background:#f8fafc;font-weight:700">
          <td>Total</td>
          <td colspan="3">${student.total} — Average: ${student.average}% — Grade: ${student.grade}</td>
        </tr>
      </tbody></table>
      </body></html>`);
      w.document.close();
      w.print();
    } catch (err) {
      alert({ title: 'Print Error', message: err.message, variant: 'danger' });
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h3><BookIcon size={20} /> Report Card — {student.name}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="report-card">
            <div className="report-card-header">
              <h1><SchoolIcon size={24} /> {profile?.schoolName || 'Termly Academy'}</h1>
              <h2>Official Report Card — {examType}</h2>
            </div>
            <div className="report-card-info" style={{ display: 'flex', gap: '20px', margin: '14px 0', fontSize: '0.85rem' }}>
              <div><strong>Adm No:</strong> {student.admNo}</div>
              <div><strong>Student:</strong> {student.name}</div>
              <div><strong>Class:</strong> {student.class}</div>
              <div><strong>Position:</strong> {student.rank} of {classSize}</div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: '#f1f5f9' }}>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Subject</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Marks</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'center' }}>Grade</th>
                  <th style={{ padding: '8px 10px', border: '1px solid #cbd5e1', textAlign: 'left' }}>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {studentEnrolled.map(sub => {
                  const mark = (student.rawMarks || student.marks)?.[sub] || '—';
                  const g = getGrade(mark);
                  return (
                    <tr key={sub} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{sub}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700 }}>{mark}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700, color: g.color }}>{g.grade}</td>
                      <td style={{ padding: '6px 10px', color: '#475569' }}>{g.remarks}</td>
                    </tr>
                  );
                })}
                <tr style={{ fontWeight: 700, background: '#f8fafc' }}>
                  <td style={{ padding: '8px 10px' }}>Total</td>
                  <td colSpan="3" style={{ padding: '8px 10px' }}>
                    {student.total} — Avg: {student.average}% — Mean Grade: {grade}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={handlePrint}><PrintIcon size={16} /> Print</button>
            <button
              className="btn btn-primary"
              onClick={() => {
                downloadReportCardPDF(
                  student,
                  student.rawMarks || student.marks || {},
                  { teacherComments: '', headComments: '' },
                  { schoolName: profile?.schoolName || 'Termly Academy', term: examType, year: '2026' },
                  { isDraft: false }
                );
              }}
              style={{ background: '#4f46e5', borderColor: '#4f46e5' }}
            >
              <BookIcon size={16} /> Download PDF
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SubjectPicker({ student, allSubjects, onClose, onSave }) {
  const [selected, setSelected] = useState(
    student.enrolledSubjects && student.enrolledSubjects.length > 0
      ? student.enrolledSubjects
      : (student.subjects && student.subjects.length > 0 ? student.subjects : allSubjects)
  );

  const toggle = (sub) => {
    if (selected.includes(sub)) setSelected(selected.filter(s => s !== sub));
    else setSelected([...selected, sub]);
  };

  const allSelected = selected.length === allSubjects.length;
  const toggleAll = () => setSelected(allSelected ? [] : [...allSubjects]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3><SettingsIcon size={20} /> Manage Subjects</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 16, padding: '10px 14px', background: '#f0f9ff',
            borderRadius: 8, border: '1px solid #bae6fd'
          }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{student.name}</div>
              <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                Class {student.class} &middot; {selected.length} of {allSubjects.length} subjects selected
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={toggleAll} style={{ fontSize: '0.78rem' }}>
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {allSubjects.map(sub => {
              const isChecked = selected.includes(sub);
              return (
                <label key={sub} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  background: isChecked ? '#eff6ff' : '#ffffff',
                  borderRadius: 6, cursor: 'pointer',
                  border: isChecked ? '1.5px solid #3b82f6' : '1px solid #cbd5e1'
                }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(sub)}
                    style={{ width: 16, height: 16, accentColor: '#2563eb', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.82rem', fontWeight: isChecked ? 600 : 400 }}>{sub}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave(selected)} disabled={selected.length === 0}>
            <SaveIcon size={15} /> Save ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}