import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Boxes,
  LayoutDashboard,
  Layers,
  Package,
  PackageX,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import { dashboardStats, listActivity, recentMovements } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt, fmtMoney, fmtSigned } from '@/lib/format';
import { useAuth } from '@/auth/AuthProvider';
import { Badge, Card, EmptyState, ErrorState, PageHeader, StatCard, TableWrap } from '@/components/ui/Display';
import { LoadingBlock, Skeleton } from '@/components/ui/Spinner';
import { MovementTypeBadge, SummaryCards } from '@/components/stock/MovementViews';
import { AXIS, ChartTooltip, GRID, SERIES, SINGLE } from '@/components/charts';

export default function DashboardPage() {
  const { can } = useAuth();
  const stats = useQuery({ queryKey: ['dashboard', 'stats', 14], queryFn: () => dashboardStats(14), refetchInterval: 60_000 });
  const recent = useQuery({ queryKey: ['dashboard', 'recent-movements'], queryFn: () => recentMovements(8), refetchInterval: 60_000 });
  const activity = useQuery({
    queryKey: ['activity', 'dashboard'],
    queryFn: () => listActivity({ page: 1, pageSize: 8 }),
    enabled: can.viewActivity,
  });
  const s = stats.data;

  if (stats.isError) return <ErrorState error={errorMessage(stats.error)} onRetry={() => stats.refetch()} />;

  const trend = (s?.trend ?? []).map((r) => ({ ...r, label: format(parseISO(r.period_start), 'MMM d') }));
  const categories = (s?.category_distribution ?? []).slice(0, 10).map((c) => ({ ...c, quantity: Number(c.quantity) }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<LayoutDashboard className="size-5" />}
        title="Dashboard"
        description={s ? `Live overview of Bill Store inventory · ${format(parseISO(s.today), 'EEEE, MMMM d, yyyy')} (${s.timezone})` : 'Live overview of Bill Store inventory'}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {!s ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
        ) : (
          <>
            <StatCard label="Total Products" value={fmtInt(s.total_products)} icon={<Package className="size-4" />} hint={`${fmtInt(s.total_categories)} categories`} />
            <StatCard label="Inventory Quantity" value={fmtInt(s.total_quantity)} icon={<Boxes className="size-4" />} tone="wood" hint="units on hand" />
            <StatCard label="Low Stock" value={fmtInt(s.low_stock)} icon={<AlertTriangle className="size-4" />} tone="amber" hint="at or below minimum" />
            <StatCard label="Out of Stock" value={fmtInt(s.out_of_stock)} icon={<PackageX className="size-4" />} tone="red" hint="zero units left" />
            <StatCard label="Customers" value={fmtInt(s.total_customers)} icon={<Users className="size-4" />} tone="blue" />
            <StatCard label="Suppliers" value={fmtInt(s.total_suppliers)} icon={<Truck className="size-4" />} tone="violet" />
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {s && (
          <>
            <StatCard label="Total Stock In (this month)" value={`+${fmtInt(s.month_summary.stock_in)}`} icon={<ArrowDownToLine className="size-4" />} tone="green" hint={`All time: ${fmtInt(s.all_time.stock_in)} units`} />
            <StatCard label="Total Stock Sold (this month)" value={fmtInt(s.month_summary.stock_sold)} icon={<ShoppingCart className="size-4" />} tone="blue" hint={`All time: ${fmtInt(s.all_time.stock_sold)} units`} />
            {can.viewFinancials && (
              <>
                <StatCard label="Sales (this month)" value={fmtMoney(s.month_sales_amount)} icon={<Wallet className="size-4" />} tone="brand" hint={`All time: ${fmtMoney(s.all_time.sales_amount)}`} />
                <StatCard label="Inventory Value (cost)" value={fmtMoney(s.inventory_cost_value)} icon={<Layers className="size-4" />} tone="wood" hint={`Retail value ${fmtMoney(s.inventory_retail_value)}`} />
              </>
            )}
          </>
        )}
      </div>

      <Card
        title="Today's stock movement"
        subtitle="Beginning + Stock In − Sold − Other Out ± Adjustments = Ending"
        actions={
          <Link to="/movements/daily" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
            Daily details <ArrowRight className="size-4" />
          </Link>
        }
        bodyClassName="p-4"
      >
        <SummaryCards totals={s?.today_summary ?? null} loading={stats.isFetching && !s} />
      </Card>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Daily inventory trend" subtitle="Units received, sold and released — last 14 days" className="xl:col-span-3" bodyClassName="p-4">
          {!s ? (
            <Skeleton className="h-72" />
          ) : (
            <div className="h-72" role="img" aria-label="Line chart of daily stock in, stock sold and other stock out over the last 14 days">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={48} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#9cc28e', strokeDasharray: '3 3' }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: '#17221b' }} />
                  {(['stock_in', 'stock_sold', 'other_out'] as const).map((k) => (
                    <Line key={k} type="monotone" dataKey={k} name={SERIES[k].label} stroke={SERIES[k].color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Inventory by category" subtitle="Units on hand per category" className="xl:col-span-2" bodyClassName="p-4">
          {!s ? (
            <Skeleton className="h-72" />
          ) : categories.length === 0 ? (
            <EmptyState title="No categories yet" />
          ) : (
            <ul className="space-y-3" aria-label="Units on hand per category">
              {categories.map((c) => {
                const max = Math.max(...categories.map((x) => x.quantity), 1);
                return (
                  <li key={c.id} className="grid grid-cols-[minmax(0,8.5rem)_1fr_4.5rem] items-center gap-3 text-sm">
                    <span className="truncate" title={c.name}>{c.name}</span>
                    <span className="h-3 rounded-full bg-brand-50">
                      <span className="block h-3 rounded-full" style={{ width: `${(c.quantity / max) * 100}%`, background: SINGLE }} />
                    </span>
                    <span className="text-right font-medium tabular-nums" title={`${c.products} product(s)`}>{fmtInt(c.quantity)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Stock level visualization" subtitle="Highest on-hand products versus their minimum level" className="xl:col-span-3" bodyClassName="p-4">
          {!s ? (
            <Skeleton className="h-64" />
          ) : s.top_stock.length === 0 ? (
            <EmptyState title="No products yet" message="Add products to see stock levels." />
          ) : (
            <ul className="space-y-3">
              {s.top_stock.map((p) => {
                const max = Math.max(...s.top_stock.map((x) => Number(x.current_stock)), 1);
                const pct = (Number(p.current_stock) / max) * 100;
                const minPct = Math.min(100, (Number(p.min_stock_level) / max) * 100);
                const low = Number(p.current_stock) <= Number(p.min_stock_level);
                return (
                  <li key={p.id} className="grid grid-cols-[minmax(0,10rem)_1fr_4.5rem] items-center gap-3 text-sm">
                    <span className="truncate text-ink" title={p.name}>{p.name}</span>
                    <span className="relative h-3 rounded-full bg-brand-50">
                      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: low ? '#d97706' : SINGLE }} />
                      <span className="absolute -inset-y-0.5 w-0.5 rounded bg-ink/60" style={{ left: `${minPct}%` }} title={`Minimum ${p.min_stock_level}`} />
                    </span>
                    <span className="text-right font-medium tabular-nums">{fmtInt(p.current_stock)}</span>
                  </li>
                );
              })}
              <li className="pt-1 text-xs text-muted">Dark tick marks each product's minimum stock level.</li>
            </ul>
          )}
        </Card>

        <Card
          title="Stock alerts"
          subtitle="Products at or below minimum level"
          className="xl:col-span-2"
          actions={
            <Link to="/products?status=low" className="text-sm font-medium text-brand-700 hover:underline">
              View all
            </Link>
          }
        >
          {!s ? (
            <LoadingBlock rows={4} />
          ) : s.stock_alerts.length === 0 ? (
            <EmptyState title="All stocked up" message="No products are below their minimum stock level." />
          ) : (
            <ul className="divide-y divide-line">
              {s.stock_alerts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="text-xs text-muted">{a.sku} · min {fmtInt(a.min_stock_level)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums">{fmtInt(a.current_stock)} {a.unit}</span>
                    {a.status === 'out' ? (
                      <Badge tone="red"><PackageX className="size-3" /> Out</Badge>
                    ) : (
                      <Badge tone="amber"><AlertTriangle className="size-3" /> Low</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card
          title="Recent stock movements"
          className={can.viewActivity ? 'xl:col-span-3' : 'xl:col-span-5'}
          actions={
            <Link to={can.viewMovementHistory ? '/movements/history' : '/movements/daily'} className="text-sm font-medium text-brand-700 hover:underline">
              View all
            </Link>
          }
        >
          {recent.isLoading ? (
            <LoadingBlock rows={5} />
          ) : !recent.data?.length ? (
            <EmptyState title="No stock movements yet" message="Stock in, sales and adjustments will appear here." />
          ) : (
            <TableWrap>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">After</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.map((m) => (
                    <tr key={m.id}>
                      <td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(m.occurred_at)}</td>
                      <td><MovementTypeBadge type={m.movement_type} /></td>
                      <td className="font-medium">{m.product_name}</td>
                      <td className={`num font-semibold ${m.quantity_change > 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtSigned(m.quantity_change)}</td>
                      <td className="num">{fmtInt(m.quantity_after)}</td>
                      <td className="text-xs whitespace-nowrap">{m.created_by_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        {can.viewActivity && (
          <Card title="Recent system activities" className="xl:col-span-2" actions={can.manageUsers ? <Link to="/users?tab=activity" className="text-sm font-medium text-brand-700 hover:underline">Activity log</Link> : undefined}>
            {activity.isLoading ? (
              <LoadingBlock rows={5} />
            ) : !activity.data?.rows.length ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ul className="divide-y divide-line">
                {activity.data.rows.map((a) => (
                  <li key={a.id} className="px-5 py-3 text-sm">
                    <p className="text-ink">{a.summary ?? a.action}</p>
                    <p className="mt-0.5 text-xs text-muted">{a.user_name ?? 'System'} · {fmtDateTime(a.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
