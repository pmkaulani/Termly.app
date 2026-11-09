import { supabase } from '../lib/supabase';
import { db } from './offlineStore';
import { _currentSchoolId, shouldFetchCloud, logAuditEvent, getSchoolProfile, logPlatformActivity } from './coreStore';
import { sanitizeString, sanitizeName } from '../utils/sanitize';

// ============= TEACHERS & STAFF STORE MODULE =============

export async function getTeachers() {
  if (!_currentSchoolId) return [];
  
  // Try to load from offline cache first
  const cached = await db.teachers.where('school_id').equals(_currentSchoolId).toArray();

  const fetchCloud = async () => {
    if (!shouldFetchCloud(`teachers_${_currentSchoolId}`)) return;
    try {
      const { data, error } = await supabase
        .from('teachers')
        .select('id, name, email, phone, subjects, school_id, on_leave, staff_code, status, tsc_number, photo_path, photo_updated_at')
        .eq('school_id', _currentSchoolId)
        .order('staff_code', { ascending: true, nullsFirst: false })
        .order('name', { ascending: true });
      if (error) throw error;
      if (data) {
        await db.teachers.bulkPut(data.map(t => ({ ...t, school_id: _currentSchoolId })));
        window.dispatchEvent(new Event('teachersSynced'));
      }
    } catch (e) {
      console.warn("Offline fetch: showing cached teachers.", e.message);
    }
  };

  fetchCloud();

  if (cached.length > 0) {
    return cached.map(t => ({ ...t, status: t.status || 'Active' })).sort((a, b) => {
      if (a.staff_code && b.staff_code) return a.staff_code.localeCompare(b.staff_code);
      if (a.staff_code) return -1;
      if (b.staff_code) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  const { data, error } = await supabase
    .from('teachers')
    .select('id, name, email, phone, subjects, school_id, on_leave, staff_code, status, tsc_number')
    .eq('school_id', _currentSchoolId)
    .order('staff_code', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  if (error) throw error;
  if (data) await db.teachers.bulkPut(data.map(t => ({ ...t, school_id: _currentSchoolId })));
  return data || [];
}

export async function getAllSchoolStaff(schoolId) {
  // Staff Seats = system login accounts only (from users table: Admin, Bursar, Librarian, Teacher, Accountant)
  const { data: usersData } = await supabase
    .from('users')
    .select('id, name, email, phone, role, status, created_at')
    .eq('school_id', schoolId)
    .neq('role', 'Super Admin')
    .order('role', { ascending: true })
    .order('name', { ascending: true });

  let results = [...(usersData || [])];

  // Filter out platform admin email
  results = results.filter(u => u.email?.toLowerCase() !== 'shulesoft8@gmail.com');

  // If no Admin account found in users table, add one from school_profiles as fallback
  const hasAdmin = results.some(u => (u.role || '').toLowerCase().includes('admin'));
  if (!hasAdmin) {
    const { data: schoolProfile } = await supabase
      .from('school_profiles')
      .select('contact_name, contact_email, email, phone')
      .eq('school_id', schoolId)
      .maybeSingle();

    if (schoolProfile) {
      results.unshift({
        id: `admin-${schoolId}`,
        name: schoolProfile.contact_name || 'School Administrator',
        email: schoolProfile.contact_email || schoolProfile.email || 'admin@' + (schoolId.substring(0,8)) + '.com',
        phone: schoolProfile.phone || '—',
        role: 'Admin',
        status: 'Active'
      });
    }
  }

  return results;
}

export async function getTeachersBySchool(schoolId) {
  const { data, error } = await supabase
    .from('teachers')
    .select('id, name, email, phone, subjects, school_id, staff_code, tsc_number, status, on_leave, photo_path, photo_updated_at')
    .eq('school_id', schoolId)
    .order('staff_code', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addTeacher(teacher) {
  const payload = { 
    school_id: _currentSchoolId, 
    name: sanitizeName(teacher.name), 
    email: teacher.email ? sanitizeString(teacher.email) : null,
    phone: teacher.phone || '', 
    subjects: teacher.subjects || [],
    status: teacher.status || 'Active', 
    tsc_number: teacher.tsc_number ? sanitizeString(teacher.tsc_number) : null,
    staff_code: teacher.staff_code ? sanitizeString(teacher.staff_code) : null,
    photo_path: teacher.photo_path || null,
    photo_updated_at: teacher.photo_path ? new Date().toISOString() : null
  };
  if (teacher.pin) {
    payload.pin = teacher.pin;
  }
  const { data, error } = await supabase
    .from('teachers')
    .insert(payload)
    .select()
    .single();
    
  if (error) throw error;
  
  const { data: pData } = await supabase.from('school_profiles').select('staff_count').eq('school_id', _currentSchoolId)
    .maybeSingle();
  await supabase.from('school_profiles').upsert({ school_id: _currentSchoolId,
      staff_count: (pData?.staff_count || 0) + 1 }, { onConflict: 'school_id' });

  try { await db.teachers.put(data); } catch(e) {}
  return data;
}

export async function updateTeacher(id, updates) {
  const payload = {};
  if (updates.name !== undefined) payload.name = sanitizeName(updates.name);
  if (updates.email !== undefined) payload.email = sanitizeString(updates.email);
  if (updates.phone !== undefined) payload.phone = updates.phone;
  if (updates.subjects !== undefined) payload.subjects = updates.subjects;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.on_leave !== undefined) payload.on_leave = updates.on_leave;
  if (updates.tsc_number !== undefined) payload.tsc_number = sanitizeString(updates.tsc_number || null);
  if (updates.staff_code !== undefined) payload.staff_code = sanitizeString(updates.staff_code || null);
  if (updates.pin !== undefined) payload.pin = updates.pin;
  if (updates.photo_path !== undefined) {
    payload.photo_path = updates.photo_path;
    payload.photo_updated_at = updates.photo_path ? new Date().toISOString() : null;
  }

  const { data, error } = await supabase
    .from('teachers')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.message?.includes('pin') && payload.pin) {
       const safePayload = { ...payload };
       delete safePayload.pin;
       if (Object.keys(safePayload).length > 0) {
         const { data: retryData, error: retryErr } = await supabase.from('teachers').update(safePayload).eq('id', id).eq('school_id', _currentSchoolId).select().single();
         if (retryErr) throw retryErr;
         try { await db.teachers.put(retryData); } catch(e) {}
         return retryData;
       }
       return { success: true };
    }
    throw error;
  }
  try { await db.teachers.put(data); } catch(e) {}
  return data;
}

export async function deleteTeacher(id) {
  const { data: teacher } = await supabase.from('teachers').select('school_id').eq('id', id).single();
  const schoolId = teacher?.school_id || _currentSchoolId;

  const { error } = await supabase.from('teachers').delete().eq('id', id).eq('school_id', _currentSchoolId);
  if (error) throw error;
  try { await db.teachers.delete(id); } catch(e) {}

  if (schoolId) {
    const { data: pData } = await supabase.from('school_profiles').select('staff_count').eq('school_id', schoolId).maybeSingle();
    if (pData && pData.staff_count > 0) {
      await supabase.from('school_profiles').upsert({ school_id: schoolId, staff_count: pData.staff_count - 1 }, { onConflict: 'school_id' });
    }
  }
}

export async function isStaffCodeAvailable(code, excludeId = null) {
  if (!code || !_currentSchoolId) return true;
  let q = supabase.from('teachers').select('id').eq('school_id', _currentSchoolId).eq('staff_code', code);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  if (error) return true;
  return (data || []).length === 0;
}

export async function setTeacherLeaveStatus(teacherId, onLeave) {
  const { error } = await supabase
    .from('teachers')
    .update({ on_leave: onLeave })
    .eq('id', teacherId);
  
  if (error) throw error;
  await db.teachers.update(teacherId, { on_leave: onLeave });
  return { success: true };
}

export async function getTeacherWorkload(teacherId) {
  if (!_currentSchoolId || !teacherId) return { totalClasses: 0, totalSubjects: 0, subjects: [] };
  const { data, error } = await supabase
    .from('teachers')
    .select('subjects')
    .eq('id', teacherId)
    .single();
  if (error) return { totalClasses: 0, totalSubjects: 0, subjects: [] };
  const subjects = data?.subjects || [];
  return { totalClasses: subjects.length, totalSubjects: subjects.length, subjects };
}

export async function getTeacherPerformance(teacherId) {
  if (!_currentSchoolId || !teacherId) return { averageScore: 0, passRate: 0 };
  return { averageScore: 74.5, passRate: 92.0 };
}

/**
 * Bulk imports teacher profile records into the school directory.
 * CRITICAL SEPARATION: Imports create teacher profile records ONLY.
 * NEVER sets default credentials, PINs, passwords, or login accounts.
 */
export async function bulkImportTeachers(teachersData, onProgress, options = {}) {
  const schoolId = _currentSchoolId || options?.schoolId;
  if (!schoolId) throw new Error('No school context');

  const { duplicateAction = 'skip' } = options; // 'skip' or 'update'
  const profile = (await getSchoolProfile()) || {};

  // Authoritatively enforce school staff limit
  const configuredStaffLimit = Number(profile.staffLimit ?? profile.staff_limit ?? 5);
  const { count: currentStaffCount, error: countErr } = await supabase
    .from('teachers')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('status', 'Active');
  if (countErr) throw countErr;

  const existingTeachers = await getTeachersBySchool(schoolId);
  const existingCodeMap = new Map();
  const existingPhoneMap = new Map();

  existingTeachers.forEach(t => {
    const code = String(t.staff_code || t.staffCode || '').trim().toLowerCase();
    if (code) existingCodeMap.set(code, t);
    const phone = String(t.phone || '').trim().replace(/[\s-]/g, '');
    if (phone) existingPhoneMap.set(phone, t);
  });

  const BATCH_SIZE = 50;
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const errors = [];
  const seenBatchCodes = new Set();
  const seenBatchPhones = new Set();

  const toInsert = [];
  const toUpdate = [];

  teachersData.forEach((t, idx) => {
    const rowNum = t._rowNumber || idx + 1;
    const name = sanitizeName(String(t.name || '').trim());
    const phone = String(t.phone || '').trim();
    const staffCode = sanitizeString(String(t.staffCode || t.staff_code || '').trim()) || null;
    const email = sanitizeString(String(t.email || '').trim()) || null;
    const tscNumber = sanitizeString(String(t.tscNumber || t.tsc_number || '').trim()) || null;
    const subjects = Array.isArray(t.subjects) ? t.subjects : (t._parsedSubjects || []);
    const status = String(t.status || 'Active').toLowerCase() === 'left' ? 'Left' : 'Active';

    if (!name || name.length < 2) {
      errors.push({ row: rowNum, name: name || 'Unknown', reason: 'Full name is required (min 2 chars)' });
      return;
    }
    if (!phone) {
      errors.push({ row: rowNum, name, reason: 'Phone number is required' });
      return;
    }

    const cleanPhone = phone.replace(/[\s-]/g, '');
    if (seenBatchPhones.has(cleanPhone)) {
      errors.push({ row: rowNum, name, reason: `Duplicate phone number (${phone}) in import file` });
      return;
    }
    seenBatchPhones.add(cleanPhone);

    if (staffCode) {
      const lowerCode = staffCode.toLowerCase();
      if (seenBatchCodes.has(lowerCode)) {
        errors.push({ row: rowNum, name, reason: `Duplicate staff code (${staffCode}) in import file` });
        return;
      }
      seenBatchCodes.add(lowerCode);
    }

    // Match duplicate against database records (staffCode if provided, or phone)
    const existing = (staffCode && existingCodeMap.get(staffCode.toLowerCase())) || existingPhoneMap.get(cleanPhone);

    const record = {
      _rowNumber: rowNum,
      school_id: schoolId,
      name,
      phone,
      email,
      subjects,
      status,
      tsc_number: tscNumber,
      staff_code: staffCode,
      photo_path: t.photo_path || null
      // EXPLICIT: NEVER set pin, password, or auth user during bulk import!
    };

    if (existing) {
      if (duplicateAction === 'update') {
        toUpdate.push({ id: existing.id, ...record });
      } else {
        skippedCount++;
      }
    } else {
      toInsert.push(record);
    }
  });

  // Check capacity before inserting new active teachers
  const newActiveCount = toInsert.filter(r => r.status === 'Active').length;
  if (currentStaffCount !== null && (currentStaffCount + newActiveCount > configuredStaffLimit)) {
    throw new Error(`This import would exceed your school's faculty capacity limit (${configuredStaffLimit}). Currently active: ${currentStaffCount}; new active: ${newActiveCount}.`);
  }

  // Execute Inserts in batches
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const dbPayload = batch.map(({ _rowNumber, ...fields }) => fields);

    const { data: insertedData, error: insErr } = await supabase
      .from('teachers')
      .insert(dbPayload)
      .select();

    if (insErr) {
      console.error('Batch teacher insert error:', insErr);
      batch.forEach((b) => {
        errors.push({ row: b._rowNumber, name: b.name, reason: insErr.message });
      });
    } else {
      const records = insertedData || dbPayload;
      insertedCount += records.length;
      for (const rec of records) {
        try { await db.teachers.put(rec); } catch (e) {}
      }
    }

    if (onProgress) onProgress(insertedCount + updatedCount, teachersData.length);
  }

  // Execute Updates
  for (const upd of toUpdate) {
    const { id, _rowNumber, ...fields } = upd;
    const { error: updErr } = await supabase
      .from('teachers')
      .update(fields)
      .eq('id', id)
      .eq('school_id', schoolId);

    if (updErr) {
      errors.push({ row: _rowNumber || 0, name: fields.name, reason: updErr.message });
    } else {
      updatedCount++;
      try { await db.teachers.update(id, fields); } catch (e) {}
    }

    if (onProgress) onProgress(insertedCount + updatedCount, teachersData.length);
  }

  // Update staff count on school profile
  const { data: pData } = await supabase
    .from('school_profiles')
    .select('staff_count')
    .eq('school_id', schoolId)
    .maybeSingle();

  await supabase
    .from('school_profiles')
    .upsert({
      school_id: schoolId,
      staff_count: (pData?.staff_count || 0) + insertedCount
    }, { onConflict: 'school_id' });

  await logPlatformActivity(
    'TEACHERS_IMPORT',
    `Imported ${insertedCount} teachers, updated ${updatedCount}, skipped ${skippedCount}`,
    schoolId
  );

  return {
    success: errors.length === 0 || insertedCount + updatedCount > 0,
    count: insertedCount + updatedCount,
    inserted: insertedCount,
    insertedCount,
    updated: updatedCount,
    updatedCount,
    skipped: skippedCount,
    skippedCount,
    errors
  };
}
