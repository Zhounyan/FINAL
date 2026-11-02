import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordInput, PasswordStrengthMeter } from './PasswordStrength';
import { SummaryCards, totalsOf, PeriodSummaryTable } from './stock/MovementViews';
import { ProductCombobox } from './stock/ProductCombobox';
import type { PeriodSummaryRow, ProductRow } from '@/lib/types';

const products: ProductRow[] = [
  { id: 1, sku: 'BEV-001', name: 'Cola 1L', category_id: 1, category_name: 'Beverages', unit: 'bottle', current_stock: 30, min_stock_level: 5, stock_status: 'ok' },
  { id: 2, sku: 'BEV-002', name: 'Orange Juice', category_id: 1, category_name: 'Beverages', unit: 'pack', current_stock: 0, min_stock_level: 5, stock_status: 'out' },
  { id: 3, sku: 'FOOD-001', name: 'Rice 5kg', category_id: 2, category_name: 'Food Products', unit: 'sack', current_stock: 4, min_stock_level: 10, stock_status: 'low' },
].map((p) => ({ description: null, purchase_price: 1, selling_price: 2, is_archived: false, created_at: '', updated_at: '', stock_value: 0, ...p })) as ProductRow[];

function PasswordHarness() {
  const [pw, setPw] = useState('');
  return (
    <>
      <PasswordInput label="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <PasswordStrengthMeter password={pw} />
    </>
  );
}

describe('PasswordStrengthMeter', () => {
  it('updates the label and checklist in real time while typing', async () => {
    const user = userEvent.setup();
    render(<PasswordHarness />);
    const input = screen.getByLabelText('Password');
    const label = () => screen.getByTestId('strength-label').textContent;
    expect(label()).toBe('—');

    await user.type(input, 'a');
    expect(label()).toBe('Poor');
    await user.type(input, 'bcdefg1');
    expect(label()).toBe('Weak');
    await user.clear(input);
    await user.type(input, 'Mango#Tr7');
    expect(label()).toBe('Good');
    await user.type(input, 'ee99');
    expect(label()).toBe('Strong');
    await user.type(input, 'x!Rivr');
    expect(label()).toBe('Super Strong');

    const items = within(screen.getByTestId('password-meter')).getAllByRole('listitem');
    expect(items.every((li) => li.getAttribute('data-met') === 'true')).toBe(true);
  });

  it('can reveal the password', async () => {
    const user = userEvent.setup();
    render(<PasswordHarness />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
  });
});

describe('Stock movement summary', () => {
  const rows: PeriodSummaryRow[] = [
    { period_start: '2026-11-01', period_end: '2026-11-01', beginning_stock: 500, stock_in: 150, stock_sold: 35, other_out: 5, adjustments: 5, ending_stock: 615, movement_count: 6 },
    { period_start: '2026-11-02', period_end: '2026-11-02', beginning_stock: 615, stock_in: 80, stock_sold: 25, other_out: 0, adjustments: 0, ending_stock: 670, movement_count: 2 },
  ];

  it('totals a period: first beginning, summed flows, last ending', () => {
    expect(totalsOf(rows)).toEqual({ beginning_stock: 500, stock_in: 230, stock_sold: 60, other_out: 5, adjustments: 5, ending_stock: 670 });
    expect(totalsOf([])).toBeNull();
  });

  it('renders the specification example cards', () => {
    render(<SummaryCards totals={totalsOf(rows.slice(0, 1))} />);
    expect(screen.getByTestId('card-beginning_stock')).toHaveTextContent('500');
    expect(screen.getByTestId('card-stock_in')).toHaveTextContent('+150');
    expect(screen.getByTestId('card-stock_sold')).toHaveTextContent('−35');
    expect(screen.getByTestId('card-other_out')).toHaveTextContent('−5');
    expect(screen.getByTestId('card-adjustments')).toHaveTextContent('+5');
    expect(screen.getByTestId('card-ending_stock')).toHaveTextContent('615');
  });

  it('renders the historical summary table with a totals row', () => {
    render(<PeriodSummaryTable rows={rows} bucket="day" totals={totalsOf(rows)} />);
    const table = screen.getByTestId('period-table');
    const bodyRows = within(table).getAllByRole('row');
    expect(bodyRows).toHaveLength(1 + 2 + 1); // header + 2 days + total
    expect(bodyRows[1]).toHaveTextContent('Sun, Nov 1');
    expect(bodyRows[3]).toHaveTextContent('Period total');
    expect(bodyRows[3]).toHaveTextContent('670');
  });
});

describe('ProductCombobox', () => {
  it('filters by name or SKU and selects with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProductCombobox label="Product" products={products} value={null} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.type(input, 'food');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('offers an "all" option when used as a filter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProductCombobox products={products} value={1} onChange={onChange} allowAll allLabel="All products" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'All products' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
