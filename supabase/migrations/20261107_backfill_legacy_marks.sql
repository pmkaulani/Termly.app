-- ==============================================================================
-- Migration: Deterministic Backfill of Legacy Marks into Canonical Exam Marks
-- File: 20261107_backfill_legacy_marks.sql
-- ==============================================================================

DO $$
DECLARE
  r RECORD;
  v_class_id UUID;
  v_subject_id UUID;
  v_exam_id UUID;
  v_paper_id UUID;
  v_backfilled_count INT := 0;
  v_skipped_count INT := 0;
BEGIN
  RAISE NOTICE 'Starting legacy marks backfill...';

  FOR r IN (
    SELECT m.id as mark_id, m.school_id, m.student_id, m.subject, m.mark, m.period_id, m.exam_type, m.created_by,
           s.class as student_class
    FROM public.marks m
    JOIN public.students s ON s.id = m.student_id
    WHERE m.subject IS NOT NULL 
      AND TRIM(m.subject) != ''
      AND m.exam_type IS NOT NULL
      AND TRIM(m.exam_type) != ''
  ) LOOP
    -- 1. Deterministic class resolution
    SELECT id INTO v_class_id 
    FROM public.classes 
    WHERE school_id = r.school_id AND name = r.student_class 
    LIMIT 1;

    -- 2. Deterministic subject resolution
    SELECT id INTO v_subject_id 
    FROM public.tt_subjects 
    WHERE school_id = r.school_id AND name = r.subject 
    LIMIT 1;

    -- 3. Deterministic exam resolution (by name or exam_type)
    SELECT id INTO v_exam_id 
    FROM public.exams 
    WHERE school_id = r.school_id AND (name = r.exam_type OR exam_type = r.exam_type)
    LIMIT 1;

    -- If any component is ambiguous or missing, do NOT guess — skip safely
    IF v_class_id IS NULL OR v_subject_id IS NULL OR v_exam_id IS NULL THEN
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    -- 4. Find or create exam paper
    SELECT id INTO v_paper_id 
    FROM public.exam_papers 
    WHERE exam_id = v_exam_id AND class_id = v_class_id AND subject_id = v_subject_id;

    IF v_paper_id IS NULL THEN
      INSERT INTO public.exam_papers (exam_id, school_id, class_id, subject_id, max_score, out_of)
      VALUES (v_exam_id, r.school_id, v_class_id, v_subject_id, 100, 100)
      RETURNING id INTO v_paper_id;
    END IF;

    -- 5. Deterministic upsert into exam_marks
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
      r.student_id,
      r.school_id,
      CASE WHEN r.mark = -1 THEN NULL WHEN r.mark >= 0 THEN r.mark ELSE NULL END,
      CASE WHEN r.mark = -1 THEN TRUE ELSE FALSE END,
      r.created_by,
      now(),
      now()
    )
    ON CONFLICT (exam_paper_id, student_id) DO NOTHING;

    v_backfilled_count := v_backfilled_count + 1;
  END LOOP;

  RAISE NOTICE 'Legacy marks backfill complete. Processed: %, Skipped ambiguous: %', v_backfilled_count, v_skipped_count;
END;
$$;
