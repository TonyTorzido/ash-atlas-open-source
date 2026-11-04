import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { PlayerService } from "./players.js";

const databaseUrl = process.env.KINGDOM_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

const trackedPlayerIds = new Set<string>();
const trackedKingdomIds = new Set<string>();

describeDatabase("Kingdom migration PostgreSQL integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 12 });
  }, 30_000);

  afterEach(async () => {
    await cleanTrackedFixtures(pool);
  });

  afterAll(async () => {
    if (pool) {
      await cleanTrackedFixtures(pool);
      await pool.end();
    }
  });

  it("migrates the Kingdom catalog, PostGIS columns, and active spatial indexes", async () => {
    const migrations = await pool.query<{ version: string }>(
      `SELECT version
       FROM schema_migrations
       WHERE version = ANY($1::text[])
       ORDER BY version`,
      [[
        "0400_kingdom_foundation.sql",
        "0401_kingdom_ledger_immutability.sql",
        "0402_kingdom_foundation_hardening.sql",
        "0403_kingdom_request_retention_index.sql",
        "0404_kingdom_spatial_revision.sql",
        "0405_kingdom_update_1_0_hardening.sql",
        "0406_kingdom_construction_jobs.sql",
        "0620_kingdom_flag_affiliation.sql",
        "0621_kingdom_flag_control.sql",
        "0622_kingdom_seat_source_flag.sql",
        "0623_kingdom_source_flag_territory.sql",
        "0624_personal_flags_use_ordinary_overlap_rules.sql",
        "0625_kingdom_conversion_uses_existing_overlap.sql",
        "0676_kingdom_seat_physical_placement.sql"
      ]]
    );
    expect(migrations.rows.map((row) => row.version)).toEqual([
      "0400_kingdom_foundation.sql",
      "0401_kingdom_ledger_immutability.sql",
      "0402_kingdom_foundation_hardening.sql",
      "0403_kingdom_request_retention_index.sql",
      "0404_kingdom_spatial_revision.sql",
      "0405_kingdom_update_1_0_hardening.sql",
      "0406_kingdom_construction_jobs.sql",
      "0620_kingdom_flag_affiliation.sql",
      "0621_kingdom_flag_control.sql",
      "0622_kingdom_seat_source_flag.sql",
      "0623_kingdom_source_flag_territory.sql",
      "0624_personal_flags_use_ordinary_overlap_rules.sql",
      "0625_kingdom_conversion_uses_existing_overlap.sql",
      "0676_kingdom_seat_physical_placement.sql"
    ]);

    const revisions = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'spatial_revision'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [["kingdom_cots", "kingdom_decorations", "kingdoms"]]
    );
    expect(revisions.rows).toEqual([
      { table_name: "kingdom_cots", is_nullable: "NO" },
      { table_name: "kingdom_decorations", is_nullable: "NO" },
      { table_name: "kingdoms", is_nullable: "NO" }
    ]);

    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [[
        "kingdom_audit_events",
        "kingdom_chat_messages",
        "kingdom_chat_mutes",
        "kingdom_construction_jobs",
        "kingdom_cots",
        "kingdom_decoration_definitions",
        "kingdom_decorations",
        "kingdom_donations",
        "kingdom_invitations",
        "kingdom_flag_affiliation_history",
        "kingdom_memberships",
        "kingdom_requests",
        "kingdom_seats",
        "kingdom_treasury_balances",
        "kingdom_xp_ledger",
        "kingdoms"
      ]]
    );
    expect(tables.rows.map((row) => row.tablename)).toHaveLength(16);

    const geometryColumns = await pool.query<{
      f_table_name: string;
      srid: number;
      type: string;
    }>(
      `SELECT f_table_name, srid, type
       FROM geometry_columns
       WHERE f_table_schema = 'public' AND f_table_name = ANY($1::text[])
       ORDER BY f_table_name`,
      [["kingdom_cots", "kingdom_decorations", "kingdom_seats"]]
    );
    expect(geometryColumns.rows).toEqual([
      { f_table_name: "kingdom_cots", srid: 4326, type: "POINT" },
      { f_table_name: "kingdom_decorations", srid: 4326, type: "POINT" },
      { f_table_name: "kingdom_seats", srid: 4326, type: "POINT" }
    ]);

    const spatialIndexes = await pool.query<{
      access_method: string;
      index_name: string;
      predicate: string | null;
    }>(
      `SELECT index_class.relname AS index_name,
              access_method.amname AS access_method,
              pg_get_expr(index_catalog.indpred, index_catalog.indrelid) AS predicate
       FROM pg_index AS index_catalog
       JOIN pg_class AS index_class ON index_class.oid = index_catalog.indexrelid
       JOIN pg_am AS access_method ON access_method.oid = index_class.relam
       WHERE index_class.relname = ANY($1::text[])
       ORDER BY index_class.relname`,
      [[
        "kingdom_cots_geom_active_gix",
        "kingdom_cots_geography_active_gix",
        "kingdom_decorations_geom_active_gix",
        "kingdom_decorations_geography_active_gix",
        "kingdom_seats_geom_active_gix",
        "kingdom_seats_geography_active_gix"
      ]]
    );
    expect(spatialIndexes.rows).toHaveLength(6);
    for (const index of spatialIndexes.rows) {
      expect(index.access_method).toBe("gist");
      expect(index.predicate).toContain("status = 'active'::text");
    }

    const replayIndex = await pool.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'kingdom_requests_actor_created_idx'`
    );
    expect(replayIndex.rows[0]?.definition).toContain("(actor_player_id, created_at)");

    const invitationExpiryIndex = await pool.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'kingdom_invitations_pending_expiry_idx'`
    );
    expect(invitationExpiryIndex.rows[0]?.definition).toContain("expires_at");
    expect(invitationExpiryIndex.rows[0]?.definition).toContain("status = 'pending'");

    const kingdomFlagIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [["flags_kingdom_active_idx", "flags_kingdom_geom_gix", "flags_kingdom_owner_idx"]]
    );
    expect(kingdomFlagIndexes.rows.map(({ indexname }) => indexname)).toEqual([
      "flags_kingdom_active_idx",
      "flags_kingdom_geom_gix",
      "flags_kingdom_owner_idx"
    ]);

    const decorationCatalog = await pool.query<{
      active: boolean;
      capacity_cost: number;
      footprint_radius_m: number;
      type_id: string;
    }>(
      `SELECT type_id, footprint_radius_m, capacity_cost, active
       FROM kingdom_decoration_definitions
       WHERE type_id = ANY($1::text[])
       ORDER BY type_id`,
      [["banner", "campfire", "crate", "table", "training_post"]]
    );
    expect(decorationCatalog.rows.map((row) => row.type_id)).toEqual([
      "banner",
      "campfire",
      "crate",
      "table",
      "training_post"
    ]);
    for (const definition of decorationCatalog.rows) {
      expect(definition.active).toBe(true);
      expect(definition.capacity_cost).toBeGreaterThan(0);
      expect(definition.footprint_radius_m).toBeGreaterThan(0);
    }
  });

  it("enforces normalized Kingdom names with a race-safe database unique constraint", async () => {
    const founderA = await createPlayer(pool);
    const founderB = await createPlayer(pool);
    const name = `realm-${randomUUID().slice(0, 8)}`;
    const kingdomA = randomUUID();
    const kingdomB = randomUUID();
    trackedKingdomIds.add(kingdomA);
    trackedKingdomIds.add(kingdomB);

    const attempts = await Promise.allSettled([
      insertKingdom(pool, kingdomA, founderA, name, "First Realm"),
      insertKingdom(pool, kingdomB, founderB, name, "Second Realm")
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "23505" } });

    await expect(
      insertKingdom(pool, randomUUID(), founderB, "Invalid Uppercase", "Invalid Realm")
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows at most one active membership per player across all Kingdoms", async () => {
    const founderA = await createPlayer(pool);
    const founderB = await createPlayer(pool);
    const member = await createPlayer(pool);
    const kingdomA = await createKingdom(pool, founderA);
    const kingdomB = await createKingdom(pool, founderB);
    const membershipA = randomUUID();

    await insertMembership(pool, membershipA, kingdomA, member, "active", null);
    await expect(
      insertMembership(pool, randomUUID(), kingdomB, member, "active", null)
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query(
      `UPDATE kingdom_memberships
       SET status = 'left', ended_at = now(), end_reason = 'integration-test'
       WHERE id = $1`,
      [membershipA]
    );
    await expect(
      insertMembership(pool, randomUUID(), kingdomB, member, "active", null)
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("allows only one active seat per Kingdom and one active cot per player", async () => {
    const founderA = await createPlayer(pool);
    const founderB = await createPlayer(pool);
    const member = await createPlayer(pool);
    const kingdomA = await createKingdom(pool, founderA);
    const kingdomB = await createKingdom(pool, founderB);
    const firstSeat = randomUUID();

    await insertSeat(pool, firstSeat, kingdomA, "active");
    await expect(insertSeat(pool, randomUUID(), kingdomA, "active"))
      .rejects.toMatchObject({ code: "23505" });
    await pool.query(
      "UPDATE kingdom_seats SET status = 'archived', archived_at = now() WHERE id = $1",
      [firstSeat]
    );
    await expect(insertSeat(pool, randomUUID(), kingdomA, "active"))
      .resolves.toMatchObject({ rowCount: 1 });

    const firstCot = randomUUID();
    await insertCot(pool, firstCot, kingdomA, member, "active");
    await expect(insertCot(pool, randomUUID(), kingdomB, member, "active"))
      .rejects.toMatchObject({ code: "23505" });
    await pool.query(
      "UPDATE kingdom_cots SET status = 'packed', archived_at = now() WHERE id = $1",
      [firstCot]
    );
    await expect(insertCot(pool, randomUUID(), kingdomB, member, "active"))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("keeps donations append-only, request-unique, and balance-consistent", async () => {
    const client = await pool.connect();
    const founder = newPlayerId();
    const kingdomId = randomUUID();
    const donationId = randomUUID();
    const requestId = `donate-${randomUUID()}`;

    try {
      await client.query("BEGIN");
      await insertPlayer(client, founder);
      await insertKingdom(client, kingdomId, founder, `realm-${randomUUID().slice(0, 8)}`, "Ledger Realm");
      await insertDonation(client, donationId, kingdomId, founder, requestId);

      await expectConstraintFailure(client, "duplicate_donation", "23505", () =>
        insertDonation(client, randomUUID(), kingdomId, founder, requestId)
      );
      await expectConstraintFailure(client, "invalid_donation_balances", "23514", () =>
        client.query(
          `INSERT INTO kingdom_donations (
             id, kingdom_id, donor_player_id, request_id, resource_type, quantity,
             player_balance_before, player_balance_after,
             treasury_balance_before, treasury_balance_after
           ) VALUES ($1, $2, $3, $4, 'wood', 5, 10, 6, 0, 5)`,
          [randomUUID(), kingdomId, founder, `invalid-${randomUUID()}`]
        )
      );
      await expectConstraintFailure(client, "update_append_only", "55000", () =>
        client.query("UPDATE kingdom_donations SET quantity = 6 WHERE id = $1", [donationId])
      );
      await expectConstraintFailure(client, "delete_append_only", "55000", () =>
        client.query("DELETE FROM kingdom_donations WHERE id = $1", [donationId])
      );

      const retained = await client.query<{ quantity: number }>(
        "SELECT quantity FROM kingdom_donations WHERE id = $1",
        [donationId]
      );
      expect(retained.rows).toEqual([{ quantity: 5 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rejects inconsistent Kingdom, membership, and seat lifecycle states", async () => {
    const founder = await createPlayer(pool);
    const kingdomId = await createKingdom(pool, founder);

    await expect(
      pool.query(
        `UPDATE kingdoms
         SET status = 'dissolved', dissolved_at = NULL
         WHERE id = $1`,
        [kingdomId]
      )
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      insertMembership(pool, randomUUID(), kingdomId, founder, "left", null)
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertMembership(pool, randomUUID(), kingdomId, founder, "active", new Date())
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      insertSeat(pool, randomUUID(), kingdomId, "active", "complete", null)
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertSeat(pool, randomUUID(), kingdomId, "active", "under_construction", new Date())
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps existing flags personal and enforces city/Kingdom affiliation exclusivity", async () => {
    const owner = await createPlayer(pool);
    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Migration Flag',35.0844,-106.6504,100,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
      [flagId, owner]
    );
    await expect(pool.query<{ kingdom_id: string | null; control_type: string }>(
      "SELECT kingdom_id, control_type FROM flags WHERE id = $1", [flagId]
    )).resolves.toMatchObject({ rows: [{ kingdom_id: null, control_type: "personal" }] });

    const kingdomId = await createKingdom(pool, owner);
    await expect(pool.query("UPDATE flags SET kingdom_id = $2 WHERE id = $1", [flagId, kingdomId]))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE flags SET control_type = 'kingdom', kingdom_id = $2,
         kingdom_affiliated_at = now(), kingdom_affiliated_by_player_id = $3,
         original_owner_player_id = owner_id, contributed_by_player_id = $3,
         original_personal_color = '#38bdf8'
       WHERE id = $1`,
      [flagId, kingdomId, owner]
    );
    const cityId = randomUUID();
    const citySeatFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Migration City Center',36.0844,-106.6504,100,
         ST_SetSRID(ST_MakePoint(-106.6504,36.0844),4326))`,
      [citySeatFlagId, owner]
    );
    await pool.query(
      `INSERT INTO cities (
         id, world_id, canonical_municipality_id,
         world_settlement_id, world_settlement_source, world_source_settlement_id,
         name, country_code, founder_player_id, founding_request_id, seat_flag_id,
         hall_lat, hall_lon, hall_geom, founding_annex_radius_m
       ) VALUES ($1,'main',$2,$2,'test',$2,'Migration City','US',$3,$4,$5,
         36.0844,-106.6504,ST_SetSRID(ST_MakePoint(-106.6504,36.0844),4326),100)`,
      [cityId, `settlement-${cityId}`, owner, `found-${cityId}`, citySeatFlagId]
    );
    await pool.query(
      `UPDATE flags
       SET control_type = 'city_seat', city_id = $2,
           city_affiliated_at = now(), city_affiliated_by_player_id = NULL,
           original_owner_player_id = NULL, contributed_by_player_id = NULL,
           original_personal_color = NULL
       WHERE id = $1`,
      [citySeatFlagId, cityId]
    );
    await expect(pool.query("UPDATE flags SET city_id = $2 WHERE id = $1", [flagId, cityId]))
      .rejects.toMatchObject({ code: "23514", constraint: "flags_city_kingdom_exclusive" });

    const newOwner = await createPlayer(pool);
    await expect(pool.query("UPDATE flags SET owner_id = $2 WHERE id = $1", [flagId, newOwner]))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE flags SET owner_id = $2, control_type = 'personal', kingdom_id = NULL,
         kingdom_affiliated_at = NULL, kingdom_affiliated_by_player_id = NULL
       WHERE id = $1`,
      [flagId, newOwner]
    );
    await expect(pool.query<{ owner_id: string; kingdom_id: string | null }>(
      "SELECT owner_id, kingdom_id FROM flags WHERE id = $1", [flagId]
    )).resolves.toMatchObject({ rows: [{ owner_id: newOwner, kingdom_id: null }] });
  });

  it("enforces a unique, geometry-preserving transformed source flag relationship", async () => {
    const owner = await createPlayer(pool);
    const kingdomId = await createKingdom(pool, owner);
    const sourceFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Founding Source',35.0844,-106.6504,275,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
      [sourceFlagId, owner]
    );
    const seatId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE flags
         SET control_type = 'kingdom_seat', kingdom_id = $2,
             kingdom_affiliated_at = now(), original_owner_player_id = owner_id,
             original_personal_color = '#38bdf8'
         WHERE id = $1`,
        [sourceFlagId, kingdomId]
      );
      await insertSeat(client, seatId, kingdomId, "active", "complete", new Date(), sourceFlagId, 275);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(pool.query<{
      source_flag_id: string; territory_radius_m: number; control_type: string;
    }>(
      `SELECT seat.source_flag_id, seat.territory_radius_m, flag.control_type
       FROM kingdom_seats seat JOIN flags flag ON flag.id = seat.source_flag_id
       WHERE seat.id = $1`,
      [seatId]
    )).resolves.toMatchObject({ rows: [{
      source_flag_id: sourceFlagId,
      territory_radius_m: 275,
      control_type: "kingdom_seat"
    }] });

    await expect(pool.query(
      "UPDATE kingdom_seats SET territory_radius_m = 276 WHERE id = $1",
      [seatId]
    )).rejects.toMatchObject({ code: "23514", constraint: "kingdom_seats_source_flag_identity" });
    await expect(pool.query(
      "UPDATE flags SET claim_radius_m = 276 WHERE id = $1",
      [sourceFlagId]
    )).rejects.toMatchObject({ code: "23514", constraint: "flags_kingdom_seat_source_identity" });
    const competingKingdomId = await createKingdom(pool, owner);
    await expect(insertSeat(
      pool, randomUUID(), competingKingdomId, "active", "complete", new Date(), sourceFlagId, 275
    )).rejects.toMatchObject({ code: "23505", constraint: "kingdom_seats_source_flag_unique_idx" });
  });

  it("upgrades a populated archived Seat source for reuse and reruns empty", async () => {
    const owner = await createPlayer(pool);
    const firstKingdomId = await createKingdom(pool, owner);
    const sourceFlagId = randomUUID();
    const firstSeatId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Reusable Founding Source',35.0844,-106.6504,275,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
      [sourceFlagId, owner]
    );
    const firstClient = await pool.connect();
    try {
      await firstClient.query("BEGIN");
      await firstClient.query(
        `UPDATE flags
         SET control_type = 'kingdom_seat', kingdom_id = $2,
             kingdom_affiliated_at = now(), original_owner_player_id = owner_id,
             original_personal_color = '#38bdf8'
         WHERE id = $1`,
        [sourceFlagId, firstKingdomId]
      );
      await insertSeat(
        firstClient, firstSeatId, firstKingdomId, "active", "complete", new Date(), sourceFlagId, 275
      );
      await firstClient.query("COMMIT");
    } catch (error) {
      await firstClient.query("ROLLBACK");
      throw error;
    } finally {
      firstClient.release();
    }
    await pool.query(
      "UPDATE kingdom_seats SET status = 'archived', archived_at = now() WHERE id = $1",
      [firstSeatId]
    );
    await pool.query(
      `UPDATE flags
       SET control_type = 'personal', kingdom_id = NULL,
           kingdom_affiliated_at = NULL, kingdom_affiliated_by_player_id = NULL
       WHERE id = $1`,
      [sourceFlagId]
    );

    await pool.query("DROP INDEX kingdom_seats_source_flag_unique_idx");
    await pool.query(
      `CREATE UNIQUE INDEX kingdom_seats_source_flag_unique_idx
       ON kingdom_seats (source_flag_id) WHERE source_flag_id IS NOT NULL`
    );
    await pool.query(
      "DELETE FROM schema_migrations WHERE version = '0723_reuse_archived_kingdom_seat_sources.sql'"
    );
    await runMigrations(databaseUrl!);

    const secondKingdomId = await createKingdom(pool, owner);
    const secondSeatId = randomUUID();
    const secondClient = await pool.connect();
    try {
      await secondClient.query("BEGIN");
      await secondClient.query(
        `UPDATE flags
         SET control_type = 'kingdom_seat', kingdom_id = $2,
             kingdom_affiliated_at = now(), original_owner_player_id = owner_id,
             original_personal_color = '#38bdf8'
         WHERE id = $1`,
        [sourceFlagId, secondKingdomId]
      );
      await insertSeat(
        secondClient, secondSeatId, secondKingdomId, "active", "complete", new Date(), sourceFlagId, 275
      );
      await secondClient.query("COMMIT");
    } catch (error) {
      await secondClient.query("ROLLBACK");
      throw error;
    } finally {
      secondClient.release();
    }

    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kingdom_seats WHERE source_flag_id = $1",
      [sourceFlagId]
    )).resolves.toMatchObject({ rows: [{ count: "2" }] });
    const sourceIndex = await pool.query<{ predicate: string | null }>(
      `SELECT pg_get_expr(index.indpred, index.indrelid) AS predicate
       FROM pg_index index
       WHERE index.indexrelid = 'kingdom_seats_source_flag_unique_idx'::regclass`
    );
    expect(sourceIndex.rows[0]?.predicate).toContain("status = 'active'::text");

    await runMigrations(databaseUrl!);
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM schema_migrations
       WHERE version = '0723_reuse_archived_kingdom_seat_sources.sql'`
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("persists and reconnects a Castle destination without weakening flag references", async () => {
    const playerId = await createPlayer(pool);
    const kingdomId = await createKingdom(pool, playerId);
    const seatId = randomUUID();
    await insertSeat(pool, seatId, kingdomId, "active");
    const players = new PlayerService(pool, loadConfig({ NODE_ENV: "test" }));
    await players.persistPlayerSnapshot({
      playerId,
      username: `player-${playerId.slice(0, 8)}`,
      displayColor: "#38bdf8",
      regionCode: "NM",
      zoneId: "NM",
      lat: 35.0844,
      lon: -106.6504,
      anchorLat: 35.0844,
      anchorLon: -106.6504,
      moveLeashRadiusM: 900,
      movementRevision: 1,
      relocationRevision: 1,
      targetLat: null,
      targetLon: null,
      moving: false,
      currentFlagId: seatId,
      currentKingdomSeatId: seatId,
      online: true,
      updatedAt: new Date().toISOString()
    });

    await expect(players.loadPlayer(playerId)).resolves.toMatchObject({
      resourceVision: {
        flagId: seatId,
        flagName: "Migration Realm Castle",
        destinationKind: "kingdom_seat",
        center: { lat: 35.0844, lon: -106.6504 }
      }
    });
    await expect(pool.query<{ current_flag_id: string | null; current_kingdom_seat_id: string | null }>(
      "SELECT current_flag_id, current_kingdom_seat_id FROM players WHERE id = $1", [playerId]
    )).resolves.toMatchObject({
      rows: [{ current_flag_id: null, current_kingdom_seat_id: seatId }]
    });

    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Destination Flag',35.1,-106.7,100,
         ST_SetSRID(ST_MakePoint(-106.7,35.1),4326))`,
      [flagId, playerId]
    );
    await expect(pool.query(
      "UPDATE players SET current_flag_id = $2 WHERE id = $1", [playerId, flagId]
    )).rejects.toMatchObject({ code: "23514", constraint: "players_current_destination_exclusive" });
  });

  it("repairs untouched founding absorptions while preserving later Kingdom flag networks", async () => {
    const safeOwner = await createPlayer(pool);
    const safeKingdom = await createKingdom(pool, safeOwner);
    const safeFlag = randomUUID();
    const unsafeOwner = await createPlayer(pool);
    const unsafeKingdom = await createKingdom(pool, unsafeOwner);
    const unsafeAbsorbedFlag = randomUUID();
    const unsafeManualFlag = randomUUID();

    for (const [flagId, ownerId, kingdomId, lat, name] of [
      [safeFlag, safeOwner, safeKingdom, 35.2, "Safe absorbed flag"],
      [unsafeAbsorbedFlag, unsafeOwner, unsafeKingdom, 36.2, "Unsafe absorbed flag"],
      [unsafeManualFlag, unsafeOwner, unsafeKingdom, 36.3, "Later manual flag"]
    ] as const) {
      await pool.query(
        `INSERT INTO flags (
           id, owner_id, name, lat, lon, claim_radius_m, geom,
           control_type, kingdom_id, kingdom_affiliated_at,
           kingdom_affiliated_by_player_id, original_owner_player_id,
           contributed_by_player_id, original_personal_color
         ) VALUES (
           $1,$2,$5,$4,-106.7,100,ST_SetSRID(ST_MakePoint(-106.7,$4),4326),
           'kingdom',$3,now(),$2,$2,$2,'#38bdf8'
         )`,
        [flagId, ownerId, kingdomId, lat, name]
      );
    }
    for (const [flagId, ownerId, kingdomId, reason] of [
      [safeFlag, safeOwner, safeKingdom, "founding_overlap_absorption"],
      [unsafeAbsorbedFlag, unsafeOwner, unsafeKingdom, "founding_overlap_absorption"],
      [unsafeManualFlag, unsafeOwner, unsafeKingdom, "leader_affiliation"]
    ] as const) {
      await pool.query(
        `INSERT INTO kingdom_flag_affiliation_history (
           id, kingdom_id, flag_id, flag_owner_player_id, performed_by_player_id,
           action, reason, resulting_kingdom_id
         ) VALUES ($1,$2,$3,$4,$4,'affiliated',$5,$2)`,
        [randomUUID(), kingdomId, flagId, ownerId, reason]
      );
    }

    await pool.query(
      "DELETE FROM schema_migrations WHERE version = '0722_preserve_kingdom_founding_flags.sql'"
    );
    await runMigrations(databaseUrl!);

    await expect(pool.query<{ control_type: string; kingdom_id: string | null }>(
      "SELECT control_type, kingdom_id FROM flags WHERE id = $1",
      [safeFlag]
    )).resolves.toMatchObject({ rows: [{ control_type: "personal", kingdom_id: null }] });
    await expect(pool.query<{ control_type: string; kingdom_id: string | null }>(
      "SELECT control_type, kingdom_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[unsafeAbsorbedFlag, unsafeManualFlag]]
    )).resolves.toMatchObject({ rows: [
      { control_type: "kingdom", kingdom_id: unsafeKingdom },
      { control_type: "kingdom", kingdom_id: unsafeKingdom }
    ] });
    const repairs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM kingdom_flag_affiliation_history
       WHERE flag_id = $1 AND reason = 'repair_founding_overlap_absorption'`,
      [safeFlag]
    );
    expect(repairs.rows).toEqual([{ count: "1" }]);

    await runMigrations(databaseUrl!);
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM kingdom_flag_affiliation_history
       WHERE flag_id = $1 AND reason = 'repair_founding_overlap_absorption'`,
      [safeFlag]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });
});

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

function newPlayerId(): string {
  const playerId = randomUUID();
  trackedPlayerIds.add(playerId);
  return playerId;
}

async function createPlayer(queryable: Queryable): Promise<string> {
  const playerId = newPlayerId();
  await insertPlayer(queryable, playerId);
  return playerId;
}

async function insertPlayer(queryable: Queryable, playerId: string): Promise<void> {
  await queryable.query(
    `INSERT INTO players (
       id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, online, geom
     ) VALUES ($1, $2, '#38bdf8', 'NM', 35.0844, -106.6504, 35.0844, -106.6504,
               900, false, ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326))`,
    [playerId, `Kingdom migration ${playerId}`]
  );
}

async function createKingdom(queryable: Queryable, founderId: string): Promise<string> {
  const kingdomId = randomUUID();
  trackedKingdomIds.add(kingdomId);
  await insertKingdom(
    queryable,
    kingdomId,
    founderId,
    `realm-${randomUUID().slice(0, 8)}`,
    "Migration Realm"
  );
  return kingdomId;
}

async function insertKingdom(
  queryable: Queryable,
  kingdomId: string,
  founderId: string,
  normalizedName: string,
  displayName: string
): Promise<pg.QueryResult> {
  return queryable.query(
    `INSERT INTO kingdoms (
       id, normalized_name, display_name, founder_player_id, leader_player_id,
       founding_request_id
     ) VALUES ($1, $2, $3, $4, $4, $5)`,
    [kingdomId, normalizedName, displayName, founderId, `found-${kingdomId}`]
  );
}

async function insertMembership(
  queryable: Queryable,
  membershipId: string,
  kingdomId: string,
  playerId: string,
  status: "active" | "left",
  endedAt: Date | null
): Promise<pg.QueryResult> {
  return queryable.query(
    `INSERT INTO kingdom_memberships (
       id, kingdom_id, player_id, role, status, perk_qualified_at, ended_at
     ) VALUES ($1, $2, $3, 'member', $4, now(), $5)`,
    [membershipId, kingdomId, playerId, status, endedAt]
  );
}

async function insertSeat(
  queryable: Queryable,
  seatId: string,
  kingdomId: string,
  status: "active" | "archived",
  constructionState: "complete" | "under_construction" = "complete",
  completedAt: Date | null = new Date(),
  sourceFlagId: string | null = null,
  territoryRadiusM = 200
): Promise<pg.QueryResult> {
  return queryable.query(
    `INSERT INTO kingdom_seats (
       id, kingdom_id, source_flag_id, lat, lon, geom, territory_radius_m,
       is_land, is_saltwater, inside_major_lake,
       environment_rules_version, environment_lookup_at,
       construction_state, completed_under_free_construction,
       status, completed_at, archived_at
     ) VALUES (
       $1, $2, $6, 35.0844, -106.6504,
       ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326), $7,
       true, false, false, 1, now(), $4, true, $3, $5,
       CASE WHEN $3 = 'archived' THEN now() ELSE NULL END
     )`,
    [seatId, kingdomId, status, constructionState, completedAt, sourceFlagId, territoryRadiusM]
  );
}

async function insertCot(
  queryable: Queryable,
  cotId: string,
  kingdomId: string,
  ownerId: string,
  status: "active" | "packed"
): Promise<pg.QueryResult> {
  return queryable.query(
    `INSERT INTO kingdom_cots (
       id, kingdom_id, owner_player_id, placed_by_player_id, request_id,
       lat, lon, geom, status, completed_under_free_construction, archived_at
     ) VALUES (
       $1, $2, $3, $3, $4, 35.0845, -106.6505,
       ST_SetSRID(ST_MakePoint(-106.6505, 35.0845), 4326), $5, true,
       CASE WHEN $5 = 'packed' THEN now() ELSE NULL END
     )`,
    [cotId, kingdomId, ownerId, `cot-${cotId}`, status]
  );
}

async function insertDonation(
  queryable: Queryable,
  donationId: string,
  kingdomId: string,
  donorId: string,
  requestId: string
): Promise<pg.QueryResult> {
  return queryable.query(
    `INSERT INTO kingdom_donations (
       id, kingdom_id, donor_player_id, request_id, resource_type, quantity,
       player_balance_before, player_balance_after,
       treasury_balance_before, treasury_balance_after
     ) VALUES ($1, $2, $3, $4, 'wood', 5, 10, 5, 0, 5)`,
    [donationId, kingdomId, donorId, requestId]
  );
}

async function expectConstraintFailure(
  client: pg.PoolClient,
  savepoint: string,
  code: string,
  operation: () => Promise<unknown>
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  await expect(operation()).rejects.toMatchObject({ code });
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

async function cleanTrackedFixtures(pool: pg.Pool): Promise<void> {
  const kingdomIds = [...trackedKingdomIds];
  const playerIds = [...trackedPlayerIds];
  if (kingdomIds.length === 0 && playerIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (playerIds.length > 0) {
      const cities = await client.query<{ id: string }>(
        "SELECT id FROM cities WHERE founder_player_id = ANY($1::text[])",
        [playerIds]
      );
      const cityIds = cities.rows.map(({ id }) => id);
      if (cityIds.length > 0) {
        await client.query(
          `UPDATE flags
           SET control_type = 'personal', city_id = NULL,
               city_affiliated_at = NULL, city_affiliated_by_player_id = NULL
           WHERE city_id = ANY($1::uuid[])`,
          [cityIds]
        );
        await client.query("DELETE FROM cities WHERE id = ANY($1::uuid[])", [cityIds]);
      }
    }
    if (kingdomIds.length > 0) {
      for (const table of [
        "kingdom_flag_affiliation_history",
        "kingdom_audit_events",
        "kingdom_requests",
        "kingdom_decorations",
        "kingdom_cots",
        "kingdom_xp_ledger",
        "kingdom_donations",
        "kingdom_treasury_balances",
        "kingdom_chat_mutes",
        "kingdom_chat_messages",
        "kingdom_invitations",
        "kingdom_memberships",
        "kingdom_seats"
      ]) {
        await client.query(`DELETE FROM ${table} WHERE kingdom_id = ANY($1::uuid[])`, [kingdomIds]);
      }
      await client.query("DELETE FROM flags WHERE owner_id = ANY($1::text[])", [playerIds]);
      await client.query("DELETE FROM kingdoms WHERE id = ANY($1::uuid[])", [kingdomIds]);
    }
    if (playerIds.length > 0) {
      // Current affiliation triggers record leaderboard events for these fixture players.
      await client.query("ALTER TABLE weekly_leaderboard_events DISABLE TRIGGER weekly_leaderboard_events_immutable");
      try {
        await client.query("DELETE FROM weekly_leaderboard_events WHERE player_id = ANY($1::text[])", [playerIds]);
      } finally {
        await client.query("ALTER TABLE weekly_leaderboard_events ENABLE TRIGGER weekly_leaderboard_events_immutable");
      }
      await client.query("DELETE FROM weekly_leaderboard_totals WHERE player_id = ANY($1::text[])", [playerIds]);
      await client.query("DELETE FROM players WHERE id = ANY($1::text[])", [playerIds]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    trackedKingdomIds.clear();
    trackedPlayerIds.clear();
  }
}
