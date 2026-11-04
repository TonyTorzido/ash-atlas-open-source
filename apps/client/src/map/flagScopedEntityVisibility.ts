import type { ResourceVision } from "@ash-atlas/shared";

export function matchesActiveFlagCircle(
  activeFlagId: string | null | undefined,
  messageFlagId: string | null | undefined
): boolean {
  return Boolean(activeFlagId && messageFlagId && activeFlagId === messageFlagId);
}

export function matchesActiveResourceVision(
  activeFlagId: string | null | undefined,
  resourceVision: ResourceVision | null
): boolean {
  if (resourceVision?.destinationKind === "area") return !activeFlagId;
  return (activeFlagId ?? null) === (resourceVision?.flagId ?? null);
}
