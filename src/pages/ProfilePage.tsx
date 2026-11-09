import { useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Camera, KeyRound, Trash2, UserCircle } from 'lucide-react';
import { passwordPolicyError } from '@shared/password-policy';
import { invokeFunction, updateMyAvatar, updateMyProfile } from '@/lib/api';
import { imageFileToAvatar } from '@/lib/image';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/permissions';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Card, DetailRow, PageHeader } from '@/components/ui/Display';
import { PasswordInput, PasswordStrengthMeter } from '@/components/PasswordStrength';
import { FormAlert } from './auth/AuthShell';
import { Avatar } from '@/components/ui/Avatar';

const profileSchema = z.object({
  full_name: z.string().trim().min(2, 'Full name is required').max(120),
  phone: z.string().trim().max(40).regex(/^[0-9+()\-\s]*$/, 'Use digits, spaces, +, - or parentheses').optional(),
});

const passwordSchema = z
  .object({
    current_password: z.string().min(1, 'Enter your current password'),
    new_password: z.string().superRefine((v, ctx) => {
      const err = passwordPolicyError(v);
      if (err) ctx.addIssue({ code: 'custom', message: err });
    }),
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
  .refine((v) => v.new_password !== v.current_password, { path: ['new_password'], message: 'Choose a password different from your current one' });

export default function ProfilePage() {
  const { profile, refreshProfile, signIn, signOut } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const required = params.get('required') === '1' || profile?.must_change_password;

  const pf = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: { full_name: profile?.full_name ?? '', phone: profile?.phone ?? '' },
  });
  const saveProfile = useMutation({
    mutationFn: (v: z.infer<typeof profileSchema>) => updateMyProfile(v.full_name, v.phone ?? ''),
    onSuccess: async () => {
      toast.success('Profile updated.');
      await refreshProfile();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const pw = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema), defaultValues: { current_password: '', new_password: '', confirm: '' } });
  const changePw = useMutation({
    mutationFn: async (v: z.infer<typeof passwordSchema>) => {
      await invokeFunction('change-password', { current_password: v.current_password, new_password: v.new_password });
      // All sessions were revoked server-side; sign back in with the new password.
      try {
        await signIn(profile!.email, v.new_password);
        return true;
      } catch {
        await signOut();
        return false;
      }
    },
    onSuccess: async (reauthenticated) => {
      pw.reset();
      if (reauthenticated) {
        toast.success('Password changed. Other devices have been signed out.');
        await refreshProfile();
        if (required) navigate('/', { replace: true });
      } else {
        toast.success('Password changed. Please sign in again.');
        navigate('/login', { replace: true });
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!profile) return null;

  return (
    <div className="space-y-6">
      <PageHeader icon={<UserCircle className="size-5" />} title="My Profile" description="Your account details and password." />
      {required && (
        <FormAlert>
          For security, you must change the temporary password given to you before using INVPORTIQ.
        </FormAlert>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Account information" bodyClassName="p-5 space-y-5">
          <ProfilePhoto />
          <dl className="divide-y divide-line">
            <DetailRow label="Email">{profile.email}</DetailRow>
            <DetailRow label="Role">{ROLE_LABELS[profile.role]}{profile.role === 'staff' && profile.can_add_products ? ' · can add products' : ''}</DetailRow>
            <DetailRow label="Last sign-in">{fmtDateTime(profile.last_login_at)}</DetailRow>
            <DetailRow label="Member since">{fmtDateTime(profile.created_at)}</DetailRow>
          </dl>
          <form onSubmit={pf.handleSubmit((v) => saveProfile.mutate(v))} className="space-y-4" noValidate>
            <Input label="Full name" required error={pf.formState.errors.full_name?.message} {...pf.register('full_name')} />
            <Input label="Phone" error={pf.formState.errors.phone?.message} {...pf.register('phone')} />
            <div className="flex justify-end">
              <Button type="submit" loading={saveProfile.isPending} disabled={required}>Save profile</Button>
            </div>
          </form>
        </Card>

        <Card title="Change password" subtitle="Changing your password signs you out of all other devices" bodyClassName="p-5" className={required ? 'ring-2 ring-amber-300' : ''}>
          <form onSubmit={pw.handleSubmit((v) => changePw.mutate(v))} className="space-y-4" noValidate data-testid="change-password-form">
            <PasswordInput label="Current password" required autoComplete="current-password" error={pw.formState.errors.current_password?.message} {...pw.register('current_password')} />
            <PasswordInput label="New password" required autoComplete="new-password" error={pw.formState.errors.new_password?.message} {...pw.register('new_password')} />
            <PasswordStrengthMeter password={pw.watch('new_password')} />
            <PasswordInput label="Confirm new password" required autoComplete="new-password" error={pw.formState.errors.confirm?.message} {...pw.register('confirm')} />
            <div className="flex justify-end">
              <Button type="submit" loading={changePw.isPending} icon={<KeyRound className="size-4" />}>Change password</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}

/** Upload, change or remove the signed-in user's profile photo. */
function ProfilePhoto() {
  const { profile, refreshProfile } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async (file: File | null) => updateMyAvatar(file ? await imageFileToAvatar(file) : null),
    onSuccess: async (_r, file) => {
      await Promise.all([refreshProfile(), qc.invalidateQueries({ queryKey: ['users'] })]);
      toast.success(file ? 'Profile photo updated.' : 'Profile photo removed.');
    },
    onError: (e) => toast.error(errorMessage(e, 'Could not update the photo.')),
  });
  if (!profile) return null;
  return (
    <div className="flex flex-wrap items-center gap-5" data-testid="profile-photo">
      <Avatar name={profile.full_name} src={profile.avatar_url} size="lg" className="shadow-card" />
      <div className="space-y-2">
        <p className="text-sm font-medium text-ink">Profile photo</p>
        <p className="text-xs text-muted">JPEG, PNG or WebP. It is cropped to a square and resized automatically.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Camera className="size-4" />} loading={save.isPending && save.variables !== null} onClick={() => input.current?.click()}>
            {profile.avatar_url ? 'Change photo' : 'Upload photo'}
          </Button>
          {profile.avatar_url && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={save.isPending && save.variables === null} onClick={() => save.mutate(null)}>
              Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Choose profile photo"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) save.mutate(file);
          }}
        />
      </div>
    </div>
  );
}
