/*
 * Manor warfare  (houses are attackable). A player Manor uses the
 * same war rules as every other structure (structureWarfare.ts):
 *  - hand attacks deal 25 (3x while a repair runs), once per attacker per 24 h,
 *    and stop at the 50% burn threshold; reaching it ignites the Manor, which
 *    then burns from the threshold to 0 over its burn time (90 h);
 *  - repair is free and time-only at 5x the burn rate, the burn pauses while
 *    the owner repairs, and only the owner can repair.
 *
 * Health: our Manor types (Timber, Haunted, Samurai) are cosmetic skins of one
 * personal home, so every Manor uses one value: 4,400 HP with a 90 h burn.
 *
 * A Manor at 0 health is "burnt": it stays on the map with every stored item,
 * furniture placement and station intact, but nobody can enter it until the
 * owner repairs it above 0. It is never deleted or unbuilt by warfare.
 *
 * The database keeps one checkpoint per Manor (health, health_at, burning,
 * repairing), projected with the same rates as city buildings
 * (cityBuildingHealthAt), so the server and the client compute the same value.
 */
import { cityBuildingBurnRemainingMs, cityBuildingHealthAt } from "./cityStructureWarfare.js";
import { STRUCTURE_WARFARE_ORGANIZATION_SEAT_BURN_DURATION_MS } from "./structureWarfare.js";

/** Manor House health. */
export const MANOR_WARFARE_MAXIMUM_HEALTH = 4_400;
export const MANOR_WARFARE_BURN_THRESHOLD = 2_200;
/** 90 h. */
export const MANOR_WARFARE_BURN_DURATION_MS = STRUCTURE_WARFARE_ORGANIZATION_SEAT_BURN_DURATION_MS;
/** Name of the house tier every Manor uses. */
export const MANOR_WARFARE_BASE_TIER = "Manor House" as const;

export type ManorWarfareProfile = Readonly<{
  maximumHealth: number;
  burnThreshold: number;
  burnDurationMs: number;
}>;

export const MANOR_WARFARE_PROFILE: ManorWarfareProfile = Object.freeze({
  maximumHealth: MANOR_WARFARE_MAXIMUM_HEALTH,
  burnThreshold: MANOR_WARFARE_BURN_THRESHOLD,
  burnDurationMs: MANOR_WARFARE_BURN_DURATION_MS
});

/** Wire projection sent with a Manor world snapshot. */
export type ManorWarfareSnapshot = Readonly<{
  maximumHealth: number;
  burnThreshold: number;
  burnDurationMs: number;
  /** Checkpoint health (full health when untouched). */
  health: number;
  /** ISO time of the checkpoint; null when untouched. */
  healthAt: string | null;
  burning: boolean;
  repairing: boolean;
  repairPlayerId: string | null;
}>;

export type ManorWarfareCheckpoint = Readonly<{
  health: number | null;
  healthAtMs: number | null;
  burning: boolean;
  repairing: boolean;
}>;

/** Projected Manor health at `nowMs`. */
export function manorHealthAt(checkpoint: ManorWarfareCheckpoint, nowMs: number): number {
  return cityBuildingHealthAt(MANOR_WARFARE_PROFILE, checkpoint, nowMs);
}

export function manorHealthFromSnapshot(snapshot: ManorWarfareSnapshot | null | undefined, nowMs: number): number {
  if (!snapshot) return MANOR_WARFARE_MAXIMUM_HEALTH;
  return cityBuildingHealthAt(snapshot, {
    health: snapshot.health,
    healthAtMs: snapshot.healthAt ? Date.parse(snapshot.healthAt) : null,
    burning: snapshot.burning,
    repairing: snapshot.repairing
  }, nowMs);
}

/** Milliseconds until a burning, unrepaired Manor at `health` burns down. */
export function manorBurnRemainingMs(health: number): number {
  return cityBuildingBurnRemainingMs(MANOR_WARFARE_PROFILE, health);
}

/** A burnt Manor (0 health, not being repaired) cannot be entered. */
export function isManorBurnt(snapshot: ManorWarfareSnapshot | null | undefined, nowMs: number): boolean {
  return manorHealthFromSnapshot(snapshot, nowMs) <= 0;
}
