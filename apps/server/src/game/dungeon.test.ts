import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  CISTERN_WARRENS_DUNGEON,
  CISTERN_WARRENS_SPAWN,
  DASH_DISTANCE_M,
  DEFAULT_PLAYER_SPEED_MPS,
  DUNGEON_CATALOG,
  DUNGEON_METERS_PER_COORDINATE,
  dungeonLocalToCombatPosition,
  emptyEquipmentSlots,
  moveToward,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  validateDungeonCatalog,
  dungeonCatalogValidationIssues,
  distanceMeters,
  type ActiveEquipmentLoadout,
  type DungeonCatalog,
  type DungeonDefinition,
  type EquipmentCombatStats,
  type WeaponCategory,
  CURRENT_LEVEL_CAP,
  portalIds
} from "@ash-atlas/shared";

import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import {
  createCombatEquipmentHandler,
  type CombatEquipmentHandlerContext
} from "../realtime/handlers/combatEquipmentHandler.js";
import { CombatEngine } from "./combat/combatEngine.js";
import type { PlayerEquipmentCombatState } from "./combat/combatEngine.js";
import { GameState } from "./state.js";
import { zoneIdForPosition } from "./spatialZones.js";
import { WorldRuntime } from "./worldRuntime.js";

import {
  CisternWarrensRuntime,
  boundedDungeonCombatId,
  DungeonError,
  summarizeAutoNotices,
  type DungeonRuntimeAuthorities
} from "./dungeon.js";
import { requireMobDefinition } from "./combat/mobDefinitions.js";
import { DungeonResourceHarvestService } from "./dungeonResourceHarvest.js";
import { dungeonResourceRule } from "./dungeonResourceRules.js";

