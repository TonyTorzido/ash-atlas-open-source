import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { setMarketControlAuditContext } from "../game/marketControlAudit.js";
import { MIGRATION_LOCK_NAME } from "./migrate.js";

const { Client } = pg;

export const RESET_CONFIRMATION = "RESET-ASH-ATLAS-TEST-DATA";
export const RESET_ADVISORY_LOCK = "ash-atlas-test-data-reset-v1";
export const MAINTENANCE_ADVISORY_LOCK = "ash-atlas-database-maintenance-v1";
export const PUBLIC_TEST_DATABASE = "ash_atlas_game";

export const resetManifest = Object.freeze({
  preserve: Object.freeze([
    "account_chat_preferences",
    "player_announcements",
    "test_access_settings",
    "wiki_collaborators",
    "wiki_page_revisions",
    "wiki_pages",
    "account_device_links",
    "account_identities",
    "account_risk_events",
    "accounts",
    "auth_events",
    "auth_google_credential_uses",
    "auth_sessions",
    "device_installations",
    "flag_set_revision",
    "item_definitions",
    "item_market_tax_tags",
    "kingdom_decoration_definitions",
    "market_fee_policies",
    "market_global_controls",
    "market_premium_assets",
    "population_river_water_suppressions_v1",
    "schema_migrations",
    "spatial_ref_sys",
    "test_access_email_grants",
    "test_access_events"
  ]),
  wipe: Object.freeze([
    // War release (children before their parents; territory_collapses follows flags).
    "city_structure_attack_operations",
    "war_camp_attack_cooldowns",
    "war_camp_damage_operations",
    "kingdom_war_structure_operations",
    "kingdom_command_board_operations",
    "kingdom_command_boards",
    "kingdom_perk_operations",
    "kingdom_perk_selections",
    "kingdom_member_xp_days",
    "organization_war_death_losses",
    "organization_war_surrenders",
    "organization_war_alerts",
    "organization_wars",
    "kingdom_brick_furnace_operations",
    "kingdom_brick_furnaces",
    "kingdom_structure_build_operations",
    "kingdom_brick_deposits",
    "kingdom_treasury_ledger",
    "flag_tower_upgrade_operations",
    "backpack_events",
    "backpack_operations",
    "butcher_build_jobs",
    "butcher_jobs",
    "butcher_operations",
    "kitchen_build_jobs",
    "kitchen_jobs",
    "kitchen_operations",
    "simple_food_consumption_operations",
    "travel_hunger_consumption_operations",
    "character_xp_curve_adjustments",
    "class_xp_curve_adjustments",
    "creature_book_ashen_sightings",
    "creature_book_drop_occurrences",
    "creature_book_kill_occurrences",
    "creature_book_sightings",
    "developer_spawned_mobs",
    "dungeon_instance_runs",
    "dungeon_presence",
    "dungeon_reward_claims",
    "dungeon_run_stats",
    "furnace_build_jobs",
    "fishing_catch_records",
    "fishing_encounters",
    "fishing_food_accumulators",
    "fishing_hut_build_jobs",
    "fishing_operations",
    "wandering_merchant_stock",
    "wandering_merchants",
    "cinder_lantern_runs",
    "cinder_lanterns",
    "player_pathfinder_mark_requests",
    "player_pathfinder_marks",
    "hollin_hut_player_standing",
    "hollin_huts",
    "goblin_market_sales",
    "goblin_market_purchases",
    "goblin_market_stock",
    "goblin_village_deletions",
    "goblin_village_population_overrides",
    "goblin_village_spawns",
    "harvest_toll_operations",
    "kingdom_projects",
    "kingdom_treasury_expenditures",
    "manor_storage_backpack_events",
    "market_collection_repairs",
    "market_legacy_collection_allowlist",
    "npc_city_defender_slots",
    "npc_city_player_relations",
    "player_announcement_dismissals",
    "player_backpack_instances",
    "player_backpack_state",
    "player_butchers",
    "player_kitchens",
    "player_class_unlocks",
    "player_combat_records",
    "player_death_xp_penalties",
    "player_pvp_death_gold_losses",
    "player_pvp_timers",
    "player_pvp_defeat_safety",
    "player_pvp_pending_deaths",
    "player_general_active_loadouts",
    "player_harvest_toll_settings",
    "player_skill_point_state",
    "player_skill_ranks",
    "player_skill_runtime",
    "buried_treasure_operations",
    "buried_treasures",
    "player_shovel_wear",
    "war_monolith_operations",
    "war_monoliths",
    "player_skill_world_unlocks",
    "player_specialization_ranks",
    "player_specialization_state",
    "player_specialization_ultimate_unlocks",
    "population_flag_plan_backfill_jobs",
    "population_generation_kind_manifest_v2",
    "population_generation_mob_rollouts_v2",
    "repeatable_resource_claim_operations",
    "skill_point_operations",
    "specialization_commitment_reconciliation_audit",
    "specialization_migration_audit",
    "specialization_ultimate_completion_identities",
    "warrior_xp_curve_adjustments",
    "world_equipment_drops",
    "world_backpack_drops",
    "backpack_drop_operations",
    "player_death_backpack_drops",
    "xoral_event_rewards",
    "xoral_events",
    "xoral_ring_drops",
    "account_pet_operations",
    "account_pet_whistles",
    "dog_events",
    "dog_boardings",
    "dog_foundation_purchases",
    "dog_breeding_contracts",
    "dog_traits",
    "account_dogs",
    "dog_owner_cooldowns",
    "atlas_shrine_unlock_operations",
    "archived_class_technique_unlocks",
    "balsam_resin_effects",
    "chat_channel_read_states",
    "chat_messages",
    "chat_moderation_decisions",
    "chat_mutes",
    "cities",
    "city_construction_contributions",
    "city_coin_contributions",
    "city_coin_ledger",
    "city_flag_affiliation_history",
    "city_district_events",
    "city_gold_ledger",
    "land_owner_bonus_payouts",
    "city_market_daily_purchases",
    "kingdom_gold_ledger",
    "kingdom_gold_reserves",
    "city_gold_operations",
    "city_gold_reserves",
    "city_memberships",
    "city_mutations",
    "city_settlement_reconciliation_events",
    "city_settlement_reconciliation_runs",
    "dungeon_completion_ledger",
    "cistern_warrens_encounters",
    "cistern_warrens_presence",
    "salon_appearance_operations",
    "salon_presence",
    "city_structure_events",
    "city_structure_material_spend",
    "city_oil_well_operations",
    "city_oil_well_production",
    "city_quartz_hut_production",
    "city_structure_operations",
    "city_structure_refunds",
    "city_structures",
    "city_treasuries",
    "city_warehouse_events",
    "city_warehouse_operations",
    "city_warehouse_stacks",
    "class_operations",
    "class_progression_operations",
    "collectible_nodes",
    "combat_balance_summaries",
    "combat_kit_items",
    "combat_kit_operations",
    "combat_kits",
    "combat_reward_participants",
    "combat_reward_settlements",
    "dev_progression_operations",
    "direct_conversation_participants",
    "direct_conversations",
    "direct_message_event_cursors",
    "direct_message_events",
    "direct_message_rate_windows",
    "dog_daily_care",
    "dog_explore_destinations",
    "enemy_neutrality_requests",
    "equipment_audit_events",
    "equipment_instances",
    "equipment_operations",
    "equipment_upgrade_operations",
    "flag_build_operations",
    "flag_destruction_operations",
    "flag_destruction_refunds",
    "flag_material_spend",
    "flag_resource_visions",
    "flag_travel_commands",
    "flags",
    "territory_collapse_flags",
    "territory_collapses",
    "friend_requests",
    "friendships",
    "generated_world_mobs",
    "harvest_sessions",
    "inventory_events",
    "inventory_operations",
    "inventory_protection_events",
    "inventory_protection_operations",
    "inventory_stack_operations",
    "kingdom_audit_events",
    "kingdom_chat_messages",
    "kingdom_chat_mutes",
    "kingdom_construction_jobs",
    "kingdom_cots",
    "kingdom_decorations",
    "kingdom_donations",
    "kingdom_flag_affiliation_history",
    "kingdom_invitations",
    "kingdom_memberships",
    "kingdom_requests",
    "kingdom_revolt_votes",
    "kingdom_revolts",
    "kingdom_seats",
    "kingdom_treasury_balances",
    "kingdom_xp_ledger",
    "kingdoms",
    "legendary_bird_cycles",
    "legendary_bird_events",
    "legendary_bird_species_cooldowns",
    "manor_bans",
    "manor_build_operations",
    "manor_jump_operations",
    "manor_placement_events",
    "manor_placement_operations",
    "manor_storage_equipment_events",
    "manor_storage_events",
    "manor_storage_operations",
    "manor_storage_overflow",
    "manor_storage_stack_events",
    "manor_storage_stacks",
    "manor_transfer_operations",
    "market_claims",
    "market_collections",
    "market_equipment_collections",
    "market_equipment_gold_collections",
    "market_equipment_ledger",
    "market_equipment_listings",
    "market_ledger_entries",
    "market_ledger_groups",
    "market_order_books",
    "market_order_escrows",
    "market_orders",
    "market_player_controls",
    "market_premium_sell_terms",
    "market_quote_requests",
    "market_quotes",
    "market_rate_windows",
    "market_requests",
    "market_sessions",
    "market_trades",
    "mastery_progression_operations",
    "normal_flag_passage_grants",
    "normal_flag_passage_requests",
    "furnace_operations",
    "furnace_smelt_units",
    "furnace_smelt_jobs",
    "parties",
    "party_invites",
    "party_members",
    "party_operations",
    "permanent_mine_allocation_buckets",
    "pet_daily_care",
    "pet_debug_offsets",
    "pet_debug_operations",
    "pet_expedition_debug_operations",
    "pet_expedition_discoveries",
    "pet_expedition_preferences",
    "pet_expedition_profiles",
    "pet_expedition_training_choices",
    "pet_expeditions",
    "pet_memories",
    "pet_milestones",
    "pet_owner_audit_events",
    "pet_view_preferences",
    "player_blocks",
    "player_class_legacy_unlocks",
    "player_class_loadouts",
    "player_class_profiles",
    "player_class_progress",
    "player_class_resources",
    "player_class_runtime",
    "player_class_technique_unlocks",
    "player_combat_profiles",
    "player_direct_message_preferences",
    "player_compass_wear",
    "player_map_waypoints",
    "player_map_markers",
    "player_world_map_destination_preferences",
    "player_world_map_social_positions",
    "player_world_map_social_preferences",
    "player_discovered_cities",
    "player_discovered_mines",
    "player_enemy_marks",
    "player_equipment_state",
    "player_flag_preferences",
    "player_furnaces",
    "player_fishing_huts",
    "tannery_operations",
    "tannery_jobs",
    "tannery_build_jobs",
    "player_tanneries",
    "player_inbox_entries",
    "player_inbox_read_receipts",
    "player_inventory",
    "player_inventory_capacities",
    "player_inventory_protection_state",
    "legacy_player_inventory_slots",
    "player_item_keep_policies",
    "player_manor_presence",
    "player_manors",
    "player_mastery_achievements",
    "player_mastery_state",
    "player_gift_equipment_instances",
    "player_package_campaigns",
    "player_package_claim_operations",
    "player_package_items",
    "player_packages",
    "player_pets",
    "player_profession_progress",
    "player_profiles",
    "player_stats",
    "player_atlas_shrine_progression",
    "player_achievements",
    "player_biome_discoveries",
    "player_progression_profiles",
    "player_subclass_loadouts",
    "player_subclass_progress",
    "player_unique_item_protections",
    "player_wallets",
    "player_water_collection_cadence",
    "players",
    "population_entity_state_v2",
    "population_flag_suppression_cleanup_jobs",
    "population_permanent_stone_authority_v2",
    "population_plan_permanent_stones_v2",
    "population_runtime_entity_leases_v2",
    "population_spawn_slots_v2",
    "population_stone_conflict_repair_receipts_v2",
    "population_zone_cutovers_v2",
    "population_zone_generations_v2",
    "population_zones_v2",
    "recent_player_pair_suppressions",
    "recent_players",
    "repeatable_resource_harvests",
    "repeatable_resource_nodes",
    "repeatable_resource_sessions",
    "resource_vision_jobs",
    "spawn_cells",
    "travel_invite_operations",
    "travel_invites",
    "wallet_events",
    "water_collection_operations",
    "world_environment_cells",
    "world_environment_profile_jobs",
    "world_item_drop_requests",
    "world_item_drops",
    "world_item_movements",
    "world_item_pickups",
    "world_item_system_drop_sources",
    "weekly_leaderboard_events",
    "weekly_leaderboard_totals",
    "xp_events",
    "xp_operations"
  ]),
  derivedReseed: Object.freeze([
    "market_audit_events",
    "market_venue_controls",
    "market_venues",
    "chat_channel_sequences",
    "chat_channels"
  ])
});

