import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownToLine, PackageMinus, SlidersHorizontal } from 'lucide-react';
import { listMovements, PAGE_SIZE, recordAdjustment, recordStockIn, recordStockOut } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt, fmtMoney, fmtSigned, STOCK_OUT_REASONS } from '@/lib/format';
import type { MovementType, ProductRow, StockMovement, StockOutType } from '@/lib/types';
import { useDebounce, useInvalidateInventory, useProductOptions, useSupplierOptions, useResettingPage, useStoreToday } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Card, ErrorState, PageHeader, Pagination, SearchInput } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ProductCombobox } from '@/components/stock/ProductCombobox';
import { MovementTypeBadge } from '@/components/stock/MovementViews';
import { HistoryTable } from './StockReportPage';

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
export function StockInPage() {
  return (
    <div className="space-y-6">
      <PageHeader icon={<ArrowDownToLine className="size-5" />} title="Stock-In" description="Record products received. Inventory increases as soon as the entry is confirmed, and each entry gets its own IN- reference number." />
      <StockInForm />
      <RecentMovements title="Stock-In history" types={['stock_in']} showCost />
    </div>
  );
}

export function StockOutPage() {
  return (
    <div className="space-y-6">
      <PageHeader icon={<PackageMinus className="size-5" />} title="Stock-Out" description="Release damaged, expired, missing or internally used items. Sales are deducted automatically by the Point of Sale." />
      <StockOutForm />
      <RecentMovements title="Stock-Out history" types={['damaged', 'expired', 'lost', 'internal_use', 'other_out']} />
    </div>
  );
}

/** Authorized stock adjustment (physical count or verified error), opened from the Products page. */
export function StockAdjustmentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Authorized stock adjustment" description="Use after a physical count or a verified error. The previous quantity, change and new quantity are kept permanently.">
      <AdjustmentForm />
    </Modal>
  );
}

