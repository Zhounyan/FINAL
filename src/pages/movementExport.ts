import type { ExportColumn } from '@/lib/export';
import { fmtSigned, MOVEMENT_LABELS } from '@/lib/format';
import { rowLabel } from '@/lib/periods';
import type { BreakdownRow, PeriodSummaryRow, StockMovement } from '@/lib/types';
import { format, parseISO } from 'date-fns';

export const summaryColumns = (bucket: 'day' | 'month'): ExportColumn<PeriodSummaryRow>[] => [
  { header: bucket === 'month' ? 'Month' : 'Date', value: (r) => rowLabel(r.period_start, bucket) },
  { header: 'Beginning Stock', value: (r) => Number(r.beginning_stock), numeric: true },
  { header: 'Stock In', dashZero: true, value: (r) => Number(r.stock_in), numeric: true },
  { header: 'Stock Sold', dashZero: true, value: (r) => Number(r.stock_sold), numeric: true },
  { header: 'Other Out', dashZero: true, value: (r) => Number(r.other_out), numeric: true },
  { header: 'Adjustments', dashZero: true, value: (r) => Number(r.adjustments), numeric: true },
  { header: 'Ending Stock', value: (r) => Number(r.ending_stock), numeric: true },
];

export const breakdownColumns = (group: 'product' | 'category'): ExportColumn<BreakdownRow>[] => [
  { header: group === 'product' ? 'Product' : 'Category', value: (r) => r.group_name },
  ...(group === 'product'
    ? ([
        { header: 'SKU', value: (r) => r.sku ?? '' },
        { header: 'Category', value: (r) => r.category_name ?? '' },
      ] as ExportColumn<BreakdownRow>[])
    : []),
  { header: 'Beginning', value: (r) => Number(r.beginning_stock), numeric: true },
  { header: 'Received', dashZero: true, value: (r) => Number(r.stock_in), numeric: true },
  { header: 'Sold', dashZero: true, value: (r) => Number(r.stock_sold), numeric: true },
  { header: 'Other Out', dashZero: true, value: (r) => Number(r.other_out), numeric: true },
  { header: 'Adjusted', dashZero: true, value: (r) => Number(r.adjustments), numeric: true },
  { header: 'Ending', value: (r) => Number(r.ending_stock), numeric: true },
];

export const movementColumns: ExportColumn<StockMovement>[] = [
  { header: 'Date & Time', value: (m) => format(parseISO(m.occurred_at), 'yyyy-MM-dd HH:mm') },
  { header: 'Type', value: (m) => MOVEMENT_LABELS[m.movement_type] },
  { header: 'Product', value: (m) => m.product_name, wrap: true },
  { header: 'SKU', value: (m) => m.product_sku },
  { header: 'Category', value: (m) => m.category_name },
  { header: 'Before', value: (m) => m.quantity_before, numeric: true },
  { header: 'Change', value: (m) => fmtSigned(m.quantity_change), align: 'right' },
  { header: 'After', value: (m) => m.quantity_after, numeric: true },
  { header: 'Supplier / Customer', value: (m) => m.supplier_name ?? m.customer_name ?? '', wrap: true },
  { header: 'Reference', value: (m) => m.reference_no ?? '' },
  { header: 'Reason', value: (m) => m.reason ?? '', wrap: true },
  { header: 'Recorded by', value: (m) => m.created_by_name },
];
