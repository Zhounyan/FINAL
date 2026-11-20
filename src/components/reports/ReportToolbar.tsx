import { useState } from 'react';
import { toast } from 'sonner';
import { FileDown, FileText, Printer } from 'lucide-react';
import { buildPeriod, type PeriodType, type ReportPeriod } from '@/lib/periods';
import { exportDocumentDocx, exportDocumentPdf, printDocument, type DocModel } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { Button } from '../ui/Button';
import { PeriodPicker } from '../stock/MovementFilters';

export interface ReportRange {
  from: string;
  to: string;
  label: string;
  custom: boolean;
}

/** Period selection for a daily / weekly / monthly report, with an optional custom date range. */
export function useReportRange(type: Exclude<PeriodType, 'yearly'>, today: string) {
  const [period, setPeriod] = useState<ReportPeriod>(() => buildPeriod(type, today));
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const range: ReportRange =
    custom && from && to && from <= to
      ? { from, to, custom: true, label: `${from} to ${to}` }
      : { from: period.from, to: period.to, custom: false, label: period.label };
  return { period, setPeriod, custom, setCustom, from, setFrom, to, setTo, range };
}

export function ReportToolbar({
  state,
  today,
  build,
  disabled,
}: {
  state: ReturnType<typeof useReportRange>;
  today: string;
  build: () => Promise<DocModel>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<null | 'print' | 'pdf' | 'docx'>(null);
  const run = async (kind: 'print' | 'pdf' | 'docx') => {
    setBusy(kind);
    try {
      const doc = await build();
      if (kind === 'print') await printDocument(doc);
      if (kind === 'pdf') await exportDocumentPdf(doc);
      if (kind === 'docx') await exportDocumentDocx(doc);
      if (kind !== 'print') toast.success(`Report saved as ${kind === 'pdf' ? 'PDF' : 'Word'}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card">
      <div className="space-y-2">
        {!state.custom && <PeriodPicker period={state.period} onChange={state.setPeriod} allowTypes={false} today={today} />}
        {state.custom && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              From
              <input type="date" className="input w-44" value={state.from} max={today} onChange={(e) => state.setFrom(e.target.value)} aria-label="Custom range start" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              To
              <input type="date" className="input w-44" value={state.to} max={today} onChange={(e) => state.setTo(e.target.value)} aria-label="Custom range end" />
            </label>
            {state.from > state.to && <span className="text-xs text-red-600">The start date must be before the end date.</span>}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="size-4 accent-brand-700"
            checked={state.custom}
            onChange={(e) => {
              state.setCustom(e.target.checked);
              state.setFrom(state.period.from);
              state.setTo(state.period.to);
            }}
          />
          Custom date range
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" icon={<Printer className="size-4" />} loading={busy === 'print'} disabled={disabled || Boolean(busy)} onClick={() => run('print')}>
          Print
        </Button>
        <Button variant="outline" icon={<FileDown className="size-4" />} loading={busy === 'pdf'} disabled={disabled || Boolean(busy)} onClick={() => run('pdf')}>
          PDF
        </Button>
        <Button variant="outline" icon={<FileText className="size-4" />} loading={busy === 'docx'} disabled={disabled || Boolean(busy)} onClick={() => run('docx')}>
          Word
        </Button>
      </div>
    </div>
  );
}

export function SortableTh({ label, active, dir, onClick, num }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; num?: boolean }) {
  return (
    <th className={num ? 'num' : undefined}>
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 font-semibold uppercase hover:underline">
        {label}
        <span aria-hidden className={active ? 'opacity-100' : 'opacity-30'}>
          {active && dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

export function sortRows<T>(rows: T[], key: keyof T, dir: 'asc' | 'desc'): T[] {
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return dir === 'asc' ? c : -c;
  });
}
