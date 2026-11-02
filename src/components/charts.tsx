// Chart theme for INVPORTIQ (validated categorical palette: aqua / blue / orange).
export const SERIES = {
  stock_in: { color: '#1baf7a', label: 'Stock In' },
  stock_sold: { color: '#2a78d6', label: 'Stock Sold' },
  other_out: { color: '#eb6834', label: 'Other Stock Out' },
} as const;
export const SINGLE = '#2b5a2c'; // brand single-series hue
export const GRID = '#e8eae2';
export const AXIS = { fontSize: 11, fill: '#5f6b63' };

export function ChartTooltip({ active, payload, label, labelFormatter }: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string; dataKey?: string | number }[];
  label?: string | number;
  labelFormatter?: (l: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-pop">
      <p className="mb-1 font-semibold text-ink">{labelFormatter ? labelFormatter(String(label)) : label}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-muted">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: p.color }} />
          {p.name}: <b className="text-ink tabular-nums">{Number(p.value ?? 0).toLocaleString('en-US')}</b>
        </p>
      ))}
    </div>
  );
}
