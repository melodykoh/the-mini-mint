-- Fix: deposit_to_cash only stored {"source": "..."} in metadata.
-- Hanzi Dojo flow needs to also store points_total.
-- Solution: add p_metadata JSONB param, merge with source.

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

  -- Build metadata: merge source + caller-supplied metadata
  v_final_metadata := COALESCE(p_metadata, '{}'::jsonb);
  IF p_source IS NOT NULL THEN
    v_final_metadata := v_final_metadata || jsonb_build_object('source', p_source);
  END IF;
  -- Store NULL if empty
  IF v_final_metadata = '{}'::jsonb THEN
    v_final_metadata := NULL;
  END IF;

  -- Insert deposit transaction
  INSERT INTO transactions (kid_id, type, bucket, amount, note, metadata, created_by)
  VALUES (
    p_kid_id,
    'deposit',
    'cash',
    p_amount,
    p_note,
    v_final_metadata,
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
