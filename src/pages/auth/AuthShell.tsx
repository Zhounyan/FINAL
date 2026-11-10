import type { ReactNode } from 'react';
import { BarChart3, Boxes, ShieldCheck } from 'lucide-react';
import logo from '@/assets/logo.png';
import storeFront from '@/assets/store-front.jpg';
import storeFrontSmall from '@/assets/store-front-sm.jpg';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative grid min-h-screen bg-brand-950 lg:grid-cols-[1.05fr_1fr]">
      {/* Bill Store storefront photo behind the whole sign-in screen */}
      <img
        src={storeFrontSmall}
        srcSet={`${storeFrontSmall} 900w, ${storeFront} 1920w`}
        sizes="100vw"
        alt=""
        aria-hidden
        className="pointer-events-none fixed inset-0 h-full w-full object-cover object-center select-none"
      />
      <div className="relative hidden overflow-hidden bg-gradient-to-r from-brand-950/85 via-brand-950/65 to-brand-950/45 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="relative flex items-center gap-3">
          <img src={logo} alt="" className="size-12 rounded-full bg-white p-0.5" />
          <span className="text-xl font-extrabold tracking-wide">INVPORTIQ</span>
        </div>
        <div className="relative max-w-lg">
          <img src={logo} alt="Bill Store" className="mb-8 size-40 rounded-full bg-white p-1 shadow-2xl ring-8 ring-white/10" />
          <h2 className="text-3xl leading-tight font-bold">Inventory Management &amp; Business Intelligence for Bill Store</h2>
          <p className="mt-4 text-brand-100/80">
            Track every unit that comes in and goes out, see exactly what remains each day, and make decisions with accurate reports.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-brand-50/90">
            <li className="flex items-center gap-3"><Boxes className="size-5 text-brand-300" /> Accurate stock ledger with full history</li>
            <li className="flex items-center gap-3"><BarChart3 className="size-5 text-brand-300" /> Daily, weekly, monthly &amp; yearly analytics</li>
            <li className="flex items-center gap-3"><ShieldCheck className="size-5 text-brand-300" /> Secure role-based access for Owner, Admin &amp; Staff</li>
          </ul>
        </div>
        <p className="relative text-xs text-brand-200/60">© {new Date().getFullYear()} Bill Store · INVPORTIQ</p>
      </div>
      <div className="relative flex items-center justify-center bg-brand-950/55 px-4 pt-10 pb-24 sm:px-8 lg:bg-transparent lg:bg-gradient-to-r lg:from-brand-950/45 lg:to-brand-950/35">
        <div className="w-full max-w-md animate-pop-in">
          <div className="mb-8 flex flex-col items-center text-center lg:items-start lg:text-left">
            <img src={logo} alt="Bill Store" className="mb-4 size-20 rounded-full shadow-md lg:hidden" />
            <h1 className="text-2xl font-bold tracking-tight text-white drop-shadow-md">{title}</h1>
            {subtitle && <p className="mt-2 text-sm text-white/90 drop-shadow">{subtitle}</p>}
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-pop sm:p-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function FormAlert({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success'; children: ReactNode }) {
  const cls = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2.5 text-sm ${cls}`}>
      {children}
    </div>
  );
}
