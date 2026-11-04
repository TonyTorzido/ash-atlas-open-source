import {
  AFLOAT_SPEED_MULTIPLIER,
  RAFT_LAUNCH_COST,
  destinationPoint,
  distanceMeters,
  moveToward,
  type LatLon,
  type MoveSpeedSegment,
  type PlayerInventorySnapshot,
  type WaterShoreHint
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import type { InventoryService } from "./inventory.js";
import type { CombatApproachPlanResult, GameState, WaterLeg, WaterLegSurface } from "./state.js";
import {
  SAMPLE_GRID_DEGREES,
  SHORE_STOP_M,
  cellKey,
  pathCells,
  snapToSampleGrid,
  type PathCell
} from "./waterCells.js";

export { snapToSampleGrid } from "./waterCells.js";

/**
 * Water travel, phase A (docs/design/WATER_GAME_PLAN.md).
 *
 * At MOVE_TO time the straight path is sampled once through the World API
 * batch endpoint (cached on a ~11 m grid). The result is a leg of speed and
 * surface breakpoints that the server tick and the client prediction share.
 * World API failures fail open: unknown surfaces move at land speed, never
 * charge and never change afloat.
 *
 * Free-raft invariant: an unrafted player only becomes afloat through the
 * paid launchRaft, a water site (buoy, whirlpool), or standing on open water
 * at an arrival spot (login, relocation, respawn). Walks, taps, dashes and
 * combat approaches never grant it: every grid cell of a leg is checked
 * exactly (pathCells), and the tick refuses known water cells as well.
 */

const PATH_SAMPLE_STEP_M = 15;
const PATH_SAMPLE_MAX_POINTS = 200;
const WALK_SAMPLE_STEP_M = 5;
/** Exact cell traversal budget per leg (~1.5 km); longer legs fall back to the samples past it. */
const PATH_CELLS_MAX = 300;
const SURFACE_CACHE_MAX_ENTRIES = 50_000;
const SURFACE_CACHE_TTL_MS = 30 * 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;
const MIN_LEG_DISTANCE_M = 0.5;
/** Path scan step used to find the cell edge inside one sample gap (fallback past the exact cell budget). */
const SHORE_SCAN_STEP_M = 0.25;
/** Shore probe: rays every 10 degrees, cell-exact, at least this long. */
const SHORE_RAY_STEP_DEG = 10;
/** Cell lookups that failed or came back unknown in the background are not retried before this. */
const PREFETCH_RETRY_MS = 2_000;
const SHORE_PROBE_MIN_RADIUS_M = 8;
const SHORE_PROBE_MAX_RADIUS_M = 24;
/** After a shore contact the probe keeps running for walk moves, so the client always has a wall. */
const SHORE_CONTACT_MS = 2_500;
/** A slide that keeps less than this share of the requested leg is a stop. */
const SHORE_MIN_SLIDE_SCORE = 0.12;
/** A stranded player (unrafted on water after a fail-open walk) may wade back to land through this much water. */
const STRANDED_EXIT_M = 40;

export type PathSample = Readonly<{ distanceM: number; point: LatLon }>;

export type WaterLegPlan = Readonly<{
  segments: WaterLeg["segments"];
  needsRaft: boolean;
  /** Set when the path would need a second raft after coming ashore: stop on that shore. */
  truncateAtM: number | null;
  originSurface: WaterLegSurface;
  afloatAtStart: boolean;
  wetAtStart: boolean;
}>;

export function classifyWaterSurface(
  result: Pick<WorldGameplayEnvironmentResult, "ok" | "surfaceKind" | "waterKind"> | null | undefined
): WaterLegSurface {
  if (!result || result.ok === false) return "unknown";
  if (
    result.waterKind === "river" || result.waterKind === "ocean" || result.waterKind === "lake" ||
    result.waterKind === "inland_water" || result.surfaceKind === "water"
  ) return "open_water";
  if (result.surfaceKind === "land") return "land";
  return "unknown";
}

export function samplePathPoints(
  origin: LatLon,
  target: LatLon,
  baseStepM: number = PATH_SAMPLE_STEP_M
): PathSample[] {
  const totalM = distanceMeters(origin, target);
  const stepM = Math.max(baseStepM, totalM / (PATH_SAMPLE_MAX_POINTS - 1));
  const count = Math.max(1, Math.ceil(totalM / stepM));
  const samples: PathSample[] = [];
  for (let index = 0; index <= count; index += 1) {
    const distanceM = Math.min(totalM, index * stepM);
    const point = index === count ? target : moveToward(origin, target, distanceM);
    samples.push({ distanceM, point: snapToSampleGrid(point) });
  }
  return samples;
}

function multiplierForSurface(surface: WaterLegSurface, afloatMultiplier: number): number {
  if (surface === "open_water") return afloatMultiplier;
  return 1;
}

/**
 * Turns sampled surfaces into breakpoints (placed halfway between differing
 * samples) and walks them with the afloat rules:
 * - standing on open water is afloat for free (real location, buoy, arrival);
 * - the first open water reached while not afloat needs one raft;
 * - reaching land after being on open water loses the raft;
 * - a second water entry after coming ashore stops the move on that shore.
 */
export function buildWaterLegPlan(input: Readonly<{
  samples: readonly Readonly<{ distanceM: number; surface: WaterLegSurface }>[];
  afloat: boolean;
  wet: boolean;
  /** Water speed; the Tidewater Draught raises it to full land speed. */
  afloatMultiplier?: number;
}>): WaterLegPlan {
  const samples = input.samples;
  const originSurface = samples[0]?.surface ?? "unknown";
  const raw: Array<{ startM: number; surface: WaterLegSurface }> = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const previous = samples[index - 1];
    if (!previous) {
      raw.push({ startM: 0, surface: sample.surface });
    } else if (sample.surface !== previous.surface) {
      raw.push({ startM: (previous.distanceM + sample.distanceM) / 2, surface: sample.surface });
    }
  }

  let afloat = input.afloat;
  let wet = input.wet;
  if (originSurface === "open_water") {
    afloat = true;
    wet = true;
  } else if (originSurface === "land" && afloat && wet) {
    afloat = false;
    wet = false;
  }
  const afloatAtStart = afloat;
  const wetAtStart = wet;
  let needsRaft = false;
  let cameAshore = false;
  let truncateAtM: number | null = null;
  const segments: Array<{ startM: number; multiplier: number; surface: WaterLegSurface }> = [];
  for (const segment of raw) {
    if (segment.surface === "open_water") {
      if (!afloat) {
        if (cameAshore) {
          truncateAtM = segment.startM;
          break;
        }
        needsRaft = true;
        afloat = true;
      }
      wet = true;
    } else if (segment.surface === "land" && afloat && wet) {
      afloat = false;
      wet = false;
      cameAshore = true;
    }
    segments.push({
      startM: segment.startM,
      multiplier: multiplierForSurface(segment.surface, input.afloatMultiplier ?? AFLOAT_SPEED_MULTIPLIER),
      surface: segment.surface
    });
  }
  return { segments, needsRaft, truncateAtM, originSurface, afloatAtStart, wetAtStart };
}

