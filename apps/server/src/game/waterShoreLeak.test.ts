import {
  clipWalkTargetToShore,
  destinationPoint,
  distanceMeters,
  moveToward,
  type LatLon,
  type WaterShoreHint
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { GameState } from "./state.js";
import { pathCells, snapToSampleGrid } from "./waterCells.js";
import { WaterTravelService, samplePathPoints } from "./waterTravel.js";

/**
 * Free-raft leak (docs/plans/water-shore.md): an unrafted player must never become afloat except through the
 * paid launchRaft, a water site, or an arrival on water. The dev runtime walks at 125 m/s with a 0.7 s joystick
 * lookahead (87.5 m walk legs). Root cause: a MOVE_TO that started on a water cell made the player afloat for
 * free, and walk legs could reach water cells the planner never checked (slides past the 24 m probe, corners
 * clipped between samples, cells unknown to a cold World API).
 */
const SPEED_MPS = 125;
const WALK_LEG_M = SPEED_MPS * 0.7;
const config = loadConfig({
  NODE_ENV: "test", PLAYER_SPEED_MPS: String(SPEED_MPS), MOVE_LEASH_RADIUS_M: "600"
});
const G = 1e-4;
const LAT0 = 26.8408;
const LON0 = -80.9531;
const I0 = Math.round(LAT0 / G);
const J0 = Math.round(LON0 / G);

type Shore = (di: number, dj: number) => boolean;
const SHORES: Record<string, Shore> = {
  staircase: (di, dj) => dj - Math.floor(di / 2) > 0,
  diagonal: (di, dj) => dj - di > 0,
  bay: (di, dj) => dj > 0 || di >= 4
};

function cellWater(shore: Shore, point: LatLon): boolean {
  return shore(Math.round(point.lat / G) - I0, Math.round(point.lon / G) - J0);
}

/** A World API whose answers are right; `cold` answers ok:false the first time each cell is asked (a cold cache). */
function world(shore: Shore, cold = false) {
  const asked = new Set<string>();
  return {
    lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[], _options?: unknown) =>
      points.map((point) => {
        const key = `${point.lat},${point.lon}`;
        if (cold && !asked.has(key)) {
          asked.add(key);
          return { ok: false, surfaceKind: null, waterKind: null };
        }
        return cellWater(shore, point)
          ? { ok: true, surfaceKind: "water", waterKind: "lake" }
          : { ok: true, surfaceKind: "land", waterKind: null };
      }))
  };
}

