import { supabase } from '../lib/supabase';
import { _currentSchoolId, mutationGuard, getSchoolProfileBySchoolId, checkIsSubscriptionActive, checkFeatureAccess, logPlatformActivity, hasFeature, getCurrentSchoolId } from './coreStore';
import { generateTempPassword } from '../utils/securityUtils';

// ============================================================================
// AUTH MODULE: API LAYER for Login & Register
// ============================================================================

export async function getAuthUserDetails(email) {
    const { data, error } = await supabase.from('users').select('school_id').eq('email', email).maybeSingle();
    if (error) throw error;
    return data;
}

export async function getHqSchool(email) {
    const { data, error } = await supabase.from('schools').select('id').eq('email', email).maybeSingle();
    if (error) throw error;
    return data;
}

export async function getUserByEmail(email) {
    const { data, error } = await supabase.from('users').select('id, school_id').eq('email', email).limit(1);
    if (error) throw error;
    return data;
}

export async function upsertAuthUser(schoolId, authUserId, name, email, role = 'Admin') {
    const { data, error } = await supabase.from('users')
        .upsert({
            school_id: schoolId, 
            auth_user_id: authUserId,
            name,
            email, 
            role
        }).select().single();
    if (error) throw error;
    return data;
}

export async function getMatchedUser(schoolId, email) {
    const { data, error } = await supabase.from('users').select('*, schools(id, name, plan)').eq('school_id', schoolId).eq('email', email).maybeSingle();
    if (error) throw error;
    return data;
}

export async function updateUserAuthId(userId, authUserId) {
    const { error } = await supabase.from('users').update({ auth_user_id: authUserId }).eq('id', userId);
    if (error) throw error;
    return true;
}

export async function getOwnedSchools(authUserId) {
    const { data, error } = await supabase.from('schools').select('*').eq('owner_id', authUserId);
    if (error) throw error;
    return data;
}

export async function getUserRecords(authUserId) {
    const { data, error } = await supabase.from('users').select('*, schools(id, name, plan)').eq('auth_user_id', authUserId);
    if (error) throw error;
    return data;
}

export async function checkSchoolExists(ownerId) {
    const { data, error } = await supabase.from('schools').select('id').eq('owner_id', ownerId).maybeSingle();
    if (error) throw error;
    return data;
}

export async function getUserRole(authUserId) {
    if (!authUserId) return null;
    const { data, error } = await supabase.from('users').select('role').eq('auth_user_id', authUserId).maybeSingle();
    if (error) { console.warn("getUserRole error:", error); return null; }
    return data?.role || null;
}


export async function getUsers() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, school_id, auth_user_id')
    .eq('school_id', _currentSchoolId);
  if (error) throw error;
  return data || [];
}

export async function saveUsers(users) {
  mutationGuard('saveUsers');
  // Bulk update
  const admins = users.filter(u => u.role === 'Admin');
  if (admins.length > 1) {
    throw new Error("Only one Administrator per school is allowed.");
  }
  for (const user of users) {
    await supabase.from('users')
      .update({ name: user.name, email: user.email, role: user.role })
      .eq('id', user.id);
  }
}

export async function addUser(user) {
  mutationGuard('addUser');
  if (user.role === 'Admin') {
    const existing = await getUsers();
    if (existing.some(u => u.role === 'Admin')) {
      throw new Error("Only one Administrator is allowed per school.");
    }
  }
  // Use the RPC to securely create an Auth identity and a public.user record
  const { data, error } = await supabase.rpc('invite_sub_admin', {
    new_email: user.email,
    new_name: user.name,
    new_role: user.role,
    new_password: user.password || generateTempPassword(),
    target_school_id: getCurrentSchoolId()
  });

  if (error) {
    throw new Error(error.message || 'Failed to add user. Ensure they do not already exist.');
  }
  
  return data;
}

export async function deleteUser(id) {
  mutationGuard('deleteUser');
  // Prevent deleting oneself
  const { data: { session } } = await supabase.auth.getSession();
  const all = await getUsers();
  const targetUser = all.find(u => u.id === id);

  if (targetUser && session?.user?.id === targetUser.auth_user_id) {
    throw new Error("You cannot delete your own account.");
  }

  // Also prevent deleting the owner of the school
  const { data: school } = await supabase
    .from('schools')
    .select('owner_id')
    .eq('id', _currentSchoolId)
    .single();

  if (school && targetUser && school.owner_id === targetUser.auth_user_id) {
    throw new Error("Cannot delete the primary school owner.");
  }

  const { error } = await supabase.from('users').delete().eq('id', id);
  if (error) throw error;
}

export async function getUserByAuthId(authUserId) {
  // Ultra-simplified query to isolate 406 error
  const { data, error } = await supabase
    .from('users')
    .select('id, name, role, school_id')
    .eq('auth_user_id', authUserId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function setSelfPassword(newPassword, oldPassword = null) {
  mutationGuard('setSelfPassword');
  
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) throw new Error('Not authenticated');

  // 1. If project requires old password, verify credentials
  if (oldPassword && user.email) {
    // Attempt re-authentication (Standard Supabase v2)
    if (typeof supabase.auth.reauthenticateWithPassword === 'function') {
      const { error: reauthErr } = await supabase.auth.reauthenticateWithPassword({ password: oldPassword });
      if (reauthErr) throw new Error(`Verification failed: ${reauthErr.message}`);
    } 
    // Fallback to fresh sign-in if reauthenticate is missing from library version
    else {
      const { error: verifyErr } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: oldPassword
      });
      if (verifyErr) throw new Error(`Verification failed: ${verifyErr.message}`);
    }
  }
  
  // 2. Update Auth Identity
  const { data: authData, error: authError } = await supabase.auth.updateUser({
    password: newPassword
  });
  if (authError) throw authError;

  // 3. Update users table password_changed flag
  const { error: dbError } = await supabase
    .from('users')
    .update({ password_changed: true })
    .eq('auth_user_id', user.id);
  if (dbError) throw dbError;
}

