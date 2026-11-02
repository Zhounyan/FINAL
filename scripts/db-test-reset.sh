#!/usr/bin/env bash
# Recreates a throwaway local database, applies the Supabase stub + all migrations.
# Usage: PGHOST=/tmp PGPORT=54329 scripts/db-test-reset.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-invportiq_test}
export PGUSER=${PGUSER:-postgres}
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
echo "Database $DB ready."
