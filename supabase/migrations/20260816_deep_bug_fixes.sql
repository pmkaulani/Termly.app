-- Termly Security Patch: Deep Bug Fixes
-- Date: 2026-08-16

-- ============================================================
-- 1. FIX: Privilege Escalation in invite_sub_admin
-- ============================================================
-- The previous version blindly accepted a target_school_id and 
-- escalated the caller's context to that school, allowing an 
-- admin from School A to create an admin in School B.

DROP FUNCTION IF EXISTS public.invite_sub_admin(text,text,text,text,uuid);
DROP FUNCTION IF EXISTS public.invite_sub_admin(text,text,text,text);

CREATE OR REPLACE FUNCTION public.invite_sub_admin(
    new_email TEXT,
    new_name TEXT,
    new_role TEXT,
    new_password TEXT DEFAULT 'password123'
) RETURNS JSON AS $$
DECLARE
    current_school_id UUID;
    new_auth_id UUID;
    existing_user_count INT;
    plan_limit INT;
    current_plan TEXT;
BEGIN
    -- 1. Verify caller is an Admin
    SELECT school_id INTO current_school_id FROM public.users 
    WHERE auth_user_id = auth.uid() AND (role = 'Admin' OR role = 'admin') 
    LIMIT 1;

    IF current_school_id IS NULL THEN
        -- Check if they are the owner
        SELECT id INTO current_school_id FROM public.schools WHERE owner_id = auth.uid() LIMIT 1;
        IF current_school_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Only Admins or Owners can add new users.';
        END IF;
    END IF;
    
    -- Removed target_school_id override vulnerability.
    -- The caller can ONLY create admins for their own school.

    -- 2. Verify limits based on subscription plan
    SELECT plan INTO current_plan FROM public.schools WHERE id = current_school_id;
    
    SELECT (value->current_plan->>'admins')::INT INTO plan_limit 
    FROM public.platform_settings 
    WHERE key = 'pricing';

    IF plan_limit IS NULL THEN
        plan_limit := 5; 
    END IF;

    SELECT COUNT(*) INTO existing_user_count FROM public.users WHERE school_id = current_school_id;

    IF existing_user_count >= plan_limit THEN
        RAISE EXCEPTION 'Admin limit reached for your % plan (% users). Please upgrade your plan.', current_plan, plan_limit;
    END IF;

    -- 3. Create the user in auth.users
    new_auth_id := gen_random_uuid();
    
    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, recovery_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
    ) VALUES (
        '00000000-0000-0000-0000-000000000000', new_auth_id, 'authenticated', 'authenticated', new_email, crypt(new_password, gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, ('{"name":"'||new_name||'"}')::jsonb, now(), now(), '', '', '', ''
    );

    INSERT INTO auth.identities (
        id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) VALUES (
        gen_random_uuid(), new_auth_id, format('{"sub":"%s","email":"%s","email_verified":false,"phone_verified":false}', new_auth_id::text, new_email)::jsonb, 'email', new_email, now(), now(), now()
    );

    -- 4. Insert into public.users
    INSERT INTO public.users (school_id, auth_user_id, name, email, role)
    VALUES (current_school_id, new_auth_id, new_name, new_email, new_role);

    RETURN json_build_object('status', 'success', 'user_id', new_auth_id, 'email', new_email);
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'A user with this email already exists.';
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to invite user: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;


-- ============================================================
-- 2. FIX: E-Learning RLS Data Exposure
-- ============================================================
-- The previous policies allowed any authenticated user to 
-- read/modify assignments and submissions for any school.

DROP POLICY IF EXISTS "Enable all access for authenticated users" ON public.el_assignments;
DROP POLICY IF EXISTS "Enable all access for authenticated users submissions" ON public.el_submissions;

CREATE POLICY "el_assignments_select" ON public.el_assignments 
FOR SELECT USING (school_id = public.get_auth_school_id() OR public.is_school_owner(school_id));

CREATE POLICY "el_assignments_modify" ON public.el_assignments 
FOR ALL USING (school_id = public.get_auth_school_id() OR public.is_school_owner(school_id));

CREATE POLICY "el_submissions_select" ON public.el_submissions 
FOR SELECT USING (
    assignment_id IN (
        SELECT id FROM public.el_assignments 
        WHERE school_id = public.get_auth_school_id() OR public.is_school_owner(school_id)
    )
);

CREATE POLICY "el_submissions_modify" ON public.el_submissions 
FOR ALL USING (
    assignment_id IN (
        SELECT id FROM public.el_assignments 
        WHERE school_id = public.get_auth_school_id() OR public.is_school_owner(school_id)
    )
);
