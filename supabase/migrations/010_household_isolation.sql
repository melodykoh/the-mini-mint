-- Migration 010: Household-based data isolation
--
-- Problem: All admins see all kids. Test account can modify Aiden/Skylar.
-- Solution: Add household_id to admin_users and kids. Update RLS + RPCs.
--
-- Households:
--   "Sheen Family" → Melody + husband → Aiden, Skylar
--   "QA Test"    → testuser@familyapps.com → QA-Alice, QA-Bob
--
-- Run sections one-at-a-time in Supabase SQL Editor and verify each step.

-- ============================================================
-- SECTION 1: Create households table + seed data
-- ============================================================

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE households ENABLE ROW LEVEL SECURITY;

-- NOTE: RLS policy for households is added AFTER Section 2
-- (it references admin_users.household_id which doesn't exist yet)

INSERT INTO households (id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Sheen Family'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'QA Test');


-- ============================================================
-- SECTION 2: Add household_id to admin_users
-- ============================================================

ALTER TABLE admin_users
  ADD COLUMN household_id uuid REFERENCES households(id);

-- Melody
UPDATE admin_users
SET household_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE user_id = '060b3bac-15e5-462e-9ed1-406b5a8fcc62';

-- Husband
UPDATE admin_users
SET household_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE user_id = 'c5363614-5af4-4603-be5f-cc0e2b99ca44';

-- Test user
UPDATE admin_users
SET household_id = 'aaaaaaaa-0000-0000-0000-000000000002'
WHERE user_id = '19e4ce84-e500-4d85-a74a-036064fc28e3';

ALTER TABLE admin_users
  ALTER COLUMN household_id SET NOT NULL;

-- Now we can add the households RLS policy (admin_users.household_id exists)
CREATE POLICY "members_only" ON households
  FOR ALL TO authenticated
  USING (
    id = (
      SELECT au.household_id FROM admin_users au
      WHERE au.user_id = (SELECT auth.uid())
    )
  );


-- ============================================================
-- SECTION 3: Add household_id to kids
-- ============================================================

ALTER TABLE kids
  ADD COLUMN household_id uuid REFERENCES households(id);

-- Aiden + Skylar + TestKid → Sheen Family
UPDATE kids
SET household_id = 'aaaaaaaa-0000-0000-0000-000000000001'
WHERE name IN ('Aiden', 'Skylar', 'TestKid');

-- QA kids → QA Test
UPDATE kids
SET household_id = 'aaaaaaaa-0000-0000-0000-000000000002'
WHERE name LIKE 'QA-%';

ALTER TABLE kids
  ALTER COLUMN household_id SET NOT NULL;


-- ============================================================
-- SECTION 4: Update RLS policies — household-scoped
-- ============================================================

-- Helper: get caller's household_id (used in all policies below)
-- Pattern: (SELECT au.household_id FROM admin_users au WHERE au.user_id = (SELECT auth.uid()))

-- 4a. kids: only see kids in your household
DROP POLICY IF EXISTS "admin_only" ON kids;
CREATE POLICY "household_only" ON kids
  FOR ALL TO authenticated
  USING (
    household_id = (
      SELECT au.household_id FROM admin_users au
      WHERE au.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    household_id = (
      SELECT au.household_id FROM admin_users au
      WHERE au.user_id = (SELECT auth.uid())
    )
  );

-- 4b. transactions: only see transactions for kids in your household
DROP POLICY IF EXISTS "admin_only" ON transactions;
CREATE POLICY "household_only" ON transactions
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM kids k
      WHERE k.id = transactions.kid_id
        AND k.household_id = (
          SELECT au.household_id FROM admin_users au
          WHERE au.user_id = (SELECT auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM kids k
      WHERE k.id = transactions.kid_id
        AND k.household_id = (
          SELECT au.household_id FROM admin_users au
          WHERE au.user_id = (SELECT auth.uid())
        )
    )
  );

-- 4c. cd_lots: only see CDs for kids in your household
DROP POLICY IF EXISTS "admin_only" ON cd_lots;
CREATE POLICY "household_only" ON cd_lots
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM kids k
      WHERE k.id = cd_lots.kid_id
        AND k.household_id = (
          SELECT au.household_id FROM admin_users au
          WHERE au.user_id = (SELECT auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM kids k
      WHERE k.id = cd_lots.kid_id
        AND k.household_id = (
          SELECT au.household_id FROM admin_users au
          WHERE au.user_id = (SELECT auth.uid())
        )
    )
  );

-- 4d. stock_positions: only see positions for kids in your household
DROP POLICY IF EXISTS "admin_only" ON stock_positions;
CREATE POLICY "household_only" ON stock_positions
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM kids k
      WHERE k.id = stock_positions.kid_id
        AND k.household_id = (
          SELECT au.household_id FROM admin_users au
          WHERE au.user_id = (SELECT auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM kids k
      WHERE k.id = stock_positions.kid_id
        AND k.household_id = (
          SELECT au.household_id FROM admin_users au
          WHERE au.user_id = (SELECT auth.uid())
        )
    )
  );

-- 4e. stock_prices: stays global (prices are not household-specific)
-- No change needed — all admins should see all prices.

-- 4f. settings: stays global (rates, limits are not household-specific)
-- No change needed — all admins should see all settings.

-- 4g. admin_users: already fixed in migration 008 (self_check)
-- No change needed.


-- ============================================================
-- SECTION 5: Update RPCs — add household ownership check
-- ============================================================

-- The pattern changes from:
--   IF NOT EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id)
--   IF NOT EXISTS (SELECT 1 FROM kids k WHERE k.id = p_kid_id)
--
-- To a single combined check:
--   IF NOT EXISTS (
--     SELECT 1 FROM admin_users au
--     JOIN kids k ON k.household_id = au.household_id
--     WHERE au.user_id = v_caller_id AND k.id = p_kid_id
--   )

-- 5a. deposit_to_cash (latest version from 009)
CREATE OR REPLACE FUNCTION deposit_to_cash(
  p_kid_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS TABLE (new_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_final_metadata jsonb;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING DETAIL = format('received: %s', p_amount),
            ERRCODE = 'P0001';
  END IF;

  -- Validate note length
  IF p_note IS NOT NULL AND LENGTH(p_note) > 500 THEN
    RAISE EXCEPTION 'Note too long: max 500 characters'
      USING ERRCODE = 'P0001';
  END IF;

  -- Build metadata: merge source + caller-supplied metadata
  v_final_metadata := COALESCE(p_metadata, '{}'::jsonb);
  IF p_source IS NOT NULL THEN
    v_final_metadata := v_final_metadata || jsonb_build_object('source', p_source);
  END IF;
  IF v_final_metadata = '{}'::jsonb THEN
    v_final_metadata := NULL;
  END IF;

  -- Insert deposit transaction
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'deposit', 'cash', p_amount, p_note, v_final_metadata, v_caller_id);

  -- Return updated cash balance
  RETURN QUERY
  SELECT COALESCE(SUM(t.amount), 0.00)::numeric AS new_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'cash';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5b. withdraw_from_cash
CREATE OR REPLACE FUNCTION withdraw_from_cash(
  p_kid_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL
)
RETURNS TABLE (new_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_balance numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING DETAIL = format('received: %s', p_amount),
            ERRCODE = 'P0001';
  END IF;

  -- Validate note length
  IF p_note IS NOT NULL AND LENGTH(p_note) > 500 THEN
    RAISE EXCEPTION 'Note too long: max 500 characters'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Check balance
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'cash';

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient cash: have %, need %', v_balance, p_amount
      USING DETAIL = format('available: %s, requested: %s', v_balance, p_amount),
            HINT = 'Check balance before transacting',
            ERRCODE = 'P0001';
  END IF;

  -- Insert withdrawal transaction (negative amount)
  INSERT INTO transactions (kid_id, type, bucket, amount, note, created_by)
  VALUES (p_kid_id, 'withdraw', 'cash', -p_amount, p_note, v_caller_id);

  -- Return updated cash balance
  RETURN QUERY
  SELECT COALESCE(SUM(t.amount), 0.00)::numeric AS new_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'cash';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5c. invest_in_mmf
CREATE OR REPLACE FUNCTION invest_in_mmf(
  p_kid_id uuid,
  p_amount numeric
)
RETURNS TABLE (cash_balance numeric, mmf_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_cash numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Check cash balance
  SELECT COALESCE(SUM(t.amount), 0.00) INTO v_cash
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'cash';

  IF v_cash < p_amount THEN
    RAISE EXCEPTION 'Insufficient cash: have %, need %', v_cash, p_amount
      USING DETAIL = format('available: %s, requested: %s', v_cash, p_amount),
            HINT = 'Check balance before investing',
            ERRCODE = 'P0001';
  END IF;

  -- Deduct from cash
  INSERT INTO transactions (kid_id, type, bucket, amount, created_by)
  VALUES (p_kid_id, 'invest', 'cash', -p_amount, v_caller_id);

  -- Add to MMF
  INSERT INTO transactions (kid_id, type, bucket, amount, created_by)
  VALUES (p_kid_id, 'invest', 'mmf', p_amount, v_caller_id);

  -- Return updated balances
  RETURN QUERY
  SELECT
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS cash_balance,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf')::numeric AS mmf_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5d. redeem_from_mmf
CREATE OR REPLACE FUNCTION redeem_from_mmf(
  p_kid_id uuid,
  p_amount numeric
)
RETURNS TABLE (cash_balance numeric, mmf_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_mmf numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Check MMF balance
  SELECT COALESCE(SUM(t.amount), 0.00) INTO v_mmf
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf';

  IF v_mmf < p_amount THEN
    RAISE EXCEPTION 'Insufficient MMF balance: have %, need %', v_mmf, p_amount
      USING DETAIL = format('available: %s, requested: %s', v_mmf, p_amount),
            HINT = 'Check balance before redeeming',
            ERRCODE = 'P0001';
  END IF;

  -- Deduct from MMF
  INSERT INTO transactions (kid_id, type, bucket, amount, created_by)
  VALUES (p_kid_id, 'redeem', 'mmf', -p_amount, v_caller_id);

  -- Add to cash
  INSERT INTO transactions (kid_id, type, bucket, amount, created_by)
  VALUES (p_kid_id, 'redeem', 'cash', p_amount, v_caller_id);

  -- Return updated balances
  RETURN QUERY
  SELECT
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS cash_balance,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf')::numeric AS mmf_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5e. accrue_mmf_interest
CREATE OR REPLACE FUNCTION accrue_mmf_interest(
  p_kid_id uuid
)
RETURNS TABLE (interest_credited numeric, new_mmf_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_mmf_balance numeric;
  v_apy numeric;
  v_last_accrual_date date;
  v_days integer;
  v_interest numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get current MMF balance
  SELECT COALESCE(SUM(t.amount), 0.00) INTO v_mmf_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf';

  IF v_mmf_balance <= 0 THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  -- Get current APY from settings
  SELECT s.value::numeric INTO v_apy
  FROM settings s WHERE s.key = 'mmf_apy';

  IF v_apy IS NULL THEN
    RAISE EXCEPTION 'Setting mmf_apy not found' USING ERRCODE = 'P0001';
  END IF;

  -- Find last accrual date
  SELECT utc_date(t.created_at) INTO v_last_accrual_date
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.type = 'interest' AND t.bucket = 'mmf'
  ORDER BY t.created_at DESC LIMIT 1;

  IF v_last_accrual_date IS NULL THEN
    SELECT utc_date(t.created_at) INTO v_last_accrual_date
    FROM transactions t
    WHERE t.kid_id = p_kid_id AND t.type = 'invest' AND t.bucket = 'mmf'
    ORDER BY t.created_at ASC LIMIT 1;
  END IF;

  IF v_last_accrual_date IS NULL THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  v_days := CURRENT_DATE - v_last_accrual_date;

  IF v_days <= 0 THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  v_interest := ROUND(v_mmf_balance * (v_apy / 365.0) * v_days, 2);

  IF v_interest <= 0 THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  -- Credit interest
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (
    p_kid_id, 'interest', 'mmf', v_interest,
    jsonb_build_object('days_accrued', v_days, 'apy_at_accrual', v_apy, 'balance_at_accrual', v_mmf_balance),
    v_caller_id
  );

  RETURN QUERY SELECT v_interest AS interest_credited, (v_mmf_balance + v_interest) AS new_mmf_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5f. create_cd
CREATE OR REPLACE FUNCTION create_cd(
  p_kid_id uuid,
  p_amount numeric,
  p_term_months integer
)
RETURNS TABLE (cd_lot_id uuid, maturity_date date, apy numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_cash numeric;
  v_apy numeric;
  v_maturity date;
  v_lot_id uuid;
  v_setting_key text;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate term
  IF p_term_months NOT IN (3, 6, 12) THEN
    RAISE EXCEPTION 'Invalid term: must be 3, 6, or 12 months'
      USING DETAIL = format('received: %s', p_term_months), ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Check cash balance
  SELECT COALESCE(SUM(t.amount), 0.00) INTO v_cash
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'cash';

  IF v_cash < p_amount THEN
    RAISE EXCEPTION 'Insufficient cash: have %, need %', v_cash, p_amount
      USING DETAIL = format('available: %s, requested: %s', v_cash, p_amount), ERRCODE = 'P0001';
  END IF;

  -- Get APY
  v_setting_key := 'cd_' || p_term_months || 'm_apy';
  SELECT s.value::numeric INTO v_apy FROM settings s WHERE s.key = v_setting_key;

  IF v_apy IS NULL THEN
    RAISE EXCEPTION 'Setting % not found', v_setting_key USING ERRCODE = 'P0001';
  END IF;

  v_maturity := (CURRENT_DATE + (p_term_months || ' months')::interval)::date;

  -- Deduct cash
  INSERT INTO transactions (kid_id, type, bucket, amount, created_by)
  VALUES (p_kid_id, 'invest', 'cash', -p_amount, v_caller_id);

  -- Create CD lot
  INSERT INTO cd_lots (kid_id, principal, apy, term_months, start_date, maturity_date, status)
  VALUES (p_kid_id, p_amount, v_apy, p_term_months, CURRENT_DATE, v_maturity, 'active')
  RETURNING cd_lots.id INTO v_lot_id;

  RETURN QUERY SELECT v_lot_id AS cd_lot_id, v_maturity AS maturity_date, v_apy AS apy;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5g. mature_cd (takes cd_lot_id, not kid_id — check via lot → kid → household)
CREATE OR REPLACE FUNCTION mature_cd(
  p_cd_lot_id uuid
)
RETURNS TABLE (principal_returned numeric, interest_earned numeric, total_returned numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_lot cd_lots%ROWTYPE;
  v_days integer;
  v_interest numeric;
  v_total numeric;
BEGIN
  -- Fetch CD lot
  SELECT cl.* INTO v_lot FROM cd_lots cl WHERE cl.id = p_cd_lot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CD lot not found: %', p_cd_lot_id USING ERRCODE = 'P0001';
  END IF;

  -- Auth + household ownership check (via lot's kid)
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = v_lot.kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_lot.status != 'active' THEN
    RAISE EXCEPTION 'CD lot is not active (status: %)', v_lot.status USING ERRCODE = 'P0001';
  END IF;

  IF v_lot.maturity_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'CD not yet matured: matures on %', v_lot.maturity_date
      USING DETAIL = format('maturity_date: %s, today: %s', v_lot.maturity_date, CURRENT_DATE),
            HINT = 'Wait until maturity date or use break_cd for early withdrawal',
            ERRCODE = 'P0001';
  END IF;

  -- Advisory lock on the kid
  PERFORM pg_advisory_xact_lock(hashtext(v_lot.kid_id::text));

  -- Calculate interest
  v_days := v_lot.maturity_date - v_lot.start_date;
  v_interest := ROUND(v_lot.principal * v_lot.apy * v_days / 365.0, 2);
  v_total := v_lot.principal + v_interest;

  -- Update CD lot status
  UPDATE cd_lots SET status = 'matured' WHERE id = p_cd_lot_id;

  -- Return principal + interest to cash
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (
    v_lot.kid_id, 'redeem', 'cash', v_total,
    format('%s-month CD matured', v_lot.term_months),
    jsonb_build_object('cd_lot_id', p_cd_lot_id, 'principal', v_lot.principal,
      'interest', v_interest, 'apy', v_lot.apy, 'days_held', v_days),
    v_caller_id
  );

  RETURN QUERY SELECT v_lot.principal AS principal_returned, v_interest AS interest_earned, v_total AS total_returned;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5h. break_cd (takes cd_lot_id — check via lot → kid → household)
CREATE OR REPLACE FUNCTION break_cd(
  p_cd_lot_id uuid
)
RETURNS TABLE (principal_returned numeric, interest_earned numeric, penalty numeric, net_returned numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_lot cd_lots%ROWTYPE;
  v_days integer;
  v_interest numeric;
  v_penalty numeric;
  v_penalty_days integer;
  v_net numeric;
BEGIN
  -- Fetch CD lot
  SELECT cl.* INTO v_lot FROM cd_lots cl WHERE cl.id = p_cd_lot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CD lot not found: %', p_cd_lot_id USING ERRCODE = 'P0001';
  END IF;

  -- Auth + household ownership check (via lot's kid)
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = v_lot.kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_lot.status != 'active' THEN
    RAISE EXCEPTION 'CD lot is not active (status: %)', v_lot.status USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock on the kid
  PERFORM pg_advisory_xact_lock(hashtext(v_lot.kid_id::text));

  -- Calculate interest earned so far
  v_days := CURRENT_DATE - v_lot.start_date;
  v_interest := ROUND(v_lot.principal * v_lot.apy * v_days / 365.0, 2);

  -- Penalty = last 30 days of interest (or all interest if held < 30 days)
  v_penalty_days := LEAST(v_days, 30);
  v_penalty := ROUND(v_lot.principal * v_lot.apy * v_penalty_days / 365.0, 2);

  -- Net return: principal + interest - penalty, but never less than principal
  v_net := v_lot.principal + GREATEST(v_interest - v_penalty, 0);

  -- Update CD lot status
  UPDATE cd_lots SET status = 'broken' WHERE id = p_cd_lot_id;

  -- Return net amount to cash
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (
    v_lot.kid_id, 'redeem', 'cash', v_net,
    format('%s-month CD broken early (day %s of %s)', v_lot.term_months, v_days, (v_lot.maturity_date - v_lot.start_date)),
    jsonb_build_object('cd_lot_id', p_cd_lot_id, 'principal', v_lot.principal,
      'interest_earned', v_interest, 'penalty', v_penalty, 'penalty_days', v_penalty_days,
      'net_returned', v_net, 'days_held', v_days, 'apy', v_lot.apy),
    v_caller_id
  );

  RETURN QUERY SELECT v_lot.principal AS principal_returned, v_interest AS interest_earned, v_penalty AS penalty, v_net AS net_returned;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5i. buy_stock
CREATE OR REPLACE FUNCTION buy_stock(
  p_kid_id uuid,
  p_ticker text,
  p_dollar_amount numeric
)
RETURNS TABLE (shares_bought numeric, price_per_share numeric, new_cash_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_cash numeric;
  v_price numeric;
  v_shares numeric;
  v_position_count integer;
  v_position_limit integer;
  v_has_position boolean;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate ticker format
  IF p_ticker !~ '^[A-Z]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid ticker format: must be 1-10 uppercase letters'
      USING DETAIL = format('received: %s', p_ticker), ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_dollar_amount <= 0 OR p_dollar_amount > 100000 OR p_dollar_amount != ROUND(p_dollar_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get latest price
  SELECT sp.close_price INTO v_price
  FROM stock_prices sp WHERE sp.ticker = p_ticker
  ORDER BY sp.date DESC LIMIT 1;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'No price data for ticker %: add price data first', p_ticker
      USING HINT = 'Use the stock price refresh to fetch prices before buying', ERRCODE = 'P0001';
  END IF;

  -- Check position limit (only for new tickers)
  SELECT EXISTS (
    SELECT 1 FROM stock_positions spos
    WHERE spos.kid_id = p_kid_id AND spos.ticker = p_ticker
  ) INTO v_has_position;

  IF NOT v_has_position THEN
    SELECT COUNT(*) INTO v_position_count
    FROM stock_positions spos
    WHERE spos.kid_id = p_kid_id AND spos.shares > 0;

    SELECT s.value::integer INTO v_position_limit
    FROM settings s WHERE s.key = 'stock_position_limit';

    IF v_position_limit IS NULL THEN v_position_limit := 5; END IF;

    IF v_position_count >= v_position_limit THEN
      RAISE EXCEPTION 'Position limit reached: max % different stocks allowed', v_position_limit
        USING DETAIL = format('current positions: %s, limit: %s', v_position_count, v_position_limit),
              HINT = 'Sell an existing position before buying a new ticker', ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Check cash balance
  SELECT COALESCE(SUM(t.amount), 0.00) INTO v_cash
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'cash';

  IF v_cash < p_dollar_amount THEN
    RAISE EXCEPTION 'Insufficient cash: have %, need %', v_cash, p_dollar_amount
      USING DETAIL = format('available: %s, requested: %s', v_cash, p_dollar_amount), ERRCODE = 'P0001';
  END IF;

  -- Calculate shares
  v_shares := ROUND(p_dollar_amount / v_price, 8);

  -- Deduct cash
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'buy', 'cash', -p_dollar_amount,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares, 'price_per_share', v_price), v_caller_id);

  -- Record stock transaction
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'buy', 'stock', p_dollar_amount,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares, 'price_per_share', v_price), v_caller_id);

  -- Upsert stock position
  INSERT INTO stock_positions (kid_id, ticker, shares, cost_basis)
  VALUES (p_kid_id, p_ticker, v_shares, p_dollar_amount)
  ON CONFLICT (kid_id, ticker) DO UPDATE
  SET shares = stock_positions.shares + v_shares,
      cost_basis = stock_positions.cost_basis + p_dollar_amount;

  RETURN QUERY
  SELECT v_shares AS shares_bought, v_price AS price_per_share,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS new_cash_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5j. sell_stock
CREATE OR REPLACE FUNCTION sell_stock(
  p_kid_id uuid,
  p_ticker text,
  p_dollar_amount numeric  -- pass 0 for "sell all"
)
RETURNS TABLE (shares_sold numeric, price_per_share numeric, proceeds numeric, realized_gain_loss numeric, new_cash_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_price numeric;
  v_position stock_positions%ROWTYPE;
  v_shares_to_sell numeric;
  v_actual_proceeds numeric;
  v_avg_cost_per_share numeric;
  v_cost_of_sold numeric;
  v_gain numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate ticker format
  IF p_ticker !~ '^[A-Z]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid ticker format: must be 1-10 uppercase letters'
      USING DETAIL = format('received: %s', p_ticker), ERRCODE = 'P0001';
  END IF;

  -- Validate amount (0 is allowed = sell all)
  IF p_dollar_amount < 0 OR p_dollar_amount > 100000 THEN
    RAISE EXCEPTION 'Invalid amount: must be >= 0 and <= $100,000' USING ERRCODE = 'P0001';
  END IF;
  IF p_dollar_amount > 0 AND p_dollar_amount != ROUND(p_dollar_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must have exactly 2 decimal places' USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get latest price
  SELECT sp.close_price INTO v_price
  FROM stock_prices sp WHERE sp.ticker = p_ticker
  ORDER BY sp.date DESC LIMIT 1;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'No price data for ticker %', p_ticker USING ERRCODE = 'P0001';
  END IF;

  -- Get current position
  SELECT spos.* INTO v_position
  FROM stock_positions spos
  WHERE spos.kid_id = p_kid_id AND spos.ticker = p_ticker;

  IF NOT FOUND OR v_position.shares <= 0 THEN
    RAISE EXCEPTION 'No shares of % to sell', p_ticker USING ERRCODE = 'P0001';
  END IF;

  -- Determine shares to sell
  IF p_dollar_amount = 0 THEN
    v_shares_to_sell := v_position.shares;
    v_actual_proceeds := ROUND(v_shares_to_sell * v_price, 2);
  ELSE
    v_shares_to_sell := ROUND(p_dollar_amount / v_price, 8);
    v_actual_proceeds := p_dollar_amount;

    IF v_shares_to_sell > v_position.shares THEN
      RAISE EXCEPTION 'Insufficient shares of %: have %, need %',
        p_ticker, v_position.shares, v_shares_to_sell
        USING DETAIL = format('current value: %s, requested: %s',
          ROUND(v_position.shares * v_price, 2), p_dollar_amount), ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Calculate realized gain/loss
  v_avg_cost_per_share := v_position.cost_basis / v_position.shares;
  v_cost_of_sold := ROUND(v_avg_cost_per_share * v_shares_to_sell, 2);
  v_gain := ROUND(v_actual_proceeds - v_cost_of_sold, 2);

  -- Record cash receipt
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'sell', 'cash', v_actual_proceeds,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares_to_sell, 'price_per_share', v_price, 'realized_gain_loss', v_gain),
    v_caller_id);

  -- Record stock sale
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'sell', 'stock', -v_actual_proceeds,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares_to_sell, 'price_per_share', v_price, 'realized_gain_loss', v_gain),
    v_caller_id);

  -- Update or delete position
  IF v_shares_to_sell >= v_position.shares THEN
    DELETE FROM stock_positions
    WHERE stock_positions.kid_id = p_kid_id AND stock_positions.ticker = p_ticker;
  ELSE
    UPDATE stock_positions
    SET shares = stock_positions.shares - v_shares_to_sell,
        cost_basis = stock_positions.cost_basis - v_cost_of_sold
    WHERE stock_positions.kid_id = p_kid_id AND stock_positions.ticker = p_ticker;
  END IF;

  RETURN QUERY
  SELECT v_shares_to_sell AS shares_sold, v_price AS price_per_share,
    v_actual_proceeds AS proceeds, v_gain AS realized_gain_loss,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS new_cash_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5k. spend_from_mmf
CREATE OR REPLACE FUNCTION spend_from_mmf(
  p_kid_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL
)
RETURNS TABLE (new_mmf_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_mmf numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  SELECT COALESCE(SUM(t.amount), 0.00) INTO v_mmf
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf';

  IF v_mmf < p_amount THEN
    RAISE EXCEPTION 'Insufficient MMF balance: have %, need %', v_mmf, p_amount
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'redeem', 'mmf', -p_amount, p_note,
    jsonb_build_object('reason', 'spend'), v_caller_id);

  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'redeem', 'cash', p_amount, p_note,
    jsonb_build_object('reason', 'spend', 'funded_from', 'mmf'), v_caller_id);

  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'withdraw', 'cash', -p_amount, p_note,
    jsonb_build_object('funded_from', 'mmf'), v_caller_id);

  RETURN QUERY
  SELECT COALESCE(SUM(t.amount), 0.00)::numeric AS new_mmf_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;


-- 5l. spend_from_stock
CREATE OR REPLACE FUNCTION spend_from_stock(
  p_kid_id uuid,
  p_ticker text,
  p_amount numeric,
  p_note text DEFAULT NULL
)
RETURNS TABLE (shares_sold numeric, realized_gain_loss numeric, new_cash_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_price numeric;
  v_position stock_positions%ROWTYPE;
  v_shares_to_sell numeric;
  v_avg_cost numeric;
  v_cost_of_sold numeric;
  v_gain numeric;
BEGIN
  -- Auth + household ownership check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au
    JOIN kids k ON k.household_id = au.household_id
    WHERE au.user_id = v_caller_id AND k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller does not have access to this kid'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_ticker !~ '^[A-Z]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid ticker' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  SELECT sp.close_price INTO v_price
  FROM stock_prices sp WHERE sp.ticker = p_ticker
  ORDER BY sp.date DESC LIMIT 1;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'No price data for %', p_ticker USING ERRCODE = 'P0001';
  END IF;

  SELECT spos.* INTO v_position
  FROM stock_positions spos
  WHERE spos.kid_id = p_kid_id AND spos.ticker = p_ticker;

  IF NOT FOUND OR v_position.shares <= 0 THEN
    RAISE EXCEPTION 'No shares of % to sell', p_ticker USING ERRCODE = 'P0001';
  END IF;

  v_shares_to_sell := ROUND(p_amount / v_price, 8);

  IF v_shares_to_sell > v_position.shares THEN
    RAISE EXCEPTION 'Insufficient shares: have %, need %',
      v_position.shares, v_shares_to_sell USING ERRCODE = 'P0001';
  END IF;

  v_avg_cost := v_position.cost_basis / v_position.shares;
  v_cost_of_sold := ROUND(v_avg_cost * v_shares_to_sell, 2);
  v_gain := ROUND(p_amount - v_cost_of_sold, 2);

  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'sell', 'stock', -p_amount,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares_to_sell,
      'price_per_share', v_price, 'realized_gain_loss', v_gain, 'reason', 'spend'),
    v_caller_id);

  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'sell', 'cash', p_amount,
    jsonb_build_object('ticker', p_ticker, 'reason', 'spend'),
    v_caller_id);

  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'withdraw', 'cash', -p_amount, p_note,
    jsonb_build_object('funded_from', 'stock', 'ticker', p_ticker, 'realized_gain_loss', v_gain),
    v_caller_id);

  IF v_shares_to_sell >= v_position.shares THEN
    DELETE FROM stock_positions
    WHERE stock_positions.kid_id = p_kid_id AND stock_positions.ticker = p_ticker;
  ELSE
    UPDATE stock_positions
    SET shares = stock_positions.shares - v_shares_to_sell,
        cost_basis = stock_positions.cost_basis - v_cost_of_sold
    WHERE stock_positions.kid_id = p_kid_id AND stock_positions.ticker = p_ticker;
  END IF;

  RETURN QUERY
  SELECT v_shares_to_sell AS shares_sold, v_gain AS realized_gain_loss,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS new_cash_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
