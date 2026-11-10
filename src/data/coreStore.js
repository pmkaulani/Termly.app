import { supabase } from '../lib/supabase';
import { isSchoolAccessActive } from '../utils/schoolEntitlement.mjs';

export { supabase };

export let _currentSchoolId = sessionStorage.getItem('Termly_portal_school_id') || null;
export let _currentAuthUser = null;
export let _currentPeriodId = sessionStorage.getItem('Termly_portal_period_id') || null;
export let _currentUserId   = sessionStorage.getItem('Termly_portal_user_id') || null;
export let _currentExamType = '';



export function initPortalStore(schoolId, userId = null, periodId = null) {
  console.log(`[PORTAL STORE] Initializing for School: ${schoolId}, User: ${userId}`);
  _currentSchoolId = schoolId;
  _currentUserId = userId;
  _currentPeriodId = periodId;
  _currentAuthUser = null; 
  
  if (schoolId) sessionStorage.setItem('Termly_portal_school_id', schoolId);
  if (userId) sessionStorage.setItem('Termly_portal_user_id', userId);
  if (periodId) sessionStorage.setItem('Termly_portal_period_id', periodId);
  
  window.dispatchEvent(new Event('schoolProfileChanged'));
}

export const isShadowMode = () => {
  return sessionStorage.getItem('Termly_acting_as_admin') === 'true';
};

export async function logAuditEvent(action, targetType, targetId, details) {
  if (!_currentSchoolId) return;
  try {
    const { error } = await supabase.from('audit_logs').insert({
      school_id: _currentSchoolId,
      user_id: _currentUserId,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
      created_at: new Date().toISOString()
    });
    if (error) console.error("Audit Log failed:", error);
  } catch (e) {
    console.error("Audit log error:", e);
  }
}

export async function logPlatformActivity(type, description, schoolId = null) {
  try {
    const { error } = await supabase.from('platform_activity').insert({
      type,
      description,
      school_id: schoolId,
      actor_email: _currentUserId,
      created_at: new Date().toISOString()
    });
    if (error) console.error("Platform Activity Log failed:", error);
  } catch (e) {
    console.error("Platform activity error:", e);
  }
}

export const mutationGuard = (fnName) => {
  if (isShadowMode()) {
    console.warn(`[SHADOW MODE] Blocked mutation attempt in ${fnName}`);
    throw new Error('Action blocked: You are currently in View-Only Shadow Mode (Watching TV).');
  }
};

const _lastFetch = {};
export function shouldFetchCloud(key, ttl = 10000) {
  const now = Date.now();
  if (!_lastFetch[key] || now - _lastFetch[key] > ttl) {
    _lastFetch[key] = now;
    return true;
  }
  return false;
}

const _dbCache = {};
export async function cachedQuery(key, fetcher, ttl = 10000) {
  const now = Date.now();
  if (_dbCache[key] && (now - _dbCache[key].time) < ttl) {
    return _dbCache[key].promise;
  }
  const promise = fetcher();
  _dbCache[key] = { time: now, promise };
  try {
    await promise;
  } catch (e) {
    delete _dbCache[key];
    throw e;
  }
  return promise;
}

export function invalidateCache(key) {
  if (key) delete _dbCache[key];
  else {
    Object.keys(_dbCache).forEach(k => delete _dbCache[k]);
  }
}

// ============= FEATURE TOGGLES (Replaces Plans) =============
const _featureCache = new Map(); // Cache map: { `${schoolId}_${featureKey}`: { value: boolean, timestamp: number } }
const CACHE_TTL = 30 * 1000; // 30 seconds

export async function hasFeature(schoolId, featureKey) {
  if (!schoolId || !featureKey) return false;
  
  const cacheKey = `${schoolId}_${featureKey}`;
  const cached = _featureCache.get(cacheKey);
  const now = Date.now();

  // Return cached if within TTL
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    return cached.value;
  }

  try {
    let finalStatus = false;

    // PORTAL/UNAUTH MODE: Use RPC to bypass RLS
    if (!_currentAuthUser) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('portal_has_feature', { 
        p_school_id: schoolId, 
        p_feature_key: featureKey 
      });
      if (!rpcError && rpcData !== null) {
        finalStatus = rpcData;
      } else {
        // Fallback to direct query if RPC fails or is missing
        const { data, error } = await supabase
          .from('school_features')
          .select('is_enabled, expires_at')
          .eq('school_id', schoolId)
          .eq('feature_key', featureKey)
          .maybeSingle();
        
        const isEnabled = data?.is_enabled || false;
        const isExpired = data?.expires_at && new Date(data.expires_at) < now;
        finalStatus = isEnabled && !isExpired;
      }
    } else {
      // ADMIN MODE: Direct table query (has auth session)
      const { data, error } = await supabase
        .from('school_features')
        .select('is_enabled, expires_at')
        .eq('school_id', schoolId)
        .eq('feature_key', featureKey)
        .maybeSingle();
        
      if (error && error.code !== 'PGRST116') {
        console.error(`Error checking feature ${featureKey}:`, error);
        return false; 
      }
      
      const isEnabled = data?.is_enabled || false;
      const isExpired = data?.expires_at && new Date(data.expires_at) < now;
      finalStatus = isEnabled && !isExpired;
    }

    _featureCache.set(cacheKey, { value: finalStatus, timestamp: now });
    return finalStatus;
  } catch (err) {
    console.error(`Exception checking feature ${featureKey}:`, err);
    return false;
  }
}

