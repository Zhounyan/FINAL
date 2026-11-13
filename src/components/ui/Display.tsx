import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Inbox, Search, X } from 'lucide-react';
import { Button } from './Button';

export function Card({ children, className, title, actions, subtitle, bodyClassName }: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('min-w-0 rounded-2xl border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const tones = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  red: 'bg-red-50 text-red-700 ring-red-600/15',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/15',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/15',
  brand: 'bg-brand-50 text-brand-800 ring-brand-600/20',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'slate', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', tones[tone], className)}>
      {children}
    </span>
  );
}

export function StatCard({ label, value, icon, tone = 'brand', hint, className }: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: 'brand' | 'green' | 'blue' | 'red' | 'amber' | 'violet' | 'wood' | 'slate';
  hint?: ReactNode;
  className?: string;
}) {
  const iconTone = {
    brand: 'bg-brand-100 text-brand-800',
    green: 'bg-emerald-100 text-emerald-700',
    blue: 'bg-sky-100 text-sky-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    violet: 'bg-violet-100 text-violet-700',
    wood: 'bg-wood-100 text-wood-700',
    slate: 'bg-slate-100 text-slate-700',
  }[tone];
  return (
    <div className={clsx('group rounded-2xl border border-line bg-surface p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-md', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
        {icon && <span className={clsx('flex size-9 items-center justify-center rounded-xl', iconTone)}>{icon}</span>}
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function PageHeader({ title, description, actions, icon }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-start gap-3">
        {icon && <div className="hidden size-11 items-center justify-center rounded-xl bg-brand-800 text-white shadow-sm sm:flex">{icon}</div>}
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, message, action, icon }: { title: string; message?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-700">{icon ?? <Inbox className="size-6" />}</div>
      <p className="font-semibold text-ink">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="font-medium">Could not load data</p>
      <p className="mt-1">{error}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="no-print flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
      <span>
        Showing <b className="text-ink">{start.toLocaleString()}</b>–<b className="text-ink">{end.toLocaleString()}</b> of{' '}
        <b className="text-ink">{total.toLocaleString()}</b>
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft className="size-4" /> Prev
        </Button>
        <span className="px-2 tabular-nums">
          {page} / {pages}
        </span>
        <Button variant="outline" size="sm" onClick={() => onChange(page + 1)} disabled={page >= pages} aria-label="Next page">
          Next <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="input pr-8 pl-9"
        maxLength={80}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-ink" aria-label="Clear search">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: ReactNode; icon?: ReactNode; hidden?: boolean }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={clsx('no-print flex gap-1 overflow-x-auto rounded-xl border border-line bg-white p-1 shadow-xs', className)}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={value === t.id}
            onClick={() => onChange(t.id)}
            className={clsx(
              'inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition',
              value === t.id ? 'bg-brand-800 text-white shadow-sm' : 'text-muted hover:bg-brand-50 hover:text-brand-800',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
    </div>
  );
}

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('max-w-full overflow-x-auto', className)}>{children}</div>;
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2 font-medium break-words text-ink">{children ?? '—'}</dd>
    </div>
  );
}