/** Wire form for MOVE_ACCEPTED; omitted entirely for an all-land leg. */
export function waterLegSpeedProfile(
  leg: WaterLeg
): { speedOrigin: LatLon; speedSegments: MoveSpeedSegment[] } | Record<string, never> {
  const speedSegments: MoveSpeedSegment[] = [];
  for (const segment of leg.segments) {
    if (speedSegments.at(-1)?.multiplier === segment.multiplier) continue;
    speedSegments.push({ startM: segment.startM, multiplier: segment.multiplier });
  }
  if (speedSegments.every((segment) => segment.multiplier === 1)) return {};
  return { speedOrigin: { ...leg.origin }, speedSegments };
}

export type PlannedWaterMove = Readonly<{
  target: LatLon;
  leg: WaterLeg;
  needsRaft: boolean;
  /** An unrafted walk or land-target tap was cut at the shore instead of asking for a raft. */
  blocked?: boolean;
  shore?: WaterShoreHint;
}>;

/**
 * How a MOVE_TO that would take an unrafted player onto open water is treated:
 * - "raft": needs a raft (combat approach is blocked; a tap on open water prompts);
 * - "tap": a tap whose target is land stops at the shore, a tap on open water prompts;
 * - "walk": joystick / keys / pad never prompt; the leg stops at the shore and slides along it.
 */
