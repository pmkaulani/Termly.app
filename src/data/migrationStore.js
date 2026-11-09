import { supabase } from '../lib/supabase';
import { getCurrentSchoolId, mutationGuard, logAuditEvent } from './coreStore';

const TABLE = 'school_migration_batches';
const HISTORY_LIMIT = 20;

/**
 * Returns recent migration activity for the current school.
 * The database migration creates this as an append-only, admin-readable table.
 */
export async function getMigrationBatches(limit = HISTORY_LIMIT) {
  const schoolId = getCurrentSchoolId();
  if (!schoolId) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit) || HISTORY_LIMIT, 100));
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, dataset, source_system, source_filename, status, total_rows, inserted_count, updated_count, skipped_count, failed_count, notes, created_at')
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return data || [];
}

/**
 * Stores a summary only. Source rows and files are deliberately not copied into
 * the audit table because they may contain children's or staff members' data.
 */
export async function recordMigrationBatch({
  dataset,
  sourceSystem = 'Legacy school system',
  sourceFilename = null,
  result = {},
  notes = ''
}) {
  mutationGuard('recordMigrationBatch');

  const schoolId = getCurrentSchoolId();
  if (!schoolId) throw new Error('No active school context.');
  if (!['students', 'teachers'].includes(dataset)) {
    throw new Error(`Unsupported migration dataset: ${dataset}`);
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData?.user?.id) throw new Error('A signed-in administrator is required to record migration activity.');

  const inserted = Math.max(0, Number(result.inserted) || 0);
  const updated = Math.max(0, Number(result.updated) || 0);
  const skipped = Math.max(0, Number(result.skipped) || 0);
  const failed = Math.max(
    Array.isArray(result.errors) ? result.errors.length : 0,
    Math.max(0, Number(result.failed) || 0)
  );
  const total = Math.max(
    0,
    Number(result.totalRows) || Number(result.total) || inserted + updated + skipped + failed
  );
  const successful = inserted + updated;
  const status = failed === 0 ? 'completed' : successful > 0 ? 'partial' : 'failed';

  const payload = {
    school_id: schoolId,
    created_by: authData.user.id,
    dataset,
    source_system: String(sourceSystem || 'Legacy school system').trim().slice(0, 160),
    // Store only a file extension/type, never a user-supplied filename that may contain PII.
    source_filename: sourceFilename ? String(sourceFilename).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) : null,
    status,
    total_rows: total,
    inserted_count: inserted,
    updated_count: updated,
    skipped_count: skipped,
    failed_count: failed,
    notes: String(notes || '').trim().slice(0, 2000) || null
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select('id, dataset, source_system, source_filename, status, total_rows, inserted_count, updated_count, skipped_count, failed_count, notes, created_at')
    .single();

  if (error) throw error;

  await logAuditEvent('data_migration_import_recorded', TABLE, data.id, {
    dataset,
    status,
    total_rows: total,
    inserted_count: inserted,
    updated_count: updated,
    skipped_count: skipped,
    failed_count: failed
  });

  return data;
}
