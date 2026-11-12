// INVPORTIQ backup engine (Supabase Edge Functions, Deno).
//
// Archive layout (ZIP):
//   metadata.json          app/version/date/type/counts/schema signature + SHA-256 of every file
//   README.txt             what is inside and how to recover
//   database/<table>.json  every row of every application table (one consistent snapshot)
//   schema/schema.json     columns, constraints, indexes, triggers, RLS policies, functions
//   auth/users.json        login accounts (id, email, created_at) for verification — NO password hashes
//   files/<bucket>/<path>  objects from application Storage buckets (none today; profile photos live in the database)
//
// Stored copies are AES-256-GCM encrypted in the private "backups" bucket; the
// key is an Edge Function secret (BACKUP_ENCRYPTION_KEY) and never goes in the archive.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { strFromU8, strToU8, unzipSync, zipSync } from 'npm:fflate@0.8.3';

export const APP_NAME = 'InvportIQ';
export const APP_VERSION = '1.0.0';
export const FORMAT_VERSION = 1;
export const BACKUP_BUCKET = 'backups';
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAGIC = new TextEncoder().encode('IVQB1');
const STALE_RUN_MINUTES = 20;

export interface Actor {
  id: string | null;
  name: string;
}

export interface BackupRun {
  id: string;
  trigger: 'manual' | 'scheduled' | 'safety' | 'uploaded';
  status: 'running' | 'success' | 'failed';
  filename: string | null;
  storage_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  [key: string]: unknown;
}

export class BackupError extends Error {
  code: string;
  constructor(message: string, code = 'backup_error') {
    super(message);
    this.code = code;
  }
}

/** Copies into a plain ArrayBuffer-backed array (what Web Crypto / Blob expect). */
export function ab(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Hashing & encryption
// ---------------------------------------------------------------------------
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ab(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(): Promise<{ key: CryptoKey; id: string; source: 'secret' | 'derived' }> {
  const configured = Deno.env.get('BACKUP_ENCRYPTION_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const material = configured ? configured : `invportiq-backup-key:${service}`;
  if (!configured && !service) throw new BackupError('No backup encryption key is available.', 'misconfigured');
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const id = (await sha256Hex(raw)).slice(0, 16);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, id, source: configured ? 'secret' : 'derived' };
}

export async function encryptArchive(plain: Uint8Array): Promise<{ data: Uint8Array; keyId: string }> {
  const { key, id } = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ab(plain)));
  const out = new Uint8Array(MAGIC.length + iv.length + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + iv.length);
  return { data: out, keyId: id };
}

export async function decryptArchive(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < MAGIC.length + 12 + 16 || !MAGIC.every((b, i) => data[i] === b)) {
    throw new BackupError('The stored backup is not a valid encrypted InvportIQ archive.', 'corrupt');
  }
  const { key } = await encryptionKey();
  const iv = data.slice(MAGIC.length, MAGIC.length + 12);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data.slice(MAGIC.length + 12)));
  } catch {
    throw new BackupError('The stored backup could not be decrypted (damaged file or different encryption key).', 'corrupt');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type TableRows = Record<string, Record<string, unknown>[]>;
interface SchemaInfo {
  tables: Record<string, { name: string; type: string }[]>;
  [key: string]: unknown;
}

const SAFE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function json(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 1));
}

export async function schemaSignature(schema: SchemaInfo, tables: string[]): Promise<string> {
  const lines = tables
    .slice()
    .sort()
    .flatMap((t) => (schema.tables[t] ?? []).map((c) => `${t}.${c.name}:${c.type}`));
  return sha256Hex(strToU8(lines.join('\n')));
}

function backupFilename(trigger: string, when: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when).replace(':', '');
  const label = trigger === 'scheduled' ? 'Weekly' : trigger === 'safety' ? 'PreRestore' : 'Full';
  return `InvportIQ_${label}_Backup_${day}_${time}.zip`;
}

