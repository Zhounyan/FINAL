import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import { History, List, Package, Tags, Table2 } from 'lucide-react';
import { listMovements, movementBreakdown, movementSummary, PAGE_SIZE } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtInt, fmtSigned } from '@/lib/format';
import { useAuth } from '@/auth/AuthProvider';
import { clampToToday } from '@/lib/periods';
import { useDebounce, useSettings, useStoreToday, useResettingPage } from '@/hooks/data';
import { Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap, Tabs } from '@/components/ui/Display';
import { LoadingBlock, Skeleton } from '@/components/ui/Spinner';
import { CategoryProductFilters, defaultFilterState, PeriodPicker, useFilterDescription, type MovementFilterState } from '@/components/stock/MovementFilters';
import { FormulaNote, MovementTable, PeriodSummaryTable, SummaryCards, totalsOf } from '@/components/stock/MovementViews';
import { ReverseDialog } from '@/components/stock/ReverseDialog';
import { ExportButtons } from '@/components/ExportButtons';
import { AXIS, ChartTooltip, GRID, SERIES } from '@/components/charts';
import type { StockMovement } from '@/lib/types';
import { breakdownColumns, movementColumns, summaryColumns } from './movementExport';

type View = 'summary' | 'category' | 'product' | 'entries';

export default function MovementHistoryPage() {
  const { can, profile } = useAuth();
  const today = useStoreToday();
  const settings = useSettings();
  const [filters, setFilters] = useState<MovementFilterState>(() => defaultFilterState('monthly', today));
  const [view, setView] = useState<View>('summary');
  const [search, setSearch] = useState('');
  const [reversing, setReversing] = useState<StockMovement | null>(null);
  const debounced = useDebounce(search);
  const describe = useFilterDescription(filters);
  const [page, setPage] = useResettingPage([filters, debounced]);

  const base = { from: filters.period.from, to: clampToToday(filters.period, today).to, categoryId: filters.categoryId, productId: filters.productId };
  const bucket = filters.period.bucket;
  const summary = useQuery({ queryKey: ['movements', 'summary', base, bucket], queryFn: () => movementSummary({ ...base, bucket }) });
  const group = view === 'category' ? 'category' : 'product';
  const breakdown = useQuery({
    queryKey: ['movements', 'breakdown', base, group],
    queryFn: () => movementBreakdown({ ...base, group }),
    enabled: view === 'category' || view === 'product',
  });
  const types = filters.movementType ? [filters.movementType] : undefined;
  const list = useQuery({
    queryKey: ['movements', 'list', base, types, debounced, page],
    queryFn: () => listMovements({ ...base, types, search: debounced, page }),
    enabled: view === 'entries',
    placeholderData: (p) => p,
  });
  const totals = totalsOf(summary.data);
  const chartData = (summary.data ?? []).map((r) => ({
    ...r,
    stock_in: Number(r.stock_in),
    stock_sold: Number(r.stock_sold),
    other_out: Number(r.other_out),
    label: format(parseISO(r.period_start), bucket === 'month' ? 'MMM' : filters.period.type === 'weekly' ? 'EEE d' : 'd'),
  }));

  const metaBase = {
    storeName: settings.data?.store_name ?? 'Bill Store',
    generatedBy: profile?.full_name,
    subtitle: describe.text,
    summary: totals
      ? [
          { label: 'Beginning Stock', value: fmtInt(totals.beginning_stock) },
          { label: 'Stock In', value: `+${fmtInt(totals.stock_in)}` },
          { label: 'Stock Sold', value: `-${fmtInt(totals.stock_sold)}` },
          { label: 'Other Stock Out', value: `-${fmtInt(totals.other_out)}` },
          { label: 'Adjustments', value: fmtSigned(totals.adjustments) },
          { label: 'Ending Stock', value: fmtInt(totals.ending_stock) },
        ]
      : [],
  };
  const periodName = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[filters.period.type];

  const buildExport = async () => {
    if (view === 'entries') {
      const all = await listMovements({ ...base, types, search: debounced, page: 1, pageSize: 5000 });
      return { rows: all.rows as unknown[], columns: movementColumns as never, meta: { ...metaBase, title: `${periodName} Stock Movement Entries` } };
    }
    if (view === 'category' || view === 'product') {
      const rows = breakdown.data ?? (await movementBreakdown({ ...base, group }));
      return {
        rows: rows as unknown[],
        columns: breakdownColumns(group) as never,
        meta: { ...metaBase, title: group === 'category' ? 'Category-Based Stock Movement Report' : 'Product-Specific Stock Movement Report' },
      };
    }
    return { rows: (summary.data ?? []) as unknown[], columns: summaryColumns(bucket) as never, meta: { ...metaBase, title: `${periodName} Stock Movement Report` } };
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<History className="size-5" />}
        title="Stock Movement History"
        description="Review historical inventory movements by day, week, month or year — for all inventory, a category or a single product."
        actions={<ExportButtons build={buildExport} />}
      />

      <Card bodyClassName="p-4 space-y-4">
        <PeriodPicker period={filters.period} onChange={(p) => setFilters((f) => ({ ...f, period: p }))} today={today} />
        <CategoryProductFilters value={filters} onChange={setFilters} />
        <p className="text-xs text-muted">
          Showing: <b className="text-ink">{describe.text}</b>
          {filters.movementType && ' — the movement-type filter applies to the entries list; balances always include every movement.'}
        </p>
      </Card>

      {summary.isError ? (
        <ErrorState error={errorMessage(summary.error)} onRetry={() => summary.refetch()} />
      ) : (
        <div className="space-y-2">
          <SummaryCards totals={totals} loading={summary.isFetching} />
          <FormulaNote />
        </div>
      )}

      {filters.period.type !== 'daily' && (
        <Card title="Stock in vs stock out" subtitle={`Per ${bucket === 'month' ? 'month' : 'day'} · ${filters.period.label}`} bodyClassName="p-4">
          {summary.isLoading ? (
            <Skeleton className="h-64" />
          ) : (
            <div className="h-64" role="img" aria-label="Grouped bar chart of stock in, stock sold and other stock out per period">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barGap={2} barCategoryGap="20%">
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={48} />
                  <Tooltip
                    content={<ChartTooltip labelFormatter={(l) => chartData.find((d) => d.label === l)?.period_start ? format(parseISO(chartData.find((d) => d.label === l)!.period_start), bucket === 'month' ? 'MMMM yyyy' : 'EEE, MMM d, yyyy') : l} />}
                    cursor={{ fill: '#f2f7f0' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {(['stock_in', 'stock_sold', 'other_out'] as const).map((k) => (
                    <Bar key={k} dataKey={k} name={SERIES[k].label} fill={SERIES[k].color} radius={[4, 4, 0, 0]} maxBarSize={18} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      )}

      <div className="space-y-4">
        <Tabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { id: 'summary', label: 'Historical summary', icon: <Table2 className="size-4" /> },
            { id: 'category', label: 'By category', icon: <Tags className="size-4" /> },
            { id: 'product', label: 'By product', icon: <Package className="size-4" /> },
            { id: 'entries', label: 'Movement entries', icon: <List className="size-4" /> },
          ]}
        />

        {view === 'summary' && (
          <Card title="Historical summary" subtitle={`${bucket === 'month' ? 'Monthly' : 'Daily'} balances · ${describe.text}`}>
            {summary.isLoading ? <LoadingBlock /> : <PeriodSummaryTable rows={summary.data ?? []} bucket={bucket} totals={totals} />}
          </Card>
        )}

        {(view === 'category' || view === 'product') && (
          <Card
            title={view === 'category' ? 'Category-based stock movements' : 'Product-specific stock movements'}
            subtitle={`Beginning and ending quantities for ${filters.period.label}`}
          >
            {breakdown.isLoading ? (
              <LoadingBlock />
            ) : breakdown.isError ? (
              <ErrorState error={errorMessage(breakdown.error)} />
            ) : !breakdown.data?.length ? (
              <EmptyState title="No data" />
            ) : (
              <TableWrap>
                <table className="table-base" data-testid="history-breakdown">
                  <thead>
                    <tr>
                      {breakdownColumns(group).map((c) => (
                        <th key={c.header} className={c.numeric ? 'num' : ''}>{c.header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.data.map((r) => (
                      <tr key={r.group_id} className={Number(r.movement_count) === 0 ? 'text-muted' : ''}>
                        <td className="font-medium">{r.group_name}</td>
                        {group === 'product' && (
                          <>
                            <td className="text-xs text-muted">{r.sku}</td>
                            <td>{r.category_name}</td>
                          </>
                        )}
                        <td className="num">{fmtInt(r.beginning_stock)}</td>
                        <td className="num text-emerald-700">+{fmtInt(r.stock_in)}</td>
                        <td className="num text-sky-700">{fmtInt(r.stock_sold)}</td>
                        <td className="num text-amber-700">{fmtInt(r.other_out)}</td>
                        <td className="num text-violet-700">{fmtSigned(r.adjustments)}</td>
                        <td className="num font-semibold">{fmtInt(r.ending_stock)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={group === 'product' ? 3 : 1}>Total</td>
                      {(['beginning_stock', 'stock_in', 'stock_sold', 'other_out', 'adjustments', 'ending_stock'] as const).map((k) => (
                        <td key={k} className="num">
                          {k === 'adjustments'
                            ? fmtSigned(breakdown.data!.reduce((a, r) => a + Number(r[k]), 0))
                            : fmtInt(breakdown.data!.reduce((a, r) => a + Number(r[k]), 0))}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </TableWrap>
            )}
          </Card>
        )}

        {view === 'entries' && (
          <Card title="Movement entries" subtitle="Dates, movement types, quantities and responsible users" actions={<SearchInput value={search} onChange={setSearch} className="w-64" placeholder="Search product, ref, user…" />}>
            {list.isError ? (
              <ErrorState error={errorMessage(list.error)} onRetry={() => list.refetch()} />
            ) : list.isLoading ? (
              <LoadingBlock />
            ) : (
              <MovementTable rows={list.data?.rows ?? []} onReverse={can.reverseMovements ? setReversing : undefined} />
            )}
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onChange={setPage} />
          </Card>
        )}
      </div>
      <ReverseDialog movement={reversing} onClose={() => setReversing(null)} />
    </div>
  );
}
