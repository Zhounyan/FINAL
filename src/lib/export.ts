import { format } from 'date-fns';
import { fmtMoney } from './format';
import interRegularUrl from '@/assets/fonts/Inter-Regular.ttf?url';
import interBoldUrl from '@/assets/fonts/Inter-Bold.ttf?url';

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** numeric columns are written as numbers in Excel */
  numeric?: boolean;
  /** peso amounts: shown as ₱1,234.00, saved as peso-formatted numbers in Excel */
  money?: boolean;
  /** long text (names, reasons, addresses) may wrap; everything else stays on one line */
  wrap?: boolean;
  /** movement flows: a 0 is shown as a quiet dash on screen (exports keep the 0) */
  dashZero?: boolean;
}

export interface ExportMeta {
  title: string;
  subtitle?: string;
  storeName: string;
  generatedBy?: string;
  /** label/value pairs printed above the table */
  summary?: { label: string; value: string | number }[];
  fileName?: string;
}

/** Text shown for a cell on screen and in PDFs: ₱ for money, thousands separators for numbers. */
export function displayCell<T>(c: ExportColumn<T>, row: T): string {
  const v = cell(c, row);
  if (typeof v === 'number') return c.money ? fmtMoney(v) : v.toLocaleString('en-US');
  return v;
}

const PESO_FORMAT = '"₱"#,##0.00';

/** Gives money cells a peso number format so Excel shows ₱ and can still add them up. */
function formatMoneyCells<T>(
  XLSX: typeof import('xlsx'),
  ws: import('xlsx').WorkSheet,
  columns: ExportColumn<T>[],
  firstDataRow: number,
  rowCount: number,
) {
  columns.forEach((c, ci) => {
    if (!c.money) return;
    for (let r = firstDataRow; r < firstDataRow + rowCount; r++) {
      const ref = XLSX.utils.encode_cell({ r, c: ci });
      const target = ws[ref];
      if (target && target.t === 'n') target.z = PESO_FORMAT;
    }
  });
}

// ---------------------------------------------------------------------------
// PDF font: jsPDF's built-in fonts cannot print ₱ or −, so embed Inter.
// ---------------------------------------------------------------------------
export const PDF_FONT = 'Inter';
let fontCache: Promise<{ regular: string; bold: string }> | null = null;

