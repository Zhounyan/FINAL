import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArchiveRestore, Eye, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { customerSales, deleteCustomer, listCustomers, PAGE_SIZE, restoreCustomer, saveCustomer } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { code, fmtDate, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import type { Customer } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useSettings, useResettingPage } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Card, DetailRow, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ExportButtons } from '@/components/ExportButtons';

const schema = z.object({
  full_name: z.string().trim().min(2, 'Full name is required').max(120),
  contact_number: z.string().trim().max(40).regex(/^[0-9+()\-\s]*$/, 'Use digits, spaces, +, - or parentheses').optional(),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address')]).optional(),
  address: z.string().trim().max(300).optional(),
});
type Values = z.infer<typeof schema>;

export default function CustomersPage() {
  const { can, profile } = useAuth();
  const settings = useSettings();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([debounced, archived]);

  const q = useQuery({
    queryKey: ['customers', 'list', debounced, archived, page],
    queryFn: () => listCustomers({ search: debounced, archived, page }),
    placeholderData: (p) => p,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['customers'] });

  const del = useMutation({
    mutationFn: (c: Customer) => deleteCustomer(c.id),
    onSuccess: async (r, c) => {
      toast.success(r === 'archived' ? `${c.full_name} has purchase history and was archived.` : `${c.full_name} was deleted.`);
      setDeleting(null);
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: (c: Customer) => restoreCustomer(c.id),
    onSuccess: async () => {
      toast.success('Customer restored.');
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Users className="size-5" />}
        title="Customers"
        description="Customer records and purchase history. Newest customers appear first."
        actions={
          <>
            <ExportButtons
              build={async () => {
                const all = await listCustomers({ search: debounced, archived, page: 1, pageSize: 5000 });
                return {
                  rows: all.rows,
                  columns: [
                    { header: 'Customer ID', value: (c: Customer) => code('CUS', c.id) },
                    { header: 'Full Name', value: (c: Customer) => c.full_name, wrap: true },
                    { header: 'Contact Number', value: (c: Customer) => c.contact_number ?? '' },
                    { header: 'Email', value: (c: Customer) => c.email ?? '' },
                    { header: 'Address', value: (c: Customer) => c.address ?? '', wrap: true },
                    { header: 'Purchases', value: (c: Customer) => Number(c.sale_count ?? 0), numeric: true },
                    { header: 'Total Spent', value: (c: Customer) => Number(c.total_amount ?? 0), money: true },
                    { header: 'Date Added', value: (c: Customer) => fmtDate(c.created_at) },
                  ],
                  meta: { title: 'Customer Report', storeName: settings.data?.store_name ?? 'Bill Store', generatedBy: profile?.full_name, subtitle: `${all.total} customer(s)${archived ? ' · archived' : ''}` },
                };
              }}
            />
            {can.manageCustomers && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add customer</Button>}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} className="min-w-64 flex-1" placeholder="Search name, contact, email or address…" />
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="size-4 accent-brand-700" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
          </label>
        </div>
        {q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock />
        ) : !q.data?.rows.length ? (
          <EmptyState title={debounced ? 'No matching customers' : 'No customers yet'} action={can.manageCustomers && !debounced && !archived ? <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add customer</Button> : undefined} />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="customers-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Contact</th>
                  <th>Address</th>
                  <th className="num">Purchases</th>
                  <th className="num">Total spent</th>
                  <th>Added</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((c) => (
                  <tr key={c.id}>
                    <td><span className="font-medium">{c.full_name}</span><span className="block text-xs text-muted">{code('CUS', c.id)}</span></td>
                    <td className="text-sm">{c.contact_number ?? '—'}<span className="block text-xs text-muted">{c.email}</span></td>
                    <td className="max-w-56 truncate text-sm text-muted">{c.address ?? '—'}</td>
                    <td className="num">{fmtInt(c.sale_count)}</td>
                    <td className="num">{fmtMoney(c.total_amount)}</td>
                    <td className="text-xs whitespace-nowrap text-muted">{fmtDate(c.created_at)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" onClick={() => setViewing(c)} aria-label={`View ${c.full_name}`}><Eye className="size-4" /></Button>
                      {can.manageCustomers && !c.is_archived && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => setEditing(c)} aria-label={`Edit ${c.full_name}`}><Pencil className="size-4" /></Button>
                          <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setDeleting(c)} aria-label={`Delete ${c.full_name}`}><Trash2 className="size-4" /></Button>
                        </>
                      )}
                      {can.manageCustomers && c.is_archived && (
                        <Button variant="ghost" size="sm" icon={<ArchiveRestore className="size-4" />} onClick={() => restore.mutate(c)}>Restore</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      </Card>

      {editing && <CustomerForm customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      {viewing && <CustomerDetail customer={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete customer?"
        message={<>Delete <b className="text-ink">{deleting?.full_name}</b>? Customers with purchase history are archived instead, so past sales stay accurate.</>}
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { full_name: customer?.full_name ?? '', contact_number: customer?.contact_number ?? '', email: customer?.email ?? '', address: customer?.address ?? '' },
  });
  const save = useMutation({
    mutationFn: (v: Values) => saveCustomer({ id: customer?.id, ...v }),
    onSuccess: async () => {
      toast.success(customer ? 'Customer updated.' : 'Customer added.');
      await onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={customer ? 'Edit customer' : 'Add customer'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="customer-form" loading={save.isPending}>Save</Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Input label="Full name" required error={formState.errors.full_name?.message} {...register('full_name')} wrapperClassName="sm:col-span-2" />
        <Input label="Contact number" inputMode="tel" error={formState.errors.contact_number?.message} {...register('contact_number')} />
        <Input label="Email address" type="email" error={formState.errors.email?.message} {...register('email')} />
        <Textarea label="Address" error={formState.errors.address?.message} {...register('address')} wrapperClassName="sm:col-span-2" />
      </form>
    </Modal>
  );
}

function CustomerDetail({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const sales = useQuery({ queryKey: ['customers', 'sales', customer.id], queryFn: () => customerSales(customer.id) });
  return (
    <Modal open onClose={onClose} size="xl" title={customer.full_name} description={code('CUS', customer.id)}>
      <dl className="grid divide-y divide-line sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
        <DetailRow label="Contact number">{customer.contact_number ?? '—'}</DetailRow>
        <DetailRow label="Email">{customer.email ?? '—'}</DetailRow>
        <DetailRow label="Address">{customer.address ?? '—'}</DetailRow>
        <DetailRow label="Date added">{fmtDateTime(customer.created_at)}</DetailRow>
        <DetailRow label="Purchases">{fmtInt(customer.sale_count)} · {fmtInt(customer.total_quantity)} units</DetailRow>
        <DetailRow label="Total spent">{fmtMoney(customer.total_amount)}</DetailRow>
      </dl>
      <h3 className="mt-6 mb-2 text-sm font-semibold">Purchase history</h3>
      <div className="rounded-xl border border-line">
        {sales.isLoading ? (
          <LoadingBlock rows={3} />
        ) : !sales.data?.length ? (
          <EmptyState title="No purchases yet" />
        ) : (
          <TableWrap>
            <table className="table-base">
              <thead><tr><th>Reference</th><th>Date</th><th className="num">Units</th><th className="num">Total</th><th>Recorded by</th></tr></thead>
              <tbody>
                {sales.data.map((s) => (
                  <tr key={s.id}><td className="font-medium">{s.reference_no}</td><td className="text-xs text-muted">{fmtDateTime(s.sold_at)}</td><td className="num">{fmtInt(s.total_quantity)}</td><td className="num">{fmtMoney(s.total_amount)}</td><td className="text-xs">{s.created_by_name}</td></tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>
    </Modal>
  );
}
