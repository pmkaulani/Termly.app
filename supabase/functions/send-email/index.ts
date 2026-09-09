import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

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
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    // Ensure the user is authenticated to send emails
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Verify user role
    const { data: userData, error: userError } = await supabaseClient
      .from('users')
      .select('role')
      .eq('auth_user_id', user.id)
      .single();

    if (userError || !userData || ['student', 'parent'].includes(userData.role?.toLowerCase())) {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions to send emails' }), {
        status: 403,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const payload = await req.json();
    const { to, subject, html } = payload;

    if (!to || !subject || !html) {
      throw new Error("Missing 'to', 'subject', or 'html' in request payload.");
    }

    if (!RESEND_API_KEY) {
      console.warn("RESEND_API_KEY not set. Simulating email send:", { to, subject });
      return new Response(JSON.stringify({ success: true, simulated: true }), { 
        status: 200, 
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } 
      });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Termly Notifications <notifications@termly-app.vercel.app>',
        to: [to],
        subject: subject,
        html: html,
      }),
    });

    const resData = await res.json();
    if (!res.ok) throw new Error(resData.message || 'Failed to send email via Resend');

    return new Response(JSON.stringify({ success: true, id: resData.id }), { 
      status: 200, 
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    console.error('Email sending error:', error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 400, 
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } 
    });
  }
});
