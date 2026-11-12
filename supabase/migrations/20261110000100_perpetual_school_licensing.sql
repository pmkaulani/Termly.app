-- Termly Phase 4: perpetual school licensing.
-- The Ed25519 signature is verified by the activate-perpetual-license Edge Function.
-- This transaction is callable only by service_role after that verification.

ALTER TABLE public.school_profiles
  ADD COLUMN IF NOT EXISTS license_type TEXT NOT NULL DEFAULT 'subscription',
  ADD COLUMN IF NOT EXISTS license_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS license_id TEXT,
  ADD COLUMN IF NOT EXISTS license_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS license_support_until DATE,
  ADD COLUMN IF NOT EXISTS license_reference TEXT,
  ADD COLUMN IF NOT EXISTS license_document JSONB,
  ADD COLUMN IF NOT EXISTS license_feature_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.school_profiles'::regclass
      AND conname = 'school_profiles_license_type_check'
  ) THEN
    ALTER TABLE public.school_profiles
      ADD CONSTRAINT school_profiles_license_type_check
      CHECK (license_type IN ('subscription', 'perpetual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.school_profiles'::regclass
      AND conname = 'school_profiles_license_status_check'
  ) THEN
    ALTER TABLE public.school_profiles
      ADD CONSTRAINT school_profiles_license_status_check
      CHECK (license_status IN ('active', 'suspended'));
  END IF;
END $$;

-- The current Termly UI bootstrap identifies its platform administrator by
-- this email. Keep the database/RLS identity table aligned so the existing
-- is_platform_admin() policy helper can authorize the same operator.
INSERT INTO public.platform_admins (email, role)
VALUES ('shulesoft8@gmail.com', 'super_admin')
ON CONFLICT (email) DO NOTHING;

-- Stop school-level clients from granting themselves a perpetual licence by
-- writing licence columns directly through PostgREST. Only the verified
-- service-role activation RPC can create/change signed licence claims.
CREATE OR REPLACE FUNCTION public.termly_protect_license_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_service_role BOOLEAN := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
  v_platform_admin BOOLEAN := FALSE;
  v_existing public.school_profiles%ROWTYPE;
BEGIN
  IF v_service_role THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Supabase .upsert() executes a BEFORE INSERT trigger even when the row
    -- already exists. Permit a no-op replay of the existing signed claims so
    -- ordinary school-profile saves can preserve (but never change) a licence.
    SELECT * INTO v_existing
    FROM public.school_profiles
    WHERE school_id = NEW.school_id;

    IF FOUND THEN
      IF ROW(
        NEW.license_type, NEW.license_status, NEW.license_id, NEW.license_issued_at,
        NEW.license_support_until, NEW.license_reference, NEW.license_document,
        NEW.license_feature_keys
      ) IS NOT DISTINCT FROM ROW(
        v_existing.license_type, v_existing.license_status, v_existing.license_id, v_existing.license_issued_at,
        v_existing.license_support_until, v_existing.license_reference, v_existing.license_document,
        v_existing.license_feature_keys
      ) THEN
        RETURN NEW;
      END IF;

      v_platform_admin := public.is_platform_admin();
      IF v_platform_admin
         AND v_existing.license_type = 'perpetual'
         AND NEW.license_type = v_existing.license_type
         AND NEW.license_status IN ('active', 'suspended')
         AND ROW(
           NEW.license_id, NEW.license_issued_at, NEW.license_support_until,
           NEW.license_reference, NEW.license_document, NEW.license_feature_keys
         ) IS NOT DISTINCT FROM ROW(
           v_existing.license_id, v_existing.license_issued_at, v_existing.license_support_until,
           v_existing.license_reference, v_existing.license_document, v_existing.license_feature_keys
         ) THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'School licence claims are protected. Use the Termly licensing workflow.';
    END IF;

    -- A genuinely new profile may only begin with the neutral subscription defaults.
    IF NEW.license_type IS DISTINCT FROM 'subscription'
       OR NEW.license_status IS DISTINCT FROM 'active'
       OR NEW.license_id IS NOT NULL
       OR NEW.license_issued_at IS NOT NULL
       OR NEW.license_support_until IS NOT NULL
       OR NEW.license_reference IS NOT NULL
       OR NEW.license_document IS NOT NULL
       OR COALESCE(array_length(NEW.license_feature_keys, 1), 0) <> 0 THEN
      RAISE EXCEPTION 'Licence claims can only be created by the verified Termly licensing service.';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.license_type, NEW.license_status, NEW.license_id, NEW.license_issued_at,
    NEW.license_support_until, NEW.license_reference, NEW.license_document,
    NEW.license_feature_keys
  ) IS NOT DISTINCT FROM ROW(
    OLD.license_type, OLD.license_status, OLD.license_id, OLD.license_issued_at,
    OLD.license_support_until, OLD.license_reference, OLD.license_document,
    OLD.license_feature_keys
  ) THEN
    RETURN NEW;
  END IF;

  v_platform_admin := public.is_platform_admin();
  -- The Super Admin suspend/restore workflow may change only the operational
  -- status of an already-issued perpetual licence. It cannot edit its claims.
  IF v_platform_admin
     AND OLD.license_type = 'perpetual'
     AND NEW.license_type = OLD.license_type
     AND NEW.license_status IN ('active', 'suspended')
     AND ROW(
       NEW.license_id, NEW.license_issued_at, NEW.license_support_until,
       NEW.license_reference, NEW.license_document, NEW.license_feature_keys
     ) IS NOT DISTINCT FROM ROW(
       OLD.license_id, OLD.license_issued_at, OLD.license_support_until,
       OLD.license_reference, OLD.license_document, OLD.license_feature_keys
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'School licence claims are protected. Use the Termly licensing workflow.';
END;
$$;

DROP TRIGGER IF EXISTS termly_protect_license_fields ON public.school_profiles;
CREATE TRIGGER termly_protect_license_fields
  BEFORE INSERT OR UPDATE ON public.school_profiles
  FOR EACH ROW EXECUTE FUNCTION public.termly_protect_license_fields();

CREATE UNIQUE INDEX IF NOT EXISTS school_profiles_license_id_unique
  ON public.school_profiles (license_id)
  WHERE license_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.school_license_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  license_id TEXT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.school_license_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.school_license_events TO authenticated;
DROP POLICY IF EXISTS "Platform admins read school licence events" ON public.school_license_events;
CREATE POLICY "Platform admins read school licence events"
  ON public.school_license_events
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

CREATE OR REPLACE FUNCTION public.termly_apply_perpetual_license(
  p_school_id UUID,
  p_license_document JSONB,
  p_actor_id UUID,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_payload JSONB;
  v_features JSONB;
  v_license_id TEXT;
  v_issued_at TIMESTAMPTZ;
  v_support_until DATE;
  v_school_name TEXT;
  v_reference TEXT;
  v_resolved_features TEXT[] := ARRAY[]::TEXT[];
  v_feature_count INTEGER := 0;
BEGIN
  -- Only the server-side Edge Function, after Ed25519 verification, may call this.
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Only the verified licensing service may apply a perpetual licence.';
  END IF;

  IF p_license_document IS NULL OR jsonb_typeof(p_license_document) <> 'object' THEN
    RAISE EXCEPTION 'Invalid licence document.';
  END IF;

  v_payload := p_license_document -> 'payload';
  IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'Licence payload is missing.';
  END IF;

  IF COALESCE(v_payload ->> 'schemaVersion', '') <> '1'
     OR COALESCE(v_payload ->> 'product', '') <> 'termly'
     OR COALESCE(v_payload ->> 'licenseType', '') <> 'perpetual'
     OR lower(COALESCE(v_payload ->> 'schoolId', '')) <> lower(p_school_id::TEXT) THEN
    RAISE EXCEPTION 'Licence claims do not match this Termly school installation.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.school_profiles
    WHERE school_id = p_school_id
      AND license_type = 'perpetual'
      AND license_status = 'suspended'
  ) THEN
    RAISE EXCEPTION 'A platform-suspended perpetual licence cannot be reactivated by re-uploading its licence file.';
  END IF;

  v_license_id := NULLIF(BTRIM(v_payload ->> 'licenseId'), '');
  v_school_name := NULLIF(BTRIM(v_payload ->> 'schoolName'), '');
  v_reference := NULLIF(BTRIM(v_payload ->> 'reference'), '');

  IF v_license_id IS NULL OR LENGTH(v_license_id) > 100 OR v_school_name IS NULL THEN
    RAISE EXCEPTION 'Licence ID and school name are required.';
  END IF;

  BEGIN
    v_issued_at := (v_payload ->> 'issuedAt')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Licence issue date is invalid.';
  END;

  IF v_issued_at IS NULL THEN
    RAISE EXCEPTION 'Licence issue date is required.';
  END IF;

  IF v_issued_at > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Licence issue date is in the future.';
  END IF;

  IF NULLIF(v_payload ->> 'supportUntil', '') IS NOT NULL THEN
    BEGIN
      v_support_until := (v_payload ->> 'supportUntil')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Support-through date is invalid.';
    END;
  ELSE
    v_support_until := NULL;
  END IF;

  v_features := v_payload #> '{entitlements,features}';
  IF v_features IS NULL OR jsonb_typeof(v_features) <> 'array' THEN
    RAISE EXCEPTION 'Licence feature entitlements are missing or invalid.';
  END IF;

  IF v_features @> '["*"]'::jsonb THEN
    IF jsonb_array_length(v_features) <> 1 THEN
      RAISE EXCEPTION 'Wildcard feature entitlement must be used by itself.';
    END IF;
    SELECT COALESCE(array_agg(fr.feature_key ORDER BY fr.feature_key), ARRAY[]::TEXT[])
      INTO v_resolved_features
      FROM public.features_registry fr;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_features) AS requested(feature_key)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.features_registry fr
        WHERE fr.feature_key = requested.feature_key
      )
    ) THEN
      RAISE EXCEPTION 'Licence contains a feature key that is not registered in this Termly version.';
    END IF;
    SELECT COALESCE(array_agg(requested.feature_key ORDER BY requested.feature_key), ARRAY[]::TEXT[])
      INTO v_resolved_features
      FROM jsonb_array_elements_text(v_features) AS requested(feature_key);

    -- A limited licence must not inherit old, broader subscription entitlements.
    UPDATE public.school_features
    SET is_enabled = FALSE, expires_at = NOW(), updated_at = NOW()
    WHERE school_id = p_school_id
      AND NOT (feature_key::TEXT = ANY(v_resolved_features));
  END IF;

  IF COALESCE(array_length(v_resolved_features, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Licence does not resolve to any registered Termly features.';
  END IF;

  INSERT INTO public.school_features (school_id, feature_key, is_enabled, enabled_at, enabled_by, expires_at, updated_at)
    SELECT p_school_id, requested.feature_key, TRUE, NOW(), p_actor_id, NULL, NOW()
    FROM unnest(v_resolved_features) AS requested(feature_key)
  ON CONFLICT (school_id, feature_key) DO UPDATE
    SET is_enabled = TRUE, expires_at = NULL, updated_at = NOW();
  GET DIAGNOSTICS v_feature_count = ROW_COUNT;

  UPDATE public.school_profiles
  SET license_type = 'perpetual',
      license_status = 'active',
      license_id = v_license_id,
      license_issued_at = v_issued_at,
      license_support_until = v_support_until,
      license_reference = v_reference,
      license_document = p_license_document,
      license_feature_keys = v_resolved_features,
      subscription_plan = 'Perpetual',
      subscription_status = 'Active',
      subscription_expiry = NULL,
      updated_at = NOW()
  WHERE school_id = p_school_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'School profile was not found. Complete school setup before activating a licence.';
  END IF;

  UPDATE public.schools
  SET plan = 'Perpetual', status = 'Active'
  WHERE id = p_school_id;

  INSERT INTO public.school_license_events (
    school_id, event_type, license_id, actor_id, actor_email, metadata
  ) VALUES (
    p_school_id,
    'LICENSE_ACTIVATED',
    v_license_id,
    p_actor_id,
    p_actor_email,
    jsonb_build_object(
      'license_type', 'perpetual',
      'support_until', v_support_until,
      'reference', v_reference,
      'school_name_claim', v_school_name,
      'feature_rows_upserted', v_feature_count
    )
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'school_id', p_school_id,
    'license_id', v_license_id,
    'license_type', 'perpetual',
    'license_status', 'active',
    'support_until', v_support_until,
    'feature_rows_upserted', v_feature_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.termly_apply_perpetual_license(UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.termly_apply_perpetual_license(UUID, JSONB, UUID, TEXT) TO service_role;

COMMENT ON COLUMN public.school_profiles.license_type IS 'Commercial licence model. Perpetual means the purchased Termly version does not expire.';
COMMENT ON COLUMN public.school_profiles.license_status IS 'Operational licence status. Suspension blocks access; support date does not.';
COMMENT ON COLUMN public.school_profiles.license_support_until IS 'Informational support/update coverage date; never an application expiry date.';
COMMENT ON COLUMN public.school_profiles.license_document IS 'Signed Termly licence document verified by the activate-perpetual-license Edge Function.';
COMMENT ON COLUMN public.school_profiles.license_feature_keys IS 'Resolved feature entitlement snapshot captured at licence activation; restore never expands wildcard claims to future features.';

NOTIFY pgrst, 'reload schema';