export async function validateStaffLogin(schoolSearch, phone, pin, schoolId = null) {
  const queryParam = schoolId || schoolSearch;

  const { data, error } = await supabase.rpc('validate_staff_portal_login', {
    p_school_search: queryParam,
    p_phone: phone,
    p_pin: pin
  });

  if (error) {
    throw new Error('Database connection error. Please try again.');
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  if (!data || !data.id) {
    throw new Error('Invalid credentials.');
  }

  const selectedSchoolId = data.schoolId || data.school_id;

  // 2. Resolve profile and check subscription/feature
  const profile = await getSchoolProfileBySchoolId(selectedSchoolId);
  
  // Subscription Gate
  const isSubActive = await checkIsSubscriptionActive(profile);
  if (!isSubActive) {
    throw new Error('Your institution\'s Termly subscription has expired. Access to the Staff Portal is restricted.');
  }

  // Feature Gate
  const hasFeature = await checkFeatureAccess('teacher_portal', profile);
  if (!hasFeature) {
    throw new Error('The Staff Portal feature is not active for your institution\'s current plan.');
  }

  // Pass through both user_id and teacher_record_id for dual-ID matching
  return {
    token: data.token || null,
    id: data.id,
    name: data.name,
    role: 'teacher',
    school_id: selectedSchoolId,
    schoolId: selectedSchoolId,  // backward compat
    teacher_record_id: data.teacher_record_id || data.id,  // teachers table ID
    user_id: data.user_id || data.id  // users table ID
  };
}

export async function validateParentLogin(schoolSearch, admNo, phone, schoolId = null) {
  const queryParam = schoolId || schoolSearch;

  const { data, error } = await supabase.rpc('validate_parent_portal_login', {
    p_school_search: queryParam,
    p_adm_no: admNo,
    p_phone: phone
  });

  if (error) {
    throw new Error('Database connection error. Please try again.');
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  if (!data || !data.id) {
    throw new Error('Invalid credentials.');
  }

  const selectedSchoolId = data.school_id;

  const profile = await getSchoolProfileBySchoolId(selectedSchoolId);

  // Subscription Gate
  const isSubActive = await checkIsSubscriptionActive(profile);
  if (!isSubActive) {
    throw new Error('Your institution\'s Termly subscription has expired. Access to the Parent Portal is restricted.');
  }

  // Feature Gate
  const hasFeature = await checkFeatureAccess('parent_portal', profile);
  if (!hasFeature) {
    throw new Error('The Parent Portal feature is not active for your institution\'s current plan.');
  }

  // Query linked siblings matching the parent phone
  let linkedChildren = [];
  try {
    const pPhone = (data.parent_phone || phone || '').trim();
    if (pPhone && selectedSchoolId) {
      const { data: siblings } = await supabase
        .from('students')
        .select('id, name, class, stream, adm_no, school_id, residence_type, parent_phone')
        .eq('school_id', selectedSchoolId)
        .eq('parent_phone', pPhone);
      if (siblings && siblings.length > 0) {
        linkedChildren = siblings;
      }
    }
  } catch (e) {
    console.warn('Child linkage search exception:', e);
  }

  if (linkedChildren.length === 0) {
    linkedChildren = [data];
  }

  return {
    token: data.token || null,
    id: data.id,
    name: data.name,
    class: data.class,
    stream: data.stream || '',
    subjects: data.subjects || [],
    adm_no: data.adm_no,
    school_id: data.school_id,
    residence_type: data.residence_type,
    parent_phone: data.parent_phone || '',
    linkedChildren: linkedChildren
  };
}

export async function resetUserPassword(authUserId, newPassword = null) {
  const passwordToSet = newPassword || generateTempPassword();
  // In a real app, you'd use a server-side route or a SECURITY DEFINER RPC.
  // For this demo/MVP, we'll try to use the RPC if it exists, or just log it.
  const { error } = await supabase.rpc('platform_reset_password', { 
    target_user_id: authUserId, 
    new_password: passwordToSet 
  });
  if (error) {
    console.error("Password reset RPC failed. Ensure platform_reset_password RPC exists.", error);
    throw new Error("Password reset failed. Administrative privileges required.");
  }
  await logPlatformActivity('PASSWORD_RESET', `Reset password for user: ${authUserId}`);
}

export async function verifyPortalSession(token) {
  if (!token) return { valid: false, error: 'No session token.' };
  try {
    const { data, error } = await supabase.rpc('portal_verify_session', { p_token: token });
    if (error || !data || !data.valid) {
      return { valid: false, error: data?.error || error?.message || 'Invalid session.' };
    }
    return data;
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

export async function logoutPortalSession(token) {
  if (!token) return;
  try {
    await supabase.rpc('portal_logout', { p_token: token });
  } catch (err) {
    console.warn('[AUTH] Logout RPC error:', err);
  }
}
