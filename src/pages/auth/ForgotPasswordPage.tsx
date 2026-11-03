import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Mail } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { AuthShell, FormAlert } from './AuthShell';

const schema = z.object({ email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address') });

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<{ email: string }>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    // Rate-limit and delivery errors are shown; whether an account exists is never revealed.
    if (err && /rate|seconds/i.test(err.message)) {
      setError('Please wait a minute before requesting another reset email.');
      return;
    }
    if (err && (/send|smtp|mail/i.test(err.message) || (err as { status?: number }).status === 500)) {
      setError(`The reset email could not be sent (${err.message}). Please contact the administrator.`);
      return;
    }
    setSent(true);
  });

  return (
    <AuthShell title="Reset your password" subtitle="Enter the email address of your INVPORTIQ account.">
      {sent ? (
        <div className="space-y-4">
          <FormAlert tone="success">
            If an account exists for that email, a password reset link has been sent. The link expires after a short time.
          </FormAlert>
          <Link to="/login" className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 hover:underline">
            <ArrowLeft className="size-4" /> Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <FormAlert>{error}</FormAlert>}
          <Input label="Email address" type="email" autoComplete="email" error={formState.errors.email?.message} {...register('email')} />
          <Button type="submit" size="lg" className="w-full" loading={formState.isSubmitting} icon={<Mail className="size-4" />}>
            Send reset link
          </Button>
          <Link to="/login" className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 hover:underline">
            <ArrowLeft className="size-4" /> Back to sign in
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
