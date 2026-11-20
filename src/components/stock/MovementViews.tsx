import { clsx } from 'clsx';
import { Undo2 } from 'lucide-react';
import type { MovementType, StockMovement } from '@/lib/types';
import { fmtDateTime, fmtInt, fmtSigned, MOVEMENT_LABELS, MOVEMENT_TONES } from '@/lib/format';
import { Badge, EmptyState, TableWrap } from '../ui/Display';
import { Button } from '../ui/Button';

export function MovementTypeBadge({ type }: { type: MovementType }) {
  return <Badge tone={MOVEMENT_TONES[type]}>{MOVEMENT_LABELS[type]}</Badge>;
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
                <span className="block font-mono text-[11px]">{m.movement_no}</span>
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
