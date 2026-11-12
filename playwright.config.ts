import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// E2E tests run the production build against the test-only Supabase emulator
// (e2e/mock-supabase), which executes every request on a real local PostgreSQL
// database with the project's migrations. Requires a local PostgreSQL server:
//   PGHOST / PGPORT / PGUSER environment variables (defaults: /tmp, 54329, postgres).
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(preinstalled) ? preinstalled : undefined);
const pgEnv = `PGHOST=${process.env.PGHOST ?? '/tmp'} PGPORT=${process.env.PGPORT ?? '54329'} PGUSER=${process.env.PGUSER ?? 'postgres'} TEST_DB=invportiq_e2e`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `${pgEnv} bash -c "scripts/db-test-reset.sh >/dev/null && MOCK_STORAGE_DIR=$(mktemp -d) node e2e/mock-supabase/server.mjs"`,
      url: 'http://127.0.0.1:54400/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        'VITE_SUPABASE_URL=http://127.0.0.1:54400 VITE_SUPABASE_ANON_KEY=e2e-anon-key npx vite build --outDir dist-e2e --logLevel warn && npx vite preview --outDir dist-e2e --port 4180 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4180',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
