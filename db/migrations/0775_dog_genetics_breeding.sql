-- Retained account Dogs become Foundation stock. Their immutable IDs seed a weighted 0..6
-- genotype and their biological age is fixed at a safe 21-day adult. Historical Neglect deaths
-- remain memorialized; active code may create natural Old Age deaths only.
DROP INDEX IF EXISTS account_dogs_one_living_per_account;
ALTER TABLE account_dogs
  DROP CONSTRAINT IF EXISTS account_dogs_death_state,
  DROP CONSTRAINT IF EXISTS account_dogs_lifecycle_order,
  DROP CONSTRAINT IF EXISTS account_dogs_reservation_state;

ALTER TABLE account_dogs
  ADD COLUMN owner_player_id text REFERENCES players(id) ON DELETE RESTRICT,
  ADD COLUMN species text NOT NULL DEFAULT 'DOG',
  ADD COLUMN source text NOT NULL DEFAULT 'FOUNDATION',
  ADD COLUMN status text,
  ADD COLUMN birth_at timestamptz,
  ADD COLUMN selected boolean NOT NULL DEFAULT false,
  ADD COLUMN current_hp integer,
  ADD COLUMN current_stamina_seconds integer,
  ADD COLUMN stamina_updated_at timestamptz,
  ADD COLUMN summoned_at timestamptz,
  ADD COLUMN last_unsummoned_at timestamptz,
  ADD COLUMN incapacitated_until timestamptz,
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN surrendered_at timestamptz,
  ADD COLUMN died_at timestamptz,
  ADD COLUMN death_age_day smallint,
  ADD COLUMN auto_retire_at_90 boolean NOT NULL DEFAULT true,
  ADD COLUMN active_skill_available_at timestamptz,
  ADD COLUMN mother_id uuid,
  ADD COLUMN father_id uuid,
  ADD COLUMN generation integer NOT NULL DEFAULT 0,
  ADD COLUMN lifetime_breedings smallint NOT NULL DEFAULT 0,
  ADD COLUMN max_lifetime_breedings smallint NOT NULL DEFAULT 4,
  ADD COLUMN breeding_cooldown_until timestamptz,
  ADD COLUMN elder_processed_day smallint NOT NULL DEFAULT 89,
  ADD COLUMN gene_vitality smallint,
  ADD COLUMN gene_speed smallint,
  ADD COLUMN gene_power smallint,
  ADD COLUMN gene_focus smallint,
  ADD COLUMN gene_stamina smallint,
  ADD COLUMN gene_instinct smallint;

WITH owners AS (
  SELECT account_id, min(id) AS player_id FROM players GROUP BY account_id
), seeded AS (
  SELECT d.id,
    ARRAY[
      (('x'||substr(md5(d.id::text||':vitality'),1,8))::bit(32)::bigint % 100),
      (('x'||substr(md5(d.id::text||':speed'),1,8))::bit(32)::bigint % 100),
      (('x'||substr(md5(d.id::text||':power'),1,8))::bit(32)::bigint % 100),
      (('x'||substr(md5(d.id::text||':focus'),1,8))::bit(32)::bigint % 100),
      (('x'||substr(md5(d.id::text||':stamina'),1,8))::bit(32)::bigint % 100),
      (('x'||substr(md5(d.id::text||':instinct'),1,8))::bit(32)::bigint % 100)
    ]::integer[] AS rolls,
    o.player_id
  FROM account_dogs d LEFT JOIN owners o ON o.account_id=d.account_id
), genes AS (
  SELECT id, player_id,
    ARRAY(SELECT CASE WHEN r<5 THEN 0 WHEN r<25 THEN 1 WHEN r<50 THEN 2
      WHEN r<75 THEN 3 WHEN r<90 THEN 4 WHEN r<98 THEN 5 ELSE 6 END
      FROM unnest(rolls) r) AS values
  FROM seeded
)
UPDATE account_dogs d SET
  owner_player_id=g.player_id,
  status=CASE WHEN d.death_at IS NULL THEN 'READY' ELSE 'DEAD' END,
  birth_at=d.adopted_at-interval '21 days',
  stamina_updated_at=COALESCE(d.updated_at,now()),
  last_unsummoned_at=COALESCE(d.updated_at,now()),
  active_skill_available_at=COALESCE(d.explore_available_at,d.updated_at,now()),
  died_at=d.death_at,
  gene_vitality=g.values[1], gene_speed=g.values[2], gene_power=g.values[3],
  gene_focus=g.values[4], gene_stamina=g.values[5], gene_instinct=g.values[6]
FROM genes g WHERE d.id=g.id;

