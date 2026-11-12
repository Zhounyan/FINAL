import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  DatabaseBackup,
  Download,
  Eye,
  HardDrive,
  History,
  Loader2,
  PlayCircle,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { DAY_NAMES, describeSchedule, nextSlot } from '@shared/backup-schedule';
import {
  BACKUP_STAGES,
  createBackupNow,
  deleteBackupRun,
  downloadBackup,
  formatBytes,
  getBackupSettings,
  getSchedulerStatus,
  installScheduler,
  listBackupRuns,
  restoreBackup,
  runScheduledNow,
  updateBackupSettings,
  uploadBackup,
  type BackupRun,
  type BackupSettings,
  type RestoreResult,
} from '@/lib/backups';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime, fmtInt } from '@/lib/format';

/** The scheduled instant shown in the store's time zone (not the browser's). */
function fmtInZone(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}
import { useSettings } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Card, DetailRow, EmptyState, ErrorState, PageHeader, StatCard, TableWrap } from '@/components/ui/Display';
import { LoadingBlock } from '@/components/ui/Spinner';

const TYPE_LABEL: Record<BackupRun['trigger'], string> = {
  manual: 'Manual',
  scheduled: 'Automatic',
  safety: 'Pre-restore safety',
  uploaded: 'Uploaded',
};

function StatusBadge({ run }: { run: BackupRun }) {
  if (run.status === 'success') return <Badge tone="green"><CheckCircle2 className="size-3" /> Successful</Badge>;
  if (run.status === 'failed') return <Badge tone="red"><XCircle className="size-3" /> Failed</Badge>;
  return <Badge tone="blue"><Loader2 className="size-3 animate-spin" /> In progress</Badge>;
}

