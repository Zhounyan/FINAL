import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { listActivity, listUsers, PAGE_SIZE } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';
import { useDebounce, useResettingPage } from '@/hooks/data';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';

const ACTIONS: [string, string][] = [
  ['', 'All actions'],
  ['login', 'Sign-in'],
  ['logout', 'Sign-out'],
  ['sale', 'Sale'],
  ['invoice_generated', 'Invoice generated'],
  ['invoice_printed', 'Invoice printed'],
  ['sale_voided', 'Transaction voided'],
  ['stock_in', 'Stock-In'],
  ['stock_out', 'Stock-Out'],
  ['adjustment', 'Adjustment'],
  ['reverse', 'Reversal'],
  ['user_created', 'Cashier created'],
  ['user_updated', 'Cashier updated'],
  ['user_deactivated', 'Account deactivated'],
  ['password_reset', 'Password reset'],
  ['create', 'Record created'],
  ['update', 'Record updated'],
];

export default function ActivityLogsPage() {
  const [params, setParams] = useSearchParams();
  const userId = params.get('user') ?? '';
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const debounced = useDebounce(search);
  const [page, setPage] = useResettingPage([debounced, userId, action, from, to]);
  const users = useQuery({ queryKey: ['users', 'all-for-filter'], queryFn: () => listUsers({ page: 1 }), staleTime: 60_000 });
  const q = useQuery({
    queryKey: ['activity', 'log', debounced, userId, action, from, to, page],
    queryFn: () =>
      listActivity({
        page,
        search: debounced,
        userId: userId || undefined,
        action: action || undefined,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
      }),
    placeholderData: (p) => p,
  });

  return (
    <div className="space-y-6">
      <PageHeader icon={<Activity className="size-5" />} title="Activity Logs" description="Audit trail of sign-ins, sales, invoices, stock operations and account changes." />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} className="max-w-sm flex-1" placeholder="Search activity…" />
          <select className="input h-10 w-auto" value={userId} onChange={(e) => setParams(e.target.value ? { user: e.target.value } : {})} aria-label="Filter by user">
            <option value="">All users</option>
            {users.data?.rows.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
          <select className="input h-10 w-auto" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
            {ACTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input type="date" className="input h-10 w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <input type="date" className="input h-10 w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        {q.isError ? (
          <ErrorState error={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock />
        ) : !q.data?.rows.length ? (
          <EmptyState title="No activity" message="Nothing matches these filters." />
        ) : (
          <TableWrap>
            <table className="table-base" data-testid="activity-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(a.created_at)}</td>
                    <td className="whitespace-nowrap">{a.user_name ?? 'System'}</td>
                    <td>
                      <Badge tone="slate">{a.action.replace(/_/g, ' ')}</Badge>
                      <span className="block text-[11px] text-muted">{a.entity_type.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="text-sm">{a.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      </Card>
    </div>
  );
}
