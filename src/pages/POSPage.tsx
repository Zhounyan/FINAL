import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { CheckCircle2, Minus, Plus, Printer, ReceiptText, RotateCcw, ScanBarcode, ShoppingCart, Trash2, X } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { useCategories, useDebounce, useInvalidateInventory, useResettingPage, useSettings } from '@/hooks/data';
import { getSale, logInvoiceAction, posLookupCode, posSearch, recordSale } from '@/lib/api';
import { buildInvoiceDoc } from '@/lib/invoice';
import { printDocument } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { fmtInt, fmtMoney, money2, paymentLabel } from '@/lib/format';
import type { PaymentMethod, PosProduct, Sale } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Badge, Pagination } from '@/components/ui/Display';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Spinner';
import { InvoiceModal } from '@/components/sales/InvoiceModal';

interface CartLine {
  product_id: number;
  name: string;
  sku: string;
  unit: string;
  price: number;
  stock: number;
  quantity: number;
}

const PAGE = 24;
const newRequestId = () => crypto.randomUUID();

function cartKey(userId: string | undefined) {
  return `invportiq.pos.cart.${userId ?? 'anon'}`;
}

/** Restores an unfinished cart after a refresh or a dropped connection. */
function loadCart(userId: string | undefined): CartLine[] {
  try {
    const raw = localStorage.getItem(cartKey(userId));
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    return Array.isArray(parsed) ? parsed.filter((l) => l && Number.isInteger(l.product_id) && l.quantity > 0) : [];
  } catch {
    return [];
  }
}

