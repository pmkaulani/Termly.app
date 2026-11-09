-- Fix Parent Portal library loans against the canonical library schema.
-- The canonical library uses borrow_records -> book_copies -> books.
-- The previous portal RPC queried the obsolete book_issues table and
-- accepted p_school_id rather than validating the server-issued session.

DROP FUNCTION IF EXISTS public.portal_get_student_books(uuid, uuid);
DROP FUNCTION IF EXISTS public.portal_get_student_books(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.portal_get_student_books(
  p_student_id UUID,
  p_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_school_id UUID;
BEGIN
  -- The caller cannot choose a school. The session must be valid and the
  -- requested student must be linked to this parent session.
  IF NOT public.validate_portal_parent_access(p_token, p_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: Access denied to student library loans.';
  END IF;

  SELECT school_id
    INTO v_school_id
    FROM public.students
   WHERE id = p_student_id;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Student record not found.';
  END IF;

  RETURN (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', br.id,
          'book_id', b.id,
          'title', b.title,
          'author', b.author,
          'isbn', b.isbn,
          'copy_code', bc.copy_code,
          'issue_date', br.borrow_date,
          'borrow_date', br.borrow_date,
          'due_date', br.due_date,
          'status', br.status,
          'is_overdue', (br.due_date < CURRENT_DATE)
        ) ORDER BY br.due_date ASC, b.title ASC
      ),
      '[]'::jsonb
    )
    FROM public.borrow_records br
    JOIN public.book_copies bc
      ON bc.id = br.book_copy_id
    JOIN public.books b
      ON b.id = bc.book_id
    WHERE br.student_id = p_student_id
      AND br.school_id = v_school_id
      AND b.school_id = v_school_id
      AND br.status IN ('borrowed', 'overdue')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.portal_get_student_books(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_get_student_books(UUID, UUID) TO anon, authenticated;

COMMENT ON FUNCTION public.portal_get_student_books(UUID, UUID) IS
  'Returns only active library loans for a student linked to the validated parent portal session.';