describe("catalog dungeon runtime", () => {
  it("bounds long authored mob and pack identities without changing short existing IDs", () => {
    const short = "dungeon:room:encounter:slime:1";
    expect(boundedDungeonCombatId(short)).toBe(short);
    const long = `dungeon:${"long_accepted_name_".repeat(20)}:slime:1`;
    const bounded = boundedDungeonCombatId(long);
    expect(bounded.length).toBeLessThanOrEqual(160);
    expect(boundedDungeonCombatId(long)).toBe(bounded);
    expect(boundedDungeonCombatId(`${long}:2`)).not.toBe(bounded);
  });
  it("preserves the CisternWarrensRuntime compatibility export", () => {
    const source = readFileSync(new URL("./dungeon.ts", import.meta.url), "utf8");

    expect(source).toContain("export class DungeonRuntime");
    expect(source).toContain("export { DungeonRuntime as CisternWarrensRuntime }");
    expect(source).not.toContain("cistern_warrens_encounters");
  });

  it("restores canonical coordinates and traverses at canonical indoor speed", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1",
      spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(restored?.player).toMatchObject({
      x: 500, y: 200,
      movementSpeed: DEFAULT_PLAYER_SPEED_MPS / DUNGEON_METERS_PER_COORDINATE
    });
    expect(restored).toMatchObject({
      dungeonId: "cistern_warrens", dungeonRevision: "cistern-warrens-v2",
      instancePolicy: "shared_persistent",
      roomWidth: 1_000, roomHeight: 1_000, playerVisualHeight: 35,
      camera: { mode: "fixed_center", minZoom: 0.5, defaultZoom: 1, maxZoom: 1.6 },
      environment: { environmentId: "cistern_warrens_hatch_landing" }
    });
    expect(restored?.objects.filter((object) => object.kind === "portal")).toEqual([
      expect.objectContaining({ id: "world-exit", x: 500, y: 60 }),
      expect.objectContaining({ id: "door-e", x: 950, y: 475 })
    ]);
    expect(harness.persistInteriorPosition).not.toHaveBeenCalled();

    const moving = harness.runtime.moveTo("player-1", "session-1", 760, 200);
    expect(moving.player).toMatchObject({ targetX: 760, targetY: 200 });
    await harness.runtime.tick(1);
    expect(harness.runtime.get("player-1")?.player.x).toBe(
      500 + DEFAULT_PLAYER_SPEED_MPS / DUNGEON_METERS_PER_COORDINATE * 0.25
    );
    expect(harness.runtime.get("player-1")?.player.movementRevision)
      .toBeGreaterThan(moving.player.movementRevision);
    expect(() => harness.runtime.moveTo("player-1", "session-1", 10, 150))
      .toThrowError(DungeonError);
  });

  it("holds only reserved dungeon movement until Replenish releases the player", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    harness.runtime.moveTo("player-1", "session-1", 760, 200);
    harness.combat.isPlayerReserved.mockReturnValueOnce(true);
    await harness.runtime.tick(0.25);
    expect(harness.runtime.get("player-1")?.player.x).toBe(500);
    expect(harness.combat.syncPlayer).not.toHaveBeenCalledWith(expect.objectContaining({
      position: dungeonLocalToCombatPosition(500 + DEFAULT_PLAYER_SPEED_MPS / DUNGEON_METERS_PER_COORDINATE * 0.25, 200)
    }));
    await harness.runtime.tick(0.25);
    expect(harness.runtime.get("player-1")?.player.x).toBeGreaterThan(500);
  });

  it.each([[1, 1], [1.1, 1.1], [1.5, 1.5], [0.2, 0.2]] as const)(
    "applies the canonical combat movement multiplier %d to movement and snapshots",
    async (multiplier, expectedMultiplier) => {
      const harness = runtimeHarness({ localX: 14, localY: 24, movementMultiplier: multiplier });
      await harness.runtime.restore(player(), {
        sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
      });
      harness.runtime.moveTo("player-1", "session-1", 790, 200);
      await harness.runtime.tick(0.25);
      const speed = DEFAULT_PLAYER_SPEED_MPS / DUNGEON_METERS_PER_COORDINATE * expectedMultiplier;
      expect(harness.runtime.get("player-1")?.player).toMatchObject({
        x: 500 + speed * 0.25,
        movementSpeed: speed
      });
    }
  );

  it.each(["goblin", "alligator", "training_dummy"] as const)(
    "reproduces ranged approach parity for a %s through the production command path",
    async (archetype) => {
      const overworld = await productionApproachEvidence("world", archetype);
      const dungeon = await productionApproachEvidence("dungeon", archetype);

      for (const evidence of [overworld, dungeon]) {
        expect(evidence.commandAccepted).toBe(true);
        expect(evidence.combatStarted).toBe(true);
        expect(evidence.weaponSlotBefore).toBe("melee");
        expect(evidence.sawWeaponSwitch).toBe(true);
        expect(evidence.weaponSlotAtFirstHit).toBe("secondary");
        expect(evidence.effectiveRangeM).toBe(300);
        expect(evidence.initialDistanceM).toBeGreaterThan(100);
        expect(evidence.routeDestinationDistanceM).toBeCloseTo(299.9, 2);
        expect(evidence.firstHitDistanceM).toBeCloseTo(299.9, 2);
      }
      expect(dungeon.routeDestinationDistanceM).toBeCloseTo(overworld.routeDestinationDistanceM, 2);
      expect(dungeon.firstHitDistanceM).toBeCloseTo(overworld.firstHitDistanceM, 2);
    }
  );

  it("enters at the exact committed arrival while inserting legacy-compatible storage", async () => {
    const transactionQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
      void values;
      if (sql.includes("SELECT 1 FROM cistern_warrens_presence")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const poolQuery = vi.fn(async (sql: string) => sql.includes("FROM city_structures structure")
      ? { rows: [{
        structure_id: "sewer-1", city_id: "city-1", city_name: "Test City",
        region_code: "world", placement_revision: "1", lat: 35, lon: -106
      }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const runtime = new CisternWarrensRuntime({
      query: poolQuery,
      connect: vi.fn(async () => ({ query: transactionQuery, release: vi.fn() }))
    } as never, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0)
    } as never);
    const entered = await runtime.enter(player(), "sewer-1", {
      spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(entered.player).toMatchObject({ x: 500, y: 200 });
    expect(entered.objects.filter((object) => object.kind === "portal")).toEqual([
      expect.objectContaining({ id: "world-exit", x: 500, y: 60 }),
      expect.objectContaining({ id: "door-e", x: 950, y: 475 })
    ]);
    const insert = transactionQuery.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO cistern_warrens_presence")
    );
    expect(insert?.[0]).toContain("VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)");
    expect(insert?.[1]).toEqual([
      "player-1", "sewer-1", expect.any(String), 80, 32, "world", 35, -106
    ]);
  });

  it("persists runtime coordinates in the legacy encoding and restores the round trip", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1",
      spaceId: "overflow_channel", position: { x: 130, y: 400 }
    });
    expect(restored?.spaceId).toBe("overflow_channel");
    expect(restored?.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "door-w", x: 30, y: 400 })
    ]));
    expect(harness.persistInteriorPosition).not.toHaveBeenCalled();
    harness.runtime.moveTo("player-1", "session-1", 150, 400);
    await harness.runtime.tick(0.25);
    const update = harness.queries.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE cistern_warrens_presence SET local_x=$2")
    );
    expect(update?.[1]).toEqual(["player-1", 24, 64]);
    expect(harness.persistInteriorPosition).toHaveBeenCalledWith(expect.objectContaining({
      x: 150, y: 400
    }));

    harness.queries.mockClear();
    harness.persistInteriorPosition.mockClear();
    await harness.runtime.detachRuntime("player-1");
    expect(harness.queries).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE cistern_warrens_presence SET local_x=$2"),
      ["player-1", 24, 64]
    );
    expect(harness.persistInteriorPosition).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: "sewer:sewer-1", spaceId: "overflow_channel", x: 150, y: 400
    }));
    expect(harness.runtime.get("player-1")).toBeNull();
  });

  it("repairs stale durable presence when leaving without a runtime session", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    await harness.runtime.detachRuntime("player-1");

    await expect(harness.runtime.leave("player-1", undefined, "recovery:death-anchor"))
      .resolves.toBeNull();
    expect(harness.queries).toHaveBeenCalledWith(
      "DELETE FROM cistern_warrens_presence WHERE player_id=$1",
      ["player-1"]
    );
  });

  it("recovers an invalid canonical restore point and respawns with dual persistence", async () => {
    const harness = runtimeHarness({ localX: 0, localY: 0 });
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1",
      spaceId: "hatch_landing", position: { x: 0, y: 0 }
    });
    expect(restored?.spaceId).toBe("hatch_landing");
    expect(restored?.player).toMatchObject(CISTERN_WARRENS_SPAWN);
    expect(harness.queries).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE cistern_warrens_presence SET local_x=$2"),
      ["player-1", 80, 32]
    );
    expect(harness.persistInteriorPosition).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: "hatch_landing", x: CISTERN_WARRENS_SPAWN.x, y: CISTERN_WARRENS_SPAWN.y
    }));
    harness.runtime.moveTo("player-1", "session-1", 500, 500);
    harness.queries.mockClear();
    harness.persistInteriorPosition.mockClear();
    harness.runtime.respawnPlayer("player-1");
    expect(harness.runtime.get("player-1")?.player).toMatchObject({
      ...CISTERN_WARRENS_SPAWN, targetX: null, targetY: null
    });
    expect(harness.persistInteriorPosition).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: "sewer:sewer-1", spaceId: "hatch_landing",
      x: CISTERN_WARRENS_SPAWN.x, y: CISTERN_WARRENS_SPAWN.y
    }));
    expect(harness.queries).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE cistern_warrens_presence SET local_x=$2"),
      ["player-1", 80, 32]
    );
  });

  it("repositions combat players in canonical room bounds and cancels their movement route", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1",
      spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    harness.runtime.moveTo("player-1", "session-1", 500, 500);

    expect(harness.runtime.repositionCombatPlayer(
      "player-1",
      dungeonLocalToCombatPosition(520, 220)
    )).toBe(true);
    expect(harness.runtime.get("player-1")?.player).toMatchObject({
      targetX: null, targetY: null
    });
    expect(harness.runtime.get("player-1")?.player.x).toBeCloseTo(520);
    expect(harness.runtime.get("player-1")?.player.y).toBeCloseTo(220);

    await harness.runtime.tick(1);
    expect(harness.runtime.get("player-1")?.player.x).toBeCloseTo(520);
    expect(harness.runtime.get("player-1")?.player.y).toBeCloseTo(220);
    expect(harness.runtime.repositionCombatPlayer(
      "player-1",
      dungeonLocalToCombatPosition(10, 200)
    )).toBe(false);
  });

  it("discards a feature projection for a different canonical Sewer", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24, sewerId: "sewer-other" });
    await expect(harness.runtime.restore(player(), {
      sewerId: "sewer-1",
      spaceId: "hatch_landing",
      position: { x: 500, y: 200 }
    })).resolves.toBeNull();
    expect(harness.queries).toHaveBeenCalledWith(
      "DELETE FROM cistern_warrens_presence WHERE player_id=$1",
      ["player-1"]
    );
    expect(harness.runtime.get("player-1")).toBeNull();
  });

  it("restores a valid authored dungeon canonical location without ejecting it", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    catalog.entrances.push({ id: "cave-a", dungeonId: "cistern_warrens", revision: "entrance-v1",
      retired: false, name: "Test Cave", description: "Fixture only", lat: 35, lon: -106,
      interactionRadiusM: 8, footprintRadiusM: 5, portalId: "world-to-entrance",
      portalRevision: "portal-v1", interactionLabel: "Enter Cave", presentation: "cave",
      assetKey: null });
    catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.instancePolicy = "solo_ephemeral";
    const instanceId = "dungeon:cave-a:player:player-1";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM dungeon_presence WHERE player_id")) return { rows: [{
        sewer_structure_id: "cave-a", session_id: "session-1", local_x: 150, local_y: 175,
        return_region_code: "world", return_lat: 35, return_lon: -106,
        instance_id: instanceId, dungeon_id: "cistern_warrens",
        run_id: "00000000-0000-4000-8000-000000000001"
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const runtime = new CisternWarrensRuntime({ query } as never, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, CISTERN_WARRENS_DUNGEON, {}, catalog);
    const restored = await runtime.restore(player(), {
      sewerId: "cave-a", spaceId: "hatch_landing", position: { x: 500, y: 200 },
      instanceId, locationType: "dungeon"
    });
    expect(restored).toMatchObject({ entranceId: "cave-a", dungeonId: "cistern_warrens",
      instanceId, instancePolicy: "solo_ephemeral", spaceId: "hatch_landing" });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("DELETE FROM dungeon_presence"),
      expect.anything());
    await expect(runtime.restore(player(), {
      sewerId: "cave-a", spaceId: "hatch_landing", position: { x: 500, y: 200 },
      instanceId: `${instanceId}-stale`, locationType: "dungeon"
    })).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM dungeon_presence WHERE player_id=$1", ["player-1"]
    );
  });

  it("restores the persisted authored run identity and distinguishes ordered rewards", async () => {
    const runId = "00000000-0000-4000-8000-000000000091";
    const dungeon = interactiveDungeon();
    dungeon.rewardTableIds = ["basic_dungeon_chest"];
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.actions.push({
      type: "grant_reward", rewardTableId: "basic_dungeon_chest"
    });
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.actions.push({
      type: "grant_reward", rewardTableId: "basic_dungeon_chest"
    });
    const catalog = authoredCatalog(dungeon);
    const grantReward = vi.fn(async () => undefined);
    const instanceId = "dungeon:cave-a";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM dungeon_presence WHERE player_id")) return { rows: [{
        sewer_structure_id: "cave-a", session_id: "session-1", local_x: 420, local_y: 360,
        return_region_code: "world", return_lat: 35, return_lon: -106,
        instance_id: instanceId, dungeon_id: dungeon.id, run_id: runId
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const runtime = new CisternWarrensRuntime({ query } as never, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, { grantReward }, catalog);
    await runtime.restore(player(), {
      sewerId: "cave-a", spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId, locationType: "dungeon"
    });
    runtime.interact("player-1", "session-1", "test-valve", "reward-request");
    await vi.waitFor(() => expect(grantReward).toHaveBeenCalled());
    expect(grantReward).toHaveBeenNthCalledWith(1, "player-1", "basic_dungeon_chest", {
      instanceId, runId, dungeonId: dungeon.id, rewardSourceId: "lock-once:reward:1", torchTotal: 1,
      requestId: "reward-request"
    });
    expect(grantReward).toHaveBeenNthCalledWith(2, "player-1", "basic_dungeon_chest", {
      instanceId, runId, dungeonId: dungeon.id, rewardSourceId: "lock-once:reward:2", torchTotal: 1,
      requestId: "reward-request"
    });
  });

  it("pays a run reward once to each of five connected members, and a replay pays nothing", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "shared_persistent";
    dungeon.rewardTableIds = ["basic_dungeon_chest"];
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.actions.push({
      type: "set_dungeon_flag", flagId: "paid", value: true
    });
    dungeon.triggers.push({
      id: "pay-all", retired: false, enabled: true, scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "dungeon_flag", flagId: "paid", value: true }, conditions: { mode: "all", items: [] },
      actions: [{ type: "grant_run_reward", rewardTableId: "basic_dungeon_chest", recipients: "present" }]
    });
    const catalog = authoredCatalog(dungeon);
    expect(dungeonCatalogValidationIssues(catalog).map((issue) => issue.message)
      .filter((message) => message.startsWith("run rewards") || message.includes("dungeon_flag event"))).toEqual([]);
    const grantReward = vi.fn(async () => undefined);
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, { grantReward }, catalog);
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    const members = ["player-1", "player-2", "player-3", "player-4", "player-5"];
    const entered = [];
    for (const playerId of members) entered.push(await runtime.enter(player(playerId), "cave-a", canonical));
    const runId = database.presences.get("player-1")!.runId;

    runtime.interact("player-1", entered[0]!.sessionId, "test-valve", "pay-request");
    await vi.waitFor(() => expect(grantReward).toHaveBeenCalledTimes(5));
    expect(grantReward.mock.calls.map((call) => (call as unknown[])[0]).sort()).toEqual(members);
    for (const playerId of members) {
      expect(grantReward).toHaveBeenCalledWith(playerId, "basic_dungeon_chest", {
        instanceId: "dungeon:cave-a", runId, dungeonId: dungeon.id,
        rewardSourceId: "pay-all:reward:0", torchTotal: 1
      });
    }

    // Replays: the same request, a fresh interaction and the flag event again pay nothing more.
    runtime.interact("player-1", entered[0]!.sessionId, "test-valve", "pay-request");
    runtime.interact("player-2", entered[1]!.sessionId, "test-valve", "pay-request-2");
    const internals = runtime as unknown as { instances: Map<string, unknown>;
      dispatch(instance: unknown, event: Record<string, unknown>): void };
    internals.dispatch(internals.instances.get("dungeon:cave-a"), { type: "dungeon_flag", flagId: "paid", value: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(grantReward).toHaveBeenCalledTimes(5);
  });

  it("pays a member who was disconnected when the run reward fired once they restore into the run", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "shared_persistent";
    dungeon.rewardTableIds = ["basic_dungeon_chest"];
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.actions.push({
      type: "set_dungeon_flag", flagId: "paid", value: true
    });
    dungeon.triggers.push({
      id: "pay-all", retired: false, enabled: true, scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "dungeon_flag", flagId: "paid", value: true }, conditions: { mode: "all", items: [] },
      actions: [{ type: "grant_run_reward", rewardTableId: "basic_dungeon_chest", recipients: "present" }]
    });
    const grantReward = vi.fn(async () => undefined);
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, { grantReward }, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    const first = await runtime.enter(player("player-1"), "cave-a", canonical);
    await runtime.enter(player("player-2"), "cave-a", canonical);
    const runId = database.presences.get("player-1")!.runId;
    runtime.suspend("player-2");

    runtime.interact("player-1", first.sessionId, "test-valve", "pay-request");
    await vi.waitFor(() => expect(grantReward).toHaveBeenCalledTimes(1));
    expect(grantReward).toHaveBeenCalledWith("player-1", "basic_dungeon_chest", expect.anything());

    database.query.mockImplementationOnce((async () => ({ rows: [{
      sewer_structure_id: "cave-a", session_id: "restored-session", local_x: 420, local_y: 360,
      return_region_code: "world", return_lat: 35, return_lon: -106,
      instance_id: "dungeon:cave-a", dungeon_id: dungeon.id, run_id: runId
    }], rowCount: 1 })) as never);
    await runtime.restore(player("player-2"), { sewerId: "cave-a", ...canonical });
    await vi.waitFor(() => expect(grantReward).toHaveBeenCalledTimes(2));
    expect(grantReward).toHaveBeenLastCalledWith("player-2", "basic_dungeon_chest", {
      instanceId: "dungeon:cave-a", runId, dungeonId: dungeon.id,
      rewardSourceId: "pay-all:reward:0", torchTotal: 1
    });

    // A late joiner who enters after the reward fired and then restores is never paid.
    await runtime.enter(player("player-3"), "cave-a", canonical);
    runtime.suspend("player-3");
    database.query.mockImplementationOnce((async () => ({ rows: [{
      sewer_structure_id: "cave-a", session_id: "late-session", local_x: 420, local_y: 360,
      return_region_code: "world", return_lat: 35, return_lon: -106,
      instance_id: "dungeon:cave-a", dungeon_id: dungeon.id, run_id: runId
    }], rowCount: 1 })) as never);
    await runtime.restore(player("player-3"), { sewerId: "cave-a", ...canonical });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(grantReward).toHaveBeenCalledTimes(2);
    expect(grantReward).not.toHaveBeenCalledWith("player-3", expect.anything(), expect.anything());
  });

  it("keeps run reward eligibility across a restart (persisted with the trigger state)", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "shared_persistent";
    dungeon.rewardTableIds = ["basic_dungeon_chest"];
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.actions.push({
      type: "set_dungeon_flag", flagId: "paid", value: true
    });
    dungeon.triggers.push({
      id: "pay-all", retired: false, enabled: true, scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "dungeon_flag", flagId: "paid", value: true }, conditions: { mode: "all", items: [] },
      actions: [{ type: "grant_run_reward", rewardTableId: "basic_dungeon_chest", recipients: "present" }]
    });
    const grantReward = vi.fn(async () => undefined);
    const database = genericDungeonDatabase();
    const combat = { syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0) } as never;
    const runtime = new CisternWarrensRuntime(database.pool, combat, undefined, dungeon, { grantReward }, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    const first = await runtime.enter(player("player-1"), "cave-a", canonical);
    await runtime.enter(player("player-2"), "cave-a", canonical);
    const runId = database.presences.get("player-1")!.runId;
    runtime.suspend("player-2");
    runtime.interact("player-1", first.sessionId, "test-valve", "pay-request");
    await vi.waitFor(() => expect(grantReward).toHaveBeenCalledTimes(1));
    const persisted = () => database.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO dungeon_instance_state"));
    await vi.waitFor(() => expect(persisted().some(([, values]) =>
      JSON.parse(String((values as unknown[])[6]))["pay-all"]?.rewardEligible?.includes("player-2"))).toBe(true));
    const triggerStates = [...persisted()].reverse().find(([, values]) =>
      JSON.parse(String((values as unknown[])[6]))["pay-all"]?.rewardEligible)![1] as unknown[];
    expect(JSON.parse(String(triggerStates[6]))["pay-all"].rewardEligible.sort()).toEqual(["player-1", "player-2"]);

    // A fresh runtime (server restart) hydrates the eligibility from the stored trigger state.
    const restartedGrant = vi.fn(async () => undefined);
    const restarted = new CisternWarrensRuntime(database.pool, combat, undefined, dungeon,
      { grantReward: restartedGrant }, authoredCatalog(dungeon));
    const stored = { object_states: {}, object_availability: {}, portal_locks: {}, flags: { paid: true },
      trigger_states: JSON.parse(String(triggerStates[6])), encounter_states: {}, completed: false, cues: [] };
    const restoreRow = (playerId: string) => ({ rows: [{
      sewer_structure_id: "cave-a", session_id: `${playerId}-session`, local_x: 420, local_y: 360,
      return_region_code: "world", return_lat: 35, return_lon: -106,
      instance_id: "dungeon:cave-a", dungeon_id: dungeon.id, run_id: runId
    }], rowCount: 1 });
    const base = database.query.getMockImplementation()!;
    database.query.mockImplementation((async (sql: string, values: unknown[] = []) =>
      String(sql).includes("FROM dungeon_instance_state") ? { rows: [stored], rowCount: 1 } : base(sql, values)) as never);
    database.query.mockImplementationOnce((async () => restoreRow("player-2")) as never);
    await restarted.restore(player("player-2"), { sewerId: "cave-a", ...canonical });
    await vi.waitFor(() => expect(restartedGrant).toHaveBeenCalledWith("player-2", "basic_dungeon_chest", expect.anything()));
    database.query.mockImplementationOnce((async () => restoreRow("player-9")) as never);
    await restarted.restore(player("player-9"), { sewerId: "cave-a", ...canonical });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restartedGrant).toHaveBeenCalledTimes(1);
  });

  it("rejects run rewards on player events and player-scoped triggers", () => {
    const dungeon = interactiveDungeon();
    dungeon.rewardTableIds = ["basic_dungeon_chest"];
    dungeon.triggers.push({
      id: "bad-run-reward", retired: false, enabled: true, scope: "player", repetition: "repeat", cooldownMs: 0,
      event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "grant_run_reward", rewardTableId: "basic_dungeon_chest", recipients: "room_present" }]
    });
    const messages = dungeonCatalogValidationIssues(authoredCatalog(dungeon)).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      "run rewards fire only on encounter_state, room_clear or dungeon_flag events",
      "run rewards pay every member once, so the trigger must be instance-scoped",
      "run rewards fire once per run"
    ]));
  });

  it("serializes simultaneous shared entrants onto one authored run", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "shared_persistent";
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, {}, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a", locationType: "dungeon" as const };

    await Promise.all([
      runtime.enter(player("player-1"), "cave-a", canonical),
      runtime.enter(player("player-2"), "cave-a", canonical)
    ]);

    expect(database.presences.get("player-1")?.runId)
      .toBe(database.presences.get("player-2")?.runId);
    expect(database.advisoryLocks).toHaveBeenCalledTimes(2);
  });

  it("uses full scene payloads for direct snapshots and deltas for periodic broadcasts", async () => {
    const source = readFileSync(new URL("./dungeon.ts", import.meta.url), "utf8");
    const updateBuilder = source.slice(
      source.indexOf("private updateSnapshot"),
      source.indexOf("private playerSnapshot")
    );
    expect(updateBuilder).toContain("this.commonSnapshot(session)");
    expect(updateBuilder).not.toContain("this.snapshot(session)");
    expect(updateBuilder).not.toContain("structuredClone");

    const harness = runtimeHarness({ localX: 14, localY: 24 });
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(restored).toMatchObject({ snapshotKind: "full", room: { id: "hatch_landing" } });
    expect(restored?.prefabs.length).toBeGreaterThan(0);
    const periodic = harness.runtime.activeSnapshots()[0]?.snapshot;
    expect(periodic).toMatchObject({
      snapshotKind: "update",
      catalogRevision: restored?.catalogRevision,
      dungeonRevision: restored?.dungeonRevision,
      spaceId: restored?.spaceId,
      sceneRevision: restored?.sceneRevision
    });
    expect(periodic).not.toHaveProperty("room");
    expect(periodic).not.toHaveProperty("prefabs");
    const moved = harness.runtime.moveTo("player-1", "session-1", 200, 150);
    expect(moved).toMatchObject({ snapshotKind: "full", room: { id: "hatch_landing" } });
    const transferred = harness.runtime.transferSpace(
      "player-1", "session-1", "overflow_channel", { x: 100, y: 150 }
    );
    expect(transferred).toMatchObject({
      snapshotKind: "full", spaceId: "overflow_channel", room: { id: "overflow_channel" }
    });
    expect(transferred.prefabs.length).toBeGreaterThan(0);
    expect(transferred.sceneRevision).not.toBe(restored?.sceneRevision);
  });

  it("wires the production runtime to the existing party authority", () => {
    const source = readFileSync(new URL("../application.ts", import.meta.url), "utf8");
    expect(source).toContain("partyIdForPlayer: (playerId) => partyAuthority.partyForPlayer(playerId)?.partyId ?? null");
  });

  it("projects catalog objects dynamically", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    catalog.prefabs.push({
      id: "test_object", revision: "test-object-v1", name: "Test Object",
      type: "object", retired: false, defaultWidth: 48, defaultHeight: 48,
      defaultLayerId: "actors",
      assetKey: "apps/client/public/assets/dungeons/test-object.png",
      renderMode: "sprite", nativeWidth: 48, nativeHeight: 48,
      pivotX: 0.5, pivotY: 0.5, defaultOpacity: 1, defaultRotationDeg: 0,
      defaultFlipX: false, defaultFlipY: false, stateAssets: [], defaultColliders: [],
      interactionRadius: 64
    });
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const entrance = dungeon.rooms.find((room) => room.id === "hatch_landing")!;
    entrance.anchors.push({ id: "test_valve", retired: false, x: 420, y: 360 });
    entrance.objects.push({
      id: "test-valve", retired: false, type: "valve", prefabId: "test_object",
      prefabRevision: "test-object-v1", layerId: "actors", name: "Test Valve",
      anchorId: "test_valve", available: true, initialState: "off", interactionRadius: 64,
      rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0
    });
    validateDungeonCatalog(catalog);
    const harness = runtimeHarness({ localX: 14, localY: 24 }, dungeon);
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(restored?.objects).toContainEqual(expect.objectContaining({
      id: "test-valve", kind: "valve", name: "Test Valve",
      x: 420, y: 360, available: true
    }));
  });

  it("accepts active room IDs from the injected catalog", async () => {
    const dungeon = structuredClone(CISTERN_WARRENS_DUNGEON);
    const annex = structuredClone(dungeon.rooms.find((room) => room.id === "overflow_channel")!);
    annex.id = "sewer_annex";
    annex.name = "Sewer Annex";
    dungeon.rooms.push(annex);
    const harness = runtimeHarness({ localX: 14, localY: 24 }, dungeon);
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "sewer_annex", position: { x: 130, y: 400 }
    });
    expect(restored).toMatchObject({ spaceId: "sewer_annex", roomWidth: 1_600, roomHeight: 800 });
  });

  it("marks catalog portal objects unavailable when their portal is disabled", async () => {
    const dungeon = structuredClone(CISTERN_WARRENS_DUNGEON);
    dungeon.portals.find((portal) => portal.id === "hatch-to-overflow")!.enabled = false;
    const harness = runtimeHarness({ localX: 14, localY: 24 }, dungeon);
    const restored = await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(restored?.objects.filter((object) => object.kind === "portal")).toEqual([
      expect.objectContaining({ id: "world-exit", available: true }),
      expect.objectContaining({ id: "door-e", available: false })
    ]);
  });

  it("rejects invalid catalog room IDs during restore and transfer", async () => {
    const invalidRestore = runtimeHarness({ localX: 14, localY: 24 });
    await expect(invalidRestore.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "unknown_room", position: { x: 100, y: 100 }
    })).resolves.toBeNull();
    expect(invalidRestore.queries).toHaveBeenCalledWith(
      "DELETE FROM cistern_warrens_presence WHERE player_id=$1", ["player-1"]
    );

    const active = runtimeHarness({ localX: 14, localY: 24 });
    await active.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(() => active.runtime.transferSpace(
      "player-1", "session-1", "unknown_room", { x: 100, y: 100 }
    )).toThrowError(expect.objectContaining({ code: "INVALID_SPACE" }));
  });

  it("rejects remote interaction and applies an idempotent authoritative object transition", async () => {
    const dungeon = interactiveDungeon();
    const far = runtimeHarness({ localX: 14, localY: 24 }, dungeon);
    await far.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 500, y: 200 }
    });
    expect(() => far.runtime.interact("player-1", "session-1", "test-valve", "far"))
      .toThrowError(expect.objectContaining({ code: "OUT_OF_RANGE" }));

    const near = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await near.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const changed = near.runtime.interact("player-1", "session-1", "test-valve", "same-request");
    expect(changed.objects.find((object) => object.id === "test-valve")?.state).toBe("on");
    const duplicate = near.runtime.interact("player-1", "session-1", "test-valve", "same-request");
    expect(duplicate.objects.find((object) => object.id === "test-valve")?.state).toBe("on");
    expect(duplicate.triggers.find((trigger) => trigger.id === "lock-once")?.firedCount).toBe(1);
    const depthsPortalId = duplicate.objects.find((object) => object.id === "door-e")?.portalId;
    expect(depthsPortalId).toBe("sewer:sewer-1:hatch-to-overflow");
    expect(duplicate.portalLocks[depthsPortalId!]).toBe(true);
    expect(duplicate.portalLocks["hatch-to-overflow"]).toBeUndefined();
    expect(() => near.runtime.authorizePortal("player-1", "sewer:sewer-1:hatch-to-overflow"))
      .toThrowError(expect.objectContaining({ code: "PORTAL_LOCKED" }));
  });

  it("serializes an instance-scoped once trigger across two occupants", async () => {
    const dungeon = interactiveDungeon();
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player("player-1"), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    await harness.runtime.restore(player("player-2"), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    harness.runtime.interact("player-1", "session-1", "test-valve", "first");
    const second = harness.runtime.interact("player-2", "session-1", "test-valve", "second");
    expect(second.triggers.find((trigger) => trigger.id === "lock-once")?.firedCount).toBe(1);
  });

  it("shares party-scoped repetition only across members from the party authority", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.scope = "party";
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon, {
      partyIdForPlayer: (playerId) => playerId === "player-3" ? "party-b" : "party-a"
    });
    for (const playerId of ["player-1", "player-2", "player-3"]) {
      await harness.runtime.restore(player(playerId), {
        sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
      });
    }
    harness.runtime.interact("player-1", "session-1", "test-valve", "party-a-first");
    harness.runtime.interact("player-2", "session-1", "test-valve", "party-a-second");
    const otherParty = harness.runtime.interact("player-3", "session-1", "test-valve", "party-b-first");
    expect(otherParty.triggers.find((trigger) => trigger.id === "lock-once")?.firedCount).toBe(2);
  });

  it("rejects conflicting request-id reuse while replaying an identical interaction", async () => {
    const dungeon = interactiveDungeon();
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const original = harness.runtime.interact("player-1", "session-1", "test-valve", "request-1");
    expect(harness.runtime.interact("player-1", "session-1", "test-valve", "request-1"))
      .toEqual(original);
    expect(() => harness.runtime.interact("player-1", "session-1", "door-e", "request-1"))
      .toThrowError(expect.objectContaining({ code: "REQUEST_ID_REUSED" }));
  });

  it("preflights unsupported rewards without partially firing trigger actions", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.push({ id: "unsupported-reward", retired: false, enabled: true,
      scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
      conditions: { mode: "all", items: [] }, actions: [
        { type: "set_dungeon_flag", flagId: "reward-started", value: true },
        { type: "grant_reward", rewardTableId: "test-reward" }
      ] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "reward");
    expect(snapshot.triggers.find((trigger) => trigger.id === "unsupported-reward")?.firedCount).toBe(0);
    expect(snapshot.dungeonFlags["reward-started"]).toBeUndefined();
    expect(snapshot.cues).toContain("error:unsupported_reward_authority:unsupported-reward");
  });

  it("applies authored object availability independently from object state", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.push({ id: "hide-valve", retired: false, enabled: true,
      scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "room_enter", roomId: "hatch_landing" },
      conditions: { mode: "all", items: [] }, actions: [{
        type: "set_object_available", roomId: "hatch_landing",
        objectId: "test-valve", available: false
      }] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const snapshot = await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    expect(snapshot?.objects.find((object) => object.id === "test-valve"))
      .toMatchObject({ available: false, state: "off" });
  });

  it("bounds authored event cycles and exposes one diagnostic cue", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.push({ id: "cycle-start", retired: false, enabled: true, scope: "instance",
      repetition: "repeat", cooldownMs: 0,
      event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "set_dungeon_flag", flagId: "cycle-a", value: true }] });
    const cycle = [
      ["cycle-a", true, "cycle-b", true], ["cycle-b", true, "cycle-a", false],
      ["cycle-a", false, "cycle-b", false], ["cycle-b", false, "cycle-a", true]
    ] as const;
    cycle.forEach(([eventFlag, eventValue, actionFlag, actionValue], index) => dungeon.triggers.push({
      id: `cycle-${index}`, retired: false, enabled: true, scope: "instance", repetition: "repeat",
      cooldownMs: 0, event: { type: "dungeon_flag", flagId: eventFlag, value: eventValue },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "set_dungeon_flag", flagId: actionFlag, value: actionValue }]
    }));
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "cycle");
    expect(snapshot.cues.filter((cue) => cue === "error:event_drain_budget_exceeded")).toHaveLength(1);
  });

  it("spawns an authored encounter wave and completes it from combat life state", async () => {
    const dungeon = interactiveDungeon(true);
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    harness.runtime.interact("player-1", "session-1", "test-valve", "start-wave");
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
    const entity = [...harness.combatEntities.values()][0]!;
    entity.lifeState = "defeated";
    await harness.runtime.tick(0);
    expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "completed"
    }));
  });

  it("places random enemies inside their polygon and rerolls on a new run", async () => {
    const dungeon = interactiveDungeon(true);
    const room = dungeon.rooms.find((room) => room.id === "hatch_landing")!;
    room.zones.push({ id: "random-spawn", retired: false, purpose: "encounter_boundary", kind: "polygon",
      points: [{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }, { x: 400, y: 600 }] });
    room.mobs.find((mob) => mob.id === "test_mob")!.randomSpawnZoneId = "random-spawn";
    const positions = [];
    const combatIds: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
      const database = genericDungeonDatabase();
      const runtime = new CisternWarrensRuntime(database.pool, harness.combat as never, undefined, dungeon, {}, authoredCatalog(dungeon));
      await runtime.enter(player(), "cave-a", { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" });
      runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "start-wave");
      const spawned = harness.combat.spawnMob.mock.calls[0]![0].position;
      // Local +y is south (negative latitude): (400, 600) is the south-west corner.
      const minimum = dungeonLocalToCombatPosition(400, 600);
      const maximum = dungeonLocalToCombatPosition(600, 400);
      expect(spawned.lat).toBeGreaterThanOrEqual(minimum.lat); expect(spawned.lat).toBeLessThanOrEqual(maximum.lat);
      expect(spawned.lon).toBeGreaterThanOrEqual(minimum.lon); expect(spawned.lon).toBeLessThanOrEqual(maximum.lon);
      positions.push(spawned);
      combatIds.push(harness.combat.spawnMob.mock.calls[0]![0].entityId);
    }
    expect(positions[0]).not.toEqual(positions[1]);
    expect(combatIds[0]).not.toEqual(combatIds[1]);
  });

  it("hydrates an authored run once so reconnect cannot clear live spawn identities", async () => {
    const dungeon = interactiveDungeon(true);
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, harness.combat as never, undefined, dungeon, {}, authoredCatalog(dungeon));
    const destination = { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    await runtime.enter(player(), "cave-a", destination);
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "start-wave");
    await runtime.restore(player(), { sewerId: "cave-a", ...destination });
    const hydrationReads = database.query.mock.calls.filter(([sql]) => String(sql).includes("FROM dungeon_instance_state"));
    expect(hydrationReads).toHaveLength(1);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
    await runtime.tick(0);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
  });

  it("spawns a rolled wave with one torch, skips higher torch sets, and still completes", async () => {
    const dungeon = rolledInteractiveDungeon();
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });
    harness.runtime.interact("player-1", "session-1", "test-valve", "start-rolled");
    const spawned = harness.combat.spawnMob.mock.calls.map(([input]) => input.entityId);
    expect(spawned).toHaveLength(3);
    expect(spawned.every((entityId) => entityId.includes(":test-encounter_roll_s1_w1_"))).toBe(true);
    for (const entity of harness.combatEntities.values()) entity.lifeState = "defeated";
    await harness.runtime.tick(0);
    expect(harness.runtime.get("player-1")?.encounters.find((encounter) => encounter.id === "test-encounter")?.state).toBe("completed");
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(3);
  });

  it("spawns every rolled torch set up to the run's torch total", async () => {
    const dungeon = rolledInteractiveDungeon();
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const runtime = CisternWarrensRuntime.ephemeral({
      combat: harness.combat as never, dungeon, catalog: authoredCatalog(dungeon),
      runId: "seed:torches", now: () => 0, torchTotal: 3
    });
    await runtime.enter(player(), "cave-a", { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" });
    runtime.interact("player-1", runtime.get("player-1")!.sessionId, "test-valve", "start-torches");
    const sets = harness.combat.spawnMob.mock.calls.map(([input]) => /_roll_s(\d+)_/u.exec(input.entityId)![1]);
    expect(sets.sort()).toEqual(["1", "1", "1", "2", "2", "2", "3", "3", "3"]);
  });

  it("re-spawns a persisted rolled wave identically when a restarted runtime hydrates the run", async () => {
    const dungeon = rolledInteractiveDungeon();
    dungeon.reset.policy = "manual";
    const database = genericDungeonDatabase();
    const persisted: { encounterStates?: string } = {};
    const base = database.query.getMockImplementation()!;
    database.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO dungeon_instance_state")) persisted.encounterStates = String(values[7]);
      if (sql.includes("FROM dungeon_instance_state") && persisted.encounterStates) {
        return { rows: [{ object_states: {}, object_availability: {}, portal_locks: {}, flags: {}, trigger_states: {},
          encounter_states: JSON.parse(persisted.encounterStates), completed: false, cues: [] }], rowCount: 1 } as never;
      }
      return base(sql, values);
    });
    const destination = { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    const spawnsOf = (combat: { spawnMob: { mock: { calls: Array<[{ entityId: string; archetype: string; position: unknown }]> } } }) =>
      combat.spawnMob.mock.calls.map(([input]) => ({ entityId: input.entityId, archetype: input.archetype, position: input.position }));

    const first = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const firstRuntime = new CisternWarrensRuntime(database.pool, first.combat as never, undefined, dungeon, {}, authoredCatalog(dungeon));
    await firstRuntime.enter(player(), "cave-a", destination);
    firstRuntime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "start-rolled");
    await firstRuntime.tick(0);
    expect(JSON.parse(persisted.encounterStates!)["test-encounter"]).toMatchObject({ state: "active", currentWaveId: "test-encounter_roll_w1" });

    const restarted = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const restartedRuntime = new CisternWarrensRuntime(database.pool, restarted.combat as never, undefined, dungeon, {}, authoredCatalog(dungeon));
    await restartedRuntime.enter(player("player-2"), "cave-a", destination);
    expect(spawnsOf(restarted.combat)).toHaveLength(3);
    expect(spawnsOf(restarted.combat)).toEqual(spawnsOf(first.combat));
  });

  it("honors zero object spawn chance and rejects interaction", async () => {
    const dungeon = interactiveDungeon(true);
    const room = dungeon.rooms.find((room) => room.id === "hatch_landing")!;
    room.objects.find((object) => object.id === "test-valve")!.spawnChance = 0;
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });
    expect(harness.runtime.get("player-1")?.objects.find((object) => object.id === "test-valve")?.available).toBe(false);
    expect(() => harness.runtime.interact("player-1", "session-1", "test-valve", "hidden-object")).toThrow();
  });

  it("publishes one stable rolled chest rarity and its assigned PNG after spawn succeeds", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = interactiveDungeon();
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    const prefab = structuredClone(catalog.prefabs.find((candidate) => candidate.id === "dungeon_chest")!);
    prefab.id = "legendary_chest_art";
    prefab.revision = "legendary-chest-art-v1";
    prefab.assetKey = "apps/client/public/assets/dungeons/custom/legendary-chest.png";
    catalog.prefabs.push(prefab);
    const chestAnchor = { id: "rarity_chest_anchor", retired: false, x: 420, y: 360 };
    room.anchors.push(chestAnchor);
    room.objects.push({
      id: "rarity-chest", retired: false, type: "chest", prefabId: "dungeon_chest",
      prefabRevision: "dungeon-chest-v2", layerId: "actors", name: "Rarity Chest",
      anchorId: chestAnchor.id, available: true, initialState: "closed", interactionRadius: 72,
      rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0,
      rewardTableId: "rarity_reward", spawnChance: 100
    });
    const rewardTable = {
      id: "rarity_reward", revision: "rarity-reward-v1", retired: false, items: [],
      chestLoot: {
        rarities: (["common", "uncommon", "rare", "epic", "legendary"] as const).map((rarity) => ({
          rarity, chance: rarity === "legendary" ? 100 : 0, slots: 1,
          ...(rarity === "legendary" ? { assetKey: prefab.assetKey } : {}),
          loot: [{ itemId: "coal", weight: 1, minQuantity: 1, maxQuantity: 1 }]
        }))
      }
    };
    catalog.rewardTables.push(rewardTable);
    catalog.rewardTableIds.push(rewardTable.id);
    dungeon.rewardTableIds.push(rewardTable.id);
    dungeon.triggers.push({
      id: "rarity-chest-reward", retired: false, enabled: true, scope: "player",
      repetition: "once", cooldownMs: 0,
      event: { type: "object_interact", roomId: room.id, objectId: "rarity-chest" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "grant_reward", rewardTableId: rewardTable.id }]
    });
    validateDungeonCatalog(catalog);
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon, {}, catalog);
    const first = await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: room.id, position: { x: 420, y: 360 }
    });
    const chest = first?.objects.find((object) => object.id === "rarity-chest");
    expect(chest).toMatchObject({
      available: true,
      rarity: "legendary",
      assetKey: prefab.assetKey
    });
    expect(harness.runtime.get("player-1")?.objects.find((object) => object.id === "rarity-chest"))
      .toMatchObject({ rarity: "legendary", assetKey: prefab.assetKey });
  });

  it("summons adds once at the leader health threshold and waits for them before clearing", async () => {
    const dungeon = interactiveDungeon(true);
    const room = dungeon.rooms.find((room) => room.id === "hatch_landing")!;
    const leader = room.mobs.find((mob) => mob.id === "test_mob")!;
    room.mobs.push({ ...leader, id: "summoned_add", summonedByMobSpawnId: leader.id, summonAtHealthPercent: 50 });
    dungeon.encounters.find((encounter) => encounter.id === "test-encounter")!.waves[0]!.mobSpawnIds.push("summoned_add");
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });
    harness.runtime.interact("player-1", "session-1", "test-valve", "spawn");
    await harness.runtime.tick(0);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
    const entity = [...harness.combatEntities.values()][0]!;
    entity.currentHealth = 5;
    await harness.runtime.tick(0); await harness.runtime.tick(0);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(2);
    entity.lifeState = "defeated"; entity.currentHealth = 0;
    await harness.runtime.tick(0);
    expect(harness.runtime.get("player-1")?.encounters.find((encounter) => encounter.id === "test-encounter")?.state).toBe("active");
    for (const mob of harness.combatEntities.values()) mob.lifeState = "defeated";
    await harness.runtime.tick(0);
    expect(harness.runtime.get("player-1")?.encounters.find((encounter) => encounter.id === "test-encounter")?.state).toBe("completed");
  });

  describe("timed rescue", () => {
    async function rescueRun(clearAfterMs: number) {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      try {
        const dungeon = interactiveDungeon(true);
        dungeon.encounters.find((encounter) => encounter.id === "test-encounter")!.rescue = { timeLimitMs: 60_000 };
        const rescueAlly = vi.fn();
        const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon, { rescueAlly });
        await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });
        harness.runtime.interact("player-1", "session-1", "test-valve", "spawn");
        await harness.runtime.tick(0);
        vi.setSystemTime(Date.now() + clearAfterMs);
        for (const mob of harness.combatEntities.values()) mob.lifeState = "defeated";
        await harness.runtime.tick(0);
        return { rescueAlly, state: harness.runtime.get("player-1")?.encounters.find((encounter) => encounter.id === "test-encounter")?.state };
      } finally {
        vi.useRealTimers();
      }
    }

    it("frees the prisoner when the encounter clears inside the time limit", async () => {
      const { rescueAlly, state } = await rescueRun(59_000);
      expect(state).toBe("completed");
      expect(rescueAlly).toHaveBeenCalledWith("player-1");
    });

    it("loses the prisoner when the encounter clears after the time limit", async () => {
      const { rescueAlly, state } = await rescueRun(61_000);
      expect(state).toBe("completed");
      expect(rescueAlly).not.toHaveBeenCalled();
    });
  });

  it("applies encounter activation and portal locks for a direct start_wave action", async () => {
    const dungeon = interactiveDungeon(true);
    const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
    encounter.lockPortalIds = ["hatch-to-overflow"];
    dungeon.triggers = dungeon.triggers.filter((trigger) =>
      trigger.id !== "lock-once" && trigger.id !== "start-test");
    dungeon.triggers.push({ id: "direct-wave", retired: false, enabled: true,
      scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "start_wave", encounterId: "test-encounter", waveId: "wave-one" }] });
    dungeon.triggers.push({ id: "observe-active", retired: false, enabled: true,
      scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "encounter_state", encounterId: "test-encounter", state: "active" },
      conditions: { mode: "all", items: [] }, actions: [{ type: "play_cue", cueId: "active" }] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "direct-wave");
    expect(snapshot.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "active", currentWaveId: "wave-one", attempts: 1
    }));
    expect(snapshot.portalLocks["sewer:sewer-1:hatch-to-overflow"]).toBe(true);
    expect(snapshot.triggers.find((trigger) => trigger.id === "observe-active")?.firedCount).toBe(1);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
  });

  it("rejects a blocked formation before mutating encounter state or portal locks", async () => {
    const dungeon = interactiveDungeon(true);
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
    encounter.lockPortalIds = ["hatch-to-overflow"];
    dungeon.triggers = dungeon.triggers.filter((trigger) => trigger.id !== "lock-once" && trigger.id !== "start-test");
    const first = room.mobs.find((mob) => mob.id === "test_mob")!;
    room.mobs.push({ ...first, id: "test_mob_two" });
    encounter.groupControls = { formation: "line", linkedAggro: false };
    encounter.waves[0]!.mobSpawnIds.push("test_mob_two");
    room.colliders.push({ id: "formation-blocker", retired: false, kind: "rectangle", x: 508, y: 450, width: 20, height: 100 });
    dungeon.triggers.push({ id: "blocked-wave", retired: false, enabled: true, scope: "instance", repetition: "once",
      cooldownMs: 0, event: { type: "object_interact", roomId: room.id, objectId: "test-valve" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "start_wave", encounterId: encounter.id, waveId: encounter.waves[0]!.id }] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });

    expect(() => harness.runtime.interact("player-1", "session-1", "test-valve", "blocked-preflight"))
      .toThrowError(expect.objectContaining({ code: "SPAWN_POSITION_BLOCKED" }));
    const afterFailure = harness.runtime.get("player-1")!;
    expect(afterFailure.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "idle", currentWaveId: null, attempts: 0
    }));
    expect(afterFailure.portalLocks["sewer:sewer-1:hatch-to-overflow"]).toBe(false);
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    await harness.runtime.tick(0);
    expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "idle", currentWaveId: null, attempts: 0
    }));
  });

  it("rejects an empty wave before activation so an empty mob set cannot auto-complete", async () => {
    const dungeon = interactiveDungeon(true);
    const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
    encounter.lockPortalIds = ["hatch-to-overflow"];
    dungeon.triggers = dungeon.triggers.filter((trigger) => trigger.id !== "lock-once");
    encounter.waves[0]!.mobSpawnIds = [];
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });

    expect(() => harness.runtime.interact("player-1", "session-1", "test-valve", "empty-wave"))
      .toThrowError(expect.objectContaining({ code: "EMPTY_WAVE" }));
    expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "idle", currentWaveId: null, attempts: 0
    }));
    await harness.runtime.tick(0);
    expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "idle", currentWaveId: null, attempts: 0
    }));
  });

  it("unlocks configured portals when a party wipe terminally fails an encounter", async () => {
    const dungeon = interactiveDungeon(true);
    const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
    encounter.lockPortalIds = ["hatch-to-overflow"];
    encounter.retry.maxAttempts = 1;
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    harness.runtime.interact("player-1", "session-1", "test-valve", "start-failing");
    expect(harness.runtime.get("player-1")?.portalLocks["sewer:sewer-1:hatch-to-overflow"])
      .toBe(true);
    harness.combatEntities.set("player-1", {
      lifeState: "defeated", targetEntityId: null, currentHealth: 0, maxHealth: 100
    });
    await harness.runtime.tick(0);
    const failed = harness.runtime.get("player-1")!;
    expect(failed.encounters).toContainEqual(expect.objectContaining({
      id: "test-encounter", state: "failed", attempts: 1
    }));
    expect(failed.portalLocks["sewer:sewer-1:hatch-to-overflow"]).toBe(false);
  });

  it("releases portal locks when spawning throws after the encounter locked them", async () => {
    const dungeon = interactiveDungeon(true);
    const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
    encounter.lockPortalIds = ["hatch-to-overflow"];
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    harness.combat.spawnMob.mockImplementationOnce(() => { throw new Error("spawn exploded"); });

    expect(() => harness.runtime.interact("player-1", "session-1", "test-valve", "spawn-throws"))
      .toThrowError("spawn exploded");
    const failed = harness.runtime.get("player-1")!;
    expect(failed.encounters).toContainEqual(expect.objectContaining({ id: "test-encounter", state: "failed" }));
    expect(failed.portalLocks["sewer:sewer-1:hatch-to-overflow"]).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("encounter=test-encounter"));
    warn.mockRestore();
  });

  it("fails an active encounter that has no live mobs and no pending wave, unlocking portals", async () => {
    const dungeon = interactiveDungeon(true);
    const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
    encounter.lockPortalIds = ["hatch-to-overflow"];
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    harness.runtime.interact("player-1", "session-1", "test-valve", "start-then-lose");
    expect(harness.runtime.get("player-1")?.portalLocks["sewer:sewer-1:hatch-to-overflow"]).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Simulate mob bookkeeping lost (e.g. a restart) while the encounter is still active.
    const instances = (harness.runtime as unknown as { instances: Map<string, { encounters: Map<string, { spawnedMobIds: Map<string, string>; nextWaveAt: number | null }> }> }).instances;
    for (const instance of instances.values()) instance.encounters.get("test-encounter")?.spawnedMobIds.clear();
    dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!.mobs.forEach((mob) => { mob.retired = true; });

    await harness.runtime.tick(0);
    const failed = harness.runtime.get("player-1")!;
    expect(failed.encounters).toContainEqual(expect.objectContaining({ id: "test-encounter", state: "failed" }));
    expect(failed.portalLocks["sewer:sewer-1:hatch-to-overflow"]).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("authorizes only live owned encounter mobs in the connected player's current space", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "overflow_channel", position: { x: 250, y: 150 }
    });
    const [mobId, mob] = [...harness.combatEntities.entries()][0]!;
    const actor: Record<string, unknown> = { kind: "player", lifeState: "alive", regionCode: mob.regionCode, zoneId: mob.zoneId };
    harness.combatEntities.set("player-1", actor);
    expect(harness.runtime.canFightMob("player-1", mobId)).toBe(true);
    expect(harness.runtime.canFightMob("world-player", mobId)).toBe(false);
    const spoofId = `${mobId}:spoof`;
    harness.combatEntities.set(spoofId, { ...mob });
    expect(harness.runtime.canFightMob("player-1", spoofId)).toBe(false);
    for (const target of [actor, mob]) {
      for (const [key, value] of [
        ["regionCode", "world"], ["regionCode", "interior:other-instance"],
        ["zoneId", "interior:sewer:sewer-1:hatch_landing"], ["lifeState", "defeated"]
      ] as const) {
        const original = target[key];
        target[key] = value;
        expect(harness.runtime.canFightMob("player-1", mobId)).toBe(false);
        target[key] = original;
      }
    }
    harness.runtime.suspend("player-1");
    expect(harness.runtime.canFightMob("player-1", mobId)).toBe(false);
  });

  it("authorizes adds summoned by the room's live encounter mobs and holds completion until they fall", async () => {
    // Kit summons (a phased boss's adds) and a Gate Warden's rift cultists are spawned outside the
    // encounter's wave list; they carry their summoner and must be fightable in the same room.
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "overflow_channel", position: { x: 250, y: 150 }
    });
    const [mobId, mob] = [...harness.combatEntities.entries()][0]!;
    harness.combatEntities.set("player-1", { kind: "player", lifeState: "alive", regionCode: mob.regionCode, zoneId: mob.zoneId });
    const add: Record<string, unknown> = { ...mob, entityId: "summoned-add", summonedByEntityId: mobId };
    harness.combatEntities.set("summoned-add", add);
    expect(harness.runtime.canFightMob("player-1", "summoned-add")).toBe(true);
    harness.combatEntities.set("stray-add", { ...mob, entityId: "stray-add", summonedByEntityId: "some-world-mob" });
    expect(harness.runtime.canFightMob("player-1", "stray-add")).toBe(false);
    harness.combatEntities.set("other-room-add", { ...add, entityId: "other-room-add", zoneId: "interior:sewer:sewer-1:hatch_landing" });
    expect(harness.runtime.canFightMob("player-1", "other-room-add")).toBe(false);
    harness.combatEntities.delete("stray-add");
    harness.combatEntities.delete("other-room-add");

    // Every wave mob falls but the add lives: the encounter stays active.
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    try {
      const lockId = "sewer:sewer-1:overflow-to-hatch";
      for (let round = 0; round < 12; round += 1) {
        for (const call of harness.combat.spawnMob.mock.calls) {
          const entity = harness.combatEntities.get(call[0].entityId);
          if (entity) entity.lifeState = "defeated";
        }
        vi.setSystemTime(Date.now() + 10_000);
        await harness.runtime.tick(0);
      }
      expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
        id: "overflow-rats", state: "active"
      }));
      expect(harness.runtime.get("player-1")?.portalLocks[lockId]).toBe(true);
      add.lifeState = "defeated";
      await harness.runtime.tick(0);
      expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
        id: "overflow-rats", state: "completed"
      }));
      expect(harness.runtime.get("player-1")?.portalLocks[lockId]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fights the shipped Overflow Channel rats through the application's combat callbacks and unlocks return", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    try {
      const harness = runtimeHarness({ localX: 14, localY: 24 });
      // Evaluate the actual bootstrap callbacks, so a missing interior branch fails this test.
      const source = readFileSync(new URL("../application.ts", import.meta.url), "utf8");
      const callbackSource = source.slice(source.indexOf("    isPlayerMobAttackAuthorized:"),
        source.indexOf("    resolveMobRetreatDestination:"));
      const callbacks = new Function("hollinHutsRef", "dungeonRef", "overworldBossEvents", "goblinVillageRef", "worldRuntimeRef", "overworldBossHandlerForEntity",
        `return ({${callbackSource}});`)(undefined, harness.runtime,
        { handlerForEntity: () => undefined }, undefined, undefined, () => undefined) as
        Pick<ConstructorParameters<typeof CombatEngine>[0], "isPlayerMobAttackAuthorized" |
          "isMobPlayerAttackAuthorized" | "canMobProactivelyAcquire" | "canMobContinueIntent">;
      const settled = vi.fn(() => true);
      const engine = new CombatEngine({ tickRateHz: 20, isPlayerAuthorityActive: () => true,
        onDefeatSettlementCandidate: settled, ...callbacks, getAuthoritativeViewCircle: (id) => harness.runtime.gameplayViewCircle(id) });
      harness.combat.entity.mockImplementation((id) => engine.entity(id) as never);
      harness.combat.syncPlayer.mockImplementation((input) => { engine.syncPlayer(input as never); });
      harness.combat.spawnMob.mockImplementation((input) => engine.spawnMob(input as never) as never);
      engine.connectPlayer({ playerId: "player-1", name: "Player", regionCode: "world", zoneId: "world",
        position: { lat: 35, lon: -106 }, accountId: "account", connectionId: "connection",
        profile: { playerId: "player-1", maxHealth: 10000, currentHealth: 10000, baseAttackDamage: 1000 } });
      await harness.runtime.restore(player(), {
        sewerId: "sewer-1", spaceId: "overflow_channel", position: { x: 130, y: 400 }
      });
      const lockId = "sewer:sewer-1:overflow-to-hatch";
      expect(harness.runtime.get("player-1")?.portalLocks[lockId]).toBe(true);
      const unowned = engine.spawnMob({ entityId: "dungeon:sewer:sewer-1:spoof", archetype: "goblin",
        position: dungeonLocalToCombatPosition(130, 400), regionCode: "interior:sewer:sewer-1",
        zoneId: "interior:sewer:sewer-1:overflow_channel" });
      expect(() => engine.startAttack({ attackerId: "player-1", targetEntityId: unowned.entityId,
        requestId: "unowned", accountId: "account", connectionId: "connection" })).toThrow();
      expect(callbacks.isMobPlayerAttackAuthorized!(unowned.entityId, "player-1")).toBe(false);
      expect(callbacks.canMobProactivelyAcquire!(unowned.entityId, "player-1")).toBe(false);
      expect(callbacks.canMobContinueIntent!(unowned.entityId, "player-1")).toBe(false);
      engine.despawnMob(unowned.entityId);
      for (let wave = 0; wave < 4; wave += 1) {
        const mobId = harness.combat.spawnMob.mock.calls[wave]![0].entityId;
        const mob = engine.entity(mobId)!;
        expect(callbacks.isPlayerMobAttackAuthorized!("player-1", mobId)).toBe(true);
        expect(callbacks.isMobPlayerAttackAuthorized!(mobId, "player-1")).toBe(true);
        expect(callbacks.canMobProactivelyAcquire!(mobId, "player-1")).toBe(true);
        expect(callbacks.canMobContinueIntent!(mobId, "player-1")).toBe(true);
        engine.syncPlayer({ playerId: "player-1", position: { lat: mob.lat, lon: mob.lon },
          regionCode: mob.regionCode, zoneId: mob.zoneId });
        engine.updatePlayerPveStats("player-1", { level: 1, maxHealth: 10000, attackPower: 1, defense: 0 });
        const healthBefore = engine.entity("player-1")!.currentHealth;
        engine.startAttack({ attackerId: "player-1", targetEntityId: mobId, requestId: `engage-${wave}`,
          accountId: "account", connectionId: "connection" });
        for (let tick = 0; tick < 200 && engine.entity("player-1")!.currentHealth === healthBefore; tick += 1) {
          vi.setSystemTime(Date.now() + 50);
          engine.tick();
        }
        expect(engine.entity("player-1")!.currentHealth).toBeLessThan(healthBefore);
        engine.updatePlayerPveStats("player-1", { level: 1, maxHealth: 10000, attackPower: 1000, defense: 0 });
        engine.startAttack({ attackerId: "player-1", targetEntityId: mobId, requestId: `wave-${wave}`,
          accountId: "account", connectionId: "connection" });
        for (let tick = 0; tick < 200 && engine.entity(mobId)?.lifeState === "alive"; tick += 1) {
          vi.setSystemTime(Date.now() + 50);
          engine.tick();
        }
        expect(settled).toHaveBeenCalledWith(expect.objectContaining({ defeatedEntityId: mobId }));
        expect(engine.entity(mobId)).toBeNull();
        expect(harness.runtime.canFightMob("player-1", mobId)).toBe(false);
        await harness.runtime.tick(0);
        if (wave < 3) expect(harness.runtime.get("player-1")?.portalLocks[lockId]).toBe(true);
      }
      expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
        id: "overflow-rats", state: "completed"
      }));
      expect(harness.runtime.get("player-1")?.portalLocks[lockId]).toBe(false);
      const completedMob = harness.combat.spawnMob.mock.calls[3]![0];
      engine.spawnMob(completedMob as never);
      expect(harness.runtime.canFightMob("player-1", completedMob.entityId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the shipped Turtle Cistern encounter and reveals its alcove chest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    try {
      const harness = runtimeHarness({ localX: 14, localY: 24 });
      await harness.runtime.restore(player(), {
        sewerId: "sewer-1", spaceId: "turtle_cistern", position: { x: 130, y: 580 }
      });
      expect(harness.combat.spawnMob).toHaveBeenCalledTimes(3);
      expect(harness.runtime.get("player-1")?.encounters).toContainEqual(expect.objectContaining({
        id: "cistern-rats", state: "active", currentWaveId: "wave-1"
      }));
      for (const rat of harness.combatEntities.values()) rat.lifeState = "defeated";
      await harness.runtime.tick(0);

      const completed = harness.runtime.get("player-1")!;
      expect(completed.encounters).toContainEqual(expect.objectContaining({
        id: "cistern-rats", state: "completed"
      }));
      expect(completed.triggers.find((trigger) => trigger.id === "reveal-alcove-chest")?.firedCount)
        .toBe(1);
      expect(completed.objects.find((object) => object.id === "alcove-chest"))
        .toMatchObject({ available: true, state: "closed" });
      expect(completed.cues).toContain("cache_revealed");
      expect(completed.notices!.every((notice) => notice.tone === "success")).toBe(true);
      expect(completed.notices!.some((notice) => /appeared.$/.test(notice.text))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("announces authored show_message text and lets it replace automatic notices", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.push(
      { id: "authored-message", retired: false, enabled: true, scope: "instance", repetition: "once",
        cooldownMs: 0, event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
        conditions: { mode: "all", items: [] },
        actions: [{ type: "complete_dungeon" }, { type: "show_message", text: "The valve groans.", tone: "warning" }] },
      { id: "auto-complete", retired: false, enabled: true, scope: "instance", repetition: "once",
        cooldownMs: 0, event: { type: "object_state", roomId: "hatch_landing", objectId: "test-valve", state: "on" },
        conditions: { mode: "all", items: [] }, actions: [{ type: "complete_dungeon" }] }
    );
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "pull");
    expect(snapshot.notices).toEqual([
      expect.objectContaining({ text: "The valve groans.", tone: "warning" })
    ]);
    expect(snapshot.notices!.some((notice) => /Dungeon complete/.test(notice.text))).toBe(false);
  });

  it("announces dungeon completion automatically when no message is authored", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.push({ id: "auto-complete", retired: false, enabled: true, scope: "instance",
      repetition: "once", cooldownMs: 0,
      event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
      conditions: { mode: "all", items: [] }, actions: [{ type: "complete_dungeon" }] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "pull");
    expect(snapshot.notices).toEqual([
      expect.objectContaining({ text: "Dungeon complete.", tone: "success" })
    ]);
  });

  it("suppresses duplicate cooldown activation until its authored deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const dungeon = interactiveDungeon();
      dungeon.triggers.push({ id: "cooldown-trigger", retired: false, enabled: true,
        scope: "instance", repetition: "cooldown", cooldownMs: 100,
        event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
        conditions: { mode: "all", items: [] }, actions: [{ type: "play_cue", cueId: "valve-click" }] });
      const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
      await harness.runtime.restore(player(), {
        sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
      });
      harness.runtime.interact("player-1", "session-1", "test-valve", "one");
      let snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "two");
      expect(snapshot.triggers.find((trigger) => trigger.id === "cooldown-trigger")?.firedCount).toBe(1);
      vi.setSystemTime(10_101);
      snapshot = harness.runtime.interact("player-1", "session-1", "test-valve", "three");
      expect(snapshot.triggers.find((trigger) => trigger.id === "cooldown-trigger")?.firedCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms a repeated timer when its conditions initially do not match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    try {
      const dungeon = interactiveDungeon();
      dungeon.triggers.push({ id: "conditional-timer", retired: false, enabled: true,
        scope: "instance", repetition: "repeat", cooldownMs: 0,
        event: { type: "timer", delayMs: 100 },
        conditions: { mode: "all", items: [{ type: "object_state", roomId: "hatch_landing",
          objectId: "test-valve", state: "on" }] },
        actions: [{ type: "play_cue", cueId: "timer-fired" }] });
      const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
      await harness.runtime.restore(player(), {
        sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
      });
      vi.setSystemTime(20_100);
      await harness.runtime.tick(0);
      expect(harness.runtime.get("player-1")?.cues).not.toContain("timer-fired");
      harness.runtime.interact("player-1", "session-1", "test-valve", "turn-on");
      vi.setSystemTime(20_200);
      await harness.runtime.tick(0);
      expect(harness.runtime.get("player-1")?.cues).toContain("timer-fired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits all_players_present only when that room-zone crosses its edge", async () => {
    const dungeon = interactiveDungeon();
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    room.zones.push({ id: "wide-zone", retired: false, kind: "rectangle", purpose: "trigger",
      x: 300, y: 300, width: 300, height: 200 });
    room.zones.push({ id: "narrow-zone", retired: false, kind: "rectangle", purpose: "trigger",
      x: 410, y: 340, width: 20, height: 40 });
    dungeon.triggers.push({ id: "wide-all", retired: false, enabled: true, scope: "instance",
      repetition: "repeat", cooldownMs: 0,
      event: { type: "all_players_present", roomId: room.id, zoneId: "wide-zone" },
      conditions: { mode: "all", items: [] }, actions: [{ type: "play_cue", cueId: "wide-all" }] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: room.id, position: { x: 420, y: 360 }
    });
    expect(harness.runtime.get("player-1")?.triggers.find((trigger) => trigger.id === "wide-all")?.firedCount).toBe(1);
    expect(harness.runtime.repositionCombatPlayer("player-1", dungeonLocalToCombatPosition(450, 360))).toBe(true);
    expect(harness.runtime.get("player-1")?.triggers.find((trigger) => trigger.id === "wide-all")?.firedCount).toBe(1);
  });

  it("clears all_players_present when a new occupant joins outside and refires on re-entry", async () => {
    const dungeon = interactiveDungeon();
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    room.zones.push({ id: "party-zone", retired: false, kind: "rectangle", purpose: "trigger",
      x: 300, y: 300, width: 300, height: 200 });
    dungeon.triggers.push({ id: "party-all", retired: false, enabled: true, scope: "instance",
      repetition: "repeat", cooldownMs: 0,
      event: { type: "all_players_present", roomId: room.id, zoneId: "party-zone" },
      conditions: { mode: "all", items: [] }, actions: [{ type: "play_cue", cueId: "party-all" }] });
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player("player-1"), {
      sewerId: "sewer-1", spaceId: room.id, position: { x: 420, y: 360 }
    });
    expect(harness.runtime.get("player-1")?.triggers.find((trigger) => trigger.id === "party-all")?.firedCount)
      .toBe(1);
    await harness.runtime.restore(player("player-2"), {
      sewerId: "sewer-1", spaceId: room.id, position: { x: 610, y: 360 }
    });
    expect(harness.runtime.get("player-1")?.triggers.find((trigger) => trigger.id === "party-all")?.firedCount)
      .toBe(1);
    expect(harness.runtime.repositionCombatPlayer(
      "player-2", dungeonLocalToCombatPosition(590, 360)
    )).toBe(true);
    expect(harness.runtime.get("player-1")?.triggers.find((trigger) => trigger.id === "party-all")?.firedCount)
      .toBe(2);
  });

  it("resets an empty instance and despawns its authored enemies", async () => {
    const dungeon = interactiveDungeon(true);
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    harness.runtime.interact("player-1", "session-1", "test-valve", "spawn");
    await harness.runtime.leave("player-1", "session-1");
    await harness.runtime.tick(0);
    expect(harness.combat.despawnMob).toHaveBeenCalledTimes(1);
  });

  it("isolates authored empty resets by instance and rotates only that run", async () => {
    const dungeon = interactiveDungeon(true);
    dungeon.instancePolicy = "solo_ephemeral";
    const database = genericDungeonDatabase();
    const combat = {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null),
      isPlayerReserved: vi.fn(() => false),
      spawnMob: vi.fn((input: { entityId: string; archetype: string; position: { lat: number; lon: number } }) => ({
        entityId: input.entityId, archetypeKey: input.archetype, kind: "mob", name: input.archetype,
        lat: input.position.lat, lon: input.position.lon, currentHealth: 10, maxHealth: 10,
        lifeState: "alive", targetEntityId: null
      })),
      despawnMob: vi.fn(),
      generalSkillRank: vi.fn(() => 0)
    };
    const runtime = new CisternWarrensRuntime(database.pool, combat as never, undefined,
      dungeon, {}, authoredCatalog(dungeon));
    await runtime.enter(player("player-1"), "cave-a", {
      spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a:player:player-1", locationType: "dungeon"
    });
    await runtime.enter(player("player-2"), "cave-a", {
      spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a:player:player-2", locationType: "dungeon"
    });
    const firstRun = database.presences.get("player-1")!.runId;
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "spawn");
    await runtime.leave("player-1", database.presences.get("player-1")!.sessionId);
    await runtime.tick(0);

    expect(combat.despawnMob).toHaveBeenCalledTimes(1);
    expect(database.runs.get("dungeon:cave-a:player:player-1")).not.toBe(firstRun);
    expect(database.presences.has("player-2")).toBe(true);
  });

  it("cancels a pending authored reset when the same instance is re-entered", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "shared_persistent";
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null), despawnMob: vi.fn(),
      isPlayerReserved: vi.fn(() => false),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, {}, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    await runtime.enter(player("player-1"), "cave-a", canonical);
    const originalRun = database.presences.get("player-1")!.runId;
    await runtime.leave("player-1", database.presences.get("player-1")!.sessionId);
    await runtime.enter(player("player-2"), "cave-a", canonical);
    await runtime.tick(0);

    expect(database.presences.get("player-2")?.runId).toBe(originalRun);
    expect(database.runs.get(canonical.instanceId)).toBe(originalRun);
  });

  it("does not apply a delayed old-run reward completion to the reset run", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "shared_persistent";
    dungeon.rewardTableIds = ["basic_dungeon_chest"];
    dungeon.triggers.find((trigger) => trigger.id === "lock-once")!.actions.push({
      type: "grant_reward", rewardTableId: "basic_dungeon_chest"
    });
    let resolveReward!: () => void;
    const delayedReward = new Promise<void>((resolve) => { resolveReward = resolve; });
    const grantReward = vi.fn(() => delayedReward);
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null), despawnMob: vi.fn(),
      generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, { grantReward }, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 },
      instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    await runtime.enter(player("player-1"), "cave-a", canonical);
    const originalRun = database.presences.get("player-1")!.runId;
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId,
      "test-valve", "delayed-reward");
    expect(grantReward).toHaveBeenCalledOnce();
    await runtime.leave("player-1", database.presences.get("player-1")!.sessionId);
    await runtime.tick(0);
    expect(database.runs.get(canonical.instanceId)).not.toBe(originalRun);
    await runtime.enter(player("player-2"), "cave-a", canonical);

    resolveReward();
    await delayedReward;
    await Promise.resolve();
    await Promise.resolve();

    const resetRun = runtime.get("player-2")!;
    expect(resetRun.triggers.find((trigger) => trigger.id === "lock-once")?.firedCount).toBe(0);
    expect(resetRun.portalLocks["dungeon:cave-a:hatch-to-overflow"]).toBe(false);
  });

  it("records a real completion only for the caller's active Sewer session identity", async () => {
    const harness = runtimeHarness({ localX: 14, localY: 24 });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "overflow_channel", position: { x: 500, y: 200 }
    });

    await expect(harness.runtime.completeSession(
      "player-1", "wrong-session", "boss-completion-1"
    )).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(harness.recordCompletion).not.toHaveBeenCalled();

    await harness.runtime.completeSession("player-1", "session-1", "boss-completion-1");
    expect(harness.recordCompletion).toHaveBeenCalledWith({
      completionKey: "boss-completion-1",
      playerId: "player-1",
      dungeonKey: "cistern_warrens:sewer-1",
      sessionIdentity: "session-1"
    });
  });

  it("harvests authored dungeon resources through the inventory authority with replay-safe depletion", async () => {
    const dungeon = interactiveDungeon();
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    room.anchors.push({ id: "resource_anchor", retired: false, x: 420, y: 360 });
    room.anchors.push({ id: "resource_anchor_concurrent", retired: false, x: 420, y: 360 });
    room.resourceNodes = [
      { id: "resource-node", retired: false, anchorId: "resource_anchor", resourceType: "wood", minYield: 100, maxYield: 100, respawnSeconds: null, resetOnRun: true, available: true, interactionRadius: 72 },
      { id: "resource-node-concurrent", retired: false, anchorId: "resource_anchor_concurrent", resourceType: "wood", minYield: 100, maxYield: 100, respawnSeconds: null, resetOnRun: true, available: true, interactionRadius: 72 }
    ];
    // Node quantity comes from the overworld rule now; the catalog yield only caps the Studio playtest request.
    const grant = vi.fn(async (_playerId: string, _type: string, quantity: number) => quantity);
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null), despawnMob: vi.fn(), generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, { harvestResource: grant }, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    await runtime.enter(player(), "cave-a", canonical);
    const sessionId = database.presences.get("player-1")!.sessionId;
    const first = await runtime.harvestResource("player-1", sessionId, "resource-node", "harvest-1");
    const replay = await runtime.harvestResource("player-1", sessionId, "resource-node", "harvest-1");
    expect(first.quantity).toBeGreaterThan(0);
    expect(replay.quantity).toBe(first.quantity);
    expect(grant).toHaveBeenCalledOnce();
    expect(first.snapshot.resources).toContainEqual(expect.objectContaining({ id: "resource-node", state: "depleted", quantity: 0 }));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO dungeon_resource_states"), expect.any(Array));
    const concurrent = await Promise.allSettled([
      runtime.harvestResource("player-1", sessionId, "resource-node-concurrent", "harvest-concurrent-1"),
      runtime.harvestResource("player-1", sessionId, "resource-node-concurrent", "harvest-concurrent-2")
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("fails closed for item-owned and quest-flag portal gates", async () => {
    const dungeon = interactiveDungeon();
    const portal = dungeon.portals.find((candidate) => candidate.id === "hatch-to-overflow")!;
    portal.gates = [{ type: "item_owned", itemId: "rusty-key", quantity: 1 }, { type: "quest_flag", flagId: "sewer-key", value: true }];
    let itemAllowed = false;
    let questAllowed = false;
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null), generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, {
      ownsItem: () => itemAllowed,
      hasQuestFlag: () => questAllowed
    }, authoredCatalog(dungeon));
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    await runtime.enter(player(), "cave-a", canonical);
    const denied = runtime.get("player-1")?.objects.find((object) => object.id === "door-e");
    expect(denied?.available).toBe(false);
    itemAllowed = true;
    questAllowed = true;
    const allowed = runtime.get("player-1")?.objects.find((object) => object.id === "door-e");
    expect(allowed?.available).toBe(true);
  });

  it("uses production item and quest authorities for trigger conditions", async () => {
    const dungeon = interactiveDungeon();
    dungeon.triggers.push({
      id: "authority-trigger", retired: false, enabled: true,
      scope: "player", repetition: "once", cooldownMs: 0,
      event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
      conditions: { mode: "all", items: [
        { type: "item_owned", itemId: "rusty-key", quantity: 1 },
        { type: "quest_flag", flagId: "sewer-key", value: true }
      ] },
      actions: [{ type: "play_cue", cueId: "authority-approved" }]
    });
    let itemAllowed = false;
    let questAllowed = false;
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon, {
      ownsItem: () => itemAllowed,
      hasQuestFlag: () => questAllowed
    });
    await harness.runtime.restore(player(), {
      sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 }
    });
    const denied = harness.runtime.interact("player-1", "session-1", "test-valve", "authority-denied");
    expect(denied.cues).not.toContain("authority-approved");
    itemAllowed = true;
    questAllowed = true;
    const allowed = harness.runtime.interact("player-1", "session-1", "test-valve", "authority-allowed");
    expect(allowed.cues).toContain("authority-approved");
  });
});

