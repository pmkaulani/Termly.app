import { supabase } from '../lib/supabase';
import { db, queueChange } from './offlineStore';
import { 
  _currentSchoolId, _currentPeriodId, mutationGuard, cachedQuery, invalidateCache, getCurrentSchoolId,
  logAuditEvent, logPlatformActivity, getPrintHeader, checkIsPlatformAdmin, shouldFetchCloud, getSchoolProfile
} from './coreStore';
import { withRetry } from '../utils/resilience';
import { getFeeSummary, getPayments } from './financeStore';
import { getCurrentPeriodDetails } from './academicsStore';
import { TERM_FEE, CBC_STRUCTURE, getSubjectsForGrade } from './seedData';
import { jsPDF } from 'jspdf'; 

// ==========================================
// STUDENTS (Extracted from store.js)
// ==========================================

export async function getStudents() {
  if (!_currentSchoolId) return [];
  
  // Try to load from offline cache first (SWR)
  const cached = await db.students.where('school_id').equals(_currentSchoolId).toArray();
  
  // Background fetch from cloud
  const fetchCloud = async () => {
    if (!shouldFetchCloud(`students_${_currentSchoolId}`)) return;
    try {
      const { data, error } = await withRetry(() => supabase
        .from('students')
        .select('*')
        .eq('school_id', _currentSchoolId)
        .order('name'));
      if (error) throw error;
      if (data) {
        // Update offline cache
        await db.students.bulkPut(data.map(s => ({ ...s, school_id: _currentSchoolId })));
        window.dispatchEvent(new Event('studentsSynced'));
      }
    } catch (e) {
      console.warn("Offline fetch: showing cached students.", e.message);
    }
  };
  
  fetchCloud(); // Fire and forget for internal sync
  
  if (cached.length > 0) {
    return cached.map(s => ({
      ...s,
      admNo: s.adm_no,
      residenceType: s.residence_type || 'day',
      house: s.house || null,
      parentPhone: s.parent_phone,
      joinDate: s.join_date,
      birthCertNo: s.birth_cert_no,
      fatherName: s.father_name,
      fatherPhone: s.father_phone,
      motherName: s.mother_name,
      motherPhone: s.mother_phone,
      nemisVerified: s.nemis_verified,
      status: s.status || 'Active'
    }));
  }
  
  // If no cache, wait for cloud
  const { data, error } = await supabase.from('students').select('*').eq('school_id', _currentSchoolId).order('name');
  if (error) throw error;
  if (data) await db.students.bulkPut(data.map(s => ({ ...s, school_id: _currentSchoolId })));
  return (data || []).map(s => ({
    ...s,
    admNo: s.adm_no,
    residenceType: s.residence_type || 'day',
    house: s.house || null,
    parentPhone: s.parent_phone,
    joinDate: s.join_date,
    birthCertNo: s.birth_cert_no,
    fatherName: s.father_name,
    fatherPhone: s.father_phone,
    motherName: s.mother_name,
    motherPhone: s.mother_phone,
    nemisVerified: s.nemis_verified,
    status: s.status || 'Active'
  }));
}

export async function getNEMISComplianceReport() {
  const students = await getStudents();
  const report = {
    total: students.length,
    ready: 0,
    nonReady: 0,
    readinessRate: 0,
    missingStats: {
      upi: 0,
      dob: 0,
      gender: 0,
      birth_cert: 0,
      parent_contact: 0,
      class_stream: 0
    },
    studentsWithIssues: []
  };

  students.forEach(s => {
    const issues = [];
    if (!s.nemis_number && !s.upi) {
      issues.push('Missing UPI/NEMIS Number');
      report.missingStats.upi++;
    }
    if (!s.date_of_birth && !s.dob) {
      issues.push('Missing Date of Birth');
      report.missingStats.dob++;
    }
    if (!s.gender) {
      issues.push('Missing Gender');
      report.missingStats.gender++;
    }
    if (!s.parent_phone && !s.parentPhone) {
      issues.push('Missing Parent Contact');
      report.missingStats.parent_contact++;
    }
    if (!s.birth_cert_no && !s.birthCertNo) {
      issues.push('Missing Birth Certificate No');
      report.missingStats.birth_cert++;
    }
    if (!s.class) {
      issues.push('Missing Class Assignment');
      report.missingStats.class_stream++;
    }

    if (issues.length === 0) {
      report.ready++;
    } else {
      report.nonReady++;
      report.studentsWithIssues.push({
        id: s.id,
        name: s.name,
        admNo: s.admNo,
        class: s.class,
        issues
      });
    }
  });

  report.readinessRate = ((report.ready / (report.total || 1)) * 100).toFixed(1);
  return report;
}

