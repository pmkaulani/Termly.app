-- Termly reliability remediation migration
-- Apply only after reviewing the currently deployed Supabase migration history.
-- This migration is additive and deliberately does not edit already-applied migrations.

-- -----------------------------------------------------------------------------
-- 1. Attendance: preserve separate session records instead of overwriting a day.
-- -----------------------------------------------------------------------------
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES public.academic_periods(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS session TEXT NOT NULL DEFAULT 'Morning';

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  IF to_regclass('public.attendance') IS NOT NULL THEN
    -- Remove legacy unique constraints that prevent session-based recording (both 4-column and 3-column)
    FOR v_constraint IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) AS key(attnum) ON TRUE
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = key.attnum
      WHERE c.conrelid = 'public.attendance'::regclass
        AND c.contype = 'u'
      GROUP BY c.conname
      HAVING array_agg(a.attname::TEXT ORDER BY a.attname::TEXT)
          IN (
            ARRAY['date', 'period_id', 'school_id', 'student_id']::TEXT[],
            ARRAY['date', 'school_id', 'student_id']::TEXT[]
          )
    LOOP
      EXECUTE format('ALTER TABLE public.attendance DROP CONSTRAINT %I', v_constraint.conname);
    END LOOP;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_school_date_student_period_session_uidx
  ON public.attendance (school_id, date, student_id, period_id, session);

CREATE INDEX IF NOT EXISTS attendance_school_period_date_idx
  ON public.attendance (school_id, period_id, date);

-- -----------------------------------------------------------------------------
-- 2. LMS: align the deployed el_* schema with the fields used by Termly's UI.
-- The canonical store remains el_assignments / el_submissions. IndexedDB is a
-- local cache/outbox only; it is not a second source of truth.
-- -----------------------------------------------------------------------------
ALTER TABLE public.el_assignments
  ADD COLUMN IF NOT EXISTS class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subject_id UUID REFERENCES public.tt_subjects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS class TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS teacher TEXT,
  ADD COLUMN IF NOT EXISTS stream TEXT,
  ADD COLUMN IF NOT EXISTS allow_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cutoff_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS questions JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS external_link TEXT,
  ADD COLUMN IF NOT EXISTS links TEXT,
  ADD COLUMN IF NOT EXISTS class_label TEXT,
  ADD COLUMN IF NOT EXISTS subject_label TEXT,
  ADD COLUMN IF NOT EXISTS teacher_name TEXT,
  ADD COLUMN IF NOT EXISTS quiz_config JSONB NOT NULL DEFAULT '[]'::JSONB;

DO $$
BEGIN
  -- Ensure legacy NOT NULL constraints do not prevent modern inserts
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'el_assignments' AND column_name = 'class' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.el_assignments ALTER COLUMN class DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'el_assignments' AND column_name = 'subject' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.el_assignments ALTER COLUMN subject DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'el_assignments' AND column_name = 'allow_from' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.el_assignments ALTER COLUMN allow_from DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'el_assignments' AND column_name = 'cutoff_date' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.el_assignments ALTER COLUMN cutoff_date DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'el_assignments' AND column_name = 'class_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.el_assignments ALTER COLUMN class_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'el_assignments' AND column_name = 'teacher_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.el_assignments ALTER COLUMN teacher_id DROP NOT NULL;
  END IF;
END $$;

-- Backfill class_id on assignments from classes if missing
UPDATE public.el_assignments a
SET class_id = c.id
FROM public.classes c
WHERE a.class_id IS NULL
  AND a.school_id = c.school_id
  AND (a.class = c.name OR a.class_label = c.name);

-- Backfill labels and legacy aliases
UPDATE public.el_assignments
SET class_label = COALESCE(class_label, class),
    subject_label = COALESCE(subject_label, subject),
    teacher_name = COALESCE(teacher_name, teacher),
    external_link = COALESCE(external_link, links)
WHERE class_label IS NULL OR subject_label IS NULL OR teacher_name IS NULL OR external_link IS NULL;