export const standaloneResetSequences = Object.freeze([
  "kingdom_spatial_revision_seq",
  "market_priority_sequence"
]);

type ProtectedSnapshot = Record<string, Readonly<{ rows: number; digest: string }>>;

type MigrationFile = Readonly<{
  version: string;
  contentSha256: string;
}>;

type ResetIdentity = Readonly<{
  host: string;
  port: number;
  database: string;
}>;

export type ResetReceipt = Readonly<{
  schemaVersion: 1;
  event: "ash_atlas_test_data_reset";
  dryRun: boolean;
  completedAtUtc: string;
  releaseSha: string | null;
  database: ResetIdentity;
  backupPath: string | null;
  manifest: typeof resetManifest;
  standaloneResetSequences: readonly string[];
  rowsBefore: Record<string, number>;
  protectedBefore: ProtectedSnapshot;
  protectedAfter: ProtectedSnapshot;
}>;

type ExecuteResetInput = Readonly<{
  client: pg.Client;
  identity: ResetIdentity;
  migrationsDirectory: string;
  dryRun: boolean;
  releaseSha?: string | null;
  createBackup?: () => Promise<string>;
  now?: () => Date;
}>;

type GuardEnvironment = Readonly<Record<string, string | undefined>>;

export function validateRealResetAuthorization(
  confirmation: string | undefined,
  environment: GuardEnvironment
): void {
  if (environment.ALLOW_TEST_DATA_RESET !== "1") {
    refuse("ALLOW_TEST_DATA_RESET must equal 1");
  }
  if (confirmation !== RESET_CONFIRMATION) {
    refuse("confirmation phrase is absent or incorrect");
  }
}

