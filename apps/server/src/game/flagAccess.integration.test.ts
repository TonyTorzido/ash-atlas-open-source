import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_FLAG_CLAIM_RADIUS_M,
  DEFAULT_MOVE_LEASH_RADIUS_M
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DestinationAnchoring } from "../auth/trust/anchoring.js";
import { DestinationAnchorGate, PostgresDestinationAnchorStore } from "../auth/trust/destinationAnchorGate.js";
import { PostgresTrustZoneStore } from "../auth/trust/trustStore.js";
import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { FlagAccessService } from "./flagAccess.js";
import { WalletService } from "./wallet.js";

const adminUrl = process.env.FLAG_ACCESS_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("three-mode flag access", () => {
  const databaseName = `ash_atlas_stability_flag_access_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let service: FlagAccessService;
  let wallet: WalletService;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    wallet = new WalletService();
    service = new FlagAccessService(pool, wallet);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await admin.end();
  });

  it("is repeatable and enforces canonical stack limits and three access modes", async () => {
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
    await expect(pool.query(
      `SELECT item_id, max_stack FROM item_definitions
       WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
      [["balsam_resin", "food", "leather", "ore", "stone", "water", "wood"]]
    )).resolves.toMatchObject({
      rows: [
        { item_id: "balsam_resin", max_stack: 100 },
        { item_id: "food", max_stack: 100 },
        { item_id: "leather", max_stack: 500 },
        { item_id: "ore", max_stack: 250 },
        { item_id: "stone", max_stack: 250 },
        { item_id: "water", max_stack: 100 },
        { item_id: "wood", max_stack: 500 }
      ]
    });
    const owner = await seedPlayer(pool, "mode-owner");
    const flagId = await seedFlag(pool, owner);
    await expect(pool.query(
      "UPDATE flags SET access_mode='custom' WHERE id=$1",
      [flagId]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("lists owned personal flags and Atlas Shrines with their mode counts", async () => {
    const owner = await seedPlayer(pool, "shrine-dashboard-owner");
    const ordinary = await seedFlag(pool, owner);
    const shrine = await seedFlag(pool, owner);
    await pool.query(
      `UPDATE flags
       SET reinforcement_level=2,name='North Shrine',atlas_shrine_slot_number=1
       WHERE id=$1`,
      [shrine]
    );

    await expect(service.dashboard(owner)).resolves.toMatchObject({
      flags: [{ flagId: ordinary }, {
        flagId: shrine,
        flagName: "North Shrine",
        atlasShrineSlotNumber: 1
      }],
      ownedFlagCountsByMode: { private: 2, public: 0, normal: 0 }
    });
    expect((await service.dashboard(owner)).flags.map((flag) => flag.flagId))
      .toContain(ordinary);
  });

  it("uses one owner-wide Normal request and grant across Normal flags", async () => {
    const owner = await seedPlayer(pool, "normal-owner");
    const traveler = await seedPlayer(pool, "normal-traveler");
    const first = await seedFlag(pool, owner);
    const second = await seedFlag(pool, owner);
    await service.updateSettings({
      ownerPlayerId: owner,
      flagId: first,
      mode: "normal",
      jumpTollGold: "7"
    });
    await service.updateSettings({
      ownerPlayerId: owner,
      flagId: second,
      mode: "normal",
      jumpTollGold: "9"
    });
    const requested = await service.requestPassage({
      flagId: first,
      requesterPlayerId: traveler,
      requestId: randomUUID()
    });
    expect((await service.authorize(second, traveler)).decision.reasonCode)
      .toBe("NORMAL_REQUEST_PENDING");
    await service.resolvePassageRequest({
      ownerPlayerId: owner,
      flagId: first,
      passageRequestId: requested.request.id,
      requestId: randomUUID(),
      action: "approve"
    });
    expect((await service.authorize(first, traveler)).decision)
      .toMatchObject({ reasonCode: "ALLOWED_NORMAL", tollGold: "7" });
    expect((await service.authorize(second, traveler)).decision)
      .toMatchObject({ reasonCode: "ALLOWED_NORMAL", tollGold: "9" });
  });

  it("authoritatively applies Public, Normal, and Private for the owner only", async () => {
    const owner = await seedPlayer(pool, "settings-owner");
    const outsider = await seedPlayer(pool, "settings-outsider");
    const flagId = await seedFlag(pool, owner);
    for (const mode of ["public", "normal", "private"] as const) {
      const access = await service.updateSettings({
        ownerPlayerId: owner,
        flagId,
        mode,
        jumpTollGold: mode === "private" ? "0" : "3"
      });
      expect(access.mode).toBe(mode);
    }
    await expect(service.updateSettings({
      ownerPlayerId: outsider,
      flagId,
      mode: "public",
      jumpTollGold: "0"
    })).rejects.toMatchObject({ code: "FLAG_ACCESS_FORBIDDEN" });
    await expect(service.authorize(flagId, outsider)).resolves.toMatchObject({
      decision: { allowed: false, reasonCode: "PRIVATE_OWNER_ONLY" }
    });
  });

  it("lets others jump to an unsettled owner's public flag, keeps private private and enemies out", async () => {
    // Owner decision 2026-10-15: flag access is the owner's choice whether or
    // not they are Settled. Seeded accounts have no account_settlement row.
    const owner = await seedPlayer(pool, "unsettled-owner");
    const traveler = await seedPlayer(pool, "unsettled-traveler");
    const enemy = await seedPlayer(pool, "unsettled-enemy");
    const flagId = await seedFlag(pool, owner);
    await pool.query(
      `INSERT INTO player_enemy_marks (owner_id,target_id)
       VALUES (LEAST($1::text,$2::text),GREATEST($1::text,$2::text))`,
      [owner, enemy]
    );
    const anchors = new DestinationAnchorGate(
      new PostgresDestinationAnchorStore(pool),
      new DestinationAnchoring(new PostgresTrustZoneStore(pool), { TRUST_HOME_DESTINATION_RADIUS_KM: 50 }),
      { TRUST_ANCHOR_MODE: "enforce" }
    );
    const travel = (travellerPlayerId: string) => anchors.checkTravel({
      travellerPlayerId,
      kind: "flag",
      destination: { kind: "flag", id: flagId, personalFlagId: flagId }
    });

    await expect(service.updateSettings({ ownerPlayerId: owner, flagId, mode: "public", jumpTollGold: "0" }))
      .resolves.toMatchObject({ mode: "public" });
    await expect(service.authorize(flagId, traveler)).resolves.toMatchObject({
      decision: { allowed: true, reasonCode: "ALLOWED_PUBLIC" }
    });
    await expect(travel(traveler)).resolves.toBeNull();
    await expect(service.authorize(flagId, enemy)).resolves.toMatchObject({
      decision: { allowed: false, reasonCode: "PUBLIC_ENEMY_BLOCKED" }
    });

    await service.updateSettings({ ownerPlayerId: owner, flagId, mode: "private", jumpTollGold: "0" });
    await expect(service.authorize(flagId, traveler)).resolves.toMatchObject({
      decision: { allowed: false, reasonCode: "PRIVATE_OWNER_ONLY" }
    });
  });

  it("replays one exact travel request but commits two distinct request IDs", async () => {
    const owner = await seedPlayer(pool, "travel-id-owner");
    const flagId = await seedFlag(pool, owner);
    const commits: string[] = [];
    const execute = (requestId: string) => service.executeTravel({
      flagId,
      travelerPlayerId: owner,
      requestId,
      expectedTollGold: "0",
      commit: async () => {
        commits.push(requestId);
        return requestId;
      }
    });

    const first = await execute("same-request");
    const replay = await execute("same-request");
    const distinct = await execute("different-request");

    expect(first).toMatchObject({ replayed: false, value: "same-request" });
    expect(replay).toMatchObject({ replayed: true, value: null });
    expect(distinct).toMatchObject({
      replayed: false,
      value: "different-request"
    });
    expect(commits).toEqual(["same-request", "different-request"]);
  });

  it("charges a direct Public jump but keeps a hosted arrival free and replay-safe", async () => {
    const owner = await seedPlayer(pool, "hosted-toll-owner");
    const traveler = await seedPlayer(pool, "hosted-toll-traveler");
    const flagId = await seedFlag(pool, owner);
    await service.updateSettings({
      ownerPlayerId: owner,
      flagId,
      mode: "public",
      jumpTollGold: "7"
    });
    await fundWallet(pool, wallet, owner, 10n);
    await fundWallet(pool, wallet, traveler, 50n);

    await service.executeTravel({
      flagId,
      travelerPlayerId: traveler,
      requestId: "direct-public-toll",
      expectedTollGold: "7",
      commit: async () => undefined
    });
    let balances = await pool.query<{ player_id: string; gold_balance: string }>(
      `SELECT player_id,gold_balance::text FROM player_wallets
       WHERE player_id = ANY($1::text[]) ORDER BY player_id`,
      [[owner, traveler]]
    );
    expect(balances.rows).toEqual([
      { player_id: owner, gold_balance: "17" },
      { player_id: traveler, gold_balance: "43" }
    ].sort((left, right) => left.player_id.localeCompare(right.player_id)));

    let hostedCommits = 0;
    const hosted = () => service.executeTravel({
      flagId,
      travelerPlayerId: traveler,
      companionHostPlayerId: owner,
      requestId: "hosted-public-arrival",
      commit: async () => {
        hostedCommits += 1;
      }
    });
    await expect(hosted()).resolves.toMatchObject({ replayed: false });
    await expect(hosted()).resolves.toMatchObject({ replayed: true });
    balances = await pool.query<{ player_id: string; gold_balance: string }>(
      `SELECT player_id,gold_balance::text FROM player_wallets
       WHERE player_id = ANY($1::text[]) ORDER BY player_id`,
      [[owner, traveler]]
    );
    expect(balances.rows).toEqual([
      { player_id: owner, gold_balance: "17" },
      { player_id: traveler, gold_balance: "43" }
    ].sort((left, right) => left.player_id.localeCompare(right.player_id)));
    expect(hostedCommits).toBe(1);
  });

  it("migrates existing Custom state to Normal and removes the retired schema", async () => {
    const legacyName = `ash_atlas_stability_flag_custom_${randomUUID().replaceAll("-", "")}`;
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${legacyName}`;
    const legacyUrl = parsed.toString();
    const preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0684-"));
    const source = path.resolve(process.cwd(), "../../db/migrations");
    let legacyPool: pg.Pool | null = null;
    try {
      for (const name of (await readdir(source))
        .filter((entry) => entry.endsWith(".sql") && entry < "0684_")) {
        await copyFile(path.join(source, name), path.join(preceding, name));
      }
      await admin.query(`CREATE DATABASE ${quoteIdentifier(legacyName)}`);
      await runMigrations(legacyUrl, { migrationsDirectory: preceding });
      legacyPool = new DisposableTestPool({ connectionString: legacyUrl, max: 2 });
      const owner = await seedPlayer(legacyPool, "custom-owner");
      const flagId = await seedFlag(legacyPool, owner);
      const groupId = randomUUID();
      await legacyPool.query(
        "INSERT INTO custom_flag_access_groups (id,owner_player_id,name) VALUES ($1,$2,'Legacy')",
        [groupId, owner]
      );
      await legacyPool.query(
        "UPDATE flags SET access_mode='custom' WHERE id=$1",
        [flagId]
      );
      await legacyPool.query(
        "INSERT INTO custom_flag_group_memberships (flag_id,group_id) VALUES ($1,$2)",
        [flagId, groupId]
      );
      await legacyPool.query(
        `UPDATE player_flag_preferences
         SET default_flag_access_mode='custom', default_custom_group_id=$2
         WHERE owner_player_id=$1`,
        [owner, groupId]
      );
      await expect(runMigrations(legacyUrl)).resolves.toContain(
        "0684_inventory_and_flag_access_cleanup.sql"
      );
      await expect(legacyPool.query(
        `SELECT
           to_regprocedure('public.reset_personal_flag_access_lifecycle()')::text
             AS lifecycle_function,
           to_regprocedure('public.enforce_flag_access_override_scope()')::text
             AS override_function`
      )).resolves.toMatchObject({
        rows: [{
          lifecycle_function: null,
          override_function: null
        }]
      });
      await expect(legacyPool.query(
        `SELECT flag.access_mode, preference.default_flag_access_mode,
                to_regclass('public.custom_flag_access_groups')::text AS custom_table
         FROM flags flag
         JOIN player_flag_preferences preference ON preference.owner_player_id=flag.owner_id
         WHERE flag.id=$1`,
        [flagId]
      )).resolves.toMatchObject({
        rows: [{
          access_mode: "normal",
          default_flag_access_mode: "normal",
          custom_table: null
        }]
      });
      await expect(runMigrations(legacyUrl)).resolves.toEqual([]);
    } finally {
      await legacyPool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(legacyName)}`);
      await rm(preceding, { recursive: true, force: true });
    }
  }, 30_000);
});

