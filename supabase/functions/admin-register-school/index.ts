// supabase/functions/admin-register-school/index.ts
//
// Lets a platform admin register a new school on a prospect's
// behalf — the whole point of the "book a demo, then we register
// you" flow instead of self-serve signup. Creating another
// person's auth account requires the service-role key, which must
// never reach the browser, so this has to be an edge function —
// same reasoning as validate-shadow-session and mpesa-stk-push.
//
// Deploy: supabase functions deploy admin-register-school
// Reuses the existing register_school RPC for the actual school/
// profile creation, so there's exactly one place that logic lives.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const allowedOrigins = [
  'https://termly.com',
  'http://localhost:5173',
  'capacitor://localhost',
  'app://.'
];

function getCorsHeaders(req) {
  const origin = req.headers.get('origin');
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'https://termly.com';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function generateTempPassword() {
  // 12 chars, at least one upper/lower/digit — meets standard
  // Supabase Auth password requirements without being hard for
  // you to read aloud or type on a call with a bursar.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) pw += chars[bytes[i] % chars.length];
  return pw;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  try {
    // 1. Verify the caller is a real, logged-in platform admin —
    //    exact same pattern as validate-shadow-session.
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 401,
      })
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: adminCheck, error: checkError } = await supabaseAdmin
      .from('platform_admins').select('email').eq('email', user.email).single()
    if (checkError || !adminCheck) {
      return new Response(JSON.stringify({ error: 'Forbidden: Not a Platform Admin' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 403,
      })
    }

    // 2. Read the school + admin details from the request body.
    const { schoolName, adminName, adminEmail, phone, location, curriculum, demoRequestId } = await req.json();
    if (!schoolName || !adminName || !adminEmail) {
      return new Response(JSON.stringify({ error: 'schoolName, adminName, and adminEmail are required' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // 3. Create the school admin's auth account with a generated
    //    temp password. email_confirm: true skips the confirmation
    //    email entirely — deliberate, since transactional email
    //    isn't reliable yet (see the Resend/SMTP conversation) and
    //    this account is being vouched for by a human, not a click
    //    on a confirmation link.
    const tempPassword = generateTempPassword();
    const { data: newUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email: adminEmail,
      password: tempPassword,
      email_confirm: true,
    });
    if (createUserError) {
      return new Response(JSON.stringify({ error: `Could not create admin account: ${createUserError.message}` }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 400,
      })
    }

    // 4. Register the school itself via the existing RPC — same
    //    function Register.jsx already calls, so there's exactly
    //    one place "creating a school" happens.
    const { data: schoolData, error: registerError } = await supabaseAdmin.rpc('register_school', {
      school_name: schoolName,
      school_email: adminEmail,
      plan: 'standard',
      owner_id: newUser.user.id,
      admin_name: adminName,
      admin_email: adminEmail,
      phone: phone ?? null,
      location: location ?? null,
      curriculum: curriculum ?? 'CBC',
    });

    if (registerError) {
      // The auth user now exists without a school attached — surface
      // this clearly rather than silently leaving an orphaned account.
      return new Response(JSON.stringify({
        error: `Admin account created, but school registration failed: ${registerError.message}. The auth user (${adminEmail}) exists — check for it before retrying, to avoid a duplicate.`
      }), { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 500 })
    }

    // 5. Mark the demo request as registered, if this came from one.
    if (demoRequestId) {
      await supabaseAdmin.from('demo_requests').update({ status: 'registered' }).eq('id', demoRequestId);
    }

    return new Response(JSON.stringify({
      success: true,
      tempPassword,
      adminEmail,
      school: schoolData,
    }), { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 400,
    })
  }
})
