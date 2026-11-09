import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Bell, CheckCheck, ChevronRight, PackageX, Trash2 } from 'lucide-react';
import { dashboardStats } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { deletionInfo } from '@/lib/accounts';
import { fmtDate, fmtInt } from '@/lib/format';
import type { Profile } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';

interface Notice {
  /** changes when the situation changes, so a new state shows as unread again */
  key: string;
  tone: 'red' | 'amber';
  icon: React.ReactNode;
  title: string;
  detail: string;
  action: string;
  to: string;
}

const SEEN_KEY = 'invportiq.notifications.seen';

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(keys: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-300)));
  } catch {
    /* storage unavailable: unread state just isn't remembered */
  }
}

export function NotificationBell() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const box = useRef<HTMLDivElement>(null);

  const stats = useQuery({ queryKey: ['dashboard', 'stats', 14], queryFn: () => dashboardStats(14), staleTime: 30_000 });
  const pending = useQuery({
    queryKey: ['users', 'pending-deletion'],
    enabled: can.manageUsers,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, deletion_scheduled_at')
        .not('deletion_scheduled_at', 'is', null)
        .is('deleted_at', null)
        .order('deletion_scheduled_at');
      if (error) return [] as Pick<Profile, 'id' | 'full_name' | 'email' | 'deletion_scheduled_at'>[];
      return data;
    },
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const s = stats.data;
  const notices: Notice[] = [];
  for (const a of s?.stock_alerts ?? []) {
    const out = a.status === 'out';
    notices.push({
      key: `stock:${a.id}:${a.status}:${a.current_stock}`,
      tone: out ? 'red' : 'amber',
      icon: out ? <PackageX className="size-4" /> : <AlertTriangle className="size-4" />,
      title: out ? `${a.name} is out of stock` : `${a.name} is running low`,
      detail: out ? `0 ${a.unit} left · minimum ${fmtInt(a.min_stock_level)}` : `${fmtInt(a.current_stock)} ${a.unit} left · minimum ${fmtInt(a.min_stock_level)}`,
      action: can.recordStockIn ? 'Record stock in' : 'View product',
      to: can.recordStockIn ? `/stock?tab=stock_in&product=${a.id}` : `/products?status=${a.status}`,
    });
  }
  for (const u of pending.data ?? []) {
    const info = deletionInfo(u);
    if (!info) continue;
    notices.push({
      key: `deletion:${u.id}:${info.daysLeft}`,
      tone: 'red',
      icon: <Trash2 className="size-4" />,
      title: `${u.full_name}'s account will be deleted`,
      detail: `${info.daysLeft} day(s) left to recover · deletes ${fmtDate(info.deletesAt)}`,
      action: 'Review in User Management',
      to: '/users',
    });
  }
  const totalStockAlerts = (s?.low_stock ?? 0) + (s?.out_of_stock ?? 0);
  const hiddenStockAlerts = Math.max(0, totalStockAlerts - (s?.stock_alerts.length ?? 0));
  const unread = notices.filter((n) => !seen.has(n.key)).length;

  const markAllRead = () => {
    const next = new Set(seen);
    notices.forEach((n) => next.add(n.key));
    setSeen(next);
    saveSeen(next);
  };

  const go = (n: Notice) => {
    const next = new Set(seen);
    next.add(n.key);
    setSeen(next);
    saveSeen(next);
    setOpen(false);
    navigate(n.to);
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx('relative rounded-xl p-2.5 transition hover:bg-brand-50 hover:text-brand-800', open ? 'bg-brand-50 text-brand-800' : 'text-muted')}
        aria-label={`Notifications: ${unread} unread`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] leading-5 font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="fixed inset-x-3 top-16 z-40 animate-pop-in overflow-hidden rounded-2xl border border-line bg-surface shadow-pop sm:absolute sm:inset-x-auto sm:top-12 sm:right-0 sm:w-96"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">Notifications</p>
              <p className="text-xs text-muted">{notices.length ? `${unread} unread · click one to act on it` : 'Nothing needs your attention'}</p>
            </div>
            {unread > 0 && (
              <button type="button" onClick={markAllRead} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
                <CheckCheck className="size-3.5" /> Mark all as read
              </button>
            )}
          </div>

          {notices.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted">
              <CheckCheck className="mx-auto mb-2 size-6 text-brand-600" />
              All products are above their minimum stock level.
            </div>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto" data-testid="notification-list">
              {notices.map((n) => {
                const isUnread = !seen.has(n.key);
                return (
                  <li key={n.key}>
                    <button type="button" onClick={() => go(n)} className={clsx('flex w-full gap-3 px-4 py-3 text-left transition hover:bg-brand-50', isUnread && 'bg-brand-50/50')}>
                      <span className={clsx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', n.tone === 'red' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>
                        {n.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={clsx('block text-sm text-ink', isUnread && 'font-semibold')}>{n.title}</span>
                        <span className="block text-xs text-muted">{n.detail}</span>
                        <span className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-brand-700">
                          {n.action} <ChevronRight className="size-3" />
                        </span>
                      </span>
                      {isUnread && <span className="mt-2 size-2 shrink-0 rounded-full bg-red-600" aria-label="Unread" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {hiddenStockAlerts > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate(can.viewReports ? '/reports?type=low_stock' : '/products?status=low');
              }}
              className="block w-full border-t border-line px-4 py-2.5 text-center text-xs font-medium text-brand-700 hover:bg-brand-50"
            >
              View all {fmtInt(totalStockAlerts)} stock alerts
            </button>
          )}
        </div>
      )}
    </div>
  );
}
