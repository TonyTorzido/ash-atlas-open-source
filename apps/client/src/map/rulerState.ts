import { distanceMeters, type LatLon } from "@ash-atlas/shared";

export type RulerLine = Readonly<{ start: LatLon; end: LatLon; distanceM: number }>;
export type RulerState = Readonly<{ pending: LatLon | null; lines: readonly RulerLine[] }>;

export const EMPTY_RULER_STATE: RulerState = { pending: null, lines: [] };

export function addRulerPoint(state: RulerState, point: LatLon): RulerState {
  const next = { lat: point.lat, lon: point.lon };
  if (!state.pending) return { pending: next, lines: state.lines };
  return {
    pending: null,
    lines: [...state.lines, { start: state.pending, end: next, distanceM: distanceMeters(state.pending, next) }]
  };
}

export function formatRulerDistance(distanceM: number): string {
  return `${distanceM < 100 ? distanceM.toFixed(1) : Math.round(distanceM).toLocaleString()} m`;
}
