import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import { ArrowDownToLine, ArrowUpFromLine, ClipboardList, RotateCcw, ShoppingCart, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useProductOptions, useResettingPage, useSettings, useStoreToday } from '@/hooks/data';
import { listMovements, PAGE_SIZE, stockReport } from '@/lib/api';
import type { DocModel } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt, fmtSigned, MOVEMENT_LABELS } from '@/lib/format';
import type { MovementType, StockMovement, StockReport } from '@/lib/types';
import { Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, StatCard, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ProductCombobox } from '@/components/stock/ProductCombobox';
import { MovementTypeBadge } from '@/components/stock/MovementViews';
import { ReportToolbar, useReportRange } from '@/components/reports/ReportToolbar';

type Period = 'daily' | 'weekly' | 'monthly';
const TITLES: Record<Period, string> = {
  daily: 'Daily Stock Management Report',
  weekly: 'Weekly Stock Management Report',
  monthly: 'Monthly Stock Management Report',
};

export const TYPE_FILTERS: { value: string; label: string; types: MovementType[] }[] = [
  { value: '', label: 'All movement types', types: [] },
  { value: 'stock_in', label: 'Stock-In', types: ['stock_in'] },
  { value: 'stock_out', label: 'Stock-Out (all reasons)', types: ['damaged', 'expired', 'lost', 'internal_use', 'other_out'] },
  { value: 'sale', label: 'Sales deductions', types: ['sale'] },
  { value: 'sale_void', label: 'Voided-sale returns', types: ['sale_void'] },
  { value: 'adjustment', label: 'Authorized adjustments', types: ['adjustment'] },
];

export default function StockReportPage({ period }: { period: Period }) {
  const today = useStoreToday();
  return <StockReportView key={period} period={period} today={today} />;
}

