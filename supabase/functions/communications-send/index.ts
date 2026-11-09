import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function normalizeKenyanPhone(value: unknown): string | null {
  let phone = String(value ?? '').replace(/\D/g, '');
  if (phone.startsWith('0')) phone = `254${phone.slice(1)}`;
  if (phone.length === 9) phone = `254${phone}`;
  return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

async function sendSms(phone: string, message: string) {
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY') || '';
  const username = Deno.env.get('AFRICASTALKING_USERNAME') || '';
  const senderId = Deno.env.get('AFRICASTALKING_SENDER_ID') || '';
  if (!apiKey || !username) throw new Error('SMS provider is not configured in Supabase Edge Function secrets.');

  const sandbox = username.toLowerCase() === 'sandbox';
  const endpoint = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const body = new URLSearchParams({ username, to: phone, message });
  if (senderId) body.set('from', senderId);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        apiKey,
      },
      body,
    });
  } catch (networkError) {
    const error = new Error('SMS provider request outcome is unknown. The message was not reset to the retry queue; check provider logs before attempting another send.') as Error & { indeterminate?: boolean };
    error.indeterminate = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.SMSMessageData?.Message || data?.errorMessage || `SMS provider returned HTTP ${response.status}.`);
  }

  const result = data?.SMSMessageData?.Recipients?.[0];
  const accepted = ['success', 'sent', 'queued'].includes(String(result?.status || '').toLowerCase());
  return {
    accepted,
    providerMessageId: result?.messageId || null,
    providerStatus: result?.status || 'Unknown',
    response: data,
    error: accepted ? null : (result?.status || data?.SMSMessageData?.Message || 'Provider did not accept the SMS.'),
  };
}

