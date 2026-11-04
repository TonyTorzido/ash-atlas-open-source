-- City Districts, Monuments, city-owned Gold, and isolated physical City Markets.
-- This migration is forward-only and preserves all legacy city and exchange assets.

ALTER TABLE cities
  ADD COLUMN selected_district text NULL,
  ADD COLUMN district_revision bigint NOT NULL DEFAULT 0 CHECK (district_revision >= 0),
  ADD COLUMN district_selected_at timestamptz NULL,
  ADD COLUMN monument_ever_activated boolean NOT NULL DEFAULT false,
  ADD COLUMN latest_monument_destroyed_at timestamptz NULL,
  ADD COLUMN district_switch_available_at timestamptz NULL;

ALTER TABLE cities
  ADD CONSTRAINT cities_selected_district_valid CHECK (
    selected_district IS NULL
    OR selected_district IN ('mining', 'forestry', 'hunting', 'fashion')
  ),
  ADD CONSTRAINT cities_district_selection_shape CHECK (
    (selected_district IS NULL AND district_selected_at IS NULL)
    OR (selected_district IS NOT NULL AND district_selected_at IS NOT NULL)
  ),
  ADD CONSTRAINT cities_district_switch_shape CHECK (
    (latest_monument_destroyed_at IS NULL AND district_switch_available_at IS NULL)
    OR (
      latest_monument_destroyed_at IS NOT NULL
      AND district_switch_available_at =
        latest_monument_destroyed_at + interval '7 days'
    )
  );

ALTER TABLE city_structures
  ADD COLUMN district_type text NULL;

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'warehouse', 'market', 'monument',
      'weaponsmith', 'armory'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (
      structure_type IN ('city_house', 'mayor_house')
      AND owner_player_id IS NOT NULL
    )
    OR (
      structure_type IN (
        'warehouse', 'market', 'monument', 'weaponsmith', 'armory'
      )
      AND owner_player_id IS NULL
    )
  ),
  ADD CONSTRAINT city_structures_district_shape_check CHECK (
    (
      structure_type = 'monument'
      AND district_type IN ('mining', 'forestry', 'hunting', 'fashion')
    )
    OR (structure_type <> 'monument' AND district_type IS NULL)
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type = 'market' AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'monument')
  );

CREATE UNIQUE INDEX city_structures_one_reserved_market_idx
  ON city_structures (city_id)
  WHERE structure_type = 'market' AND state IN ('constructing', 'active');
CREATE UNIQUE INDEX city_structures_one_reserved_monument_idx
  ON city_structures (city_id)
  WHERE structure_type = 'monument' AND state IN ('constructing', 'active');

ALTER TABLE city_structure_operations
  DROP CONSTRAINT IF EXISTS city_structure_operations_action_check;
ALTER TABLE city_structure_operations
  ADD CONSTRAINT city_structure_operations_action_check CHECK (
    action IN (
      'build_house', 'destroy_house', 'build_facility', 'upgrade_facility',
      'destroy_facility', 'claim_mayor', 'relinquish_mayor',
      'expire_founder_grace', 'build_market', 'build_monument',
      'upgrade_monument', 'destroy_monument'
    )
  );

ALTER TABLE city_structure_events
  DROP CONSTRAINT IF EXISTS city_structure_events_event_type_check;
ALTER TABLE city_structure_events
  ADD CONSTRAINT city_structure_events_event_type_check CHECK (
    event_type IN (
      'built', 'activated', 'upgraded', 'destroyed',
      'promoted_to_mayor_house', 'demoted_to_city_house',
      'market_built', 'market_activated', 'monument_built',
      'monument_activated', 'monument_upgraded', 'monument_destroyed'
    )
  );

CREATE TABLE city_district_events (
  event_id bigserial PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  actor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  structure_id uuid NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  operation_key text NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN (
      'district_selected', 'monument_construction_started',
      'monument_activated', 'monument_upgraded', 'monument_destroyed',
      'district_changed'
    )
  ),
  prior_district text NULL CHECK (
    prior_district IS NULL
    OR prior_district IN ('mining', 'forestry', 'hunting', 'fashion')
  ),
  new_district text NULL CHECK (
    new_district IS NULL
    OR new_district IN ('mining', 'forestry', 'hunting', 'fashion')
  ),
  prior_tier smallint NULL CHECK (prior_tier BETWEEN 1 AND 3),
  new_tier smallint NULL CHECK (new_tier BETWEEN 1 AND 3),
  prior_district_revision bigint NOT NULL CHECK (prior_district_revision >= 0),
  district_revision bigint NOT NULL CHECK (district_revision > 0),
  prior_city_revision bigint NOT NULL CHECK (prior_city_revision >= 0),
  city_revision bigint NOT NULL CHECK (city_revision > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_key, event_type)
);
CREATE INDEX city_district_events_city_created_idx
  ON city_district_events (city_id, created_at DESC, event_id);