export function assertExactTableClassification(actualTables: readonly string[]): void {
  const classified = [
    ...resetManifest.preserve,
    ...resetManifest.wipe,
    ...resetManifest.derivedReseed
  ];
  const duplicates = classified.filter((table, index) => classified.indexOf(table) !== index);
  if (duplicates.length > 0) {
    refuse(`table manifest contains duplicate classifications: ${[...new Set(duplicates)].join(", ")}`);
  }
  const known = new Set(classified);
  const actual = new Set(actualTables);
  const unknown = actualTables.filter((table) => !known.has(table));
  const missing = classified.filter((table) => !actual.has(table));
  if (unknown.length > 0) refuse(`unclassified public tables: ${unknown.join(", ")}`);
  if (missing.length > 0) refuse(`classified public tables are missing: ${missing.join(", ")}`);
}

export function assertForeignKeyClosure(
  foreignKeys: ReadonlyArray<Readonly<{
    childSchema: string;
    childTable: string;
    parentSchema: string;
    parentTable: string;
  }>>
): void {
  const reset = new Set([...resetManifest.wipe, ...resetManifest.derivedReseed]);
  const unsafe = foreignKeys.filter((foreignKey) =>
    foreignKey.parentSchema === "public" &&
    reset.has(foreignKey.parentTable) &&
    (foreignKey.childSchema !== "public" || !reset.has(foreignKey.childTable))
  );
  if (unsafe.length > 0) {
    refuse(
      "protected or unclassified tables reference reset tables: " +
      unsafe.map((foreignKey) =>
        `${foreignKey.childSchema}.${foreignKey.childTable}->` +
        `${foreignKey.parentSchema}.${foreignKey.parentTable}`
      ).join(", ")
    );
  }
}

