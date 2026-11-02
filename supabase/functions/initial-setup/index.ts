// One-time creation of the first administrator account.
// Public endpoint (verify_jwt = false) that permanently closes itself:
// complete_initial_setup() claims a singleton row atomically, so concurrent or
// repeated requests can never create a second "initial" administrator.
import { adminClient, EMAIL_RE, HttpError, rawPassword, serve, str, timingSafeEqual } from '../_shared/http.ts';
import { passwordPolicyError } from '../_shared/password-policy.ts';

serve(async (_req, body) => {
  const admin = adminClient();

  const { data: status, error: statusErr } = await admin.rpc('setup_status');
  if (statusErr) throw new HttpError(500, 'Could not check setup status.', 'server_error');
  if (!status?.setup_required) {
    throw new HttpError(403, 'Initial setup has already been completed. Please sign in.', 'setup_closed');
  }

  // Optional deployment secret: when INITIAL_SETUP_TOKEN is configured, the
  // installer must provide it, so a stranger cannot race the real owner.
  const requiredToken = Deno.env.get('INITIAL_SETUP_TOKEN');
  if (requiredToken) {
    const provided = str(body, 'setup_token', { max: 200 });
    if (!provided || !timingSafeEqual(provided, requiredToken)) {
      throw new HttpError(403, 'The setup token is incorrect.', 'invalid_setup_token');
    }
  }

  const fullName = str(body, 'full_name', { required: true, max: 120 });
  const email = str(body, 'email', { required: true, max: 254 }).toLowerCase();
  const password = rawPassword(body, 'password');
  if (fullName.length < 2) throw new HttpError(400, 'Full name is required.', 'validation');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'validation');
  const policyError = passwordPolicyError(password);
  if (policyError) throw new HttpError(400, policyError, 'weak_password');

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr || !created.user) {
    throw new HttpError(400, createErr?.message ?? 'Could not create the administrator account.', 'create_failed');
  }

  const { error: claimErr } = await admin.rpc('complete_initial_setup', {
    p_user_id: created.user.id,
    p_email: email,
    p_full_name: fullName,
  });
  if (claimErr) {
    // Remove the orphaned auth user, then report what actually happened.
    await admin.auth.admin.deleteUser(created.user.id);
    const { data: after } = await admin.rpc('setup_status');
    if (after && after.setup_required === false) {
      throw new HttpError(403, 'Initial setup has already been completed. Please sign in.', 'setup_closed');
    }
    console.error('complete_initial_setup failed', claimErr);
    throw new HttpError(500, `Setup could not be completed: ${claimErr.message}`, 'setup_failed');
  }

  return { ok: true, email };
});
