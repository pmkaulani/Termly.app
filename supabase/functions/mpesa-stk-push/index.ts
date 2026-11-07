import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const allowedOrigins = [
  'https://termly.com',
  'https://app.termly.school',
  'http://localhost:5173',
  'http://localhost:3000',
  'capacitor://localhost',
  'app://.'
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'https://termly.com';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-portal-token, x-session-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
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

    // 2. Action: Push (STK Push initiation)
    if (action === 'push') {
      const { phoneNumber, amount, accountRef, description, studentId } = payload;
      const targetStudentId = studentId || authenticatedStudentId;

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

      // Check against current fee ledger
      const { data: feeRecord } = await supabaseAdmin
        .from('fees')
        .select('id, balance, total_fee')
        .eq('student_id', targetStudentId)
        .maybeSingle();

      if (feeRecord && feeRecord.balance !== null && Number(feeRecord.balance) <= 0) {
        return new Response(JSON.stringify({ error: 'Student fee balance is already settled.' }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
        });
      }

      // Mock mode for local/dev testing
      if (!CONSUMER_KEY || CONSUMER_KEY === 'MOCK_KEY') {
        const mockMerchant = 'MOCK-' + Date.now();
        const mockCheckout = 'WS-' + Math.random().toString(36).substring(2, 9);
        await supabaseAdmin.from('mpesa_callbacks').insert({
          school_id: authenticatedSchoolId,
          merchant_request_id: mockMerchant,
          checkout_request_id: mockCheckout,
          result_code: -1,
          bill_ref_number: student.adm_no || student.id,
          phone_number: cleanPhone,
          amount: numAmount,
          status: 'awaiting_callback',
          created_at: new Date().toISOString()
        });

        return new Response(
          JSON.stringify({ success: true, MerchantRequestID: mockMerchant, CheckoutRequestID: mockCheckout }),
          { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
        );
      }

      // Live Daraja STK Push
      const token = await getOAuthToken(ENVIRONMENT, CONSUMER_KEY, CONSUMER_SECRET);
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
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

      await supabaseAdmin.from('mpesa_callbacks').insert({
        school_id: authenticatedSchoolId,
        merchant_request_id: result.MerchantRequestID,
        checkout_request_id: result.CheckoutRequestID,
        result_code: -1,
        bill_ref_number: student.adm_no || student.id,
        phone_number: cleanPhone,
        amount: numAmount,
        status: 'awaiting_callback',
        created_at: new Date().toISOString()
      });

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

      if (!CONSUMER_KEY || CONSUMER_KEY === 'MOCK_KEY') {
        return new Response(
          JSON.stringify({ status: cbRecord.status, result_code: cbRecord.result_code }),
          { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
        );
      }

      const token = await getOAuthToken(ENVIRONMENT, CONSUMER_KEY, CONSUMER_SECRET);
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
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
