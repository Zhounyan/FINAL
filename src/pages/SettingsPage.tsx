import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DatabaseBackup, KeyRound, Receipt, Settings, Store } from 'lucide-react';
import { updateSetting } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { ALL_PAYMENT_METHODS, paymentLabel } from '@/lib/format';
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
  store_tin: z.string().trim().max(60),
  invoice_footer: z.string().trim().max(300),
  cashier_max_discount_pct: z.coerce.number<string | number>().min(0, '0 to 100').max(100, '0 to 100'),
  // Cash is always accepted; the other methods are optional.
  payment_methods: z.array(z.string()).transform((a) => ['cash', ...a.filter((m) => m !== 'cash')]),
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
      const changed = (Object.keys(v) as (keyof Values)[]).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(current[k as keyof StoreSettings]));
      for (const k of changed) await updateSetting(k as keyof StoreSettings, v[k] as string | number | string[]);
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
      <PageHeader icon={<Settings className="size-5" />} title="Settings" description="Store details, Point of Sale and invoice options, and data backups." />
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
              <h3 className="mt-2 flex items-center gap-2 text-sm font-semibold text-ink sm:col-span-2"><Receipt className="size-4" /> Point of Sale &amp; invoices</h3>
              <fieldset className="sm:col-span-2">
                <legend className="mb-1.5 text-sm font-medium text-ink">Payment methods accepted at the POS</legend>
                <div className="flex flex-wrap gap-3">
                  {ALL_PAYMENT_METHODS.map((m) => (
                    <label key={m} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                      {m === 'cash' ? (
                        <input type="checkbox" className="size-4 accent-brand-700" checked readOnly disabled aria-label="Cash (always accepted)" />
                      ) : (
                        <input type="checkbox" className="size-4 accent-brand-700" value={m} {...form.register('payment_methods')} />
                      )}
                      {paymentLabel(m)}
                    </label>
                  ))}
                </div>
                {form.formState.errors.payment_methods && <p className="mt-1 text-xs text-red-600">{form.formState.errors.payment_methods.message}</p>}
              </fieldset>
              <Input label="Cashier discount limit (%)" type="number" min={0} max={100} step="0.5" hint="0 = cashiers cannot give discounts. The Administrator can always discount." error={form.formState.errors.cashier_max_discount_pct?.message} {...form.register('cashier_max_discount_pct')} />
              <Input label="TIN (printed on invoices)" error={form.formState.errors.store_tin?.message} {...form.register('store_tin')} />
              <Input label="Invoice footer message" error={form.formState.errors.invoice_footer?.message} {...form.register('invoice_footer')} wrapperClassName="sm:col-span-2" />
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
        <div className="space-y-6">
        <Card title="Backup & Restore" bodyClassName="p-5 space-y-3 text-sm text-muted">
          <p>Create, download and restore full backups. An automatic weekly backup runs on the server.</p>
          <Link to="/backups" className="inline-flex items-center gap-2 font-medium text-brand-700 hover:underline">
            <DatabaseBackup className="size-4" /> Open Backup &amp; Restore
          </Link>
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
    </div>
  );
}