export async function getStudent(id) {
  const { data, error } = await supabase
    .from('students')
    .select('id, name, adm_no, class, stream, parent, parent_phone, gender, dob, join_date, notes, school_id, birth_cert_no, county, father_name, father_phone, mother_name, mother_phone, residence_type, house, subjects')
    .eq('id', id)
    .eq('school_id', _currentSchoolId)
    .single();
  if (error) throw error;
  return data ? { ...data, admNo: data.adm_no, parentPhone: data.parent_phone, joinDate: data.join_date, residenceType: data.residence_type || 'day', house: data.house || null } : null;
}

export async function addStudent(student) {
  mutationGuard('addStudent');
  const all = await getStudents();
  const activeStudents = all.filter(s => (s.status || 'Active') === 'Active');
  const p = await getSchoolProfile();
  
  // Enforce student limit set by Super Admin (Active seats only)
  const currentCount = activeStudents.length;
  if (currentCount >= p.studentLimit) {
    throw new Error(`Active student limit reached (${p.studentLimit}). Please contact Super Admin to increase your school's capacity.`);
  }
  const count = all.length + 1;
  const admNo = student.admNo || String(count).padStart(3, '0');

  const { data, error } = await supabase
    .from('students')
    .insert({
      school_id: _currentSchoolId,
      adm_no: admNo,
      name: student.name,
      class: student.class,
      stream: student.stream || 'General',
      parent: student.parent || '',
      residence_type: student.residenceType || 'day',
      house: student.house || null,
      parent_phone: student.parentPhone || '',
      gender: student.gender || '',
      dob: student.dob || '',
      join_date: student.joinDate || new Date().toISOString().split('T')[0],
      notes: sanitizeString(student.notes || ''),
      birth_cert_no: student.birthCertNo || null,
      county: student.county || null,
      father_name: sanitizeName(student.fatherName || null),
      father_phone: student.fatherPhone || null,
      mother_name: sanitizeName(student.motherName || null),
      mother_phone: student.motherPhone || null,
      status: student.status || 'Active',
      subjects: getSubjectsForGrade(student.class, p)
    })
    .select()
    .single();
  if (error) throw error;

  // Create fee record for new student (term-aware)
  const feeConfig = p.gradeFees?.[student.class];
  let baseFee = TERM_FEE;
  if (feeConfig) {
    if (typeof feeConfig === 'object') {
      const type = (student.residenceType || 'day').toLowerCase();
      // Check per-term rates first
      let termName = null;
      try { const period = await getCurrentPeriodDetails(); termName = period?.term || null; } catch(e) { /* ignore */ }
      if (termName && feeConfig[termName] && typeof feeConfig[termName] === 'object') {
        baseFee = Number(feeConfig[termName][type]) || Number(feeConfig[termName].day) || TERM_FEE;
      } else {
        baseFee = Number(feeConfig[type]) || Number(feeConfig.day) || TERM_FEE;
      }
    } else {
      baseFee = Number(feeConfig) || TERM_FEE;
    }
  }
  const { error: feeError } = await supabase.from('fees').insert({
    school_id: _currentSchoolId,
    student_id: data.id,
    period_id: _currentPeriodId,
    total_fee: baseFee,
    paid: 0,
    balance: baseFee,
  });
  if (feeError) {
    console.error('Failed to create fee record for new student:', feeError);
    // Continue anyway so student creation doesn't completely fail
  }

  await logPlatformActivity('STUDENT_ADD', `Added new student: ${student.name}`);
  const newStudent = { 
    ...data, 
    admNo: data.adm_no, 
    residenceType: data.residence_type || 'day',
    house: data.house || null,
    parentPhone: data.parent_phone, 
    joinDate: data.join_date,
    birthCertNo: data.birth_cert_no,
    fatherName: data.father_name,
    fatherPhone: data.father_phone,
    motherName: data.mother_name,
    motherPhone: data.mother_phone,
    subjects: data.subjects || [],
    status: data.status || 'Active',
    nemisVerified: false
  };

  // Sync to local DB immediately for UI responsiveness
  try { await db.students.put(data); } catch(e) {}

  await logAuditEvent('student_created', 'students', data.id, { name: student.name, class: student.class });
  return newStudent;
}