export async function executeReset(input: ExecuteResetInput): Promise<ResetReceipt> {
  const locks: string[] = [];
  let transactionOpen = false;
  try {
    for (const lockName of [
      RESET_ADVISORY_LOCK,
      MAINTENANCE_ADVISORY_LOCK,
      MIGRATION_LOCK_NAME
    ]) {
      const acquired = await input.client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [lockName]
      );
      if (acquired.rows[0]?.acquired !== true) {
        refuse(`database operation lock is already held: ${lockName}`);
      }
      locks.push(lockName);
    }

    const actualDatabase = await scalar(input.client, "SELECT current_database() AS value");
    if (actualDatabase !== input.identity.database) {
      refuse("SQL connection database differs from the verified target identity");
    }
    await verifyMigrationLedger(input.client, input.migrationsDirectory);

    const actualTables = (
      await input.client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
      )
    ).rows.map((row) => row.tablename);
    assertExactTableClassification(actualTables);
    await verifyForeignKeys(input.client);
    await verifySequenceClassification(input.client);

    const resetTables = [...resetManifest.wipe, ...resetManifest.derivedReseed];
    const rowsBefore = await tableCounts(input.client, resetTables);
    const protectedBefore = await protectedSnapshot(input.client);

    if (input.dryRun) {
      return receipt(input, rowsBefore, protectedBefore, protectedBefore, null);
    }
    if (!input.createBackup) refuse("backup creation is required for a real reset");
    const backupPath = await input.createBackup();
    if (!backupPath) refuse("backup creation did not return a verified path");

    await input.client.query("BEGIN");
    transactionOpen = true;
    await input.client.query("SET LOCAL lock_timeout = '30s'");
    await input.client.query("SET LOCAL statement_timeout = '180s'");
    await input.client.query("LOCK TABLE market_venues, market_venue_controls IN ACCESS EXCLUSIVE MODE");
    const invalidGlobalVenue = await input.client.query(
      "SELECT 1 FROM market_venues WHERE venue_key='global' AND (city_id IS NOT NULL OR market_structure_id IS NOT NULL)"
    );
    if (invalidGlobalVenue.rowCount !== 0) refuse("legacy global market venue has gameplay ownership");
    const globalMarket = (await input.client.query<{ venues: string; controls: string }>(`
      SELECT
        (SELECT coalesce(json_agg(venue ORDER BY venue_id), '[]'::json)::text
         FROM market_venues venue WHERE venue_key='global') AS venues,
        (SELECT coalesce(json_agg(controls ORDER BY controls.venue_id), '[]'::json)::text
         FROM market_venue_controls controls
         JOIN market_venues venue USING (venue_id) WHERE venue.venue_key='global') AS controls
    `)).rows[0]!;
    await input.client.query(
      `TRUNCATE TABLE ${resetTables.map(quoteIdentifier).join(", ")} RESTART IDENTITY`
    );
    for (const sequence of standaloneResetSequences) {
      await input.client.query(`ALTER SEQUENCE ${quoteIdentifier(sequence)} RESTART WITH 1`);
    }
    await reseedDerivedTables(input.client);
    await input.client.query(
      "INSERT INTO market_venues SELECT * FROM json_populate_recordset(NULL::market_venues, $1::json)",
      [globalMarket.venues]
    );
    const restoreOperator = `reset-test-data:${input.releaseSha ?? "unversioned"}`;
    const restoreReason = "restore preserved global market configuration after gameplay reset";
    await setMarketControlAuditContext(input.client, {
      operatorIdentity: restoreOperator,
      reason: restoreReason
    });
    await input.client.query(
      "INSERT INTO market_venue_controls SELECT * FROM json_populate_recordset(NULL::market_venue_controls, $1::json)",
      [globalMarket.controls]
    );

    const rowsAfter = await tableCounts(input.client, resetManifest.wipe);
    const nonempty = Object.entries(rowsAfter).filter(([, count]) => count !== 0);
    if (nonempty.length > 0) {
      throw new Error(
        `reset tables are not empty: ${nonempty.map(([table]) => table).join(", ")}`
      );
    }
    const derivedRows = await tableCounts(input.client, resetManifest.derivedReseed);
    if (derivedRows.chat_channels !== 4 || derivedRows.chat_channel_sequences !== 4) {
      throw new Error("derived chat catalog reseed did not produce exactly four canonical rows");
    }
    const restoredAudit = await input.client.query<{ valid: boolean }>(`
      SELECT
        (SELECT count(*) FROM market_audit_events) =
        (SELECT count(*) FROM market_venue_controls WHERE frozen OR sensitive_reason IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM market_audit_events audit
          LEFT JOIN market_venue_controls controls USING (venue_id)
          LEFT JOIN market_venues venue USING (venue_id)
          WHERE venue.venue_key IS DISTINCT FROM 'global'
            OR audit.severity <> 'warning' OR audit.event_type <> 'market_control_changed'
            OR audit.player_id IS NOT NULL OR audit.book_id IS NOT NULL
            OR audit.evidence IS DISTINCT FROM jsonb_build_object(
              'operatorIdentity', $1::text, 'reason', $2::text, 'incidentId', NULL,
              'targetScope', jsonb_build_object('type', 'venue', 'id', venue.venue_id),
              'priorState', NULL,
              'resultingState', jsonb_build_object('frozen', controls.frozen, 'sensitiveReason', controls.sensitive_reason)
            )
        ) AS valid
    `, [restoreOperator, restoreReason]);
    if (restoredAudit.rows[0]?.valid !== true) {
      throw new Error("global market restoration audit does not match preserved controls");
    }
    const protectedAfter = await protectedSnapshot(input.client);
    if (derivedRows.market_venues !== protectedAfter.global_market_venues?.rows ||
        derivedRows.market_venue_controls !== protectedAfter.global_market_venue_controls?.rows) {
      throw new Error("regional market configuration remained after gameplay reset");
    }
    assertProtectedUnchanged(protectedBefore, protectedAfter);
    await verifyMigrationLedger(input.client, input.migrationsDirectory);
    await input.client.query("COMMIT");
    transactionOpen = false;
    return receipt(input, rowsBefore, protectedBefore, protectedAfter, backupPath);
  } catch (error) {
    if (transactionOpen) {
      await input.client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    for (const lockName of locks.reverse()) {
      await input.client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [lockName]
      ).catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) refuse("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  const identity = databaseIdentity(url);
  const rehearsal = process.env.ASH_ATLAS_RESET_REHEARSAL === "1";
  verifyTargetIdentity(identity, rehearsal);
  if (!args.dryRun) {
    validateRealResetAuthorization(args.confirmation, process.env);
  }

  process.stdout.write(`${JSON.stringify({
    event: "ash_atlas_test_data_reset_target",
    dryRun: args.dryRun,
    database: identity
  })}\n`);

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "ash-atlas-test-data-reset"
  });
  await client.connect();
  try {
    const repoRoot = findRepoRoot();
    const backupAcknowledgment = process.env.TEST_DATA_RESET_BACKUP_ACK_PATH;
    const receipt = await executeReset({
      client,
      identity,
      migrationsDirectory: path.join(repoRoot, "db", "migrations"),
      dryRun: args.dryRun,
      releaseSha: process.env.RUNTIME_SHA ?? null,
      ...(args.dryRun
        ? {}
        : {
            createBackup: async () =>
              verifiedRemoteBackupPath(
                identity,
                process.env.RUNTIME_SHA ?? null,
                backupAcknowledgment
              )
          }),
      now: () => new Date()
    });

    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return;
    }
    const receiptDirectory =
      process.env.TEST_DATA_RESET_RECEIPT_DIR ?? "/var/lib/ash-atlas/gameplay-resets";
    const receiptPath = writeReceipt(receipt, receiptDirectory);
    process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