export type WaterEntryMode = "raft" | "tap" | "walk";

export type CombatApproachPlan = CombatApproachPlanResult;

export type RaftLaunchResult =
  | Readonly<{ status: "launched"; inventory: PlayerInventorySnapshot }>
  | Readonly<{ status: "replayed" }>
  | Readonly<{ status: "insufficient" }>;

type SurfaceCacheEntry = { surface: WaterLegSurface; expiresAt: number };

export class WaterTravelService {
  private readonly surfaceCache = new Map<string, SurfaceCacheEntry>();
  private readonly shoreContactUntil = new Map<string, number>();
  private readonly prefetchQueue = new Map<string, LatLon>();
  private readonly prefetchInFlight = new Set<string>();
  private readonly prefetchRetryAt = new Map<string, number>();
  private prefetchScheduled = false;

  constructor(private readonly deps: Readonly<{
    pool: pg.Pool;
    inventory: Pick<InventoryService, "debitItemsForOperationInTransaction">;
    worldLookup?: Pick<WorldLookupClient, "lookupGameplayEnvironments"> | undefined;
    gameState: GameState;
    logger: Pick<AppLogger, "warn">;
    now?: () => number;
    /** Tidewater Draught: full land speed on water. */
    hasFullWaterSpeed?: (playerId: string) => boolean;
  }>) {}

  /** Classify a straight move and apply free-afloat facts about the player's current spot. */
  async planMove(
    playerId: string,
    target: LatLon,
    options: Readonly<{ walk?: boolean }> = {}
  ): Promise<PlannedWaterMove | null> {
    const { gameState } = this.deps;
    const player = gameState.getPlayer(playerId);
    if (!player || !gameState.isWorldPresent(playerId) || !this.deps.worldLookup) return null;
    const origin = { ...player.position };
    const relocationRevision = player.relocationRevision ?? 0;
    if (distanceMeters(origin, target) < MIN_LEG_DISTANCE_M) return null;
    // Walks are short and hug shores: sample finer than the 11 m cell for the speed breakpoints.
    const samples = samplePathPoints(origin, target, options.walk ? WALK_SAMPLE_STEP_M : PATH_SAMPLE_STEP_M);
    // Every cell the leg touches, exactly: a corner clipped between two samples is still water.
    const path = pathCells(origin, target, PATH_CELLS_MAX);
    const all = await this.surfacesFor([
      ...samples.map((sample) => sample.point),
      ...path.cells.map((cell) => cell.point)
    ]);
    // Cells that came back unknown (a cold or slow World API) are walked as land, so ask again in the
    // background right away: the tick's shore guard then knows them before the player gets there.
    this.retryUnknownCells(path.cells, all.slice(samples.length));
    const current = gameState.getPlayer(playerId);
    if (!current || (current.relocationRevision ?? 0) !== relocationRevision) return null;
    const mode: WaterEntryMode = options.walk ? "walk" : "tap";
    const planned = this.planFromSurfaces(
      playerId, origin, target, relocationRevision, samples, all.slice(0, samples.length),
      { cells: path.cells, surfaces: all.slice(samples.length) }, mode
    );
    if (mode !== "walk" || gameState.isAfloat(playerId) || planned.needsRaft) return planned;
    const now = this.deps.now?.() ?? Date.now();
    const contactActive = (this.shoreContactUntil.get(playerId) ?? 0) > now;
    if (!planned.blocked && !contactActive) return planned;
    const probe = await this.probeShore(origin, target, planned.blocked === true);
    const afterProbe = gameState.getPlayer(playerId);
    if (!afterProbe || (afterProbe.relocationRevision ?? 0) !== relocationRevision) return null;
    if (!probe) {
      this.shoreContactUntil.delete(playerId);
      return planned;
    }
    if (planned.blocked) this.shoreContactUntil.set(playerId, now + SHORE_CONTACT_MS);
    if (!planned.blocked) return { ...planned, shore: probe.hint };
    // The straight leg ran into water: replace it with the best slide along the shore (or a stop).
    return {
      target: probe.slideTarget ?? origin,
      leg: { origin, relocationRevision, segments: [{ startM: 0, multiplier: 1, surface: "land" }] },
      needsRaft: false,
      blocked: true,
      shore: probe.hint
    };
  }

