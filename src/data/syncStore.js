import { supabase } from '../lib/supabase';
import { getPendingSync, updateSyncStatus, syncTypes } from './offlineStore';

let _syncing = false;

export async function triggerSync() {
  if (_syncing || !navigator.onLine) return { processed: 0, succeeded: 0, failed: 0 };
  _syncing = true;
  window.dispatchEvent(new Event('syncStarted'));
  const summary = { processed: 0, succeeded: 0, failed: 0 };

  try {
    const pending = await getPendingSync();
    for (const item of pending) {
      summary.processed++;
      let failure = null;
      try {
        switch (item.type) {
          case syncTypes.ADD_STUDENT: {
            const { error } = await supabase.from('students').upsert([item.payload]);
            if (error) throw error;
            break;
          }
          case syncTypes.ADD_MARK: {
            const { error } = await supabase.from('marks').upsert([item.payload]);
            if (error) throw error;
            break;
          }
          case syncTypes.UPDATE_MARK: {
            const { id: markId, ...updates } = item.payload;
            const query = markId
              ? supabase.from('marks').update(updates).eq('id', markId)
              : supabase.from('marks').upsert([item.payload]);
            const { error } = await query;
            if (error) throw error;
            break;
          }
          case syncTypes.UPLOAD_FEE: {
            const { recordPayment } = await import('./financeStore.js');
            await recordPayment(item.payload.studentId, item.payload.amount,
              item.payload.method || 'Offline', item.payload.reference || ('OFFLINE-' + item.id));
            break;
          }
          case syncTypes.UPDATE_STUDENT: {
            const { id: studentId, updated_at: expectedUpdatedAt, ...updates } = item.payload;
            if (!studentId) throw new Error('Offline student update is missing the student id.');
            if (!expectedUpdatedAt) throw new Error('Offline student update has no last-known updated_at value. The update was retained to avoid overwriting newer server data.');
            updates.updated_at = new Date().toISOString();
            const { data, error } = await supabase.from('students').update(updates)
              .eq('id', studentId).eq('updated_at', expectedUpdatedAt).select('id');
            if (error) throw error;
            if (!Array.isArray(data) || data.length !== 1) {
              throw new Error('Student record changed on the server while this device was offline. Resolve the conflict before retrying.');
            }
            break;
          }
          case syncTypes.ADD_ATTENDANCE: {
            const { error } = await supabase.from('attendance').upsert(item.payload, {
              onConflict: 'school_id,date,student_id,period_id,session',
            });
            if (error) throw error;
            break;
          }
          case syncTypes.SYNC_GRADES: {
            const { getGradingDrafts, markDraftsSynced } = await import('./offlineStore.js');
            const { saveExamMarks } = await import('./academicsStore.js');
            const drafts = await getGradingDrafts(item.payload.exam_paper_id);
            const unsynced = drafts.filter((draft) => !draft.synced);
            if (!unsynced.length) break;
            const marks = unsynced.map((draft) => ({
              student_id: draft.student_id,
              raw_score: draft.is_absent ? null : ((draft.raw_score === '' || draft.raw_score == null) ? null : Number(draft.raw_score)),
              is_absent: Boolean(draft.is_absent),
              remarks: draft.remarks || '',
            }));
            const result = await saveExamMarks(item.payload.exam_paper_id, marks);
            const confirmed = result?.success === true || Number(result?.saved_count || 0) >= marks.length;
            if (!confirmed) throw new Error('Marks API did not return an explicit successful save result; drafts were retained.');
            await markDraftsSynced(unsynced.map((draft) => draft.id));
            break;
          }
          default:
            throw new Error('Unknown sync queue type: ' + String(item.type) + '. Item has been retained for diagnosis.');
        }
        await updateSyncStatus(item.id, 'synced');
        summary.succeeded++;
      } catch (error) {
        failure = error?.message || String(error);
        console.error('Sync item failed:', item.type, failure);
        await updateSyncStatus(item.id, 'failed', failure);
        summary.failed++;
      }
    }
  } finally {
    _syncing = false;
    window.dispatchEvent(new CustomEvent('syncCompleted', { detail: summary }));
  }

  try {
    const { autoProcessMpesaCallbacks } = await import('./financeStore.js');
    await autoProcessMpesaCallbacks();
  } catch (error) {
    console.error('M-Pesa reconciliation check failed:', error?.message || error);
  }
  return summary;
}
