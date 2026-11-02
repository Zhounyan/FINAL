import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownToLine, Boxes, ClipboardList, Minus, PackageMinus, Plus, Receipt, ShoppingCart, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  listProducts,
  listSales,
  PAGE_SIZE,
  recordAdjustment,
  recordSale,
  recordStockIn,
  recordStockOut,
  saleItems,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt, fmtMoney, fmtSigned } from '@/lib/format';
import type { ProductRow, Sale, StockMovement, StockStatus } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useCustomerOptions, useDebounce, useInvalidateInventory, useProductOptions, useSupplierOptions, useResettingPage } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, StatCard, TableWrap, Tabs } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ProductCombobox } from '@/components/stock/ProductCombobox';
import { MovementTypeBadge } from '@/components/stock/MovementViews';

type TabId = 'inventory' | 'stock_in' | 'sale' | 'stock_out' | 'adjustment' | 'sales';

export default function StockPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = (params.get('tab') as TabId) ?? (can.recordStockIn ? 'stock_in' : 'inventory');
  const allowed: Record<TabId, boolean> = {
    inventory: true,
    stock_in: can.recordStockIn,
    sale: can.recordSale,
    stock_out: can.recordStockOut,
    adjustment: can.recordAdjustment,
    sales: true,
  };
  const tab: TabId = allowed[requested] ? requested : 'inventory';

  return (
    <div className="space-y-6">
      <PageHeader icon={<Boxes className="size-5" />} title="Stock Management" description="Record stock received, sales, releases and corrections. Every operation is written to the stock movement ledger." />
      <Tabs<TabId>
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: 'stock_in', label: 'Stock In', icon: <ArrowDownToLine className="size-4" />, hidden: !allowed.stock_in },
          { id: 'sale', label: 'Record Sale', icon: <ShoppingCart className="size-4" />, hidden: !allowed.sale },
          { id: 'stock_out', label: 'Stock Out', icon: <PackageMinus className="size-4" />, hidden: !allowed.stock_out },
          { id: 'adjustment', label: 'Adjustment', icon: <SlidersHorizontal className="size-4" />, hidden: !allowed.adjustment },
          { id: 'inventory', label: 'Current Stock', icon: <ClipboardList className="size-4" /> },
          { id: 'sales', label: 'Sales History', icon: <Receipt className="size-4" /> },
        ]}
      />
      {tab === 'inventory' && <InventoryPanel />}
      {tab === 'stock_in' && <StockInForm />}
      {tab === 'sale' && <SaleForm />}
      {tab === 'stock_out' && <StockOutForm />}
      {tab === 'adjustment' && <AdjustmentForm />}
      {tab === 'sales' && <SalesHistory />}
    </div>
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
        Stock changed from <b>{fmtInt(movement.quantity_before)}</b> to <b>{fmtInt(movement.quantity_after)}</b> · Movement #{movement.id} · {fmtDateTime(movement.occurred_at)}
      </p>
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
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [last, setLast] = useState<StockMovement | null>(null);
  const product = products.data?.find((p) => p.id === productId);

  const m = useMutation({
    mutationFn: recordStockIn,
    onSuccess: async (row) => {
      setLast(row);
      toast.success(`Stock in recorded: +${fmtInt(row.quantity_change)} ${row.product_name}`);
      setQty('');
      setRef('');
      setReason('');
      setUnitCost('');
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
    if (unitCost && (Number.isNaN(Number(unitCost)) || Number(unitCost) < 0)) errs.cost = 'Enter a valid cost';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    m.mutate({
      product_id: productId!,
      quantity: q!,
      supplier_id: supplierId ? Number(supplierId) : null,
      reference_no: ref,
      reason,
      unit_cost: unitCost ? Number(unitCost) : null,
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Receive stock" subtitle="Products received or added to Bill Store's inventory" className="xl:col-span-2" bodyClassName="p-5">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="space-y-3 sm:col-span-2">
            <ProductCombobox label="Product" required products={products.data ?? []} value={productId} onChange={setProductId} error={errors.product} />
            <SelectedProductInfo product={product} />
          </div>
          <Input label="Quantity received" required type="number" min={1} step={1} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} error={errors.qty} />
          <Select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">No supplier / not applicable</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Input label="Reference no." placeholder="Delivery receipt, PO, invoice…" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />
          <Input label="Unit cost" type="number" min={0} step="0.01" placeholder={product ? String(product.purchase_price) : ''} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} error={errors.cost} />
          <Textarea label="Reason / description" maxLength={500} placeholder="e.g. Weekly delivery" value={reason} onChange={(e) => setReason(e.target.value)} wrapperClassName="sm:col-span-2" />
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" loading={m.isPending} icon={<ArrowDownToLine className="size-4" />}>Record stock in</Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4">
        {last && <SuccessReceipt movement={last} onDismiss={() => setLast(null)} />}
        <HelpCard
          items={[
            'Date, time and the responsible user are recorded automatically by the server.',
            'Stock-in entries can be reversed by an administrator if recorded in error — they are never edited or deleted.',
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

interface CartLine {
  product: ProductRow;
  quantity: number;
}

function SaleForm() {
  const products = useProductOptions();
  const customers = useCustomerOptions();
  const invalidate = useInvalidateInventory();
  const [pick, setPick] = useState<number | null>(null);
  const [cartState, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [ref, setRef] = useState('');
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [lastSale, setLastSale] = useState<Sale | null>(null);

  // always show the latest stock levels for items in the cart
  const cart = cartState.map((l) => ({ ...l, product: products.data?.find((p) => p.id === l.product.id) ?? l.product }));

  const add = (id: number | null) => {
    setPick(null);
    const p = products.data?.find((x) => x.id === id);
    if (!p) return;
    if (p.current_stock <= 0) {
      toast.error(`"${p.name}" is out of stock.`);
      return;
    }
    setCart((c) => (c.some((l) => l.product.id === p.id) ? c.map((l) => (l.product.id === p.id ? { ...l, quantity: Math.min(l.quantity + 1, p.current_stock) } : l)) : [...c, { product: p, quantity: 1 }]));
  };
  const setQty = (id: number, q: number) => setCart((c) => c.map((l) => (l.product.id === id ? { ...l, quantity: Math.max(1, Math.min(q || 1, l.product.current_stock)) } : l)));
  const total = cart.reduce((a, l) => a + l.quantity * Number(l.product.selling_price), 0);
  const units = cart.reduce((a, l) => a + l.quantity, 0);
  const over = cart.filter((l) => l.quantity > l.product.current_stock);

  const m = useMutation({
    mutationFn: () =>
      recordSale({
        items: cart.map((l) => ({ product_id: l.product.id, quantity: l.quantity })),
        customer_id: customerId ? Number(customerId) : null,
        reference_no: ref,
        notes,
        client_request_id: requestId,
      }),
    onSuccess: async (sale) => {
      toast.success(`Sale ${sale.reference_no} recorded · ${fmtMoney(sale.total_amount)}`);
      setLastSale(sale);
      setCart([]);
      setRef('');
      setNotes('');
      setCustomerId('');
      setConfirm(false);
      setRequestId(crypto.randomUUID()); // next sale gets a new idempotency key
      await invalidate();
    },
    onError: (e) => {
      setConfirm(false);
      toast.error(errorMessage(e));
      void products.refetch();
    },
  });

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="New sale" subtitle="Sales automatically create the matching Stock Out (sold) movements" className="xl:col-span-2" bodyClassName="p-5 space-y-4">
        <ProductCombobox label="Add product" products={(products.data ?? []).filter((p) => p.current_stock > 0)} value={pick} onChange={add} placeholder="Search a product to add…" />
        {cart.length === 0 ? (
          <EmptyState icon={<ShoppingCart className="size-6" />} title="No items yet" message="Search and select products to add them to this sale." />
        ) : (
          <TableWrap className="rounded-xl border border-line">
            <table className="table-base" data-testid="sale-cart">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Available</th>
                  <th className="text-center">Quantity</th>
                  <th className="num">Price</th>
                  <th className="num">Line total</th>
                  <th><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {cart.map((l) => (
                  <tr key={l.product.id}>
                    <td><span className="font-medium">{l.product.name}</span><span className="block text-xs text-muted">{l.product.sku}</span></td>
                    <td className="num text-muted">{fmtInt(l.product.current_stock)}</td>
                    <td>
                      <div className="mx-auto flex w-32 items-center gap-1">
                        <Button variant="outline" size="icon" className="size-8" onClick={() => setQty(l.product.id, l.quantity - 1)} aria-label="Decrease quantity"><Minus className="size-3" /></Button>
                        <input className="input h-8 px-1 text-center tabular-nums" type="number" min={1} max={l.product.current_stock} value={l.quantity} onChange={(e) => setQty(l.product.id, Number(e.target.value))} aria-label={`Quantity of ${l.product.name}`} />
                        <Button variant="outline" size="icon" className="size-8" onClick={() => setQty(l.product.id, l.quantity + 1)} aria-label="Increase quantity"><Plus className="size-3" /></Button>
                      </div>
                    </td>
                    <td className="num">{fmtMoney(l.product.selling_price)}</td>
                    <td className="num font-semibold">{fmtMoney(l.quantity * Number(l.product.selling_price))}</td>
                    <td className="text-right">
                      <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setCart((c) => c.filter((x) => x.product.id !== l.product.id))} aria-label={`Remove ${l.product.name}`}><Trash2 className="size-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total ({fmtInt(units)} units)</td>
                  <td colSpan={3} className="num text-base">{fmtMoney(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Walk-in customer</option>
            {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </Select>
          <Input label="Reference / receipt no." placeholder="Auto-generated if blank" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />
          <Textarea label="Notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} wrapperClassName="sm:col-span-2" />
        </div>
        <div className="flex justify-end">
          <Button disabled={!cart.length || over.length > 0} onClick={() => setConfirm(true)} icon={<ShoppingCart className="size-4" />}>
            Complete sale · {fmtMoney(total)}
          </Button>
        </div>
      </Card>
      <div className="space-y-4">
        {lastSale && (
          <div className="animate-pop-in rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
            <p className="font-semibold">Sale {lastSale.reference_no} recorded</p>
            <p className="mt-1">{fmtInt(lastSale.total_quantity)} units · {fmtMoney(lastSale.total_amount)} · {fmtDateTime(lastSale.sold_at)}</p>
          </div>
        )}
        <HelpCard
          items={[
            'Prices come from each product record; the server recalculates the total.',
            'The sale and every stock deduction are saved in one transaction — if any item is short, nothing is recorded.',
            'Double-clicking or retrying never records the same sale twice.',
          ]}
        />
      </div>
      <ConfirmDialog
        open={confirm}
        tone="primary"
        title="Complete this sale?"
        message={<>Record a sale of <b className="text-ink">{fmtInt(units)} units</b> totalling <b className="text-ink">{fmtMoney(total)}</b>? Stock will be deducted immediately.</>}
        confirmLabel="Record sale"
        loading={m.isPending}
        onConfirm={() => m.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function StockOutForm() {
  const products = useProductOptions();
  const customers = useCustomerOptions();
  const invalidate = useInvalidateInventory();
  const [productId, setProductId] = useState<number | null>(null);
  const [type, setType] = useState<'damaged' | 'lost' | 'other_out'>('damaged');
  const [qty, setQty] = useState('');
  const [customerId, setCustomerId] = useState('');
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
      toast.success(`Stock out recorded: ${fmtSigned(row.quantity_change)} ${row.product_name}`);
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
    if (!reason.trim()) errs.reason = 'A reason is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Release stock" subtitle="Damaged, lost or other authorised releases. Use Record Sale for products sold." className="xl:col-span-2" bodyClassName="p-5">
        <form onSubmit={(e) => { e.preventDefault(); if (validate()) setConfirm(true); }} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="space-y-3 sm:col-span-2">
            <ProductCombobox label="Product" required products={products.data ?? []} value={productId} onChange={setProductId} error={errors.product} />
            <SelectedProductInfo product={product} />
          </div>
          <Select label="Stock-out type" required value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="damaged">Damaged stock</option>
            <option value="lost">Lost / missing stock</option>
            <option value="other_out">Other stock out</option>
          </Select>
          <Input label="Quantity released" required type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} error={errors.qty} />
          <Select label="Customer (if applicable)" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Not applicable</option>
            {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </Select>
          <Input label="Reference no." maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />
          <Textarea label="Reason / description" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} wrapperClassName="sm:col-span-2" />
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" variant="danger" icon={<PackageMinus className="size-4" />}>Record stock out</Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4">
        {last && <SuccessReceipt movement={last} onDismiss={() => setLast(null)} />}
        <HelpCard items={['Stock can never go below zero.', 'Damaged, lost and other releases appear as “Other Stock Out” in daily summaries.']} />
      </div>
      <ConfirmDialog
        open={confirm}
        title="Record stock out?"
        message={<>Release <b className="text-ink">{qty} {product?.unit}</b> of <b className="text-ink">{product?.name}</b> as <b>{type === 'other_out' ? 'other stock out' : type}</b>?</>}
        confirmLabel="Record stock out"
        loading={m.isPending}
        onConfirm={() =>
          m.mutate({ product_id: productId!, quantity: Number(qty), movement_type: type, customer_id: customerId ? Number(customerId) : null, reference_no: ref, reason })
        }
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function AdjustmentForm() {
  const products = useProductOptions();
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

function InventoryPanel() {
  const [status, setStatus] = useState<'all' | StockStatus>('all');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([status, debounced]);
  const q = useQuery({
    queryKey: ['products', 'inventory', status, debounced, page],
    queryFn: () => listProducts({ status, search: debounced, page }),
    placeholderData: (p) => p,
  });
  const counts = useQuery({
    queryKey: ['products', 'inventory-counts'],
    queryFn: async () => {
      const [low, out, all] = await Promise.all([
        listProducts({ status: 'low', page: 1, pageSize: 1 }),
        listProducts({ status: 'out', page: 1, pageSize: 1 }),
        listProducts({ page: 1, pageSize: 1 }),
      ]);
      return { low: low.total, out: out.total, all: all.total };
    },
  });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <button type="button" onClick={() => setStatus('all')} className="text-left"><StatCard label="Active products" value={fmtInt(counts.data?.all ?? 0)} icon={<Boxes className="size-4" />} className={status === 'all' ? 'ring-2 ring-brand-400' : ''} /></button>
        <button type="button" onClick={() => setStatus('low')} className="text-left"><StatCard label="Low stock alerts" value={fmtInt(counts.data?.low ?? 0)} tone="amber" icon={<PackageMinus className="size-4" />} className={status === 'low' ? 'ring-2 ring-amber-400' : ''} /></button>
        <button type="button" onClick={() => setStatus('out')} className="text-left"><StatCard label="Out-of-stock alerts" value={fmtInt(counts.data?.out ?? 0)} tone="red" icon={<PackageMinus className="size-4" />} className={status === 'out' ? 'ring-2 ring-red-400' : ''} /></button>
      </div>
      <Card title="Current stock levels" actions={<SearchInput value={search} onChange={setSearch} className="w-64" placeholder="Search products…" />}>
        {q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock />
        ) : !q.data?.rows.length ? (
          <EmptyState title="No products match" />
        ) : (
          <TableWrap>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th className="num">On hand</th>
                  <th className="num">Minimum</th>
                  <th>Level</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((p) => {
                  const pct = Math.min(100, p.min_stock_level > 0 ? (p.current_stock / (p.min_stock_level * 2)) * 100 : p.current_stock > 0 ? 100 : 0);
                  return (
                    <tr key={p.id}>
                      <td><span className="font-medium">{p.name}</span><span className="block text-xs text-muted">{p.sku}</span></td>
                      <td>{p.category_name}</td>
                      <td className="num font-semibold">{fmtInt(p.current_stock)} <span className="text-xs font-normal text-muted">{p.unit}</span></td>
                      <td className="num text-muted">{fmtInt(p.min_stock_level)}</td>
                      <td className="w-40">
                        <div className="h-2 rounded-full bg-slate-100" title={`${p.current_stock} of target ${p.min_stock_level * 2}`}>
                          <div className={`h-2 rounded-full ${p.stock_status === 'out' ? 'bg-red-500' : p.stock_status === 'low' ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td>{p.stock_status === 'out' ? <Badge tone="red">Out of stock</Badge> : p.stock_status === 'low' ? <Badge tone="amber">Low stock</Badge> : <Badge tone="green">In stock</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      </Card>
    </div>
  );
}

function SalesHistory() {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Sale | null>(null);
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([debounced]);
  const q = useQuery({ queryKey: ['sales', 'list', debounced, page], queryFn: () => listSales({ page, search: debounced }), placeholderData: (p) => p });
  const items = useQuery({ queryKey: ['sales', 'items', open?.id], queryFn: () => saleItems(open!.id), enabled: Boolean(open) });
  return (
    <Card title="Sales history" subtitle="Each sale is linked to its Stock Sold movements" actions={<SearchInput value={search} onChange={setSearch} className="w-64" placeholder="Search reference or customer…" />}>
      {q.isError ? (
        <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <LoadingBlock />
      ) : !q.data?.rows.length ? (
        <EmptyState icon={<Receipt className="size-6" />} title="No sales recorded" />
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Date</th>
                <th>Customer</th>
                <th className="num">Items</th>
                <th className="num">Units</th>
                <th className="num">Total</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((s) => (
                <tr key={s.id} className="cursor-pointer" onClick={() => setOpen(s)}>
                  <td className="font-medium text-brand-800">{s.reference_no}</td>
                  <td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(s.sold_at)}</td>
                  <td>{s.customer_name ?? <span className="text-muted">Walk-in</span>}</td>
                  <td className="num">{fmtInt(s.item_count)}</td>
                  <td className="num">{fmtInt(s.total_quantity)}</td>
                  <td className="num font-semibold">{fmtMoney(s.total_amount)}</td>
                  <td className="text-xs">{s.created_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} size="lg" title={`Sale ${open?.reference_no ?? ''}`} description={open ? `${fmtDateTime(open.sold_at)} · ${open.customer_name ?? 'Walk-in customer'} · by ${open.created_by_name}` : ''}>
        {items.isLoading ? (
          <LoadingBlock rows={3} />
        ) : (
          <TableWrap className="rounded-xl border border-line">
            <table className="table-base">
              <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Total</th></tr></thead>
              <tbody>
                {items.data?.map((i) => (
                  <tr key={i.id}><td>{i.product_name}<span className="block text-xs text-muted">{i.product_sku}</span></td><td className="num">{fmtInt(i.quantity)}</td><td className="num">{fmtMoney(i.unit_price)}</td><td className="num">{fmtMoney(i.line_total)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Total</td><td className="num">{fmtMoney(open?.total_amount)}</td></tr></tfoot>
            </table>
          </TableWrap>
        )}
        {open?.notes && <p className="mt-3 text-sm text-muted">Notes: {open.notes}</p>}
      </Modal>
    </Card>
  );
}
