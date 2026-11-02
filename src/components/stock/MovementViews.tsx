import { clsx } from 'clsx';
import { ArrowDownToLine, ArrowUpFromLine, Equal, PackageMinus, ShoppingCart, SlidersHorizontal, Undo2, Warehouse } from 'lucide-react';
import type { MovementType, PeriodSummaryRow, StockMovement } from '@/lib/types';
import { fmtDateTime, fmtInt, fmtSigned, MOVEMENT_LABELS, MOVEMENT_TONES } from '@/lib/format';
import { rowLabel } from '@/lib/periods';
import { Badge, EmptyState, TableWrap } from '../ui/Display';
import { Button } from '../ui/Button';

export function MovementTypeBadge({ type }: { type: MovementType }) {
  return <Badge tone={MOVEMENT_TONES[type]}>{MOVEMENT_LABELS[type]}</Badge>;
}

export interface SummaryTotals {
  beginning_stock: number;
  stock_in: number;
  stock_sold: number;
  other_out: number;
  adjustments: number;
  ending_stock: number;
}

export function totalsOf(rows: PeriodSummaryRow[] | undefined): SummaryTotals | null {
  if (!rows || rows.length === 0) return null;
  const sum = (k: keyof PeriodSummaryRow) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  return {
    beginning_stock: Number(rows[0].beginning_stock),
    stock_in: sum('stock_in'),
    stock_sold: sum('stock_sold'),
    other_out: sum('other_out'),
    adjustments: sum('adjustments'),
    ending_stock: Number(rows[rows.length - 1].ending_stock),
  };
}

const CARDS = [
  { key: 'beginning_stock', label: 'Beginning Stock', icon: Warehouse, cls: 'from-slate-50 to-white text-slate-800', iconCls: 'bg-slate-200 text-slate-700', sign: '' },
  { key: 'stock_in', label: 'Stock In', icon: ArrowDownToLine, cls: 'from-emerald-50 to-white text-emerald-800', iconCls: 'bg-emerald-100 text-emerald-700', sign: '+' },
  { key: 'stock_sold', label: 'Stock Sold', icon: ShoppingCart, cls: 'from-sky-50 to-white text-sky-800', iconCls: 'bg-sky-100 text-sky-700', sign: '−' },
  { key: 'other_out', label: 'Other Stock Out', icon: PackageMinus, cls: 'from-amber-50 to-white text-amber-800', iconCls: 'bg-amber-100 text-amber-700', sign: '−' },
  { key: 'adjustments', label: 'Adjustments', icon: SlidersHorizontal, cls: 'from-violet-50 to-white text-violet-800', iconCls: 'bg-violet-100 text-violet-700', sign: '±' },
  { key: 'ending_stock', label: 'Ending Stock', icon: Equal, cls: 'from-brand-100 to-brand-50 text-brand-900', iconCls: 'bg-brand-800 text-white', sign: '' },
] as const;

