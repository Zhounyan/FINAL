#!/usr/bin/env bash
# Fires 20 concurrent single-unit sales at a product holding 10 units.
# Expected: exactly 10 succeed, 10 fail with "Insufficient stock", final stock 0.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PGUSER=${PGUSER:-postgres}
DB=${TEST_DB:-invportiq_conc}
TEST_DB=$DB scripts/db-test-reset.sh >/dev/null 2>&1
ADMIN=00000000-0000-0000-0000-0000000000aa
psql -qX -v ON_ERROR_STOP=1 -d $DB >/dev/null <<SQL
insert into auth.users (id, email) values ('$ADMIN', 'a@b.test');
set role service_role;
select public.complete_initial_setup('$ADMIN', 'a@b.test', 'Admin');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$ADMIN","role":"authenticated"}', false);
insert into public.categories (name) values ('Beverages');
select public.create_product('C-1', 'Cola', 1, 'pc', 1, 2, 0, null, 10);
SQL
OUT=$(mktemp -d)
for i in $(seq 1 20); do
  psql -qX -d $DB -tA >"$OUT/$i.log" 2>&1 <<SQL &
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$ADMIN","role":"authenticated"}', false);
select 'SOLD ' || (public.record_sale('[{"product_id":1,"quantity":1}]', null, 'C-$i')).reference_no;
SQL
done
wait
SOLD=$(cat "$OUT"/*.log | grep -c '^SOLD')
REJ=$(cat "$OUT"/*.log | grep -c 'Insufficient stock')
STOCK=$(psql -qXtA -d $DB -c "select current_stock from public.products where id = 1")
LEDGER=$(psql -qXtA -d $DB -c "select sum(quantity_change) from public.stock_movements where product_id = 1")
echo "sold=$SOLD rejected=$REJ stock=$STOCK ledger_sum=$LEDGER"
rm -rf "$OUT"
psql -qX -d postgres -c "drop database $DB" >/dev/null
[[ $SOLD == 10 && $REJ == 10 && $STOCK == 0 && $LEDGER == 0 ]] && echo "CONCURRENCY TEST PASSED" || { echo "CONCURRENCY TEST FAILED"; exit 1; }