function RecentMovements({ title, types, showCost }: { title: string; types: MovementType[]; showCost?: boolean }) {
  const today = useStoreToday();
  const [from, setFrom] = useState(() => {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([from, to, debounced]);
  const valid = from && to && from <= to;
  const q = useQuery({
    queryKey: ['movements', 'recent', types, from, to, debounced, page],
    queryFn: () => listMovements({ from, to, types, search: debounced, page }),
    enabled: Boolean(valid),
    placeholderData: (p) => p,
  });
  return (
    <Card title={title}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <SearchInput value={search} onChange={setSearch} className="max-w-sm flex-1" placeholder="Search product, reference no., user…" />
        <input type="date" className="input h-10 w-auto" value={from} max={today} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <input type="date" className="input h-10 w-auto" value={to} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
      </div>
      {q.isError ? <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} /> : q.isLoading ? <LoadingBlock /> : <HistoryTable rows={q.data?.rows ?? []} showCost={showCost} />}
      <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
    </Card>
  );
}


function SuccessReceipt({ movement, onDismiss }: { movement: StockMovement; onDismiss: () => void }) {
  return (
    <div className="animate-pop-in rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          Recorded <MovementTypeBadge type={movement.movement_type} /> {fmtSigned(movement.quantity_change)} · {movement.product_name}
        </p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
      <p className="mt-1">
        Stock changed from <b>{fmtInt(movement.quantity_before)}</b> to <b>{fmtInt(movement.quantity_after)}</b> · Reference <b>{movement.movement_no}</b> · {fmtDateTime(movement.occurred_at)}
      </p>
      {movement.movement_type === 'stock_in' && movement.unit_cost != null && (
        <p className="mt-1">
          Total cost <b>{fmtMoney(movement.quantity_change * Number(movement.unit_cost))}</b> ({fmtInt(movement.quantity_change)} × {fmtMoney(movement.unit_cost)})
        </p>
      )}
    </div>
  );
}

function SelectedProductInfo({ product }: { product: ProductRow | undefined }) {
  if (!product) return null;
  return (
    <div className="grid grid-cols-3 gap-2 rounded-xl bg-brand-50/70 p-3 text-xs">
      <div><p className="text-muted">Category</p><p className="font-semibold text-ink">{product.category_name}</p></div>
      <div><p className="text-muted">On hand</p><p className="font-semibold text-ink tabular-nums">{fmtInt(product.current_stock)} {product.unit}</p></div>
      <div><p className="text-muted">Minimum</p><p className="font-semibold text-ink tabular-nums">{fmtInt(product.min_stock_level)}</p></div>
    </div>
  );
}

function positiveInt(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n > 0 && n <= 10_000_000 ? n : null;
}

function StockInForm() {
  const products = useProductOptions();
  const suppliers = useSupplierOptions();
  const invalidate = useInvalidateInventory();
  const [params] = useSearchParams();
  // A notification can open this form with the product already selected (?product=<id>).
  const [productId, setProductId] = useState<number | null>(() => (Number(params.get('product')) > 0 ? Number(params.get('product')) : null));
  const [qty, setQty] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  // The unit cost starts at the product's purchase price; the user may type a different cost for this delivery.
  const [costOverride, setCostOverride] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [last, setLast] = useState<StockMovement | null>(null);
  const product = products.data?.find((p) => p.id === productId);
  const unitCost = costOverride ?? (product ? Number(product.purchase_price).toFixed(2) : '');
  const qtyNum = positiveInt(qty);
  const costNum = unitCost === '' ? NaN : Number(unitCost);
  const totalCost = qtyNum && Number.isFinite(costNum) && costNum >= 0 ? Math.round(qtyNum * costNum * 100) / 100 : null;
  const chooseProduct = (id: number | null) => {
    setProductId(id);
    setCostOverride(null);
  };

  const m = useMutation({
    mutationFn: recordStockIn,
    onSuccess: async (row) => {
      setLast(row);
      toast.success(`Stock-In ${row.movement_no} recorded: +${fmtInt(row.quantity_change)} ${row.product_name}`);
      setQty('');
      setRef('');
      setReason('');
      setCostOverride(null);
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const q = positiveInt(qty);
    if (!productId) errs.product = 'Select a product';
    if (!q) errs.qty = 'Enter a whole number greater than zero';
    if (unitCost !== '' && (Number.isNaN(Number(unitCost)) || Number(unitCost) < 0)) errs.cost = 'Enter a valid cost';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    m.mutate({
      product_id: productId!,
      quantity: q!,
      supplier_id: supplierId ? Number(supplierId) : null,
      reference_no: ref,
      reason,
      unit_cost: unitCost !== '' ? Number(unitCost) : null,
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Receive stock" subtitle="Products received or added to Bill Store's inventory" className="xl:col-span-2" bodyClassName="p-5">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="space-y-3 sm:col-span-2">
            <ProductCombobox label="Product" required products={products.data ?? []} value={productId} onChange={chooseProduct} error={errors.product} />
            <SelectedProductInfo product={product} />
          </div>
          <Input label="Quantity received" required type="number" min={1} step={1} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} error={errors.qty} />
          <Select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">No supplier / not applicable</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Input label="Supporting document no." placeholder="Delivery receipt, PO or supplier invoice no." maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />
          <Input
            label="Unit cost"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={unitCost}
            onChange={(e) => setCostOverride(e.target.value)}
            error={errors.cost}
            hint={product ? (costOverride === null ? "From the product's purchase price — change it if this delivery cost differs." : `Purchase price on file: ${fmtMoney(product.purchase_price)}`) : 'Filled in from the product\'s purchase price.'}
          />
          <div className="flex flex-col justify-center rounded-xl border border-brand-200 bg-brand-50/70 px-4 py-2.5" data-testid="stock-in-total-cost">
            <span className="text-xs font-medium text-muted">Total cost</span>
            <span className="text-xl font-bold text-brand-900 tabular-nums">{totalCost != null ? fmtMoney(totalCost) : '—'}</span>
            <span className="text-xs text-muted">{totalCost != null ? `${fmtInt(qtyNum)} × ${fmtMoney(costNum)}` : 'Quantity received × unit cost'}</span>
          </div>
          <Textarea label="Remarks" maxLength={500} placeholder="e.g. Weekly delivery" value={reason} onChange={(e) => setReason(e.target.value)} wrapperClassName="sm:col-span-2" />
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" size="lg" loading={m.isPending} icon={<ArrowDownToLine className="size-4" />}>Record Stock-In</Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4">
        {last && <SuccessReceipt movement={last} onDismiss={() => setLast(null)} />}
        <HelpCard
          items={[
            'A unique IN- reference number, the date, time and your name are recorded automatically.',
            'Entries are never edited or deleted. A mistake is corrected with a reversal in Stock Movement History.',
          ]}
        />
      </div>
    </div>
  );
}

function HelpCard({ items }: { items: string[] }) {
  return (
    <Card title="Good to know" bodyClassName="p-5">
      <ul className="list-disc space-y-2 pl-4 text-sm text-muted">
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
    </Card>
  );
}

function StockOutForm() {
  const products = useProductOptions();
  const invalidate = useInvalidateInventory();
  const [productId, setProductId] = useState<number | null>(null);
  const [type, setType] = useState<StockOutType>('damaged');
  const [qty, setQty] = useState('');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [last, setLast] = useState<StockMovement | null>(null);
  const [confirm, setConfirm] = useState(false);
  const product = products.data?.find((p) => p.id === productId);

  const m = useMutation({
    mutationFn: recordStockOut,
    onSuccess: async (row) => {
      setLast(row);
      setConfirm(false);
      toast.success(`Stock-Out ${row.movement_no} recorded: ${fmtSigned(row.quantity_change)} ${row.product_name}`);
      setQty('');
      setRef('');
      setReason('');
      await invalidate();
    },
    onError: (e) => {
      setConfirm(false);
      toast.error(errorMessage(e));
    },
  });

  const validate = () => {
    const errs: Record<string, string> = {};
    const q = positiveInt(qty);
    if (!productId) errs.product = 'Select a product';
    if (!q) errs.qty = 'Enter a whole number greater than zero';
    else if (product && q > product.current_stock) errs.qty = `Only ${fmtInt(product.current_stock)} ${product.unit} available`;
    if (type === 'other_out' && !reason.trim()) errs.reason = 'Please describe the reason';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Release stock" subtitle="Items leaving the store for reasons other than a sale" className="xl:col-span-2" bodyClassName="p-5">
        <form onSubmit={(e) => { e.preventDefault(); if (validate()) setConfirm(true); }} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="space-y-3 sm:col-span-2">
            <ProductCombobox label="Product" required products={products.data ?? []} value={productId} onChange={setProductId} error={errors.product} />
            <SelectedProductInfo product={product} />
          </div>
          <Select label="Stock-out reason" required value={type} onChange={(e) => setType(e.target.value as StockOutType)}>
            {STOCK_OUT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
          <Input label="Quantity released" required type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} error={errors.qty} />
          <Input label="Supporting document no." maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} wrapperClassName="sm:col-span-2" />
          <Textarea label={type === 'other_out' ? 'Remarks (required)' : 'Remarks'} required={type === 'other_out'} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} wrapperClassName="sm:col-span-2" />
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" size="lg" variant="danger" icon={<PackageMinus className="size-4" />}>Record Stock-Out</Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4">
        {last && <SuccessReceipt movement={last} onDismiss={() => setLast(null)} />}
        <HelpCard items={['Stock can never go below zero.', 'Each entry gets a unique OUT- reference number and is shown separately from sales in the stock reports.']} />
      </div>
      <ConfirmDialog
        open={confirm}
        title="Record Stock-Out?"
        message={<>Release <b className="text-ink">{qty} {product?.unit}</b> of <b className="text-ink">{product?.name}</b> — <b>{STOCK_OUT_REASONS.find((r) => r.value === type)?.label}</b>?</>}
        confirmLabel="Record Stock-Out"
        loading={m.isPending}
        onConfirm={() => m.mutate({ product_id: productId!, quantity: Number(qty), movement_type: type, reference_no: ref, reason })}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function AdjustmentForm() {
  // Admins can still correct the stock of inactive products.
  const products = useProductOptions(null, true);
  const invalidate = useInvalidateInventory();
  const [productId, setProductId] = useState<number | null>(null);
  const [mode, setMode] = useState<'count' | 'delta'>('count');
  const [value, setValue] = useState('');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [last, setLast] = useState<StockMovement | null>(null);
  const product = products.data?.find((p) => p.id === productId);

  const preview = useMemo(() => {
    if (!product || value.trim() === '' || !/^-?\d+$/.test(value.trim())) return null;
    const n = Number(value);
    const next = mode === 'count' ? n : product.current_stock + n;
    return { prev: product.current_stock, change: next - product.current_stock, next };
  }, [product, value, mode]);

  const m = useMutation({
    mutationFn: recordAdjustment,
    onSuccess: async (row) => {
      setLast(row);
      setConfirm(false);
      toast.success(`Adjustment recorded for ${row.product_name}`);
      setValue('');
      setReason('');
      setRef('');
      await invalidate();
    },
    onError: (e) => {
      setConfirm(false);
      toast.error(errorMessage(e));
    },
  });

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!productId) errs.product = 'Select a product';
    if (!preview) errs.value = mode === 'count' ? 'Enter the counted quantity (whole number)' : 'Enter a whole number such as 5 or -3';
    else if (preview.next < 0) errs.value = 'The resulting stock cannot be negative';
    else if (preview.change === 0) errs.value = 'This does not change the stock quantity';
    if (!reason.trim()) errs.reason = 'An adjustment reason is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Stock adjustment" subtitle="Authorised correction after a physical count or verified error" className="xl:col-span-2" bodyClassName="p-5">
        <form onSubmit={(e) => { e.preventDefault(); if (validate()) setConfirm(true); }} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="space-y-3 sm:col-span-2">
            <ProductCombobox label="Product" required products={products.data ?? []} value={productId} onChange={setProductId} error={errors.product} />
            <SelectedProductInfo product={product} />
          </div>
          <Select label="Adjustment method" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="count">Set counted quantity</option>
            <option value="delta">Increase / decrease by</option>
          </Select>
          <Input
            label={mode === 'count' ? 'New counted quantity' : 'Adjustment quantity (+/−)'}
            required
            type="number"
            step={1}
            min={mode === 'count' ? 0 : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            error={errors.value}
          />
          {preview && (
            <div className="grid grid-cols-3 gap-2 rounded-xl border border-violet-200 bg-violet-50 p-3 text-center text-sm sm:col-span-2" data-testid="adjustment-preview">
              <div><p className="text-xs text-muted">Previous quantity</p><p className="text-lg font-bold tabular-nums">{fmtInt(preview.prev)}</p></div>
              <div><p className="text-xs text-muted">Adjustment</p><p className="text-lg font-bold text-violet-700 tabular-nums">{fmtSigned(preview.change)}</p></div>
              <div><p className="text-xs text-muted">New quantity</p><p className="text-lg font-bold tabular-nums">{fmtInt(preview.next)}</p></div>
            </div>
          )}
          <Input label="Reference no." maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />
          <Textarea label="Adjustment reason" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} wrapperClassName="sm:col-span-2" />
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" icon={<SlidersHorizontal className="size-4" />}>Record adjustment</Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4">
        {last && <SuccessReceipt movement={last} onDismiss={() => setLast(null)} />}
        <HelpCard items={['Adjustments never overwrite history: the previous quantity, change and new quantity are stored permanently.', 'Only administrators can record adjustments.']} />
      </div>
      <ConfirmDialog
        open={confirm}
        tone="primary"
        title="Record stock adjustment?"
        message={preview && <>Change <b className="text-ink">{product?.name}</b> from <b>{fmtInt(preview.prev)}</b> to <b>{fmtInt(preview.next)}</b> ({fmtSigned(preview.change)})?</>}
        confirmLabel="Record adjustment"
        loading={m.isPending}
        onConfirm={() =>
          m.mutate({ product_id: productId!, reason, reference_no: ref, ...(mode === 'count' ? { new_quantity: Number(value) } : { change: Number(value) }) })
        }
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