async function storeTimeZone(admin: SupabaseClient): Promise<{ timeZone: string; storeName: string }> {
  const { data } = await admin.from('system_settings').select('key, value').in('key', ['timezone', 'store_name']);
  const map = Object.fromEntries((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  return { timeZone: String(map.timezone ?? 'Asia/Manila'), storeName: String(map.store_name ?? 'Bill Store') };
}

export async function audit(admin: SupabaseClient, actor: Actor, action: string, entityId: string | null, summary: string, details: Record<string, unknown> | null = null) {
  const { error } = await admin.from('activity_logs').insert({
    user_id: actor.id,
    user_name: actor.name,
    action,
    entity_type: 'backup',
    entity_id: entityId,
    summary,
    details,
  });
  if (error) console.error('backup audit log failed', error);
}

async function setStage(admin: SupabaseClient, id: string, stage: string) {
  await admin.from('backup_runs').update({ stage }).eq('id', id);
}

/** Lists every object in a bucket (recursively). */
async function listObjects(admin: SupabaseClient, bucket: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw new BackupError(`Could not list files in bucket "${bucket}": ${error.message}`, 'storage');
    for (const item of data ?? []) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null || item.id === undefined) out.push(...(await listObjects(admin, bucket, path)));
      else out.push(path);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

function safeStoragePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 900 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  );
}

// ---------------------------------------------------------------------------
// Build + verify an archive
// ---------------------------------------------------------------------------
interface BuiltArchive {
  zip: Uint8Array;
  metadata: BackupMetadata;
}

export interface BackupMetadata {
  application: string;
  application_version: string;
  format_version: number;
  backup_type: string;
  created_at: string;
  snapshot_at: string;
  store_name: string;
  time_zone: string;
  schema_signature: string;
  table_count: number;
  record_count: number;
  table_counts: Record<string, number>;
  file_count: number;
  profile_photo_count: number;
  auth_user_count: number;
  files: Record<string, { sha256: string; size: number }>;
  excluded: string[];
}

async function buildArchive(admin: SupabaseClient, trigger: string, runId: string): Promise<BuiltArchive> {
  const { timeZone, storeName } = await storeTimeZone(admin);

  await setStage(admin, runId, 'Exporting database');
  const { data: snap, error: snapErr } = await admin.rpc('backup_export_snapshot');
  if (snapErr || !snap) throw new BackupError(`Database export failed: ${snapErr?.message ?? 'no data'}`, 'export');
  const { data: schema, error: schemaErr } = await admin.rpc('backup_schema_info');
  if (schemaErr || !schema) throw new BackupError(`Schema export failed: ${schemaErr?.message ?? 'no data'}`, 'export');
  const tables = snap.tables as TableRows;
  const tableNames = Object.keys(tables).sort();
  if (!tableNames.length) throw new BackupError('No application tables were found to back up.', 'export');

  await setStage(admin, runId, 'Collecting files');
  const files: Record<string, Uint8Array> = {};
  const { data: buckets, error: bucketErr } = await admin.storage.listBuckets();
  if (bucketErr) throw new BackupError(`Could not list storage buckets: ${bucketErr.message}`, 'storage');
  for (const b of buckets ?? []) {
    if (b.id === BACKUP_BUCKET) continue; // never back up the backups
    for (const path of await listObjects(admin, b.id)) {
      const { data: blob, error } = await admin.storage.from(b.id).download(path);
      if (error || !blob) throw new BackupError(`Could not read file ${b.id}/${path}: ${error?.message}`, 'storage');
      files[`files/${b.id}/${path}`] = new Uint8Array(await blob.arrayBuffer());
    }
  }

  await setStage(admin, runId, 'Creating archive');
  const entries: Record<string, Uint8Array> = {};
  const tableCounts: Record<string, number> = {};
  for (const t of tableNames) {
    entries[`database/${t}.json`] = json(tables[t]);
    tableCounts[t] = tables[t].length;
  }
  entries['schema/schema.json'] = json(schema);
  entries['auth/users.json'] = json(snap.auth_users ?? []);
  Object.assign(entries, files);
  entries['README.txt'] = strToU8(readme());

  const manifest: BackupMetadata['files'] = {};
  for (const [name, bytes] of Object.entries(entries)) manifest[name] = { sha256: await sha256Hex(bytes), size: bytes.length };

  const profiles = (tables.profiles ?? []) as { avatar_url?: string | null }[];
  const metadata: BackupMetadata = {
    application: APP_NAME,
    application_version: APP_VERSION,
    format_version: FORMAT_VERSION,
    backup_type: trigger,
    created_at: new Date().toISOString(),
    snapshot_at: String(snap.snapshot_at),
    store_name: storeName,
    time_zone: timeZone,
    schema_signature: await schemaSignature(schema as SchemaInfo, tableNames),
    table_count: tableNames.length,
    record_count: Object.values(tableCounts).reduce((a, b) => a + b, 0),
    table_counts: tableCounts,
    file_count: Object.keys(files).length,
    profile_photo_count: profiles.filter((p) => p.avatar_url).length,
    auth_user_count: (snap.auth_users ?? []).length,
    files: manifest,
    excluded: [
      'Supabase Auth password hashes, sessions and tokens (restore with Supabase project backups)',
      'Backup history and settings (backup_runs, backup_settings)',
      'Secrets and environment variables (service-role key, encryption key, SMTP password)',
      'Application source code, Edge Functions and migrations (kept in the Git repository)',
    ],
  };
  entries['metadata.json'] = json(metadata);
  const zip = zipSync(entries, { level: 6, mtime: new Date() });
  return { zip, metadata };
}