/** Beginning + In − Sold − Other ± Adjustments = Ending */
export function SummaryCards({ totals, loading }: { totals: SummaryTotals | null; loading?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="summary-cards">
      {CARDS.map((c) => {
        const raw = totals ? Number(totals[c.key]) : null;
        const display =
          raw === null ? '—' : c.key === 'adjustments' ? fmtSigned(raw) : c.sign === '+' ? `+${fmtInt(raw)}` : c.sign === '−' && raw > 0 ? `−${fmtInt(raw)}` : fmtInt(raw);
        return (
          <div key={c.key} className={clsx('rounded-2xl border border-line bg-gradient-to-br p-4 shadow-card', c.cls, c.key === 'ending_stock' && 'ring-1 ring-brand-300')}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold tracking-wide uppercase opacity-80">{c.label}</p>
              <span className={clsx('flex size-8 items-center justify-center rounded-lg', c.iconCls)}>
                <c.icon className="size-4" />
              </span>
            </div>
            <p className={clsx('mt-2 text-2xl font-bold tabular-nums', loading && 'animate-pulse opacity-50')} data-testid={`card-${c.key}`}>
              {display}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function FormulaNote() {
  return (
    <p className="text-xs text-muted">
      <b>Ending Stock</b> = Beginning Stock + Stock In − Stock Sold − Other Stock Out ± Adjustments. Values are calculated from the recorded stock movement ledger.
    </p>
  );
}

export function PeriodSummaryTable({ rows, bucket, totals }: { rows: PeriodSummaryRow[]; bucket: 'day' | 'month'; totals: SummaryTotals | null }) {
  if (!rows.length) return <EmptyState title="No data for this period" />;
  return (
    <TableWrap>
      <table className="table-base" data-testid="period-table">
        <thead>
          <tr>
            <th>{bucket === 'month' ? 'Month' : 'Date'}</th>
            <th className="num">Beginning Stock</th>
            <th className="num">Stock In</th>
            <th className="num">Stock Sold</th>
            <th className="num">Other Out</th>
            <th className="num">Adjustments</th>
            <th className="num">Ending Stock</th>
            <th className="num">Entries</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period_start} className={clsx(Number(r.movement_count) === 0 && 'text-muted')}>
              <td className="font-medium whitespace-nowrap">{rowLabel(r.period_start, bucket)}</td>
              <td className="num">{fmtInt(r.beginning_stock)}</td>
              <td className="num text-emerald-700">{Number(r.stock_in) ? `+${fmtInt(r.stock_in)}` : '0'}</td>
              <td className="num text-sky-700">{Number(r.stock_sold) ? `−${fmtInt(r.stock_sold)}` : '0'}</td>
              <td className="num text-amber-700">{Number(r.other_out) ? `−${fmtInt(r.other_out)}` : '0'}</td>
              <td className="num text-violet-700">{fmtSigned(r.adjustments)}</td>
              <td className="num font-semibold">{fmtInt(r.ending_stock)}</td>
              <td className="num">{fmtInt(r.movement_count)}</td>
            </tr>
          ))}
        </tbody>
        {totals && rows.length > 1 && (
          <tfoot>
            <tr>
              <td>Period total</td>
              <td className="num">{fmtInt(totals.beginning_stock)}</td>
              <td className="num">+{fmtInt(totals.stock_in)}</td>
              <td className="num">−{fmtInt(totals.stock_sold)}</td>
              <td className="num">−{fmtInt(totals.other_out)}</td>
              <td className="num">{fmtSigned(totals.adjustments)}</td>
              <td className="num">{fmtInt(totals.ending_stock)}</td>
              <td className="num">{fmtInt(rows.reduce((a, r) => a + Number(r.movement_count), 0))}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </TableWrap>
  );
}

export function MovementTable({ rows, onReverse, compact }: { rows: StockMovement[]; onReverse?: (m: StockMovement) => void; compact?: boolean }) {
  if (!rows.length) return <EmptyState title="No stock movements" message="No inventory activity matches the selected filters." />;
  return (
    <TableWrap>
      <table className="table-base" data-testid="movement-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Type</th>
            <th>Product</th>
            {!compact && <th>Category</th>}
            <th className="num">Before</th>
            <th className="num">Qty</th>
            <th className="num">After</th>
            {!compact && <th>Party / Reference</th>}
            <th>Reason</th>
            <th>Recorded by</th>
            {onReverse && <th className="no-print"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="text-xs whitespace-nowrap text-muted">
                {fmtDateTime(m.occurred_at)}
                <span className="block text-[11px]">#{m.id}</span>
              </td>
              <td>
                <MovementTypeBadge type={m.movement_type} />
                {m.reverses_movement_id && <span className="mt-1 block text-[11px] text-muted">Reverses #{m.reverses_movement_id}</span>}
                {m.reversed_by_id && <span className="mt-1 block text-[11px] text-red-600">Reversed by #{m.reversed_by_id}</span>}
              </td>
              <td className="min-w-40">
                <span className="font-medium">{m.product_name}</span>
                <span className="block text-xs text-muted">{m.product_sku}</span>
              </td>
              {!compact && <td className="text-sm whitespace-nowrap">{m.category_name}</td>}
              <td className="num text-muted">{fmtInt(m.quantity_before)}</td>
              <td className={clsx('num font-semibold', m.quantity_change > 0 ? 'text-emerald-700' : 'text-red-600')}>{fmtSigned(m.quantity_change)}</td>
              <td className="num font-medium">{fmtInt(m.quantity_after)}</td>
              {!compact && (
                <td className="text-xs">
                  {m.supplier_name && <span className="block">Supplier: {m.supplier_name}</span>}
                  {m.customer_name && <span className="block">Customer: {m.customer_name}</span>}
                  {m.reference_no && <span className="block text-muted">Ref: {m.reference_no}</span>}
                  {!m.supplier_name && !m.customer_name && !m.reference_no && '—'}
                </td>
              )}
              <td className="max-w-56 text-xs text-muted">{m.reason ?? '—'}</td>
              <td className="text-xs whitespace-nowrap">{m.created_by_name}</td>
              {onReverse && (
                <td className="no-print text-right">
                  {['stock_in', 'damaged', 'lost', 'other_out', 'adjustment'].includes(m.movement_type) && !m.reverses_movement_id && !m.reversed_by_id && (
                    <Button variant="ghost" size="sm" onClick={() => onReverse(m)} icon={<Undo2 className="size-3.5" />} title="Record a reversing adjustment">
                      Reverse
                    </Button>
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

export function InOutIcon({ positive }: { positive: boolean }) {
  return positive ? <ArrowDownToLine className="size-4" /> : <ArrowUpFromLine className="size-4" />;
}
