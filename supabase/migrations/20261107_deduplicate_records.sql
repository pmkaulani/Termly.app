-- ==============================================================================
-- Migration: Deduplicate Historical Records in Marks, Exams & Sessions
-- File: supabase/migrations/20261107_deduplicate_records.sql
-- ==============================================================================

DO $$
DECLARE
  v_marks_deleted INT := 0;
  v_exam_marks_deleted INT := 0;
  v_papers_deleted INT := 0;
  v_sessions_deleted INT := 0;
  v_attempts_deleted INT := 0;
BEGIN
  RAISE NOTICE 'Starting database deduplication cleanup...';

  -- 1. Deduplicate legacy marks table (keeping latest by updated_at or ctid)
  WITH deleted AS (
    DELETE FROM public.marks a
    USING public.marks b
    WHERE a.ctid < b.ctid
      AND a.school_id = b.school_id
      AND a.student_id = b.student_id
      AND a.subject = b.subject
      AND a.period_id IS NOT DISTINCT FROM b.period_id
      AND a.exam_type IS NOT DISTINCT FROM b.exam_type
    RETURNING a.id
  )
  SELECT count(*) INTO v_marks_deleted FROM deleted;

  -- 2. Deduplicate exam_marks (keeping newest entry per student + paper)
  WITH deleted AS (
    DELETE FROM public.exam_marks a
    USING public.exam_marks b
    WHERE a.ctid < b.ctid
      AND a.exam_paper_id = b.exam_paper_id
      AND a.student_id = b.student_id
    RETURNING a.id
  )
  SELECT count(*) INTO v_exam_marks_deleted FROM deleted;

  -- 3. Deduplicate exam_papers (keeping newest paper per exam + class + subject)
  -- First re-link any exam_marks pointing to duplicate papers
  UPDATE public.exam_marks em
  SET exam_paper_id = canonical.id
  FROM (
    SELECT DISTINCT ON (exam_id, class_id, subject_id) id, exam_id, class_id, subject_id
    FROM public.exam_papers
    ORDER BY exam_id, class_id, subject_id, created_at DESC
  ) canonical
  JOIN public.exam_papers dup 
    ON dup.exam_id = canonical.exam_id 
   AND dup.class_id = canonical.class_id 
   AND dup.subject_id = canonical.subject_id
   AND dup.id != canonical.id
  WHERE em.exam_paper_id = dup.id
    AND NOT EXISTS (
      -- Don't update if canonical already has a mark for this student
      SELECT 1 FROM public.exam_marks em2 
      WHERE em2.exam_paper_id = canonical.id AND em2.student_id = em.student_id
    );

  WITH deleted AS (
    DELETE FROM public.exam_papers a
    USING public.exam_papers b
    WHERE a.ctid < b.ctid
      AND a.exam_id = b.exam_id
      AND a.class_id = b.class_id
      AND a.subject_id = b.subject_id
    RETURNING a.id
  )
  SELECT count(*) INTO v_papers_deleted FROM deleted;

  -- 4. Deduplicate active portal sessions (keep newest active session per entity)
  WITH deleted AS (
    DELETE FROM public.portal_sessions a
    USING public.portal_sessions b
    WHERE a.ctid < b.ctid
      AND a.school_id = b.school_id
      AND a.entity_id = b.entity_id
      AND a.role = b.role
      AND a.revoked = false
      AND a.expires_at > now()
      AND b.revoked = false
      AND b.expires_at > now()
    RETURNING a.id
  )
  SELECT count(*) INTO v_sessions_deleted FROM deleted;

  -- 5. Deduplicate login attempts table
  WITH deleted AS (
    DELETE FROM public.portal_login_attempts a
    USING public.portal_login_attempts b
    WHERE a.ctid < b.ctid
      AND a.identifier = b.identifier
      AND a.attempt_type = b.attempt_type
    RETURNING a.id
  )
  SELECT count(*) INTO v_attempts_deleted FROM deleted;

  RAISE NOTICE 'Deduplication complete! Summary:';
  RAISE NOTICE '  - Marks deleted: %', v_marks_deleted;
  RAISE NOTICE '  - Exam marks deleted: %', v_exam_marks_deleted;
  RAISE NOTICE '  - Duplicate papers deleted: %', v_papers_deleted;
  RAISE NOTICE '  - Duplicate active sessions cleaned: %', v_sessions_deleted;
  RAISE NOTICE '  - Duplicate login attempt rows: %', v_attempts_deleted;
END;
$$;
