# Phase A: The Engine — Ralph Loop Execution Plan

## Enhancement Summary

**Deepened on:** 2026-02-15
**Research agents used:** 9 (Supabase RPC best practices, React financial patterns, Twelve Data API integration, PL/pgSQL financial ledger patterns, security audit, performance analysis, architecture review, simplicity review, data integrity review)
**Context7 docs consulted:** Supabase RPCs/RLS, React Router v7, Twelve Data batch API, Supabase JS client

### Key Improvements
1. **Security hardening:** 3 CRITICAL findings — disable signups, derive `created_by` from `auth.uid()`, move API key server-side
2. **Schema hardening:** UNIQUE constraint on stock_positions, advisory locks, CHECK constraints, ENUM types, composite indexes
3. **Implementation patterns:** Implicit transactions (no BEGIN/COMMIT), `jsonb_build_object()` for metadata, `ORDER BY date DESC LIMIT 1` for latest price
4. **Frontend patterns:** TanStack Query v5 for state, Zod + React Hook Form for validation, `type="text" + inputMode="decimal"` for money inputs
5. **T8 decision:** Hanzi Dojo delta logic folded into T12 (Add Money) via transaction metadata — no separate table or RPC needed
6. **T10 decision:** Investment Simulator INCLUDED with expanded scope — uses real historical stock data for risk/reward comparison + multi-year CD compounding

### Critical Changes to Integrate Before Execution

| # | Change | Source | Task Affected |
|---|--------|--------|---------------|
| 1 | Disable Supabase signups + add `admin_users` table | Security audit | P4, T2 |
| 2 | Remove `p_created_by` param from ALL RPCs — derive from `auth.uid()` | Security audit | T4-T7, T14 |
| 3 | Move Twelve Data API call to Supabase Edge Function | Security + Architecture | T9 |
| 4 | Add `UNIQUE(kid_id, ticker)` to `stock_positions` | Architecture + Data integrity | T2 |
| 5 | Use Postgres ENUM types (not text + CHECK) | Supabase best practices | T2 |
| 6 | Add composite indexes on transactions | Performance analysis | T2 |
| 7 | Add advisory locks to all check-then-write RPCs | PL/pgSQL patterns + Data integrity | T4-T7, T14 |
| 8 | Add amount CHECK constraints + validation in RPCs | Security + Data integrity | T2, T4-T7 |
| 9 | Add settings validation trigger | Security + Data integrity | T2 |
| 10 | Add `dividend` to transaction type enum | Architecture + Data integrity | T2 |
| 11 | Expand T9 to fetch 5-year historical prices (not just latest) | T10 expansion | T9, T10 |
| 12 | Fold Hanzi Dojo points tracking into T12 via transaction metadata | T8 simplification | T2, T12 |

---

## Overview

Phase A builds the complete backend + data layer + basic admin UI. Every task is atomic, machine-verifiable, and has explicit acceptance criteria. Phase B (kid-facing UX, visual design, delight) follows interactively.

## Architecture Principles

### PL/pgSQL RPCs vs. TypeScript Functions

All financial operations that move money between buckets involve multiple coordinated writes. These **must** be atomic — if any step fails, the entire operation rolls back. This determines where logic lives:

| Operation Type | Implementation | Why |
|---------------|---------------|-----|
| **Writes that move money** (invest, redeem, buy, sell, break CD, mature CD, deposit, withdraw) | **PL/pgSQL RPC** in Supabase | Atomicity via implicit transaction. A failed step auto-rolls back. No partial state. |
| **Reads** (get_balance, get_positions, get_portfolio_summary) | **TypeScript function** calling Supabase JS client | No atomicity needed. Easier to compose and test. |
| **Pure computation** (investment simulator) | **TypeScript function**, client-side | No database interaction beyond reading settings. Pure math. |

**The rule:** If the function creates or modifies rows in `transactions`, `cd_lots`, or `stock_positions`, it's a PL/pgSQL RPC. Everything else is TypeScript.

> **Research insight (Supabase docs):** PL/pgSQL functions run inside an **implicit transaction**. You do NOT need explicit `BEGIN...COMMIT` inside functions. If any statement raises an exception, the entire function rolls back automatically. Never use `COMMIT` or `ROLLBACK` inside a function — they will error.

### Authorization Model

> **Research insight (Security audit — CRITICAL):** The original plan accepted `p_created_by` as a parameter in all RPCs. This is forgeable. Always derive the caller's identity from `auth.uid()` inside the function.

**Every RPC MUST follow this authorization pattern:**

```sql
CREATE FUNCTION some_rpc(p_kid_id uuid, p_amount numeric, ...)
RETURNS ... AS $$
DECLARE
  v_caller_id uuid := auth.uid();  -- ALWAYS derive, never accept as param
BEGIN
  -- Verify caller is an admin
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin';
  END IF;

  -- Use v_caller_id for created_by
  INSERT INTO transactions (..., created_by)
  VALUES (..., v_caller_id);
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
```

### Concurrency Control

> **Research insight (PL/pgSQL patterns + Data integrity):** Advisory locks prevent concurrent balance checks from causing overdrafts. `pg_advisory_xact_lock` serializes per-kid operations, releases automatically at transaction end.

**Every check-then-write RPC MUST acquire an advisory lock:**

```sql
-- Hash the kid UUID to a bigint for the advisory lock key
PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

-- Now safe to read balance and write — serialized per kid
```

Apply to: `withdraw_from_cash`, `invest_in_mmf`, `redeem_from_mmf`, `create_cd`, `buy_stock`, `sell_stock`, `spend_from_mmf`, `spend_from_stock`

> **Note:** `deposit_to_cash` does NOT need an advisory lock — deposits are additive and cannot overdraft.

### MMF Interest Accrual Tracking

Last accrual date is derived from the most recent `type='interest', bucket='mmf'` transaction for that kid. No separate tracking column needed — the ledger is the source of truth. If no interest transaction exists, the accrual period starts from the kid's first MMF investment transaction.

### Spending from Non-Cash Buckets

When spending from MMF or stocks, the liquidation and withdrawal happen inside a **single PL/pgSQL RPC** (e.g., `spend_from_mmf(kid_id, amount, note)`). Money does NOT briefly land in cash — the RPC creates the redeem + withdraw transactions atomically in one call. This prevents orphaned state if any step fails.

### Stock Ticker Validation

The "Buy Stock/ETF" form accepts a free-text ticker input. Validation is limited to: (1) ticker exists in `stock_prices` table (meaning Twelve Data has returned data for it), and (2) ticker matches regex `^[A-Z]{1,10}$`. No autocomplete, no search, no API lookup at buy time. If a kid wants to buy a new ticker, the parent first adds it via a "Track New Ticker" action (which fetches from Twelve Data and inserts prices), then the kid can buy it.

> **Research insight (Security audit):** Always validate ticker format with regex before database lookup or API call. Prevents injection via crafted ticker strings.

### CD Simulator Projections

The investment simulator shows CD projections for each term that fits within the selected time horizon. It assumes a **single term, no reinvestment**. For example, `simulate_growth($100, 9)` shows CD 3m and CD 6m projections (both would have matured), but the return shown is for one term of each — not "3m CD reinvested 3 times." This keeps the math honest and the teaching moment clear.

