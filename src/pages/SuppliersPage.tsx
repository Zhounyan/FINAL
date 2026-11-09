import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArchiveRestore, Eye, Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { deleteSupplier, listSuppliers, PAGE_SIZE, restoreSupplier, saveSupplier, supplierDeliveries } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { code, fmtDate, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import type { Supplier } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useSettings, useResettingPage } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Card, DetailRow, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ExportButtons } from '@/components/ExportButtons';

const phone = z.string().trim().max(40).regex(/^[0-9+()\-\s]*$/, 'Use digits, spaces, +, - or parentheses').optional();
const schema = z.object({
  name: z.string().trim().min(2, 'Supplier name is required').max(150),
  contact_person: z.string().trim().max(120).optional(),
  contact_number: phone,
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address')]).optional(),
  address: z.string().trim().max(300).optional(),
});
type Values = z.infer<typeof schema>;

export default function SuppliersPage() {
  const { can, profile } = useAuth();
  const settings = useSettings();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [viewing, setViewing] = useState<Supplier | null>(null);
  const [deleting, setDeleting] = useState<Supplier | null>(null);
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([debounced, archived]);

  const q = useQuery({
    queryKey: ['suppliers', 'list', debounced, archived, page],
    queryFn: () => listSuppliers({ search: debounced, archived, page }),
    placeholderData: (p) => p,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['suppliers'] });

  const del = useMutation({
    mutationFn: (s: Supplier) => deleteSupplier(s.id),
    onSuccess: async (r, s) => {
      toast.success(r === 'archived' ? `${s.name} has delivery history and was archived.` : `${s.name} was deleted.`);
      setDeleting(null);
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: (s: Supplier) => restoreSupplier(s.id),
    onSuccess: async () => {
      toast.success('Supplier restored.');
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Truck className="size-5" />}
        title="Suppliers"
        description="Supplier directory and delivery history. Newest suppliers appear first."
        actions={
          <>
            <ExportButtons
              build={async () => {
                const all = await listSuppliers({ search: debounced, archived, page: 1, pageSize: 5000 });
                return {
                  rows: all.rows,
                  columns: [
                    { header: 'Supplier ID', value: (s: Supplier) => code('SUP', s.id) },
                    { header: 'Supplier Name', value: (s: Supplier) => s.name, wrap: true },
                    { header: 'Contact Person', value: (s: Supplier) => s.contact_person ?? '', wrap: true },
                    { header: 'Contact Number', value: (s: Supplier) => s.contact_number ?? '' },
                    { header: 'Email', value: (s: Supplier) => s.email ?? '' },
                    { header: 'Address', value: (s: Supplier) => s.address ?? '', wrap: true },
                    { header: 'Deliveries', value: (s: Supplier) => Number(s.delivery_count ?? 0), numeric: true },
                    { header: 'Units Supplied', value: (s: Supplier) => Number(s.total_quantity ?? 0), numeric: true },
                    { header: 'Date Added', value: (s: Supplier) => fmtDate(s.created_at) },
                  ],
                  meta: { title: 'Supplier Report', storeName: settings.data?.store_name ?? 'Bill Store', generatedBy: profile?.full_name, subtitle: `${all.total} supplier(s)${archived ? ' · archived' : ''}` },
                };
              }}
            />
            {can.manageSuppliers && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add supplier</Button>}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} className="min-w-64 flex-1" placeholder="Search name, contact person, number, email…" />
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="size-4 accent-brand-700" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
          </label>
        </div>
        {q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock />
        ) : !q.data?.rows.length ? (
          <EmptyState title={debounced ? 'No matching suppliers' : 'No suppliers yet'} action={can.manageSuppliers && !debounced && !archived ? <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add supplier</Button> : undefined} />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="suppliers-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Contact person</th>
                  <th>Contact</th>
                  <th className="num">Deliveries</th>
                  <th className="num">Units supplied</th>
                  <th>Added</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((s) => (
                  <tr key={s.id}>
                    <td><span className="font-medium">{s.name}</span><span className="block text-xs text-muted">{code('SUP', s.id)}</span></td>
                    <td>{s.contact_person ?? '—'}</td>
                    <td className="text-sm">{s.contact_number ?? '—'}<span className="block text-xs text-muted">{s.email}</span></td>
                    <td className="num">{fmtInt(s.delivery_count)}</td>
                    <td className="num">{fmtInt(s.total_quantity)}</td>
                    <td className="text-xs whitespace-nowrap text-muted">{fmtDate(s.created_at)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" onClick={() => setViewing(s)} aria-label={`View ${s.name}`}><Eye className="size-4" /></Button>
                      {can.manageSuppliers && !s.is_archived && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}><Pencil className="size-4" /></Button>
                          <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setDeleting(s)} aria-label={`Delete ${s.name}`}><Trash2 className="size-4" /></Button>
                        </>
                      )}
                      {can.manageSuppliers && s.is_archived && (
                        <Button variant="ghost" size="sm" icon={<ArchiveRestore className="size-4" />} onClick={() => restore.mutate(s)}>Restore</Button>
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

      {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      {viewing && <SupplierDetail supplier={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete supplier?"
        message={<>Delete <b className="text-ink">{deleting?.name}</b>? Suppliers with delivery history are archived instead.</>}
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function SupplierForm({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: supplier?.name ?? '',
      contact_person: supplier?.contact_person ?? '',
      contact_number: supplier?.contact_number ?? '',
      email: supplier?.email ?? '',
      address: supplier?.address ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: Values) => saveSupplier({ id: supplier?.id, ...v }),
    onSuccess: async () => {
      toast.success(supplier ? 'Supplier updated.' : 'Supplier added.');
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
      title={supplier ? 'Edit supplier' : 'Add supplier'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="supplier-form" loading={save.isPending}>Save</Button>
        </>
      }
    >
      <form id="supplier-form" onSubmit={handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Input label="Company / supplier name" required error={formState.errors.name?.message} {...register('name')} wrapperClassName="sm:col-span-2" />
        <Input label="Contact person" error={formState.errors.contact_person?.message} {...register('contact_person')} />
        <Input label="Contact number" inputMode="tel" error={formState.errors.contact_number?.message} {...register('contact_number')} />
        <Input label="Email address" type="email" error={formState.errors.email?.message} {...register('email')} wrapperClassName="sm:col-span-2" />
        <Textarea label="Business address" error={formState.errors.address?.message} {...register('address')} wrapperClassName="sm:col-span-2" />
      </form>
    </Modal>
  );
}

function SupplierDetail({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const { can } = useAuth();
  const deliveries = useQuery({ queryKey: ['suppliers', 'deliveries', supplier.id], queryFn: () => supplierDeliveries(supplier.id) });
  return (
    <Modal open onClose={onClose} size="xl" title={supplier.name} description={code('SUP', supplier.id)}>
      <dl className="grid divide-y divide-line sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
        <DetailRow label="Contact person">{supplier.contact_person ?? '—'}</DetailRow>
        <DetailRow label="Contact number">{supplier.contact_number ?? '—'}</DetailRow>
        <DetailRow label="Email">{supplier.email ?? '—'}</DetailRow>
        <DetailRow label="Business address">{supplier.address ?? '—'}</DetailRow>
        <DetailRow label="Date added">{fmtDateTime(supplier.created_at)}</DetailRow>
        <DetailRow label="Deliveries">{fmtInt(supplier.delivery_count)} · {fmtInt(supplier.total_quantity)} units{can.viewFinancials ? ` · ${fmtMoney(supplier.total_cost)}` : ''}</DetailRow>
      </dl>
      <h3 className="mt-6 mb-2 text-sm font-semibold">Delivery history</h3>
      <div className="rounded-xl border border-line">
        {deliveries.isLoading ? (
          <LoadingBlock rows={3} />
        ) : !deliveries.data?.length ? (
          <EmptyState title="No deliveries recorded" />
        ) : (
          <TableWrap>
            <table className="table-base">
              <thead><tr><th>Date</th><th>Product</th><th className="num">Quantity</th><th>Reference</th><th>Recorded by</th></tr></thead>
              <tbody>
                {deliveries.data.map((m) => (
                  <tr key={m.id}><td className="text-xs text-muted">{fmtDateTime(m.occurred_at)}</td><td className="font-medium">{m.product_name}</td><td className="num">+{fmtInt(m.quantity_change)}</td><td className="text-xs">{m.reference_no ?? '—'}</td><td className="text-xs">{m.created_by_name}</td></tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>
    </Modal>
  );
}