async function sendWhatsApp(phone: string, message: string) {
  const token = Deno.env.get('WHATSAPP_ACCESS_TOKEN') || '';
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';
  const version = Deno.env.get('WHATSAPP_GRAPH_VERSION') || 'v23.0';
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp Business Cloud API is not configured. No bulk WhatsApp messages were sent.');
  }

  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { preview_url: false, body: message },
      }),
    });
  } catch (networkError) {
    const error = new Error('WhatsApp provider request outcome is unknown. The message was not reset to the retry queue; check provider logs before attempting another send.') as Error & { indeterminate?: boolean };
    error.indeterminate = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `WhatsApp provider returned HTTP ${response.status}.`);
  }
  return {
    accepted: Array.isArray(data?.messages) && data.messages.length > 0,
    providerMessageId: data?.messages?.[0]?.id || null,
    providerStatus: 'accepted_by_meta',
    response: data,
    error: null,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Server configuration is incomplete.' }, 500);

  const authHeader = req.headers.get('Authorization') || '';
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData?.user) return json({ error: 'Authentication required.' }, 401);

  const { data: actorRow, error: actorError } = await admin
    .from('users')
    .select('id, school_id, role')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (actorError) return json({ error: 'Could not verify school membership.' }, 403);
  let actor = actorRow;
  if (!actor?.school_id) {
    const { data: ownerSchool, error: ownerError } = await admin.from('schools')
      .select('id').eq('owner_id', authData.user.id).maybeSingle();
    if (ownerError) return json({ error: 'Could not verify school ownership.' }, 403);
    if (ownerSchool?.id) actor = { id: null, school_id: ownerSchool.id, role: 'owner' };
  }
  if (!actor?.school_id) return json({ error: 'No school membership was found for this account.' }, 403);

  const role = String(actor.role || '').toLowerCase();
  if (!['owner', 'admin', 'finance', 'teacher', 'librarian'].includes(role)) {
    return json({ error: 'Your role is not allowed to send school communications.' }, 403);
  }

  let input: any;
  try { input = await req.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }

  const action = String(input?.action || 'send');
  const channel = String(input?.channel || 'sms').toLowerCase();
  if (!['sms', 'whatsapp'].includes(channel)) return json({ error: 'Channel must be sms or whatsapp.' }, 400);

  if (action === 'test_connection') {
    if (channel === 'whatsapp') {
      const configured = Boolean(Deno.env.get('WHATSAPP_ACCESS_TOKEN') && Deno.env.get('WHATSAPP_PHONE_NUMBER_ID'));
      return json({ success: configured, message: configured ? 'WhatsApp Cloud API credentials are present. No test message was sent.' : 'WhatsApp Cloud API credentials are not configured.' });
    }
    const apiKey = Deno.env.get('AFRICASTALKING_API_KEY') || '';
    const username = Deno.env.get('AFRICASTALKING_USERNAME') || '';
    if (!apiKey || !username) return json({ success: false, message: 'Africa’s Talking secrets are not configured in Supabase.' }, 200);
    const endpoint = username.toLowerCase() === 'sandbox'
      ? 'https://api.sandbox.africastalking.com/version1/user'
      : 'https://api.africastalking.com/version1/user';
    const check = await fetch(`${endpoint}?username=${encodeURIComponent(username)}`, { headers: { apiKey, Accept: 'application/json' } });
    const body = await check.json().catch(() => ({}));
    if (!check.ok) return json({ success: false, message: body?.errorMessage || `Provider check returned HTTP ${check.status}.` });
    return json({ success: true, message: 'Africa’s Talking credentials were accepted by the account endpoint. No SMS was sent.' });
  }

  const dispatch = async (phoneInput: unknown, messageInput: unknown, rowId: string) => {
    const phone = normalizeKenyanPhone(phoneInput);
    const message = String(messageInput ?? '').trim();
    if (!phone || !message || message.length > 1600) {
      const errorMessage = !phone ? 'Invalid Kenyan recipient phone number.' : 'Message must contain 1–1600 characters.';
      await admin.from('sms_messages').update({ status: 'failed', error_message: errorMessage })
        .eq('id', rowId).eq('school_id', actor.school_id).eq('status', 'queued');
      return { phone: phone || String(phoneInput || ''), accepted: false, error: errorMessage, logPersisted: true };
    }

    // Claim the queue row before calling the external provider. A second
    // dispatcher can only claim a row that is still queued, preventing a
    // double-send when retries or multiple tabs overlap.
    const { data: claimed, error: claimError } = await admin.from('sms_messages')
      .update({ status: 'sending', channel, error_message: null })
      .eq('id', rowId).eq('school_id', actor.school_id).eq('status', 'queued')
      .select('id').maybeSingle();
    if (claimError) throw new Error('Could not claim queued message: ' + claimError.message);
    if (!claimed) return { phone, accepted: false, error: 'Message is already being processed or is no longer queued.', logPersisted: true };

    let result: any;
    try {
      result = channel === 'sms' ? await sendSms(phone, message) : await sendWhatsApp(phone, message);
    } catch (providerError) {
      const errorMessage = String(providerError?.message || providerError);
      const indeterminate = Boolean((providerError as any)?.indeterminate);
      const { error: failedLogError } = indeterminate
        ? await admin.from('sms_messages').update({
            status: 'sending', error_message: errorMessage, provider_status: 'outcome_unknown',
          }).eq('id', rowId).eq('school_id', actor.school_id)
        : await admin.from('sms_messages').update({
            status: 'failed', error_message: errorMessage, provider_status: 'provider_error',
          }).eq('id', rowId).eq('school_id', actor.school_id);
      return { phone, accepted: false, indeterminate, error: errorMessage, logPersisted: !failedLogError, logError: failedLogError?.message || null };
    }

    const { error: finalizeError } = await admin.from('sms_messages').update({
      status: result.accepted ? 'accepted' : 'failed',
      provider_message_id: result.providerMessageId,
      provider_status: result.providerStatus,
      provider_response: JSON.stringify(result.response).slice(0, 8000),
      error_message: result.error,
      sent_at: result.accepted ? new Date().toISOString() : null,
    }).eq('id', rowId).eq('school_id', actor.school_id).eq('status', 'sending');

    // If this final write fails, leave the row in `sending`. Do not place it
    // back in the retryable queue: the provider may already have accepted it.
    return {
      phone,
      ...result,
      logPersisted: !finalizeError,
      logError: finalizeError?.message || null,
      state: finalizeError ? 'provider_result_not_persisted_do_not_retry_automatically' : undefined,
    };
  };

  if (action === 'dispatch_queued') {
    const ids = Array.isArray(input?.messageIds) ? input.messageIds.filter((id: unknown) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 100) return json({ error: 'Provide 1–100 queued message IDs.' }, 400);
    const { data: rows, error } = await admin.from('sms_messages').select('id, phone_number, message, status')
      .eq('school_id', actor.school_id).in('id', ids).eq('status', 'queued');
    if (error) return json({ error: error.message }, 500);
    const results = [];
    for (const row of rows || []) {
      try { results.push(await dispatch(row.phone_number, row.message, row.id)); }
      catch (err) {
        // A claim failure is not permission to reset another worker's row.
        results.push({ phone: row.phone_number, accepted: false, error: String(err?.message || err), logPersisted: false });
      }
    }
    const accepted = results.filter((r: any) => r.accepted).length;
    return json({ success: results.length > 0 && accepted === results.length, accepted_count: accepted, failed_count: results.length - accepted, total: results.length, results, state: 'provider_accepted_not_delivery_confirmed' });
  }

  if (action !== 'send') return json({ error: 'Unsupported action.' }, 400);
  const recipients = Array.isArray(input?.recipients) ? input.recipients : [];
  const message = String(input?.message ?? '').trim();
  if (!recipients.length || recipients.length > 100) return json({ error: 'Send to between 1 and 100 recipients per request.' }, 400);
  if (!message || message.length > 1600) return json({ error: 'Message must contain 1–1600 characters.' }, 400);

  const results = [];
  for (const recipient of recipients) {
    const phoneInput = typeof recipient === 'string' ? recipient : recipient?.phone;
    const phone = normalizeKenyanPhone(phoneInput);
    if (!phone) {
      results.push({ phone: String(phoneInput || ''), accepted: false, error: 'Invalid Kenyan phone number.' });
      continue;
    }
    const { data: queuedRow, error: queueError } = await admin.from('sms_messages').insert({
      school_id: actor.school_id,
      channel,
      phone_number: phone,
      message,
      type: input?.type || 'broadcast',
      status: 'queued',
    }).select('id').single();
    if (queueError || !queuedRow?.id) {
      results.push({ phone, accepted: false, error: queueError?.message || 'Could not create a message audit row.', logPersisted: false });
      continue;
    }
    try {
      results.push(await dispatch(phone, message, queuedRow.id));
    } catch (err) {
      results.push({ phone, accepted: false, error: String(err?.message || err), logPersisted: true });
    }
  }
  const accepted = results.filter((r: any) => r.accepted).length;
  return json({
    success: results.length > 0 && accepted === results.length,
    accepted_count: accepted,
    failed_count: results.length - accepted,
    total: results.length,
    results,
    state: 'provider_accepted_not_delivery_confirmed',
  });
});
