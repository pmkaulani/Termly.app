import { supabase } from '../lib/supabase';
import { _currentSchoolId, _currentAuthUser, mutationGuard } from './coreStore';
import { getUserByAuthId } from './authStore';

/**
 * SMS & Communication History Store
 */

export async function logSmsHistory(payload) {
  const { data, error } = await supabase
    .from('sms_logs')
    .insert([{
      ...payload,
      created_at: new Date().toISOString()
    }]);
  
  if (error) throw error;
  return data;
}

export async function getSmsLogs(schoolId) {
  const { data, error } = await supabase
    .from('sms_logs')
    .select('*')
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false });
  
  if (error) throw error;
  return data;
}

export async function getSmsBalance(schoolId) {
  const { data, error } = await supabase
    .from('school_profiles')
    .select('sms_balance')
    .eq('id', schoolId)
    .single();
  
  if (error) throw error;
  return data?.sms_balance || 0;
}


export async function queueSMS(phoneNumber, message, type = 'general') {
  if (!_currentSchoolId) throw new Error('No school context.');
  const { data, error } = await supabase
    .from('sms_messages')
    .insert({ school_id: _currentSchoolId, phone_number: phoneNumber, message, type, status: 'queued' })
    .select('id')
    .single();
  if (error) throw error;
  const { data: dispatched, error: dispatchError } = await supabase.functions.invoke('communications-send', {
    body: { action: 'dispatch_queued', channel: 'sms', messageIds: [data.id] },
  });
  if (dispatchError) return { queued: true, sent: false, id: data.id, status: 'queued', dispatchError: dispatchError.message };
  return { queued: true, sent: Number(dispatched?.accepted_count || 0) === 1, id: data.id, status: Number(dispatched?.accepted_count || 0) === 1 ? 'accepted' : 'failed', dispatch: dispatched };
}

export async function getSMSLogs() {
  if (!_currentSchoolId) return [];
  const { data, error } = await supabase
    .from('sms_messages')
    .select('*')
    .eq('school_id', _currentSchoolId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function queueSmsBatch(messages) {
  if (!_currentSchoolId || !messages.length) return { queued: 0, sent: 0 };
  const { data, error } = await supabase
    .from('sms_messages')
    .insert(messages.map((m) => ({
      school_id: _currentSchoolId,
      phone_number: m.phone,
      message: m.message,
      type: m.type || 'general',
      status: 'queued',
    })))
    .select('id');
  if (error) throw error;
  const ids = (data || []).map((row) => row.id);
  if (!ids.length) return { queued: 0, sent: 0, ids: [] };
  const { data: dispatched, error: dispatchError } = await supabase.functions.invoke('communications-send', {
    body: { action: 'dispatch_queued', channel: 'sms', messageIds: ids },
  });
  return { queued: ids.length, sent: Number(dispatched?.accepted_count || 0), failed: Number(dispatched?.failed_count || 0), ids, dispatchError: dispatchError?.message || null, dispatch: dispatched || null };
}

export async function testSmsConnection() {
  const { data, error } = await supabase.functions.invoke('communications-send', {
    body: { action: 'test_connection', channel: 'sms' },
  });
  if (error) return { success: false, message: error.message || 'SMS provider test failed.' };
  return data || { success: false, message: 'SMS provider returned no test result.' };
}

export async function logCommunication(comm) {
  mutationGuard('logCommunication');
  if (!_currentSchoolId) throw new Error('No school context');
  
  const creatorId = (await getUserByAuthId(_currentAuthUser?.id))?.id;
  
  if (comm.type === 'sms' || comm.type === 'whatsapp') {
    // If it's a broadcast, create an announcement record as well
    const { data, error } = await supabase
      .from('announcements')
      .insert({
        school_id: _currentSchoolId,
        created_by: creatorId,
        title: comm.channel === 'whatsapp' ? 'WhatsApp Broadcast' : 'SMS Broadcast',
        content: comm.message,
        target_audience: comm.target,
        status: 'published',
        metadata: {
          recipient_count: comm.count,
          channel: comm.type
        }
      })
      .select()
      .single();
    if (error) console.error('Failed to log announcement:', error);
    return data;
  }
  
  return { id: 'log-' + Date.now(), ...comm };
}

export async function sendSMSMessage(recipients, message) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const { data, error } = await supabase.functions.invoke('communications-send', {
    body: { action: 'send', channel: 'sms', recipients: list, message, type: 'broadcast' },
  });
  if (error) throw new Error(error.message || 'SMS dispatch failed.');
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function sendWhatsAppMessage(recipients, message) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const { data, error } = await supabase.functions.invoke('communications-send', {
    body: { action: 'send', channel: 'whatsapp', recipients: list, message, type: 'broadcast' },
  });
  if (error) throw new Error(error.message || 'WhatsApp dispatch failed.');
  if (data?.error) throw new Error(data.error);
  return data;
}

export function getWhatsAppLink(phone, message = '') {
  const clean = String(phone || '').replace(/\D/g, '');
  const normalized = clean.startsWith('0') ? '254' + clean.slice(1) : (clean.length === 9 ? '254' + clean : clean);
  if (!/^254[17]\d{8}$/.test(normalized)) throw new Error('Invalid Kenyan phone number.');
  return 'https://wa.me/' + normalized + (message ? '?text=' + encodeURIComponent(message) : '');
}

export async function getCommunicationLogs() {
  return getSMSLogs();
}
