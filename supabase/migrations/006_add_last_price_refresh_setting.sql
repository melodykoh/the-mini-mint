-- Add 'last_price_refresh' to settings validation trigger
-- This key stores the ISO timestamp of the last stock price refresh

CREATE OR REPLACE FUNCTION validate_setting() RETURNS TRIGGER AS $$
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
    WHEN 'last_price_refresh' THEN
      -- ISO timestamp string, validated by successful cast
      PERFORM NEW.value::timestamptz;
    ELSE
      RAISE EXCEPTION 'Unknown settings key: %', NEW.key;
  END CASE;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
