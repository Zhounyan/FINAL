-- ============================================================================
-- INVPORTIQ POS reconstruction — part 1 of 2: enum changes.
-- Kept in its own migration because new enum values can only be used after
-- the transaction that adds them has committed. Run this file first.
-- ============================================================================

-- Exactly two working roles: Administrator and Cashier.
-- "staff" becomes "cashier" (existing staff accounts keep working as cashiers).
-- "owner" stays in the type only so historical rows remain valid; owner
-- accounts are deactivated in part 2 and can no longer be created.
do $$
begin
  if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
              where t.typname = 'app_role' and e.enumlabel = 'staff') then
    alter type public.app_role rename value 'staff' to 'cashier';
  end if;
end $$;

-- Stock-out reasons and sale voids.
alter type public.movement_type add value if not exists 'expired';
alter type public.movement_type add value if not exists 'internal_use';
alter type public.movement_type add value if not exists 'sale_void';
