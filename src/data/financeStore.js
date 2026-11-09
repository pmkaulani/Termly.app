import { supabase } from '../lib/supabase';
import { db, queueChange } from './offlineStore';
import { 
  _currentSchoolId, _currentPeriodId, _currentAuthUser, mutationGuard, cachedQuery, invalidateCache, getCurrentSchoolId, getCurrentPeriodId, logAuditEvent, logPlatformActivity, getSchoolProfile
} from './coreStore';
import { withRetry } from '../utils/resilience';
import { getStudents } from './studentStore';
import { TERM_FEE } from './seedData';
import { queueSMS } from './smsStore';


// ==========================================
// FINANCE & FEES (Extracted from store.js)
// ==========================================

export async function getFees(studentId = null) {
  if (!_currentSchoolId) return studentId ? null : {};

  // Portal mode: the RPC is the single source of truth now (SECURITY
  // DEFINER, scoped by school_id + the school's active academic
  // period — see 20260717_unify_portal_fee_and_results_visibility.sql).
  // No more silent fallback to an un-scoped direct query.
  if (!_currentAuthUser && studentId) {
    const { data, error } = await supabase.rpc('portal_get_student_fee_summary', {
      p_student_id: studentId,
      p_school_id: _currentSchoolId,
    });

    if (error) {
      console.error('[Portal] Fee summary RPC failed:', error.message);
      throw error;
    }

    const payments = (Array.isArray(data?.payments) ? data.payments : []).map(p => ({
      id: p.id,
      amount: Number(p.amount || 0),
      date: p.date,
      method: p.method || 'Payment',
      reference: p.reference || '',
      status: p.status || 'Confirmed',
    }));

    return {
      totalFee: Number(data?.total_fee || 0),
      billed: Number(data?.total_fee || 0),
      paid: Number(data?.paid || 0),
      balance: Number(data?.balance || 0),
      payments,
      _feeId: data?.fee_id || null,
      periodId: data?.period_id || null,
      noRecordForCurrentPeriod: !!data?.no_record_for_current_period,
    };
  }

  // Admin/staff mode: unchanged — already scoped to school_id + the
  // currently selected academic period.
  const cacheKey = `fees_${_currentSchoolId}_${_currentPeriodId}`;
  return cachedQuery(cacheKey, async () => {
    const { data, error } = await withRetry(() => supabase
      .from('fees')
      .select('id, student_id, total_fee, paid, balance, period_id, school_id, fee_payments(id, amount, date, method, reference)')
      .eq('school_id', _currentSchoolId)
      .eq('period_id', _currentPeriodId));
    if (error) throw error;

    const fees = {};
    (data || []).forEach(row => {
      fees[row.student_id] = {
        totalFee: Number(row.total_fee),
        paid: Number(row.paid),
        balance: Number(row.balance),
        payments: (row.fee_payments || []).map(p => ({
          id: p.id,
          amount: Number(p.amount),
          date: p.date,
          method: p.method,
          reference: p.reference,
        })),
        _feeId: row.id,
        periodId: row.period_id,
      };
    });

    Object.keys(fees).forEach(sid => {
      if (fees[sid].totalFee === 0) {
        import('./academicsStore.js').then(m => m.reconcileStudentFee(sid, fees[sid])).catch(console.error);
      }
    });

    return fees;
  });
}