/** Quick cash buttons: exact amount and the next convenient bills. */
export function quickCashAmounts(total: number): number[] {
  if (total <= 0) return [];
  const out = new Set<number>([money2(total)]);
  for (const step of [20, 50, 100, 500, 1000]) {
    const v = Math.ceil(total / step) * step;
    if (v > total) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

export default function POSPage() {
  const { profile, can } = useAuth();
  const settings = useSettings();
  const categories = useCategories();
  const invalidate = useInvalidateInventory();
  const searchRef = useRef<HTMLInputElement>(null);

  // ----- product search -----------------------------------------------------
  const [term, setTerm] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [sort, setSort] = useState('relevance');
  const debounced = useDebounce(term.trim(), 250);
  const [page, setPage] = useResettingPage(`${debounced}|${categoryId}|${sort}`);
  const products = useQuery({
    queryKey: ['pos', 'search', debounced, categoryId, sort, page],
    queryFn: () => posSearch({ query: debounced, categoryId, sort, page, pageSize: PAGE }),
    placeholderData: keepPreviousData,
  });

  // ----- cart -----------------------------------------------------------------
  const [cart, setCart] = useState<CartLine[]>(() => loadCart(profile?.id));
  useEffect(() => {
    try {
      localStorage.setItem(cartKey(profile?.id), JSON.stringify(cart));
    } catch {
      /* private mode: the cart simply isn't kept after a refresh */
    }
  }, [cart, profile?.id]);

  const addProduct = (p: PosProduct, qty = 1) => {
    if (p.current_stock <= 0) {
      toast.error(`${p.name} is out of stock.`);
      return;
    }
    const existing = cart.find((l) => l.product_id === p.id);
    if (existing) {
      const next = existing.quantity + qty;
      if (next > p.current_stock) {
        toast.error(`Only ${fmtInt(p.current_stock)} ${p.unit} of ${p.name} in stock.`);
        return;
      }
      setCart((c) => c.map((l) => (l.product_id === p.id ? { ...l, quantity: next, stock: p.current_stock, price: Number(p.selling_price) } : l)));
      toast.info(`${p.name} is already in the cart — quantity is now ${next}.`, { id: `qty-${p.id}`, duration: 1800 });
    } else {
      setCart((c) => [
        ...c,
        { product_id: p.id, name: p.name, sku: p.sku, unit: p.unit, price: Number(p.selling_price), stock: p.current_stock, quantity: qty },
      ]);
    }
  };

  const setQty = (id: number, qty: number) => {
    setCart((c) =>
      c.map((l) => {
        if (l.product_id !== id) return l;
        const wanted = Math.floor(Number.isFinite(qty) ? qty : 1);
        if (wanted > l.stock) toast.error(`Only ${fmtInt(l.stock)} ${l.unit} of ${l.name} in stock.`, { id: `max-${id}` });
        return { ...l, quantity: Math.max(1, Math.min(wanted || 1, l.stock)) };
      }),
    );
  };
  const removeLine = (id: number) => setCart((c) => c.filter((l) => l.product_id !== id));

  // ----- payment ---------------------------------------------------------------
  const enabledMethods: PaymentMethod[] = settings.data?.payment_methods?.length ? settings.data.payment_methods : ['cash'];
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [received, setReceived] = useState('');
  const [discountText, setDiscountText] = useState('');
  const [reference, setReference] = useState('');
  const [customer, setCustomer] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const [confirmClear, setConfirmClear] = useState(false);
  const [completed, setCompleted] = useState<Sale | null>(null);
  const [viewInvoice, setViewInvoice] = useState<number | null>(null);

  const subtotal = money2(cart.reduce((a, l) => a + l.price * l.quantity, 0));
  const units = cart.reduce((a, l) => a + l.quantity, 0);
  const maxDiscountPct = can.isAdmin ? 100 : settings.data?.cashier_max_discount_pct ?? 0;
  const maxDiscount = money2((subtotal * maxDiscountPct) / 100);
  const discount = money2(Math.max(0, Number(discountText) || 0));
  const discountError = discount > maxDiscount ? (maxDiscountPct > 0 ? `Discount limit is ${fmtMoney(maxDiscount)} (${maxDiscountPct}%).` : 'Discounts need the Administrator.') : null;
  const total = money2(Math.max(0, subtotal - (discountError ? 0 : discount)));
  const receivedNum = method === 'cash' ? money2(Number(received) || 0) : total;
  const change = money2(receivedNum - total);
  const cashShort = method === 'cash' && receivedNum < total;
  const quick = useMemo(() => quickCashAmounts(total), [total]);

  const problems: string[] = [];
  if (!cart.length) problems.push('Add a product to start a sale.');
  if (discountError) problems.push(discountError);
  if (cart.length && method === 'cash' && !received) problems.push('Enter the amount received.');
  else if (cart.length && cashShort) problems.push(`Amount received is ${fmtMoney(total - receivedNum)} short.`);

  const resetSale = () => {
    setCart([]);
    setReceived('');
    setDiscountText('');
    setReference('');
    setCustomer('');
    setMethod('cash');
    setRequestId(newRequestId());
  };

  const sale = useMutation({
    mutationFn: () =>
      recordSale({
        items: cart.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
        payment_method: method,
        amount_received: method === 'cash' ? receivedNum : null,
        discount,
        customer_name: customer,
        payment_reference: method === 'cash' ? undefined : reference,
        client_request_id: requestId,
      }),
    onSuccess: async (s) => {
      setCompleted(s);
      resetSale();
      void invalidate();
      void products.refetch();
    },
    // The cart, payment and request id are kept, so "Complete Sale" can simply be pressed again.
    onError: (e) => toast.error(errorMessage(e)),
  });

  const complete = () => {
    if (sale.isPending || problems.length) return;
    sale.mutate();
  };

  const printCompleted = async () => {
    if (!completed) return;
    try {
      const { sale: s, items } = await getSale(completed.id);
      await printDocument(buildInvoiceDoc(s, items, settings.data, profile?.full_name));
      await logInvoiceAction(s.id, 'printed');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Barcode scanners type the code and press Enter.
  const onSearchKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = term.trim();
    if (!code) return;
    const found = await posLookupCode(code).catch(() => null);
    if (found) {
      addProduct(found);
      setTerm('');
    } else if (products.data?.rows.length === 1 && debounced === code) {
      addProduct(products.data.rows[0]!);
      setTerm('');
    } else {
      toast.error(`No product found with barcode or code "${code}". Try searching by name.`);
    }
  };

  const rows = products.data?.rows ?? [];
  const inCart = (id: number) => cart.find((l) => l.product_id === id)?.quantity ?? 0;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" data-testid="pos">
      {/* ---------------------------- products ---------------------------- */}
      <section className="min-w-0 space-y-4" aria-label="Products">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <ShoppingCart className="size-7 text-brand-700" /> Point of Sale
          </h1>
          <span className="text-sm text-muted">Cashier: {profile?.full_name}</span>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-3 shadow-card">
          <label htmlFor="pos-search" className="mb-1.5 block text-sm font-semibold text-ink">
            Search Product
          </label>
          <div className="relative">
            <ScanBarcode className="pointer-events-none absolute top-1/2 left-3.5 size-6 -translate-y-1/2 text-muted" />
            <input
              id="pos-search"
              ref={searchRef}
              autoFocus
              autoComplete="off"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Type a product name, SKU or scan a barcode…"
              className="input h-14 pl-12 text-lg"
            />
            {term && (
              <button type="button" onClick={() => setTerm('')} className="absolute top-1/2 right-3 -translate-y-1/2 rounded-lg p-1.5 text-muted hover:bg-brand-50" aria-label="Clear search">
                <X className="size-5" />
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <select className="input h-10 w-auto min-w-44" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)} aria-label="Category">
              <option value="">All categories</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select className="input h-10 w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort products">
              <option value="relevance">Best match</option>
              <option value="name">Name A–Z</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="stock_desc">Most stock</option>
              <option value="newest">Newest</option>
            </select>
            <span className="ml-auto self-center text-sm text-muted">{products.data ? `${fmtInt(products.data.total)} product(s)` : ''}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3" data-testid="pos-results">
          {products.isLoading &&
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          {!products.isLoading && rows.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed border-line p-10 text-center text-muted">
              No products match “{term}”. Check the spelling or try another word.
            </div>
          )}
          {rows.map((p) => {
            const out = p.current_stock <= 0;
            const low = !out && p.current_stock <= p.min_stock_level;
            const qty = inCart(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => addProduct(p)}
                disabled={out}
                aria-label={`Add ${p.name} to cart`}
                className={clsx(
                  'flex items-center gap-3 rounded-2xl border bg-surface p-3 text-left shadow-card transition',
                  out ? 'cursor-not-allowed border-line opacity-60' : 'border-line hover:border-brand-400 hover:bg-brand-50/50 active:scale-[0.99]',
                  qty > 0 && 'ring-2 ring-brand-500',
                )}
              >
                {p.image_url ? (
                  <img src={p.image_url} alt="" className="size-16 shrink-0 rounded-xl object-cover" loading="lazy" />
                ) : (
                  <span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-xl font-bold text-brand-700">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-ink">{p.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {p.sku} · {p.category_name}
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-lg font-bold text-brand-800">{fmtMoney(p.selling_price)}</span>
                    {out ? (
                      <Badge tone="red">Out of stock</Badge>
                    ) : (
                      <span className={clsx('text-xs font-medium', low ? 'text-amber-700' : 'text-muted')}>
                        {fmtInt(p.current_stock)} {p.unit} left
                      </span>
                    )}
                  </span>
                </span>
                {!out && (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-800 text-white" aria-hidden>
                    {qty > 0 ? <span className="text-sm font-bold">{qty}</span> : <Plus className="size-5" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {products.data && products.data.total > PAGE && <Pagination page={page} pageSize={PAGE} total={products.data.total} onChange={setPage} />}
      </section>

      {/* ------------------------------ cart ------------------------------ */}
      <aside className="xl:sticky xl:top-20 xl:self-start" aria-label="Current transaction">
        <div className="flex flex-col rounded-2xl border border-line bg-surface shadow-card">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-lg font-bold text-ink">
              Current Sale <span className="text-sm font-normal text-muted">({fmtInt(units)} item{units === 1 ? '' : 's'})</span>
            </h2>
            {cart.length > 0 && (
              <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} onClick={() => setConfirmClear(true)}>
                Clear
              </Button>
            )}
          </div>

          <ul className="max-h-[38vh] divide-y divide-line overflow-y-auto" data-testid="cart">
            {cart.length === 0 && (
              <li className="px-4 py-10 text-center text-sm text-muted">
                <ShoppingCart className="mx-auto mb-2 size-8 text-brand-300" />
                The cart is empty. Search for a product and tap it to add it.
              </li>
            )}
            {cart.map((l) => (
              <li key={l.product_id} className="px-4 py-3" data-testid="cart-line">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink">{l.name}</p>
                    <p className="text-xs text-muted">
                      {fmtMoney(l.price)} each · {fmtInt(l.stock)} in stock
                    </p>
                  </div>
                  <button type="button" onClick={() => removeLine(l.product_id)} className="rounded-lg p-2 text-muted hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${l.name}`}>
                    <Trash2 className="size-5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setQty(l.product_id, l.quantity - 1)} disabled={l.quantity <= 1} className="flex size-10 items-center justify-center rounded-xl border border-line text-ink hover:bg-brand-50 disabled:opacity-40" aria-label={`Decrease quantity of ${l.name}`}>
                      <Minus className="size-4" />
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={l.stock}
                      value={l.quantity}
                      onChange={(e) => setQty(l.product_id, Number(e.target.value))}
                      className="input h-10 w-16 text-center text-base font-semibold"
                      aria-label={`Quantity of ${l.name}`}
                    />
                    <button type="button" onClick={() => setQty(l.product_id, l.quantity + 1)} disabled={l.quantity >= l.stock} className="flex size-10 items-center justify-center rounded-xl border border-line text-ink hover:bg-brand-50 disabled:opacity-40" aria-label={`Increase quantity of ${l.name}`}>
                      <Plus className="size-4" />
                    </button>
                  </div>
                  <span className="text-base font-bold tabular-nums">{fmtMoney(l.price * l.quantity)}</span>
                </div>
              </li>
            ))}
          </ul>

          <div className="space-y-3 border-t border-line px-4 py-4">
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">Subtotal</span>
                <span className="font-semibold tabular-nums" data-testid="pos-subtotal">{fmtMoney(subtotal)}</span>
              </div>
              {maxDiscountPct > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="pos-discount" className="text-muted">
                    Discount (₱)
                  </label>
                  <input id="pos-discount" type="number" min={0} step="0.01" inputMode="decimal" value={discountText} onChange={(e) => setDiscountText(e.target.value)} className={clsx('input h-9 w-32 text-right', discountError && 'input-invalid')} placeholder="0.00" />
                </div>
              )}
            </div>
            <div className="flex items-end justify-between rounded-xl bg-brand-900 px-4 py-3 text-white">
              <span className="text-sm font-medium text-brand-100">Total Amount</span>
              <span className="text-3xl font-extrabold tabular-nums" data-testid="pos-total">{fmtMoney(total)}</span>
            </div>

            <fieldset>
              <legend className="mb-1.5 text-sm font-semibold text-ink">Payment Method</legend>
              <div className="grid grid-cols-3 gap-2">
                {enabledMethods.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    aria-pressed={method === m}
                    className={clsx(
                      'h-11 rounded-xl border text-sm font-semibold transition',
                      method === m ? 'border-brand-800 bg-brand-800 text-white' : 'border-line bg-white text-ink hover:border-brand-400',
                    )}
                  >
                    {paymentLabel(m)}
                  </button>
                ))}
              </div>
            </fieldset>

            {method === 'cash' ? (
              <div>
                <label htmlFor="pos-received" className="mb-1.5 block text-sm font-semibold text-ink">
                  Amount Received
                </label>
                <input
                  id="pos-received"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && complete()}
                  className={clsx('input h-12 text-right text-xl font-bold', cart.length > 0 && received !== '' && cashShort && 'input-invalid')}
                  placeholder="0.00"
                />
                {quick.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {quick.map((a, i) => (
                      <button key={a} type="button" onClick={() => setReceived(String(a))} className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand-400 hover:bg-brand-50">
                        {i === 0 ? `Exact ${fmtMoney(a)}` : fmtMoney(a)}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between rounded-xl bg-amber-50 px-4 py-2.5">
                  <span className="text-sm font-semibold text-amber-900">Change</span>
                  <span className="text-2xl font-extrabold text-amber-900 tabular-nums" data-testid="pos-change">
                    {fmtMoney(cart.length && received !== '' && !cashShort ? change : 0)}
                  </span>
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="pos-ref" className="mb-1.5 block text-sm font-semibold text-ink">
                  {paymentLabel(method)} reference no. <span className="font-normal text-muted">(optional)</span>
                </label>
                <input id="pos-ref" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} className="input h-11" placeholder="e.g. last 4 digits or ref. no." />
              </div>
            )}

            <div>
              <label htmlFor="pos-customer" className="mb-1.5 block text-sm font-medium text-muted">
                Customer name (optional)
              </label>
              <input id="pos-customer" value={customer} maxLength={120} onChange={(e) => setCustomer(e.target.value)} className="input h-10" placeholder="Walk-in customer" />
            </div>

            {cart.length > 0 && problems.length > 0 && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="status">
                {problems[0]}
              </p>
            )}
            <Button size="xl" className="w-full text-lg" icon={<CheckCircle2 className="size-6" />} loading={sale.isPending} disabled={problems.length > 0 || sale.isPending} onClick={complete}>
              Complete Sale
            </Button>
          </div>
        </div>
      </aside>

      <ConfirmDialog
        open={confirmClear}
        title="Clear the whole sale?"
        message="All products will be removed from the cart. Nothing has been sold yet."
        confirmLabel="Clear sale"
        onConfirm={() => {
          resetSale();
          setConfirmClear(false);
        }}
        onCancel={() => setConfirmClear(false)}
      />

      <Modal
        open={completed != null}
        onClose={() => {
          setCompleted(null);
          searchRef.current?.focus();
        }}
        title="Sale completed"
        size="sm"
        footer={
          <div className="grid w-full gap-2 sm:grid-cols-3">
            <Button variant="outline" icon={<Printer className="size-4" />} onClick={printCompleted}>
              Print Invoice
            </Button>
            <Button variant="outline" icon={<ReceiptText className="size-4" />} onClick={() => setViewInvoice(completed?.id ?? null)}>
              View Invoice
            </Button>
            <Button
              icon={<Plus className="size-4" />}
              onClick={() => {
                setCompleted(null);
                setTimeout(() => searchRef.current?.focus(), 50);
              }}
            >
              New Transaction
            </Button>
          </div>
        }
      >
        {completed && (
          <div className="space-y-3 text-center" data-testid="sale-complete">
            <CheckCircle2 className="mx-auto size-14 text-brand-600" />
            <p className="text-sm text-muted">
              {completed.invoice_no} · {completed.reference_no}
            </p>
            <div className="grid grid-cols-2 gap-2 text-left text-sm">
              <span className="text-muted">Total amount</span>
              <span className="text-right font-bold">{fmtMoney(completed.total_amount)}</span>
              <span className="text-muted">Payment</span>
              <span className="text-right font-semibold">{paymentLabel(completed.payment_method)}</span>
              {completed.payment_method === 'cash' && (
                <>
                  <span className="text-muted">Amount received</span>
                  <span className="text-right font-semibold">{fmtMoney(completed.amount_received)}</span>
                </>
              )}
            </div>
            {completed.payment_method === 'cash' && (
              <div className="rounded-xl bg-amber-50 py-3">
                <p className="text-sm font-semibold text-amber-900">Give change</p>
                <p className="text-4xl font-extrabold text-amber-900" data-testid="sale-change">
                  {fmtMoney(completed.change_amount)}
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <InvoiceModal saleId={viewInvoice} onClose={() => setViewInvoice(null)} />

      {/* phone: total always visible */}
      {cart.length > 0 && (
        <div className="fixed inset-x-3 bottom-3 z-20 flex items-center justify-between rounded-2xl bg-brand-900 px-4 py-3 text-white shadow-pop xl:hidden">
          <span className="text-sm">
            {fmtInt(units)} item(s) · <b className="text-lg">{fmtMoney(total)}</b>
          </span>
          <a href="#pos-received" className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-brand-900" onClick={(e) => { e.preventDefault(); document.getElementById(method === 'cash' ? 'pos-received' : 'pos-ref')?.focus(); }}>
            Pay now
          </a>
        </div>
      )}
    </div>
  );
}