export interface VerifiedArchive {
  metadata: BackupMetadata;
  tables: TableRows;
  files: Record<string, Uint8Array>;
  authUsers: { id: string; email: string }[];
}

/** Opens and fully validates an archive: structure, paths, checksums, counts. */
export async function verifyArchive(zipBytes: Uint8Array): Promise<VerifiedArchive> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new BackupError('The file is not a valid ZIP archive.', 'corrupt');
  }
  for (const name of Object.keys(entries)) {
    if (name.endsWith('/')) continue;
    const ok =
      name === 'metadata.json' ||
      name === 'README.txt' ||
      name === 'schema/schema.json' ||
      name === 'auth/users.json' ||
      (/^database\/[a-z_][a-z0-9_]{0,62}\.json$/.test(name)) ||
      (name.startsWith('files/') && safeStoragePath(name.slice(6)) && name.slice(6).includes('/'));
    if (!ok) throw new BackupError(`The archive contains an unexpected or unsafe path: "${name.slice(0, 120)}".`, 'corrupt');
  }
  if (!entries['metadata.json']) throw new BackupError('The archive has no metadata.json — it is not an InvportIQ backup.', 'corrupt');
  let metadata: BackupMetadata;
  try {
    metadata = JSON.parse(strFromU8(entries['metadata.json']));
  } catch {
    throw new BackupError('metadata.json is damaged.', 'corrupt');
  }
  if (metadata.application !== APP_NAME) throw new BackupError('This archive was not created by InvportIQ.', 'incompatible');
  if (metadata.format_version !== FORMAT_VERSION) {
    throw new BackupError(`Unsupported backup format version ${metadata.format_version} (this system reads version ${FORMAT_VERSION}).`, 'incompatible');
  }
  // every listed file must exist with a matching checksum, and nothing unlisted may be present
  for (const [name, info] of Object.entries(metadata.files ?? {})) {
    const bytes = entries[name];
    if (!bytes) throw new BackupError(`The archive is incomplete: "${name}" is missing.`, 'corrupt');
    if ((await sha256Hex(bytes)) !== info.sha256) throw new BackupError(`Checksum mismatch for "${name}" — the archive is damaged or was modified.`, 'corrupt');
  }
  for (const name of Object.keys(entries)) {
    if (name !== 'metadata.json' && !name.endsWith('/') && !metadata.files[name]) {
      throw new BackupError(`"${name}" is not listed in the backup manifest.`, 'corrupt');
    }
  }
  const tables: TableRows = {};
  for (const [t, count] of Object.entries(metadata.table_counts ?? {})) {
    if (!SAFE_NAME.test(t)) throw new BackupError(`Invalid table name "${t}" in metadata.`, 'corrupt');
    const bytes = entries[`database/${t}.json`];
    if (!bytes) throw new BackupError(`The archive is missing the data for table "${t}".`, 'corrupt');
    const rows = JSON.parse(strFromU8(bytes));
    if (!Array.isArray(rows) || rows.length !== count) {
      throw new BackupError(`Table "${t}" has ${Array.isArray(rows) ? rows.length : 'no'} rows but the metadata says ${count}.`, 'corrupt');
    }
    tables[t] = rows;
  }
  if (Object.keys(tables).length !== metadata.table_count) throw new BackupError('The number of tables does not match the metadata.', 'corrupt');
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) if (name.startsWith('files/')) files[name.slice(6)] = bytes;
  if (Object.keys(files).length !== metadata.file_count) throw new BackupError('The number of files does not match the metadata.', 'corrupt');
  const authUsers = entries['auth/users.json'] ? JSON.parse(strFromU8(entries['auth/users.json'])) : [];
  return { metadata, tables, files, authUsers };
}

