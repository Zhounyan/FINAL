import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { authLinkHint, supabase } from '@/lib/supabase';
import { fetchProfile, invokeFunction } from '@/lib/api';
import { capabilities, type Capabilities } from '@/lib/permissions';
import type { Profile } from '@/lib/types';

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  can: Capabilities;
  loading: boolean;
  /** set when the user arrived through an emailed password-recovery link */
  recovery: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** true after the user pressed Logout (the next sign-in starts fresh, not on the previous user's page) */
  signedOut: boolean;
  refreshProfile: () => Promise<Profile | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(authLinkHint.recovery);
  const loadedFor = useRef<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const loadProfile = useCallback(async (userId: string | null) => {
    if (!userId) {
      loadedFor.current = null;
      setProfile(null);
      return null;
    }
    try {
      const p = await fetchProfile(userId);
      if (!p || !p.is_active) {
        // No profile or deactivated: end the session (RLS already blocks data access).
        await supabase.auth.signOut({ scope: 'local' });
        setProfile(null);
        return null;
      }
      loadedFor.current = userId;
      setProfile(p);
      return p;
    } catch {
      setProfile(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      await loadProfile(data.session?.user.id ?? null);
      if (mounted) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') {
        setRecovery(false);
        queryClient.clear();
      }
      setSession(next);
      const uid = next?.user.id ?? null;
      if (uid !== loadedFor.current) {
        // Defer: never await Supabase calls inside the auth callback.
        setTimeout(() => {
          void loadProfile(uid);
        }, 0);
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile, queryClient]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      // `email` may also be a cashier username; the auth-login function resolves it.
      const res = await invokeFunction<{ session: { access_token: string; refresh_token: string } }>('auth-login', {
        login: email,
        password,
      });
      const { data, error } = await supabase.auth.setSession(res.session);
      if (error || !data.session) throw error ?? new Error('Could not start your session.');
      const p = await loadProfile(data.session.user.id);
      if (!p) throw new Error('This account is not active. Please contact the administrator.');
      setSignedOut(false);
    },
    [loadProfile],
  );

  const signOut = useCallback(async () => {
    // Audit the sign-out while the session is still valid (best effort).
    await supabase.rpc('log_logout').then(
      () => undefined,
      () => undefined,
    );
    setSignedOut(true);
    await supabase.auth.signOut();
    queryClient.clear();
    setProfile(null);
    loadedFor.current = null;
  }, [queryClient]);

  const refreshProfile = useCallback(() => loadProfile(session?.user.id ?? null), [loadProfile, session]);

  // Never pair one user's session with another user's profile (e.g. right after switching accounts):
  // until the matching profile is loaded the app shows a loader instead of the previous user's pages.
  const current = profile && session && profile.id === session.user.id ? profile : null;
  const value = useMemo<AuthContextValue>(
    () => ({ session, profile: current, can: capabilities(current), loading, recovery, signIn, signOut, signedOut, refreshProfile }),
    [session, current, loading, recovery, signIn, signOut, signedOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