async function simulateJoystick(shore: Shore, bearingDeg: number, clientClip: boolean, cold: boolean, seconds = 4) {
  const gameState = new GameState(config);
  const player = gameState.helloPlayer("p1", "Ash");
  player.position = { lat: I0 * G, lon: J0 * G };
  player.anchor = { ...player.position };
  const waterTravel = new WaterTravelService({
    pool: {} as never,
    inventory: {} as never,
    worldLookup: world(shore, cold) as never,
    gameState,
    logger: { warn: vi.fn() }
  });
  gameState.setWaterSurfaceLookup((point) => waterTravel.cachedSurfaceAt(point));
  let grants = 0;
  let waterTicks = 0;
  let wasAfloat = false;
  let hint: { hint: WaterShoreHint; atMs: number } | null = null;
  const start = { ...player.position };
  const observe = () => {
    const afloat = gameState.isAfloat("p1");
    if (afloat && !wasAfloat) grants += 1;
    wasAfloat = afloat;
  };
  // Joystick cadence (joystickMovementMath.ts): considered every 90 ms, sent on the first frame, while a client
  // slide was applied in the last 400 ms, or when less than 0.35 s of travel remains to the last sent target.
  const frameMs = 90;
  const tickMs = 50;
  let nextFrame = 0;
  let nextTick = tickMs;
  let lastSent: LatLon | null = null;
  let lastBack = false;
  let slidingUntil = Number.NEGATIVE_INFINITY;
  let travelledM = 0;
  // Hold the stick for `seconds`, then pull it back the other way for one second (a stranded player gets out).
  while (Math.min(nextFrame, nextTick) < (seconds + 1) * 1000) {
    const back = nextFrame >= seconds * 1000;
    if (back && travelledM === 0) travelledM = Math.round(distanceMeters(start, player.position));
    if (nextFrame <= nextTick) {
      let target = destinationPoint(player.position, WALK_LEG_M, back ? (bearingDeg + 180) % 360 : bearingDeg);
      let clipped = false;
      // The client slides the stick target along the last wall the server sent (shoreSlide.ts).
      if (clientClip && hint && nextFrame - hint.atMs <= 2_000 && distanceMeters(player.position, hint.hint.at) <= 40) {
        const clip = clipWalkTargetToShore(target, hint.hint);
        target = clip.target;
        clipped = clip.clipped;
      }
      if (clipped) slidingUntil = nextFrame + 400;
      const send = !lastSent || (back && lastBack !== back) || nextFrame < slidingUntil ||
        distanceMeters(player.position, lastSent) < SPEED_MPS * 0.35;
      if (send) {
        lastSent = target;
        lastBack = back;
        const plan = await waterTravel.planMove("p1", target, { walk: true });
        observe();
        if (plan) hint = plan.shore ? { hint: plan.shore, atMs: nextFrame } : null;
        // shoreSlide.recordShoreHint: a wall from the server keeps the stick resending (the server may cut the leg).
        if (clientClip && plan?.shore) slidingUntil = Math.max(slidingUntil, nextFrame + 400);
        if (plan && !plan.needsRaft) {
          try { gameState.setTarget("p1", plan.target, plan.leg); } catch { /* leash */ }
        }
      }
      nextFrame += frameMs;
    } else {
      // The real server yields to the event loop between 50 ms ticks: background lookups land here.
      await new Promise((resolve) => setImmediate(resolve));
      gameState.tick(tickMs / 1000);
      observe();
      if (!gameState.isAfloat("p1") && cellWater(shore, player.position)) waterTicks += 1;
      nextTick += tickMs;
    }
  }
  const endsOnWater = !gameState.isAfloat("p1") && cellWater(shore, player.position) ? 1 : 0;
  return { grants, waterTicks, travelledM, endsOnWater };
}

