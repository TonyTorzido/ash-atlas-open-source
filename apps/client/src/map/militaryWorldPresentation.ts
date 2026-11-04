import type {
  MilitaryBomberChannelSnapshot,
  MilitarySiegeVolleyCue,
  MilitaryUnitGroupSnapshot
} from "@ash-atlas/shared";

import { buildRemainingTimeLabel } from "../flags/flagBuildCountdown.js";

export const MILITARY_SIEGE_LAUNCH_DURATION_MS = 1000;

/**
 * World-unit countdown copy is derived from the latest server deadline and
 * the synchronized client clock. A locally elapsed deadline stays visible as
 * Finalizing until the authoritative snapshot changes.
 */
export function militaryWorldCountdownLabel(
  group: Pick<MilitaryUnitGroupSnapshot, "unitType" | "locationState" | "packingCompletesAt" | "groupId">,
  bomberChannel: MilitaryBomberChannelSnapshot | null | undefined,
  now: number
): string | null {
  const packingDeadlineMs = group.locationState === "PACKING_UP" && group.packingCompletesAt
    ? Date.parse(group.packingCompletesAt)
    : Number.NaN;
  const bomberDeadlineMs = group.unitType === "bomber" && bomberChannel?.groupId === group.groupId
    ? Date.parse(bomberChannel.completesAt)
    : Number.NaN;
  const deadlineMs = Number.isFinite(packingDeadlineMs) ? packingDeadlineMs : bomberDeadlineMs;
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(now)) return null;
  const remainingMs = deadlineMs - now;
  return remainingMs > 0
    ? `${group.locationState === "PACKING_UP" ? "Packing up" : "Planting Bomb"} · ${buildRemainingTimeLabel(remainingMs)}`
    : "Finalizing…";
}

export type MilitaryWorldArtSlot =
  | "military-siege-packed"
  | "military-siege-deployed"
  | "military-siege-launch"
  | "military-bomber-idle"
  | "military-bomber-planting"
  | "military-infantry"
  | "military-archer";

/** Resolve the authoritative production art state for a world military group. */
export function militaryWorldArtSlot(
  group: Pick<MilitaryUnitGroupSnapshot, "unitType" | "locationState" | "groupId">,
  bomberChannel: MilitaryBomberChannelSnapshot | null | undefined,
  siegeVolleys: readonly MilitarySiegeVolleyCue[] | null | undefined = undefined,
  now = Date.now()
): MilitaryWorldArtSlot {
  if (group.unitType === "field_ballista") {
    const launchActive = group.locationState === "DEPLOYED_FIELD" &&
      Number.isFinite(now) &&
      siegeVolleys?.some((volley) =>
        volley.groupId === group.groupId &&
        Number.isFinite(volley.occurredAt) &&
        now >= volley.occurredAt &&
        now < volley.occurredAt + MILITARY_SIEGE_LAUNCH_DURATION_MS
      ) === true;
    if (launchActive) return "military-siege-launch";
    return group.locationState === "DEPLOYED_FIELD"
      ? "military-siege-deployed"
      : "military-siege-packed";
  }
  if (group.unitType === "bomber") {
    return bomberChannel?.groupId === group.groupId
      ? "military-bomber-planting"
      : "military-bomber-idle";
  }
  return group.unitType === "infantry" ? "military-infantry" : "military-archer";
}
