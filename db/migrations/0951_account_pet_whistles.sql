-- Pets (docs/design/PETS_PLAN.md): one whistle per species per account, one pet out at a time.
-- Replaces the Dog genetics/breeding/care system. The old dog and menu-pet tables are left in
-- place, unused (no destructive drop). Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS account_pet_whistles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  species text NOT NULL CHECK (species IN (
    'trail_hound', 'brood_spinner', 'emberclaw_raptor', 'storm_chick', 'thicket_wolf',
    'thornback_boar', 'ember_drake', 'deep_crawler', 'glade_wisp'
  )),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 24),
  level smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 100),
  unlocked_abilities text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (cardinality(unlocked_abilities) <= 2),
  -- Base health (before Companion Bond); NULL means full.
  current_hp integer CHECK (current_hp IS NULL OR current_hp >= 0),
  last_fed_at timestamptz NOT NULL DEFAULT now(),
  rest_until timestamptz,
  active_until timestamptz,
  paused_remaining_ms integer CHECK (paused_remaining_ms IS NULL OR paused_remaining_ms > 0),
  source text NOT NULL CHECK (source IN ('starter', 'migration', 'hatch', 'hermit', 'repair')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_pet_whistles_one_species UNIQUE (account_id, species),
  CONSTRAINT account_pet_whistles_timer_state CHECK (
    NOT (active_until IS NOT NULL AND (rest_until IS NOT NULL OR paused_remaining_ms IS NOT NULL))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS account_pet_whistles_one_out
  ON account_pet_whistles (account_id)
  WHERE active_until IS NOT NULL;

DROP TRIGGER IF EXISTS account_pet_whistles_set_updated_at ON account_pet_whistles;
CREATE TRIGGER account_pet_whistles_set_updated_at
BEFORE UPDATE ON account_pet_whistles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Replay guard for every paid or item-consuming pet action (Glimmer debit and item debit use the
-- same operation key in the same transaction).
CREATE TABLE IF NOT EXISTS account_pet_operations (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 240),
  action text NOT NULL CHECK (action IN ('feed', 'heal', 'train', 'unlock', 'hatch', 'hermit')),
  pet_id uuid REFERENCES account_pet_whistles(id) ON DELETE RESTRICT,
  glimmer_cost integer NOT NULL DEFAULT 0 CHECK (glimmer_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, operation_key)
);

-- Every account gets the free Trail Hound whistle; the active dog's name carries over.
INSERT INTO account_pet_whistles (account_id, species, name, source)
SELECT a.id, 'trail_hound', COALESCE(dog.name, 'Trail Hound'), 'migration'
FROM accounts a
LEFT JOIN LATERAL (
  SELECT btrim(d.name) AS name
  FROM account_dogs d
  WHERE d.account_id = a.id
    AND d.status NOT IN ('DEAD', 'SURRENDERED', 'RETIRED')
    AND char_length(btrim(d.name)) BETWEEN 1 AND 24
  ORDER BY d.selected DESC, (d.status = 'SUMMONED') DESC, d.adopted_at DESC, d.id
  LIMIT 1
) dog ON true
ON CONFLICT (account_id, species) DO NOTHING;