export default function BackupsPage() {
  const qc = useQueryClient();
  const settings = useSettings();
  const timeZone = settings.data?.timezone ?? 'Asia/Manila';
  const runs = useQuery({
    queryKey: ['backups', 'runs'],
    queryFn: listBackupRuns,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === 'running') ? 800 : 30_000),
  });
  const backupSettings = useQuery({ queryKey: ['backups', 'settings'], queryFn: getBackupSettings });
  const scheduler = useQuery({ queryKey: ['backups', 'scheduler'], queryFn: getSchedulerStatus });
  const refresh = () => qc.invalidateQueries({ queryKey: ['backups'] });

  const [viewing, setViewing] = useState<BackupRun | null>(null);
  const [restoring, setRestoring] = useState<BackupRun | null>(null);
  const [deleting, setDeleting] = useState<BackupRun | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: createBackupNow,
    onMutate: () => setTimeout(refresh, 400), // show live progress as soon as the run row exists
    onSuccess: async (r) => {
      toast.success(`Backup completed: ${r.run.filename}`);
      await refresh();
    },
    onError: async (e) => {
      toast.error(errorMessage(e, 'The backup failed.'));
      await refresh();
    },
  });
  const runWeekly = useMutation({
    mutationFn: runScheduledNow,
    onMutate: () => setTimeout(refresh, 400),
    onSuccess: async (r) => {
      const msg: Record<string, string> = {
        started: 'This week’s automatic backup completed.',
        already_done: 'This week’s automatic backup was already completed.',
        in_progress: 'This week’s automatic backup is already running.',
        disabled: 'Automatic backups are turned off.',
        gave_up: 'This week’s automatic backup failed 3 times. Use “Create backup” instead.',
      };
      (r.status === 'started' && r.run?.status === 'success' ? toast.success : toast.info)(msg[r.status] ?? r.status);
      await refresh();
    },
    onError: async (e) => {
      toast.error(errorMessage(e, 'The automatic backup failed.'));
      await refresh();
    },
  });
  const upload = useMutation({
    mutationFn: uploadBackup,
    onSuccess: async (run) => {
      toast.success(`Backup verified and stored: ${run.filename}. You can restore it from the history below.`);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e, 'The file is not a valid InvportIQ backup.')),
  });
  const del = useMutation({
    mutationFn: (r: BackupRun) => deleteBackupRun(r.id),
    onSuccess: async () => {
      toast.success('Backup deleted.');
      setDeleting(null);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const list = runs.data ?? [];
  const successful = list.filter((r) => r.status === 'success');
  const lastSuccess = successful[0];
  const latest = list.find((r) => r.status !== 'running') ?? null;
  const running = list.find((r) => r.status === 'running') ?? null;
  const lastAttempt = list.find((r) => r.trigger === 'scheduled') ?? null;
  const storageUsed = successful.reduce((a, r) => a + Number(r.size_bytes ?? 0), 0);
  const s = backupSettings.data;
  const next = s?.auto_enabled ? nextSlot(new Date(), timeZone, s.day_of_week, s.hour_of_day) : null;
  const busy = Boolean(running) || create.isPending || runWeekly.isPending;

  const download = async (r: BackupRun) => {
    setDownloading(r.id);
    try {
      await downloadBackup(r);
      toast.success(`Downloading ${r.filename}`);
    } catch (e) {
      toast.error(errorMessage(e, 'The download failed.'));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<DatabaseBackup className="size-5" />}
        title="Backup & Restore"
        description="Protect Bill Store’s data with verified, encrypted backups — manual or automatic every week."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              aria-label="Choose backup file to upload"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) upload.mutate(f);
              }}
            />
            <Button variant="outline" icon={<Upload className="size-4" />} loading={upload.isPending} onClick={() => fileInput.current?.click()}>
              Upload backup
            </Button>
            <Button icon={<DatabaseBackup className="size-4" />} loading={create.isPending} disabled={busy} onClick={() => create.mutate()}>
              Create backup
            </Button>
          </>
        }
      />

      {runs.isError && <ErrorState error={errorMessage(runs.error)} onRetry={() => runs.refetch()} />}

      {/* Overview */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="backup-overview">
        <StatCard label="Last successful backup" value={<span className="text-base">{lastSuccess ? fmtDateTime(lastSuccess.created_at) : 'None yet'}</span>} icon={<CheckCircle2 className="size-4" />} tone="green" />
        <StatCard label="Next scheduled backup" hint={next ? `Store time (${timeZone})` : ''} value={<span className="text-base">{next ? fmtInZone(next, timeZone) : 'Off'}</span>} icon={<CalendarClock className="size-4" />} tone="blue" />
        <StatCard label="Available backups" value={fmtInt(successful.length)} icon={<History className="size-4" />} />
        <StatCard label="Storage used" value={formatBytes(storageUsed)} icon={<HardDrive className="size-4" />} tone="wood" />
        <StatCard
          label="Automatic backup"
          value={<span className="text-base">{s ? (s.auto_enabled ? 'Enabled' : 'Disabled') : '—'}</span>}
          icon={<ShieldCheck className="size-4" />}
          tone={s?.auto_enabled ? 'green' : 'slate'}
        />
        <StatCard label="Frequency" value={<span className="text-base">Weekly</span>} hint={s ? describeSchedule(s.day_of_week, s.hour_of_day) : ''} icon={<CalendarClock className="size-4" />} tone="violet" />
        <StatCard
          label="Latest result"
          value={<span className="text-base">{latest ? (latest.status === 'success' ? 'Successful' : 'Failed') : '—'}</span>}
          hint={latest ? `${TYPE_LABEL[latest.trigger]} · ${fmtDateTime(latest.created_at)}` : ''}
          icon={latest?.status === 'failed' ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
          tone={latest?.status === 'failed' ? 'red' : 'green'}
        />
      </div>

      {running && <ProgressPanel run={running} />}

      <div className="grid gap-6 xl:grid-cols-3">
        {s ? (
        <ScheduleCard
          key={s.updated_at}
          settings={s}
          timeZone={timeZone}
          lastAttempt={lastAttempt}
          onRunNow={() => runWeekly.mutate()}
          runningNow={runWeekly.isPending}
          busy={busy}
          successfulCount={successful.filter((r) => r.trigger === 'scheduled').length}
          scheduler={scheduler.data}
          onInstalled={refresh}
        />
        ) : (
          <Card title="Automatic weekly backup" className="xl:col-span-2"><LoadingBlock rows={3} /></Card>
        )}
        <Card title="What a backup contains" className="xl:col-span-1" bodyClassName="p-5 space-y-3 text-sm">
          <p className="font-medium text-ink">Included</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>Every record of all {lastSuccess?.table_count ?? 12} database tables (products, stock ledger, sales, customers, suppliers, users, settings, activity log…)</li>
            <li>Profile photos and any files in app storage</li>
            <li>Database structure: constraints, indexes, triggers, security policies, functions</li>
            <li>A list of login accounts for checking (no passwords)</li>
          </ul>
          <p className="font-medium text-ink">Not included (by design)</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>Passwords and login sessions — kept by Supabase’s own daily backups</li>
            <li>Secrets and keys</li>
            <li>The app’s source code — kept in GitHub</li>
          </ul>
        </Card>
      </div>

      {/* History */}
      <Card title="Backup history" subtitle="Newest first · stored encrypted in private storage">
        {runs.isLoading ? (
          <LoadingBlock rows={4} />
        ) : list.length === 0 ? (
          <EmptyState icon={<DatabaseBackup className="size-6" />} title="No backups yet" message="Create your first backup now, or wait for the automatic weekly backup." />
        ) : (
          <TableWrap>
            <table className="table-base table-compact" data-testid="backup-history">
              <thead>
                <tr>
                  <th>Backup</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="num">Size</th>
                  <th className="num">Tables</th>
                  <th className="num">Records</th>
                  <th className="num">Files</th>
                  <th>Status</th>
                  <th>Created by</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs font-medium whitespace-nowrap">{r.filename ?? <span className="text-muted">—</span>}</td>
                    <td className="whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                    <td className="whitespace-nowrap">{TYPE_LABEL[r.trigger]}</td>
                    <td className="num">{r.size_bytes ? formatBytes(r.size_bytes) : '—'}</td>
                    <td className="num">{r.table_count ?? '—'}</td>
                    <td className="num">{r.record_count != null ? fmtInt(r.record_count) : '—'}</td>
                    <td className="num" title="Storage files + profile photos">{r.file_count != null ? fmtInt((r.file_count ?? 0) + (r.profile_photo_count ?? 0)) : '—'}</td>
                    <td className="whitespace-nowrap"><StatusBadge run={r} /></td>
                    <td className="whitespace-nowrap">{r.created_by_name}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" onClick={() => setViewing(r)} aria-label={`View ${r.filename ?? 'backup'} details`} title="View details"><Eye className="size-4" /></Button>
                      {r.status === 'success' && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => download(r)} disabled={downloading === r.id} aria-label={`Download ${r.filename}`} title="Download">
                            {downloading === r.id ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setRestoring(r)} disabled={busy} aria-label={`Restore ${r.filename}`} title="Restore"><RotateCcw className="size-4" /></Button>
                        </>
                      )}
                      {r.status !== 'running' && (
                        <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setDeleting(r)} aria-label={`Delete ${r.filename ?? 'failed backup'}`} title="Delete"><Trash2 className="size-4" /></Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {viewing && <DetailsModal run={viewing} onClose={() => setViewing(null)} />}
      {restoring && (
        <RestoreDialog
          run={restoring}
          onClose={() => setRestoring(null)}
          onDone={async (r) => {
            setRestoring(null);
            setResult(r);
            await qc.invalidateQueries(); // every page's data changed
          }}
        />
      )}
      {result && <RestoreResultModal result={result} onClose={() => setResult(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete backup?"
        message={
          <>
            Permanently delete <b className="text-ink">{deleting?.filename ?? 'this failed attempt'}</b>? This cannot be undone. The only remaining valid backup can never be deleted.
          </>
        }
        confirmLabel="Delete backup"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function ProgressPanel({ run }: { run: BackupRun }) {
  const current = BACKUP_STAGES.indexOf((run.stage ?? 'Preparing backup') as (typeof BACKUP_STAGES)[number]);
  return (
    <Card title={`${TYPE_LABEL[run.trigger]} backup in progress`} subtitle={`Started ${fmtDateTime(run.created_at)} by ${run.created_by_name}`} bodyClassName="p-5">
      <ol className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-live="polite" data-testid="backup-progress">
        {BACKUP_STAGES.map((stage, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'todo';
          return (
            <li key={stage} className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', state === 'active' ? 'border-brand-300 bg-brand-50 font-medium text-brand-900' : 'border-line text-muted')}>
              {state === 'done' ? <CheckCircle2 className="size-4 text-emerald-600" /> : state === 'active' ? <Loader2 className="size-4 animate-spin text-brand-700" /> : <CircleDashed className="size-4" />}
              {stage}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function ScheduleCard({
  settings,
  timeZone,
  lastAttempt,
  onRunNow,
  runningNow,
  busy,
  successfulCount,
  scheduler,
  onInstalled,
}: {
  settings: BackupSettings;
  timeZone: string;
  lastAttempt: BackupRun | null;
  onRunNow: () => void;
  runningNow: boolean;
  busy: boolean;
  successfulCount: number;
  scheduler: Awaited<ReturnType<typeof getSchedulerStatus>> | undefined;
  onInstalled: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState({ enabled: settings.auto_enabled, day: settings.day_of_week, hour: settings.hour_of_day, retention: settings.retention_count });
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => updateBackupSettings(draft),
    onSuccess: async () => {
      toast.success('Automatic backup settings saved.');
      await qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const install = useMutation({
    mutationFn: installScheduler,
    onSuccess: async () => {
      toast.success('Automatic backup scheduler activated.');
      await onInstalled();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const changed =
    draft.enabled !== settings.auto_enabled || draft.day !== settings.day_of_week || draft.hour !== settings.hour_of_day || draft.retention !== settings.retention_count;

  return (
    <Card
      title="Automatic weekly backup"
      subtitle={`Runs on the server — nobody needs to be signed in · time zone ${timeZone}`}
      className="xl:col-span-2"
      bodyClassName="p-5 space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex items-center gap-3 rounded-xl border border-line p-3 text-sm sm:col-span-2 lg:col-span-4">
          <input
            type="checkbox"
            className="size-5 accent-brand-700"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            aria-label="Automatic backup enabled"
          />
          <span>
            <span className="font-medium text-ink">Automatic backup {draft.enabled ? 'enabled' : 'disabled'}</span>
            <span className="block text-xs text-muted">{describeSchedule(draft.day, draft.hour)} · keeps the latest {draft.retention} successful weekly backups</span>
          </span>
        </label>
        <Select label="Day" value={draft.day} onChange={(e) => setDraft({ ...draft, day: Number(e.target.value) })}>
          {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </Select>
        <Select label="Time" value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{`${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`}</option>
          ))}
        </Select>
        <Input
          label="Keep (weekly backups)"
          type="number"
          min={1}
          max={104}
          value={draft.retention}
          onChange={(e) => setDraft({ ...draft, retention: Math.max(1, Math.min(104, Number(e.target.value) || 12)) })}
        />
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-ink">Time zone</span>
          <p className="input bg-slate-50 text-muted">{timeZone}</p>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-1 rounded-xl bg-brand-50/50 p-3 text-sm sm:grid-cols-2">
        <DetailRow label="Last attempt">{lastAttempt ? `${fmtDateTime(lastAttempt.created_at)} · ${lastAttempt.status === 'success' ? 'Successful' : lastAttempt.status === 'failed' ? 'Failed' : 'In progress'}` : 'None yet'}</DetailRow>
        <DetailRow label="Successful weekly backups">{fmtInt(successfulCount)}</DetailRow>
        <DetailRow label="Server scheduler">
          {scheduler?.installed && scheduler.active ? (
            <Badge tone="green"><CheckCircle2 className="size-3" /> Active (checks hourly)</Badge>
          ) : (
            <Badge tone="amber"><AlertTriangle className="size-3" /> Not activated</Badge>
          )}
        </DetailRow>
        {lastAttempt?.status === 'failed' && <DetailRow label="Last error"><span className="text-red-700">{lastAttempt.error}</span></DetailRow>}
      </dl>

      {scheduler && !(scheduler.installed && scheduler.active) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The weekly schedule is saved, but the server scheduler is not running yet.
          {!scheduler.pg_cron || !scheduler.pg_net
            ? ' Enable the “pg_cron” and “pg_net” extensions in Supabase (Database → Extensions), then click Activate.'
            : ' Click Activate to start it.'}
          <div className="mt-2">
            <Button size="sm" variant="outline" loading={install.isPending} onClick={() => install.mutate()} disabled={!scheduler.pg_cron || !scheduler.pg_net}>
              Activate scheduler
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" icon={<PlayCircle className="size-4" />} loading={runningNow} disabled={busy} onClick={onRunNow} title="Runs this week’s automatic backup now if it hasn’t succeeded yet (also retries a failed one)">
          Run weekly backup now
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed}>
          Save schedule
        </Button>
      </div>
    </Card>
  );
}

function DetailsModal({ run, onClose }: { run: BackupRun; onClose: () => void }) {
  const counts = Object.entries(run.details?.table_counts ?? {});
  return (
    <Modal open onClose={onClose} size="lg" title={run.filename ?? 'Backup details'} description={`${TYPE_LABEL[run.trigger]} backup · ${fmtDateTime(run.created_at)}`}>
      <dl className="divide-y divide-line">
        <DetailRow label="Status"><StatusBadge run={run} /></DetailRow>
        {run.error && <DetailRow label="Error"><span className="text-red-700">{run.error}</span></DetailRow>}
        <DetailRow label="Created by">{run.created_by_name}</DetailRow>
        {run.details?.snapshot_at && <DetailRow label="Data as of">{fmtDateTime(run.details.snapshot_at)}</DetailRow>}
        {run.details?.original_created_at && <DetailRow label="Originally created">{fmtDateTime(run.details.original_created_at)}</DetailRow>}
        <DetailRow label="Size">{run.size_bytes ? formatBytes(run.size_bytes) : '—'}</DetailRow>
        <DetailRow label="Contents">
          {run.table_count ?? 0} tables · {fmtInt(run.record_count ?? 0)} records · {run.file_count ?? 0} files · {run.profile_photo_count ?? 0} profile photos · {run.auth_user_count ?? 0} login accounts listed
        </DetailRow>
        <DetailRow label="SHA-256"><code className="text-xs break-all">{run.sha256 ?? '—'}</code></DetailRow>
        <DetailRow label="Stored as">Encrypted (AES-256-GCM){run.encryption_key_id ? ` · key ${run.encryption_key_id}` : ''}</DetailRow>
        <DetailRow label="Format">Version {run.format_version ?? '—'}</DetailRow>
        {run.last_restored_at && <DetailRow label="Last restored">{fmtDateTime(run.last_restored_at)}</DetailRow>}
      </dl>
      {counts.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 text-sm font-semibold">Records per table</h3>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {counts.map(([t, n]) => (
              <div key={t} className="flex justify-between border-b border-line/60 py-1">
                <span className="text-muted">{t}</span>
                <span className="font-medium tabular-nums">{fmtInt(n)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function RestoreDialog({ run, onClose, onDone }: { run: BackupRun; onClose: () => void; onDone: (r: RestoreResult) => void }) {
  const [typed, setTyped] = useState('');
  const m = useMutation({
    mutationFn: () => restoreBackup(run.id),
    onSuccess: (r) => {
      toast.success('Restore completed and verified.');
      onDone(r);
    },
    onError: (e) => toast.error(errorMessage(e, 'The restore failed. No data was changed.')),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={m.isPending}
      title="Restore this backup?"
      description={run.filename ?? undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>Cancel</Button>
          <Button variant="danger" icon={<RotateCcw className="size-4" />} disabled={typed !== 'RESTORE'} loading={m.isPending} onClick={() => m.mutate()}>
            Restore backup
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-red-900">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <p>
            All current business data (products, stock, sales, customers, suppliers, users’ profiles, settings and activity log) will be <b>replaced</b> with the data from{' '}
            <b>{fmtDateTime(run.details?.snapshot_at ?? run.created_at)}</b>. Anything recorded after that will no longer appear.
          </p>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>The backup’s checksum, structure and compatibility are checked first.</li>
          <li>A safety backup of the current data is created automatically.</li>
          <li>The restore runs as one transaction: if any check fails, nothing is changed.</li>
          <li>Login passwords are not affected.</li>
        </ul>
        <Input label={<>Type <b>RESTORE</b> to confirm</>} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        {m.isPending && (
          <p className="flex items-center gap-2 text-brand-800" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> Verifying, creating a safety backup and restoring…
          </p>
        )}
      </div>
    </Modal>
  );
}

function RestoreResultModal({ result, onClose }: { result: RestoreResult; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Restore completed" description={`${fmtInt(result.restored_records)} records restored and verified`} footer={<Button onClick={onClose}>Done</Button>}>
      <ul className="space-y-1.5 text-sm" data-testid="restore-checks">
        {result.checks.map((c) => (
          <li key={c} className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> {c}
          </li>
        ))}
      </ul>
      {result.profiles_without_login > 0 && (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {result.profiles_without_login} restored user profile(s) have no login account in this Supabase project. Recreate those users in User Management, or restore
          Supabase’s own project backup to recover their logins.
        </p>
      )}
    </Modal>
  );
}