export async function recordPayment(studentId, amount, method, reference) {
  const numAmount = Math.max(0, Number(amount) || 0);
  if (numAmount === 0) throw new Error('Payment amount must be greater than zero.');
  
  const sanitizedRef = (reference || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const fees = await getFees();
  let feeRecord = fees[studentId];

  // 1. If no fee record exists, we must create one. 
  // But we MUST have a configuration set first.
  if (!feeRecord) {
    const student = (await getStudents()).find(s => s.id === studentId);
    const profile = await getSchoolProfile();
    const finalFee = getCalculatedTotalFee(student, profile);

    if (finalFee === null) {
      throw new Error(`Fee structure not configured for ${student?.class || 'this class'}. Please set fees in Settings before recording payments.`);
    }

    const { data: newFee, error: feeErr } = await supabase
      .from('fees')
      .insert({ 
        school_id: _currentSchoolId, 
        student_id: studentId, 
        period_id: _currentPeriodId,
        total_fee: finalFee, 
        paid: 0, 
        balance: finalFee 
      })
      .select()
      .single();
    if (feeErr) throw feeErr;
  }

  // 1. Fetch current fee record and reconcile it with latest config
  const { data: currentFee, error: fetchErr } = await supabase
    .from('fees')
    .select('id, total_fee, paid, balance')
    .eq('school_id', _currentSchoolId)
    .eq('student_id', studentId)
    .eq('period_id', _currentPeriodId)
    .single();

  if (fetchErr) throw fetchErr;

  // 1.5 Reconcile the total_fee and balance before processing payment
  const { reconcileStudentFee } = await import('./academicsStore.js');
  const reconciled = await reconcileStudentFee(studentId, {
    totalFee: Number(currentFee.total_fee),
    paid: Number(currentFee.paid),
    balance: Number(currentFee.balance),
    _feeId: currentFee.id
  });

  const targetFeeId = currentFee.id;
  const upToDateTotalFee = Number(reconciled?.totalFee || currentFee.total_fee);
  const upToDatePaid = Number(reconciled?.paid || currentFee.paid);

  // Missing RPC fallback: Perform the operation client-side
  const amountNum = Number(amount);
  const { data: result, error: paymentError } = await supabase.rpc('record_fee_payment_atomic', {
    p_school_id: _currentSchoolId,
    p_period_id: _currentPeriodId,
    p_student_id: studentId,
    p_amount: amountNum,
    p_method: method || 'Cash',
    p_reference: sanitizedRef || null,
  });
  if (paymentError) throw paymentError;
  if (!result?.success || !result?.payment?.id) throw new Error('Payment transaction returned an invalid result.');
  const paymentRecord = result.payment;
  const paymentDate = paymentRecord.date || new Date().toISOString();

  await logAuditEvent('payment_recorded', 'fee_payments', paymentRecord.id, { 
    student_id: studentId, 
    amount: amountNum, 
    method: method || 'Cash',
    reference: sanitizedRef
  });

  // 3.5 Invalidate caches so the UI sees the new balance immediately
  invalidateCache(`fees_${_currentSchoolId}_${_currentPeriodId}`);
  invalidateCache(`summary_${_currentSchoolId}_${_currentPeriodId}`);

  // 4. Queue Payment Confirmation SMS
  const student = (await getStudents()).find(s => s.id === studentId);
  if (student && student.parent_phone && !result.duplicate) {
    try {
      await queueSMS(
        student.parent_phone,
        `Termly: We have received KSh ${amount.toLocaleString()} for ${student.name}. Balance: KSh ${Number(result.balance || 0).toLocaleString()}. Ref: ${reference || 'N/A'}`,
        'fee_payment'
      );
    } catch (smsError) {
      // The fee transaction is already committed; do not report it as failed because of an optional SMS side-effect.
      console.warn('Payment saved, but confirmation SMS could not be dispatched:', smsError?.message || smsError);
    }
  }
  
  return { 
    id: paymentRecord.id,
    amount: Number(amount),
    method,
    reference: sanitizedRef,
    date: paymentDate
  };
}

export async function getPayments() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('payments')
    .select('id, amount, transaction_code, notes, status, created_at, school_id')
    .eq('school_id', _currentSchoolId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getFeeSummary(preFetchedFees = null, preFetchedStudents = null, preFetchedProfile = null) {
  const fees = preFetchedFees || await getFees();
  const students = preFetchedStudents || await getStudents();
  const profile = preFetchedProfile || await getSchoolProfile();
  const gradeFees = profile.gradeFees || {};
  
  let termName = null;
  try {
    const { getCurrentPeriodDetails } = await import('./academicsStore');
    const period = await getCurrentPeriodDetails();
    termName = period?.term || null;
  } catch (e) { /* ignore */ }
  
  let totalExpected = 0, totalCollected = 0, totalOutstanding = 0;
  let fullyPaid = 0, partialPaid = 0, unpaid = 0;
  students.forEach(s => {
    let defaultFee = TERM_FEE;
    const cf = gradeFees[s.class];
    if (cf) {
      if (typeof cf === 'object') {
        const resType = (s.residenceType || s.residence_type || 'day').toLowerCase();
        if (termName && cf[termName] && typeof cf[termName] === 'object') {
          defaultFee = Number(cf[termName][resType]) || Number(cf[termName].day) || TERM_FEE;
        } else {
          defaultFee = Number(cf[resType]) || Number(cf.day) || TERM_FEE;
        }
      } else {
        defaultFee = Number(cf) || TERM_FEE;
      }
    }
    const f = fees[s.id] || { totalFee: defaultFee, paid: 0, balance: defaultFee };
    totalExpected += (Number(f.totalFee) || 0);
    totalCollected += (Number(f.paid) || 0);
    totalOutstanding += (Number(f.balance) || 0);
    if (f.balance <= 0) fullyPaid++;
    else if (f.paid > 0) partialPaid++;
    else unpaid++;
  });
  return { totalExpected, totalCollected, totalOutstanding, fullyPaid, partialPaid, unpaid };
}

export async function processMpesaPayment(callbackData) {
  const { 
    SchoolId, 
    Amount, 
    MpesaReceiptNumber, 
    TransactionDate, 
    PhoneNumber, 
    BillRefNumber // This usually contains the Admission No
  } = callbackData;

  // 1. Log the raw callback first
  const { data: log, error: logErr } = await supabase
    .from('mpesa_callbacks')
    .insert({
      school_id: SchoolId,
      amount: Amount,
      mpesa_receipt_number: MpesaReceiptNumber,
      transaction_date: TransactionDate,
      phone_number: PhoneNumber,
      bill_ref_number: BillRefNumber,
      raw_payload: callbackData,
      status: 'pending'
    })
    .select()
    .single();

  if (logErr) throw logErr;

  try {
    // 2. Try to find the student by Admission Number
    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id, name, parent_phone, class')
      .eq('school_id', SchoolId)
      .ilike('adm_no', BillRefNumber)
      .maybeSingle();

    if (!student) {
      // Mark as orphaned for manual reconciliation
      await supabase.from('mpesa_callbacks').update({ status: 'orphaned' }).eq('id', log.id).eq('school_id', _currentSchoolId);
      return { status: 'orphaned', message: 'Student not found' };
    }

    // 3. Record the payment using the RPC
    await recordPayment(student.id, Amount, 'M-Pesa', MpesaReceiptNumber);

    // 4. Success - Update callback status
    await supabase.from('mpesa_callbacks').update({ 
      status: 'processed', 
      student_id: student.id 
    }).eq('id', log.id).eq('school_id', _currentSchoolId);

    return { status: 'success', student: student.name };
  } catch (err) {
    await supabase.from('mpesa_callbacks').update({ status: 'failed', result_desc: err.message }).eq('id', log.id).eq('school_id', _currentSchoolId);
    throw err;
  }
}

export async function getMpesaLogs() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('mpesa_callbacks')
    .select('*, students(name, class, adm_no)')
    .eq('school_id', _currentSchoolId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function testMpesaConnection() {
  const { data, error } = await supabase.functions.invoke('mpesa-stk-push', {
    body: { action: 'test_connection', payload: {} },
  });
  if (error) return { success: false, message: error.message || 'Daraja connection test failed.' };
  return data || { success: false, message: 'Daraja returned no test result.' };
}

export async function getOrphanedMpesaCallbacks() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('mpesa_callbacks')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .in('status', ['pending', 'orphaned', 'failed'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function autoProcessMpesaCallbacks() {
  if (!_currentSchoolId || _autoProcessing) return { processed: 0, orphaned: 0 };
  _autoProcessing = true;
  window.dispatchEvent(new CustomEvent('mpesaAutoProcessStart'));

  let processed = 0, orphaned = 0;

  try {
    // 1. Fetch only 'pending' callbacks (not already orphaned/failed)
    const { data: pending, error: fetchErr } = await supabase
      .from('mpesa_callbacks')
      .select('*')
      .eq('school_id', _currentSchoolId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (fetchErr || !pending || pending.length === 0) {
      return { processed: 0, orphaned: 0 };
    }

    // 2. Fetch all students for this school (for matching)
    const { data: allStudents, error: studErr } = await supabase
      .from('students')
      .select('id, adm_no, name')
      .eq('school_id', _currentSchoolId);

    if (studErr || !allStudents) {
      return { processed: 0, orphaned: 0 };
    }

    // 3. Build a lookup map: normalised admission number → student id
    const admLookup = {};
    for (const s of allStudents) {
      if (s.adm_no) {
        admLookup[s.adm_no.trim().toUpperCase()] = s.id;
      }
    }

    // 4. Process pending callbacks concurrently instead of sequential N+1
    const promises = pending.map(async (cb) => {
      const ref = (cb.bill_ref_number || '').trim().toUpperCase();
      const matchedStudentId = admLookup[ref];

      if (matchedStudentId) {
        // Auto-reconcile
        try {
          await reconcileMpesaPayment(cb.id, matchedStudentId);
          processed++;
        } catch (e) {
          console.error(`Auto-reconcile failed for ${cb.mpesa_receipt_number}:`, e.message);
        }
      } else {
        // Mark as orphaned for manual review
        await supabase
          .from('mpesa_callbacks')
          .update({ status: 'orphaned' })
          .eq('id', cb.id)
          .eq('school_id', _currentSchoolId);
        orphaned++;
      }
    });
    
    await Promise.all(promises);

    if (processed > 0) {
      await logPlatformActivity(
        'MPESA_AUTO_RECONCILED',
        `Auto-reconciled ${processed} payment(s). ${orphaned} orphaned for manual review.`
      );
    }
  } catch (e) {
    console.error('Auto-process M-Pesa error:', e);
  } finally {
    _autoProcessing = false;
    window.dispatchEvent(new CustomEvent('mpesaAutoProcessEnd', {
      detail: { processed, orphaned }
    }));
  }

  return { processed, orphaned };
}

export async function simulateMpesaCallback({ amount, phone, admNo, receiptNumber }) {
  if (!_currentSchoolId) throw new Error('No school context.');

  const receipt = receiptNumber || `SIM${Date.now()}`;
  const { error } = await supabase.from('mpesa_callbacks').insert([{
    school_id: _currentSchoolId,
    mpesa_receipt_number: receipt,
    amount: Number(amount),
    phone_number: phone || '2547XXXXXXXX',
    bill_ref_number: admNo,
    transaction_date: new Date().toISOString(),
    status: 'pending',
    created_at: new Date().toISOString()
  }]);

  if (error) throw error;

  // Immediately trigger auto-processing
  const result = await autoProcessMpesaCallbacks();

  return { receipt, ...result };
}

export async function reconcileMpesaPayment(callbackId, studentId) {
  const { data: callback, error: cbError } = await supabase
    .from('mpesa_callbacks')
    .select('*')
    .eq('id', callbackId)
    .eq('school_id', _currentSchoolId)
    .single();
  
  if (cbError) throw cbError;
  if (!callback) throw new Error("Payment record not found.");

  // 1. Update the callback status
  const { error: updateError } = await supabase
    .from('mpesa_callbacks')
    .update({ 
      student_id: studentId,
      status: 'processed'
    })
    .eq('id', callbackId)
    .eq('school_id', _currentSchoolId);
  
  if (updateError) throw updateError;

  // 2. Add to student fees
  const { data: fee, error: feeError } = await supabase
    .from('fees')
    .select('*')
    .eq('student_id', studentId)
    .eq('period_id', _currentPeriodId)
    .single();
  
  if (!feeError && fee) {
    const newPaid = Number(fee.paid) + Number(callback.amount);
    const newBal = Number(fee.total_fee) - newPaid;

    await supabase
      .from('fees')
      .update({
        paid: newPaid,
        balance: newBal,
        updated_at: new Date().toISOString()
      })
      .eq('id', fee.id);
  }

  // 3. Log activity
  await logPlatformActivity('PAYMENT_RECONCILED', `Reconciled payment ${callback.mpesa_receipt_number} to student ID ${studentId}`);

  return { success: true };
}



export async function submitPayment(amount, transactionCode, notes = '') {
  mutationGuard('submitPayment');
  if (!_currentSchoolId) throw new Error('No school context');
  const { error } = await supabase
    .from('payments')
    .insert([{
      school_id: _currentSchoolId,
      amount,
      transaction_code: transactionCode,
      notes,
      status: 'Pending'
    }]);
  if (error) throw error;

  // Update last payment status in school profile
  const { error: profileError } = await supabase
    .from('school_profiles')
    .upsert({ school_id: _currentSchoolId, last_payment_status: 'pending' }, { onConflict: 'school_id' });
  if (profileError) throw profileError;

  await logPlatformActivity('PAYMENT_SUBMIT', `New payment of KSh ${amount.toLocaleString()} submitted via code: ${transactionCode}`, _currentSchoolId);
}

export async function getAllPendingPayments() {
  const { data, error } = await supabase
    .from('payments')
    .select('id, amount, transaction_code, notes, status, created_at, school_id, school_profiles(school_name)')
    .eq('status', 'Pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getAllPayments() {
  const { data, error } = await supabase
    .from('payments')
    .select('id, amount, transaction_code, notes, status, created_at, school_id, school_profiles(school_name, subscription_plan)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function approvePayment(paymentId, schoolId, monthsToAdd = 4) {
  mutationGuard('approvePayment');
  // 1. Update payment status
  const { error: pError } = await supabase
    .from('payments')
    .update({ status: 'Approved' })
    .eq('id', paymentId);
  if (pError) throw pError;

  // 1.5 Calculate new expiry
  const { data: profileData } = await supabase
    .from('school_profiles')
    .select('subscription_expiry')
    .eq('school_id', schoolId)
    .single();

  let expiry = new Date();
  if (profileData && profileData.subscription_expiry) {
    const currentExpiry = new Date(profileData.subscription_expiry);
    if (currentExpiry > expiry) {
      expiry = currentExpiry;
    }
  }
  expiry.setMonth(expiry.getMonth() + monthsToAdd);

  // 2. Update school profile
  const { error: sError } = await supabase
    .from('school_profiles')
    .upsert({ 
      school_id: schoolId,
      subscription_status: 'Active',
      subscription_expiry: expiry.toISOString(),
      last_payment_status: 'approved'
    }, { onConflict: 'school_id' });
  if (sError) throw sError;

  // 3. Sync status to schools table
  const { error: masterErr } = await supabase
    .from('schools')
    .update({ status: 'Active' })
    .eq('id', schoolId);
  if (masterErr) console.warn('Failed to sync master school status:', masterErr);

  await logPlatformActivity('PAYMENT_APPROVE', `Approved payment for ${schoolId}`, schoolId);
}

export async function rejectPayment(paymentId, schoolId, reason = 'Verification failed') {
  const { error } = await supabase
    .from('payments')
    .update({ status: 'Rejected', notes: reason })
    .eq('id', paymentId);
  if (error) throw error;

  const { error: profileError } = await supabase
    .from('school_profiles')
    .upsert({ school_id: schoolId, last_payment_status: 'rejected' }, { onConflict: 'school_id' });
  if (profileError) throw profileError;

  await logPlatformActivity('PAYMENT_REJECT', `Rejected payment for ${schoolId}: ${reason}`, schoolId);
}

export async function cancelSubscription() {
  if (!_currentSchoolId) return;
  const { error } = await supabase
    .from('school_profiles')
    .upsert({ school_id: _currentSchoolId, subscription_status: 'Deactivated' }, { onConflict: 'school_id' });
  if (error) throw error;
  await logPlatformActivity('SUBSCRIPTION_CANCEL', `School canceled subscription: ${_currentSchoolId}`, _currentSchoolId);
}

export async function updateSchoolPlan(schoolId, plan) {
  // 1. Update Profile (Detailed data - used by School Portal)
  const { error: pError } = await supabase
    .from('school_profiles')
    .upsert({ school_id: schoolId, subscription_plan: plan }, { onConflict: 'school_id' });
  if (pError) throw pError;

  // 2. Update Schools Master (Summarized data - used by Super Admin list)
  const { error: sError } = await supabase
    .from('schools')
    .update({ plan: plan })
    .eq('id', schoolId);
  // We log warning but don't strictly fail if the master sync fails, though it should succeed
  if (sError) console.warn('Sync to schools table failed:', sError);

  await logPlatformActivity('PLAN_CHANGE', `Admin updated school plan to ${plan}`, schoolId);
}

export async function manualExtendSubscription(schoolId, daysToAdd) {
  const { data: profile, error: getErr } = await supabase
    .from('school_profiles')
    .select('subscription_expiry')
    .eq('school_id', schoolId)
    .single();
  
  if (getErr) throw getErr;

  let baseDate = new Date();
  const currentExpiry = new Date(profile.subscription_expiry);
  if (currentExpiry > baseDate) {
    baseDate = currentExpiry; // If still active, add to the end
  }

  const newExpiry = new Date(baseDate);
  newExpiry.setDate(newExpiry.getDate() + daysToAdd);

  const { error } = await supabase
    .from('school_profiles')
    .upsert({ 
      school_id: schoolId,
      subscription_status: 'Active',
      subscription_expiry: newExpiry.toISOString(),
      last_payment_status: 'manual_extension'
    }, { onConflict: 'school_id' });
  
  if (error) throw error;
  
  await logPlatformActivity('SUBSCRIPTION_EXTEND', `Extended school access by ${daysToAdd} days`, schoolId);
}

export async function simulateMpesaSTKPush(student, amount, phone) {
  // 1. Simulate Network Delay (STK Push pop-up on user's phone)
  await new Promise(resolve => setTimeout(resolve, 2500));

  // 2. Generate generic M-pesa reference
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const mpesaRef = Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join('');

  // 3. Process the actual payment in the ledger
  const payment = await recordPayment(student.id, amount, 'M-Pesa', mpesaRef);

  // 4. Inject into mpesa_logs to simulate Daraja API webhook firing
  const { error: cbErr } = await supabase.from('mpesa_callbacks').insert({
    school_id: _currentSchoolId,
    phone_number: phone,
    amount: amount,
    mpesa_receipt_number: mpesaRef,
    bill_ref_number: student.adm_no || student.admNo || 'DEF',
    status: 'processed',
    student_id: student.id,
    raw_payload: { mocked: true }
  });
  if (cbErr) throw cbErr;

  // 5. Synthesize an automated SMS receipt into the offline communications store
  try {
    const { db } = await import('./offlineStore');
    await db.communications.add({
      type: 'SMS',
      target: 'single',
      message: `Dear Parent, we confirm receipt of Ksh ${amount} via M-Pesa (${mpesaRef}) for ${student.name}. Thank you.`,
      timestamp: new Date().toISOString(),
      user: 'M-Pesa Auto-Bot',
      recipientCount: 1
    });
  } catch (e) {
    console.error('Failed to log mocked SMS to IndexedDB:', e);
  }

  return payment;
}

export async function getTermFinancialSummary() {
  if (!_currentSchoolId || !_currentPeriodId) return null;
  
  const [students, fees] = await Promise.all([
    getStudents(),
    getFees()
  ]);

  let totalExpected = 0;
  let totalCollected = 0;
  let fullyPaidCount = 0;
  let partialPaidCount = 0;
  let unpaidCount = 0;

  students.forEach(s => {
    const f = fees[s.id] || { total_fee: 0, paid: 0, balance: 0 };
    totalExpected += Number(f.total_fee || 0);
    totalCollected += Number(f.paid || 0);
    
    const balance = Number(f.balance || 0);
    if (balance <= 0 && f.total_fee > 0) fullyPaidCount++;
    else if (f.paid > 0) partialPaidCount++;
    else unpaidCount++;
  });

  return {
    totalExpected,
    totalCollected,
    totalOutstanding: totalExpected - totalCollected,
    fullyPaidCount,
    partialPaidCount,
    unpaidCount,
    collectionRate: totalExpected > 0 ? ((totalCollected / totalExpected) * 100).toFixed(1) : 0,
  };
}