-- Weighted Foundation values are 0..6 (T0/T1); compute full quantized phenotype.
UPDATE account_dogs SET
  current_hp=90+CASE WHEN gene_vitality>=6 THEN 1 ELSE 0 END,
  current_stamina_seconds=(CASE WHEN gene_stamina>=6 THEN 48 ELSE 45 END)*60;

WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY owner_player_id ORDER BY adopted_at DESC,id) AS n
  FROM account_dogs WHERE status='READY' AND owner_player_id IS NOT NULL
)
UPDATE account_dogs d SET selected=true FROM ranked r WHERE d.id=r.id AND r.n=1;

ALTER TABLE account_dogs
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN owner_player_id SET NOT NULL,
  ALTER COLUMN birth_at SET NOT NULL,
  ALTER COLUMN current_hp SET NOT NULL,
  ALTER COLUMN current_stamina_seconds SET NOT NULL,
  ALTER COLUMN stamina_updated_at SET NOT NULL,
  ALTER COLUMN last_unsummoned_at SET NOT NULL,
  ALTER COLUMN active_skill_available_at SET NOT NULL,
  ALTER COLUMN gene_vitality SET NOT NULL,
  ALTER COLUMN gene_speed SET NOT NULL,
  ALTER COLUMN gene_power SET NOT NULL,
  ALTER COLUMN gene_focus SET NOT NULL,
  ALTER COLUMN gene_stamina SET NOT NULL,
  ALTER COLUMN gene_instinct SET NOT NULL,
  ADD CONSTRAINT account_dogs_species_dog CHECK(species='DOG'),
  ADD CONSTRAINT account_dogs_source CHECK(source IN('FOUNDATION','PUPPY')),
  ADD CONSTRAINT account_dogs_status CHECK(status IN(
    'READY','SUMMONED','RESTING','INCAPACITATED','BOARDING','NURSERY',
    'RETIRED','DEAD','SURRENDERED')),
  ADD CONSTRAINT account_dogs_genes CHECK(
    gene_vitality BETWEEN 0 AND 31 AND gene_speed BETWEEN 0 AND 31 AND
    gene_power BETWEEN 0 AND 31 AND gene_focus BETWEEN 0 AND 31 AND
    gene_stamina BETWEEN 0 AND 31 AND gene_instinct BETWEEN 0 AND 31),
  ADD CONSTRAINT account_dogs_health_stamina CHECK(current_hp>=0 AND current_stamina_seconds>=0),
  ADD CONSTRAINT account_dogs_breeding_counts CHECK(
    max_lifetime_breedings=4 AND lifetime_breedings BETWEEN 0 AND max_lifetime_breedings),
  ADD CONSTRAINT account_dogs_generation CHECK(generation>=0),
  ADD CONSTRAINT account_dogs_death_age CHECK(death_age_day IS NULL OR death_age_day BETWEEN 90 AND 100),
  ADD CONSTRAINT account_dogs_terminal_state CHECK(
    (status='DEAD')=(died_at IS NOT NULL) AND
    (status='RETIRED')=(retired_at IS NOT NULL) AND
    (status='SURRENDERED')=(surrendered_at IS NOT NULL)),
  ADD CONSTRAINT account_dogs_summon_state CHECK(
    (status='SUMMONED')=(summoned_at IS NOT NULL));