  /**
   * Combat approach and dash (synchronous, from the tick): plans from cached
   * surfaces only. Missing cells are fetched in the background and count as
   * unknown (land) meanwhile; START_ATTACK prewarms the path so the cache is
   * normally warm. A path that touches water is blocked rather than launched.
   */
  planCombatApproach(playerId: string, target: LatLon): CombatApproachPlan {
    const { gameState } = this.deps;
    const player = gameState.getPlayer(playerId);
    if (!player || !gameState.isWorldPresent(playerId) || !this.deps.worldLookup) {
      return { blocked: false, target, leg: null };
    }
    const origin = { ...player.position };
    if (distanceMeters(origin, target) < MIN_LEG_DISTANCE_M) return { blocked: false, target, leg: null };
    const samples = samplePathPoints(origin, target);
    const path = pathCells(origin, target, PATH_CELLS_MAX);
    const all = this.cachedSurfaces([
      ...samples.map((sample) => sample.point),
      ...path.cells.map((cell) => cell.point)
    ]);
    const plan = this.planFromSurfaces(
      playerId, origin, target, player.relocationRevision ?? 0, samples, all.slice(0, samples.length),
      { cells: path.cells, surfaces: all.slice(samples.length) }, "raft"
    );
    return plan.needsRaft
      ? { blocked: true }
      : { blocked: false, target: plan.target, leg: plan.leg };
  }

  /** Warm the surface cache for a path the combat tick may plan synchronously. */
  async prewarmPath(playerId: string, target: LatLon): Promise<void> {
    const player = this.deps.gameState.getPlayer(playerId);
    if (!player || !this.deps.worldLookup) return;
    await this.surfacesFor([
      ...samplePathPoints(player.position, target).map((sample) => sample.point),
      ...pathCells(player.position, target, PATH_CELLS_MAX).cells.map((cell) => cell.point)
    ]);
  }

