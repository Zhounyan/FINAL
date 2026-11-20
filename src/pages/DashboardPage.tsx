import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  CalendarDays,
  CircleDollarSign,
  LayoutDashboard,
  PackageX,
  Receipt,
  ShoppingCart,
  TrendingUp,
  Warehouse,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { adminDashboard, myDashboard } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt, fmtMoney, fmtSigned, paymentLabel } from '@/lib/format';
import { Badge, Card, EmptyState, ErrorState, PageHeader, StatCard, Tabs } from '@/components/ui/Display';
import { Button } from '@/components/ui/Button';
import { LoadingBlock } from '@/components/ui/Spinner';
import { MovementTypeBadge } from '@/components/stock/MovementViews';
import { InvoiceModal } from '@/components/sales/InvoiceModal';

export default function DashboardPage() {
  const { can } = useAuth();
  return can.isAdmin ? <AdminDashboardView /> : <CashierDashboardView />;
}

function AdminDashboardView() {
  const q = useQuery({ queryKey: ['dashboard', 'admin'], queryFn: adminDashboard, refetchInterval: 60_000 });
  const [chart, setChart] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [viewing, setViewing] = useState<number | null>(null);
  if (q.isError) return <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  if (q.isLoading || !q.data) return <LoadingBlock rows={8} />;
  const d = q.data;
  const data =
    chart === 'daily'
      ? d.daily_sales.map((x) => ({ label: format(parseISO(x.day), 'MMM d'), amount: Number(x.amount) }))
      : chart === 'weekly'
        ? d.weekly_sales.map((x) => ({ label: `Wk of ${format(parseISO(x.week), 'MMM d')}`, amount: Number(x.amount) }))
        : d.monthly_sales.map((x) => ({ label: format(parseISO(x.month), 'MMM yy'), amount: Number(x.amount) }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<LayoutDashboard className="size-5" />}
        title="Dashboard"
        description={`Business overview for ${format(parseISO(d.today), 'EEEE, MMMM d, yyyy')}. All figures come straight from recorded sales and stock movements.`}
        actions={
          <Link to="/pos">
            <Button icon={<ShoppingCart className="size-4" />}>Open Point of Sale</Button>
          </Link>
        }
      />
      <section aria-label="Sales overview" className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="sales-overview">
        <StatCard label="Today's sales" value={fmtMoney(d.sales_today.amount)} hint={`${fmtInt(d.sales_today.transactions)} transaction(s)`} icon={<CircleDollarSign className="size-4" />} tone="green" />
        <StatCard label="This week's sales" value={fmtMoney(d.sales_week.amount)} hint={`${fmtInt(d.sales_week.transactions)} transaction(s)`} icon={<CalendarDays className="size-4" />} tone="blue" />
        <StatCard label="This month's sales" value={fmtMoney(d.sales_month.amount)} hint={`${fmtInt(d.sales_month.transactions)} transaction(s)`} icon={<TrendingUp className="size-4" />} tone="violet" />
        <StatCard label="Total transactions" value={fmtInt(d.total_transactions)} hint="All completed sales" icon={<Receipt className="size-4" />} />
      </section>
      <section aria-label="Inventory overview" className="grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="inventory-overview">
        <StatCard label="Total products" value={fmtInt(d.total_products)} icon={<Boxes className="size-4" />} />
        <StatCard label="Inventory quantity" value={fmtInt(d.total_quantity)} icon={<Warehouse className="size-4" />} tone="blue" />
        <Link to="/products?status=low" className="block">
          <StatCard label="Low stock" value={fmtInt(d.low_stock)} icon={<AlertTriangle className="size-4" />} tone="amber" />
        </Link>
        <Link to="/products?status=out" className="block">
          <StatCard label="Out of stock" value={fmtInt(d.out_of_stock)} icon={<PackageX className="size-4" />} tone="red" />
        </Link>
        <StatCard label="Today's stock-in" value={fmtInt(d.stock_in_today.quantity)} hint={`${fmtInt(d.stock_in_today.entries)} entr(ies)`} icon={<ArrowDownToLine className="size-4" />} tone="green" />
        <StatCard label="Today's stock-out" value={fmtInt(d.stock_out_today.quantity)} hint={`${fmtInt(d.stock_out_today.entries)} entr(ies)`} icon={<ArrowUpFromLine className="size-4" />} tone="red" />
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="Sales" className="xl:col-span-2" actions={<Tabs value={chart} onChange={setChart} tabs={[{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }]} />}>
          <div className="h-72 p-4" data-testid="sales-chart">
            <ResponsiveContainer>
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e3e5dc" />
                <XAxis dataKey="label" fontSize={11} tickLine={false} />
                <YAxis fontSize={11} tickLine={false} width={70} tickFormatter={(v) => `₱${Number(v).toLocaleString()}`} />
                <Tooltip formatter={(v) => fmtMoney(Number(v))} />
                <Bar dataKey="amount" name="Net sales" fill="#2f7a4a" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Best-selling products" subtitle="This month">
          {!d.best_sellers.length ? (
            <EmptyState title="No sales yet this month" />
          ) : (
            <ol className="divide-y divide-line">
              {d.best_sellers.map((b, i) => (
                <li key={b.product_id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800">{i + 1}</span>
                    <span className="truncate font-medium">{b.product_name}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <b>{fmtInt(b.quantity)}</b> sold
                    <span className="block text-xs text-muted">{fmtMoney(b.amount)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="Recent transactions" actions={<Link to="/sales" className="text-sm font-medium text-brand-700 hover:underline">All transactions</Link>}>
          {!d.recent_sales.length ? (
            <EmptyState title="No sales yet" />
          ) : (
            <ul className="divide-y divide-line" data-testid="recent-sales">
              {d.recent_sales.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setViewing(s.id)} className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-sm hover:bg-brand-50/50">
                    <span className="min-w-0">
                      <span className="block font-mono text-xs font-semibold">{s.reference_no}</span>
                      <span className="block text-xs text-muted">
                        {fmtDateTime(s.sold_at)} · {s.created_by_name}
                      </span>
                    </span>
                    <span className="text-right">
                      <b className={s.status === 'voided' ? 'text-muted line-through' : ''}>{fmtMoney(s.total_amount)}</b>
                      <span className="block text-xs text-muted">{s.status === 'voided' ? 'Voided' : paymentLabel(s.payment_method)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent stock movements" actions={<Link to="/stock/history" className="text-sm font-medium text-brand-700 hover:underline">History</Link>}>
          {!d.recent_movements.length ? (
            <EmptyState title="No stock movements yet" />
          ) : (
            <ul className="divide-y divide-line">
              {d.recent_movements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.product_name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                      <MovementTypeBadge type={m.movement_type} /> {m.created_by_name}
                    </span>
                  </span>
                  <span className="text-right">
                    <b className={m.quantity_change > 0 ? 'text-emerald-700' : 'text-red-700'}>{fmtSigned(m.quantity_change)}</b>
                    <span className="block font-mono text-[11px] text-muted">{m.movement_no}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent cashier activities" actions={<Link to="/activity" className="text-sm font-medium text-brand-700 hover:underline">Activity logs</Link>}>
          {!d.cashier_activity.length ? (
            <EmptyState title="No cashier activity yet" />
          ) : (
            <ul className="divide-y divide-line" data-testid="cashier-activity">
              {d.cashier_activity.map((a) => (
                <li key={a.id} className="px-5 py-3 text-sm">
                  <span className="font-medium">{a.user_name}</span> <span className="text-muted">— {a.summary ?? a.action}</span>
                  <span className="block text-xs text-muted">{fmtDateTime(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {d.stock_alerts.length > 0 && (
        <Card title="Stock alerts" subtitle="Products at or below their minimum level">
          <ul className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="stock-alerts">
            {d.stock_alerts.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-sm">
                <span className="truncate font-medium">{a.name}</span>
                {a.status === 'out' ? <Badge tone="red">Out</Badge> : <Badge tone="amber">{fmtInt(a.current_stock)} left</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <InvoiceModal saleId={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

function CashierDashboardView() {
  const { profile } = useAuth();
  const q = useQuery({ queryKey: ['dashboard', 'mine'], queryFn: myDashboard, refetchInterval: 60_000 });
  const [viewing, setViewing] = useState<number | null>(null);
  if (q.isError) return <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  if (q.isLoading || !q.data) return <LoadingBlock rows={6} />;
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start gap-4 rounded-2xl bg-gradient-to-br from-brand-800 to-brand-950 p-6 text-white shadow-card sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-brand-100">Hello, {profile?.full_name.split(' ')[0]}!</p>
          <p className="text-2xl font-bold">Ready to sell?</p>
          <p className="text-sm text-brand-100">{format(parseISO(d.today), 'EEEE, MMMM d, yyyy')}</p>
        </div>
        <Link to="/pos" className="inline-flex h-16 items-center gap-3 rounded-2xl bg-white px-8 text-xl font-bold text-brand-900 shadow-lg hover:bg-brand-50">
          <ShoppingCart className="size-7" /> Open Point of Sale
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="my-summary">
        <StatCard label="My sales today" value={fmtMoney(d.sales_today.amount)} icon={<CircleDollarSign className="size-4" />} tone="green" />
        <StatCard label="My transactions today" value={fmtInt(d.sales_today.transactions)} hint={`${fmtInt(d.sales_today.items_sold)} item(s) sold`} icon={<Receipt className="size-4" />} tone="blue" />
        <StatCard label="Products available" value={fmtInt(d.available_products)} icon={<Boxes className="size-4" />} />
        <StatCard label="Low / out of stock" value={`${fmtInt(d.low_stock)} / ${fmtInt(d.out_of_stock)}`} icon={<AlertTriangle className="size-4" />} tone="amber" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="My daily sales summary" subtitle="Completed sales today, by payment method">
          {!d.by_payment.length ? (
            <EmptyState title="No sales yet today" message="Your completed sales will be summarised here." />
          ) : (
            <ul className="divide-y divide-line">
              {d.by_payment.map((p) => (
                <li key={p.payment_method} className="flex justify-between px-5 py-3 text-sm">
                  <span className="font-medium">{paymentLabel(p.payment_method)}</span>
                  <span>
                    {fmtInt(p.transactions)} sale(s) · <b>{fmtMoney(p.amount)}</b>
                  </span>
                </li>
              ))}
              {d.voided_today > 0 && <li className="px-5 py-3 text-sm text-red-700">{d.voided_today} of today's sales were voided by the Administrator.</li>}
            </ul>
          )}
        </Card>
        <Card title="My recent transactions" actions={<Link to="/my-sales" className="text-sm font-medium text-brand-700 hover:underline">See all</Link>}>
          {!d.recent_sales.length ? (
            <EmptyState title="No transactions yet" />
          ) : (
            <ul className="divide-y divide-line">
              {d.recent_sales.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setViewing(s.id)} className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-sm hover:bg-brand-50/50">
                    <span>
                      <span className="block font-mono text-xs font-semibold">{s.invoice_no}</span>
                      <span className="block text-xs text-muted">{fmtDateTime(s.sold_at)}</span>
                    </span>
                    <span className="text-right">
                      <b className={s.status === 'voided' ? 'text-muted line-through' : ''}>{fmtMoney(s.total_amount)}</b>
                      <span className="block text-xs text-muted">{s.status === 'voided' ? 'Voided' : paymentLabel(s.payment_method)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <InvoiceModal saleId={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
