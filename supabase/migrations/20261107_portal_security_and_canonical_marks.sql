-- ==============================================================================
-- Migration: Portal Security, Session Boundary, and Canonical Marks Pipeline
-- File: 20261107_portal_security_and_canonical_marks.sql
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. Portal Sessions Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('parent', 'teacher', 'admin')),
  entity_id UUID NOT NULL, -- student_id (for parent) or teacher_id (for teacher)
  user_id UUID,            -- user_id in public.users if linked
  parent_phone TEXT,       -- normalized parent phone for family linkage
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  revoked BOOLEAN NOT NULL DEFAULT false,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_token ON public.portal_sessions(token);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_lookup ON public.portal_sessions(token, revoked, expires_at);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_school_entity ON public.portal_sessions(school_id, entity_id);

-- Enforce strict RLS on sessions
ALTER TABLE public.portal_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny all portal_sessions direct access" ON public.portal_sessions;
CREATE POLICY "Deny all portal_sessions direct access" ON public.portal_sessions FOR ALL USING (false);

-- ------------------------------------------------------------------------------
-- 2. Server-Side Login Attempt Throttling
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT NOT NULL,
  school_id UUID,
  attempt_type TEXT NOT NULL, -- 'parent' or 'staff'
  failed_count INT NOT NULL DEFAULT 1,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_login_attempts_ident ON public.portal_login_attempts(identifier, attempt_type);

