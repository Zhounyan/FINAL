// Called hourly by Supabase Cron (pg_cron + pg_net). Not callable from browsers:
// the request must carry the secret token stored in backup_private.cron_secret.
// Runs the weekly backup when this week's slot (default Sunday 12:00 AM, store
// time zone) has no successful backup yet; retries failed slots up to 3 times.
import { adminClient, corsHeaders, json } from '../_shared/http.ts';
import { claimScheduledSlot, runClaimedSlot } from '../_shared/backup-run-scheduled.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed' });

  const admin = adminClient();
  const token = req.headers.get('x-backup-cron-token') ?? '';
  const { data: valid } = await admin.rpc('backup_check_cron_token', { p_token: token });
  if (valid !== true) return json(req, 401, { error: 'Unauthorized', code: 'unauthorized' });

  try {
    const claim = await claimScheduledSlot(admin);
    if (claim.status !== 'started') return json(req, 200, claim);

    const work = runClaimedSlot(admin, claim).catch((e) => console.error('scheduled backup failed', e));
    // On Supabase the backup continues after the response (cron does not wait);
    // elsewhere (tests) it is awaited so the result is returned.
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(work);
      return json(req, 202, claim);
    }
    await work;
    const { data: run } = await admin.from('backup_runs').select('id, status, error, filename').eq('id', claim.run_id).single();
    return json(req, 200, { ...claim, result: run });
  } catch (e) {
    console.error('backup scheduler error', e);
    return json(req, 500, { error: (e as Error).message, code: 'scheduler_error' });
  }
});