async function seedPlayer(pool: pg.Pool, prefix: string): Promise<string> {
  const playerId = `${prefix}-${randomUUID()}`;
  const accountId = randomUUID();
  await pool.query(
    "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
    [accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id,account_id,username,username_normalized,region_code,
       lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
     ) VALUES ($1,$2,$1,lower($1),'NM',35,-106,35,-106,$3,false,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
    [playerId, accountId, DEFAULT_MOVE_LEASH_RADIUS_M]
  );
  return playerId;
}

async function seedFlag(pool: pg.Pool, ownerPlayerId: string): Promise<string> {
  const flagId = randomUUID();
  const lon = -106 + (++seededFlagCount * 0.02);
  await pool.query(
    `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
     VALUES ($1,$2,$3,35,$4,$5,ST_SetSRID(ST_MakePoint($4,35),4326))`,
    [flagId, ownerPlayerId, `Flag ${flagId.slice(0, 8)}`, lon, DEFAULT_FLAG_CLAIM_RADIUS_M]
  );
  return flagId;
}

async function fundWallet(
  pool: pg.Pool,
  wallet: WalletService,
  playerId: string,
  amount: bigint
): Promise<void> {
  const account = await pool.query<{ account_id: string }>(
    "SELECT account_id FROM players WHERE id=$1",
    [playerId]
  );
  const accountId = account.rows[0]?.account_id;
  if (!accountId) throw new Error(`Missing account for ${playerId}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await wallet.creditForOperationInTransaction(client, {
      playerId,
      accountId,
      amount,
      operationKey: `flag-access-seed:${playerId}`,
      reason: "flag_access_test_seed"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let seededFlagCount = 0;

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.pathname !== "/ash_atlas_stability") {
    throw new Error("FLAG_ACCESS_TEST_ADMIN_URL must target a local ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