async function toBase64(url: string): Promise<string> {
  const buf = await (await fetch(url)).arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function registerPdfFont(doc: import('jspdf').jsPDF) {
  fontCache ??= Promise.all([toBase64(interRegularUrl), toBase64(interBoldUrl)]).then(([regular, bold]) => ({ regular, bold }));
  const { regular, bold } = await fontCache;
  doc.addFileToVFS('Inter-Regular.ttf', regular);
  doc.addFont('Inter-Regular.ttf', PDF_FONT, 'normal');
  doc.addFileToVFS('Inter-Bold.ttf', bold);
  doc.addFont('Inter-Bold.ttf', PDF_FONT, 'bold');
  doc.setFont(PDF_FONT, 'normal');
}

/** autoTable column settings: aligned numbers, short columns never wrap, headers aligned like their data. */
function tableColumnStyles<T>(columns: ExportColumn<T>[]) {
  return Object.fromEntries(
    columns.map((c, i) => [
      i,
      { halign: c.align ?? (c.numeric || c.money ? 'right' : 'left'), cellWidth: c.wrap ? 'auto' : 'wrap' },
    ]),
  ) as Record<number, { halign: 'left' | 'right' | 'center'; cellWidth: 'auto' | 'wrap' }>;
}

function alignHeaders<T>(columns: ExportColumn<T>[]) {
  return (data: { section: string; column: { index: number }; cell: { styles: { halign: string } } }) => {
    if (data.section !== 'head') return;
    const c = columns[data.column.index];
    if (c) data.cell.styles.halign = c.align ?? (c.numeric || c.money ? 'right' : 'left');
  };
}

function safeFileName(meta: ExportMeta, ext: string): string {
  const base = (meta.fileName ?? meta.title).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${base || 'report'}-${format(new Date(), 'yyyyMMdd-HHmm')}.${ext}`;
}

function cell<T>(c: ExportColumn<T>, row: T): string | number {
  const v = c.value(row);
  if (v === null || v === undefined) return '';
  if (c.numeric || c.money) {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
}

/** Builds an .xlsx workbook (write-only use of SheetJS: no untrusted file parsing). */
export async function exportExcel<T>(rows: T[], columns: ExportColumn<T>[], meta: ExportMeta): Promise<void> {
  const XLSX = await import('xlsx');
  const header: (string | number)[][] = [
    [meta.storeName],
    [meta.title],
    ...(meta.subtitle ? [[meta.subtitle]] : []),
    [`Generated ${format(new Date(), 'MMM d, yyyy h:mm a')}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}`],
    ...(meta.summary?.length ? [[], ...meta.summary.map((s) => [s.label, s.value])] : []),
    [],
  ];
  const body = [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => cell(c, r)))];
  const ws = XLSX.utils.aoa_to_sheet([...header, ...body]);
  formatMoneyCells(XLSX, ws, columns, header.length + 1, rows.length);
  ws['!cols'] = columns.map((c) => ({
    wch: Math.min(48, Math.max(c.header.length + 2, ...rows.slice(0, 200).map((r) => displayCell(c, r).length + 2))),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, meta.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  XLSX.writeFile(wb, safeFileName(meta, 'xlsx'));
}

let logoCache: string | null = null;
export async function logoDataUrl(): Promise<string | null> {
  if (logoCache) return logoCache;
  try {
    const res = await fetch('/logo-192.png');
    const blob = await res.blob();
    logoCache = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    return logoCache;
  } catch {
    return null;
  }
}

async function buildPdf<T>(rows: T[], columns: ExportColumn<T>[], meta: ExportMeta) {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default;
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  await registerPdfFont(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 36;

  const logo = await logoDataUrl();
  if (logo) doc.addImage(logo, 'PNG', margin, 26, 44, 44);
  const tx = margin + (logo ? 54 : 0);
  doc.setTextColor(27, 74, 43);
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(15);
  doc.text(meta.storeName, tx, 42);
  doc.setFontSize(9);
  doc.setFont(PDF_FONT, 'normal');
  doc.setTextColor(90, 100, 95);
  doc.text('INVPORTIQ · Inventory Management & Business Intelligence', tx, 56);
  doc.text(`Generated ${format(new Date(), 'MMM d, yyyy h:mm a')}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}`, tx, 68);

  doc.setTextColor(20, 30, 25);
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(13);
  doc.text(meta.title, margin, 96);
  let y = 96;
  if (meta.subtitle) {
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(70, 80, 75);
    y += 14;
    doc.text(doc.splitTextToSize(meta.subtitle, pageWidth - margin * 2), margin, y);
  }
  if (meta.summary?.length) {
    y += 10;
    autoTable(doc, {
      startY: y,
      body: meta.summary.map((s) => [s.label, String(s.value)]),
      theme: 'plain',
      styles: { font: PDF_FONT, fontSize: 9, cellPadding: 2.5 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150 } },
      margin: { left: margin, right: margin },
      tableWidth: 360,
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  }

  autoTable(doc, {
    startY: y + 12,
    head: [columns.map((c) => c.header)],
    body: rows.map((r) => columns.map((c) => displayCell(c, r))),
    styles: { font: PDF_FONT, fontSize: 8.5, cellPadding: { top: 4, bottom: 4, left: 5, right: 5 }, overflow: 'linebreak', valign: 'middle', lineColor: [227, 229, 220], lineWidth: { bottom: 0.5 } },
    headStyles: { fillColor: [27, 74, 43], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [243, 247, 241] },
    columnStyles: tableColumnStyles(columns),
    didParseCell: alignHeaders(columns),
    margin: { left: margin, right: margin, bottom: 40 },
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(8);
      doc.setTextColor(130);
      doc.text(`${meta.storeName} · ${meta.title}`, margin, h - 20);
      const pageNo = `Page ${doc.getCurrentPageInfo().pageNumber}`;
      doc.text(pageNo, pageWidth - margin - doc.getTextWidth(pageNo), h - 20);
    },
  });
  if (rows.length === 0) {
    doc.setFontSize(10);
    doc.text('No records for the selected filters.', margin, y + 60);
  }
  return doc;
}

export async function exportPdf<T>(rows: T[], columns: ExportColumn<T>[], meta: ExportMeta): Promise<void> {
  const doc = await buildPdf(rows, columns, meta);
  doc.save(safeFileName(meta, 'pdf'));
}

/** Opens the report as a print-ready PDF in a new tab and triggers the print dialog. */
export async function printReport<T>(rows: T[], columns: ExportColumn<T>[], meta: ExportMeta): Promise<void> {
  const win = window.open('', '_blank');
  const doc = await buildPdf(rows, columns, meta);
  doc.autoPrint();
  const url = doc.output('bloburl');
  if (win) win.location.href = String(url);
  else window.location.href = String(url);
}