## Development Standards (From Hanzi Dojo Learnings)

> These standards were extracted from 6 Hanzi Dojo solution documents. They are **preventive** — integrate before Phase A begins, not discovered during execution. Full analysis: `LEARNINGS_APPLIED.md`.

### SQL RPC Development Checklist (All Tasks T4-T7, T14)

**Every PL/pgSQL function MUST follow this pattern:**

```sql
-- GOOD: Explicit aliases everywhere
CREATE FUNCTION deposit_to_cash(p_kid_id uuid, p_amount numeric, ...)
RETURNS TABLE (new_balance numeric) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kids k        -- Explicit alias
    WHERE k.id = p_kid_id       -- Use alias, not bare 'id'
  ) THEN
    RAISE EXCEPTION 'Unauthorized...';
  END IF;

  RETURN QUERY
  SELECT SUM(t.amount) AS new_balance  -- Alias matches RETURNS TABLE param
  FROM transactions t
  WHERE t.kid_id = p_kid_id
  AND t.bucket = 'cash';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
```

**Before writing any RPC:**
- [ ] Use explicit table aliases in ALL queries (`t.kid_id`, `k.id`, not bare `id`)
- [ ] Use explicit column aliases in SELECT (`SUM(t.amount) AS new_balance`)
- [ ] If RETURNS TABLE has OUT param named X, never write bare X in WHERE/SELECT
- [ ] Test in Supabase SQL Editor with real UUIDs before wiring to frontend
- [ ] `created_by` derived from `auth.uid()`, NOT accepted as parameter
- [ ] Advisory lock acquired before balance check (`pg_advisory_xact_lock`)
- [ ] Amount validated: positive, <= $100,000, exactly 2 decimal places
- [ ] String inputs length-limited (notes <= 500 chars, tickers <= 10 chars)
- [ ] JSONB built with `jsonb_build_object()`, never string concatenation
- [ ] Structured errors with `RAISE EXCEPTION ... USING DETAIL, HINT, ERRCODE`

