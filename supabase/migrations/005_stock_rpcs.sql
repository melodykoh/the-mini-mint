-- T7: Stock Position RPCs
-- buy_stock: purchases virtual shares at current price
-- sell_stock: sells virtual shares (0 = sell all)

-- ============================================================
-- buy_stock
-- ============================================================

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

  -- Validate ticker format
  IF p_ticker !~ '^[A-Z]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid ticker format: must be 1-10 uppercase letters'
      USING DETAIL = format('received: %s', p_ticker),
            ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_dollar_amount <= 0 OR p_dollar_amount > 100000 OR p_dollar_amount != ROUND(p_dollar_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must be positive, <= $100,000, and exactly 2 decimal places'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get latest price for this ticker
  SELECT sp.close_price
  INTO v_price
  FROM stock_prices sp
  WHERE sp.ticker = p_ticker
  ORDER BY sp.date DESC
  LIMIT 1;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'No price data for ticker %: add price data first', p_ticker
      USING HINT = 'Use the stock price refresh to fetch prices before buying',
            ERRCODE = 'P0001';
  END IF;

  -- Check position limit (only for new tickers)
  SELECT EXISTS (
    SELECT 1 FROM stock_positions spos
    WHERE spos.kid_id = p_kid_id AND spos.ticker = p_ticker
  ) INTO v_has_position;

  IF NOT v_has_position THEN
    SELECT COUNT(*)
    INTO v_position_count
    FROM stock_positions spos
    WHERE spos.kid_id = p_kid_id AND spos.shares > 0;

    SELECT s.value::integer
    INTO v_position_limit
    FROM settings s
    WHERE s.key = 'stock_position_limit';

    IF v_position_limit IS NULL THEN
      v_position_limit := 5; -- default
    END IF;

    IF v_position_count >= v_position_limit THEN
      RAISE EXCEPTION 'Position limit reached: max % different stocks allowed', v_position_limit
        USING DETAIL = format('current positions: %s, limit: %s', v_position_count, v_position_limit),
              HINT = 'Sell an existing position before buying a new ticker',
              ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Check cash balance
  SELECT COALESCE(SUM(t.amount), 0.00)
  INTO v_cash
  FROM transactions t
  WHERE t.kid_id = p_kid_id
    AND t.bucket = 'cash';

  IF v_cash < p_dollar_amount THEN
    RAISE EXCEPTION 'Insufficient cash: have %, need %', v_cash, p_dollar_amount
      USING DETAIL = format('available: %s, requested: %s', v_cash, p_dollar_amount),
            ERRCODE = 'P0001';
  END IF;

  -- Calculate shares
  v_shares := ROUND(p_dollar_amount / v_price, 8);

  -- Deduct cash
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (
    p_kid_id,
    'buy',
    'cash',
    -p_dollar_amount,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares, 'price_per_share', v_price),
    v_caller_id
  );

  -- Record stock transaction
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (
    p_kid_id,
    'buy',
    'stock',
    p_dollar_amount,
    jsonb_build_object('ticker', p_ticker, 'shares', v_shares, 'price_per_share', v_price),
    v_caller_id
  );

  -- Upsert stock position
  INSERT INTO stock_positions (kid_id, ticker, shares, cost_basis)
  VALUES (p_kid_id, p_ticker, v_shares, p_dollar_amount)
  ON CONFLICT (kid_id, ticker) DO UPDATE
  SET shares = stock_positions.shares + v_shares,
      cost_basis = stock_positions.cost_basis + p_dollar_amount;

  -- Return results
  RETURN QUERY
  SELECT
    v_shares AS shares_bought,
    v_price AS price_per_share,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS new_cash_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- ============================================================
