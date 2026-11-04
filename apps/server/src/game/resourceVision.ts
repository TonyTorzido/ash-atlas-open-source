import { createHash } from "node:crypto";

import {
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  resourceVisionRadiusForLeash,
  type LatLon,
  type ResourceVision
} from "@ash-atlas/shared";

export function resourceVisionForArea(input: {
  regionCode: string;
  position: LatLon;
  movementLeashRadiusM: number;
  visibleRadiusM?: number;
}): ResourceVision {
  const radiusM = Math.max(
    input.visibleRadiusM ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    resourceVisionRadiusForLeash(input.movementLeashRadiusM)
  );
  return {
    flagId: stableUuid(
      `environmental-population-vision:${input.regionCode}:${coordinateIdentity(input.position)}`
    ),
    flagName: "Open area",
    destinationKind: "area",
    center: { ...input.position },
    movementLeashRadiusM: input.movementLeashRadiusM,
    paddingM: radiusM - input.movementLeashRadiusM,
    radiusM
  };
}

function coordinateIdentity(position: LatLon): string {
  return `${position.lat.toFixed(8)},${position.lon.toFixed(8)}`;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
