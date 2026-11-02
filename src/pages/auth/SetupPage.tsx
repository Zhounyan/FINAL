import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { passwordPolicyError } from '@shared/password-policy';
import { getSetupStatus, invokeFunction } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { PasswordInput, PasswordStrengthMeter } from '@/components/PasswordStrength';
import { FullPageLoader } from '@/components/ui/Spinner';
import { AuthShell, FormAlert } from './AuthShell';

const schema = z
  .object({
    full_name: z.string().trim().min(2, 'Enter your full name').max(120),
    email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
    password: z.string().superRefine((v, ctx) => {
      const err = passwordPolicyError(v);
      if (err) ctx.addIssue({ code: 'custom', message: err });
    }),
    confirm: z.string(),
    setup_token: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Values = z.infer<typeof schema>;

export default function SetupPage() {
  const status = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 0 });
  const { signIn } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, watch, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { full_name: '', email: '', password: '', confirm: '', setup_token: '' },
  });
  const password = watch('password');

  if (status.isLoading) return <FullPageLoader />;
  // Setup is permanently closed once an administrator exists.
  if (!status.data?.setup_required) return <Navigate to="/login" replace />;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      await invokeFunction('initial-setup', {
        full_name: v.full_name,
        email: v.email,
        password: v.password,
        setup_token: v.setup_token || undefined,
      });
      await qc.invalidateQueries({ queryKey: ['setup-status'] });
      toast.success('Administrator account created. Initial setup is now closed.');
      await signIn(v.email, v.password);
      navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
      void status.refetch();
    }
  });

  return (
    <AuthShell
      title="Initial administrator setup"
      subtitle="Create the first Admin account for INVPORTIQ. This page is available only once and closes permanently afterwards."
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormAlert tone="info">
          <span className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            No demo or default accounts exist. The account you create here manages all other users.
          </span>
        </FormAlert>
        {error && <FormAlert>{error}</FormAlert>}
        <Input label="Full name" required autoComplete="name" error={formState.errors.full_name?.message} {...register('full_name')} />
        <Input label="Email address" type="email" required autoComplete="email" error={formState.errors.email?.message} {...register('email')} />
        <PasswordInput label="Password" required autoComplete="new-password" error={formState.errors.password?.message} {...register('password')} />
        <PasswordStrengthMeter password={password} />
        <PasswordInput label="Confirm password" required autoComplete="new-password" error={formState.errors.confirm?.message} {...register('confirm')} />
        <Input
          label="Setup token"
          type="password"
          autoComplete="off"
          hint="Only required if your deployment configured INITIAL_SETUP_TOKEN."
          error={formState.errors.setup_token?.message}
          {...register('setup_token')}
        />
        <Button type="submit" size="lg" className="w-full" loading={formState.isSubmitting}>
          Create administrator account
        </Button>
      </form>
    </AuthShell>
  );
}
