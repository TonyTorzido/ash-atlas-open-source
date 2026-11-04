-- Kingdom perk tree: four perks per level for levels 2-6, one chosen per
-- level, plus kingdom level 6.
--
-- Choosing a perk costs 23,500 Bricks + 1,150 Glimmer Oil from the
-- treasury; changing one costs 34,000 + 1,700. Only the leader chooses.
-- Every choice, change and activation is one append-only operation row
-- keyed by the leader's request, and the treasury debits go through
-- kingdom_treasury_ledger under the same key, so a replay can never charge
-- twice.
--
-- Grandfathering: before this migration every kingdom at level 2 or above
-- got +1 defense ("Steadfast Company"), and from level 4 also +1 attack
-- ("Rallying Standard"), with no choice. Those perks are retired. So that no
-- kingdom silently loses power, every active kingdom at level 2 or above
-- (by stored level or by lifetime XP, 250 at level 2) gets Boundary
-- Writ (+2 attack / +2 defense) chosen at level 2, free of charge.

ALTER TABLE kingdoms DROP CONSTRAINT IF EXISTS kingdoms_level_valid;
ALTER TABLE kingdoms ADD CONSTRAINT kingdoms_level_valid CHECK (level BETWEEN 1 AND 6);

ALTER TABLE kingdom_projects DROP CONSTRAINT IF EXISTS kingdom_projects_target_level_valid;
ALTER TABLE kingdom_projects
  ADD CONSTRAINT kingdom_projects_target_level_valid CHECK (target_level BETWEEN 2 AND 6);

CREATE TABLE IF NOT EXISTS kingdom_perk_selections (
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  perk_level smallint NOT NULL,
  perk_id text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  -- Level 6 activated perks: the last activation and the end of its buff.
  activated_at timestamptz NULL,
  active_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kingdom_id, perk_level),
  CONSTRAINT kingdom_perk_selections_level_valid CHECK (perk_level BETWEEN 2 AND 6),
  CONSTRAINT kingdom_perk_selections_perk_valid CHECK (
    (perk_level = 2 AND perk_id IN ('verdant_surge', 'picket_lines', 'boundary_writ', 'reserved_game'))
    OR (perk_level = 3 AND perk_id IN ('beacon_wardens', 'braced_foundations', 'grand_masonry', 'forward_sappers'))
    OR (perk_level = 4 AND perk_id IN ('skyward_stonework', 'sworn_ramparts', 'gilded_trim', 'warded_monuments'))
    OR (perk_level = 5 AND perk_id IN ('unyielding_assault', 'picked_legion', 'hearth_ground', 'labor_corps'))
    OR (perk_level = 6 AND perk_id IN ('breach_company', 'the_spearhead', 'the_watchfires', 'caravan_guild'))
  ),
  CONSTRAINT kingdom_perk_selections_buff_valid CHECK (
    (activated_at IS NULL AND active_until IS NULL)
    OR (activated_at IS NOT NULL AND perk_level = 6 AND (active_until IS NULL OR active_until > activated_at))
  )
);

-- Perk lookups by perk id (tower volleys, structure damage, brick and gold
-- yield) probe the few kingdoms holding that perk.
CREATE INDEX IF NOT EXISTS kingdom_perk_selections_perk_idx
  ON kingdom_perk_selections (perk_id, kingdom_id);

CREATE TABLE IF NOT EXISTS kingdom_perk_operations (
  operation_key text PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL,
  perk_level smallint NOT NULL CHECK (perk_level BETWEEN 2 AND 6),
  perk_id text NOT NULL,
  previous_perk_id text NULL,
  bricks_quantity integer NOT NULL CHECK (bricks_quantity >= 0),
  glimmer_oil_quantity integer NOT NULL CHECK (glimmer_oil_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_perk_operations_action_valid
    CHECK (action IN ('choose', 'change', 'grandfather', 'activate')),
  CONSTRAINT kingdom_perk_operations_shape CHECK (
    (action = 'choose' AND previous_perk_id IS NULL AND bricks_quantity > 0 AND glimmer_oil_quantity > 0
      AND player_id IS NOT NULL)
    OR (action = 'change' AND previous_perk_id IS NOT NULL AND previous_perk_id <> perk_id
      AND bricks_quantity > 0 AND glimmer_oil_quantity > 0 AND player_id IS NOT NULL)
    OR (action = 'grandfather' AND player_id IS NULL AND bricks_quantity = 0 AND glimmer_oil_quantity = 0)
    OR (action = 'activate' AND perk_level = 6 AND bricks_quantity = 0 AND glimmer_oil_quantity = 0
      AND player_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS kingdom_perk_operations_kingdom_idx
  ON kingdom_perk_operations (kingdom_id, created_at DESC);

DROP TRIGGER IF EXISTS kingdom_perk_operations_append_only ON kingdom_perk_operations;
CREATE TRIGGER kingdom_perk_operations_append_only
BEFORE UPDATE OR DELETE ON kingdom_perk_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss',
      'kingdom_perk_choose', 'kingdom_perk_change'
    )
  );

-- Grandfather (idempotent: a kingdom that already has a level 2 perk, or
-- already has its grandfather row, is skipped).
INSERT INTO kingdom_perk_operations (
  operation_key, kingdom_id, player_id, action, perk_level, perk_id, bricks_quantity, glimmer_oil_quantity
)
SELECT 'kingdom-perk-grandfather:' || k.id::text, k.id, NULL, 'grandfather', 2, 'boundary_writ', 0, 0
FROM kingdoms k
WHERE k.status = 'active'
  AND (k.level >= 2 OR k.lifetime_xp >= 250)
  AND NOT EXISTS (
    SELECT 1 FROM kingdom_perk_selections s WHERE s.kingdom_id = k.id AND s.perk_level = 2
  )
ON CONFLICT (operation_key) DO NOTHING;

INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id)
SELECT op.kingdom_id, 2, 'boundary_writ'
FROM kingdom_perk_operations op
WHERE op.action = 'grandfather'
ON CONFLICT (kingdom_id, perk_level) DO NOTHING;

COMMENT ON TABLE kingdom_perk_selections IS
  'One chosen kingdom perk per level (2-6); level 6 activated perks also hold their 24 h buff window.';
COMMENT ON TABLE kingdom_perk_operations IS
  'Append-only perk choices, changes, activations and the 0924 grandfather grants, keyed by request.';