-- sell_stock
-- ============================================================

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

  -- Validate ticker format
  IF p_ticker !~ '^[A-Z]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid ticker format: must be 1-10 uppercase letters'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount (0 is allowed = sell all)
  IF p_dollar_amount < 0 OR p_dollar_amount > 100000 THEN
    RAISE EXCEPTION 'Invalid amount: must be >= 0 and <= $100,000'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_dollar_amount > 0 AND p_dollar_amount != ROUND(p_dollar_amount, 2) THEN
    RAISE EXCEPTION 'Invalid amount: must have exactly 2 decimal places'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

  -- Get latest price
  SELECT sp.close_price
  INTO v_price
  FROM stock_prices sp
  WHERE sp.ticker = p_ticker
  ORDER BY sp.date DESC
  LIMIT 1;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'No price data for ticker %', p_ticker
      USING ERRCODE = 'P0001';
  END IF;

  -- Get current position
  SELECT spos.* INTO v_position
  FROM stock_positions spos
  WHERE spos.kid_id = p_kid_id AND spos.ticker = p_ticker;

  IF NOT FOUND OR v_position.shares <= 0 THEN
    RAISE EXCEPTION 'No shares of % to sell', p_ticker
      USING ERRCODE = 'P0001';
  END IF;

  -- Determine shares to sell
  IF p_dollar_amount = 0 THEN
    -- Sell all
    v_shares_to_sell := v_position.shares;
    v_actual_proceeds := ROUND(v_shares_to_sell * v_price, 2);
  ELSE
    v_shares_to_sell := ROUND(p_dollar_amount / v_price, 8);
    v_actual_proceeds := p_dollar_amount;

    IF v_shares_to_sell > v_position.shares THEN
      RAISE EXCEPTION 'Insufficient shares of %: have %, need %',
        p_ticker, v_position.shares, v_shares_to_sell
        USING DETAIL = format('current value: %s, requested: %s',
          ROUND(v_position.shares * v_price, 2), p_dollar_amount),
              ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Calculate realized gain/loss (average cost basis method)
  v_avg_cost_per_share := v_position.cost_basis / v_position.shares;
  v_cost_of_sold := ROUND(v_avg_cost_per_share * v_shares_to_sell, 2);
  v_gain := ROUND(v_actual_proceeds - v_cost_of_sold, 2);

  -- Record cash receipt
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (
    p_kid_id,
    'sell',
    'cash',
    v_actual_proceeds,
    jsonb_build_object(
      'ticker', p_ticker,
      'shares', v_shares_to_sell,
      'price_per_share', v_price,
      'realized_gain_loss', v_gain
    ),
    v_caller_id
  );

  -- Record stock sale
  INSERT INTO transactions (kid_id, type, bucket, amount, metadata, created_by)
  VALUES (
    p_kid_id,
    'sell',
    'stock',
    -v_actual_proceeds,
    jsonb_build_object(
      'ticker', p_ticker,
      'shares', v_shares_to_sell,
      'price_per_share', v_price,
      'realized_gain_loss', v_gain
    ),
    v_caller_id
  );

  -- Update or delete position
  IF v_shares_to_sell >= v_position.shares THEN
    -- Sold all shares — delete position
    DELETE FROM stock_positions
    WHERE stock_positions.kid_id = p_kid_id AND stock_positions.ticker = p_ticker;
  ELSE
    -- Reduce position proportionally
    UPDATE stock_positions
    SET shares = stock_positions.shares - v_shares_to_sell,
        cost_basis = stock_positions.cost_basis - v_cost_of_sold
    WHERE stock_positions.kid_id = p_kid_id AND stock_positions.ticker = p_ticker;
  END IF;

  -- Return results
  RETURN QUERY
  SELECT
    v_shares_to_sell AS shares_sold,
    v_price AS price_per_share,
    v_actual_proceeds AS proceeds,
    v_gain AS realized_gain_loss,
    (SELECT COALESCE(SUM(t.amount), 0.00) FROM transactions t
     WHERE t.kid_id = p_kid_id AND t.bucket = 'cash')::numeric AS new_cash_balance;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
