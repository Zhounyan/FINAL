import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useDebounce, useProductOptions, useResettingPage, useStoreToday } from '@/hooks/data';
import { listMovements, PAGE_SIZE } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import type { MovementType, StockMovement } from '@/lib/types';
import { Card, ErrorState, PageHeader, Pagination, SearchInput } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ProductCombobox } from '@/components/stock/ProductCombobox';
import { ReverseDialog } from '@/components/stock/ReverseDialog';
import { HistoryTable, TYPE_FILTERS } from './StockReportPage';

const ALL_TYPES: MovementType[] = ['stock_in', 'sale', 'sale_void', 'damaged', 'expired', 'lost', 'internal_use', 'other_out', 'adjustment'];

/** One central, traceable history of every inventory change. */
export default function StockMovementHistoryPage() {
  const today = useStoreToday();
  const [from, setFrom] = useState(() => `${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [productId, setProductId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'quantity'>('newest');
  const [reversing, setReversing] = useState<StockMovement | null>(null);
  const products = useProductOptions(null, true);
  const debounced = useDebounce(search);
  const types = TYPE_FILTERS.find((t) => t.value === typeFilter)?.types ?? [];
  const valid = Boolean(from && to && from <= to);
  const [page, setPage] = useResettingPage([from, to, productId, typeFilter, debounced, sort]);
  const q = useQuery({
    queryKey: ['movements', 'history', from, to, productId, typeFilter, debounced, sort, page],
    queryFn: () => listMovements({ from, to, productId, types: types.length ? types : ALL_TYPES, search: debounced, sort, page }),
    enabled: valid,
    placeholderData: (p) => p,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<History className="size-5" />}
        title="Stock Movement History"
        description="Every Stock-In, Stock-Out, sales deduction and authorized adjustment, with the previous and new quantity, reference number and responsible user."
      />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-2 xl:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            From
            <input type="date" className="input h-10" value={from} max={today} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            To
            <input type="date" className="input h-10" value={to} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </label>
          <div className="xl:col-span-2">
            <ProductCombobox products={products.data ?? []} value={productId} onChange={setProductId} label="Product" allowAll showStock={false} />
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Movement type
            <select className="input h-10" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Movement type">
              {TYPE_FILTERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Sort
            <select className="input h-10" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort movements">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="quantity">Largest quantity</option>
            </select>
          </label>
          <SearchInput value={search} onChange={setSearch} className="md:col-span-2 xl:col-span-6" placeholder="Search product, movement ID (e.g. IN-000012), reference no., user, remarks…" />
        </div>
        {!valid ? (
          <p className="p-6 text-sm text-red-600">The start date must be before the end date.</p>
        ) : q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock />
        ) : (
          <HistoryTable rows={q.data?.rows ?? []} onReverse={setReversing} />
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      </Card>
      <ReverseDialog movement={reversing} onClose={() => setReversing(null)} />
    </div>
  );
}