function interactiveDungeon(withEncounter = false): DungeonDefinition {
  const dungeon = structuredClone(CISTERN_WARRENS_DUNGEON);
  const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
  room.anchors.push({ id: "test_valve", retired: false, x: 420, y: 360 });
  room.objects.push({
    id: "test-valve", retired: false, type: "valve", prefabId: "dungeon_lever",
    prefabRevision: "dungeon-lever-v1", layerId: "actors", name: "Test Valve",
    anchorId: "test_valve", available: true, initialState: "off", interactionRadius: 72,
    rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0
  });
  dungeon.triggers.push({
    id: "lock-once", retired: false, enabled: true, scope: "instance", repetition: "once",
    cooldownMs: 0, event: { type: "object_interact", roomId: room.id, objectId: "test-valve" },
    conditions: { mode: "all", items: [] },
    actions: [{ type: "set_portal_locked", portalId: "hatch-to-overflow", locked: true }]
  });
  if (withEncounter) {
    room.anchors.push({ id: "test_mob", retired: false, x: 500, y: 500 });
    room.zones.push({ id: "test_boundary", retired: false, kind: "rectangle",
      purpose: "encounter_boundary", x: 300, y: 300, width: 400, height: 400 });
    room.zones.push({ id: "test_leash", retired: false, kind: "rectangle",
      purpose: "leash", x: 250, y: 250, width: 500, height: 500 });
    room.mobs.push({ id: "test_mob", retired: false, archetype: "wolf", anchorId: "test_mob",
      facing: 0, encounterId: "test-encounter", spawnGroupId: "test-pack", waveIndex: 1,
      leashZoneId: "test_leash", visualScale: 1 });
    dungeon.encounters.push({ id: "test-encounter", retired: false, name: "Test Encounter",
      roomId: room.id, boundaryZoneId: "test_boundary", leashZoneId: "test_leash",
      waves: [{ id: "wave-one", mobSpawnIds: ["test_mob"], delayMs: 0 }],
      completion: "all_spawned_mobs_defeated", reset: { onPartyWipe: true, delayMs: 0 },
      retry: { allowed: true, maxAttempts: null }, lockPortalIds: [] });
    dungeon.triggers.push({ id: "start-test", retired: false, enabled: true,
      scope: "instance", repetition: "once", cooldownMs: 0,
      event: { type: "object_state", roomId: room.id, objectId: "test-valve", state: "on" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "start_encounter", encounterId: "test-encounter" }] });
  }
  return dungeon;
}

