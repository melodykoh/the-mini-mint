# Phase A: The Engine — Ralph Loop Execution Plan

## Overview

Phase A builds the complete backend + data layer + basic admin UI. Every task is atomic, machine-verifiable, and has explicit acceptance criteria. Phase B (kid-facing UX, visual design, delight) follows interactively.

## Architecture Principles

### PL/pgSQL RPCs vs. TypeScript Functions

All financial operations that move money between buckets involve multiple coordinated writes. These **must** be atomic — if any step fails, the entire operation rolls back. This determines where logic lives:

| Operation Type | Implementation | Why |
|---------------|---------------|-----|
| **Writes that move money** (invest, redeem, buy, sell, break CD, mature CD, deposit, withdraw) | **PL/pgSQL RPC** in Supabase | Atomicity via `BEGIN...COMMIT` is trivial in PL/pgSQL. A failed step auto-rolls back. No partial state. |
| **Reads** (get_balance, get_positions, get_portfolio_summary) | **TypeScript function** calling Supabase JS client | No atomicity needed. Easier to compose and test. |
| **Pure computation** (investment simulator) | **TypeScript function**, client-side | No database interaction beyond reading settings. Pure math. |

**The rule:** If the function creates or modifies rows in `transactions`, `cd_lots`, or `stock_positions`, it's a PL/pgSQL RPC. Everything else is TypeScript.

### MMF Interest Accrual Tracking

Last accrual date is derived from the most recent `type='interest', bucket='mmf'` transaction for that kid. No separate tracking column needed — the ledger is the source of truth. If no interest transaction exists, the accrual period starts from the kid's first MMF investment transaction.

### Spending from Non-Cash Buckets

When spending from MMF or stocks, the liquidation and withdrawal happen inside a **single PL/pgSQL RPC** (e.g., `spend_from_mmf(kid_id, amount, note, created_by)`). Money does NOT briefly land in cash — the RPC creates the redeem + withdraw transactions atomically in one call. This prevents orphaned state if any step fails.

### Stock Ticker Validation

The "Buy Stock/ETF" form accepts a free-text ticker input. Validation is limited to: (1) ticker exists in `stock_prices` table (meaning Twelve Data has returned data for it). No autocomplete, no search, no API lookup at buy time. If a kid wants to buy a new ticker, the parent first adds it via a "Track New Ticker" action (which fetches from Twelve Data and backfills prices), then the kid can buy it.

### CD Simulator Projections

The investment simulator shows CD projections for each term that fits within the selected time horizon. It assumes a **single term, no reinvestment**. For example, `simulate_growth($100, 9)` shows CD 3m and CD 6m projections (both would have matured), but the return shown is for one term of each — not "3m CD reinvested 3 times." This keeps the math honest and the teaching moment clear.

## Prerequisites (Manual, Before Ralph Loop Starts)

These must be done by Melody before autonomous execution:

- [ ] **P1: Create Supabase project** — new project in Supabase dashboard
- [ ] **P2: Get Supabase credentials** — project URL + anon key + service role key
- [ ] **P3: Get Twelve Data API key** — free registration at twelvedata.com
- [ ] **P4: Create two admin users** in Supabase Auth dashboard (email + password for Melody and husband)
- [ ] **P5: Store secrets** — add to `.env.local` in repo root:
  ```
  VITE_SUPABASE_URL=...
  VITE_SUPABASE_ANON_KEY=...
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
                 │                 ├── T7 (stock position RPCs)
                 │                 └── T8 (Hanzi Dojo delta logic)
                 │                 │
                 │                 ├── T9 (Twelve Data integration) ── depends on T7
                 │                 └── T10 (investment simulator) ── depends on T5, T6
                 │
                 └── T11 (admin UI: dashboard) ── depends on T3, T4
                     T12 (admin UI: add money) ── depends on T4, T8
                     T13a (admin UI: MMF management) ── depends on T5
                     T13b (admin UI: CD management) ── depends on T6
                     T13c (admin UI: stock management) ── depends on T7, T9
                     T14 (admin UI: record spend) ── depends on T4, T7
                     T15 (admin UI: settings) ── depends on T3
```

