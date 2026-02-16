-- T14: Spend RPCs
-- spend_from_mmf: atomically redeems from MMF → cash → withdraw
-- spend_from_stock: atomically sells shares → cash → withdraw
-- Net effect: source bucket decreases, cash unchanged

-- ============================================================
-- spend_from_mmf
-- ============================================================

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
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM kids k WHERE k.id = p_kid_id) THEN
    RAISE EXCEPTION 'Kid not found' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Check MMF balance
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_mmf
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf';

  IF v_mmf < p_amount THEN
    RAISE EXCEPTION 'Insufficient MMF balance: have %, need %', v_mmf, p_amount
      USING ERRCODE = 'P0001';
  END IF;

  -- Step 1: Redeem from MMF (negative MMF)
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'redeem', 'mmf', -p_amount, p_note,
    jsonb_build_object('reason', 'spend'), v_caller_id);

  -- Step 2: Redeem to cash (positive cash)
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'redeem', 'cash', p_amount, p_note,
    jsonb_build_object('reason', 'spend', 'funded_from', 'mmf'), v_caller_id);

  -- Step 3: Withdraw from cash (negative cash — money leaves)
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'withdraw', 'cash', -p_amount, p_note,
    jsonb_build_object('funded_from', 'mmf'), v_caller_id);

  -- Return updated MMF balance
  RETURN QUERY
  SELECT COALESCE(SUM(t.amount), 0.00)::numeric AS new_mmf_balance
  FROM transactions t
  WHERE t.kid_id = p_kid_id AND t.bucket = 'mmf';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- ============================================================
-- spend_from_stock
-- ============================================================

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
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM admin_users au WHERE au.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM kids k WHERE k.id = p_kid_id) THEN
    RAISE EXCEPTION 'Kid not found' USING ERRCODE = 'P0001';
  END IF;

  IF p_ticker !~ '^[A-Z]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid ticker' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount <= 0 OR p_amount > 100000 OR p_amount != ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get latest price
  SELECT sp.close_price INTO v_price
  FROM stock_prices sp
  WHERE sp.ticker = p_ticker
  ORDER BY sp.date DESC LIMIT 1;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'No price data for %', p_ticker USING ERRCODE = 'P0001';
  END IF;

  -- Get position
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

  -- Calculate gain/loss
  v_avg_cost := v_position.cost_basis / v_position.shares;
  v_cost_of_sold := ROUND(v_avg_cost * v_shares_to_sell, 2);
  v_gain := ROUND(p_amount - v_cost_of_sold, 2);

  -- Step 1: Sell stock (negative stock bucket)
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'sell', 'stock', -p_amount,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares_to_sell,
      'price_per_share', v_price, 'realized_gain_loss', v_gain, 'reason', 'spend'),
    v_caller_id);

  -- Step 2: Sell proceeds to cash (positive cash)
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (p_kid_id, 'sell', 'cash', p_amount,
    jsonb_build_object('ticker', p_ticker, 'reason', 'spend'),
    v_caller_id);

  -- Step 3: Withdraw from cash (money leaves)
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (p_kid_id, 'withdraw', 'cash', -p_amount, p_note,
    jsonb_build_object('funded_from', 'stock', 'ticker', p_ticker, 'realized_gain_loss', v_gain),
    v_caller_id);

  -- Update stock position
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
  SELECT
    v_shares_to_sell AS shares_sold,
    v_gain AS realized_gain_loss,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS new_cash_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
