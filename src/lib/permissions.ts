import type { AppRole, Profile } from './types';

/**
 * UI-level capability map for the two roles. The database (RLS + RPC role
 * checks) and the Edge Functions enforce the same rules — this only decides
 * what to show.
 */
export function capabilities(profile: Pick<Profile, 'role'> | null) {
  const role: AppRole | null = profile?.role ?? null;
  const admin = role === 'admin';
  const cashier = role === 'cashier';
  const active = admin || cashier;
  return {
    role,
    isAdmin: admin,
    isCashier: cashier,
    viewDashboard: active,
    usePos: active,
    viewProducts: active,
    addProducts: admin,
    editProducts: admin,
    deleteProducts: admin,
    viewCostPrices: admin,
    manageCategories: admin,
    /** Stock-In / Stock-Out: both roles (adjustments, reversals and reports stay Administrator-only) */
    recordStockIn: active,
    recordStockOut: active,
    recordAdjustment: admin,
    reverseMovements: admin,
    viewMovementHistory: admin,
    viewStockReports: admin,
    viewSalesReports: admin,
    /** every active user can see transactions — cashiers only their own (RLS) */
    viewTransactions: active,
    viewAllTransactions: admin,
    voidTransactions: admin,
    viewSuppliers: admin,
    manageSuppliers: admin,
    manageUsers: admin,
    viewActivity: admin,
    /** Backup & Restore: Administrator only (also enforced by RLS and the backup Edge Functions) */
    manageBackups: admin,
    manageSettings: admin,
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
export type Capability = Exclude<keyof Capabilities, 'role'>;

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: 'Owner (retired)',
  admin: 'Administrator',
  cashier: 'Cashier',
};
