import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Activity, Eye, KeyRound, Pencil, Power, RotateCcw, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { passwordPolicyError } from '@shared/password-policy';
import { deletionInfo } from '@/lib/accounts';
import { ACCOUNT_RECOVERY_DAYS, adminUsers, listActivity, listUsers, PAGE_SIZE, recoverUserAccount, scheduleUserDeletion } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/permissions';
import type { Profile } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useResettingPage } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Card, DetailRow, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { PasswordInput, PasswordStrengthMeter } from '@/components/PasswordStrength';

const strongPassword = z.string().superRefine((v, ctx) => {
  const err = passwordPolicyError(v);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});

export default function UsersPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={<ShieldCheck className="size-5" />}
        title="User Management"
        description="One Administrator and as many Cashier accounts as the store needs. Each cashier signs in with their own username and password."
      />
      <UsersPanel />
    </div>
  );
}

function RoleBadge({ role }: { role: Profile['role'] }) {
  return <Badge tone={role === 'admin' ? 'brand' : role === 'owner' ? 'slate' : 'blue'}>{ROLE_LABELS[role]}</Badge>;
}

const isPlaceholderEmail = (email: string) => email.endsWith('@cashier.invportiq.invalid');

function UsersPanel() {
  const { profile: me } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [resetting, setResetting] = useState<Profile | null>(null);
  const [toggling, setToggling] = useState<Profile | null>(null);
  const [viewing, setViewing] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [role, setRole] = useState<'all' | 'admin' | 'cashier'>('all');
  const [page, setPage] = useResettingPage([debounced, status, role]);

  const q = useQuery({
    queryKey: ['users', debounced, status, role, page],
    queryFn: () => listUsers({ search: debounced, page, status, role }),
    placeholderData: (p) => p,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  const toggle = useMutation({
    mutationFn: (u: Profile) => adminUsers({ action: 'set_active', user_id: u.id, active: !u.is_active }),
    onSuccess: async (_r, u) => {
      toast.success(`${u.full_name} ${u.is_active ? 'deactivated' : 'activated'}.`);
      setToggling(null);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const del = useMutation({
    mutationFn: (u: Profile) => scheduleUserDeletion(u.id),
    onSuccess: async (_r, u) => {
      toast.success(`${u.full_name}'s account will be permanently deleted in ${ACCOUNT_RECOVERY_DAYS} days. You can recover it until then.`);
      setDeleting(null);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const recover = useMutation({
    mutationFn: (u: Profile) => recoverUserAccount(u.id),
    onSuccess: async (_r, u) => {
      toast.success(`${u.full_name}'s account was recovered.`);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card title="Accounts" subtitle="Public registration is disabled — only the Administrator creates cashier accounts" actions={<Button icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>Add Cashier</Button>}>
      <div className="flex flex-wrap gap-3 border-b border-line p-4">
        <SearchInput value={search} onChange={setSearch} className="max-w-md flex-1" placeholder="Search name, username or email…" />
        <select className="input h-10 w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select className="input h-10 w-auto" value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="Filter by role">
          <option value="all">All roles</option>
          <option value="cashier">Cashiers</option>
          <option value="admin">Administrator</option>
        </select>
      </div>
      {q.isError ? (
        <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock />
      ) : !q.data?.rows.length ? (
        <EmptyState title="No accounts found" />
      ) : (
        <TableWrap>
          <table className="table-base" data-testid="users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Username</th>
                <th>Last sign-in</th>
                <th>Created</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar name={u.full_name} src={u.avatar_url} size="sm" />
                      <div className="min-w-0">
                        <span className="font-medium">{u.full_name}</span>
                        {u.id === me?.id && <span className="ml-1 text-xs text-muted">(you)</span>}
                        <span className="block text-xs text-muted">{isPlaceholderEmail(u.email) ? 'No e-mail' : u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td><RoleBadge role={u.role} /></td>
                  <td>
                    {deletionInfo(u) ? (
                      <>
                        <Badge tone="red"><Trash2 className="size-3" /> Deletion pending</Badge>
                        <span className="mt-1 block text-[11px] whitespace-nowrap text-red-700">
                          Deletes {fmtDate(deletionInfo(u)!.deletesAt)} · {deletionInfo(u)!.daysLeft} day(s) left to recover
                        </span>
                      </>
                    ) : u.is_active ? (
                      <Badge tone="green">Active</Badge>
                    ) : (
                      <Badge tone="red">Inactive</Badge>
                    )}
                    {u.must_change_password && !u.deletion_scheduled_at && <span className="mt-1 block text-[11px] text-amber-700">Must change password</span>}
                  </td>
                  <td className="font-mono text-xs">{u.username ?? '—'}</td>
                  <td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(u.last_login_at)}</td>
                  <td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(u.created_at)}</td>
                  <td className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" onClick={() => setViewing(u)} aria-label={`View ${u.full_name}`}><Eye className="size-4" /></Button>
                    {u.deletion_scheduled_at ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<RotateCcw className="size-4" />}
                        loading={recover.isPending && recover.variables?.id === u.id}
                        onClick={() => recover.mutate(u)}
                        aria-label={`Recover ${u.full_name}`}
                      >
                        Recover
                      </Button>
                    ) : (
                    <>
                    <Button variant="ghost" size="icon" onClick={() => setEditing(u)} aria-label={`Edit ${u.full_name}`}><Pencil className="size-4" /></Button>
                    {(u.role !== 'admin' || u.id === me?.id) && (
                      <Button variant="ghost" size="icon" onClick={() => setResetting(u)} aria-label={`Reset password for ${u.full_name}`} title="Reset password"><KeyRound className="size-4" /></Button>
                    )}
                    {u.role === 'cashier' && (
                      <Button variant="ghost" size="icon" className={u.is_active ? 'hover:text-red-600' : 'hover:text-emerald-700'} onClick={() => setToggling(u)} aria-label={`${u.is_active ? 'Deactivate' : 'Activate'} ${u.full_name}`} title={u.is_active ? 'Deactivate' : 'Activate'}>
                        <Power className="size-4" />
                      </Button>
                    )}
                    {u.role === 'cashier' && u.id !== me?.id && (
                      <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setDeleting(u)} aria-label={`Delete ${u.full_name}`} title="Delete account">
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                    </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />

      {creating && <CreateUserModal onClose={() => setCreating(false)} onDone={refresh} />}
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} onDone={refresh} />}
      {viewing && <UserDetailModal user={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete account?"
        message={
          <>
            <b className="text-ink">{deleting?.full_name}</b> ({deleting?.username ?? deleting?.email}) will be signed out and blocked immediately. The account is
            <b> permanently deleted after {ACCOUNT_RECOVERY_DAYS} days</b>; until then you can undo this with <b>Recover</b>. Their past sales and
            stock records are kept.
          </>
        }
        confirmLabel="Delete account"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={Boolean(toggling)}
        tone={toggling?.is_active ? 'danger' : 'primary'}
        title={toggling?.is_active ? 'Deactivate account?' : 'Activate account?'}
        message={
          toggling?.is_active ? (
            <><b className="text-ink">{toggling.full_name}</b> will be signed out everywhere and will not be able to sign in until reactivated. Their records are kept.</>
          ) : (
            <><b className="text-ink">{toggling?.full_name}</b> will be able to sign in again.</>
          )
        }
        confirmLabel={toggling?.is_active ? 'Deactivate' : 'Activate'}
        loading={toggle.isPending}
        onConfirm={() => toggling && toggle.mutate(toggling)}
        onCancel={() => setToggling(null)}
      />
    </Card>
  );
}

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, 'Use 3–32 letters, numbers, dot, dash or underscore (no spaces)');

const createSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Full name is required').max(120),
    username: usernameSchema,
    email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address')]),
    phone: z.string().trim().max(40).optional(),
    must_change_password: z.boolean(),
    password: strongPassword,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type CreateValues = z.infer<typeof createSchema>;

function CreateUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<unknown> }) {
  const { register, handleSubmit, watch, formState } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { full_name: '', username: '', email: '', phone: '', must_change_password: true, password: '', confirm: '' },
  });
  const m = useMutation({
    mutationFn: ({ confirm: _c, ...v }: CreateValues) => adminUsers({ action: 'create', ...v, email: v.email || undefined }),
    onSuccess: async (_r, v) => {
      toast.success(`Cashier account created for ${v.full_name} (username: ${v.username}).`);
      await onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={m.isPending}
      size="lg"
      title="Add Cashier"
      description="Give the cashier their username and temporary password in person."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button type="submit" form="create-user" loading={m.isPending}>Create cashier</Button>
        </>
      }
    >
      <form id="create-user" onSubmit={handleSubmit((v) => m.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Input label="Full name" required error={formState.errors.full_name?.message} {...register('full_name')} />
        <Input label="Username" required autoComplete="off" hint="Used to sign in, e.g. maria.cashier" error={formState.errors.username?.message} {...register('username')} />
        <Input label="Email address (optional)" type="email" autoComplete="off" hint="Only needed for 'Forgot password' e-mails" error={formState.errors.email?.message} {...register('email')} />
        <Input label="Phone" error={formState.errors.phone?.message} {...register('phone')} />
        <PasswordInput label="Temporary password" required autoComplete="new-password" error={formState.errors.password?.message} {...register('password')} />
        <PasswordInput label="Confirm password" required autoComplete="new-password" error={formState.errors.confirm?.message} {...register('confirm')} />
        <div className="sm:col-span-2"><PasswordStrengthMeter password={watch('password')} /></div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="size-4 accent-brand-700" {...register('must_change_password')} /> Require the user to change this password at first sign-in
        </label>
      </form>
    </Modal>
  );
}

const editSchema = z.object({
  full_name: z.string().trim().min(2, 'Full name is required').max(120),
  phone: z.string().trim().max(40).optional(),
  username: z.union([z.literal(''), usernameSchema]),
});

function EditUserModal({ user, onClose, onDone }: { user: Profile; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { refreshProfile, profile: me } = useAuth();
  const { register, handleSubmit, formState } = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    defaultValues: { full_name: user.full_name, phone: user.phone ?? '', username: user.username ?? '' },
  });
  const m = useMutation({
    mutationFn: (v: z.infer<typeof editSchema>) =>
      adminUsers({ action: 'update', user_id: user.id, full_name: v.full_name, phone: v.phone, username: user.role === 'cashier' && v.username ? v.username : undefined }),
    onSuccess: async () => {
      toast.success('Account updated.');
      await onDone();
      if (user.id === me?.id) await refreshProfile();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={m.isPending}
      title={`Edit ${user.full_name}`}
      description={user.username ? `Username: ${user.username}` : user.email}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button type="submit" form="edit-user" loading={m.isPending}>Save changes</Button>
        </>
      }
    >
      <form id="edit-user" onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <Input label="Full name" required error={formState.errors.full_name?.message} {...register('full_name')} />
        <Input label="Phone" error={formState.errors.phone?.message} {...register('phone')} />
        {user.role === 'cashier' ? (
          <Input label="Username" required error={formState.errors.username?.message} {...register('username')} />
        ) : (
          <p className="rounded-lg bg-brand-50 p-3 text-sm text-muted">Roles cannot be changed. The system has one Administrator and Cashier accounts.</p>
        )}
      </form>
    </Modal>
  );
}

const resetSchema = z.object({ password: strongPassword, confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

function ResetPasswordModal({ user, onClose, onDone }: { user: Profile; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { register, handleSubmit, watch, formState } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirm: '' } });
  const m = useMutation({
    mutationFn: (v: z.infer<typeof resetSchema>) => adminUsers({ action: 'reset_password', user_id: user.id, new_password: v.password }),
    onSuccess: async () => {
      toast.success(`Password reset for ${user.full_name}. Their existing sessions were signed out.`);
      await onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={m.isPending}
      title={`Reset password · ${user.full_name}`}
      description="The user will be signed out everywhere and asked to choose a new password at next sign-in."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button type="submit" form="reset-pw" loading={m.isPending}>Reset password</Button>
        </>
      }
    >
      <form id="reset-pw" onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <PasswordInput label="New temporary password" required autoComplete="new-password" error={formState.errors.password?.message} {...register('password')} />
        <PasswordStrengthMeter password={watch('password')} />
        <PasswordInput label="Confirm password" required autoComplete="new-password" error={formState.errors.confirm?.message} {...register('confirm')} />
      </form>
    </Modal>
  );
}

function UserDetailModal({ user, onClose }: { user: Profile; onClose: () => void }) {
  const activity = useQuery({ queryKey: ['activity', 'user', user.id], queryFn: () => listActivity({ page: 1, userId: user.id, pageSize: 15 }) });
  return (
    <Modal open onClose={onClose} size="lg" title={user.full_name} description={isPlaceholderEmail(user.email) ? `Username: ${user.username}` : user.email}>
      <dl className="divide-y divide-line">
        <DetailRow label="Role"><RoleBadge role={user.role} /></DetailRow>
        <DetailRow label="Username">{user.username ?? '—'}</DetailRow>
        <DetailRow label="Status">{user.is_active ? 'Active' : 'Inactive'}</DetailRow>
        <DetailRow label="Phone">{user.phone ?? '—'}</DetailRow>
        <DetailRow label="Last sign-in">{fmtDateTime(user.last_login_at)}</DetailRow>
        <DetailRow label="Created">{fmtDateTime(user.created_at)}</DetailRow>
      </dl>
      <div className="mt-6 mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Activity history</h3>
        <Link to={`/activity?user=${user.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
          <Activity className="size-4" /> Full activity log
        </Link>
      </div>
      {activity.isLoading ? (
        <LoadingBlock rows={3} />
      ) : !activity.data?.rows.length ? (
        <EmptyState title="No activity recorded" />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {activity.data.rows.map((a) => (
            <li key={a.id} className="px-4 py-2.5 text-sm">
              {a.summary ?? a.action}
              <span className="block text-xs text-muted">{fmtDateTime(a.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
