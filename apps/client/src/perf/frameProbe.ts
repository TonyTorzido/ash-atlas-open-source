/**
 * Frame-sync probe for the smooth-walking checks (docs/plans/crisp-smooth.md). Off until a spec or a developer sets
 * window.__ASH_ATLAS_FRAME_PROBE__.on = true. While on it records, for every MapLibre render and every Pixi overlay render,
 * the screen point of one fixed world anchor (the camera as that layer saw it) and, for the overlay, the local player's
 * sprite point. An overlay render whose anchor differs from the last map render's anchor is a frame where the sprites and the
 * ground were drawn with different cameras (visible as jitter). Costs one property read per frame while off.
 */
import { perfMetrics } from "./perfMetrics.js";

export type FrameProbeSample = Readonly<{
  /** "m" MapLibre render, "o" overlay render, "r" requestAnimationFrame tick (rAF timestamp, for the frame-time distribution). */
  kind: "m" | "o" | "r";
  t: number;
  ax: number;
  ay: number;
  px: number;
  py: number;
}>;

export type FrameProbe = {
  /** GameApp renders so far and the noted reasons (reasons need the perf probe visible). */
  reactRenders?: () => { renders: number; reasons: Array<[string, number]> };
  on: boolean;
  /** [lng, lat] of the fixed anchor; the spec sets it to the player's spawn. */
  anchor: [number, number] | null;
  samples: FrameProbeSample[];
};

type ProbeMap = { project(lngLat: [number, number]): { x: number; y: number } };

const probe: FrameProbe = {
  on: false,
  anchor: null,
  samples: [],
  reactRenders: () => ({ renders: perfMetrics.gameAppRenderCount(), reasons: perfMetrics.renderReasonCounts() })
};
if (typeof window !== "undefined") {
  (window as unknown as { __ASH_ATLAS_FRAME_PROBE__?: FrameProbe }).__ASH_ATLAS_FRAME_PROBE__ = probe;
}

export function frameProbeOn(): boolean {
  return (probe.on && probe.anchor !== null) || probeTap !== null;
}

export function noteFrameProbe(kind: "m" | "o", map: ProbeMap, sprite: Readonly<{ x: number; y: number }> | null): void {
  probeTap?.(kind, map, sprite);
  if (!probe.on || !probe.anchor || probe.samples.length > 20_000) return;
  const a = map.project(probe.anchor);
  probe.samples.push({ kind, t: performance.now(), ax: a.x, ay: a.y, px: sprite?.x ?? 0, py: sprite?.y ?? 0 });
}

type FrameProbeTap = (kind: "m" | "o", map: ProbeMap, sprite: Readonly<{ x: number; y: number }> | null) => void;
let probeTap: FrameProbeTap | null = null;

/** The on-device motion report (motionReport.ts) taps the same render points while it samples. */
export function setFrameProbeTap(tap: FrameProbeTap | null): void {
  probeTap = tap;
}
