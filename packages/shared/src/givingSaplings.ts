/**
 * Giving Tree saplings : plant a Giving Berry or a pulled sapling on open
 * land, tend it, and it matures into a permanent Giving Tree. Pure lifecycle rules shared by the
 * server (authoritative) and the client (status text). docs/giving-trees.md.
 */

import { WORLD_ZONE_BIOME_NAMES, type WorldZoneBiome } from "./worldZones.js";

export const GIVING_SAPLING_ITEM_ID = "giving_tree_sapling";
export const GIVING_SAPLING_DISPLAY_NAME = "Giving Tree Sapling";
export const GIVING_SAPLING_GROWN_DISPLAY_NAME = "Giving Tree";

export const SAPLING_DAY_MS = 86_400_000;
/** A sapling can be tended this long after it was planted or last tended ("starting the next day"). */
export const SAPLING_TEND_INTERVAL_MS = SAPLING_DAY_MS;
/** Untended for this long, a sapling dies. The window to tend is therefore 1 to 2 days after the last care. */
export const SAPLING_DEATH_AFTER_MS = 2 * SAPLING_DAY_MS;
/** Alive for this long after planting, a sapling matures into a permanent Giving Tree. */
export const SAPLING_MATURE_AFTER_MS = 6 * SAPLING_DAY_MS;
/** Grove Lore rank 2: the owner's tending makes the sapling mature this long after planting instead. */
export const SAPLING_MATURE_AFTER_FAST_MS = 4 * SAPLING_DAY_MS;
export const SAPLING_FAST_TEND_GROVE_LORE_RANK = 2;
export const SAPLING_PULL_GROVE_LORE_RANK = 3;
/** A grown tree grows one Giving Berry back this long after its berries were gathered (5 hours). */
export const GROWN_TREE_BERRY_REGROW_MS = 5 * 3_600_000;

/** Minimum distance between a new sapling and any other sapling or known tree. */
export const SAPLING_MIN_SPACING_M = 90;
/**
 * Slack on that rule so two neighbours on the planting lattice (exactly SAPLING_MIN_SPACING_M apart on
 * the shared sphere, a few centimetres off on the database's WGS84 ellipsoid) are never refused as too
 * close. A new sapling is too close when it is nearer than SAPLING_MIN_SPACING_M - this.
 */
export const SAPLING_SPACING_TOLERANCE_M = 0.5;
/** Plant, tend, pull and gather all happen within this distance of the sapling. */
export const SAPLING_INTERACT_RANGE_M = 20;
/**
 * How far a planner-snapped planting spot may be from the player: the nearest planting-grid point can
 * be up to SAPLING_MIN_SPACING_M / sqrt(3) away (about 52 m), past the plain interact range, so the
 * grid point nearest the player is always plantable. 2 m slack covers the seam rows between bands.
 */
export const SAPLING_PLANT_TARGET_RANGE_M = Math.max(SAPLING_INTERACT_RANGE_M, SAPLING_MIN_SPACING_M / Math.sqrt(3) + 2);
/** Saplings and grown trees shown around the player. */
export const SAPLING_VIEW_RADIUS_M = 800;
/**
 * Nearest-first cap on one view. A dense planted forest at the 90 m spacing rule fits about 500 trees
 * within the nearest ~1 km, which is far past the 20 m interaction range, so any truncation only drops
 * the farthest trees and never one the player can act on.
 */
export const SAPLING_VIEW_LIMIT = 500;

/**
 * Biomes where trees grow. Planting is refused everywhere else (dry, frozen or open water biomes).
 * Scrubland is allowed: its dry hills carry scattered oak and gum woodland, like the Savanna.
 * "wilds" is the unknown-biome fallback, so a point the zone map cannot classify still allows planting.
 */
export const SAPLING_PLANTABLE_BIOMES = [
  "jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "wilds"
] as const satisfies readonly WorldZoneBiome[];

export function isSaplingPlantableBiome(biome: WorldZoneBiome): boolean {
  return (SAPLING_PLANTABLE_BIOMES as readonly string[]).includes(biome);
}

export function saplingBiomeRefusal(biome: WorldZoneBiome): string {
  return `Giving Trees do not grow in the ${WORLD_ZONE_BIOME_NAMES[biome]}.`;
}

export const SAPLING_PLANT_SOURCES = ["berry", "sapling"] as const;
export type SaplingPlantSource = (typeof SAPLING_PLANT_SOURCES)[number];

export type SaplingLifecycleInput = Readonly<{
  plantedAtMs: number;
  lastTendedAtMs: number;
  /** Set when the owner tended it with Grove Lore rank 2 or better. */
  fastGrowth: boolean;
}>;

