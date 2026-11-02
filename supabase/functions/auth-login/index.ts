// Sign-in with brute-force protection and account status checks.
// Five failed attempts lock the account for 15 minutes (see login_record()).
// Supabase Auth's own per-IP rate limits (config.toml [auth.rate_limit]) apply too.
import { adminClient, anonClient, EMAIL_RE, HttpError, rawPassword, serve, str } from '../_shared/http.ts';

const GENERIC = 'Invalid email or password.';

serve(async (_req, body) => {
  const email = str(body, 'email', { required: true, max: 254 }).toLowerCase();
  const password = rawPassword(body, 'password');
  if (!EMAIL_RE.test(email) || password.length > 200) throw new HttpError(401, GENERIC, 'invalid_credentials');

  const admin = adminClient();
  const { data: guard, error: guardErr } = await admin.rpc('login_guard', { p_email: email });
  if (guardErr) throw new HttpError(500, 'Sign-in is temporarily unavailable.', 'server_error');
  if (guard?.locked) {
    throw new HttpError(429, 'Too many failed attempts. This account is temporarily locked. Try again later.', 'locked', {
      locked_until: guard.locked_until,
    });
  }

  const anon = anonClient();
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    const { data: rec } = await admin.rpc('login_record', { p_email: email, p_success: false });
    if (rec?.locked) {
      throw new HttpError(429, 'Too many failed attempts. This account is temporarily locked for 15 minutes.', 'locked', {
        locked_until: rec.locked_until,
      });
    }
    throw new HttpError(401, GENERIC, 'invalid_credentials', { remaining_attempts: rec?.remaining_attempts });
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('id, is_active')
    .eq('id', data.user.id)
    .maybeSingle();
  if (!profile || !profile.is_active) {
    await admin.rpc('admin_revoke_sessions', { p_user_id: data.user.id });
    throw new HttpError(403, 'This account has been deactivated. Please contact the administrator.', 'inactive');
  }

  await admin.rpc('login_record', { p_email: email, p_success: true, p_user_id: data.user.id });

  return {
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  };
});
