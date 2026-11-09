import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { passwordPolicyError } from '@shared/password-policy';
import { authLinkHint, supabase } from '@/lib/supabase';
import { invokeFunction } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { PasswordInput, PasswordStrengthMeter } from '@/components/PasswordStrength';
import { Spinner } from '@/components/ui/Spinner';
import { AuthShell, FormAlert } from './AuthShell';

const schema = z
  .object({
    password: z.string().superRefine((v, ctx) => {
      const err = passwordPolicyError(v);
      if (err) ctx.addIssue({ code: 'custom', message: err });
    }),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Values = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);
  const { register, handleSubmit, watch, formState } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });

  useEffect(() => {
    // The PKCE code in the URL is exchanged automatically; give it a moment.
    const t = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(t);
  }, []);

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      await invokeFunction('change-password', { mode: 'recovery', new_password: v.password });
      await supabase.auth.signOut({ scope: 'local' });
      toast.success('Password updated. Please sign in with your new password.');
      navigate('/login', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  if (!session && (loading || !waited)) {
    return (
      <AuthShell title="Verifying reset link…">
        <div className="flex justify-center py-6"><Spinner className="size-8" /></div>
      </AuthShell>
    );
  }

  if (!session) {
    return (
      <AuthShell title="Reset link invalid or expired">
        <div className="space-y-4">
          <FormAlert>
            This password reset link is invalid or has expired{authLinkHint.error ? ` (${authLinkHint.error})` : ''}. Reset links work once and expire after a
            short time. Request a new one.
          </FormAlert>
          <Link to="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">Request a new link</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Your new password must meet the security requirements below.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <FormAlert>{error}</FormAlert>}
        <PasswordInput label="New password" autoComplete="new-password" error={formState.errors.password?.message} {...register('password')} />
        <PasswordStrengthMeter password={watch('password')} />
        <PasswordInput label="Confirm new password" autoComplete="new-password" error={formState.errors.confirm?.message} {...register('confirm')} />
        <Button type="submit" size="lg" className="w-full" loading={formState.isSubmitting}>Update password</Button>
      </form>
    </AuthShell>
  );
}
