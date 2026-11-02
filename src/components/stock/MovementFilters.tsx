import { useEffect, useMemo } from 'react';
import { parseISO } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { buildPeriod, shiftPeriod, toISODate, type PeriodType, type ReportPeriod } from '@/lib/periods';
import { MOVEMENT_LABELS } from '@/lib/format';
import type { MovementType } from '@/lib/types';
import { useCategories, useProductOptions } from '@/hooks/data';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { Tabs } from '../ui/Display';
import { ProductCombobox } from './ProductCombobox';

export interface MovementFilterState {
  period: ReportPeriod;
  categoryId: number | null;
  productId: number | null;
  movementType: MovementType | '';
}

export function defaultFilterState(type: PeriodType, today: string): MovementFilterState {
  return { period: buildPeriod(type, today), categoryId: null, productId: null, movementType: '' };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function PeriodPicker({ period, onChange, allowTypes = true, today }: {
  period: ReportPeriod;
  onChange: (p: ReportPeriod) => void;
  allowTypes?: boolean;
  today: string;
}) {
  const anchor = parseISO(period.anchor);
  const year = anchor.getFullYear();
  const thisYear = parseISO(today).getFullYear();
  const years = useMemo(() => Array.from({ length: 12 }, (_, i) => thisYear - 10 + i), [thisYear]);
  const atFuture = period.to >= today;

  return (
    <div className="space-y-3">
      {allowTypes && (
        <Tabs<PeriodType>
          value={period.type}
          onChange={(t) => onChange(buildPeriod(t, period.anchor > today ? today : period.anchor))}
          tabs={[
            { id: 'daily', label: 'Daily' },
            { id: 'weekly', label: 'Weekly' },
            { id: 'monthly', label: 'Monthly' },
            { id: 'yearly', label: 'Yearly' },
          ]}
        />
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Button variant="outline" size="icon" onClick={() => onChange(shiftPeriod(period, -1))} aria-label="Previous period">
          <ChevronLeft className="size-4" />
        </Button>
        {(period.type === 'daily' || period.type === 'weekly') && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            {period.type === 'daily' ? 'Date' : 'Any day in the week'}
            <input
              type="date"
              className="input w-44"
              value={period.anchor}
              max={today}
              onChange={(e) => e.target.value && onChange(buildPeriod(period.type, e.target.value))}
              aria-label={period.type === 'daily' ? 'Select date' : 'Select a day in the week'}
            />
          </label>
        )}
        {period.type === 'monthly' && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Month
            <select
              className="input w-40"
              value={anchor.getMonth()}
              aria-label="Select month"
              onChange={(e) => onChange(buildPeriod('monthly', toISODate(new Date(year, Number(e.target.value), 1))))}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i}>{m}</option>
              ))}
            </select>
          </label>
        )}
        {(period.type === 'monthly' || period.type === 'yearly') && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Year
            <select
              className="input w-28"
              value={year}
              aria-label="Select year"
              onChange={(e) => onChange(buildPeriod(period.type, toISODate(new Date(Number(e.target.value), period.type === 'monthly' ? anchor.getMonth() : 0, 1))))}
            >
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        )}
        <Button variant="outline" size="icon" onClick={() => onChange(shiftPeriod(period, 1))} disabled={atFuture} aria-label="Next period">
          <ChevronRight className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(buildPeriod(period.type, today))} icon={<CalendarDays className="size-4" />}>
          {period.type === 'daily' ? 'Today' : period.type === 'weekly' ? 'This week' : period.type === 'monthly' ? 'This month' : 'This year'}
        </Button>
      </div>
      <p className="text-sm font-semibold text-brand-800" data-testid="period-label">{period.label}</p>
    </div>
  );
}

/**
 * Category → Product dependent filters (+ movement type). Selecting a category
 * restricts the product list to that category; changing the category clears a
 * product that does not belong to it.
 */
export function CategoryProductFilters({ value, onChange, showType = true }: {
  value: MovementFilterState;
  onChange: (v: MovementFilterState) => void;
  showType?: boolean;
}) {
  const categories = useCategories();
  const products = useProductOptions(value.categoryId, true);

  useEffect(() => {
    if (value.productId && products.data && !products.data.some((p) => p.id === value.productId)) {
      onChange({ ...value, productId: null });
    }
  }, [products.data, value, onChange]);

  return (
    <div className={`grid gap-3 sm:grid-cols-2 ${showType ? 'xl:grid-cols-3' : ''}`}>
      <Select
        label="Category"
        value={value.categoryId ?? ''}
        onChange={(e) => onChange({ ...value, categoryId: e.target.value ? Number(e.target.value) : null, productId: null })}
      >
        <option value="">All categories</option>
        {categories.data?.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </Select>
      <ProductCombobox
        label={value.categoryId ? 'Product (in selected category)' : 'Product'}
        products={products.data ?? []}
        value={value.productId}
        onChange={(id) => onChange({ ...value, productId: id })}
        allowAll
        allLabel={value.categoryId ? 'All products in category' : 'All products'}
        disabled={products.isLoading}
      />
      {showType && (
        <Select label="Movement type" value={value.movementType} onChange={(e) => onChange({ ...value, movementType: e.target.value as MovementType | '' })}>
          <option value="">All movement types</option>
          {(Object.keys(MOVEMENT_LABELS) as MovementType[]).map((t) => (
            <option key={t} value={t}>{MOVEMENT_LABELS[t]}</option>
          ))}
        </Select>
      )}
    </div>
  );
}

export function useFilterDescription(v: MovementFilterState) {
  const categories = useCategories();
  const products = useProductOptions(v.categoryId, true);
  const cat = categories.data?.find((c) => c.id === v.categoryId)?.name;
  const prod = products.data?.find((p) => p.id === v.productId);
  const parts = [
    v.period.label,
    cat ? `Category: ${cat}` : 'All categories',
    prod ? `Product: ${prod.name} (${prod.sku})` : 'All products',
  ];
  if (v.movementType) parts.push(`Type: ${MOVEMENT_LABELS[v.movementType]}`);
  return { text: parts.join(' · '), categoryName: cat, product: prod };
}
