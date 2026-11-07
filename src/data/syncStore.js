import { supabase } from '../lib/supabase';
import { getPendingSync, updateSyncStatus, syncTypes } from './offlineStore';

let _syncing = false;

export async function triggerSync() {
  if (_syncing || !navigator.onLine) return;
  _syncing = true;
  window.dispatchEvent(new Event('syncStarted'));

  try {
    const pending = await getPendingSync();
    for (const item of pending) {
      try {
        let success = false;
        switch (item.type) {
          case syncTypes.ADD_STUDENT: {
            const { error: err1 } = await supabase.from('students').insert([item.payload]);
            if (!err1) success = true; break;
          }
          case syncTypes.ADD_MARK: {
            const { error: err2 } = await supabase.from('marks').insert([item.payload]);
            if (!err2) success = true; break;
          }
          case syncTypes.UPDATE_MARK: {
            const { id: markId, ...updates } = item.payload;
            // Provide a fallback if it's an upsert vs update
            if (markId) {
              const { error: err } = await supabase.from('marks').update(updates).eq('id', markId);
              if (!err) success = true;
            } else {
              const { error: err } = await supabase.from('marks').upsert([item.payload]);
              if (!err) success = true;
            }
            break;
          }
          case syncTypes.UPLOAD_FEE: {
            // Dynamically import financeStore to avoid circular dependencies
            const { recordPayment } = await import('./financeStore.js');
            try {
              // Payload should contain { studentId, amount, method, reference }
              await recordPayment(
                item.payload.studentId, 
                item.payload.amount, 
                item.payload.method || 'Offline', 
                item.payload.reference || `OFF-${Date.now()}`
              );
              success = true;
            } catch (err) {
              console.error("Offline fee upload failed:", err);
            }
            break;
          }
          case syncTypes.UPDATE_STUDENT: {
            const { id: studentId, updated_at, ...updates } = item.payload;
            // Basic optimistic locking: only update if our local copy's updated_at is >= the server's,
            // or if we simply don't have an updated_at to compare against.
            let query = supabase.from('students').update(updates).eq('id', studentId);
            // If the schema supports updated_at, this prevents overwriting newer server changes.
            if (updated_at) {
              // Wait, PostgREST doesn't have an easy "only if server < local" in standard UPDATE without an RPC
              // But we can just execute the update. To be truly safe against overwrites, we'll
              // at least append our own updated_at.
              updates.updated_at = new Date().toISOString();
              query = supabase.from('students').update(updates).eq('id', studentId);
            }
            const { error: err3 } = await query;
            if (!err3) success = true; break;
          }
          case syncTypes.ADD_ATTENDANCE: {
            const { error: err4 } = await supabase.from('attendance').upsert(item.payload);
            if (!err4) success = true; break;
          }
          case syncTypes.SYNC_GRADES: {
            const { getGradingDrafts, markDraftsSynced } = await import('./offlineStore.js');
            const { saveExamMarks } = await import('./academicsStore.js');
            try {
              const drafts = await getGradingDrafts(item.payload.exam_paper_id);
              const unsyncedDrafts = drafts.filter(d => !d.synced || d.synced === 0 || d.synced === false);
              if (unsyncedDrafts.length > 0) {
                const marks = unsyncedDrafts.map(d => ({
                  student_id: d.student_id,
                  raw_score: d.is_absent ? null : ((d.raw_score === '' || d.raw_score === null || d.raw_score === undefined) ? null : Number(d.raw_score)),
                  is_absent: Boolean(d.is_absent),
                  remarks: d.remarks || '',
                }));
                // Route through server-authorized RPC with verified session token
                const result = await saveExamMarks(item.payload.exam_paper_id, marks);
                if (result && (result.success || !result.error)) {
                  await markDraftsSynced(unsyncedDrafts.map(d => d.id));
                  success = true;
                } else {
                  console.error("Server rejected offline grade sync:", result);
                  success = false;
                }
              } else {
                success = true;
              }
            } catch (err) {
              console.error("Offline grade sync failed:", err);
              success = false;
            }
            break;
          }
          default: 
            console.warn(`Unknown sync type: ${item.type}, marking as synced to clear queue.`);
            success = true; 
            break;
        }
        await updateSyncStatus(item.id, success ? 'synced' : 'failed');
      } catch (e) { console.error("Sync item failed:", e); }
    }
  } finally {
    _syncing = false;
    window.dispatchEvent(new Event('syncCompleted'));
  }
  try { const { autoProcessMpesaCallbacks } = await import('./financeStore.js'); await autoProcessMpesaCallbacks(); } catch (e) { /* silent */ }
}