> **Why this exists (Hanzi Dojo Issue #40, #42):** RETURNS TABLE creates OUT parameters that conflict with bare column names. Bug was introduced twice — silently returns wrong results without errors.

### Migration Data Validation Pattern

**Rule: Query actual data before writing migration constraints.** See `LEARNINGS_APPLIED.md` Section 2.

### Pre-Modification RPC Checklist (Post-Phase-A Maintenance)

**Every time an existing RPC function is modified:** read the full evolution via `git log`, base changes on LATEST migration, add comments for non-obvious clauses. See `LEARNINGS_APPLIED.md` Section 3.

### Data Inheritance Validation

Financial data flows through derived chains. See `LEARNINGS_APPLIED.md` Section 4 for source-to-derived validation patterns.

---

## Prerequisites (Manual, Before Ralph Loop Starts)

These must be done by Melody before autonomous execution:

- [ ] **P1: Create Supabase project** — new project in Supabase dashboard
- [ ] **P2: Get Supabase credentials** — project URL + anon key + service role key
- [ ] **P3: Get Twelve Data API key** — free registration at twelvedata.com
- [ ] **P4: Create two admin users** in Supabase Auth dashboard (email + password for Melody and husband)
- [ ] **P4b: Disable signups** — Supabase Dashboard > Authentication > Settings > toggle OFF "Enable sign up" *(CRITICAL — prevents unauthorized account creation)*
- [ ] **P5: Store secrets** — add to `.env.local` in repo root:
  ```
  VITE_SUPABASE_URL=...
  VITE_SUPABASE_ANON_KEY=...
  # DANGER: NEVER prefix with VITE_ — this key bypasses all RLS
  SUPABASE_SERVICE_ROLE_KEY=...
  TWELVE_DATA_API_KEY=...
  ```
- [ ] **P6: Store test credentials** — add to `.env.test.local` (gitignored):
  ```
  TEST_ADMIN_EMAIL=...
  TEST_ADMIN_PASSWORD=...
  ```

---

## Task Dependency Graph

```
T1 (scaffold) ──┬── T2 (schema) ──┬── T3 (auth)
                 │                 ├── T4 (deposit/withdraw RPCs)
                 │                 ├── T5 (MMF interest RPCs)
                 │                 ├── T6 (CD management RPCs)
                 │                 └── T7 (stock position RPCs)
                 │                 │
                 │                 ├── T9 (Twelve Data integration) ── depends on T7
                 │                 └── T10 (investment simulator) ── depends on T5, T6, T9
                 │
                 └── T11 (admin UI: dashboard) ── depends on T3, T4
                     T12 (admin UI: add money) ── depends on T4
                     T13a (admin UI: MMF management) ── depends on T5
                     T13b (admin UI: CD management) ── depends on T6
                     T13c (admin UI: stock management) ── depends on T7, T9
                     T14 (admin UI: record spend) ── depends on T4, T7
                     T15 (admin UI: settings) ── depends on T3
```

**Parallelizable groups:**
- After T2: T3, T4, T5, T6, T7 can all run in parallel
- After T7: T9 can start
- After T5, T6, T9: T10 can start
- After T3, T4: T11-T15 can run in parallel

> **T8 decision:** Hanzi Dojo delta logic folded into T12 as conditional form behavior. No separate table or RPC — point snapshots stored in transaction metadata. See T12 for details.
>
> **T10 decision:** Investment Simulator included with expanded scope. Uses real historical stock data from Twelve Data (via T9) for risk/reward comparison. Multi-year CD reinvestment compounding. Depends on T9 for historical prices.

---

## Tasks

### T1: Scaffold Project

**What:** Initialize React + Vite + TypeScript + Tailwind + Supabase project with React Router.

**Acceptance Criteria:**
- [ ] `npm run dev` starts dev server on localhost without errors
- [ ] `npm run build` produces a successful production build
- [ ] `npm run lint` passes with zero errors
- [ ] TypeScript strict mode enabled (`"strict": true` in tsconfig)
- [ ] Tailwind CSS configured and a test class renders correctly
- [ ] Supabase client initialized in `src/lib/supabase.ts`
- [ ] React Router v7 installed and configured with a basic route structure
- [ ] `.env.local` loaded (with placeholder values if secrets not yet available)
- [ ] `.gitignore` includes `.env*.local`, `node_modules/`, `dist/`
- [ ] `git status` does NOT show `.env.local` as untracked after creating it
- [ ] Project structure follows:
  ```
  src/
    components/    # React components
    lib/           # Supabase client, API utilities, business logic
    types/         # TypeScript interfaces
    pages/         # Page-level components
    hooks/         # Custom React hooks
    schemas/       # Zod validation schemas
  supabase/
    migrations/    # SQL migration files
    functions/     # Edge Functions (for Twelve Data proxy)
  docs/
    solutions/
      README.md            # Bug documentation template (from Hanzi Dojo pattern)
      database-issues/
      process-learnings/
  ```

> **Research insight (React patterns):** Install TanStack Query v5, React Hook Form, Zod, and @hookform/resolvers upfront. These are the recommended state management + form validation stack for financial React apps.

**Additional packages to install:**
```bash
npm install @tanstack/react-query react-hook-form @hookform/resolvers zod
```

> **Research insight (Security audit):** Add security headers in `vercel.json`:
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

**Test:** `npm run dev && npm run build && npm run lint` — all three pass.

---

### T2: Create Database Schema

**What:** Write Supabase migration creating all tables with RLS policies, ENUM types, indexes, constraints, and seed data.

**Tables:** `admin_users`, `kids`, `transactions`, `cd_lots`, `stock_positions`, `stock_prices`, `settings`

**Acceptance Criteria:**
- [ ] Migration file: `supabase/migrations/001_initial_schema.sql`
- [ ] All tables use `uuid` primary keys (generated by default via `gen_random_uuid()` — no extension needed)

**ENUM types (not text + CHECK):**
```sql
CREATE TYPE transaction_type AS ENUM (
  'deposit', 'withdraw', 'invest', 'redeem', 'interest', 'dividend', 'buy', 'sell'
);
CREATE TYPE transaction_bucket AS ENUM ('cash', 'mmf', 'cd', 'stock');
CREATE TYPE cd_status AS ENUM ('active', 'matured', 'broken');
```

> **Research insight (Supabase best practices):** ENUM types are stored as 4 bytes internally (vs full text), provide compile-time type safety in PL/pgSQL, and show up in Supabase-generated TypeScript types. Adding a value later is simple: `ALTER TYPE transaction_type ADD VALUE 'dividend';`

**Schema requirements:**
- [ ] `admin_users` table with `user_id uuid PRIMARY KEY REFERENCES auth.users(id)` — seeded with the two admin UUIDs from P4
- [ ] `transactions.type` uses `transaction_type` ENUM
- [ ] `transactions.bucket` uses `transaction_bucket` ENUM
- [ ] `transactions.amount` is `numeric(12,2)` — positive for inflows, negative for outflows
- [ ] `transactions.amount` has CHECK: `ABS(amount) <= 100000` and `amount = ROUND(amount, 2)`
- [ ] `transactions.metadata` is `jsonb` (nullable)
- [ ] `transactions.created_by` is `uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL` — NOT a parameter, derived from `auth.uid()` in RPCs
- [ ] `cd_lots.term_months` has CHECK constraint: `term_months IN (3, 6, 12)`
- [ ] `cd_lots.status` uses `cd_status` ENUM
- [ ] `cd_lots.maturity_date` computed in `create_cd` RPC: `start_date + (term_months * interval '1 month')`
- [ ] `cd_lots.principal` has CHECK: `principal > 0 AND principal <= 100000`
- [ ] `stock_positions.shares` is `numeric(16,8)` (fractional shares need precision)
- [ ] `stock_positions` has `UNIQUE (kid_id, ticker)` constraint
- [ ] `stock_prices` has composite PK on `(ticker, date)`
- [ ] `stock_prices.close_price` has CHECK: `close_price > 0`
- [ ] `settings` has `key` as PK, `value` as text, `updated_at` as timestamp
- [ ] RLS enabled on all tables
- [ ] RLS policies: **scoped to admin_users** (not blanket `authenticated`)
- [ ] All foreign keys use `ON DELETE RESTRICT` (never CASCADE for financial data)
- [ ] `created_at` columns default to `now()`
- [ ] TypeScript types manually written in `src/types/database.ts` matching all tables

**RLS policy pattern (all tables):**
```sql
CREATE POLICY "admin_only" ON transactions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));
```

> **Research insight (Supabase best practices):** Wrap `auth.uid()` in a `SELECT` for caching: `(SELECT auth.uid())` instead of bare `auth.uid()`. This prevents re-evaluation per row in large tables.

**Append-only enforcement on transactions:**
```sql
CREATE FUNCTION prevent_txn_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'transactions table is append-only: % not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_txn_mutation();
```

**Settings validation trigger:**
```sql
CREATE FUNCTION validate_setting() RETURNS trigger AS $$
BEGIN
  CASE NEW.key
    WHEN 'mmf_apy', 'cd_3m_apy', 'cd_6m_apy', 'cd_12m_apy' THEN
      IF NEW.value::numeric < 0 OR NEW.value::numeric > 0.20 THEN
        RAISE EXCEPTION 'APY must be between 0 and 0.20';
      END IF;
    WHEN 'stock_position_limit' THEN
      IF NEW.value::integer < 1 OR NEW.value::integer > 10 THEN
        RAISE EXCEPTION 'Position limit must be between 1 and 10';
      END IF;
    WHEN 'hanzi_dojo_conversion_rate' THEN
      IF NEW.value::numeric < 0.01 OR NEW.value::numeric > 10.00 THEN
        RAISE EXCEPTION 'Conversion rate must be between $0.01 and $10.00';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown settings key: %', NEW.key;
  END CASE;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_setting
  BEFORE INSERT OR UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION validate_setting();
```

**Valid type+bucket combinations CHECK:**
```sql
ALTER TABLE transactions ADD CONSTRAINT chk_valid_type_bucket CHECK (
  (type = 'deposit'  AND bucket = 'cash') OR
  (type = 'withdraw' AND bucket = 'cash') OR
  (type = 'invest'   AND bucket IN ('cash', 'mmf')) OR
  (type = 'redeem'   AND bucket IN ('cash', 'mmf', 'cd')) OR
  (type = 'interest' AND bucket = 'mmf') OR
  (type = 'dividend' AND bucket = 'cash') OR
  (type = 'buy'      AND bucket IN ('cash', 'stock')) OR
  (type = 'sell'     AND bucket IN ('cash', 'stock'))
);
```

**Indexes:**
```sql
-- Balance computation (most frequent query)
CREATE INDEX idx_transactions_kid_bucket ON transactions (kid_id, bucket);

-- Interest accrual lookups (last accrual date)
CREATE INDEX idx_transactions_kid_type_bucket_created
  ON transactions (kid_id, type, bucket, created_at DESC);

-- Prevent double interest credit same day
CREATE UNIQUE INDEX uq_interest_per_kid_per_day
  ON transactions (kid_id, type, bucket, DATE(created_at))
  WHERE type = 'interest';
```

**Seed data:**
```sql
-- Admin users (UUIDs from P4 — replace with actual values)
INSERT INTO admin_users (user_id) VALUES
  ('melody-uuid'), ('husband-uuid');

INSERT INTO kids (name) VALUES ('Aiden'), ('Skylar');

INSERT INTO settings (key, value) VALUES
  ('mmf_apy', '0.042'),
  ('cd_3m_apy', '0.048'),
  ('cd_6m_apy', '0.050'),
  ('cd_12m_apy', '0.052'),
  ('stock_position_limit', '5'),
  ('hanzi_dojo_conversion_rate', '0.10');
```

**Test:** Migration runs successfully against Supabase. All tables exist. INSERT/SELECT works for each table. RLS blocks unauthenticated access. RLS blocks authenticated non-admin access.

---

### T3: Set Up Authentication

**What:** Configure Supabase email auth with protected routes.

**Acceptance Criteria:**
- [ ] `src/lib/supabase.ts` exports a configured Supabase client
- [ ] `src/components/AuthProvider.tsx` provides auth context using `onAuthStateChange`
- [ ] `useAuth()` hook returns `{ user, loading, signIn, signOut }`
- [ ] Protected route wrapper: redirects to login if not authenticated
- [ ] Login page: email + password form, error display, redirects to dashboard on success
- [ ] No signup flow (admins are pre-created in Supabase dashboard — see prerequisite P4)
- [ ] Auth state persists across page reloads (Supabase handles this via localStorage)

> **Research insight (Supabase auth):** Use `getSession()` for initial load (reads from localStorage, no network request). Use `getUser()` only when you need server-verified user data. The `onAuthStateChange` listener handles token refresh automatically.

**Test (requires test credentials from P6):**
1. Unauthenticated user sees login page
2. Wrong credentials show error message
3. Correct credentials redirect to dashboard
4. Page reload maintains auth state
5. Sign out returns to login page

---

### T4: Deposit and Withdraw RPCs

**What:** PL/pgSQL functions for adding/removing money from cash balance.

**Implementation:** PL/pgSQL RPCs (write operations — must be atomic).

**Functions:**
- `deposit_to_cash(p_kid_id, p_amount, p_note, p_source)` — adds a deposit transaction
- `withdraw_from_cash(p_kid_id, p_amount, p_note)` — adds a withdrawal transaction (validates sufficient balance)

**Read Functions (TypeScript):**
- `getCashBalance(kidId)` → returns current cash balance via Supabase query

**Acceptance Criteria:**
- [ ] `deposit_to_cash` creates a transaction with `type='deposit'`, `bucket='cash'`, positive amount
- [ ] `deposit_to_cash` stores source in metadata via `jsonb_build_object('source', p_source)`
- [ ] `withdraw_from_cash` creates a transaction with `type='withdraw'`, `bucket='cash'`, negative amount
- [ ] `withdraw_from_cash` FAILS if amount > current cash balance (raises exception)
- [ ] `getCashBalance` returns `SUM(t.amount) FROM transactions t WHERE t.kid_id = $1 AND t.bucket = 'cash'`
- [ ] `created_by` derived from `auth.uid()` inside both RPCs (NOT a parameter)
- [ ] Admin authorization check at function entry
- [ ] Advisory lock acquired before balance check
- [ ] Amount validation: positive, <= $100,000, exactly 2 decimal places
- [ ] All PL/pgSQL uses explicit table aliases (`t.kid_id`, not `kid_id`)
- [ ] All PL/pgSQL functions are `SECURITY INVOKER` (use caller's RLS context)
- [ ] Structured errors: `RAISE EXCEPTION '...' USING ERRCODE = 'P0001'`
- [ ] TypeScript wrapper functions in `src/lib/transactions.ts` calling `supabase.rpc()`

**Error handling pattern:**
```sql
RAISE EXCEPTION 'Insufficient cash: have %, need %', v_balance, p_amount
  USING DETAIL = format('available: %s, requested: %s', v_balance, p_amount),
        HINT = 'Check balance before transacting',
        ERRCODE = 'P0001';
```

> **Research insight (Supabase best practices):** The client receives structured errors via `error.code`, `error.message`, `error.details`, `error.hint`. Use these for user-friendly frontend error messages.

**Test Cases:**
```
1. Deposit $50 for Aiden → cash balance = $50.00
2. Deposit $30 for Aiden → cash balance = $80.00
3. Withdraw $20 from Aiden → cash balance = $60.00
4. Withdraw $100 from Aiden → FAILS (insufficient balance)
5. Aiden's balance unchanged after failed withdrawal = $60.00
6. Skylar's balance is $0 (independent per kid)
```

---

### T5: MMF Interest Accrual RPCs

**What:** PL/pgSQL functions for investing in MMF and accruing interest.

**Implementation:** PL/pgSQL RPCs for writes. TypeScript for reads.

**PL/pgSQL Functions:**
- `invest_in_mmf(p_kid_id, p_amount)` — moves cash → MMF (atomic: deducts cash + adds MMF)
- `redeem_from_mmf(p_kid_id, p_amount)` — moves MMF → cash (atomic)
- `accrue_mmf_interest(p_kid_id)` — calculates and credits daily interest since last accrual

**TypeScript Functions:**
- `getMmfBalance(kidId)` → current MMF balance (SUM of mmf transactions)

**Acceptance Criteria:**
- [ ] `invest_in_mmf` creates two transactions atomically: `type='invest', bucket='cash'` (negative) + `type='invest', bucket='mmf'` (positive)
- [ ] `invest_in_mmf` fails if insufficient cash balance
- [ ] `redeem_from_mmf` does the reverse atomically (fails if insufficient MMF balance)
- [ ] `accrue_mmf_interest` reads current APY from `settings` table (key: `mmf_apy`)
- [ ] Last accrual date = `MAX(t.created_at)::date FROM transactions t WHERE t.kid_id = $1 AND t.type = 'interest' AND t.bucket = 'mmf'`. If NULL, use date of kid's first MMF invest transaction.
- [ ] Interest = `mmf_balance * (apy / 365) * days_since_last_accrual`
- [ ] Interest credited as transaction: `type='interest', bucket='mmf'`
- [ ] If days_since_last_accrual = 0, does nothing (no double-credit)
- [ ] **If computed interest rounds to $0.00, skip insertion** (prevents ledger pollution)
- [ ] Interest metadata includes: `days_accrued`, `apy_at_accrual`, `balance_at_accrual`
- [ ] Advisory lock acquired before balance check
- [ ] `created_by` derived from `auth.uid()`
- [ ] All PL/pgSQL uses explicit table aliases

> **Research insight (PL/pgSQL patterns):** Record `apy_at_accrual` in metadata. If the parent changes the rate mid-period, interest up to the accrual date uses the old rate (already credited), and interest from accrual date forward uses the new rate (next accrual reads new setting). Full audit trail.

**Test Cases:**
```
Setup: Set mmf_apy = 0.042 (4.2%)

1. Deposit $100 cash, invest $100 in MMF → cash=$0, mmf=$100.00
2. Accrue interest for 30 days → mmf = $100 + ($100 * 0.042/365 * 30) = $100.35
3. Accrue again same day → no change (days_since_last_accrual = 0)
4. Redeem $50 from MMF → cash=$50.00, mmf=$50.35
5. Redeem $60 from MMF → FAILS (only $50.35 available)
```

---

### T6: CD Lot Management RPCs

**What:** PL/pgSQL functions for creating, maturing, and breaking CD lots.

**Implementation:** PL/pgSQL RPCs for all operations (all involve money movement).

**PL/pgSQL Functions:**
- `create_cd(p_kid_id, p_amount, p_term_months)` — locks cash into a CD lot
- `break_cd(p_cd_lot_id)` — early withdrawal with penalty
- `mature_cd(p_cd_lot_id)` — processes a matured CD (returns principal + interest to cash)

**TypeScript Functions:**
- `getCdLots(kidId)` → returns all active/matured CD lots with current accrued value

> **Research insight (PL/pgSQL patterns):** CD interest uses **simple interest with actual/365 day count convention**, which is standard for US CDs. PostgreSQL's date subtraction (`date - date`) returns exact integer days — no interval arithmetic needed.

**Acceptance Criteria:**
- [ ] `create_cd` deducts from cash (transaction `type='invest', bucket='cash'`), creates `cd_lots` row with `status='active'`
- [ ] `create_cd` computes `maturity_date = start_date + (term_months * interval '1 month')` in the RPC
- [ ] `create_cd` fails if `p_term_months` not in (3, 6, 12)
- [ ] `create_cd` fails if insufficient cash balance
- [ ] APY for each term read from settings: `cd_3m_apy`, `cd_6m_apy`, `cd_12m_apy`
- [ ] `mature_cd` returns principal + accrued interest to cash (transaction `type='redeem', bucket='cash'`)
- [ ] `mature_cd` fails if CD not yet matured (`maturity_date > CURRENT_DATE`)
- [ ] `mature_cd` sets `status='matured'`
- [ ] `break_cd` returns principal + (accrued interest - penalty) to cash
- [ ] `break_cd` sets `status='broken'`
- [ ] CD interest = `principal * apy * (actual_days_held / 365)`
- [ ] Penalty for early break = last 30 days of interest (or all interest if held < 30 days)
- [ ] Net return on break never less than principal: `principal + GREATEST(interest - penalty, 0)`
- [ ] Advisory lock acquired, `created_by` derived from `auth.uid()`
- [ ] All PL/pgSQL uses explicit table aliases

**Test Cases:**
```
Setup: cd_3m_apy=0.048, cd_6m_apy=0.050, cd_12m_apy=0.052

1. Deposit $200 cash, create 3-month CD for $100 → cash=$100.00, CD lot active with $100.00 principal
2. Attempt to mature CD on day 1 → FAILS (not yet matured)
3. Break CD on day 45 →
   interest_earned = $100 * 0.048 * 45/365 = $0.59
   penalty = $100 * 0.048 * 30/365 = $0.39
   returned = $100 + $0.59 - $0.39 = $100.20
   cash = $100 + $100.20 = $200.20
   CD status = 'broken'
4. Create 6-month CD for $100, fast-forward to maturity (182 days)
   interest = $100 * 0.050 * 182/365 = $2.49
   returned = $102.49
   CD status = 'matured'
```

---

### T7: Stock Position RPCs

**What:** PL/pgSQL functions for buying/selling virtual shares. TypeScript for reads.

**Implementation:** PL/pgSQL RPCs for buy/sell (money movement). TypeScript for position queries.

**PL/pgSQL Functions:**
- `buy_stock(p_kid_id, p_ticker, p_dollar_amount)` — buys virtual shares at current price
- `sell_stock(p_kid_id, p_ticker, p_dollar_amount)` — sells virtual shares at current price (pass 0 for "sell all")

**TypeScript Functions:**
- `getStockPositions(kidId)` → returns all positions with current value and gain/loss
- `getPortfolioSummary(kidId)` → returns total: cash + MMF + CD + stocks

> **Research insight (Stock API + PL/pgSQL patterns):** Use **average cost basis** (not FIFO). For buy: add to shares and cost_basis. For sell: reduce proportionally. Average cost per share = `cost_basis / shares`. This is simpler and teaches the same concept.

**Acceptance Criteria:**
- [ ] `buy_stock` deducts from cash, creates/updates `stock_positions` row
- [ ] **Use INSERT ... ON CONFLICT for upsert:** `INSERT INTO stock_positions ... ON CONFLICT (kid_id, ticker) DO UPDATE SET shares = shares + new_shares, cost_basis = cost_basis + dollar_amount`
- [ ] Virtual shares = `p_dollar_amount / current_price` (latest price via `ORDER BY date DESC LIMIT 1`, NOT `WHERE date = CURRENT_DATE`)
- [ ] `buy_stock` fails if insufficient cash
- [ ] `buy_stock` fails if kid already has positions = stock_position_limit (from settings) and this is a new ticker
- [ ] `buy_stock` fails if ticker has no entry in `stock_prices` (ticker not tracked yet)
- [ ] `buy_stock` validates ticker format: `p_ticker ~ '^[A-Z]{1,10}$'`
- [ ] Creates transactions: `type='buy', bucket='cash'` (negative) + `type='buy', bucket='stock'` (positive, metadata: `jsonb_build_object('ticker', p_ticker, 'shares', v_shares, 'price_per_share', v_price)`)
- [ ] `sell_stock` with `p_dollar_amount > 0`: sells shares worth that dollar amount at current price
- [ ] `sell_stock` with `p_dollar_amount = 0`: sells ALL shares (full liquidation)
- [ ] If selling all shares, deletes the `stock_positions` row
- [ ] Sell records realized gain/loss in metadata: `jsonb_build_object('realized_gain_loss', v_gain)`
- [ ] `getStockPositions` returns: ticker, shares, cost_basis, current_price, current_value, gain_loss, gain_loss_pct
- [ ] `getPortfolioSummary` returns: cash, mmf, cd_total, stock_total, grand_total

> **Research insight (Performance):** Use `Promise.all` for parallel queries in `getPortfolioSummary`. Fire all 4 balance queries simultaneously. On the dashboard (T11), also parallel-fetch both kids: 8 queries total, 1 network round-trip.

**Test Cases:**
```
Setup: Insert stock_prices rows — NVDA at $800.00, VTI at $250.00

1. Deposit $500, buy $200 of NVDA
   → shares = 200/800 = 0.25000000
   → cash=$300.00, NVDA position: shares=0.25, cost_basis=$200.00, value=$200.00

2. Update NVDA price to $900.00
   → NVDA value = 0.25 * $900 = $225.00, gain=$25.00 (+12.5%)

3. Sell $100 of NVDA at $900
   → shares_sold = 100/900 = 0.11111111
   → remaining shares = 0.25 - 0.11111111 = 0.13888889
   → cash = $300 + $100 = $400.00

4. Buy $100 of VTI at $250
   → VTI shares = 100/250 = 0.40000000
   → cash = $400 - $100 = $300.00

5. Portfolio summary:
   → cash=$300, mmf=$0, cd=$0, stocks=$225.00, total=$525.00

6. Attempt to buy 6th different ticker (with 5 already held) → FAILS (position limit)
```

---

### ~~T8: Hanzi Dojo Delta Logic~~ → Folded into T12

**Decision:** Hanzi Dojo point tracking does not need a separate table or RPC. The high-water-mark snapshot is stored in transaction metadata, and the delta computation happens in the Add Money form (T12). This eliminates 1 table and 1 RPC while preserving all functionality.

See **T12** for the Hanzi Dojo points flow: last recorded total shown → enter new total → auto-compute delta × conversion rate → deposit.

---

### T9: Twelve Data Stock Price Integration

**What:** Server-side function for stock price fetching — both latest prices and 5-year historical data. Manual trigger for v1.

**Implementation:** **Supabase Edge Function** (NOT client-side TypeScript). The API key must never be exposed to the browser.

> **Research insight (Security audit — CRITICAL):** The Twelve Data API key cannot be in the browser bundle. Store it as a Supabase secret (`supabase secrets set TWELVE_DATA_API_KEY=xxx`) and fetch from a Supabase Edge Function. The frontend "Refresh Prices" button calls the Edge Function.

**Two fetch modes:**

| Mode | When | API Call | Purpose |
|------|------|----------|---------|
| **Daily refresh** | "Refresh Prices" button | `outputsize=1` per ticker | Update latest prices for portfolio valuation |
| **Historical backfill** | First time a ticker is tracked, or "Backfill History" | `start_date` 5 years ago, `end_date` today | Populate historical data for T10 simulator |

**Acceptance Criteria:**
- [ ] `supabase/functions/fetch-stock-prices/index.ts` — Deno-based Edge Function
- [ ] Accepts `mode` parameter: `"daily"` (default) or `"backfill"`
- [ ] **Daily mode:** Uses Twelve Data batch endpoint: `GET /time_series?symbol=NVDA,VTI,...&interval=1day&outputsize=1`
- [ ] **Backfill mode:** Uses `GET /time_series?symbol=TICKER&interval=1day&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` per ticker (5 years of history)
- [ ] **Handles single vs batch response shape difference:** single symbol returns unwrapped, multi-symbol returns keyed object
- [ ] Parses response, upserts each ticker's close price into `stock_prices` table
- [ ] Handles API errors gracefully (logs error, returns partial success)
- [ ] Handles market holidays (no new data = no insert, no error — categorize as "skipped")
- [ ] Deduplicates: upsert on `(ticker, date)` composite key with `ignoreDuplicates: false` (allows price corrections)
- [ ] `getTrackedTickers()` → returns distinct tickers from `stock_positions` across all kids
- [ ] API key read from Deno environment variable (NOT from browser)
- [ ] Rate limit protection: check `last_price_refresh` timestamp in settings, refuse if < 1 hour ago
- [ ] "Refresh Prices" button on Settings page (T15) calls the Edge Function (daily mode)
- [ ] Returns result with `updated`, `skipped`, `failed` ticker lists + row counts for backfill

> **Research insight (Twelve Data API):** Batch response format uses symbol keys at the top level. Each symbol consumes 1 credit regardless of success/failure. Free tier: 800 credits/day. Backfill uses 1 credit per ticker (returns all data points in one call). With max 10 tickers, even a full 5-year backfill uses only 10 credits.

**Response shape handling:**
```typescript
// CRITICAL: Single symbol returns unwrapped, multi-symbol returns keyed
if (tickers.length === 1) {
  // data is { meta: {...}, values: [...], status: 'ok' }
} else {
  // data is { 'NVDA': { meta: {...}, ... }, 'VTI': { meta: {...}, ... } }
}
```

**Backfill trigger:** When a new ticker is added via "Track New Ticker" (T13c), automatically call the Edge Function in backfill mode for that single ticker. This ensures historical data is available for the simulator (T10) immediately.

**Test Cases:**
```
1. Daily refresh for ["NVDA", "VTI", "TSM"] → 3 rows upserted in stock_prices (latest day)
2. Fetch again same day → rows updated (upsert overwrites)
3. Invalid ticker "ZZZZZ" → graceful error, other tickers still processed
4. Weekend/holiday → skipped (no error)
5. Backfill NVDA (5 years) → ~1,260 rows inserted (trading days)
6. Backfill already-backfilled ticker → upserts without error (no duplicates)
```

---

### T10: Investment Simulator

**What:** "What would $X become?" calculator using real rates (MMF, CDs) and real historical stock data. The dinner-table teaching tool — shows why locking money longer earns more, and why stocks can go up OR down.

**Implementation:** TypeScript functions (read-only — queries settings + stock_prices). No RPCs.

**Dependencies:** T5 (MMF rates), T6 (CD rates), T9 (historical stock prices must be backfilled).

**Functions:**
- `simulateGrowth(amount: number, months: number, rates: Settings)` → projections for cash, MMF, CDs
- `getHistoricalStockReturns(ticker: string, months: number)` → actual/best/worst returns from stock_prices data

**Acceptance Criteria:**

**Fixed-income projections (pure math, from settings):**
- [ ] Cash (mattress): `amount` (no growth — "your money just sits there")
- [ ] MMF: `amount × (1 + apy/12)^months` (monthly compounding)
- [ ] CD projections show **reinvestment compounding** over the full horizon:
  - CD 3m over 12 months: 4 terms reinvested → `amount × (1 + cd_3m_apy × 3/12)^4`
  - CD 6m over 12 months: 2 terms reinvested → `amount × (1 + cd_6m_apy × 6/12)^2`
  - CD 12m over 12 months: 1 term → `amount × (1 + cd_12m_apy)`
  - CD 3m over 60 months: 20 terms → `amount × (1 + cd_3m_apy × 3/12)^20`
  - General: `terms = floor(months / term_months)`, `result = amount × (1 + apy × term_months/12)^terms`
- [ ] Only show CD terms that fit within the horizon (no CD 12m for a 6-month horizon)
- [ ] All amounts rounded to 2 decimal places

**Stock projections (from historical price data via T9):**
- [ ] For each tracked ticker with sufficient history, compute:
  - **Actual return (past N months):** price N months ago vs. latest price → `amount × (latest / past_price)`
  - **Best 12-month return in history:** scan all 12-month windows, find highest → show as upside scenario
  - **Worst 12-month return in history:** scan all 12-month windows, find lowest → show as downside scenario
- [ ] For multi-year horizons (e.g., 5 years):
  - **Actual 5-year return:** price 5 years ago vs. latest price → annualized + total
  - **Best/worst rolling windows** at that horizon length
- [ ] If insufficient historical data for the requested horizon: "Not enough history — NVDA has only 2 years of data"
- [ ] Stock projections are clearly labeled as **"Based on past performance — not guaranteed"**

**UI (one page component):**
- [ ] Route: `/simulator`
- [ ] Input: amount (money input), time horizon (pill buttons: 3mo, 6mo, 1yr, 3yr, 5yr)
- [ ] Results table showing all products side by side
- [ ] Stocks section shows per-ticker with upside/downside range
- [ ] Color coding: green for gains, red for losses (emerald-600/red-600 for accessibility)
- [ ] Mobile-responsive

> **Teaching design:** The power is in the side-by-side comparison. Seeing "$100 in cash = $100, in MMF = $123, in NVDA = could be $891 or $51" makes risk/reward visceral. The multi-year CD compounding shows how "boring" investments add up — $100 in CD 3m reinvested for 5 years at 4.8% = $126.82, which is real money for a 6-year-old.

**Test Cases:**
```
Setup: mmf_apy=0.042, cd_3m_apy=0.048, cd_6m_apy=0.050, cd_12m_apy=0.052
       NVDA historical prices loaded via T9 backfill

simulateGrowth($100, 12 months):
  Cash:          $100.00
  MMF:           $104.28  (monthly compound)
  CD 3m (×4):    $104.86  (4 terms reinvested)
  CD 6m (×2):    $105.06  (2 terms reinvested)
  CD 12m (×1):   $105.20  (1 term)

simulateGrowth($100, 60 months):
  Cash:          $100.00
  MMF:           $123.14  (monthly compound, 60 months)
  CD 3m (×20):   $126.82  (20 terms reinvested)
  CD 6m (×10):   $128.01  (10 terms reinvested)
  CD 12m (×5):   $128.85  (5 terms reinvested)

getHistoricalStockReturns("NVDA", 12):
  Actual (past 12m):   $100 → $148.00  (+48%)
  Best 12m window:     $100 → $312.00  (+212%)
  Worst 12m window:    $100 → $51.00   (-49%)

getHistoricalStockReturns("VTI", 60):
  Actual (past 5yr):   $100 → $178.00  (+78%)
  Best 5yr window:     $100 → $215.00  (+115%)
  Worst 5yr window:    $100 → $89.00   (-11%)
```

---

### T11: Admin Dashboard Page

**What:** Landing page showing both kids' balances at a glance.

**Acceptance Criteria:**
- [ ] Route: `/` (authenticated)
- [ ] Shows one card per kid with:
  - Kid name
  - Total portfolio value (cash + MMF + CD + stocks)
  - Breakdown: cash | MMF | CD | stocks (as numbers and visual bar)
- [ ] Calls `getPortfolioSummary` for **both kids in parallel** (`Promise.all`)
- [ ] Loading state while fetching
- [ ] Error state if fetch fails (using React error boundary with TanStack Query)
- [ ] Mobile-responsive (stacks vertically on phone)
- [ ] Navigation to individual kid's investment page
- [ ] Quick action buttons: Add Money, Invest, Spend

> **Research insight (React patterns):** Use emerald-600 for gains, red-600 for losses (not pure green — better accessibility contrast). Use `Intl.NumberFormat` for money display. Add a `BucketBar` component showing proportional allocation.

> **Research insight (Performance):** Configure TanStack Query with `staleTime: 5 * 60 * 1000` (5 min default), `refetchOnWindowFocus: true` for when parent switches back to app.

**Test:** Page renders both kids' balances. Values update after a deposit is made via Add Money.

---

### T12: Add Money Page

**What:** Form for depositing money into a kid's cash balance. Includes Hanzi Dojo point tracking via transaction metadata (formerly T8).

**Acceptance Criteria:**
- [ ] Route: `/add-money`
- [ ] Form fields:
  - Kid selector (dropdown: Aiden / Skylar)
  - Amount (`type="text"` + `inputMode="decimal"` — NOT `type="number"`)
  - Source (pill buttons, not dropdown: Chores, Chinese Book, English Book, Hanzi Dojo Points, Red Envelope, Gift, Other)
  - Note (optional text)

**Hanzi Dojo Points Flow (conditional form mode):**
- [ ] When source = "Hanzi Dojo Points", the form switches from dollar input to points input
- [ ] Query last Hanzi Dojo deposit for this kid: `SELECT t.metadata->>'points_total' FROM transactions t WHERE t.kid_id = $1 AND t.metadata->>'source' = 'hanzi_dojo' ORDER BY t.created_at DESC LIMIT 1`
- [ ] Display: **"Last recorded: 1,000 points"** (or "First entry" if no previous)
- [ ] Parent enters current total (e.g., 1,158)
- [ ] App computes: delta = 1,158 - 1,000 = 158 points, reads `hanzi_dojo_conversion_rate` from settings (e.g., $0.10/point), deposit = $15.80
- [ ] Confirmation shown: **"158 new points → $15.80 deposit. Confirm?"**
- [ ] If entered total < last recorded total: warning — "That's fewer points than last time (1,000). Did you mean something else?"
- [ ] If delta = 0: "No new points since last entry. Nothing to deposit."
- [ ] On confirm: calls standard `deposit_to_cash` RPC with metadata: `jsonb_build_object('source', 'hanzi_dojo', 'points_total', 1158, 'points_delta', 158, 'conversion_rate', 0.10)`
- [ ] First-ever entry (no previous snapshot): treats full total as delta

**All other sources:**
- [ ] Standard dollar amount input → calls `deposit_to_cash` RPC
- [ ] Metadata stores source label: `jsonb_build_object('source', 'chores')`, `jsonb_build_object('source', 'chinese_book')`, etc.
- [ ] Zod schema validation with React Hook Form
- [ ] Success message with updated cash balance shown
- [ ] Form resets after successful submission (ready for next entry)
- [ ] Validation: amount must be positive, kid must be selected
- [ ] Mobile-optimized (large touch targets ≥ 44px, `py-4` on inputs/buttons)

> **Research insight (React patterns):** Use `type="text"` with `inputMode="decimal"` for money inputs. `type="number"` allows scientific notation (`1e5`), has inconsistent scroll behavior, and spinner arrows are useless for money. The `$` prefix should be a positioned `<span>`, not part of the input value.

**Test:**
1. Add $50 gift for Aiden → success, balance increases by $50
2. Select "Hanzi Dojo Points" → form shows "Last recorded: 0 points (first entry)", enter 500 → "500 points → $50.00 deposit", confirm → cash +$50
3. Select "Hanzi Dojo Points" again → form shows "Last recorded: 500 points", enter 658 → "158 new points → $15.80 deposit", confirm → cash +$15.80
4. Enter 400 points (less than 500) → warning: "fewer points than last time"
5. Enter 500 points (same as last) → "No new points since last entry"
6. Add $4 "Chinese Book" for Aiden → success, metadata has source="chinese_book"
7. Submit with no amount → validation error
8. Submit with negative amount → validation error

---

### T13a: Manage Investments — MMF Section

**What:** MMF management within the kid's investment page.

**Acceptance Criteria:**
- [ ] Route: `/kid/:kidId/invest` (shared page with T13b, T13c)
- [ ] **Page-level data fetch:** all section data loaded via single `Promise.all` at page level, passed down to sections
- [ ] Page layout: shows current cash balance prominently at top ("Available to invest: $X")
- [ ] MMF section shows:
  - Current MMF balance
  - Current APY rate (from settings)
  - "Add to MMF" form: amount input + submit → calls `invest_in_mmf` RPC
  - "Withdraw from MMF" form: amount input + submit → calls `redeem_from_mmf` RPC
- [ ] Balances update after each action via TanStack Query `invalidateQueries`
- [ ] Error messages for insufficient balance
- [ ] Mobile-responsive

**Test:**
1. Invest $50 in MMF → cash decreases by $50, MMF increases by $50
2. Withdraw $25 from MMF → cash increases by $25, MMF decreases by $25
3. Try to invest more than cash balance → error message

---

### T13b: Manage Investments — CD Section

**What:** CD management within the kid's investment page.

**Acceptance Criteria:**
- [ ] Renders within `/kid/:kidId/invest` page (below MMF section)
- [ ] Shows list of active CD lots: principal, APY, start date, maturity date, days remaining
- [ ] "Open New CD" form: amount input + term dropdown (3/6/12 months) + submit → calls `create_cd` RPC
- [ ] Matured CDs (maturity_date <= now AND status='active') show "Collect" button → calls `mature_cd` RPC
- [ ] Active CDs show "Break Early" button with penalty estimate displayed → calls `break_cd` RPC
- [ ] Empty state if no CDs: "No CDs yet — lock up money for a higher return!"
- [ ] Balances update after each action
- [ ] Error messages for insufficient balance, invalid term

**Test:**
1. Open 3-month CD for $100 → cash decreases, CD appears in list with maturity date
2. Break CD early → cash increases by principal + interest - penalty, CD disappears from active list
3. Try to open CD with more than cash balance → error message

---

### T13c: Manage Investments — Stock Section

**What:** Stock/ETF management within the kid's investment page.

**Acceptance Criteria:**
- [ ] Renders within `/kid/:kidId/invest` page (below CD section)
- [ ] Shows list of current positions: ticker, shares, cost basis, current value, gain/loss $, gain/loss %
- [ ] Current price per position (from `stock_prices`)
- [ ] **Stale price indicator:** if latest price is > 3 days old, show warning (weekends = 2 days, so > 3 means genuinely stale)
- [ ] "Buy Stock/ETF" form: ticker text input + dollar amount + submit → calls `buy_stock` RPC
- [ ] Ticker input accepts uppercase letters; validation = must exist in `stock_prices` table
- [ ] Per-position "Sell" button with amount input or "Sell All" → calls `sell_stock` RPC
- [ ] Shows position count (e.g., "2 of 5 positions used")
- [ ] Empty state if no positions: "Pick your first company to invest in!"
- [ ] Balances update after each action
- [ ] Error messages for: insufficient cash, ticker not found, position limit reached

**Test:**
1. Buy $50 of NVDA → cash decreases, position appears with shares and current value
2. Sell $25 of NVDA → shares reduced, cash increases, gain/loss shown
3. Try to buy unknown ticker "ZZZZZ" → error: "ticker not tracked"
4. Try to buy 6th different ticker when at limit → error: "position limit reached"

---

### T14: Record Spending Page

**What:** Form for recording when a kid spends money. Liquidation from non-cash buckets is atomic.

**Implementation:** For spending from MMF or stocks, create dedicated PL/pgSQL RPCs:
- `spend_from_mmf(p_kid_id, p_amount, p_note)` — atomically redeems from MMF and records the spend
- `spend_from_stock(p_kid_id, p_ticker, p_amount, p_note)` — atomically sells shares and records the spend

**Acceptance Criteria:**
- [ ] Route: `/spend`
- [ ] Form fields:
  - Kid selector
  - Amount (money input, required, > 0)
  - Source bucket (pill buttons: Cash, MMF, Stock — with current balance shown per option)
  - If Stock: which ticker (dropdown of kid's current holdings with current value each)
  - What for (required text: "Pokemon cards", "toy", etc.)
- [ ] If source = Cash: calls `withdraw_from_cash` RPC
- [ ] If source = MMF: calls `spend_from_mmf` RPC (single atomic operation)
- [ ] If source = Stock: calls `spend_from_stock` RPC (single atomic operation)
- [ ] CD is NOT an option (locked — must mature or break first via Manage Investments)
- [ ] Shows gain/loss if spending from stocks: "Selling NVDA: you gained $12.00!"
- [ ] Success message with new balance
- [ ] Mobile-optimized

**Test:**
1. Spend $20 from cash → cash decreases by $20
2. Spend $30 from MMF → MMF decreases by $30, cash unchanged
3. Spend $25 from NVDA position → shares reduced proportionally, cash unchanged
4. CD not available as source option

---

### T15: Settings Page

**What:** Admin page for managing rates, configuration, and triggering price refresh.

**Acceptance Criteria:**
- [ ] Route: `/settings`
- [ ] Editable fields:
  - MMF APY (e.g., 4.2%)
  - CD 3-month APY
  - CD 6-month APY
  - CD 12-month APY
  - Stock position limit per kid (default: 5)
  - Hanzi Dojo conversion rate (default: $0.10 per point)
- [ ] Current values loaded from `settings` table
- [ ] Save button updates `settings` table (DB-level validation trigger catches invalid values)
- [ ] Shows last-updated timestamp per setting
- [ ] Input validation: rates between 0% and 20%, position limit 1-10
- [ ] **"Refresh Stock Prices" button** → calls Supabase Edge Function → shows success/failure + last refresh timestamp
- [ ] **"Accrue MMF Interest" button** → calls `accrue_mmf_interest` for each kid → shows results
- [ ] Mobile-responsive

> **Research insight (Performance):** Configure TanStack Query for settings with `staleTime: Infinity` — never auto-refetch; only invalidate on explicit save.

**Test:**
1. Change MMF APY from 4.2% to 4.5% → saved, persists on page reload
2. Set invalid rate (-5%) → validation error (both client-side and DB trigger)
3. Click "Refresh Stock Prices" → prices updated, timestamp shown

---

## Execution Order for Ralph Loop

**Wave 1 (sequential — foundation):**
1. T1: Scaffold project
2. T2: Create schema + seed data

**Wave 2 (parallel — all backend logic, no dependencies between them):**
3. T3: Auth
4. T4: Deposit/withdraw RPCs
5. T5: MMF interest RPCs
6. T6: CD management RPCs
7. T7: Stock position RPCs

**Wave 3 (depends on Wave 2):**
8. T9: Twelve Data integration — Edge Function + historical backfill (depends on T7)
9. T10: Investment simulator (depends on T5, T6, T9)

**Wave 4 (parallel — UI pages, depend on RPCs from Wave 2-3):**
10. T11: Admin dashboard
11. T12: Add money page (includes Hanzi Dojo points flow — formerly T8)
12. T13a: MMF management UI
13. T13b: CD management UI
14. T13c: Stock management UI
15. T14: Record spending page (includes `spend_from_mmf` and `spend_from_stock` RPCs)
16. T15: Settings page (includes price refresh + interest accrual buttons)

**Wave 5 (integration verification):**
17. End-to-end test: deposit → invest in all 3 products → accrue interest → spend from each bucket → verify all balances
18. Stock positions reconciliation query (verify `stock_positions.shares` matches transaction-derived shares)

---

## Definition of Done (Phase A Complete)

- [ ] All 16 tasks pass their acceptance criteria (T1-T7, T9-T15 + integration tests)
- [ ] All test cases pass
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm run lint` passes with zero errors
- [ ] App runs on localhost, two admins can log in
- [ ] Non-admin users blocked by RLS (verified)
- [ ] Can complete full lifecycle: add money → invest in all 3 products → accrue interest → spend
- [ ] Stock prices fetch from Twelve Data API via Edge Function (API key NOT in browser)
- [ ] Historical stock prices backfilled for all tracked tickers (5 years)
- [ ] Hanzi Dojo points flow works: shows last recorded total, computes delta, deposits correctly
- [ ] Investment simulator shows correct projections with real historical stock data
- [ ] Multi-year CD compounding matches manual calculation
- [ ] All PL/pgSQL RPCs tested in Supabase SQL Editor before frontend wiring
- [ ] Mobile-responsive (functional, not necessarily "delightful" — that's Phase B)
- [ ] `docs/solutions/` directory created with README template
- [ ] All RPC functions follow SQL Development Checklist (explicit aliases, SQL Editor tested, auth.uid() derived, advisory locks)
- [ ] TypeScript types in `database.ts` verified against actual schema

### Phase B QA Note (For Future Reference)

Phase A uses Playwright MCP for functional UI verification (element presence, form submission, data display). Phase B (kid-facing UX) will additionally need Agent Browser for visual/state verification that Playwright cannot catch: animation smoothness, touch behavior, visual stability after interactions, design token consistency. See `LEARNINGS_APPLIED.md` Section 5 for full protocol.
