-- T6: CD Lot Management RPCs
-- create_cd: locks cash into a CD lot
-- mature_cd: processes matured CD (returns principal + interest to cash)
-- break_cd: early withdrawal with penalty

-- ============================================================
-- create_cd
-- ============================================================

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

  -- Validate term
  IF p_term_months NOT IN (3, 6, 12) THEN
    RAISE EXCEPTION 'Invalid term: must be 3, 6, or 12 months'
      USING DETAIL = format('received: %s', p_term_months),
            ERRCODE = 'P0001';
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
            ERRCODE = 'P0001';
  END IF;

  -- Get APY for this term from settings
  v_setting_key := 'cd_' || p_term_months || 'm_apy';
  SELECT s.value::numeric
  INTO v_apy
  FROM settings s
  WHERE s.key = v_setting_key;

  IF v_apy IS NULL THEN
    RAISE EXCEPTION 'Setting % not found', v_setting_key
      USING ERRCODE = 'P0001';
  END IF;

  -- Calculate maturity date
  v_maturity := (CURRENT_DATE + (p_term_months || ' months')::interval)::date;

  -- Deduct cash
  INSERT INTO transactions (kid_id, type, bucket, amount, created_by)
  VALUES (p_kid_id, 'invest', 'cash', -p_amount, v_caller_id);

  -- Create CD lot
  INSERT INTO cd_lots (kid_id, principal, apy, term_months, start_date, maturity_date, status)
  VALUES (p_kid_id, p_amount, v_apy, p_term_months, CURRENT_DATE, v_maturity, 'active')
  RETURNING cd_lots.id INTO v_lot_id;

  -- Return CD lot info
  RETURN QUERY
  SELECT v_lot_id AS cd_lot_id, v_maturity AS maturity_date, v_apy AS apy;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- ============================================================
-- mature_cd
-- ============================================================

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
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  -- Fetch CD lot
  SELECT cl.* INTO v_lot
  FROM cd_lots cl
  WHERE cl.id = p_cd_lot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CD lot not found: %', p_cd_lot_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_lot.status != 'active' THEN
    RAISE EXCEPTION 'CD lot is not active (status: %)', v_lot.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_lot.maturity_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'CD not yet matured: matures on %', v_lot.maturity_date
      USING DETAIL = format('maturity_date: %s, today: %s', v_lot.maturity_date, CURRENT_DATE),
            HINT = 'Wait until maturity date or use break_cd for early withdrawal',
            ERRCODE = 'P0001';
  END IF;

  -- Advisory lock on the kid
  PERFORM pg_advisory_xact_lock(hashtext(v_lot.kid_id::text));

  -- Calculate interest: principal * apy * (days / 365)
  v_days := v_lot.maturity_date - v_lot.start_date;
  v_interest := ROUND(v_lot.principal * v_lot.apy * v_days / 365.0, 2);
  v_total := v_lot.principal + v_interest;

  -- Update CD lot status
  UPDATE cd_lots
  SET status = 'matured'
  WHERE id = p_cd_lot_id;

  -- Return principal + interest to cash
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (
    v_lot.kid_id,
    'redeem',
    'cash',
    v_total,
    format('%s-month CD matured', v_lot.term_months),
    jsonb_build_object(
      'cd_lot_id', p_cd_lot_id,
      'principal', v_lot.principal,
      'interest', v_interest,
      'apy', v_lot.apy,
      'days_held', v_days
    ),
    v_caller_id
  );

  RETURN QUERY
  SELECT v_lot.principal AS principal_returned, v_interest AS interest_earned, v_total AS total_returned;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- ============================================================
-- break_cd
-- ============================================================

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
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  -- Fetch CD lot
  SELECT cl.* INTO v_lot
  FROM cd_lots cl
  WHERE cl.id = p_cd_lot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CD lot not found: %', p_cd_lot_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_lot.status != 'active' THEN
    RAISE EXCEPTION 'CD lot is not active (status: %)', v_lot.status
      USING ERRCODE = 'P0001';
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
  UPDATE cd_lots
  SET status = 'broken'
  WHERE id = p_cd_lot_id;

  -- Return net amount to cash
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (
    v_lot.kid_id,
    'redeem',
    'cash',
    v_net,
    format('%s-month CD broken early (day %s of %s)',
      v_lot.term_months, v_days, (v_lot.maturity_date - v_lot.start_date)),
    jsonb_build_object(
      'cd_lot_id', p_cd_lot_id,
      'principal', v_lot.principal,
      'interest_earned', v_interest,
      'penalty', v_penalty,
      'penalty_days', v_penalty_days,
      'net_returned', v_net,
      'days_held', v_days,
      'apy', v_lot.apy
    ),
    v_caller_id
  );

  RETURN QUERY
  SELECT v_lot.principal AS principal_returned, v_interest AS interest_earned, v_penalty AS penalty, v_net AS net_returned;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
