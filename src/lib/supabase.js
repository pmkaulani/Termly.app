import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || (import.meta.env.MODE === 'test' ? 'http://127.0.0.1:54321' : '');
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || (import.meta.env.MODE === 'test' ? 'mock-anon-key' : '');

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Intercept RPC calls to inject portal session tokens for verified server-side session checks
const originalRpc = supabase.rpc.bind(supabase);
supabase.rpc = async (fn, args = {}, options) => {
  const safeArgs = args ? { ...args } : {};
  if (fn.startsWith('portal_') && fn !== 'portal_has_feature' && !fn.includes('login')) {
    if (!safeArgs.p_token) {
      const token = localStorage.getItem('Termly_Portal_Token') || localStorage.getItem('Termly_Staff_Token');
      if (token) {
        safeArgs.p_token = token;
      }
    }
  }
  return originalRpc(fn, safeArgs, options);
};
