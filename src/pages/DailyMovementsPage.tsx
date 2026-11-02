import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays } from 'lucide-react';
import { listMovements, movementBreakdown, movementSummary, PAGE_SIZE } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtInt, fmtSigned } from '@/lib/format';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useSettings, useStoreToday, useResettingPage } from '@/hooks/data';
import { Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { CategoryProductFilters, defaultFilterState, PeriodPicker, useFilterDescription, type MovementFilterState } from '@/components/stock/MovementFilters';
import { FormulaNote, MovementTable, SummaryCards, totalsOf } from '@/components/stock/MovementViews';
import { ReverseDialog } from '@/components/stock/ReverseDialog';
import { ExportButtons } from '@/components/ExportButtons';
import type { StockMovement } from '@/lib/types';
import { breakdownColumns, movementColumns } from './movementExport';

export default function DailyMovementsPage() {
  const { can, profile } = useAuth();
  const today = useStoreToday();
  const settings = useSettings();
  const [filters, setFilters] = useState<MovementFilterState>(() => defaultFilterState('daily', today));
  const [search, setSearch] = useState('');
  const [reversing, setReversing] = useState<StockMovement | null>(null);
  const debounced = useDebounce(search);
  const describe = useFilterDescription(filters);

  const [page, setPage] = useResettingPage([filters, debounced]);

  const base = { from: filters.period.from, to: filters.period.to, categoryId: filters.categoryId, productId: filters.productId };
  const summary = useQuery({ queryKey: ['movements', 'summary', base], queryFn: () => movementSummary({ ...base, bucket: 'day' }) });
  const breakdown = useQuery({ queryKey: ['movements', 'breakdown', base], queryFn: () => movementBreakdown({ ...base, group: 'product' }) });
  const list = useQuery({
    queryKey: ['movements', 'list', base, filters.movementType, debounced, page],
    queryFn: () => listMovements({ ...base, types: filters.movementType ? [filters.movementType] : undefined, search: debounced, page }),
    placeholderData: (p) => p,
  });
  const totals = totalsOf(summary.data);
  const active = (breakdown.data ?? []).filter((r) => Number(r.movement_count) > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<CalendarDays className="size-5" />}
        title="Daily Stock Movements"
        description="Exactly how many units came in, were sold or released, and what remains for the selected day."
        actions={
          <ExportButtons
            build={async () => {
              const all = await listMovements({ ...base, types: filters.movementType ? [filters.movementType] : undefined, search: debounced, page: 1, pageSize: 5000 });
              return {
                rows: all.rows,
                columns: movementColumns,
                meta: {
                  title: 'Daily Stock Movement Report',
                  subtitle: describe.text,
                  storeName: settings.data?.store_name ?? 'Bill Store',
                  generatedBy: profile?.full_name,
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
                },
              };
            }}
          />
        }
      />

      <Card bodyClassName="p-4 space-y-4">
        <PeriodPicker period={filters.period} onChange={(p) => setFilters((f) => ({ ...f, period: p }))} allowTypes={false} today={today} />
        <CategoryProductFilters value={filters} onChange={setFilters} />
      </Card>

      {summary.isError ? (
        <ErrorState error={errorMessage(summary.error)} onRetry={() => summary.refetch()} />
      ) : (
        <div className="space-y-2">
          <SummaryCards totals={totals} loading={summary.isFetching} />
          <FormulaNote />
        </div>
      )}

      <Card title="Per-product summary for the day" subtitle={`${active.length} product(s) with activity · ${describe.text}`}>
        {breakdown.isLoading ? (
          <LoadingBlock rows={3} />
        ) : breakdown.isError ? (
          <ErrorState error={errorMessage(breakdown.error)} />
        ) : active.length === 0 ? (
          <EmptyState title="No activity on this day" message="No stock was received, sold or released for the selected filters." />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="daily-breakdown">
              <thead>
                <tr>
                  {breakdownColumns('product').map((c) => (
                    <th key={c.header} className={c.numeric ? 'num' : ''}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.map((r) => (
                  <tr key={r.group_id}>
                    <td className="font-medium">{r.group_name}</td>
                    <td className="text-xs text-muted">{r.sku}</td>
                    <td>{r.category_name}</td>
                    <td className="num">{fmtInt(r.beginning_stock)}</td>
                    <td className="num text-emerald-700">+{fmtInt(r.stock_in)}</td>
                    <td className="num text-sky-700">{fmtInt(r.stock_sold)}</td>
                    <td className="num text-amber-700">{fmtInt(r.other_out)}</td>
                    <td className="num text-violet-700">{fmtSigned(r.adjustments)}</td>
                    <td className="num font-semibold">{fmtInt(r.ending_stock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Movement entries" subtitle="Every stock-in, sale, release and adjustment recorded on this day" actions={<SearchInput value={search} onChange={setSearch} className="w-64" placeholder="Search product, ref, reason…" />}>
        {list.isError ? (
          <ErrorState error={errorMessage(list.error)} onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <LoadingBlock />
        ) : (
          <MovementTable rows={list.data?.rows ?? []} onReverse={can.reverseMovements ? setReversing : undefined} />
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onChange={setPage} />
      </Card>
      <ReverseDialog movement={reversing} onClose={() => setReversing(null)} />
    </div>
  );
}