  private planFromSurfaces(
    playerId: string,
    origin: LatLon,
    target: LatLon,
    relocationRevision: number,
    samples: readonly PathSample[],
    sampledSurfaces: readonly WaterLegSurface[],
    exact: Readonly<{ cells: readonly PathCell[]; surfaces: readonly WaterLegSurface[] }>,
    mode: WaterEntryMode
  ): PlannedWaterMove {
    const { gameState } = this.deps;
    const afloat = gameState.isAfloat(playerId);
    const originKey = cellKey(samples[0]!.point);
    // Standing on open water is a free raft only at an arrival spot (login, relocation, respawn). An unrafted
    // player on a water cell any other way (a fail-open walk over unknown cells) is stranded: nothing is
    // granted, their own cell counts as land, and a leg whose leading water reaches known land within
    // STRANDED_EXIT_M may wade it (wadeM) so they can get back out.
    const stranded = !afloat && sampledSurfaces[0] === "open_water" && !gameState.isAtArrivalSpot(playerId);
    let wadeM = 0;
    if (stranded) {
      // The way out must end on known land: wading never runs on through unknown cells.
      const exitIndex = exact.cells.findIndex((cell, index) => cell.key !== originKey && exact.surfaces[index] !== "open_water");
      const exit = exact.cells[exitIndex];
      if (exit && exact.surfaces[exitIndex] === "land" && exit.entryM <= STRANDED_EXIT_M) wadeM = exit.entryM;
    }
    const surfaces: readonly WaterLegSurface[] = stranded
      ? sampledSurfaces.map((surface, index) =>
        cellKey(samples[index]!.point) === originKey || samples[index]!.distanceM < wadeM ? "land" : surface)
      : sampledSurfaces;
    const plan = buildWaterLegPlan({
      samples: samples.map((sample, index) => ({
        distanceM: sample.distanceM,
        surface: surfaces[index] ?? "unknown"
      })),
      afloat,
      wet: gameState.isWet(playerId),
      afloatMultiplier: this.deps.hasFullWaterSpeed?.(playerId) ? 1 : AFLOAT_SPEED_MULTIPLIER
    });
    gameState.setAfloat(playerId, plan.afloatAtStart, plan.wetAtStart);
    // The exact first water cell after the origin's own cell (cells[0]); only an unrafted leg cares.
    const exactWaterM = plan.afloatAtStart
      ? null
      : exact.cells.find((cell, index) =>
        index > 0 && cell.key !== originKey && cell.entryM >= wadeM && exact.surfaces[index] === "open_water"
      )?.entryM ?? null;
    const needsRaft = plan.needsRaft || exactWaterM !== null;
    const targetIsWater = surfaces[surfaces.length - 1] === "open_water";
    if (
      needsRaft && !plan.afloatAtStart &&
      (mode === "walk" || (mode === "tap" && !targetIsWater))
    ) {
      // Unrafted and heading into water by walking (or tapping land across water): stop at the shore.
      const stopM = exactWaterM !== null
        ? Math.max(0, exactWaterM - SHORE_STOP_M)
        : this.shoreStopDistance(origin, target, samples, surfaces.findIndex((surface) => surface === "open_water"));
      const landSegments = plan.segments.filter(
        (segment) => segment.surface !== "open_water" && segment.startM < Math.max(stopM, 0.001)
      );
      return {
        target: stopM < SHORE_SCAN_STEP_M ? origin : moveToward(origin, target, stopM),
        needsRaft: false,
        blocked: true,
        leg: {
          origin,
          relocationRevision,
          segments: landSegments.length > 0
            ? landSegments
            : [{ startM: 0, multiplier: 1, surface: "land" }],
          ...(wadeM > 0 ? { wadeM } : {})
        }
      };
    }
    const plannedTarget = plan.truncateAtM === null
      ? target
      : moveToward(origin, target, plan.truncateAtM);
    return {
      target: plannedTarget,
      needsRaft,
      leg: { origin, relocationRevision, segments: plan.segments, ...(wadeM > 0 ? { wadeM } : {}) }
    };
  }

  /**
   * Fallback stop distance when the first water lies past the exact cell budget: the sample gap before the
   * first water sample is scanned in 0.25 m steps against the cell grid.
   */
  private shoreStopDistance(
    origin: LatLon,
    target: LatLon,
    samples: readonly PathSample[],
    firstWaterIndex: number
  ): number {
    const water = samples[firstWaterIndex];
    const before = samples[firstWaterIndex - 1];
    if (!water || !before) return 0;
    for (let d = before.distanceM; d <= water.distanceM; d += SHORE_SCAN_STEP_M) {
      const cell = snapToSampleGrid(moveToward(origin, target, d));
      if (cell.lat === water.point.lat && cell.lon === water.point.lon) {
        return Math.max(0, d - SHORE_STOP_M);
      }
    }
    return Math.max(0, (before.distanceM + water.distanceM) / 2 - SHORE_STOP_M);
  }

