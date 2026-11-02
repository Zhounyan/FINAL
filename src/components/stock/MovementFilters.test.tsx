import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProductRow } from '@/lib/types';
import { CategoryProductFilters, defaultFilterState, type MovementFilterState } from './MovementFilters';

const all = [
  { id: 1, name: 'Cola 1L', sku: 'BEV-001', category_id: 1, category_name: 'Beverages' },
  { id: 2, name: 'Orange Juice', sku: 'BEV-002', category_id: 1, category_name: 'Beverages' },
  { id: 3, name: 'Rice 5kg', sku: 'FOOD-001', category_id: 2, category_name: 'Food Products' },
].map((p) => ({ unit: 'pc', current_stock: 5, min_stock_level: 1, stock_status: 'ok', ...p })) as ProductRow[];

// The hooks query Supabase; here they return fixtures so the component logic is tested in isolation.
vi.mock('@/hooks/data', () => ({
  useCategories: () => ({ data: [{ id: 1, name: 'Beverages' }, { id: 2, name: 'Food Products' }], isLoading: false }),
  useProductOptions: (categoryId?: number | null) => ({
    data: categoryId ? all.filter((p) => p.category_id === categoryId) : all,
    isLoading: false,
  }),
}));

const latest = {} as MovementFilterState;
function Harness({ initial }: { initial?: Partial<MovementFilterState> }) {
  const [v, setV] = useState<MovementFilterState>({ ...defaultFilterState('daily', '2026-11-02'), ...initial });
  Object.assign(latest, v);
  return <CategoryProductFilters value={v} onChange={setV} />;
}

describe('CategoryProductFilters (dependent filter)', () => {
  it('limits the product list to the selected category', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: /^Product/ }));
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Cola'), expect.stringContaining('Rice')]),
    );
    await user.keyboard('{Escape}');

    await user.selectOptions(screen.getByLabelText('Category'), 'Beverages');
    expect(latest.categoryId).toBe(1);
    await user.click(screen.getByRole('combobox', { name: /^Product/ }));
    const names = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names[0]).toBe('All products in category');
    expect(names.some((n) => n.includes('Rice'))).toBe(false);
    expect(names.filter((n) => n.includes('BEV-')).length).toBe(2);
  });

  it('clears a selected product when the category changes', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ productId: 3 }} />);
    expect(latest.productId).toBe(3);
    await user.selectOptions(screen.getByLabelText('Category'), 'Beverages');
    await waitFor(() => expect(latest.productId).toBeNull());
    expect(latest.categoryId).toBe(1);
  });

  it('supports a movement type filter and "All" options', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByLabelText('Category')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Movement type'), 'Sold');
    expect(latest.movementType).toBe('sale');
  });
});