CREATE TABLE city_gold_reserves (
  city_id uuid PRIMARY KEY REFERENCES cities(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_donated bigint NOT NULL DEFAULT 0 CHECK (lifetime_donated >= 0),
  lifetime_spent bigint NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lifetime_donated >= balance + lifetime_spent)
);
INSERT INTO city_gold_reserves (city_id)
SELECT id FROM cities
ON CONFLICT (city_id) DO NOTHING;

CREATE TABLE city_gold_operations (
  operation_key text PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('donate', 'construction_spend')),
  intent jsonb NOT NULL CHECK (octet_length(intent::text) <= 8192),
  result jsonb NULL CHECK (
    result IS NULL OR octet_length(result::text) <= 262144
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (actor_player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE city_gold_ledger (
  entry_id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE
    REFERENCES city_gold_operations(operation_key) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (
    entry_type IN ('member_donation', 'construction_spend')
  ),
  delta bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX city_gold_ledger_city_created_idx
  ON city_gold_ledger (city_id, created_at DESC, entry_id);

CREATE TRIGGER city_district_events_immutable
BEFORE UPDATE OR DELETE ON city_district_events
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();
CREATE TRIGGER city_gold_ledger_immutable
BEFORE UPDATE OR DELETE ON city_gold_ledger
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

ALTER TABLE harvest_sessions
  ADD COLUMN city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  ADD COLUMN city_district_type text NULL,
  ADD COLUMN city_district_revision bigint NULL CHECK (city_district_revision >= 0),
  ADD COLUMN city_monument_tier smallint NULL CHECK (city_monument_tier BETWEEN 1 AND 3),
  ADD COLUMN city_bonus_chance double precision NOT NULL DEFAULT 0
    CHECK (city_bonus_chance BETWEEN 0 AND 1),
  ADD COLUMN city_bonus_succeeded boolean NOT NULL DEFAULT false;
ALTER TABLE harvest_sessions
  ADD CONSTRAINT harvest_sessions_city_bonus_shape CHECK (
    (
      city_id IS NULL
      AND city_district_type IS NULL
      AND city_district_revision IS NULL
      AND city_monument_tier IS NULL
      AND city_bonus_chance = 0
      AND NOT city_bonus_succeeded
    )
    OR (
      city_id IS NOT NULL
      AND city_district_type IN ('mining', 'forestry')
      AND city_district_revision IS NOT NULL
      AND city_monument_tier IS NOT NULL
    )
  );

ALTER TABLE repeatable_resource_sessions
  ADD COLUMN city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  ADD COLUMN city_district_type text NULL,
  ADD COLUMN city_district_revision bigint NULL CHECK (city_district_revision >= 0),
  ADD COLUMN city_monument_tier smallint NULL CHECK (city_monument_tier BETWEEN 1 AND 3),
  ADD COLUMN city_bonus_chance double precision NOT NULL DEFAULT 0
    CHECK (city_bonus_chance BETWEEN 0 AND 1),
  ADD COLUMN city_bonus_succeeded boolean NOT NULL DEFAULT false;
ALTER TABLE repeatable_resource_sessions
  ADD CONSTRAINT repeatable_resource_sessions_city_bonus_shape CHECK (
    (
      city_id IS NULL
      AND city_district_type IS NULL
      AND city_district_revision IS NULL
      AND city_monument_tier IS NULL
      AND city_bonus_chance = 0
      AND NOT city_bonus_succeeded
    )
    OR (
      city_id IS NOT NULL
      AND city_district_type = 'mining'
      AND city_district_revision IS NOT NULL
      AND city_monument_tier IS NOT NULL
    )
  );

ALTER TABLE balsam_resin_effects
  ADD COLUMN resin_consumed boolean NOT NULL DEFAULT true,
  ADD COLUMN hunting_district_preserved boolean NOT NULL DEFAULT false,
  ADD COLUMN city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  ADD COLUMN city_district_revision bigint NULL CHECK (city_district_revision >= 0),
  ADD COLUMN city_monument_tier smallint NULL CHECK (city_monument_tier BETWEEN 1 AND 3),
  ADD COLUMN preservation_chance double precision NOT NULL DEFAULT 0
    CHECK (preservation_chance BETWEEN 0 AND 1);
ALTER TABLE balsam_resin_effects
  ADD CONSTRAINT balsam_resin_effects_preservation_shape CHECK (
    hunting_district_preserved = NOT resin_consumed
    AND (
      (
        city_id IS NULL
        AND city_district_revision IS NULL
        AND city_monument_tier IS NULL
        AND preservation_chance = 0
        AND resin_consumed
      )
      OR (
        city_id IS NOT NULL
        AND city_district_revision IS NOT NULL
        AND city_monument_tier = 3
        AND preservation_chance = 0.12
      )
    )
  );

INSERT INTO market_fee_policies (
  fee_policy_id, version, listing_fee, buyer_fee_bps,
  seller_fee_bps, cancellation_fee, active
) VALUES
  (2, 2, 0, 900, 0, 0, true),
  (3, 3, 0, 450, 0, 0, true)
ON CONFLICT (fee_policy_id) DO NOTHING;

CREATE TABLE item_market_tax_tags (
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  tax_tag text NOT NULL CHECK (
    tax_tag IN ('mining', 'forestry', 'hunting', 'equipment', 'cosmetic')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, tax_tag)
);
INSERT INTO item_market_tax_tags (item_id, tax_tag) VALUES
  ('wood', 'forestry'),
  ('balsam_resin', 'forestry'),
  ('stone', 'mining'),
  ('ore', 'mining'),
  ('leather', 'hunting'),
  ('atlas_shrine_shard', 'hunting')
ON CONFLICT DO NOTHING;

UPDATE item_definitions
SET market_tradable = true,
    market_fungible = true,
    market_identity = item_id,
    updated_at = now()
WHERE item_id IN ('balsam_resin', 'leather', 'atlas_shrine_shard');

ALTER TABLE market_venues
  ADD COLUMN city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  ADD COLUMN market_structure_id uuid NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  ADD COLUMN tax_revision bigint NOT NULL DEFAULT 0 CHECK (tax_revision >= 0),
  ADD COLUMN state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'frozen', 'legacy_claims_only'));
ALTER TABLE market_venues
  ADD CONSTRAINT market_venues_city_shape CHECK (
    (
      scope_type = 'regional'
      AND city_id IS NOT NULL
      AND market_structure_id IS NOT NULL
    )
    OR (
      scope_type <> 'regional'
      AND city_id IS NULL
      AND market_structure_id IS NULL
    )
  ),
  ADD CONSTRAINT market_venues_city_unique UNIQUE (city_id),
  ADD CONSTRAINT market_venues_structure_unique UNIQUE (market_structure_id);

ALTER TABLE market_venue_controls
  ADD COLUMN new_orders_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN matching_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN cancellations_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN claims_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE market_collections
  ADD COLUMN venue_id uuid NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT;
UPDATE market_collections collection
SET venue_id = source.venue_id
FROM (
  SELECT collection_id, COALESCE(trade.venue_id, orders.venue_id) AS venue_id
  FROM market_collections candidate
  LEFT JOIN market_trades trade ON trade.trade_id = candidate.source_trade_id
  LEFT JOIN market_orders orders ON orders.order_id = candidate.source_order_id
) source
WHERE source.collection_id = collection.collection_id;
ALTER TABLE market_collections ALTER COLUMN venue_id SET NOT NULL;
CREATE INDEX market_collections_venue_player_open_idx
  ON market_collections (venue_id, player_id, asset_kind, collection_id)
  WHERE remaining_amount > 0;

ALTER TABLE market_claims
  ADD COLUMN venue_id uuid NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT;
UPDATE market_claims
SET venue_id = '00000000-0000-4000-8000-000000000600'
WHERE venue_id IS NULL;
ALTER TABLE market_claims ALTER COLUMN venue_id SET NOT NULL;

ALTER TABLE market_requests
  ADD COLUMN venue_id uuid NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT;
UPDATE market_requests
SET venue_id = '00000000-0000-4000-8000-000000000600'
WHERE venue_id IS NULL;
ALTER TABLE market_requests ALTER COLUMN venue_id SET NOT NULL;
ALTER TABLE market_requests
  DROP CONSTRAINT IF EXISTS market_requests_action_check;
ALTER TABLE market_requests
  ADD CONSTRAINT market_requests_action_check CHECK (
    action IN (
      'create_buy', 'create_sell', 'simple_buy', 'cancel_order',
      'claim_items', 'claim_gold', 'claim_all',
      'create_equipment_listing', 'purchase_equipment_listing',
      'cancel_equipment_listing', 'claim_equipment'
    )
  );

ALTER TABLE market_quotes
  ADD COLUMN gross_item_total bigint NOT NULL DEFAULT 0 CHECK (gross_item_total >= 0),
  ADD COLUMN buyer_tax bigint NOT NULL DEFAULT 0 CHECK (buyer_tax >= 0),
  ADD COLUMN buyer_total bigint NOT NULL DEFAULT 0 CHECK (buyer_total >= 0),
  ADD COLUMN applied_buyer_tax_bps integer NOT NULL DEFAULT 0
    CHECK (applied_buyer_tax_bps BETWEEN 0 AND 10000),
  ADD COLUMN district_type text NULL CHECK (
    district_type IS NULL
    OR district_type IN ('mining', 'forestry', 'hunting', 'fashion')
  ),
  ADD COLUMN tax_revision bigint NOT NULL DEFAULT 0 CHECK (tax_revision >= 0),
  ADD COLUMN specialty_tax_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN qualifying_tax_tag text NULL CHECK (
    qualifying_tax_tag IS NULL
    OR qualifying_tax_tag IN (
      'mining', 'forestry', 'hunting', 'equipment', 'cosmetic'
    )
  );
UPDATE market_quotes
SET gross_item_total = quoted_total,
    buyer_total = quoted_total;
ALTER TABLE market_quotes
  ADD CONSTRAINT market_quotes_tax_total_check CHECK (
    buyer_total = gross_item_total + buyer_tax
  );

ALTER TABLE market_trades
  ADD COLUMN applied_buyer_tax_bps integer NOT NULL DEFAULT 0
    CHECK (applied_buyer_tax_bps BETWEEN 0 AND 10000),
  ADD COLUMN district_type text NULL CHECK (
    district_type IS NULL
    OR district_type IN ('mining', 'forestry', 'hunting', 'fashion')
  ),
  ADD COLUMN tax_revision bigint NOT NULL DEFAULT 0 CHECK (tax_revision >= 0),
  ADD COLUMN specialty_tax_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN qualifying_tax_tag text NULL CHECK (
    qualifying_tax_tag IS NULL
    OR qualifying_tax_tag IN (
      'mining', 'forestry', 'hunting', 'equipment', 'cosmetic'
    )
  );

CREATE TABLE market_sessions (
  session_id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  connection_id text NOT NULL,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  market_structure_id uuid NOT NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  relocation_revision bigint NOT NULL CHECK (relocation_revision >= 0),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  invalidated_at timestamptz NULL,
  invalidated_reason text NULL,
  CHECK (
    (invalidated_at IS NULL AND invalidated_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidated_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX market_sessions_one_current_connection_idx
  ON market_sessions (connection_id)
  WHERE invalidated_at IS NULL;
CREATE INDEX market_sessions_player_current_idx
  ON market_sessions (player_id, opened_at DESC)
  WHERE invalidated_at IS NULL;

ALTER TABLE equipment_instances
  ADD COLUMN market_listing_id uuid NULL,
  ADD COLUMN market_collection_id uuid NULL;
ALTER TABLE equipment_instances
  DROP CONSTRAINT IF EXISTS equipment_instances_location_check,
  DROP CONSTRAINT IF EXISTS equipment_instances_location_fields_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_location_check CHECK (
    location IN (
      'inventory', 'equipped', 'manor_storage', 'market_escrow',
      'market_collection', 'destroyed'
    )
  ),
  ADD CONSTRAINT equipment_instances_location_fields_check CHECK (
    (
      location = 'equipped'
      AND equipped_slot IS NOT NULL
      AND inventory_slot_index IS NOT NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'inventory'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NOT NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'manor_storage'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NOT NULL AND manor_slot_index IS NOT NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'market_escrow'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NOT NULL AND market_collection_id IS NULL
    )
    OR (
      location = 'market_collection'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NOT NULL AND market_collection_id IS NOT NULL
    )
    OR (
      location = 'destroyed'
      AND equipped_slot IS NULL
      AND inventory_slot_index IS NULL
      AND manor_id IS NULL AND manor_slot_index IS NULL
      AND market_listing_id IS NULL AND market_collection_id IS NULL
    )
  );

CREATE TABLE market_equipment_listings (
  listing_id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  equipment_instance_id uuid NOT NULL
    REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  seller_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  buyer_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  asking_price bigint NOT NULL CHECK (asking_price > 0),
  status text NOT NULL CHECK (status IN ('open', 'sold', 'cancelled', 'claimed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  presentation_snapshot jsonb NOT NULL
    CHECK (octet_length(presentation_snapshot::text) <= 65536),
  tax_revision bigint NULL CHECK (tax_revision >= 0),
  buyer_tax bigint NULL CHECK (buyer_tax >= 0),
  applied_buyer_tax_bps integer NULL CHECK (
    applied_buyer_tax_bps BETWEEN 0 AND 10000
  ),
  specialty_tax_applied boolean NULL,
  qualifying_tax_tag text NULL CHECK (
    qualifying_tax_tag IS NULL
    OR qualifying_tax_tag IN ('equipment', 'cosmetic')
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sold_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  UNIQUE (listing_id, venue_id),
  CHECK (seller_player_id IS DISTINCT FROM buyer_player_id)
);
CREATE UNIQUE INDEX market_equipment_listings_one_open_instance_idx
  ON market_equipment_listings (equipment_instance_id)
  WHERE status = 'open';
CREATE INDEX market_equipment_listings_venue_open_idx
  ON market_equipment_listings (venue_id, created_at DESC, listing_id)
  WHERE status = 'open';

CREATE TABLE market_equipment_collections (
  collection_id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL REFERENCES market_equipment_listings(listing_id) ON DELETE RESTRICT,
  equipment_instance_id uuid NOT NULL
    REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('purchase', 'cancel_return')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz NULL,
  UNIQUE (listing_id, reason),
  UNIQUE (equipment_instance_id)
);
CREATE INDEX market_equipment_collections_venue_player_open_idx
  ON market_equipment_collections (venue_id, player_id, created_at, collection_id)
  WHERE claimed_at IS NULL;

CREATE TABLE market_equipment_gold_collections (
  collection_id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL UNIQUE
    REFERENCES market_equipment_listings(listing_id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  original_amount bigint NOT NULL CHECK (original_amount > 0),
  remaining_amount bigint NOT NULL CHECK (
    remaining_amount BETWEEN 0 AND original_amount
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz NULL
);
CREATE INDEX market_equipment_gold_collections_venue_player_open_idx
  ON market_equipment_gold_collections (
    venue_id, player_id, created_at, collection_id
  )
  WHERE remaining_amount > 0;

ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_market_listing_fk
  FOREIGN KEY (market_listing_id)
    REFERENCES market_equipment_listings(listing_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT equipment_instances_market_collection_fk
  FOREIGN KEY (market_collection_id)
    REFERENCES market_equipment_collections(collection_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE market_equipment_ledger (
  entry_id bigserial PRIMARY KEY,
  operation_key text NOT NULL,
  venue_id uuid NOT NULL REFERENCES market_venues(venue_id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL REFERENCES market_equipment_listings(listing_id) ON DELETE RESTRICT,
  equipment_instance_id uuid NOT NULL
    REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (
    entry_type IN (
      'listed', 'purchased', 'cancelled', 'collected',
      'seller_proceeds', 'buyer_debit', 'tax_burn'
    )
  ),
  gold_delta bigint NULL CHECK (gold_delta IS NULL OR gold_delta <> 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_key, entry_type)
);
CREATE TRIGGER market_equipment_ledger_immutable
BEFORE UPDATE OR DELETE ON market_equipment_ledger
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

-- Resting buy orders deliberately snapshot the maximum standard policy while
-- each trade snapshots the current local tax policy. Preserve the seller's
-- immutable order policy, but validate the buyer against the trade-time policy.
DO $migration$
DECLARE
  function_definition text;
  policy_start integer;
  policy_end integer;
  new_policy_validation text :=
    '  IF target_trade.seller_fee_policy_id <> sell_order.fee_policy_id'
    || chr(10)
    || '     OR target_trade.seller_fee_policy_version <> sell_order.fee_policy_version THEN'
    || chr(10)
    || '    RAISE EXCEPTION ''market trade seller fee snapshot does not match its order'';'
    || chr(10)
    || '  END IF;'
    || chr(10);
  fee_marker text := '     OR target_trade.buyer_fee::numeric';
  new_fee_marker text :=
    '     OR target_trade.applied_buyer_tax_bps <> buyer_fee_policy.buyer_fee_bps'
    || chr(10)
    || '     OR target_trade.buyer_fee::numeric';
BEGIN
  SELECT pg_get_functiondef(
    'validate_market_trade_commit(uuid)'::regprocedure
  ) INTO function_definition;
  policy_start := position(
    '  IF target_trade.buyer_fee_policy_id <> buy_order.fee_policy_id'
    IN function_definition
  );
  policy_end := position(
    '  SELECT * INTO buyer_fee_policy'
    IN function_definition
  );
  IF policy_start = 0
     OR policy_end <= policy_start
     OR position(fee_marker IN function_definition) = 0 THEN
    RAISE EXCEPTION
      'validate_market_trade_commit no longer matches the expected immutable baseline';
  END IF;
  function_definition := overlay(
    function_definition
    PLACING new_policy_validation
    FROM policy_start
    FOR policy_end - policy_start
  );
  function_definition := replace(
    function_definition,
    fee_marker,
    new_fee_marker
  );
  EXECUTE function_definition;
END;
$migration$;

DO $migration$
DECLARE
  function_definition text;
  declaration_marker text :=
    '  buyer_fee_policy market_fee_policies%ROWTYPE;';
  trade_policy_marker text :=
    '    AND version = target_trade.buyer_fee_policy_version;';
  reserve_bps_marker text :=
    'buyer_fee_policy.buyer_fee_bps::numeric';
BEGIN
  SELECT pg_get_functiondef(
    'validate_market_trade_hardening_commit(uuid)'::regprocedure
  ) INTO function_definition;
  IF position(declaration_marker IN function_definition) = 0
     OR position(trade_policy_marker IN function_definition) = 0
     OR (
       length(function_definition)
       - length(replace(function_definition, reserve_bps_marker, ''))
     ) / length(reserve_bps_marker) <> 2 THEN
    RAISE EXCEPTION
      'validate_market_trade_hardening_commit no longer matches the expected immutable baseline';
  END IF;
  function_definition := replace(
    function_definition,
    declaration_marker,
    declaration_marker
      || chr(10)
      || '  buy_reserve_fee_policy market_fee_policies%ROWTYPE;'
  );
  function_definition := replace(
    function_definition,
    trade_policy_marker,
    trade_policy_marker
      || chr(10)
      || '  SELECT * INTO buy_reserve_fee_policy'
      || chr(10)
      || '  FROM market_fee_policies'
      || chr(10)
      || '  WHERE fee_policy_id = buy_order.fee_policy_id'
      || chr(10)
      || '    AND version = buy_order.fee_policy_version;'
  );
  function_definition := replace(
    function_definition,
    reserve_bps_marker,
    'buy_reserve_fee_policy.buyer_fee_bps::numeric'
  );
  EXECUTE function_definition;
END;
$migration$;

-- The legacy global exchange remains available only for audited returns and
-- claims. Fresh City Market code must use a physical regional venue.
UPDATE market_venues
SET state = 'legacy_claims_only',
    tax_revision = tax_revision + 1
WHERE venue_key = 'global';
UPDATE market_venue_controls
SET new_orders_enabled = false,
    matching_enabled = false,
    cancellations_enabled = true,
    claims_enabled = true,
    updated_at = clock_timestamp()
WHERE venue_id = '00000000-0000-4000-8000-000000000600';

COMMENT ON COLUMN cities.district_switch_available_at IS
  'Database destruction time plus exactly seven days; a different District is allowed at this timestamp.';
COMMENT ON COLUMN city_gold_reserves.balance IS
  'City-owned construction Gold. Capacity is derived in shared configuration and is not persisted here.';
COMMENT ON COLUMN market_sessions.session_id IS
  'Connection-bound physical City Market authorization fence, never an idempotency identity.';
