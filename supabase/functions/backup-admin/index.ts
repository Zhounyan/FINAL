// Backup & Restore — Admin only. Every request is re-authorised on the server.
//   POST {action:"create"}                         manual full backup
//   POST {action:"run_scheduled"}                  run this week's automatic backup now (if due)
//   POST {action:"download", id}                   -> application/zip (decrypted, checksum-verified)
//   POST ?action=upload&name=<file>  (raw zip body) store a validated archive
//   POST {action:"restore", id, confirm:"RESTORE"}  validated, transactional restore
//   POST {action:"delete", id}
import { adminClient, corsHeaders, HttpError, json, requireCaller } from '../_shared/http.ts';
import {
  assertNoRunningBackup,
  BackupError,
  createBackup,
  deleteBackup,
  loadArchive,
  loadRun,
  MAX_UPLOAD_BYTES,
  restoreBackup,
  storeUploadedArchive,
  audit,
  ab,
  type Actor,
} from '../_shared/backup.ts';
import { claimScheduledSlot, runClaimedSlot } from '../_shared/backup-run-scheduled.ts';

const STATUS: Record<string, number> = {
  validation: 400,
  not_found: 404,
  busy: 409,
  last_backup: 409,
  corrupt: 422,
  incompatible: 422,
  too_large: 413,
  restore_failed: 422,
};

function errorResponse(req: Request, e: unknown): Response {
  if (e instanceof HttpError) return json(req, e.status, { error: e.message, code: e.code });
  if (e instanceof BackupError) return json(req, STATUS[e.code] ?? 500, { error: e.message, code: e.code });
  console.error('backup-admin error', e);
  return json(req, 500, { error: 'An unexpected server error occurred.', code: 'server_error' });
}

Deno.serve(async (req) => {
  const cors = { ...corsHeaders(req), 'Access-Control-Expose-Headers': 'Content-Disposition, X-Backup-Sha256' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed' });

  try {
    const admin = adminClient();
    const caller = await requireCaller(req, admin);
    if (caller.profile.role !== 'admin') throw new HttpError(403, 'Only administrators can manage backups.', 'forbidden');
    const actor: Actor = { id: caller.profile.id, name: caller.profile.full_name };
    const url = new URL(req.url);

    // Binary upload
    if (url.searchParams.get('action') === 'upload') {
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw new BackupError('The uploaded file is larger than 100 MB.', 'too_large');
      const bytes = new Uint8Array(await req.arrayBuffer());
      try {
        const run = await storeUploadedArchive(admin, bytes, actor, url.searchParams.get('name') ?? 'Uploaded_Backup.zip');
        return json(req, 200, { ok: true, run });
      } catch (e) {
        await audit(admin, actor, 'backup_upload_rejected', null, `Rejected uploaded backup: ${(e as Error).message.slice(0, 300)}`);
        throw e;
      }
    }

    const text = await req.text();
    if (text.length > 10_000) throw new HttpError(413, 'Request too large.', 'too_large');
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON body.', 'bad_request');
    }
    const id = typeof body.id === 'string' ? body.id : '';

    switch (body.action) {
      case 'create': {
        await assertNoRunningBackup(admin);
        const run = await createBackup(admin, { trigger: 'manual', actor });
        return json(req, 200, { ok: true, run });
      }
      case 'run_scheduled': {
        const claim = await claimScheduledSlot(admin);
        if (claim.status !== 'started') return json(req, 200, claim);
        const { run, removed } = await runClaimedSlot(admin, claim);
        return json(req, 200, { ...claim, run, removed_by_retention: removed.length });
      }
      case 'download': {
        const run = await loadRun(admin, id);
        const zip = await loadArchive(admin, run);
        await audit(admin, actor, 'backup_downloaded', run.id, `Downloaded backup ${run.filename}`);
        return new Response(ab(zip), {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${run.filename}"`,
            'X-Backup-Sha256': String(run.sha256),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      case 'restore': {
        if (body.confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm the restore.', 'confirmation_required');
        const result = await restoreBackup(admin, id, actor);
        return json(req, 200, result);
      }
      case 'delete': {
        await deleteBackup(admin, id, actor);
        return json(req, 200, { ok: true });
      }
      default:
        throw new HttpError(400, 'Unknown action.', 'bad_request');
    }
  } catch (e) {
    return errorResponse(req, e);
  }
});