function parseArguments(argv: readonly string[]): {
  dryRun: boolean;
  confirmation?: string;
} {
  let dryRun = false;
  let confirmation: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (dryRun) refuse("--dry-run may be supplied only once");
      dryRun = true;
      continue;
    }
    if (argument === "--confirm") {
      if (confirmation !== undefined) refuse("--confirm may be supplied only once");
      confirmation = argv[index + 1];
      if (!confirmation || confirmation.startsWith("--")) {
        refuse("--confirm requires the exact confirmation phrase");
      }
      index += 1;
      continue;
    }
    refuse(`unknown argument: ${argument}`);
  }
  if (dryRun === (confirmation !== undefined)) {
    refuse("choose exactly one of --dry-run or --confirm <phrase>");
  }
  return confirmation === undefined
    ? { dryRun }
    : { dryRun, confirmation };
}

function databaseIdentity(url: URL): ResetIdentity {
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database) refuse("DATABASE_URL does not name a database");
  return {
    host: url.hostname,
    port: Number(url.port || "5432"),
    database
  };
}

function verifyTargetIdentity(identity: ResetIdentity, rehearsal: boolean): void {
  if (/(?:^|_)(?:world|map)(?:_|$)/iu.test(identity.database)) {
    refuse("target database appears to be a World or map database");
  }
  if (rehearsal) {
    if (!["127.0.0.1", "localhost"].includes(identity.host)) {
      refuse("rehearsal resets require local PostgreSQL");
    }
    if (!identity.database.startsWith("ash_atlas_stability")) {
      refuse("rehearsal database must begin with ash_atlas_stability");
    }
    return;
  }
  if (process.platform !== "linux") refuse("real test-server resets require Linux");
  if (process.env.ASH_ATLAS_DEPLOYMENT_ROLE !== "test-server") {
    refuse("ASH_ATLAS_DEPLOYMENT_ROLE must identify the test server");
  }
  if (identity.database !== PUBLIC_TEST_DATABASE) {
    refuse(`test-server database must be exactly ${PUBLIC_TEST_DATABASE}`);
  }
  if (
    process.env.RUNTIME_LABEL !== "production" ||
    process.env.RUNTIME_BRANCH !== "master" ||
    !/^[a-f0-9]{40}$/u.test(process.env.RUNTIME_SHA ?? "")
  ) {
    refuse("runtime label, branch, or immutable SHA does not match the deployed test server");
  }
  const currentRelease = realpathSync("/srv/ash-atlas/game/current");
  if (path.basename(currentRelease) !== process.env.RUNTIME_SHA) {
    refuse("RUNTIME_SHA differs from the active immutable game release");
  }
  if (process.env.WORLD_API_BASE !== "http://127.0.0.1:8765") {
    refuse("World API identity is not the protected loopback service");
  }
  const gameState = command("systemctl", [
    "show",
    "ash-atlas.service",
    "--property=ActiveState",
    "--value"
  ]);
  const gamePid = command("systemctl", [
    "show",
    "ash-atlas.service",
    "--property=MainPID",
    "--value"
  ]);
  if (gameState !== "inactive" || gamePid !== "0") {
    refuse("Ash Atlas game service must be fully stopped before reset");
  }
  if (spawnSync("systemctl", ["is-active", "--quiet", "ash-atlas-world.service"]).status !== 0) {
    refuse("Ash Atlas World service must remain active");
  }
}

