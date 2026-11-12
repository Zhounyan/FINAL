import { describe, expect, it } from 'vitest';
import { describeSchedule, latestSlot, nextSlot, zonedTimeToUtc } from '@shared/backup-schedule';

const TZ = 'Asia/Manila'; // UTC+8, no daylight saving

describe('weekly backup schedule (Sunday 12:00 AM, store time zone)', () => {
  it('converts store-local midnight to the right UTC instant', () => {
    expect(zonedTimeToUtc(2026, 11, 15, 0, TZ).toISOString()).toBe('2026-11-14T16:00:00.000Z');
  });

  it('finds the most recent Sunday midnight in Manila', () => {
    // Thursday Nov 12 2026, 10:00 Manila
    expect(latestSlot(new Date('2026-11-12T02:00:00Z'), TZ, 0, 0).toISOString()).toBe('2026-11-07T16:00:00.000Z');
    // exactly Sunday 00:00 Manila counts as that Sunday
    expect(latestSlot(new Date('2026-11-14T16:00:00Z'), TZ, 0, 0).toISOString()).toBe('2026-11-14T16:00:00.000Z');
    // one second before: still the previous week
    expect(latestSlot(new Date('2026-11-14T15:59:59Z'), TZ, 0, 0).toISOString()).toBe('2026-11-07T16:00:00.000Z');
  });

  it('computes the next scheduled backup', () => {
    expect(nextSlot(new Date('2026-11-12T02:00:00Z'), TZ, 0, 0).toISOString()).toBe('2026-11-14T16:00:00.000Z');
    expect(nextSlot(new Date('2026-11-14T16:00:00Z'), TZ, 0, 0).toISOString()).toBe('2026-11-21T16:00:00.000Z');
  });

  it('follows a changed day, hour and time zone', () => {
    // Wednesday 2:00 PM in New York (EST, UTC-5 in November)
    expect(nextSlot(new Date('2026-11-12T02:00:00Z'), 'America/New_York', 3, 14).toISOString()).toBe('2026-11-18T19:00:00.000Z');
    expect(describeSchedule(0, 0)).toBe('Every Sunday at 12:00 AM');
    expect(describeSchedule(3, 14)).toBe('Every Wednesday at 2:00 PM');
  });

  it('handles daylight-saving changes', () => {
    // US DST starts Sunday March 8 2026: 2 AM does not exist; midnight does
    expect(zonedTimeToUtc(2026, 3, 8, 0, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedTimeToUtc(2026, 3, 15, 0, 'America/New_York').toISOString()).toBe('2026-03-15T04:00:00.000Z');
  });
});
