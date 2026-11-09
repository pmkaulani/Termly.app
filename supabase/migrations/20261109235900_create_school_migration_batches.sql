-- Termly manual migration audit history.
-- Store summaries only: never store raw learner/staff spreadsheets in this table.

CREATE TABLE IF NOT EXISTS public.school_migration_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  dataset TEXT NOT NULL CHECK (dataset IN ('students', 'teachers')),
  source_system TEXT NOT NULL DEFAULT 'Legacy school system',
  source_filename TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_migration_batches_school_created
  ON public.school_migration_batches (school_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.can_manage_school_migration(p_school_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.school_id = p_school_id
      AND u.auth_user_id = auth.uid()
      AND lower(coalesce(u.role, '')) IN ('admin', 'owner')
  );
$function$;

REVOKE ALL ON FUNCTION public.can_manage_school_migration(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_school_migration(UUID) TO authenticated;

ALTER TABLE public.school_migration_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS school_migration_batches_admin_select ON public.school_migration_batches;
CREATE POLICY school_migration_batches_admin_select
  ON public.school_migration_batches
  FOR SELECT TO authenticated
  USING (public.can_manage_school_migration(school_id));

DROP POLICY IF EXISTS school_migration_batches_admin_insert ON public.school_migration_batches;
CREATE POLICY school_migration_batches_admin_insert
  ON public.school_migration_batches
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_manage_school_migration(school_id)
    AND created_by = auth.uid()
  );

-- History is intentionally append-only from the application: no UPDATE or DELETE policy.
REVOKE ALL ON public.school_migration_batches FROM anon, PUBLIC;
GRANT SELECT, INSERT ON public.school_migration_batches TO authenticated;
