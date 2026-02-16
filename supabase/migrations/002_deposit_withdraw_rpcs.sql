-- T4: Deposit and Withdraw RPCs
-- deposit_to_cash: adds money to a kid's cash balance
-- withdraw_from_cash: removes money (with balance check + advisory lock)

-- ============================================================
-- deposit_to_cash
-- ============================================================
-- No advisory lock needed: deposits are additive, cannot overdraft.

CREATE OR REPLACE FUNCTION deposit_to_cash(
  p_kid_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL,
  p_source text DEFAULT NULL
)
RETURNS TABLE (new_balance numeric) AS $$
DECLARE
  v_caller_id uuid := auth.uid();
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
      USING DETAIL = format('received: %s', p_amount),
            ERRCODE = 'P0001';
  END IF;

  -- Validate note length
  IF p_note IS NOT NULL AND LENGTH(p_note) > 500 THEN
    RAISE EXCEPTION 'Note too long: max 500 characters'
      USING ERRCODE = 'P0001';
  END IF;

  -- Insert deposit transaction
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (
    p_kid_id,
    'deposit',
    'cash',
    p_amount,
    p_note,
    CASE WHEN p_source IS NOT NULL
      THEN jsonb_build_object('source', p_source)
      ELSE NULL
    END,
    v_caller_id
  );

  -- Return updated cash balance
  RETURN QUERY
  SELECT COALESCE(SUM(t.amount), 0.00)::numeric AS new_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'cash';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- ============================================================
-- withdraw_from_cash
-- ============================================================

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
      USING DETAIL = format('received: %s', p_amount),
            ERRCODE = 'P0001';
  END IF;

  -- Validate note length
  IF p_note IS NOT NULL AND LENGTH(p_note) > 500 THEN
    RAISE EXCEPTION 'Note too long: max 500 characters'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock: serialize per-kid operations
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Check balance
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'cash';

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient cash: have %, need %', v_balance, p_amount
      USING DETAIL = format('available: %s, requested: %s', v_balance, p_amount),
            HINT = 'Check balance before transacting',
            ERRCODE = 'P0001';
  END IF;

  -- Insert withdrawal transaction (negative amount)
  INSERT INTO transactions (kid_id, type, bucket, amount, note, created_by)
  VALUES (
    p_kid_id,
    'withdraw',
    'cash',
    -p_amount,
    p_note,
    v_caller_id
  );

  -- Return updated cash balance
  RETURN QUERY
  SELECT COALESCE(SUM(t.amount), 0.00)::numeric AS new_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'cash';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
