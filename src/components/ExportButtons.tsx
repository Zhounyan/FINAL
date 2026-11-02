import { useState } from 'react';
import { FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { exportExcel, exportPdf, printReport, type ExportColumn, type ExportMeta } from '@/lib/export';
import { errorMessage } from '@/lib/errors';
import { Button } from './ui/Button';

export interface ExportPayload<T> {
  rows: T[];
  columns: ExportColumn<T>[];
  meta: ExportMeta;
}

/** PDF / Excel / Print buttons. `build` may fetch the complete (unpaginated) data set. */
export function ExportButtons<T>({ build, disabled }: { build: () => Promise<ExportPayload<T>>; disabled?: boolean }) {
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | 'print' | null>(null);
  const run = async (kind: 'pdf' | 'xlsx' | 'print') => {
    setBusy(kind);
    try {
      const p = await build();
      if (kind === 'pdf') await exportPdf(p.rows, p.columns, p.meta);
      else if (kind === 'xlsx') await exportExcel(p.rows, p.columns, p.meta);
      else await printReport(p.rows, p.columns, p.meta);
      if (kind !== 'print') toast.success(`${kind === 'pdf' ? 'PDF' : 'Excel'} report downloaded.`);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not generate the report.'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="no-print flex flex-wrap gap-2">
      <Button variant="outline" size="sm" icon={<FileText className="size-4 text-red-600" />} loading={busy === 'pdf'} disabled={disabled || Boolean(busy)} onClick={() => run('pdf')}>
        PDF
      </Button>
      <Button variant="outline" size="sm" icon={<FileSpreadsheet className="size-4 text-emerald-700" />} loading={busy === 'xlsx'} disabled={disabled || Boolean(busy)} onClick={() => run('xlsx')}>
        Excel
      </Button>
      <Button variant="outline" size="sm" icon={<Printer className="size-4" />} loading={busy === 'print'} disabled={disabled || Boolean(busy)} onClick={() => run('print')}>
        Print
      </Button>
    </div>
  );
}