async function verifyMigrationLedger(
  client: pg.Client,
  migrationsDirectory: string
): Promise<void> {
  const files = loadMigrationFiles(migrationsDirectory);
  const ledger = await client.query<{
    version: string;
    content_sha256: string | null;
  }>("SELECT version, content_sha256 FROM schema_migrations ORDER BY version");
  if (ledger.rows.length !== files.length) {
    refuse(
      `migration ledger has ${ledger.rows.length} rows but deployed code has ${files.length} files`
    );
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const row = ledger.rows[index];
    if (!row || row.version !== file.version || row.content_sha256 !== file.contentSha256) {
      refuse(`migration ledger differs from deployed code at ${file.version}`);
    }
  }
}

function loadMigrationFiles(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((version) => ({
      version,
      contentSha256: createHash("sha256")
        .update(readFileSync(path.join(directory, version), "utf8"), "utf8")
        .digest("hex")
    }));
}

async function verifyForeignKeys(client: pg.Client): Promise<void> {
  const rows = await client.query<{
    child_schema: string;
    child_table: string;
    parent_schema: string;
    parent_table: string;
  }>(`
    SELECT
      child_ns.nspname AS child_schema,
      child.relname AS child_table,
      parent_ns.nspname AS parent_schema,
      parent.relname AS parent_table
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE constraint_row.contype = 'f'
    ORDER BY 1, 2, 3, 4
  `);
  assertForeignKeyClosure(rows.rows.map((row) => ({
    childSchema: row.child_schema,
    childTable: row.child_table,
    parentSchema: row.parent_schema,
    parentTable: row.parent_table
  })));
}

