import { COLLECTIBLE_PICKUP_RADIUS_M } from "./collectibles.js";
import { BASIC_ATTACK_INTERVAL_MS } from "./combatConstants.js";

export const GIVING_TREE_DISPLAY_NAME = "Giving Tree";
export const WILLOW_TREE_DISPLAY_NAME = "Willow Tree";
export const CHINESE_PISTACHE_DISPLAY_NAME = "Chinese Pistache";
export const ELDER_FERN_DISPLAY_NAME = "Elder Fern";
export const TREE_VARIETIES = [
  "giving_tree",
  "elder_fern",
  "chinese_pistache",
  "willow"
] as const;
export type TreeVariety = (typeof TREE_VARIETIES)[number];
export const GIVING_TREE_WOOD_YIELD = 4;
export const ELDER_FERN_WOOD_YIELD = 4;
export const CHINESE_PISTACHE_WOOD_YIELD = 10;
export const WILLOW_TREE_WOOD_YIELD = 20;
export const GIVING_TREE_HARVEST_DURATION_MS = 15_000;
export const ELDER_FERN_HARVEST_DURATION_MS = 15_000;
export const CHINESE_PISTACHE_HARVEST_DURATION_MS = 20_000;
export const WILLOW_TREE_HARVEST_DURATION_MS = 25_000;
export const GIVING_TREE_SPAWN_PERCENT = 76;
export const ELDER_FERN_SPAWN_PERCENT = 20;
export const CHINESE_PISTACHE_SPAWN_PERCENT = 3;
export const WILLOW_TREE_SPAWN_PERCENT = 1;
export const GIVING_TREE_AURA_RADIUS_M = COLLECTIBLE_PICKUP_RADIUS_M;
export const GIVING_TREE_AURA_HEAL = 3;
/** The aura heals once per combat beat. */
export const GIVING_TREE_AURA_INTERVAL_MS = BASIC_ATTACK_INTERVAL_MS;
export const GIVING_TREE_RESIN_THRESHOLD = 2_576_980_377;
export const GIVING_TREE_RESIN_PERCENT = 60;
export const GIVING_BERRY_ITEM_ID = "giving_berry";
export const BALSAM_RESIN_ITEM_ID = "balsam_resin";
/** Player-facing name of balsam_resin, the sap tapped from Elder Ferns. */
export const FROND_SAP_DISPLAY_NAME = "Frond Sap";
/** A tapped Elder Fern refills its sap this long after it was tapped. */
export const ELDER_FROND_SAP_REFILL_MS = 5 * 60 * 60 * 1000;
export const BALSAM_RESIN_HARVEST_DURATION_MS = 600;
export const BALSAM_RESIN_HEAL_PER_TICK = 4;
export const BALSAM_RESIN_TOTAL_TICKS = 6;
export const BALSAM_RESIN_TOTAL_HEALING =
  BALSAM_RESIN_HEAL_PER_TICK * BALSAM_RESIN_TOTAL_TICKS;
/** Giving Berry heals once per combat beat. */
export const BALSAM_RESIN_TICK_INTERVAL_MS = BASIC_ATTACK_INTERVAL_MS;
/**
 * Healing for one Giving Berry tick. A multiplier above 1 (Alchemy) spreads the extra healing over the
 * ticks so the total is exactly round(24 x multiplier): 1.5 heals 6 on every tick.
 */
export function balsamResinTickHeal(tickIndex: number, multiplier = 1): number {
  const perTick = BALSAM_RESIN_HEAL_PER_TICK * multiplier;
  return Math.round(perTick * (tickIndex + 1)) - Math.round(perTick * tickIndex);
}
/**
 * Giving Berry tick spacing for one player: a Monk (specialisation rank 1+) who is not
 * aggressive heals 1.3x faster (1.6x from rank 3, 2x at rank 5), still for exactly
 * BALSAM_RESIN_TOTAL_TICKS ticks.
 * The server engine and the client's hotbar timer both call this so they cannot disagree.
 */
export function balsamResinTickIntervalMs(
  state: Readonly<{
    activeSpecializationId: string | null;
    specializationRank: number;
    aggressiveUntilMs: number;
  }> | null | undefined,
  nowMs: number
): number {
  if (
    state?.activeSpecializationId !== "monk" || state.specializationRank < 1 ||
    state.aggressiveUntilMs > nowMs
  ) return BALSAM_RESIN_TICK_INTERVAL_MS;
  const speedup = state.specializationRank >= 5 ? 2 : state.specializationRank >= 3 ? 1.6 : 1.3;
  return Math.round(BALSAM_RESIN_TICK_INTERVAL_MS / speedup);
}
export const BALSAM_RESIN_EFFECT_DURATION_MS =
  (BALSAM_RESIN_TOTAL_TICKS - 1) * BALSAM_RESIN_TICK_INTERVAL_MS;
