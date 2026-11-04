import { AFLOAT_SPEED_MULTIPLIER, distanceMeters, moveToward, type LatLon } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { GameState, type WaterLegSurface } from "./state.js";
import {
  WaterTravelService,
  buildWaterLegPlan,
  classifyWaterSurface,
  samplePathPoints,
  waterLegSpeedProfile
} from "./waterTravel.js";

const config = loadConfig({ NODE_ENV: "test", PLAYER_SPEED_MPS: "100", MOVE_LEASH_RADIUS_M: "600" });

function east(origin: LatLon, distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.05 }, distanceM);
}

function samples(...surfaces: WaterLegSurface[]) {
  return surfaces.map((surface, index) => ({ distanceM: index * 100, surface }));
}

describe("water path sampling", () => {
  it("classifies World API surfaces and fails open", () => {
    expect(classifyWaterSurface({ ok: true, surfaceKind: "water", waterKind: "ocean" })).toBe("open_water");
    expect(classifyWaterSurface({ ok: true, surfaceKind: "water", waterKind: "lake" })).toBe("open_water");
    expect(classifyWaterSurface({ ok: true, surfaceKind: "water", waterKind: "inland_water" })).toBe("open_water");
    expect(classifyWaterSurface({ ok: true, surfaceKind: "water", waterKind: "river" })).toBe("open_water");
    expect(classifyWaterSurface({ ok: true, surfaceKind: "land", waterKind: null })).toBe("land");
    expect(classifyWaterSurface({ ok: false, surfaceKind: "water", waterKind: "ocean" })).toBe("unknown");
    expect(classifyWaterSurface(undefined)).toBe("unknown");
  });

  it("samples the straight path on a snapped grid from origin to target", () => {
    const origin = { lat: 35.08, lon: -106.65 };
    const target = east(origin, 600);
    const path = samplePathPoints(origin, target);
    // One sample per 15 m plus the target (float rounding may add one).
    expect(path.length).toBeGreaterThanOrEqual(41);
    expect(path.length).toBeLessThanOrEqual(42);
    expect(path[0]!.distanceM).toBe(0);
    expect(path.at(-1)!.distanceM).toBeCloseTo(600, 3);
    for (const sample of path) {
      expect(Math.abs(sample.point.lat * 1e4 - Math.round(sample.point.lat * 1e4))).toBeLessThan(1e-6);
      expect(Math.abs(sample.point.lon * 1e4 - Math.round(sample.point.lon * 1e4))).toBeLessThan(1e-6);
    }
    // Long paths stay within the batch budget.
    expect(samplePathPoints(origin, east(origin, 20_000)).length).toBeLessThanOrEqual(200);
  });

  it("places breakpoints halfway between differing samples with water at half speed", () => {
    const plan = buildWaterLegPlan({ samples: samples("land", "land", "open_water", "land"), afloat: true, wet: false });
    expect(plan.needsRaft).toBe(false);
    expect(plan.segments).toEqual([
      { startM: 0, multiplier: 1, surface: "land" },
      { startM: 150, multiplier: 0.5, surface: "open_water" },
      { startM: 250, multiplier: 1, surface: "land" }
    ]);
  });

  it("needs a raft from land into ocean or lake but not when already afloat", () => {
    expect(buildWaterLegPlan({ samples: samples("land", "open_water"), afloat: false, wet: false }).needsRaft)
      .toBe(true);
    expect(buildWaterLegPlan({ samples: samples("land", "open_water"), afloat: true, wet: false }).needsRaft)
      .toBe(false);
    expect(buildWaterLegPlan({ samples: samples("land", "unknown", "land"), afloat: false, wet: false }).needsRaft)
      .toBe(false);
  });

  it("is afloat for free when the move starts on open water", () => {
    const plan = buildWaterLegPlan({ samples: samples("open_water", "land"), afloat: false, wet: false });
    expect(plan).toMatchObject({ needsRaft: false, afloatAtStart: true, wetAtStart: true });
  });

  it("stops on the shore instead of needing a second raft after coming ashore", () => {
    const plan = buildWaterLegPlan({
      samples: samples("land", "open_water", "land", "open_water"),
      afloat: false,
      wet: false
    });
    expect(plan.needsRaft).toBe(true);
    expect(plan.truncateAtM).toBe(250);
    expect(plan.segments.map((segment) => segment.surface)).toEqual(["land", "open_water", "land"]);
  });

  it("sends speed breakpoints only for legs that slow down", () => {
    const origin = { lat: 1, lon: 2 };
    expect(waterLegSpeedProfile({
      origin, relocationRevision: 0,
      segments: [{ startM: 0, multiplier: 1, surface: "land" }, { startM: 50, multiplier: 1, surface: "unknown" }]
    })).toEqual({});
    expect(waterLegSpeedProfile({
      origin, relocationRevision: 0,
      segments: [
        { startM: 0, multiplier: 1, surface: "land" },
        { startM: 50, multiplier: 0.5, surface: "open_water" },
        { startM: 80, multiplier: 1, surface: "unknown" }
      ]
    })).toEqual({
      speedOrigin: origin,
      speedSegments: [{ startM: 0, multiplier: 1 }, { startM: 50, multiplier: 0.5 }, { startM: 80, multiplier: 1 }]
    });
  });
});

