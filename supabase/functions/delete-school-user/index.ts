import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const auth = req.headers.get('Authorization') || '';
  const client = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const admin = createClient(url, service);
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData?.user) return json({ error: 'Authentication required.' }, 401);

  const { data: actorRow, error: actorError } = await admin.from('users')
    .select('id, school_id, role').eq('auth_user_id', authData.user.id).maybeSingle();
  if (actorError) return json({ error: 'Could not verify school membership.' }, 403);
  let actor = actorRow;
  if (!actor?.school_id) {
    const { data: ownerSchool, error: ownerError } = await admin.from('schools')
      .select('id').eq('owner_id', authData.user.id).maybeSingle();
    if (ownerError) return json({ error: 'Could not verify school ownership.' }, 403);
    if (ownerSchool?.id) actor = { id: null, school_id: ownerSchool.id, role: 'owner' };
  }
  if (!actor?.school_id) return json({ error: 'School membership not found.' }, 403);
  if (!['owner', 'admin'].includes(String(actor.role || '').toLowerCase())) {
    return json({ error: 'Only a school owner or administrator can remove staff accounts.' }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }
  const targetId = String(body?.userId || '');
  if (!targetId) return json({ error: 'userId is required.' }, 400);

  const { data: target, error: targetError } = await admin.from('users')
    .select('id, auth_user_id, school_id').eq('id', targetId).eq('school_id', actor.school_id).maybeSingle();
  if (targetError || !target) return json({ error: 'Staff account was not found in this school.' }, 404);
  if (target.auth_user_id === authData.user.id) return json({ error: 'You cannot delete your own account.' }, 400);

  const { data: school } = await admin.from('schools').select('owner_id').eq('id', actor.school_id).maybeSingle();
  if (school?.owner_id && target.auth_user_id === school.owner_id) {
    return json({ error: 'The primary school owner account cannot be deleted here.' }, 400);
  }

  // Delete Auth first; the public.users row may cascade through existing FK rules.
  if (target.auth_user_id) {
    const { error: authDeleteError } = await admin.auth.admin.deleteUser(target.auth_user_id);
    if (authDeleteError) return json({ error: `Could not remove the authentication identity: ${authDeleteError.message}` }, 500);
  }
  const { error: profileDeleteError } = await admin.from('users')
    .delete().eq('id', target.id).eq('school_id', actor.school_id);
  if (profileDeleteError) return json({ error: `Authentication identity removed, but staff profile cleanup failed: ${profileDeleteError.message}` }, 500);

  return json({ success: true, deletedUserId: target.id });
});