ALTER TABLE public.el_submissions
  ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'Submitted',
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'submitted',
  ADD COLUMN IF NOT EXISTS grade_numeric NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS score DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS feedback TEXT,
  ADD COLUMN IF NOT EXISTS teacher_comment TEXT,
  ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_late BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quiz_results JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS answers JSONB,
  ADD COLUMN IF NOT EXISTS content_url TEXT,
  ADD COLUMN IF NOT EXISTS text_response TEXT,
  ADD COLUMN IF NOT EXISTS external_link TEXT,
  ADD COLUMN IF NOT EXISTS external_label TEXT,
  ADD COLUMN IF NOT EXISTS graded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graded_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- Backfill school_id on submissions from assignments if missing
UPDATE public.el_submissions s
SET school_id = a.school_id
FROM public.el_assignments a
WHERE s.school_id IS NULL AND s.assignment_id = a.id;

-- Backfill timestamp, grade_numeric, feedback from legacy columns if missing
UPDATE public.el_submissions
SET timestamp = COALESCE(timestamp, submitted_at),
    grade_numeric = COALESCE(grade_numeric, score),
    feedback = COALESCE(feedback, teacher_comment)
WHERE timestamp IS NULL OR grade_numeric IS NULL OR feedback IS NULL;

CREATE INDEX IF NOT EXISTS el_assignments_school_class_due_idx
  ON public.el_assignments (school_id, class_id, due_date);
CREATE INDEX IF NOT EXISTS el_submissions_school_assignment_idx
  ON public.el_submissions (school_id, assignment_id);

-- -----------------------------------------------------------------------------
-- 3. M-Pesa receipt uniqueness and atomic ledger operations.
-- -----------------------------------------------------------------------------
ALTER TABLE public.mpesa_callbacks
  ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES public.academic_periods(id),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE public.fee_payments
  ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES public.academic_periods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Confirmed',
  ADD COLUMN IF NOT EXISTS receipt_number TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Backfill fee_payments foreign keys from parent fee record if null
UPDATE public.fee_payments fp
SET school_id = COALESCE(fp.school_id, f.school_id),
    student_id = COALESCE(fp.student_id, f.student_id),
    period_id = COALESCE(fp.period_id, f.period_id)
