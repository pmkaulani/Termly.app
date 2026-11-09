import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('Termly remediation regression invariants', () => {
  it('does not ship Africa\'s Talking credentials in the browser bundle', () => {
    const source = read('src/utils/sms.js');
    expect(source).not.toContain('VITE_SMS_API_KEY');
    expect(source).toContain("functions.invoke('communications-send'");
  });

  it('keeps unknown offline queue records failed instead of silently syncing them', () => {
    const source = read('src/data/syncStore.js');
    expect(source).toContain('Unknown sync queue type:');
    expect(source).toContain("updateSyncStatus(item.id, 'failed', failure)");
  });

  it('persists session-aware attendance and uses the roster denominator', () => {
    const source = read('src/data/academicsStore.js');
    expect(source).toContain("onConflict: 'school_id,date,student_id,period_id,session'");
    expect(source).toContain('roster.length');
  });

  it('contains atomic fee and M-Pesa callback database operations', () => {
    const migration = read('supabase/migrations/20261108224600_termly_reliability_remediation.sql');
    expect(migration).toContain('record_fee_payment_atomic');
    expect(migration).toContain('Enter the M-Pesa receipt number');
    expect(migration).toContain('process_mpesa_stk_callback');
    expect(migration).toContain('attendance_school_date_student_period_session_uidx');
    expect(migration).toContain('sms_messages_insert_same_school');
  });

  it('uses Kenya local time for Daraja request passwords and callback timestamps', () => {
    const stk = read('supabase/functions/mpesa-stk-push/index.ts');
    const migration = read('supabase/migrations/20261108224600_termly_reliability_remediation.sql');
    expect(stk).toContain("timeZone: 'Africa/Nairobi'");
    expect(stk).toContain('const timestamp = getDarajaTimestamp();');
    expect(migration).toContain("'Africa/Nairobi'");
    expect(migration).not.toContain("to_timestamp(p_transaction_date, 'YYYYMMDDHH24MISS')");
  });

  it('keeps the academic period from STK initiation and checks duplicate receipts', () => {
    const applier = read('termly-remediation-kit/apply-termly-remediation.mjs');
    const migration = read('supabase/migrations/20261108224600_termly_reliability_remediation.sql');
    expect(applier).toContain('period_id: feeRecord.period_id');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES public.academic_periods(id)');
    expect(migration).toContain('WHERE ap.id = v_callback.period_id AND ap.school_id = v_callback.school_id');
    expect(migration).toContain("pg_advisory_xact_lock(hashtext(v_callback.school_id::TEXT || ':' || v_receipt))");
    expect(migration).toContain('duplicate_receipt_collision');
    expect(migration).toContain("regexp_replace(upper(btrim(coalesce(p_receipt_no, '')))");
  });

  it('does not return an uncertain provider request to the retry queue', () => {
    const source = read('supabase/functions/communications-send/index.ts');
    expect(source).toContain("status: 'sending', error_message: errorMessage, provider_status: 'outcome_unknown'");
    expect(source).toContain("eq('status', 'queued')");
  });

  it('does not let offline student updates overwrite newer server versions', () => {
    const source = read('src/data/syncStore.js');
    expect(source).toContain(".eq('updated_at', expectedUpdatedAt).select('id')");
    expect(source).toContain('Resolve the conflict before retrying.');
  });

  it('keeps LMS assignment reads on the canonical el_* cloud schema', () => {
    const source = read('src/data/academicsStore.js');
    expect(source).toContain("from('el_assignments')");
    expect(source).toContain("from('el_submissions')");
  });
});
