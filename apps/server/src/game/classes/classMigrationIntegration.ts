import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../config.js";
import { createPool } from "../../db/pool.js";

const foundationSql = await migration("0300_class_progression_foundation.sql");
const developmentSql = await migration("0301_dev_progression_operations.sql");
const simplifiedSql = await migration("0302_simplified_warrior_and_queue_combat.sql");
const telemetrySql = await migration("0303_combat_balance_telemetry.sql");
const hunterSql = await migration("0304_hunter_and_multiclass_foundation.sql");
const paladinClericSql = await migration("0305_paladin_cleric_foundation.sql");
const clericStarterStaffSql = await migration("0306_cleric_starter_staff.sql");
const durablePartySql = await migration("0307_durable_party_authority.sql");
const partyConsentReplaySql = await migration("0308_party_consent_replay_and_lease.sql");
const schema = `class_migration_test_${crypto.randomUUID().replaceAll("-", "")}`;
const pool = createPool({ databaseUrl: loadConfig().DATABASE_URL });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}", public`);
  await client.query(`
    CREATE TABLE players (id text PRIMARY KEY);
    CREATE TABLE character_progression_sentinel (
      player_id text PRIMARY KEY REFERENCES players(id), total_xp integer NOT NULL, level integer NOT NULL
    );
    CREATE TABLE inventory_sentinel (
      player_id text PRIMARY KEY REFERENCES players(id), item_id text NOT NULL, quantity integer NOT NULL
    );
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TABLE item_definitions (
      item_id text PRIMARY KEY, display_name text NOT NULL, category text NOT NULL,
      stackable boolean NOT NULL, max_stack integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE equipment_operations (
      operation_key text PRIMARY KEY, player_id text NOT NULL REFERENCES players(id),
      action text NOT NULL, completed_at timestamptz NULL
    );
    CREATE TABLE equipment_instances (
      instance_id uuid PRIMARY KEY, definition_id text NOT NULL REFERENCES item_definitions(item_id),
      owner_player_id text NOT NULL REFERENCES players(id), location text NOT NULL,
      equipped_slot text NULL, created_by_operation_key text NOT NULL REFERENCES equipment_operations(operation_key)
    );
    INSERT INTO item_definitions VALUES
      ('starter_sword', 'Starter Sword', 'equipment', false, 1, now()),
      ('padded_tunic', 'Padded Tunic', 'equipment', false, 1, now());
    INSERT INTO players (id) VALUES ('returning-warrior');
    INSERT INTO character_progression_sentinel VALUES ('returning-warrior', 12345, 18);
    INSERT INTO inventory_sentinel VALUES ('returning-warrior', 'owned-sword', 1);
  `);
  await client.query(foundationSql);
  await client.query(developmentSql);
  await client.query(`
    UPDATE player_class_progress
    SET mastery_xp = 999, mastery_rank = 16,
        training_points_earned = 20, training_points_spent = 9
    WHERE player_id = 'returning-warrior';
    UPDATE player_subclass_progress
    SET unlocked = true, mastery_xp = 16500, mastery_rank = 10,
        training_points_earned = 12, training_points_spent = 8
    WHERE player_id = 'returning-warrior' AND subclass_id = 'reaver';
    UPDATE player_class_profiles SET active_subclass_id = 'reaver'
    WHERE player_id = 'returning-warrior';
    INSERT INTO player_class_technique_unlocks
      (player_id, technique_id, class_id, subclass_id, operation_key)
    VALUES
      ('returning-warrior', 'warrior_cleave', 'warrior', NULL, 'learn-cleave'),
      ('returning-warrior', 'warrior_fortify', 'warrior', NULL, 'learn-fortify'),
      ('returning-warrior', 'warrior_second_wind', 'warrior', NULL, 'learn-obsolete');
    UPDATE player_class_loadouts
    SET base_active_ids = ARRAY['warrior_cleave','warrior_fortify']::text[],
        base_passive_ids = ARRAY['warrior_ironclad','warrior_thick_blood',NULL]::text[],
        subclass_active_id = 'reaver_blood_harvest',
        subclass_passive_ids = ARRAY['reaver_deep_wounds',NULL]::text[]
    WHERE player_id = 'returning-warrior';
    INSERT INTO player_class_legacy_unlocks
      (player_id, completed_class_id, legacy_id, display_name)
    VALUES
      ('returning-warrior','warrior','warrior_legacy_iron_constitution','Iron Constitution');
    UPDATE player_class_runtime
    SET rage = 50, rage_reserved = 20,
        queued_ability_id = 'warrior_second_wind',
        queued_target_entity_id = 'obsolete-target', queued_at_tick = 99,
        cooldown_ends_at = '{"warrior_second_wind":999999}'::jsonb,
        status_effects = '[{"sourceTechniqueId":"warrior_second_wind"}]'::jsonb,
        counters = '{"obsoleteCounter":4}'::jsonb,
        combat_generation = 7, last_combat_at = now()
    WHERE player_id = 'returning-warrior';
  `);

  await client.query(simplifiedSql);
  await client.query(telemetrySql);
  await client.query(hunterSql);

  const progress = row(await client.query<{
    mastery_xp: number; mastery_rank: number; training_points_earned: number; training_points_spent: number;
  }>(`SELECT mastery_xp, mastery_rank, training_points_earned, training_points_spent
      FROM player_class_progress WHERE player_id = 'returning-warrior'`));
  assert(Number(progress.mastery_rank) === 16, "retained Warrior Level changed");
  assert(Number(progress.mastery_xp) === 15000, "retained Warrior XP was not reconciled");
  assert(Number(progress.training_points_earned) === 0 && Number(progress.training_points_spent) === 0,
    "dormant Training Points were not reconciled");

  const loadout = row(await client.query<{
    reset_active_ids: Array<string | null>;
    normal_active_ids: Array<string | null>;
    passive_tier_ids: Array<string | null>;
    base_active_ids: Array<string | null>;
  }>(`SELECT reset_active_ids, normal_active_ids, passive_tier_ids, base_active_ids
      FROM player_class_loadouts WHERE player_id = 'returning-warrior' AND class_id = 'warrior'`));
  assert(loadout.normal_active_ids.join(",") === "warrior_cleave,warrior_fortify",
    "equivalent old normal actives were not mapped");
  assert(loadout.reset_active_ids.every((id) => id === null), "obsolete reset slots were not cleared");
  assert(loadout.passive_tier_ids.every((id) => id === null), "obsolete passives were not cleared");
  assert(loadout.base_active_ids.every((id) => id === null), "old active storage was not cleared");

  const runtime = row(await client.query<{
    rage: number; rage_reserved: number; queued_ability_id: string | null;
    cooldown_ends_at: Record<string, unknown>; status_effects: unknown[];
    counters: Record<string, unknown>; combat_generation: number;
  }>(`SELECT rage, rage_reserved, queued_ability_id, cooldown_ends_at,
             status_effects, counters, combat_generation
      FROM player_class_runtime WHERE player_id = 'returning-warrior'`));
  assert(Number(runtime.rage) === 50, "earned Rage was not preserved");
  assert(Number(runtime.rage_reserved) === 0 && runtime.queued_ability_id === null,
    "obsolete queued action was not invalidated");
  assert(Object.keys(runtime.cooldown_ends_at).length === 0, "obsolete cooldowns survived");
  assert(runtime.status_effects.length === 0 && Object.keys(runtime.counters).length === 0,
    "obsolete effects or counters survived");
  assert(Number(runtime.combat_generation) === 8, "runtime generation was not invalidated exactly once");

  const preserved = row(await client.query<{
    character_xp: number; character_level: number; item_id: string; quantity: number;
    legacy_count: number; reaver_unlocked: boolean; archived_count: number; current_unlock_count: number;
  }>(`
    SELECT character.total_xp AS character_xp, character.level AS character_level,
           inventory.item_id, inventory.quantity,
           (SELECT count(*)::int FROM player_class_legacy_unlocks WHERE player_id = 'returning-warrior') AS legacy_count,
           (SELECT unlocked FROM player_subclass_progress WHERE player_id = 'returning-warrior' AND subclass_id = 'reaver') AS reaver_unlocked,
           (SELECT count(*)::int FROM archived_class_technique_unlocks WHERE player_id = 'returning-warrior') AS archived_count,
           (SELECT count(*)::int FROM player_class_technique_unlocks WHERE player_id = 'returning-warrior') AS current_unlock_count
    FROM character_progression_sentinel character
    JOIN inventory_sentinel inventory USING (player_id)
    WHERE character.player_id = 'returning-warrior'
  `));
  assert(Number(preserved.character_xp) === 12345 && Number(preserved.character_level) === 18,
    "character progression changed");
  assert(preserved.item_id === "owned-sword" && Number(preserved.quantity) === 1,
    "inventory or ownership changed");
  assert(Number(preserved.legacy_count) === 1 && preserved.reaver_unlocked,
    "legacy or subclass unlock was not preserved");
  assert(Number(preserved.archived_count) === 3 && Number(preserved.current_unlock_count) === 0,
    "historical learned rows were not archived exactly once");

  const hunterState = row(await client.query<{
    hunter_level: number; hunter_loadouts: number; hunter_subclasses: number;
    warrior_resource: number; hunter_resource: number; starter_bows: number;
    selected_warrior: string | null;
  }>(`
    SELECT
      (SELECT mastery_rank FROM player_class_progress WHERE player_id = 'returning-warrior' AND class_id = 'hunter') AS hunter_level,
      (SELECT count(*)::int FROM player_class_loadouts WHERE player_id = 'returning-warrior' AND class_id = 'hunter') AS hunter_loadouts,
      (SELECT count(*)::int FROM player_subclass_progress WHERE player_id = 'returning-warrior' AND class_id = 'hunter') AS hunter_subclasses,
      (SELECT current_value FROM player_class_resources WHERE player_id = 'returning-warrior' AND class_id = 'warrior') AS warrior_resource,
      (SELECT current_value FROM player_class_resources WHERE player_id = 'returning-warrior' AND class_id = 'hunter') AS hunter_resource,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_bow') AS starter_bows,
      (SELECT selected_subclasses->>'warrior' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_warrior
  `));
  assert(Number(hunterState.hunter_level) === 0 && Number(hunterState.hunter_loadouts) === 1,
    "Hunter Level-0 progress or loadout was not backfilled");
  assert(Number(hunterState.hunter_subclasses) === 2, "Hunter subclass progress was not backfilled");
  assert(Number(hunterState.warrior_resource) === 50 && Number(hunterState.hunter_resource) === 100,
    "independent Rage/Focus resources were not initialized correctly");
  assert(Number(hunterState.starter_bows) === 1, "starter bow was not granted exactly once");
  assert(hunterState.selected_warrior === "reaver", "active Warrior subclass was not preserved as its selection");

  await client.query(`UPDATE player_class_profiles SET selected_subclasses = jsonb_set(selected_subclasses, '{hunter}', '"stalker"'::jsonb) WHERE player_id = 'returning-warrior'`);
  await client.query(hunterSql);
  const replayCounts = row(await client.query<{
    progress: number; resources: number; subclasses: number; bows: number; selected_hunter: string | null;
  }>(`
    SELECT
      (SELECT count(*)::int FROM player_class_progress WHERE player_id = 'returning-warrior') AS progress,
      (SELECT count(*)::int FROM player_class_resources WHERE player_id = 'returning-warrior') AS resources,
      (SELECT count(*)::int FROM player_subclass_progress WHERE player_id = 'returning-warrior') AS subclasses,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_bow') AS bows,
      (SELECT selected_subclasses->>'hunter' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_hunter
  `));
  assert(Number(replayCounts.progress) === 2 && Number(replayCounts.resources) === 2,
    "replayed migration duplicated class or resource rows");
  assert(Number(replayCounts.subclasses) === 4 && Number(replayCounts.bows) === 1,
    "replayed migration duplicated subclass or starter bow rows");
  assert(replayCounts.selected_hunter === "stalker", "replayed migration overwrote an inactive class selection");

  await client.query(paladinClericSql);
  const sacredState = row(await client.query<{
    paladin_level: number; cleric_level: number; class_rows: number; class_loadouts: number;
    subclass_rows: number; subclass_loadouts: number; conviction: number; faith: number;
    selected_warrior: string | null; selected_hunter: string | null;
    has_paladin_key: boolean; has_cleric_key: boolean; starter_staffs: number; equipped_staffs: number;
  }>(`
    SELECT
      (SELECT mastery_rank FROM player_class_progress WHERE player_id = 'returning-warrior' AND class_id = 'paladin') AS paladin_level,
      (SELECT mastery_rank FROM player_class_progress WHERE player_id = 'returning-warrior' AND class_id = 'cleric') AS cleric_level,
      (SELECT count(*)::int FROM player_class_progress WHERE player_id = 'returning-warrior') AS class_rows,
      (SELECT count(*)::int FROM player_class_loadouts WHERE player_id = 'returning-warrior') AS class_loadouts,
      (SELECT count(*)::int FROM player_subclass_progress WHERE player_id = 'returning-warrior') AS subclass_rows,
      (SELECT count(*)::int FROM player_subclass_loadouts WHERE player_id = 'returning-warrior') AS subclass_loadouts,
      (SELECT current_value FROM player_class_resources WHERE player_id = 'returning-warrior' AND class_id = 'paladin') AS conviction,
      (SELECT current_value FROM player_class_resources WHERE player_id = 'returning-warrior' AND class_id = 'cleric') AS faith,
      (SELECT selected_subclasses->>'warrior' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_warrior,
      (SELECT selected_subclasses->>'hunter' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_hunter,
      (SELECT selected_subclasses ? 'paladin' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS has_paladin_key,
      (SELECT selected_subclasses ? 'cleric' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS has_cleric_key,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_staff') AS starter_staffs,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_staff' AND location = 'equipped') AS equipped_staffs
  `));
  assert(Number(sacredState.paladin_level) === 0 && Number(sacredState.cleric_level) === 0,
    "Paladin or Cleric did not start at Level 0");
  assert(Number(sacredState.class_rows) === 4 && Number(sacredState.class_loadouts) === 4,
    "Paladin or Cleric progress/loadouts were not backfilled exactly once");
  assert(Number(sacredState.subclass_rows) === 8 && Number(sacredState.subclass_loadouts) === 8,
    "Paladin or Cleric subclass rows/loadouts were not backfilled exactly once");
  assert(Number(sacredState.conviction) === 0 && Number(sacredState.faith) === 0,
    "Conviction or Faith did not initialize independently at zero");
  assert(sacredState.selected_warrior === "reaver" && sacredState.selected_hunter === "stalker",
    "Paladin/Cleric migration overwrote an existing class selection");
  assert(sacredState.has_paladin_key && sacredState.has_cleric_key,
    "Paladin/Cleric selection keys were not backfilled");
  assert(Number(sacredState.starter_staffs) === 1 && Number(sacredState.equipped_staffs) === 0,
    "Cleric starter staff was not granted exactly once and unequipped");

  await client.query(`
    UPDATE player_class_profiles
    SET selected_subclasses = jsonb_set(
      jsonb_set(selected_subclasses, '{paladin}', '"justicar"'::jsonb),
      '{cleric}', '"exorcist"'::jsonb
    )
    WHERE player_id = 'returning-warrior';
    INSERT INTO player_class_legacy_unlocks
      (player_id, completed_class_id, legacy_id, display_name)
    VALUES
      ('returning-warrior','paladin','paladin_legacy_sacred_endurance','Sacred Endurance'),
      ('returning-warrior','cleric','cleric_legacy_lasting_grace','Lasting Grace');
  `);
  await client.query(paladinClericSql);
  await client.query(paladinClericSql);
  const sacredReplay = row(await client.query<{
    class_rows: number; resource_rows: number; subclass_rows: number;
    selected_paladin: string | null; selected_cleric: string | null; legacy_rows: number; starter_staffs: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM player_class_progress WHERE player_id = 'returning-warrior') AS class_rows,
      (SELECT count(*)::int FROM player_class_resources WHERE player_id = 'returning-warrior') AS resource_rows,
      (SELECT count(*)::int FROM player_subclass_progress WHERE player_id = 'returning-warrior') AS subclass_rows,
      (SELECT selected_subclasses->>'paladin' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_paladin,
      (SELECT selected_subclasses->>'cleric' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_cleric,
      (SELECT count(*)::int FROM player_class_legacy_unlocks WHERE player_id = 'returning-warrior') AS legacy_rows,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_staff') AS starter_staffs
  `));
  assert(Number(sacredReplay.class_rows) === 4 && Number(sacredReplay.resource_rows) === 4 &&
    Number(sacredReplay.subclass_rows) === 8, "replayed Paladin/Cleric migration duplicated rows");
  assert(sacredReplay.selected_paladin === "justicar" && sacredReplay.selected_cleric === "exorcist",
    "replayed Paladin/Cleric migration overwrote selections");
  assert(Number(sacredReplay.legacy_rows) === 3, "Paladin/Cleric legacy constraints rejected valid permanent rows");
  assert(Number(sacredReplay.starter_staffs) === 1, "replayed Paladin/Cleric migration duplicated the starter staff");

  // Simulate a retained database whose migration ledger recorded 0305 before
  // the starter-staff statements were appended, then prove 0306 repairs it.
  await client.query(`
    DELETE FROM equipment_instances
    WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_staff';
    DELETE FROM equipment_operations
    WHERE operation_key = 'cleric-starter-staff:returning-warrior:v1';
    DELETE FROM item_definitions WHERE item_id = 'starter_staff';
    DROP INDEX IF EXISTS equipment_starter_definition_once_idx;
    CREATE UNIQUE INDEX equipment_starter_definition_once_idx
      ON equipment_instances (owner_player_id, definition_id)
      WHERE definition_id IN ('starter_sword', 'starter_bow', 'padded_tunic') AND location <> 'destroyed';
  `);
  await client.query(clericStarterStaffSql);
  await client.query(clericStarterStaffSql);
  const staffCorrection = row(await client.query<{
    definitions: number; instances: number; inventory_instances: number; operations: number;
    class_rows: number; selected_paladin: string | null; selected_cleric: string | null;
  }>(`
    SELECT
      (SELECT count(*)::int FROM item_definitions WHERE item_id = 'starter_staff') AS definitions,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_staff') AS instances,
      (SELECT count(*)::int FROM equipment_instances WHERE owner_player_id = 'returning-warrior' AND definition_id = 'starter_staff' AND location = 'inventory' AND equipped_slot IS NULL) AS inventory_instances,
      (SELECT count(*)::int FROM equipment_operations WHERE operation_key = 'cleric-starter-staff:returning-warrior:v1') AS operations,
      (SELECT count(*)::int FROM player_class_progress WHERE player_id = 'returning-warrior') AS class_rows,
      (SELECT selected_subclasses->>'paladin' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_paladin,
      (SELECT selected_subclasses->>'cleric' FROM player_class_profiles WHERE player_id = 'returning-warrior') AS selected_cleric
  `));
  assert(Number(staffCorrection.definitions) === 1 && Number(staffCorrection.instances) === 1 &&
    Number(staffCorrection.inventory_instances) === 1 && Number(staffCorrection.operations) === 1,
    "0306 did not repair the retained starter staff exactly once and unequipped");
  assert(Number(staffCorrection.class_rows) === 4 && staffCorrection.selected_paladin === "justicar" &&
    staffCorrection.selected_cleric === "exorcist", "0306 altered retained class state");

  await client.query(durablePartySql);
  await client.query(durablePartySql);
  await client.query(partyConsentReplaySql);
  await client.query(partyConsentReplaySql);
  await client.query(`
    INSERT INTO players (id) VALUES
      ('party-alpha'), ('party-beta'), ('party-zeta'), ('party-invitee');
    INSERT INTO parties (party_id, leader_player_id) VALUES ('retained-party', 'party-zeta');
    INSERT INTO party_members (party_id, player_id) VALUES
      ('retained-party', 'party-zeta'),
      ('retained-party', 'party-beta'),
      ('retained-party', 'party-alpha');
  `);
  await client.query(`DELETE FROM party_members WHERE party_id = 'retained-party' AND player_id = 'party-zeta'`);
  await client.query("SET CONSTRAINTS party_leader_membership_fk IMMEDIATE");
  await client.query(`
    INSERT INTO party_invites (
      party_id, target_player_id, invited_by_player_id, issued_at, expires_at
    ) VALUES (
      'retained-party', 'party-invitee', 'party-alpha', now(), now() + interval '5 minutes'
    );
    INSERT INTO party_operations (player_id, request_id, action, payload, completed_at)
    VALUES ('party-alpha', 'retained-request', 'invite',
      '{"targetPlayerId":"party-invitee"}'::jsonb, now());
  `);
  await client.query("SET CONSTRAINTS party_invites_inviter_membership_fk IMMEDIATE");
  await client.query(durablePartySql);
  await client.query(partyConsentReplaySql);
  const durableParty = row(await client.query<{
    leader_player_id: string; revision: number; member_count: number;
    invite_count: number; operation_count: number; invitee_membership_count: number;
    retained_character_xp: number; retained_inventory_quantity: number;
  }>(`
    SELECT party.leader_player_id, party.revision,
           (SELECT count(*)::int FROM party_members WHERE party_id = party.party_id) AS member_count,
           (SELECT count(*)::int FROM party_invites WHERE party_id = party.party_id) AS invite_count,
           (SELECT count(*)::int FROM party_operations
             WHERE player_id = 'party-alpha' AND request_id = 'retained-request') AS operation_count,
           (SELECT count(*)::int FROM party_members
             WHERE player_id = 'party-invitee') AS invitee_membership_count,
           (SELECT total_xp FROM character_progression_sentinel WHERE player_id = 'returning-warrior') AS retained_character_xp,
           (SELECT quantity FROM inventory_sentinel WHERE player_id = 'returning-warrior') AS retained_inventory_quantity
    FROM parties party WHERE party.party_id = 'retained-party'
  `));
  assert(durableParty.leader_player_id === "party-alpha" && Number(durableParty.revision) === 2,
    "0307 did not preserve deterministic leader succession and revision");
  assert(Number(durableParty.member_count) === 2, "0307 did not preserve explicit party members");
  assert(Number(durableParty.invite_count) === 1 && Number(durableParty.operation_count) === 1,
    "0308 replay did not preserve durable invitation or request-reservation rows");
  assert(Number(durableParty.invitee_membership_count) === 0,
    "0308 inferred party membership from an invitation");
  assert(Number(durableParty.retained_character_xp) === 12345 && Number(durableParty.retained_inventory_quantity) === 1,
    "0307 altered retained progression or inventory state");

  await client.query("SAVEPOINT duplicate_party_membership");
  try {
    await client.query(`
      INSERT INTO parties (party_id, leader_player_id) VALUES ('invalid-second-party', 'party-alpha');
      INSERT INTO party_members (party_id, player_id) VALUES ('invalid-second-party', 'party-alpha');
    `);
    throw new Error("0307 allowed one player to belong to two parties");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT duplicate_party_membership");
    const databaseError = error as { code?: string; constraint?: string };
    assert(databaseError.code === "23505" &&
      databaseError.constraint === "party_members_one_party_per_player_key",
    "0307 did not enforce the one-party-per-player constraint");
  }

  await client.query(`
    INSERT INTO players (id) VALUES ('new-warrior');
    INSERT INTO player_class_progress (player_id, class_id) VALUES ('new-warrior', 'warrior');
  `);
  const newWarrior = row(await client.query<{ mastery_xp: number; mastery_rank: number }>(
    `SELECT mastery_xp, mastery_rank FROM player_class_progress WHERE player_id = 'new-warrior'`
  ));
  assert(Number(newWarrior.mastery_xp) === 0 && Number(newWarrior.mastery_rank) === 0,
    "post-0302 Warrior did not start at Level 0");

  console.log(JSON.stringify({
    ok: true,
    retainedLevel: Number(progress.mastery_rank),
    retainedXp: Number(progress.mastery_xp),
    archivedTechniques: Number(preserved.archived_count),
    runtimeGeneration: Number(runtime.combat_generation),
    hunterLevel: Number(hunterState.hunter_level),
    hunterFocus: Number(hunterState.hunter_resource),
    paladinLevel: Number(sacredState.paladin_level),
    clericLevel: Number(sacredState.cleric_level),
    conviction: Number(sacredState.conviction),
    faith: Number(sacredState.faith),
    starterStaffs: Number(staffCorrection.instances),
    starterBows: Number(replayCounts.bows),
    durablePartyLeader: durableParty.leader_player_id,
    durablePartyRevision: Number(durableParty.revision),
    durablePartyInvites: Number(durableParty.invite_count),
    durablePartyOperations: Number(durableParty.operation_count),
    newWarriorLevel: Number(newWarrior.mastery_rank)
  }, null, 2));
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

async function migration(file: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`../../../../../db/migrations/${file}`, import.meta.url)),
    "utf8"
  );
}

function row<T>(result: { rows: T[] }): T {
  const value = result.rows[0];
  if (!value) throw new Error("migration fixture query returned no row");
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