**Parallelizable groups:**
- After T2: T3, T4, T5, T6, T7, T8 can all run in parallel
- After T4-T8: T9, T10, T11-T15 can run in parallel

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
- [ ] `.gitignore` includes `.env.local`, `.env.test.local`, `node_modules/`, `dist/`
- [ ] Project structure follows:
  ```
  src/
    components/    # React components
    lib/           # Supabase client, API utilities, business logic
    types/         # TypeScript interfaces
    pages/         # Page-level components
  supabase/
    migrations/    # SQL migration files
  ```

**Test:** `npm run dev && npm run build && npm run lint` — all three pass.

---

### T2: Create Database Schema

**What:** Write Supabase migration creating all 7 tables with RLS policies and seed data.

**Tables:** `kids`, `transactions`, `cd_lots`, `stock_positions`, `stock_prices`, `hanzi_dojo_snapshots`, `settings`

**Acceptance Criteria:**
- [ ] Migration file: `supabase/migrations/001_initial_schema.sql`
- [ ] All tables use `uuid` primary keys (generated by default via `gen_random_uuid()`)
- [ ] `transactions.type` is enum: `deposit`, `withdraw`, `invest`, `redeem`, `interest`, `buy`, `sell`
- [ ] `transactions.bucket` is enum: `cash`, `mmf`, `cd`, `stock`
- [ ] `transactions.amount` is `numeric(12,2)` — positive for inflows, negative for outflows
- [ ] `transactions.metadata` is `jsonb` (nullable)
- [ ] `transactions.created_by` is `uuid` referencing `auth.users(id)` — the Supabase auth user who made the entry
- [ ] `cd_lots.term_months` has CHECK constraint: `term_months IN (3, 6, 12)`
- [ ] `cd_lots.status` is enum: `active`, `matured`, `broken`
- [ ] `cd_lots.maturity_date` is computed column or set by trigger: `start_date + (term_months * interval '1 month')`
- [ ] `stock_positions.shares` is `numeric(16,8)` (fractional shares need precision)
- [ ] `stock_prices` has composite PK on `(ticker, date)`
- [ ] `hanzi_dojo_snapshots` stores `total_points`, `previous_total`, `delta_points`, `dollar_equivalent`
- [ ] `settings` has `key` as PK, `value` as text, `updated_at` as timestamp
- [ ] RLS enabled on all tables
- [ ] RLS policies: authenticated users can read/write all tables (admin-only app)
- [ ] `created_at` columns default to `now()`
- [ ] All foreign keys have appropriate `ON DELETE` behavior (CASCADE for child records, RESTRICT for references)
- [ ] TypeScript types manually written in `src/types/database.ts` matching all tables
- [ ] Seed data included in migration (or separate `002_seed_data.sql`):
  ```sql
  INSERT INTO kids (name) VALUES ('Aiden'), ('Skylar');
  INSERT INTO settings (key, value) VALUES
    ('mmf_apy', '0.042'),
    ('cd_3m_apy', '0.048'),
    ('cd_6m_apy', '0.050'),
    ('cd_12m_apy', '0.052'),
    ('stock_position_limit', '5'),
    ('hanzi_dojo_conversion_rate', '0.10');
  ```

**Test:** Migration runs successfully against Supabase. All tables exist. INSERT/SELECT works for each table. RLS blocks unauthenticated access.

---

### T3: Set Up Authentication

**What:** Configure Supabase email auth with protected routes.

**Acceptance Criteria:**
- [ ] `src/lib/supabase.ts` exports a configured Supabase client
- [ ] `src/lib/auth.ts` exports: `signIn(email, password)`, `signOut()`, `getCurrentUser()`, `onAuthStateChange(callback)`
- [ ] Auth context provider: `src/components/AuthProvider.tsx`
- [ ] `useAuth()` hook returns `{ user, loading, signIn, signOut }`
- [ ] Protected route wrapper: redirects to login if not authenticated
- [ ] Login page: email + password form, error display, redirects to dashboard on success
- [ ] No signup flow (admins are pre-created in Supabase dashboard — see prerequisite P4)
- [ ] Auth state persists across page reloads (Supabase handles this)

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
- `deposit_to_cash(p_kid_id, p_amount, p_note, p_source, p_created_by)` — adds a deposit transaction
- `withdraw_from_cash(p_kid_id, p_amount, p_note, p_created_by)` — adds a withdrawal transaction (validates sufficient balance)

**Read Functions (TypeScript):**
- `getCashBalance(kidId)` → returns current cash balance via Supabase query

