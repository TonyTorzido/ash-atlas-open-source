import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DUNGEON_CATALOG, type DungeonCatalog, type ResourceType } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { CisternWarrensRuntime } from "./dungeon.js";
import { dungeonEntryCostAuthorities } from "./dungeonEntryCost.js";
import { golemForgeEntryCost, golemForgeGroupGoldMultiplier } from "./golemForge.js";
import { InventoryService } from "./inventory.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const PLAYERS = ["gf-p1", "gf-p2", "gf-pass", "gf-a1", "gf-a2", "gf-b1", "gf-c1", "gf-c2"] as const;
const PASS = "gf-pass";

type Internals = {
  instances: Map<string, {
    runId: string;
    encounters: Map<string, { state: string }>;
    bossCredits: Map<string, Set<string>>;
    dungeon: DungeonCatalog["dungeons"][number];
  }>;
  sessions: Map<string, { x: number; y: number; instanceId: string; runId: string }>;
  pollEncounters(instanceId: string, instance: unknown, now: number): void;
  handlePartyWipe(instance: unknown, definition: unknown, state: unknown, now: number): void;
};

/**
 * The shared Golem Forge against a real database and the real inventory debit: price by bosses alive
 * (re-read at charge time), two parties in one run, re-entry pays again without a lockout, boss credit
 * gates the chest and the lockout, party torch sets, and the group gold multiplier by party presence.
 */
