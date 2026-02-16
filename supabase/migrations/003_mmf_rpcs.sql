-- T5: MMF Interest Accrual RPCs
-- invest_in_mmf: moves cash → MMF (atomic dual transaction)
-- redeem_from_mmf: moves MMF → cash (atomic dual transaction)
-- accrue_mmf_interest: credits daily interest since last accrual

-- ============================================================
-- invest_in_mmf
-- ============================================================

CREATE OR REPLACE FUNCTION invest_in_mmf(
  p_kid_id uuid,
  p_amount numeric
)
RETURNS TABLE (cash_balance numeric, mmf_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_cash numeric;
BEGIN
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate kid exists
  IF NOT EXISTS (
    SELECT 1 FROM kids k WHERE k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Kid not found: %', p_kid_id
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
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_cash
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'cash';

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

-- ============================================================
-- redeem_from_mmf
-- ============================================================

CREATE OR REPLACE FUNCTION redeem_from_mmf(
  p_kid_id uuid,
  p_amount numeric
)
RETURNS TABLE (cash_balance numeric, mmf_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_mmf numeric;
BEGIN
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate kid exists
  IF NOT EXISTS (
    SELECT 1 FROM kids k WHERE k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Kid not found: %', p_kid_id
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
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_mmf
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'mmf';

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

-- ============================================================
-- accrue_mmf_interest
-- ============================================================

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
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate kid exists
  IF NOT EXISTS (
    SELECT 1 FROM kids k WHERE k.id = p_kid_id
  ) THEN
    RAISE EXCEPTION 'Kid not found: %', p_kid_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get current MMF balance
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_mmf_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'mmf';

  -- If no MMF balance, nothing to accrue
  IF v_mmf_balance <= 0 THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  -- Get current APY from settings
  SELECT s.value::numeric
  INTO v_apy
  FROM settings s
  WHERE s.key = 'mmf_apy';

  IF v_apy IS NULL THEN
    RAISE EXCEPTION 'Setting mmf_apy not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Find last accrual date: most recent interest transaction for this kid's MMF
  SELECT utc_date(t.created_at)
  INTO v_last_accrual_date
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.type = 'interest'
    AND t.bucket = 'mmf'
  ORDER BY t.created_at DESC
  LIMIT 1;

  -- If no prior accrual, use date of first MMF invest transaction
  IF v_last_accrual_date IS NULL THEN
    SELECT utc_date(t.created_at)
    INTO v_last_accrual_date
    FROM transactions t
    WHERE t.kid_id = p_kid_id
      AND t.type = 'invest'
      AND t.bucket = 'mmf'
    ORDER BY t.created_at ASC
    LIMIT 1;
  END IF;

  -- If still NULL, nothing to accrue (shouldn't happen if balance > 0)
  IF v_last_accrual_date IS NULL THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  -- Calculate days since last accrual
  v_days := CURRENT_DATE - v_last_accrual_date;

  -- If 0 days, nothing to accrue (prevent double-credit)
  IF v_days <= 0 THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  -- Calculate interest: balance * (apy / 365) * days
  v_interest := ROUND(v_mmf_balance * (v_apy / 365.0) * v_days, 2);

  -- Skip if interest rounds to $0.00 (prevents ledger pollution)
  IF v_interest <= 0 THEN
    RETURN QUERY SELECT 0.00::numeric AS interest_credited, v_mmf_balance AS new_mmf_balance;
    RETURN;
  END IF;

  -- Credit interest
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (
    p_kid_id,
    'interest',
    'mmf',
    v_interest,
    jsonb_build_object(
      'days_accrued', v_days,
      'apy_at_accrual', v_apy,
      'balance_at_accrual', v_mmf_balance
    ),
    v_caller_id
  );

  -- Return results
  RETURN QUERY
  SELECT
    v_interest AS interest_credited,
    (v_mmf_balance + v_interest) AS new_mmf_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
