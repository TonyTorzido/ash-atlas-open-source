import type { LatLon } from "@ash-atlas/shared";

export type WorldTargetAnchorCandidate = Readonly<{
  position: LatLon;
  entityId?: string;
}>;

export function resolveWorldTargetAnchor(input: Readonly<{
  explicit: readonly (WorldTargetAnchorCandidate | null | undefined)[];
  harvest: WorldTargetAnchorCandidate | null | undefined;
  hostileCombat: WorldTargetAnchorCandidate | null | undefined;
}>): WorldTargetAnchorCandidate | null {
  return input.explicit.find(isValidCandidate)
    ?? (isValidCandidate(input.harvest) ? input.harvest : null)
    ?? (isValidCandidate(input.hostileCombat) ? input.hostileCombat : null);
}

export function currentWorldTargetAnchor(
  position: LatLon | null | undefined,
  entityId: string | null | undefined,
  currentDynamicPosition: (entityId: string) => LatLon | null
): LatLon | null {
  if (entityId) return currentDynamicPosition(entityId);
  return position && Number.isFinite(position.lat) && Number.isFinite(position.lon)
    ? position
    : null;
}

function isValidCandidate(
  value: WorldTargetAnchorCandidate | null | undefined
): value is WorldTargetAnchorCandidate {
  return Boolean(
    value &&
    Number.isFinite(value.position.lat) &&
    Number.isFinite(value.position.lon)
  );
}
