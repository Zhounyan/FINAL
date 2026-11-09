import { ACCOUNT_RECOVERY_DAYS } from './api';
import type { Profile } from './types';

/** When a scheduled account deletion becomes permanent, and how many days are left to recover it. */
export function deletionInfo(u: Pick<Profile, 'deletion_scheduled_at'>, now = Date.now()) {
  if (!u.deletion_scheduled_at) return null;
  const deletesAt = new Date(new Date(u.deletion_scheduled_at).getTime() + ACCOUNT_RECOVERY_DAYS * 864e5);
  const daysLeft = Math.max(0, Math.ceil((deletesAt.getTime() - now) / 864e5));
  return { deletesAt, daysLeft };
}