/** The interactive test encounter as a roll: three wolves per torch set, one wave. */
function rolledInteractiveDungeon(): DungeonDefinition {
  const dungeon = interactiveDungeon(true);
  const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
  room.mobs = room.mobs.filter((mob) => mob.id !== "test_mob");
  const encounter = dungeon.encounters.find((candidate) => candidate.id === "test-encounter")!;
  encounter.waves = [];
  encounter.roll = {
    pool: [{ archetype: "wolf", cost: 1 }], budget: { min: 3, max: 3 }, waves: { min: 1, max: 1 },
    spawn: { anchorIds: ["test_mob"] }, partySetBudgetPct: 100
  };
  return dungeon;
}

function authoredCatalog(dungeon: DungeonDefinition): DungeonCatalog {
  const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
  const index = catalog.dungeons.findIndex((candidate) => candidate.id === dungeon.id);
  catalog.dungeons[index] = dungeon;
  catalog.entrances.push({
    id: "cave-a", dungeonId: dungeon.id, revision: "entrance-v1", retired: false,
    name: "Test Cave", description: "Fixture only", lat: 35, lon: -106,
    interactionRadiusM: 8, footprintRadiusM: 5, portalId: "world-to-entrance",
    portalRevision: "portal-v1", interactionLabel: "Enter Cave", presentation: "cave",
    assetKey: null
  });
  return catalog;
}

