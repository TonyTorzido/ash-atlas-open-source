-- Player gifting reuses the admin player-package system: one gift is one
-- player_gift campaign with exactly one package. The campaign, package and
-- item rows are the gift history (sender, recipient, contents, timestamps).

ALTER TABLE player_package_campaigns
  ADD COLUMN kind text NOT NULL DEFAULT 'admin'
    CONSTRAINT player_package_campaigns_kind_check
    CHECK (kind IN ('admin', 'player_gift'));

-- Rolling 24 h sent-per-day and per-pair limits count these rows.
CREATE INDEX player_package_campaigns_gift_sender_idx
  ON player_package_campaigns (created_by_player_id, created_at DESC)
  WHERE kind = 'player_gift';
-- The held-gift count (recipient, status <> 'claimed') uses the existing
-- player_packages_recipient_unclaimed_idx partial index from 0689.

-- Gold and City Coins can never be gifted, whatever the server code says.
CREATE FUNCTION reject_player_gift_currency_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_kind IN ('gold', 'city_coins') AND EXISTS (
    SELECT 1
    FROM player_packages package
    JOIN player_package_campaigns campaign ON campaign.id = package.campaign_id
    WHERE package.id = NEW.package_id AND campaign.kind = 'player_gift'
  ) THEN
    RAISE EXCEPTION 'Player gifts cannot contain currency'
      USING ERRCODE = '23514', CONSTRAINT = 'player_gift_no_currency';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER player_package_items_gift_no_currency
BEFORE INSERT OR UPDATE OF item_kind, package_id ON player_package_items
FOR EACH ROW EXECUTE FUNCTION reject_player_gift_currency_line();
