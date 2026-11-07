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
      console.error('Unrecognized M-Pesa callback shape:', JSON.stringify(body));
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 1. Locate the pending callback row
    const { data: pending, error: findError } = await supabaseAdmin
      .from('mpesa_callbacks')
      .select('*')
      .eq('checkout_request_id', CheckoutRequestID)
      .maybeSingle();

    if (findError || !pending) {
      console.error(`No matching mpesa_callbacks row for CheckoutRequestID ${CheckoutRequestID}`);
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
    }

    // 2. Idempotency check: if already completed, do NOT double credit
    if (pending.status === 'completed' || pending.status === 'processed') {
      console.log(`Duplicate callback received for CheckoutRequestID ${CheckoutRequestID}. Already processed.`);
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
    }

    // 3. Process outcome
    if (ResultCode === 0) {
      const items = stkCallback.CallbackMetadata?.Item || [];
      const getVal = (name: string) => items.find((i: any) => i.Name === name)?.Value;
      const receiptNo = String(getVal('MpesaReceiptNumber') || '').trim();
      const confirmedAmount = Number(getVal('Amount') || pending.amount);
      const transactionDate = getVal('TransactionDate');
      const payerPhone = getVal('PhoneNumber');

      // Update callback record
      await supabaseAdmin.from('mpesa_callbacks').update({
        status: 'completed',
        result_code: ResultCode,
        mpesa_receipt_number: receiptNo,
        amount: confirmedAmount,
        transaction_date: transactionDate,
        phone_number: payerPhone,
        result_desc: ResultDesc,
        updated_at: new Date().toISOString()
      }).eq('id', pending.id);

      // Reconcile fee ledger idempotently
      if (pending.bill_ref_number && pending.school_id) {
        const { data: student } = await supabaseAdmin
          .from('students')
          .select('id')
          .eq('school_id', pending.school_id)
          .or(`adm_no.eq.${pending.bill_ref_number},id.eq.${pending.bill_ref_number}`)
          .maybeSingle();

        if (student) {
          const { data: fee } = await supabaseAdmin
            .from('fees')
            .select('id, balance, paid')
            .eq('student_id', student.id)
            .maybeSingle();

          if (fee) {
            // Check if payment with this receipt already recorded
            const { data: existingPayment } = await supabaseAdmin
              .from('fee_payments')
              .select('id')
              .eq('reference', receiptNo)
              .maybeSingle();

            if (!existingPayment) {
              await supabaseAdmin.from('fee_payments').insert({
                fee_id: fee.id,
                amount: confirmedAmount,
                method: 'M-Pesa',
                reference: receiptNo,
                receipt_number: receiptNo,
                date: new Date().toISOString(),
                status: 'Confirmed'
              });

              await supabaseAdmin.from('fees').update({
                paid: (Number(fee.paid) || 0) + confirmedAmount,
                balance: (Number(fee.balance) || 0) - confirmedAmount
              }).eq('id', fee.id);
            }
          }
        }
      }
    } else {
      // Payment failed / cancelled / timed out
      await supabaseAdmin.from('mpesa_callbacks').update({
        status: 'failed',
        result_code: ResultCode,
        result_desc: ResultDesc,
        updated_at: new Date().toISOString()
      }).eq('id', pending.id);
    }

    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('mpesa-callback error:', error.message);
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), { status: 200 });
  }
});
