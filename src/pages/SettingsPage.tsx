import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { KeyRound, Settings, Store } from 'lucide-react';
import { updateSetting } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import type { StoreSettings } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useSettings } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Card, DetailRow, PageHeader } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Manila', 'UTC'];
  }
})();

const schema = z.object({
  store_name: z.string().trim().min(2, 'Store name is required').max(80),
  store_address: z.string().trim().max(200),
  store_contact: z.string().trim().max(80),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code, e.g. PHP'),
  timezone: z.string().min(1),
  default_min_stock: z.coerce.number<string | number>().int('Whole number').min(0, 'Cannot be negative').max(1_000_000),
});
type Form = z.input<typeof schema>;
type Values = z.output<typeof schema>;

export default function SettingsPage() {
  const { can } = useAuth();
  const settings = useSettings();
  const qc = useQueryClient();
  const form = useForm<Form, unknown, Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (settings.data) form.reset(settings.data);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: async (v: Values) => {
      const current = settings.data!;
      const changed = (Object.keys(v) as (keyof StoreSettings)[]).filter((k) => String(v[k]) !== String(current[k]));
      for (const k of changed) await updateSetting(k, v[k]);
      return changed.length;
    },
    onSuccess: async (n) => {
      toast.success(n ? 'Settings saved.' : 'No changes to save.');
      await qc.invalidateQueries();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (settings.isLoading || !settings.data) return <LoadingBlock />;
  const s = settings.data;

  return (
    <div className="space-y-6">
      <PageHeader icon={<Settings className="size-5" />} title="Settings" description={can.manageSettings ? 'Store details and system preferences.' : 'Store details (read-only for your role).'} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Store settings" subtitle="Single-branch configuration for Bill Store" className="xl:col-span-2" bodyClassName="p-5">
          {can.manageSettings ? (
            <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
              <Input label="Store name" required error={form.formState.errors.store_name?.message} {...form.register('store_name')} wrapperClassName="sm:col-span-2" />
              <Input label="Address" error={form.formState.errors.store_address?.message} {...form.register('store_address')} wrapperClassName="sm:col-span-2" />
              <Input label="Contact" error={form.formState.errors.store_contact?.message} {...form.register('store_contact')} />
              <Input label="Currency" error={form.formState.errors.currency?.message} {...form.register('currency')} maxLength={3} />
              <Select label="Time zone" hint="Defines the start and end of each day in stock movement reports." {...form.register('timezone')}>
                {TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
              <Input label="Default minimum stock" type="number" min={0} hint="Pre-filled when adding new products." error={form.formState.errors.default_min_stock?.message} {...form.register('default_min_stock')} />
              <div className="flex justify-end sm:col-span-2">
                <Button type="submit" loading={save.isPending} icon={<Store className="size-4" />}>Save settings</Button>
              </div>
            </form>
          ) : (
            <dl className="divide-y divide-line">
              <DetailRow label="Store name">{s.store_name}</DetailRow>
              <DetailRow label="Address">{s.store_address || '—'}</DetailRow>
              <DetailRow label="Contact">{s.store_contact || '—'}</DetailRow>
              <DetailRow label="Currency">{s.currency}</DetailRow>
              <DetailRow label="Time zone">{s.timezone}</DetailRow>
            </dl>
          )}
        </Card>
        <Card title="Security" bodyClassName="p-5 space-y-3 text-sm text-muted">
          <p>Passwords require at least 8 characters with an uppercase letter, a number and a special symbol.</p>
          <p>Five failed sign-in attempts lock an account for 15 minutes.</p>
          <Link to="/profile?tab=password" className="inline-flex items-center gap-2 font-medium text-brand-700 hover:underline">
            <KeyRound className="size-4" /> Change my password
          </Link>
        </Card>
      </div>
    </div>
  );
}
