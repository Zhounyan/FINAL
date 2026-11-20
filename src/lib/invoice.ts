import type { DocModel } from './documents';
import { fmtDateTime, fmtInt, fmtMoney, paymentLabel } from './format';
import type { Sale, SaleItem, StoreSettings } from './types';

/** Builds the printable / exportable sales invoice from the saved transaction. */
export function buildInvoiceDoc(sale: Sale, items: SaleItem[], settings: StoreSettings | undefined, generatedBy?: string): DocModel {
  const storeLines = [
    settings?.store_address ?? '',
    settings?.store_contact ? `Contact: ${settings.store_contact}` : '',
    settings?.store_tin ? `TIN: ${settings.store_tin}` : '',
  ];
  const info: [string, string][] = [
    ['Invoice No.', sale.invoice_no],
    ['Transaction No.', sale.reference_no],
    ['Date & time', fmtDateTime(sale.sold_at)],
    ['Cashier', sale.created_by_name],
    ['Customer', sale.customer_name || 'Walk-in customer'],
    ['Payment method', paymentLabel(sale.payment_method) + (sale.payment_reference ? ` (Ref. ${sale.payment_reference})` : '')],
    ['Payment status', sale.payment_status === 'paid' ? 'Paid' : 'Refunded'],
    ['Transaction status', sale.status === 'completed' ? 'Completed' : 'Voided'],
  ];
  const totals: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Subtotal', value: fmtMoney(sale.subtotal) },
    { label: 'Discount', value: sale.discount_amount > 0 ? `-${fmtMoney(sale.discount_amount)}` : fmtMoney(0) },
    { label: 'TOTAL AMOUNT', value: fmtMoney(sale.total_amount), strong: true },
  ];
  if (sale.amount_received != null) totals.push({ label: 'Amount received', value: fmtMoney(sale.amount_received) });
  if (sale.payment_method === 'cash') totals.push({ label: 'Change', value: fmtMoney(sale.change_amount) });

  const sections: DocModel['sections'] = [
    { kind: 'kv', rows: info },
    {
      kind: 'table',
      heading: 'Items purchased',
      columns: [
        { header: '#', align: 'center', width: 26 },
        { header: 'Product' },
        { header: 'Qty', align: 'right', width: 44 },
        { header: 'Unit price', align: 'right', width: 80 },
        { header: 'Subtotal', align: 'right', width: 86 },
      ],
      rows: items.map((it, i) => [String(i + 1), `${it.product_name} (${it.product_sku})`, fmtInt(it.quantity), fmtMoney(it.unit_price), fmtMoney(it.line_total)]),
      footer: ['', `${fmtInt(sale.item_count)} item(s)`, fmtInt(sale.total_quantity), '', fmtMoney(sale.subtotal)],
    },
    { kind: 'totals', rows: totals },
  ];
  if (sale.status === 'voided') {
    sections.push({
      kind: 'note',
      text: `VOIDED on ${fmtDateTime(sale.voided_at)} by ${sale.voided_by_name ?? 'Administrator'}. Reason: ${sale.void_reason ?? '—'}. This invoice is kept for the record and is not valid as proof of payment.`,
    });
  }
  return {
    title: 'SALES INVOICE',
    subtitle: `${sale.invoice_no} · ${sale.reference_no}`,
    storeName: settings?.store_name || 'Bill Store',
    storeLines,
    stamp: sale.status === 'voided' ? 'VOID' : undefined,
    sections,
    footer: settings?.invoice_footer || undefined,
    generatedBy,
    fileName: `${sale.invoice_no}`,
  };
}
