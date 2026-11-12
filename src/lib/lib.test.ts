import { describe, expect, it } from 'vitest';
import { assessPassword, passwordPolicyError, STRENGTH_LABELS } from '@shared/password-policy';
import { buildPeriod, dateToWeekInput, rowLabel, shiftPeriod, todayIn, weekInputToDate } from './periods';
import { ilikeOr, sanitizeSearch } from './search';
import { capabilities } from './permissions';
import { errorMessage } from './errors';
import { fmtSigned } from './format';

describe('password policy', () => {
  it('lists the four mandatory requirements', () => {
    const a = assessPassword('abc');
    expect(a.requirements.map((r) => r.id)).toEqual(['length', 'uppercase', 'number', 'symbol']);
    expect(a.valid).toBe(false);
  });

  it('requires 8+ chars, an uppercase letter, a number and a symbol', () => {
    expect(assessPassword('Abcdefg1').valid).toBe(false); // no symbol
    expect(assessPassword('abcdefg1!').valid).toBe(false); // no uppercase
    expect(assessPassword('Abcdefgh!').valid).toBe(false); // no number
    expect(assessPassword('Ab1!').valid).toBe(false); // too short
    expect(assessPassword('Mango#Tree7').valid).toBe(true);
  });

  it('produces every strength label from Poor to Super Strong', () => {
    const samples: Record<string, string> = {
      Poor: 'a',
      Weak: 'abcdefgh1',
      Fair: 'Abcdefgh1',
      Good: 'Mango#Tr7',
      Strong: 'Mango#Tree7xz',
      'Super Strong': 'Mango#Tree7x!Rivr',
    };
    for (const [label, pw] of Object.entries(samples)) expect(assessPassword(pw).label, pw).toBe(label);
    expect(STRENGTH_LABELS).toEqual(['Poor', 'Weak', 'Fair', 'Good', 'Strong', 'Super Strong']);
  });

  it('penalises common words and sequences', () => {
    const a = assessPassword('Password1234!!xyzQ');
    expect(a.valid).toBe(true);
    expect(a.label).not.toBe('Super Strong');
    expect(a.warnings.length).toBeGreaterThan(0);
  });

  it('explains what is missing', () => {
    expect(passwordPolicyError('abcdefgh')).toMatch(/uppercase.*number.*symbol/i);
    expect(passwordPolicyError('Mango#Tree7')).toBeNull();
    expect(passwordPolicyError('A1!' + 'x'.repeat(80))).toMatch(/at most 72/);
  });
});

describe('reporting periods', () => {
  it('daily period is a single day', () => {
    const p = buildPeriod('daily', '2026-11-01');
    expect([p.from, p.to, p.bucket]).toEqual(['2026-11-01', '2026-11-01', 'day']);
  });
  it('weekly period is the ISO week Monday–Sunday', () => {
    const p = buildPeriod('weekly', '2026-11-04'); // Wednesday
    expect([p.from, p.to]).toEqual(['2026-11-02', '2026-11-08']);
    expect(p.label).toContain('Week 45');
  });
  it('monthly and yearly periods', () => {
    expect(buildPeriod('monthly', '2026-02-14')).toMatchObject({ from: '2026-02-01', to: '2026-02-28', bucket: 'day' });
    expect(buildPeriod('yearly', '2024-06-01')).toMatchObject({ from: '2024-01-01', to: '2024-12-31', bucket: 'month' });
  });
  it('shifts periods backwards and forwards', () => {
    expect(shiftPeriod(buildPeriod('monthly', '2026-01-31'), -1).from).toBe('2025-12-01');
    expect(shiftPeriod(buildPeriod('weekly', '2026-11-04'), 1).from).toBe('2026-11-09');
    expect(shiftPeriod(buildPeriod('yearly', '2026-03-01'), -1).label).toBe('2025');
  });
  it('converts ISO week inputs', () => {
    expect(weekInputToDate('2026-W45')).toBe('2026-11-02');
    expect(dateToWeekInput('2026-11-08')).toBe('2026-W45');
    expect(weekInputToDate('garbage')).toBeNull();
  });
  it('computes today in the store time zone', () => {
    const instant = new Date('2026-11-01T17:30:00Z'); // 01:30 on Nov 2 in Manila
    expect(todayIn('Asia/Manila', instant)).toBe('2026-11-02');
    expect(todayIn('America/New_York', instant)).toBe('2026-11-01');
  });
  it('labels rows', () => {
    expect(rowLabel('2026-11-01', 'month')).toBe('November 2026');
    expect(rowLabel('2026-11-01', 'day')).toBe('Sun, Nov 1');
  });
});

