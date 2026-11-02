#!/usr/bin/env bash
# Runs the database test suite against a throwaway local PostgreSQL database.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGUSER=${PGUSER:-postgres}
TEST_DB=${TEST_DB:-invportiq_test} scripts/db-test-reset.sh >/dev/null 2>&1
psql -X -v ON_ERROR_STOP=1 -d "${TEST_DB:-invportiq_test}" -f supabase/tests/database.test.sql 2>&1 | sed -E "s/^psql:[^ ]+ (NOTICE|WARNING): +//" | grep -E "^(ok|NOT OK)| passed|^ +[0-9]+ \| +[0-9]+|FAILED"