export type SaplingLifecycle =
  | Readonly<{ state: "sapling"; diesAtMs: number; maturesAtMs: number; tendReadyAtMs: number }>
  | Readonly<{ state: "grown"; maturedAtMs: number }>
  | Readonly<{ state: "dead"; diedAtMs: number }>;

export function saplingMaturesAtMs(input: SaplingLifecycleInput): number {
  return input.plantedAtMs + (input.fastGrowth ? SAPLING_MATURE_AFTER_FAST_MS : SAPLING_MATURE_AFTER_MS);
}

export function saplingDiesAtMs(input: SaplingLifecycleInput): number {
  return input.lastTendedAtMs + SAPLING_DEATH_AFTER_MS;
}

/**
 * Where the sapling stands at `nowMs`. Whichever of death (2 days after the last care) and maturity
 * (6 days, or 4 days once fast-tended, after planting) comes first and has passed wins; a sapling
 * that reaches maturity on the same instant it would die matures. Pure: replaying it never differs.
 */
export function evaluateSapling(input: SaplingLifecycleInput, nowMs: number): SaplingLifecycle {
  const diesAtMs = saplingDiesAtMs(input);
  const maturesAtMs = saplingMaturesAtMs(input);
  if (maturesAtMs <= nowMs && maturesAtMs <= diesAtMs) return { state: "grown", maturedAtMs: maturesAtMs };
  if (diesAtMs <= nowMs) return { state: "dead", diedAtMs: diesAtMs };
  return {
    state: "sapling",
    diesAtMs,
    maturesAtMs,
    tendReadyAtMs: input.lastTendedAtMs + SAPLING_TEND_INTERVAL_MS
  };
}

export type SaplingTendDecision =
  | Readonly<{ allowed: true; fastGrowth: boolean }>
  | Readonly<{ allowed: false; code: "SAPLING_NOT_GROWING" | "SAPLING_TEND_TOO_SOON"; retryAtMs?: number }>;

/**
 * Anyone in range may tend a sapling: tending only helps (it keeps a free healing aura alive for
 * everyone and costs the tender nothing), so it needs no ownership. Only the owner's Grove Lore
 * rank 2 tending also makes it mature faster, so a stranger cannot speed up or claim credit for it.
 */
export function decideSaplingTend(input: Readonly<{
  sapling: SaplingLifecycleInput;
  tenderIsOwner: boolean;
  tenderGroveLoreRank: number;
  nowMs: number;
}>): SaplingTendDecision {
  const life = evaluateSapling(input.sapling, input.nowMs);
  if (life.state !== "sapling") return { allowed: false, code: "SAPLING_NOT_GROWING" };
  if (input.nowMs < life.tendReadyAtMs) {
    return { allowed: false, code: "SAPLING_TEND_TOO_SOON", retryAtMs: life.tendReadyAtMs };
  }
  return {
    allowed: true,
    fastGrowth: input.sapling.fastGrowth ||
      (input.tenderIsOwner && input.tenderGroveLoreRank >= SAPLING_FAST_TEND_GROVE_LORE_RANK)
  };
}

export type SaplingPullDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      code: "SAPLING_PULL_RANK_REQUIRED" | "SAPLING_NOT_GROWING" | "SAPLING_TERRITORY_OWNED_BY_OTHER";
    }>;

/**
 * Grove Lore rank 3 pulls saplings: your own anywhere, or anyone's on land that is unclaimed or
 * yours. Land claimed by another player is theirs to decide, the same as for planting.
 */
export function decideSaplingPull(input: Readonly<{
  sapling: SaplingLifecycleInput;
  groveLoreRank: number;
  /** A Shovel in the puller's inventory uproots any growing sapling, anyone's, anywhere (not consumed). */
  hasShovel?: boolean;
  pullerIsOwner: boolean;
  /** Owner of the flag territory the sapling stands in, or null when unclaimed. */
  territoryOwnerPlayerId: string | null;
  pullerPlayerId: string;
  nowMs: number;
}>): SaplingPullDecision {
  if (!input.hasShovel && input.groveLoreRank < SAPLING_PULL_GROVE_LORE_RANK) {
    return { allowed: false, code: "SAPLING_PULL_RANK_REQUIRED" };
  }
  if (evaluateSapling(input.sapling, input.nowMs).state !== "sapling") {
    return { allowed: false, code: "SAPLING_NOT_GROWING" };
  }
  if (
    !input.hasShovel &&
    !input.pullerIsOwner &&
    input.territoryOwnerPlayerId !== null &&
    input.territoryOwnerPlayerId !== input.pullerPlayerId
  ) {
    return { allowed: false, code: "SAPLING_TERRITORY_OWNED_BY_OTHER" };
  }
  return { allowed: true };
}

/**
 * A sapling heals like an adult tree until tending is due; a sick sapling gives no healing until it is
 * tended. A grown tree always heals.
 */
