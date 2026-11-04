import { bearingDegrees, distanceMeters, type LatLon } from "@ash-atlas/shared";

export type WaypointView = Readonly<{ lat: number; lon: number; label: string }>;

/** Compact distance for the arrow label: metres under a kilometre, then km. */
export function formatWaypointDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return km < 100 ? `${km.toFixed(km < 10 ? 1 : 0)} km` : `${Math.round(km)} km`;
}

export function waypointBearingDegrees(from: LatLon, waypoint: LatLon): number {
  return bearingDegrees(from, waypoint);
}

export function waypointDistanceMeters(from: LatLon, waypoint: LatLon): number {
  return distanceMeters(from, waypoint);
}

export type ScreenPoint = Readonly<{ x: number; y: number }>;

/**
 * Triangle pointing from the circle centre outward through the edge point. The tip sits on the
 * edge; the base is pulled inward so the whole arrow stays inside the circle.
 */
export function waypointArrowTriangle(
  center: ScreenPoint,
  edge: ScreenPoint,
  size = 14
): Readonly<{ tip: ScreenPoint; left: ScreenPoint; right: ScreenPoint; angle: number; label: ScreenPoint; direction: ScreenPoint }> | null {
  const dx = edge.x - center.x;
  const dy = edge.y - center.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < size * 1.5) return null;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = edge.x - ux * size;
  const baseY = edge.y - uy * size;
  const half = size * 0.55;
  return {
    tip: edge,
    left: { x: baseX - uy * half, y: baseY + ux * half },
    right: { x: baseX + uy * half, y: baseY - ux * half },
    angle: Math.atan2(dy, dx),
    // The label sits just inside the arrow base; the caller anchors it so the text grows inward.
    label: { x: baseX - ux * 6, y: baseY - uy * 6 },
    direction: { x: ux, y: uy }
  };
}
