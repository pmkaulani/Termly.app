import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const suppliedToken = url.searchParams.get('token');
    const expectedToken = Deno.env.get('MPESA_CALLBACK_TOKEN');
    if (!expectedToken || suppliedToken !== expectedToken) {
      return new Response(JSON.stringify({ error: 'Unauthorized callback.' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const callback = body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) {
      return new Response(JSON.stringify({ ResultCode: 1, ResultDesc: 'Invalid callback payload.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const items = callback.CallbackMetadata?.Item || [];
    const getValue = (name: string) => items.find((item: any) => item.Name === name)?.Value;
    const receipt = getValue('MpesaReceiptNumber');
    const amount = getValue('Amount');
    const transactionDate = getValue('TransactionDate');
    const phone = getValue('PhoneNumber');

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    );

    // The database function locks the callback and fee rows and writes the
    // receipt + fee ledger + final callback status in one transaction.
    const { data, error } = await admin.rpc('process_mpesa_stk_callback', {
      p_checkout_request_id: callback.CheckoutRequestID,
      p_result_code: Number(callback.ResultCode ?? -1),
      p_result_desc: String(callback.ResultDesc || ''),
      p_receipt_no: receipt == null ? null : String(receipt),
      p_amount: amount == null ? null : Number(amount),
      p_transaction_date: transactionDate == null ? null : String(transactionDate),
      p_payer_phone: phone == null ? null : String(phone),
    });

    if (error) {
      console.error('M-Pesa callback ledger transaction failed:', error.message);
      // Do not mark the callback completed. A retry/reconciliation can process it.
      return new Response(JSON.stringify({ ResultCode: 1, ResultDesc: 'Payment ledger processing failed. Please retry.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log('M-Pesa callback processed:', data);
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('M-Pesa callback handler error:', error?.message || error);
    return new Response(JSON.stringify({ ResultCode: 1, ResultDesc: 'Callback could not be processed.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});