CREATE OR REPLACE FUNCTION public.check_login_throttle(
  p_identifier TEXT,
  p_school_id UUID,
  p_attempt_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_attempt RECORD;
BEGIN
  SELECT * INTO v_attempt 
  FROM public.portal_login_attempts 
  WHERE identifier = p_identifier AND attempt_type = p_attempt_type
  FOR UPDATE;

  IF FOUND THEN
    IF v_attempt.locked_until IS NOT NULL AND v_attempt.locked_until > now() THEN
      RAISE EXCEPTION 'Too many failed login attempts. Account temporarily locked until %.', 
        to_char(v_attempt.locked_until, 'YYYY-MM-DD HH24:MI:SS UTC');
    END IF;

    -- Reset if last failure was > 15 minutes ago
    IF v_attempt.last_failed_at < now() - interval '15 minutes' THEN
      DELETE FROM public.portal_login_attempts WHERE id = v_attempt.id;
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_failed_login(
  p_identifier TEXT,
  p_school_id UUID,
  p_attempt_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_count INT;
BEGIN
  INSERT INTO public.portal_login_attempts (identifier, school_id, attempt_type, failed_count, first_failed_at, last_failed_at)
  VALUES (p_identifier, p_school_id, p_attempt_type, 1, now(), now())
  ON CONFLICT (id) DO NOTHING; -- handled via select update below

  SELECT failed_count INTO v_count 
  FROM public.portal_login_attempts 
  WHERE identifier = p_identifier AND attempt_type = p_attempt_type;

  IF FOUND THEN
    v_count := v_count + 1;
    UPDATE public.portal_login_attempts
    SET failed_count = v_count,
        last_failed_at = now(),
        locked_until = CASE WHEN v_count >= 5 THEN now() + interval '15 minutes' ELSE NULL END
    WHERE identifier = p_identifier AND attempt_type = p_attempt_type;
  ELSE
    INSERT INTO public.portal_login_attempts (identifier, school_id, attempt_type, failed_count, first_failed_at, last_failed_at)
    VALUES (p_identifier, p_school_id, p_attempt_type, 1, now(), now());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_failed_login(
  p_identifier TEXT,
  p_attempt_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM public.portal_login_attempts 
  WHERE identifier = p_identifier AND attempt_type = p_attempt_type;
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. Staff Portal Login RPC (Hardened PIN Verification & No Default PIN)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.validate_staff_portal_login(text, text, text);

CREATE OR REPLACE FUNCTION public.validate_staff_portal_login(
  p_school_search TEXT,
  p_phone TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, extensions
AS $$
DECLARE
  v_school_id UUID;
  v_teacher RECORD;
  v_cleaned_phone TEXT;
  v_token UUID;
  v_pin_matches BOOLEAN := FALSE;
  v_throttle_key TEXT;
BEGIN
  -- 1. Resolve school
  SELECT id INTO v_school_id FROM public.schools 
  WHERE id::text = p_school_search 
     OR school_code ILIKE p_school_search 
     OR name ILIKE '%' || p_school_search || '%' 
     OR email ILIKE '%' || p_school_search || '%' 
  LIMIT 1;

  IF v_school_id IS NULL THEN 
    RETURN jsonb_build_object('error', 'Institution not found.'); 
  END IF;

  v_cleaned_phone := REGEXP_REPLACE(p_phone, '[^0-9]', '', 'g');
  v_throttle_key := v_school_id::text || ':' || v_cleaned_phone;

  -- 2. Check rate limit
  BEGIN
    PERFORM public.check_login_throttle(v_throttle_key, v_school_id, 'staff');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', SQLERRM);
  END;

  -- 3. Find teacher
  SELECT id, name, school_id, pin, user_id, on_leave 
  INTO v_teacher 
  FROM public.teachers
  WHERE school_id = v_school_id 
    AND (REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = v_cleaned_phone OR phone = p_phone) 
  LIMIT 1;

  IF v_teacher.id IS NULL THEN
    PERFORM public.record_failed_login(v_throttle_key, v_school_id, 'staff');
    RETURN jsonb_build_object('error', 'Teacher account not found.');
  END IF;

  -- 4. PIN verification (Strict: no default PIN, supports bcrypt and migrates legacy plaintext)
  IF v_teacher.pin IS NULL OR TRIM(v_teacher.pin) = '' THEN
    RETURN jsonb_build_object('error', 'PIN not configured. Please contact school administration to set your Staff PIN.');
  END IF;

  IF v_teacher.pin LIKE '$2%' THEN
    -- Bcrypt hash
    v_pin_matches := (crypt(p_pin, v_teacher.pin) = v_teacher.pin);
  ELSE
    -- Legacy plaintext comparison with automatic upgrade
    IF v_teacher.pin = p_pin THEN
      v_pin_matches := TRUE;
      UPDATE public.teachers 
      SET pin = crypt(p_pin, gen_salt('bf'))
      WHERE id = v_teacher.id;
    END IF;
  END IF;

  IF NOT v_pin_matches THEN
    PERFORM public.record_failed_login(v_throttle_key, v_school_id, 'staff');
    RETURN jsonb_build_object('error', 'Invalid PIN code.');
  END IF;

  -- Login succeeded: clear failures
  PERFORM public.clear_failed_login(v_throttle_key, 'staff');

  -- 5. Issue server-side session token
  INSERT INTO public.portal_sessions (
    school_id,
    role,
    entity_id,
    user_id,
    created_at,
    expires_at
  ) VALUES (
    v_school_id,
    'teacher',
    v_teacher.id,
    v_teacher.user_id,
    now(),
    now() + interval '24 hours'
  ) RETURNING token INTO v_token;

  RETURN jsonb_build_object(
    'token', v_token,
    'id', COALESCE(v_teacher.user_id, v_teacher.id),
    'teacher_record_id', v_teacher.id,
    'user_id', v_teacher.user_id,
    'name', v_teacher.name,
    'role', 'teacher',
    'school_id', v_teacher.school_id
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', 'Authentication error: ' || SQLERRM);
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. Parent Portal Login RPC (Server-Side Session & Sibling Linkage)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.validate_parent_portal_login(text, text, text);

CREATE OR REPLACE FUNCTION public.validate_parent_portal_login(
  p_school_search TEXT,
  p_adm_no TEXT,
  p_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_school_id UUID;
  v_student RECORD;
  v_parent_phone_clean TEXT;
  v_input_phone_clean TEXT;
  v_token UUID;
  v_throttle_key TEXT;
  v_siblings JSONB;
BEGIN
  -- 1. Resolve school
  SELECT id INTO v_school_id FROM public.schools 
  WHERE id::text = p_school_search 
     OR school_code ILIKE p_school_search 
     OR name ILIKE '%' || p_school_search || '%' 
     OR email ILIKE '%' || p_school_search || '%'
  LIMIT 1;

  IF v_school_id IS NULL THEN 
    RETURN jsonb_build_object('error', 'Institution not found.'); 
  END IF;

  v_input_phone_clean := REGEXP_REPLACE(COALESCE(p_phone, ''), '[^0-9]', '', 'g');
  v_throttle_key := v_school_id::text || ':' || v_input_phone_clean;

  -- 2. Check rate limit
  BEGIN
    PERFORM public.check_login_throttle(v_throttle_key, v_school_id, 'parent');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', SQLERRM);
  END;

  -- 3. Find primary student
  SELECT id, name, class, stream, subjects, adm_no, school_id, parent_phone, residence_type, status 
  INTO v_student 
  FROM public.students 
  WHERE school_id = v_school_id AND adm_no ILIKE TRIM(p_adm_no) 
  LIMIT 1;

  IF v_student.id IS NULL THEN 
    PERFORM public.record_failed_login(v_throttle_key, v_school_id, 'parent');
    RETURN jsonb_build_object('error', 'Student not found.'); 
  END IF;

  IF v_student.status IN ('Inactive', 'Graduated', 'Transferred') THEN
    RETURN jsonb_build_object('error', 'Access restricted. Student record is ' || LOWER(v_student.status) || '.');
  END IF;

  -- 4. Verify parent phone matches student guardian phone
  v_parent_phone_clean := REGEXP_REPLACE(COALESCE(v_student.parent_phone, ''), '[^0-9]', '', 'g');

  IF v_parent_phone_clean = '' OR v_parent_phone_clean != v_input_phone_clean THEN
    PERFORM public.record_failed_login(v_throttle_key, v_school_id, 'parent');
    RETURN jsonb_build_object('error', 'Guardian phone does not match our school records.');
  END IF;

  -- Success: clear rate limiting
  PERFORM public.clear_failed_login(v_throttle_key, 'parent');

  -- 5. Issue server-side session token
  INSERT INTO public.portal_sessions (
    school_id,
    role,
    entity_id,
    parent_phone,
    created_at,
    expires_at
  ) VALUES (
    v_school_id,
    'parent',
    v_student.id,
    v_parent_phone_clean,
    now(),
    now() + interval '24 hours'
  ) RETURNING token INTO v_token;

  -- 6. Collect all linked children for this guardian phone
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'class', s.class,
    'stream', COALESCE(s.stream, ''),
    'adm_no', s.adm_no,
    'school_id', s.school_id,
    'residence_type', COALESCE(s.residence_type, 'day'),
    'parent_phone', s.parent_phone
  )), '[]'::jsonb)
  INTO v_siblings
  FROM public.students s
  WHERE s.school_id = v_school_id 
    AND REGEXP_REPLACE(COALESCE(s.parent_phone, ''), '[^0-9]', '', 'g') = v_parent_phone_clean
    AND s.status NOT IN ('Inactive', 'Graduated', 'Transferred');

  RETURN jsonb_build_object(
    'token', v_token,
    'id', v_student.id, 
    'name', v_student.name, 
    'class', v_student.class, 
    'stream', COALESCE(v_student.stream, ''),
    'subjects', COALESCE(v_student.subjects, '[]'::jsonb),
    'adm_no', v_student.adm_no, 
    'school_id', v_student.school_id, 
    'residence_type', COALESCE(v_student.residence_type, 'day'),
    'parent_phone', v_student.parent_phone,
    'linkedChildren', v_siblings
  );
EXCEPTION WHEN OTHERS THEN 
  RETURN jsonb_build_object('error', 'Authentication error: ' || SQLERRM);
END; 
$$;

-- ------------------------------------------------------------------------------
-- 5. Session Verification and Invalidation RPCs
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_verify_session(p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session RECORD;
  v_student RECORD;
  v_teacher RECORD;
  v_siblings JSONB;
BEGIN
  SELECT * INTO v_session 
  FROM public.portal_sessions 
  WHERE token = p_token AND revoked = false AND expires_at > now();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Session expired or invalid.');
  END IF;

  UPDATE public.portal_sessions SET last_active_at = now() WHERE token = p_token;

  IF v_session.role = 'parent' THEN
    SELECT id, name, class, stream, subjects, adm_no, school_id, residence_type, parent_phone, status
    INTO v_student FROM public.students WHERE id = v_session.entity_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'class', s.class,
      'stream', COALESCE(s.stream, ''),
      'adm_no', s.adm_no,
      'school_id', s.school_id,
      'residence_type', COALESCE(s.residence_type, 'day'),
      'parent_phone', s.parent_phone
    )), '[]'::jsonb)
    INTO v_siblings
    FROM public.students s
    WHERE s.school_id = v_session.school_id 
      AND REGEXP_REPLACE(COALESCE(s.parent_phone, ''), '[^0-9]', '', 'g') = v_session.parent_phone
      AND s.status NOT IN ('Inactive', 'Graduated', 'Transferred');

    RETURN jsonb_build_object(
      'valid', true,
      'role', 'parent',
      'school_id', v_session.school_id,
      'id', v_student.id,
      'name', v_student.name,
      'class', v_student.class,
      'stream', COALESCE(v_student.stream, ''),
      'adm_no', v_student.adm_no,
      'parent_phone', v_student.parent_phone,
      'linkedChildren', v_siblings
    );
  ELSIF v_session.role = 'teacher' THEN
    SELECT id, name, school_id, user_id, phone INTO v_teacher 
    FROM public.teachers WHERE id = v_session.entity_id;

    RETURN jsonb_build_object(
      'valid', true,
      'role', 'teacher',
      'school_id', v_session.school_id,
      'id', COALESCE(v_teacher.user_id, v_teacher.id),
      'teacher_record_id', v_teacher.id,
      'user_id', v_teacher.user_id,
      'name', v_teacher.name
    );
  ELSE
    RETURN jsonb_build_object('valid', false, 'error', 'Unsupported session role.');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_logout(p_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE public.portal_sessions 
  SET revoked = true 
  WHERE token = p_token;
  RETURN TRUE;
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. Helper: Validate Authorization for Private RPCs
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_portal_parent_access(p_token UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session RECORD;
  v_student_school UUID;
  v_student_phone TEXT;
BEGIN
  IF p_token IS NULL OR p_student_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_session 
  FROM public.portal_sessions 
  WHERE token = p_token AND role = 'parent' AND revoked = false AND expires_at > now();

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT school_id, REGEXP_REPLACE(COALESCE(parent_phone, ''), '[^0-9]', '', 'g')
  INTO v_student_school, v_student_phone
  FROM public.students
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_student_school != v_session.school_id THEN
    RETURN FALSE;
  END IF;

  -- Allow if child is primary session child or phone matches session guardian phone
  RETURN (v_student_phone = v_session.parent_phone OR p_student_id = v_session.entity_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_portal_teacher_access(p_token UUID, p_teacher_id UUID DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session RECORD;
BEGIN
  IF p_token IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_session 
  FROM public.portal_sessions 
  WHERE token = p_token AND role = 'teacher' AND revoked = false AND expires_at > now();

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF p_teacher_id IS NOT NULL THEN
    RETURN (v_session.entity_id = p_teacher_id OR v_session.user_id = p_teacher_id);
  END IF;

  RETURN TRUE;
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. Private Parent Portal Data RPCs
-- ------------------------------------------------------------------------------

-- 7.1 Student Profile
DROP FUNCTION IF EXISTS public.portal_get_student_profile(uuid, uuid);
DROP FUNCTION IF EXISTS public.portal_get_student_profile(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_profile(
  p_student_id UUID, 
  p_school_id UUID DEFAULT NULL, 
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT public.validate_portal_parent_access(p_token, p_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: Access denied to student profile.';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(s.*), '[]'::jsonb)
    FROM public.students s
    WHERE s.id = p_student_id
  );
END;
$$;

-- 7.2 Released Exam Results Only
DROP FUNCTION IF EXISTS public.portal_get_student_results_v2(uuid, uuid);
DROP FUNCTION IF EXISTS public.portal_get_student_results_v2(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_results_v2(
  p_student_id UUID, 
  p_school_id UUID DEFAULT NULL, 
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT public.validate_portal_parent_access(p_token, p_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: Access denied to student exam results.';
  END IF;

  -- Only return results where the exam is published and officially released to parents
  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', er.id,
        'exam_id', er.exam_id,
        'student_id', er.student_id,
        'total_marks', er.total_marks,
        'mean_score', er.mean_score,
        'class_position', er.class_position,
        'stream_position', er.stream_position,
        'class_size', er.class_size,
        'stream_size', er.stream_size,
        'exam_name', e.name,
        'exam_term', e.term,
        'exam_type', e.exam_type,
        'academic_year', e.academic_year
      ) ORDER BY e.created_at DESC
    ), '[]'::jsonb)
    FROM public.exam_results er
    JOIN public.exams e ON er.exam_id = e.id
    WHERE er.student_id = p_student_id
      AND (
        e.status = 'published' 
        OR (er.released_to_parents IS TRUE)
      )
  );
END;
$$;

-- 7.3 Student Fees & Payments (Reconciled with Admin Ledger)
DROP FUNCTION IF EXISTS public.portal_get_student_fees(uuid, uuid);
DROP FUNCTION IF EXISTS public.portal_get_student_fees(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_fees(
  p_student_id UUID,
  p_period_id UUID DEFAULT NULL,
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fee RECORD;
  v_payments JSONB;
BEGIN
  IF NOT public.validate_portal_parent_access(p_token, p_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: Access denied to student fees.';
  END IF;

  SELECT * INTO v_fee 
  FROM public.fees 
  WHERE student_id = p_student_id 
  LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', fp.id,
    'amount', fp.amount,
    'date', fp.date,
    'method', fp.method,
    'reference', fp.reference,
    'receipt_number', fp.receipt_number
  ) ORDER BY fp.date DESC), '[]'::jsonb)
  INTO v_payments
  FROM public.fee_payments fp
  WHERE fp.fee_id = v_fee.id;

  RETURN jsonb_build_object(
    'id', v_fee.id,
    'student_id', p_student_id,
    'billed', COALESCE(v_fee.total_fee, 0),
    'paid', COALESCE(v_fee.paid, 0),
    'balance', COALESCE(v_fee.balance, 0),
    'payments', COALESCE(v_payments, '[]'::jsonb)
  );
END;
$$;

-- 7.4 Student Books
DROP FUNCTION IF EXISTS public.portal_get_student_books(uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_books(
  p_student_id UUID,
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT public.validate_portal_parent_access(p_token, p_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: Access denied to student books.';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', bi.id,
      'book_id', b.id,
      'title', b.title,
      'author', b.author,
      'issue_date', bi.issue_date,
      'due_date', bi.due_date,
      'status', bi.status
    )), '[]'::jsonb)
    FROM public.book_issues bi
    JOIN public.books b ON b.id = bi.book_id
    WHERE bi.student_id = p_student_id
      AND bi.status != 'returned'
  );
END;
$$;

-- 7.5 Student E-Learning Assignments
CREATE OR REPLACE FUNCTION public.portal_get_student_assignments(
  p_student_id UUID,
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_class_id UUID;
  v_student_class TEXT;
  v_school_id UUID;
BEGIN
  IF NOT public.validate_portal_parent_access(p_token, p_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: Access denied to student assignments.';
  END IF;

  SELECT school_id, class INTO v_school_id, v_student_class
  FROM public.students WHERE id = p_student_id;

  SELECT id INTO v_class_id 
  FROM public.classes 
  WHERE school_id = v_school_id AND name = v_student_class
  LIMIT 1;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'description', a.description,
      'due_date', a.due_date,
      'max_score', a.max_score,
      'submission_type', a.submission_type,
      'status', a.status,
      'submission', (
        SELECT jsonb_build_object(
          'id', s.id,
          'status', s.status,
          'submitted_at', s.submitted_at,
          'score', s.score
        )
        FROM public.el_submissions s
        WHERE s.assignment_id = a.id AND s.student_id = p_student_id
        LIMIT 1
      )
    )), '[]'::jsonb)
    FROM public.el_assignments a
    WHERE a.school_id = v_school_id
      AND (a.class_id = v_class_id OR a.class_id IS NULL)
      AND a.status = 'published'
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 8. Teacher Portal RPCs (Exam Discovery, Papers, Mark Entry Authorization)
-- ------------------------------------------------------------------------------

-- 8.1 Get Open Exams for Authenticated Teacher
CREATE OR REPLACE FUNCTION public.portal_get_open_exams_for_teacher(p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session RECORD;
BEGIN
  SELECT * INTO v_session 
  FROM public.portal_sessions 
  WHERE token = p_token AND role = 'teacher' AND revoked = false AND expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized: Invalid teacher session.';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', e.id,
      'name', e.name,
      'term', e.term,
      'exam_type', e.exam_type,
      'academic_year', e.academic_year,
      'status', e.status
    ) ORDER BY e.created_at DESC), '[]'::jsonb)
    FROM public.exams e
    WHERE e.school_id = v_session.school_id
      AND e.status IN ('open', 'active')
      AND EXISTS (
        SELECT 1 FROM public.exam_papers ep
        WHERE ep.exam_id = e.id
          AND (
            ep.teacher_id = v_session.entity_id 
            OR ep.teacher_id = v_session.user_id
            OR EXISTS (
              SELECT 1 FROM public.teacher_assignments ta
              WHERE ta.school_id = v_session.school_id
                AND ta.teacher_id = v_session.entity_id
                AND ta.subject_id = ep.subject_id
            )
          )
      )
  );
END;
$$;

-- 8.2 Get Papers Assigned to Teacher for an Exam
DROP FUNCTION IF EXISTS public.portal_get_teacher_papers(uuid, uuid);
DROP FUNCTION IF EXISTS public.portal_get_teacher_papers(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_teacher_papers(
  p_exam_id UUID,
  p_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session RECORD;
BEGIN
  SELECT * INTO v_session 
  FROM public.portal_sessions 
  WHERE token = p_token AND role = 'teacher' AND revoked = false AND expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized: Invalid teacher session.';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', ep.id,
      'exam_id', ep.exam_id,
      'class_id', ep.class_id,
      'subject_id', ep.subject_id,
      'max_score', ep.max_score,
      'out_of', ep.out_of,
      'marks_entered', ep.marks_entered,
      'classes', jsonb_build_object('name', c.name, 'stream', c.stream),
      'tt_subjects', jsonb_build_object('name', ts.name)
    )), '[]'::jsonb)
    FROM public.exam_papers ep
    JOIN public.classes c ON c.id = ep.class_id
    JOIN public.tt_subjects ts ON ts.id = ep.subject_id
    WHERE ep.exam_id = p_exam_id
      AND ep.school_id = v_session.school_id
      AND (
        ep.teacher_id = v_session.entity_id 
        OR ep.teacher_id = v_session.user_id
        OR EXISTS (
          SELECT 1 FROM public.teacher_assignments ta
          WHERE ta.school_id = v_session.school_id
            AND ta.teacher_id = v_session.entity_id
            AND ta.subject_id = ep.subject_id
        )
      )
  );
