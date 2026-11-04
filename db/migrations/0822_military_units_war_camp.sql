-- Military units, personal War Camp logistics, and siege operation ledgers.
-- All state is player-owned, durable, and intentionally excludes City/Kingdom
-- warfare or an enterable War Camp interior.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES (
  'demolition_charge', 'Demolition Charge', 'consumable', 'uncommon', true, 50,
  true, true, true, true, 'demolition_charge', ARRAY['default']::text[]
)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

-- Existing Siege Crew rows are retired as a forward-only conversion. The
-- ledger records every converted row so a populated upgrade is auditable and
-- repeat-safe; no row is silently converted into a Ballista.
CREATE TABLE IF NOT EXISTS military_siege_crew_retirements (
  retirement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  personnel_id uuid NOT NULL UNIQUE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  training_job_id uuid NULL,
  refunded_food integer NOT NULL DEFAULT 3 CHECK (refunded_food >= 0),
  refunded_gold bigint NOT NULL DEFAULT 100 CHECK (refunded_gold >= 0),
  refunded_cloth integer NOT NULL DEFAULT 2 CHECK (refunded_cloth >= 0),
  refunded_leather integer NOT NULL DEFAULT 2 CHECK (refunded_leather >= 0),
  status text NOT NULL DEFAULT 'refunded'
    CHECK (status IN ('refunded','recorded_no_wallet')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO military_siege_crew_retirements (
  personnel_id, player_id, training_job_id
)
SELECT personnel_id, owner_player_id, training_job_id
FROM military_personnel
WHERE personnel_type = 'siege_crew'
ON CONFLICT (personnel_id) DO NOTHING;

-- Refund the retained material and Gold costs through the authoritative event
-- chains. The procedural loop is deliberate: newly-created zero stacks must
-- be visible to the immediately-following versioned event in the same
-- migration statement. Existing events make each transition idempotent.
DO $$
DECLARE
  retirement record;
  item record;
  stack record;
  wallet_row record;
BEGIN
  FOR retirement IN SELECT * FROM military_siege_crew_retirements ORDER BY personnel_id LOOP
    FOR item IN
      SELECT * FROM (VALUES
        ('simple_food', retirement.refunded_food),
        ('cloth', retirement.refunded_cloth),
        ('leather', retirement.refunded_leather)
      ) AS refund(item_id, quantity)
      WHERE quantity > 0
    LOOP
      IF EXISTS (
        SELECT 1 FROM inventory_events
        WHERE operation_key = 'military-siege-crew-retirement:' || retirement.personnel_id::text || ':' || item.item_id
      ) THEN
        CONTINUE;
      END IF;
      INSERT INTO inventory_operations (
        operation_key, player_id, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        'military-siege-crew-retirement:' || retirement.personnel_id::text || ':' || item.item_id,
        retirement.player_id, 'military_siege_crew_retirement', 'military_personnel',
        retirement.personnel_id::text,
        jsonb_build_object('migration', '0822_military_units_war_camp')
      ) ON CONFLICT (operation_key) DO NOTHING;
      INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
      VALUES (retirement.player_id, item.item_id, 'default', 0, 0)
      ON CONFLICT (player_id, resource_type, variant) DO NOTHING;
      SELECT quantity, version INTO stack
      FROM player_inventory
      WHERE player_id = retirement.player_id
        AND resource_type = item.item_id
        AND variant = 'default'
      FOR UPDATE;
      INSERT INTO inventory_events (
        operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
        version_after, source, source_entity_type, source_entity_id, metadata
      ) VALUES (
        'military-siege-crew-retirement:' || retirement.personnel_id::text || ':' || item.item_id,
        retirement.player_id, item.item_id, 'default', item.quantity,
        stack.quantity + item.quantity, stack.version + 1,
        'military_siege_crew_retirement', 'military_personnel', retirement.personnel_id::text,
        jsonb_build_object('migration', '0822_military_units_war_camp')
      ) ON CONFLICT (operation_key, item_id, variant) DO NOTHING;
      UPDATE player_inventory
      SET quantity = quantity + item.quantity, version = version + 1, updated_at = now()
      WHERE player_id = retirement.player_id AND resource_type = item.item_id AND variant = 'default';
    END LOOP;

    SELECT player_wallet.player_id, player_wallet.account_id,
           player_wallet.gold_balance, player_wallet.version
    INTO wallet_row
    FROM player_wallets AS player_wallet
    WHERE player_wallet.player_id = retirement.player_id
    FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE military_siege_crew_retirements
      SET status = 'recorded_no_wallet'
      WHERE personnel_id = retirement.personnel_id;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM wallet_events
        WHERE operation_key = 'military-siege-crew-retirement:' || retirement.personnel_id::text || ':gold'
      ) THEN
        INSERT INTO wallet_events (
          operation_key, player_id, account_id, delta_gold, balance_after, version_after,
          reason, metadata
        ) VALUES (
          'military-siege-crew-retirement:' || retirement.personnel_id::text || ':gold',
          wallet_row.player_id, wallet_row.account_id, retirement.refunded_gold,
          wallet_row.gold_balance + retirement.refunded_gold, wallet_row.version + 1,
          'military_siege_crew_retirement',
          jsonb_build_object('migration', '0822_military_units_war_camp')
        );
        UPDATE player_wallets
        SET gold_balance = gold_balance + retirement.refunded_gold,
            version = version + 1, updated_at = now()
        WHERE player_id = wallet_row.player_id;
      END IF;
    END IF;
  END LOOP;
END $$;

-- A fully trained legacy crew has no outstanding charge to refund. A crew in
-- training is cancelled and receives the same material refund; the old job is
-- then cleared so it cannot produce a standalone personnel row after upgrade.
UPDATE military_facility_jobs
SET collected_quantity = output_quantity,
    cleared_at = COALESCE(cleared_at, clock_timestamp()),
    updated_at = clock_timestamp()
WHERE job_type = 'train_siege_crew' AND cleared_at IS NULL;

UPDATE player_lodges lodge
SET reserved_capacity = GREATEST(0, reserved_capacity - retired.capacity_cost),
    updated_at = clock_timestamp()
FROM (
  SELECT owner_player_id, SUM(capacity_cost)::integer AS capacity_cost
  FROM military_personnel
  WHERE personnel_type = 'siege_crew'
    AND status = 'training'
  GROUP BY owner_player_id
) retired
WHERE lodge.owner_player_id = retired.owner_player_id
  AND lodge.removed_at IS NULL;

DELETE FROM military_personnel WHERE personnel_type = 'siege_crew';

ALTER TABLE military_facility_jobs
  DROP CONSTRAINT IF EXISTS military_facility_jobs_job_type_check;
ALTER TABLE military_facility_jobs
  ADD CONSTRAINT military_facility_jobs_job_type_check CHECK (job_type IN (
    'train_siege_crew', 'train_infantry', 'train_archer', 'train_bomber',
    'manufacture_field_ballista', 'repair_kit_batch', 'torch_batch',
    'demolition_charge_batch', 'field_ballista_kit'
  ));

CREATE TABLE IF NOT EXISTS military_units (
  unit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  unit_type text NOT NULL CHECK (unit_type IN ('infantry','archer','bomber','field_ballista')),
  home_city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  current_hp smallint NOT NULL CHECK (current_hp >= 0),
  max_hp smallint NOT NULL CHECK (max_hp IN (60,80,100,150)),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','recovering','destroyed')),
  location_state text NOT NULL DEFAULT 'STATIONED_CITY'
    CHECK (location_state IN ('STATIONED_CITY','STATIONED_WAR_CAMP','FOLLOWING_PLAYER','DEPLOYED_FIELD','RECOVERING')),
  station_city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  war_camp_id uuid NULL,
  lat double precision NULL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon double precision NULL CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  group_id uuid NULL,
  carried_demolition_charge boolean NOT NULL DEFAULT false,
  next_recovery_at timestamptz NULL,
  next_fire_at timestamptz NULL,
  target_flag_id uuid NULL REFERENCES flags(id) ON DELETE SET NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT military_units_type_hp_check CHECK (
    (unit_type = 'infantry' AND max_hp = 100)
    OR (unit_type = 'archer' AND max_hp = 80)
    OR (unit_type = 'bomber' AND max_hp = 60)
    OR (unit_type = 'field_ballista' AND max_hp = 150)
  ),
  CONSTRAINT military_units_hp_status_check CHECK (
    current_hp <= max_hp AND (status <> 'destroyed' OR current_hp = 0)
  ),
  CONSTRAINT military_units_location_anchor_check CHECK (
    (location_state = 'STATIONED_CITY' AND station_city_id IS NOT NULL AND war_camp_id IS NULL)
    OR (location_state = 'STATIONED_WAR_CAMP' AND war_camp_id IS NOT NULL AND station_city_id IS NULL)
    OR (location_state IN ('FOLLOWING_PLAYER','DEPLOYED_FIELD','RECOVERING'))
  )
);

CREATE INDEX IF NOT EXISTS military_units_owner_state_idx
  ON military_units(owner_player_id, status, location_state, created_at, unit_id);
CREATE INDEX IF NOT EXISTS military_units_group_idx ON military_units(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS military_units_due_recovery_idx
  ON military_units(next_recovery_at, unit_id) WHERE status = 'recovering';

CREATE TABLE IF NOT EXISTS military_unit_groups (
  group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  unit_type text NOT NULL CHECK (unit_type IN ('infantry','archer','bomber','field_ballista')),
  location_state text NOT NULL
    CHECK (location_state IN ('STATIONED_CITY','STATIONED_WAR_CAMP','FOLLOWING_PLAYER','DEPLOYED_FIELD','RECOVERING')),
  station_city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  war_camp_id uuid NULL,
  lat double precision NULL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon double precision NULL CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  target_flag_id uuid NULL REFERENCES flags(id) ON DELETE SET NULL,
  next_fire_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS military_unit_groups_owner_idx
  ON military_unit_groups(owner_player_id, location_state, created_at, group_id);

ALTER TABLE military_units
  DROP CONSTRAINT IF EXISTS military_units_group_fk,
  ADD CONSTRAINT military_units_group_fk FOREIGN KEY (group_id)
    REFERENCES military_unit_groups(group_id) ON DELETE SET NULL;
ALTER TABLE military_units
  DROP CONSTRAINT IF EXISTS military_units_war_camp_fk;

CREATE TABLE IF NOT EXISTS war_camps (
  camp_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  footprint_geom geometry(Polygon,4326) NOT NULL,
  footprint_radius_m double precision NOT NULL CHECK (footprint_radius_m > 0),
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  built_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removed_reason text NULL,
  relocation_available_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS war_camps_active_owner_idx
  ON war_camps(owner_player_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS war_camps_world_geom_idx ON war_camps USING gist(geom);
CREATE INDEX IF NOT EXISTS war_camps_footprint_geom_idx ON war_camps USING gist(footprint_geom);

ALTER TABLE military_units
  DROP CONSTRAINT IF EXISTS military_units_war_camp_fk,
  ADD CONSTRAINT military_units_war_camp_fk FOREIGN KEY (war_camp_id)
    REFERENCES war_camps(camp_id) ON DELETE RESTRICT;
ALTER TABLE military_unit_groups
  DROP CONSTRAINT IF EXISTS military_unit_groups_war_camp_fk,
  ADD CONSTRAINT military_unit_groups_war_camp_fk FOREIGN KEY (war_camp_id)
    REFERENCES war_camps(camp_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS military_unit_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN (
    'combine','split','load_bombers','build_war_camp','call_troops',
    'relocate_war_camp','remove_war_camp','follow','deploy','return','stop','repair_ballista'
  )),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE(player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE IF NOT EXISTS military_rally_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  camp_id uuid NOT NULL REFERENCES war_camps(camp_id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE(player_id, request_id),
  CHECK (completes_at > started_at)
);
CREATE INDEX IF NOT EXISTS military_rally_due_idx
  ON military_rally_operations(completes_at, operation_key) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS military_siege_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN ('bomber_breach','ballista_volley')),
  -- Historical operation rows remain replayable even after a group is
  -- dissolved; group_id is therefore an immutable historical identity, not
  -- a lifecycle FK. Flag cleanup follows the existing warfare ledger policy.
  group_id uuid NOT NULL,
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  damage smallint NOT NULL CHECK (damage > 0),
  consumed_charges integer NOT NULL DEFAULT 0 CHECK (consumed_charges >= 0),
  damage_cycle_id uuid NULL,
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('pending','complete','cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completes_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE(player_id, request_id),
  CHECK ((status = 'pending' AND completed_at IS NULL) OR (status IN ('complete','cancelled') AND completed_at IS NOT NULL))
);
ALTER TABLE military_siege_operations
  ALTER COLUMN completed_at DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completes_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE military_siege_operations
  DROP CONSTRAINT IF EXISTS military_siege_operations_status_check,
  ADD CONSTRAINT military_siege_operations_status_check CHECK (status IN ('pending','complete','cancelled'));
ALTER TABLE military_siege_operations
  DROP CONSTRAINT IF EXISTS military_siege_operations_completion_check,
  ADD CONSTRAINT military_siege_operations_completion_check CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status IN ('complete','cancelled') AND completed_at IS NOT NULL)
  );
CREATE INDEX IF NOT EXISTS military_siege_operations_flag_idx
  ON military_siege_operations(flag_id, created_at DESC);
CREATE INDEX IF NOT EXISTS military_siege_operations_due_idx
  ON military_siege_operations(completes_at, operation_key) WHERE status = 'pending';

COMMENT ON TABLE military_units IS
  'Durable underlying unit identity. Groups are only a presentation/command aggregate.';
COMMENT ON TABLE military_unit_groups IS
  'Durable player-command aggregate; member identity and condition remain in military_units.';
COMMENT ON TABLE war_camps IS
  'Outdoor, non-enterable personal rally anchor. War Camp placement never changes player GPS.';
COMMENT ON TABLE military_siege_operations IS
  'Replay-safe bomber/ballista damage ledger; it does not create manual Flag cooldowns.';
