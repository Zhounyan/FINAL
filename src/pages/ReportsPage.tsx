import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { FileBarChart } from 'lucide-react';
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
import type { ExportColumn } from '@/lib/export';
import { code, fmtDate, fmtInt, fmtMoney, fmtSigned } from '@/lib/format';
import { buildPeriod, clampToToday, type PeriodType } from '@/lib/periods';
import type { MovementType, ProductRow, StockMovement } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useSettings, useStoreToday, useResettingPage } from '@/hooks/data';
import { Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';
import { CategoryProductFilters, PeriodPicker, useFilterDescription, type MovementFilterState } from '@/components/stock/MovementFilters';
import { ExportButtons } from '@/components/ExportButtons';
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
  { header: 'Product', value: (p) => p.name },
  { header: 'SKU', value: (p) => p.sku },
  { header: 'Category', value: (p) => p.category_name },
  { header: 'Unit', value: (p) => p.unit },
  { header: 'Stock', value: (p) => p.current_stock, numeric: true },
  { header: 'Min Level', value: (p) => p.min_stock_level, numeric: true },
  { header: 'Status', value: (p) => (p.stock_status === 'out' ? 'Out of stock' : p.stock_status === 'low' ? 'Low stock' : 'In stock') },
  ...(financial ? ([{ header: 'Cost Value', value: (p) => Number(p.stock_value), numeric: true }] as ExportColumn<ProductRow>[]) : []),
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
      let rows = filterProducts(await listAllProducts({ categoryId: f.categoryId }));
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
      const rows = filterProducts(await listAllProducts({ categoryId: f.categoryId })).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const cols: ExportColumn<ProductRow>[] = [
        { header: 'Product ID', value: (p) => code('PRD', p.id) },
        { header: 'Product', value: (p) => p.name },
        { header: 'SKU / Barcode', value: (p) => p.sku },
        { header: 'Category', value: (p) => p.category_name },
        { header: 'Unit', value: (p) => p.unit },
        ...(financial ? ([{ header: 'Purchase Price', value: (p) => Number(p.purchase_price), numeric: true }] as ExportColumn<ProductRow>[]) : []),
        { header: 'Selling Price', value: (p) => Number(p.selling_price), numeric: true },
        { header: 'Stock', value: (p) => p.current_stock, numeric: true },
        { header: 'Min Level', value: (p) => p.min_stock_level, numeric: true },
        { header: 'Date Added', value: (p) => fmtDate(p.created_at) },
        { header: 'Last Updated', value: (p) => fmtDate(p.updated_at) },
      ];
      return { rows, columns: cols as ExportColumn<never>[], summary: [{ label: 'Products', value: fmtInt(rows.length) }] };
    }
    case 'category': {
      const [cats, products] = await Promise.all([listCategories(), listAllProducts()]);
      const rows = cats.map((c) => {
        const ps = products.filter((p) => p.category_id === c.id);
        return {
          name: c.name,
          products: ps.length,
          units: ps.reduce((a, p) => a + p.current_stock, 0),
          low: ps.filter((p) => p.stock_status === 'low').length,
          out: ps.filter((p) => p.stock_status === 'out').length,
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
        ...(financial ? ([{ header: 'Cost Value', value: (r) => r.value, numeric: true }] as ExportColumn<R>[]) : []),
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
          { header: 'Unit Price', value: (m) => Number(m.unit_price ?? 0), numeric: true },
          { header: 'Amount', value: (m) => Math.abs(m.quantity_change) * Number(m.unit_price ?? 0), numeric: true },
          { header: 'Customer', value: (m) => m.customer_name ?? 'Walk-in' },
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
          { header: 'Reason', value: (m) => m.reason ?? '' },
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
          { header: 'Full Name', value: (c: { full_name: string }) => c.full_name },
          { header: 'Contact Number', value: (c: { contact_number: string | null }) => c.contact_number ?? '' },
          { header: 'Email', value: (c: { email: string | null }) => c.email ?? '' },
          { header: 'Address', value: (c: { address: string | null }) => c.address ?? '' },
          { header: 'Purchases', value: (c: { sale_count?: number }) => Number(c.sale_count ?? 0), numeric: true },
          { header: 'Units Bought', value: (c: { total_quantity?: number }) => Number(c.total_quantity ?? 0), numeric: true },
          { header: 'Total Spent', value: (c: { total_amount?: number }) => Number(c.total_amount ?? 0), numeric: true },
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
          { header: 'Supplier', value: (s: { name: string }) => s.name },
          { header: 'Contact Person', value: (s: { contact_person: string | null }) => s.contact_person ?? '' },
          { header: 'Contact Number', value: (s: { contact_number: string | null }) => s.contact_number ?? '' },
          { header: 'Email', value: (s: { email: string | null }) => s.email ?? '' },
          { header: 'Address', value: (s: { address: string | null }) => s.address ?? '' },
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
      <PageHeader icon={<FileBarChart className="size-5" />} title="Reports" description="Business reports generated from live database records. Print, or export to PDF and Excel." />
      <div className="grid gap-6 xl:grid-cols-[300px_1fr]">
        <Card title="Report type" bodyClassName="p-2">
          <select className="input m-2 w-[calc(100%-1rem)] xl:hidden" value={reportId} onChange={(e) => setParams({ type: e.target.value })} aria-label="Select report">
            {REPORTS.map((r, i) => <option key={r.id} value={r.id}>{i + 1}. {r.title}</option>)}
          </select>
          <nav className="hidden space-y-3 xl:block" aria-label="Reports">
            {groups.map((g) => (
              <div key={g}>
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{g}</p>
                {REPORTS.filter((r) => r.group === g).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setParams({ type: r.id })}
                    className={clsx('block w-full rounded-lg px-3 py-2 text-left text-sm transition', r.id === reportId ? 'bg-brand-800 font-medium text-white' : 'text-ink hover:bg-brand-50')}
                    aria-current={r.id === reportId}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card bodyClassName="p-4 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-ink">{def.title} Report</h2>
                <p className="text-sm text-muted">{def.description}</p>
              </div>
              <ExportButtons
                disabled={!q.data}
                build={async () => ({
                  rows,
                  columns: cols,
                  meta: {
                    title: `${def.title} Report`,
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

          {q.data?.summary && q.data.summary.length > 0 && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {q.data.summary.map((s) => (
                <div key={s.label} className="rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
                  <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{s.label}</p>
                  <p className="mt-1 text-lg font-bold text-ink tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>
          )}

          <Card title={subtitle} subtitle={`${fmtInt(rows.length)} row(s)`}>
            {q.isError ? (
              <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
            ) : q.isLoading ? (
              <LoadingBlock rows={8} />
            ) : rows.length === 0 ? (
              <EmptyState title="No records" message="Nothing matches the selected report filters." />
            ) : (
              <TableWrap>
                <table className="table-base" data-testid="report-table">
                  <thead>
                    <tr>{cols.map((c) => <th key={c.header} className={c.numeric || c.align === 'right' ? 'num' : ''}>{c.header}</th>)}</tr>
                  </thead>
                  <tbody>
                    {visible.map((r, i) => (
                      <tr key={i}>
                        {cols.map((c) => {
                          const v = c.value(r);
                          const isMoney = /price|amount|value|spent|cost/i.test(c.header);
                          return (
                            <td key={c.header} className={c.numeric || c.align === 'right' ? 'num' : ''}>
                              {c.numeric ? (isMoney ? fmtMoney(v as number) : fmtInt(v as number)) : (v ?? '')}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            <Pagination page={page} pageSize={PREVIEW_PAGE} total={rows.length} onChange={setPage} />
          </Card>
        </div>
      </div>
    </div>
  );
}
