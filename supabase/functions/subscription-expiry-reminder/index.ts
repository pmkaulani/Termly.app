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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    // Only allow platform admins to run this
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) throw new Response("Unauthorized", { status: 401 })

    const { data: adminCheck } = await supabaseClient
      .from('platform_admins')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()
    
    if (!adminCheck) throw new Response("Forbidden", { status: 403 })

    // Find schools expiring in 7 days
    const nextWeek = new Date()
    nextWeek.setDate(nextWeek.getDate() + 7)
    const nextWeekISO = nextWeek.toISOString().slice(0, 10)

    const { data: expiringProfiles, error: fetchError } = await supabaseClient
      .from('school_profiles')
      .select('school_id, school_name, subscription_expiry, license_type, schools(email, phone)')
      .neq('license_type', 'perpetual')
      .lt('subscription_expiry', nextWeek.toISOString())
      .gt('subscription_expiry', new Date().toISOString())

    if (fetchError) throw fetchError

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
    const BRAND_COLORS = { primary: '#5B3EF5', bg: '#F8FAFC' }

    if (expiringProfiles.length > 0 && RESEND_API_KEY) {
      for (const p of expiringProfiles) {
        const email = p.schools?.email
        if (!email) continue

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
                <h1 style="margin: 0; font-size: 24px;">Action Required: Subscription Expiring Soon</h1>
              </div>
              <div class="body">
                <p>Dear Admin,</p>
                <p>This is a gentle reminder that the Termly subscription for <strong>${p.school_name}</strong> is scheduled to expire in 7 days on <strong>${p.subscription_expiry.split('T')[0]}</strong>.</p>
                <p>To ensure uninterrupted access to your data, portals, and management tools, please renew your subscription before the expiry date.</p>
                <p style="text-align: center; margin-top: 32px; margin-bottom: 32px;">
                  <a href="https://termly-app.vercel.app/login" class="btn">Renew Subscription</a>
                </p>
                <p>If you have already made a payment that hasn't reflected, please contact our support team.</p>
                <p>Best regards,<br>The Termly Billing Team</p>
              </div>
            </div>
          </body>
          </html>
        `

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Termly Billing <billing@termly-app.vercel.app>',
            to: [email],
            subject: `Action Required: Your Termly Subscription is Expiring Soon`,
            html: htmlContent,
          }),
        }).catch(err => console.error("Resend error:", err))
      }
      console.log(`Sent ${expiringProfiles.length} expiry reminders.`)
    }

    return new Response(JSON.stringify({ success: true, count: expiringProfiles.length }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
