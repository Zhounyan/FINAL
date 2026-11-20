import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { getSetupStatus } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { PasswordInput } from '@/components/PasswordStrength';
import { FullPageLoader } from '@/components/ui/Spinner';
import { AuthShell, FormAlert } from './AuthShell';

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your username or email')
    .refine((v) => (v.includes('@') ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) : /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(v)), 'Enter a valid username or email address'),
  password: z.string().min(1, 'Password is required'),
});
type Values = z.infer<typeof schema>;

export default function LoginPage() {
  const { session, profile, signIn } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const status = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 0, retry: 1 });
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  if (session && profile) return <Navigate to={(location.state as { from?: string })?.from ?? '/'} replace />;
  if (status.isLoading) return <FullPageLoader />;
  if (status.data?.setup_required) return <Navigate to="/setup" replace />;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      // Once signed in, this page re-renders and redirects (see the <Navigate> above) — one redirect only.
      await signIn(v.email, v.password);
    } catch (e) {
      const err = e as Error & { info?: { remaining_attempts?: number } };
      const remaining = err.info?.remaining_attempts;
      setError(err.message + (typeof remaining === 'number' && remaining > 0 && remaining <= 3 ? ` ${remaining} attempt(s) left before a temporary lock.` : ''));
    }
  });

  return (
    <AuthShell title="Sign in to INVPORTIQ" subtitle={`${status.data?.store_name ?? 'Bill Store'} · Inventory & Business Intelligence`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <FormAlert>{error}</FormAlert>}
        {status.isError && <FormAlert>Could not reach the server. Check your connection.</FormAlert>}
        <Input label="Username or email" autoComplete="username" autoCapitalize="none" placeholder="e.g. maria or you@billstore.com" error={formState.errors.email?.message} {...register('email')} />
        <PasswordInput label="Password" autoComplete="current-password" placeholder="Enter your password" error={formState.errors.password?.message} {...register('password')} />
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-brand-700 hover:text-brand-900 hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={formState.isSubmitting} icon={<LogIn className="size-4" />}>
          Sign in
        </Button>
        <p className="pt-2 text-center text-xs text-muted">Accounts are created by the store administrator. Public registration is disabled.</p>
      </form>
    </AuthShell>
  );
}
