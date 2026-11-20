import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Eye, FileDown, FileText, Printer, Receipt, ReceiptText } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { useDebounce, useInvalidateInventory, useResettingPage, useSettings } from '@/hooks/data';
import { getSale, listCashiers, listSales, logInvoiceAction, PAGE_SIZE, voidSale, type SalesQuery } from '@/lib/api';
import { buildInvoiceDoc } from '@/lib/invoice';
import { exportDocumentDocx, exportDocumentPdf, printDocument } from '@/lib/documents';
import { errorMessage } from '@/lib/errors';
import { ALL_PAYMENT_METHODS, fmtDateTime, fmtInt, fmtMoney, paymentLabel } from '@/lib/format';
import type { Sale } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Field';
import { LoadingBlock } from '@/components/ui/Spinner';
import { InvoiceModal } from '@/components/sales/InvoiceModal';

type Mode = 'transactions' | 'invoices';

export function StatusBadge({ sale }: { sale: Pick<Sale, 'status'> }) {
  return sale.status === 'completed' ? <Badge tone="green">Completed</Badge> : <Badge tone="red">Voided</Badge>;
}

export default function SalesListPage({ mode }: { mode: Mode }) {
  const { can, profile } = useAuth();
  const settings = useSettings();
  const qc = useQueryClient();
  const invalidate = useInvalidateInventory();
  const all = can.viewAllTransactions;
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cashierId, setCashierId] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState<'' | 'completed' | 'voided'>('');
  const [sort, setSort] = useState<NonNullable<SalesQuery['sort']>>('newest');
  const debounced = useDebounce(search);
  const filters = { debounced, from, to, cashierId, method, status, sort };
  const [page, setPage] = useResettingPage(filters);
  const [viewing, setViewing] = useState<number | null>(null);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const cashiers = useQuery({ queryKey: ['users', 'cashiers'], queryFn: listCashiers, enabled: all, staleTime: 60_000 });
  const q = useQuery({
    queryKey: ['sales', 'list', filters, page],
    queryFn: () =>
      listSales({ search: debounced, from: from || null, to: to || null, cashierId: cashierId || null, paymentMethod: method || null, status: status || null, sort, page }),
    placeholderData: (p) => p,
  });

  const voidM = useMutation({
    mutationFn: () => voidSale(voiding!.id, reason),
    onSuccess: async (s) => {
      toast.success(`${s.reference_no} voided. The items were returned to stock.`);
      setVoiding(null);
      setViewing(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['sale'] });
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const quick = async (sale: Sale, kind: 'print' | 'pdf' | 'docx') => {
    setBusy(`${sale.id}-${kind}`);
    try {
      const { sale: s, items } = await getSale(sale.id);
      const doc = buildInvoiceDoc(s, items, settings.data, profile?.full_name);
      if (kind === 'print') await printDocument(doc);
      if (kind === 'pdf') await exportDocumentPdf(doc);
      if (kind === 'docx') await exportDocumentDocx(doc);
      await logInvoiceAction(s.id, kind === 'print' ? 'printed' : kind === 'pdf' ? 'exported_pdf' : 'exported_docx');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const title = mode === 'transactions' ? (all ? 'Sales Transactions' : 'My Transaction History') : all ? 'Sales Invoices' : 'My Invoices';
  const description =
    mode === 'transactions'
      ? all
        ? 'Every completed and voided sale, with cashier, payment and totals. Finalized sales are never deleted.'
        : 'Sales you completed. Only your own transactions are shown.'
      : all
        ? 'Invoice history. View, print or export any invoice — reprinting never creates a new sale.'
        : 'Invoices for your own sales. Print or save them as PDF or Word.';

  const viewingSale = q.data?.rows.find((r) => r.id === viewing);

  return (
    <div className="space-y-6">
      <PageHeader icon={mode === 'transactions' ? <Receipt className="size-5" /> : <ReceiptText className="size-5" />} title={title} description={description} />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <SearchInput value={search} onChange={setSearch} className="sm:col-span-2" placeholder={mode === 'invoices' ? 'Invoice no., customer, product…' : 'Transaction no., customer, product…'} />
          <input type="date" className="input h-10" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" title="From date" />
          <input type="date" className="input h-10" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" title="To date" />
          {all && (
            <select className="input h-10" value={cashierId} onChange={(e) => setCashierId(e.target.value)} aria-label="Filter by cashier">
              <option value="">All cashiers</option>
              {cashiers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </select>
          )}
          <select className="input h-10" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Filter by payment method">
            <option value="">All payments</option>
            {ALL_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {paymentLabel(m)}
              </option>
            ))}
          </select>
          <select className="input h-10" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="completed">Completed</option>
            <option value="voided">Voided</option>
          </select>
          <select className="input h-10" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount_desc">Highest amount</option>
            <option value="amount_asc">Lowest amount</option>
          </select>
        </div>
        {q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock />
        ) : !q.data?.rows.length ? (
          <EmptyState title="No sales found" message="Completed sales from the Point of Sale appear here." />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="sales-table">
              <thead>
                <tr>
                  <th>{mode === 'invoices' ? 'Invoice no.' : 'Transaction no.'}</th>
                  <th>Date &amp; time</th>
                  {all && <th>Cashier</th>}
                  <th>Customer</th>
                  <th className="num">Items</th>
                  {mode === 'transactions' && <th className="num">Discount</th>}
                  <th className="num">Total</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="font-mono text-sm font-semibold">{mode === 'invoices' ? s.invoice_no : s.reference_no}</span>
                      <span className="block font-mono text-[11px] text-muted">{mode === 'invoices' ? s.reference_no : s.invoice_no}</span>
                    </td>
                    <td className="text-xs whitespace-nowrap">{fmtDateTime(s.sold_at)}</td>
                    {all && <td className="whitespace-nowrap">{s.created_by_name}</td>}
                    <td>{s.customer_name ?? <span className="text-muted">Walk-in</span>}</td>
                    <td className="num">{fmtInt(s.total_quantity)}</td>
                    {mode === 'transactions' && <td className="num">{s.discount_amount > 0 ? fmtMoney(s.discount_amount) : '—'}</td>}
                    <td className="num font-semibold">{fmtMoney(s.total_amount)}</td>
                    <td className="whitespace-nowrap">{paymentLabel(s.payment_method)}</td>
                    <td>
                      <StatusBadge sale={s} />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" onClick={() => setViewing(s.id)} aria-label={`View ${s.invoice_no}`} title="View invoice">
                        <Eye className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" loading={busy === `${s.id}-print`} onClick={() => quick(s, 'print')} aria-label={`Print ${s.invoice_no}`} title="Print invoice">
                        {busy === `${s.id}-print` ? null : <Printer className="size-4" />}
                      </Button>
                      {mode === 'invoices' && (
                        <>
                          <Button variant="ghost" size="icon" loading={busy === `${s.id}-pdf`} onClick={() => quick(s, 'pdf')} aria-label={`Download PDF of ${s.invoice_no}`} title="Export PDF">
                            {busy === `${s.id}-pdf` ? null : <FileDown className="size-4" />}
                          </Button>
                          <Button variant="ghost" size="icon" loading={busy === `${s.id}-docx`} onClick={() => quick(s, 'docx')} aria-label={`Download Word file of ${s.invoice_no}`} title="Export Word">
                            {busy === `${s.id}-docx` ? null : <FileText className="size-4" />}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      </Card>

      <InvoiceModal
        saleId={viewing}
        onClose={() => setViewing(null)}
        extraFooter={
          can.voidTransactions && viewingSale?.status === 'completed' ? (
            <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setVoiding(viewingSale)}>
              Void transaction
            </Button>
          ) : undefined
        }
      />

      <Modal
        open={voiding != null}
        onClose={() => setVoiding(null)}
        busy={voidM.isPending}
        title={`Void ${voiding?.reference_no ?? ''}?`}
        description="The sale stays on record marked VOID, its items go back to stock, and it no longer counts in sales reports."
        footer={
          <>
            <Button variant="outline" onClick={() => setVoiding(null)} disabled={voidM.isPending}>
              Keep sale
            </Button>
            <Button variant="danger" loading={voidM.isPending} disabled={!reason.trim()} onClick={() => voidM.mutate()}>
              Void transaction
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">
          Total {fmtMoney(voiding?.total_amount)} · {paymentLabel(voiding?.payment_method)} · Cashier {voiding?.created_by_name}
        </p>
        <Textarea label="Reason for voiding" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  );
}
