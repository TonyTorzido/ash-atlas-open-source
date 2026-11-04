#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { Client } = require("pg");

export const PUBLIC_TEST_DATABASE = "ash_atlas_game";
export const PUBLIC_TEST_RUNTIME_LABEL = "production";
export const DESTRUCTIVE_TOKEN = "YES_DELETE_TEST_GAMEPLAY";
export const RESET_CONFIRMATION = "RESET_ASH_ATLAS_PUBLIC_TEST_WORLD";

export const preservedTables = Object.freeze([
  "account_device_links", "account_identities", "account_risk_events", "accounts",
  "auth_events", "auth_google_credential_uses", "auth_sessions", "device_installations",
  "item_definitions", "kingdom_decoration_definitions", "market_fee_policies",
  "market_global_controls", "market_order_books", "market_venue_controls", "market_venues",
  "schema_migrations", "spatial_ref_sys"
]);

export const resetCategories = Object.freeze({
  players_progression_social: [
    "archived_class_technique_unlocks", "class_operations", "class_progression_operations",
    "dev_progression_operations", "enemy_neutrality_requests", "equipment_audit_events",
    "equipment_instances", "equipment_operations", "equipment_upgrade_operations",
    "friend_requests", "friendships", "mastery_progression_operations", "player_blocks",
    "player_class_legacy_unlocks", "player_class_loadouts", "player_class_profiles",
    "player_class_progress", "player_class_resources", "player_class_runtime",
    "player_class_technique_unlocks", "player_combat_profiles", "player_combat_records",
    "player_direct_message_preferences", "player_discovered_cities", "player_discovered_mines",
    "player_enemy_marks", "player_equipment_state", "player_inbox_entries", "player_inventory",
    "player_mastery_achievements", "player_mastery_state", "player_profession_progress",
    "player_gift_equipment_instances",
    "player_package_campaigns", "player_package_claim_operations", "player_package_items",
    "player_packages",
    "player_profiles", "player_progression_profiles", "player_subclass_loadouts",
    "player_subclass_progress", "players", "recent_player_pair_suppressions", "recent_players",
    "xp_events", "xp_operations"
  ],
  flags_cities_kingdoms_manors: [
    "cities", "city_flag_affiliation_history", "city_memberships", "city_mutations",
    "flag_build_operations", "flags", "kingdom_audit_events", "kingdom_chat_messages",
    "kingdom_chat_mutes", "kingdom_construction_jobs", "kingdom_cots", "kingdom_decorations",
    "kingdom_donations", "kingdom_flag_affiliation_history", "kingdom_invitations",
    "kingdom_memberships", "kingdom_requests", "kingdom_seats", "kingdom_treasury_balances",
    "kingdom_xp_ledger", "kingdoms", "manor_build_operations", "manor_placement_events",
    "manor_placement_operations", "manor_storage_events", "manor_storage_stacks",
    "manor_transfer_operations", "player_manor_presence", "player_manors"
  ],
  population_resources_world_items: [
    "collectible_nodes", "flag_resource_visions", "generated_world_mobs", "harvest_sessions",
    "permanent_mine_allocation_buckets", "population_entity_state_v2",
    "population_plan_permanent_stones_v2", "population_permanent_stone_authority_v2",
    "population_runtime_entity_leases_v2", "population_spawn_slots_v2",
    "population_stone_conflict_repair_receipts_v2",
    "population_zone_cutovers_v2", "population_zone_generations_v2",
    "population_zones_v2", "repeatable_resource_harvests", "repeatable_resource_nodes",
    "repeatable_resource_sessions", "resource_vision_jobs", "spawn_cells",
    "world_environment_cells", "world_environment_profile_jobs", "world_item_drop_requests",
    "world_item_drops", "world_item_movements", "world_item_pickups"
  ],
  combat_equipment_pets: [
    "combat_balance_summaries", "combat_kit_items", "combat_kit_operations", "combat_kits",
    "combat_reward_participants", "combat_reward_settlements", "pet_daily_care",
    "pet_debug_offsets", "pet_debug_operations", "pet_expedition_debug_operations",
    "pet_expedition_discoveries", "pet_expedition_preferences", "pet_expedition_profiles",
    "pet_expedition_training_choices", "pet_expeditions", "pet_memories", "pet_milestones",
    "pet_owner_audit_events", "pet_view_preferences", "player_pets"
  ],
  chat_parties_travel: [
    "chat_channel_read_states", "chat_channel_sequences", "chat_channels", "chat_messages",
    "chat_moderation_decisions", "chat_mutes", "direct_conversation_participants",
    "direct_conversations", "direct_message_event_cursors", "direct_message_events",
    "direct_message_rate_windows", "parties", "party_invites", "party_members",
    "party_operations", "travel_invite_operations", "travel_invites"
  ],
  economy_and_operations: [
    "inventory_events", "inventory_operations", "market_audit_events", "market_claims",
    "market_collections", "market_ledger_entries", "market_ledger_groups", "market_order_escrows",
    "market_orders", "market_player_controls", "market_quote_requests", "market_quotes",
    "market_rate_windows", "market_requests", "market_trades", "player_wallets",
    "player_water_collection_cadence", "wallet_events", "water_collection_operations"
  ]
});