export function invalidateFeatureCache(schoolId) {
  if (!schoolId) {
    _featureCache.clear();
    return;
  }
  for (const key of _featureCache.keys()) {
    if (key.startsWith(`${schoolId}_`)) {
      _featureCache.delete(key);
    }
  }
}

export async function getAllFeaturesRegistry() {
  const { data, error } = await supabase
    .from('features_registry')
    .select('*')
    .order('feature_name');
  if (error) throw error;
  return data || [];
}

export async function updateSchoolFeature(schoolId, featureKey, isEnabled, expiresAt = null) {
  mutationGuard('updateSchoolFeature');
  const { error } = await supabase
    .from('school_features')
    .upsert({
      school_id: schoolId,
      feature_key: featureKey,
      is_enabled: isEnabled,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'school_id, feature_key' });
  
  if (error) throw error;
  _featureCache.delete(`${schoolId}_${featureKey}`);
}

export async function getSchoolFeatures(schoolId) {
  const { data, error } = await supabase
    .from('school_features')
    .select('*')
    .eq('school_id', schoolId);
  if (error) throw error;
  return data || [];
}

export function setCurrentSchoolContext(schoolId, authUser) {
  _currentSchoolId = schoolId;
  _currentAuthUser = authUser;
  window.dispatchEvent(new Event('schoolProfileChanged'));
}

export function setCurrentPeriodId(periodId) {
  _currentPeriodId = periodId;
  window.dispatchEvent(new Event('periodChanged'));
}

export function getCurrentPeriodId() {
  return _currentPeriodId;
}

export function setCurrentExamType(type) {
  _currentExamType = type;
  window.dispatchEvent(new Event('examTypeChanged'));
}

export function getCurrentExamType() {
  return _currentExamType;
}

export function getCurrentSchoolId() {
  return _currentSchoolId;
}

export function getCurrentAuthUser() {
  return _currentAuthUser;
}

export function setCurrentSchool(schoolId) {
  _currentSchoolId = schoolId;
  window.dispatchEvent(new Event('schoolChanged'));
}

export function getCurrentSchool() {
  return _currentSchoolId;
}


// ============================================================================
// EVERYTHING BELOW WAS RESTORED BY fix_coreStore_final.cjs
// These functions were in the original monolithic store.js and must be exported
// from coreStore.js for the domain stores and pages to work.
// ============================================================================



// ============= REALTIME SUBSCRIPTIONS =============

export function subscribeToSchoolChanges(onSettingsChange, onProfileChange) {
  if (!_currentSchoolId) return () => {};

  const channel = supabase
    .channel(`school_shell_${_currentSchoolId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'platform_settings' }, () => {
      onSettingsChange();
    })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'school_profiles',
      filter: `school_id=eq.${_currentSchoolId}`
    }, () => {
      _profileCache = null;
      onProfileChange();
      window.dispatchEvent(new Event('schoolProfileChanged'));
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'schools',
      filter: `id=eq.${_currentSchoolId}`
    }, () => {
      console.log('[REALTIME] Schools table changed — re-evaluating subscription status');
      _profileCache = null;
      onProfileChange();
      window.dispatchEvent(new Event('schoolProfileChanged'));
    })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'school_features',
      filter: `school_id=eq.${_currentSchoolId}`
    }, (payload) => {
      console.log("[REALTIME] Feature changed:", payload.new);
      invalidateFeatureCache(_currentSchoolId);
      onSettingsChange();
    })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'students',
      filter: `school_id=eq.${_currentSchoolId}`
    }, () => {
      window.dispatchEvent(new Event('studentsSynced'));
    })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'mpesa_callbacks',
      filter: `school_id=eq.${_currentSchoolId}`
    }, () => {
      window.dispatchEvent(new Event('mpesaCallbackReceived'));
    })
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export function subscribeToPlatformChanges(onPlatformActivity) {
  const channel = supabase
    .channel('platform_admin_global')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'schools' }, () => {
      onPlatformActivity?.();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'platform_settings' }, () => {
      onPlatformActivity?.();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'platform_activity' }, () => {
      onPlatformActivity?.();
    })
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export function subscribeToChanges(onStudentChange, onFeeChange) {
  if (!_currentSchoolId) return () => {};
  const channel = supabase
    .channel(`data_changes_${_currentSchoolId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'students',
      filter: `school_id=eq.${_currentSchoolId}`
    }, () => onStudentChange?.())
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'fees',
      filter: `school_id=eq.${_currentSchoolId}`
    }, () => onFeeChange?.())
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ============= PROFILE HELPERS =============