END;
$$;

-- 8.3 Save Exam Marks with Full Server-Side Batch Authorization
DROP FUNCTION IF EXISTS public.portal_save_exam_marks(jsonb);
DROP FUNCTION IF EXISTS public.portal_save_exam_marks(jsonb, uuid);
DROP FUNCTION IF EXISTS public.portal_save_exam_marks(uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.portal_save_exam_marks(
  p_paper_id UUID,
  p_marks JSONB,
  p_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session RECORD;
  v_paper RECORD;
  v_exam RECORD;
  v_mark RECORD;
  v_saved_count INT := 0;
  v_raw_score DECIMAL;
  v_is_absent BOOLEAN;
  v_student_id UUID;
  v_student_exists BOOLEAN;
BEGIN
  -- 1. Validate session
  SELECT * INTO v_session 
  FROM public.portal_sessions 
  WHERE token = p_token AND role IN ('teacher', 'admin') AND revoked = false AND expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized: Valid teacher or administrator session required.';
  END IF;

  -- 2. Validate paper & school
  SELECT ep.*, ts.name as subject_name 
  INTO v_paper 
  FROM public.exam_papers ep
  JOIN public.tt_subjects ts ON ts.id = ep.subject_id
  WHERE ep.id = p_paper_id AND ep.school_id = v_session.school_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam paper not found or does not belong to this institution.';
  END IF;

  -- 3. Validate exam status
  SELECT * INTO v_exam FROM public.exams WHERE id = v_paper.exam_id;
  IF v_exam.status NOT IN ('open', 'active', 'setup') AND v_session.role != 'admin' THEN
    RAISE EXCEPTION 'Mark entry is closed for this exam (Status: %).', v_exam.status;
  END IF;

  -- 4. Validate teacher assignment (unless admin)
  IF v_session.role = 'teacher' THEN
    IF v_paper.teacher_id != v_session.entity_id 
       AND v_paper.teacher_id != v_session.user_id 
       AND NOT EXISTS (
         SELECT 1 FROM public.teacher_assignments ta
         WHERE ta.school_id = v_session.school_id
           AND ta.teacher_id = v_session.entity_id
           AND ta.subject_id = v_paper.subject_id
       ) THEN
      RAISE EXCEPTION 'Forbidden: You are not assigned to grade this exam paper.';
    END IF;
  END IF;

  -- 5. Batch validate and upsert marks
  FOR v_mark IN SELECT * FROM jsonb_to_recordset(p_marks) AS x(student_id UUID, raw_score DECIMAL, is_absent BOOLEAN, remarks TEXT)
  LOOP
    v_student_id := v_mark.student_id;
    v_is_absent := COALESCE(v_mark.is_absent, false);
    v_raw_score := v_mark.raw_score;

    -- Validate student belongs to this school
    SELECT EXISTS (SELECT 1 FROM public.students WHERE id = v_student_id AND school_id = v_session.school_id)
    INTO v_student_exists;

    IF NOT v_student_exists THEN
      RAISE EXCEPTION 'Student % does not belong to this institution.', v_student_id;
    END IF;

    -- Score boundaries validation
    IF NOT v_is_absent AND v_raw_score IS NOT NULL THEN
      IF v_raw_score < 0 OR v_raw_score > v_paper.max_score THEN
        RAISE EXCEPTION 'Score % is out of bounds (allowed: 0 - %).', v_raw_score, v_paper.max_score;
      END IF;
    END IF;

    INSERT INTO public.exam_marks (
      exam_paper_id,
      student_id,
      school_id,
      raw_score,
      is_absent,
      remarks,
      entered_by,
      entered_at,
      updated_at
    ) VALUES (
      p_paper_id,
      v_student_id,
      v_session.school_id,
      CASE WHEN v_is_absent THEN NULL ELSE v_raw_score END,
      v_is_absent,
      v_mark.remarks,
      v_session.user_id,
      now(),
      now()
    )
    ON CONFLICT (exam_paper_id, student_id) DO UPDATE SET
      raw_score = EXCLUDED.raw_score,
      is_absent = EXCLUDED.is_absent,
      remarks = EXCLUDED.remarks,
      updated_by = v_session.user_id,
      updated_at = now();

    v_saved_count := v_saved_count + 1;
  END LOOP;

  -- Update marks_entered count on paper
  UPDATE public.exam_papers 
  SET marks_entered = (SELECT COUNT(*) FROM public.exam_marks WHERE exam_paper_id = p_paper_id AND (raw_score IS NOT NULL OR is_absent = true))
  WHERE id = p_paper_id;

  RETURN jsonb_build_object(
    'success', true,
    'saved_count', v_saved_count,
    'paper_id', p_paper_id
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 9. Canonical Marks Pipeline: Bidirectional Database Triggers
-- ------------------------------------------------------------------------------

-- 9.1 Sync from exam_marks to marks (Legacy Table Synchronization)
CREATE OR REPLACE FUNCTION public.fn_sync_exam_marks_to_marks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_paper RECORD;
  v_exam RECORD;
  v_mark_val INTEGER;
BEGIN
  -- Resolve exam paper, subject name, exam name and term
  SELECT ep.*, ts.name as subject_name 
  INTO v_paper
  FROM public.exam_papers ep
  JOIN public.tt_subjects ts ON ts.id = ep.subject_id
  WHERE ep.id = NEW.exam_paper_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_paper.exam_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Map score to legacy sentinel codes (-1 ABS, -2 MISSING, -3 EXEMPT)
  IF NEW.is_absent THEN
    v_mark_val := -1;
  ELSIF NEW.raw_score IS NOT NULL THEN
    v_mark_val := ROUND(NEW.raw_score)::INTEGER;
  ELSE
    v_mark_val := NULL;
  END IF;

  -- Upsert to marks table
  INSERT INTO public.marks (
    school_id,
    student_id,
    subject,
    mark,
    exam_type,
    created_by
  ) VALUES (
    NEW.school_id,
    NEW.student_id,
    v_paper.subject_name,
    v_mark_val,
    v_exam.name,
    NEW.entered_by
  )
  ON CONFLICT (school_id, student_id, subject, period_id, exam_type)
  DO UPDATE SET 
    mark = EXCLUDED.mark;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_exam_marks_to_marks ON public.exam_marks;
CREATE TRIGGER trg_sync_exam_marks_to_marks
AFTER INSERT OR UPDATE ON public.exam_marks
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_exam_marks_to_marks();

-- 9.2 Sync from marks to exam_marks (Admin Scoreboard to Structured Storage)
CREATE OR REPLACE FUNCTION public.fn_sync_marks_to_exam_marks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_student RECORD;
  v_class RECORD;
  v_subject RECORD;
  v_exam RECORD;
  v_paper_id UUID;
  v_is_absent BOOLEAN := FALSE;
  v_raw DECIMAL := NULL;
BEGIN
  -- Avoid infinite recursive trigger
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  SELECT id, class, school_id INTO v_student FROM public.students WHERE id = NEW.student_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Find class record
  SELECT id INTO v_class FROM public.classes WHERE school_id = NEW.school_id AND name = v_student.class LIMIT 1;
  -- Find subject record
  SELECT id INTO v_subject FROM public.tt_subjects WHERE school_id = NEW.school_id AND name = NEW.subject LIMIT 1;
  -- Find exam record
  SELECT id INTO v_exam FROM public.exams WHERE school_id = NEW.school_id AND (name = NEW.exam_type OR exam_type = NEW.exam_type) LIMIT 1;

  IF v_class.id IS NOT NULL AND v_subject.id IS NOT NULL AND v_exam.id IS NOT NULL THEN
    -- Find or create exam paper
    SELECT id INTO v_paper_id FROM public.exam_papers 
    WHERE exam_id = v_exam.id AND class_id = v_class.id AND subject_id = v_subject.id;

    IF v_paper_id IS NULL THEN
      INSERT INTO public.exam_papers (exam_id, school_id, class_id, subject_id, max_score, out_of)
      VALUES (v_exam.id, NEW.school_id, v_class.id, v_subject.id, 100, 100)
      RETURNING id INTO v_paper_id;
    END IF;

    IF NEW.mark = -1 THEN
      v_is_absent := TRUE;
      v_raw := NULL;
    ELSIF NEW.mark IS NOT NULL AND NEW.mark >= 0 THEN
      v_is_absent := FALSE;
      v_raw := NEW.mark;
    ELSE
      v_is_absent := FALSE;
      v_raw := NULL;
    END IF;

    INSERT INTO public.exam_marks (
      exam_paper_id,
      student_id,
      school_id,
      raw_score,
      is_absent,
      entered_by,
      entered_at,
      updated_at
    ) VALUES (
      v_paper_id,
      NEW.student_id,
      NEW.school_id,
      v_raw,
      v_is_absent,
      NEW.created_by,
      now(),
      now()
    )
    ON CONFLICT (exam_paper_id, student_id) DO UPDATE SET
      raw_score = EXCLUDED.raw_score,
      is_absent = EXCLUDED.is_absent,
      updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_marks_to_exam_marks ON public.marks;
CREATE TRIGGER trg_sync_marks_to_exam_marks
AFTER INSERT OR UPDATE ON public.marks
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_marks_to_exam_marks();

-- ------------------------------------------------------------------------------
-- 10. Explicit Security Permissions & Grants
-- ------------------------------------------------------------------------------
-- Revoke all default public access from tables
REVOKE ALL ON public.portal_sessions FROM PUBLIC, anon;
REVOKE ALL ON public.portal_login_attempts FROM PUBLIC, anon;

-- Revoke all default PUBLIC execution permissions on sensitive private RPCs
REVOKE ALL ON FUNCTION public.portal_verify_session(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_logout(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_get_open_exams_for_teacher(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_get_teacher_papers(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_save_exam_marks(UUID, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_portal_parent_access(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_portal_teacher_access(UUID, UUID, UUID) FROM PUBLIC;

-- Grant execution on verified boundary RPCs
GRANT EXECUTE ON FUNCTION public.validate_staff_portal_login(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_parent_portal_login(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_verify_session(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_logout(uuid) TO anon, authenticated;

-- Private RPCs (Token validated internally)
GRANT EXECUTE ON FUNCTION public.portal_get_student_profile(uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_student_results_v2(uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_student_fees(uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_student_books(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_student_assignments(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_open_exams_for_teacher(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_teacher_papers(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_save_exam_marks(uuid, jsonb, uuid) TO anon, authenticated;

-- Alias: portal_get_student_fee_summary
DROP FUNCTION IF EXISTS public.portal_get_student_fee_summary(uuid, uuid);
DROP FUNCTION IF EXISTS public.portal_get_student_fee_summary(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_fee_summary(
  p_student_id UUID,
  p_school_id UUID DEFAULT NULL,
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.portal_get_student_fees(p_student_id, NULL, p_token);
END;
$$;

GRANT EXECUTE ON FUNCTION public.portal_get_student_fee_summary(uuid, uuid, uuid) TO anon, authenticated;
