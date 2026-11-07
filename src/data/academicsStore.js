import { supabase } from '../lib/supabase';
import {
  _currentSchoolId,
  _currentAuthUser,
  _currentExamType,
  _currentPeriodId,
  _currentUserId,
  invalidateCache,
  mutationGuard,
  cachedQuery,
  updateSchoolFeature,
  logPlatformActivity,
  logAuditEvent,
  setCurrentPeriodId,
  getSchoolProfile
} from './coreStore';
import { getTeachers } from './staffStore';
import { getStudents } from './studentStore';
import { getFees } from './financeStore';
import { withRetry } from '../utils/resilience';
import { getUserByAuthId } from './authStore';
import { CBC_STRUCTURE, getLevelForGrade, getSubjectsForGrade } from './seedData';
import { calculateStudentSummary, assignCompetitionRanks, parseMarkValue } from '../utils/assessmentCalculations';

export async function getPeriods() {
  if (!_currentSchoolId) return [];
  
  if (!_currentAuthUser && _currentSchoolId) {
    const { data, error } = await supabase.rpc('portal_get_periods', { p_school_id: _currentSchoolId });
    if (error) throw error;
    return data || [];
  }

  const { data, error } = await supabase
    .from('academic_periods')
    .select('id, year, term, is_active, school_id')
    .eq('school_id', _currentSchoolId)
    .order('year', { ascending: false })
    .order('term', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createPeriod(year, term, setAsActive = false) {
  mutationGuard('createPeriod');
  if (!_currentSchoolId) return;
  const { data, error } = await supabase
    .from('academic_periods')
    .insert({ school_id: _currentSchoolId, year, term, is_active: setAsActive })
    .select()
    .single();
  if (error) throw error;
  
  if (setAsActive) {
    // Unset others
    await supabase.from('academic_periods')
      .update({ is_active: false })
      .eq('school_id', _currentSchoolId)
      .neq('id', data.id);
    setCurrentPeriodId(data.id);
  }
  return data;
}

// ==========================================
// GRADING UTILS
// ==========================================

export function getGradeForScore(score, className, profile) {
  if (score === null || score === undefined || score === '') return { grade: '-', remarks: '-', color: 'text-gray-500' };
  
  const numScore = Number(score);
  if (isNaN(numScore)) return { grade: '-', remarks: '-', color: 'text-gray-500' };

  let level = 'default';
  if (className) {
    if (className.toLowerCase().includes('form')) level = 'secondary';
    if (className.toLowerCase().includes('grade') || className.toLowerCase().includes('class')) level = 'primary';
    if (className.toLowerCase().includes('pp') || className.toLowerCase().includes('play')) level = 'preprimary';
  }

  let systems = profile?.grading_systems;
  if (!systems) {
    // Default fallback
    systems = {
      default: [
        { min: 80, max: 100, grade: 'A', remarks: 'Excellent', color: 'text-green-600' },
        { min: 65, max: 79, grade: 'B', remarks: 'Good', color: 'text-blue-600' },
        { min: 50, max: 64, grade: 'C', remarks: 'Average', color: 'text-yellow-600' },
        { min: 0, max: 49, grade: 'D', remarks: 'Needs Effort', color: 'text-red-600' }
      ]
    };
  }

  const activeSystem = systems[level] || systems.default || [];
  for (const g of activeSystem) {
    if (numScore >= g.min && numScore <= g.max) {
      return g;
    }
  }

  return { grade: '?', remarks: 'Unknown', color: 'text-gray-500' };
}

export async function setActivePeriod(periodId) {
  mutationGuard('setActivePeriod');
  if (!_currentSchoolId) return;
  // Update DB
  const { error: deactError } = await supabase.from('academic_periods')
    .update({ is_active: false })
    .eq('school_id', _currentSchoolId);
  if (deactError) throw deactError;
  
  const { error } = await supabase.from('academic_periods')
    .update({ is_active: true })
    .eq('id', periodId).eq('school_id', _currentSchoolId);
  if (error) throw error;
  
  setCurrentPeriodId(periodId);
  window.dispatchEvent(new Event('periodChanged'));
}

export async function initActivePeriod() {
  if (!_currentSchoolId) return null;
  const periods = await getPeriods();
  let active = periods.find(p => p.is_active);
  if (!active && periods.length > 0) {
    active = periods[0];
  } else if (!active) {
    // Create default first term
    active = await createPeriod('2025', 'Term 1', true);
  }
  setCurrentPeriodId(active.id);
  return active;
}

export async function getCurrentPeriodDetails() {
  const periods = await getPeriods();
  return periods.find(p => p.id === _currentPeriodId) || null;
}

export async function getMarks(examType = _currentExamType) {
  if (!_currentSchoolId || !_currentPeriodId) return {};
  const cacheKey = `marks_${_currentSchoolId}_${_currentPeriodId}_${examType}`;
  return cachedQuery(cacheKey, async () => {
    const { data, error } = await supabase
      .from('marks')
      .select('student_id, subject, mark')
      .eq('school_id', _currentSchoolId)
      .eq('period_id', _currentPeriodId)
      .eq('exam_type', examType);
    if (error) throw error;
    const marks = {};
    (data || []).forEach(row => {
      if (!marks[row.student_id]) marks[row.student_id] = {};
      // Map sentinels back to special codes
      if (row.mark === -1) marks[row.student_id][row.subject] = 'ABS';
      else if (row.mark === -2) marks[row.student_id][row.subject] = 'MISSING';
      else if (row.mark === -3) marks[row.student_id][row.subject] = 'EXEMPT';
      else marks[row.student_id][row.subject] = row.mark;
    });
    return marks;
  });
}

export async function setStudentAllMarks(studentId, subjectMarks, examType = _currentExamType, reason = '') {
  mutationGuard('setStudentAllMarks');
  const userRecord = await getUserByAuthId(_currentAuthUser?.id);
  const creatorId = userRecord?.id || _currentUserId;
  
  const rows = Object.entries(subjectMarks).map(([subject, rawMark]) => {
    let dbMark = null;
    if (rawMark === 'ABS') dbMark = -1;
    else if (rawMark === 'MISSING') dbMark = -2;
    else if (rawMark === 'EXEMPT') dbMark = -3;
    else if (rawMark !== null && rawMark !== undefined && rawMark !== '') {
      const num = Number(rawMark);
      dbMark = isNaN(num) ? null : num;
    }

    return {
      school_id: _currentSchoolId,
      student_id: studentId,
      subject,
      mark: dbMark,
      period_id: _currentPeriodId,
      exam_type: examType,
      created_by: creatorId
    };
  });

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('marks')
    .upsert(rows, { onConflict: 'school_id,student_id,subject,period_id,exam_type' });
  
  if (error) {
    console.error('[STORE] Failed to save marks:', error);
    throw error;
  }

  // Audit log for traceability
  logAuditEvent('marks_updated', 'marks', studentId, {
    examType,
    subjectCount: rows.length,
    reason
  });

  invalidateCache(`marks_${_currentSchoolId}_${_currentPeriodId}_${examType}`);
}

export async function batchSaveMarks(marksMap, examType = _currentExamType, reason = '') {
  mutationGuard('batchSaveMarks');
  if (!_currentSchoolId || !_currentPeriodId) return;

  const userRecord = await getUserByAuthId(_currentAuthUser?.id);
  const creatorId = userRecord?.id || _currentUserId;

  const allRows = [];
  for (const [studentId, subjectMarks] of Object.entries(marksMap || {})) {
    for (const [subject, rawMark] of Object.entries(subjectMarks || {})) {
      let dbMark = null;
      if (rawMark === 'ABS') dbMark = -1;
      else if (rawMark === 'MISSING') dbMark = -2;
      else if (rawMark === 'EXEMPT') dbMark = -3;
      else if (rawMark !== null && rawMark !== undefined && rawMark !== '') {
        const num = Number(rawMark);
        dbMark = isNaN(num) ? null : num;
      }

      allRows.push({
        school_id: _currentSchoolId,
        student_id: studentId,
        subject,
        mark: dbMark,
        period_id: _currentPeriodId,
        exam_type: examType,
        created_by: creatorId
      });
    }
  }

  if (allRows.length === 0) return;

  const { error } = await supabase
    .from('marks')
    .upsert(allRows, { onConflict: 'school_id,student_id,subject,period_id,exam_type' });

  if (error) {
    console.error('[STORE] Failed to batch save marks:', error);
    throw error;
  }

  logAuditEvent('batch_marks_updated', 'marks', _currentSchoolId, {
    examType,
    rowCount: allRows.length,
    reason
  });

  invalidateCache(`marks_${_currentSchoolId}_${_currentPeriodId}_${examType}`);
}

export async function getClassResults(className, examType = _currentExamType) {
  const students = (await getStudents()).filter(s => s.class === className);
  const marks = await getMarks(examType);
  const profile = await getSchoolProfile();
  const subjects = getSubjectsForGrade(className, profile);

  const results = students.map(s => {
    const sMarks = marks[s.id] || {};
    return calculateStudentSummary(s, sMarks, subjects, {}, profile);
  });

  // Assign standard competition ranks with ties (1, 2, 2, 4)
  return assignCompetitionRanks(results, 'total', 'average');
}

export async function getSubjectRankings(className, examType = _currentExamType) {
  const students = (await getStudents()).filter(s => s.class === className);
  const marks = await getMarks(examType);
  const profile = await getSchoolProfile();
  const subjects = getSubjectsForGrade(className, profile);
  const rankings = {};

  subjects.forEach(sub => {
    const subResults = students
      .filter(s => !s.subjects || s.subjects.length === 0 || s.subjects.includes(sub))
      .map(s => {
        const raw = (marks[s.id] || {})[sub];
        const num = typeof raw === 'number' ? raw : null;
        return {
          ...s,
          mark: raw !== undefined && raw !== null ? raw : '—',
          score: num !== null ? num : -1
        };
      });

    // Standard competition ranking for subject scores
    rankings[sub] = assignCompetitionRanks(subResults, 'score', 'name');
  });

  return rankings;
}

export async function getClassList(className, classId = null, subjectName = null, streamName = null) {
  let students = [];
  const isPortalMode = !_currentAuthUser && _currentSchoolId;

  if (isPortalMode) {
    // Portal mode: use RPC to bypass RLS
    // We do NOT apply stream/subject filters — teacher already selected a specific paper
    console.log('[PORTAL] getClassList for class:', className, 'classId:', classId);
    
    // Strategy 1: Use simple text-based RPC (most reliable)
    try {
      const { data, error } = await supabase.rpc('portal_get_students_by_class_name', { 
        p_school_id: _currentSchoolId,
        p_class_name: className
      });
      if (!error && data && data.length > 0) {
        console.log('[PORTAL] Text-based RPC returned', data.length, 'students');
        return data.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      }
      if (error) console.warn('[PORTAL] portal_get_students_by_class_name error:', error.message);
    } catch (e) {
      console.warn('[PORTAL] Text RPC failed:', e.message);
    }

    // Strategy 2: Use UUID-based RPC (original)
    if (classId) {
      try {
        const { data, error } = await supabase.rpc('portal_get_class_students', { 
          p_school_id: _currentSchoolId,
          p_class_id: classId
        });
        if (!error && data && data.length > 0) {
          console.log('[PORTAL] UUID-based RPC returned', data.length, 'students');
          return data.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        if (error) console.warn('[PORTAL] portal_get_class_students error:', error.message);
      } catch (e) {
        console.warn('[PORTAL] UUID RPC failed:', e.message);
      }
    }

    // Strategy 3: Direct table query (may be blocked by RLS but worth trying)
    try {
      const { data: fallback, error: fbErr } = await supabase
        .from('students')
        .select('id, name, adm_no, class, stream, subjects')
        .eq('school_id', _currentSchoolId)
        .eq('class', className);
      if (!fbErr && fallback && fallback.length > 0) {
        console.log('[PORTAL] Direct query returned', fallback.length, 'students');
        return fallback.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      }
    } catch (e) {
      console.warn('[PORTAL] Direct query failed:', e.message);
    }

    console.error('[PORTAL] All strategies failed to find students for class:', className);
    return [];
  }

  // Admin mode: use local cache
  students = (await getStudents()).filter(s => s.class === className);

  // 1. Filter by Stream (Strict) — admin mode only
  if (streamName) {
    const sLower = streamName.toLowerCase();
    const isGeneral = sLower === 'general';
    students = students.filter(s => {
      const studentStream = (s.stream || '').toLowerCase();
      if (studentStream === sLower) return true;
      if (isGeneral && (studentStream === '' || studentStream === 'all')) return true;
      if (s.class && s.class.toLowerCase().includes(sLower)) return true;
      return false;
    });
  }

  // 2. Filter by Subject (Strict Enrollment Only) — admin mode only
  if (subjectName) {
    const subLower = subjectName.toLowerCase();
    const hasEnrollmentData = students.some(s => s.subjects && s.subjects.length > 0);
    
    if (hasEnrollmentData) {
      students = students.filter(s => {
        if (!s.subjects || s.subjects.length === 0) return false;
        return s.subjects.some(sub => sub.toLowerCase().includes(subLower) || subLower.includes(sub.toLowerCase()));
      });
    }
  }

  return students.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExamMarksForPaper(paperId) {
  // 1. Get marks from new portal table
  const { data: portalMarks, error: portalErr } = await supabase
    .from('exam_marks')
    .select('student_id, raw_score, is_absent')
    .eq('exam_paper_id', paperId);
  
  // 2. Also get marks from legacy admin table (for two-way sync)
  const { data: paper } = await supabase
    .from('exam_papers')
    .select('subject, exam_id')
    .eq('id', paperId)
    .maybeSingle(); // More resilient than .single()
  
  let legacyMarks = [];
  if (paper) {
    const { data: exam } = await supabase
      .from('exams')
      .select('name')
      .eq('id', paper.exam_id)
      .maybeSingle();
    
    if (exam) {
      const { data } = await supabase
        .from('marks')
        .select('student_id, mark')
        .eq('school_id', _currentSchoolId)
        .eq('exam_type', exam.name)
        .eq('subject', paper.subject);
      legacyMarks = data || [];
    }
  }

  // Merge: Portal marks take priority, but legacy marks fill the gaps
  const merged = {};
  legacyMarks.forEach(m => { merged[m.student_id] = { raw_score: m.mark, is_absent: false }; });
  (portalMarks || []).forEach(m => { merged[m.student_id] = m; });

  return Object.entries(merged).map(([id, m]) => ({ student_id: id, ...m }));
}

export async function getExams() {
  if (!_currentSchoolId) return [];
  
  // Portal mode: strictly identify portal users via sessionStorage
  const isPortalUser = !!sessionStorage.getItem('Termly_portal_user_id');
  if (isPortalUser && _currentSchoolId) {
    const { data, error } = await supabase.rpc('portal_get_open_exams', { p_school_id: _currentSchoolId });
    if (error) throw error;
    return data || [];
  }

  // Admin/Standard mode: use direct table query
  const cacheKey = `exams_${_currentSchoolId}_${_currentPeriodId}`;
  return cachedQuery(cacheKey, async () => {
    let query = supabase
      .from('exams')
      .select('*')
      .eq('school_id', _currentSchoolId);
    
    // If we are in Staff Portal mode (initialized with teacher id but not parent portal session),
    // we might want to filter by status. Let's check if there is a teacher session.
    const isTeacherPortal = !!sessionStorage.getItem('Termly_teacher_id');
    if (isTeacherPortal) {
      query = query.eq('status', 'published'); // Published here means 'Open for Teachers'
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  });
}

/**
 * [UNIFICATION] Auto-migration helper for legacy exams
 */
async function migrateLegacyExams(examsList) {
  if (!examsList || examsList.length === 0 || !_currentSchoolId) return;
  console.log('[UNIFICATION] Migrating legacy exams:', examsList);
  
  const periodId = _currentPeriodId || 'Current';
  
  for (const name of examsList) {
    try {
      // Check if already exists in robust table
      const { data: existing } = await supabase
        .from('exams')
        .select('id')
        .eq('school_id', _currentSchoolId)
        .eq('name', name)
        .maybeSingle();

      if (!existing) {
        console.log(`[UNIFICATION] Creating robust record for: ${name}`);
        await createExam(name, 'endterm', periodId);
      }
    } catch (e) {
      console.error(`[UNIFICATION] Failed to migrate ${name}:`, e.message);
    }
  }

  // Clear legacy field to prevent re-migration
  const { error: profileErr } = await supabase
    .from('school_profiles')
    .upsert({ school_id: _currentSchoolId, custom_exams: [] }, { onConflict: 'school_id' });
  if (profileErr) throw profileErr;
}

/**
 * Creates a new unified exam record
 */
export async function createExam(name, type = 'endterm', term = 'Current', status = 'setup') {
  mutationGuard('createExam');
  const userRecord = await getUserByAuthId(_currentAuthUser?.id);
  const creatorId = userRecord?.id || _currentUserId;
  
  console.log(`[STORE] Creating exam: ${name} (Type: ${type}, CreatedBy: ${creatorId})`);
  
  const { data, error } = await supabase
    .from('exams')
    .insert({
      school_id: _currentSchoolId,
      name,
      exam_type: type,
      term: term,
      academic_year: term,
      status: status, 
      created_by: creatorId
    })
    .select()
    .single();

  if (error) {
    console.error('[STORE] Failed to create exam:', error);
    throw error;
  }
  invalidateCache(`exams_${_currentSchoolId}_${_currentPeriodId}`);
  return data;
}

export async function deleteExam(examId) {
  mutationGuard('deleteExam');
  const { error } = await supabase
    .from('exams')
    .delete()
    .eq('id', examId)
    .eq('school_id', _currentSchoolId);
  
  if (error) throw error;
  invalidateCache(`exams_${_currentSchoolId}_${_currentPeriodId}`);
  return true;
}

export async function updateExam(examId, updates) {
  mutationGuard('updateExam');
  const { error } = await supabase
    .from('exams')
    .update(updates)
    .eq('id', examId)
    .eq('school_id', _currentSchoolId);
  
  if (error) throw error;
  invalidateCache(`exams_${_currentSchoolId}_${_currentPeriodId}`);
}

export async function updateExamStatus(examId, newStatus, reason = '') {
  const { data: current } = await supabase
    .from('exams')
    .select('status, name')
    .eq('id', examId)
    .maybeSingle();

  const { error } = await supabase
    .from('exams')
    .update({ status: newStatus })
    .eq('id', examId)
    .eq('school_id', _currentSchoolId);
  if (error) throw error;

  await logAuditEvent('assessment_status_change', 'exams', examId, {
    examName: current?.name,
    oldStatus: current?.status,
    newStatus,
    reason
  });
  
  invalidateCache(`exams_${_currentSchoolId}_${_currentPeriodId}`);
  return true;
}

export async function finalizeExam(examId) {
  return await updateExamStatus(examId, 'finalized', 'Assessment results finalized and locked.');
}

export async function unlockExam(examId, reason = 'Administrator reopened marks entry') {
  return await updateExamStatus(examId, 'open', reason);
}

export async function releaseExamToParents(examId, isReleased = true) {
  const { error } = await supabase
    .from('exams')
    .update({ released_to_parents: isReleased })
    .eq('id', examId)
    .eq('school_id', _currentSchoolId);
  if (error) throw error;
  
  invalidateCache(`exams_${_currentSchoolId}_${_currentPeriodId}`);
  return true;
}

/**
 * Subscribes to real-time changes for a specific table and school.
 */
export function subscribeToTable(tableName, callback) {
  const channel = supabase
    .channel(`${tableName}_realtime`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: tableName,
        filter: `school_id=eq.${_currentSchoolId}`
      },
      (payload) => {
        // Invalidate cache when changes occur
        invalidateCache(); 
        callback(payload);
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export async function getExamPapers(examId) {
  if (!_currentSchoolId || !examId) return [];
  
  if (!_currentAuthUser && _currentSchoolId) {
    // Portal mode: Fetch papers via RPC (usually for teachers entering marks)
    // Use teacher_record_id if available (from staff login), otherwise fall back to userId
    const teacherId = _currentUserId;
    console.log('[PORTAL] Fetching papers for teacher:', teacherId, 'exam:', examId);
    const { data, error } = await supabase.rpc('portal_get_teacher_papers', { 
      p_teacher_id: teacherId, 
      p_exam_id: examId 
    });
    if (error) {
      console.warn('portal_get_teacher_papers error:', error.message);
      return [];
    }
    return data || [];
  }

  const { data, error } = await supabase
    .from('exam_papers')
    .select('*, tt_subjects(name), classes(name, stream)')
    .eq('exam_id', examId)
    .eq('school_id', _currentSchoolId);
  if (error) throw error;
  return data;
}


export async function saveExamMarks(paperId, marks, virtualPaper = null) {
  mutationGuard('saveExamMarks');
  const token = localStorage.getItem('Termly_Staff_Token') || localStorage.getItem('Termly_Portal_Token');

  if (virtualPaper) {
    const subjectName = virtualPaper.tt_subjects?.name || virtualPaper._subject;
    const className = virtualPaper.classes?.name || virtualPaper._className;
    const examName = virtualPaper._examName || _currentExamType;

    const classMarks = marks.map(m => ({
      school_id: _currentSchoolId,
      student_id: m.student_id,
      subject: subjectName,
      mark: m.is_absent ? -1 : (m.raw_score !== null && m.raw_score !== undefined ? Math.round(Number(m.raw_score)) : null),
      exam_type: examName,
      period_id: _currentPeriodId
    }));

    if (!_currentAuthUser && token) {
      const { data, error } = await supabase.rpc('portal_save_class_marks', { p_marks: classMarks });
      if (error) {
        if (paperId && String(paperId).length === 36) {
          const { data: d2, error: e2 } = await supabase.rpc('portal_save_exam_marks', {
            p_paper_id: paperId,
            p_marks: marks,
            p_token: token
          });
          if (e2) throw e2;
          return d2;
        }
        throw error;
      }
      return data;
    } else {
      const { error } = await supabase.from('marks').upsert(classMarks, {
        onConflict: 'school_id,student_id,subject,period_id,exam_type'
      });
      if (error) throw error;
      return { success: true, count: classMarks.length };
    }
  }

  if (!_currentAuthUser && _currentSchoolId) {
    const { data, error } = await supabase.rpc('portal_save_exam_marks', {
      p_paper_id: paperId,
      p_marks: marks,
      p_token: token
    });
    if (error) {
      const portalMarks = marks.map(m => ({
        ...m,
        exam_paper_id: paperId,
        school_id: _currentSchoolId
      }));
      const { data: legData, error: legErr } = await supabase.rpc('portal_save_exam_marks', { p_marks: portalMarks });
      if (legErr) throw error;
      return legData;
    }
    return data;
  }

  const rows = marks.map(m => ({
    ...m,
    exam_paper_id: paperId,
    school_id: _currentSchoolId,
    entered_by: _currentUserId,
    entered_at: new Date().toISOString()
  }));
  const { error } = await supabase
    .from('exam_marks')
    .upsert(rows, { onConflict: 'exam_paper_id,student_id' });
  if (error) throw error;
  return { success: true, count: rows.length };
}

export async function saveExamPapers(examId, papers) {
  mutationGuard('saveExamPapers');
  const rows = papers.map(p => ({
    ...p,
    exam_id: examId,
    school_id: _currentSchoolId
  }));
  const { error } = await supabase
    .from('exam_papers')
    .upsert(rows, { onConflict: 'exam_id,class_id,subject_id' });
  if (error) throw error;
}

export async function getExamResults(examId) {
  const { data, error } = await supabase
    .from('exam_results')
    .select('*, students(name, adm_no), classes(name, stream)')
    .eq('exam_id', examId)
    .eq('school_id', _currentSchoolId)
    .order('class_position', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Fetch results for a specific student, only from PUBLISHED exams.
 */
export async function getStudentExamResults(studentId) {
  if (!_currentSchoolId || !studentId) return [];

  // Portal mode: portal_get_student_results_v2 already does
  // exam_results-first, marks-table-fallback internally, gated on
  // released_to_parents. Trust it directly — the old layered
  // fallbacks (a direct un-scoped exam_results query, then the
  // long-dead portal_get_student_results v1) were the actual bug:
  // the direct query could "succeed" with one old released exam and
  // return before ever reaching the logic that also checks marks.
  if (!_currentAuthUser && _currentSchoolId) {
    const { data, error } = await supabase.rpc('portal_get_student_results_v2', {
      p_student_id: studentId,
      p_school_id: _currentSchoolId,
    });
    if (error) {
      console.error('[Portal] Student results RPC failed:', error.message);
      throw error;
    }
    return (data || []).map(r => ({
      ...r,
      exams: { name: r.exam_name, term: r.exam_term, exam_type: r.exam_type },
    }));
  }

  // Admin/staff mode: unchanged.
  const { data, error } = await supabase
    .from('exam_results')
    .select('*, exams(name, term, exam_type)')
    .eq('student_id', studentId);

  if (error) throw error;
  return (data || []).filter(r => r.exams);
}

export async function getStudentProfile(studentId) {
  if (!_currentSchoolId || !studentId) return null;

  // Portal mode: try direct query first
  if (!_currentAuthUser && _currentSchoolId) {
    try {
      const { data, error } = await supabase
        .from('students')
        .select('id, name, adm_no, class, stream, gender, parent, parent_phone')
        .eq('id', studentId)
        .single();
      if (!error && data) return { ...data, parent_name: data.parent };
    } catch (e) {
      console.warn('[Portal] Direct student profile query failed:', e.message);
    }
    // Fallback to RPC
    try {
      const { data, error } = await supabase.rpc('portal_get_student_profile', { p_student_id: studentId, p_school_id: _currentSchoolId });
      if (!error) return data || null;
    } catch (e) {
      console.warn('[Portal] RPC student profile also failed:', e.message);
    }
    return null;
  }

  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', studentId)
    .single();
  
  if (error) throw error;
  return data;
}

export async function getSubjectDetails(studentId) {
  if (!_currentSchoolId || !studentId) return [];

  // Strategy 1: Get subjects from student record/marks via RPC
  try {
    const { data, error } = await supabase.rpc('portal_get_student_subjects', { p_student_id: studentId, p_school_id: _currentSchoolId });
    if (!error && data && Array.isArray(data) && data.length > 0) {
      return data.map(s => typeof s === 'string' ? { subject_name: s, name: s } : { ...s, subject_name: s.name || s.subject_name });
    }
  } catch (e) {
    console.warn('[Portal] Subject RPC failed:', e.message);
  }

  // Strategy 2: Try direct tt_subjects query
  try {
    const { data, error } = await supabase
      .from('tt_subjects')
      .select('id, name, short_code')
      .eq('school_id', _currentSchoolId);
    if (!error && data && data.length > 0) return data.map(s => ({ ...s, subject_name: s.name, code: s.short_code }));
  } catch (e) {
    console.warn('[Portal] Direct subjects query failed:', e.message);
  }

  // Strategy 3: Fallback to RPC
  try {
    const { data, error } = await supabase.rpc('portal_get_subject_details', { p_student_id: studentId, p_school_id: _currentSchoolId });
    if (!error) return data || [];
  } catch (e) {
    console.warn('[Portal] RPC subject details also failed:', e.message);
  }
  return [];
}


export async function calculateExamResults(examId) {
  mutationGuard('calculateExamResults');
  
  // 1. Get all marks and papers for this exam
  const { data: marks, error: mErr } = await supabase
    .from('exam_marks')
    .select('student_id, raw_score, is_absent, exam_papers(class_id, subject_id)')
    .eq('exam_papers.exam_id', examId);
  
  if (mErr) throw mErr;

  // 2. Group by student
  const studentTotals = {};
  marks.forEach(m => {
    if (!studentTotals[m.student_id]) {
      studentTotals[m.student_id] = { 
        student_id: m.student_id, 
        total: 0, 
        count: 0, 
        class_id: m.exam_papers?.class_id || null 
      };
    }
    if (!m.is_absent && m.raw_score !== null) {
      studentTotals[m.student_id].total += Number(m.raw_score);
      studentTotals[m.student_id].count += 1;
    }
  });

  // 3. Sort for ranking
  const results = Object.values(studentTotals).map(s => ({
    exam_id: examId,
    school_id: _currentSchoolId,
    student_id: s.student_id,
    class_id: s.class_id,
    total_marks: s.total,
    total_subjects: s.count,
    mean_score: s.count > 0 ? (s.total / s.count) : 0
  })).sort((a, b) => b.total_marks - a.total_marks);

  // 4. Assign class_position
  results.forEach((r, i) => {
    r.class_position = i + 1;
    r.class_size = results.length;
  });

  // 5. Upsert results
  const { error: uErr } = await supabase
    .from('exam_results')
    .upsert(results, { onConflict: 'exam_id,student_id' });
  
  if (uErr) throw uErr;
}

// ============= FEES =============
/**
 * Ensures a student's fee record is in sync with the current profile configuration.
 * Fixes "0" total_fee issues and recalculates balances if configuration has changed.
 */
export async function reconcileStudentFee(studentId, existingRecord = null) {
  mutationGuard('reconcileStudentFee');
  if (!studentId || !_currentSchoolId || !_currentPeriodId) return null;

  const period = await getCurrentPeriodDetails();
  const termName = period?.term || null;
  const students = await getStudents();
  const student = students.find(s => s.id === studentId);
  const profile = await getSchoolProfile();
  const configTotal = getCalculatedTotalFee(student, profile, termName);

  if (configTotal === null) return existingRecord; // No config, can't reconcile

  const record = existingRecord || (await getFees())[studentId];
  
  // If no record exists, we don't create one here (recordPayment handles creation)
  if (!record) return null;

  const currentTotal = Number(record.totalFee);
  
  // Reconcile if total is 0 or different from config
  if (currentTotal === 0 || currentTotal !== configTotal) {
    const newPaid = Number(record.paid) || 0;
    const newBalance = configTotal - newPaid;

    const { error } = await supabase
      .from('fees')
      .update({
        total_fee: configTotal,
        balance: newBalance
      })
      .eq('id', record._feeId);

    if (error) {
      console.error('Fee reconciliation failed:', error);
      return record;
    }

    // Update local record to avoid re-syncing
    record.totalFee = configTotal;
    record.balance = newBalance;
    
    invalidateCache(`fees_${_currentSchoolId}_${_currentPeriodId}`);
  }

  return record;
}


/**
 * Internal helper to calculate a student's total fee based on their class, residence type, and current active term.
 * Returns null if the fee is not configured in the school profile.
 */
export function getCalculatedTotalFee(student, profile, termName = null) {
  if (!student || !profile) return null;
  const grade = student.class;
  const gradeFees = profile.gradeFees || {};
  const customFee = gradeFees[grade];
  
  if (!customFee) return null;

  const resType = (student.residence_type || student.residenceType || 'day').toLowerCase();

  if (typeof customFee === 'object') {
    // 1. Check term-specific fee if configured (e.g. termName = "Term 1")
    if (termName && customFee[termName] && typeof customFee[termName] === 'object') {
      const termFee = Number(customFee[termName][resType]) || Number(customFee[termName].day);
      if (termFee) return termFee;
    }

    // 2. Fallback to general day/boarding rate
    const fee = Number(customFee[resType]) || Number(customFee.day);
    return fee || null;
  }
  
  return Number(customFee) || null;
}



/**
 * Archive a student record (Soft Delete).
 * Transfers the student to a specific inactive category like 'Transferred' or 'Graduated'.
 */


/**
 * Fetch all payments for a specific student in the current period.
 */
export async function getStudentPayments(studentId) {
  if (!_currentSchoolId || !_currentPeriodId) return [];
  const { data, error } = await supabase
    .from('fee_payments')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .eq('student_id', studentId)
    .eq('period_id', _currentPeriodId)
    .order('created_at', { ascending: false });
  
  if (error) throw error;
  return data || [];
}

/**
 * Void a payment record (Soft Delete for finance).
 * Reverses the payment amount from the student's balance.
 */
export async function voidPayment(paymentId, reason) {
  mutationGuard('voidPayment');
  
  // 1. Get the payment to know the amount and student
  const { data: payment, error: pErr } = await supabase
    .from('fee_payments')
    .select('*')
    .eq('id', paymentId)
    .single();
    
  if (pErr) throw pErr;
  if (payment.status === 'Voided') throw new Error('Payment is already voided.');

  // 2. Mark as voided
  const { error: vErr } = await supabase
    .from('fee_payments')
    .update({ 
      status: 'Voided',
      notes: reason ? `VOIDED: ${reason}` : 'Voided by Admin'
    })
    .eq('id', paymentId)
    .eq('school_id', _currentSchoolId);
    
  if (vErr) throw vErr;

  // 3. Trigger reconciliation for this student to fix the running balance
  await reconcileStudentFeesWithPayments(payment.student_id);
  
  await logPlatformActivity('PAYMENT_VOID', `Voided payment of ${payment.amount} for Student ID: ${payment.student_id}. Reason: ${reason}`);
}

/**
 * Restore a voided payment (undo an accidental void).
 * Re-applies the payment amount to the student's balance.
 */
export async function restorePayment(paymentId) {
  mutationGuard('restorePayment');
  
  // 1. Get the payment
  const { data: payment, error: pErr } = await supabase
    .from('fee_payments')
    .select('*')
    .eq('id', paymentId)
    .single();
    
  if (pErr) throw pErr;
  if (payment.status !== 'Voided') throw new Error('Only voided payments can be restored.');

  // 2. Mark as restored (back to Success)
  const previousNotes = payment.notes || '';
  const { error: rErr } = await supabase
    .from('fee_payments')
    .update({ 
      status: 'Success',
      notes: previousNotes ? `${previousNotes} | RESTORED on ${new Date().toISOString().split('T')[0]}` : `RESTORED on ${new Date().toISOString().split('T')[0]}`
    })
    .eq('id', paymentId)
    .eq('school_id', _currentSchoolId);
    
  if (rErr) throw rErr;

  // 3. Re-reconcile the student's balance
  await reconcileStudentFeesWithPayments(payment.student_id);
  
  await logPlatformActivity('PAYMENT_RESTORE', `Restored voided payment of ${payment.amount} for Student ID: ${payment.student_id}`);
}

/**
 * Hard-reconciliation: Recalculates the student's total paid amount
 * based on all non-voided fee_payments records.
 */
export async function reconcileStudentFeesWithPayments(studentId) {
  mutationGuard('reconcileStudentFeesWithPayments');
  
  // 1. Get all valid payments
  const { data: payments, error: pErr } = await supabase
    .from('fee_payments')
    .select('amount')
    .eq('student_id', studentId)
    .eq('period_id', _currentPeriodId)
    .neq('status', 'Voided');
    
  if (pErr) throw pErr;
  
  const totalPaid = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);

  // 2. Get current fee record to find total_fee
  const { data: feeRecord, error: fErr } = await supabase
    .from('fees')
    .select('total_fee')
    .eq('student_id', studentId)
    .eq('period_id', _currentPeriodId)
    .single();
    
  if (fErr) throw fErr;

  // 3. Update the fees table with the verified totals
  const { error: uErr } = await supabase
    .from('fees')
    .update({
      paid: totalPaid,
      balance: Number(feeRecord.total_fee) - totalPaid
    })
    .eq('student_id', studentId)
    .eq('period_id', _currentPeriodId);
    
  if (uErr) throw uErr;
  
  invalidateCache(`fees_${_currentSchoolId}_${_currentPeriodId}`);
}

/**
 * Update all students in the database to match the current grade-based fee structure.
 * This is called when the school admin updates the fee structure in Settings.
 */
export async function applyFeeStructure() {
  if (!_currentSchoolId || !_currentPeriodId) return;
  const profile = await getSchoolProfile();
  const period = await getCurrentPeriodDetails();
  const termName = period?.term || null;
  const gradeFees = profile.gradeFees || {};
  const students = await getStudents();
  
  // FIX: Bulk fetch all fee records to avoid N+1
  const { data: currentFees } = await supabase
    .from('fees')
    .select('student_id, paid')
    .eq('school_id', _currentSchoolId)
    .eq('period_id', _currentPeriodId);
    
  const paidMap = {};
  if (currentFees) {
    currentFees.forEach(f => paidMap[f.student_id] = Number(f.paid));
  }
  
  const upserts = [];
  
  for (const student of students) {
    const finalFee = getCalculatedTotalFee(student, profile, termName);
    if (finalFee === null) continue;

    const paid = paidMap[student.id] || 0;
    const newBalance = finalFee - paid;

    upserts.push({
      school_id: _currentSchoolId,
      student_id: student.id,
      period_id: _currentPeriodId,
      total_fee: finalFee,
      paid: paid,
      balance: newBalance
    });
  }
  
  if (upserts.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const { error } = await supabase.from('fees').upsert(upserts.slice(i, i + CHUNK), { onConflict: 'student_id,period_id' });
      if (error) console.error('applyFeeStructure bulk upsert error:', error);
    }
  }
}



// ============= ATTENDANCE =============
export async function getAttendance() {
  if (!_currentSchoolId || !_currentPeriodId) return {};
  const cacheKey = `att_${_currentSchoolId}_${_currentPeriodId}`;
  return cachedQuery(cacheKey, async () => {
    const { data, error } = await supabase
      .from('attendance')
      .select('id, student_id, date, status, period_id, school_id')
      .eq('school_id', _currentSchoolId)
      .eq('period_id', _currentPeriodId);
    if (error) throw error;
    // Convert to { date: { studentId: status } }
    const att = {};
    (data || []).forEach(row => {
      if (!att[row.date]) att[row.date] = {};
      att[row.date][row.student_id] = row.status;
    });
    return att;
  });
}

export async function markAttendance(date, studentId, status) {
  const { error } = await supabase
    .from('attendance')
    .upsert(
      { school_id: _currentSchoolId, date, student_id: studentId, status, period_id: _currentPeriodId },
      { onConflict: 'school_id,date,student_id,period_id' }
    );
  if (error) throw error;
}

export async function getAttendanceSummary(date, preFetchedAttendance = null) {
  const att = preFetchedAttendance || await getAttendance();
  const entries = Object.values(att[date] || {});
  const present = entries.filter(v => v === 'present').length;
  const late = entries.filter(v => v === 'late').length;
  const absent = entries.filter(v => v === 'absent').length;
  const total = entries.length;
  const percentage = total > 0 ? (((present + late) / total) * 100).toFixed(1) : 0;
  return { present, late, absent, total, percentage: Number(percentage) };
}

export function getTodayStr() { return new Date().toISOString().split('T')[0]; }

// ============= CBC COMPETENCIES =============
export async function getCBC() {
  if (!_currentSchoolId || !_currentPeriodId) return {};
  const { data, error } = await supabase
    .from('cbc_assessments')
    .select('student_id, subject, level')
    .eq('school_id', _currentSchoolId)
    .eq('period_id', _currentPeriodId);
  if (error) throw error;
  const cbc = {};
  (data || []).forEach(row => {
    if (!cbc[row.student_id]) cbc[row.student_id] = {};
    cbc[row.student_id][row.subject] = row.level;
  });
  return cbc;
}

export async function setCBC(studentId, subject, level) {
  const { error } = await supabase
    .from('cbc_assessments')
    .upsert(
      { school_id: _currentSchoolId, student_id: studentId, subject, level, period_id: _currentPeriodId },
      { onConflict: 'school_id,student_id,subject,period_id' }
    );
  if (error) throw error;
}

// ============= CORE COMPETENCIES =============
export async function getCoreCompetencies() {
  if (!_currentSchoolId || !_currentPeriodId) return {};
  const { data, error } = await supabase
    .from('core_competencies')
    .select('id, student_id, competency, level, period_id, school_id')
    .eq('school_id', _currentSchoolId)
    .eq('period_id', _currentPeriodId);
  if (error) throw error;
  const cc = {};
  (data || []).forEach(row => {
    if (!cc[row.student_id]) cc[row.student_id] = {};
    cc[row.student_id][row.competency] = row.level;
  });
  return cc;
}

export async function setCoreCompetency(studentId, competency, level) {
  const { error } = await supabase
    .from('core_competencies')
    .upsert(
      { school_id: _currentSchoolId, student_id: studentId, competency, level, period_id: _currentPeriodId },
      { onConflict: 'school_id,student_id,competency,period_id' }
    );
  if (error) throw error;
}

// ============= SCHOOL STRUCTURE =============
export async function getSchoolStructure(preFetchedStudents = null, preFetchedMarks = null, preFetchedProfile = null) {
  const students = preFetchedStudents || await getStudents();
  const marks = preFetchedMarks || await getMarks();
  const profile = preFetchedProfile || await getSchoolProfile();
  const activeClasses = profile.activeClasses || [];
  const structure = {};

  for (const [levelName, levelData] of Object.entries(CBC_STRUCTURE)) {
    // Filter grades to only those active in this school
    const activeGradesForLevel = levelData.grades.filter(g => activeClasses.includes(g));
    
    // If no grades in this level are active, skip the level
    if (activeGradesForLevel.length === 0) continue;

    const levelStudents = students.filter(s => activeGradesForLevel.includes(s.class));
    const grades = {};
    for (const g of activeGradesForLevel) {
      const gradeStudents = students.filter(s => s.class === g);
      const subjects = getSubjectsForGrade(g, profile);
      const gradeMarks = gradeStudents.map(s => {
        const m = marks[s.id] || {};
        const vals = Array.isArray(subjects) ? subjects.map(sub => m[sub] || 0).filter(v => v > 0) : [];
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      }).filter(a => a > 0);
      const avgPerf = gradeMarks.length > 0 ? (gradeMarks.reduce((a, b) => a + b, 0) / gradeMarks.length).toFixed(1) : 0;
      grades[g] = { count: gradeStudents.length, avgPerformance: Number(avgPerf) };
    }
    structure[levelName] = {
      ...levelData,
      totalStudents: levelStudents.length,
      grades,
    };
  }
  return structure;
}



export async function getSubjectAssignments() {
  if (!_currentSchoolId || !_currentPeriodId) return {};

  // [UNIFICATION] Fetch from the robust teacher_assignments table (Domain 16A)
  // instead of the legacy subject_assignments table.
  const { data, error } = await supabase
    .from('teacher_assignments')
    .select('teacher_id, subject, stream:class_streams(name, level)')
    .eq('school_id', _currentSchoolId)
    .eq('period_id', _currentPeriodId)
    .eq('is_active', true);

  if (error) {
    console.warn('[STORE] getSubjectAssignments fetch error:', error.message);
    return {};
  }

  // Convert to legacy nested structure: { classGrade: { stream: { subject: teacherId } } }
  const assignments = {};
  (data || []).forEach(row => {
    const classGrade = row.stream?.level;
    const streamName = row.stream?.name || 'General';
    if (!classGrade) return;

    if (!assignments[classGrade]) assignments[classGrade] = {};
    if (!assignments[classGrade][streamName]) assignments[classGrade][streamName] = {};
    assignments[classGrade][streamName][row.subject] = row.teacher_id;
  });
  return assignments;
}

export async function getTeacherForSubject(classGrade, stream, subject) {
  const assignments = await getSubjectAssignments();
  let teacherId = null;
  if (assignments[classGrade] && assignments[classGrade][stream]) {
    teacherId = assignments[classGrade][stream][subject];
  }
  if (!teacherId) return null;
  const teachers = await getTeachers();
  return teachers.find(t => t.id === teacherId) || null;
}

export async function getClassSubjectAssignments(schoolId, periodId, classGrade, stream = null) {
  // [UNIFICATION] Query from teacher_assignments (Domain 16A)
  let query = supabase
    .from('teacher_assignments')
    .select('*, stream:class_streams!inner(*)')
    .eq('school_id', schoolId)
    .eq('period_id', periodId)
    .eq('is_active', true)
    .eq('stream.level', classGrade);
  
  if (stream) {
    query = query.eq('stream.name', stream);
  }

  const { data, error } = await query;
  if (error) throw error;
  
  // Format to match the legacy record structure { class_grade, stream, subject, teacher_id }
  return (data || []).map(row => ({
    school_id: row.school_id,
    period_id: row.period_id,
    class_grade: row.stream?.level,
    stream: row.stream?.name,
    subject: row.subject,
    teacher_id: row.teacher_id
  }));
}

export async function saveClassSubjectAssignment(schoolId, periodId, assignment) {
  const { error } = await supabase
    .from('subject_assignments')
    .upsert({
      school_id: schoolId,
      period_id: periodId,
      class_grade: assignment.class_grade,
      stream: assignment.stream || null,
      subject: assignment.subject,
      teacher_id: assignment.teacher_id || null
    }, { onConflict: 'school_id,period_id,class_grade,stream,subject' });
  if (error) throw error;
}

export async function getTTPeriods() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('tt_periods')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .order('order_index');
  if (error) throw error;
  return data || [];
}

export async function saveTTPeriod(period) {
  mutationGuard('saveTTPeriod');
  if (!_currentSchoolId) throw new Error('No school context');
  const payload = { ...period, school_id: _currentSchoolId };
  if (period.id) {
    const { data, error } = await supabase.from('tt_periods').update(payload).eq('id', period.id).eq('school_id', _currentSchoolId).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('tt_periods').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteTTPeriod(id) {
  mutationGuard('deleteTTPeriod');
  const { error } = await supabase.from('tt_periods').delete().eq('id', id).eq('school_id', _currentSchoolId);
  if (error) throw error;
}

export async function getTTSubjects() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('tt_subjects')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function saveTTSubject(subject) {
  mutationGuard('saveTTSubject');
  if (!_currentSchoolId) throw new Error('No school context');
  const payload = { ...subject, school_id: _currentSchoolId };
  if (subject.id) {
    const { data, error } = await supabase.from('tt_subjects').update(payload).eq('id', subject.id).eq('school_id', _currentSchoolId).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('tt_subjects').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function getTTTeacherSubjects(classId = null) {
  if (!_currentSchoolId) return [];
  let q = supabase
    .from('tt_teacher_subjects')
    .select('*, users(name), tt_subjects(name, short_code), classes(name, stream)')
    .eq('school_id', _currentSchoolId);
  if (classId) q = q.eq('class_id', classId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function saveTTTeacherSubject({ teacherId, subjectId, classId }) {
  mutationGuard('saveTTTeacherSubject');
  if (!_currentSchoolId) throw new Error('No school context');
  const { data, error } = await supabase
    .from('tt_teacher_subjects')
    .upsert({ school_id: _currentSchoolId, teacher_id: teacherId, subject_id: subjectId, class_id: classId },
      { onConflict: 'teacher_id,subject_id,class_id' })
    .select()
    .single();
  if (error) throw error;
  
  // UNREACHABLE CODE FIX: We do not return data early, we want to execute the fallback sync below
  const { error: delError } = await supabase
    .from('subject_assignments')
    .delete()
    .eq('school_id', _currentSchoolId)
    .eq('period_id', _currentPeriodId)
    .eq('class_grade', classGrade)
    .eq('stream', stream)
    .eq('subject', subject);
  
  if (delError) throw delError;

  if (teacherId) {
    const { error: insError } = await supabase
      .from('subject_assignments')
      .insert({
        school_id: _currentSchoolId,
        class_grade: classGrade,
        stream,
        subject,
        teacher_id: teacherId,
        period_id: _currentPeriodId
      });
    if (insError) throw insError;
  }
  return data;
}

export async function getTimetableConfig(schoolId, periodId, classLevel = 'Global') {
  if (!_currentAuthUser && _currentSchoolId) {
    const { data, error } = await supabase.rpc('portal_get_timetable_config', { 
      p_school_id: schoolId, 
      p_period_id: periodId,
      p_class_level: classLevel
    });
    if (error) throw error;
    return data || [];
  }

  let query = supabase
    .from('timetable_configs')
    .select('*')
    .eq('school_id', schoolId)
    .eq('period_id', periodId);
    
  if (classLevel && classLevel !== 'Global') {
    query = query.eq('class_level', classLevel);
  } else {
    query = query.is('class_level', null);
  }

  const { data, error } = await query.order('slot_index', { ascending: true });
  if (error) throw error;
  
  // If no level-specific config found, fallback to global (NULL class_level)
  if (data.length === 0 && classLevel && classLevel !== 'Global') {
    const { data: globalData, error: globalError } = await supabase
      .from('timetable_configs')
      .select('*')
      .eq('school_id', schoolId)
      .eq('period_id', periodId)
      .is('class_level', null)
      .order('slot_index', { ascending: true });
    if (globalError) throw globalError;
    return globalData || [];
  }

  return data || [];
}

export async function saveTimetableConfig(schoolId, periodId, slots, classLevel = 'Global') {
  let delQuery = supabase
    .from('timetable_configs')
    .delete()
    .eq('school_id', schoolId)
    .eq('period_id', periodId);
    
  if (classLevel && classLevel !== 'Global') {
    delQuery = delQuery.eq('class_level', classLevel);
  } else {
    delQuery = delQuery.is('class_level', null);
  }

  const { error: delErr } = await delQuery;
  if (delErr) throw delErr;

  if (!slots || slots.length === 0) return;

  const rows = slots.map((s, i) => ({
    school_id: schoolId,
    period_id: periodId,
    slot_index: i,
    label: s.label,
    start_time: s.start_time,
    end_time: s.end_time,
    is_break: s.is_break || false,
    class_level: (classLevel === 'Global') ? null : classLevel
  }));

  const { error } = await supabase.from('timetable_configs').insert(rows);
  if (error) throw error;
}

export async function getTimetableSlots(schoolId, periodId, classGrade, stream = null) {
  let query = supabase
    .from('timetable_slots')
    .select('*, teachers(id, name, staff_code)')
    .eq('school_id', schoolId)
    .eq('period_id', periodId)
    .eq('class_grade', classGrade);
  
  if (stream) query = query.eq('stream', stream);
  else query = query.eq('stream', '');


  const { data, error } = await query.order('slot_index', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getAllTimetableSlots(schoolId, periodId) {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select('*, teachers(id, name, staff_code)')
    .eq('school_id', schoolId)
    .eq('period_id', periodId);
  if (error) throw error;
  return data || [];
}

export async function getTeacherTimetable(schoolId, periodId, teacherId) {
  // Use robust RPC for both Admin and Portal to ensure data sync
  const { data, error } = await supabase.rpc('portal_get_teacher_timetable', { 
    p_school_id: schoolId, 
    p_period_id: periodId,
    p_teacher_id: teacherId
  });
  if (error) throw error;
  return data || [];
}

export async function saveTimetableSlot(schoolId, periodId, slot) {
  const { error } = await supabase
    .from('timetable_slots')
    .upsert({
      school_id: schoolId,
      period_id: periodId,
      class_grade: slot.class_grade,
      stream: slot.stream || '',
      day_of_week: slot.day_of_week,
      slot_index: slot.slot_index,
      subject: slot.subject,
      teacher_id: slot.teacher_id || null,
      room: slot.room || null,
      color: slot.color || null,
      is_double_first: slot.is_double_first || false,
      is_double_second: slot.is_double_second || false,
      start_time: slot.start_time || null,
      end_time: slot.end_time || null
    }, { onConflict: 'school_id,period_id,class_grade,stream,day_of_week,slot_index' });
  if (error) throw error;
  return true;
}

export async function clearTimetableSlot(schoolId, periodId, classGrade, stream, day, slotIndex) {
  let query = supabase
    .from('timetable_slots')
    .delete()
    .eq('school_id', schoolId)
    .eq('period_id', periodId)
    .eq('class_grade', classGrade)
    .eq('day_of_week', day)
    .eq('slot_index', slotIndex);
  
  if (stream) query = query.eq('stream', stream);
  else query = query.eq('stream', '');

  const { error } = await query;
  if (error) throw error;
  return true;
}

export async function getTimetableRooms(schoolId) {
  const { data, error } = await supabase
    .from('timetable_rooms')
    .select('*')
    .eq('school_id', schoolId)
    .order('name', { ascending: true });
  if (error) {
    // Graceful fallback if table doesn't exist yet - some environments might use local storage for rooms
    console.warn("timetable_rooms table fetch error:", error);
    return [];
  }
  return data || [];
}

export async function saveTimetableRoom(schoolId, room) {
  const payload = {
    school_id: schoolId,
    name: room.name,
    building: room.building || null,
    updated_at: new Date().toISOString()
  };

  if (room.id) {
    const { data, error } = await supabase
      .from('timetable_rooms')
      .update(payload)
      .eq('id', room.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await supabase
      .from('timetable_rooms')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

export async function deleteTimetableRoom(id) {
  const { error } = await supabase
    .from('timetable_rooms')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return true;
}

export async function clearAndSaveTimetable(schoolId, periodId, slots, classGrades) {
  const { error: delErr } = await supabase
    .from('timetable_slots')
    .delete()
    .eq('school_id', schoolId)
    .eq('period_id', periodId)
    .in('class_grade', classGrades);
  if (delErr) throw delErr;

  if (!slots || slots.length === 0) return;
  const rows = slots.map(s => ({
    school_id: schoolId,
    period_id: periodId,
    class_grade: s.class_grade,
    stream: s.stream || null,
    day_of_week: s.day_of_week,
    slot_index: s.slot_index,
    subject: s.subject,
    teacher_id: s.teacher_id || null,
    room: s.room || null,
    color: s.color || null,
    is_double_first: s.is_double_first || false,
    is_double_second: s.is_double_second || false,
    date: s.date || null,
    start_time: s.start_time || null,
    end_time: s.end_time || null
  }));

  const CHUNK_SIZE = 100;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from('timetable_slots').insert(chunk);
    if (error) throw error;
  }
}

export async function clearAllTimetableSlots(schoolId, periodId) {
  mutationGuard('clearAllTimetableSlots');
  const { error } = await supabase
    .from('timetable_slots')
    .delete()
    .eq('school_id', schoolId)
    .eq('period_id', periodId);
  if (error) throw error;
  return true;
}

export async function duplicateTimetable(schoolId, fromPeriodId, toPeriodId) {
  mutationGuard('duplicateTimetable');
  if (fromPeriodId === toPeriodId) throw new Error("Source and target periods cannot be the same.");

  const { data: sourceSlots, error: fetchErr } = await supabase
    .from('timetable_slots')
    .select('*')
    .eq('school_id', schoolId)
    .eq('period_id', fromPeriodId);
  
  if (fetchErr) throw fetchErr;
  if (!sourceSlots || sourceSlots.length === 0) throw new Error("No timetable slots found in the source period.");

  // Clear target before duplication to avoid conflicts
  await clearAllTimetableSlots(schoolId, toPeriodId);

  const newSlots = sourceSlots.map(s => {
    const { id, created_at, ...rest } = s; // Strip unique fields
    return { ...rest, period_id: toPeriodId };
  });

  const CHUNK_SIZE = 100;
  for (let i = 0; i < newSlots.length; i += CHUNK_SIZE) {
    const chunk = newSlots.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from('timetable_slots').insert(chunk);
    if (error) throw error;
  }
  return true;
}

export async function getTeacherWorkloadSummary(schoolId, periodId, teacherId) {
  if (!_currentAuthUser && _currentSchoolId) {
    const { data, error } = await supabase.rpc('portal_get_teacher_workload', { 
      p_school_id: schoolId, 
      p_period_id: periodId,
      p_teacher_id: teacherId
    });
    if (error) throw error;
    return data || 0;
  }

  const { data, error, count } = await supabase
    .from('timetable_slots')
    .select('id', { count: 'exact' })
    .eq('school_id', schoolId)
    .eq('period_id', periodId)
    .eq('teacher_id', teacherId);
  
  if (error) throw error;
  return count || 0;
}

export async function checkTimetableConflicts(schoolId, periodId, { day, startTime, endTime, teacherId, classGrade, stream, currentSlotIndex, subject }) {
  if (!schoolId || !periodId || !day || currentSlotIndex === undefined) {
    return null;
  }

  try {
    const targetStream = stream || '';

    // Fetch all timetable slots for this school, period, and day
    const { data: daySlots, error } = await supabase
      .from('timetable_slots')
      .select('*, teachers(id, name)')
      .eq('school_id', schoolId)
      .eq('period_id', periodId)
      .eq('day_of_week', day);

    if (error || !daySlots) return null;

    // Check teacher clashes
    if (teacherId) {
      for (const slot of daySlots) {
        // Skip current slot being edited for the same class and stream
        if (slot.class_grade === classGrade && (slot.stream || '') === targetStream && slot.slot_index === currentSlotIndex) {
          continue;
        }

        // Check direct index match or double-lesson overlap
        const isDirectMatch = slot.slot_index === currentSlotIndex;
        const isDoubleOverlap = (slot.is_double_first && slot.slot_index + 1 === currentSlotIndex) ||
                                (slot.is_double_second && slot.slot_index - 1 === currentSlotIndex);

        if (slot.teacher_id === teacherId && (isDirectMatch || isDoubleOverlap)) {
          const teacherName = slot.teachers?.name || 'Teacher';
          const otherClass = `${slot.class_grade}${slot.stream ? ' (' + slot.stream + ')' : ''}`;
          return {
            hasConflict: true,
            msg: `Conflict: ${teacherName} is already teaching ${slot.subject || 'a lesson'} in ${otherClass} at this time.`
          };
        }
      }
    }
  } catch (err) {
    console.warn('Timetable conflict check failed:', err);
  }

  return null;
}

export async function fetchLmsContent(url) {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

export async function getAssignmentStats(assignmentId, className, stream) {
  const { count: submitted } = await supabase.from('lms_submissions')
    .select('*', { count: 'exact', head: true })
    .eq('assignment_id', assignmentId);
    
  let query = supabase.from('students').select('*', { count: 'exact', head: true }).eq('class', className);
  if (stream && stream !== 'General' && stream !== '') query = query.eq('stream', stream);
  
  const { count: total } = await query;
  return { submitted: submitted || 0, total: total || Math.max(submitted || 0, 1) };
}

export async function getQuizAnalytics(assignmentId) {
  const { data: ast, error: e1 } = await supabase.from('lms_assignments').select('quiz_config, max_score, title').eq('id', assignmentId).eq('school_id', _currentSchoolId).single();
  if (e1) throw e1;
  const { data: subs, error: e2 } = await supabase.from('lms_submissions').select('quiz_results, grade_numeric').eq('assignment_id', assignmentId);
  if (e2) throw e2;

  const totalSubmissions = subs.length;
  if (totalSubmissions === 0) return { totalSubmissions: 0, questionStats: [] };

  const questions = ast.quiz_config || [];
  const questionStats = questions.map((q, idx) => {
    let correctCount = 0;
    subs.forEach(s => { if (s.quiz_results?.answers?.[idx]?.correct) correctCount++; });
    return { id: q.id, text: q.text, successRate: (correctCount / totalSubmissions) * 100 };
  });

  const scores = subs.map(s => s.grade_numeric || 0);
  return {
    title: ast.title,
    maxScore: ast.max_score,
    totalSubmissions,
    avgScore: (scores.reduce((a, b) => a + b, 0) / totalSubmissions).toFixed(1),
    highestScore: Math.max(...scores),
    lowestScore: Math.min(...scores),
    questionStats
  };
}

export async function updateSubmission(submissionId, updates) {
  const { data, error } = await supabase.from('lms_submissions').update(updates).eq('id', submissionId).eq('school_id', _currentSchoolId).select().single();
  if (error) throw error;
  return data;
}

export async function getClasses() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('classes')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function addClass({ name, level, stream = 'General', curriculum_type = 'both' }) {
  mutationGuard('addClass');
  const { data, error } = await supabase
    .from('classes')
    .insert({ school_id: _currentSchoolId, name, level, stream, curriculum_type })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateClass(id, updates) {
  mutationGuard('updateClass');
  const { data, error } = await supabase
    .from('classes')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClass(id) {
  mutationGuard('deleteClass');
  const { error } = await supabase.from('classes').delete().eq('id', id).eq('school_id', _currentSchoolId);
  if (error) throw error;
}

export async function getTTAvailability(teacherId) {
  const { data, error } = await supabase
    .from('tt_teacher_availability')
    .select('*')
    .eq('teacher_id', teacherId);
  if (error) throw error;
  return data || [];
}

export async function saveTTAvailability(entries) {
  mutationGuard('saveTTAvailability');
  if (!_currentSchoolId) throw new Error('No school context');
  const payload = entries.map(e => ({ ...e, school_id: _currentSchoolId }));
  const { error } = await supabase.from('tt_teacher_availability').upsert(payload, { onConflict: 'teacher_id,day_of_week,period_id' });
  if (error) throw error;
}

export async function getTTSlots(classId = null, dayOfWeek = null) {
  if (!_currentSchoolId) return [];
  let q = supabase
    .from('tt_slots')
    .select('*, tt_subjects(name, short_code, color_hex), users!tt_slots_teacher_id_fkey(name), classes(name, stream), tt_periods(name, start_time, end_time, order_index)')
    .eq('school_id', _currentSchoolId);
  if (classId) q = q.eq('class_id', classId);
  if (dayOfWeek) q = q.eq('day_of_week', dayOfWeek);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function saveTTSlot(slot) {
  mutationGuard('saveTTSlot');
  if (!_currentSchoolId) throw new Error('No school context');
  const creatorId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  const payload = { ...slot, school_id: _currentSchoolId, created_by: creatorId, updated_at: new Date().toISOString() };
  if (slot.id) {
    const { data, error } = await supabase.from('tt_slots').update(payload).eq('id', slot.id).eq('school_id', _currentSchoolId).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('tt_slots').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteTTSlot(id) {
  mutationGuard('deleteTTSlot');
  const { error } = await supabase.from('tt_slots').delete().eq('id', id).eq('school_id', _currentSchoolId);
  if (error) throw error;
}

export async function getTTWeeklyTargets(classId) {
  const { data, error } = await supabase
    .from('tt_weekly_targets')
    .select('*, tt_subjects(name)')
    .eq('class_id', classId);
  if (error) throw error;
  return data || [];
}

export async function saveTTWeeklyTarget({ classId, subjectId, minLessons, maxLessons }) {
  mutationGuard('saveTTWeeklyTarget');
  const { data, error } = await supabase
    .from('tt_weekly_targets')
    .upsert({ school_id: _currentSchoolId, class_id: classId, subject_id: subjectId, min_lessons: minLessons, max_lessons: maxLessons });
  if (error) throw error;
  return data;
}

export async function createAssignment(assignment) {
  mutationGuard('createAssignment');
  if (!_currentSchoolId) throw new Error('No school context');
  
  const payload = {
    school_id: _currentSchoolId,
    title: assignment.title,
    class: assignment.class,
    stream: assignment.stream,
    subject: assignment.subject,
    description: assignment.description,
    links: assignment.links,
    allow_from: assignment.allowFrom,
    due_date: assignment.dueDate,
    cutoff_date: assignment.cutoffDate,
    max_score: assignment.maxScore,
    submission_type: assignment.submissionType,
    questions: assignment.questions,
    teacher: assignment.teacher
  };

  const { data, error } = await supabase
    .from('el_assignments')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateAssignment(id, updates) {
  mutationGuard('updateAssignment');
  const { data, error } = await supabase
    .from('el_assignments')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function publishAssignment(id) {
  return updateAssignment(id, { status: 'published', published_at: new Date().toISOString() });
}

export async function closeAssignment(id) {
  return updateAssignment(id, { status: 'closed', closed_at: new Date().toISOString() });
}

export async function deleteAssignment(id) {
  mutationGuard('deleteAssignment');
  const { error } = await supabase.from('el_assignments').delete().eq('id', id).eq('school_id', _currentSchoolId);
  if (error) throw error;
}

export async function getAnnouncements(filters = {}) {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createAnnouncement(ann) {
  mutationGuard('createAnnouncement');
  if (!_currentSchoolId) throw new Error('No school context');
  const creatorId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  const { data, error } = await supabase
    .from('announcements')
    .insert({ ...ann, school_id: _currentSchoolId, created_by: creatorId })
    .select()
    .single();
  if (error) throw error;

  try {
    if (ann.target_role === 'teachers' || ann.target_role === 'all') {
      const { data: staff } = await supabase
        .from('users')
        .select('id')
        .eq('school_id', _currentSchoolId)
        .in('role', ['teacher', 'admin', 'finance', 'librarian']);
        
      if (staff && staff.length > 0) {
        const notifs = staff.map(s => ({
          school_id: _currentSchoolId,
          user_id: s.id,
          type: 'info',
          title: 'New Announcement',
          body: ann.title || 'A new announcement has been posted.',
          reference_type: 'announcement',
          reference_id: data.id,
        }));
        await supabase.from('notifications').insert(notifs);
      }
    }
  } catch (e) {
    console.error('Failed to dispatch notifications for announcement:', e);
  }

  return data;
}

export async function markAnnouncementRead(announcementId) {
  const userId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  if (!userId) return;
  await supabase
    .from('announcement_reads')
    .upsert({ announcement_id: announcementId, user_id: userId },
      { onConflict: 'announcement_id,user_id' });
}

export async function getMessages(otherUserId = null) {
  const userId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  if (!userId) return [];
  let q = supabase
    .from('messages')
    .select('*, sender:users!messages_sender_id_fkey(name, role), recipient:users!messages_recipient_id_fkey(name, role)')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order('created_at', { ascending: false });
  if (otherUserId) {
    q = supabase
      .from('messages')
      .select('*, sender:users!messages_sender_id_fkey(name, role), recipient:users!messages_recipient_id_fkey(name, role)')
      .or(`and(sender_id.eq.${userId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${userId})`)
      .order('created_at', { ascending: true });
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function sendMessage({ recipientId, body }) {
  const senderId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  const { data, error } = await supabase
    .from('messages')
    .insert({ school_id: _currentSchoolId, sender_id: senderId, recipient_id: recipientId, body })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markMessageRead(messageId) {
  const { error } = await supabase
    .from('messages')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', messageId);
  if (error) throw error;
}

export async function getNotifications(unreadOnly = false) {
  const userId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  if (!userId) return [];
  let q = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (unreadOnly) q = q.eq('is_read', false);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getUnreadNotificationCount() {
  const userId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  if (!userId) return 0;
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) return 0;
  return count || 0;
}

export async function markNotificationRead(notifId) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notifId);
  if (error) throw error;
}

export async function markAllNotificationsRead() {
  const userId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  if (!userId) return;
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) throw error;
}

export async function createNotification({ userId, type, title, body, referenceType, referenceId }) {
  const { data, error } = await supabase
    .from('notifications')
    .insert({ user_id: userId, type, title, body, reference_type: referenceType, reference_id: referenceId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getNotificationPreferences() {
  const userId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  if (!userId) return [];
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  return data || [];
}


export async function updateNotificationPreference(prefId, updates) {
  const { error } = await supabase
    .from('notification_preferences')
    .update(updates)
    .eq('id', prefId);
  if (error) throw error;
}

export function subscribeToNotifications(userId, callback) {
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload) => callback(payload.new)
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

export function subscribeToMessages(userId, callback) {
  const channel = supabase
    .channel(`messages:${userId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${userId}` },
      (payload) => callback(payload.new)
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// ==========================================
// TEACHER ASSIGNMENTS & STREAMS
// ==========================================

export async function initializeStreams() {
  if (!_currentSchoolId) return [];
  const year = new Date().getFullYear();
  const { data: existing } = await supabase.from('class_streams').select('id').eq('school_id', _currentSchoolId).eq('academic_year', year);
  if (existing && existing.length > 0) return existing;

  const toInsert = [];
  Object.keys(CBC_STRUCTURE || {}).forEach(level => {
    toInsert.push({ school_id: _currentSchoolId, name: 'North', level, academic_year: year });
    toInsert.push({ school_id: _currentSchoolId, name: 'South', level, academic_year: year });
  });

  if (toInsert.length > 0) {
    const { data, error } = await supabase.from('class_streams').insert(toInsert).select();
    if (error) { console.error("initializeStreams error:", error); return []; }
    return data || [];
  }
  return [];
}

export async function deleteAllExams() {
  console.warn('[academicsStore] deleteAllExams is not yet implemented');
  return [];
}

export async function previewClassPromotion() {
  console.warn('[academicsStore] previewClassPromotion is not yet implemented');
  return { promoted: [], retained: [] };
}

export async function promoteClasses() {
  console.warn('[academicsStore] promoteClasses is not yet implemented');
  return { promoted: 0, retained: 0 };
}

export async function getOpenExamsForTeacher() {
  const token = typeof localStorage !== 'undefined' ? (localStorage.getItem('Termly_Staff_Token') || localStorage.getItem('Termly_Portal_Token')) : null;
  if (token) {
    try {
      const { data, error } = await supabase.rpc('portal_get_open_exams_for_teacher', { p_token: token });
      if (!error && Array.isArray(data)) {
        return data;
      }
    } catch (e) {
      console.warn('[academicsStore] RPC portal_get_open_exams_for_teacher error, falling back:', e);
    }
  }

  // Fallback for admin or direct authenticated mode
  if (!_currentSchoolId) return [];
  try {
    const { data, error } = await supabase
      .from('exams')
      .select('*')
      .eq('school_id', _currentSchoolId)
      .in('status', ['open', 'active', 'in_progress'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[academicsStore] Failed to get open exams for teacher:', err);
    return [];
  }
}

export async function getVirtualPaperMarks(schoolId, className, subjectName, examName) {
  const targetSchoolId = schoolId || _currentSchoolId;
  if (!targetSchoolId) return [];
  try {
    let query = supabase
      .from('marks')
      .select('student_id, mark, is_absent')
      .eq('school_id', targetSchoolId);

    if (subjectName) query = query.eq('subject', subjectName);
    if (examName) query = query.eq('exam_type', examName);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(m => ({
      student_id: m.student_id,
      raw_score: m.mark === -1 ? null : m.mark,
      is_absent: m.mark === -1 || !!m.is_absent
    }));
  } catch (err) {
    console.error('[academicsStore] Failed to get virtual paper marks:', err);
    return [];
  }
}

export async function getTeacherAssignments() {
  if (!_currentSchoolId) return [];
  try {
    const { data, error } = await supabase
      .from('teacher_assignments')
      .select('*, teacher:teachers(id, name), stream:class_streams(id, name, level)')
      .eq('school_id', _currentSchoolId);
    if (error) {
      console.warn("getTeacherAssignments error:", error);
      return [];
    }
    return data || [];
  } catch (e) {
    return [];
  }
}

export async function assignTeacher(payload) {
  if (!_currentSchoolId) return null;
  const { data, error } = await supabase
    .from('teacher_assignments')
    .insert([{ ...payload, school_id: _currentSchoolId }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeTeacherAssignment(id) {
  if (!_currentSchoolId) return null;
  const { error } = await supabase
    .from('teacher_assignments')
    .delete()
    .eq('id', id)
    .eq('school_id', _currentSchoolId);
  if (error) throw error;
  return true;
}

export async function getClassStreams(level = null, year = new Date().getFullYear()) {
  if (!_currentSchoolId) return [];
  try {
    let query = supabase.from('class_streams').select('*').eq('school_id', _currentSchoolId).eq('academic_year', Number(year) || new Date().getFullYear());
    if (level) query = query.eq('level', level);
    const { data, error } = await query.order('level');
    if (error) {
      console.warn("getClassStreams error:", error);
      return [];
    }
    return data || [];
  } catch (e) {
    return [];
  }
}
export async function getStudentCBCProgress(studentId) {
  if (!studentId) return [];
  try {
    const { data, error } = await supabase
      .from('cbc_assessments')
      .select('*')
      .eq('student_id', studentId)
      .eq('period_id', _currentPeriodId)
      .order('subject');

    if (error) {
      console.warn('getStudentCBCProgress error:', error);
      return [];
    }
    return data || [];
  } catch (e) {
    return [];
  }
}



export async function getStudentAssignments(studentId) {
  if (!studentId) return [];
  const token = localStorage.getItem('Termly_Portal_Token');
  try {
    const { data, error } = await supabase.rpc('portal_get_student_assignments', {
      p_student_id: studentId,
      p_token: token
    });
    if (!error && Array.isArray(data)) return data;
    return [];
  } catch (e) {
    return [];
  }
}