import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);
/** Public project URL and anon key (used for direct Edge Function downloads/uploads). */
export const supabaseUrl = url ?? 'http://localhost:54321';
export const supabaseAnonKey = anonKey ?? '';

// Read the emailed-link details BEFORE the client consumes and clears the URL.
const linkParams = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, ''));
export const authLinkHint = {
  /** the page was opened from a password-reset email */
  recovery: linkParams.get('type') === 'recovery',
  /** the emailed link was invalid or expired */
  error: linkParams.get('error_code') ? (linkParams.get('error_description') ?? 'This link is invalid or has expired.').replace(/\+/g, ' ') : null,
};

// Only the public anon/publishable key is ever shipped to the browser.
// Privileged operations run in Edge Functions with the service role key.
export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'public-anon-key-not-configured', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Implicit flow: emailed password-reset links work on any device or
    // browser (PKCE links only work in the browser that requested them).
    flowType: 'implicit',
    storageKey: 'invportiq.auth',
  },
});