ALTER TABLE account_dogs
  ADD CONSTRAINT account_dogs_mother_fk FOREIGN KEY(mother_id) REFERENCES account_dogs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT account_dogs_father_fk FOREIGN KEY(father_id) REFERENCES account_dogs(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX account_dogs_one_usable_per_owner ON account_dogs(owner_player_id)
  WHERE owner_player_id IS NOT NULL AND status IN('READY','SUMMONED','RESTING','INCAPACITATED','BOARDING');
CREATE UNIQUE INDEX account_dogs_one_nursery_per_owner ON account_dogs(owner_player_id)
  WHERE owner_player_id IS NOT NULL AND status='NURSERY';
CREATE UNIQUE INDEX account_dogs_one_selected_per_owner ON account_dogs(owner_player_id) WHERE selected;
CREATE INDEX account_dogs_history ON account_dogs(owner_player_id,birth_at DESC,id);
CREATE INDEX account_dogs_mother ON account_dogs(mother_id) WHERE mother_id IS NOT NULL;
CREATE INDEX account_dogs_father ON account_dogs(father_id) WHERE father_id IS NOT NULL;

CREATE TABLE dog_traits(
  dog_id uuid NOT NULL REFERENCES account_dogs(id) ON DELETE RESTRICT,
  trait_key text NOT NULL CHECK(trait_key IN(
    'keen_nose','trailblazer','tireless','fleet_paw','hardy','strong_jaw',
    'pathfinder','guard_dog','escape_artist','tracker')),
  source text NOT NULL DEFAULT 'birth' CHECK(source IN('birth','inheritance','spontaneous','debug')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(dog_id,trait_key)
);
CREATE OR REPLACE FUNCTION enforce_dog_trait_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize trait additions on the durable Dog row so concurrent inserts cannot exceed two.
  PERFORM 1 FROM account_dogs WHERE id=NEW.dog_id FOR UPDATE;
  IF (SELECT count(*) FROM dog_traits WHERE dog_id=NEW.dog_id)>=2 THEN
    RAISE EXCEPTION 'a Dog may have at most two traits' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dog_traits_limit BEFORE INSERT ON dog_traits
FOR EACH ROW WHEN (pg_trigger_depth()=0) EXECUTE FUNCTION enforce_dog_trait_limit();

CREATE TABLE dog_breeding_contracts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  breeder_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  kennel_manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  parent_a_id uuid NOT NULL REFERENCES account_dogs(id) ON DELETE RESTRICT,
  parent_b_id uuid NOT NULL REFERENCES account_dogs(id) ON DELETE RESTRICT,
  owner_a_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  owner_b_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  puppy_recipient_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  captured_breeder_rank smallint NOT NULL CHECK(captured_breeder_rank BETWEEN 0 AND 4),
  breeder_fee_gold bigint NOT NULL CHECK(breeder_fee_gold>=0),
  stud_fee_gold bigint NOT NULL CHECK(stud_fee_gold>=0),
  focus_gene text CHECK(focus_gene IN('vitality','speed','power','focus','stamina','instinct')),
  parent_a_genes jsonb,
  parent_b_genes jsonb,
  parent_a_traits text[],
  parent_b_traits text[],
  request_id text NOT NULL CHECK(char_length(request_id) BETWEEN 1 AND 128),
  operation_id uuid NOT NULL UNIQUE,
  immutable_terms_hash text NOT NULL,
  owner_a_approved_at timestamptz,
  owner_b_approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  starts_at timestamptz,
  completes_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  status text NOT NULL CHECK(status IN('DRAFT','AWAITING_APPROVAL','APPROVED','STARTED','COMPLETED','CANCELLED')),
  puppy_id uuid REFERENCES account_dogs(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(breeder_player_id,request_id),
  CHECK(parent_a_id<>parent_b_id),
  CHECK(puppy_recipient_player_id IN(owner_a_player_id,owner_b_player_id)),
  CHECK((status IN('STARTED','COMPLETED'))=(starts_at IS NOT NULL)),
  CHECK((status IN('STARTED','COMPLETED'))=(completes_at IS NOT NULL)),
  CHECK((status IN('STARTED','COMPLETED'))=(parent_a_genes IS NOT NULL AND parent_b_genes IS NOT NULL)),
  CHECK((status IN('STARTED','COMPLETED'))=(parent_a_traits IS NOT NULL AND parent_b_traits IS NOT NULL)),
  CHECK((status='COMPLETED')=(completed_at IS NOT NULL AND puppy_id IS NOT NULL))
);
CREATE UNIQUE INDEX dog_contract_one_active_kennel ON dog_breeding_contracts(kennel_manor_id)
  WHERE status IN('DRAFT','AWAITING_APPROVAL','APPROVED','STARTED');
CREATE UNIQUE INDEX dog_contract_active_parent_a ON dog_breeding_contracts(parent_a_id)
  WHERE status IN('AWAITING_APPROVAL','APPROVED','STARTED');
CREATE UNIQUE INDEX dog_contract_active_parent_b ON dog_breeding_contracts(parent_b_id)
  WHERE status IN('AWAITING_APPROVAL','APPROVED','STARTED');
CREATE UNIQUE INDEX dog_contract_one_started_recipient ON dog_breeding_contracts(puppy_recipient_player_id)
  WHERE status='STARTED';
CREATE INDEX dog_contract_due ON dog_breeding_contracts(completes_at,id) WHERE status='STARTED';

CREATE TABLE dog_boardings(
  contract_id uuid NOT NULL REFERENCES dog_breeding_contracts(id) ON DELETE RESTRICT,
  dog_id uuid NOT NULL REFERENCES account_dogs(id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  kennel_manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  boarded_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY(contract_id,dog_id)
);
CREATE UNIQUE INDEX dog_boardings_one_active_dog ON dog_boardings(dog_id) WHERE ended_at IS NULL;

CREATE TABLE dog_foundation_purchases(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK(char_length(request_id) BETWEEN 1 AND 128),
  operation_id uuid NOT NULL UNIQUE,
  dog_id uuid NOT NULL REFERENCES account_dogs(id) ON DELETE RESTRICT,
  price_gold bigint NOT NULL CHECK(price_gold>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);

CREATE TABLE dog_owner_cooldowns(
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  foundation_available_at timestamptz NOT NULL,
  reason text NOT NULL CHECK(reason IN('SURRENDER','TRANSFER')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dog_events(
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  player_id text REFERENCES players(id) ON DELETE RESTRICT,
  dog_id uuid REFERENCES account_dogs(id) ON DELETE RESTRICT,
  contract_id uuid REFERENCES dog_breeding_contracts(id) ON DELETE RESTRICT,
  event_key text NOT NULL CHECK(event_key~'^dog_[a-z0-9_]+$'),
  operation_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dog_events_operation_once ON dog_events(operation_id,event_key) WHERE operation_id IS NOT NULL;
CREATE INDEX dog_events_player_history ON dog_events(player_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION protect_dog_breeding_contract_immutable_terms()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.breeder_player_id,NEW.kennel_manor_id,NEW.parent_a_id,NEW.parent_b_id,
    NEW.owner_a_player_id,NEW.owner_b_player_id,NEW.puppy_recipient_player_id,
    NEW.captured_breeder_rank,NEW.breeder_fee_gold,NEW.stud_fee_gold,NEW.focus_gene,
    NEW.request_id,NEW.operation_id,NEW.immutable_terms_hash,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.breeder_player_id,OLD.kennel_manor_id,OLD.parent_a_id,OLD.parent_b_id,
    OLD.owner_a_player_id,OLD.owner_b_player_id,OLD.puppy_recipient_player_id,
    OLD.captured_breeder_rank,OLD.breeder_fee_gold,OLD.stud_fee_gold,OLD.focus_gene,
    OLD.request_id,OLD.operation_id,OLD.immutable_terms_hash,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Dog breeding contract terms are immutable' USING ERRCODE='23514';
  END IF;
  IF (OLD.owner_a_approved_at IS NOT NULL AND NEW.owner_a_approved_at IS DISTINCT FROM OLD.owner_a_approved_at)
     OR (OLD.owner_b_approved_at IS NOT NULL AND NEW.owner_b_approved_at IS DISTINCT FROM OLD.owner_b_approved_at) THEN
    RAISE EXCEPTION 'Dog breeding approvals are immutable once recorded' USING ERRCODE='23514';
  END IF;
  IF (OLD.parent_a_genes IS NOT NULL AND NEW.parent_a_genes IS DISTINCT FROM OLD.parent_a_genes)
     OR (OLD.parent_b_genes IS NOT NULL AND NEW.parent_b_genes IS DISTINCT FROM OLD.parent_b_genes)
     OR (OLD.parent_a_traits IS NOT NULL AND NEW.parent_a_traits IS DISTINCT FROM OLD.parent_a_traits)
     OR (OLD.parent_b_traits IS NOT NULL AND NEW.parent_b_traits IS DISTINCT FROM OLD.parent_b_traits) THEN
    RAISE EXCEPTION 'Dog breeding parent snapshots are immutable once captured' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dog_breeding_contracts_immutable_terms
BEFORE UPDATE ON dog_breeding_contracts FOR EACH ROW
EXECUTE FUNCTION protect_dog_breeding_contract_immutable_terms();

CREATE OR REPLACE FUNCTION protect_dog_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dog events are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER dog_events_immutable
BEFORE UPDATE OR DELETE ON dog_events FOR EACH ROW EXECUTE FUNCTION protect_dog_events_immutable();

ALTER TABLE dog_explore_destinations
  DROP CONSTRAINT dog_explore_destinations_pkey,
  ADD COLUMN id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN option_key text,
  ADD COLUMN package_id text,
  ADD COLUMN collectible_id text,
  ADD COLUMN expires_at timestamptz;
UPDATE dog_explore_destinations SET option_key='primary',expires_at=discovered_at+interval '15 minutes';
ALTER TABLE dog_explore_destinations
  ALTER COLUMN id SET NOT NULL,ALTER COLUMN option_key SET NOT NULL,ALTER COLUMN expires_at SET NOT NULL,
  ADD PRIMARY KEY(id),ADD UNIQUE(dog_id,option_key);

DROP TRIGGER IF EXISTS dog_breeding_contracts_set_updated_at ON dog_breeding_contracts;
CREATE TRIGGER dog_breeding_contracts_set_updated_at BEFORE UPDATE ON dog_breeding_contracts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
