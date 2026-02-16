-- Family Capital Ledger: Initial Schema
-- Applied to shared Supabase project (also hosts Lego App: creations, photos tables)
-- DO NOT modify Lego App tables.
--
-- Tables: admin_users, kids, transactions, cd_lots, stock_positions, stock_prices, settings
-- ENUMs: transaction_type, transaction_bucket, cd_status

-- ============================================================
-- 0. CLEANUP (safe to re-run if previous attempt partially succeeded)
-- ============================================================

DROP TYPE IF EXISTS transaction_type CASCADE;
DROP TYPE IF EXISTS transaction_bucket CASCADE;
DROP TYPE IF EXISTS cd_status CASCADE;
DROP FUNCTION IF EXISTS utc_date(timestamptz);

-- ============================================================
-- 1. ENUM TYPES
-- ============================================================

CREATE TYPE transaction_type AS ENUM (
  'deposit', 'withdraw', 'invest', 'redeem', 'interest', 'dividend', 'buy', 'sell'
);

CREATE TYPE transaction_bucket AS ENUM ('cash', 'mmf', 'cd', 'stock');

CREATE TYPE cd_status AS ENUM ('active', 'matured', 'broken');

-- ============================================================
-- 2. TABLES
-- ============================================================

-- Admin users: references Supabase auth.users
CREATE TABLE admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Kids: the children whose money we're tracking
CREATE TABLE kids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Transactions: append-only financial ledger (the core of the system)
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE RESTRICT,
  type transaction_type NOT NULL,
  bucket transaction_bucket NOT NULL,
  amount numeric(12,2) NOT NULL,
  note text,
  metadata jsonb,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Amount validation: max $100,000, exactly 2 decimal places
  CONSTRAINT chk_amount_range CHECK (ABS(amount) <= 100000),
  CONSTRAINT chk_amount_precision CHECK (amount = ROUND(amount, 2)),

  -- Note length limit
  CONSTRAINT chk_note_length CHECK (note IS NULL OR LENGTH(note) <= 500),

  -- Valid type+bucket combinations
  CONSTRAINT chk_valid_type_bucket CHECK (
    (type = 'deposit'  AND bucket = 'cash') OR
    (type = 'withdraw' AND bucket = 'cash') OR
    (type = 'invest'   AND bucket IN ('cash', 'mmf')) OR
    (type = 'redeem'   AND bucket IN ('cash', 'mmf', 'cd')) OR
    (type = 'interest' AND bucket = 'mmf') OR
    (type = 'dividend' AND bucket = 'cash') OR
    (type = 'buy'      AND bucket IN ('cash', 'stock')) OR
    (type = 'sell'     AND bucket IN ('cash', 'stock'))
  )
);

-- CD lots: individual certificate of deposit holdings
CREATE TABLE cd_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE RESTRICT,
  principal numeric(12,2) NOT NULL,
  apy numeric(6,4) NOT NULL,
  term_months integer NOT NULL,
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  maturity_date date NOT NULL,
  status cd_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_principal_positive CHECK (principal > 0 AND principal <= 100000),
  CONSTRAINT chk_apy_range CHECK (apy >= 0 AND apy <= 0.20),
  CONSTRAINT chk_term_valid CHECK (term_months IN (3, 6, 12))
);

-- Stock positions: one row per kid per ticker (upserted on buy)
CREATE TABLE stock_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE RESTRICT,
  ticker text NOT NULL,
  shares numeric(16,8) NOT NULL DEFAULT 0,
  cost_basis numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One position per kid per ticker
  CONSTRAINT uq_kid_ticker UNIQUE (kid_id, ticker),

  -- Ticker format: 1-10 uppercase letters
  CONSTRAINT chk_ticker_format CHECK (ticker ~ '^[A-Z]{1,10}$'),
  CONSTRAINT chk_shares_non_negative CHECK (shares >= 0),
  CONSTRAINT chk_cost_basis_non_negative CHECK (cost_basis >= 0)
);

-- Stock prices: historical daily close prices
CREATE TABLE stock_prices (
  ticker text NOT NULL,
  date date NOT NULL,
  close_price numeric(12,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (ticker, date),

  CONSTRAINT chk_ticker_format CHECK (ticker ~ '^[A-Z]{1,10}$'),
  CONSTRAINT chk_price_positive CHECK (close_price > 0)
);

-- Settings: key-value configuration (rates, limits)
CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 3. INDEXES
-- ============================================================

-- Balance computation (most frequent query pattern)
CREATE INDEX idx_transactions_kid_bucket
  ON transactions (kid_id, bucket);

-- Interest accrual lookups (find last accrual date)
CREATE INDEX idx_transactions_kid_type_bucket_created
  ON transactions (kid_id, type, bucket, created_at DESC);

-- Immutable date extractor for index use (pins to UTC)
CREATE FUNCTION utc_date(ts timestamptz) RETURNS date AS $$
  SELECT (ts AT TIME ZONE 'UTC')::date;
$$ LANGUAGE sql IMMUTABLE;

-- Prevent double interest credit on same day
CREATE UNIQUE INDEX uq_interest_per_kid_per_day
  ON transactions (kid_id, type, bucket, utc_date(created_at))
  WHERE type = 'interest';

-- CD lot lookups by kid and status
CREATE INDEX idx_cd_lots_kid_status
  ON cd_lots (kid_id, status);

-- Stock price lookups (latest price per ticker)
CREATE INDEX idx_stock_prices_ticker_date
  ON stock_prices (ticker, date DESC);

-- ============================================================
-- 4. APPEND-ONLY ENFORCEMENT ON TRANSACTIONS
-- ============================================================

CREATE FUNCTION prevent_txn_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'transactions table is append-only: % not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_txn_mutation();

-- ============================================================
-- 5. SETTINGS VALIDATION TRIGGER
-- ============================================================

CREATE FUNCTION validate_setting() RETURNS TRIGGER AS $$
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

-- ============================================================
-- 6. STOCK POSITIONS updated_at TRIGGER
-- ============================================================

CREATE FUNCTION update_stock_position_timestamp() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_position_updated
  BEFORE UPDATE ON stock_positions
  FOR EACH ROW EXECUTE FUNCTION update_stock_position_timestamp();

-- ============================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================

-- Enable RLS on all FCL tables
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE kids ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cd_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Admin-only policy pattern:
-- Uses (SELECT auth.uid()) for caching — prevents re-evaluation per row.

CREATE POLICY "admin_only" ON admin_users
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

CREATE POLICY "admin_only" ON kids
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

CREATE POLICY "admin_only" ON transactions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

CREATE POLICY "admin_only" ON cd_lots
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

CREATE POLICY "admin_only" ON stock_positions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

CREATE POLICY "admin_only" ON stock_prices
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

CREATE POLICY "admin_only" ON settings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users au WHERE au.user_id = (SELECT auth.uid())));

-- ============================================================
-- 8. SEED DATA
-- ============================================================

-- Admin users (Melody + husband)
INSERT INTO admin_users (user_id) VALUES
  ('060b3bac-15e5-462e-9ed1-406b5a8fcc62'),
  ('c5363614-5af4-4603-be5f-cc0e2b99ca44');

-- Kids
INSERT INTO kids (name) VALUES ('Aiden'), ('Skylar');

-- Default settings (rates, limits)
INSERT INTO settings (key, value) VALUES
  ('mmf_apy', '0.042'),
  ('cd_3m_apy', '0.048'),
  ('cd_6m_apy', '0.050'),
  ('cd_12m_apy', '0.052'),
  ('stock_position_limit', '5'),
  ('hanzi_dojo_conversion_rate', '0.10');
