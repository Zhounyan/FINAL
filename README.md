<p align="center"><img src="public/logo-192.png" width="120" alt="Bill Store logo"></p>

# INVPORTIQ

**An Inventory Management and Business Intelligence System for Bill Store** (single branch).

INVPORTIQ manages products, categories, customers, suppliers, stock movements, sales, users and reports. It shows exactly how many units came into Bill Store, how many were sold or released, and how much remains for any day, week, month or year. You can view this for all inventory, for one category, or for one product.

---

## Contents
1. [Technology](#technology)
2. [Architecture](#architecture)
3. [Roles & permissions](#roles--permissions)
4. [Inventory model](#inventory-model-how-the-numbers-are-calculated)
5. [Local development](#local-development)
6. [Production deployment](#production-deployment)
7. [Testing](#testing)
8. [Security](#security)
9. [Project structure](#project-structure)
10. [Known limitations](#known-limitations)

---

## Technology

| Layer | Stack |
|---|---|
| Frontend | Node.js, Vite, React 19, TypeScript, Tailwind CSS 4, React Router, TanStack Query, React Hook Form + Zod, Recharts, date-fns, Sonner, Lucide |
| Backend | Supabase: PostgreSQL, Supabase Auth, Row Level Security, PostgreSQL functions (RPC) and triggers, Supabase Realtime, Edge Functions (Deno) |
| Exports | xlsx (SheetJS) for Excel, jsPDF + jsPDF-AutoTable for PDF and print |
| Quality | ESLint, Vitest, React Testing Library, Playwright, SQL test suite |

## Architecture

```
Browser (React SPA, anon key only)
  │  supabase-js
  ├── PostgREST ──► PostgreSQL ── RLS policies on every table
  │                 ├── SECURITY DEFINER RPCs: role check + transaction + ledger write
  │                 ├── triggers: ledger balances, immutability, audit log, timestamps
  │                 └── reporting RPCs (SECURITY INVOKER, RLS applies)
  ├── Realtime ───► dashboard / lists refresh automatically
  └── Edge Functions (service role key stays on the server)
        initial-setup · auth-login · admin-users · change-password
```

* **Nothing writes inventory directly.** API roles have no INSERT/UPDATE grant on `products`, `stock_movements`, `sales` or `sale_items`. Every stock change goes through a transactional RPC (`record_stock_in`, `record_sale`, `record_stock_out`, `record_adjustment`, `reverse_movement`, `create_product`, `update_product`).
* **The ledger is the source of truth.** `products.current_stock` changes only as a side effect of inserting a `stock_movements` row. A trigger blocks every other path, including the database owner. A movement row can never be edited, deleted or truncated.
* **Privileged account operations** (creating users, password resets, deactivation, the one-time setup, login lockout) run in Edge Functions using the service-role key. That key never reaches the browser.

### Database tables

`profiles`, `categories`, `products`, `customers`, `suppliers`, `sales`, `sale_items`, `stock_movements`, `activity_logs`, `system_settings`, plus `setup_state` (one-time setup lock) and `auth_lockouts` (brute-force protection).
Read models: `product_overview`, `customer_overview`, `supplier_overview` (all `security_invoker`).
Migrations: `supabase/migrations/*.sql`.

## Roles & permissions

Each role is enforced three times: in the database (RLS and RPC role checks), in the Edge Functions, and in the UI.

| Capability | Owner | Admin | Staff |
|---|:-:|:-:|:-:|
| Dashboard & analytics | ✅ | ✅ | ✅ |
| View products / stock levels | ✅ | ✅ | ✅ |
| Add products | – | ✅ | if authorised by Admin |
| Edit / delete products, manage categories | – | ✅ | – |
| Stock In, Record Sale, Damaged/Lost/Other Stock Out | – | ✅ | ✅ |
| Stock adjustments, reverse erroneous movements | – | ✅ | – |
| Daily Stock Movements | ✅ | ✅ | ✅ |
| Stock Movement History (daily/weekly/monthly/yearly) | ✅ | ✅ | – |
| Customers & suppliers | view | manage | – (pickers only) |
| Reports, PDF/Excel export, print | ✅ | ✅ | – |
| User management, store settings | – | ✅ | – |
| Activity log | ✅ | ✅ | own entries |
| Change own password / profile | ✅ | ✅ | ✅ |

The Owner has strictly read-only access. There is no public registration. The Admin creates every Owner and Staff account.

## Inventory model (how the numbers are calculated)

```
Ending Stock = Beginning Stock + Stock In − Stock Sold − Other Stock Out ± Adjustments
```

* **Movement types:** `stock_in`, `sale`, `damaged`, `lost`, `other_out`, `adjustment`, `reclassify` (category transfer).
* **Balances come from the ledger.** The balance at any moment is the sum of all movements before it. That makes day N's ending stock equal to day N+1's beginning stock by construction.
* **Day boundaries use the store time zone** (`system_settings.timezone`, default `Asia/Manila`).
* **Sales are atomic.** A sale, its line items and its one `sale` movement per product are written in a single transaction:
  * product rows are locked in id order, so concurrent sales cannot oversell;
  * if any line is short of stock, nothing is written;
  * a client idempotency key means a retried or double-clicked sale is recorded only once.
* **Timestamps are server-generated**, so history cannot be back-dated.
* **History stays accurate after edits.**
  * Every movement stores a snapshot of the product name, SKU and category.
  * Renaming a product does not rewrite history.
  * Moving a product to another category writes a net-zero transfer pair. Category reports for past periods keep their original totals.
* **Corrections are never edits.** An Admin records an adjustment, or reverses a wrong entry (each entry can be reversed only once).
* **Deletes are safeguarded.** A product, customer or supplier with history is archived instead of deleted. Products that still hold stock, and categories that are in use, cannot be removed.

## Local development

Prerequisites: Node.js 20+, the [Supabase CLI](https://supabase.com/docs/guides/cli) (installed as a dev dependency) and Docker.

```bash
npm install
```

```bash
npx supabase start
```

```bash
npx supabase db reset
```

`db reset` applies all migrations. `supabase start` prints an API URL and an anon key. Copy them into `.env.local`:

```bash
cp .env.example .env.local
```

Serve the Edge Functions (keep this terminal open):

```bash
npx supabase functions serve
```

Start the app in another terminal:

```bash
npm run dev
```

Open http://localhost:5173. On a fresh database you are redirected to **Initial administrator setup**. Create the Admin there. The page then closes permanently.

## Production deployment

1. **Create a Supabase project.** Note the project ref, the API URL and the anon (publishable) key.
2. **Apply the database migrations:**
   ```bash
   npx supabase login
   ```
   ```bash
   npx supabase link --project-ref <project-ref>
   ```
   ```bash
   npx supabase db push
   ```
3. **Configure Auth** (Dashboard → Authentication):
   * Disable "Allow new users to sign up". Accounts are created by the Admin.
   * Set the minimum password length to **8**.
   * Set the Site URL to your frontend URL and add `https://<your-domain>/reset-password` to the Redirect URLs.
   * Configure SMTP so password-recovery emails are delivered.
   * Keep the default sign-in rate limits enabled.
4. **Set the Edge Function secrets.** `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
   ```bash
   npx supabase secrets set ALLOWED_ORIGINS=https://inventory.billstore.example
   ```
   Recommended: set a one-time setup token, so only someone holding it can create the first Admin:
   ```bash
   npx supabase secrets set INITIAL_SETUP_TOKEN=<long-random-string>
   ```
5. **Deploy the Edge Functions:**
   ```bash
   npm run functions:deploy
   ```
6. **Build and host the frontend** on any static host (Cloudflare Pages, Netlify, Vercel, Supabase Storage + CDN, …):
   ```bash
   VITE_SUPABASE_URL=https://<ref>.supabase.co VITE_SUPABASE_ANON_KEY=<anon-key> npm run build
   ```
   Upload `dist/` and configure an SPA fallback (all routes → `index.html`). For Cloudflare Pages, add `public/_redirects` containing `/* /index.html 200`.
7. **Complete the initial setup.** Open the site and create the first Admin. If you set `INITIAL_SETUP_TOKEN`, enter it on the setup page.
8. **Create the other accounts.** In **User Management**, create the Owner and Staff accounts. Each user changes the temporary password at first sign-in.

> Never place the `service_role` key in any `VITE_` variable or in frontend code.

## Testing

| Command | What it covers |
|---|---|
| `npm run lint` | ESLint (TypeScript and React Hooks rules) |
| `npm run typecheck` | Frontend, tooling and Edge Function TypeScript |
| `npm test` | Vitest + React Testing Library: password policy and strength meter, period maths, the dependent category→product filter, summary cards, search sanitising, permission matrix |
| `npm run test:db` | Applies the real migrations to a scratch PostgreSQL database, then runs **121 assertions**. It also runs a concurrency test: 20 simultaneous sales compete for 10 units |
| `npm run test:e2e` | Playwright: a full browser journey against the production build |

`npm run test:db` calls the RPCs as the `anon`, `authenticated` and `service_role` roles with JWT claims, the same way PostgREST does. Its assertions cover RBAC/RLS, one-time setup, ledger invariants, immutability, atomic sales, the daily/weekly/monthly/yearly/category/product report maths (including the specification's 500 → 615 example), time-zone boundaries, safeguarded deletes, lockout and deactivation.

`npm run test:e2e` covers 13 scenarios:
* setup and the live password meter;
* master data and newest-first sorting;
* stock in, sale, damaged stock out and adjustment;
* daily movement cards and the history filters;
* PDF and Excel export;
* user creation, the forced password change, Owner and Staff restrictions;
* brute-force lockout;
* the mobile layout.

The database and e2e tests need a local PostgreSQL 15+ server. Set `PGHOST`, `PGPORT` and `PGUSER` (defaults: `/tmp`, `54329`, `postgres`).

The e2e suite runs the real Edge Function source and the real migrations through `e2e/mock-supabase/server.mjs`. This is a **test-only** emulator of the Supabase Auth and REST HTTP APIs that executes every query in PostgreSQL under the correct role and JWT claims. Use `supabase start` for a full local stack during development.

## Security

* Supabase Auth with server-side session validation. Inactive accounts are banned in Auth, their sessions are revoked, and RLS denies them access at once.
* Password policy: at least 8 characters, with an uppercase letter, a number and a special symbol.
  * The policy file is shared by the browser and the server, and the Edge Functions enforce it.
  * The live strength meter runs Poor → Weak → Fair → Good → Strong → Super Strong.
* Brute-force protection: 5 failed sign-ins lock the account for 15 minutes, on top of Supabase Auth's per-IP rate limits.
* Password changes and Admin resets revoke all sessions. Admin resets force a password change at the next sign-in.
* The one-time Admin setup is atomic (a single row with a primary-key lock), can never be repeated, and has no default or demo credentials.
* Input is validated with Zod in the UI and checked again by database constraints and RPC checks.
* Queries are parameterised. Free-text search is sanitised against PostgREST filter injection, and React escapes all output.
* Security headers on Edge Function responses: CORS allow-list, `no-store`, `nosniff`.
* Audit trail: sign-ins, every master-data change (with a field-level diff), every stock operation, and user-management actions.

## Project structure

```
src/
  auth/            AuthProvider (session, profile, capabilities), route guards
  components/      UI kit, layout, password meter, stock movement views/filters, export buttons
  hooks/           data hooks, realtime invalidation, pagination
  lib/             api (all Supabase calls), types, periods, export (PDF/Excel), permissions, format
  pages/           Dashboard, Products, Stock, Daily Movements, History, Customers, Suppliers,
                   Reports, Users, Settings, Profile, auth/*
supabase/
  migrations/      schema, triggers, business RPCs, reporting RPCs, RLS & grants
  functions/       initial-setup, auth-login, admin-users, change-password, _shared/
  tests/           database.test.sql, concurrency.test.sh, supabase_stub.sql (test-only)
e2e/               Playwright specs + test-only Supabase emulator
```

## Known limitations

* **Single branch by design.** There are no multi-location features.
* **Excel exports use the npm build of SheetJS (`xlsx@0.18.5`).** Its published advisories concern *parsing* untrusted spreadsheets, which INVPORTIQ never does; it only writes files. To remove the advisory, install the patched build from `https://cdn.sheetjs.com/`.
* **Movement timestamps are server-generated, so stock cannot be back-dated.** Record late entries on the day they are entered and note the actual date in the reference or reason.
* **The movement-type filter applies to the entries list and the transaction reports.** Beginning and ending balances always include every movement, so they stay correct.
