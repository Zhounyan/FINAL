import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileBarChart, FileSpreadsheet, FileText, Files, Printer } from 'lucide-react';
import { toast } from 'sonner';
import {
  listAllProducts,
  listCategories,
  listCustomers,
  listMovements,
  listSuppliers,
  movementBreakdown,
  movementSummary,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { displayCell, exportExcelBundle, exportPdfBundle, printBundle, type ExportColumn, type ReportSection } from '@/lib/export';
import { code, fmtDate, fmtInt, fmtMoney, fmtSigned } from '@/lib/format';
import { buildPeriod, clampToToday, type PeriodType } from '@/lib/periods';
import type { MovementType, ProductRow, StockMovement } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useSettings, useStoreToday, useResettingPage } from '@/hooks/data';
import { Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { CategoryProductFilters, PeriodPicker, useFilterDescription, type MovementFilterState } from '@/components/stock/MovementFilters';
import { ExportButtons } from '@/components/ExportButtons';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { breakdownColumns, movementColumns, summaryColumns } from './movementExport';

type ReportId =
  | 'inventory_summary' | 'product' | 'category' | 'low_stock' | 'out_of_stock'
  | 'stock_in' | 'stock_sold' | 'other_out' | 'adjustments'
  | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'category_movement' | 'product_movement'
  | 'customer' | 'supplier';

interface ReportDef {
  id: ReportId;
  title: string;
  group: 'Inventory' | 'Stock movements' | 'Periodic movement' | 'Customers & suppliers';
  description: string;
  /** which filters apply */
  period?: 'any' | PeriodType;
  categoryProduct?: boolean;
  search?: boolean;
}

const REPORTS: ReportDef[] = [
  { id: 'inventory_summary', group: 'Inventory', title: 'Inventory Summary', description: 'Current quantity and value of every active product.', categoryProduct: true, search: true },
  { id: 'product', group: 'Inventory', title: 'Product Report', description: 'Product catalogue with prices, thresholds and dates.', categoryProduct: true, search: true },
  { id: 'category', group: 'Inventory', title: 'Category Report', description: 'Products, units and value per category.' },
  { id: 'low_stock', group: 'Inventory', title: 'Low Stock Report', description: 'Products at or below their minimum level.', categoryProduct: true },
  { id: 'out_of_stock', group: 'Inventory', title: 'Out-of-Stock Report', description: 'Products with zero units on hand.', categoryProduct: true },
  { id: 'stock_in', group: 'Stock movements', title: 'Stock-In Report', description: 'All stock received in a period.', period: 'any', categoryProduct: true, search: true },
  { id: 'stock_sold', group: 'Stock movements', title: 'Stock-Sold Report', description: 'Units sold and sales value in a period.', period: 'any', categoryProduct: true, search: true },
  { id: 'other_out', group: 'Stock movements', title: 'Other Stock-Out Report', description: 'Damaged, lost and other releases.', period: 'any', categoryProduct: true, search: true },
  { id: 'adjustments', group: 'Stock movements', title: 'Stock Adjustment Report', description: 'Previous / adjusted / new quantities with reasons.', period: 'any', categoryProduct: true, search: true },
  { id: 'daily', group: 'Periodic movement', title: 'Daily Stock Movement', description: 'Beginning, in, sold, other out and ending for a day.', period: 'daily', categoryProduct: true },
  { id: 'weekly', group: 'Periodic movement', title: 'Weekly Stock Movement', description: 'Day-by-day movement for a week.', period: 'weekly', categoryProduct: true },
  { id: 'monthly', group: 'Periodic movement', title: 'Monthly Stock Movement', description: 'Day-by-day movement for a month.', period: 'monthly', categoryProduct: true },
  { id: 'yearly', group: 'Periodic movement', title: 'Yearly Stock Movement', description: 'Month-by-month movement for a year.', period: 'yearly', categoryProduct: true },
  { id: 'category_movement', group: 'Periodic movement', title: 'Category-Based Stock Movement', description: 'Movement totals for each category.', period: 'any', categoryProduct: true },
  { id: 'product_movement', group: 'Periodic movement', title: 'Product-Specific Stock Movement', description: 'Per-product totals, or full entries for one product.', period: 'any', categoryProduct: true },
  { id: 'customer', group: 'Customers & suppliers', title: 'Customer Report', description: 'Customers with purchase counts and totals.', search: true },
  { id: 'supplier', group: 'Customers & suppliers', title: 'Supplier Report', description: 'Suppliers with deliveries and units supplied.', search: true },
];

interface ReportResult {
  rows: unknown[];
  columns: ExportColumn<never>[];
  summary?: { label: string; value: string | number }[];
}

const MOVEMENT_TYPES: Partial<Record<ReportId, MovementType[]>> = {
  stock_in: ['stock_in'],
  stock_sold: ['sale'],
  other_out: ['damaged', 'lost', 'other_out'],
  adjustments: ['adjustment'],
};

const productColumns = (financial: boolean): ExportColumn<ProductRow>[] => [
  { header: 'Product ID', value: (p) => code('PRD', p.id) },
  { header: 'Product', value: (p) => p.name, wrap: true },
  { header: 'SKU', value: (p) => p.sku },
  { header: 'Category', value: (p) => p.category_name },
  { header: 'Unit', value: (p) => p.unit },
  { header: 'Stock', value: (p) => p.current_stock, numeric: true },
  { header: 'Min Level', value: (p) => p.min_stock_level, numeric: true },
  { header: 'Status', value: (p) => (p.is_archived ? 'Inactive' : p.stock_status === 'out' ? 'Out of stock' : p.stock_status === 'low' ? 'Low stock' : 'In stock') },
  ...(financial ? ([{ header: 'Cost Value', value: (p) => Number(p.stock_value), money: true }] as ExportColumn<ProductRow>[]) : []),
];

async function loadReport(id: ReportId, f: MovementFilterState, search: string, financial: boolean): Promise<ReportResult> {
  const base = { from: f.period.from, to: f.period.to, categoryId: f.categoryId, productId: f.productId };
  const filterProducts = (rows: ProductRow[]) =>
    rows.filter(
      (p) =>
        (!f.productId || p.id === f.productId) &&
        (!search || `${p.name} ${p.sku} ${p.category_name}`.toLowerCase().includes(search.toLowerCase())),
    );

  switch (id) {
    case 'inventory_summary':
    case 'low_stock':
    case 'out_of_stock': {
      // Inactive products keep their stock, so they stay in the inventory summary; alerts cover active products only.
      let rows = filterProducts(await listAllProducts({ categoryId: f.categoryId, includeArchived: id === 'inventory_summary' }));
      if (id === 'low_stock') rows = rows.filter((p) => p.stock_status === 'low');
      if (id === 'out_of_stock') rows = rows.filter((p) => p.stock_status === 'out');
      if (id !== 'inventory_summary') rows.sort((a, b) => a.current_stock - b.current_stock || a.name.localeCompare(b.name));
      const qty = rows.reduce((a, p) => a + p.current_stock, 0);
      return {
        rows,
        columns: productColumns(financial) as ExportColumn<never>[],
        summary: [
          { label: 'Products', value: fmtInt(rows.length) },
          { label: 'Total units', value: fmtInt(qty) },
          ...(financial ? [{ label: 'Inventory value (cost)', value: fmtMoney(rows.reduce((a, p) => a + Number(p.stock_value), 0)) }] : []),
        ],
      };
    }
    case 'product': {
      const rows = filterProducts(await listAllProducts({ categoryId: f.categoryId, includeArchived: true })).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const cols: ExportColumn<ProductRow>[] = [
        { header: 'Product ID', value: (p) => code('PRD', p.id) },
        { header: 'Product', value: (p) => p.name, wrap: true },
        { header: 'SKU / Barcode', value: (p) => p.sku },
        { header: 'Category', value: (p) => p.category_name },
        { header: 'Unit', value: (p) => p.unit },
        ...(financial ? ([{ header: 'Purchase Price', value: (p) => Number(p.purchase_price), money: true }] as ExportColumn<ProductRow>[]) : []),
        { header: 'Selling Price', value: (p) => Number(p.selling_price), money: true },
        { header: 'Stock', value: (p) => p.current_stock, numeric: true },
        { header: 'Min Level', value: (p) => p.min_stock_level, numeric: true },
        { header: 'Date Added', value: (p) => fmtDate(p.created_at) },
        { header: 'Last Updated', value: (p) => fmtDate(p.updated_at) },
        { header: 'Status', value: (p) => (p.is_archived ? 'Inactive' : 'Active') },
      ];
      return { rows, columns: cols as ExportColumn<never>[], summary: [{ label: 'Products', value: fmtInt(rows.length) }] };
    }
    case 'category': {
      const [cats, products] = await Promise.all([listCategories(), listAllProducts({ includeArchived: true })]);
      const rows = cats.map((c) => {
        const ps = products.filter((p) => p.category_id === c.id);
        return {
          name: c.name,
          products: ps.filter((p) => !p.is_archived).length,
          units: ps.reduce((a, p) => a + p.current_stock, 0),
          low: ps.filter((p) => !p.is_archived && p.stock_status === 'low').length,
          out: ps.filter((p) => !p.is_archived && p.stock_status === 'out').length,
          value: ps.reduce((a, p) => a + Number(p.stock_value), 0),
        };
      });
      type R = (typeof rows)[number];
      const cols: ExportColumn<R>[] = [
        { header: 'Category', value: (r) => r.name },
        { header: 'Active Products', value: (r) => r.products, numeric: true },
        { header: 'Units on Hand', value: (r) => r.units, numeric: true },
        { header: 'Low Stock', value: (r) => r.low, numeric: true },
        { header: 'Out of Stock', value: (r) => r.out, numeric: true },
        ...(financial ? ([{ header: 'Cost Value', value: (r) => r.value, money: true }] as ExportColumn<R>[]) : []),
      ];
      return { rows, columns: cols as ExportColumn<never>[], summary: [{ label: 'Categories', value: rows.length }] };
    }
    case 'stock_in':
    case 'stock_sold':
    case 'other_out':
    case 'adjustments': {
      const { rows } = await listMovements({ ...base, types: MOVEMENT_TYPES[id], search, page: 1, pageSize: 5000 });
      const units = rows.reduce((a, m) => a + Math.abs(m.quantity_change), 0);
      let cols: ExportColumn<StockMovement>[] = movementColumns;
      const summary: { label: string; value: string | number }[] = [{ label: 'Entries', value: fmtInt(rows.length) }];
      if (id === 'stock_sold') {
        cols = [
          ...movementColumns.slice(0, 5),
          { header: 'Qty Sold', value: (m) => Math.abs(m.quantity_change), numeric: true },
          { header: 'Unit Price', value: (m) => Number(m.unit_price ?? 0), money: true },
          { header: 'Amount', value: (m) => Math.abs(m.quantity_change) * Number(m.unit_price ?? 0), money: true },
          { header: 'Customer', value: (m) => m.customer_name ?? 'Walk-in', wrap: true },
          { header: 'Reference', value: (m) => m.reference_no ?? '' },
          { header: 'Recorded by', value: (m) => m.created_by_name },
        ];
        summary.push({ label: 'Units sold', value: fmtInt(units) });
        summary.push({ label: 'Sales value', value: fmtMoney(rows.reduce((a, m) => a + Math.abs(m.quantity_change) * Number(m.unit_price ?? 0), 0)) });
      } else if (id === 'adjustments') {
        cols = [
          movementColumns[0],
          movementColumns[2],
          movementColumns[3],
          { header: 'Previous Qty', value: (m) => m.quantity_before, numeric: true },
          { header: 'Adjustment', value: (m) => fmtSigned(m.quantity_change), align: 'right' },
          { header: 'New Qty', value: (m) => m.quantity_after, numeric: true },
          { header: 'Reason', value: (m) => m.reason ?? '', wrap: true },
          { header: 'Recorded by', value: (m) => m.created_by_name },
        ];
        summary.push({ label: 'Net adjustment', value: fmtSigned(rows.reduce((a, m) => a + m.quantity_change, 0)) });
      } else {
        summary.push({ label: id === 'stock_in' ? 'Units received' : 'Units released', value: fmtInt(units) });
      }
      return { rows, columns: cols as ExportColumn<never>[], summary };
    }
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'yearly': {
      const rows = await movementSummary({ ...base, bucket: f.period.bucket });
      const sum = (k: 'stock_in' | 'stock_sold' | 'other_out' | 'adjustments') => rows.reduce((a, r) => a + Number(r[k]), 0);
      return {
        rows,
        columns: summaryColumns(f.period.bucket) as ExportColumn<never>[],
        summary: rows.length
          ? [
              { label: 'Beginning Stock', value: fmtInt(rows[0].beginning_stock) },
              { label: 'Stock In', value: `+${fmtInt(sum('stock_in'))}` },
              { label: 'Stock Sold', value: `-${fmtInt(sum('stock_sold'))}` },
              { label: 'Other Stock Out', value: `-${fmtInt(sum('other_out'))}` },
              { label: 'Adjustments', value: fmtSigned(sum('adjustments')) },
              { label: 'Ending Stock', value: fmtInt(rows[rows.length - 1].ending_stock) },
            ]
          : [],
      };
    }
    case 'category_movement':
    case 'product_movement': {
      if (id === 'product_movement' && f.productId) {
        const [entries, summary] = await Promise.all([
          listMovements({ ...base, page: 1, pageSize: 5000 }),
          movementSummary({ ...base, bucket: f.period.bucket }),
        ]);
        const sum = (k: 'stock_in' | 'stock_sold' | 'other_out' | 'adjustments') => summary.reduce((a, r) => a + Number(r[k]), 0);
        return {
          rows: entries.rows,
          columns: movementColumns as ExportColumn<never>[],
          summary: summary.length
            ? [
                { label: 'Beginning Quantity', value: fmtInt(summary[0].beginning_stock) },
                { label: 'Quantity Received', value: `+${fmtInt(sum('stock_in'))}` },
                { label: 'Quantity Sold', value: `-${fmtInt(sum('stock_sold'))}` },
                { label: 'Other Quantity Released', value: `-${fmtInt(sum('other_out'))}` },
                { label: 'Quantity Adjusted', value: fmtSigned(sum('adjustments')) },
                { label: 'Ending Quantity', value: fmtInt(summary[summary.length - 1].ending_stock) },
              ]
            : [],
        };
      }
      const group = id === 'category_movement' ? 'category' : 'product';
      const rows = await movementBreakdown({ ...base, group });
      return {
        rows,
        columns: breakdownColumns(group) as ExportColumn<never>[],
        summary: [
          { label: group === 'category' ? 'Categories' : 'Products', value: rows.length },
          { label: 'Total ending stock', value: fmtInt(rows.reduce((a, r) => a + Number(r.ending_stock), 0)) },
        ],
      };
    }
    case 'customer': {
      const { rows, total } = await listCustomers({ search, page: 1, pageSize: 5000 });
      return {
        rows,
        columns: [
          { header: 'Customer ID', value: (c: { id: number }) => code('CUS', c.id) },
          { header: 'Full Name', value: (c: { full_name: string }) => c.full_name, wrap: true },
          { header: 'Contact Number', value: (c: { contact_number: string | null }) => c.contact_number ?? '' },
          { header: 'Email', value: (c: { email: string | null }) => c.email ?? '' },
          { header: 'Address', value: (c: { address: string | null }) => c.address ?? '', wrap: true },
          { header: 'Purchases', value: (c: { sale_count?: number }) => Number(c.sale_count ?? 0), numeric: true },
          { header: 'Units Bought', value: (c: { total_quantity?: number }) => Number(c.total_quantity ?? 0), numeric: true },
          { header: 'Total Spent', value: (c: { total_amount?: number }) => Number(c.total_amount ?? 0), money: true },
          { header: 'Date Added', value: (c: { created_at: string }) => fmtDate(c.created_at) },
        ] as ExportColumn<never>[],
        summary: [{ label: 'Customers', value: fmtInt(total) }],
      };
    }
    case 'supplier': {
      const { rows, total } = await listSuppliers({ search, page: 1, pageSize: 5000 });
      return {
        rows,
        columns: [
          { header: 'Supplier ID', value: (s: { id: number }) => code('SUP', s.id) },
          { header: 'Supplier', value: (s: { name: string }) => s.name, wrap: true },
          { header: 'Contact Person', value: (s: { contact_person: string | null }) => s.contact_person ?? '', wrap: true },
          { header: 'Contact Number', value: (s: { contact_number: string | null }) => s.contact_number ?? '' },
          { header: 'Email', value: (s: { email: string | null }) => s.email ?? '' },
          { header: 'Address', value: (s: { address: string | null }) => s.address ?? '', wrap: true },
          { header: 'Deliveries', value: (s: { delivery_count?: number }) => Number(s.delivery_count ?? 0), numeric: true },
          { header: 'Units Supplied', value: (s: { total_quantity?: number }) => Number(s.total_quantity ?? 0), numeric: true },
          { header: 'Date Added', value: (s: { created_at: string }) => fmtDate(s.created_at) },
        ] as ExportColumn<never>[],
        summary: [{ label: 'Suppliers', value: fmtInt(total) }],
      };
    }
  }
}

const PREVIEW_PAGE = 50;

/** A movement column whose value is 0 (shown as a quiet dash on screen; exports keep 0). */
function cell0(c: ExportColumn<unknown>, row: unknown) {
  return Number(c.value(row as never)) === 0;
}

/** Rows with no movement at all (e.g. quiet days in a monthly report) are shown in muted text. */
function isQuietRow(cols: ExportColumn<unknown>[], row: unknown) {
  const flows = cols.filter((c) => c.dashZero);
  return flows.length > 0 && flows.every((c) => cell0(c, row));
}

/** Numbers and money right-aligned; long text may wrap; everything else stays on one line. */
function cellClass(c: ExportColumn<unknown>) {
  if (c.numeric || c.money || c.align === 'right') return 'num';
  return c.wrap ? 'min-w-28 max-w-60 whitespace-normal' : 'whitespace-nowrap';
}

/** "Low Stock Report" stays as is; "Inventory Summary" becomes "Inventory Summary Report". */
const reportTitle = (def: ReportDef) => (/report$/i.test(def.title) ? def.title : `${def.title} Report`);

export default function ReportsPage() {
  const { can, profile } = useAuth();
  const settings = useSettings();
  const today = useStoreToday();
  const [params, setParams] = useSearchParams();
  const reportId = (REPORTS.some((r) => r.id === params.get('type')) ? params.get('type') : 'inventory_summary') as ReportId;
  const def = REPORTS.find((r) => r.id === reportId)!;
  const [rawFilters, setFilters] = useState<MovementFilterState>(() => ({
    period: buildPeriod('monthly', today),
    categoryId: null,
    productId: null,
    movementType: '',
  }));
  const [search, setSearch] = useState('');
  const [bundleOpen, setBundleOpen] = useState(false);
  const debounced = useDebounce(search);

  // Fixed-period reports force their period type (derived, not stored).
  const filters: MovementFilterState =
    def.period && def.period !== 'any' && rawFilters.period.type !== def.period
      ? { ...rawFilters, period: buildPeriod(def.period, rawFilters.period.anchor) }
      : rawFilters;
  const describe = useFilterDescription(filters);
  const [page, setPage] = useResettingPage([reportId, filters, debounced]);

  const q = useQuery({
    queryKey: ['reports', reportId, filters.period.from, filters.period.to, filters.period.bucket, filters.categoryId, filters.productId, debounced, can.viewFinancials],
    queryFn: () => loadReport(reportId, { ...filters, period: clampToToday(filters.period, today) }, def.search ? debounced : '', can.viewFinancials),
  });

  const subtitle = (() => {
    const parts: string[] = [];
    if (def.period) parts.push(filters.period.label);
    if (def.categoryProduct) {
      parts.push(describe.categoryName ? `Category: ${describe.categoryName}` : 'All categories');
      parts.push(describe.product ? `Product: ${describe.product.name}` : 'All products');
    }
    if (def.search && debounced) parts.push(`Search: "${debounced}"`);
    if (!def.period) parts.push(`As of ${fmtDate(new Date())}`);
    return parts.join(' · ');
  })();

  const groups = Array.from(new Set(REPORTS.map((r) => r.group)));
  const rows = q.data?.rows ?? [];
  const cols = (q.data?.columns ?? []) as ExportColumn<unknown>[];
  const visible = rows.slice((page - 1) * PREVIEW_PAGE, page * PREVIEW_PAGE);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<FileBarChart className="size-5" />}
        title="Reports"
        description="Business reports generated from live database records. Print, or export to PDF and Excel."
        actions={
          <Button icon={<Files className="size-4" />} onClick={() => setBundleOpen(true)}>
            Export multiple reports
          </Button>
        }
      />
      {bundleOpen && <BundleExportModal today={today} onClose={() => setBundleOpen(false)} />}

      {/* Report picker + filters in one compact card */}
      <Card bodyClassName="p-4 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="w-full max-w-md space-y-1">
            <span className="block text-xs font-medium text-muted">Report</span>
            <select className="input font-medium" value={reportId} onChange={(e) => setParams({ type: e.target.value })} aria-label="Report">
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {REPORTS.filter((r) => r.group === g).map((r) => (
                    <option key={r.id} value={r.id}>{reportTitle(r)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <ExportButtons
            disabled={!q.data}
            build={async () => ({
              rows,
              columns: cols,
              meta: {
                title: reportTitle(def),
                subtitle,
                storeName: settings.data?.store_name ?? 'Bill Store',
                generatedBy: profile?.full_name,
                summary: q.data?.summary,
              },
            })}
          />
        </div>
        {def.period && (
          <PeriodPicker period={filters.period} onChange={(p) => setFilters({ ...filters, period: p })} allowTypes={def.period === 'any'} today={today} />
        )}
        {(def.categoryProduct || def.search) && (
          <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
            {def.categoryProduct ? <CategoryProductFilters value={filters} onChange={setFilters} showType={false} /> : <div />}
            {def.search && (
              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-ink">Search</span>
                <SearchInput value={search} onChange={setSearch} placeholder="Filter rows…" />
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Report: title, key figures, table */}
      <Card bodyClassName="">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3">
          <h2 className="text-base font-bold text-ink" data-testid="report-title">{reportTitle(def)}</h2>
          <p className="text-xs text-muted">
            {subtitle} · {fmtInt(rows.length)} row(s)
          </p>
        </div>
        {q.data?.summary && q.data.summary.length > 0 && (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 border-b border-line bg-brand-50/40 px-4 py-2.5" data-testid="report-summary">
            {q.data.summary.map((x) => (
              <div key={x.label} className="flex items-baseline gap-2">
                <dt className="text-xs text-muted">{x.label}</dt>
                <dd className="text-sm font-bold text-ink tabular-nums">{x.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState title="No records" message="Nothing matches the selected report filters." />
        ) : (
          <TableWrap>
            <table className="table-base table-compact" data-testid="report-table">
              <thead>
                <tr>{cols.map((c) => <th key={c.header} className={cellClass(c)}>{c.header}</th>)}</tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const quiet = isQuietRow(cols, r);
                  return (
                    <tr key={i} className={quiet ? 'text-muted' : undefined}>
                      {cols.map((c) => (
                        <td key={c.header} className={cellClass(c)}>
                          {c.dashZero && cell0(c, r) ? <span className="text-slate-300">–</span> : displayCell(c, r)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={page} pageSize={PREVIEW_PAGE} total={rows.length} onChange={setPage} />
      </Card>
    </div>
  );
}

/**
 * Export several reports at once, into ONE Excel workbook (a tab per report)
 * or ONE PDF (cover page + each report on its own pages). All selected
 * reports share the same period and category/product filters.
 */
function BundleExportModal({ today, onClose }: { today: string; onClose: () => void }) {
  const { can, profile } = useAuth();
  const settings = useSettings();
  const [selected, setSelected] = useState<Set<ReportId>>(() => new Set(REPORTS.map((r) => r.id)));
  const [filters, setFilters] = useState<MovementFilterState>(() => ({
    period: buildPeriod('monthly', today),
    categoryId: null,
    productId: null,
    movementType: '',
  }));
  const describe = useFilterDescription(filters);
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | 'print' | null>(null);
  const [progress, setProgress] = useState('');
  const groups = Array.from(new Set(REPORTS.map((r) => r.group)));
  const count = selected.size;

  const toggle = (id: ReportId) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setGroup = (group: ReportDef['group'], on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      REPORTS.filter((r) => r.group === group).forEach((r) => (on ? next.add(r.id) : next.delete(r.id)));
      return next;
    });

  const run = async (kind: 'xlsx' | 'pdf' | 'print') => {
    const chosen = REPORTS.filter((r) => selected.has(r.id));
    if (!chosen.length) {
      toast.error('Select at least one report.');
      return;
    }
    setBusy(kind);
    try {
      const sections: ReportSection[] = [];
      for (const [i, def] of chosen.entries()) {
        setProgress(`Preparing ${i + 1} of ${chosen.length}: ${def.title}…`);
        // Fixed-period reports use the day / week / month / year containing the chosen date.
        const period = def.period && def.period !== 'any' ? buildPeriod(def.period, filters.period.anchor) : filters.period;
        const res = await loadReport(def.id, { ...filters, period: clampToToday(period, today) }, '', can.viewFinancials);
        const parts: string[] = [];
        if (def.period) parts.push(period.label);
        if (def.categoryProduct) {
          parts.push(describe.categoryName ? `Category: ${describe.categoryName}` : 'All categories');
          parts.push(describe.product ? `Product: ${describe.product.name}` : 'All products');
        }
        if (!def.period) parts.push(`As of ${fmtDate(new Date())}`);
        sections.push({
          title: reportTitle(def),
          subtitle: parts.join(' · '),
          rows: res.rows,
          columns: res.columns as ExportColumn<unknown>[],
          summary: res.summary,
        });
      }
      setProgress(kind === 'xlsx' ? 'Creating Excel file…' : 'Creating PDF…');
      const meta = {
        title: chosen.length === REPORTS.length ? 'Complete Business Report' : 'Combined Report',
        storeName: settings.data?.store_name ?? 'Bill Store',
        generatedBy: profile?.full_name,
        filters: describe.text,
      };
      if (kind === 'xlsx') await exportExcelBundle(sections, meta);
      else if (kind === 'pdf') await exportPdfBundle(sections, meta);
      else await printBundle(sections, meta);
      if (kind !== 'print') toast.success(`${chosen.length} report(s) exported to one ${kind === 'xlsx' ? 'Excel' : 'PDF'} file.`);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not generate the reports.'));
    } finally {
      setBusy(null);
      setProgress('');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={Boolean(busy)}
      size="xl"
      title="Export multiple reports"
      description="Tick the reports you want. They are combined into one file: one Excel workbook (a tab per report) or one PDF."
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted" aria-live="polite">{progress || `${count} of ${REPORTS.length} reports selected`}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" icon={<Printer className="size-4" />} loading={busy === 'print'} disabled={!count || Boolean(busy)} onClick={() => run('print')}>
              Print
            </Button>
            <Button variant="outline" icon={<FileText className="size-4 text-red-600" />} loading={busy === 'pdf'} disabled={!count || Boolean(busy)} onClick={() => run('pdf')}>
              One PDF
            </Button>
            <Button icon={<FileSpreadsheet className="size-4" />} loading={busy === 'xlsx'} disabled={!count || Boolean(busy)} onClick={() => run('xlsx')}>
              One Excel file
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">1. Choose reports</h3>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setSelected(new Set(REPORTS.map((r) => r.id)))}>Select all</Button>
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2" data-testid="bundle-report-list">
            {groups.map((g) => {
              const items = REPORTS.filter((r) => r.group === g);
              const all = items.every((r) => selected.has(r.id));
              return (
                <fieldset key={g} className="rounded-xl border border-line p-3">
                  <legend className="px-1">
                    <label className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
                      <input type="checkbox" className="size-4 accent-brand-700" checked={all} onChange={(e) => setGroup(g, e.target.checked)} />
                      {g}
                    </label>
                  </legend>
                  <div className="space-y-1.5">
                    {items.map((r) => (
                      <label key={r.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-brand-50">
                        <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                        <span>
                          <span className="font-medium text-ink">{r.title}</span>
                          <span className="block text-xs text-muted">{r.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-ink">2. Period &amp; filters (applied to every selected report)</h3>
          <PeriodPicker period={filters.period} onChange={(p) => setFilters({ ...filters, period: p })} today={today} />
          <CategoryProductFilters value={filters} onChange={setFilters} showType={false} />
          <p className="text-xs text-muted">
            The Daily, Weekly, Monthly and Yearly movement reports use the day, week, month and year that contain the selected date. Inventory, customer and
            supplier reports show current figures.
          </p>
        </section>
      </div>
    </Modal>
  );
}
