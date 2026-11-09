import { supabase } from '../lib/supabase';
import { _currentSchoolId, mutationGuard } from './coreStore';
import { sendSMSMessage, sendWhatsAppMessage, queueSmsBatch, logCommunication } from './smsStore';

/**
 * Broadcast Store — Phase 1: WhatsApp Flows & SMS Fallback
 * Unified multi-channel dispatch with templates, delivery tracking, and fallback logic.
 */

// ===========================
// BROADCAST TEMPLATES
// ===========================

export const BROADCAST_TEMPLATES = {
  emergency_alert: {
    key: 'emergency_alert',
    name: 'Emergency Alert',
    icon: 'Alert',
    color: '#EF4444',
    bg: '#FEF2F2',
    description: 'Urgent safety or emergency notification',
    smsTemplate: (data) =>
      `URGENT UPDATE from ${data.schoolName}: ${data.message}. Please rest assured that the situation is being managed. Contact ${data.phone || 'the office'} for official updates.`,
    whatsappTemplate: (data) =>
      `*URGENT NOTIFICATION | ${data.schoolName}*\n\nDear Parents,\n\nPlease be advised of the following urgent update:\n${data.message}\n\nYour children's safety and well-being remain our highest priority, and we are managing the situation closely. We kindly request that you monitor official school channels for further updates.\n\nFor immediate assistance or inquiries, please contact the school office at: ${data.phone || 'the office'}.\n\nTimestamp: ${new Date().toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}`,
  },

  fee_invoice: {
    key: 'fee_invoice',
    name: 'Fee Invoice / Reminder',
    icon: 'Card',
    color: '#F59E0B',
    bg: '#FFFBEB',
    description: 'Fee balance reminder with M-Pesa payment details',
    smsTemplate: (data) =>
      `Dear ${data.parentName || 'Parent'}, this is a polite reminder from ${data.schoolName} that ${data.childName}'s fee balance of KSh ${Number(data.balance || 0).toLocaleString()} is due. Please submit payment via M-Pesa Paybill ${data.paybill || '---'}, A/C ${data.admNo || 'N/A'}. Thank you for your continued support.`,
    whatsappTemplate: (data) =>
      `Dear ${data.parentName || 'Parent'},\n\nWarm greetings from ${data.schoolName}.\nThis is a gentle reminder regarding the outstanding fee balance for your child, *${data.childName}*.\n\n*Account Details:*\n• Admission Number: ${data.admNo || 'N/A'}\n• Current Balance: *KSh ${Number(data.balance || 0).toLocaleString()}*\n\n*Payment Instructions:*\nPlease remit payment via M-Pesa Paybill: *${data.paybill || '---'}*\nAccount Number: *${data.admNo || 'N/A'}*\n\nIf you have already settled this amount, please disregard this message. Thank you for being a valued part of our community.`,
  },

  exam_results: {
    key: 'exam_results',
    name: 'Exam Results Notification',
    icon: 'Book',
    color: '#3B82F6',
    bg: '#EFF6FF',
    description: 'Notify parents that exam results are available',
    smsTemplate: (data) =>
      `Dear ${data.parentName || 'Parent'}, ${data.childName || "your child"}'s ${data.examName || 'exam'} results have been officially released by ${data.schoolName}. Please log in to your Parent Portal to view the comprehensive report card.`,
    whatsappTemplate: (data) =>
      `Dear ${data.parentName || 'Parent'},\n\nWe are pleased to inform you that the *${data.examName || 'Term Exam'}* results for *${data.childName || 'your child'}* have been officially published by ${data.schoolName}.\n\nWe encourage you to review your child's academic progress by logging into the Termly Parent Portal, where the comprehensive report card is now available for download.\n\nShould you have any questions or wish to discuss the results, please feel free to contact the academic office.\n\nWarm regards,\n${data.schoolName} Administration`,
  },

  general_notice: {
    key: 'general_notice',
    name: 'General Notice',
    icon: 'Notice',
    color: '#8B5CF6',
    bg: '#F5F3FF',
    description: 'General school announcement or circular',
    smsTemplate: (data) =>
      `Official Notice from ${data.schoolName}: ${data.message}. Thank you for your attention.`,
    whatsappTemplate: (data) =>
      `*OFFICIAL ANNOUNCEMENT*\n*${data.schoolName}*\n\nDear Parents,\n\n${data.message}\n\nThank you for your continued cooperation and support.\n\nSincerely,\n${data.schoolName} Administration`,
  },
};

// ===========================
// CHANNEL STRATEGIES
// ===========================

const CHANNELS = {
  sms: {
    key: 'sms',
    name: 'SMS',
    icon: 'SMS',
    send: async (phones, message) => sendSMSMessage(phones, message),
  },
  whatsapp: {
    key: 'whatsapp',
    name: 'WhatsApp',
    icon: 'WhatsApp',
    send: async (phones, message) => sendWhatsAppMessage(phones, message),
  },
};

// ===========================
// SEND BROADCAST
// ===========================

/**
 * Send a broadcast message via one or both channels.
 * @param {Object} opts
 * @param {'sms'|'whatsapp'|'both'} opts.channel
 * @param {string} opts.templateKey — key from BROADCAST_TEMPLATES
 * @param {Array<{phone: string, parentName?: string, childName?: string, admNo?: string, balance?: number}>} opts.recipients
 * @param {Object} opts.data — extra template data (schoolName, message, etc.)
 * @param {string} opts.schoolName
 * @returns {Promise<{success: boolean, stats: Object}>}
 */
