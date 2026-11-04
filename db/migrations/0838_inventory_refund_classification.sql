-- Server-controlled repair refunds are inventory sources.  Keep refund
-- sources ahead of the repair sink matcher so positive material returns do
-- not violate the economy event leg invariant.

CREATE OR REPLACE FUNCTION economy_classify_inventory_source(source_value text)
RETURNS text AS $$
DECLARE source_key text := lower(coalesce(source_value, ''));
BEGIN
  IF source_key ~ '(craft|process|smelt|cook|furnace|tannery|butcher|loom|repair_kit|transform)' THEN
    RETURN 'TRANSFORM';
  ELSIF source_key ~ '(development|dev_|admin|moderation|migration)' THEN
    RETURN 'ADMIN';
  ELSIF source_key ~ '(harvest|reward|starter|spawn|production|grant|overture|replenish|combat|refund)' THEN
    RETURN 'SOURCE';
  ELSIF source_key ~ '(consume|hunger|construction|build|repair|burn|destroy|spend|fee|tax|demolition)' THEN
    RETURN 'SINK';
  END IF;
  RETURN 'UNKNOWN';
END;
$$ LANGUAGE plpgsql IMMUTABLE;