export async function updateStudent(id, updates) {
  mutationGuard('updateStudent');
  const row = {};
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.class !== undefined) row.class = updates.class;
  if (updates.stream !== undefined) row.stream = updates.stream;
  if (updates.parent !== undefined) row.parent = updates.parent;
  if (updates.residenceType !== undefined) row.residence_type = updates.residenceType;
  if (updates.house !== undefined) row.house = updates.house;
  if (updates.parentPhone !== undefined) row.parent_phone = updates.parentPhone;
  if (updates.gender !== undefined) row.gender = updates.gender;
  if (updates.dob !== undefined) row.dob = updates.dob;
  if (updates.joinDate !== undefined) row.join_date = updates.joinDate;
  if (updates.notes !== undefined) row.notes = updates.notes;
  if (updates.admNo !== undefined) row.adm_no = updates.admNo;
  if (updates.birthCertNo !== undefined) row.birth_cert_no = updates.birthCertNo;
  if (updates.county !== undefined) row.county = updates.county;
  if (updates.fatherName !== undefined) row.father_name = updates.fatherName;
  if (updates.fatherPhone !== undefined) row.father_phone = updates.fatherPhone;
  if (updates.motherName !== undefined) row.mother_name = updates.motherName;
  if (updates.motherPhone !== undefined) row.mother_phone = updates.motherPhone;
  if (updates.subjects !== undefined) row.subjects = updates.subjects;
  if (updates.status !== undefined) row.status = updates.status;

  const { data, error } = await supabase
    .from('students')
    .update(row)
    .eq('id', id)
    .eq('school_id', _currentSchoolId)
    .select()
    .single();
  if (error) throw error;
  
  // Sync to local DB immediately
  try { await db.students.put(data); } catch(e) {}
  
  await logAuditEvent('student_updated', 'students', id, { updates: row });
  return data ? { ...data, admNo: data.adm_no, parentPhone: data.parent_phone, joinDate: data.join_date, residenceType: data.residence_type || 'day', house: data.house || null, subjects: data.subjects || [], status: data.status || 'Active' } : null;
}

export async function migrateExistingStudentsSubjects() {
  const students = await getStudents();
  const profile = await getSchoolProfile();
  
  const updates = [];
  for (const s of students) {
    if (!s.subjects || s.subjects.length === 0) {
      const defaultSubs = getSubjectsForGrade(s.class, profile);
      updates.push({ id: s.id, subjects: defaultSubs });
    }
  }

  if (updates.length > 0) {
    // Supabase JS doesn't have a bulk update by ID easily without upserting full rows.
    // To do it efficiently, we can use an RPC or do a map. We'll map and await Promise.all
    // which is better than sequential awaiting in a loop.
    await Promise.all(updates.map(u => 
      supabase.from('students').update({ subjects: u.subjects }).eq('id', u.id).eq('school_id', _currentSchoolId)
    ));
  }
  
  return updates.length;
}

export async function deleteStudent(id) {
  mutationGuard('deleteStudent');
  const { error } = await supabase.from('students').delete().eq('id', id).eq('school_id', _currentSchoolId);
  if (error) throw error;
  // Sync to local DB immediately
  try { await db.students.delete(id); } catch(e) {}
}

export async function archiveStudent(id, targetStatus = 'Transferred', reason = '') {
  mutationGuard('archiveStudent');
  const { data, error } = await supabase
    .from('students')
    .update({ 
      status: targetStatus,
      notes: reason ? `[ARCHIVED: ${new Date().toLocaleDateString()}] ${reason}` : undefined
    })
    .eq('id', id)
    .eq('school_id', _currentSchoolId)
    .select()
    .single();
    
  if (error) throw error;
  
  // Update local cache
  try { await db.students.update(id, { status: targetStatus }); } catch(e) {}
  
  await logAuditEvent('student_archived', 'students', id, { targetStatus, reason });
  await logPlatformActivity('STUDENT_ARCHIVE', `Archived student (Status: ${targetStatus}): ${data.name}`);
  return data;
}

export async function transferStudents(selectedIds, direction = 'promote') {
  mutationGuard('transferStudents');
  const allGrades = Object.values(CBC_STRUCTURE).flatMap(l => l.grades);
  const students = (await getStudents()).filter(s => s.status === 'Active');
  const targetStudents = students.filter(s => selectedIds.includes(s.id));
  const updates = [];

  targetStudents.forEach(s => {
    const idx = allGrades.indexOf(s.class);
    if (direction === 'promote') {
      if (idx >= 0 && idx < allGrades.length - 1) {
        updates.push({ id: s.id, newClass: allGrades[idx + 1] });
      }
    } else if (direction === 'demote') {
      if (idx > 0) {
        updates.push({ id: s.id, newClass: allGrades[idx - 1] });
      }
    }
  });

  for (const u of updates) {
    const { error } = await supabase.from('students').update({ class: u.newClass }).eq('id', u.id).eq('school_id', _currentSchoolId);
    if (error) throw error;
  }
  return await getStudents();
}

