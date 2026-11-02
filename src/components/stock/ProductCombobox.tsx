import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronsUpDown, Search } from 'lucide-react';
import type { ProductRow } from '@/lib/types';
import { fmtInt } from '@/lib/format';

interface Props {
  products: ProductRow[];
  value: number | null;
  onChange: (id: number | null) => void;
  label?: string;
  placeholder?: string;
  error?: string;
  allowAll?: boolean;
  allLabel?: string;
  disabled?: boolean;
  showStock?: boolean;
  required?: boolean;
}

/** Searchable product picker (name / SKU), keyboard accessible. */
export function ProductCombobox({
  products,
  value,
  onChange,
  label,
  placeholder = 'Search product name or SKU…',
  error,
  allowAll,
  allLabel = 'All products',
  disabled,
  showStock = true,
  required,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const selected = products.find((p) => p.id === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) : products;
    return list.slice(0, 100);
  }, [products, query]);

  const options: (ProductRow | null)[] = allowAll ? [null, ...filtered] : filtered;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (p: ProductRow | null) => {
    onChange(p?.id ?? null);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="space-y-1.5" ref={box}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          {label}
          {required && <span className="ml-0.5 text-red-600">*</span>}
        </label>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          disabled={disabled}
          className={clsx('input pr-8 pl-9', error && 'input-invalid')}
          placeholder={selected ? `${selected.name} (${selected.sku})` : allowAll ? allLabel : placeholder}
          value={open ? query : selected ? `${selected.name} · ${selected.sku}` : allowAll ? allLabel : ''}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && open) {
              e.preventDefault();
              if (options[active] !== undefined) choose(options[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-slate-400" />
        {open && !disabled && (
          <ul id={`${id}-list`} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-white py-1 shadow-pop">
            {options.length === 0 && <li className="px-3 py-2 text-sm text-muted">No matching products</li>}
            {options.map((p, i) => (
              <li
                key={p?.id ?? 'all'}
                role="option"
                aria-selected={(p?.id ?? null) === value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                onMouseEnter={() => setActive(i)}
                className={clsx(
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm',
                  i === active && 'bg-brand-50',
                  (p?.id ?? null) === value && 'font-semibold text-brand-800',
                )}
              >
                {p ? (
                  <>
                    <span className="min-w-0">
                      <span className="block truncate">{p.name}</span>
                      <span className="block text-xs text-muted">
                        {p.sku} · {p.category_name}
                      </span>
                    </span>
                    {showStock && (
                      <span className={clsx('shrink-0 text-xs tabular-nums', p.current_stock === 0 ? 'text-red-600' : p.stock_status === 'low' ? 'text-amber-700' : 'text-muted')}>
                        {fmtInt(p.current_stock)} {p.unit}
                      </span>
                    )}
                  </>
                ) : (
                  <span>{allLabel}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-xs font-medium text-red-600" role="alert">{error}</p>}
    </div>
  );
}