type ProductionApproachMode = "world" | "dungeon";
type ProductionApproachArchetype = "goblin" | "alligator" | "training_dummy";

type ProductionApproachEvidence = {
  commandAccepted: boolean;
  combatStarted: boolean;
  weaponSlotBefore: string | null;
  sawWeaponSwitch: boolean;
  weaponSlotAtFirstHit: string | null;
  effectiveRangeM: number | undefined;
  initialDistanceM: number;
  routeDestinationDistanceM: number;
  firstHitDistanceM: number;
};

async function productionApproachEvidence(
  mode: ProductionApproachMode,
  archetype: ProductionApproachArchetype
): Promise<ProductionApproachEvidence> {
  const config = loadConfig({
    NODE_ENV: "test",
    COMBAT_DELTA_HZ: "20",
    WORLD_DELTA_HZ: "20"
  });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const playerId = `approach-${mode}-${archetype}`;
  const playerRecord = gameState.helloPlayer(playerId, "Approach Player");
  const playerPosition = { ...playerRecord.position };
  const socket = productionSocket();
  const initialRegionCode = mode === "world"
    ? playerRecord.regionCode
    : "interior:sewer:sewer-1";
  const initialZoneId = mode === "world"
    ? zoneIdForPosition(playerPosition)
    : "interior:sewer:sewer-1:overflow_channel";
  const connectionId = registry.add({
    accountId: `account-${playerId}`,
    playerId,
    username: playerRecord.username,
    regionCode: initialRegionCode,
    zoneId: initialZoneId,
    socket
  });
  if (mode === "dungeon") gameState.setWorldPresence(playerId, false);

  let dungeon: CisternWarrensRuntime | null = null;
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    playerMovementSpeedMps: config.PLAYER_SPEED_MPS,
    interestRadiusM: config.COMBAT_INTEREST_RADIUS_M,
    random: () => 1,
    getAuthoritativeViewCircle: (id) =>
      dungeon?.gameplayViewCircle(id) ?? gameState.getGameplayViewCircle(id),
    isPlayerAuthorityActive: (id, accountId, activeConnectionId) =>
      registry.isActiveConnection(accountId, activeConnectionId) &&
      registry.isActivePlayerConnection(id, activeConnectionId),
    isPlayerMobAttackAuthorized: (id, mobEntityId) =>
      dungeon?.isInside(id) ? dungeon.canFightMob(id, mobEntityId) : true,
    isMobPlayerAttackAuthorized: () => true,
    movePlayerToward: (id, target) => {
      if (dungeon?.isInside(id)) dungeon.setCombatTarget(id, target);
      else gameState.setCombatTarget(id, target);
    },
    stopPlayer: (id) => {
      if (dungeon?.isInside(id)) dungeon.stop(id);
      else gameState.stopPlayer(id);
    }
  });
  combat.connectPlayer({
    playerId,
    name: playerRecord.username,
    regionCode: initialRegionCode,
    zoneId: initialZoneId,
    position: playerPosition,
    accountId: `account-${playerId}`,
    connectionId,
    profile: {
      playerId,
      level: 25,
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10,
      persistenceVersion: 0
    }
  });
  const installed = combat.syncPlayerEquipmentCombatState(
    playerId,
    productionShurikenEquipmentState()
  );
  expect(installed?.weaponCombat).toMatchObject({
    activeWeaponSlot: "melee",
    switchingToSlot: null
  });
  const weaponSlotBefore = installed?.weaponCombat?.activeWeaponSlot ?? null;

  let targetEntityId: string;
  if (mode === "dungeon") {
    const dungeonDefinition = productionApproachDungeon(archetype);
    dungeon = new CisternWarrensRuntime(
      productionApproachDatabase(),
      combat,
      undefined,
      dungeonDefinition,
      { playerMovementSpeedMps: config.PLAYER_SPEED_MPS },
      DUNGEON_CATALOG,
      { recordCompletion: vi.fn(async () => ({})), authorizeEntry: vi.fn(async () => undefined) } as never
    );
    const restored = await dungeon.restore(playerRecord, {
      sewerId: "sewer-1",
      spaceId: "overflow_channel",
      position: { x: 200, y: 170 }
    });
    expect(restored?.player).toMatchObject({ x: 200, y: 170 });
    targetEntityId = "dungeon:sewer:sewer-1:overflow-rats:overflow-rat-1:1";
  } else {
    const targetPosition = moveToward(
      playerPosition,
      { lat: playerPosition.lat, lon: playerPosition.lon + 0.02 },
      500
    );
    targetEntityId = `world-approach-${archetype}`;
    combat.spawnMob({
      entityId: targetEntityId,
      archetype,
      position: targetPosition,
      homePosition: targetPosition,
      regionCode: playerRecord.regionCode,
      zoneId: initialZoneId,
      worldAi: false
    });
  }

  const target = combat.entity(targetEntityId);
  expect(target).not.toBeNull();
  const initialDistanceM = distanceMeters(combat.entity(playerId)!, target!);
  const runtime = new WorldRuntime(config, registry, gameState, combat, logger);
  let commandAccepted = false;
  const handler = createCombatEquipmentHandler({
    state: { playerId, connectionId },
    socket,
    authenticatedSession: { account: { id: `account-${playerId}` } } as never,
    registry,
    gameState,
    worldRuntime: runtime,
    combat,
    classRealtimeState: { hasActiveMutation: () => false },
    flagBuilds: null,
    cancelPendingManorEntry: () => false,
    enforcePlayerClassRate: () => undefined,
    enqueueWorldCommand: (
      command: Parameters<CombatEquipmentHandlerContext["enqueueWorldCommand"]>[0]
    ) => {
      const runtimeResult = runtime.enqueue({
        ...command,
        playerId,
        accountId: `account-${playerId}`,
        connectionId
      } as never);
      commandAccepted = runtimeResult.accepted;
      return runtimeResult.accepted;
    },
    refreshAuthoritativePlayerStats: vi.fn(async () => ({
      progression: {}, equipment: {}
    })),
    applyLiveClassMutationState: vi.fn(async () => null),
    applyLiveSkillMutationState: vi.fn(async () => null),
    safeSendServerMessage: (socket: SocketLike, message: unknown) => {
      void socket;
      void message;
      return true;
    },
    sendCombatError: vi.fn(),
    stageEquipmentSnapshot: vi.fn(() => true),
    recenterXoralParticipant: vi.fn(async () => ({ success: true as const }))
  } as unknown as CombatEquipmentHandlerContext);
  await handler({
    type: "START_ATTACK",
    requestId: `start-${mode}-${archetype}`,
    targetEntityId
  });
  let combatStarted = false;

  const initialTick = 0.05;
  let routeDestinationDistanceM = Number.NaN;
  let sawWeaponSwitch = false;
  let firstHitDistanceM = Number.NaN;
  let weaponSlotAtFirstHit: string | null = null;
  let effectiveRangeM: number | undefined;
  for (let tick = 0; tick < 120; tick += 1) {
    runtime.tick(initialTick, mode === "dungeon"
      ? () => dungeon!.advanceMovement(initialTick)
      : undefined);
    if (mode === "dungeon") {
      await dungeon!.tick(0, { movementAlreadyAdvanced: true });
    }
    combatStarted ||= productionMessages(socket).some((message) =>
      message.type === "COMBAT_STARTED" &&
      message.requestId === `start-${mode}-${archetype}`
    );
    const player = combat.entity(playerId)!;
    const weapon = player.weaponCombat;
    if (weapon?.switchingToSlot === "secondary" || weapon?.activeWeaponSlot === "secondary") {
      sawWeaponSwitch = true;
    }
    if (Number.isNaN(routeDestinationDistanceM)) {
      const routeDestination = mode === "world"
        ? gameState.getPlayer(playerId)?.target ?? null
        : (() => {
          const snapshot = dungeon!.get(playerId)?.player;
          return snapshot?.targetX !== null && snapshot?.targetY !== null
            ? dungeonLocalToCombatPosition(snapshot!.targetX!, snapshot!.targetY!)
            : null;
        })();
      if (routeDestination) routeDestinationDistanceM = distanceMeters(routeDestination, target!);
    }
    const events = productionMessages(socket).flatMap((message) =>
      message.type === "COMBAT_DELTA" ? message.state?.events ?? [] : []);
    const firstHit = events.find((event) =>
      event.type === "ATTACK_LANDED" &&
      event.sourceEntityId === playerId &&
      event.targetEntityId === targetEntityId
    );
    if (firstHit) {
      firstHitDistanceM = distanceMeters(combat.entity(playerId)!, combat.entity(targetEntityId)!);
      weaponSlotAtFirstHit = player.weaponCombat?.activeWeaponSlot ?? null;
      effectiveRangeM = player.attackRangeM;
      break;
    }
  }

  expect(Number.isFinite(routeDestinationDistanceM)).toBe(true);
  expect(Number.isFinite(firstHitDistanceM)).toBe(true);
  return {
    commandAccepted,
    combatStarted,
    weaponSlotBefore,
    sawWeaponSwitch,
    weaponSlotAtFirstHit,
    effectiveRangeM,
    initialDistanceM,
    routeDestinationDistanceM,
    firstHitDistanceM
  };
}

