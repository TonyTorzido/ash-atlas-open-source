import {
  distanceMeters,
  isWithinSiegeAttackRange,
  type FlagSnapshot,
  type CityStructureSnapshot,
  type LatLon,
  type MilitaryUnitGroupSnapshot
} from "@ash-atlas/shared";

import { isFlagSiegeTargetPresentationTarget } from "../flags/flagDisplay.js";

type SiegePresentationGroup = Pick<MilitaryUnitGroupSnapshot,
  "unitType" | "locationState" | "lat" | "lon" | "ownerPlayerId" | "targetFlagId" | "targetCityStructureId">;
type SiegePresentationFlag = Parameters<typeof isFlagSiegeTargetPresentationTarget>[0] &
  Pick<FlagSnapshot, "id" | "lat" | "lon">;

/**
 * Resolve the live hostile structures a selected deployed Siege can damage.
 * The caller supplies the latest snapshots on every render update so target
 * markers follow movement, durability, ownership, and visibility changes.
 */
export function siegeTargetFlagIds(
  group: SiegePresentationGroup | null,
  flags: readonly SiegePresentationFlag[]
): readonly string[] {
  if (
    !group ||
    group.unitType !== "field_ballista" ||
    group.locationState !== "DEPLOYED_FIELD" ||
    group.lat === null ||
    group.lon === null ||
    !Number.isFinite(group.lat) ||
    !Number.isFinite(group.lon)
  ) return [];

  const origin: LatLon = { lat: group.lat, lon: group.lon };
  return flags
    .filter((flag) =>
      isFlagSiegeTargetPresentationTarget(flag, group.ownerPlayerId) &&
      isWithinSiegeAttackRange(distanceMeters(origin, flag))
    )
    .map((flag) => flag.id)
    .sort((left, right) => left.localeCompare(right));
}

/** Face the attacked single building/organization structure, or nearest Tower in an area volley. */
export function siegeFacingTarget(
  group: SiegePresentationGroup | null,
  flags: readonly SiegePresentationFlag[],
  structures: readonly Pick<CityStructureSnapshot, "structureId" | "lat" | "lon">[]
): (LatLon & Readonly<{ id: string }>) | null {
  if (!group || group.unitType !== "field_ballista" || group.locationState !== "DEPLOYED_FIELD" ||
      group.lat === null || group.lon === null || !Number.isFinite(group.lat) || !Number.isFinite(group.lon)) return null;
  if (group.targetCityStructureId) {
    const building = structures.find((entry) => entry.structureId === group.targetCityStructureId);
    return building ? { id: building.structureId, lat: building.lat, lon: building.lon } : null;
  }
  const selected = flags.find((flag) => flag.id === group.targetFlagId);
  // City/kingdom flag structures use single-target warfare, unlike personal Towers.
  if (selected && (selected.controlType !== "personal" || selected.cityId || selected.kingdomId)) return selected;
  const ids = new Set(siegeTargetFlagIds(group, flags));
  const origin = { lat: group.lat, lon: group.lon };
  return flags.filter((flag) => ids.has(flag.id))
    .sort((left, right) => distanceMeters(origin, left) - distanceMeters(origin, right) || left.id.localeCompare(right.id))[0] ?? null;
}