export async function getSchoolProfileBySchoolId(schoolId) {
  if (!schoolId) return null;
  const [{ data, error }, { data: schoolData }] = await Promise.all([
    supabase.from('school_profiles').select('*').eq('school_id', schoolId).maybeSingle(),
    supabase.from('schools').select('*').eq('id', schoolId).maybeSingle()
  ]);

  if (error || (!data && !schoolData)) return null;

  const prof = data || {};
  const sch = schoolData || {};

  const activeClasses = prof.active_classes || prof.activeClasses || [];
  const streamsPerClass = prof.streams_per_class || prof.streamsPerClass || {};
  const customSubjects = prof.custom_subjects || prof.customSubjects || {};
  const gradeFees = prof.grade_fees || prof.gradeFees || {};
  const gradingSystems = prof.grading_systems || prof.gradingSystems || null;

  return {
    id: prof.id || sch.id,
    schoolId: schoolId,
    school_id: schoolId,
    schoolName: prof.school_name || prof.schoolName || sch.name || '',
    school_name: prof.school_name || prof.schoolName || sch.name || '',
    subscriptionPlan: sch.plan || prof.subscription_plan || 'Free',
    subscriptionStatus: sch.status || prof.subscription_status || 'Active',
    subscriptionExpiry: sch.subscription_expiry || prof.subscription_expiry || null,
    licenseType: prof.license_type || 'subscription',
    licenseStatus: prof.license_status || 'active',
    licenseId: prof.license_id || null,
    licenseIssuedAt: prof.license_issued_at || null,
    licenseSupportUntil: prof.license_support_until || null,
    licenseReference: prof.license_reference || null,
    license_type: prof.license_type || 'subscription',
    license_status: prof.license_status || 'active',
    licenseWorkspaceStatus: sch.status || 'Active',
    licenseSubscriptionStatus: prof.subscription_status || sch.status || 'Active',
    logoUrl: prof.logo_url || prof.logo || '',
    logo: prof.logo || prof.logo_url || '',
    primaryColor: prof.primary_color || (typeof localStorage !== 'undefined' ? localStorage.getItem(`Termly_primary_color_${schoolId}`) : null) || null,
    motto: prof.motto || '',
    phone: prof.phone || '',
    address: prof.address || '',
    email: prof.email || sch.email || '',
    schoolType: prof.school_type || prof.schoolType || 'Day',
    school_type: prof.school_type || prof.schoolType || 'Day',
    curriculum: prof.curriculum || 'CBC Only',
    enabledModules: prof.enabled_modules || {},
    enabled_modules: prof.enabled_modules || {},
    grading_systems: gradingSystems,
    gradingSystems: gradingSystems,
    grade_fees: gradeFees,
    gradeFees: gradeFees,
    active_classes: activeClasses,
    activeClasses: activeClasses,
    streams_per_class: streamsPerClass,
    streamsPerClass: streamsPerClass,
    custom_subjects: customSubjects,
    customSubjects: customSubjects,
    studentLimit: sch.student_limit || prof.student_limit || customSubjects?.__limits?.students || 10000,
    student_limit: sch.student_limit || prof.student_limit || customSubjects?.__limits?.students || 10000,
    staffLimit: sch.staff_limit || prof.staff_limit || customSubjects?.__limits?.staff || 5,
    staff_limit: sch.staff_limit || prof.staff_limit || customSubjects?.__limits?.staff || 5,
    portal_access: prof.portal_access,
    mpesa_config: { managed_by: 'supabase_edge_function_secrets' },
    sms_config: { managed_by: 'supabase_edge_function_secrets' },
    setup_completed: prof.setup_completed
  };
}

export function checkIsSubscriptionActive(profile) {
  return isSchoolAccessActive(profile);
}

export async function checkFeatureAccess(featureKey, profile) {
  if (!profile || !profile.schoolId) return false;
  if (profile.subscriptionPlan === 'Platform Admin') return true;
  return await hasFeature(profile.schoolId, featureKey);
}

export async function isFeatureEnabled(featureSlug) {
  if (!_currentSchoolId) return false;
  try {
    const profile = await getSchoolProfile();
    if (profile.enabledModules?.[featureSlug] === false) return false;
    return await checkFeatureAccess(featureSlug, profile);
  } catch (e) {
    console.error("Feature gating error:", e);
    return false;
  }
}

export async function checkIsPlatformAdmin(email) {
  try {
    let targetEmail = email;
    if (!targetEmail) {
      const { data: { user } } = await supabase.auth.getUser();
      targetEmail = user?.email;
    }
    if (!targetEmail) return false;
    return targetEmail.toLowerCase().trim() === 'shulesoft8@gmail.com';
  } catch { return false; }
}

// ============= SCHOOL PROFILE CRUD =============

let _profileCache = null;

export async function refreshSchoolProfile() {
  if (!_currentSchoolId) return null;
  _profileCache = null;
  return getSchoolProfile();
}

export async function getSchoolProfile() {
  if (!_currentSchoolId) return null;
  if (_profileCache) return _profileCache;
  const profile = await getSchoolProfileBySchoolId(_currentSchoolId);
  _profileCache = profile;
  return profile;
}

export const DEFAULT_PROFILE = {
  enabledModules: { students: true, attendance: true, grading: true, fees: true, dashboard: true }
};