async function verifySequenceClassification(client: pg.Client): Promise<void> {
  const rows = await client.query<{
    sequence_name: string;
    owning_table: string | null;
  }>(`
    SELECT sequence.relname AS sequence_name, owning_table.relname AS owning_table
    FROM pg_class sequence
    JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
    LEFT JOIN pg_depend dependency
      ON dependency.objid = sequence.oid AND dependency.deptype IN ('a', 'i')
    LEFT JOIN pg_class owning_table ON owning_table.oid = dependency.refobjid
    WHERE sequence.relkind = 'S' AND namespace.nspname = 'public'
    ORDER BY sequence.relname
  `);
  const classifiedTables = new Set([
    ...resetManifest.preserve,
    ...resetManifest.wipe,
    ...resetManifest.derivedReseed
  ]);
  const unknownOwned = rows.rows.filter((row) =>
    row.owning_table !== null && !classifiedTables.has(row.owning_table)
  );
  if (unknownOwned.length > 0) {
    refuse(
      `sequences are owned by unclassified tables: ${unknownOwned.map((row) => row.sequence_name).join(", ")}`
    );
  }
  const standalone = rows.rows
    .filter((row) => row.owning_table === null)
    .map((row) => row.sequence_name);
  const unknownStandalone = standalone.filter(
    (sequence) => !standaloneResetSequences.includes(sequence)
  );
  const missingStandalone = standaloneResetSequences.filter(
    (sequence) => !standalone.includes(sequence)
  );
  if (unknownStandalone.length > 0 || missingStandalone.length > 0) {
    refuse(
      "standalone sequence manifest differs: " +
      `unknown=[${unknownStandalone.join(", ")}] missing=[${missingStandalone.join(", ")}]`
    );
  }
}

