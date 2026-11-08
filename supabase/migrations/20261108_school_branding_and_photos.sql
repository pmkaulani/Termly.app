-- ==============================================================================
-- Migration: 20261108_school_branding_and_photos.sql
-- Description:
--   1. Adds photo_path, photo_updated_at, and parent_email to students and teachers.
--   2. Synchronizes logo_url on school_profiles.
--   3. Configures Supabase Storage buckets:
--        - school-logos (public bucket for school wordmarks/crests)
--        - school-people-photos (private bucket for student/teacher portraits)
--   4. Creates least-privilege RLS policies on storage.objects scoped by school.
--   5. Adds portal photo authorization helper for verified portal sessions.
-- ==============================================================================

-- 1. Schema Extensions for Students, Teachers, and School Profiles
ALTER TABLE public.students 
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_email TEXT;

ALTER TABLE public.teachers 
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

ALTER TABLE public.school_profiles 
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Index for efficient photo and staff code lookups
CREATE INDEX IF NOT EXISTS idx_students_school_photo ON public.students(school_id, photo_path) WHERE photo_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_school_photo ON public.teachers(school_id, photo_path) WHERE photo_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_school_staff_code ON public.teachers(school_id, staff_code) WHERE staff_code IS NOT NULL;

-- 2. Storage Buckets Setup
DO $$
BEGIN
  -- school-logos: public bucket for school branding assets
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'school-logos',
      'school-logos',
      true,
      2097152, -- 2 MB
      ARRAY['image/png', 'image/jpeg', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE SET
      public = true,
      file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

    -- school-people-photos: private bucket for student and faculty portraits
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'school-people-photos',
      'school-people-photos',
      false,
      5242880, -- 5 MB
      ARRAY['image/png', 'image/jpeg', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE SET
      public = false,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];
  END IF;
END $$;

-- 3. Storage Object RLS Policies
-- Objects are organized as: <school_id>/...
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN

    -- Policies for school-logos
    DROP POLICY IF EXISTS "school_logos_public_select" ON storage.objects;
    CREATE POLICY "school_logos_public_select" ON storage.objects
      FOR SELECT USING (bucket_id = 'school-logos');

    DROP POLICY IF EXISTS "school_logos_admin_insert" ON storage.objects;
    CREATE POLICY "school_logos_admin_insert" ON storage.objects
      FOR INSERT WITH CHECK (
        bucket_id = 'school-logos' AND (
          public.is_school_owner(split_part(name, '/', 1)::uuid) OR
          public.is_school_admin(split_part(name, '/', 1)::uuid)
        )
      );

    DROP POLICY IF EXISTS "school_logos_admin_update" ON storage.objects;
    CREATE POLICY "school_logos_admin_update" ON storage.objects
      FOR UPDATE USING (
        bucket_id = 'school-logos' AND (
          public.is_school_owner(split_part(name, '/', 1)::uuid) OR
          public.is_school_admin(split_part(name, '/', 1)::uuid)
        )
      );

    DROP POLICY IF EXISTS "school_logos_admin_delete" ON storage.objects;
    CREATE POLICY "school_logos_admin_delete" ON storage.objects
      FOR DELETE USING (
        bucket_id = 'school-logos' AND (
          public.is_school_owner(split_part(name, '/', 1)::uuid) OR
          public.is_school_admin(split_part(name, '/', 1)::uuid)
        )
      );

    -- Policies for school-people-photos (Private)
    DROP POLICY IF EXISTS "school_photos_member_select" ON storage.objects;
    CREATE POLICY "school_photos_member_select" ON storage.objects
      FOR SELECT USING (
        bucket_id = 'school-people-photos' AND (
          split_part(name, '/', 1)::uuid = public.get_auth_school_id() OR
          public.is_school_owner(split_part(name, '/', 1)::uuid)
        )
      );

    DROP POLICY IF EXISTS "school_photos_admin_modify" ON storage.objects;
    CREATE POLICY "school_photos_admin_modify" ON storage.objects
      FOR ALL USING (
        bucket_id = 'school-people-photos' AND (
          public.is_school_owner(split_part(name, '/', 1)::uuid) OR
          public.is_school_admin(split_part(name, '/', 1)::uuid)
        )
      );

  END IF;
END $$;

-- 4. Server-Verified Portal Photo Authorization Function
-- Allows verified parent/staff portal sessions to retrieve their authorized student/teacher photo path
CREATE OR REPLACE FUNCTION public.portal_get_student_photo(
  p_token UUID,
  p_student_id UUID
)
RETURNS TABLE (
  photo_path TEXT,
  photo_updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session RECORD;
  v_student RECORD;
BEGIN
  -- 1. Validate session
  SELECT * INTO v_session
  FROM public.portal_sessions
  WHERE token = p_token
    AND revoked = false
    AND expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired portal session';
  END IF;

  -- 2. Validate relationship:
  -- If parent session, verify parent phone matches student parent_phone
  IF v_session.role = 'parent' THEN
    SELECT s.photo_path, s.photo_updated_at INTO v_student
    FROM public.students s
    WHERE s.id = p_student_id
      AND s.school_id = v_session.school_id
      AND s.parent_phone = v_session.parent_phone;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unauthorized: Student not linked to authenticated parent';
    END IF;

    RETURN QUERY SELECT v_student.photo_path, v_student.photo_updated_at;
  ELSIF v_session.role = 'teacher' THEN
    -- Staff can view student photos in their school
    SELECT s.photo_path, s.photo_updated_at INTO v_student
    FROM public.students s
    WHERE s.id = p_student_id
      AND s.school_id = v_session.school_id;

    RETURN QUERY SELECT v_student.photo_path, v_student.photo_updated_at;
  ELSE
    RAISE EXCEPTION 'Unauthorized role';
  END IF;
END;
$$;

-- Revoke public access, grant to anon/authenticated
REVOKE ALL ON FUNCTION public.portal_get_student_photo(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_get_student_photo(UUID, UUID) TO anon, authenticated, service_role;
