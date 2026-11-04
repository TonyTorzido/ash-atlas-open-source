import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DUNGEON_CATALOG, type DungeonCatalog, type ResourceType } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { CisternWarrensRuntime, DUNGEON_PENDING_TORCH_RUN_TTL_MS } from "./dungeon.js";
import { dungeonEntryCostAuthorities } from "./dungeonEntryCost.js";
import { InventoryService } from "./inventory.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const RICH = "torch-rich";
const EXACT = "torch-exact";
const POOR = "torch-poor";
const REFUND_A = "torch-refund-a";
const REFUND_B = "torch-refund-b";
const ENTERED = "torch-entered";
const SOLO = "torch-solo";

/**
 * Torch lobby payments against a real database and the real inventory debit: exact N x cost, a replayed
 * start never charges twice, and one member who can't pay leaves everyone (and the run) untouched.
 */
describeDatabase("dungeon torch lobby payments", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_torch_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let pool: DisposableTestPool | undefined;
  let runtime: CisternWarrensRuntime;
  let party = "party-a";
  let fangrockRoom: DungeonCatalog["dungeons"][number]["rooms"][number];

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
        !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
      throw new Error("The torch lobby payment test requires a local disposable stability database");
    }
    parsed.pathname = `/${databaseName}`;
    // Trunk migrations grant to this cluster-level role (see fallenPrisonMigrations.integration.test.ts).
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(parsed.toString(), { migrationsDirectory: sourceMigrations });
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 6 });
    const inventory = new InventoryService(pool as unknown as pg.Pool);
    for (const [playerId, oil, wood] of [[RICH, 100, 5], [EXACT, 18, 1], [POOR, 30, 0],
      [REFUND_A, 100, 5], [REFUND_B, 40, 2], [ENTERED, 100, 5], [SOLO, 100, 5]] as const) {
      const accountId = randomUUID();
      await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
      await pool.query(
        `INSERT INTO players (id,account_id,username,username_normalized,region_code,lat,lon,
           anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
         VALUES ($1,$2,$1,$1,'GLOBAL',35,-106,35,-106,100,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [playerId, accountId]
      );
      const grants: Array<{ itemId: ResourceType; variant: null; quantity: number }> =
        [{ itemId: "refined_oil" as ResourceType, variant: null, quantity: oil }];
      if (wood > 0) grants.push({ itemId: "wood" as ResourceType, variant: null, quantity: wood });
      await inventory.grantItemsForOperation({
        operationKey: `torch-test-seed:${playerId}`, playerId, source: "dungeon_resource_harvest",
        sourceEntityType: "dungeon_resource", sourceEntityId: "seed", metadata: {}, grants
      });
    }
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const fangrock = catalog.dungeons.find((dungeon) => dungeon.id === "fangrock_cavern")!;
    fangrock.access = { entryCost: fangrock.access!.entryCost!, lockoutDays: 6 };
    catalog.entrances.push({
      id: "torch-cave", dungeonId: fangrock.id, revision: "torch-cave-v1", retired: false,
      name: "Torch Cave", description: "Fixture only", lat: 35, lon: -106, interactionRadiusM: 8,
      footprintRadiusM: 5, portalId: "world-to-entrance", portalRevision: "portal-v1",
      interactionLabel: "Enter", presentation: "cave", assetKey: null
    });
    fangrockRoom = fangrock.rooms.find((room) => !room.retired && room.active)!;
    // Combat is not under test: every combat call is a no-op.
    const combat = new Proxy({}, { get: () => vi.fn(() => null) });
    runtime = new CisternWarrensRuntime(pool as unknown as pg.Pool, combat as never, undefined, fangrock, {
      partyIdForPlayer: () => party,
      ...dungeonEntryCostAuthorities(inventory)
    }, catalog);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  const holdings = async (playerId: string) => {
    const rows = await pool!.query<{ resource_type: string; quantity: string }>(
      "SELECT resource_type,quantity::text FROM player_inventory WHERE player_id=$1 AND resource_type IN ('refined_oil','wood')",
      [playerId]
    );
    return Object.fromEntries(rows.rows.map((row) => [row.resource_type, Number(row.quantity)]));
  };

  it("charges exactly torches x cost per member once, and a replayed start charges nothing", async () => {
    const members = [{ playerId: RICH, name: "Rich", torches: 3 }, { playerId: EXACT, name: "Exact", torches: 1 }];
    const started = await runtime.startTorchRun({ entranceId: "torch-cave", members });
    expect(started).toMatchObject({ instanceId: "dungeon:torch-cave:party:party-a", torchTotal: 4, replayed: false });
    await expect(holdings(RICH)).resolves.toEqual({ refined_oil: 46, wood: 2 });
    await expect(holdings(EXACT)).resolves.toEqual({ refined_oil: 0, wood: 0 });
    const replays = await Promise.all([1, 2, 3].map(() => runtime.startTorchRun({ entranceId: "torch-cave", members })));
    expect(replays.every((replay) => replay.replayed && replay.runId === started.runId && replay.torchTotal === 4)).toBe(true);
    await expect(holdings(RICH)).resolves.toEqual({ refined_oil: 46, wood: 2 });
    await expect(pool!.query("SELECT torch_total,party_size,ended_at FROM dungeon_run_stats WHERE run_id=$1::uuid", [started.runId]))
      .resolves.toMatchObject({ rows: [{ torch_total: 4, party_size: 0, ended_at: null }] });
    await expect(pool!.query("SELECT count(*)::int AS count FROM inventory_operations WHERE source='dungeon_entry_cost'"))
      .resolves.toMatchObject({ rows: [{ count: 2 }] });
  }, 60_000);

  it("charges nobody and opens no run when one member cannot pay", async () => {
    party = "party-b";
    const before = await holdings(RICH);
    await expect(runtime.startTorchRun({ entranceId: "torch-cave", members: [
      { playerId: RICH, name: "Rich", torches: 1 }, { playerId: POOR, name: "Poor", torches: 1 }
    ] })).rejects.toMatchObject({ code: "DUNGEON_ENTRY_COST_UNAFFORDABLE", message: expect.stringContaining("Poor") });
    await expect(holdings(RICH)).resolves.toEqual(before);
    await expect(holdings(POOR)).resolves.toEqual({ refined_oil: 30 });
    await expect(pool!.query("SELECT count(*)::int AS count FROM dungeon_instance_runs WHERE instance_id='dungeon:torch-cave:party:party-b'"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool!.query("SELECT count(*)::int AS count FROM dungeon_run_stats WHERE instance_id='dungeon:torch-cave:party:party-b'"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    // A zero-torch member pays nothing, so the same party starts once the poor member burns none.
    await expect(runtime.startTorchRun({ entranceId: "torch-cave", members: [
      { playerId: RICH, name: "Rich", torches: 1 }, { playerId: POOR, name: "Poor", torches: 0 }
    ] })).resolves.toMatchObject({ torchTotal: 1, replayed: false });
    await expect(holdings(RICH)).resolves.toEqual({ refined_oil: before.refined_oil! - 18, wood: before.wood! - 1 });
    await expect(holdings(POOR)).resolves.toEqual({ refined_oil: 30 });
  }, 60_000);
  const backdate = (runId: string) => pool!.query(
    "UPDATE dungeon_run_stats SET started_at=now() - ($2::double precision * interval '1 millisecond') WHERE run_id=$1::uuid",
    [runId, DUNGEON_PENDING_TORCH_RUN_TTL_MS + 60_000]
  );
  const enterAs = (playerId: string, instanceId: string) => {
    const spawn = fangrockRoom.anchors.find((anchor) => anchor.id === fangrockRoom.spawnAnchorId)!;
    return runtime.enter(
      { playerId, username: playerId, displayColor: null, movementRevision: 1, regionCode: "GLOBAL",
        position: { lat: 35, lon: -106 } } as never,
      "torch-cave",
      { spaceId: fangrockRoom.id, position: { x: spawn.x, y: spawn.y }, instanceId, locationType: "dungeon" }
    );
  };
  const refundCount = async (runId: string) => (await pool!.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM inventory_operations WHERE source='dungeon_entry_refund' AND metadata->>'runId'=$1",
    [runId]
  )).rows[0]!.count;

  it("expires a paid run nobody entered: refunds every payer exactly, once, even when expiry races", async () => {
    party = "party-c";
    const started = await runtime.startTorchRun({ entranceId: "torch-cave", members: [
      { playerId: REFUND_A, name: "A", torches: 2 }, { playerId: REFUND_B, name: "B", torches: 1 }
    ] });
    await expect(holdings(REFUND_A)).resolves.toEqual({ refined_oil: 64, wood: 3 });
    await expect(holdings(REFUND_B)).resolves.toEqual({ refined_oil: 22, wood: 1 });
    // Not yet stale: nothing happens.
    await expect(runtime.expireStalePendingTorchRun(started.instanceId, "fangrock_cavern")).resolves.toBe(false);
    await backdate(started.runId);
    const results = await Promise.all([1, 2, 3].map(() =>
      runtime.expireStalePendingTorchRun(started.instanceId, "fangrock_cavern")));
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(runtime.expireStalePendingTorchRun(started.instanceId, "fangrock_cavern")).resolves.toBe(false);
    await expect(holdings(REFUND_A)).resolves.toEqual({ refined_oil: 100, wood: 5 });
    await expect(holdings(REFUND_B)).resolves.toEqual({ refined_oil: 40, wood: 2 });
    await expect(refundCount(started.runId)).resolves.toBe(2);
    await expect(pool!.query("SELECT result,ended_at IS NOT NULL AS ended FROM dungeon_run_stats WHERE run_id=$1::uuid", [started.runId]))
      .resolves.toMatchObject({ rows: [{ result: "abandoned", ended: true }] });
    const current = await pool!.query<{ run_id: string }>(
      "SELECT run_id::text FROM dungeon_instance_runs WHERE instance_id=$1", [started.instanceId]);
    expect(current.rows[0]!.run_id).not.toBe(started.runId);
    // The lobby entry point (torchEntryFor) sees an unpaid instance again.
    await expect(runtime.torchEntryFor(REFUND_A, "torch-cave")).resolves.toMatchObject({ paid: false });
  }, 60_000);

  it("never refunds a paid run somebody entered", async () => {
    party = "party-d";
    const started = await runtime.startTorchRun({ entranceId: "torch-cave", members: [
      { playerId: ENTERED, name: "Entered", torches: 1 }
    ] });
    await expect(holdings(ENTERED)).resolves.toEqual({ refined_oil: 82, wood: 4 });
    await enterAs(ENTERED, started.instanceId);
    await backdate(started.runId);
    await expect(runtime.expireStalePendingTorchRun(started.instanceId, "fangrock_cavern")).resolves.toBe(false);
    // Even with the presence row gone (the member left), its entrants on the stats keep it un-refundable.
    await pool!.query("DELETE FROM dungeon_presence WHERE player_id=$1", [ENTERED]);
    await expect(runtime.expireStalePendingTorchRun(started.instanceId, "fangrock_cavern")).resolves.toBe(false);
    await expect(holdings(ENTERED)).resolves.toEqual({ refined_oil: 82, wood: 4 });
    await expect(refundCount(started.runId)).resolves.toBe(0);
  }, 60_000);

  it("charges a plain enter into an unpaid run one torch, once, and records torch_total=1", async () => {
    party = "party-e";
    const instanceId = "dungeon:torch-cave:party:party-e";
    const entries = await Promise.allSettled([enterAs(SOLO, instanceId), enterAs(SOLO, instanceId)]);
    expect(entries.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    await expect(holdings(SOLO)).resolves.toEqual({ refined_oil: 82, wood: 4 });
    const run = await pool!.query<{ run_id: string; torch_total: number; party_size: number }>(
      `SELECT stats.run_id::text,stats.torch_total,stats.party_size FROM dungeon_run_stats stats
         JOIN dungeon_instance_runs run ON run.run_id=stats.run_id WHERE run.instance_id=$1`, [instanceId]);
    expect(run.rows[0]).toMatchObject({ torch_total: 1, party_size: 1 });
    const charge = (await pool!.query<{ operation_key: string }>(
      "SELECT operation_key FROM inventory_operations WHERE source='dungeon_entry_cost' AND player_id=$1", [SOLO])).rows;
    expect(charge.map((row) => row.operation_key)).toEqual([`dungeon-entry-cost:${run.rows[0]!.run_id}:${SOLO}`]);
    // Leaving and re-entering the same run is free: the run is paid.
    const entered = entries.find((entry) => entry.status === "fulfilled")!;
    await runtime.leave(SOLO, (entered as PromiseFulfilledResult<{ sessionId: string }>).value.sessionId);
    await enterAs(SOLO, instanceId);
    await expect(holdings(SOLO)).resolves.toEqual({ refined_oil: 82, wood: 4 });
    await expect(pool!.query("SELECT count(*)::int AS count FROM inventory_operations WHERE source='dungeon_entry_cost' AND player_id=$1", [SOLO]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 60_000);
});