function productionShurikenEquipmentState(): PlayerEquipmentCombatState {
  const loadout: ActiveEquipmentLoadout = {
    active: emptyEquipmentSlots(null),
    readiedWeaponSlot: "melee"
  };
  loadout.active.melee = {
    instanceId: "approach-melee",
    itemLevel: 0,
    definition: requireEquipmentDefinition("starter_sword")
  };
  const stats: EquipmentCombatStats = resolveEquipmentCombatStats({
    context: "pve",
    characterLevel: 25,
    classId: "warrior",
    classRank: 0,
    loadout
  });
  stats.weaponAttackPower.secondary = 30;
  stats.weaponCategories.secondary = "shuriken";
  stats.items.secondary = resolveEquipmentItemDerivedStats({
    item: {
      instanceId: "approach-ranged",
      definition: requireEquipmentDefinition("starter_shuriken"),
      itemLevel: 20
    },
    slot: "secondary",
    classId: "warrior"
  });
  return {
    activeKitIndex: 1,
    inventoryRevision: 1,
    activeRevision: 1,
    stats,
    weaponCategory: "sword" as WeaponCategory,
    chestArmorCategory: null,
    heavyArmorPieces: 0,
    hasShield: false,
    activeWeaponInstanceId: "approach-melee",
    activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null },
    weaponSlots: {
      melee: {
        instanceId: "approach-melee",
        definitionId: "starter_sword",
        category: "sword",
        enchantmentIdentity: null
      },
      secondary: {
        instanceId: "approach-ranged",
        definitionId: "starter_shuriken",
        category: "shuriken",
        enchantmentIdentity: null
      }
    },
    activeWeaponSlot: "melee",
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
}

function productionApproachDungeon(archetype: ProductionApproachArchetype): DungeonDefinition {
  const dungeon = structuredClone(CISTERN_WARRENS_DUNGEON);
  const room = dungeon.rooms.find((candidate) => candidate.id === "overflow_channel")!;
  const spawnId = "overflow-rat-1";
  const placement = room.mobs.find((candidate) => candidate.id === spawnId)!;
  placement.archetype = archetype;
  const anchor = room.anchors.find((candidate) => candidate.id === placement.anchorId)!;
  anchor.x = 900;
  anchor.y = 170;
  const encounter = dungeon.encounters.find((candidate) => candidate.id === "overflow-rats")!;
  encounter.waves = [{ id: "wave_1", mobSpawnIds: [spawnId], delayMs: 0 }];
  return dungeon;
}

function productionApproachDatabase() {
  const query = vi.fn(async (sql: string) => sql.includes("FROM cistern_warrens_presence WHERE player_id=$1")
    ? {
      rows: [{
        sewer_structure_id: "sewer-1",
        session_id: "session-approach",
        local_x: 200,
        local_y: 150,
        return_region_code: "world",
        return_lat: 35,
        return_lon: -106
      }],
      rowCount: 1
    }
    : sql.includes("FROM city_structures structure")
      ? {
        rows: [{
          structure_id: "sewer-1",
          city_id: "city-1",
          city_name: "Test City",
          region_code: "world",
          placement_revision: "1",
          lat: 35,
          lon: -106
        }],
        rowCount: 1
      }
    : { rows: [], rowCount: 1 });
  return { query } as never;
}

function productionSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn()
  } satisfies SocketLike;
}

type ProductionMessage = {
  type?: string;
  requestId?: string;
  state?: { events?: ProductionCombatEvent[] };
};
type ProductionCombatEvent = {
  type?: string;
  sourceEntityId?: string;
  targetEntityId?: string;
};

function productionMessages(socket: ReturnType<typeof productionSocket>): ProductionMessage[] {
  return socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as ProductionMessage);
}

