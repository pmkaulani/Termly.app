import Dexie from 'dexie';

export const db = new Dexie('TermlyOffline');

// Schema definition
db.version(7).stores({
  students: 'id, school_id, name, adm_no, parent_phone, class, status, residence_type',
  teachers: 'id, school_id, name, pin, phone, on_leave',
  marks: '[period_id+student_id+subject], period_id, student_id, school_id',
  attendance: 'id, date, school_id, class_id',
  communications: '++id, type, target, timestamp, user',
  assignments: '++id, class, stream, subject, title, dueDate, timestamp, teacher',
  submissions: '++id, assignment_id, student_id, student_name, workflow_status, timestamp, [assignment_id+student_id]',
  syncQueue: '++id, type, payload, status, created_at',
  mpesa_transactions: '++id, checkout_id, student_id, amount, status, timestamp',
  sms_queue: '++id, phoneNumber, message, status, retry_count, created_at'
});

// Phase 1: Add grading_drafts table for offline-first teacher grading
db.version(8).stores({
  students: 'id, school_id, name, adm_no, parent_phone, class, status, residence_type',
  teachers: 'id, school_id, name, pin, phone, on_leave',
  marks: '[period_id+student_id+subject], period_id, student_id, school_id',
  attendance: 'id, date, school_id, class_id',
  communications: '++id, type, target, timestamp, user',
  assignments: '++id, class, stream, subject, title, dueDate, timestamp, teacher',
  submissions: '++id, assignment_id, student_id, student_name, workflow_status, timestamp, [assignment_id+student_id]',
  syncQueue: '++id, type, payload, status, created_at',
  mpesa_transactions: '++id, checkout_id, student_id, amount, status, timestamp',
  sms_queue: '++id, phoneNumber, message, status, retry_count, created_at',
  grading_drafts: '++id, exam_paper_id, student_id, teacher_id, [exam_paper_id+student_id], synced'
});

export const syncTypes = {
  ADD_STUDENT: 'ADD_STUDENT',
  UPDATE_STUDENT: 'UPDATE_STUDENT',
  ADD_MARK: 'ADD_MARK',
  UPDATE_MARK: 'UPDATE_MARK',
  UPLOAD_FEE: 'UPLOAD_FEE',
  SYNC_GRADES: 'SYNC_GRADES'
};

/**
 * Queue a change for background synchronization
 */
export async function queueChange(type, payload) {
  return await db.syncQueue.add({
    type,
    payload,
    status: 'pending',
    created_at: new Date().toISOString()
  });
}

/**
 * Get pending sync items
 */
export async function getPendingSync() {
  return await db.syncQueue.where('status').equals('pending').toArray();
}

/**
 * Get count of pending sync items
 */
export async function getPendingSyncCount() {
  return await db.syncQueue.where('status').equals('pending').count();
}

/**
 * Get count of failed sync items
 */
export async function getFailedSyncCount() {
  return await db.syncQueue.where('status').equals('failed').count();
}

/**
 * Mark item as synced or failed
 */
export async function updateSyncStatus(id, status, error = null) {
  return await db.syncQueue.update(id, { status, error, synced_at: new Date().toISOString() });
}

/**
 * Validate Portal authentication by checking local offlineStore for student
 * In production, this would make an anonymous query to Supabase.
 */
export async function validatePortalLogin(schoolSearch, admNo, phone) {
  try {
    // Try to find a student who matches the ADM number exactly
    const students = await db.students.where('adm_no').equalsIgnoreCase(admNo).toArray();
    
    if (students.length === 0) return null;
    
    // Refined check: also verify phone number (guardian phone)
    const student = students.find(s => {
      // Basic normalization: remove spaces/dashes if any
      const sPhone = (s.parent_phone || '').replace(/[\s-]/g, '');
      const pPhone = (phone || '').replace(/[\s-]/g, '');
      return sPhone.includes(pPhone) || pPhone.includes(sPhone);
    });

    if (!student) return null;
    
    // Try to find outstanding fees or communication history
    const allComms = await db.communications.orderBy('timestamp').reverse().toArray();
    
    return {
      id: student.id,
      name: student.name,
      class: student.class,
      adm_no: student.adm_no,
      residence_type: student.residence_type || 'day',
      recent_comms: allComms.slice(0, 5) // Last 5 notices
    };
  } catch (err) {
    console.error('Offline portal login validation failed:', err);
    return null;
  }
}

// ==========================================
// LMS HELPERS
// ==========================================
export async function addAssignment(payload) {
  return await db.assignments.add({ ...payload, timestamp: new Date().toISOString() });
}

export async function getAssignments(className = null) {
  const all = await db.assignments.orderBy('timestamp').reverse().toArray();
  if (className) return all.filter(a => a.class === className);
  return all;
}

