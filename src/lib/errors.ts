import { FunctionsHttpError } from '@supabase/supabase-js';

interface PgLikeError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

const FRIENDLY_CODES: Record<string, string> = {
  '42501': 'You do not have permission to perform this action.',
  '23505': 'A record with the same value already exists.',
  '23503': 'This record is linked to other records and cannot be changed this way.',
  '23514': 'Some values are not allowed. Please check the form.',
  PGRST301: 'Your session has expired. Please sign in again.',
};

/** Converts Supabase / PostgREST / Edge Function errors into a user-facing message. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  const e = err as PgLikeError & { context?: unknown };
  const msg = e.message ?? '';

  // Messages raised by our own database functions are already user-friendly.
  if (e.code === 'P0001' || e.code === '22023' || e.code === 'P0002') return msg || fallback;
  if (msg && !/^(new row violates|duplicate key|permission denied|violates foreign key|JWT)/i.test(msg) && e.code !== '42501') {
    if (e.code && FRIENDLY_CODES[e.code] && /constraint|policy/i.test(msg)) return FRIENDLY_CODES[e.code];
    return msg;
  }
  if (/duplicate key/i.test(msg)) return FRIENDLY_CODES['23505'];
  if (/row-level security|permission denied/i.test(msg)) return FRIENDLY_CODES['42501'];
  if (/foreign key/i.test(msg)) return FRIENDLY_CODES['23503'];
  if (e.code && FRIENDLY_CODES[e.code]) return FRIENDLY_CODES[e.code];
  return msg || fallback;
}

export interface EdgeErrorBody {
  error?: string;
  code?: string;
  [key: string]: unknown;
}

/** Reads the JSON error body returned by our Edge Functions. */
export async function edgeError(err: unknown): Promise<EdgeErrorBody> {
  if (err instanceof FunctionsHttpError) {
    try {
      const body = (await err.context.json()) as EdgeErrorBody;
      return body;
    } catch {
      return { error: 'The server returned an unexpected response.' };
    }
  }
  const message = (err as Error)?.message ?? 'Network error. Check your connection and try again.';
  if (/Failed to send a request/i.test(message)) {
    return { error: 'Could not reach the server. Check your connection and try again.', code: 'network' };
  }
  return { error: message };
}
