import { DEFAULT_FLAG_CLAIM_RADIUS_M } from "./gameplayArea.js";

/**
 * Tidecraft and the water sites (docs/design/WATER_GAME_PLAN.md, phases C and D).
 * The server is authoritative for every rule; this file holds the shared numbers
 * and the wire shapes for the map objects.
 */

export const TIDECRAFT_SKILL_ID = "tidecraft" as const;

/** Pearl Beds, whirlpools and Drowned City sites are used from this close. */
export const WATER_SITE_INTERACTION_RADIUS_M = 50;
/** Sites are listed for the player within this radius. */
export const WATER_SITE_VISIBLE_RADIUS_M = 3_000;

export const PEARL_DIVE_COOLDOWN_MS = 7 * 60 * 60 * 1_000;
export const PEARL_DIVE_MIN_RANK = 1;
/** Rank 2: chance of a second pearl. Rank 3 always gives two. */
export const PEARL_DIVE_DOUBLE_CHANCE_RANK_2 = 0.45;

export const WHIRLPOOL_MIN_RANK = 1;
export const WHIRLPOOL_PLATE_COST = 34;

/** Presenting this many Abyssal Orbs at a Drowned City site discovers Tidecraft. */
export const TIDECRAFT_UNLOCK_ITEM_ID = "abyssal_orb" as const;
export const TIDECRAFT_UNLOCK_COST = 20;

/** Mobs the Tidecraft matchup bonuses apply to. */
export const TIDECRAFT_MATCHUP_MOB_KEYS: readonly string[] = Object.freeze(["tide_wraith", "drowned_citizen"]);
/** Defense against the matchup mobs by Tidecraft rank: +2 from rank 1, +3 at rank 3. */
export const TIDECRAFT_DEFENSE_BONUS = [0, 2, 2, 3] as const;
/** Attack against the matchup mobs by Tidecraft rank: +2 from rank 2, +3 at rank 3. */
export const TIDECRAFT_ATTACK_BONUS = [0, 0, 2, 3] as const;

export const TIDEWATER_DRAUGHT_DURATION_MS = [0, 75 * 60 * 1_000, 75 * 60 * 1_000, 150 * 60 * 1_000] as const;

export const UNDERTOW_SNARE_LIFETIME_MS = 6 * 60 * 1_000;
export const UNDERTOW_SNARE_RADIUS_M = 28;
/** Pull speed toward the snare's centre. */
export const UNDERTOW_SNARE_PULL_MPS = 1.7;
/** The snare pulls in steps this far apart (players are stopped at each step). */
export const UNDERTOW_SNARE_PULL_INTERVAL_MS = 1_000;
/** Nothing is pulled closer than this to the centre. */
export const UNDERTOW_SNARE_HOLD_M = 1;

export const STILLWATER_ORB_RANGE_M = 20;
export const STILLWATER_ORB_RADIUS_M = 7;
export const STILLWATER_ORB_ROOT_MS = 13_000;
/** Thrown by a player of this Tidecraft rank or higher, the orb also blocks healing. */
export const STILLWATER_ORB_HEAL_BLOCK_MIN_RANK = 2;

export const FREE_STEP_WARD_LIFETIME_MS = 12 * 60 * 1_000;
export const FREE_STEP_WARD_RADIUS_M = DEFAULT_FLAG_CLAIM_RADIUS_M;

/** Rank 3: snares spare and wards protect only allies (party or kingdom). */
export const TIDECRAFT_ALLY_FILTER_MIN_RANK = 3;

export type TidecraftRank = 0 | 1 | 2 | 3;

export function tidecraftRank(rank: number | null | undefined): TidecraftRank {
  return Math.max(0, Math.min(3, Math.trunc(Number(rank ?? 0)))) as TidecraftRank;
}

/** Pearls from one dive; `roll` is a 0-1 random number (only rank 2 uses it). */
export function pearlDiveYield(rank: number, roll: number): number {
  const normalized = tidecraftRank(rank);
  if (normalized < PEARL_DIVE_MIN_RANK) return 0;
  if (normalized >= 3) return 2;
  if (normalized === 2) return roll < PEARL_DIVE_DOUBLE_CHANCE_RANK_2 ? 2 : 1;
  return 1;
}

export function tidewaterDraughtDurationMs(rank: number): number {
  return TIDEWATER_DRAUGHT_DURATION_MS[Math.max(1, tidecraftRank(rank)) as TidecraftRank];
}

export const WATER_SITE_KINDS = ["pearl_bed", "whirlpool", "drowned_city_site"] as const;
export type WaterSiteKind = (typeof WATER_SITE_KINDS)[number];

export type WaterSitePoint = Readonly<{ lat: number; lon: number }>;

export type WaterSiteSnapshot = Readonly<{
  siteId: string;
  kind: WaterSiteKind;
  lat: number;
  lon: number;
  /** Whirlpools: where this one leads. */
  destination?: WaterSitePoint & Readonly<{ distanceM: number }>;
  /** Pearl Beds: epoch ms when this player may dive again; absent when ready. */
  diveReadyAt?: number;
}>;

/** Why an action at a water site cannot run, for the popup. Null when it can. */
export type WaterSiteBlocker =
  | "no_rank"
  | "not_afloat"
  | "too_far"
  | "not_enough_plates"
  | "cooldown"
  | "already_known"
  | "not_enough_orbs";

export function waterSiteBlockerText(blocker: WaterSiteBlocker, detail: Readonly<{ readyInMs?: number; have?: number; need?: number }> = {}): string {
  switch (blocker) {
    case "no_rank": return "Needs Tidecraft rank 1.";
    case "not_afloat": return "You must be afloat.";
    case "too_far": return "Move closer.";
    case "not_enough_plates": return `Needs ${detail.need ?? WHIRLPOOL_PLATE_COST} Shellback Plates (you have ${detail.have ?? 0}).`;
    case "cooldown": return `Dive again in ${formatWaitMs(detail.readyInMs ?? 0)}.`;
    case "already_known": return "You already know Tidecraft.";
    case "not_enough_orbs": return `Needs ${detail.need ?? TIDECRAFT_UNLOCK_COST} Abyssal Orbs (you have ${detail.have ?? 0}).`;
  }
}

function formatWaitMs(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}