  /**
   * Looks around the player for open water (36 cell-exact rays, lookups cached) and returns the shore wall plus
   * the best slide for a walk toward `target`: the ray within 90 degrees of the input that keeps the most
   * progress along the input direction, or null (stop) when the input is nearly straight into the water.
   * A slide never reaches past the probed radius, so every cell it crosses was checked. Returns null when no
   * water is within reach. Unknown cells count as land (fail-open); the origin's own cell is ignored.
   */
  private async probeShore(
    origin: LatLon,
    target: LatLon,
    wantSlide: boolean
  ): Promise<{ hint: WaterShoreHint; slideTarget: LatLon | null } | null> {
    const legM = distanceMeters(origin, target);
    const radiusM = Math.min(SHORE_PROBE_MAX_RADIUS_M, Math.max(SHORE_PROBE_MIN_RADIUS_M, legM));
    const rays: Array<{ bearing: number; end: LatLon; cells: PathCell[] }> = [];
    const unique = new Map<string, LatLon>();
    for (let bearing = 0; bearing < 360; bearing += SHORE_RAY_STEP_DEG) {
      const end = destinationPoint(origin, radiusM, bearing);
      const { cells } = pathCells(origin, end);
      for (const cell of cells) unique.set(cell.key, cell.point);
      rays.push({ bearing, end, cells });
    }
    const originKey = cellKey(snapToSampleGrid(origin));
    const keys = [...unique.keys()];
    const surfaces = await this.surfacesFor(keys.map((key) => unique.get(key)!));
    const waterKeys = new Set(keys.filter((key, index) => surfaces[index] === "open_water" && key !== originKey));
    if (waterKeys.size === 0) return null;
    const clear = rays.map((ray) => {
      const hit = ray.cells.find((cell) => waterKeys.has(cell.key));
      return hit ? Math.max(0, hit.entryM - SHORE_STOP_M) : Number.POSITIVE_INFINITY;
    });
    let nx = 0;
    let ny = 0;
    let minClear = Number.POSITIVE_INFINITY;
    for (const [index, ray] of rays.entries()) {
      const room = clear[index]!;
      if (!Number.isFinite(room)) continue;
      const weight = (radiusM - room) / radiusM + 0.05;
      nx += Math.sin((ray.bearing * Math.PI) / 180) * weight;
      ny += Math.cos((ray.bearing * Math.PI) / 180) * weight;
      minClear = Math.min(minClear, room);
    }
    if (!Number.isFinite(minClear)) return null;
    const normalDeg = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
    const nearest = Math.round(normalDeg / SHORE_RAY_STEP_DEG) % rays.length;
    const nearestClear = clear[nearest]!;
    const hint: WaterShoreHint = {
      at: { ...origin },
      normalDeg: Math.round(normalDeg * 10) / 10,
      gapM: Math.round((Number.isFinite(nearestClear) ? nearestClear : minClear) * 100) / 100
    };
    if (!wantSlide) return { hint, slideTarget: null };
    // Only the probed radius is known: a longer walk leg slides at most that far (the next resend continues it).
    const reachM = Math.min(legM, radiusM);
    const cosLat = Math.cos((origin.lat * Math.PI) / 180);
    const wanted = ((Math.atan2((target.lon - origin.lon) * cosLat, target.lat - origin.lat) * 180) / Math.PI + 360) % 360;
    let best: { score: number; end: LatLon; lengthM: number } | null = null;
    for (const [index, ray] of rays.entries()) {
      const delta = Math.abs((((ray.bearing - wanted) % 360) + 540) % 360 - 180);
      if (delta > 90) continue;
      const lengthM = Math.min(reachM, clear[index]!);
      const score = lengthM * Math.cos((delta * Math.PI) / 180);
      if (!best || score > best.score) best = { score, end: ray.end, lengthM };
    }
    // The slide runs along the ray's own straight lat/lon line, the same line its cells were traced on.
    const slideTarget = best && best.score >= SHORE_MIN_SLIDE_SCORE * reachM
      ? moveToward(origin, best.end, best.lengthM)
      : null;
    return { hint, slideTarget };
  }