export const resetTables = Object.freeze(Object.values(resetCategories).flat());

function fail(message) {
  throw new Error(`REFUSED: ${message}`);
}

export function validateResetGuards(input) {
  const worldLike = /(?:^|_)(?:world|map)(?:_|$)/i.test(input.actualDatabase ?? "");
  if (input.destructiveToken !== DESTRUCTIVE_TOKEN) fail("destructive reset token is absent or incorrect");
  if (input.confirmation !== RESET_CONFIRMATION) fail("typed confirmation token is absent or incorrect");
  if (worldLike) fail("target database appears to be a World database");
  if (input.expectedDatabase !== input.actualDatabase) fail("expected and actual database identities differ");
  if (!input.rehearsal && input.actualDatabase !== PUBLIC_TEST_DATABASE) {
    fail(`public reset target must be exactly ${PUBLIC_TEST_DATABASE}`);
  }
  if (input.rehearsal && !/^ash_atlas_stability[_a-z0-9-]*$/.test(input.actualDatabase)) {
    fail("disposable rehearsal database must begin with ash_atlas_stability");
  }
  if (input.expectedRuntimeLabel !== input.actualRuntimeLabel) fail("runtime labels differ");
  if (!input.rehearsal && input.actualRuntimeLabel !== PUBLIC_TEST_RUNTIME_LABEL) {
    fail(`public test runtime label must be exactly ${PUBLIC_TEST_RUNTIME_LABEL}`);
  }
  if (!/^[a-f0-9]{40}$/.test(input.expectedSha ?? "") || input.expectedSha !== input.actualSha) {
    fail("expected, configured, and deployed SHAs must match exactly");
  }
  if (!input.rehearsal && input.runtimeBranch !== "master") fail("public test runtime branch must be master");
  if (!input.rehearsal && input.gameServiceActive) fail("Game service must be stopped before reset");
  if (!input.rehearsal && !input.worldServiceActive) fail("World service must remain active during reset");
}

export function assertExactTableClassification(actualTables) {
  const duplicates = resetTables.filter((table, index) => resetTables.indexOf(table) !== index);
  if (duplicates.length) fail(`reset manifest contains duplicates: ${[...new Set(duplicates)].join(", ")}`);
  const classified = new Set([...preservedTables, ...resetTables]);
  const unknown = actualTables.filter((table) => !classified.has(table));
  const missing = [...classified].filter((table) => !actualTables.includes(table));
  if (unknown.length) fail(`unclassified public tables: ${unknown.join(", ")}`);
  if (missing.length) fail(`classified public tables are missing: ${missing.join(", ")}`);
}

