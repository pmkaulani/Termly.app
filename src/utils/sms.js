import { supabase } from '../lib/supabase';

/**
 * SMS and WhatsApp dispatch is performed by a Supabase Edge Function.
 * Provider acceptance is not the same as handset delivery.
 */
export async function dispatchSMS(to, message) {
  const recipients = Array.isArray(to) ? to : [to];
  const cleanRecipients = recipients.map((value) => {
    let phone = String(value || '').replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (phone.length === 9) phone = '254' + phone;
    return /^254[17]\d{8}$/.test(phone) ? phone : null;
  }).filter(Boolean);

  if (!cleanRecipients.length) return { success: false, accepted_count: 0, failed_count: recipients.length, error: 'No valid Kenyan recipients.' };
  const { data, error } = await supabase.functions.invoke('communications-send', {
    body: { action: 'send', channel: 'sms', recipients: cleanRecipients, message, type: 'direct' },
  });
  if (error) throw new Error(error.message || 'SMS dispatch failed.');
  if (data?.error) throw new Error(data.error);
  return data;
}

export function generateAttendanceMessage(studentName, status, date) {
  const d = new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (status === 'absent') return 'Dear Parent, ' + studentName + ' was ABSENT from school today, ' + d + '. Please contact the office for any clarification. - Termly';
  if (status === 'late') return 'Dear Parent, ' + studentName + ' arrived LATE to school today, ' + d + '. Prompt arrival is encouraged. - Termly';
  return 'Dear Parent, ' + studentName + ' was present in school today, ' + d + '. - Termly';
}

export function generateFeeReminder(studentName, balance) {
  const fmt = (n) => 'KSh ' + Number(n).toLocaleString();
  return 'Dear Parent, this is a reminder that ' + studentName + ' has an outstanding fee balance of ' + fmt(balance) + '. Kindly settle to avoid disruptions. - Termly';
}
