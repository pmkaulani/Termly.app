import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const defaultAllowedOrigins = [
  'https://termly.com',
  'https://app.termly.school',
  'http://localhost:5173',
  'http://localhost:3000',
  'capacitor://localhost',
  'app://.'
];

// A school-hosted deployment adds its exact Termly HTTPS origin via the
// server-side TERMLY_ALLOWED_ORIGINS variable (comma-separated). No wildcard.
const allowedOrigins = new Set([
  ...defaultAllowedOrigins,
  ...(Deno.env.get('TERMLY_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean)
]);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  return {
    ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-portal-token, x-session-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function getDarajaTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)?.value || '00';
  return [part('year'), part('month'), part('day'), part('hour'), part('minute'), part('second')].join('');
}

async function getOAuthToken(env: string, key: string, secret: string) {
  const url = env === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const auth = btoa(`${key}:${secret}`);
  
  const response = await fetch(url, {
    headers: { 'Authorization': `Basic ${auth}` }
  });
  
  const data = await response.json();
  if (!response.ok) throw new Error(data.errorMessage || 'M-Pesa Auth Failed');
  return data.access_token;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } }
    });

    // 1. Authenticate the caller: either via Supabase Auth user or verified Portal Session Token
    const portalToken = req.headers.get('x-portal-token') || req.headers.get('x-session-token');
    let authenticatedSchoolId: string | null = null;
    let authenticatedStudentId: string | null = null;
    let callerRole: string = 'anon';

    if (portalToken) {
      const { data: session } = await supabaseAdmin
        .from('portal_sessions')
        .select('*')
        .eq('token', portalToken)
        .eq('revoked', false)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (session) {
        authenticatedSchoolId = session.school_id;
        authenticatedStudentId = session.entity_id;
        callerRole = session.role;
      }
    }

    if (!authenticatedSchoolId) {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (user) {
        const { data: userData } = await supabaseAdmin
          .from('users')
          .select('school_id, role')
          .eq('auth_user_id', user.id)
          .maybeSingle();
        if (userData) {
          authenticatedSchoolId = userData.school_id;
          callerRole = userData.role || 'Admin';
        } else {
          const { data: ownerSchool } = await supabaseAdmin.from('schools').select('id')
            .eq('owner_id', user.id).maybeSingle();
          if (ownerSchool?.id) { authenticatedSchoolId = ownerSchool.id; callerRole = 'owner'; }
        }
      }
    }

    if (!authenticatedSchoolId) {
      return new Response(JSON.stringify({ error: 'Unauthorized: valid portal session or login required.' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const { action, payload } = await req.json();

    const CONSUMER_KEY = Deno.env.get('MPESA_CONSUMER_KEY') ?? '';
    const CONSUMER_SECRET = Deno.env.get('MPESA_CONSUMER_SECRET') ?? '';
    const PASSKEY = Deno.env.get('MPESA_PASSKEY') ?? '';
    const SHORTCODE = Deno.env.get('MPESA_SHORTCODE') ?? '';
    const CALLBACK_URL = Deno.env.get('MPESA_CALLBACK_URL') ?? '';
    const ENVIRONMENT = Deno.env.get('MPESA_ENVIRONMENT') || 'sandbox';

    if (action === 'test_connection') {
      const role = String(callerRole || '').toLowerCase();
      if (!['owner', 'admin'].includes(role)) {
        return new Response(JSON.stringify({ success: false, message: 'Only a school owner or administrator can test Daraja credentials.' }), {
          status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      if (!CONSUMER_KEY || CONSUMER_KEY === 'MOCK_KEY' || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY) {
        return new Response(JSON.stringify({ success: false, message: 'Daraja credentials are incomplete. Configure secrets in Supabase.' }), {
          status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      try {
        await getOAuthToken(ENVIRONMENT, CONSUMER_KEY, CONSUMER_SECRET);
        return new Response(JSON.stringify({ success: true, message: 'Safaricom Daraja OAuth authentication succeeded. No payment prompt was sent.' }), {
          status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      } catch (testError) {
        return new Response(JSON.stringify({ success: false, message: testError.message || 'Daraja OAuth authentication failed.' }), {
          status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
    }

    // 2. Action: Push (STK Push initiation)
    if (action === 'push') {
      const { phoneNumber, amount, accountRef, description, studentId } = payload;
      const role = String(callerRole || '').toLowerCase();
      const parentSession = role === 'parent' || role === 'student';
      if (parentSession && studentId && studentId !== authenticatedStudentId) {
        return new Response(JSON.stringify({ error: 'A parent portal session can only initiate payment for its linked student.' }), {
          status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      if (!parentSession && !['owner', 'admin', 'finance'].includes(role)) {
        return new Response(JSON.stringify({ error: 'Your account is not authorized to initiate school fee payments.' }), {
          status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      const targetStudentId = parentSession ? authenticatedStudentId : (studentId || authenticatedStudentId);

      if (!targetStudentId) {
        return new Response(JSON.stringify({ error: 'Student ID is required.' }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      // Verify student belongs to this school
      const { data: student, error: stuErr } = await supabaseAdmin
        .from('students')
        .select('id, name, adm_no, school_id, parent_phone')
        .eq('id', targetStudentId)
        .eq('school_id', authenticatedSchoolId)
        .single();

      if (stuErr || !student) {
        return new Response(JSON.stringify({ error: 'Student not found in your institution.' }), {
          status: 403,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      // Validate payment amount bounds
      const numAmount = Math.round(Number(amount));
      if (isNaN(numAmount) || numAmount < 1 || numAmount > 150000) {
        return new Response(JSON.stringify({ error: 'Invalid amount. Must be between KSh 1 and KSh 150,000.' }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      // Validate phone number format (Kenyan MSISDN)
      let cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
      if (cleanPhone.length === 9) cleanPhone = '254' + cleanPhone;
      if (!/^254(7|1)\d{8}$/.test(cleanPhone)) {
        return new Response(JSON.stringify({ error: 'Invalid phone number. Format: 2547XXXXXXXX or 2541XXXXXXXX.' }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      // Check against the school's active academic-period ledger.
      const { data: activePeriod, error: periodError } = await supabaseAdmin
        .from('academic_periods').select('id').eq('school_id', authenticatedSchoolId)
        .eq('is_active', true).order('year', { ascending: false }).limit(1).maybeSingle();
      if (periodError || !activePeriod) {
        return new Response(JSON.stringify({ error: 'No active academic period is configured for this school.' }), {
          status: 409, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      const { data: feeRecord, error: feeError } = await supabaseAdmin
        .from('fees').select('id, balance, total_fee, period_id')
        .eq('school_id', authenticatedSchoolId).eq('student_id', targetStudentId)
        .eq('period_id', activePeriod.id).maybeSingle();
      if (feeError || !feeRecord) {
        return new Response(JSON.stringify({ error: 'No fee ledger exists for this student in the active academic period.' }), {
          status: 409, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      if (numAmount > Number(feeRecord.balance || 0)) {
        return new Response(JSON.stringify({ error: 'Payment amount exceeds the outstanding fee balance.' }), {
          status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      if (feeRecord.balance !== null && Number(feeRecord.balance) <= 0) {
        return new Response(JSON.stringify({ error: 'Student fee balance is already settled.' }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      if (!CONSUMER_KEY || CONSUMER_KEY === 'MOCK_KEY') {
        return new Response(JSON.stringify({ error: 'Daraja is not configured. Mock transactions cannot send a real STK prompt and are disabled by this endpoint.' }), {
          status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      // Live Daraja STK Push
      const token = await getOAuthToken(ENVIRONMENT, CONSUMER_KEY, CONSUMER_SECRET);
      const timestamp = getDarajaTimestamp();
      const password = btoa(`${SHORTCODE}${PASSKEY}${timestamp}`);

      const url = ENVIRONMENT === 'sandbox'
        ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          BusinessShortCode: SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: numAmount,
          PartyA: cleanPhone,
          PartyB: SHORTCODE,
          PhoneNumber: cleanPhone,
          CallBackURL: CALLBACK_URL,
          AccountReference: student.adm_no || student.id,
          TransactionDesc: description || `School Fees - ${student.name}`
        })
      });

      const result = await response.json();
      if (result.ResponseCode !== '0') {
        throw new Error(result.ResponseDescription || 'M-Pesa STK Push rejected.');
      }

      const { error: trackingError } = await supabaseAdmin.from('mpesa_callbacks').insert({
        school_id: authenticatedSchoolId,
        merchant_request_id: result.MerchantRequestID,
        checkout_request_id: result.CheckoutRequestID,
        result_code: -1,
        bill_ref_number: student.adm_no || student.id,
        phone_number: cleanPhone,
        amount: numAmount,
        period_id: feeRecord.period_id,
        status: 'awaiting_callback',
        created_at: new Date().toISOString()
      });
      if (trackingError) {
        console.error('Safaricom accepted the STK request but Termly could not save its tracking row:', trackingError.message);
        return new Response(JSON.stringify({ error: 'Safaricom may have accepted this STK request, but Termly could not save its tracking record. Check transaction status before attempting another push.' }), {
          status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          MerchantRequestID: result.MerchantRequestID,
          CheckoutRequestID: result.CheckoutRequestID,
          ResponseDescription: result.ResponseDescription
        }),
        { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
      );
    } 
    // 3. Action: Status Query
    else if (action === 'status') {
      const statusRole = String(callerRole || '').toLowerCase();
      if (!['owner', 'admin', 'finance', 'parent', 'student'].includes(statusRole)) {
        return new Response(JSON.stringify({ error: 'Your account is not authorized to view M-Pesa transaction status.' }), {
          status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      const { checkoutRequestId } = payload;
      
      const { data: cbRecord } = await supabaseAdmin
        .from('mpesa_callbacks')
        .select('*')
        .eq('checkout_request_id', checkoutRequestId)
        .eq('school_id', authenticatedSchoolId)
        .maybeSingle();

      if (!cbRecord) {
        return new Response(JSON.stringify({ error: 'Transaction not found or access denied.' }), {
          status: 403,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }
      if (['parent', 'student'].includes(String(callerRole || '').toLowerCase())) {
        const { data: linkedStudent } = await supabaseAdmin.from('students').select('id, adm_no')
          .eq('id', authenticatedStudentId).eq('school_id', authenticatedSchoolId).maybeSingle();
        const ownReference = linkedStudent && (cbRecord.bill_ref_number === linkedStudent.id || cbRecord.bill_ref_number === linkedStudent.adm_no);
        if (!ownReference) return new Response(JSON.stringify({ error: 'A parent portal session can only view the linked student's payment status.' }), {
          status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      if (!CONSUMER_KEY || CONSUMER_KEY === 'MOCK_KEY') {
        return new Response(
          JSON.stringify({ status: cbRecord.status, result_code: cbRecord.result_code }),
          { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
        );
      }

      const token = await getOAuthToken(ENVIRONMENT, CONSUMER_KEY, CONSUMER_SECRET);
      const timestamp = getDarajaTimestamp();
      const password = btoa(`${SHORTCODE}${PASSKEY}${timestamp}`);

      const url = ENVIRONMENT === 'sandbox'
        ? 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query'
        : 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          BusinessShortCode: SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId
        })
      });

      const result = await response.json();
      return new Response(
        JSON.stringify(result),
        { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action specified.' }),
      { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 400 }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
