/**
 * One document model, three outputs: browser print, PDF (jsPDF) and an
 * editable Word file (.docx). Used by sales invoices and the six reports so
 * every format shows exactly the same, real data.
 */
import { format } from 'date-fns';
import { logoDataUrl, PDF_FONT, registerPdfFont } from './export';

export type Align = 'left' | 'right' | 'center';

export type DocSection =
  | { kind: 'kv'; heading?: string; rows: [string, string][]; columns?: 1 | 2 }
  | {
      kind: 'table';
      heading?: string;
      columns: { header: string; align?: Align; width?: number }[];
      rows: string[][];
      footer?: string[];
      emptyText?: string;
    }
  | { kind: 'totals'; rows: { label: string; value: string; strong?: boolean }[] }
  | { kind: 'note'; text: string };

export interface DocModel {
  /** e.g. "SALES INVOICE" or "Daily Sales Report" */
  title: string;
  subtitle?: string;
  storeName: string;
  storeLines?: string[];
  /** large diagonal-free banner, e.g. VOID */
  stamp?: string;
  sections: DocSection[];
  footer?: string;
  generatedBy?: string;
  fileName: string;
  landscape?: boolean;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function safeName(name: string, ext: string) {
  const base = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'document';
  return `${base}.${ext}`;
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// HTML (print)
// ---------------------------------------------------------------------------
export function renderHtml(m: DocModel, logo: string | null): string {
  const sec = m.sections
    .map((s) => {
      const h = 'heading' in s && s.heading ? `<h2>${esc(s.heading)}</h2>` : '';
      if (s.kind === 'kv') {
        const cells = s.rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
        return `${h}<div class="kvgrid c${s.columns ?? 2}">${cells}</div>`;
      }
      if (s.kind === 'table') {
        const al = (i: number) => s.columns[i]?.align ?? 'left';
        const head = s.columns.map((c, i) => `<th style="text-align:${al(i)}">${esc(c.header)}</th>`).join('');
        const body = s.rows.length
          ? s.rows.map((r) => `<tr>${r.map((v, i) => `<td style="text-align:${al(i)}">${esc(v)}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${s.columns.length}" class="empty">${esc(s.emptyText ?? 'No records for this period.')}</td></tr>`;
        const foot = s.footer ? `<tfoot><tr>${s.footer.map((v, i) => `<td style="text-align:${al(i)}">${esc(v)}</td>`).join('')}</tr></tfoot>` : '';
        return `${h}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
      }
      if (s.kind === 'totals') {
        return `<table class="totals">${s.rows
          .map((r) => `<tr class="${r.strong ? 'strong' : ''}"><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`)
          .join('')}</table>`;
      }
      return `<p class="note">${esc(s.text)}</p>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title>
<style>
  @page { size: A4 ${m.landscape ? 'landscape' : 'portrait'}; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Inter, "Segoe UI", Arial, sans-serif; color: #17241c; font-size: 11.5px; margin: 0; }
  header { display: flex; gap: 14px; align-items: center; border-bottom: 2px solid #1b4a2b; padding-bottom: 10px; }
  header img { width: 52px; height: 52px; border-radius: 50%; }
  header .store { font-size: 17px; font-weight: 700; color: #1b4a2b; }
  header .lines { color: #55625a; font-size: 10.5px; line-height: 1.45; }
  h1 { font-size: 18px; margin: 16px 0 2px; letter-spacing: .4px; }
  .sub { color: #55625a; margin: 0 0 10px; }
  h2 { font-size: 12.5px; margin: 16px 0 6px; color: #1b4a2b; }
  .kvgrid { display: grid; gap: 4px 24px; }
  .kvgrid.c2 { grid-template-columns: 1fr 1fr; } .kvgrid.c1 { grid-template-columns: 1fr; }
  .kv { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dotted #d5dbd2; padding: 3px 0; }
  .kv span { color: #55625a; } .kv b { font-weight: 600; text-align: right; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { background: #1b4a2b; color: #fff; font-weight: 600; padding: 6px 7px; font-size: 10.5px; }
  td { padding: 5px 7px; border-bottom: 1px solid #e3e5dc; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) td { background: #f3f7f1; }
  tfoot td { font-weight: 700; border-top: 2px solid #1b4a2b; }
  td.empty { text-align: center; color: #7a857e; padding: 14px; }
  table.totals { width: 300px; margin: 10px 0 0 auto; }
  table.totals td { border: none; padding: 3px 7px; } table.totals td:last-child { text-align: right; }
  table.totals tr.strong td { font-size: 14px; font-weight: 700; border-top: 2px solid #1b4a2b; padding-top: 6px; }
  .note { color: #55625a; margin-top: 14px; }
  .stamp { display: inline-block; border: 3px solid #b42318; color: #b42318; font-weight: 800; font-size: 20px; padding: 2px 14px; letter-spacing: 3px; margin-top: 8px; }
  footer { margin-top: 22px; text-align: center; color: #55625a; font-size: 10.5px; border-top: 1px solid #e3e5dc; padding-top: 8px; }
</style></head><body>
<header>${logo ? `<img src="${logo}" alt="">` : ''}<div><div class="store">${esc(m.storeName)}</div><div class="lines">${(m.storeLines ?? [])
    .filter(Boolean)
    .map(esc)
    .join('<br>')}</div></div></header>
<h1>${esc(m.title)}</h1>${m.subtitle ? `<p class="sub">${esc(m.subtitle)}</p>` : ''}${m.stamp ? `<div class="stamp">${esc(m.stamp)}</div>` : ''}
${sec}
<footer>${m.footer ? `${esc(m.footer)}<br>` : ''}Generated ${esc(format(new Date(), 'MMM d, yyyy h:mm a'))}${m.generatedBy ? ` by ${esc(m.generatedBy)}` : ''} · INVPORTIQ</footer>
</body></html>`;
}

/** Prints through a hidden frame: the page itself never changes and no pop-up is needed. */
export async function printDocument(m: DocModel): Promise<void> {
  const html = renderHtml(m, await logoDataUrl());
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  await new Promise((r) => setTimeout(r, 250));
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
export async function buildDocumentPdf(m: DocModel) {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default;
  const doc = new jsPDF({ orientation: m.landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  await registerPdfFont(doc);
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  const logo = await logoDataUrl();
  if (logo) doc.addImage(logo, 'PNG', M, 30, 46, 46);
  const tx = M + (logo ? 58 : 0);
  doc.setTextColor(27, 74, 43);
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(15);
  doc.text(m.storeName, tx, 46);
  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(85, 98, 90);
  let ly = 59;
  for (const line of (m.storeLines ?? []).filter(Boolean)) {
    doc.text(line, tx, ly);
    ly += 11;
  }
  let y = Math.max(ly, 82) + 4;
  doc.setDrawColor(27, 74, 43);
  doc.setLineWidth(1.5);
  doc.line(M, y, W - M, y);
  y += 24;
  doc.setTextColor(23, 36, 28);
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(16);
  doc.text(m.title, M, y);
  if (m.stamp) {
    doc.setTextColor(180, 35, 24);
    doc.setFontSize(18);
    const sw = doc.getTextWidth(m.stamp);
    doc.setDrawColor(180, 35, 24);
    doc.rect(W - M - sw - 20, y - 18, sw + 20, 26);
    doc.text(m.stamp, W - M - sw - 10, y);
    doc.setTextColor(23, 36, 28);
  }
  if (m.subtitle) {
    y += 14;
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(85, 98, 90);
    doc.text(doc.splitTextToSize(m.subtitle, W - M * 2), M, y);
  }
  y += 10;

  for (const s of m.sections) {
    if ('heading' in s && s.heading) {
      if (y > doc.internal.pageSize.getHeight() - 90) {
        doc.addPage();
        y = 50;
      }
      y += 16;
      doc.setFont(PDF_FONT, 'bold');
      doc.setFontSize(11);
      doc.setTextColor(27, 74, 43);
      doc.text(s.heading, M, y);
      y += 4;
    }
    if (s.kind === 'kv') {
      const cols = s.columns ?? 2;
      const body: string[][] = [];
      for (let i = 0; i < s.rows.length; i += cols) {
        const row: string[] = [];
        for (let j = 0; j < cols; j++) row.push(...(s.rows[i + j] ?? ['', '']));
        body.push(row);
      }
      autoTable(doc, {
        startY: y + 4,
        body,
        theme: 'plain',
        styles: { font: PDF_FONT, fontSize: 9, cellPadding: 2.5, textColor: [23, 36, 28] },
        columnStyles: cols === 2 ? { 0: { textColor: [85, 98, 90] }, 2: { textColor: [85, 98, 90] }, 1: { fontStyle: 'bold' }, 3: { fontStyle: 'bold' } } : { 0: { textColor: [85, 98, 90], cellWidth: 170 }, 1: { fontStyle: 'bold' } },
        margin: { left: M, right: M },
      });
      y = lastY();
    } else if (s.kind === 'table') {
      const al = (i: number) => s.columns[i]?.align ?? 'left';
      autoTable(doc, {
        startY: y + 6,
        head: [s.columns.map((c) => c.header)],
        body: s.rows.length ? s.rows : [[s.emptyText ?? 'No records for this period.', ...s.columns.slice(1).map(() => '')]],
        foot: s.footer ? [s.footer] : undefined,
        styles: { font: PDF_FONT, fontSize: 8.5, cellPadding: { top: 4, bottom: 4, left: 5, right: 5 }, overflow: 'linebreak', lineColor: [227, 229, 220], lineWidth: { bottom: 0.5 } },
        headStyles: { fillColor: [27, 74, 43], textColor: 255, fontStyle: 'bold' },
        footStyles: { fillColor: [232, 240, 230], textColor: [23, 36, 28], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [243, 247, 241] },
        columnStyles: Object.fromEntries(s.columns.map((c, i) => [i, { halign: al(i), cellWidth: c.width ?? 'auto' }])),
        didParseCell: (d) => {
          d.cell.styles.halign = al(d.column.index);
        },
        margin: { left: M, right: M, bottom: 44 },
      });
      y = lastY();
    } else if (s.kind === 'totals') {
      autoTable(doc, {
        startY: y + 8,
        body: s.rows.map((r) => [r.label, r.value]),
        theme: 'plain',
        styles: { font: PDF_FONT, fontSize: 10, cellPadding: 3 },
        columnStyles: { 0: { halign: 'left' }, 1: { halign: 'right' } },
        didParseCell: (d) => {
          if (s.rows[d.row.index]?.strong) {
            d.cell.styles.fontStyle = 'bold';
            d.cell.styles.fontSize = 12;
          }
        },
        margin: { left: W - M - 260, right: M },
        tableWidth: 260,
      });
      y = lastY();
    } else {
      y += 16;
      doc.setFont(PDF_FONT, 'normal');
      doc.setFontSize(9);
      doc.setTextColor(85, 98, 90);
      const lines = doc.splitTextToSize(s.text, W - M * 2);
      doc.text(lines, M, y);
      y += lines.length * 11;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const H = doc.internal.pageSize.getHeight();
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130, 140, 134);
    const left = `${m.footer ? `${m.footer} · ` : ''}Generated ${format(new Date(), 'MMM d, yyyy h:mm a')}${m.generatedBy ? ` by ${m.generatedBy}` : ''}`;
    doc.text(doc.splitTextToSize(left, W - M * 2 - 60), M, H - 22);
    const pn = `Page ${p} of ${pages}`;
    doc.text(pn, W - M - doc.getTextWidth(pn), H - 22);
  }
  return doc;
}

export async function exportDocumentPdf(m: DocModel): Promise<void> {
  const doc = await buildDocumentPdf(m);
  doc.save(safeName(m.fileName, 'pdf'));
}

// ---------------------------------------------------------------------------
// Word (.docx) — real, editable text and tables
// ---------------------------------------------------------------------------
export async function buildDocumentDocx(m: DocModel): Promise<Blob> {
  const d = await import('docx');
  const { AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType, Footer, PageOrientation } = d;
  const GREEN = '1B4A2B';
  const font = 'Calibri';
  const align = (a?: Align) => (a === 'right' ? AlignmentType.RIGHT : a === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT);
  const pageW = m.landscape ? 15840 : 11906;
  const contentW = pageW - 2 * 1000;
  const thin = { style: BorderStyle.SINGLE, size: 4, color: 'E3E5DC' };
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

  const p = (text: string, o: { bold?: boolean; size?: number; color?: string; align?: Align; after?: number; before?: number } = {}) =>
    new Paragraph({
      alignment: align(o.align),
      spacing: { after: o.after ?? 60, before: o.before ?? 0 },
      children: [new TextRun({ text, bold: o.bold, size: o.size ?? 20, color: o.color, font })],
    });

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  const logo = await logoDataUrl();
  const header: InstanceType<typeof TextRun | typeof ImageRun>[] = [];
  if (logo) {
    const bytes = Uint8Array.from(atob(logo.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
    header.push(new ImageRun({ type: 'png', data: bytes, transformation: { width: 52, height: 52 } }));
  }
  children.push(new Paragraph({ children: [...header, new TextRun({ text: `  ${m.storeName}`, bold: true, size: 32, color: GREEN, font })] }));
  for (const line of (m.storeLines ?? []).filter(Boolean)) children.push(p(line, { size: 18, color: '55625A', after: 0 }));
  children.push(
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GREEN } }, spacing: { after: 160 }, children: [] }),
  );
  children.push(p(m.title, { bold: true, size: 32, after: 40 }));
  if (m.subtitle) children.push(p(m.subtitle, { size: 19, color: '55625A', after: 120 }));
  if (m.stamp) children.push(p(m.stamp, { bold: true, size: 36, color: 'B42318', after: 120 }));

  for (const s of m.sections) {
    if ('heading' in s && s.heading) children.push(p(s.heading, { bold: true, size: 23, color: GREEN, before: 200, after: 80 }));
    if (s.kind === 'kv') {
      const cols = s.columns ?? 2;
      const rows: InstanceType<typeof TableRow>[] = [];
      for (let i = 0; i < s.rows.length; i += cols) {
        const cells: InstanceType<typeof TableCell>[] = [];
        for (let j = 0; j < cols; j++) {
          const [k, v] = s.rows[i + j] ?? ['', ''];
          cells.push(
            new TableCell({ borders: { top: none, left: none, right: none, bottom: thin }, children: [p(k, { size: 18, color: '55625A', after: 20 })] }),
            new TableCell({ borders: { top: none, left: none, right: none, bottom: thin }, children: [p(v, { size: 18, bold: true, after: 20 })] }),
          );
        }
        rows.push(new TableRow({ children: cells }));
      }
      children.push(new Table({ width: { size: contentW, type: WidthType.DXA }, rows }));
    } else if (s.kind === 'table') {
      const n = s.columns.length;
      const head = new TableRow({
        tableHeader: true,
        children: s.columns.map(
          (c) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, fill: GREEN, color: 'auto' },
              children: [p(c.header, { bold: true, size: 17, color: 'FFFFFF', align: c.align, after: 20 })],
            }),
        ),
      });
      const bodyRows = (s.rows.length ? s.rows : [[s.emptyText ?? 'No records for this period.', ...Array(n - 1).fill('')]]).map(
        (r, ri) =>
          new TableRow({
            children: r.map(
              (v, i) =>
                new TableCell({
                  shading: ri % 2 ? { type: ShadingType.CLEAR, fill: 'F3F7F1', color: 'auto' } : undefined,
                  borders: { top: thin, bottom: thin, left: thin, right: thin },
                  children: [p(v, { size: 17, align: s.columns[i]?.align, after: 10 })],
                }),
            ),
          }),
      );
      const foot = s.footer
        ? [
            new TableRow({
              children: s.footer.map(
                (v, i) =>
                  new TableCell({
                    shading: { type: ShadingType.CLEAR, fill: 'E8F0E6', color: 'auto' },
                    children: [p(v, { size: 17, bold: true, align: s.columns[i]?.align, after: 10 })],
                  }),
              ),
            }),
          ]
        : [];
      children.push(new Table({ width: { size: contentW, type: WidthType.DXA }, rows: [head, ...bodyRows, ...foot] }));
    } else if (s.kind === 'totals') {
      children.push(
        new Table({
          width: { size: 4600, type: WidthType.DXA },
          alignment: AlignmentType.RIGHT,
          rows: s.rows.map(
            (r) =>
              new TableRow({
                children: [
                  new TableCell({ borders: { top: r.strong ? { style: BorderStyle.SINGLE, size: 12, color: GREEN } : none, bottom: none, left: none, right: none }, children: [p(r.label, { bold: r.strong, size: r.strong ? 24 : 20, after: 20 })] }),
                  new TableCell({ borders: { top: r.strong ? { style: BorderStyle.SINGLE, size: 12, color: GREEN } : none, bottom: none, left: none, right: none }, children: [p(r.value, { bold: r.strong, size: r.strong ? 24 : 20, align: 'right', after: 20 })] }),
                ],
              }),
          ),
        }),
      );
    } else {
      children.push(p(s.text, { size: 18, color: '55625A', before: 160 }));
    }
  }

  const footerText = `${m.footer ? `${m.footer} · ` : ''}Generated ${format(new Date(), 'MMM d, yyyy h:mm a')}${m.generatedBy ? ` by ${m.generatedBy}` : ''} · INVPORTIQ`;
  const doc = new Document({
    creator: 'INVPORTIQ',
    title: m.title,
    styles: { default: { document: { run: { font, size: 20 } } } },
    sections: [
      {
        properties: {
          page: {
            size: m.landscape ? { orientation: PageOrientation.LANDSCAPE, width: 11906, height: 16838 } : { width: 11906, height: 16838 },
            margin: { top: 900, bottom: 900, left: 1000, right: 1000 },
          },
        },
        footers: { default: new Footer({ children: [p(footerText, { size: 16, color: '828C86', align: 'center' })] }) },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}

export async function exportDocumentDocx(m: DocModel): Promise<void> {
  download(await buildDocumentDocx(m), safeName(m.fileName, 'docx'));
}