function genericDungeonDatabase() {
  const runs = new Map<string, string>();
  const presences = new Map<string, { instanceId: string; runId: string; sessionId: string }>();
  /** dungeon_run_stats rows (open runs only): torches and entrants. */
  const stats = new Map<string, { torchTotal: number; partySize: number }>();
  const advisoryLocks = vi.fn();
  let lockTail = Promise.resolve();
  const occupiedBy = (instanceId: unknown) => [...presences.values()].some((row) => row.instanceId === instanceId);
  const statsQuery = (sql: string, values: unknown[]) => {
    if (sql.includes("LEFT JOIN dungeon_run_stats")) {
      const runId = runs.get(String(values[0]));
      const row = runId ? stats.get(runId) : undefined;
      return { rows: runId ? [{ run_id: runId, torch_total: row?.torchTotal ?? null, party_size: row?.partySize ?? null,
        occupied: occupiedBy(values[0]) }] : [], rowCount: runId ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO dungeon_run_stats") && !sql.includes("ON CONFLICT")) {
      stats.set(String(values[0]), { torchTotal: Number(values[4]), partySize: 0 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO dungeon_run_stats")) {
      const row = stats.get(String(values[0]));
      if (row) row.partySize += 1;
      else stats.set(String(values[0]), { torchTotal: Number(values[4]), partySize: 1 });
      return { rows: [{ started_at: new Date(0) }], rowCount: 1 };
    }
    if (sql.includes("SELECT torch_total FROM dungeon_run_stats")) {
      const row = stats.get(String(values[0]));
      return { rows: row ? [{ torch_total: row.torchTotal }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("AS pending")) return { rows: [{ pending: stats.get(String(values[0]))?.partySize === 0 }], rowCount: 1 };
    return null;
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      const statsResult = statsQuery(sql, values);
      if (statsResult) return statsResult;
      if (sql.includes("DELETE FROM dungeon_presence")) {
        presences.delete(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1)")) {
        return { rows: [{ occupied: [...presences.values()].some((row) => row.instanceId === values[0]) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
  const pool = {
    query,
    connect: vi.fn(async () => {
      let releaseLock: (() => void) | null = null;
      return {
        query: vi.fn(async (sql: string, values: unknown[] = []) => {
          if (sql === "BEGIN") return { rows: [], rowCount: 0 };
          const statsResult = statsQuery(sql, values);
          if (statsResult) return statsResult;
          if (sql.includes("pg_advisory_xact_lock")) {
            advisoryLocks(values[0]);
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
            await prior;
            return { rows: [], rowCount: 1 };
          }
          if (sql === "COMMIT" || sql === "ROLLBACK") {
            releaseLock?.();
            releaseLock = null;
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("SELECT run_id::text FROM dungeon_instance_runs")) {
            const runId = runs.get(String(values[0]));
            return { rows: runId ? [{ run_id: runId }] : [], rowCount: runId ? 1 : 0 };
          }
          if (sql.includes("INSERT INTO dungeon_instance_runs")) {
            runs.set(String(values[0]), String(values[1]));
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SELECT 1 FROM dungeon_presence WHERE player_id")) {
            return { rows: presences.has(String(values[0])) ? [{ exists: 1 }] : [],
              rowCount: presences.has(String(values[0])) ? 1 : 0 };
          }
          if (sql.includes("INSERT INTO dungeon_presence")) {
            presences.set(String(values[0]), {
              instanceId: String(values[9]), runId: String(values[11]), sessionId: String(values[2])
            });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1)")) {
            return { rows: [{ occupied: [...presences.values()].some((row) => row.instanceId === values[0]) }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn()
      };
    })
  };
  return { pool: pool as never, query, runs, presences, stats, advisoryLocks };
}

function runtimeHarness(
  position: { localX: number; localY: number; sewerId?: string; movementMultiplier?: number },
  dungeon: DungeonDefinition = CISTERN_WARRENS_DUNGEON,
  authorities: DungeonRuntimeAuthorities = {},
  catalog: DungeonCatalog = DUNGEON_CATALOG
) {
  const queries = vi.fn(async (sql: string, values: unknown[] = []) => {
    void values;
    if (sql.startsWith("SELECT") && sql.includes("FROM cistern_warrens_presence WHERE player_id=$1")) {
      return { rows: [{
        sewer_structure_id: position.sewerId ?? "sewer-1", session_id: "session-1",
        local_x: position.localX, local_y: position.localY,
        return_region_code: "world", return_lat: 35, return_lon: -106
      }], rowCount: 1 };
    }
    if (sql.includes("FROM city_structures structure")) {
      return { rows: [{
        structure_id: "sewer-1", city_id: "city-1", city_name: "Test City",
        region_code: "world", placement_revision: "1", lat: 35, lon: -106
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const persistInteriorPosition = vi.fn(async () => undefined);
  const combatEntities = new Map<string, Record<string, unknown>>();
  const combatEntity = vi.fn((entityId: string) => combatEntities.get(entityId) ?? ({
    targetEntityId: null, currentHealth: 100, maxHealth: 100
  }));
  const combat = {
    syncPlayer: vi.fn((_input: unknown) => { void _input; }), cancelCombat: vi.fn(), entity: combatEntity,
    isPlayerReserved: vi.fn(() => false),
    spawnMob: vi.fn((input: { entityId: string; archetype: string; position: { lat: number; lon: number }; regionCode: string; zoneId: string }) => {
      const entity = { entityId: input.entityId, archetypeKey: input.archetype, kind: "mob",
        name: input.archetype, lat: input.position.lat, lon: input.position.lon,
        regionCode: input.regionCode, zoneId: input.zoneId, currentHealth: 10,
        maxHealth: 10, lifeState: "alive", targetEntityId: null };
      combatEntities.set(input.entityId, entity);
      return entity;
    }),
    despawnMob: vi.fn((entityId: string) => combatEntities.delete(entityId)),
    scaleFreshMobStats: vi.fn((_entityId: string, _factors: unknown) => { void _entityId; void _factors; return true; }),
    healMob: vi.fn((_entityId: string, _amount: number) => { void _entityId; void _amount; return 0; }),
    setMobCombatModifierProvider: vi.fn((provider: unknown) => { void provider; }),
    summonerOf: vi.fn((entityId: string) => (combatEntities.get(entityId)?.summonedByEntityId as string | undefined) ?? null),
    livingSummonedMobIds: vi.fn((zoneId: string, summoners: ReadonlySet<string>) => [...combatEntities.entries()]
      .filter(([, entity]) => entity.kind === "mob" && entity.lifeState === "alive" && entity.zoneId === zoneId &&
        summoners.has(entity.summonedByEntityId as string))
      .map(([id]) => id)),
    generalSkillRank: vi.fn(() => 0),
    playerMovementMultiplier: vi.fn(() => position.movementMultiplier ?? 1)
  };
  const recordCompletion = vi.fn(async (input: {
    completionKey: string; playerId: string; dungeonKey: string; sessionIdentity: string;
  }) => ({ ...input, delversLoreRank: 0, cooldownDays: 6,
    completedAt: new Date(0), lockoutExpiresAt: new Date(604_800_000) }));
  return {
    queries,
    persistInteriorPosition,
    combat,
    combatEntities,
    recordCompletion,
    runtime: new CisternWarrensRuntime(
      { query: queries } as never,
      combat as never,
      { persistInteriorPosition } as never,
      dungeon,
      authorities,
      catalog,
      { recordCompletion, authorizeEntry: vi.fn(async () => undefined) } as never
    )
  };
}

function player(playerId = "player-1") {
  return {
    playerId, username: "Player", displayColor: null,
    movementRevision: 4, regionCode: "world", position: { lat: 35, lon: -106 }
  } as never;
}

describe("dungeon elite modifiers", () => {
  type EliteId = "hardy" | "swift" | "shielded" | "enraged" | "splitting" | "healer_aura";
  async function eliteRun(modifiers: EliteId[], withAlly = false) {
    const dungeon = interactiveDungeon(true);
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    const mob = room.mobs.find((candidate) => candidate.id === "test_mob")!;
    mob.elite = { modifiers };
    if (withAlly) {
      room.mobs.push({ ...mob, id: "ally_mob", elite: undefined });
      dungeon.encounters.find((encounter) => encounter.id === "test-encounter")!.waves[0]!.mobSpawnIds.push("ally_mob");
    }
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: 420, y: 360 } });
    harness.runtime.interact("player-1", "session-1", "test-valve", "spawn");
    const eliteEntityId = harness.combat.spawnMob.mock.calls[0]![0].entityId;
    const provider = () => harness.combat.setMobCombatModifierProvider.mock.calls[0]![0] as
      (id: string) => { outgoingDamageMultiplier?: number; incomingDamageMultiplier?: number } | null;
    const enemies = () => harness.runtime.get("player-1")!.enemies;
    const encounterState = () => harness.runtime.get("player-1")!.encounters.find((encounter) => encounter.id === "test-encounter")!.state;
    return { harness, eliteEntityId, provider, enemies, encounterState };
  }
  const wolfLevel = requireMobDefinition("wolf").level;

  it("hardy adds 60% health and two levels (elite +1, hardy +1)", async () => {
    const { harness, enemies } = await eliteRun(["hardy"]);
    const input = harness.combat.spawnMob.mock.calls[0]![0] as unknown as { maxHealthMultiplier: number; combatProfile: { level: number } };
    expect(input.maxHealthMultiplier).toBe(1.6);
    expect(input.combatProfile.level).toBe(wolfLevel + 2);
    expect(enemies()[0]!.elite).toEqual({ modifiers: ["hardy"] });
  });

  it("swift adds 25% speed and one level", async () => {
    const { harness } = await eliteRun(["swift"]);
    const input = harness.combat.spawnMob.mock.calls[0]![0] as unknown as { combatProfile: { level: number } };
    expect(input.combatProfile.level).toBe(wolfLevel + 1);
    expect(harness.combat.scaleFreshMobStats).toHaveBeenCalledWith(expect.any(String), { movementSpeed: 1.25 });
  });

  it("shielded absorbs all damage for 2 s of every 8 s and flags it in the snapshot", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { eliteEntityId, provider, enemies } = await eliteRun(["shielded"]);
      expect(provider()(eliteEntityId)).toBeNull();
      expect(enemies()[0]!.elite).toEqual({ modifiers: ["shielded"], shieldActive: false });
      vi.setSystemTime(1_000_000 + 6_500);
      expect(provider()(eliteEntityId)).toEqual({ incomingDamageMultiplier: 0 });
      expect(enemies()[0]!.elite).toEqual({ modifiers: ["shielded"], shieldActive: true });
      vi.setSystemTime(1_000_000 + 8_000);
      expect(provider()(eliteEntityId)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("enraged adds 40% outgoing damage below 30% health only", async () => {
    const { harness, eliteEntityId, provider } = await eliteRun(["enraged"]);
    const entity = harness.combatEntities.get(eliteEntityId)!;
    expect(provider()(eliteEntityId)).toBeNull();
    entity.currentHealth = 2;
    expect(provider()(eliteEntityId)).toEqual({ outgoingDamageMultiplier: 1.4 });
    entity.currentHealth = 3;
    expect(provider()(eliteEntityId)).toBeNull();
  });

  it("healer_aura heals nearby allies for 4% max health every 4 s", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      const { harness, eliteEntityId } = await eliteRun(["healer_aura"], true);
      const allyId = [...harness.combatEntities.keys()].find((id) => id !== eliteEntityId)!;
      harness.combatEntities.get(allyId)!.currentHealth = 5;
      await harness.runtime.tick(0);
      expect(harness.combat.healMob).not.toHaveBeenCalled();
      vi.setSystemTime(2_000_000 + 4_000);
      await harness.runtime.tick(0);
      expect(harness.combat.healMob).toHaveBeenCalledTimes(1);
      expect(harness.combat.healMob).toHaveBeenCalledWith(allyId, 10 * 0.04);
    } finally { vi.useRealTimers(); }
  });

  it("splitting leaves two half-health, 0.75-scale, non-elite copies that hold the wave open", async () => {
    const { harness, eliteEntityId, enemies, encounterState } = await eliteRun(["splitting"]);
    harness.combatEntities.get(eliteEntityId)!.lifeState = "defeated";
    await harness.runtime.tick(0);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(3);
    expect(harness.combat.scaleFreshMobStats).toHaveBeenCalledWith(expect.any(String), { maxHealth: 0.5 });
    const children = enemies().filter((enemy) => enemy.spawnId.includes("~split"));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.visualScale).toBe(0.75);
      expect(child.elite).toBeUndefined();
    }
    expect(encounterState()).toBe("active");
    harness.combatEntities.get(children[0]!.entityId)!.lifeState = "defeated";
    await harness.runtime.tick(0);
    expect(encounterState()).toBe("active");
    harness.combatEntities.get(children[1]!.entityId)!.lifeState = "defeated";
    await harness.runtime.tick(0);
    expect(encounterState()).toBe("completed");
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(3);
  });
});

describe("dungeon resource nodes follow the overworld harvest rules", () => {
  async function nodeHarness(resourceTypes: readonly ("wood" | "stone")[] = ["stone"]) {
    const dungeon = interactiveDungeon();
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    room.resourceNodes = resourceTypes.map((resourceType, index) => {
      room.anchors.push({ id: `node_anchor_${index}`, retired: false, x: 420, y: 360 });
      return {
        id: `node-${index}`, retired: false, anchorId: `node_anchor_${index}`, resourceType,
        // The catalog yield/respawn fields must not change gameplay.
        minYield: 9, maxYield: 9, respawnSeconds: 1, resetOnRun: false, available: true, interactionRadius: 72
      };
    });
    dungeon.reset.policy = "when_empty";
    dungeon.reset.despawnAfterSeconds = 0;
    const database = genericDungeonDatabase();
    const runtime = new CisternWarrensRuntime(database.pool, {
      syncPlayer: vi.fn(), cancelCombat: vi.fn(), entity: vi.fn(() => null), despawnMob: vi.fn(), isPlayerReserved: vi.fn(() => false), generalSkillRank: vi.fn(() => 0)
    } as never, undefined, dungeon, {}, authoredCatalog(dungeon));
    const grants = new Map<string, number>();
    const inventory = {
      getInventorySnapshot: vi.fn(async () => ({ totals: {} })),
      grantItemsForOperationInTransaction: vi.fn(async (_client: unknown, input: { operationKey: string; grants: { itemId: string; quantity: number }[] }) => {
        if (!grants.has(input.operationKey)) grants.set(input.operationKey, input.grants[0]!.quantity);
        return {
          inventory: { totals: {} },
          grants: input.grants.map((grant) => ({ itemId: grant.itemId, variant: null, remainderQuantity: 0 }))
        };
      })
    };
    const service = new DungeonResourceHarvestService({
      pool: database.pool, dungeon: runtime, inventory: inventory as never, random: () => 0.99
    });
    const canonical = { spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId: "dungeon:cave-a", locationType: "dungeon" as const };
    runtime.onPlayerLeftRoom((playerId) => service.cancelActiveForPlayer(playerId));
    await runtime.enter(player(), "cave-a", canonical);
    const sessionId = database.presences.get("player-1")!.sessionId;
    return { runtime, service, database, grants, inventory, sessionId, canonical };
  }

  it("grants once per session, replays without a second grant, and serializes concurrent completes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { runtime, service, grants } = await nodeHarness(["wood"]);
      const started = await service.start("player-1", "dungeon-resource:node-0");
      expect(started.session.nodeId).toBe("dungeon-resource:node-0");
      vi.setSystemTime(Date.parse(started.session.completesAt) + 1);
      const settled = await Promise.allSettled([
        service.complete("player-1", started.session.sessionId),
        service.complete("player-1", started.session.sessionId)
      ]);
      expect(grants.size).toBe(1);
      // Overworld tree yield, not the catalog's 9.
      expect([...grants.values()][0]).toBe(dungeonResourceRule("wood", "node-0").yieldQuantity);
      expect(settled.some((result) => result.status === "fulfilled")).toBe(true);
      const replay = await service.complete("player-1", started.session.sessionId);
      expect(replay.replayed).toBe(true);
      expect(grants.size).toBe(1);
      expect(runtime.get("player-1")!.resources).toContainEqual(expect.objectContaining({ id: "node-0", state: "depleted", availableAt: null }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a depleted mine depleted for the run with no regeneration timer", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      const { runtime, service } = await nodeHarness(["stone"]);
      const started = await service.start("player-1", "dungeon-resource:node-0");
      vi.setSystemTime(Date.parse(started.session.completesAt) + 1);
      const done = await service.complete("player-1", started.session.sessionId);
      const doneAt = Date.now();
      const depleted = done.snapshot!.resources!.find((resource) => resource.id === "node-0")!;
      expect(depleted.state).toBe("depleted");
      expect(depleted.availableAt).toBeNull();
      expect(dungeonResourceRule("stone", "node-0").regenerationMs).toBeNull();
      // Far beyond any overworld regeneration window: still depleted, still no timer.
      vi.setSystemTime(doneAt + 24 * 60 * 60 * 1_000);
      await runtime.tick(0.05);
      expect(runtime.get("player-1")!.resources![0]).toMatchObject({ state: "depleted", availableAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels gathering when the player leaves the dungeon and never grants afterwards", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(4_000_000);
      const { runtime, service, grants, sessionId } = await nodeHarness(["wood"]);
      const started = await service.start("player-1", "dungeon-resource:node-0");
      await runtime.leave("player-1", sessionId);
      expect(service.activeSessionForPlayer("player-1")).toBeNull();
      vi.setSystemTime(Date.parse(started.session.completesAt) + 1);
      await expect(service.complete("player-1", started.session.sessionId)).rejects.toMatchObject({ code: "HARVEST_CANCELLED" });
      expect(grants.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a new run fresh nodes and drops the old run's depletion", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(5_000_000);
      const { runtime, service, sessionId, canonical } = await nodeHarness(["wood"]);
      const started = await service.start("player-1", "dungeon-resource:node-0");
      vi.setSystemTime(Date.parse(started.session.completesAt) + 1);
      await service.complete("player-1", started.session.sessionId);
      expect(runtime.get("player-1")!.resources![0]!.state).toBe("depleted");
      await runtime.leave("player-1", sessionId);
      vi.setSystemTime(Date.now() + 120_000);
      await runtime.tick(0.05);
      await runtime.enter(player(), "cave-a", canonical);
      expect(runtime.get("player-1")!.resources![0]).toMatchObject({ id: "node-0", state: "available" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("summarizeAutoNotices", () => {
  const room = (id: string, name: string) => ({ id, name });
  const portal = (id: string, from: string, to: string) => ({
    id, interactionLabel: "Open door", source: { kind: "room", roomId: from }, destination: { kind: "room", roomId: to }
  });
  const dungeon = {
    rooms: [room("hall", "Hall of Bones"), room("gate", "Crypt Gatehouse"), room("oss", "The Ossuary")],
    portals: [portal("hall-gate", "hall", "gate"), portal("gate-hall", "gate", "hall"), portal("hall-oss", "hall", "oss")]
  } as unknown as DungeonDefinition;
  const context = (occupied: string[]) => ({ dungeon, occupiedRoomIds: new Set(occupied) });

  it("announces a door once, skipping the reciprocal back-direction portal", () => {
    expect(summarizeAutoNotices(context(["hall", "gate"]), [
      { kind: "portal", portalId: "hall-gate", audience: null },
      { kind: "portal", portalId: "gate-hall", audience: null }
    ])).toEqual(["The way to Crypt Gatehouse is open."]);
  });

  it("skips doors that do not leave the player's current room", () => {
    expect(summarizeAutoNotices(context(["oss"]), [
      { kind: "portal", portalId: "hall-gate", audience: null },
      { kind: "portal", portalId: "hall-oss", audience: null }
    ])).toEqual([]);
  });

  it("folds one opened door into a short defeat line and keeps boss and completion separate", () => {
    expect(summarizeAutoNotices(context(["hall"]), [
      { kind: "defeat", name: "Bone Guard", boss: false, audience: null },
      { kind: "portal", portalId: "hall-gate", audience: null },
      { kind: "portal", portalId: "hall-oss", audience: null }
    ])).toEqual(["Bone Guard defeated — Crypt Gatehouse is open.", "The way to The Ossuary is open."]);
    expect(summarizeAutoNotices(context(["hall"]), [
      { kind: "defeat", name: "The Ossuary Lord - Boss", boss: true, audience: null },
      { kind: "portal", portalId: "hall-gate", audience: null },
      { kind: "object", text: "Crypt Chest appeared.", audience: null },
      { kind: "complete", audience: null }
    ])).toEqual(["Boss defeated: The Ossuary Lord", "Crypt Chest appeared.", "Dungeon complete."]);
  });
});

describe("dungeon access rules (level gate, torch cost, lockout)", () => {
  const TORCH = [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }];
  const canonical = (instanceId: string) => ({
    spaceId: "hatch_landing", position: { x: 420, y: 360 }, instanceId, locationType: "dungeon" as const
  });

  function accessHarness(
    access: DungeonDefinition["access"],
    authorities: DungeonRuntimeAuthorities = {},
    options: { level?: number; completes?: boolean } = {}
  ) {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "party_ephemeral";
    if (access) dungeon.access = access;
    if (options.completes) {
      dungeon.triggers.push({
        id: "finish", retired: false, enabled: true, scope: "instance", repetition: "once",
        cooldownMs: 0, event: { type: "object_interact", roomId: "hatch_landing", objectId: "test-valve" },
        conditions: { mode: "all", items: [] }, actions: [{ type: "complete_dungeon" }]
      });
    }
    const database = genericDungeonDatabase();
    const baseQuery = (database.pool as unknown as { query: (sql: string, values?: unknown[]) => Promise<unknown> }).query;
    (database.pool as unknown as { query: unknown }).query = vi.fn(async (sql: string, values: unknown[] = []) =>
      sql.includes("player_progression_profiles")
        ? { rows: [{ level: options.level ?? 1 }], rowCount: 1 }
        : baseQuery(sql, values));
    const ledger = { authorizeEntry: vi.fn(async (..._args: unknown[]) => undefined), recordCompletion: vi.fn(async (..._args: unknown[]) => ({})),
      recordEarlyLeave: vi.fn(async (..._args: unknown[]) => ({})) };
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const runtime = new CisternWarrensRuntime(database.pool, harness.combat as never, undefined, dungeon,
      { partyIdForPlayer: () => "party-1", ...authorities }, authoredCatalog(dungeon), ledger as never);
    return { runtime, database, ledger, dungeon };
  }

  it("denies entry below the minimum level with a player-facing message", async () => {
    const { runtime, ledger } = accessHarness({ minimumLevel: 5 }, {}, { level: 3 });
    await expect(runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({
      code: "DUNGEON_LEVEL_TOO_LOW", message: expect.stringContaining("requires level 5. You are level 3")
    });
    expect(ledger.authorizeEntry).not.toHaveBeenCalled();
  });

  it("allows entry at the minimum level and checks the per-dungeon lockout", async () => {
    const { runtime, ledger, dungeon } = accessHarness({ minimumLevel: 5 }, {}, { level: 5 });
    await expect(runtime.authorizeEntry("player-1", "cave-a")).resolves.toBeUndefined();
    expect(ledger.authorizeEntry).toHaveBeenCalledWith("player-1", `dungeon:${dungeon.id}`);
  });

  it("caps an authored level above the level cap at the cap (Fallen Prison is level 40)", async () => {
    const atCap = accessHarness({ minimumLevel: 40 }, {}, { level: CURRENT_LEVEL_CAP });
    await expect(atCap.runtime.authorizeEntry("player-1", "cave-a")).resolves.toBeUndefined();
    const below = accessHarness({ minimumLevel: 40 }, {}, { level: CURRENT_LEVEL_CAP - 1 });
    await expect(below.runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({
      code: "DUNGEON_LEVEL_TOO_LOW", message: expect.stringContaining(`requires level ${CURRENT_LEVEL_CAP}.`)
    });
  });

  it("ships the configured gates: sewer open, Fangrock 6, Eyrie 11, Grove 17 with torch cost and 6-day lockout", async () => {
    expect(DUNGEON_CATALOG.dungeons.find((d) => d.id === "cistern_warrens")?.access?.minimumLevel).toBeUndefined();
    const levels = Object.fromEntries(DUNGEON_CATALOG.dungeons.map((d) => [d.id, d.access?.minimumLevel]));
    expect(levels).toMatchObject({ fangrock_cavern: 6, the_eyrie: 11, blightwood_grove: 17 });
    for (const id of ["fangrock_cavern", "the_eyrie", "blightwood_grove"]) {
      expect(DUNGEON_CATALOG.dungeons.find((d) => d.id === id)?.access).toMatchObject({ entryCost: TORCH, lockoutDays: 6 });
    }
    expect(DUNGEON_CATALOG.dungeons.find((d) => d.id === "cistern_warrens")?.access?.entryCost).toBeUndefined();
    const { runtime } = accessHarness(undefined, {}, { level: 1 });
    await expect(runtime.authorizeEntry("player-1", "cave-a")).resolves.toBeUndefined();
  });

  it("surfaces an active lockout from the repeat ledger", async () => {
    const { runtime, ledger } = accessHarness({ lockoutDays: 6 });
    ledger.authorizeEntry.mockRejectedValueOnce(Object.assign(new Error("You already cleared this dungeon."), { code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE" }));
    await expect(runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({ code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE" });
  });

  it("refuses entry into an unpaid run, but admits a member joining an occupied run free", async () => {
    const { runtime, database } = accessHarness({ entryCost: TORCH });
    const instanceId = "dungeon:cave-a:party:party-1";
    await expect(runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({
      code: "DUNGEON_TORCHES_REQUIRED", message: expect.stringContaining("18 Glimmer Oil + 1 Wood")
    });
    await expect(runtime.enter(player("player-1"), "cave-a", canonical(instanceId)))
      .rejects.toMatchObject({ code: "DUNGEON_TORCHES_REQUIRED" });
    expect(database.presences.has("player-1")).toBe(false);
    database.presences.set("leader", { instanceId, runId: "run-1", sessionId: "s" });
    database.runs.set(instanceId, "run-1");
    await expect(runtime.authorizeEntry("player-1", "cave-a")).resolves.toBeUndefined();
  });

  it("charges each member torches x cost once, enters free, and spawns the torch total's sets", async () => {
    const chargeEntryCost = vi.fn(async (..._args: unknown[]) => undefined);
    const dungeon = rolledInteractiveDungeon();
    dungeon.instancePolicy = "party_ephemeral";
    dungeon.access = { entryCost: TORCH };
    const database = genericDungeonDatabase();
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const ledger = { authorizeEntry: vi.fn(async () => undefined), recordCompletion: vi.fn(async () => ({})) };
    const runtime = new CisternWarrensRuntime(database.pool, harness.combat as never, undefined, dungeon,
      { partyIdForPlayer: () => "party-1", chargeEntryCost }, authoredCatalog(dungeon), ledger as never);
    const instanceId = "dungeon:cave-a:party:party-1";
    const members = [{ playerId: "player-1", name: "One", torches: 2 }, { playerId: "player-2", name: "Two", torches: 1 },
      { playerId: "player-3", name: "Three", torches: 0 }];
    await expect(runtime.startTorchRun({ entranceId: "cave-a", members: members.map((member) => ({ ...member, torches: 9 })) }))
      .rejects.toMatchObject({ code: "DUNGEON_TORCHES_INVALID" });
    await expect(runtime.startTorchRun({ entranceId: "cave-a", members: members.map((member) => ({ ...member, torches: 0 })) }))
      .rejects.toMatchObject({ code: "DUNGEON_TORCHES_INVALID" });
    expect(chargeEntryCost).not.toHaveBeenCalled();
    const started = await runtime.startTorchRun({ entranceId: "cave-a", members });
    expect(started).toMatchObject({ instanceId, torchTotal: 3, replayed: false });
    expect(chargeEntryCost.mock.calls.map(([, playerId, items]) => [playerId, items])).toEqual([
      ["player-1", [{ itemId: "refined_oil", quantity: 36 }, { itemId: "wood", quantity: 2 }]],
      ["player-2", [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }]]
    ]);
    // A repeated start finds the paid run and charges nothing more.
    await expect(runtime.startTorchRun({ entranceId: "cave-a", members })).resolves.toMatchObject({
      runId: started.runId, torchTotal: 3, replayed: true
    });
    expect(chargeEntryCost).toHaveBeenCalledTimes(2);
    await runtime.authorizeEntry("player-1", "cave-a");
    const snapshot = await runtime.enter(player("player-1"), "cave-a", canonical(instanceId));
    // Full snapshots carry only the torch sets this run spawns (the materializer keeps all ten).
    const sentSets = snapshot.room.mobs.map((mob) => mob.partySet ?? 1);
    expect(Math.max(...sentSets)).toBe(3);
    await runtime.enter(player("player-2"), "cave-a", canonical(instanceId));
    expect(database.presences.get("player-1")!.runId).toBe(started.runId);
    expect(database.stats.get(started.runId)).toEqual({ torchTotal: 3, partySize: 2 });
    expect(chargeEntryCost).toHaveBeenCalledTimes(2);
    await expect(runtime.startTorchRun({ entranceId: "cave-a", members }))
      .rejects.toMatchObject({ code: "DUNGEON_RUN_IN_PROGRESS" });
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "start-torches");
    const sets = harness.combat.spawnMob.mock.calls.map(([input]) => /_roll_s(\d+)_/u.exec(input.entityId)![1]);
    expect(sets.sort()).toEqual(["1", "1", "1", "2", "2", "2", "3", "3", "3"]);
  });

  it("charges Atlas Pass holders 35% off the Glimmer Oil per torch only while the discount hook is on", async () => {
    const PASS_TORCH = [{ itemId: "refined_oil", quantity: 11 }, { itemId: "wood", quantity: 1 }];
    const passHolders = new Set(["pass-1"]);
    const atlasPassEntryDiscount = vi.fn(async (_queryable: unknown, playerId: string) => passHolders.has(playerId));
    const chargeEntryCost = vi.fn(async (..._args: unknown[]) => undefined);
    const on = accessHarness({ entryCost: TORCH }, { chargeEntryCost, atlasPassEntryDiscount });
    // A plain enter into an unpaid, empty run burns one torch at the entrant's price.
    await on.runtime.enter(player("pass-1"), "cave-a", canonical("dungeon:cave-a:party:party-a"));
    await on.runtime.enter(player("plain-1"), "cave-a", canonical("dungeon:cave-a:party:party-b"));
    expect(chargeEntryCost.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["pass-1", PASS_TORCH],
      ["plain-1", TORCH]
    ]);
    // The torch lobby shows each player their own per-torch price and charges each member at it.
    await expect(on.runtime.torchEntryFor("pass-1", "cave-a")).resolves.toMatchObject({ entryCost: PASS_TORCH });
    const lobby = accessHarness({ entryCost: TORCH }, { chargeEntryCost, atlasPassEntryDiscount, partyIdForPlayer: () => "party-1" });
    chargeEntryCost.mockClear();
    await lobby.runtime.startTorchRun({ entranceId: "cave-a", members: [
      { playerId: "pass-1", name: "Pass", torches: 2 }, { playerId: "plain-1", name: "Plain", torches: 1 }
    ] });
    expect(chargeEntryCost.mock.calls.map((call) => [call[1], call[2], (call[3] as { torches?: number }).torches])).toEqual([
      ["pass-1", [{ itemId: "refined_oil", quantity: 22 }, { itemId: "wood", quantity: 2 }], 2],
      ["plain-1", TORCH, 1]
    ]);
    const offCharge = vi.fn(async (..._args: unknown[]) => undefined);
    const off = accessHarness({ entryCost: TORCH }, { chargeEntryCost: offCharge });
    await off.runtime.enter(player("pass-1"), "cave-a", canonical("dungeon:cave-a:party:party-a"));
    expect(offCharge).toHaveBeenCalledWith(expect.anything(), "pass-1", TORCH, expect.anything());
  });

  it("refuses to start without a payment hook or for a member who left the party", async () => {
    const missing = accessHarness({ entryCost: TORCH });
    await expect(missing.runtime.startTorchRun({ entranceId: "cave-a", members: [{ playerId: "player-1", name: "One", torches: 1 }] }))
      .rejects.toMatchObject({ code: "DUNGEON_ENTRY_COST_UNAVAILABLE" });
    const chargeEntryCost = vi.fn(async () => undefined);
    const moved = accessHarness({ entryCost: TORCH }, {
      chargeEntryCost, partyIdForPlayer: (playerId) => playerId === "player-2" ? "party-2" : "party-1"
    });
    await expect(moved.runtime.startTorchRun({ entranceId: "cave-a", members: [
      { playerId: "player-1", name: "One", torches: 1 }, { playerId: "player-2", name: "Two", torches: 1 }
    ] })).rejects.toMatchObject({ code: "TORCH_LOBBY_PARTY_CHANGED" });
    expect(chargeEntryCost).not.toHaveBeenCalled();
  });

  it("charges nobody when a member leaves the party while the start transaction charges", async () => {
    let partyOfTwo = "party-1";
    const chargeEntryCost = vi.fn(async (..._args: unknown[]) => { partyOfTwo = "party-2"; });
    const { runtime, database } = accessHarness({ entryCost: TORCH }, {
      chargeEntryCost, partyIdForPlayer: (playerId) => playerId === "player-2" ? partyOfTwo : "party-1"
    });
    const clients = (database.pool as unknown as { connect: { mock: { results: Array<{ value: Promise<{ query: { mock: { calls: unknown[][] } } }> }> } } }).connect;
    await expect(runtime.startTorchRun({ entranceId: "cave-a", members: [
      { playerId: "player-1", name: "One", torches: 1 }, { playerId: "player-2", name: "Two", torches: 1 }
    ] })).rejects.toMatchObject({ code: "TORCH_LOBBY_PARTY_CHANGED", message: expect.stringContaining("Nobody was charged") });
    const statements = (await clients.mock.results.at(-1)!.value).query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("gives shared-instance dungeons no torch lobby: each entrant pays on entry", async () => {
    const { runtime, dungeon } = accessHarness({ entryCost: TORCH }, { chargeEntryCost: vi.fn(async () => undefined) });
    await expect(runtime.torchEntryFor("player-1", "cave-a")).resolves.toMatchObject({ partyScoped: true });
    dungeon.instancePolicy = "shared_persistent";
    await expect(runtime.torchEntryFor("player-1", "cave-a")).resolves.toBeNull();
  });

  it("starts a lockout for everyone present when the dungeon completes", async () => {
    const { runtime, database, ledger, dungeon } = accessHarness({ lockoutDays: 3 }, {}, { completes: true });
    const instanceId = "dungeon:cave-a:party:party-1";
    await runtime.enter(player("player-1"), "cave-a", canonical(instanceId));
    await runtime.enter(player("player-2"), "cave-a", canonical(instanceId));
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "finish");
    await vi.waitFor(() => expect(ledger.recordCompletion).toHaveBeenCalledTimes(2));
    expect(ledger.recordCompletion).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-2", dungeonKey: `dungeon:${dungeon.id}`, baseCooldownDays: 3
    }));
  });

  it("passes an hour-based lockout to the ledger instead of days", async () => {
    const { runtime, database, ledger } = accessHarness({ lockoutHours: 12 }, {}, { completes: true });
    await runtime.enter(player("player-1"), "cave-a", canonical("dungeon:cave-a:party:party-1"));
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "finish");
    await vi.waitFor(() => expect(ledger.recordCompletion).toHaveBeenCalledTimes(1));
    const call = ledger.recordCompletion.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.lockoutHours).toBe(12);
    expect(call).not.toHaveProperty("baseCooldownDays");
  });

  it("requires every entrant to be afloat when the dungeon says so (Drowned City)", async () => {
    const afloat = new Set<string>();
    const { runtime, ledger } = accessHarness({ minimumLevel: 32, requiresAfloat: true }, { isAfloat: (id) => afloat.has(id) }, { level: 32 });
    await expect(runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({ code: "DUNGEON_AFLOAT_REQUIRED" });
    expect(ledger.authorizeEntry).not.toHaveBeenCalled();
    afloat.add("player-1");
    await expect(runtime.authorizeEntry("player-1", "cave-a")).resolves.toBeUndefined();
    // No afloat authority fails closed.
    const unknown = accessHarness({ requiresAfloat: true }, {}, { level: 30 });
    await expect(unknown.runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({ code: "DUNGEON_AFLOAT_REQUIRED" });
    // Level still gates an afloat player.
    const low = accessHarness({ minimumLevel: 32, requiresAfloat: true }, { isAfloat: () => true }, { level: 31 });
    await expect(low.runtime.authorizeEntry("player-1", "cave-a")).rejects.toMatchObject({ code: "DUNGEON_LEVEL_TOO_LOW" });
  });

  it("no re-entry: leaving through the world exit before completion starts the lockout but is never a clear", async () => {
    const onDungeonCompleted = vi.fn();
    const { runtime, database, ledger, dungeon } = accessHarness({ lockoutDays: 6, noReentry: true }, { onDungeonCompleted }, { completes: true });
    const instanceId = "dungeon:cave-a:party:party-1";
    const escape = portalIds.dungeon("cave-a", dungeon.escape.portalId);
    await runtime.enter(player("player-1"), "cave-a", canonical(instanceId));
    await runtime.enter(player("player-2"), "cave-a", canonical(instanceId));
    // A non-exit portal id (or none, as a disconnect cleanup) never locks out.
    await runtime.leave("player-2", database.presences.get("player-2")!.sessionId);
    expect(ledger.recordEarlyLeave).not.toHaveBeenCalled();
    await runtime.leave("player-1", database.presences.get("player-1")!.sessionId, escape);
    expect(ledger.recordEarlyLeave).toHaveBeenCalledTimes(1);
    expect(ledger.recordEarlyLeave).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1", dungeonKey: `dungeon:${dungeon.id}`, baseCooldownDays: 6, runId: expect.any(String)
    }));
    // Not a clear: no clear record and no completion event (the only clear consumer).
    expect(ledger.recordCompletion).not.toHaveBeenCalled();
    expect(onDungeonCompleted).not.toHaveBeenCalled();
    // A completed run's exit adds no early-leave lockout (the clear already recorded one).
    const done = accessHarness({ lockoutDays: 6, noReentry: true }, {}, { completes: true });
    await done.runtime.enter(player("player-1"), "cave-a", canonical(instanceId));
    done.runtime.interact("player-1", done.database.presences.get("player-1")!.sessionId, "test-valve", "finish");
    await vi.waitFor(() => expect(done.ledger.recordCompletion).toHaveBeenCalledTimes(1));
    await done.runtime.leave("player-1", done.database.presences.get("player-1")!.sessionId, escape);
    expect(done.ledger.recordCompletion).toHaveBeenCalledTimes(1);
    expect(done.ledger.recordEarlyLeave).not.toHaveBeenCalled();
    // Without noReentry an early exit is free.
    const open = accessHarness({ lockoutDays: 6 });
    await open.runtime.enter(player("player-1"), "cave-a", canonical(instanceId));
    await open.runtime.leave("player-1", open.database.presences.get("player-1")!.sessionId, escape);
    expect(open.ledger.recordEarlyLeave).not.toHaveBeenCalled();
  });

  it("ejects a failed room through the location CAS, and a reconnect after the eject restores the new room", async () => {
    const dungeon = interactiveDungeon();
    dungeon.instancePolicy = "party_ephemeral";
    const instanceId = "dungeon:cave-a:party:party-1";
    const database = genericDungeonDatabase();
    const baseQuery = (database.pool as unknown as { query: (sql: string, values?: unknown[]) => Promise<unknown> }).query;
    (database.pool as unknown as { query: unknown }).query = vi.fn(async (sql: string, values: unknown[] = []) => {
      const presence = database.presences.get(String(values[0]));
      if (sql.includes("FROM dungeon_presence WHERE player_id") && presence) {
        return { rows: [{ sewer_structure_id: "cave-a", session_id: presence.sessionId, local_x: 420, local_y: 360,
          return_region_code: "world", return_lat: 35, return_lon: -106, instance_id: presence.instanceId,
          dungeon_id: dungeon.id, run_id: presence.runId }], rowCount: 1 };
      }
      return baseQuery(sql, values);
    });
    let revision = 4;
    const inside = (spaceId: string, position: { x: number; y: number }) => ({
      kind: "interior" as const, locationType: "dungeon" as const, locationId: "cave-a", instanceId, spaceId,
      regionCode: `interior:${instanceId}`, zoneId: `interior:${instanceId}:${spaceId}`, position, revision, lastPortalId: "entry"
    });
    const playerLocations = {
      load: vi.fn(async () => inside("hatch_landing", { x: 420, y: 360 })),
      commitPortalTransition: vi.fn(async (input: { destination: { spaceId: string; position: { x: number; y: number } } }) => {
        revision += 1;
        return { location: inside(input.destination.spaceId, input.destination.position), replayed: false };
      }),
      persistInteriorPosition: vi.fn(async () => undefined)
    };
    const onPlayerEjected = vi.fn();
    const harness = runtimeHarness({ localX: 67.2, localY: 57.6 }, dungeon);
    const runtime = new CisternWarrensRuntime(database.pool, harness.combat as never, playerLocations as never, dungeon,
      { partyIdForPlayer: () => "party-1", onPlayerEjected }, authoredCatalog(dungeon),
      { authorizeEntry: vi.fn(), recordCompletion: vi.fn(), recordEarlyLeave: vi.fn() } as never);
    await runtime.enter(player("player-1"), "cave-a", canonical(instanceId));
    const session = (runtime as unknown as { sessions: Map<string, unknown> }).sessions.get("player-1");
    await runtime.ejectToRoom(session as never, "hatch-to-overflow", "overflow_channel", { x: 130, y: 400 });
    expect(playerLocations.commitPortalTransition).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1", expectedRevision: 4, portalId: portalIds.dungeon("cave-a", "hatch-to-overflow"),
      destination: expect.objectContaining({ kind: "interior", instanceId, spaceId: "overflow_channel", position: { x: 130, y: 400 } })
    }));
    expect(runtime.get("player-1")).toMatchObject({ spaceId: "overflow_channel" });
    expect(onPlayerEjected).toHaveBeenCalledWith("player-1",
      expect.objectContaining({ spaceId: "overflow_channel", revision: 5 }), expect.objectContaining({ spaceId: "overflow_channel" }));
    // A stale canonical location (another transition won the race) moves nobody.
    playerLocations.commitPortalTransition.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "STALE_LOCATION" }));
    await expect(runtime.ejectToRoom(session as never, "hatch-to-overflow", "hatch_landing", { x: 420, y: 360 })).rejects.toThrow("stale");
    expect(runtime.get("player-1")).toMatchObject({ spaceId: "overflow_channel" });
    // Disconnect, then reconnect from the committed canonical location: the player is in the new room.
    runtime.suspend("player-1");
    await runtime.detachRuntime("player-1");
    expect(runtime.get("player-1")).toBeNull();
    const restored = await runtime.restore(player("player-1"), {
      sewerId: "cave-a", spaceId: "overflow_channel", position: { x: 130, y: 400 }, instanceId, locationType: "dungeon"
    });
    expect(restored).toMatchObject({ spaceId: "overflow_channel", instanceId });
  });

  it("records no lockout when the dungeon configures none (lockoutDays 0)", async () => {
    const { runtime, database, ledger } = accessHarness({ lockoutDays: 0 }, {}, { completes: true });
    await runtime.enter(player("player-1"), "cave-a", canonical("dungeon:cave-a:party:party-1"));
    runtime.interact("player-1", database.presences.get("player-1")!.sessionId, "test-valve", "finish");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ledger.recordCompletion).not.toHaveBeenCalled();
  });
});

describe("Fangrock Cavern lever puzzle", () => {
  const LEVER_SPOTS = { triangle: 1260, circle: 1150, square: 1370 } as const;
  async function leverRun() {
    const dungeon = structuredClone(DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === "fangrock_cavern")!);
    const harness = runtimeHarness({ localX: 0, localY: 0 }, dungeon);
    const runtime = CisternWarrensRuntime.ephemeral({
      combat: harness.combat as never, dungeon, catalog: authoredCatalog(dungeon),
      runId: "seed:levers", now: () => 0
    });
    await runtime.enter(player(), "cave-a", {
      spaceId: "narrow_pass", position: { x: 1260, y: 300 }, instanceId: "dungeon:cave-a", locationType: "dungeon"
    });
    const session = [...(runtime as unknown as { sessions: Map<string, { x: number; y: number }> }).sessions.values()][0]!;
    const snapshot = () => runtime.get("player-1")!;
    let request = 0;
    const pull = (lever: keyof typeof LEVER_SPOTS) => {
      session.x = LEVER_SPOTS[lever];
      session.y = 310;
      return runtime.interact("player-1", snapshot().sessionId, `pass-lever-${lever}`, `pull-${request += 1}`);
    };
    const leverStates = () => Object.fromEntries(snapshot().objects.filter((object) => object.id.startsWith("pass-lever-"))
      .map((object) => [object.id.replace("pass-lever-", ""), object.state]));
    const ambush = () => snapshot().encounters.find((encounter) => encounter.id === "lever_ambush")!.state;
    const ambushSpawns = () => harness.combat.spawnMob.mock.calls
      .filter(([input]) => input.entityId.includes(":lever_ambush_roll_")).length;
    const exitLocked = () => {
      const portalId = snapshot().objects.find((object) => object.id === "pass_to_pit_object")!.portalId!;
      return snapshot().portalLocks[portalId];
    };
    return { runtime, snapshot, pull, leverStates, ambush, ambushSpawns, exitLocked, harness };
  }

  it("locks the pass exit behind three levers and opens it for triangle, circle, square", async () => {
    const run = await leverRun();
    expect(run.exitLocked()).toBe(true);
    expect(run.snapshot().objects.find((object) => object.id === "pass-cache-chest")?.available).toBe(false);
    expect(run.leverStates()).toEqual({ triangle: "released", circle: "released", square: "released" });

    run.pull("triangle");
    run.pull("circle");
    expect(run.exitLocked()).toBe(true);
    run.pull("square");
    expect(run.exitLocked()).toBe(false);
    expect(run.snapshot().dungeonFlags["pass_levers_solved"]).toBe(true);
    expect(run.snapshot().objects.find((object) => object.id === "pass-cache-chest")?.available).toBe(true);
    expect(run.leverStates()).toEqual({ triangle: "pressed", circle: "pressed", square: "pressed" });
    expect(run.ambush()).toBe("idle");
    expect(run.ambushSpawns()).toBe(0);
  });

  it("answers a wrong order with one ambush and a reset, then still opens for the right order", async () => {
    const run = await leverRun();
    run.pull("circle");
    expect(run.ambush()).toBe("active");
    expect(run.ambushSpawns()).toBe(4);
    expect(run.leverStates()).toEqual({ triangle: "released", circle: "released", square: "released" });
    expect(run.exitLocked()).toBe(true);

    // A second mistake midway (triangle, then square) resets again without a second ambush.
    run.pull("triangle");
    run.pull("square");
    expect(run.leverStates()).toEqual({ triangle: "released", circle: "released", square: "released" });
    expect(run.ambushSpawns()).toBe(4);
    expect(run.exitLocked()).toBe(true);

    run.pull("triangle");
    run.pull("circle");
    run.pull("square");
    expect(run.exitLocked()).toBe(false);
    expect(run.snapshot().dungeonFlags["pass_levers_solved"]).toBe(true);
  });

  it("ignores levers once solved instead of ambushing", async () => {
    const run = await leverRun();
    run.pull("triangle");
    run.pull("circle");
    run.pull("square");
    run.pull("circle");
    expect(run.ambush()).toBe("idle");
    expect(run.exitLocked()).toBe(false);
  });
});

describe("dungeon dash", () => {
  async function dashHarness(localX: number, localY: number) {
    const harness = runtimeHarness({ localX, localY });
    Object.assign(harness.combat, { isPlayerAlive: vi.fn(() => true), notePlayerDashed: vi.fn() });
    await harness.runtime.restore(player(), { sewerId: "sewer-1", spaceId: "hatch_landing", position: { x: localX, y: localY } });
    return harness;
  }

  it("travels the overworld dash distance through open floor and starts the cooldown and i-frames", async () => {
    const harness = await dashHarness(500, 500);
    const dash = harness.runtime.dash("player-1", 1, 0);
    expect(dash.toLocal.x - dash.fromLocal.x).toBeCloseTo(DASH_DISTANCE_M / DUNGEON_METERS_PER_COORDINATE, 3);
    expect(dash.toLocal.y).toBeCloseTo(500, 6);
    expect(harness.runtime.get("player-1")?.player).toMatchObject({ x: dash.toLocal.x, y: dash.toLocal.y, targetX: null });
    expect(harness.runtime.isDashInvulnerable("player-1")).toBe(true);
    expect((harness.combat as unknown as { notePlayerDashed: ReturnType<typeof vi.fn> }).notePlayerDashed).toHaveBeenCalledWith("player-1");
    expect(() => harness.runtime.dash("player-1", 1, 0)).toThrowError(/cooldown/);
  });

  it("is clamped by the room walls instead of crossing them", async () => {
    const harness = await dashHarness(500, 80);
    // North on screen is -y locally; the full dash would leave the floor.
    const dash = harness.runtime.dash("player-1", 0, 1);
    const travelled = Math.hypot(dash.toLocal.x - dash.fromLocal.x, dash.toLocal.y - dash.fromLocal.y);
    expect(travelled).toBeLessThan(DASH_DISTANCE_M / DUNGEON_METERS_PER_COORDINATE - 20);
    expect(dash.toLocal.y).toBeGreaterThan(0);
    expect(dash.toLocal.y).toBeLessThan(80);
  });
});
