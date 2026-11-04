import {
  faceFeaturePointInPolygon,
  SALON_FLOOR_SIZE,
  SALON_PLAYER_VISUAL_HEIGHT_UNITS,
  type PlayerAnchorPoint,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import {
  PixiTextureCache,
  PlayerRenderer,
  playerDisplayColorNumber
} from "@ash-atlas/player-renderer";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { Application } from "pixi.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SalonMovementTimeline } from "../movement/salonMovementTimeline.js";
import { IndoorPlayerLayer } from "./IndoorPlayerLayer.js";
import { playerLayerResolution } from "../perf/renderQuality.js";

const renderResolution = playerLayerResolution;
const SALON_PREVIEW_PADDING = 16;
const SALON_PREVIEW_MAX_ZOOM = 5;

type PreviewPan = Readonly<{ x: number; y: number }>;
type PreviewTransform = PreviewPan & Readonly<{ zoom: number }>;
/** Pointer radius (CSS px) around a movable face feature that starts a feature drag. */
const FEATURE_GRAB_RADIUS_PX = 36;

/** A face feature the preview lets the player drag inside its allowed area. */
export type PreviewFeatureEdit = Readonly<{
  label: string;
  point: PlayerAnchorPoint;
  polygon: readonly PlayerAnchorPoint[];
  onChange(point: PlayerAnchorPoint): void;
}>;

/**
 * Moves a feature toward a candidate point without leaving its polygon: the full move
 * when allowed, else a slide along one axis, else the last valid point.
 */
export function clampFeaturePointToArea(
  current: PlayerAnchorPoint,
  candidate: PlayerAnchorPoint,
  polygon: readonly PlayerAnchorPoint[]
): PlayerAnchorPoint {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const options = [
    { x: round(candidate.x), y: round(candidate.y) },
    { x: round(candidate.x), y: current.y },
    { x: current.x, y: round(candidate.y) }
  ];
  return options.find((point) => faceFeaturePointInPolygon(point, polygon)) ?? current;
}

export function playerAppearancePreviewFitScale(
  viewportWidth: number,
  viewportHeight: number,
  bounds: Readonly<{ width: number; height: number }>,
  padding = SALON_PREVIEW_PADDING
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 1;
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  return Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
}

export function clampPlayerAppearancePreviewPan(
  viewportWidth: number,
  viewportHeight: number,
  fittedWidth: number,
  fittedHeight: number,
  zoom: number,
  pan: PreviewPan,
  padding = SALON_PREVIEW_PADDING
): PreviewPan {
  if (zoom <= 1) return { x: 0, y: 0 };
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const maxX = Math.max(0, (fittedWidth * zoom - availableWidth) / 2);
  const maxY = Math.max(0, (fittedHeight * zoom - availableHeight) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y))
  };
}

export type PlayerAppearancePreviewVerticalAlignment = "grounded" | "centered";

export function playerAppearancePreviewY(
  viewportHeight: number,
  scale: number,
  bounds: Readonly<{ y: number; height: number }>,
  verticalAlignment: PlayerAppearancePreviewVerticalAlignment
): number {
  if (verticalAlignment === "centered") {
    return Math.round(viewportHeight / 2 - (bounds.y + bounds.height / 2) * scale);
  }
  return Math.round(viewportHeight * 0.7);
}

export function SalonPlayerLayer({ timeline, displayColor, appearance }: {
  timeline: SalonMovementTimeline;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
}): React.JSX.Element {
  return <IndoorPlayerLayer
    roomWidth={SALON_FLOOR_SIZE}
    roomHeight={SALON_FLOOR_SIZE}
    playerVisualHeightUnits={SALON_PLAYER_VISUAL_HEIGHT_UNITS}
    positionSource={timeline}
    displayColor={displayColor}
    {...(appearance ? { appearance } : {})}
    className="salon-player-layer"
    canvasClassName="salon-player-canvas"
    ariaLabel="Your character"
  />;
}

/**
 * Last drawn still portraits. A preview that mounts again (the Game Menu after an app
 * closes) paints this at once while its renderer starts, so the character never blinks.
 */
