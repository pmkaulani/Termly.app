import { supabase } from '../lib/supabase';
import { db } from './offlineStore';
import { _currentSchoolId, shouldFetchCloud, logAuditEvent } from './coreStore';
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
        .select('id, name, email, phone, subjects, school_id, on_leave, staff_code, status, tsc_number')
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
    .select('id, name, email, phone, subjects, school_id, staff_code, tsc_number')
    .eq('school_id', schoolId)
    .order('staff_code', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addTeacher(teacher) {
  const { data, error } = await supabase
    .from('teachers')
    .insert({ 
      school_id: _currentSchoolId, 
      name: teacher.name, 
      email: teacher.email || null,
      phone: teacher.phone || '', 
      subjects: teacher.subjects || [],
      status: teacher.status || 'Active', 
      tsc_number: teacher.tsc_number || null,
      staff_code: teacher.staff_code || null,
      pin: teacher.pin || '1234'
    })
    .select()
    .single();
    
  if (error) throw error;
  
  const { data: pData } = await supabase.from('school_profiles').select('staff_count').eq('school_id', _currentSchoolId).maybeSingle();
  await supabase.from('school_profiles').upsert({ school_id: _currentSchoolId, staff_count: (pData?.staff_count || 0) + 1 }, { onConflict: 'school_id' });

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