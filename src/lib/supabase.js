import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Intercept RPC calls to inject portal session tokens for IDOR protection
const originalRpc = supabase.rpc.bind(supabase);
supabase.rpc = async (fn, args, options) => {
  if (fn.startsWith('portal_') && fn !== 'portal_has_feature') {
    const token = localStorage.getItem('Termly_Portal_Token') || localStorage.getItem('Termly_Staff_Token');
    if (token) {
      args = { ...args, p_token: token };
    }
  }
  return originalRpc(fn, args, options);
};