const stillPreviewSnapshots = new Map<string, string>();
const STILL_PREVIEW_SNAPSHOT_LIMIT = 8;

function rememberStillPreview(key: string, canvas: HTMLCanvasElement): void {
  try {
    stillPreviewSnapshots.delete(key);
    stillPreviewSnapshots.set(key, canvas.toDataURL());
    while (stillPreviewSnapshots.size > STILL_PREVIEW_SNAPSHOT_LIMIT) {
      const oldest = stillPreviewSnapshots.keys().next().value;
      if (oldest === undefined) break;
      stillPreviewSnapshots.delete(oldest);
    }
  } catch {
    // A canvas that cannot be read back just goes without the placeholder.
  }
}

export function PlayerAppearancePreview({
  appearance,
  displayColor,
  scale = 2.4,
  verticalAlignment = "grounded",
  className = "salon-player-preview",
  ariaLabel = "Character appearance",
  interactive = false,
  featureEdit = null
}: {
  appearance?: PlayerAppearanceSnapshot;
  displayColor: string | null;
  scale?: number;
  verticalAlignment?: PlayerAppearancePreviewVerticalAlignment;
  className?: string;
  ariaLabel?: string;
  interactive?: boolean;
  featureEdit?: PreviewFeatureEdit | null;
}): React.JSX.Element {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const rendererRef = useRef<PlayerRenderer | null>(null);
  const [transform, setTransform] = useState<PreviewTransform>({ zoom: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const lastPanPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastPinchRef = useRef<{ distance: number; centerX: number; centerY: number } | null>(null);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  transformRef.current = transform;
  const featureEditRef = useRef(featureEdit);
  featureEditRef.current = featureEdit;
  const featureDragRef = useRef<{
    pointerId: number;
    start: PlayerAnchorPoint;
    startPoint: PlayerAnchorPoint;
    last: PlayerAnchorPoint;
  } | null>(null);
  const [featureDragging, setFeatureDragging] = useState(false);
  const [featureOverlay, setFeatureOverlay] = useState<{
    point: PlayerAnchorPoint;
    polygon: PlayerAnchorPoint[];
  } | null>(null);
  /** Re-projects the movable feature's handle and area after the renderer moves. */
  const refreshFeatureOverlay = (): void => {
    const edit = featureEditRef.current;
    const renderer = rendererRef.current;
    if (!edit || !renderer || typeof renderer.faceFeatureGlobalPoint !== "function") {
      setFeatureOverlay(null);
      return;
    }
    setFeatureOverlay({
      point: renderer.faceFeatureGlobalPoint(edit.point),
      polygon: edit.polygon.map((vertex) => renderer.faceFeatureGlobalPoint(vertex))
    });
  };
  const hostPoint = (event: React.PointerEvent): PlayerAnchorPoint | null => {
    const host = canvasHostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const snapshotKey = interactive ? null : JSON.stringify([appearance ?? null, displayColor, scale, verticalAlignment]);
  const snapshotKeyRef = useRef(snapshotKey);
  snapshotKeyRef.current = snapshotKey;
  /** Records the drawn still and drops the placeholder once the live canvas shows it. */
  const settleStill = (canvas: HTMLCanvasElement): void => {
    const key = snapshotKeyRef.current;
    if (key !== null) rememberStillPreview(key, canvas);
    const host = canvasHostRef.current;
    if (host) host.style.backgroundImage = "";
  };

  useLayoutEffect(() => {
    const host = canvasHostRef.current;
    if (!host || snapshotKey === null || host.querySelector("canvas")) return;
    const snapshot = stillPreviewSnapshots.get(snapshotKey);
    if (!snapshot) return;
    host.style.backgroundImage = `url("${snapshot}")`;
    host.style.backgroundSize = "100% 100%";
    host.style.backgroundRepeat = "no-repeat";
    // Mount-only: later appearance changes redraw the live canvas in place.
  }, []);

  const normalizeTransform = (next: PreviewTransform): PreviewTransform => {
    const host = canvasHostRef.current;
    const renderer = rendererRef.current;
    if (!interactive || !host || !renderer) return next;
    const bounds = renderer.root.getLocalBounds();
    const fitScale = playerAppearancePreviewFitScale(host.clientWidth, host.clientHeight, bounds);
    const zoom = Math.max(1, Math.min(SALON_PREVIEW_MAX_ZOOM, next.zoom));
    const pan = clampPlayerAppearancePreviewPan(
      host.clientWidth,
      host.clientHeight,
      bounds.width * fitScale,
      bounds.height * fitScale,
      zoom,
      next
    );
    return { zoom, ...pan };
  };
  const syncTransform = (next: PreviewTransform): PreviewTransform => {
    const normalized = normalizeTransform(next);
    transformRef.current = normalized;
    setTransform((current) => current.zoom === normalized.zoom &&
      current.x === normalized.x && current.y === normalized.y ? current : normalized);
    return normalized;
  };
  const commitTransform = (next: PreviewTransform): void => { syncTransform(next); };
  const zoomAt = (nextZoom: number, clientX?: number, clientY?: number): void => {
    const host = canvasHostRef.current;
    const current = transformRef.current;
    const zoom = Math.max(1, Math.min(SALON_PREVIEW_MAX_ZOOM, nextZoom));
    if (!host || clientX === undefined || clientY === undefined) {
      commitTransform({ ...current, zoom });
      return;
    }
    const rect = host.getBoundingClientRect();
    const offsetX = clientX - rect.left - rect.width / 2;
    const offsetY = clientY - rect.top - rect.height / 2;
    const ratio = zoom / current.zoom;
    commitTransform({
      zoom,
      x: offsetX - (offsetX - current.x) * ratio,
      y: offsetY - (offsetY - current.y) * ratio
    });
  };

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    let disposed = false;
    let initialized = false;
    let observer: ResizeObserver | null = null;
    const app = new Application();
    const initialize = async (): Promise<void> => {
      await app.init({
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        sharedTicker: false,
        resolution: renderResolution(),
        roundPixels: true
      });
      initialized = true;
      app.stop();
      app.ticker.stop();
      if (disposed) {
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
        return;
      }
      const renderer = new PlayerRenderer({
        local: true,
        color: playerDisplayColorNumber(displayColor),
        textureLoader: new PixiTextureCache(playerAppearanceAssetUrl)
      });
      appRef.current = app;
      rendererRef.current = renderer;
      renderer.root.scale.set(scale);
      app.canvas.className = "salon-preview-canvas";
      host.replaceChildren(app.canvas);
      app.stage.addChild(renderer.root);
      await renderer.updateAppearance(appearanceRef.current);
      const resize = (): void => {
        app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
        const bounds = renderer.root.getLocalBounds();
        if (interactive) {
          const current = syncTransform(transformRef.current);
          const fitScale = playerAppearancePreviewFitScale(app.screen.width, app.screen.height, bounds);
          const renderedScale = fitScale * current.zoom;
          renderer.root.scale.set(renderedScale);
          renderer.root.position.set(
            Math.round(app.screen.width / 2 - (bounds.x + bounds.width / 2) * renderedScale + current.x),
            Math.round(app.screen.height / 2 - (bounds.y + bounds.height / 2) * renderedScale + current.y)
          );
        } else {
          renderer.root.scale.set(scale);
          renderer.root.position.set(
            Math.round(app.screen.width / 2),
            playerAppearancePreviewY(app.screen.height, scale, bounds, verticalAlignment)
          );
        }
        app.render();
        if (!interactive) settleStill(app.canvas);
        if (interactive) refreshFeatureOverlay();
      };
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(host);
    };
    void initialize();
    return () => {
      disposed = true;
      observer?.disconnect();
      appRef.current = null;
      rendererRef.current = null;
      if (initialized) {
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
      }
    };
  }, [displayColor, interactive, scale, verticalAlignment]);

  useEffect(() => {
    if (!interactive) return;
    const app = appRef.current;
    const renderer = rendererRef.current;
    if (!app || !renderer) return;
    const bounds = renderer.root.getLocalBounds();
    const fitScale = playerAppearancePreviewFitScale(app.screen.width, app.screen.height, bounds);
    const current = normalizeTransform(transform);
    const renderedScale = fitScale * current.zoom;
    renderer.root.scale.set(renderedScale);
    renderer.root.position.set(
      Math.round(app.screen.width / 2 - (bounds.x + bounds.width / 2) * renderedScale + current.x),
      Math.round(app.screen.height / 2 - (bounds.y + bounds.height / 2) * renderedScale + current.y)
    );
    app.render();
    refreshFeatureOverlay();
  }, [interactive, transform]);

  useEffect(() => {
    if (interactive) refreshFeatureOverlay();
  }, [featureEdit?.point.x, featureEdit?.point.y, featureEdit?.polygon, interactive]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const app = appRef.current;
    if (!renderer || !app) return;
    void renderer.updateAppearance(appearance).then(() => {
      if (rendererRef.current !== renderer || appRef.current !== app) return;
      const bounds = renderer.root.getLocalBounds();
      if (interactive) {
        const current = syncTransform(transformRef.current);
        const fitScale = playerAppearancePreviewFitScale(app.screen.width, app.screen.height, bounds);
        const renderedScale = fitScale * current.zoom;
        renderer.root.scale.set(renderedScale);
        renderer.root.position.set(
          Math.round(app.screen.width / 2 - (bounds.x + bounds.width / 2) * renderedScale + current.x),
          Math.round(app.screen.height / 2 - (bounds.y + bounds.height / 2) * renderedScale + current.y)
        );
      } else {
        renderer.root.position.y = playerAppearancePreviewY(
          app.screen.height,
          scale,
          bounds,
          verticalAlignment
        );
      }
      app.render();
      if (!interactive) settleStill(app.canvas);
      if (interactive) refreshFeatureOverlay();
    });
  }, [appearance, interactive, scale, verticalAlignment]);

  const pointerPosition = (event: React.PointerEvent): { x: number; y: number } => ({
    x: event.clientX,
    y: event.clientY
  });
  const finishPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    if (featureDragRef.current?.pointerId === event.pointerId) {
      featureDragRef.current = null;
      setFeatureDragging(false);
    }
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const remaining = [...pointersRef.current.values()];
    lastPanPointRef.current = remaining[0] ?? null;
    lastPinchRef.current = null;
  };

  if (!interactive) {
    return <div ref={canvasHostRef} className={className} aria-label={ariaLabel} />;
  }

  return <div
    className={`${className} salon-player-preview-interactive`}
    aria-label={ariaLabel}
    onWheel={interactive ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      zoomAt(transformRef.current.zoom * Math.exp(-event.deltaY * .0015), event.clientX, event.clientY);
    } : undefined}
    onPointerDown={interactive ? (event) => {
      if ((event.target as Element).closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointersRef.current.set(event.pointerId, pointerPosition(event));
      const points = [...pointersRef.current.values()];
      const edit = featureEditRef.current;
      const renderer = rendererRef.current;
      const start = hostPoint(event);
      if (points.length === 1 && edit && renderer && start &&
        typeof renderer.faceFeaturePointAt === "function") {
        const handle = renderer.faceFeatureGlobalPoint(edit.point);
        const area = edit.polygon.map((vertex) => renderer.faceFeatureGlobalPoint(vertex));
        if (
          Math.hypot(start.x - handle.x, start.y - handle.y) <= FEATURE_GRAB_RADIUS_PX ||
          faceFeaturePointInPolygon(start, area)
        ) {
          featureDragRef.current = {
            pointerId: event.pointerId,
            start: renderer.faceFeaturePointAt(start.x, start.y),
            startPoint: edit.point,
            last: edit.point
          };
          setFeatureDragging(true);
          return;
        }
      }
      if (featureDragRef.current) {
        featureDragRef.current = null;
        setFeatureDragging(false);
      }
      if (points.length === 1) lastPanPointRef.current = points[0] ?? null;
      if (points.length === 2) {
        const [first, second] = points;
        if (!first || !second) return;
        lastPinchRef.current = {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          centerX: (first.x + second.x) / 2,
          centerY: (first.y + second.y) / 2
        };
      }
    } : undefined}
    onPointerMove={interactive ? (event) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      event.preventDefault();
      event.stopPropagation();
      pointersRef.current.set(event.pointerId, pointerPosition(event));
      const featureDrag = featureDragRef.current;
      if (featureDrag?.pointerId === event.pointerId) {
        const edit = featureEditRef.current;
        const renderer = rendererRef.current;
        const current = hostPoint(event);
        if (!edit || !renderer || !current) return;
        const local = renderer.faceFeaturePointAt(current.x, current.y);
        const next = clampFeaturePointToArea(featureDrag.last, {
          x: featureDrag.startPoint.x + local.x - featureDrag.start.x,
          y: featureDrag.startPoint.y + local.y - featureDrag.start.y
        }, edit.polygon);
        if (next.x !== featureDrag.last.x || next.y !== featureDrag.last.y) {
          featureDrag.last = next;
          edit.onChange(next);
        }
        return;
      }
      const points = [...pointersRef.current.values()];
      const current = transformRef.current;
      if (points.length >= 2) {
        const [first, second] = points;
        const previous = lastPinchRef.current;
        if (!first || !second || !previous) return;
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        const centerX = (first.x + second.x) / 2;
        const centerY = (first.y + second.y) / 2;
        const nextZoom = Math.max(1, Math.min(SALON_PREVIEW_MAX_ZOOM,
          current.zoom * (previous.distance > 0 ? distance / previous.distance : 1)));
        const host = canvasHostRef.current;
        if (host) {
          const rect = host.getBoundingClientRect();
          const previousOffsetX = previous.centerX - rect.left - rect.width / 2;
          const previousOffsetY = previous.centerY - rect.top - rect.height / 2;
          const currentOffsetX = centerX - rect.left - rect.width / 2;
          const currentOffsetY = centerY - rect.top - rect.height / 2;
          const ratio = nextZoom / current.zoom;
          commitTransform({
            zoom: nextZoom,
            x: currentOffsetX - (previousOffsetX - current.x) * ratio,
            y: currentOffsetY - (previousOffsetY - current.y) * ratio
          });
        }
        lastPinchRef.current = { distance, centerX, centerY };
        return;
      }
      const previous = lastPanPointRef.current;
      const point = points[0];
      if (!previous || !point || current.zoom <= 1) return;
      commitTransform({
        ...current,
        x: current.x + point.x - previous.x,
        y: current.y + point.y - previous.y
      });
      lastPanPointRef.current = point;
    } : undefined}
    onPointerUp={interactive ? finishPointer : undefined}
    onPointerCancel={interactive ? finishPointer : undefined}
    onLostPointerCapture={interactive ? finishPointer : undefined}
  >
    <div ref={canvasHostRef} className="salon-preview-renderer" />
    {featureEdit && featureOverlay ? <svg
      className={`salon-feature-overlay${featureDragging ? " dragging" : ""}`}
      aria-hidden="true"
    >
      {featureDragging ? <polygon
        className="salon-feature-area"
        points={featureOverlay.polygon.map((vertex) => `${vertex.x},${vertex.y}`).join(" ")}
      /> : null}
      <circle
        className="salon-feature-handle"
        cx={featureOverlay.point.x}
        cy={featureOverlay.point.y}
        r={featureDragging ? 7 : 9}
      />
    </svg> : null}
    {interactive ? <div className="salon-preview-controls" role="group" aria-label="Preview zoom controls">
      <button
        type="button"
        aria-label={`Reset preview, current zoom ${Math.round(transform.zoom * 100)}%`}
        disabled={transform.zoom === 1 && transform.x === 0 && transform.y === 0}
        onClick={() => commitTransform({ zoom: 1, x: 0, y: 0 })}
      >{Math.round(transform.zoom * 100)}%</button>
    </div> : null}
  </div>;
}

export function SalonPlayerPreview({ appearance, displayColor, featureEdit = null }: {
  appearance?: PlayerAppearanceSnapshot;
  displayColor: string | null;
  featureEdit?: PreviewFeatureEdit | null;
}): React.JSX.Element {
  return <PlayerAppearancePreview
    {...(appearance ? { appearance } : {})}
    displayColor={displayColor}
    className="salon-player-preview"
    ariaLabel={featureEdit ? `Style preview, drag to move the ${featureEdit.label}` : "Style preview"}
    interactive
    featureEdit={featureEdit}
  />;
}