export function assertForeignKeyClosure(foreignKeys) {
  const reset = new Set(resetTables);
  const unsafe = foreignKeys.filter(({ child, parent }) => reset.has(parent) && !reset.has(child));
  if (unsafe.length) fail(`reset FK closure is incomplete: ${unsafe.map((fk) => `${fk.child}->${fk.parent}`).join(", ")}`);
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`unsafe SQL identifier ${value}`);
  return `"${value}"`;
}

export function buildResetSql({ spawnLat, spawnLon }) {
  const south = Math.min(89, Math.floor(spawnLat));
  const west = Math.min(179, Math.floor(spawnLon));
  const packageId = `world_v1_lat${south}_lon${west}`;
  const zoneId = `world:${packageId}`;
  return `
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '180s';
CREATE TEMP TABLE preserved_player_identities ON COMMIT DROP AS
  SELECT id, username, username_normalized, display_color, account_id, created_at FROM players;
TRUNCATE TABLE ${resetTables.map(quoteIdentifier).join(", ")} RESTART IDENTITY;
INSERT INTO players (
  id, username, username_normalized, display_color, account_id, region_code,
  lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, last_seen_at,
  created_at, updated_at, geom, spatial_package_id, spatial_zone_id,
  current_flag_id, current_kingdom_seat_id
)
SELECT id, username, username_normalized, display_color, account_id, '${packageId}',
  ${spawnLat}, ${spawnLon}, ${spawnLat}, ${spawnLon}, 600, false, now(),
  created_at, now(), ST_SetSRID(ST_MakePoint(${spawnLon}, ${spawnLat}), 4326),
  '${packageId}', '${zoneId}', NULL, NULL
FROM preserved_player_identities;
DO $audit$
BEGIN
  IF EXISTS (SELECT 1 FROM players WHERE move_leash_radius_m <> 600 OR current_flag_id IS NOT NULL OR current_kingdom_seat_id IS NOT NULL OR online) THEN
    RAISE EXCEPTION 'preserved player reset invariant failed';
  END IF;
  IF EXISTS (SELECT 1 FROM flags) OR EXISTS (SELECT 1 FROM flag_resource_visions) OR EXISTS (SELECT 1 FROM population_entity_state_v2) THEN
    RAISE EXCEPTION 'gameplay rows remain after reset';
  END IF;
END
$audit$;
COMMIT;`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) fail(`unknown argument ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${name} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout.trim();
}

function postgresEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGSSLMODE: url.searchParams.get("sslmode") ?? process.env.PGSSLMODE
  };
}

async function tableCounts(tables, client) {
  const sql = tables.map((table) => `SELECT '${table}' AS table_name, count(*)::bigint AS row_count FROM ${quoteIdentifier(table)}`).join(" UNION ALL ") + " ORDER BY 1;";
  const result = await client.query(sql);
  return Object.fromEntries(result.rows.map((row) => [row.table_name, Number(row.row_count)]));
}

function isServiceActive(name) {
  return spawnSync("systemctl", ["is-active", "--quiet", name]).status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rehearsal = process.env.ASH_ATLAS_RESET_REHEARSAL === "YES";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL is required");
  const database = new URL(databaseUrl).pathname.slice(1);
  const expectedSha = args["expected-sha"];
  let deployedSha = process.env.RUNTIME_SHA;
  if (!rehearsal) {
    const releasePath = realpathSync("/srv/ash-atlas/game/current");
    deployedSha = basename(releasePath);
    if (process.env.RUNTIME_SHA !== deployedSha) fail("runtime environment SHA differs from deployed release symlink");
  }
  validateResetGuards({
    destructiveToken: process.env.ALLOW_PUBLIC_TEST_GAMEPLAY_RESET,
    confirmation: args.confirmation,
    expectedDatabase: args["expected-database"],
    actualDatabase: database,
    expectedRuntimeLabel: args["expected-runtime-label"],
    actualRuntimeLabel: process.env.RUNTIME_LABEL,
    expectedSha,
    actualSha: deployedSha,
    runtimeBranch: process.env.RUNTIME_BRANCH,
    gameServiceActive: rehearsal ? false : isServiceActive("ash-atlas.service"),
    worldServiceActive: rehearsal ? true : isServiceActive("ash-atlas-world.service"),
    rehearsal
  });
  if (!rehearsal && process.env.WORLD_API_BASE !== "http://127.0.0.1:8765") {
    fail("World API identity is not the protected loopback service");
  }

  const pgEnv = postgresEnvironment(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const scalar = async (sql) => String((await client.query(sql)).rows[0]?.value ?? "");
  const actualDatabase = await scalar("SELECT current_database() AS value;");
  if (actualDatabase !== database) fail("SQL connection database differs from DATABASE_URL");
  const actualTables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"))
    .rows.map((row) => String(row.tablename));
  assertExactTableClassification(actualTables);
  const foreignKeys = (await client.query(`SELECT child.relname AS child, parent.relname AS parent FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace WHERE c.contype='f' AND child_ns.nspname='public' AND parent_ns.nspname='public' ORDER BY 1;`)).rows;
  assertForeignKeyClosure(foreignKeys);

  const identityBefore = {
    accounts: Number(await scalar("SELECT count(*) AS value FROM accounts;")),
    accountIdentities: Number(await scalar("SELECT count(*) AS value FROM account_identities;")),
    players: Number(await scalar("SELECT count(*) AS value FROM players;")),
    migrationRows: Number(await scalar("SELECT count(*) AS value FROM schema_migrations;"))
  };
  const before = await tableCounts(resetTables, client);
  let snapshot = null;
  if (!rehearsal) {
    const snapshotDirectory = args["snapshot-directory"];
    if (!snapshotDirectory) fail("a snapshot directory is required for the public reset");
    mkdirSync(snapshotDirectory, { recursive: true });
    snapshot = join(snapshotDirectory, `${database}-${new Date().toISOString().replaceAll(":", "-")}-${expectedSha}.dump`);
    command("pg_dump", ["--format=custom", `--file=${snapshot}`], { env: pgEnv });
  }

  const spawnLat = Number(process.env.DEFAULT_SPAWN_LAT ?? "35.0844");
  const spawnLon = Number(process.env.DEFAULT_SPAWN_LON ?? "-106.6504");
  await client.query(buildResetSql({ spawnLat, spawnLon }));
  const after = await tableCounts(resetTables.filter((table) => table !== "players"), client);
  const nonempty = Object.entries(after).filter(([, count]) => count !== 0);
  if (nonempty.length) throw new Error(`post-reset gameplay tables are nonempty: ${nonempty.map(([table]) => table).join(", ")}`);
  const identityAfter = {
    accounts: Number(await scalar("SELECT count(*) AS value FROM accounts;")),
    accountIdentities: Number(await scalar("SELECT count(*) AS value FROM account_identities;")),
    players: Number(await scalar("SELECT count(*) AS value FROM players;")),
    migrationRows: Number(await scalar("SELECT count(*) AS value FROM schema_migrations;"))
  };
  if (JSON.stringify(identityAfter) !== JSON.stringify(identityBefore)) throw new Error("preserved identity or migration counts changed");
  const receipt = {
    schemaVersion: 1,
    completedAtUtc: new Date().toISOString(),
    releaseSha: expectedSha,
    database,
    runtimeLabel: process.env.RUNTIME_LABEL,
    rehearsal,
    snapshot,
    identityBefore,
    identityAfter,
    before,
    after,
    preservedTables,
    resetCategories
  };
  const receiptDirectory = args["receipt-directory"] ?? (rehearsal ? process.cwd() : "/var/lib/ash-atlas/gameplay-resets");
  mkdirSync(receiptDirectory, { recursive: true });
  const receiptPath = join(receiptDirectory, `${expectedSha}-${Date.now()}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await client.end();
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