export async function saveSchoolProfile(profile) {
  mutationGuard('saveSchoolProfile');
  if (!_currentSchoolId) {
    throw new Error("School Identification Lost. Please refresh your browser or log in again.");
  }

  const { ...rest } = profile;
  const row = { ...rest, school_id: _currentSchoolId };

  // Map camelCase UI properties to snake_case DB columns
  if (profile.activeClasses !== undefined) row.active_classes = profile.activeClasses;
  if (profile.streamsPerClass !== undefined) row.streams_per_class = profile.streamsPerClass;
  if (profile.customSubjects !== undefined) row.custom_subjects = profile.customSubjects;
  if (profile.gradeFees !== undefined) row.grade_fees = profile.gradeFees;
  if (profile.gradingSystems !== undefined) row.grading_systems = profile.gradingSystems;
  if (profile.schoolName !== undefined) row.school_name = profile.schoolName;
  if (profile.schoolType !== undefined) row.school_type = profile.schoolType;
  if (profile.logo !== undefined) {
    row.logo = profile.logo;
    row.logo_url = profile.logo;
  } else if (profile.logoUrl !== undefined) {
    row.logo_url = profile.logoUrl;
    row.logo = profile.logoUrl;
  }
  if (profile.primaryColor !== undefined) {
    row.primary_color = profile.primaryColor;
    if (_currentSchoolId && typeof localStorage !== 'undefined') {
      if (profile.primaryColor) {
        localStorage.setItem(`Termly_primary_color_${_currentSchoolId}`, profile.primaryColor);
      } else {
        localStorage.removeItem(`Termly_primary_color_${_currentSchoolId}`);
      }
    }
  }

  const encryptIfNew = async (val, oldEncrypted) => {
    if (!val) return null;
    if (val.includes?.('...********')) return oldEncrypted;
    return val;
  };

  row.mpesa_config = { managed_by: 'supabase_edge_function_secrets' };
  row.sms_config = { managed_by: 'supabase_edge_function_secrets' };

  if (row.grading_systems) {
    Object.keys(row.grading_systems).forEach(lv => {
      if (Array.isArray(row.grading_systems[lv])) {
        row.grading_systems[lv] = row.grading_systems[lv].map(g => ({
          ...g,
          min: Math.max(0, Math.min(100, Number(g.min) || 0)),
          max: Math.max(0, Math.min(100, Number(g.max) || 0))
        }));
      }
    });
  }
  if (row.grade_fees) {
    Object.keys(row.grade_fees).forEach(g => {
      if (typeof row.grade_fees[g] === 'object') {
        row.grade_fees[g].day = Math.max(0, Number(row.grade_fees[g].day) || 0);
        row.grade_fees[g].boarding = Math.max(0, Number(row.grade_fees[g].boarding) || 0);
      } else {
        row.grade_fees[g] = Math.max(0, Number(row.grade_fees[g]) || 0);
      }
    });
  }

  const skippedColumns = [];
  const attemptSave = async (payload) => {
    const { error } = await supabase
      .from('school_profiles')
      .upsert(payload, { onConflict: 'school_id' });
    if (error) {
      if (error.message?.includes('column') || error.hint?.includes('column')) {
        const quotedMatches = error.message.match(/["']([^"']+)["']/g) || [];
        let foundCol = null;
        for (const match of quotedMatches) {
          const possibleCol = match.replace(/["']/g, '');
          if (payload[possibleCol] !== undefined) { foundCol = possibleCol; break; }
        }
        if (foundCol) {
          skippedColumns.push(foundCol);
          const newPayload = { ...payload };
          delete newPayload[foundCol];
          return attemptSave(newPayload);
        }
      }
      throw error;
    }
  };

  await attemptSave(row);
  _profileCache = null;
  window.dispatchEvent(new Event('schoolProfileChanged'));
  return { success: true, skipped: skippedColumns };
}

// ============= PLATFORM SETTINGS =============

export async function getPlatformSettings() {
  return cachedQuery('platformSettings', async () => {
    const { data, error } = await supabase.from('platform_settings').select('*');
    if (error) throw error;
    const settings = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });
    return settings;
  }, 30000);
}

