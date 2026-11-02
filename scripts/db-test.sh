#!/usr/bin/env bash
# Runs the database test suite against a throwaway local PostgreSQL database.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGUSER=${PGUSER:-postgres}
TEST_DB=${TEST_DB:-invportiq_test} scripts/db-test-reset.sh >/dev/null 2>&1
psql -X -v ON_ERROR_STOP=1 -d "${TEST_DB:-invportiq_test}" -f supabase/tests/database.test.sql 2>&1 | sed -E "s/^psql:[^ ]+ (NOTICE|WARNING): +//" | grep -E "^(ok|NOT OK)| passed|^ +[0-9]+ \| +[0-9]+|FAILED"

# Hosted Supabase enforces `safeupdate`: UPDATE/DELETE must have a WHERE clause.
# Flag any statement in the migrations that would be rejected there.
node -e '
const fs=require("fs");let bad=[];
for(const f of fs.readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql"))){
  const src=fs.readFileSync("supabase/migrations/"+f,"utf8");
  for(const m of src.matchAll(/\b(update\s+[\w.]+\s+set|delete\s+from\s+[\w.]+)[^;]*;/gis)){
    if(!/\bwhere\b/i.test(m[0])) bad.push(f+": "+m[0].split("\n")[0].trim());
  }
}
// the original 000300 statement is superseded by migration 000600
bad=bad.filter(b=>!b.startsWith("20261102000300_business_functions.sql: update public.setup_state"));
if(bad.length){console.error("safeupdate violations:\n"+bad.join("\n"));process.exit(1)}
console.log("ok - all UPDATE/DELETE statements have a WHERE clause (safeupdate)");'
