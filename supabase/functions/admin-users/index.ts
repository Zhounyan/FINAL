// User account management — Administrator only.
// The system has exactly two roles: one Administrator and any number of Cashiers.
// Actions: create | update | set_active | reset_password
import { adminClient, audit, EMAIL_RE, HttpError, rawPassword, requireCaller, serve, str } from '../_shared/http.ts';
import { passwordPolicyError } from '../_shared/password-policy.ts';

const BAN_FOREVER = '876000h'; // ~100 years
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
/** Cashiers without an e-mail address sign in with their username; Auth still needs a unique address. */
const NO_EMAIL_DOMAIN = 'cashier.invportiq.invalid';

function username(body: Record<string, unknown>): string {
  const u = str(body, 'username', { required: true, max: 32 }).toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw new HttpError(400, 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.', 'validation');
  }
  return u;
}

function uuid(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new HttpError(400, `Invalid ${key}.`, 'validation');
  return v;
}

serve(async (req, body) => {
  const admin = adminClient();
  const caller = await requireCaller(req, admin);
  if (caller.profile.role !== 'admin') {
    throw new HttpError(403, 'Only administrators can manage user accounts.', 'forbidden');
  }
  const actor = { id: caller.profile.id, full_name: caller.profile.full_name };
  const action = body.action;

  async function loadTarget(id: string) {
    const { data, error } = await admin.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw new HttpError(500, 'Could not load the account.', 'server_error');
    if (!data) throw new HttpError(404, 'Account not found.', 'not_found');
    return data;
  }

  switch (action) {
    case 'create': {
      const user = username(body);
      const givenEmail = str(body, 'email', { max: 254 }).toLowerCase();
      const email = givenEmail || `${user}@${NO_EMAIL_DOMAIN}`;
      const fullName = str(body, 'full_name', { required: true, max: 120 });
      const phone = str(body, 'phone', { max: 40 }) || null;
      const password = rawPassword(body, 'password');
      if (givenEmail && !EMAIL_RE.test(givenEmail)) throw new HttpError(400, 'Enter a valid email address.', 'validation');
      const { data: taken } = await admin.from('profiles').select('id').ilike('username', user).maybeSingle();
      if (taken) throw new HttpError(400, `The username "${user}" is already in use.`, 'create_failed');
      if (fullName.length < 2) throw new HttpError(400, 'Full name is required.', 'validation');
      const policyError = passwordPolicyError(password);
      if (policyError) throw new HttpError(400, policyError, 'weak_password');

      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (error || !created.user) {
        const msg = /already|registered|exists/i.test(error?.message ?? '')
          ? 'An account with this email or username already exists.'
          : error?.message ?? 'Could not create the account.';
        throw new HttpError(400, msg, 'create_failed');
      }
      const { error: pErr } = await admin.from('profiles').insert({
        id: created.user.id,
        email,
        username: user,
        full_name: fullName,
        phone,
        role: 'cashier',
        can_add_products: false,
        must_change_password: body.must_change_password !== false,
        created_by: caller.profile.id,
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw new HttpError(400, 'Could not create the account profile.', 'create_failed');
      }
      await audit(admin, actor, 'user_created', created.user.id, `Created cashier account for ${fullName} (${user})`, {
        role: 'cashier',
        username: user,
      });
      return { ok: true, user_id: created.user.id };
    }

    case 'update': {
      const id = uuid(body, 'user_id');
      const target = await loadTarget(id);
      const fullName = str(body, 'full_name', { required: true, max: 120 });
      const phone = str(body, 'phone', { max: 40 }) || null;
      if (fullName.length < 2) throw new HttpError(400, 'Full name is required.', 'validation');
      const patch: Record<string, unknown> = { full_name: fullName, phone };
      if (body.role !== undefined && body.role !== target.role) {
        throw new HttpError(400, 'Roles cannot be changed. The system has one Administrator and Cashier accounts.', 'validation');
      }
      if (target.role === 'cashier' && body.username !== undefined) {
        const user = username(body);
        const { data: taken } = await admin.from('profiles').select('id').ilike('username', user).neq('id', id).maybeSingle();
        if (taken) throw new HttpError(400, `The username "${user}" is already in use.`, 'update_failed');
        patch.username = user;
      }
      const { error } = await admin.from('profiles').update(patch).eq('id', id);
      if (error) throw new HttpError(400, 'Could not update the account.', 'update_failed');
      await audit(admin, actor, 'user_updated', id, `Updated account ${target.email}`, {
        from: { full_name: target.full_name, username: target.username, phone: target.phone },
        to: patch,
      });
      return { ok: true };
    }

    case 'set_active': {
      const id = uuid(body, 'user_id');
      const active = body.active === true;
      if (id === caller.profile.id) throw new HttpError(400, 'You cannot deactivate your own account.', 'validation');
      const target = await loadTarget(id);
      if (target.role === 'admin') throw new HttpError(400, 'Administrator accounts cannot be deactivated here.', 'validation');
      if (target.role === 'owner' && active) {
        throw new HttpError(400, 'The Owner role has been retired. Create a cashier account instead.', 'validation');
      }
      const { error: banErr } = await admin.auth.admin.updateUserById(id, { ban_duration: active ? 'none' : BAN_FOREVER });
      if (banErr) throw new HttpError(400, banErr.message, 'update_failed');
      const { error } = await admin.from('profiles').update({ is_active: active }).eq('id', id);
      if (error) throw new HttpError(400, 'Could not update the account status.', 'update_failed');
      if (!active) await admin.rpc('admin_revoke_sessions', { p_user_id: id });
      await audit(admin, actor, active ? 'user_activated' : 'user_deactivated', id,
        `${active ? 'Activated' : 'Deactivated'} account ${target.email}`);
      return { ok: true };
    }

    case 'reset_password': {
      const id = uuid(body, 'user_id');
      const password = rawPassword(body, 'new_password');
      const policyError = passwordPolicyError(password);
      if (policyError) throw new HttpError(400, policyError, 'weak_password');
      const target = await loadTarget(id);
      if (target.role === 'admin' && id !== caller.profile.id) {
        throw new HttpError(400, 'Another administrator\'s password cannot be reset here.', 'validation');
      }
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw new HttpError(400, error.message, 'update_failed');
      await admin.from('profiles').update({ must_change_password: id !== caller.profile.id }).eq('id', id);
      await admin.rpc('admin_revoke_sessions', { p_user_id: id });
      await admin.from('auth_lockouts').delete().eq('email', target.email);
      await audit(admin, actor, 'password_reset', id, `Reset password for ${target.email}`);
      return { ok: true };
    }

    default:
      throw new HttpError(400, 'Unknown action.', 'bad_request');
  }
});
