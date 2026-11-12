-- Forward-only fix for sparse school_profiles upserts after perpetual licensing.
-- Existing deployments may already have applied 20261110000100; do not edit it.

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
    -- PostgREST upsert runs BEFORE INSERT before resolving ON CONFLICT. Omitted
    -- columns receive defaults (subscription/null), even when the existing row
    -- is perpetual. Preserve the current signed claims on every conflict
    -- candidate; user-supplied claim changes on this INSERT path are ignored.
    SELECT * INTO v_existing
    FROM public.school_profiles
    WHERE school_id = NEW.school_id
    FOR UPDATE;

    IF FOUND THEN
      NEW.license_type := v_existing.license_type;
      NEW.license_status := v_existing.license_status;
      NEW.license_id := v_existing.license_id;
      NEW.license_issued_at := v_existing.license_issued_at;
      NEW.license_support_until := v_existing.license_support_until;
      NEW.license_reference := v_existing.license_reference;
      NEW.license_document := v_existing.license_document;
      NEW.license_feature_keys := v_existing.license_feature_keys;
      RETURN NEW;
    END IF;

    -- A genuinely new profile may only begin with neutral subscription defaults.
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
  -- The platform-admin workflow may change only the operational status of an
  -- already-issued perpetual licence. Signed licence claims remain immutable.
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

NOTIFY pgrst, 'reload schema';