export function saplingHeals(input: SaplingLifecycleInput, nowMs: number): boolean {
  const life = evaluateSapling(input, nowMs);
  return life.state === "grown" || (life.state === "sapling" && nowMs < life.tendReadyAtMs);
}

export type SaplingWorldSnapshot = Readonly<{
  saplingId: string;
  /** Bumps when a grown tree is chopped; the chop harvest key and replay safety use it. */
  stateRevision: number;
  ownerPlayerId: string;
  ownerUsername: string | null;
  lat: number;
  lon: number;
  state: "sapling" | "grown";
  plantedAt: string;
  lastTendedAt: string;
  /** Sapling only: when it can next be tended / when it dies untended / when it matures. */
  tendReadyAt: string | null;
  diesAt: string | null;
  maturesAt: string | null;
  fastGrowth: boolean;
  /** Grown only: when berries are next ready; null when they are ready now. */
  berryReadyAt: string | null;
  berryAvailable: boolean;
}>;

/** What a mutation was (the reply to Plant, Tend, Pull or Gather). */
export const SAPLING_STATE_ACTIONS = ["plant", "tend", "pull", "gather"] as const;
export type SaplingStateAction = (typeof SAPLING_STATE_ACTIONS)[number];

/** A client asks for a fresh full list when it moved this far from where the last list was taken. */
export const SAPLING_LIST_RESYNC_MOVE_M = 200;
/** Slow safety resync: deltas carry every change, this only corrects any drift (growth buckets, dropped frames). */
export const SAPLING_SLOW_RESYNC_MS = 5 * 60_000;
/** Growth is sent in this many steps (a tenth of the way to maturity each). */
export const SAPLING_GROWTH_BUCKETS = 10;

/**
 * Everything the map needs to draw one tree, nothing more: no owner, no exact timers. The owner and the
 * timers come from a single-tree detail request when the player taps it.
 */
export type SaplingMapItem = Readonly<{
  id: string;
  lat: number;
  lon: number;
  state: "sapling" | "grown";
  /** 0 to SAPLING_GROWTH_BUCKETS. */
  growth: number;
  phase: SaplingGrowthPhase;
  berryAvailable: boolean;
}>;

/** The timing facts of one live tree, as the server keeps them in memory. */
export type SaplingTreeFacts = Readonly<{
  id: string;
  lat: number;
  lon: number;
  state: "sapling" | "grown";
  plantedAtMs: number;
  lastTendedAtMs: number;
  fastGrowth: boolean;
  berryReadyAtMs: number | null;
}>;

/** The compact drawing row for a tree at `nowMs`, or null once a sapling has died. */
export function saplingMapItem(tree: SaplingTreeFacts, nowMs: number): SaplingMapItem | null {
  const input = { plantedAtMs: tree.plantedAtMs, lastTendedAtMs: tree.lastTendedAtMs, fastGrowth: tree.fastGrowth };
  const life = tree.state === "grown" ? null : evaluateSapling(input, nowMs);
  if (life?.state === "dead") return null;
  const grown = tree.state === "grown" || life?.state === "grown";
  const base = { id: tree.id, lat: tree.lat, lon: tree.lon };
  if (grown) {
    return {
      ...base,
      state: "grown",
      growth: SAPLING_GROWTH_BUCKETS,
      phase: "healthy",
      berryAvailable: tree.berryReadyAtMs === null || tree.berryReadyAtMs <= nowMs
    };
  }
  const sapling = life as Extract<SaplingLifecycle, { state: "sapling" }>;
  return {
    ...base,
    state: "sapling",
    growth: Math.min(
      SAPLING_GROWTH_BUCKETS,
      Math.floor(saplingGrowthFraction({ plantedAtMs: tree.plantedAtMs, maturesAtMs: sapling.maturesAtMs }, nowMs) * SAPLING_GROWTH_BUCKETS)
    ),
    phase: saplingGrowthPhase({ tendReadyAtMs: sapling.tendReadyAtMs, diesAtMs: sapling.diesAtMs }, nowMs),
    berryAvailable: false
  };
}

export type SaplingGrowthPhase = "healthy" | "needs_tending" | "dying";

/** Client status: healthy until tending is due, then it looks sickly; in its last day it is dying. */
export function saplingGrowthPhase(input: Readonly<{ tendReadyAtMs: number; diesAtMs: number }>, nowMs: number): SaplingGrowthPhase {
  if (nowMs < input.tendReadyAtMs) return "healthy";
  const remaining = input.diesAtMs - nowMs;
  return remaining <= SAPLING_DAY_MS / 2 ? "dying" : "needs_tending";
}

export function saplingGrowthFraction(input: Readonly<{ plantedAtMs: number; maturesAtMs: number }>, nowMs: number): number {
  const span = input.maturesAtMs - input.plantedAtMs;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (nowMs - input.plantedAtMs) / span));
}
