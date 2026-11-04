import type { ResourceVision } from "@ash-atlas/shared";

export function isPreparedFlagVisionActive(
  activeVision: ResourceVision | null,
  preparedVision: ResourceVision
): boolean {
  return activeVision?.flagId === preparedVision.flagId;
}