describe("free raft leak (measurement)", () => {
  it("never grants afloat or stands an unrafted player on water while sliding at dev speed", async () => {
    const runs: Array<{
      shore: string; bearing: number; clip: boolean; cold: boolean;
      grants: number; waterTicks: number; travelledM: number; endsOnWater: number;
    }> = [];
    const cases: Array<[string, number[]]> = [
      ["staircase", [0, 15, 30, 45, 60, 75, 195, 210]],
      ["diagonal", [30, 50, 60, 80, 220, 240]],
      ["bay", [0, 20, 45, 70]]
    ];
    for (const [name, bearings] of cases) {
      for (const bearing of bearings) {
        for (const clip of [false, true]) {
          for (const cold of [false, true]) {
            runs.push({ shore: name, bearing, clip, cold, ...(await simulateJoystick(SHORES[name]!, bearing, clip, cold)) });
          }
        }
      }
    }
    const sum = (list: typeof runs) => list.reduce((total, run) => ({
      grants: total.grants + run.grants,
      waterTicks: total.waterTicks + run.waterTicks,
      endsOnWater: total.endsOnWater + run.endsOnWater
    }), { grants: 0, waterTicks: 0, endsOnWater: 0 });
    const totals = { warm: sum(runs.filter((run) => !run.cold)), cold: sum(runs.filter((run) => run.cold)) };
    console.log(JSON.stringify({ totals, runs }));
    // Held along the shore with client prediction, the slide keeps full speed (no stall at the probe radius).
    for (const run of runs.filter((r) => r.clip && !r.cold && r.shore !== "bay")) {
      expect(run.travelledM, `${run.shore} ${run.bearing}`).toBeGreaterThan(400);
    }
    // A warm cache: never afloat, never on a water cell. A cold World API (fail-open) may let a walk onto water
    // for a tick or two before the guard's background lookup lands, but it never floats the player for free.
    expect(totals.warm).toEqual({ grants: 0, waterTicks: 0, endsOnWater: 0 });
    expect(totals.cold.grants).toBe(0);
    expect(totals.cold.endsOnWater).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Focused reproductions. Local metres around the south-west corner of grid cell (I0 + 1, J0 + 1).

const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const CORNER = { lat: (I0 + 0.5) * G, lon: (J0 + 0.5) * G };
const local = (x: number, y: number): LatLon => ({ lat: CORNER.lat + y / M_PER_DEG_LAT, lon: CORNER.lon + x / M_PER_DEG_LON });
const cellCenter = (di: number, dj: number): LatLon => ({ lat: (I0 + di) * G, lon: (J0 + dj) * G });
/** The lake edge for shores that are water east of cell column J0. */
const LAKE_EDGE_LON = (J0 + 0.5) * G;

function setup(shore: Shore, position: LatLon, options: { guard?: boolean; lookupDown?: () => boolean } = {}) {
  const gameState = new GameState(config);
  const player = gameState.helloPlayer("p1", "Ash");
  player.position = { ...position };
  player.anchor = { ...position };
  const healthy = world(shore);
  const lookup = {
    lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[], lookupOptions?: unknown) => {
      if (options.lookupDown?.()) throw new Error("world api down");
      return healthy.lookupGameplayEnvironments(points, lookupOptions);
    })
  };
  const waterTravel = new WaterTravelService({
    pool: {} as never,
    inventory: {} as never,
    worldLookup: lookup as never,
    gameState,
    logger: { warn: vi.fn() }
  });
  if (options.guard !== false) gameState.setWaterSurfaceLookup((point) => waterTravel.cachedSurfaceAt(point));
  return { gameState, player, waterTravel, lookup };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const legIsDry = (shore: Shore, from: LatLon, to: LatLon): boolean =>
  pathCells(from, to).cells.every((cell) => !cellWater(shore, cell.point));

describe("pathCells", () => {
  it("lists every cell a straight move touches, in order, with entry distances", () => {
    const failures: string[] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let run = 0; run < 200; run += 1) {
      const from = { lat: LAT0 + (random() - 0.5) * 0.002, lon: LON0 + (random() - 0.5) * 0.002 };
      const to = destinationPoint(from, 1 + random() * 120, random() * 360);
      const { cells, complete } = pathCells(from, to);
      expect(complete).toBe(true);
      const byKey = new Map(cells.map((cell) => [cell.key, cell]));
      const totalM = distanceMeters(from, to);
      for (let step = 0; step <= 2_000; step += 1) {
        const d = (totalM * step) / 2_000;
        const snapped = snapToSampleGrid(moveToward(from, to, d));
        const cell = byKey.get(`${snapped.lat},${snapped.lon}`);
        if (!cell || cell.entryM > d + 1e-6) failures.push(`run ${run} step ${step}`);
      }
      for (let index = 1; index < cells.length; index += 1) {
        if (cells[index]!.entryM < cells[index - 1]!.entryM) failures.push(`run ${run} order ${index}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("free raft leak reproductions", () => {
  // One water cell (a staircase corner); everything else is land.
  const pond: Shore = (di, dj) => di === 1 && dj === 1;
  // Cut the pond's south-west corner 1 m deep on a south-east heading: a 2 m chord between two 5 m samples.
  const clipFrom = local(-4.95, 1.414 + 4.95);
  const clipTo = destinationPoint(clipFrom, 20, 135);

  it("finds a water corner that the 5 m walk samples step over and stops the walk before it", async () => {
    expect(samplePathPoints(clipFrom, clipTo, 5).some((sample) => cellWater(pond, sample.point))).toBe(false);
    expect(pathCells(clipFrom, clipTo).cells.some((cell) => cellWater(pond, cell.point))).toBe(true);
    const { gameState, waterTravel } = setup(pond, clipFrom);
    const plan = await waterTravel.planMove("p1", clipTo, { walk: true });
    expect(plan?.needsRaft).toBe(false);
    expect(plan?.blocked).toBe(true);
    expect(legIsDry(pond, clipFrom, plan!.target)).toBe(true);
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("stops a tap and blocks a combat approach across a clipped corner; a tap on the water still asks for a raft", async () => {
    const { gameState, waterTravel } = setup(pond, clipFrom);
    const tap = await waterTravel.planMove("p1", clipTo);
    expect(tap).toMatchObject({ needsRaft: false, blocked: true });
    expect(legIsDry(pond, clipFrom, tap!.target)).toBe(true);
    await waterTravel.prewarmPath("p1", clipTo);
    expect(waterTravel.planCombatApproach("p1", clipTo)).toEqual({ blocked: true });
    const onWater = await waterTravel.planMove("p1", cellCenter(1, 1));
    expect(onWater?.needsRaft).toBe(true);
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("never slides past the probed radius (87.5 m dev-speed walk legs, 24 m probe)", async () => {
    // Lake east of the start cell, and a bay 39 m north that the 24 m probe cannot see from the start.
    const bay: Shore = (di, dj) => dj > 0 || di >= 4;
    const start = cellCenter(0, 0);
    const { gameState, waterTravel } = setup(bay, start);
    const plan = await waterTravel.planMove("p1", destinationPoint(start, WALK_LEG_M, 45), { walk: true });
    expect(plan?.blocked).toBe(true);
    expect(distanceMeters(start, plan!.target)).toBeGreaterThan(10);
    expect(distanceMeters(start, plan!.target)).toBeLessThanOrEqual(24.01);
    expect(legIsDry(bay, start, plan!.target)).toBe(true);
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("walks over cold cells (fail-open) but never floats the player, and lets them wade back to land", async () => {
    // Open water east of cell column J0; the World API is down for the first plan.
    const lake: Shore = (_di, dj) => dj > 0;
    let down = true;
    const start = cellCenter(0, 0);
    const { gameState, player, waterTravel } = setup(lake, start, { lookupDown: () => down });
    const blind = await waterTravel.planMove("p1", destinationPoint(start, 12, 90), { walk: true });
    expect(blind?.blocked).toBeUndefined();
    gameState.setTarget("p1", blind!.target, blind!.leg);
    gameState.tick(1);
    expect(cellWater(lake, player.position)).toBe(true);
    expect(gameState.isAfloat("p1")).toBe(false);
    down = false;
    // Before the fix this MOVE_TO from a water cell floated the player for free.
    const deeper = await waterTravel.planMove("p1", destinationPoint(player.position, 20, 90), { walk: true });
    expect(gameState.isAfloat("p1")).toBe(false);
    expect(deeper?.needsRaft).toBe(false);
    expect(deeper?.blocked).toBe(true);
    expect(snapToSampleGrid(deeper!.target)).toEqual(snapToSampleGrid(player.position));
    // Back toward the land just walked over: the stranded exit wades out, still not afloat.
    const back = await waterTravel.planMove("p1", destinationPoint(player.position, 15, 270), { walk: true });
    expect(back?.leg.wadeM).toBeGreaterThan(0);
    gameState.setTarget("p1", back!.target, back!.leg);
    for (let tick = 0; tick < 10; tick += 1) gameState.tick(0.05);
    expect(cellWater(lake, player.position)).toBe(false);
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("only an arrival spot on water is a free raft", async () => {
    const lake: Shore = (_di, dj) => dj > 0;
    const { gameState, waterTravel } = setup(lake, cellCenter(0, 0));
    // Moved onto water by anything but an arrival: no raft.
    gameState.getPlayer("p1")!.position = cellCenter(0, 3);
    await waterTravel.planMove("p1", cellCenter(0, 6), { walk: true });
    expect(gameState.isAfloat("p1")).toBe(false);
    // Relocated onto water (a buoy, a relocation): afloat for free, even when the arrival check never ran.
    gameState.teleportPlayer("p1", cellCenter(0, 3));
    expect(gameState.isAfloat("p1")).toBe(false);
    await waterTravel.planMove("p1", cellCenter(0, 6), { walk: true });
    expect(gameState.isAfloat("p1")).toBe(true);
  });

  it("a reconnect or relog at a shore stop is still on land", async () => {
    const lake: Shore = (_di, dj) => dj > 0;
    const start = cellCenter(0, -1);
    const { gameState, player, waterTravel } = setup(lake, start);
    let position = start;
    for (let push = 0; push < 4; push += 1) {
      const plan = await waterTravel.planMove("p1", destinationPoint(position, WALK_LEG_M, 90), { walk: true });
      gameState.setTarget("p1", plan!.target, plan!.leg);
      gameState.tick(1);
      position = { ...player.position };
    }
    expect(cellWater(lake, position)).toBe(false);
    expect((LAKE_EDGE_LON - position.lon) * M_PER_DEG_LON).toBeLessThan(1);
    gameState.markOffline("p1");
    gameState.connectPlayer({ ...player, online: false });
    await waterTravel.refreshArrival("p1");
    expect(gameState.isAfloat("p1")).toBe(false);
    await waterTravel.planMove("p1", destinationPoint(position, WALK_LEG_M, 90), { walk: true });
    expect(gameState.isAfloat("p1")).toBe(false);
  });
});

describe("shore guard (tick safety net)", () => {
  const lake: Shore = (_di, dj) => dj > 0;
  const start = cellCenter(0, 0);

  it("ends an unrafted step at the last land position before a cached water cell, without afloat", async () => {
    const { gameState, player, waterTravel } = setup(lake, start);
    await waterTravel.prewarmPath("p1", destinationPoint(start, 60, 90));
    // A leg the planner did not cut (an old client, a stale leg): all land on paper.
    gameState.setTarget("p1", destinationPoint(start, 60, 90), {
      origin: { ...start }, relocationRevision: 0, segments: [{ startM: 0, multiplier: 1, surface: "land" }]
    });
    gameState.tick(1);
    expect(cellWater(lake, player.position)).toBe(false);
    expect((LAKE_EDGE_LON - player.position.lon) * M_PER_DEG_LON).toBeGreaterThan(0.2);
    expect((LAKE_EDGE_LON - player.position.lon) * M_PER_DEG_LON).toBeLessThan(0.5);
    expect(player.target).toBeNull();
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("never sets afloat from a leg that claims open water", () => {
    const { gameState, player } = setup(lake, start, { guard: false });
    gameState.setTarget("p1", destinationPoint(start, 60, 90), {
      origin: { ...start }, relocationRevision: 0,
      segments: [{ startM: 0, multiplier: 1, surface: "land" }, { startM: 5, multiplier: 0.5, surface: "open_water" }]
    });
    for (let tick = 0; tick < 20; tick += 1) gameState.tick(0.05);
    expect(cellWater(lake, player.position)).toBe(true);
    expect(gameState.isAfloat("p1")).toBe(false);
  });

  it("fails open on unknown cells and leaves afloat players alone", async () => {
    const cold = setup(lake, start);
    cold.lookup.lookupGameplayEnvironments.mockImplementation(async () => { throw new Error("down"); });
    cold.gameState.setTarget("p1", destinationPoint(start, 30, 90));
    cold.gameState.tick(1);
    expect(distanceMeters(start, cold.player.position)).toBeCloseTo(30, 0);
    expect(cold.gameState.isAfloat("p1")).toBe(false);

    const afloat = setup(lake, start);
    await afloat.waterTravel.prewarmPath("p1", destinationPoint(start, 30, 90));
    afloat.gameState.setAfloat("p1", true);
    afloat.gameState.setTarget("p1", destinationPoint(start, 30, 90));
    afloat.gameState.tick(1);
    expect(distanceMeters(start, afloat.player.position)).toBeCloseTo(30, 0);
  });

  it("lands an unrafted dash on the shore instead of in the water", async () => {
    const { gameState, player, waterTravel } = setup(lake, start);
    const clock = { now: 1_000_000 };
    gameState.setDashClock(() => clock.now);
    await waterTravel.prewarmPath("p1", destinationPoint(start, 150, 90));
    gameState.startDash("p1", "d1", gameState.planDash("p1", 1, 0));
    for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
      clock.now += 50;
      gameState.tick(0.05);
      await settle();
    }
    expect(gameState.isDashing("p1")).toBe(false);
    expect(cellWater(lake, player.position)).toBe(false);
    expect(player.position.lon).toBeLessThan(LAKE_EDGE_LON);
    expect(gameState.isAfloat("p1")).toBe(false);
  });
});
