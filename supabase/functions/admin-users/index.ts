// User account management — Admin only.
// Actions: create | update | set_active | reset_password
import { adminClient, audit, EMAIL_RE, HttpError, rawPassword, requireCaller, serve, str } from '../_shared/http.ts';
import { passwordPolicyError } from '../_shared/password-policy.ts';

const ASSIGNABLE_ROLES = ['owner', 'staff'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
const BAN_FOREVER = '876000h'; // ~100 years

function role(body: Record<string, unknown>): AssignableRole {
  const r = body.role;
  if (typeof r !== 'string' || !ASSIGNABLE_ROLES.includes(r as AssignableRole)) {
    throw new HttpError(400, 'Role must be Owner or Staff.', 'validation');
  }
  return r as AssignableRole;
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
      const email = str(body, 'email', { required: true, max: 254 }).toLowerCase();
      const fullName = str(body, 'full_name', { required: true, max: 120 });
      const phone = str(body, 'phone', { max: 40 }) || null;
      const password = rawPassword(body, 'password');
      const newRole = role(body);
      const canAdd = newRole === 'staff' && body.can_add_products === true;
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'validation');
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
          ? 'An account with this email already exists.'
          : error?.message ?? 'Could not create the account.';
        throw new HttpError(400, msg, 'create_failed');
      }
      const { error: pErr } = await admin.from('profiles').insert({
        id: created.user.id,
        email,
        full_name: fullName,
        phone,
        role: newRole,
        can_add_products: canAdd,
        must_change_password: body.must_change_password !== false,
        created_by: caller.profile.id,
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw new HttpError(400, 'Could not create the account profile.', 'create_failed');
      }
      await audit(admin, actor, 'user_created', created.user.id, `Created ${newRole} account for ${fullName} (${email})`, {
        role: newRole,
        can_add_products: canAdd,
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
      if (target.role !== 'admin') {
        const newRole = role(body);
        patch.role = newRole;
        patch.can_add_products = newRole === 'staff' && body.can_add_products === true;
      } else if (body.role !== undefined && body.role !== 'admin') {
        throw new HttpError(400, 'Administrator accounts cannot be demoted here.', 'validation');
      }
      const { error } = await admin.from('profiles').update(patch).eq('id', id);
      if (error) throw new HttpError(400, 'Could not update the account.', 'update_failed');
      await audit(admin, actor, 'user_updated', id, `Updated account ${target.email}`, {
        from: { full_name: target.full_name, role: target.role, can_add_products: target.can_add_products },
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