async function reseedDerivedTables(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO chat_channels (
      id, channel_key, channel_type, display_name, visibility_policy,
      send_access_policy, history_retention_policy, rate_limit_policy,
      moderation_policy, active
    ) VALUES
      (
        '05000000-0000-4000-8000-000000000001', 'public:general', 'public', 'General',
        'authenticated_public_v1', 'authenticated_public_v1', 'bounded_public_v1',
        'public_standard_v1', 'public_chat_v1', true
      ),
      (
        '05000000-0000-4000-8000-000000000002', 'public:trading', 'public', 'Trading',
        'authenticated_public_v1', 'authenticated_public_v1', 'bounded_public_v1',
        'public_trading_v1', 'public_chat_v1', true
      ),
      (
        '05000000-0000-4000-8000-000000000003', 'public:hunting', 'public', 'Hunting',
        'authenticated_public_v1', 'authenticated_public_v1', 'bounded_public_v1',
        'public_standard_v1', 'public_chat_v1', true
      ),
      (
        '05000000-0000-4000-8000-000000000004', 'local:map', 'local', 'Local',
        'authoritative_aoi_v1', 'authenticated_local_v1', 'live_session_v1',
        'public_standard_v1', 'public_chat_v1', true
      );
    INSERT INTO chat_channel_sequences (channel_id, last_sequence)
    SELECT id, 0 FROM chat_channels;
  `);
}

async function tableCounts(
  client: pg.Client,
  tables: readonly string[]
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of tables) {
    result[table] = Number(await scalar(
      client,
      `SELECT count(*)::text AS value FROM ${quoteIdentifier(table)}`
    ));
  }
  return result;
}

async function protectedSnapshot(client: pg.Client): Promise<ProtectedSnapshot> {
  const result: ProtectedSnapshot = {};
  for (const table of resetManifest.preserve) {
    const snapshot = await client.query<{ rows: string; digest: string }>(`
      SELECT
        count(*)::text AS rows,
        md5(COALESCE(string_agg(row_json, E'\\n' ORDER BY row_json), '')) AS digest
      FROM (
        SELECT row_to_json(source_row)::text AS row_json
        FROM ${quoteIdentifier(table)} source_row
      ) rows
    `);
    result[table] = {
      rows: Number(snapshot.rows[0]?.rows ?? "0"),
      digest: snapshot.rows[0]?.digest ?? ""
    };
  }
  const globalMarket = await client.query<{ table_name: string; rows: string; digest: string }>(`
    SELECT 'global_market_venues' AS table_name, count(*)::text AS rows,
      md5(coalesce(string_agg(row_to_json(venue)::text, E'\\n' ORDER BY venue_id), '')) AS digest
    FROM market_venues venue WHERE venue_key='global'
    UNION ALL
    SELECT 'global_market_venue_controls', count(*)::text,
      md5(coalesce(string_agg(row_to_json(controls)::text, E'\\n' ORDER BY controls.venue_id), ''))
    FROM market_venue_controls controls
    JOIN market_venues venue USING (venue_id) WHERE venue.venue_key='global'
  `);
  for (const row of globalMarket.rows) {
    result[row.table_name] = { rows: Number(row.rows), digest: row.digest };
  }
  return result;
}

function assertProtectedUnchanged(
  before: ProtectedSnapshot,
  after: ProtectedSnapshot
): void {
  for (const table of Object.keys(before)) {
    if (
      before[table]?.rows !== after[table]?.rows ||
      before[table]?.digest !== after[table]?.digest
    ) {
      throw new Error(`protected table changed during reset: ${table}`);
    }
  }
}

function receipt(
  input: ExecuteResetInput,
  rowsBefore: Record<string, number>,
  protectedBefore: ProtectedSnapshot,
  protectedAfter: ProtectedSnapshot,
  backupPath: string | null
): ResetReceipt {
  return {
    schemaVersion: 1,
    event: "ash_atlas_test_data_reset",
    dryRun: input.dryRun,
    completedAtUtc: (input.now ?? (() => new Date()))().toISOString(),
    releaseSha: input.releaseSha ?? null,
    database: input.identity,
    backupPath,
    manifest: resetManifest,
    standaloneResetSequences,
    rowsBefore,
    protectedBefore,
    protectedAfter
  };
}

export function verifiedRemoteBackupPath(
  identity: ResetIdentity,
  releaseSha: string | null,
  acknowledgmentPath: string | undefined
): string {
  if (!acknowledgmentPath) {
    refuse("TEST_DATA_RESET_BACKUP_ACK_PATH is required for a real reset");
  }
  const metadata = lstatSync(acknowledgmentPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    refuse("remote backup acknowledgment path is unsafe");
  }
  const acknowledgment = JSON.parse(readFileSync(acknowledgmentPath, "utf8")) as
    Record<string, unknown>;
  const remotePath = acknowledgment.remotePath;
  const backupFileName = acknowledgment.backupFileName;
  const remoteVerifiedAtUtc = acknowledgment.remoteVerifiedAtUtc;
  if (
    acknowledgment.acknowledgmentVersion !== 1 ||
    acknowledgment.event !== "ash_atlas_gameplay_reset_backup_verified" ||
    acknowledgment.database !== identity.database ||
    acknowledgment.releaseSha !== releaseSha ||
    acknowledgment.restoreCatalogVerified !== true ||
    typeof acknowledgment.acknowledgmentId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(acknowledgment.acknowledgmentId) ||
    typeof acknowledgment.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(acknowledgment.sha256) ||
    typeof acknowledgment.bytes !== "number" ||
    !Number.isSafeInteger(acknowledgment.bytes) ||
    acknowledgment.bytes <= 0 ||
    typeof backupFileName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(backupFileName) ||
    typeof remotePath !== "string" ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(remotePath) ||
    remotePath.includes("//") ||
    remotePath.includes("/../") ||
    remotePath.includes("/./") ||
    !remotePath.includes("gameplay-reset") ||
    !remotePath.endsWith(`/${backupFileName}`) ||
    typeof remoteVerifiedAtUtc !== "string" ||
    !Number.isFinite(Date.parse(remoteVerifiedAtUtc))
  ) {
    refuse("remote backup acknowledgment is missing, malformed, or mismatched");
  }
  return remotePath;
}

function writeReceipt(receiptValue: ResetReceipt, directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = receiptValue.releaseSha ?? "unknown-release";
  const fileName = `${receiptValue.completedAtUtc.replaceAll(":", "-")}-${release}.json`;
  const configuredPath = process.env.TEST_DATA_RESET_RECEIPT_PATH;
  const receiptPath = configuredPath ?? path.join(directory, fileName);
  if (
    configuredPath &&
    (
      path.dirname(configuredPath) !== directory ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(path.basename(configuredPath)) ||
      (lstatSync(configuredPath).isSymbolicLink())
    )
  ) {
    refuse("TEST_DATA_RESET_RECEIPT_PATH is outside the protected receipt directory");
  }
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receiptValue, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, receiptPath);
  return receiptPath;
}

function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  for (;;) {
    try {
      readFileSync(path.join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Could not find pnpm-workspace.yaml");
      current = parent;
    }
  }
}

async function scalar(client: pg.Client, sql: string): Promise<string> {
  const result = await client.query<{ value: string }>(sql);
  return String(result.rows[0]?.value ?? "");
}

function command(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${executable} failed while verifying test-server identity`);
  }
  return result.stdout.trim();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error(`unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function refuse(message: string): never {
  throw new Error(`REFUSED: ${message}`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
