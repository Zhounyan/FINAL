import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileDown, FileText, Printer } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge, ErrorState } from '../ui/Display';
import { LoadingBlock } from '../ui/Spinner';
import { getSale, logInvoiceAction } from '@/lib/api';
import { buildInvoiceDoc } from '@/lib/invoice';
import { exportDocumentDocx, exportDocumentPdf, printDocument } from '@/lib/documents';
import { fmtDateTime, fmtInt, fmtMoney, paymentLabel } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { useSettings } from '@/hooks/data';
import { useAuth } from '@/auth/AuthProvider';

/** Shows a saved invoice. Printing or exporting never creates a new transaction. */
export function InvoiceModal({ saleId, onClose, extraFooter }: { saleId: number | null; onClose: () => void; extraFooter?: React.ReactNode }) {
  const { profile } = useAuth();
  const settings = useSettings();
  const q = useQuery({ queryKey: ['sale', saleId], queryFn: () => getSale(saleId!), enabled: saleId != null });
  const [busy, setBusy] = useState<null | 'print' | 'pdf' | 'docx'>(null);

  const run = async (kind: 'print' | 'pdf' | 'docx') => {
    if (!q.data) return;
    setBusy(kind);
    try {
      const doc = buildInvoiceDoc(q.data.sale, q.data.items, settings.data, profile?.full_name);
      if (kind === 'print') await printDocument(doc);
      if (kind === 'pdf') await exportDocumentPdf(doc);
      if (kind === 'docx') await exportDocumentDocx(doc);
      await logInvoiceAction(q.data.sale.id, kind === 'print' ? 'printed' : kind === 'pdf' ? 'exported_pdf' : 'exported_docx');
      if (kind !== 'print') toast.success(`${q.data.sale.invoice_no} saved as ${kind === 'pdf' ? 'PDF' : 'Word'}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const s = q.data?.sale;
  return (
    <Modal
      open={saleId != null}
      onClose={onClose}
      size="lg"
      title={s ? `Invoice ${s.invoice_no}` : 'Invoice'}
      description={s ? `Transaction ${s.reference_no} · ${fmtDateTime(s.sold_at)}` : undefined}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {extraFooter}
          <Button variant="outline" icon={<Printer className="size-4" />} loading={busy === 'print'} disabled={!s || Boolean(busy)} onClick={() => run('print')}>
            Print Invoice
          </Button>
          <Button variant="outline" icon={<FileDown className="size-4" />} loading={busy === 'pdf'} disabled={!s || Boolean(busy)} onClick={() => run('pdf')}>
            PDF
          </Button>
          <Button variant="outline" icon={<FileText className="size-4" />} loading={busy === 'docx'} disabled={!s || Boolean(busy)} onClick={() => run('docx')}>
            Word
          </Button>
        </div>
      }
    >
      {q.isLoading && <LoadingBlock rows={6} />}
      {q.error && <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {s && q.data && (
        <div className="space-y-4" data-testid="invoice-view">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-brand-50/60 p-4">
            <div>
              <p className="text-lg font-bold text-brand-900">{settings.data?.store_name ?? 'Bill Store'}</p>
              {settings.data?.store_address && <p className="text-xs text-muted">{settings.data.store_address}</p>}
              {settings.data?.store_contact && <p className="text-xs text-muted">Contact: {settings.data.store_contact}</p>}
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold tracking-wide text-muted">SALES INVOICE</p>
              <p className="font-mono text-base font-bold">{s.invoice_no}</p>
              {s.status === 'voided' ? <Badge tone="red">VOID</Badge> : <Badge tone="green">Paid</Badge>}
            </div>
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Info label="Transaction No.">{s.reference_no}</Info>
            <Info label="Date & time">{fmtDateTime(s.sold_at)}</Info>
            <Info label="Cashier">{s.created_by_name}</Info>
            <Info label="Customer">{s.customer_name || 'Walk-in customer'}</Info>
            <Info label="Payment method">
              {paymentLabel(s.payment_method)}
              {s.payment_reference ? ` · Ref. ${s.payment_reference}` : ''}
            </Info>
            <Info label="Payment status">{s.payment_status === 'paid' ? 'Paid' : 'Refunded'}</Info>
          </dl>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <span className="font-medium">{it.product_name}</span>
                      <span className="block text-xs text-muted">{it.product_sku}</span>
                    </td>
                    <td className="num">{fmtInt(it.quantity)}</td>
                    <td className="num">{fmtMoney(it.unit_price)}</td>
                    <td className="num font-semibold">{fmtMoney(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ml-auto max-w-xs space-y-1 text-sm" data-testid="invoice-totals">
            <Row label="Subtotal" value={fmtMoney(s.subtotal)} />
            <Row label="Discount" value={s.discount_amount > 0 ? `-${fmtMoney(s.discount_amount)}` : fmtMoney(0)} />
            <Row label="Total amount" value={fmtMoney(s.total_amount)} strong />
            {s.amount_received != null && <Row label="Amount received" value={fmtMoney(s.amount_received)} />}
            {s.payment_method === 'cash' && <Row label="Change" value={fmtMoney(s.change_amount)} />}
          </div>
          {s.status === 'voided' && (
            <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
              Voided {fmtDateTime(s.voided_at)} by {s.voided_by_name}. Reason: {s.void_reason}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dotted border-line py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'flex justify-between border-t-2 border-brand-800 pt-1.5 text-base font-bold' : 'flex justify-between'}>
      <span className={strong ? '' : 'text-muted'}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