describeDatabase("golem forge shared run", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_gf_run_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const parties: Record<string, string | null> = {
    "gf-p1": null, "gf-p2": null, "gf-pass": null, "gf-a1": "party-a", "gf-a2": "party-a", "gf-b1": "party-b",
    "gf-c1": "party-c", "gf-c2": "party-c"
  };
  const spawnMob = vi.fn((input: { entityId: string }) => ({ entityId: input.entityId, lat: 0, lon: 0, maxHealth: 100 }));
  const grantReward = vi.fn();
  let pool: DisposableTestPool | undefined;
  let runtime: CisternWarrensRuntime;
  let internals: Internals;
  let forge: DungeonCatalog["dungeons"][number];

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
        !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
      throw new Error("The Golem Forge test requires a local disposable stability database");
    }
    parsed.pathname = `/${databaseName}`;
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(parsed.toString(), { migrationsDirectory: sourceMigrations });
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 8 });
    const inventory = new InventoryService(pool as unknown as pg.Pool);
    for (const playerId of PLAYERS) {
      const accountId = randomUUID();
      await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
      await pool.query(
        `INSERT INTO players (id,account_id,username,username_normalized,region_code,lat,lon,
           anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
         VALUES ($1,$2,$1,$1,'GLOBAL',35,-106,35,-106,100,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [playerId, accountId]
      );
      await inventory.grantItemsForOperation({
        operationKey: `gf-test-seed:${playerId}`, playerId, source: "dungeon_resource_harvest",
        sourceEntityType: "dungeon_resource", sourceEntityId: "seed", metadata: {},
        grants: [{ itemId: "refined_oil" as ResourceType, variant: null, quantity: 100 },
          { itemId: "wood" as ResourceType, variant: null, quantity: 10 }]
      });
    }
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    forge = catalog.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    expect(forge.instancePolicy).toBe("shared_persistent");
    // The level gate is not under test here.
    forge.access = { entryCost: forge.access!.entryCost!, lockoutDays: 6 };
    for (const id of ["forge-a", "forge-b", "forge-c"]) {
      catalog.entrances.push({
        id, dungeonId: forge.id, revision: `${id}-v1`, retired: false, name: "Golem Forge", description: "Fixture only",
        lat: 35, lon: -106, interactionRadiusM: 8, footprintRadiusM: 5, portalId: "golem_forge_world_to_entrance",
        portalRevision: "portal-v1", interactionLabel: "Enter", presentation: "cave", assetKey: null
      });
    }
    const combat = new Proxy({ spawnMob }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(() => null)
    });
    runtime = new CisternWarrensRuntime(pool as unknown as pg.Pool, combat as never, undefined, forge, {
      partyIdForPlayer: (playerId) => parties[playerId] ?? null,
      atlasPassEntryDiscount: async (_queryable, playerId) => playerId === PASS,
      grantReward,
      ...dungeonEntryCostAuthorities(inventory)
    }, catalog);
    internals = runtime as unknown as Internals;
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
  const room = (roomId: string) => forge.rooms.find((candidate) => candidate.id === roomId)!;
  const anchor = (roomId: string, anchorId: string) => room(roomId).anchors.find((candidate) => candidate.id === anchorId)!;
  const enterAs = async (playerId: string, entranceId: string) => {
    const gate = room("gf_forge_gate");
    const spawn = anchor(gate.id, gate.spawnAnchorId);
    return runtime.enter(
      { playerId, username: playerId, displayColor: null, movementRevision: 1, regionCode: "GLOBAL",
        position: { lat: 35, lon: -106 } } as never,
      entranceId,
      { spaceId: gate.id, position: { x: spawn.x, y: spawn.y }, instanceId: `dungeon:${entranceId}`, locationType: "dungeon" }
    );
  };
  const start = (entranceId: string, members: Array<[string, number]>, expectedBossesAlive?: number) =>
    runtime.startTorchRun({
      entranceId, members: members.map(([playerId, torches]) => ({ playerId, name: playerId, torches })),
      ...(expectedBossesAlive !== undefined ? { expectedBossesAlive } : {})
    });
  const moveTo = (playerId: string, sessionId: string, roomId: string) => {
    const target = room(roomId);
    const spawn = anchor(roomId, target.spawnAnchorId);
    return runtime.transferSpace(playerId, sessionId, roomId, { x: spawn.x, y: spawn.y });
  };
  const poll = (instanceId: string, aheadMs = 0) =>
    internals.pollEncounters(instanceId, internals.instances.get(instanceId), Date.now() + aheadMs);
  /** A boss fight gathers for its first wave's delay, then the boss wakes; combat reports it gone at once. */
  const fightBoss = (instanceId: string) => { poll(instanceId, 10_000); poll(instanceId, 20_000); };
  const persistStates = async (instanceId: string, completed: string[]) => {
    const run = await pool!.query<{ run_id: string }>("SELECT run_id::text FROM dungeon_instance_runs WHERE instance_id=$1", [instanceId]);
    let runId = run.rows[0]?.run_id;
    if (!runId) {
      runId = randomUUID();
      await pool!.query("INSERT INTO dungeon_instance_runs (instance_id,run_id) VALUES ($1,$2::uuid)", [instanceId, runId]);
    }
    await pool!.query(
      `INSERT INTO dungeon_instance_state (instance_id,run_id,encounter_states) VALUES ($1,$2::uuid,$3::jsonb)
       ON CONFLICT (instance_id,run_id) DO UPDATE SET encounter_states=EXCLUDED.encounter_states`,
      [instanceId, runId, JSON.stringify(Object.fromEntries(completed.map((id) => [id, { state: "completed" }])))]
    );
  };

  it("prices each torch by bosses alive, re-reads the count at charge time, and charges nobody on a change", async () => {
    expect(golemForgeEntryCost(3)).toEqual([{ itemId: "refined_oil", quantity: 22 }, { itemId: "wood", quantity: 1 }]);
    expect(golemForgeEntryCost(2)[0]!.quantity).toBe(15);
    expect(golemForgeEntryCost(1)[0]!.quantity).toBe(7);
    const shown = await runtime.torchEntryFor("gf-p1", "forge-a");
    expect(shown).toMatchObject({ instanceId: "dungeon:forge-a", lobbyKey: "dungeon:forge-a:player:gf-p1", bossesAlive: 3,
      paid: false, entryCost: [{ itemId: "refined_oil", quantity: 22 }, { itemId: "wood", quantity: 1 }] });
    // A boss falls between the lobby showing 22 and the leader starting: nobody is charged.
    await persistStates("dungeon:forge-a", ["quarry_boss"]);
    await expect(start("forge-a", [["gf-p1", 2]], shown!.bossesAlive))
      .rejects.toMatchObject({ code: "DUNGEON_ENTRY_PRICE_CHANGED" });
    await expect(holdings("gf-p1")).resolves.toEqual({ refined_oil: 100, wood: 10 });
    const repriced = await runtime.torchEntryFor("gf-p1", "forge-a");
    expect(repriced).toMatchObject({ bossesAlive: 2, entryCost: [{ itemId: "refined_oil", quantity: 15 }, { itemId: "wood", quantity: 1 }] });
    await start("forge-a", [["gf-p1", 2]], repriced!.bossesAlive);
    await expect(holdings("gf-p1")).resolves.toEqual({ refined_oil: 70, wood: 8 });
    // One boss left: 7 per torch, and the Atlas Pass column (3) for a Pass holder.
    await persistStates("dungeon:forge-a", ["quarry_boss", "conduit_boss"]);
    await start("forge-a", [["gf-p2", 1]], 1);
    await expect(holdings("gf-p2")).resolves.toEqual({ refined_oil: 93, wood: 9 });
    await expect(runtime.torchEntryFor(PASS, "forge-a")).resolves.toMatchObject({
      entryCost: [{ itemId: "refined_oil", quantity: 4 }, { itemId: "wood", quantity: 1 }] });
    await start("forge-a", [[PASS, 1]], 1);
    await expect(holdings(PASS)).resolves.toEqual({ refined_oil: 96, wood: 9 });
    // A second start for a player who already paid and has not entered charges nobody.
    await expect(start("forge-a", [["gf-p2", 1]], 1)).rejects.toMatchObject({ code: "DUNGEON_ALREADY_PAID" });
    await expect(holdings("gf-p2")).resolves.toEqual({ refined_oil: 93, wood: 9 });
  }, 60_000);

  it("puts two parties starting at once into one run and one boss state, each with its own torch sets", async () => {
    const [a, b] = await Promise.all([start("forge-b", [["gf-a1", 3], ["gf-a2", 0]], 3), start("forge-b", [["gf-b1", 1]], 3)]);
    expect(a.runId).toBe(b.runId);
    expect(a.instanceId).toBe("dungeon:forge-b");
    await expect(holdings("gf-a1")).resolves.toEqual({ refined_oil: 34, wood: 7 });
    await expect(holdings("gf-a2")).resolves.toEqual({ refined_oil: 100, wood: 10 });
    const partySpawns = () => spawnMob.mock.calls.filter(([input]) => input.entityId.includes("dungeon:forge-b") &&
      input.entityId.includes("~party:")).length;
    spawnMob.mockClear();
    await enterAs("gf-a1", "forge-b");
    const afterA1 = partySpawns();
    expect(afterA1).toBeGreaterThan(0);
    await enterAs("gf-a2", "forge-b");
    await enterAs("gf-b1", "forge-b");
    // Party A's sets spawned once for the room; party B burned one torch and adds none.
    expect(partySpawns()).toBe(afterA1);
    const sessions = ["gf-a1", "gf-a2", "gf-b1"].map((id) => internals.sessions.get(id)!);
    expect(new Set(sessions.map((session) => `${session.instanceId}:${session.runId}`)).size).toBe(1);
    // One boss state: a boss that falls is gone for both parties, and both see the cheaper price.
    internals.instances.get("dungeon:forge-b")!.encounters.get("quarry_boss")!.state = "completed";
    await expect(runtime.torchEntryFor("gf-a1", "forge-b")).resolves.toMatchObject({ bossesAlive: 2 });
    await expect(runtime.torchEntryFor("gf-b1", "forge-b")).resolves.toMatchObject({ bossesAlive: 2 });
    // Group gold: party members present in this Forge only.
    const region = "interior:dungeon:forge-b";
    expect(runtime.groupGoldMultiplier("gf-a1", region)).toBe(1.4);
    expect(runtime.groupGoldMultiplier("gf-b1", region)).toBe(1);
    expect(runtime.groupGoldMultiplier("gf-a1", "interior:dungeon:elsewhere")).toBe(1);
    expect([1, 2, 3, 4, 5, 6].map(golemForgeGroupGoldMultiplier)).toEqual([1, 1.4, 1.8, 2.2, 2.55, 2.55]);
  }, 60_000);

  it("charges re-entry again without a lockout; boss credit gates its chest and the Forgemaster lockout", async () => {
    await start("forge-c", [["gf-c1", 1], ["gf-c2", 1]], 3);
    const c1 = await enterAs("gf-c1", "forge-c");
    const c2 = await enterAs("gf-c2", "forge-c");
    await runtime.leave("gf-c1", c1.sessionId);
    await expect(runtime.authorizeEntry("gf-c1", "forge-c")).rejects.toMatchObject({ code: "DUNGEON_TORCHES_REQUIRED" });
    await expect(runtime.authorizeEntryGates("gf-c1", "forge-c")).resolves.toBeDefined();
    await start("forge-c", [["gf-c1", 1]], 3);
    await expect(holdings("gf-c1")).resolves.toEqual({ refined_oil: 56, wood: 8 });
    await expect(runtime.authorizeEntry("gf-c1", "forge-c")).resolves.toBeUndefined();
    const again = await enterAs("gf-c1", "forge-c");

    const instanceId = "dungeon:forge-c";
    const instance = internals.instances.get(instanceId)!;
    // The boss wakes with only C1 inside; C2 arrives after the doors sealed.
    moveTo("gf-c1", again.sessionId, "gf_bull_pen");
    poll(instanceId, 10_000);
    expect([...instance.bossCredits.get("quarry_boss")!]).toEqual(["gf-c1"]);
    moveTo("gf-c2", c2.sessionId, "gf_bull_pen");
    poll(instanceId, 20_000);
    expect(instance.encounters.get("quarry_boss")!.state).toBe("completed");
    const chest = anchor("gf_bull_pen", "quarry_chest_anchor");
    for (const id of ["gf-c1", "gf-c2"]) Object.assign(internals.sessions.get(id)!, { x: chest.x, y: chest.y });
    grantReward.mockClear();
    runtime.interact("gf-c2", c2.sessionId, "quarry_chest", "c2-open");
    expect(grantReward).not.toHaveBeenCalled();
    runtime.interact("gf-c1", again.sessionId, "quarry_chest", "c1-open");
    expect(grantReward).toHaveBeenCalledWith("gf-c1", "golem_forge_quarry_chest_reward", expect.anything());

    // A wiped (or ejected) attempt credits nobody.
    moveTo("gf-c2", c2.sessionId, "gf_containment");
    expect([...instance.bossCredits.get("conduit_boss")!]).toEqual(["gf-c2"]);
    const conduit = instance.dungeon.encounters.find((encounter) => encounter.id === "conduit_boss")!;
    internals.handlePartyWipe(instance, conduit, instance.encounters.get("conduit_boss"), Date.now());
    expect(instance.bossCredits.has("conduit_boss")).toBe(false);

    // Forgemaster credit (C1 only) starts the lockout; C2, present in the Forge, is not locked out.
    moveTo("gf-c1", again.sessionId, "gf_great_forge");
    fightBoss(instanceId);
    expect(instance.encounters.get("forgemaster")!.state).toBe("completed");
    await vi.waitFor(() => expect(runtime.authorizeEntryGates("gf-c1", "forge-a")).rejects.toMatchObject({ code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE" }), { timeout: 5_000 });
    await expect(runtime.authorizeEntryGates("gf-c2", "forge-c")).resolves.toBeDefined();
  }, 60_000);
});