describe('search sanitising (PostgREST filter injection)', () => {
  it('strips filter syntax characters', () => {
    expect(sanitizeSearch('cola),id.gt.(0')).toBe('cola id.gt. 0');
    expect(ilikeOr(['name'], 'a,b')).toBe('name.ilike.*a b*');
  });
  it('escapes LIKE wildcards', () => {
    expect(sanitizeSearch('50%_off')).toBe('50\\%\\_off');
  });
  it('returns null for blank input', () => {
    expect(ilikeOr(['name'], '  ()  ')).toBeNull();
  });
});

describe('role permissions (UI layer mirrors database RBAC)', () => {
  it('owner is read-only', () => {
    const c = capabilities({ role: 'owner', can_add_products: false });
    expect(c.viewReports && c.viewMovementHistory && c.viewCustomers && c.viewSuppliers).toBe(true);
    expect(c.addProducts || c.editProducts || c.recordStockIn || c.recordSale || c.manageUsers || c.manageCustomers).toBe(false);
    expect(c.manageBackups).toBe(false);
  });
  it('staff performs stock operations and adds products only when authorised', () => {
    expect(capabilities({ role: 'staff', can_add_products: false }).addProducts).toBe(false);
    const c = capabilities({ role: 'staff', can_add_products: true });
    expect(c.addProducts && c.recordStockIn && c.recordSale && c.recordStockOut).toBe(true);
    expect(c.recordAdjustment || c.editProducts || c.manageUsers || c.manageSettings || c.viewReports).toBe(false);
    expect(c.manageBackups).toBe(false);
  });
  it('admin manages everything', () => {
    const c = capabilities({ role: 'admin', can_add_products: false });
    expect(Object.entries(c).filter(([k, v]) => k !== 'role' && k !== 'isOwner' && k !== 'isStaff' && v === false)).toEqual([]);
  });
  it('signed-out users have no capabilities', () => {
    expect(capabilities(null).viewDashboard).toBe(false);
  });
});

describe('error messages', () => {
  it('passes through friendly database errors', () => {
    expect(errorMessage({ code: 'P0001', message: 'Insufficient stock for "Cola"' })).toBe('Insufficient stock for "Cola"');
  });
  it('hides raw policy errors', () => {
    expect(errorMessage({ code: '42501', message: 'new row violates row-level security policy for table "customers"' })).toMatch(/permission/);
    expect(errorMessage({ code: '23505', message: 'duplicate key value violates unique constraint "x"' })).toMatch(/already exists/);
  });
  it('formats signed quantities', () => {
    expect(fmtSigned(5)).toBe('+5');
    expect(fmtSigned(-1200)).toBe('−1,200');
    expect(fmtSigned(0)).toBe('0');
  });
});

describe('future dates are excluded from reports', () => {
  it('caps the current period at today', async () => {
    const { clampToToday } = await import('./periods');
    expect(clampToToday(buildPeriod('monthly', '2026-11-02'), '2026-11-02').to).toBe('2026-11-02');
    expect(clampToToday(buildPeriod('monthly', '2026-10-02'), '2026-11-02').to).toBe('2026-10-31');
  });
});
