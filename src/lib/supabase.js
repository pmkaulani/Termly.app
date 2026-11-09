import { createClient } from '@supabase/supabase-js';
import { getTermlyRuntimeConfig, validateTermlyRuntimeConfig } from './runtimeConfig';

const { supabaseUrl, supabaseAnonKey } = getTermlyRuntimeConfig();
const configuration = validateTermlyRuntimeConfig();

// Keep module evaluation safe so main.jsx can show the installation error screen
// before initStore() or any data request runs. Invalid config never uses the
// supplied key or URL to create a client.
const clientUrl = configuration.valid ? supabaseUrl : 'http://127.0.0.1:54321';
const clientKey = configuration.valid ? supabaseAnonKey : 'termly-invalid-runtime-configuration';
export const supabase = createClient(clientUrl, clientKey);

// Intercept RPC calls to inject portal session tokens for verified server-side session checks.
const originalRpc = supabase.rpc.bind(supabase);
supabase.rpc = async (fn, args = {}, options) => {
  const safeArgs = args ? { ...args } : {};
  if (fn.startsWith('portal_') && fn !== 'portal_has_feature' && !fn.includes('login')) {
    if (!safeArgs.p_token && typeof localStorage !== 'undefined') {
      const token = localStorage.getItem('Termly_Portal_Token') || localStorage.getItem('Termly_Staff_Token');
      if (token) safeArgs.p_token = token;
    }
  }
  return originalRpc(fn, safeArgs, options);
};