FROM public.fees f
WHERE fp.fee_id = f.id
  AND (fp.school_id IS NULL OR fp.student_id IS NULL OR fp.period_id IS NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fee_payments
    WHERE method = 'M-Pesa' AND reference IS NOT NULL AND btrim(reference) <> ''
    GROUP BY school_id, reference HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate M-Pesa receipts exist within a school. Reconcile these rows before applying the unique receipt index.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS fee_payments_mpesa_receipt_school_uidx
  ON public.fee_payments (school_id, reference)
  WHERE method = 'M-Pesa' AND reference IS NOT NULL AND btrim(reference) <> '';

CREATE OR REPLACE FUNCTION public.record_fee_payment_atomic(
  p_school_id UUID,
  p_period_id UUID,
  p_student_id UUID,
  p_amount NUMERIC,
  p_method TEXT DEFAULT 'Cash',
  p_reference TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_school_id UUID;
  v_role TEXT;
  v_fee public.fees%ROWTYPE;
  v_payment public.fee_payments%ROWTYPE;
  v_existing public.fee_payments%ROWTYPE;
  v_amount NUMERIC(12,2);
  v_reference TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  SELECT u.school_id, lower(u.role)
    INTO v_school_id, v_role
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;

  IF v_school_id IS NULL THEN
    SELECT s.id INTO v_school_id
    FROM public.schools s
    WHERE s.owner_id = auth.uid()
    LIMIT 1;
    v_role := 'owner';
  END IF;

  IF v_school_id IS NULL OR v_school_id <> p_school_id THEN
    RAISE EXCEPTION 'You are not authorized to record a payment for this school.';
  END IF;

  IF coalesce(v_role, '') NOT IN ('owner', 'admin', 'finance') THEN
    RAISE EXCEPTION 'Only school owners, administrators, or finance staff can record payments.';
  END IF;

  v_amount := round(coalesce(p_amount, 0), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero.';
  END IF;

  v_reference := nullif(regexp_replace(upper(coalesce(p_reference, '')), '[^A-Z0-9-]', '', 'g'), '');
  IF lower(coalesce(nullif(p_method, ''), 'Cash')) IN ('m-pesa', 'mpesa') AND v_reference IS NULL THEN
    RAISE EXCEPTION 'Enter the M-Pesa receipt number before recording a manual M-Pesa payment.';
  END IF;

  -- Serialize identical references across all fee rows in this school. This
  -- makes offline retries and repeated submits idempotent under concurrency.
  IF v_reference IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(p_school_id::TEXT || ':' || v_reference));
  END IF;

  SELECT f.* INTO v_fee
  FROM public.fees f
  WHERE f.school_id = p_school_id
    AND f.period_id = p_period_id
    AND f.student_id = p_student_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No fee record exists for this student in the selected academic period.';
  END IF;

  IF v_reference IS NOT NULL THEN
    SELECT fp.* INTO v_existing
    FROM public.fee_payments fp
    WHERE fp.school_id = p_school_id
      AND regexp_replace(upper(coalesce(fp.reference, '')), '[^A-Z0-9-]', '', 'g') = v_reference
      AND fp.status IS DISTINCT FROM 'Voided'
    ORDER BY fp.date DESC
    LIMIT 1;

    IF FOUND THEN
      IF lower(coalesce(v_existing.status, '')) = 'voided' THEN
        RAISE EXCEPTION 'This payment reference was already recorded and voided. Do not reuse a receipt or transaction reference.';
      END IF;
      IF v_existing.student_id = p_student_id
         AND v_existing.period_id = p_period_id
         AND round(coalesce(v_existing.amount, 0), 2) = v_amount
         AND lower(coalesce(v_existing.method, '')) = lower(coalesce(nullif(p_method, ''), 'Cash')) THEN
        RETURN jsonb_build_object(
          'success', TRUE,
          'duplicate', TRUE,
          'payment', to_jsonb(v_existing),
          'paid', coalesce(v_fee.paid, 0),
          'balance', coalesce(v_fee.balance, 0)
        );
      END IF;
      RAISE EXCEPTION 'This payment reference has already been recorded against another payment.';
    END IF;
  END IF;

  IF v_amount > greatest(coalesce(v_fee.balance, 0), 0) THEN
    RAISE EXCEPTION 'Payment exceeds the outstanding balance. Outstanding balance: %.', coalesce(v_fee.balance, 0);
  END IF;

  INSERT INTO public.fee_payments (
    school_id, student_id, period_id, fee_id, amount, method, reference, date, status
  ) VALUES (
    p_school_id, p_student_id, p_period_id, v_fee.id, v_amount,
    coalesce(nullif(p_method, ''), 'Cash'), v_reference, now(), 'Confirmed'
  )
  RETURNING * INTO v_payment;

  UPDATE public.fees
  SET paid = coalesce(v_fee.paid, 0) + v_amount,
      balance = greatest(coalesce(v_fee.total_fee, 0) - (coalesce(v_fee.paid, 0) + v_amount), 0),
      updated_at = now()
  WHERE id = v_fee.id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'payment', to_jsonb(v_payment),
    'paid', coalesce(v_fee.paid, 0) + v_amount,
    'balance', greatest(coalesce(v_fee.total_fee, 0) - (coalesce(v_fee.paid, 0) + v_amount), 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_fee_payment_atomic(UUID, UUID, UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_fee_payment_atomic(UUID, UUID, UUID, NUMERIC, TEXT, TEXT) TO authenticated;

-- M-Pesa callback ledger reconciliation runs only from a service-role Edge Function.
CREATE OR REPLACE FUNCTION public.process_mpesa_stk_callback(
  p_checkout_request_id TEXT,
  p_result_code INTEGER,
  p_result_desc TEXT,
  p_receipt_no TEXT DEFAULT NULL,
  p_amount NUMERIC DEFAULT NULL,
  p_transaction_date TEXT DEFAULT NULL,
  p_payer_phone TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_callback public.mpesa_callbacks%ROWTYPE;
  v_student public.students%ROWTYPE;
  v_period public.academic_periods%ROWTYPE;
  v_fee public.fees%ROWTYPE;
  v_payment_id UUID;
  v_existing_payment public.fee_payments%ROWTYPE;
  v_amount NUMERIC(12,2);
  v_receipt TEXT;
BEGIN
  SELECT * INTO v_callback
  FROM public.mpesa_callbacks
  WHERE checkout_request_id = p_checkout_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No payment request is registered for this checkout request.';
  END IF;

  IF v_callback.status IN ('completed', 'processed') THEN
    RETURN jsonb_build_object('success', TRUE, 'duplicate', TRUE, 'status', v_callback.status);
  END IF;

  IF coalesce(p_result_code, -1) <> 0 THEN
    UPDATE public.mpesa_callbacks
    SET status = 'failed', result_code = p_result_code,
        result_desc = p_result_desc, updated_at = now()
    WHERE id = v_callback.id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'failed');
  END IF;

  v_receipt := nullif(regexp_replace(upper(btrim(coalesce(p_receipt_no, ''))), '[^A-Z0-9-]', '', 'g'), '');
  v_amount := round(coalesce(p_amount, v_callback.amount), 2);
  IF v_receipt IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Successful callback is missing a valid receipt number or amount.';
  END IF;

  SELECT s.* INTO v_student
  FROM public.students s
  WHERE s.school_id = v_callback.school_id
    AND (upper(coalesce(s.adm_no, '')) = upper(coalesce(v_callback.bill_ref_number, ''))
         OR s.id::TEXT = coalesce(v_callback.bill_ref_number, ''))
  ORDER BY (upper(coalesce(s.adm_no, '')) = upper(coalesce(v_callback.bill_ref_number, ''))) DESC
  LIMIT 1;

  IF NOT FOUND THEN
    UPDATE public.mpesa_callbacks
    SET status = 'orphaned', result_code = p_result_code,
        mpesa_receipt_number = v_receipt, amount = v_amount,
        phone_number = coalesce(p_payer_phone, phone_number),
        transaction_date = CASE WHEN p_transaction_date ~ '^[0-9]{14}$' THEN make_timestamptz(
          substring(p_transaction_date from 1 for 4)::INTEGER,
          substring(p_transaction_date from 5 for 2)::INTEGER,
          substring(p_transaction_date from 7 for 2)::INTEGER,
          substring(p_transaction_date from 9 for 2)::INTEGER,
          substring(p_transaction_date from 11 for 2)::INTEGER,
          substring(p_transaction_date from 13 for 2)::DOUBLE PRECISION,
          'Africa/Nairobi'
        ) ELSE transaction_date END,
        result_desc = 'Payment received but student could not be matched. ' || coalesce(p_result_desc, ''),
        updated_at = now()
    WHERE id = v_callback.id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'orphaned');
  END IF;

  -- New STK requests save the active period before redirecting to Safaricom.
  -- Older pending callback rows have no period_id, so they fall back to the
  -- currently active period and remain identifiable for manual review.
  IF v_callback.period_id IS NOT NULL THEN
    SELECT ap.* INTO v_period
    FROM public.academic_periods ap
    WHERE ap.id = v_callback.period_id AND ap.school_id = v_callback.school_id;
  ELSE
    SELECT ap.* INTO v_period
    FROM public.academic_periods ap
    WHERE ap.school_id = v_callback.school_id AND ap.is_active = TRUE
    ORDER BY ap.year DESC, ap.term DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    UPDATE public.mpesa_callbacks
    SET status = 'orphaned', result_code = p_result_code,
        mpesa_receipt_number = v_receipt, amount = v_amount,
        result_desc = 'Payment received but no active academic period exists.',
        updated_at = now()
    WHERE id = v_callback.id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'orphaned');
  END IF;

  SELECT f.* INTO v_fee
  FROM public.fees f
  WHERE f.school_id = v_callback.school_id
    AND f.student_id = v_student.id
    AND f.period_id = v_period.id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.mpesa_callbacks
    SET status = 'orphaned', result_code = p_result_code,
        mpesa_receipt_number = v_receipt, amount = v_amount,
        student_id = v_student.id,
        result_desc = 'Payment received but no fee ledger exists for the active period.',
        updated_at = now()
    WHERE id = v_callback.id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'orphaned');
  END IF;

  -- A balance may have changed after the STK prompt was issued. Never silently
  -- cap a real received payment at zero balance; keep it visible for reconciliation.
  IF v_amount > greatest(coalesce(v_fee.balance, 0), 0) THEN
    UPDATE public.mpesa_callbacks
    SET status = 'orphaned', result_code = p_result_code,
        mpesa_receipt_number = v_receipt, amount = v_amount,
        student_id = v_student.id,
        transaction_date = CASE WHEN p_transaction_date ~ '^[0-9]{14}$' THEN make_timestamptz(
          substring(p_transaction_date from 1 for 4)::INTEGER,
          substring(p_transaction_date from 5 for 2)::INTEGER,
          substring(p_transaction_date from 7 for 2)::INTEGER,
          substring(p_transaction_date from 9 for 2)::INTEGER,
          substring(p_transaction_date from 11 for 2)::INTEGER,
          substring(p_transaction_date from 13 for 2)::DOUBLE PRECISION,
          'Africa/Nairobi'
        ) ELSE transaction_date END,
        phone_number = coalesce(p_payer_phone, phone_number),
        result_desc = 'Payment received but amount exceeds the current outstanding balance; manual reconciliation is required.',
        updated_at = now()
    WHERE id = v_callback.id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'orphaned', 'reason', 'overpayment_requires_review');
  END IF;

  -- Serialize this receipt within the school, then inspect any prior row.
  -- Treat only an identical receipt/student/period/amount as a duplicate. A
  -- receipt collision across students is orphaned for manual reconciliation.
  PERFORM pg_advisory_xact_lock(hashtext(v_callback.school_id::TEXT || ':' || v_receipt));
  SELECT fp.* INTO v_existing_payment
  FROM public.fee_payments fp
  WHERE fp.school_id = v_callback.school_id
    AND fp.reference = v_receipt
    AND fp.method = 'M-Pesa'
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF lower(coalesce(v_existing_payment.status, '')) <> 'voided'
       AND v_existing_payment.student_id = v_student.id
       AND v_existing_payment.period_id = v_period.id
       AND round(coalesce(v_existing_payment.amount, 0), 2) = v_amount THEN
      UPDATE public.mpesa_callbacks
      SET status = 'completed', result_code = p_result_code,
          mpesa_receipt_number = v_receipt, amount = v_amount,
          student_id = v_student.id,
          phone_number = coalesce(p_payer_phone, phone_number),
          result_desc = p_result_desc, updated_at = now()
      WHERE id = v_callback.id;
      RETURN jsonb_build_object('success', TRUE, 'status', 'completed', 'duplicate_receipt', TRUE,
        'payment_id', v_existing_payment.id);
    END IF;

    UPDATE public.mpesa_callbacks
    SET status = 'orphaned', result_code = p_result_code,
        mpesa_receipt_number = v_receipt, amount = v_amount,
        student_id = v_student.id,
        phone_number = coalesce(p_payer_phone, phone_number),
        result_desc = 'Receipt number already belongs to a different student, period, or amount. Manual reconciliation is required.',
        updated_at = now()
    WHERE id = v_callback.id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'orphaned', 'reason', 'duplicate_receipt_collision');
  END IF;

  INSERT INTO public.fee_payments (
    school_id, student_id, period_id, fee_id, amount, method,
    reference, receipt_number, date, status
  ) VALUES (
    v_callback.school_id, v_student.id, v_period.id, v_fee.id, v_amount,
    'M-Pesa', v_receipt, v_receipt, now(), 'Confirmed'
  )
  RETURNING id INTO v_payment_id;

  UPDATE public.fees
  SET paid = coalesce(v_fee.paid, 0) + v_amount,
      balance = greatest(coalesce(v_fee.total_fee, 0) - (coalesce(v_fee.paid, 0) + v_amount), 0),
      updated_at = now()
  WHERE id = v_fee.id;

  UPDATE public.mpesa_callbacks
  SET status = 'completed', result_code = p_result_code,
      mpesa_receipt_number = v_receipt, amount = v_amount,
      student_id = v_student.id, transaction_date = CASE WHEN p_transaction_date ~ '^[0-9]{14}$' THEN make_timestamptz(
          substring(p_transaction_date from 1 for 4)::INTEGER,
          substring(p_transaction_date from 5 for 2)::INTEGER,
          substring(p_transaction_date from 7 for 2)::INTEGER,
          substring(p_transaction_date from 9 for 2)::INTEGER,
          substring(p_transaction_date from 11 for 2)::INTEGER,
          substring(p_transaction_date from 13 for 2)::DOUBLE PRECISION,
          'Africa/Nairobi'
        ) ELSE transaction_date END,
      phone_number = coalesce(p_payer_phone, phone_number),
      result_desc = p_result_desc, updated_at = now()
  WHERE id = v_callback.id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'status', 'completed',
    'duplicate_receipt', FALSE,
    'payment_id', v_payment_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_mpesa_stk_callback(TEXT, INTEGER, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_mpesa_stk_callback(TEXT, INTEGER, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Explicitly document accepted vs delivered communication states.
-- Existing rows remain readable; provider acceptance is not delivery proof.
-- -----------------------------------------------------------------------------
ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- The pre-existing SMS RLS policy allowed reads only. Staff queue rows through
-- the client; the provider send itself remains behind the authenticated Edge Function.
DROP POLICY IF EXISTS sms_messages_insert_same_school ON public.sms_messages;
CREATE POLICY sms_messages_insert_same_school ON public.sms_messages
  FOR INSERT WITH CHECK (
    school_id IN (
      SELECT u.school_id FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND lower(coalesce(u.role, '')) IN ('admin', 'finance', 'teacher', 'librarian')
    )
    OR school_id IN (SELECT s.id FROM public.schools s WHERE s.owner_id = auth.uid())
  );

-- The current Edge Function deployment uses project-level provider secrets.
-- Fail closed when the existing SaaS data contains different per-school provider
-- configurations: one global shortcode/API key must never silently replace them.
ALTER TABLE public.school_profiles
  ADD COLUMN IF NOT EXISTS mpesa_config JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sms_config JSONB DEFAULT '{}'::jsonb;

DO $$
DECLARE
  v_mpesa_configs INTEGER;
  v_sms_configs INTEGER;
BEGIN
  SELECT count(DISTINCT mpesa_config) INTO v_mpesa_configs
  FROM public.school_profiles
  WHERE mpesa_config IS NOT NULL AND mpesa_config <> '{}'::JSONB;

  SELECT count(DISTINCT sms_config) INTO v_sms_configs
  FROM public.school_profiles
  WHERE sms_config IS NOT NULL AND sms_config <> '{}'::JSONB;

  IF v_mpesa_configs > 1 OR v_sms_configs > 1 THEN
    RAISE EXCEPTION 'Different per-school SMS/M-Pesa provider configurations exist. This global-secret deployment is not safe for this dataset; implement a server-side per-school credential vault before applying this migration.';
  END IF;
END $$;

-- Remove legacy provider credentials from browser-readable profile JSON only after
-- the matching project-level secrets have been configured as described in the guide.
UPDATE public.school_profiles
SET mpesa_config = CASE WHEN mpesa_config IS NULL THEN NULL ELSE jsonb_build_object('managed_by', 'supabase_edge_function_secrets') END,
    sms_config = CASE WHEN sms_config IS NULL THEN NULL ELSE jsonb_build_object('managed_by', 'supabase_edge_function_secrets') END
WHERE mpesa_config IS NOT NULL OR sms_config IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_messages_school_status_created_idx
  ON public.sms_messages (school_id, status, created_at DESC);

COMMENT ON COLUMN public.sms_messages.status IS
  'queued, sending, accepted, delivered, failed, or dnd. sending is claimed and must not be auto-retried; accepted means provider accepted the request, not that handset delivery is confirmed.';
