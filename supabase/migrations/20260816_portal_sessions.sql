-- ==============================================================================
-- Migration: Portal Session Tokens (Fixing systemic IDOR)
-- ==============================================================================

-- 1. Create the session table
CREATE TABLE IF NOT EXISTS public.portal_sessions (
  token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('student', 'teacher')),
  school_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT now() + interval '24 hours'
);

-- Completely lock down the table from direct client access
ALTER TABLE public.portal_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny all" ON public.portal_sessions;
CREATE POLICY "Deny all" ON public.portal_sessions FOR ALL USING (false);

-- 2. Helper function to validate sessions
CREATE OR REPLACE FUNCTION public.validate_portal_session(p_token UUID, p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid BOOLEAN;
BEGIN
  SELECT TRUE INTO v_valid
  FROM public.portal_sessions
  WHERE token = p_token 
    AND entity_id = p_entity_id 
    AND expires_at > now();
    
  RETURN COALESCE(v_valid, FALSE);
END;
$$;

-- -- 3. Updated Staff Login Function (generates session token)
CREATE OR REPLACE FUNCTION public.validate_staff_portal_login(p_school_search TEXT, p_phone TEXT, p_pin TEXT)
RETURNS JSONB 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_school_id UUID; v_school_name TEXT; v_teacher RECORD; v_cleaned_phone TEXT;
  v_token UUID;
BEGIN
  SELECT id, name INTO v_school_id, v_school_name FROM public.schools 
  WHERE id::text = p_school_search OR school_code ILIKE p_school_search 
     OR name ILIKE '%' || p_school_search || '%' OR email ILIKE '%' || p_school_search || '%' LIMIT 1;
  IF v_school_id IS NULL THEN RETURN jsonb_build_object('error', 'Institution not found.'); END IF;
  v_cleaned_phone := REGEXP_REPLACE(p_phone, '[^0-9]', '', 'g');
  SELECT id, name, school_id, pin, user_id INTO v_teacher FROM public.teachers
  WHERE school_id = v_school_id AND (phone = v_cleaned_phone OR phone = p_phone) LIMIT 1;
  IF v_teacher.id IS NULL THEN RETURN jsonb_build_object('error', 'Teacher account not found.'); END IF;
  IF COALESCE(v_teacher.pin, '1234') != p_pin THEN RETURN jsonb_build_object('error', 'Invalid PIN code.'); END IF;

  -- Generate a session token
  INSERT INTO public.portal_sessions (entity_id, entity_type, school_id)
  VALUES (v_teacher.id, 'teacher', v_school_id) RETURNING token INTO v_token;

  RETURN jsonb_build_object(
    'token', v_token,
    'id', COALESCE(v_teacher.user_id, v_teacher.id),
    'teacher_record_id', v_teacher.id,
    'user_id', v_teacher.user_id,
    'name', v_teacher.name,
    'role', 'teacher',
    'school_id', v_teacher.school_id
  );
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error', 'Auth Error: ' || SQLERRM);
END; $$;

-- 4. Updated Parent Login Function (generates session token)
CREATE OR REPLACE FUNCTION public.validate_parent_portal_login(p_school_search TEXT, p_adm_no TEXT, p_phone TEXT)
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
  v_class_id UUID;
  v_token UUID;
BEGIN
  SELECT id INTO v_school_id FROM public.schools 
  WHERE id::text = p_school_search OR school_code ILIKE p_school_search 
    OR name ILIKE '%' || p_school_search || '%' 
    OR email ILIKE '%' || p_school_search || '%'
  LIMIT 1;
  IF v_school_id IS NULL THEN RETURN jsonb_build_object('error', 'Institution not found.'); END IF;
  
  SELECT id, name, class, stream, subjects, adm_no, school_id, parent_phone, residence_type, status 
  INTO v_student FROM public.students 
  WHERE school_id = v_school_id AND adm_no ILIKE p_adm_no LIMIT 1;
  IF v_student.id IS NULL THEN RETURN jsonb_build_object('error', 'Student not found.'); END IF;

  IF v_student.status = 'Inactive' OR v_student.status = 'Graduated' OR v_student.status = 'Transferred' THEN
    RETURN jsonb_build_object('error', 'Access restricted. This account is marked as ' || COALESCE(v_student.status, 'inactive') || '.');
  END IF;
  
  SELECT id INTO v_class_id FROM public.classes WHERE school_id = v_school_id AND name = v_student.class LIMIT 1;
  
  v_parent_phone_clean := REGEXP_REPLACE(COALESCE(v_student.parent_phone, ''), '[^0-9]', '', 'g');
  v_input_phone_clean := REGEXP_REPLACE(COALESCE(p_phone, ''), '[^0-9]', '', 'g');
  
  IF v_parent_phone_clean != v_input_phone_clean THEN 
    RETURN jsonb_build_object('error', 'Phone check failed. Guardian phone does not match our records.'); 
  END IF;

  -- Generate a session token
  INSERT INTO public.portal_sessions (entity_id, entity_type, school_id)
  VALUES (v_student.id, 'student', v_school_id) RETURNING token INTO v_token;
  
  RETURN jsonb_build_object(
    'token', v_token,
    'id', v_student.id, 
    'name', v_student.name, 
    'class', v_student.class, 
    'stream', COALESCE(v_student.stream, ''),
    'subjects', COALESCE(v_student.subjects, '[]'::jsonb),
    'class_id', v_class_id, 
    'adm_no', v_student.adm_no, 
    'school_id', v_student.school_id, 
    'residence_type', COALESCE(v_student.residence_type, 'day'),
    'parent_phone', COALESCE(v_student.parent_phone, '')
  );
EXCEPTION WHEN OTHERS THEN 
  RETURN jsonb_build_object('error', 'DB Error: ' || SQLERRM);
END; 
$$;

-- Auto-generated secure wrappers for portal RPCs

DROP FUNCTION IF EXISTS public.portal_get_teacher_papers(p_teacher_id UUID, p_exam_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_teacher_papers(p_teacher_id UUID, p_exam_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_teacher_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ep.id, 'class_id', ep.class_id, 'subject_id', ep.subject_id, 'classes', jsonb_build_object('name', c.name, 'stream', c.stream), 'tt_subjects', jsonb_build_object('name', ts.name))), '[]'::jsonb) FROM public.exam_papers ep JOIN public.classes c ON c.id = ep.class_id JOIN public.tt_subjects ts ON ts.id = ep.subject_id WHERE (ep.teacher_id = p_teacher_id OR ep.teacher_id IN (SELECT user_id FROM public.teachers WHERE id = p_teacher_id)) AND ep.exam_id = p_exam_id);
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_student_payments(p_student_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_student_payments(p_student_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'amount', p.amount,
      'date', p.date, -- Now returns full timestamp
      'method', p.method,
      'reference', p.reference
    ) ORDER BY p.date DESC), '[]'::jsonb)
    FROM public.fee_payments p
    JOIN public.fees f ON f.id = p.fee_id
    WHERE f.student_id = p_student_id
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_school_profile(p_school_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_school_profile(p_school_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(sp.*), '[]'::jsonb) 
    FROM public.school_profiles sp 
    WHERE school_id = p_school_id LIMIT 1
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_periods(p_school_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_periods(p_school_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
    FROM (
      SELECT id, year, term, is_active, school_id 
      FROM public.academic_periods 
      WHERE school_id = p_school_id 
      ORDER BY year DESC, term DESC
    ) t
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_exams(p_school_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_exams(p_school_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'term', term, 'exam_type', exam_type, 'status', status, 'school_id', school_id, 'created_at', created_at)), '[]'::jsonb)
  FROM public.exams WHERE school_id = p_school_id AND status NOT ILIKE 'Draft' ORDER BY created_at DESC);
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_announcements(p_school_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_announcements(p_school_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'status', a.status, 'created_at', a.created_at, 'author_name', u.name)), '[]'::jsonb)
  FROM public.announcements a LEFT JOIN public.users u ON u.id = a.created_by
  WHERE a.school_id = p_school_id AND a.status ILIKE 'published' ORDER BY a.created_at DESC);
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_student_results(p_student_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_student_results(p_student_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', er.id, 'mean_score', er.mean_score, 'total_marks', er.total_marks, 'total_subjects', er.total_subjects, 'class_position', er.class_position, 'class_size', er.class_size, 'exams', jsonb_build_object('name', e.name, 'term', e.term, 'exam_type', e.exam_type))), '[]'::jsonb) FROM public.exam_results er JOIN public.exams e ON e.id = er.exam_id WHERE er.student_id = p_student_id AND e.status = 'published');
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_student_fees(p_student_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_student_fees(p_student_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (SELECT jsonb_build_object('id', f.id, 'total_fee', f.total_fee, 'paid', f.paid, 'balance', f.balance) FROM public.fees f WHERE f.student_id = p_student_id ORDER BY f.created_at DESC LIMIT 1);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_teacher_timetable(p_school_id UUID, p_period_id UUID, p_teacher_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_teacher_timetable(p_school_id UUID, p_period_id UUID, p_teacher_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_teacher_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (
    WITH unique_slots AS (
      SELECT DISTINCT ON (day_of_week, slot_index, subject, class_grade, stream)
        id, day_of_week, slot_index, subject, class_grade, stream, start_time, end_time
      FROM public.timetable_slots 
      WHERE school_id = p_school_id AND period_id = p_period_id 
        AND (
          teacher_id = p_teacher_id 
          OR teacher_id IN (SELECT user_id FROM teachers WHERE id = p_teacher_id)
          OR teacher_id IN (SELECT id FROM teachers WHERE user_id = p_teacher_id)
        )
      ORDER BY day_of_week, slot_index, subject, class_grade, stream, id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'day_of_week', day_of_week, 'slot_index', slot_index, 'subject', subject, 
      'class_grade', class_grade, 'stream', stream, 'start_time', start_time, 'end_time', end_time
    ) ORDER BY slot_index ASC), '[]'::jsonb)
    FROM unique_slots
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_timetable_config(p_school_id UUID, p_period_id UUID, p_class_level TEXT);

CREATE OR REPLACE FUNCTION public.portal_get_timetable_config(p_school_id UUID, p_period_id UUID, p_token UUID, p_class_level TEXT DEFAULT 'Global')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 
      'slot_index', slot_index, 
      'start_time', start_time, 
      'end_time', end_time, 
      'label', label,
      'name', label,
      'is_break', is_break,
      'class_level', class_level
    ) ORDER BY slot_index ASC), '[]'::jsonb)
    FROM public.timetable_configs 
    WHERE school_id = p_school_id 
      AND period_id = p_period_id
      AND (
        class_level = p_class_level 
        OR (class_level IS NULL AND NOT EXISTS (SELECT 1 FROM public.timetable_configs WHERE school_id = p_school_id AND period_id = p_period_id AND class_level = p_class_level))
      )
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_student_profile(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_profile(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (
        SELECT jsonb_build_object('id', id, 'name', name, 'adm_no', adm_no, 'class', class, 'stream', stream, 'gender', gender, 'parent', parent, 'parent_phone', parent_phone, 'parent_name', parent)
        FROM public.students
        WHERE id = p_student_id AND school_id = p_school_id
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_teacher_assignments(p_school_id UUID, p_period_id UUID, p_teacher_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_teacher_assignments(p_school_id UUID, p_period_id UUID, p_teacher_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_teacher_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(DISTINCT assignments), '[]'::jsonb)
    FROM (
      -- a) New Unified Table
      SELECT jsonb_build_object(
        'id', ta.id, 
        'class_grade', cs.level, 
        'stream', cs.name, 
        'subject', ta.subject,
        'table', 'teacher_assignments'
      ) as assignments
      FROM public.teacher_assignments ta
      JOIN public.class_streams cs ON ta.stream_id = cs.id
      WHERE ta.school_id = p_school_id 
        AND ta.period_id = p_period_id
        AND ta.is_active = true
        AND (
          ta.teacher_id = p_teacher_id 
          OR ta.teacher_id IN (SELECT id FROM public.teachers WHERE id = p_teacher_id OR user_id = p_teacher_id)
          OR ta.teacher_id IN (SELECT user_id FROM public.teachers WHERE id = p_teacher_id OR user_id = p_teacher_id)
        )
      
      UNION ALL
      
      -- b) Legacy Table
      SELECT jsonb_build_object(
        'id', sa.id, 
        'class_grade', sa.class_grade, 
        'stream', sa.stream, 
        'subject', sa.subject,
        'table', 'subject_assignments'
      ) as assignments
      FROM public.subject_assignments sa
      WHERE sa.school_id = p_school_id 
        AND sa.period_id = p_period_id
        AND (
          sa.teacher_id = p_teacher_id 
          OR sa.teacher_id IN (SELECT id FROM public.teachers WHERE id = p_teacher_id OR user_id = p_teacher_id)
          OR sa.teacher_id IN (SELECT user_id FROM public.teachers WHERE id = p_teacher_id OR user_id = p_teacher_id)
        )
    ) sub
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_teacher_workload(p_school_id UUID, p_period_id UUID, p_teacher_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_teacher_workload(p_school_id UUID, p_period_id UUID, p_teacher_id UUID, p_token UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  IF NOT public.validate_portal_session(p_token, p_teacher_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  SELECT COUNT(*) INTO v_count FROM public.timetable_slots 
  WHERE school_id = p_school_id AND period_id = p_period_id 
    AND (
      teacher_id = p_teacher_id 
      OR teacher_id IN (SELECT user_id FROM teachers WHERE id = p_teacher_id)
      OR teacher_id IN (SELECT id FROM teachers WHERE user_id = p_teacher_id)
    );
  RETURN COALESCE(v_count, 0);
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_open_exams(p_school_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_open_exams(p_school_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (SELECT id, name, term, status FROM public.exams WHERE school_id = p_school_id AND status = 'open') t);
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_exam_papers(p_exam_id UUID, p_teacher_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_exam_papers(p_exam_id UUID, p_teacher_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_teacher_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
    FROM (
      SELECT 
        ep.id, ep.exam_id, ep.class_id, ep.subject_id, ep.max_score, ep.out_of,
        jsonb_build_object('name', c.name, 'stream', c.stream) as classes,
        jsonb_build_object('name', s.name) as tt_subjects
      FROM public.exam_papers ep
      JOIN public.classes c ON c.id = ep.class_id
      JOIN public.tt_subjects s ON s.id = ep.subject_id
      WHERE ep.exam_id = p_exam_id AND ep.teacher_id = p_teacher_id
    ) t
  );
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_subject_details(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_subject_details(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_student_subjects JSONB;
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  -- Get subjects array from student record
    SELECT subjects INTO v_student_subjects 
    FROM public.students 
    WHERE id = p_student_id AND school_id = p_school_id;

    -- Return full details from tt_subjects, filtering by the student's subjects array
    -- if it exists, otherwise return subjects where the student has marks
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', sub.id,
                'name', sub.name,
                'code', sub.short_code
            )
        ), '[]'::jsonb)
        FROM public.tt_subjects sub
        WHERE sub.school_id = p_school_id
          AND (
            (v_student_subjects IS NOT NULL AND jsonb_array_length(v_student_subjects) > 0 AND v_student_subjects ? sub.name)
            OR
            EXISTS (SELECT 1 FROM public.marks m WHERE m.student_id = p_student_id AND m.subject = sub.name)
          )
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_ensure_teacher_papers(
    p_teacher_id uuid,
    p_exam_id uuid,
    p_school_id uuid
);

CREATE OR REPLACE FUNCTION public.portal_ensure_teacher_papers(
    p_teacher_id uuid,
    p_exam_id uuid,
    p_school_id uuid
, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_paper RECORD;
BEGIN
  IF NOT public.validate_portal_session(p_token, p_teacher_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  -- 1. Insert missing papers from legacy subject_assignments
    -- We map class_grade -> classes.name and subject -> tt_subjects.name
    INSERT INTO public.exam_papers (exam_id, school_id, class_id, subject_id, teacher_id)
    SELECT 
        p_exam_id, 
        p_school_id, 
        c.id, 
        ts.id, 
        p_teacher_id
    FROM public.subject_assignments sa
    JOIN public.classes c ON (c.school_id = sa.school_id AND c.name = sa.class_grade AND c.stream = sa.stream)
    JOIN public.tt_subjects ts ON (ts.school_id = sa.school_id AND ts.name = sa.subject)
    WHERE sa.school_id = p_school_id
      AND (sa.teacher_id = p_teacher_id OR sa.teacher_id IN (SELECT id FROM teachers WHERE user_id = p_teacher_id))
    ON CONFLICT (exam_id, class_id, subject_id) DO UPDATE 
    SET teacher_id = EXCLUDED.teacher_id
    WHERE public.exam_papers.teacher_id IS NULL;

    -- 2. Also check new tt_teacher_subjects table just in case
    INSERT INTO public.exam_papers (exam_id, school_id, class_id, subject_id, teacher_id)
    SELECT 
        p_exam_id, 
        p_school_id, 
        tts.class_id, 
        tts.subject_id, 
        p_teacher_id
    FROM public.tt_teacher_subjects tts
    WHERE tts.school_id = p_school_id
      AND (tts.teacher_id = p_teacher_id OR tts.teacher_id IN (SELECT id FROM users WHERE auth_user_id = p_teacher_id))
    ON CONFLICT (exam_id, class_id, subject_id) DO UPDATE 
    SET teacher_id = EXCLUDED.teacher_id
    WHERE public.exam_papers.teacher_id IS NULL;

    -- 3. Return the papers
    RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', ep.id,
            'exam_id', ep.exam_id,
            'class_id', ep.class_id,
            'subject_id', ep.subject_id,
            'max_score', ep.max_score,
            'marks_entered', ep.marks_entered,
            'classes', jsonb_build_object('name', c.name, 'stream', c.stream),
            'tt_subjects', jsonb_build_object('name', ts.name)
        )), '[]'::jsonb)
        FROM public.exam_papers ep
        LEFT JOIN public.classes c ON c.id = ep.class_id
        LEFT JOIN public.tt_subjects ts ON ts.id = ep.subject_id
        WHERE ep.exam_id = p_exam_id
          AND ep.teacher_id = p_teacher_id
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_class_marks(
    p_school_id uuid,
    p_class_name text,
    p_subject text,
    p_exam_type text
);

CREATE OR REPLACE FUNCTION public.portal_get_class_marks(
    p_school_id uuid,
    p_class_name text,
    p_subject text,
    p_exam_type text
, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'student_id', m.student_id,
            'raw_score', m.mark,
            'is_absent', false
        )), '[]'::jsonb)
        FROM public.marks m
        JOIN public.students s ON s.id = m.student_id
        WHERE m.school_id = p_school_id
          AND m.subject = p_subject
          AND m.exam_type = p_exam_type
          AND s.class = p_class_name
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_save_class_marks(p_marks jsonb);

CREATE OR REPLACE FUNCTION public.portal_save_class_marks(p_marks jsonb, p_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    mark_record jsonb;
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  FOR mark_record IN SELECT * FROM jsonb_array_elements(p_marks)
    LOOP
        INSERT INTO public.marks (
            school_id, student_id, subject, mark, exam_type, period_id
        ) VALUES (
            (mark_record->>'school_id')::uuid,
            (mark_record->>'student_id')::uuid,
            mark_record->>'subject',
            CASE 
                WHEN mark_record->>'mark' IS NULL OR mark_record->>'mark' = '' THEN NULL
                ELSE (mark_record->>'mark')::integer
            END,
            mark_record->>'exam_type',
            CASE 
                WHEN mark_record->>'period_id' IS NOT NULL AND mark_record->>'period_id' != '' 
                THEN (mark_record->>'period_id')::uuid
                ELSE NULL
            END
        )
        ON CONFLICT (school_id, student_id, subject, period_id, exam_type)
        DO UPDATE SET 
            mark = CASE 
                WHEN (mark_record->>'mark') IS NULL OR (mark_record->>'mark') = '' THEN NULL
                ELSE (mark_record->>'mark')::integer
            END;
    END LOOP;
    RETURN TRUE;
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_students_by_class_name(p_school_id uuid, p_class_name text);

CREATE OR REPLACE FUNCTION public.portal_get_students_by_class_name(p_school_id uuid, p_class_name text, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'adm_no', s.adm_no,
            'class', s.class,
            'stream', s.stream,
            'admNo', s.adm_no
        ) ORDER BY s.name ASC), '[]'::jsonb)
        FROM public.students s
        WHERE s.school_id = p_school_id
          AND s.class = p_class_name
          AND (s.status IS NULL OR s.status NOT IN ('Inactive', 'Graduated', 'Transferred'))
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_assignments(p_school_id UUID, p_class_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_assignments(p_school_id UUID, p_token UUID, p_class_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
    SELECT * FROM public.el_assignments WHERE school_id = p_school_id AND (p_class_id IS NULL OR class_id = p_class_id) ORDER BY created_at DESC
  ) t);
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_exam_marks(p_school_id UUID, p_paper_id UUID);

CREATE OR REPLACE FUNCTION public.portal_get_exam_marks(p_school_id UUID, p_paper_id UUID, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', em.id, 'student_id', em.student_id, 'raw_score', em.raw_score, 'is_absent', em.is_absent, 'students', jsonb_build_object('name', s.name, 'adm_no', s.adm_no))), '[]'::jsonb) FROM public.exam_marks em JOIN public.students s ON s.id = em.student_id WHERE em.exam_paper_id = p_paper_id AND em.school_id = p_school_id);
END; $$;

DROP FUNCTION IF EXISTS public.portal_save_exam_marks(p_marks JSONB);

CREATE OR REPLACE FUNCTION public.portal_save_exam_marks(p_marks JSONB, p_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE mark_record JSONB;
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  FOR mark_record IN SELECT * FROM jsonb_array_elements(p_marks) LOOP
    INSERT INTO public.exam_marks (exam_paper_id, student_id, school_id, raw_score, is_absent)
    VALUES (CAST(mark_record->>'exam_paper_id' AS UUID), CAST(mark_record->>'student_id' AS UUID), CAST(mark_record->>'school_id' AS UUID), CAST(mark_record->>'raw_score' AS DECIMAL), CAST(mark_record->>'is_absent' AS BOOLEAN))
    ON CONFLICT (exam_paper_id, student_id) DO UPDATE SET raw_score = EXCLUDED.raw_score, is_absent = EXCLUDED.is_absent, updated_at = NOW();
  END LOOP;
  RETURN TRUE;
END; $$;

DROP FUNCTION IF EXISTS public.portal_get_student_results_v2(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_results_v2(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_results JSONB;
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  -- Strategy 1: structured exam_results table, gated on the flag
    -- the "Post to Parents" button in Settings.jsx actually sets.
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
            'exam_type', e.exam_type
        ) ORDER BY e.created_at DESC
    ), '[]'::jsonb)
    INTO v_results
    FROM public.exam_results er
    JOIN public.exams e ON er.exam_id = e.id
    WHERE er.student_id = p_student_id
      AND e.school_id = p_school_id
      AND e.released_to_parents = TRUE;

    -- Strategy 2: fallback to aggregating the marks table directly,
    -- for schools/exams that never get a matching exam_results row.
    -- Same released_to_parents gate applies.
    IF jsonb_array_length(v_results) = 0 THEN
        SELECT COALESCE(jsonb_agg(exam_row ORDER BY exam_row->>'exam_type'), '[]'::jsonb)
        INTO v_results
        FROM (
            SELECT jsonb_build_object(
                'id', md5(m.exam_type || m.school_id::text || p_student_id::text)::uuid,
                'exam_name', COALESCE(m.exam_type, 'End Term'),
                'exam_type', COALESCE(m.exam_type, 'End Term'),
                'exam_term', COALESCE(m.exam_type, 'End Term'),
                'total_marks', SUM(COALESCE(m.mark, 0)),
                'total_subjects', COUNT(*),
                'mean_score', ROUND(AVG(COALESCE(m.mark, 0))::numeric, 1),
                'subjects', jsonb_agg(
                    jsonb_build_object('subject', m.subject, 'mark', m.mark) ORDER BY m.subject
                )
            ) AS exam_row
            FROM public.marks m
            JOIN public.exams e2 ON e2.exam_type = m.exam_type AND e2.school_id = m.school_id
            WHERE m.student_id = p_student_id
              AND m.school_id = p_school_id
              AND m.mark IS NOT NULL
              AND e2.released_to_parents = TRUE
            GROUP BY m.exam_type, m.school_id
        ) sub;
    END IF;

    RETURN v_results;
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_announcements_v2(p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_announcements_v2(p_school_id uuid, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', a.id,
            'title', a.title,
            'body', a.content,
            'created_at', a.created_at,
            'status', a.status
        ) ORDER BY a.created_at DESC), '[]'::jsonb)
        FROM public.announcements a
        WHERE a.school_id = p_school_id
          AND a.status ILIKE 'published'
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_assignments_v2(p_school_id uuid, p_class_id text);

CREATE OR REPLACE FUNCTION public.portal_get_assignments_v2(p_school_id uuid, p_token UUID, p_class_id text DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  
    IF NOT EXISTS (SELECT 1 FROM public.portal_sessions WHERE token = p_token AND school_id = p_school_id AND expires_at > now()) THEN
      RAISE EXCEPTION 'Unauthorized';
    END IF;

  RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', a.id,
            'title', a.title,
            'description', a.description,
            'subject', a.subject,
            'subject_id', a.subject,
            'class', a.class,
            'class_id', a.class,
            'due_date', a.due_date,
            'status', COALESCE(a.status, 'published'),
            'created_at', a.created_at
        ) ORDER BY a.due_date DESC), '[]'::jsonb)
        FROM public.el_assignments a
        WHERE a.school_id = p_school_id
          AND (a.status IS NULL OR a.status ILIKE 'published' OR a.status ILIKE 'active')
          AND (p_class_id IS NULL OR p_class_id = '' OR a.class = p_class_id)
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_student_payments_v2(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_payments_v2(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', fp.id, 'amount', fp.amount, 'date', fp.date, 'method', fp.method, 'reference', fp.reference)), '[]'::jsonb)
        FROM public.fee_payments fp
        JOIN public.fees f ON f.id = fp.fee_id
        WHERE f.student_id = p_student_id AND f.school_id = p_school_id
        ORDER BY fp.date DESC
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_student_fee_summary(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_fee_summary(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    v_active_period_id UUID;
    v_fee RECORD;
    v_payments JSONB;
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  -- Resolve the same "current period" the admin dashboard uses
    -- (academic_periods.is_active), instead of just taking
    -- whichever fees row happens to have the newest created_at.
    SELECT id INTO v_active_period_id
    FROM public.academic_periods
    WHERE school_id = p_school_id AND is_active = true
    LIMIT 1;

    SELECT id, total_fee, paid, balance, period_id
    INTO v_fee
    FROM public.fees
    WHERE student_id = p_student_id
      AND school_id = p_school_id
      AND (v_active_period_id IS NULL OR period_id = v_active_period_id)
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1;

    IF v_fee IS NULL THEN
        -- Honest "nothing set up for the current term yet" response
        -- instead of silently falling back to a stale prior-term row.
        RETURN jsonb_build_object(
            'total_fee', 0, 'paid', 0, 'balance', 0, 'payments', '[]'::jsonb,
            'period_id', v_active_period_id, 'no_record_for_current_period', true
        );
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', fp.id, 'amount', fp.amount, 'date', fp.date,
            'method', COALESCE(fp.method, 'Payment'), 'reference', COALESCE(fp.reference, ''),
            'status', COALESCE(fp.status, 'Confirmed')
        ) ORDER BY fp.date DESC
    ), '[]'::jsonb)
    INTO v_payments
    FROM public.fee_payments fp
    WHERE fp.fee_id = v_fee.id AND COALESCE(fp.status, 'Confirmed') != 'Voided';

    RETURN jsonb_build_object(
        'total_fee', COALESCE(v_fee.total_fee, 0), 'paid', COALESCE(v_fee.paid, 0),
        'balance', COALESCE(v_fee.balance, 0), 'fee_id', v_fee.id,
        'period_id', v_fee.period_id, 'payments', v_payments,
        'no_record_for_current_period', false
    );
END;
$func$;

DROP FUNCTION IF EXISTS public.portal_get_student_fees_v2(uuid, uuid);
CREATE OR REPLACE FUNCTION public.portal_get_student_fees_v2(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_active_period_id UUID;
BEGIN
    IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

    SELECT id INTO v_active_period_id FROM public.academic_periods
    WHERE school_id = p_school_id AND is_active = true LIMIT 1;

    RETURN (
        SELECT jsonb_build_object('id', id, 'total_fee', total_fee, 'paid', paid, 'balance', balance, 'period_id', period_id)
        FROM public.fees
        WHERE student_id = p_student_id AND school_id = p_school_id
          AND (v_active_period_id IS NULL OR period_id = v_active_period_id)
        ORDER BY created_at DESC NULLS LAST LIMIT 1
    );
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_student_subjects(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_subjects(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_subjects JSONB;
BEGIN
  IF NOT public.validate_portal_session(p_token, p_student_id) THEN RAISE EXCEPTION 'Unauthorized'; END IF;

  SELECT subjects INTO v_subjects FROM public.students WHERE id = p_student_id AND school_id = p_school_id;
    IF v_subjects IS NOT NULL AND jsonb_array_length(v_subjects) > 0 THEN RETURN v_subjects; END IF;
    RETURN (SELECT COALESCE(jsonb_agg(DISTINCT m.subject ORDER BY m.subject), '[]'::jsonb) FROM public.marks m WHERE m.student_id = p_student_id AND m.school_id = p_school_id AND m.subject IS NOT NULL);
END;
$$;

DROP FUNCTION IF EXISTS public.portal_get_student_books(p_student_id uuid, p_school_id uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_books(p_student_id uuid, p_school_id uuid, p_token UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', br.id,
      'title', b.title,
      'isbn', b.isbn,
      'copy_code', bc.copy_code,
      'due_date', br.due_date,
      'is_overdue', (br.due_date < CURRENT_DATE)
    ) ORDER BY br.due_date ASC
  ), '[]'::jsonb)
  FROM public.borrow_records br
  JOIN public.book_copies bc ON br.book_copy_id = bc.id
  JOIN public.books b ON bc.book_id = b.id
  WHERE br.student_id = p_student_id
    AND br.school_id = p_school_id
    AND br.status = 'borrowed';
$$;