/** Problems that make a backup incompatible with the current database schema. */
async function compatibilityProblems(admin: SupabaseClient, archive: VerifiedArchive): Promise<string[]> {
  const { data: current, error } = await admin.rpc('backup_schema_info');
  if (error || !current) throw new BackupError(`Could not read the current database schema: ${error?.message}`, 'schema');
  const problems: string[] = [];
  for (const [t, rows] of Object.entries(archive.tables)) {
    const cols = (current as SchemaInfo).tables[t];
    if (!cols) {
      problems.push(`Table "${t}" no longer exists in this database.`);
      continue;
    }
    const byName = new Map(cols.map((c) => [c.name, c.type]));
    const keys = rows.length ? Object.keys(rows[0]) : [];
    for (const k of keys) if (!byName.has(k)) problems.push(`Column "${t}.${k}" from the backup does not exist in this database.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Create a backup (manual, scheduled, safety)
// ---------------------------------------------------------------------------
export async function createBackup(
  admin: SupabaseClient,
  opts: { trigger: 'manual' | 'scheduled' | 'safety'; actor: Actor; scheduleSlot?: string; attempt?: number; runId?: string },
): Promise<BackupRun> {
  let runId = opts.runId;
  if (!runId) {
    const { data, error } = await admin
      .from('backup_runs')
      .insert({
        trigger: opts.trigger,
        status: 'running',
        stage: 'Preparing backup',
        schedule_slot: opts.scheduleSlot ?? null,
        attempt: opts.attempt ?? 1,
        created_by: opts.actor.id,
        created_by_name: opts.actor.name,
      })
      .select('id')
      .single();
    if (error || !data) throw new BackupError(`Could not start the backup: ${error?.message}`, 'start');
    runId = data.id as string;
  }

  let storagePath: string | null = null;
  try {
    const { zip, metadata } = await buildArchive(admin, opts.trigger, runId);

    await setStage(admin, runId, 'Verifying backup');
    const verified = await verifyArchive(zip);
    if (verified.metadata.record_count !== metadata.record_count) throw new BackupError('Verification failed: record counts differ.', 'verify');
    const sha256 = await sha256Hex(zip);

    await setStage(admin, runId, 'Saving backup');
    const { timeZone } = await storeTimeZone(admin);
    const filename = backupFilename(opts.trigger, new Date(metadata.created_at), timeZone);
    const { data: encrypted, keyId } = await encryptArchive(zip);
    storagePath = `${new Date().getUTCFullYear()}/${runId}.zip.enc`;
    const { error: upErr } = await admin.storage
      .from(BACKUP_BUCKET)
      .upload(storagePath, ab(encrypted), { upsert: false, contentType: 'application/octet-stream' });
    if (upErr) throw new BackupError(`Saving the backup failed: ${upErr.message}`, 'storage');

    // Read the stored copy back and prove it decrypts to the same archive.
    const { data: back, error: backErr } = await admin.storage.from(BACKUP_BUCKET).download(storagePath);
    if (backErr || !back) throw new BackupError(`Could not read back the saved backup: ${backErr?.message}`, 'verify');
    const roundTrip = await decryptArchive(new Uint8Array(await back.arrayBuffer()));
    if ((await sha256Hex(roundTrip)) !== sha256) throw new BackupError('Verification failed: the stored copy does not match.', 'verify');

    const { data: done, error: doneErr } = await admin
      .from('backup_runs')
      .update({
        status: 'success',
        stage: 'Backup successful',
        filename,
        storage_path: storagePath,
        size_bytes: zip.length,
        sha256,
        table_count: metadata.table_count,
        record_count: metadata.record_count,
        file_count: metadata.file_count,
        profile_photo_count: metadata.profile_photo_count,
        auth_user_count: metadata.auth_user_count,
        schema_signature: metadata.schema_signature,
        format_version: FORMAT_VERSION,
        encryption_key_id: keyId,
        details: { table_counts: metadata.table_counts, snapshot_at: metadata.snapshot_at, time_zone: metadata.time_zone },
        finished_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', runId)
      .select('*')
      .single();
    if (doneErr || !done) throw new BackupError(`Could not record the backup: ${doneErr?.message}`, 'record');
    await audit(admin, opts.actor, opts.trigger === 'scheduled' ? 'backup_created_automatic' : opts.trigger === 'safety' ? 'backup_created_safety' : 'backup_created', runId,
      `${opts.trigger === 'scheduled' ? 'Automatic weekly' : opts.trigger === 'safety' ? 'Pre-restore safety' : 'Manual'} backup ${filename} (${metadata.record_count} records, ${metadata.table_count} tables)`,
      { sha256, size_bytes: zip.length });
    return done as BackupRun;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (storagePath) await admin.storage.from(BACKUP_BUCKET).remove([storagePath]);
    await admin
      .from('backup_runs')
      .update({ status: 'failed', stage: 'Backup failed', error: message.slice(0, 1000), finished_at: new Date().toISOString(), storage_path: null })
      .eq('id', runId);
    await audit(admin, opts.actor, 'backup_failed', runId, `${opts.trigger === 'scheduled' ? 'Automatic' : 'Manual'} backup failed: ${message.slice(0, 300)}`);
    throw e instanceof BackupError ? e : new BackupError(message, 'failed');
  }
}

/** Marks backups stuck in "running" (e.g. the function was stopped) as failed. */
export async function failStaleRuns(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  await admin
    .from('backup_runs')
    .update({ status: 'failed', stage: 'Backup failed', error: 'The backup did not finish (timed out or interrupted).', finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('created_at', cutoff);
}

export async function assertNoRunningBackup(admin: SupabaseClient) {
  await failStaleRuns(admin);
  const { data } = await admin.from('backup_runs').select('id').eq('status', 'running').limit(1);
  if (data && data.length) throw new BackupError('Another backup is already running. Please wait for it to finish.', 'busy');
}

// ---------------------------------------------------------------------------
// Load a stored backup
// ---------------------------------------------------------------------------
export async function loadRun(admin: SupabaseClient, id: string): Promise<BackupRun> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BackupError('Invalid backup id.', 'validation');
  const { data, error } = await admin.from('backup_runs').select('*').eq('id', id).maybeSingle();
  if (error) throw new BackupError(`Could not load the backup: ${error.message}`, 'load');
  if (!data) throw new BackupError('Backup not found.', 'not_found');
  return data as BackupRun;
}

export async function loadArchive(admin: SupabaseClient, run: BackupRun): Promise<Uint8Array> {
  if (run.status !== 'success' || !run.storage_path || !run.sha256) throw new BackupError('Only successful backups can be downloaded or restored.', 'validation');
  const { data, error } = await admin.storage.from(BACKUP_BUCKET).download(run.storage_path);
  if (error || !data) throw new BackupError(`The backup file could not be read from storage: ${error?.message ?? 'missing'}`, 'storage');
  const zip = await decryptArchive(new Uint8Array(await data.arrayBuffer()));
  if ((await sha256Hex(zip)) !== run.sha256) throw new BackupError('The stored backup failed its SHA-256 check and will not be used.', 'corrupt');
  return zip;
}

// ---------------------------------------------------------------------------
// Upload an existing archive
// ---------------------------------------------------------------------------
export async function storeUploadedArchive(admin: SupabaseClient, zip: Uint8Array, actor: Actor, originalName: string): Promise<BackupRun> {
  if (zip.length === 0) throw new BackupError('The uploaded file is empty.', 'validation');
  if (zip.length > MAX_UPLOAD_BYTES) throw new BackupError('The uploaded file is larger than 100 MB.', 'too_large');
  const archive = await verifyArchive(zip);
  const sha256 = await sha256Hex(zip);
  const { data: run, error } = await admin
    .from('backup_runs')
    .insert({ trigger: 'uploaded', status: 'running', stage: 'Verifying backup', created_by: actor.id, created_by_name: actor.name })
    .select('id')
    .single();
  if (error || !run) throw new BackupError(`Could not register the upload: ${error?.message}`, 'start');
  const storagePath = `${new Date().getUTCFullYear()}/${run.id}.zip.enc`;
  try {
    const { data: encrypted, keyId } = await encryptArchive(zip);
    const { error: upErr } = await admin.storage
      .from(BACKUP_BUCKET)
      .upload(storagePath, ab(encrypted), { upsert: false, contentType: 'application/octet-stream' });
    if (upErr) throw new BackupError(`Saving the uploaded backup failed: ${upErr.message}`, 'storage');
    const safeName = originalName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'Uploaded_Backup.zip';
    const m = archive.metadata;
    const { data: done, error: doneErr } = await admin
      .from('backup_runs')
      .update({
        status: 'success',
        stage: 'Backup successful',
        filename: safeName.endsWith('.zip') ? safeName : `${safeName}.zip`,
        storage_path: storagePath,
        size_bytes: zip.length,
        sha256,
        table_count: m.table_count,
        record_count: m.record_count,
        file_count: m.file_count,
        profile_photo_count: m.profile_photo_count,
        auth_user_count: m.auth_user_count,
        schema_signature: m.schema_signature,
        format_version: m.format_version,
        encryption_key_id: keyId,
        details: { table_counts: m.table_counts, snapshot_at: m.snapshot_at, time_zone: m.time_zone, original_backup_type: m.backup_type, original_created_at: m.created_at },
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
      .select('*')
      .single();
    if (doneErr || !done) throw new BackupError(`Could not record the upload: ${doneErr?.message}`, 'record');
    await audit(admin, actor, 'backup_uploaded', run.id, `Uploaded backup ${done.filename} (${m.record_count} records from ${m.created_at.slice(0, 10)})`, { sha256 });
    return done as BackupRun;
  } catch (e) {
    await admin.storage.from(BACKUP_BUCKET).remove([storagePath]);
    await admin.from('backup_runs').update({ status: 'failed', stage: 'Backup failed', error: (e as Error).message, finished_at: new Date().toISOString(), storage_path: null }).eq('id', run.id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
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

export async function restoreBackup(admin: SupabaseClient, id: string, actor: Actor): Promise<RestoreResult> {
  const run = await loadRun(admin, id);

  // Restore lock (also protects this backup from retention / deletion).
  const { data: locked } = await admin
    .from('backup_settings')
    .update({ restore_in_progress: run.id, restore_started_at: new Date().toISOString() })
    .eq('singleton', true)
    .is('restore_in_progress', null)
    .select('singleton');
  if (!locked || !locked.length) {
    // release a lock older than 30 minutes (crashed restore) and ask to retry
    await admin.from('backup_settings').update({ restore_in_progress: null, restore_started_at: null })
      .eq('singleton', true).lt('restore_started_at', new Date(Date.now() - 30 * 60_000).toISOString());
    throw new BackupError('Another restore is already in progress.', 'busy');
  }

  const checks: string[] = [];
  try {
    await assertNoRunningBackup(admin);
    // 1-7. Validate everything BEFORE touching any data.
    const zip = await loadArchive(admin, run);
    checks.push('SHA-256 checksum of the stored archive matches');
    const archive = await verifyArchive(zip);
    checks.push(`Archive structure and all ${Object.keys(archive.metadata.files).length} file checksums verified`);
    const problems = await compatibilityProblems(admin, archive);
    if (problems.length) throw new BackupError(`This backup is not compatible with the current database: ${problems.slice(0, 5).join(' ')}`, 'incompatible');
    checks.push('Backup is compatible with the current database structure');

    // 8. Safety backup of the current system.
    const safety = await createBackup(admin, { trigger: 'safety', actor });
    checks.push(`Safety backup of the current data created (${safety.filename})`);

    // 9-12. One transaction: replace data, re-check relationships and ledger.
    const { data: applied, error: applyErr } = await admin.rpc('backup_restore_apply', { p_tables: archive.tables });
    if (applyErr || !applied) {
      throw new BackupError(`Restore was rolled back — no data was changed. Reason: ${applyErr?.message ?? 'unknown'}`, 'restore_failed');
    }
    checks.push('All relationships between records verified', 'Stock ledger balances for every product');

    // 13. Counts must match the backup exactly.
    const restoredTables = applied.tables as Record<string, number>;
    for (const [t, count] of Object.entries(archive.metadata.table_counts)) {
      if (Number(restoredTables[t]) !== count) throw new BackupError(`Post-restore check failed: ${t} has ${restoredTables[t]} rows, expected ${count}. Restore the safety backup ${safety.filename}.`, 'verify');
    }
    checks.push('Record counts match the backup for every table');

    // 14. Files (application Storage buckets).
    let restoredFiles = 0;
    for (const [path, bytes] of Object.entries(archive.files)) {
      const [bucket, ...rest] = path.split('/');
      const { error } = await admin.storage.from(bucket).upload(rest.join('/'), ab(bytes), { upsert: true, contentType: 'application/octet-stream' });
      if (error) throw new BackupError(`Database restored, but file ${path} could not be restored: ${error.message}`, 'files');
      restoredFiles++;
    }
    if (restoredFiles) checks.push(`${restoredFiles} file(s) restored`);

    await admin.from('backup_runs').update({ last_restored_at: new Date().toISOString() }).eq('id', run.id);
    const total = Object.values(restoredTables).reduce((a, b) => a + Number(b), 0);
    // activity_logs was itself restored from the backup, so this entry is written afterwards.
    await audit(admin, actor, 'backup_restored', run.id, `Restored backup ${run.filename} (${total} records). Safety backup: ${safety.filename}`, {
      safety_backup_id: safety.id,
      tables: restoredTables,
    });
    return {
      ok: true,
      backup_id: run.id,
      safety_backup_id: safety.id,
      restored_tables: restoredTables,
      restored_records: total,
      restored_files: restoredFiles,
      profiles_without_login: Number(applied.profiles_without_login ?? 0),
      checks,
    };
  } catch (e) {
    await audit(admin, actor, 'restore_failed', run.id, `Restore of ${run.filename} failed: ${(e as Error).message.slice(0, 300)}`);
    throw e;
  } finally {
    await admin.from('backup_settings').update({ restore_in_progress: null, restore_started_at: null }).eq('singleton', true);
  }
}

// ---------------------------------------------------------------------------
// Deletion & retention
// ---------------------------------------------------------------------------
async function successfulCount(admin: SupabaseClient): Promise<number> {
  const { count } = await admin.from('backup_runs').select('id', { count: 'exact', head: true }).eq('status', 'success');
  return count ?? 0;
}

export async function deleteBackup(admin: SupabaseClient, id: string, actor: Actor, reason: 'manual' | 'retention' = 'manual') {
  const run = await loadRun(admin, id);
  const { data: settings } = await admin.from('backup_settings').select('restore_in_progress').eq('singleton', true).single();
  if (settings?.restore_in_progress === run.id) throw new BackupError('This backup is being restored and cannot be deleted now.', 'busy');
  if (run.status === 'running') throw new BackupError('A running backup cannot be deleted.', 'busy');
  if (run.status === 'success' && (await successfulCount(admin)) <= 1) {
    throw new BackupError('This is the only valid backup and cannot be deleted. Create another backup first.', 'last_backup');
  }
  if (run.storage_path) {
    const { error } = await admin.storage.from(BACKUP_BUCKET).remove([run.storage_path]);
    if (error) throw new BackupError(`Could not delete the backup file: ${error.message}`, 'storage');
  }
  const { error } = await admin.from('backup_runs').delete().eq('id', run.id);
  if (error) throw new BackupError(`Could not delete the backup record: ${error.message}`, 'delete');
  await audit(admin, actor, reason === 'retention' ? 'backup_retention_cleanup' : 'backup_deleted', run.id,
    `${reason === 'retention' ? 'Retention removed' : 'Deleted'} backup ${run.filename ?? run.id}`);
}

/** Keeps the newest N successful weekly backups and the newest 5 safety backups. */
export async function applyRetention(admin: SupabaseClient, keep: number, actor: Actor) {
  const removed: string[] = [];
  const { data: old, error } = await admin.rpc('backup_retention_candidates', { p_keep: keep });
  if (error) {
    await audit(admin, actor, 'backup_retention_failed', null, `Retention check failed: ${error.message}`);
    return removed;
  }
  const { data: safety } = await admin.from('backup_runs').select('id').eq('trigger', 'safety').eq('status', 'success').order('created_at', { ascending: false });
  const candidates = [...((old ?? []) as BackupRun[]).map((r) => r.id), ...((safety ?? []) as { id: string }[]).slice(5).map((r) => r.id)];
  for (const id of candidates) {
    try {
      await deleteBackup(admin, id, actor, 'retention');
      removed.push(id);
    } catch (e) {
      await audit(admin, actor, 'backup_retention_failed', id, `Retention could not remove a backup: ${(e as Error).message}`);
    }
  }
  return removed;
}

function readme(): string {
  return `InvportIQ — Full System Backup
================================

This archive contains Bill Store's InvportIQ business data:

  metadata.json          Backup details and SHA-256 checksums of every file
  database/<table>.json  All records of every application table (one consistent snapshot)
  schema/schema.json     Database structure: columns, constraints, indexes, triggers,
                         row-level security policies and database functions
  auth/users.json        Login accounts (id, email, created date) for verification only
  files/                 Files from application storage buckets (if any)

Profile photos are stored inside the "profiles" table and are included.

NOT included (by design):
  * Supabase Auth passwords and sessions — use Supabase's own project backups
    (Dashboard > Database > Backups) to recover login accounts after a full loss.
  * Secrets (service-role key, encryption key, SMTP password).
  * Application source code, Edge Functions and migrations — these live in the
    Git repository (github.com/Zhounyan/FINAL).

To restore: InvportIQ > Backup & Restore > Upload backup, then Restore.
A safety backup of the current data is created automatically first, and the
restore runs in a single database transaction that is rolled back on any error.
`;
}