export async function submitAssignment(assignment_id, student, payload, extra = {}) {
  return await db.submissions.add({
    assignment_id,
    student_id: student.id,
    student_name: student.name,
    class: student.class,
    payload,
    status: 'submitted',
    timestamp: new Date().toISOString(),
    ...extra
  });
}

export async function getSubmissions(assignment_id) {
  return await db.submissions.where('assignment_id').equals(assignment_id).toArray();
}

export async function getStudentSubmissions(student_id) {
  return await db.submissions.where('student_id').equals(student_id).toArray();
}

/**
 * Update a student's submission with a grade and workflow status.
 */
export async function updateSubmissionGrade(submissionId, data) {
  return await db.submissions.update(submissionId, data);
}

/**
 * Domain 15: Resilient Background Sync
 * Processes queued items when the network is available.
 */
// ==========================================
// GRADING DRAFTS (Offline-First)
// ==========================================

/**
 * Save a grading draft to IndexedDB for offline-first grading.
 * Upserts based on [exam_paper_id + student_id].
 */
export async function saveGradingDraft(paperId, studentId, teacherId, data, options = {}) {
  const existing = await db.grading_drafts
    .where('[exam_paper_id+student_id]')
    .equals([paperId, studentId])
    .first();

  const idempotencyKey = `${paperId}_${studentId}_${data.score ?? 'null'}_${data.isAbsent ? '1' : '0'}`;

  const draft = {
    exam_paper_id: paperId,
    student_id: studentId,
    teacher_id: teacherId,
    school_id: options.schoolId || null,
    period_id: options.periodId || null,
    raw_score: data.score,
    is_absent: Boolean(data.isAbsent),
    remarks: data.remarks || '',
    idempotency_key: idempotencyKey,
    version: (existing?.version || 0) + 1,
    synced: 0,
    client_timestamp: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  let id;
  if (existing) {
    await db.grading_drafts.update(existing.id, draft);
    id = existing.id;
  } else {
    id = await db.grading_drafts.add(draft);
  }

  // Queue background sync item
  if (options.queueSync !== false) {
    try {
      const existingQueueItem = await db.syncQueue
        .where('type')
        .equals(syncTypes.SYNC_GRADES)
        .toArray();

      const pendingForPaper = existingQueueItem.find(
        q => q.status === 'pending' && q.payload?.exam_paper_id === paperId
      );

      if (!pendingForPaper) {
        await queueChange(syncTypes.SYNC_GRADES, {
          exam_paper_id: paperId,
          teacher_id: teacherId,
          idempotency_key: `${paperId}_${Date.now()}`
        });
      }
    } catch (e) {
      console.warn('Queue change exception:', e);
    }
  }

  return id;
}

/**
 * Get all grading drafts for a specific exam paper.
 */
export async function getGradingDrafts(paperId) {
  return await db.grading_drafts.where('exam_paper_id').equals(paperId).toArray();
}

/**
 * Mark grading drafts as synced after successful upload.
 */
export async function markDraftsSynced(draftIds) {
  for (const id of draftIds) {
    await db.grading_drafts.update(id, { synced: true, synced_at: new Date().toISOString() });
  }
}

/**
 * Get count of unsynced grading drafts.
 */
export async function getUnsyncedDraftCount() {
  return await db.grading_drafts.where('synced').equals(0).count();
}

export async function runBackgroundSync(handlers = {}) {
  const pending = await db.syncQueue.where('status').equals('pending').toArray();
  const smsPending = await db.sms_queue.where('status').equals('pending').toArray();
  
  if (pending.length === 0 && smsPending.length === 0) return { processed: 0 };

  console.log(`[SYNC] Processing ${pending.length + smsPending.length} items...`);
  let processed = 0;

  // Process standard sync queue
  for (const item of pending) {
    const handler = handlers[item.type];
    if (handler) {
      try {
        await handler(item.payload);
        await updateSyncStatus(item.id, 'synced');
        processed++;
      } catch (err) {
        await updateSyncStatus(item.id, 'failed', err.message);
      }
    }
  }

  // Process SMS queue (if handler provided)
  if (handlers.SMS && smsPending.length > 0) {
    for (const sms of smsPending) {
      try {
        await handlers.SMS(sms);
        await db.sms_queue.update(sms.id, { status: 'sent', sent_at: new Date().toISOString() });
        processed++;
      } catch (err) {
        const newCount = (sms.retry_count || 0) + 1;
        await db.sms_queue.update(sms.id, { 
          retry_count: newCount, 
          status: newCount > 3 ? 'failed' : 'pending',
          error: err.message 
        });
      }
    }
  }

  return { processed };
}
