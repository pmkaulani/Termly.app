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
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
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

    if (!CONSUMER_KEY || CONSUMER_KEY === 'MOCK_KEY') {
      if (action === 'push') {
        const { phoneNumber, amount } = payload;
        console.log(`[MPESA-MOCK] STK Push to ${phoneNumber} for KSh ${amount}`);
        return new Response(
          JSON.stringify({ success: true, MerchantRequestID: 'MOCK-' + Date.now(), CheckoutRequestID: 'WS-' + Math.random().toString(36).substr(2, 9) }),
          { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
        );
      } else {
        return new Response(
          JSON.stringify({ status: 'Pending' }),
          { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 200 }
        );
      }
    }

    const token = await getOAuthToken(ENVIRONMENT, CONSUMER_KEY, CONSUMER_SECRET);
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = btoa(`${SHORTCODE}${PASSKEY}${timestamp}`);

    if (action === 'push') {
      const { phoneNumber, amount, accountRef, description, schoolId } = payload;
      
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
          Amount: Math.round(amount),
          PartyA: phoneNumber,
          PartyB: SHORTCODE,
          PhoneNumber: phoneNumber,
          CallBackURL: CALLBACK_URL,
          AccountReference: accountRef || 'Fees',
          TransactionDesc: description || 'School Fees Payment'
        })
      });

      const result = await response.json();
      if (result.ResponseCode !== '0') {
        throw new Error(result.ResponseDescription || 'STK Push Failed');
      }

      // Without this row, an incoming callback has no way to know which
      // school (or which student's fee account) it belongs to — Safaricom's
      // callback payload only carries MerchantRequestID/CheckoutRequestID,
      // nothing app-specific. This is what mpesa-callback matches against.
      if (schoolId) {
        const supabaseAdmin = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );
        const { error: insertError } = await supabaseAdmin.from('mpesa_callbacks').insert({
          school_id: schoolId,
          merchant_request_id: result.MerchantRequestID,
          checkout_request_id: result.CheckoutRequestID,
          result_code: -1, // sentinel: no real result yet — column is NOT NULL, actual code arrives via mpesa-callback
          bill_ref_number: accountRef || null,
          phone_number: phoneNumber,
          amount: Math.round(amount),
          status: 'awaiting_callback',
        });
        if (insertError) {
          // The push already went to the customer's phone — don't fail the
          // request over this, but log it loudly, since a payment that
          // completes now has nothing to reconcile against.
          console.error('Could not create pending mpesa_callbacks row:', insertError.message);
        }
      } else {
        console.error('mpesa-stk-push called without schoolId — callback for this payment cannot be matched to a school.');
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
    } else if (action === 'status') {
      const { checkoutRequestId } = payload;
      
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
      JSON.stringify({ error: 'Invalid action' }),
      { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' }, status: 400 }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
