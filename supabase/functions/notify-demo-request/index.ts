import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const SUPERADMIN_EMAIL = Deno.env.get('SUPERADMIN_EMAIL');

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
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  try {
    const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET');
    const secretHeader = req.headers.get('x-webhook-secret');
    if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid webhook secret' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const payload = await req.json();

    // Check if this is an INSERT into demo_requests
    if (payload.type !== 'INSERT' || payload.table !== 'demo_requests') {
      return new Response(JSON.stringify({ error: 'Ignored, not a new demo request' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const { school_name, contact_name, phone, email, student_count, message } = payload.record;

    // 1. Send Telegram Notification
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const telegramText = `
*New Demo Request!*
*School:* ${school_name}
*Contact:* ${contact_name}
*Phone:* ${phone}
*Email:* ${email}
*Students:* ${student_count || 'Not provided'}
*Message:* ${message || 'None'}
      `;

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: telegramText,
          parse_mode: 'Markdown',
        }),
      }).catch(err => console.error("Telegram error:", err));
    }

    // 2. Send Email Notification via Resend
    if (RESEND_API_KEY && SUPERADMIN_EMAIL) {
      const BRAND_COLORS = { primary: '#5B3EF5', bg: '#F8FAFC' };
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            .container { max-width: 600px; margin: 40px auto; font-family: sans-serif; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background: ${BRAND_COLORS.primary}; padding: 40px 20px; text-align: center; color: #ffffff; }
            .body { padding: 40px; line-height: 1.6; color: #1E293B; }
            .btn { display: inline-block; padding: 14px 28px; background: ${BRAND_COLORS.primary}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; }
          </style>
        </head>
        <body style="background-color: ${BRAND_COLORS.bg}; margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <h1 style="margin: 0; font-size: 24px;">New Demo Request</h1>
              <p style="margin: 8px 0 0; opacity: 0.8;">${school_name}</p>
            </div>
            <div class="body">
              <p>A new school has requested a demo via the landing page. Here are the details:</p>
              <ul>
                <li><strong>Contact Name:</strong> ${contact_name}</li>
                <li><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></li>
                <li><strong>Email:</strong> <a href="mailto:${email}">${email}</a></li>
                <li><strong>Approx. Students:</strong> ${student_count || 'Not provided'}</li>
              </ul>
              <p><strong>Message:</strong></p>
              <blockquote style="background: #f1f5f9; padding: 16px; border-left: 4px solid ${BRAND_COLORS.primary}; margin: 0;">
                ${message || 'None'}
              </blockquote>
              <p style="text-align: center; margin-top: 32px;">
                <a href="https://termly-app.vercel.app/super-admin" class="btn">Log in to SuperAdmin Dashboard</a>
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Termly Notifications <onboarding@resend.dev>',
          to: [SUPERADMIN_EMAIL],
          subject: `New Demo Request: ${school_name}`,
          html: htmlContent,
        }),
      }).catch(err => console.error("Resend error:", err));
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
