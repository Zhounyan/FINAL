import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Activity, Eye, KeyRound, Pencil, Power, RotateCcw, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
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
import { Input, Select } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Card, DetailRow, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap, Tabs } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { PasswordInput, PasswordStrengthMeter } from '@/components/PasswordStrength';

const strongPassword = z.string().superRefine((v, ctx) => {
  const err = passwordPolicyError(v);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});

export default function UsersPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'activity' ? 'activity' : 'users';
  return (
    <div className="space-y-6">
      <PageHeader icon={<ShieldCheck className="size-5" />} title="User Management" description="Create and manage Owner and Staff accounts. Public registration is disabled." />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === 'users' ? {} : { tab: t })}
        tabs={[
          { id: 'users', label: 'User accounts', icon: <Users className="size-4" /> },
          { id: 'activity', label: 'System activity log', icon: <Activity className="size-4" /> },
        ]}
      />
      {tab === 'users' ? <UsersPanel /> : <ActivityPanel />}
    </div>
  );
}

function RoleBadge({ role }: { role: Profile['role'] }) {
  return <Badge tone={role === 'admin' ? 'brand' : role === 'owner' ? 'violet' : 'blue'}>{ROLE_LABELS[role]}</Badge>;
}

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
  const [page, setPage] = useResettingPage([debounced]);

  const q = useQuery({ queryKey: ['users', debounced, page], queryFn: () => listUsers({ search: debounced, page }), placeholderData: (p) => p });
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
    <Card title="Accounts" subtitle="Admins create and distribute accounts to authorised users" actions={<Button icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>Create account</Button>}>
      <div className="border-b border-line p-4">
        <SearchInput value={search} onChange={setSearch} className="max-w-md" placeholder="Search name or email…" />
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
                <th>Permissions</th>
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
                        <span className="block text-xs text-muted">{u.email}</span>
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
                  <td className="text-xs text-muted">{u.role === 'staff' ? (u.can_add_products ? 'Can add products' : 'Stock operations') : u.role === 'owner' ? 'Read-only' : 'Full access'}</td>
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
                    {u.role !== 'admin' && (
                      <Button variant="ghost" size="icon" className={u.is_active ? 'hover:text-red-600' : 'hover:text-emerald-700'} onClick={() => setToggling(u)} aria-label={`${u.is_active ? 'Deactivate' : 'Activate'} ${u.full_name}`} title={u.is_active ? 'Deactivate' : 'Activate'}>
                        <Power className="size-4" />
                      </Button>
                    )}
                    {u.role !== 'admin' && u.id !== me?.id && (
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
            <b className="text-ink">{deleting?.full_name}</b> ({deleting?.email}) will be signed out and blocked immediately. The account is
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

const createSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Full name is required').max(120),
    email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
    phone: z.string().trim().max(40).optional(),
    role: z.enum(['owner', 'staff']),
    can_add_products: z.boolean(),
    must_change_password: z.boolean(),
    password: strongPassword,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type CreateValues = z.infer<typeof createSchema>;

function CreateUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<unknown> }) {
  const { register, handleSubmit, watch, formState } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { full_name: '', email: '', phone: '', role: 'staff', can_add_products: false, must_change_password: true, password: '', confirm: '' },
  });
  const role = watch('role');
  const m = useMutation({
    mutationFn: (v: CreateValues) => adminUsers({ action: 'create', ...v }),
    onSuccess: async (_r, v) => {
      toast.success(`${ROLE_LABELS[v.role]} account created for ${v.full_name}.`);
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
      title="Create account"
      description="Share the email and temporary password with the user securely."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button type="submit" form="create-user" loading={m.isPending}>Create account</Button>
        </>
      }
    >
      <form id="create-user" onSubmit={handleSubmit((v) => m.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Input label="Full name" required error={formState.errors.full_name?.message} {...register('full_name')} />
        <Input label="Email address" type="email" required autoComplete="off" error={formState.errors.email?.message} {...register('email')} />
        <Input label="Phone" error={formState.errors.phone?.message} {...register('phone')} />
        <Select label="Role" required {...register('role')}>
          <option value="staff">Staff — inventory operations</option>
          <option value="owner">Owner — read-only reports &amp; monitoring</option>
        </Select>
        {role === 'staff' && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="size-4 accent-brand-700" {...register('can_add_products')} /> Authorise this staff member to add new products
          </label>
        )}
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
  role: z.enum(['owner', 'staff', 'admin']),
  can_add_products: z.boolean(),
});

function EditUserModal({ user, onClose, onDone }: { user: Profile; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { refreshProfile, profile: me } = useAuth();
  const { register, handleSubmit, watch, formState } = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    defaultValues: { full_name: user.full_name, phone: user.phone ?? '', role: user.role, can_add_products: user.can_add_products },
  });
  const m = useMutation({
    mutationFn: (v: z.infer<typeof editSchema>) => adminUsers({ action: 'update', user_id: user.id, ...v }),
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
      description={user.email}
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
        {user.role === 'admin' ? (
          <p className="rounded-lg bg-brand-50 p-3 text-sm text-muted">Administrator role cannot be changed here.</p>
        ) : (
          <>
            <Select label="Role" {...register('role')}>
              <option value="staff">Staff</option>
              <option value="owner">Owner</option>
            </Select>
            {watch('role') === 'staff' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-brand-700" {...register('can_add_products')} /> Can add new products
              </label>
            )}
          </>
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
    <Modal open onClose={onClose} size="lg" title={user.full_name} description={user.email}>
      <dl className="divide-y divide-line">
        <DetailRow label="Role"><RoleBadge role={user.role} /></DetailRow>
        <DetailRow label="Status">{user.is_active ? 'Active' : 'Inactive'}</DetailRow>
        <DetailRow label="Phone">{user.phone ?? '—'}</DetailRow>
        <DetailRow label="Last sign-in">{fmtDateTime(user.last_login_at)}</DetailRow>
        <DetailRow label="Created">{fmtDateTime(user.created_at)}</DetailRow>
      </dl>
      <h3 className="mt-6 mb-2 text-sm font-semibold">Recent activity</h3>
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

function ActivityPanel() {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([debounced]);
  const q = useQuery({ queryKey: ['activity', 'log', debounced, page], queryFn: () => listActivity({ page, search: debounced }), placeholderData: (p) => p });
  return (
    <Card title="System activity log" subtitle="Audit trail of sign-ins, record changes and inventory operations">
      <div className="border-b border-line p-4">
        <SearchInput value={search} onChange={setSearch} className="max-w-md" placeholder="Search activity, user or action…" />
      </div>
      {q.isError ? (
        <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock />
      ) : !q.data?.rows.length ? (
        <EmptyState title="No activity" />
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {q.data.rows.map((a) => (
                <tr key={a.id}>
                  <td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(a.created_at)}</td>
                  <td className="whitespace-nowrap">{a.user_name ?? 'System'}</td>
                  <td><Badge tone="slate">{a.action.replace(/_/g, ' ')}</Badge><span className="block text-[11px] text-muted">{a.entity_type.replace(/_/g, ' ')}</span></td>
                  <td className="text-sm">{a.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
    </Card>
  );
}
