import { format, parseISO } from 'date-fns';
import type { MovementType, PaymentMethod, StockOutType } from './types';

let currencyCode = 'PHP';
export function setCurrency(code: string) {
  if (/^[A-Z]{3}$/.test(code)) currencyCode = code;
}

const intFmt = new Intl.NumberFormat('en-US');

export function fmtInt(n: number | string | null | undefined): string {
  return intFmt.format(Number(n ?? 0));
}

export function fmtSigned(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  if (v === 0) return '0';
  return (v > 0 ? '+' : '−') + intFmt.format(Math.abs(v));
}

export function fmtMoney(n: number | string | null | undefined): string {
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency: currencyCode, minimumFractionDigits: 2 }).format(
      Number(n ?? 0),
    );
  } catch {
    return Number(n ?? 0).toFixed(2);
  }
}

function toDate(value: string | Date): Date {
  return typeof value === 'string' ? parseISO(value) : value;
}

export function fmtDate(value: string | Date | null | undefined, pattern = 'MMM d, yyyy'): string {
  if (!value) return '—';
  return format(toDate(value), pattern);
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return format(toDate(value), 'MMM d, yyyy · h:mm a');
}

export function code(prefix: string, id: number | string): string {
  return `${prefix}-${String(id).padStart(5, '0')}`;
}

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  stock_in: 'Stock-In',
  sale: 'Sales Deduction',
  sale_void: 'Voided Sale Return',
  damaged: 'Stock-Out: Damaged',
  expired: 'Stock-Out: Expired',
  lost: 'Stock-Out: Missing/Lost',
  internal_use: 'Stock-Out: Internal Use',
  other_out: 'Stock-Out: Other',
  adjustment: 'Authorized Adjustment',
  reclassify: 'Category Transfer',
};

export const MOVEMENT_TONES: Record<MovementType, 'green' | 'blue' | 'red' | 'amber' | 'slate' | 'violet'> = {
  stock_in: 'green',
  sale: 'blue',
  sale_void: 'slate',
  damaged: 'red',
  expired: 'red',
  lost: 'red',
  internal_use: 'amber',
  other_out: 'amber',
  adjustment: 'violet',
  reclassify: 'slate',
};

export const STOCK_OUT_REASONS: { value: StockOutType; label: string }[] = [
  { value: 'damaged', label: 'Damaged items' },
  { value: 'expired', label: 'Expired items' },
  { value: 'lost', label: 'Missing or lost items' },
  { value: 'internal_use', label: 'Internal use' },
  { value: 'other_out', label: 'Other reason' },
];

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  other: 'Other',
};
export const ALL_PAYMENT_METHODS: PaymentMethod[] = ['cash', 'gcash', 'maya', 'card', 'bank_transfer', 'other'];

export function paymentLabel(method: string | null | undefined): string {
  return method ? (PAYMENT_LABELS[method] ?? method) : '—';
}

/** Peso amounts rounded to centavos, avoiding floating-point drift in cart maths. */
export function money2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