export async function updatePlatformSetting(key, value) {
  mutationGuard('updatePlatformSetting');
  const { error } = await supabase
    .from('platform_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  invalidateCache('platformSettings');
}

export async function getPlatformStats() {
  const [schoolsRes, studentsRes, usersRes] = await Promise.all([
    supabase.from('schools').select('id', { count: 'exact' }),
    supabase.from('students').select('id', { count: 'exact' }).eq('status', 'Active'),
    supabase.from('users').select('id', { count: 'exact' })
  ]);
  return {
    totalSchools: schoolsRes.count || 0,
    totalStudents: studentsRes.count || 0,
    totalUsers: usersRes.count || 0
  };
}

// ============= SCHOOL MANAGEMENT (SUPER ADMIN) =============

export async function getAllSchools() {
  const { data: schools, error: sErr } = await supabase
    .from('schools')
    .select('id, name, email, plan, owner_id, phone, location, created_at, school_profiles(*)');

  if (sErr) {
    console.error('Error fetching all schools:', sErr);
    return [];
  }

  const [studentsRes, staffRes, featuresRes] = await Promise.all([
    supabase.from('students').select('school_id').eq('status', 'Active'),
    supabase.from('users').select('school_id').neq('role', 'Super Admin'),
    supabase.from('school_features').select('school_id').eq('is_enabled', true)
  ]);

  const studentCounts = (studentsRes.data || []).reduce((acc, curr) => {
    acc[curr.school_id] = (acc[curr.school_id] || 0) + 1; return acc;
  }, {});
  const staffCounts = (staffRes.data || []).reduce((acc, curr) => {
    acc[curr.school_id] = (acc[curr.school_id] || 0) + 1; return acc;
  }, {});
  const featureCounts = (featuresRes.data || []).reduce((acc, curr) => {
    acc[curr.school_id] = (acc[curr.school_id] || 0) + 1; return acc;
  }, {});

  const { data: registry } = await supabase.from('features_registry').select('feature_key').eq('is_beta', false);
  const totalCount = (registry?.length || 14);

  return (schools || []).map(s => ({
    ...s,
    _studentCount: studentCounts[s.id] || 0,
    _staffCount: staffCounts[s.id] || 0,
    features_count: featureCounts[s.id] || 0,
    features_total: totalCount
  }));
}

export async function updateSchoolPlan(schoolId, planName) {
  const { error } = await supabase
    .from('schools')
    .update({ plan: planName })
    .eq('id', schoolId);
  if (error) throw error;
  await logPlatformActivity('PLAN_CHANGE', `School ${schoolId} plan updated to ${planName}`, schoolId);
}

export async function updateSchoolLimits(schoolId, { students, staff }) {
  const numStudents = Number(students) || 10000;
  const numStaff = Number(staff) || 5;

  const { data: profile } = await supabase
    .from('school_profiles')
    .select('id, custom_subjects')
    .eq('school_id', schoolId)
    .maybeSingle();

  const custom_subjects = profile?.custom_subjects || {};
  custom_subjects.__limits = {
    students: numStudents,
    staff: numStaff,
  };

  // .update() only touches rows that already exist — if this school has no
  // school_profiles row yet (the same gap behind the "schools showing
  // inactive" issue from before), .update() silently affects zero rows and
  // the new limit is never actually saved, which is exactly why this looked
  // "stuck." .upsert() creates the row if it's missing instead of no-op'ing.
  const { error } = await supabase
    .from('school_profiles')
    .upsert({
      school_id: schoolId,
      custom_subjects,
    }, { onConflict: 'school_id' });

  if (error) throw error;

  try {
    _profileCache = null;
    invalidateCache(`profile_${schoolId}`);
    invalidateCache(`school_profile_${schoolId}`);
    window.dispatchEvent(new Event('schoolProfileChanged'));
  } catch (e) {}

  await logPlatformActivity('LIMITS_UPDATE', `School ${schoolId} limits updated to ${numStudents} students, ${numStaff} staff seats.`, schoolId);
}

export async function deactivateSchool(schoolId, reason = null) {
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: licenseData, error: licenseReadError } = await supabase.from('school_profiles')
    .select('school_id, license_type').eq('school_id', schoolId).maybeSingle();
  if (licenseReadError) throw licenseReadError;

  const { error: e0 } = await supabase.from('schools')
    .update({ status: 'Inactive' })
    .eq('id', schoolId);
  if (e0) throw e0;

  const profileUpdate = {
    school_id: schoolId,
    subscription_status: 'Inactive',
    subscription_expiry: pastDate,
    status_notes: reason,
  };
  if (String(licenseData?.license_type || '').toLowerCase() === 'perpetual') {
    profileUpdate.subscription_status = 'Suspended';
    profileUpdate.license_status = 'suspended';
  }

  const profileWrite = licenseData
    ? supabase.from('school_profiles').update(profileUpdate).eq('school_id', schoolId)
    : supabase.from('school_profiles').upsert(profileUpdate, { onConflict: 'school_id' });
  const { error: e1 } = await profileWrite;
  if (e1) throw e1;

  const { error: e2 } = await supabase.from('school_features')
    .update({ expires_at: pastDate }).eq('school_id', schoolId);
  if (e2) console.warn('DeactivateSchool: Failed to expire features', e2);

  invalidateFeatureCache(schoolId);
  invalidateCache(`profile_${schoolId}`);
  window.dispatchEvent(new Event('schoolProfileChanged'));
  await logPlatformActivity('DEACTIVATION', `School ${schoolId} deactivated. Reason: ${reason || 'Not specified'}`, schoolId);
}

