// The weekly automatic backup decision, shared by the cron entry point and the
// admin "run the weekly backup now" action.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { applyRetention, audit, createBackup, failStaleRuns, type Actor } from './backup.ts';
import { latestSlot } from './backup-schedule.ts';

export const MAX_ATTEMPTS_PER_SLOT = 3;
export const SCHEDULER: Actor = { id: null, name: 'Automatic scheduler' };

export type ScheduledOutcome =
  | { status: 'disabled' }
  | { status: 'already_done'; slot: string }
  | { status: 'in_progress'; slot: string }
  | { status: 'gave_up'; slot: string; attempts: number }
  | { status: 'started'; slot: string; run_id: string; attempt: number };

/** Claims this week's slot (if due) and returns the claimed run, without running it. */
export async function claimScheduledSlot(admin: SupabaseClient, now = new Date()): Promise<ScheduledOutcome & { retention?: number }> {
  const { data: settings, error } = await admin.from('backup_settings').select('*').eq('singleton', true).single();
  if (error || !settings) throw new Error(`Backup settings are missing: ${error?.message}`);
  if (!settings.auto_enabled) return { status: 'disabled' };

  const { data: tzRow } = await admin.from('system_settings').select('value').eq('key', 'timezone').maybeSingle();
  const timeZone = String(tzRow?.value ?? 'Asia/Manila');
  const slot = latestSlot(now, timeZone, settings.day_of_week, settings.hour_of_day).toISOString();

  await failStaleRuns(admin);
  const { data: runs } = await admin.from('backup_runs').select('id, status, attempt').eq('trigger', 'scheduled').eq('schedule_slot', slot);
  const list = (runs ?? []) as { id: string; status: string; attempt: number }[];
  if (list.some((r) => r.status === 'success')) return { status: 'already_done', slot };
  if (list.some((r) => r.status === 'running')) return { status: 'in_progress', slot };
  const failures = list.filter((r) => r.status === 'failed').length;
  if (failures >= MAX_ATTEMPTS_PER_SLOT) return { status: 'gave_up', slot, attempts: failures };

  // The unique index allows only one running/successful run per slot: a
  // concurrent invocation loses this insert and simply stops.
  const { data: run, error: claimErr } = await admin
    .from('backup_runs')
    .insert({
      trigger: 'scheduled',
      status: 'running',
      stage: 'Preparing backup',
      schedule_slot: slot,
      attempt: failures + 1,
      created_by: null,
      created_by_name: SCHEDULER.name,
    })
    .select('id')
    .single();
  if (claimErr || !run) return { status: 'in_progress', slot };
  if (failures > 0) await audit(admin, SCHEDULER, 'backup_retry', run.id, `Retrying the automatic weekly backup (attempt ${failures + 1} of ${MAX_ATTEMPTS_PER_SLOT})`);
  return { status: 'started', slot, run_id: run.id, attempt: failures + 1, retention: settings.retention_count };
}

/** Runs a claimed scheduled backup, then applies retention only after it succeeded. */
export async function runClaimedSlot(admin: SupabaseClient, claim: { slot: string; run_id: string; attempt: number; retention?: number }) {
  const run = await createBackup(admin, { trigger: 'scheduled', actor: SCHEDULER, scheduleSlot: claim.slot, attempt: claim.attempt, runId: claim.run_id });
  const removed = await applyRetention(admin, claim.retention ?? 12, SCHEDULER);
  return { run, removed };
}