**Acceptance Criteria:**
- [ ] `deposit_to_cash` creates a transaction with `type='deposit'`, `bucket='cash'`, positive amount
- [ ] `deposit_to_cash` accepts `p_source` stored in metadata as `{"source": "red_envelope"}` etc.
- [ ] `withdraw_from_cash` creates a transaction with `type='withdraw'`, `bucket='cash'`, negative amount
- [ ] `withdraw_from_cash` FAILS if amount > current cash balance (raises exception)
- [ ] `getCashBalance` returns `SUM(t.amount) FROM transactions t WHERE t.kid_id = $1 AND t.bucket = 'cash'`
- [ ] All PL/pgSQL uses explicit table aliases (`t.kid_id`, not `kid_id`)
- [ ] All PL/pgSQL functions are `SECURITY INVOKER` (use caller's RLS context)
- [ ] TypeScript wrapper functions in `src/lib/transactions.ts` calling `supabase.rpc()`

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
- `invest_in_mmf(p_kid_id, p_amount, p_created_by)` — moves cash → MMF (atomic: deducts cash + adds MMF)
- `redeem_from_mmf(p_kid_id, p_amount, p_created_by)` — moves MMF → cash (atomic)
- `accrue_mmf_interest(p_kid_id)` — calculates and credits daily interest since last accrual
- `accrue_all_mmf_interest()` — runs accrual for all kids (for cron job)

**TypeScript Functions:**
- `getMmfBalance(kidId)` → current MMF balance (SUM of mmf transactions)

**Acceptance Criteria:**
- [ ] `invest_in_mmf` creates two transactions atomically: `type='invest', bucket='cash'` (negative) + `type='invest', bucket='mmf'` (positive)
- [ ] `invest_in_mmf` fails if insufficient cash balance
- [ ] `redeem_from_mmf` does the reverse atomically (fails if insufficient MMF balance)
- [ ] `accrue_mmf_interest` reads current APY from `settings` table (key: `mmf_apy`)
- [ ] Last accrual date = `MAX(t.created_at) FROM transactions t WHERE t.kid_id = $1 AND t.type = 'interest' AND t.bucket = 'mmf'`. If NULL, use date of kid's first MMF invest transaction.
- [ ] Interest = `mmf_balance * (apy / 365) * days_since_last_accrual`
- [ ] Interest credited as transaction: `type='interest', bucket='mmf'`
- [ ] If days_since_last_accrual = 0, does nothing (no double-credit)
- [ ] All PL/pgSQL uses explicit table aliases

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
- `create_cd(p_kid_id, p_amount, p_term_months, p_created_by)` — locks cash into a CD lot
- `break_cd(p_cd_lot_id, p_created_by)` — early withdrawal with penalty
- `mature_cd(p_cd_lot_id, p_created_by)` — processes a matured CD (returns principal + interest to cash)
- `process_matured_cds()` — auto-processes all CDs past maturity date (for cron)

**TypeScript Functions:**
- `getCdLots(kidId)` → returns all active/matured CD lots with current accrued value

**Acceptance Criteria:**
- [ ] `create_cd` deducts from cash (transaction `type='invest', bucket='cash'`), creates `cd_lots` row with `status='active'`
- [ ] `create_cd` fails if `p_term_months` not in (3, 6, 12)
- [ ] `create_cd` fails if insufficient cash balance
- [ ] APY for each term read from settings: `cd_3m_apy`, `cd_6m_apy`, `cd_12m_apy`
- [ ] `maturity_date = start_date + (term_months * interval '1 month')`
- [ ] `mature_cd` returns principal + accrued interest to cash (transaction `type='redeem', bucket='cash'`)
- [ ] `mature_cd` fails if CD not yet matured (`maturity_date > now()`)
- [ ] `mature_cd` sets `status='matured'`
- [ ] `break_cd` returns principal + (accrued interest - penalty) to cash
- [ ] `break_cd` sets `status='broken'`
- [ ] CD interest = `principal * apy * (actual_days_held / 365)`
- [ ] Penalty for early break = last 30 days of interest (or all interest if held < 30 days)
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
- `buy_stock(p_kid_id, p_ticker, p_dollar_amount, p_created_by)` — buys virtual shares at current price
- `sell_stock(p_kid_id, p_ticker, p_dollar_amount, p_created_by)` — sells virtual shares at current price (pass 0 for "sell all")

**TypeScript Functions:**
- `getStockPositions(kidId)` → returns all positions with current value and gain/loss
- `getPortfolioSummary(kidId)` → returns total: cash + MMF + CD + stocks

**Acceptance Criteria:**
- [ ] `buy_stock` deducts from cash, creates/updates `stock_positions` row
- [ ] Virtual shares = `p_dollar_amount / current_price` (from latest `stock_prices` entry for that ticker)
- [ ] `buy_stock` fails if insufficient cash
- [ ] `buy_stock` fails if kid already has positions = stock_position_limit (from settings) and this is a new ticker
- [ ] `buy_stock` fails if ticker has no entry in `stock_prices` (ticker not tracked yet)
- [ ] If kid already holds ticker, adds to existing position (increases `shares`, increases `cost_basis`)
- [ ] Creates transactions: `type='buy', bucket='cash'` (negative) + `type='buy', bucket='stock'` (positive, metadata: `{"ticker": "NVDA", "shares": 0.25, "price_per_share": 800.00}`)
- [ ] `sell_stock` with `p_dollar_amount > 0`: sells shares worth that dollar amount at current price
- [ ] `sell_stock` with `p_dollar_amount = 0`: sells ALL shares (full liquidation)
- [ ] If selling all shares, deletes the `stock_positions` row
- [ ] `getStockPositions` returns: ticker, shares, cost_basis, current_price, current_value, gain_loss, gain_loss_pct
- [ ] `getPortfolioSummary` returns: cash, mmf, cd_total, stock_total, grand_total
- [ ] All PL/pgSQL uses explicit table aliases

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
   → NVDA value = 0.13888889 * $900 = $125.00

4. Buy $100 of VTI at $250
   → VTI shares = 100/250 = 0.40000000
   → cash = $400 - $100 = $300.00
   → positions = 2

5. Portfolio summary:
   → cash = $300.00
   → mmf = $0.00
   → cd = $0.00
   → stocks = (0.13888889 * $900) + (0.40 * $250) = $125.00 + $100.00 = $225.00
   → total = $525.00

6. Attempt to buy 6th different ticker (with 5 already held) → FAILS (position limit)
```

---

### T8: Hanzi Dojo Delta Logic

**What:** PL/pgSQL function for high-water-mark tracking of Hanzi Dojo points → cash deposits.

**Implementation:** PL/pgSQL RPC (creates deposit transactions).

**PL/pgSQL Functions:**
- `record_hanzi_dojo_points(p_kid_id, p_current_total_points, p_created_by)` — records snapshot, computes delta, deposits cash equivalent

**TypeScript Functions:**
- `getHanziDojoHistory(kidId)` → returns all snapshots

**Acceptance Criteria:**
- [ ] First snapshot for a kid: `previous_total = 0`, delta = current_total
- [ ] Subsequent snapshots: `previous_total` = most recent snapshot's `total_points`
- [ ] `delta_points = current_total - previous_total`
- [ ] `dollar_equivalent = delta_points * conversion_rate` (reads `hanzi_dojo_conversion_rate` from settings, default $0.10/point)
- [ ] If delta > 0: auto-creates a cash deposit transaction with note 'Hanzi Dojo points' and metadata `{"source": "hanzi_dojo", "points": delta_points}`
- [ ] If delta = 0: creates snapshot but no transaction
- [ ] If delta < 0: FAILS with error (points shouldn't decrease; likely a data entry error)
- [ ] All PL/pgSQL uses explicit table aliases

**Test Cases:**
```
1. Record 500 points for Aiden (first time) → delta=500, deposit=$50.00, cash=$50.00
2. Record 750 points → delta=250, deposit=$25.00, cash=$75.00
3. Record 750 points again → delta=0, no deposit, cash=$75.00
4. Record 600 points → FAILS (points decreased, likely entry error)
```

---

### T9: Twelve Data Stock Price Integration

**What:** TypeScript function for daily stock price fetching, plus manual trigger for v1.

**Implementation:** TypeScript function (reads from external API, writes to `stock_prices` table via Supabase client). **V1: manually triggered from the Settings page or via a "Refresh Prices" button. V2 (future): Vercel cron job.** This avoids scope creep into Edge Functions and cron configuration.

**Acceptance Criteria:**
- [ ] `src/lib/stockPrices.ts` exports `fetchAndStorePrices(tickers: string[])`
- [ ] Uses Twelve Data batch endpoint: `GET /time_series?symbol=NVDA,VTI,...&interval=1day&outputsize=1`
- [ ] Parses response, upserts each ticker's close price into `stock_prices` table
- [ ] Handles API errors gracefully (logs error, does not crash, returns partial success)
- [ ] Handles market holidays (no new data = no insert, no error)
- [ ] Deduplicates: upsert on `(ticker, date)` composite key
- [ ] `fetchHistoricalPrices(ticker, days)` for initial backfill (used once per new ticker)
- [ ] `getTrackedTickers()` → returns distinct tickers from `stock_positions` across all kids
- [ ] API key read from environment variable `TWELVE_DATA_API_KEY`
- [ ] "Refresh Prices" button on Settings page (T15) triggers `fetchAndStorePrices(getTrackedTickers())`

**Test Cases:**
```
1. Fetch prices for ["NVDA", "VTI", "TSM"] → 3 rows upserted in stock_prices
2. Fetch again same day → no duplicate rows (upsert overwrites)
3. Invalid ticker "ZZZZZ" → graceful error, other tickers still processed
4. Historical backfill for NVDA (30 days) → ~22 rows in stock_prices (trading days only)
```

---

### T10: Investment Simulator

**What:** "What would $X become?" pure TypeScript calculator.

**Implementation:** TypeScript function (pure computation, no RPC).

**Functions:**
- `simulateGrowth(amount: number, months: number, rates: Settings)` → returns projected values

**Acceptance Criteria:**
- [ ] Reads current rates from settings (passed in, or fetched once from `settings` table)
- [ ] Returns projections for:
  - Cash (mattress): `amount` (no growth)
  - MMF: `amount * (1 + apy/12)^months` (monthly compounding)
  - CD 3m (if months >= 3): `amount * (1 + cd_3m_apy * 3/12)` — single term, no reinvestment
  - CD 6m (if months >= 6): `amount * (1 + cd_6m_apy * 6/12)` — single term, no reinvestment
  - CD 12m (if months >= 12): `amount * (1 + cd_12m_apy)` — single term, no reinvestment
  - Stocks: returns `null` with label "Unknown — that's what risk means!"
- [ ] All amounts rounded to 2 decimal places
- [ ] Returns `null` for CD terms where months < term length

**Test Cases:**
```
Setup: mmf_apy=0.042, cd_3m_apy=0.048, cd_6m_apy=0.050, cd_12m_apy=0.052

simulateGrowth(100, 12):
  cash:   $100.00
  mmf:    $100 * (1 + 0.042/12)^12 = $104.28
  cd_3m:  $100 * (1 + 0.048 * 3/12) = $101.20
  cd_6m:  $100 * (1 + 0.050 * 6/12) = $102.50
  cd_12m: $100 * (1 + 0.052) = $105.20
  stocks: null

simulateGrowth(50, 3):
  cash:   $50.00
  mmf:    $50 * (1 + 0.042/12)^3 = $50.53
  cd_3m:  $50 * (1 + 0.048 * 3/12) = $50.60
  cd_6m:  null (term > months)
  cd_12m: null (term > months)
  stocks: null
```

---

### T11: Admin Dashboard Page

**What:** Landing page showing both kids' balances at a glance.

**Acceptance Criteria:**
- [ ] Route: `/` (authenticated)
- [ ] Shows one card per kid with:
  - Kid name
  - Total portfolio value (cash + MMF + CD + stocks)
  - Breakdown: cash | MMF | CD | stocks (as numbers)
- [ ] Calls `getPortfolioSummary` for each kid
- [ ] Loading state while fetching
- [ ] Error state if fetch fails
- [ ] Mobile-responsive (stacks vertically on phone)
- [ ] Navigation to individual kid's investment page

**Test:** Page renders both kids' balances. Values update after a deposit is made via Add Money.

---

### T12: Add Money Page

**What:** Form for depositing money into a kid's cash balance.

**Acceptance Criteria:**
- [ ] Route: `/add-money`
- [ ] Form fields:
  - Kid selector (dropdown: Aiden / Skylar)
  - Amount (number input, required, > 0)
  - Source (dropdown: Chores, Reading Reward, Hanzi Dojo Points, Red Envelope, Gift, Other)
  - Note (optional text)
- [ ] **If source = "Hanzi Dojo Points":** show points input instead of dollar amount. App converts and displays: "750 points = $75.00". Calls `record_hanzi_dojo_points` RPC.
- [ ] **All other sources:** dollar amount input. Calls `deposit_to_cash` RPC.
- [ ] Success message with updated cash balance shown
- [ ] Form resets after successful submission (ready for next entry)
- [ ] Validation: amount must be positive, kid must be selected
- [ ] Mobile-optimized (large touch targets, easy one-handed use)

**Test:**
1. Add $50 gift for Aiden → success, balance increases by $50
2. Add 300 Hanzi Dojo points for Aiden → success, $30 deposited, balance increases by $30
3. Submit with no amount → validation error
4. Submit with negative amount → validation error

---

### T13a: Manage Investments — MMF Section

**What:** MMF management within the kid's investment page.

**Acceptance Criteria:**
- [ ] Route: `/kid/:kidId/invest` (shared page with T13b, T13c — this task builds the MMF section)
- [ ] Page layout: shows current cash balance prominently at top ("Available to invest: $X")
- [ ] MMF section shows:
  - Current MMF balance
  - Current APY rate (from settings)
  - "Add to MMF" form: amount input + submit → calls `invest_in_mmf` RPC
  - "Withdraw from MMF" form: amount input + submit → calls `redeem_from_mmf` RPC
- [ ] Balances update after each action without page reload
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
- [ ] Matured CDs (status='matured' or maturity_date <= now) show "Collect" button → calls `mature_cd` RPC
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
- [ ] "Buy Stock/ETF" form: ticker text input + dollar amount + submit → calls `buy_stock` RPC
- [ ] Ticker input accepts any string; validation = must exist in `stock_prices` table
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
- `spend_from_mmf(p_kid_id, p_amount, p_note, p_created_by)` — atomically redeems from MMF and records the spend (no intermediate cash state)
- `spend_from_stock(p_kid_id, p_ticker, p_amount, p_note, p_created_by)` — atomically sells shares and records the spend

**Acceptance Criteria:**
- [ ] Route: `/spend`
- [ ] Form fields:
  - Kid selector
  - Amount (number input, required, > 0)
  - Source bucket (dropdown: Cash, MMF, Stock — with current balance shown per option)
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
- [ ] Save button updates `settings` table
- [ ] Shows last-updated timestamp per setting
- [ ] Input validation: rates between 0% and 20%, position limit 1-10
- [ ] **"Refresh Stock Prices" button** → calls `fetchAndStorePrices(getTrackedTickers())` → shows success/failure + last refresh timestamp
- [ ] Mobile-responsive

**Test:**
1. Change MMF APY from 4.2% to 4.5% → saved, persists on page reload
2. Set invalid rate (-5%) → validation error
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
8. T8: Hanzi Dojo delta logic

**Wave 3 (parallel — depends on Wave 2 outputs):**
9. T9: Twelve Data integration
10. T10: Investment simulator

**Wave 4 (parallel — UI pages, depend on RPCs from Wave 2-3):**
11. T11: Admin dashboard
12. T12: Add money page
13. T13a: MMF management UI
14. T13b: CD management UI
15. T13c: Stock management UI
16. T14: Record spending page (includes `spend_from_mmf` and `spend_from_stock` RPCs)
17. T15: Settings page (includes price refresh button)

**Wave 5 (integration verification):**
18. End-to-end test: deposit → invest in all 3 products → accrue interest → spend from each bucket → verify all balances

---

## Definition of Done (Phase A Complete)

- [ ] All 17 tasks pass their acceptance criteria
- [ ] All test cases pass
- [ ] `npm run build` succeeds with zero errors
- [ ] `npm run lint` passes with zero errors
- [ ] App runs on localhost, two admins can log in
- [ ] Can complete full lifecycle: add money → invest in all 3 products → accrue interest → spend
- [ ] Stock prices fetch from Twelve Data API via manual refresh
- [ ] Hanzi Dojo points convert correctly via high-water-mark
- [ ] Investment simulator shows correct projections
- [ ] All PL/pgSQL RPCs tested in Supabase SQL Editor before frontend wiring
- [ ] Mobile-responsive (functional, not necessarily "delightful" — that's Phase B)
