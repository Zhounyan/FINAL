import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSettings, listAllProducts, listCategories, listCustomerOptions, listSupplierOptions } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { setCurrency } from '@/lib/format';
import { useAuth } from '@/auth/AuthProvider';
import { todayIn } from '@/lib/periods';

export function useDebounce<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function useSettings() {
  const { profile } = useAuth();
  const q = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: Boolean(profile), staleTime: 5 * 60_000 });
  useEffect(() => {
    if (q.data) setCurrency(q.data.currency);
  }, [q.data]);
  return q;
}

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: listCategories, staleTime: 60_000 });
}

/** Product options for pickers; optionally restricted to one category (dependent filter). */
export function useProductOptions(categoryId?: number | null, includeArchived = false) {
  return useQuery({
    queryKey: ['products', 'options', categoryId ?? 'all', includeArchived],
    queryFn: () => listAllProducts({ categoryId, includeArchived }),
    staleTime: 30_000,
  });
}

export function useCustomerOptions(enabled = true) {
  return useQuery({ queryKey: ['customers', 'options'], queryFn: listCustomerOptions, staleTime: 60_000, enabled });
}

export function useSupplierOptions(enabled = true) {
  return useQuery({ queryKey: ['suppliers', 'options'], queryFn: listSupplierOptions, staleTime: 60_000, enabled });
}

const TABLE_KEYS: Record<string, string[][]> = {
  stock_movements: [['dashboard'], ['movements'], ['products'], ['sales'], ['reports'], ['activity'], ['suppliers'], ['customers']],
  products: [['products'], ['dashboard'], ['reports']],
  categories: [['categories'], ['products'], ['dashboard']],
  customers: [['customers'], ['dashboard']],
  suppliers: [['suppliers'], ['dashboard']],
};

/**
 * Subscribes to database changes (Supabase Realtime) so the dashboard and
 * lists refresh automatically when anyone records inventory activity.
 */
export function useRealtimeInvalidation() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  useEffect(() => {
    if (!profile) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const flush = () => {
      for (const table of pending) for (const key of TABLE_KEYS[table] ?? []) void qc.invalidateQueries({ queryKey: key });
      pending.clear();
    };
    const channel = supabase.channel('invportiq-live');
    for (const table of Object.keys(TABLE_KEYS)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        pending.add(table);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 400);
      });
    }
    channel.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [qc, profile]);
}

/** Invalidate everything affected by a stock operation performed in this tab. */
export function useInvalidateInventory() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [['dashboard'], ['movements'], ['products'], ['sales'], ['reports'], ['activity'], ['customers'], ['suppliers']].map((k) =>
        qc.invalidateQueries({ queryKey: k }),
      ),
    );
}

/** Current date in the store's configured time zone (yyyy-MM-dd). */
export function useStoreToday(): string {
  const { data } = useSettings();
  return todayIn(data?.timezone ?? 'Asia/Manila');
}

/**
 * Pagination state that automatically returns to page 1 whenever `key`
 * (e.g. the active filters) changes — derived, not synchronised in an effect.
 */
export function useResettingPage(key: unknown): [number, (page: number) => void] {
  const k = JSON.stringify(key);
  const [state, setState] = useState({ k, page: 1 });
  const page = state.k === k ? state.page : 1;
  return [page, (p: number) => setState({ k, page: p })];
}
