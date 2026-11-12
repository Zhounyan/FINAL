import type { AppRole, Profile } from './types';

/**
 * UI-level capability map. The database (RLS + RPC role checks) and the Edge
 * Functions enforce the same rules — this only decides what to show.
 */
export function capabilities(profile: Pick<Profile, 'role' | 'can_add_products'> | null) {
  const role: AppRole | null = profile?.role ?? null;
  const admin = role === 'admin';
  const staff = role === 'staff';
  const owner = role === 'owner';
  return {
    role,
    isAdmin: admin,
    isOwner: owner,
    isStaff: staff,
    viewDashboard: Boolean(role),
    viewProducts: Boolean(role),
    addProducts: admin || (staff && Boolean(profile?.can_add_products)),
    editProducts: admin,
    deleteProducts: admin,
    manageCategories: admin,
    viewStockManagement: Boolean(role),
    recordStockIn: admin || staff,
    recordSale: admin || staff,
    recordStockOut: admin || staff,
    recordAdjustment: admin,
    reverseMovements: admin,
    viewDailyMovements: Boolean(role),
    viewMovementHistory: admin || owner,
    viewCustomers: admin || owner,
    manageCustomers: admin,
    viewSuppliers: admin || owner,
    manageSuppliers: admin,
    viewReports: admin || owner,
    manageUsers: admin,
    /** Backup & Restore: Admin only (also enforced by RLS and the backup Edge Functions) */
    manageBackups: admin,
    manageSettings: admin,
    viewActivity: admin || owner,
    viewFinancials: admin || owner,
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
export type Capability = Exclude<keyof Capabilities, 'role'>;

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  staff: 'Staff',
};