  /**
   * Pays one raft for this request id and sets afloat in the same transaction.
   * A replayed request id never charges again and never grants a second raft.
   */
  async launchRaft(playerId: string, requestId: string): Promise<RaftLaunchResult> {
    const client = await this.deps.pool.connect();
    let result: RaftLaunchResult;
    try {
      await client.query("BEGIN");
      try {
        const debit = await this.deps.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: raftLaunchOperationKey(playerId, requestId),
          playerId,
          source: "raft_launch",
          sourceEntityType: "player",
          sourceEntityId: playerId,
          metadata: { requestId },
          debits: RAFT_LAUNCH_COST.map(({ itemId, quantity }) => ({ itemId, variant: null, quantity }))
        });
        if (debit.applied) {
          await client.query("UPDATE players SET afloat = true WHERE id = $1", [playerId]);
          result = { status: "launched", inventory: debit.inventory };
        } else {
          result = { status: "replayed" };
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Inventory does not contain enough items") {
          await client.query("ROLLBACK");
          return { status: "insufficient" };
        }
        throw error;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (result.status === "launched") this.deps.gameState.setAfloat(playerId, true);
    return result;
  }

  /** Login, relocation and respawn: standing on open water is afloat for free. */
  async refreshArrival(playerId: string): Promise<void> {
    const { gameState } = this.deps;
    const player = gameState.getPlayer(playerId);
    if (!player || !this.deps.worldLookup) return;
    const relocationRevision = player.relocationRevision ?? 0;
    const position = { ...player.position };
    const [surface] = await this.surfacesFor([snapToSampleGrid(position)]);
    const current = gameState.getPlayer(playerId);
    if (
      !current || !gameState.isWorldPresent(playerId) ||
      (current.relocationRevision ?? 0) !== relocationRevision ||
      current.target !== null || distanceMeters(current.position, position) > 1
    ) return;
    if (surface === "open_water") gameState.setAfloat(playerId, true, true);
  }

