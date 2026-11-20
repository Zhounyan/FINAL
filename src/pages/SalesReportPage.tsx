import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import { Ban, BarChart3, Coins, Percent, Receipt, ShoppingBag, TrendingUp } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useResettingPage, useSettings, useStoreToday } from '@/hooks/data';
import { listSales, PAGE_SIZE, salesReport, type SalesQuery } from '@/lib/api';
import type { DocModel } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt, fmtMoney, paymentLabel } from '@/lib/format';
import type { SalesReport } from '@/lib/types';
import { Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, StatCard, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ReportToolbar, SortableTh, sortRows, useReportRange } from '@/components/reports/ReportToolbar';
import { StatusBadge } from './SalesListPage';
import { InvoiceModal } from '@/components/sales/InvoiceModal';

type Period = 'daily' | 'weekly' | 'monthly';
const TITLES: Record<Period, string> = { daily: 'Daily Sales Report', weekly: 'Weekly Sales Report', monthly: 'Monthly Sales Report' };

export default function SalesReportPage({ period }: { period: Period }) {
  const today = useStoreToday();
  return <SalesReportView key={period} period={period} today={today} />;
}

function SalesReportView({ period, today }: { period: Period; today: string }) {
  const { profile } = useAuth();
  const settings = useSettings();
  const state = useReportRange(period, today);
  const { range } = state;
  const report = useQuery({ queryKey: ['reports', 'sales', range.from, range.to], queryFn: () => salesReport(range.from, range.to) });

  // transaction history (server-side search / sort / pagination)
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<NonNullable<SalesQuery['sort']>>('newest');
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([range.from, range.to, debounced, sort]);
  const tx = useQuery({
    queryKey: ['sales', 'report-history', range.from, range.to, debounced, sort, page],
    queryFn: () => listSales({ from: range.from, to: range.to, search: debounced, sort, page }),
    placeholderData: (p) => p,
  });
  const [viewing, setViewing] = useState<number | null>(null);
  const [bestSort, setBestSort] = useState<{ key: 'quantity' | 'amount' | 'product_name'; dir: 'asc' | 'desc' }>({ key: 'quantity', dir: 'desc' });

  const r = report.data;
  const build = async (): Promise<DocModel> => {
    const data = r ?? (await salesReport(range.from, range.to));
    const all = await listSales({ from: range.from, to: range.to, sort: 'oldest', page: 1, pageSize: 5000 });
    return salesReportDoc(TITLES[period], range.label, data, all.rows, settings.data?.store_name ?? 'Bill Store', settings.data?.store_address, profile?.full_name);
  };

  const chartData =
    period === 'daily'
      ? (r?.by_hour ?? []).filter((h) => h.hour >= 6 && h.hour <= 22).map((h) => ({ label: `${h.hour % 12 || 12}${h.hour < 12 ? 'am' : 'pm'}`, sales: Number(h.net_sales), transactions: h.transactions }))
      : (r?.by_day ?? []).map((d) => ({ label: format(parseISO(d.day), period === 'weekly' && !range.custom ? 'EEE d' : 'MMM d'), sales: Number(d.net_sales), transactions: d.transactions }));

  return (
    <div className="space-y-6">
      <PageHeader icon={<BarChart3 className="size-5" />} title={TITLES[period]} description="Completed sales only. Voided transactions are listed separately and never counted as sales." />
      <ReportToolbar state={state} today={today} build={build} disabled={!r} />

      {report.isError ? (
        <ErrorState error={errorMessage(report.error)} onRetry={() => report.refetch()} />
      ) : report.isLoading || !r ? (
        <LoadingBlock rows={6} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="sales-report-cards">
            <StatCard label={`Total ${period === 'daily' ? 'daily' : period === 'weekly' ? 'weekly' : 'monthly'} sales`} value={fmtMoney(r.totals.net_sales)} icon={<Coins className="size-4" />} tone="green" />
            <StatCard label="Transactions" value={fmtInt(r.totals.transactions)} icon={<Receipt className="size-4" />} tone="blue" hint={`Average ${fmtMoney(r.totals.average_sale)}`} />
            <StatCard label="Products sold" value={fmtInt(r.totals.items_sold)} icon={<ShoppingBag className="size-4" />} tone="violet" />
            <StatCard label="Voided / refunded" value={fmtInt(r.voided.transactions)} icon={<Ban className="size-4" />} tone="red" hint={`${fmtMoney(r.voided.amount)} not counted`} />
          </div>
          <Card title="Sales summary">
            <dl className="grid gap-x-8 gap-y-2 p-5 text-sm sm:grid-cols-3" data-testid="sales-summary">
              <Summary label="Gross sales" value={fmtMoney(r.totals.gross_sales)} />
              <Summary label="Total discounts" value={`-${fmtMoney(r.totals.discounts)}`} icon={<Percent className="size-4 text-amber-600" />} />
              <Summary label="Net sales" value={fmtMoney(r.totals.net_sales)} strong />
            </dl>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title={period === 'daily' ? 'Sales by hour' : period === 'weekly' ? 'Daily sales comparison within the week' : 'Daily sales this month'}>
              <div className="h-64 p-4">
                <ResponsiveContainer>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e3e5dc" />
                    <XAxis dataKey="label" fontSize={11} tickLine={false} />
                    <YAxis fontSize={11} tickLine={false} width={64} tickFormatter={(v) => `₱${Number(v).toLocaleString()}`} />
                    <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                    <Bar dataKey="sales" name="Net sales" fill="#2f7a4a" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            {period === 'monthly' ? (
              <Card title="Monthly sales trend" subtitle="Comparison with previous months">
                <div className="h-64 p-4">
                  <ResponsiveContainer>
                    <LineChart data={r.monthly_trend.map((m) => ({ label: format(parseISO(m.month), 'MMM yy'), sales: Number(m.net_sales) }))}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e3e5dc" />
                      <XAxis dataKey="label" fontSize={11} tickLine={false} />
                      <YAxis fontSize={11} tickLine={false} width={64} tickFormatter={(v) => `₱${Number(v).toLocaleString()}`} />
                      <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                      <Line dataKey="sales" name="Net sales" stroke="#1b4a2b" strokeWidth={2.5} dot />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            ) : (
              <BreakdownCards r={r} />
            )}
          </div>
          {period === 'monthly' && (
            <div className="grid gap-5 xl:grid-cols-2">
              <BreakdownCards r={r} />
            </div>
          )}

          <Card title="Best-selling products" actions={<TrendingUp className="size-5 text-brand-700" />}>
            {!r.best_sellers.length ? (
              <EmptyState title="No products sold in this period" />
            ) : (
              <TableWrap>
                <table className="table-base" data-testid="best-sellers">
                  <thead>
                    <tr>
                      <th>#</th>
                      <SortableTh label="Product" active={bestSort.key === 'product_name'} dir={bestSort.dir} onClick={() => setBestSort({ key: 'product_name', dir: bestSort.dir === 'asc' ? 'desc' : 'asc' })} />
                      <SortableTh label="Qty sold" num active={bestSort.key === 'quantity'} dir={bestSort.dir} onClick={() => setBestSort({ key: 'quantity', dir: bestSort.dir === 'asc' ? 'desc' : 'asc' })} />
                      <SortableTh label="Sales" num active={bestSort.key === 'amount'} dir={bestSort.dir} onClick={() => setBestSort({ key: 'amount', dir: bestSort.dir === 'asc' ? 'desc' : 'asc' })} />
                      <th className="num">Transactions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(r.best_sellers.map((b) => ({ ...b, quantity: Number(b.quantity), amount: Number(b.amount) })), bestSort.key, bestSort.dir).map((b, i) => (
                      <tr key={b.product_id}>
                        <td className="text-muted">{i + 1}</td>
                        <td>
                          <span className="font-medium">{b.product_name}</span>
                          <span className="block text-xs text-muted">{b.product_sku}</span>
                        </td>
                        <td className="num font-semibold">{fmtInt(b.quantity)}</td>
                        <td className="num">{fmtMoney(b.amount)}</td>
                        <td className="num">{fmtInt(b.transactions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </>
      )}

      <Card title={period === 'daily' ? 'Daily transaction history' : 'Transaction history'}>
        <div className="flex flex-wrap gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} className="max-w-sm flex-1" placeholder="Search transaction, invoice, customer, cashier…" />
          <select className="input h-10 w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort transactions">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount_desc">Highest amount</option>
            <option value="amount_asc">Lowest amount</option>
          </select>
        </div>
        {tx.isLoading ? (
          <LoadingBlock />
        ) : !tx.data?.rows.length ? (
          <EmptyState title="No transactions in this period" />
        ) : (
          <TableWrap>
            <table className="table-base table-compact" data-testid="report-transactions">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Date &amp; time</th>
                  <th>Cashier</th>
                  <th className="num">Items</th>
                  <th className="num">Discount</th>
                  <th className="num">Total</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tx.data.rows.map((s) => (
                  <tr key={s.id} className="cursor-pointer" onClick={() => setViewing(s.id)}>
                    <td>
                      <span className="font-mono text-xs font-semibold">{s.reference_no}</span>
                      <span className="block font-mono text-[11px] text-muted">{s.invoice_no}</span>
                    </td>
                    <td className="whitespace-nowrap">{fmtDateTime(s.sold_at)}</td>
                    <td>{s.created_by_name}</td>
                    <td className="num">{fmtInt(s.total_quantity)}</td>
                    <td className="num">{s.discount_amount > 0 ? fmtMoney(s.discount_amount) : '—'}</td>
                    <td className="num font-semibold">{fmtMoney(s.total_amount)}</td>
                    <td>{paymentLabel(s.payment_method)}</td>
                    <td>
                      <StatusBadge sale={s} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={tx.data?.total ?? 0} onChange={setPage} />
      </Card>
      <InvoiceModal saleId={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

function Summary({ label, value, strong, icon }: { label: string; value: string; strong?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2">
      <dt className="flex items-center gap-1.5 text-muted">
        {icon}
        {label}
      </dt>
      <dd className={strong ? 'text-lg font-bold text-brand-800' : 'font-semibold'}>{value}</dd>
    </div>
  );
}

function BreakdownCards({ r }: { r: SalesReport }) {
  return (
    <>
      <Card title="Sales by cashier">
        {!r.by_cashier.length ? (
          <EmptyState title="No sales" />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="by-cashier">
              <thead>
                <tr>
                  <th>Cashier</th>
                  <th className="num">Transactions</th>
                  <th className="num">Items</th>
                  <th className="num">Net sales</th>
                </tr>
              </thead>
              <tbody>
                {r.by_cashier.map((c) => (
                  <tr key={c.cashier_id ?? c.cashier_name}>
                    <td className="font-medium">{c.cashier_name}</td>
                    <td className="num">{fmtInt(c.transactions)}</td>
                    <td className="num">{fmtInt(c.items_sold)}</td>
                    <td className="num font-semibold">{fmtMoney(c.net_sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      <Card title="Sales by payment method">
        {!r.by_payment.length ? (
          <EmptyState title="No sales" />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="by-payment">
              <thead>
                <tr>
                  <th>Payment method</th>
                  <th className="num">Transactions</th>
                  <th className="num">Net sales</th>
                </tr>
              </thead>
              <tbody>
                {r.by_payment.map((p) => (
                  <tr key={p.payment_method}>
                    <td className="font-medium">{paymentLabel(p.payment_method)}</td>
                    <td className="num">{fmtInt(p.transactions)}</td>
                    <td className="num font-semibold">{fmtMoney(p.net_sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

export function salesReportDoc(
  title: string,
  rangeLabel: string,
  r: SalesReport,
  transactions: import('@/lib/types').Sale[],
  storeName: string,
  storeAddress: string | undefined,
  generatedBy: string | undefined,
): DocModel {
  const completed = transactions.filter((t) => t.status === 'completed');
  return {
    title,
    subtitle: `Period: ${rangeLabel}`,
    storeName,
    storeLines: [storeAddress ?? ''],
    generatedBy,
    fileName: `${title}-${r.from}${r.from !== r.to ? `-to-${r.to}` : ''}`,
    landscape: false,
    sections: [
      {
        kind: 'kv',
        heading: 'Summary',
        rows: [
          ['Total net sales', fmtMoney(r.totals.net_sales)],
          ['Number of transactions', fmtInt(r.totals.transactions)],
          ['Total products sold', fmtInt(r.totals.items_sold)],
          ['Average sale', fmtMoney(r.totals.average_sale)],
          ['Gross sales', fmtMoney(r.totals.gross_sales)],
          ['Total discounts', fmtMoney(r.totals.discounts)],
          ['Net sales', fmtMoney(r.totals.net_sales)],
          ['Voided / refunded (not counted)', `${fmtInt(r.voided.transactions)} · ${fmtMoney(r.voided.amount)}`],
        ],
      },
      {
        kind: 'table',
        heading: 'Sales by cashier',
        columns: [{ header: 'Cashier' }, { header: 'Transactions', align: 'right' }, { header: 'Items', align: 'right' }, { header: 'Net sales', align: 'right' }],
        rows: r.by_cashier.map((c) => [c.cashier_name, fmtInt(c.transactions), fmtInt(c.items_sold), fmtMoney(c.net_sales)]),
      },
      {
        kind: 'table',
        heading: 'Sales by payment method',
        columns: [{ header: 'Payment method' }, { header: 'Transactions', align: 'right' }, { header: 'Net sales', align: 'right' }],
        rows: r.by_payment.map((p) => [paymentLabel(p.payment_method), fmtInt(p.transactions), fmtMoney(p.net_sales)]),
      },
      {
        kind: 'table',
        heading: 'Best-selling products',
        columns: [{ header: '#', align: 'center' }, { header: 'Product' }, { header: 'Qty sold', align: 'right' }, { header: 'Sales', align: 'right' }],
        rows: r.best_sellers.map((b, i) => [String(i + 1), `${b.product_name} (${b.product_sku})`, fmtInt(b.quantity), fmtMoney(b.amount)]),
      },
      r.from === r.to
        ? {
            kind: 'table',
            heading: 'Sales by hour',
            columns: [{ header: 'Hour' }, { header: 'Transactions', align: 'right' }, { header: 'Net sales', align: 'right' }],
            rows: r.by_hour.filter((h) => h.transactions > 0).map((h) => [`${String(h.hour).padStart(2, '0')}:00`, fmtInt(h.transactions), fmtMoney(h.net_sales)]),
          }
        : {
            kind: 'table',
            heading: 'Daily sales',
            columns: [{ header: 'Date' }, { header: 'Transactions', align: 'right' }, { header: 'Items', align: 'right' }, { header: 'Net sales', align: 'right' }],
            rows: r.by_day.map((d) => [format(parseISO(d.day), 'EEE, MMM d, yyyy'), fmtInt(d.transactions), fmtInt(d.items_sold), fmtMoney(d.net_sales)]),
            footer: ['Total', fmtInt(r.totals.transactions), fmtInt(r.totals.items_sold), fmtMoney(r.totals.net_sales)],
          },
      {
        kind: 'table',
        heading: 'Monthly sales trend (last 12 months)',
        columns: [{ header: 'Month' }, { header: 'Transactions', align: 'right' }, { header: 'Net sales', align: 'right' }],
        rows: r.monthly_trend.map((m) => [format(parseISO(m.month), 'MMMM yyyy'), fmtInt(m.transactions), fmtMoney(m.net_sales)]),
      },
      {
        kind: 'table',
        heading: `Transaction history (${fmtInt(transactions.length)})`,
        columns: [{ header: 'Transaction' }, { header: 'Date & time' }, { header: 'Cashier' }, { header: 'Payment' }, { header: 'Status' }, { header: 'Total', align: 'right' }],
        rows: transactions.map((t) => [`${t.reference_no} / ${t.invoice_no}`, fmtDateTime(t.sold_at), t.created_by_name, paymentLabel(t.payment_method), t.status === 'completed' ? 'Completed' : 'VOIDED', fmtMoney(t.total_amount)]),
        footer: ['Completed total', '', '', '', `${completed.length}`, fmtMoney(completed.reduce((a, t) => a + Number(t.total_amount), 0))],
      },
    ],
  };
}