export async function sendBroadcast({ channel = 'sms', templateKey, recipients, data = {}, schoolName }) {
  mutationGuard('sendBroadcast');
  if (!_currentSchoolId) throw new Error('No school context for broadcast');

  const template = BROADCAST_TEMPLATES[templateKey] || BROADCAST_TEMPLATES.general_notice;
  const enrichedData = { ...data, schoolName: schoolName || data.schoolName || 'School' };

  const channels = channel === 'both' ? ['sms', 'whatsapp'] : [channel];
  const stats = { total: recipients.length * channels.length, sms_sent: 0, whatsapp_sent: 0, failed: 0, channel };

  for (const ch of channels) {
    const strategy = CHANNELS[ch];
    if (!strategy) continue;

    const phones = recipients.map(r => r.phone).filter(Boolean);
    if (phones.length === 0) continue;

    // For personalized templates (fee_invoice), send individually
    if (templateKey === 'fee_invoice') {
      for (const recipient of recipients) {
        if (!recipient.phone) { stats.failed++; continue; }
        try {
          const personalData = { ...enrichedData, ...recipient };
          const msg = ch === 'whatsapp'
            ? template.whatsappTemplate(personalData)
            : template.smsTemplate(personalData);
          const result = await strategy.send([recipient.phone], msg);
          const accepted = Number(result?.accepted_count ?? result?.count ?? 0);
          stats[`${ch}_sent`] += accepted;
          stats.failed += Math.max(0, 1 - accepted);
        } catch (err) {
          console.error(`[Broadcast] Failed to send ${ch} to ${recipient.phone}:`, err);
          stats.failed++;
        }
      }
    } else {
      // Bulk send for non-personalized templates
      try {
        const msg = ch === 'whatsapp'
          ? template.whatsappTemplate(enrichedData)
          : template.smsTemplate(enrichedData);
        const result = await strategy.send(phones, msg);
        const accepted = Number(result?.accepted_count ?? result?.count ?? 0);
        stats[`${ch}_sent`] += accepted;
        stats.failed += Math.max(0, recipients.length - phones.length) + Math.max(0, phones.length - accepted);
      } catch (err) {
        console.error(`[Broadcast] Bulk ${ch} failed:`, err);
        stats.failed += phones.length;
      }
    }
  }

  // Log the broadcast
  try {
    await supabase.from('broadcast_logs').insert({
      school_id: _currentSchoolId,
      channel,
      template: templateKey,
      recipient_count: stats.total,
      sms_sent: stats.sms_sent,
      whatsapp_sent: stats.whatsapp_sent,
      failed: stats.failed,
      message_preview: template.smsTemplate(enrichedData).substring(0, 200),
      metadata: { data: enrichedData },
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[Broadcast] Failed to log broadcast:', e.message);
  }

  // Also log as announcement for the Communications page
  try {
    await logCommunication({
      type: channel === 'both' ? 'whatsapp' : channel,
      channel,
      message: template.smsTemplate(enrichedData),
      target: 'broadcast',
      count: stats.total,
    });
  } catch (e) {
    console.warn('[Broadcast] Failed to log announcement:', e.message);
  }

  return { success: stats.failed === 0 && stats.sms_sent + stats.whatsapp_sent > 0, stats, state: 'provider_accepted_not_delivery_confirmed' };
}

// ===========================
// BROADCAST HISTORY
// ===========================

export async function getBroadcastHistory(limit = 50) {
  if (!_currentSchoolId) return [];
  try {
    const { data, error } = await supabase
      .from('broadcast_logs')
      .select('*')
      .eq('school_id', _currentSchoolId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[Broadcast] History fetch failed:', e.message);
    return [];
  }
}

// ===========================
// BROADCAST STATS
// ===========================

export async function getBroadcastStats() {
  if (!_currentSchoolId) return { total_sent: 0, by_channel: {}, by_template: {} };
  try {
    const { data, error } = await supabase
      .from('broadcast_logs')
      .select('channel, template, sms_sent, whatsapp_sent, recipient_count')
      .eq('school_id', _currentSchoolId);
    if (error) throw error;

    const stats = { total_sent: 0, by_channel: { sms: 0, whatsapp: 0 }, by_template: {} };
    (data || []).forEach(row => {
      stats.total_sent += (row.sms_sent || 0) + (row.whatsapp_sent || 0);
      stats.by_channel.sms += row.sms_sent || 0;
      stats.by_channel.whatsapp += row.whatsapp_sent || 0;
      if (!stats.by_template[row.template]) stats.by_template[row.template] = 0;
      stats.by_template[row.template] += row.recipient_count || 0;
    });
    return stats;
  } catch (e) {
    console.warn('[Broadcast] Stats fetch failed:', e.message);
    return { total_sent: 0, by_channel: {}, by_template: {} };
  }
}

// ===========================
// QUICK SEND HELPERS
// ===========================

/**
 * Quick-send an emergency alert to all parents.
 */
export async function sendEmergencyAlert(message, recipients, schoolName, schoolPhone) {
  return sendBroadcast({
    channel: 'both',
    templateKey: 'emergency_alert',
    recipients,
    data: { message, phone: schoolPhone },
    schoolName,
  });
}

/**
 * Quick-send fee reminders to defaulters.
 */
export async function sendFeeReminders(defaulters, paybill, schoolName) {
  const recipients = defaulters.map(d => ({
    phone: d.parentPhone || d.parent_phone,
    parentName: d.parentName || d.parent_name || 'Parent',
    childName: d.name,
    admNo: d.admNo || d.adm_no,
    balance: d.balance || 0,
  }));
  return sendBroadcast({
    channel: 'sms',
    templateKey: 'fee_invoice',
    recipients,
    data: { paybill },
    schoolName,
  });
}
