import { useMemo } from 'react';
import { parseISO } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { buildPeriod, shiftPeriod, toISODate, type PeriodType, type ReportPeriod } from '@/lib/periods';
import { Button } from '../ui/Button';
import { Tabs } from '../ui/Display';

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