  /**
   * Mob habitat lookup (synchronous, cache only, never fetches): the nearest
   * cached sample within one grid cell of the point, or null when none is
   * known. Prefilled by player paths and prewarmMobLine.
   */
  cachedSurfaceNear(point: LatLon): "land" | "water" | null {
    const now = this.deps.now?.() ?? Date.now();
    const center = snapToSampleGrid(point);
    let best: { surface: WaterLegSurface; distance: number } | null = null;
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const lat = Number((center.lat + dLat * SAMPLE_GRID_DEGREES).toFixed(4));
        const lon = Number((center.lon + dLon * SAMPLE_GRID_DEGREES).toFixed(4));
        const cached = this.surfaceCache.get(`${lat},${lon}`);
        if (!cached || cached.expiresAt <= now) continue;
        const distance = Math.abs(lat - point.lat) + Math.abs(lon - point.lon);
        if (best === null || distance < best.distance) best = { surface: cached.surface, distance };
      }
    }
    if (best === null || best.surface === "unknown") return null;
    return best.surface === "open_water" ? "water" : "land";
  }

  /**
   * The tick's shore guard (synchronous, cache only): the cached surface of the grid cell containing `point`,
   * or "unknown". An unknown cell is fetched in the background (deduplicated, retried at most every 2 s), so
   * the guard fails open for movement while the World API is cold or slow and tightens one lookup later.
   */
  cachedSurfaceAt(point: LatLon): WaterLegSurface {
    const now = this.deps.now?.() ?? Date.now();
    const cell = snapToSampleGrid(point);
    const key = cellKey(cell);
    const cached = this.surfaceCache.get(key);
    if (cached && cached.expiresAt > now) return cached.surface;
    this.prefetchCell(key, cell, now);
    return "unknown";
  }

  private retryUnknownCells(cells: readonly PathCell[], surfaces: readonly WaterLegSurface[]): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const [index, cell] of cells.entries()) {
      if (surfaces[index] === "unknown") this.prefetchCell(cell.key, cell.point, now);
    }
  }

  private prefetchCell(key: string, cell: LatLon, now: number): void {
    if (!this.deps.worldLookup || this.prefetchInFlight.has(key) || this.prefetchQueue.has(key)) return;
    if ((this.prefetchRetryAt.get(key) ?? 0) > now) return;
    this.prefetchQueue.set(key, cell);
    this.schedulePrefetchFlush();
  }

  private schedulePrefetchFlush(): void {
    if (this.prefetchScheduled) return;
    this.prefetchScheduled = true;
    queueMicrotask(() => {
      this.prefetchScheduled = false;
      const batch = [...this.prefetchQueue.entries()].slice(0, PATH_CELLS_MAX);
      if (batch.length === 0) return;
      for (const [key] of batch) {
        this.prefetchQueue.delete(key);
        this.prefetchInFlight.add(key);
      }
      if (this.prefetchRetryAt.size > SURFACE_CACHE_MAX_ENTRIES) this.prefetchRetryAt.clear();
      void this.surfacesFor(batch.map(([, point]) => point)).then((surfaces) => {
        const retryAt = (this.deps.now?.() ?? Date.now()) + PREFETCH_RETRY_MS;
        for (const [index, [key]] of batch.entries()) {
          if (surfaces[index] === "unknown") this.prefetchRetryAt.set(key, retryAt);
          else this.prefetchRetryAt.delete(key);
        }
      }).finally(() => {
        for (const [key] of batch) this.prefetchInFlight.delete(key);
        if (this.prefetchQueue.size > 0) this.schedulePrefetchFlush();
      });
    });
  }

  /** Warms the surface cache along a mob's chase line in the background. */
  prewarmMobLine(from: LatLon, to: LatLon): void {
    if (!this.deps.worldLookup) return;
    void this.surfacesFor(samplePathPoints(from, to).map((sample) => sample.point));
  }

  private cachedSurfaces(points: readonly LatLon[]): WaterLegSurface[] {
    const now = this.deps.now?.() ?? Date.now();
    let missing = false;
    const surfaces = points.map((point) => {
      const cached = this.surfaceCache.get(`${point.lat},${point.lon}`);
      if (cached && cached.expiresAt > now) return cached.surface;
      missing = true;
      return "unknown" as const;
    });
    if (missing) void this.surfacesFor(points);
    return surfaces;
  }

  private async surfacesFor(points: readonly LatLon[]): Promise<WaterLegSurface[]> {
    const now = this.deps.now?.() ?? Date.now();
    const surfaces = new Array<WaterLegSurface>(points.length).fill("unknown");
    const missing = new Map<string, { point: LatLon; indexes: number[] }>();
    for (const [index, point] of points.entries()) {
      const key = `${point.lat},${point.lon}`;
      const cached = this.surfaceCache.get(key);
      if (cached && cached.expiresAt > now) {
        surfaces[index] = cached.surface;
        continue;
      }
      const entry = missing.get(key) ?? { point, indexes: [] };
      entry.indexes.push(index);
      missing.set(key, entry);
    }
    if (missing.size === 0 || !this.deps.worldLookup) return surfaces;
    const pending = [...missing.entries()];
    try {
      const results = await this.deps.worldLookup.lookupGameplayEnvironments(
        pending.map(([, entry]) => entry.point),
        {
          caller: "travel",
          priority: 0,
          cacheClass: "probationary",
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
        }
      );
      for (const [index, [key, entry]] of pending.entries()) {
        const surface = classifyWaterSurface(results[index]);
        for (const pointIndex of entry.indexes) surfaces[pointIndex] = surface;
        if (surface !== "unknown") this.rememberSurface(key, surface, now);
      }
    } catch (error) {
      this.deps.logger.warn({ err: error, points: pending.length }, "water path lookup failed; treating path as land");
    }
    return surfaces;
  }

  private rememberSurface(key: string, surface: WaterLegSurface, now: number): void {
    this.surfaceCache.delete(key);
    while (this.surfaceCache.size >= SURFACE_CACHE_MAX_ENTRIES) {
      const oldest = this.surfaceCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.surfaceCache.delete(oldest);
    }
    this.surfaceCache.set(key, { surface, expiresAt: now + SURFACE_CACHE_TTL_MS });
  }
}

export function raftLaunchOperationKey(playerId: string, requestId: string): string {
  return `raft-launch:${playerId}:${requestId}`;
}
