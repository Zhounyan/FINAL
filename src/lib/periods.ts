import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfISOWeek,
  endOfMonth,
  endOfYear,
  format,
  getISOWeek,
  getISOWeekYear,
  isAfter,
  parseISO,
  startOfISOWeek,
  startOfMonth,
  startOfYear,
} from 'date-fns';

export type PeriodType = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ReportPeriod {
  type: PeriodType;
  /** inclusive, yyyy-MM-dd (store-local calendar date) */
  from: string;
  /** inclusive, yyyy-MM-dd */
  to: string;
  /** server aggregation bucket */
  bucket: 'day' | 'month';
  label: string;
  /** anchor date used to build the period */
  anchor: string;
}

const ISO = 'yyyy-MM-dd';

export function toISODate(d: Date): string {
  return format(d, ISO);
}

/** Builds the reporting period that contains `anchor`. Weeks are ISO weeks (Mon–Sun). */
export function buildPeriod(type: PeriodType, anchor: string): ReportPeriod {
  const d = parseISO(anchor);
  switch (type) {
    case 'daily':
      return { type, anchor, from: anchor, to: anchor, bucket: 'day', label: format(d, 'EEEE, MMMM d, yyyy') };
    case 'weekly': {
      const s = startOfISOWeek(d);
      const e = endOfISOWeek(d);
      return {
        type,
        anchor,
        from: toISODate(s),
        to: toISODate(e),
        bucket: 'day',
        label: `Week ${getISOWeek(d)}, ${getISOWeekYear(d)} · ${format(s, 'MMM d')} – ${format(e, 'MMM d, yyyy')}`,
      };
    }
    case 'monthly': {
      const s = startOfMonth(d);
      return { type, anchor, from: toISODate(s), to: toISODate(endOfMonth(d)), bucket: 'day', label: format(s, 'MMMM yyyy') };
    }
    case 'yearly': {
      const s = startOfYear(d);
      return { type, anchor, from: toISODate(s), to: toISODate(endOfYear(d)), bucket: 'month', label: format(s, 'yyyy') };
    }
  }
}

export function shiftPeriod(p: ReportPeriod, direction: 1 | -1): ReportPeriod {
  const d = parseISO(p.anchor);
  const next =
    p.type === 'daily'
      ? addDays(d, direction)
      : p.type === 'weekly'
        ? addWeeks(d, direction)
        : p.type === 'monthly'
          ? addMonths(d, direction)
          : addYears(d, direction);
  return buildPeriod(p.type, toISODate(next));
}

export function isFuturePeriod(p: ReportPeriod, today: string): boolean {
  return isAfter(parseISO(p.from), parseISO(today));
}

/** Converts a native <input type="week"> value (2026-W45) to the Monday of that ISO week. */
export function weekInputToDate(value: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Jan 4th is always in ISO week 1.
  const jan4 = new Date(year, 0, 4);
  const monday = addWeeks(startOfISOWeek(jan4), week - 1);
  return toISODate(monday);
}

export function dateToWeekInput(iso: string): string {
  const d = parseISO(iso);
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`;
}

export function rowLabel(periodStart: string, bucket: 'day' | 'month'): string {
  const d = parseISO(periodStart);
  return bucket === 'month' ? format(d, 'MMMM yyyy') : format(d, 'EEE, MMM d');
}

/** Today's calendar date in the store time zone (reports use store-local days). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return toISODate(now);
  }
}

/** Limits a period to dates that have already happened (no future rows in reports). */
export function clampToToday(p: ReportPeriod, today: string): ReportPeriod {
  return p.to > today && p.from <= today ? { ...p, to: today } : p;
}
