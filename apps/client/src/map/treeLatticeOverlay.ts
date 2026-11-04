import {
  distanceMeters,
  nearestTreeLatticePoint,
  treeLatticeKey,
  treeLatticePointsAround,
  type LatLon,
  type TreeLatticePoint
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

/** How far around the player the grid is drawn: about 50 points in a disc, drawn on a single canvas. */
export const TREE_LATTICE_VIEW_RADIUS_M = 360;
/** The disc fades out from this fraction of the radius to its edge. */
const FADE_START = 0.55;
/** A tree this close to a grid point counts as standing on it. */
const OCCUPIED_WITHIN_M = 2;

export type TreeLatticeOverlay = {
  /** Recompute the visible points (cheap; call when the player moves or the trees change). */
  update(center: LatLon | null, trees: readonly LatLon[]): void;
  destroy(): void;
};

type ShownPoint = Readonly<{ point: TreeLatticePoint; key: string; alpha: number }>;

/**
 * The tree-planting grid for the planting planner: the shared, world-anchored triangular lattice
 * in a disc around the player that fades toward its edge, drawn on one canvas that follows the map.
 * Free points are small dots, occupied ones red, and the point the player would plant on (nearest
 * to them) is a green ring. Points are bounded and only projected and painted on map render.
 */
export function mountTreeLatticeOverlay(map: maplibregl.Map): TreeLatticeOverlay {
  const canvas = document.createElement("canvas");
  canvas.className = "tree-lattice-overlay";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
  map.getCanvasContainer().append(canvas);

  let shown: readonly ShownPoint[] = [];
  let occupied = new Set<string>();
  let target: string | null = null;

  const render = (): void => {
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (shown.length < 2) return;
    const screen = shown.map(({ point }) => map.project([point.lon, point.lat]));
    // Grid lines join points one spacing apart on screen. Matching by distance rather than by
    // row/col keys keeps the lines whole across a band seam row.
    let spacingPx = Infinity;
    for (let i = 1; i < screen.length; i += 1) {
      spacingPx = Math.min(spacingPx, Math.hypot(screen[i]!.x - screen[0]!.x, screen[i]!.y - screen[0]!.y));
    }
    const maxLinkPx = spacingPx * 1.2;
    context.lineWidth = 1;
    context.lineCap = "round";
    for (let i = 0; i < screen.length; i += 1) {
      for (let j = i + 1; j < screen.length; j += 1) {
        const a = screen[i]!;
        const b = screen[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) > maxLinkPx) continue;
        context.strokeStyle = `rgba(255, 255, 255, ${(0.32 * Math.min(shown[i]!.alpha, shown[j]!.alpha)).toFixed(3)})`;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
    }
    let targetAt: { x: number; y: number } | null = null;
    for (let i = 0; i < shown.length; i += 1) {
      const { key, alpha } = shown[i]!;
      const at = screen[i]!;
      if (key === target) {
        targetAt = at;
        continue;
      }
      const taken = occupied.has(key);
      context.beginPath();
      context.arc(at.x, at.y, taken ? 4 : 2.75, 0, Math.PI * 2);
      context.fillStyle = taken ? `rgba(206, 86, 66, ${(0.92 * alpha).toFixed(3)})` : `rgba(255, 255, 255, ${(0.9 * alpha).toFixed(3)})`;
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = `rgba(36, 44, 30, ${(0.35 * alpha).toFixed(3)})`;
      context.stroke();
    }
    if (targetAt && target) {
      const taken = occupied.has(target);
      context.beginPath();
      context.arc(targetAt.x, targetAt.y, 11, 0, Math.PI * 2);
      context.fillStyle = taken ? "rgba(206, 86, 66, 0.22)" : "rgba(123, 208, 107, 0.22)";
      context.fill();
      context.beginPath();
      context.arc(targetAt.x, targetAt.y, 7, 0, Math.PI * 2);
      context.fillStyle = taken ? "rgba(206, 86, 66, 0.95)" : "rgba(108, 196, 92, 0.95)";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "#ffffff";
      context.stroke();
    }
  };

  map.on("render", render);
  render();

  return {
    update(center, trees) {
      if (!center) {
        shown = [];
        occupied = new Set();
        target = null;
      } else {
        const fadeFrom = TREE_LATTICE_VIEW_RADIUS_M * FADE_START;
        shown = treeLatticePointsAround(center, TREE_LATTICE_VIEW_RADIUS_M).flatMap((point) => {
          const distance = distanceMeters(center, point);
          if (distance > TREE_LATTICE_VIEW_RADIUS_M) return [];
          const fade = Math.min(1, Math.max(0, (distance - fadeFrom) / (TREE_LATTICE_VIEW_RADIUS_M - fadeFrom)));
          return [{ point, key: treeLatticeKey(point), alpha: 1 - fade * fade * (3 - 2 * fade) }];
        });
        target = treeLatticeKey(nearestTreeLatticePoint(center));
        const keys = new Set(shown.map((entry) => entry.key));
        occupied = new Set();
        for (const tree of trees) {
          if (distanceMeters(center, tree) > TREE_LATTICE_VIEW_RADIUS_M + 120) continue;
          const nearest = nearestTreeLatticePoint(tree);
          const key = treeLatticeKey(nearest);
          if (keys.has(key) && distanceMeters(tree, nearest) <= OCCUPIED_WITHIN_M) occupied.add(key);
        }
      }
      map.triggerRepaint();
      render();
    },
    destroy() {
      map.off("render", render);
      canvas.remove();
    }
  };
}
