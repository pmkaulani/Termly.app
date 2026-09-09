import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const callbackToken = url.searchParams.get('token');
    const expectedToken = Deno.env.get('MPESA_CALLBACK_TOKEN');

    if (!expectedToken || callbackToken !== expectedToken) {
      console.error('Unauthorized callback attempt. Invalid or missing token.');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const body = await req.json();
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      // Not a shape we recognize — still return 200 so Safaricom doesn't
      // retry indefinitely, but log it so a malformed callback isn't silent.
      console.error('Unrecognized M-Pesa callback shape:', JSON.stringify(body));
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Find the pending record mpesa-stk-push created when the push was sent.
    const { data: pending, error: findError } = await supabaseAdmin
      .from('mpesa_callbacks')
      .select('id')
      .eq('checkout_request_id', CheckoutRequestID)
      .single();

    if (findError || !pending) {
      // A callback arrived that doesn't match anything we sent — could be a
      // stale/duplicate delivery, or the initial insert in mpesa-stk-push
      // failed silently. Either way, log it; there's nothing to update.
      console.error(`No matching mpesa_callbacks row for CheckoutRequestID ${CheckoutRequestID}`);
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
    }

    if (ResultCode === 0) {
      // Success — pull the confirmed amount/receipt/date out of
      // CallbackMetadata.Item, which Safaricom sends as a flat array of
      // {Name, Value} pairs rather than a normal object.
      const items = stkCallback.CallbackMetadata?.Item || [];
      const getVal = (name) => items.find((i) => i.Name === name)?.Value;

      await supabaseAdmin.from('mpesa_callbacks').update({
        status: 'pending', // matches what autoProcessMpesaCallbacks() already reads and reconciles
        result_code: ResultCode,
        mpesa_receipt_number: getVal('MpesaReceiptNumber'),
        amount: getVal('Amount'),
        transaction_date: getVal('TransactionDate'),
        phone_number: getVal('PhoneNumber'),
        result_desc: ResultDesc,
      }).eq('id', pending.id);
    } else {
      // Customer cancelled, entered the wrong PIN, timed out, etc. —
      // ResultCode is non-zero for all of these. Record it as failed
      // rather than leaving it stuck in 'awaiting_callback' forever.
      await supabaseAdmin.from('mpesa_callbacks').update({
        status: 'failed',
        result_code: ResultCode,
        result_desc: ResultDesc,
      }).eq('id', pending.id);
    }

    // Safaricom expects exactly this shape back, regardless of outcome —
    // it's an acknowledgment that you received the callback, not a
    // reflection of whether the payment succeeded.
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('mpesa-callback error:', error.message);
    // Still 200 — a 4xx/5xx here just makes Safaricom retry the same
    // callback repeatedly, which won't fix whatever the underlying
    // problem was.
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
  }
})