export async function bulkImportStudents(studentsData, onProgress, options = {}) {
  mutationGuard('bulkImportStudents');
  if (!_currentSchoolId) throw new Error('No school context');

  const { duplicateAction = 'skip' } = options; // 'skip' or 'update'
  const profile = await getSchoolProfile();
  const existingStudents = await getStudents();
  const existingMap = new Map();
  existingStudents.forEach(s => {
    const adm = String(s.admNo || s.adm_no || '').trim().toLowerCase();
    if (adm) existingMap.set(adm, s);
  });

  const BATCH_SIZE = 50;
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const errors = [];
  const seenBatchAdmNos = new Set();

  const toInsert = [];
  const toUpdate = [];

  studentsData.forEach((s, idx) => {
    const admNo = String(s.admNo || s.adm_no || '').trim();
    const name = String(s.name || '').trim();
    const className = String(s.class || s.class_grade || '').trim();

    if (!name || name.length < 2) {
      errors.push({ row: idx + 1, name: name || 'Unknown', reason: 'Student name is required (min 2 chars)' });
      return;
    }
    if (!className) {
      errors.push({ row: idx + 1, name, reason: 'Class is required (no default will be assigned)' });
      return;
    }
    if (!admNo) {
      errors.push({ row: idx + 1, name, reason: 'Admission number is required' });
      return;
    }

    const lowerAdm = admNo.toLowerCase();
    if (seenBatchAdmNos.has(lowerAdm)) {
      errors.push({ row: idx + 1, name, reason: `Duplicate admission number (${admNo}) in uploaded batch` });
      return;
    }
    seenBatchAdmNos.add(lowerAdm);

    const record = {
      school_id: _currentSchoolId,
      adm_no: admNo,
      name,
      class: className,
      stream: s.stream || 'General',
      gender: s.gender || '',
      dob: s.dob || null,
      parent: s.parent || s.parentName || '',
      parent_phone: s.parentPhone || s.parent_phone || '',
      status: 'Active',
      subjects: getSubjectsForGrade(className, profile)
    };

    if (existingMap.has(lowerAdm)) {
      const existing = existingMap.get(lowerAdm);
      if (duplicateAction === 'update') {
        toUpdate.push({ id: existing.id, ...record });
      } else {
        skippedCount++;
      }
    } else {
      toInsert.push(record);
    }
  });

  // Execute Inserts in batches
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const { data: insertedData, error } = await supabase
      .from('students')
      .insert(batch)
      .select();

    if (error) {
      console.error('Batch insert error:', error);
      batch.forEach((b, bIdx) => {
        errors.push({ row: i + bIdx + 1, name: b.name, reason: error.message });
      });
    } else {
      const records = insertedData || batch;
      insertedCount += records.length;

      // Create fee records and local cache
      for (const rec of records) {
        try {
          if (rec.id) {
            await supabase.from('fees').insert({
              school_id: _currentSchoolId,
              student_id: rec.id,
              period_id: _currentPeriodId,
              total_fee: TERM_FEE,
              paid: 0,
              balance: TERM_FEE
            });
            await db.students.put(rec);
          }
        } catch (e) {
          // ignore non-critical fee error
        }
      }
    }

    if (onProgress) onProgress(insertedCount + updatedCount, studentsData.length);
  }

  // Execute Updates
  for (const upd of toUpdate) {
    const { id, ...fields } = upd;
    const { error: updErr } = await supabase
      .from('students')
      .update(fields)
      .eq('id', id)
      .eq('school_id', _currentSchoolId);

    if (updErr) {
      errors.push({ row: 0, name: fields.name, reason: updErr.message });
    } else {
      updatedCount++;
      try { await db.students.update(id, fields); } catch (e) {}
    }

    if (onProgress) onProgress(insertedCount + updatedCount, studentsData.length);
  }

  await logPlatformActivity(
    'STUDENTS_IMPORT',
    `Imported ${insertedCount} new students, updated ${updatedCount}, skipped ${skippedCount}`,
    _currentSchoolId
  );

  return {
    success: errors.length === 0 || insertedCount + updatedCount > 0,
    count: insertedCount + updatedCount,
    inserted: insertedCount,
    updated: updatedCount,
    skipped: skippedCount,
    errors
  };
}



export async function getStudentsBySchool(schoolId) {
  const { data, error } = await supabase
    .from('students')
    .select('id, name, adm_no, class_grade, stream, parent_phone, gender, join_date, school_id')
    .eq('school_id', schoolId);
  if (error) throw error;
  return data || [];
}
