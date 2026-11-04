import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const POPULATED_BASELINE_LAST_MIGRATION = "0629_permanent_mine_allocation.sql";
const PRE_FIXTURE_LAST_MIGRATION = "0682_closed_test_telemetry_health.sql";
const DEFERRED_ONBOARDING_MIGRATION = "0680_closed_test_access_onboarding.sql";

describeDatabase("populated retained-data migration compatibility", () => {
  const databaseName = `ash_atlas_stability_populated_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = path.resolve(
    process.env.MIGRATION_RUNNER_TEST_MIGRATIONS_DIRECTORY ??
      path.resolve(process.cwd(), "../../db/migrations")
  );
  let precedingMigrations = "";
  let preOnboardingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let pendingMigrationNames: string[] = [];
  const accountId = randomUUID();
  const inviteeAccountId = randomUUID();
  const legacyDefaultAccountId = randomUUID();
  const newAccountId = randomUUID();
  const dogId = randomUUID();
  const playerId = `populated-${randomUUID()}`;
  const inviteePlayerId = `populated-invitee-${randomUUID()}`;
  const legacyDefaultPlayerId = `populated-default-${randomUUID()}`;
  const playerName = `player-${randomUUID().slice(0, 8)}`;
  const inviteePlayerName = `invitee-${randomUUID().slice(0, 8)}`;
  const legacyDefaultPlayerName = `default-${randomUUID().slice(0, 8)}`;
  const flagId = randomUUID();
  const legacyDefaultFlagId = randomUUID();
  const legacyRadiusJobKey = `legacy-radius:${legacyDefaultFlagId}`;
  const travelInviteId = randomUUID();
  const kingdomId = randomUUID();
  const cityId = randomUUID();
  const repeatableSessionId = randomUUID();
  const legacySessionStartedAt = "2026-01-02T03:04:05.000Z";
  const legacySessionCompletesAt = "2026-01-02T03:04:15.000Z";
  const legacySessionUpdatedAt = "2026-01-02T04:05:06.000Z";

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-stability-populated-"));
    preOnboardingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-stability-pre-onboarding-")
    );
    const allMigrationNames = (await readdir(repoMigrations)).filter((name) => name.endsWith(".sql")).sort();
    const migrationNames = allMigrationNames.filter((name) => name <= POPULATED_BASELINE_LAST_MIGRATION);
    pendingMigrationNames = allMigrationNames.filter((name) => name > POPULATED_BASELINE_LAST_MIGRATION);
    for (const name of migrationNames) {
      await copyFile(path.join(repoMigrations, name), path.join(precedingMigrations, name));
    }
    for (const name of allMigrationNames) {
      if (
        name <= PRE_FIXTURE_LAST_MIGRATION &&
        name !== DEFERRED_ONBOARDING_MIGRATION
      ) {
        await copyFile(path.join(repoMigrations, name), path.join(preOnboardingMigrations, name));
      }
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRepresentativeGameplay(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
    if (preOnboardingMigrations) {
      await rm(preOnboardingMigrations, { recursive: true, force: true });
    }
  });

  it("applies pending migrations over populated gameplay without trigger failures or data loss", async () => {
    expect(pendingMigrationNames).toEqual(expect.arrayContaining([
      "0630_flag_resource_spawn_allowances.sql",
      "0631_finite_resource_history_guards.sql",
      "0632_flag_resource_generation_resets.sql",
      "0633_expire_inactive_flag_resources.sql",
      "0638_repeatable_resource_session_durations.sql",
      "0643_city_mayoral_control.sql",
      "0644_city_membership_lifecycle.sql",
      "0671_population_v2_generation_lifecycle.sql",
      "0672_inventory_slots.sql",
      "0673_inventory_slot_controls.sql",
      "0680_closed_test_access_onboarding.sql",
      "0699_sap_crawler_population.sql"
    ]));
    // Every future migration is automatically included in this populated upgrade run. Advancing
    // the baseline requires extending the representative fixture and post-upgrade assertions.
    const preOnboardingMigrationNames = pendingMigrationNames.filter(
      (name) =>
        name <= PRE_FIXTURE_LAST_MIGRATION &&
        name !== DEFERRED_ONBOARDING_MIGRATION
    );
    const postFixtureMigrationNames = pendingMigrationNames.filter(
      (name) =>
        name === DEFERRED_ONBOARDING_MIGRATION ||
        name > PRE_FIXTURE_LAST_MIGRATION
    );
    await expect(
      runMigrations(databaseUrl, { migrationsDirectory: preOnboardingMigrations })
    ).resolves.toEqual(preOnboardingMigrationNames);
    await seedPreOnboardingState(pool);
    await expect(
      runMigrations(databaseUrl, { migrationsDirectory: repoMigrations })
    ).resolves.toEqual(postFixtureMigrationNames);
    const combinedExpected = [
      "0681_closed_test_telemetry.sql",
      "0682_closed_test_telemetry_health.sql",
      "0680_closed_test_access_onboarding.sql"
    ].filter((name) => pendingMigrationNames.includes(name));
    const combinedLedger = await pool.query<{
      version: string;
      content_sha256: string;
    }>(
      `SELECT version, content_sha256
       FROM schema_migrations
       WHERE version = ANY($1::text[])
       ORDER BY version`,
      [combinedExpected]
    );
    expect(combinedLedger.rows.map(({ version }) => version)).toEqual(
      [...combinedExpected].sort()
    );
    expect(new Set(
      combinedLedger.rows.map(({ content_sha256 }) => content_sha256)
    ).size).toBe(combinedExpected.length);

    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM accounts WHERE id = $1) AS accounts,
         (SELECT count(*)::int FROM players WHERE id = $2) AS players,
         (SELECT count(*)::int FROM flags WHERE id = $3) AS flags,
         (SELECT count(*)::int FROM player_inventory WHERE player_id = $2) AS inventory,
         (SELECT count(*)::int FROM kingdoms WHERE id = $4) AS kingdoms,
         (SELECT count(*)::int FROM cities WHERE id = $5) AS cities,
         (SELECT count(*)::int FROM account_dogs WHERE id = $6) AS dogs`,
      [accountId, playerId, flagId, kingdomId, cityId, dogId]
    )).resolves.toMatchObject({
      rows: [{
        accounts: 1,
        players: 1,
        flags: 1,
        inventory: 1,
        kingdoms: 1,
        cities: 1,
        dogs: 0
      }]
    });
    await expect(pool.query(
      `SELECT
         count(*) FILTER (WHERE test_access_status = 'approved')::int AS approved_accounts,
         (
           SELECT count(*)::int
           FROM test_access_events event
           WHERE event.event_type = 'existing_account_backfilled'
             AND event.target_account_id = ANY($1::uuid[])
         ) AS backfill_events
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[accountId, inviteeAccountId, legacyDefaultAccountId]]
    )).resolves.toMatchObject({
      rows: [{ approved_accounts: 3, backfill_events: 3 }]
    });
    await pool.query(
      "INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'new')",
      [newAccountId]
    );
    await expect(pool.query(
      "SELECT test_access_status FROM accounts WHERE id = $1",
      [newAccountId]
    )).resolves.toMatchObject({ rows: [{ test_access_status: "pending" }] });
    await expect(pool.query(
      `SELECT username, personal_flag_color,
              initial_spawn_latitude = lat AS latitude_retained,
              initial_spawn_longitude = lon AS longitude_retained,
              initial_spawn_algorithm_version
       FROM players
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[playerId, inviteePlayerId, legacyDefaultPlayerId]]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        {
          username: playerName,
          personal_flag_color: "blue",
          latitude_retained: true,
          longitude_retained: true,
          initial_spawn_algorithm_version: "legacy-existing-v1"
        },
        {
          username: inviteePlayerName,
          personal_flag_color: "blue",
          latitude_retained: true,
          longitude_retained: true,
          initial_spawn_algorithm_version: "legacy-existing-v1"
        },
        {
          username: legacyDefaultPlayerName,
          personal_flag_color: "blue",
          latitude_retained: true,
          longitude_retained: true,
          initial_spawn_algorithm_version: "legacy-existing-v1"
        }
      ])
    });
    await expect(pool.query(
      "SELECT original_personal_color FROM flags WHERE id = $1",
      [flagId]
    )).resolves.toMatchObject({
      rows: [{ original_personal_color: "#3366cc" }]
    });
    await expect(pool.query(
      `SELECT control_type, original_personal_color
       FROM flags
       WHERE city_id = $1
       ORDER BY created_at, id
       LIMIT 1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        control_type: expect.stringMatching(/^city(?:_seat)?$/) as string,
        original_personal_color: null
      }]
    });
    await expect(pool.query(
      `SELECT account_id, personality, name, adopted_at
       FROM account_dogs WHERE id = $1`,
      [dogId]
    )).resolves.toMatchObject({
      // Migration 0786 is the deliberate, user-authorized exception to retained Dog data.
      rows: []
    });
    await expect(pool.query(
      `SELECT capacity.unlocked_slots,
              count(slot.stack_id)::int AS stack_count,
              sum(slot.quantity)::int AS total_quantity,
              max(slot.quantity)::int AS largest_stack,
              bool_and(slot.manual_split = false) AS all_automatic,
              max(slot.slot_index)::int AS largest_slot_index
       FROM player_inventory_capacities capacity
       JOIN legacy_player_inventory_slots slot ON slot.player_id = capacity.player_id
       WHERE capacity.player_id = $1
       GROUP BY capacity.unlocked_slots`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{
        unlocked_slots: 40,
        stack_count: 17,
        total_quantity: 4250,
        largest_stack: 250,
        all_automatic: true,
        largest_slot_index: 16
      }]
    });
    await expect(pool.query(
      `SELECT
         to_regclass('public.flag_resource_spawn_allowances') IS NOT NULL
           AS has_flag_resource_spawn_allowances,
         to_regclass('public.flag_resource_spawn_events') IS NOT NULL
           AS has_flag_resource_spawn_events,
         to_regclass('public.environmental_population_areas') IS NOT NULL
           AS has_environmental_population_areas,
         to_regclass('public.population_zones_v2') IS NOT NULL
           AS has_population_zones_v2,
         to_regclass('public.population_zone_generations_v2') IS NOT NULL
           AS has_population_zone_generations_v2,
         to_regclass('public.population_spawn_slots_v2') IS NOT NULL
           AS has_population_spawn_slots_v2`
    )).resolves.toMatchObject({
      rows: [{
        has_flag_resource_spawn_allowances: false,
        has_flag_resource_spawn_events: false,
        has_environmental_population_areas: false,
        has_population_zones_v2: true,
        has_population_zone_generations_v2: true,
        has_population_spawn_slots_v2: true
      }]
    });
    await expect(pool.query(
       `SELECT p.move_leash_radius_m,
               p.resource_vision_center_lat,
               p.resource_vision_center_lon,
               f.claim_radius_m,
              f.resource_vision_radius_m,
              vision.radius_m AS persisted_vision_radius_m,
              vision.status AS persisted_vision_status,
              job.status AS stale_job_status,
              job.next_retry_at AS stale_job_next_retry_at
       FROM players p
       JOIN flags f ON f.owner_id = p.id
       JOIN flag_resource_visions vision ON vision.flag_id = f.id
       JOIN resource_vision_jobs job ON job.flag_id = f.id
       WHERE p.id = $1`,
      [legacyDefaultPlayerId]
    )).resolves.toMatchObject({
      rows: [{
         move_leash_radius_m: 600,
         resource_vision_center_lat: 35.51,
         resource_vision_center_lon: -106.51,
        claim_radius_m: 500,
        resource_vision_radius_m: 650,
        persisted_vision_radius_m: 650,
        persisted_vision_status: "pending",
        stale_job_status: "completed",
        stale_job_next_retry_at: null
      }]
    });
    await expect(pool.query(
      `SELECT p.move_leash_radius_m, f.claim_radius_m
       FROM players p JOIN flags f ON f.owner_id = p.id
       WHERE p.id = $1 AND f.id = $2`,
      [playerId, flagId]
    )).resolves.toMatchObject({
      rows: [{ move_leash_radius_m: 900, claim_radius_m: 100 }]
    });
    await expect(pool.query(
      `SELECT city.founder_player_id, city.mayor_player_id,
              membership.world_id, membership.role, membership.left_at,
              membership.ended_reason
       FROM cities city
       JOIN city_memberships membership
         ON membership.city_id = city.id
        AND membership.player_id = city.founder_player_id
       WHERE city.id = $1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{
        founder_player_id: playerId,
        mayor_player_id: null,
        world_id: "main",
        role: "founder",
        left_at: expect.any(Date),
        ended_reason: "city_house_authority_reset"
      }]
    });

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN (
         'collectible_nodes_population_v2_owner_complete',
         'generated_world_mobs_population_owner_complete',
         'repeatable_resource_nodes_population_v2_owner_complete',
         'repeatable_resource_nodes_stone_mine_interval_check',
         'population_entity_state_v2_event_shape',
         'population_spawn_slots_v2_lifecycle_shape',
         'population_zone_cutovers_v2_v2_only',
         'flag_resource_spawn_allowances_pkey',
         'flag_resource_spawn_events_pkey'
       ) ORDER BY conname`
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "collectible_nodes_population_v2_owner_complete",
      "generated_world_mobs_population_owner_complete",
      "population_entity_state_v2_event_shape",
      "population_spawn_slots_v2_lifecycle_shape",
      "population_zone_cutovers_v2_v2_only",
      "repeatable_resource_nodes_population_v2_owner_complete",
      "repeatable_resource_nodes_stone_mine_interval_check"
    ]);
    const triggers = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
         'flags_initialize_resource_spawn_allowance',
         'flags_deactivate_resource_spawn_allowance',
         'flag_resource_spawn_events_immutable',
         'population_entity_state_v2_validate_lifecycle',
         'population_zones_v2_protect_ready',
         'population_spawn_slots_v2_protect_ready',
         'population_spawn_slots_v2_enforce_generation_cap'
       ) ORDER BY tgname`
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "population_entity_state_v2_validate_lifecycle",
      "population_spawn_slots_v2_enforce_generation_cap",
      "population_spawn_slots_v2_protect_ready",
      "population_zones_v2_protect_ready"
    ]);

    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM repeatable_resource_sessions
       WHERE id = $1`,
      [repeatableSessionId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query(
      `SELECT data_type,is_nullable,column_default
       FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='repeatable_resource_sessions'
         AND column_name='effective_duration_ms'`
    )).resolves.toMatchObject({
      rows: [{ data_type: "bigint", is_nullable: "NO", column_default: null }]
    });
    await expect(pool.query(
      `SELECT status, invalidation_reason, source_flag_id, layer_scope_id, layer_id,
              layer_relocation_revision, layer_generation, source_type, source_id,
              responded_at IS NOT NULL AS responded
       FROM travel_invites
       WHERE id = $1`,
      [travelInviteId]
    )).resolves.toMatchObject({
      rows: [{
        status: "invalidated",
        invalidation_reason: "The inviter gameplay layer must be reconfirmed.",
        source_flag_id: flagId,
        layer_scope_id: "world",
        layer_id: `flag:${flagId}`,
        layer_relocation_revision: "0",
        layer_generation: "0",
        source_type: "flag",
        source_id: flagId,
        responded: true
      }]
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM player_inbox_entries
       WHERE travel_invite_id = $1`,
      [travelInviteId]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    const sapCrawlerConstraints = await pool.query<{
      table_name: string;
      definition: string;
    }>(
      `SELECT conrelid::regclass::text AS table_name,
              pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         'generated_world_mobs'::regclass,
         'population_spawn_slots_v2'::regclass
       )
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%sap_crawler%'
       ORDER BY conrelid::regclass::text, conname`
    );
    expect(new Set(sapCrawlerConstraints.rows.map(
      ({ table_name }) => table_name
    ))).toEqual(new Set(["generated_world_mobs"]));

    await expect(
      runMigrations(databaseUrl, { migrationsDirectory: repoMigrations })
    ).resolves.toEqual([]);
  }, 30_000);

  async function seedPreOnboardingState(queryable: pg.Pool): Promise<void> {
    const client = await queryable.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE flags SET original_personal_color = '#000000' WHERE id = $1",
        [flagId]
      );
      const cityFlag = await client.query<{ id: string }>(
        `SELECT id FROM flags
         WHERE city_id = $1 AND control_type IN ('city', 'city_seat')
         ORDER BY created_at, id
         LIMIT 1
         FOR UPDATE`,
        [cityId]
      );
      const cityFlagId = cityFlag.rows[0]?.id;
      if (!cityFlagId) {
        throw new Error("populated migration fixture did not produce a city-controlled flag");
      }
      await client.query(
        "UPDATE flags SET original_personal_color = '#000000' WHERE id = $1",
        [cityFlagId]
      );
      await client.query(
        `INSERT INTO account_dogs (
           id, account_id, personality, name, gender, breed,
           country_code, country_name, adopted_at, care_reconciled_through,
           explore_available_at
         ) VALUES (
           $1, $2, 'Loyal', 'Milo', 'male', 'Labrador Retriever',
           'US', 'United States', $3::timestamptz, $3::date, $3::timestamptz
         )`,
        [dogId, accountId, "2026-01-02T03:04:05.000Z"]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedRepresentativeGameplay(queryable: pg.Pool): Promise<void> {
    const client = await queryable.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')", [accountId]);
      await client.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')", [inviteeAccountId]);
      await client.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')", [legacyDefaultAccountId]);
      await client.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$3,$3,'#38bdf8','NM',35,-106,35,-106,900,false,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId, playerName]
    );
      await client.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$3,$3,'#a78bfa','NM',35,-106,35,-106,900,false,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [inviteePlayerId, inviteeAccountId, inviteePlayerName]
    );
      await client.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$3,$3,'#f59e0b','NM',35.5,-106.5,35.5,-106.5,1250,false,
                 ST_SetSRID(ST_MakePoint(-106.5,35.5),4326))`,
      [legacyDefaultPlayerId, legacyDefaultAccountId, legacyDefaultPlayerName]
    );
      await client.query(
      `INSERT INTO inventory_operations (operation_key, player_id, source, metadata)
       VALUES ($1,$2,'populated_migration_fixture','{}'::jsonb)`,
      [`fixture:${playerId}`, playerId]
    );
      await client.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
       VALUES ($1,'wood','default',4250,1)`,
      [playerId]
    );
      await client.query(
      `INSERT INTO inventory_events (
         operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
         version_after, source, metadata
       ) VALUES ($1,$2,'wood','default',4250,4250,1,'populated_migration_fixture','{}'::jsonb)`,
      [`fixture:${playerId}`, playerId]
    );
      await client.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Populated Migration Flag',35,-106,100,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [flagId, playerId]
    );
      await client.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Legacy Default Radius Flag',35.51,-106.51,1000,
               ST_SetSRID(ST_MakePoint(-106.51,35.51),4326))`,
      [legacyDefaultFlagId, legacyDefaultPlayerId]
    );
      await client.query(
        `UPDATE players SET current_flag_id = $2 WHERE id = $1`,
        [legacyDefaultPlayerId, legacyDefaultFlagId]
      );
      await client.query(
        `INSERT INTO flag_resource_visions (
           flag_id, status, radius_m, node_count, water_highlight_count, layout_version
         ) VALUES ($1,'generating',1500,7,3,'resource-layout-v1')`,
        [legacyDefaultFlagId]
      );
      await client.query(
        `INSERT INTO resource_vision_jobs (
           job_key, flag_id, layout_version, radius_m, world_release_id,
           profile_set_fingerprint, build_contract_fingerprint, boundary_release_id,
           reason, priority, payload, status, next_retry_at
         ) VALUES (
           $1,$2,'resource-layout-v1',1500,'legacy-world',
           repeat('a',64),repeat('b',64),'legacy-boundary',
           'flag-created',1,'{}'::jsonb,'pending',now()
         )`,
        [legacyRadiusJobKey, legacyDefaultFlagId]
      );
      await client.query(
      `INSERT INTO repeatable_resource_sessions (
         id,player_id,node_id,resource_type,operation_key,starting_revision,
         status,started_at,completes_at,expires_at,updated_at
       ) VALUES (
         $1,$2,'00000000-0000-4000-8000-000000000616','stone',$3,0,
         'expired',$4::timestamptz,$5::timestamptz,
         $5::timestamptz + interval '1 minute',$6::timestamptz
       )`,
      [
        repeatableSessionId,
        playerId,
        `populated-session:${repeatableSessionId}`,
        legacySessionStartedAt,
        legacySessionCompletesAt,
        legacySessionUpdatedAt
      ]
    );
      await client.query(
        `INSERT INTO travel_invites (
           id, inviter_player_id, invitee_player_id, inviter_session_id, source_flag_id,
           destination_anchor_lat, destination_anchor_lon, create_request_id,
           created_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,35,-106,'populated-travel-invite',
                   '2026-01-02T03:04:05.000Z'::timestamptz,
                   '2026-01-02T03:14:05.000Z'::timestamptz)`,
        [travelInviteId, playerId, inviteePlayerId, randomUUID(), flagId]
      );
      await client.query(
        `INSERT INTO player_inbox_entries (
           id, player_id, travel_invite_id, perspective, message, created_at
         ) VALUES
           ($1,$2,$3,'sender','Legacy sender invite','2026-01-02T03:04:05.000Z'),
           ($4,$5,$3,'recipient','Legacy recipient invite','2026-01-02T03:04:05.000Z')`,
        [randomUUID(), playerId, travelInviteId, randomUUID(), inviteePlayerId]
      );
      await client.query(
      `INSERT INTO kingdoms (
         id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id
       ) VALUES ($1,$2,'Populated Migration Kingdom',$3,$3,$4)`,
      [kingdomId, `populated-${kingdomId.slice(0, 8)}`, playerId, `found-${kingdomId}`]
    );
      await client.query(
      `INSERT INTO cities (
         id, world_settlement_id, world_settlement_source, world_source_settlement_id,
         name, country_code, founder_player_id, founding_request_id,
         hall_lat, hall_lon, hall_geom, founding_annex_radius_m
       ) VALUES ($1,$2,'test',$2,'Populated Migration City','US',$3,$4,36,-107,
                 ST_SetSRID(ST_MakePoint(-107,36),4326),750)`,
      [cityId, `settlement-${cityId}`, playerId, `found-${cityId}`]
      );
      await client.query(
        `INSERT INTO city_memberships (city_id, player_id, role)
         VALUES ($1,$2,'founder')`,
        [cityId, playerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !["postgres:", "postgresql:"].includes(parsed.protocol) || database !== "ash_atlas_stability") {
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must target the local stability lab ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) throw new Error("Unsafe disposable stability database name");
  return `"${value}"`;
}
