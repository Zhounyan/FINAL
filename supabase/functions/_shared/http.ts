// HTTP helpers for INVPORTIQ Edge Functions.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.118.0';

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = allowedOrigins.includes('*') ? '*' : allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, code = 'error', extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Wraps a handler with CORS, method checks, JSON parsing and safe error output. */
export function serve(handler: (req: Request, body: Record<string, unknown>) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed', code: 'method_not_allowed' });
    try {
      const text = await req.text();
      if (text.length > 20_000) throw new HttpError(413, 'Request too large.', 'too_large');
      let body: Record<string, unknown> = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new HttpError(400, 'Invalid JSON body.', 'bad_request');
        }
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, 'Invalid request body.', 'bad_request');
      }
      const result = await handler(req, body);
      return json(req, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        return json(req, err.status, { error: err.message, code: err.code, ...err.extra });
      }
      console.error('Unhandled edge function error', err);
      return json(req, 500, { error: 'An unexpected server error occurred.', code: 'server_error' });
    }
  });
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new HttpError(500, `Server misconfiguration: ${name} is not set.`, 'misconfigured');
  return v;
}

/** Service-role client. Bypasses RLS — only ever used inside Edge Functions. */
export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Fresh anon client (used to verify passwords without touching other sessions). */
export function anonClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface Caller {
  user: User;
  token: string;
  claims: Record<string, unknown>;
  profile: {
    id: string;
    email: string;
    full_name: string;
    role: 'owner' | 'admin' | 'staff';
    is_active: boolean;
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
}

/** Validates the caller's access token with Supabase Auth and loads their profile. */
export async function requireCaller(req: Request, admin: SupabaseClient): Promise<Caller> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Not signed in.', 'unauthenticated');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'unauthenticated');
  const { data: profile, error: pErr } = await admin
    .from('profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', data.user.id)
    .maybeSingle();
  if (pErr) throw new HttpError(500, 'Could not load your account.', 'server_error');
  if (!profile || !profile.is_active) throw new HttpError(403, 'Your account is inactive.', 'inactive');
  return { user: data.user, token, claims: decodeJwtPayload(token), profile };
}

export function str(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw new HttpError(400, `Missing field: ${key}.`, 'validation');
    return '';
  }
  if (typeof raw !== 'string') throw new HttpError(400, `Field ${key} must be text.`, 'validation');
  const v = raw.trim();
  if (opts.max && v.length > opts.max) throw new HttpError(400, `Field ${key} is too long.`, 'validation');
  if (opts.required && !v) throw new HttpError(400, `Missing field: ${key}.`, 'validation');
  return v;
}

/** Password strings must not be trimmed. */
export function rawPassword(body: Record<string, unknown>, key: string): string {
  const raw = body[key];
  if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, `Missing field: ${key}.`, 'validation');
  return raw;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function audit(
  admin: SupabaseClient,
  actor: { id: string | null; full_name: string },
  action: string,
  entityId: string | null,
  summary: string,
  details: Record<string, unknown> | null = null,
) {
  const { error } = await admin.from('activity_logs').insert({
    user_id: actor.id,
    user_name: actor.full_name,
    action,
    entity_type: 'profiles',
    entity_id: entityId,
    summary,
    details,
  });
  if (error) console.error('audit log failed', error);
}
