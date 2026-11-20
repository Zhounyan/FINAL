import { describe, expect, it } from 'vitest';
import { quickCashAmounts } from '@/pages/POSPage';
import { buildInvoiceDoc } from './invoice';
import { buildDocumentDocx, renderHtml } from './documents';
import { money2 } from './format';
import type { Sale, SaleItem, StoreSettings } from './types';

const sale: Sale = {
  id: 7,
  reference_no: 'TXN-20261120-00007',
  invoice_no: 'INV-000007',
  customer_name: null,
  sold_at: '2026-11-20T03:15:00Z',
  item_count: 2,
  total_quantity: 3,
  subtotal: 160,
  discount_amount: 10,
  total_amount: 150,
  payment_method: 'cash',
  payment_reference: null,
  amount_received: 200,
  change_amount: 50,
  status: 'completed',
  payment_status: 'paid',
  created_by_name: 'Maria Cashier',
  voided_at: null,
  voided_by_name: null,
  void_reason: null,
};
const items: SaleItem[] = [
  { id: 1, sale_id: 7, product_id: 1, product_name: 'Cola 1L', product_sku: 'BEV-001', quantity: 2, unit_price: 55, line_total: 110 },
  { id: 2, sale_id: 7, product_id: 2, product_name: 'Rice <5kg>', product_sku: 'FOOD-001', quantity: 1, unit_price: 50, line_total: 50 },
];
const settings: StoreSettings = {
  store_name: 'Bill Store',
  store_address: 'Quezon City',
  store_contact: '0917',
  currency: 'PHP',
  timezone: 'Asia/Manila',
  default_min_stock: 10,
  payment_methods: ['cash', 'gcash'],
  cashier_max_discount_pct: 0,
  invoice_footer: 'Thank you!',
  store_tin: '123-456',
};

describe('POS cash buttons', () => {
  it('offers the exact amount and the next convenient bills', () => {
    expect(quickCashAmounts(137)).toEqual([137, 140, 150, 200, 500]);
    expect(quickCashAmounts(500)).toEqual([500, 1000]);
    expect(quickCashAmounts(0)).toEqual([]);
  });
  it('rounds peso amounts to centavos without float drift', () => {
    expect(money2(0.1 + 0.2)).toBe(0.3);
    expect(money2(3 * 33.33)).toBe(99.99);
  });
});

describe('sales invoice', () => {
  it('contains the real transaction, cashier, items and totals', () => {
    const doc = buildInvoiceDoc(sale, items, settings, 'Admin');
    expect(doc.title).toBe('SALES INVOICE');
    expect(doc.storeLines).toContain('TIN: 123-456');
    const kv = doc.sections[0];
    expect(kv.kind === 'kv' && kv.rows).toEqual(expect.arrayContaining([['Invoice No.', 'INV-000007'], ['Cashier', 'Maria Cashier'], ['Customer', 'Walk-in customer']]));
    const table = doc.sections[1];
    expect(table.kind === 'table' && table.rows.length).toBe(2);
    const totals = doc.sections[2];
    expect(totals.kind === 'totals' && totals.rows.map((r) => r.label)).toEqual(['Subtotal', 'Discount', 'TOTAL AMOUNT', 'Amount received', 'Change']);
    expect(doc.stamp).toBeUndefined();
  });
  it('marks voided invoices', () => {
    const doc = buildInvoiceDoc({ ...sale, status: 'voided', payment_status: 'refunded', voided_at: sale.sold_at, voided_by_name: 'Admin', void_reason: 'Wrong item' }, items, settings);
    expect(doc.stamp).toBe('VOID');
    expect(doc.sections.some((s) => s.kind === 'note' && s.text.includes('Wrong item'))).toBe(true);
  });
  it('escapes product names in the printable HTML', () => {
    const html = renderHtml(buildInvoiceDoc(sale, items, settings), null);
    expect(html).toContain('Rice &lt;5kg&gt;');
    expect(html).not.toContain('Rice <5kg>');
  });
  it('builds an editable Word document with the invoice text', async () => {
    const blob = await buildDocumentDocx(buildInvoiceDoc(sale, items, settings));
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('INV-000007');
    expect(xml).toContain('Maria Cashier');
    expect(xml).toContain('Cola 1L');
  });
});