export async function restoreSchool(schoolId, monthsToAdd = 4, notes = null) {
  const { data: profileData } = await supabase.from('school_profiles')
    .select('subscription_expiry, license_type, license_status, license_feature_keys').eq('school_id', schoolId).maybeSingle();

  if (String(profileData?.license_type || '').toLowerCase() === 'perpetual') {
    if (String(profileData?.license_status || '').toLowerCase() === 'active') {
      const { data: workspace, error: workspaceError } = await supabase.from('schools')
        .select('status').eq('id', schoolId).maybeSingle();
      if (workspaceError) throw workspaceError;
      if (String(workspace?.status || '').toLowerCase() === 'active') return;
    }
    if (String(profileData?.license_status || '').toLowerCase() !== 'suspended') {
      throw new Error('This perpetual licence is not suspended. Only a suspended perpetual licence can be restored here.');
    }

    const featureKeys = Array.isArray(profileData?.license_feature_keys)
      ? profileData.license_feature_keys.filter((key) => typeof key === 'string')
      : [];
    if (!featureKeys.length) throw new Error('The stored perpetual licence feature snapshot is missing. Contact Termly support before restoring access.');

    const { error: schoolError } = await supabase.from('schools')
      .update({ status: 'Active' }).eq('id', schoolId);
    if (schoolError) throw schoolError;

    const { error: profileError } = await supabase.from('school_profiles')
      .update({
        license_status: 'active',
        subscription_status: 'Active',
        subscription_expiry: null,
        status_notes: notes,
      }).eq('school_id', schoolId);
    if (profileError) throw profileError;

    if (featureKeys.length) {
      const { error: featureError } = await supabase.from('school_features')
        .update({ expires_at: null, updated_at: new Date().toISOString() })
        .eq('school_id', schoolId)
        .eq('is_enabled', true)
        .in('feature_key', featureKeys);
      if (featureError) throw featureError;
    }

    invalidateFeatureCache(schoolId);
    invalidateCache(`profile_${schoolId}`);
    window.dispatchEvent(new Event('schoolProfileChanged'));
    await logPlatformActivity('RESTORATION', `Perpetual Termly licence restored for school ${schoolId}`, schoolId);
    return;
  }

  let expiry = new Date();
  if (profileData?.subscription_expiry) {
    const currentExpiry = new Date(profileData.subscription_expiry);
    if (currentExpiry > expiry) expiry = currentExpiry;
  }
  expiry.setMonth(expiry.getMonth() + monthsToAdd);

  const { error: e0 } = await supabase.from('schools')
    .update({ status: 'Active' })
    .eq('id', schoolId);
  if (e0) throw e0;

  const { error } = await supabase.from('school_profiles')
    .upsert({ school_id: schoolId, subscription_status: 'Active', subscription_expiry: expiry.toISOString(), status_notes: notes }, { onConflict: 'school_id' });
  if (error) throw error;

  invalidateFeatureCache(schoolId);
  invalidateCache(`profile_${schoolId}`);
  window.dispatchEvent(new Event('schoolProfileChanged'));
  await logPlatformActivity('RESTORATION', `School ${schoolId} restored for ${monthsToAdd} months`, schoolId);
}


export async function deleteSchool(schoolId) {
  mutationGuard('deleteSchool');
  // Delete child data first
  const tables = ['teacher_assignments', 'class_streams', 'subject_assignments', 'core_competencies',
    'cbc_assessments', 'attendance', 'marks', 'fees', 'students', 'teachers', 'school_features', 'school_profiles'];
  
  await Promise.all(tables.map(t => supabase.from(t).delete().eq('school_id', schoolId)));
  
  const { error } = await supabase.from('schools').delete().eq('id', schoolId);
  if (error) throw error;
  await logPlatformActivity('SCHOOL_DELETED', `School ${schoolId} permanently deleted`, schoolId);
}

export async function wipeAllNonAdminSchools() {
  mutationGuard('wipeAllNonAdminSchools');
  const { data: schools } = await supabase.from('schools').select('id, plan');
  const toDelete = (schools || []).filter(s => s.plan !== 'Platform Admin');
  await Promise.all(toDelete.map(s => deleteSchool(s.id)));
  return toDelete.length;
}

export async function adminUpdateSchoolProfile(schoolId, updates) {
  mutationGuard('adminUpdateSchoolProfile');
  const { error } = await supabase
    .from('school_profiles')
    .upsert({ school_id: schoolId, ...updates }, { onConflict: 'school_id' });
  if (error) throw error;
  await logPlatformActivity('ADMIN_UPDATE_PROFILE', `Updated profile for school ${schoolId}`, schoolId);
}

// ============= USERS =============





// ============= DATA OPERATIONS =============

export async function resetAllData() {
  if (!_currentSchoolId) return;
  const tables = ['teacher_assignments', 'class_streams', 'subject_assignments', 'core_competencies',
    'cbc_assessments', 'attendance', 'marks', 'fees', 'students', 'teachers'];
  await Promise.all(tables.map(t => supabase.from(t).delete().eq('school_id', _currentSchoolId)));
}

