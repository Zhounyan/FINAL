import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

// Only the public anon/publishable key is ever shipped to the browser.
// Privileged operations run in Edge Functions with the service role key.
export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'public-anon-key-not-configured', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storageKey: 'invportiq.auth',
  },
});
