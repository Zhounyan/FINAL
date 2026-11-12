import { supabase, supabaseAnonKey, supabaseUrl } from './supabase';
import { invokeFunction } from './api';

export interface BackupRun {
  id: string;
  trigger: 'manual' | 'scheduled' | 'safety' | 'uploaded';
  status: 'running' | 'success' | 'failed';
  stage: string | null;
  schedule_slot: string | null;
  attempt: number;
  filename: string | null;
  size_bytes: number | null;
  sha256: string | null;
  table_count: number | null;
  record_count: number | null;
  file_count: number | null;
  profile_photo_count: number | null;
  auth_user_count: number | null;
  schema_signature: string | null;
  format_version: number | null;
  encryption_key_id: string | null;
  details: { table_counts?: Record<string, number>; snapshot_at?: string; time_zone?: string; original_created_at?: string; original_backup_type?: string } | null;
  error: string | null;
  created_by_name: string;
  created_at: string;
  finished_at: string | null;
  last_restored_at: string | null;
}

export interface BackupSettings {
  auto_enabled: boolean;
  day_of_week: number;
  hour_of_day: number;
  retention_count: number;
  scheduler_url: string | null;
  restore_in_progress: string | null;
  updated_at: string;
}

export interface SchedulerStatus {
  pg_cron: boolean;
  pg_net: boolean;
  installed: boolean;
  active: boolean;
}

export interface RestoreResult {
  ok: true;
  backup_id: string;
  safety_backup_id: string;
  restored_tables: Record<string, number>;
  restored_records: number;
  restored_files: number;
  profiles_without_login: number;
  checks: string[];
}

function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

export async function listBackupRuns(): Promise<BackupRun[]> {
  return unwrap(await supabase.from('backup_runs').select('*').order('created_at', { ascending: false }).limit(200));
}

export async function getBackupSettings(): Promise<BackupSettings> {
  return unwrap(await supabase.from('backup_settings').select('*').single());
}

export async function updateBackupSettings(s: { enabled: boolean; day: number; hour: number; retention: number }) {
  return unwrap(
    await supabase.rpc('backup_update_settings', { p_enabled: s.enabled, p_day: s.day, p_hour: s.hour, p_retention: s.retention }),
  );
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  return unwrap(await supabase.rpc('backup_scheduler_status'));
}

export async function installScheduler() {
  return unwrap(await supabase.rpc('backup_install_scheduler', { p_functions_base_url: supabaseUrl }));
}

export function createBackupNow() {
  return invokeFunction<{ ok: true; run: BackupRun }>('backup-admin', { action: 'create' });
}

export function runScheduledNow() {
  return invokeFunction<{ status: string; run?: BackupRun; removed_by_retention?: number }>('backup-admin', { action: 'run_scheduled' });
}

export function restoreBackup(id: string) {
  return invokeFunction<RestoreResult>('backup-admin', { action: 'restore', id, confirm: 'RESTORE' });
}

export function deleteBackupRun(id: string) {
  return invokeFunction('backup-admin', { action: 'delete', id });
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  return { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey };
}

async function functionError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string };
    return new Error(body.error ?? `Request failed (${res.status}).`);
  } catch {
    return new Error(`Request failed (${res.status}).`);
  }
}

/** Downloads the decrypted, checksum-verified archive and saves it in the browser. */
export async function downloadBackup(run: BackupRun): Promise<void> {
  const res = await fetch(`${supabaseUrl}/functions/v1/backup-admin`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'download', id: run.id }),
  });
  if (!res.ok) throw await functionError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = run.filename ?? 'InvportIQ_Backup.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Uploads a backup ZIP; the server verifies every checksum before storing it. */
export async function uploadBackup(file: File): Promise<BackupRun> {
  if (!/\.zip$/i.test(file.name)) throw new Error('Please choose an InvportIQ backup .zip file.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('The file is larger than 100 MB.');
  const res = await fetch(`${supabaseUrl}/functions/v1/backup-admin?action=upload&name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/zip' },
    body: file,
  });
  if (!res.ok) throw await functionError(res);
  return ((await res.json()) as { run: BackupRun }).run;
}

export function formatBytes(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const BACKUP_STAGES = ['Preparing backup', 'Exporting database', 'Collecting files', 'Creating archive', 'Verifying backup', 'Saving backup'] as const;
