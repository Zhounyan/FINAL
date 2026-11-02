// Self-service password change (and completion of an emailed password recovery).
// The policy is enforced here, server-side; afterwards every session of the
// user is revoked so stolen refresh tokens stop working.
import { adminClient, anonClient, HttpError, rawPassword, requireCaller, serve } from '../_shared/http.ts';
import { passwordPolicyError } from '../_shared/password-policy.ts';

const RECOVERY_WINDOW_SECONDS = 60 * 60;

function isFreshRecoverySession(claims: Record<string, unknown>): boolean {
  const amr = Array.isArray(claims.amr) ? (claims.amr as Array<{ method?: string; timestamp?: number }>) : [];
  const now = Math.floor(Date.now() / 1000);
  return amr.some(
    (m) =>
      ['recovery', 'otp', 'magiclink'].includes(m?.method ?? '') &&
      typeof m.timestamp === 'number' &&
      now - m.timestamp <= RECOVERY_WINDOW_SECONDS,
  );
}

serve(async (req, body) => {
  const admin = adminClient();
  const caller = await requireCaller(req, admin);
  const newPassword = rawPassword(body, 'new_password');
  const mode = body.mode === 'recovery' ? 'recovery' : 'change';

  const policyError = passwordPolicyError(newPassword);
  if (policyError) throw new HttpError(400, policyError, 'weak_password');

  if (mode === 'recovery') {
    if (!isFreshRecoverySession(caller.claims)) {
      throw new HttpError(403, 'This password reset link has expired. Request a new one.', 'recovery_expired');
    }
  } else {
    const current = rawPassword(body, 'current_password');
    if (current === newPassword) {
      throw new HttpError(400, 'The new password must be different from the current password.', 'validation');
    }
    const { error } = await anonClient().auth.signInWithPassword({ email: caller.profile.email, password: current });
    if (error) throw new HttpError(400, 'Your current password is incorrect.', 'wrong_password');
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(caller.user.id, { password: newPassword });
  if (updErr) throw new HttpError(400, updErr.message, 'update_failed');

  await admin.from('profiles').update({ must_change_password: false }).eq('id', caller.user.id);
  await admin.rpc('admin_revoke_sessions', { p_user_id: caller.user.id });
  await admin.from('activity_logs').insert({
    user_id: caller.profile.id,
    user_name: caller.profile.full_name,
    action: mode === 'recovery' ? 'password_recovered' : 'password_changed',
    entity_type: 'profiles',
    entity_id: caller.profile.id,
    summary: mode === 'recovery' ? 'Reset password via email recovery' : 'Changed own password',
  });

  return { ok: true, reauthenticate: true };
});