export async function exportData(selectedModules = null) {
  const profile = await getSchoolProfile();
  const schoolId = profile?.school_id || profile?.id || _currentSchoolId;

  const isAll = !selectedModules || Object.values(selectedModules).every(v => v);

  const fetchIf = async (key, queryPromise) => {
    if (!(isAll || selectedModules?.[key])) return { data: null };
    const { data, error } = await queryPromise;
    if (error) throw new Error('Backup export failed for ' + key + ': ' + error.message);
    return { data: data || [] };
  };

  // Fetch selected datasets for this school
  const [
    studentsRes, teachersRes, feesRes, paymentsRes, marksRes, timetableRes, noticesRes,
    periodsRes, classesRes, streamsRes, subjectsRes, teacherSubjectRes, examsRes,
    examPapersRes, legacyMarksRes, cbcRes, competenciesRes, attendanceRes,
    teacherAssignmentsRes, subjectAssignmentsRes, lmsAssignmentsRes, lmsSubmissionsRes
  ] = await Promise.all([
    fetchIf('students', supabase.from('students').select('*').eq('school_id', schoolId)),
    fetchIf('teachers', supabase.from('teachers').select('*').eq('school_id', schoolId)),
    fetchIf('fees', supabase.from('fees').select('*').eq('school_id', schoolId)),
    fetchIf('payments', supabase.from('fee_payments').select('*').eq('school_id', schoolId)),
    fetchIf('marks', supabase.from('exam_marks').select('*').eq('school_id', schoolId)),
    fetchIf('timetable', supabase.from('timetable_slots').select('*').eq('school_id', schoolId)),
    fetchIf('announcements', supabase.from('announcements').select('*').eq('school_id', schoolId)),
    fetchIf('students', supabase.from('academic_periods').select('*').eq('school_id', schoolId)),
    fetchIf('students', supabase.from('classes').select('*').eq('school_id', schoolId)),
    fetchIf('students', supabase.from('class_streams').select('*').eq('school_id', schoolId)),
    fetchIf('timetable', supabase.from('tt_subjects').select('*').eq('school_id', schoolId)),
    fetchIf('timetable', supabase.from('tt_teacher_subjects').select('*').eq('school_id', schoolId)),
    fetchIf('marks', supabase.from('exams').select('*').eq('school_id', schoolId)),
    fetchIf('marks', supabase.from('exam_papers').select('*').eq('school_id', schoolId)),
    fetchIf('marks', supabase.from('marks').select('*').eq('school_id', schoolId)),
    fetchIf('marks', supabase.from('cbc_assessments').select('*').eq('school_id', schoolId)),
    fetchIf('marks', supabase.from('core_competencies').select('*').eq('school_id', schoolId)),
    fetchIf('students', supabase.from('attendance').select('*').eq('school_id', schoolId)),
    fetchIf('timetable', supabase.from('teacher_assignments').select('*').eq('school_id', schoolId)),
    fetchIf('timetable', supabase.from('subject_assignments').select('*').eq('school_id', schoolId)),
    fetchIf('students', supabase.from('el_assignments').select('*').eq('school_id', schoolId)),
    fetchIf('students', supabase.from('el_submissions').select('*').eq('school_id', schoolId))
  ]);

  const fullBackup = {
    exportVersion: '3.0',
    exportDate: new Date().toISOString(),
    backupType: 'selected-module-data-export',
    completeBackup: false,
    restoreSupported: false,
    coverage: 'Operational datasets selected in the export dialog. Identity-provider users, private storage objects, secrets, and some auxiliary data are not included.',
    warning: 'This export is not a complete or restorable school backup. Restore remains disabled until a transactional restore workflow is implemented and tested.',
    schoolProfile: profile,
    ...(studentsRes?.data !== null && { students: studentsRes.data || [] }),
    ...(teachersRes?.data !== null && { teachers: teachersRes.data || [] }),
    ...(feesRes?.data !== null && { fees: feesRes.data || [] }),
    ...(paymentsRes?.data !== null && { feePayments: paymentsRes.data || [] }),
    ...(marksRes?.data !== null && { examMarks: marksRes.data || [] }),
    ...(timetableRes?.data !== null && { timetableSlots: timetableRes.data || [] }),
    ...(noticesRes?.data !== null && { announcements: noticesRes.data || [] }),
    ...(periodsRes?.data !== null && { academicPeriods: periodsRes.data || [] }),
    ...(classesRes?.data !== null && { classes: classesRes.data || [] }),
    ...(streamsRes?.data !== null && { classStreams: streamsRes.data || [] }),
    ...(subjectsRes?.data !== null && { subjects: subjectsRes.data || [] }),
    ...(teacherSubjectRes?.data !== null && { teacherSubjectAssignments: teacherSubjectRes.data || [] }),
    ...(examsRes?.data !== null && { exams: examsRes.data || [] }),
    ...(examPapersRes?.data !== null && { examPapers: examPapersRes.data || [] }),
    ...(legacyMarksRes?.data !== null && { legacyMarks: legacyMarksRes.data || [] }),
    ...(cbcRes?.data !== null && { cbcAssessments: cbcRes.data || [] }),
    ...(competenciesRes?.data !== null && { coreCompetencies: competenciesRes.data || [] }),
    ...(attendanceRes?.data !== null && { attendance: attendanceRes.data || [] }),
    ...(teacherAssignmentsRes?.data !== null && { teacherAssignments: teacherAssignmentsRes.data || [] }),
    ...(subjectAssignmentsRes?.data !== null && { subjectAssignments: subjectAssignmentsRes.data || [] }),
    ...(lmsAssignmentsRes?.data !== null && { lmsAssignments: lmsAssignmentsRes.data || [] }),
    ...(lmsSubmissionsRes?.data !== null && { lmsSubmissions: lmsSubmissionsRes.data || [] })
  };

  const jsonStr = JSON.stringify(fullBackup, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  const safeName = (profile?.schoolName || 'School').replace(/[^a-zA-Z0-9]/g, '_');
  link.download = `Termly_Export_${safeName}_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function importData(jsonDataStr) {
  throw new Error('Cloud restore is disabled. Termly currently exports selected data only and does not yet provide a validated, transactional restore workflow. Do not treat the export as a complete backup.');
}



// ============= PLATFORM ADMIN =============

export async function getPlatformAdmins() {
  const { data, error } = await supabase.from('platform_admins').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addPlatformAdmin(email, role = 'admin') {
  mutationGuard('addPlatformAdmin');
  const { error } = await supabase.from('platform_admins').insert({ email, added_by: 'system' });
  if (error) throw error;
  await logPlatformActivity('PLATFORM_ADMIN_ADDED', `Added: ${email}`);
}

export async function removePlatformAdmin(email) {
  mutationGuard('removePlatformAdmin');
  const { error } = await supabase.from('platform_admins').delete().eq('email', email);
  if (error) throw error;
  await logPlatformActivity('PLATFORM_ADMIN_REMOVED', `Removed: ${email}`);
}

export async function getPlatformActivities(limit = 50) {
  const { data, error } = await supabase.from('platform_activity')
    .select('id, type, description, actor_email, created_at, schools(name)')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getGlobalAuditLogs(limit = 100) {
  const { data, error } = await supabase.from('audit_logs')
    .select('*, schools(name)')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

// ============= SAAS / BLOG / PARTNERS (Public pages) =============

export async function getSaasBlogPosts() {
  const { data, error } = await supabase.from('blog_posts').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getFeaturedPartners() {
  const { data, error } = await supabase.from('partners').select('*').eq('featured', true);
  if (error) throw error;
  return data || [];
}

export async function registerSchool(schoolData) {
  const { data, error } = await supabase.rpc('register_school', schoolData);
  if (error) throw error;
  return data;
}



// ============= SYNC EXPORTED TO syncStore.js =============

// ============= MIGRATIONS & INVITATIONS =============

export async function sendSchoolInvite(email) {
  const { data, error } = await supabase.rpc('send_school_invite', { p_email: email });
  if (error) throw error;
  return data;
}

export async function getSchemaStatus() {
  const { data, error } = await supabase.rpc('get_schema_status');
  if (error) throw error;
  return data;
}

export async function runSchemaMigration(sql) {
  throw new Error("Direct client-side schema migrations are disabled for security. Please use the Supabase CLI.");
}

// ============= PRINT HELPERS =============

export async function getPrintHeader(title = '', profileOverride = null) {
  const profile = profileOverride || (await getSchoolProfile()) || {};
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const candidateLogo = profile.logo || profile.logoUrl || '';
  const safeLogo = /^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/i.test(candidateLogo) ? candidateLogo : '';
  const logoMarkup = safeLogo
    ? `<img src="${escapeHtml(safeLogo)}" alt="School logo" style="width:76px;height:76px;object-fit:contain;display:block;flex:0 0 76px;" />`
    : '';

  return '<div style="text-align:center;margin-bottom:20px;border-bottom:2px solid #333;padding-bottom:10px;">' +
         `<div style="display:flex;align-items:center;justify-content:center;gap:16px;min-height:76px;">${logoMarkup}<div>` +
         `<h1 style="margin:0;font-size:24px;color:#1e3a8a;">${escapeHtml(profile.schoolName || 'Termly School')}</h1>` +
         (profile.motto ? `<p style="margin:5px 0;font-style:italic;">${escapeHtml(profile.motto)}</p>` : '') +
         '</div></div>' +
         `<p style="margin:5px 0;font-size:14px;">${escapeHtml([profile.address, profile.phone, profile.email].filter(Boolean).join(' | '))}</p>` +
         `<h2 style="margin:15px 0 0;font-size:18px;text-transform:uppercase;">${escapeHtml(title)}</h2>` +
         '</div>';
}

export async function getPrintFooter() {
  return '<div style="margin-top: 40px; border-top: 1px solid #ccc; padding-top: 10px; font-size: 12px; color: #666; text-align: center;">' +
         'Printed from Termly School Management System | ' + new Date().toLocaleString() +
         '</div>';
}

// ============= PORTAL ACCESS =============

export async function getPortalAccessSettings() {
  const profile = await getSchoolProfile();
  return profile.portal_access || { student: true, parent: true, staff: true };
}

export async function updatePortalAccessSettings(settings) {
  return await saveSchoolProfile({ portal_access: settings });
}

// ============= PUBLIC / PORTAL =============

export async function searchPublicSchools(query) {
  if (!query || query.trim().length < 2) return [];
  const { data, error } = await supabase.rpc('search_public_schools', { search_query: query.trim() });
  if (error) throw error;
  return data || [];
}

export async function getSchoolByCode(code) {
  const { data, error } = await supabase.from('schools')
    .select('id, name, school_code, location, school_type, publicly_listed')
    .eq('school_code', code).ilike('status', 'active').maybeSingle();
  if (error) throw error;
  return data;
}

export async function getPortalActivity(limit = 10) {
  const { data, error } = await supabase.from('portal_activity_log')
    .select('*').eq('school_id', _currentSchoolId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(item => ({
    ...item,
    date: new Date(item.created_at).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  }));
}

export async function logPortalActivity(action, targetType, metadata = {}) {
  try {
    const { error } = await supabase.from('portal_logs').insert({
      school_id: _currentSchoolId, action, target_type: targetType, metadata
    });
    if (error) console.warn('logPortalActivity error:', error);
  } catch (e) { console.warn('logPortalActivity exception:', e); }
}

// ============= ALIASES =============
export const initStore = initPortalStore;
export const getPlatformSchoolProfiles = getAllSchools;
export const getPlatformUsageStats = getPlatformStats;
export const getSchoolsForPortalSearch = searchPublicSchools;