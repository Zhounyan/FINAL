// Weekly backup schedule maths, shared by the scheduler Edge Function and the
// dashboard so both always agree. Pure TypeScript, no dependencies.

export const DEFAULT_SCHEDULE = { dayOfWeek: 0, hour: 0, retention: 12, timeZone: 'Asia/Manila' } as const;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(instant: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday as string],
  };
}

/** UTC instant for a wall-clock time in `timeZone` (handles any fixed or DST offset). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  // Offset of the zone at (approximately) that time; refine once for DST edges.
  let utc = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(utc), timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    utc = guess - (asIfUtc - utc);
  }
  return new Date(utc);
}

/** The most recent scheduled moment at or before `now`. */
export function latestSlot(now: Date, timeZone: string, dayOfWeek: number, hour: number): Date {
  const p = localParts(now, timeZone);
  let daysBack = (p.weekday - dayOfWeek + 7) % 7;
  if (daysBack === 0 && p.hour < hour) daysBack = 7;
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day - daysBack));
  return zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, timeZone);
}

/** The next scheduled moment strictly after `now`. */
export function nextSlot(now: Date, timeZone: string, dayOfWeek: number, hour: number): Date {
  const latest = latestSlot(now, timeZone, dayOfWeek, hour);
  const p = localParts(latest, timeZone);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + 7));
  return zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, timeZone);
}

export function describeSchedule(dayOfWeek: number, hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `Every ${DAY_NAMES[dayOfWeek]} at ${h12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}
