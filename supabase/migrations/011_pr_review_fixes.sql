-- Migration 011: PR review fixes from PR #11 code review
--
-- P2-3: Change households RLS from FOR ALL to FOR SELECT (read-only intent)
-- P2-5: Add missing advisory lock to deposit_to_cash

-- ============================================================
-- SECTION 1: Restrict households RLS to read-only
-- ============================================================

DROP POLICY IF EXISTS "members_only" ON households;
CREATE POLICY "members_only" ON households
  FOR SELECT TO authenticated
  USING (
    id = (
      SELECT au.household_id FROM admin_users au
      WHERE au.user_id = (SELECT auth.uid())
    )
  );


-- ============================================================
-- SECTION 2: Add advisory lock to deposit_to_cash
-- ============================================================

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

  -- Advisory lock (was missing — all other balance-modifying RPCs have this)
  PERFORM pg_advisory_xact_lock(hashtext(p_kid_id::text));

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