export const BALSAM_RESIN_DESCRIPTION =
  "Restores 4 health immediately, then restores 4 health every 1.4 seconds. " +
  "Restores up to 24 health in total. Only one Giving Berry effect may be active at a time.";

export type BalsamResinEffectSnapshot = Readonly<{
  effectId: string;
  playerId: string;
  startedAt: string;
  endsAt: string;
  resinConsumed: boolean;
  huntingDistrictPreserved: boolean;
}>;

export function givingTreeResinHash(stableTreeId: string): number {
  let hash = 0x811c9dc5;
  const input = `giving-tree-resin-v1\u0000${stableTreeId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function isGivingTreeResinCapable(stableTreeId: string): boolean {
  return treeVarietyForStableId(stableTreeId) === "giving_tree"
    && givingTreeResinHash(stableTreeId) < GIVING_TREE_RESIN_THRESHOLD;
}

export function treeVarietyHash(stableTreeId: string): number {
  let hash = 0x811c9dc5;
  const input = `tree-variety-v1\u0000${stableTreeId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Player-planted saplings and the grown trees they become (givingSaplings.ts) use this id prefix. */
export const PLAYER_SAPLING_TREE_ID_PREFIX = "sapling:";

export function treeVarietyForStableId(stableTreeId: string): TreeVariety {
  if (stableTreeId.startsWith(PLAYER_SAPLING_TREE_ID_PREFIX)) return "giving_tree";
  const unit = treeVarietyHash(stableTreeId) / 0x1_0000_0000;
  if (unit < WILLOW_TREE_SPAWN_PERCENT / 100) return "willow";
  if (
    unit < (
      WILLOW_TREE_SPAWN_PERCENT + CHINESE_PISTACHE_SPAWN_PERCENT
    ) / 100
  ) return "chinese_pistache";
  // Elder Ferns take the band right above the older varieties, so existing willows
  // and pistaches keep their variety.
  if (
    unit < (
      WILLOW_TREE_SPAWN_PERCENT + CHINESE_PISTACHE_SPAWN_PERCENT + ELDER_FERN_SPAWN_PERCENT
    ) / 100
  ) return "elder_fern";
  return "giving_tree";
}

export function isElderFern(stableTreeId: string): boolean {
  return treeVarietyForStableId(stableTreeId) === "elder_fern";
}

/**
 * Whether a Elder Fern has sap to tap. `sapReadyAt` is when the fern refills after its
 * last tap (null or missing: never tapped).
 */
export function elderFrondSapAvailable(
  sapReadyAt: string | null | undefined,
  nowMs: number
): boolean {
  if (!sapReadyAt) return true;
  const readyAtMs = Date.parse(sapReadyAt);
  return !Number.isFinite(readyAtMs) || readyAtMs <= nowMs;
}

/**
 * Whether a tree currently carries its harvestable produce: berries on a Giving Tree,
 * sap on a Elder Fern. Other varieties never do.
 */
export function treeProduceAvailable(
  tree: Readonly<{ id: string; berryAvailable?: boolean; sapReadyAt?: string | null }>,
  nowMs: number
): boolean {
  switch (treeVarietyForStableId(tree.id)) {
    case "giving_tree": return tree.berryAvailable === true;
    case "elder_fern": return elderFrondSapAvailable(tree.sapReadyAt, nowMs);
    default: return false;
  }
}

/** `produceAvailable`: berries on a Giving Tree, sap on a Elder Fern (treeProduceAvailable). */
export function treeDisplayNameForStableId(stableTreeId: string, produceAvailable = false): string {
  switch (treeVarietyForStableId(stableTreeId)) {
    case "giving_tree": return produceAvailable ? "Giving Tree (Fruiting)" : GIVING_TREE_DISPLAY_NAME;
    case "elder_fern": return `${ELDER_FERN_DISPLAY_NAME} (${produceAvailable ? "Sap" : "Tapped"})`;
    case "chinese_pistache": return CHINESE_PISTACHE_DISPLAY_NAME;
    case "willow": return WILLOW_TREE_DISPLAY_NAME;
  }
}

export function treeWoodYieldForStableId(stableTreeId: string): number {
  switch (treeVarietyForStableId(stableTreeId)) {
    case "giving_tree": return GIVING_TREE_WOOD_YIELD;
    case "elder_fern": return ELDER_FERN_WOOD_YIELD;
    case "chinese_pistache": return CHINESE_PISTACHE_WOOD_YIELD;
    case "willow": return WILLOW_TREE_WOOD_YIELD;
  }
}

export function treeHarvestDurationMsForStableId(stableTreeId: string): number {
  switch (treeVarietyForStableId(stableTreeId)) {
    case "giving_tree": return GIVING_TREE_HARVEST_DURATION_MS;
    case "elder_fern": return ELDER_FERN_HARVEST_DURATION_MS;
    case "chinese_pistache": return CHINESE_PISTACHE_HARVEST_DURATION_MS;
    case "willow": return WILLOW_TREE_HARVEST_DURATION_MS;
  }
}