function StockReportView({ period, today }: { period: Period; today: string }) {
  const { profile } = useAuth();
  const settings = useSettings();
  const state = useReportRange(period, today);
  const { range } = state;
  const products = useProductOptions(null, true);
  const [productId, setProductId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const types = TYPE_FILTERS.find((t) => t.value === typeFilter)?.types ?? [];

  const report = useQuery({
    queryKey: ['reports', 'stock', range.from, range.to, productId, typeFilter],
    queryFn: () => stockReport({ from: range.from, to: range.to, productId, types }),
  });

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'quantity'>('newest');
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([range.from, range.to, productId, typeFilter, debounced, sort]);
  const history = useQuery({
    queryKey: ['movements', 'report-history', range.from, range.to, productId, typeFilter, debounced, sort, page],
    queryFn: () =>
      listMovements({ from: range.from, to: range.to, productId, types: types.length ? types : historyTypes, search: debounced, sort, page }),
    placeholderData: (p) => p,
  });

  const r = report.data;
  const build = async (): Promise<DocModel> => {
    const data = r ?? (await stockReport({ from: range.from, to: range.to, productId, types }));
    const all = await listMovements({ from: range.from, to: range.to, productId, types: types.length ? types : historyTypes, search: debounced, sort: 'oldest', page: 1, pageSize: 5000 });
    const productName = productId ? products.data?.find((p) => p.id === productId)?.name : undefined;
    const filters = [productName ? `Product: ${productName}` : '', typeFilter ? `Type: ${TYPE_FILTERS.find((t) => t.value === typeFilter)?.label}` : ''].filter(Boolean).join(' · ');
    return stockReportDoc(TITLES[period], `${range.label}${filters ? ` · ${filters}` : ''}`, data, all.rows, settings.data?.store_name ?? 'Bill Store', settings.data?.store_address, profile?.full_name);
  };

  const chart = (r?.by_day ?? []).map((d) => ({
    label: format(parseISO(d.day), period === 'weekly' && !range.custom ? 'EEE d' : 'MMM d'),
    'Stock-In': Number(d.stock_in),
    'Stock-Out': Number(d.stock_out),
    Sold: Number(d.sold),
  }));

  return (
    <div className="space-y-6">
      <PageHeader icon={<ClipboardList className="size-5" />} title={TITLES[period]} description="Stock-In, Stock-Out and sales deductions are always counted separately, straight from the stock movement ledger." />
      <ReportToolbar state={state} today={today} build={build} disabled={!r} />
      <div className="grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:grid-cols-2">
        <ProductCombobox products={products.data ?? []} value={productId} onChange={setProductId} label="Product" allowAll showStock={false} />
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          Movement type
          <select className="input h-10" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Movement type">
            {TYPE_FILTERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {report.isError ? (
        <ErrorState error={errorMessage(report.error)} onRetry={() => report.refetch()} />
      ) : report.isLoading || !r ? (
        <LoadingBlock rows={6} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="stock-report-cards">
            <StatCard label="Stock-In quantity" value={fmtInt(r.totals.stock_in_qty)} hint={`${fmtInt(r.totals.stock_in_count)} stock-in transaction(s)`} icon={<ArrowDownToLine className="size-4" />} tone="green" />
            <StatCard label="Stock-Out quantity" value={fmtInt(r.totals.stock_out_qty)} hint={`${fmtInt(r.totals.stock_out_count)} stock-out transaction(s)`} icon={<ArrowUpFromLine className="size-4" />} tone="red" />
            <StatCard label="Sales deductions" value={fmtInt(r.totals.sales_qty)} hint={`${fmtInt(r.totals.sales_count)} sale line(s)`} icon={<ShoppingCart className="size-4" />} tone="blue" />
            <StatCard label="Voided-sale returns" value={fmtInt(r.totals.returned_qty)} hint={`${fmtInt(r.totals.returned_count)} entr(ies)`} icon={<RotateCcw className="size-4" />} tone="slate" />
            <StatCard label="Adjustments (net)" value={fmtSigned(r.totals.adjustment_net)} hint={`${fmtInt(r.totals.adjustment_count)} adjustment(s)`} icon={<SlidersHorizontal className="size-4" />} tone="violet" />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title={period === 'weekly' ? 'Daily stock movement comparison' : period === 'monthly' ? 'Daily stock movements this month' : 'Stock movement summary'}>
              <div className="h-64 p-4">
                <ResponsiveContainer>
                  <BarChart data={chart}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e3e5dc" />
                    <XAxis dataKey="label" fontSize={11} tickLine={false} />
                    <YAxis fontSize={11} tickLine={false} width={40} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Stock-In" fill="#2f7a4a" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Stock-Out" fill="#c2410c" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Sold" fill="#0369a1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            {period === 'monthly' ? (
              <Card title="Monthly stock movement trend" subtitle="Last 12 months">
                <div className="h-64 p-4">
                  <ResponsiveContainer>
                    <BarChart data={r.monthly_trend.map((m) => ({ label: format(parseISO(m.month), 'MMM yy'), 'Stock-In': Number(m.stock_in), 'Stock-Out': Number(m.stock_out), Sold: Number(m.sold) }))}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e3e5dc" />
                      <XAxis dataKey="label" fontSize={11} tickLine={false} />
                      <YAxis fontSize={11} tickLine={false} width={40} allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="Stock-In" fill="#2f7a4a" />
                      <Bar dataKey="Stock-Out" fill="#c2410c" />
                      <Bar dataKey="Sold" fill="#0369a1" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            ) : (
              <UsersCard r={r} />
            )}
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Products received">
              {!r.products_received.length ? (
                <EmptyState title="No stock received in this period" />
              ) : (
                <TableWrap>
                  <table className="table-base" data-testid="products-received">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th className="num">Quantity</th>
                        <th className="num">Entries</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.products_received.map((p) => (
                        <tr key={p.product_id}>
                          <td>
                            <span className="font-medium">{p.product_name}</span>
                            <span className="block text-xs text-muted">{p.product_sku}</span>
                          </td>
                          <td className="num font-semibold text-emerald-700">+{fmtInt(p.quantity)}</td>
                          <td className="num">{fmtInt(p.entries)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
            <Card title="Products released (stock-out)">
              {!r.products_released.length ? (
                <EmptyState title="No stock-out in this period" />
              ) : (
                <TableWrap>
                  <table className="table-base" data-testid="products-released">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Reason</th>
                        <th className="num">Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.products_released.map((p) => (
                        <tr key={`${p.product_id}-${p.reason}`}>
                          <td>
                            <span className="font-medium">{p.product_name}</span>
                            <span className="block text-xs text-muted">{p.product_sku}</span>
                          </td>
                          <td>
                            <MovementTypeBadge type={p.reason} />
                          </td>
                          <td className="num font-semibold text-red-700">-{fmtInt(p.quantity)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>
          {period === 'monthly' && <UsersCard r={r} />}
        </>
      )}

      <Card title="Stock movement history">
        <div className="flex flex-wrap gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} className="max-w-sm flex-1" placeholder="Search product, reference no., user…" />
          <select className="input h-10 w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort movements">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="quantity">Largest quantity</option>
          </select>
        </div>
        {history.isLoading ? <LoadingBlock /> : <HistoryTable rows={history.data?.rows ?? []} />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={history.data?.total ?? 0} onChange={setPage} />
      </Card>
    </div>
  );
}

/** Category transfers are internal bookkeeping (net zero) and are left out of the history. */
const historyTypes: MovementType[] = ['stock_in', 'sale', 'sale_void', 'damaged', 'expired', 'lost', 'internal_use', 'other_out', 'adjustment'];

export function HistoryTable({ rows, onReverse }: { rows: StockMovement[]; onReverse?: (m: StockMovement) => void }) {
  if (!rows.length) return <EmptyState title="No stock movements" message="Nothing matches these filters." />;
  return (
    <TableWrap>
      <table className="table-base table-compact" data-testid="movement-history">
        <thead>
          <tr>
            <th>Movement ID</th>
            <th>Date &amp; time</th>
            <th>Product</th>
            <th>Type</th>
            <th className="num">Previous</th>
            <th className="num">Added</th>
            <th className="num">Deducted</th>
            <th className="num">New</th>
            <th>Reference</th>
            <th>User</th>
            <th>Remarks</th>
            {onReverse && <th><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="font-mono text-xs font-semibold whitespace-nowrap">{m.movement_no}</td>
              <td className="whitespace-nowrap">{fmtDateTime(m.occurred_at)}</td>
              <td>
                <span className="font-medium">{m.product_name}</span>
                <span className="block text-[11px] text-muted">{m.product_sku}</span>
              </td>
              <td>
                <MovementTypeBadge type={m.movement_type} />
              </td>
              <td className="num">{fmtInt(m.quantity_before)}</td>
              <td className="num text-emerald-700">{m.quantity_change > 0 ? `+${fmtInt(m.quantity_change)}` : '—'}</td>
              <td className="num text-red-700">{m.quantity_change < 0 ? `-${fmtInt(-m.quantity_change)}` : '—'}</td>
              <td className="num font-semibold">{fmtInt(m.quantity_after)}</td>
              <td className="text-xs whitespace-nowrap">{m.reference_no ?? '—'}</td>
              <td className="whitespace-nowrap">{m.created_by_name}</td>
              <td className="max-w-56 text-xs text-muted">
                {m.reason ?? '—'}
                {m.reversed_by_id && <span className="mt-0.5 block text-[11px] font-medium text-red-600">Reversed</span>}
              </td>
              {onReverse && (
                <td className="text-right">
                  {['stock_in', 'damaged', 'expired', 'lost', 'internal_use', 'other_out', 'adjustment'].includes(m.movement_type) && !m.reverses_movement_id && !m.reversed_by_id && (
                    <button type="button" onClick={() => onReverse(m)} className="rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
                      Reverse
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function UsersCard({ r }: { r: StockReport }) {
  return (
    <Card title="Responsible users">
      {!r.by_user.length ? (
        <EmptyState title="No movements" />
      ) : (
        <TableWrap>
          <table className="table-base" data-testid="by-user">
            <thead>
              <tr>
                <th>User</th>
                <th className="num">Movements</th>
                <th className="num">Stock-In</th>
                <th className="num">Stock-Out</th>
                <th className="num">Sold</th>
              </tr>
            </thead>
            <tbody>
              {r.by_user.map((u) => (
                <tr key={u.user_name}>
                  <td className="font-medium">{u.user_name}</td>
                  <td className="num">{fmtInt(u.movements)}</td>
                  <td className="num">{fmtInt(u.stock_in)}</td>
                  <td className="num">{fmtInt(u.stock_out)}</td>
                  <td className="num">{fmtInt(u.sold)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

export function stockReportDoc(
  title: string,
  subtitle: string,
  r: StockReport,
  movements: StockMovement[],
  storeName: string,
  storeAddress: string | undefined,
  generatedBy: string | undefined,
): DocModel {
  return {
    title,
    subtitle: `Period: ${subtitle}`,
    storeName,
    storeLines: [storeAddress ?? ''],
    generatedBy,
    landscape: true,
    fileName: `${title}-${r.from}${r.from !== r.to ? `-to-${r.to}` : ''}`,
    sections: [
      {
        kind: 'kv',
        heading: 'Summary',
        rows: [
          ['Total Stock-In quantity', fmtInt(r.totals.stock_in_qty)],
          ['Number of Stock-In transactions', fmtInt(r.totals.stock_in_count)],
          ['Total Stock-Out quantity', fmtInt(r.totals.stock_out_qty)],
          ['Number of Stock-Out transactions', fmtInt(r.totals.stock_out_count)],
          ['Sales deductions (quantity)', fmtInt(r.totals.sales_qty)],
          ['Voided-sale returns (quantity)', fmtInt(r.totals.returned_qty)],
          ['Authorized adjustments (net)', fmtSigned(r.totals.adjustment_net)],
          ['Total stock movements', fmtInt(r.totals.movements)],
        ],
      },
      {
        kind: 'table',
        heading: 'Daily stock movement summary',
        columns: [{ header: 'Date' }, { header: 'Stock-In', align: 'right' }, { header: 'Stock-Out', align: 'right' }, { header: 'Sold', align: 'right' }, { header: 'Returned', align: 'right' }, { header: 'Adjustments', align: 'right' }, { header: 'Movements', align: 'right' }],
        rows: r.by_day.map((d) => [format(parseISO(d.day), 'EEE, MMM d, yyyy'), fmtInt(d.stock_in), fmtInt(d.stock_out), fmtInt(d.sold), fmtInt(d.returned), fmtSigned(d.adjustments), fmtInt(d.movements)]),
        footer: ['Total', fmtInt(r.totals.stock_in_qty), fmtInt(r.totals.stock_out_qty), fmtInt(r.totals.sales_qty), fmtInt(r.totals.returned_qty), fmtSigned(r.totals.adjustment_net), fmtInt(r.totals.movements)],
      },
      {
        kind: 'table',
        heading: 'Products received',
        columns: [{ header: 'Product' }, { header: 'SKU' }, { header: 'Quantity', align: 'right' }, { header: 'Entries', align: 'right' }],
        rows: r.products_received.map((p) => [p.product_name, p.product_sku, fmtInt(p.quantity), fmtInt(p.entries)]),
        emptyText: 'No stock received in this period.',
      },
      {
        kind: 'table',
        heading: 'Products released (stock-out)',
        columns: [{ header: 'Product' }, { header: 'SKU' }, { header: 'Reason' }, { header: 'Quantity', align: 'right' }],
        rows: r.products_released.map((p) => [p.product_name, p.product_sku, MOVEMENT_LABELS[p.reason], fmtInt(p.quantity)]),
        emptyText: 'No stock-out in this period.',
      },
      {
        kind: 'table',
        heading: 'Responsible users',
        columns: [{ header: 'User' }, { header: 'Movements', align: 'right' }, { header: 'Stock-In', align: 'right' }, { header: 'Stock-Out', align: 'right' }, { header: 'Sold', align: 'right' }],
        rows: r.by_user.map((u) => [u.user_name, fmtInt(u.movements), fmtInt(u.stock_in), fmtInt(u.stock_out), fmtInt(u.sold)]),
      },
      {
        kind: 'table',
        heading: 'Monthly stock movement trend (last 12 months)',
        columns: [{ header: 'Month' }, { header: 'Stock-In', align: 'right' }, { header: 'Stock-Out', align: 'right' }, { header: 'Sold', align: 'right' }],
        rows: r.monthly_trend.map((m) => [format(parseISO(m.month), 'MMMM yyyy'), fmtInt(m.stock_in), fmtInt(m.stock_out), fmtInt(m.sold)]),
      },
      {
        kind: 'table',
        heading: `Stock movement history (${fmtInt(movements.length)})`,
        columns: [
          { header: 'Movement ID' },
          { header: 'Date & time' },
          { header: 'Product' },
          { header: 'Type' },
          { header: 'Previous', align: 'right' },
          { header: 'Added', align: 'right' },
          { header: 'Deducted', align: 'right' },
          { header: 'New', align: 'right' },
          { header: 'Reference' },
          { header: 'User' },
          { header: 'Remarks' },
        ],
        rows: movements.map((m) => [
          m.movement_no,
          fmtDateTime(m.occurred_at),
          m.product_name,
          MOVEMENT_LABELS[m.movement_type],
          fmtInt(m.quantity_before),
          m.quantity_change > 0 ? fmtInt(m.quantity_change) : '',
          m.quantity_change < 0 ? fmtInt(-m.quantity_change) : '',
          fmtInt(m.quantity_after),
          m.reference_no ?? '',
          m.created_by_name,
          m.reason ?? '',
        ]),
      },
    ],
  };
}