describe("GameState water legs", () => {
  it("moves at half speed on water and loses the raft on reaching land", () => {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    const origin = { ...player.position };
    gameState.setAfloat("p1", true);
    gameState.setTarget("p1", east(origin, 300), {
      origin,
      relocationRevision: player.relocationRevision ?? 0,
      segments: [
        { startM: 0, multiplier: AFLOAT_SPEED_MULTIPLIER, surface: "open_water" },
        { startM: 200, multiplier: 1, surface: "land" }
      ]
    });
    gameState.tick(1);
    expect(distanceMeters(origin, player.position)).toBeCloseTo(50, 1);
    expect(gameState.isWet("p1")).toBe(true);
    expect(gameState.snapshotForPlayer("p1").afloat).toBe(true);
    for (let index = 0; index < 4; index += 1) gameState.tick(1);
    expect(distanceMeters(origin, player.position)).toBeGreaterThan(200);
    expect(gameState.isAfloat("p1")).toBe(false);
    expect(gameState.snapshotForPlayer("p1").afloat).toBeUndefined();
  });

  it("keeps an unused raft on land and clears afloat on relocation and death", () => {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    gameState.setAfloat("p1", true);
    gameState.setTarget("p1", east(player.position, 100), {
      origin: { ...player.position },
      relocationRevision: 0,
      segments: [{ startM: 0, multiplier: 1, surface: "land" }]
    });
    gameState.tick(2);
    expect(gameState.isAfloat("p1")).toBe(true);
    gameState.teleportPlayer("p1", east(player.anchor, 50));
    expect(gameState.isAfloat("p1")).toBe(false);
    gameState.setAfloat("p1", true);
    gameState.respawnPlayerAtAnchor("p1");
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("keeps afloat across a reconnect of the persisted record", () => {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    gameState.setAfloat("p1", true, true);
    gameState.markOffline("p1");
    const reconnected = gameState.connectPlayer({ ...player, online: false });
    expect(reconnected.afloat).toBe(true);
    expect(gameState.snapshotForPlayer("p1").afloat).toBe(true);
  });

  it("ignores a leg planned before a relocation", () => {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    gameState.teleportPlayer("p1", east(player.anchor, 10));
    gameState.setTarget("p1", east(player.anchor, 100), {
      origin: { ...player.position },
      relocationRevision: 0,
      segments: [{ startM: 0, multiplier: 0.5, surface: "open_water" }]
    });
    expect(gameState.currentWaterLeg("p1")).toBeNull();
  });
});

describe("WaterTravelService", () => {
  function service(lookup: (points: readonly LatLon[]) => Promise<unknown[]>) {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    const worldLookup = {
      lookupGameplayEnvironments: vi.fn((points: readonly LatLon[], _options?: unknown) => lookup(points))
    };
    const waterTravel = new WaterTravelService({
      pool: {} as never,
      inventory: {} as never,
      worldLookup: worldLookup as never,
      gameState,
      logger: { warn: vi.fn() }
    });
    return { gameState, player, worldLookup, waterTravel };
  }

  it("needs a raft when the path enters ocean and caches the sampled grid", async () => {
    const { player, worldLookup, waterTravel } = service(async (points) =>
      points.map((point) => ({
        ok: true,
        surfaceKind: point.lon > -106.648 ? "water" : "land",
        waterKind: point.lon > -106.648 ? "ocean" : null
      })));
    player.position = { lat: 35.08, lon: -106.65 };
    player.anchor = { ...player.position };
    const target = east(player.position, 400);
    const plan = await waterTravel.planMove("p1", target);
    expect(plan?.needsRaft).toBe(true);
    expect(plan?.leg.segments.map((segment) => segment.surface)).toEqual(["land", "open_water"]);
    expect(worldLookup.lookupGameplayEnvironments).toHaveBeenCalledTimes(1);
    expect(worldLookup.lookupGameplayEnvironments.mock.calls[0]![1]).toMatchObject({ caller: "travel" });
    await waterTravel.planMove("p1", target);
    expect(worldLookup.lookupGameplayEnvironments).toHaveBeenCalledTimes(1);
  });

  function oceanEastOf(lon: number) {
    return async (points: readonly LatLon[]) => points.map((point) => ({
      ok: true,
      surfaceKind: point.lon > lon ? "water" : "land",
      waterKind: point.lon > lon ? "ocean" : null
    }));
  }

  it("blocks a combat approach from land onto ocean without a raft", async () => {
    const { gameState, player, waterTravel } = service(oceanEastOf(-106.648));
    player.position = { lat: 35.08, lon: -106.65 };
    player.anchor = { ...player.position };
    const blocked = vi.fn();
    gameState.setCombatApproachPlanner(
      (playerId, target) => waterTravel.planCombatApproach(playerId, target),
      blocked
    );
    const mob = east(player.position, 400);
    await waterTravel.prewarmPath("p1", mob);
    gameState.setCombatTarget("p1", east(player.position, 380));
    expect(blocked).toHaveBeenCalledWith("p1");
    expect(player.target).toBeNull();
    gameState.tick(1);
    expect(distanceMeters({ lat: 35.08, lon: -106.65 }, player.position)).toBe(0);
  });

  it("allows a combat approach over land and afloat approaches at water speed", async () => {
    const { gameState, player, waterTravel } = service(oceanEastOf(-106.648));
    player.position = { lat: 35.08, lon: -106.65 };
    player.anchor = { ...player.position };
    const blocked = vi.fn();
    gameState.setCombatApproachPlanner(
      (playerId, target) => waterTravel.planCombatApproach(playerId, target),
      blocked
    );
    const landTarget = east(player.position, 100);
    await waterTravel.prewarmPath("p1", landTarget);
    gameState.setCombatTarget("p1", landTarget);
    expect(blocked).not.toHaveBeenCalled();
    expect(player.target).toEqual(landTarget);

    // Afloat on the ocean: the approach is allowed and uses the 0.5 breakpoints.
    player.target = null;
    player.position = east({ lat: 35.08, lon: -106.65 }, 300);
    player.anchor = { ...player.position };
    gameState.setAfloat("p1", true, true);
    const seaTarget = east(player.position, 200);
    await waterTravel.prewarmPath("p1", seaTarget);
    const start = { ...player.position };
    gameState.setCombatTarget("p1", seaTarget);
    expect(blocked).not.toHaveBeenCalled();
    expect(gameState.currentWaterLeg("p1")?.segments[0]).toMatchObject({ multiplier: 0.5 });
    gameState.tick(1);
    expect(distanceMeters(start, player.position)).toBeCloseTo(50, 1);
  });

  it("fails open when the World API is unavailable", async () => {
    const { player, waterTravel } = service(async () => { throw new Error("world down"); });
    const plan = await waterTravel.planMove("p1", east(player.position, 300));
    expect(plan?.needsRaft).toBe(false);
    expect(plan?.leg.segments).toEqual([{ startM: 0, multiplier: 1, surface: "unknown" }]);
  });

  it("sets afloat for free when logging in on open water", async () => {
    const { gameState, waterTravel } = service(async (points) =>
      points.map(() => ({ ok: true, surfaceKind: "water", waterKind: "lake" })));
    await waterTravel.refreshArrival("p1");
    expect(gameState.isAfloat("p1")).toBe(true);
    expect(gameState.isWet("p1")).toBe(true);
  });
});

describe("WaterTravelService shore stop and slide", () => {
  // Ocean east of lon -106.648; a cell edge sits at about -106.64795 (cells snap to 1e-4 degrees).
  const SHORE_EDGE_LON = -106.64795;
  const start = { lat: 35.08, lon: -106.65 };

  function setup(isWater: (point: LatLon) => boolean, position: LatLon = start) {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    player.position = { ...position };
    player.anchor = { ...position };
    const worldLookup = {
      lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[], _options?: unknown) =>
        points.map((point) => isWater(point)
          ? { ok: true, surfaceKind: "water", waterKind: "ocean" }
          : { ok: true, surfaceKind: "land", waterKind: null }))
    };
    const waterTravel = new WaterTravelService({
      pool: {} as never,
      inventory: {} as never,
      worldLookup: worldLookup as never,
      gameState,
      logger: { warn: vi.fn() }
    });
    return { gameState, player, worldLookup, waterTravel };
  }
  const oceanEast = (point: LatLon): boolean => point.lon > -106.648;
  const river = (point: LatLon): boolean => point.lon > -106.648 && point.lon < -106.647;
  const north = (origin: LatLon, meters: number): LatLon => moveToward(origin, { lat: origin.lat + 0.05, lon: origin.lon }, meters);

  it("stops an unrafted walk at the shore without asking for a raft", async () => {
    const { waterTravel } = setup(oceanEast);
    const plan = await waterTravel.planMove("p1", east(start, 400), { walk: true });
    expect(plan).toMatchObject({ needsRaft: false, blocked: true });
    expect(plan!.target.lon).toBeLessThan(SHORE_EDGE_LON);
    expect(distanceMeters(start, plan!.target)).toBeGreaterThan(180);
    expect(plan!.leg.segments.every((segment) => segment.surface !== "open_water")).toBe(true);
  });

  it("stops a tap on land across water at the shore, but a tap on the water still needs a raft", async () => {
    const { waterTravel } = setup(river);
    const acrossRiver = await waterTravel.planMove("p1", east(start, 400));
    expect(acrossRiver).toMatchObject({ needsRaft: false, blocked: true });
    expect(acrossRiver!.target.lon).toBeLessThan(SHORE_EDGE_LON);
    const onWater = await waterTravel.planMove("p1", east(start, 215));
    expect(onWater?.needsRaft).toBe(true);
    expect(onWater?.blocked).toBeUndefined();
  });

  it("slides along the shore and reports the wall when walking diagonally into it", async () => {
    const nearShore = { lat: 35.08, lon: -106.64797 };
    const { waterTravel } = setup(oceanEast, nearShore);
    const diagonal = moveToward(nearShore, { lat: nearShore.lat + 0.001, lon: nearShore.lon + 0.001 }, 8);
    const plan = await waterTravel.planMove("p1", diagonal, { walk: true });
    expect(plan?.needsRaft).toBe(false);
    expect(plan?.blocked).toBe(true);
    expect(plan!.target.lat - nearShore.lat).toBeGreaterThan(0.00005);
    expect(plan!.target.lon).toBeLessThan(SHORE_EDGE_LON);
    expect(plan!.shore?.normalDeg).toBeGreaterThan(70);
    expect(plan!.shore?.normalDeg).toBeLessThan(110);
    expect(plan!.shore!.gapM).toBeLessThan(3);
  });

  it("just stops when walking straight into the shore", async () => {
    const nearShore = { lat: 35.08, lon: -106.64797 };
    const { player, waterTravel } = setup(oceanEast, nearShore);
    const plan = await waterTravel.planMove("p1", east(nearShore, 8), { walk: true });
    expect(plan?.blocked).toBe(true);
    expect(plan!.target.lon).toBeLessThan(SHORE_EDGE_LON);
    // Standing at the shore, pushing straight in goes nowhere, however many times it is resent.
    let position = plan!.target;
    for (let step = 0; step < 4; step += 1) {
      player.position = { ...position };
      const again = await waterTravel.planMove("p1", east(position, 8), { walk: true });
      expect(again!.target.lon).toBeLessThan(SHORE_EDGE_LON);
      position = again!.target;
    }
    expect(distanceMeters(plan!.target, position)).toBeLessThan(0.5);
  });

  it("keeps sliding along the shore as the stick follows it", async () => {
    const nearShore = { lat: 35.08, lon: -106.64797 };
    const { gameState, player, waterTravel } = setup(oceanEast, nearShore);
    let position = nearShore;
    for (let step = 0; step < 6; step += 1) {
      const plan = await waterTravel.planMove("p1", moveToward(position, { lat: position.lat + 0.001, lon: position.lon + 0.001 }, 4), { walk: true });
      expect(plan!.target.lon).toBeLessThan(SHORE_EDGE_LON);
      position = plan!.target;
      player.position = { ...position };
    }
    expect(distanceMeters(nearShore, position)).toBeGreaterThan(15);
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("sends the wall hint while the shore contact is fresh even when the leg is clear", async () => {
    const nearShore = { lat: 35.08, lon: -106.64797 };
    const { waterTravel } = setup(oceanEast, nearShore);
    await waterTravel.planMove("p1", east(nearShore, 8), { walk: true });
    const clear = await waterTravel.planMove("p1", north(nearShore, 4), { walk: true });
    expect(clear?.blocked).toBeUndefined();
    expect(clear?.shore).toBeDefined();
  });

  it("does no shore probing for plain land walks", async () => {
    const { waterTravel, worldLookup } = setup(() => false);
    const plan = await waterTravel.planMove("p1", east(start, 6), { walk: true });
    expect(plan).toMatchObject({ needsRaft: false });
    expect(plan?.shore).toBeUndefined();
    expect(worldLookup.lookupGameplayEnvironments).toHaveBeenCalledTimes(1);
  });

  it("leaves afloat movement alone", async () => {
    const onWater = east(start, 300);
    const { gameState, waterTravel } = setup(oceanEast, onWater);
    gameState.setAfloat("p1", true, true);
    const plan = await waterTravel.planMove("p1", east(onWater, 100), { walk: true });
    expect(plan?.needsRaft).toBe(false);
    expect(plan?.blocked).toBeUndefined();
    expect(plan!.leg.segments[0]).toMatchObject({ multiplier: 0.5 });
  });

  it("fails open: unknown surfaces never stop a walk", async () => {
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("p1", "Ash");
    const waterTravel = new WaterTravelService({
      pool: {} as never,
      inventory: {} as never,
      worldLookup: { lookupGameplayEnvironments: vi.fn(async () => { throw new Error("down"); }) } as never,
      gameState,
      logger: { warn: vi.fn() }
    });
    const plan = await waterTravel.planMove("p1", east(player.position, 100), { walk: true });
    expect(plan).toMatchObject({ needsRaft: false });
    expect(plan?.blocked).toBeUndefined();
  });
});
