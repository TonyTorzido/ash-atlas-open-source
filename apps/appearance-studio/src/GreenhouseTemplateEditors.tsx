import {
  GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS,
  type InteriorPrefab
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import type { RuntimeAsset } from "./bridgeTypes.js";
import { clamp } from "./interiorCanvasAuthoring.js";
import type { PlanterStageArt } from "./interiorModules.js";
import type { ViewPrefab } from "./interiorStudioModel.js";

/**
 * The Greenhouse authoring panels shared by the InteriorStudio: the Farm Plot
 * and Water tank template editors (image anchor, image frame, physical
 * footprint, touch area) and the plant stage art editor. They operate on the
 * unified schema: templates are library prefabs (`modules.planters.potPrefabId`
 * and the water tank prefab), stage art is `modules.planters.stageArt`.
 * Pure model functions are exported for tests.
 */

type Point = { x: number; y: number };
export type TemplatePlacementKind = "pot" | "water_tank";
export type TemplateDimension = "width" | "height" | "renderWidth" | "renderHeight" | "pivotX" | "pivotY" | "touchRadius" | "touchWidth" | "touchHeight" | "touchShape";
export type StageArtField = "pivotX" | "pivotY" | "offsetX" | "offsetY" | "scale";
type TouchArea = NonNullable<InteriorPrefab["touchArea"]>;

export const GREENHOUSE_PLANT_DEFINITIONS = [
  { id: "wheat", label: "Wheat", stages: [
    { label: "Seedling", path: "apps/client/src/assets/plants/wheat-seedling.png" },
    { label: "Middle 2", path: "apps/client/src/assets/plants/wheat-middle-2.png" },
    { label: "Middle 3", path: "apps/client/src/assets/plants/wheat-middle-3.png" },
    { label: "Full", path: "apps/client/src/assets/plants/wheat-full.png" }
  ] },
  { id: "giving_berry_tree", label: "Giving Berry Tree", stages: [
    { label: "Stage 1", path: GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS[0] },
    { label: "Stage 2", path: GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS[1] },
    { label: "Stage 3 (Fruiting)", path: GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS[2] },
    { label: "Stage 4 (Mature)", path: GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS[3] }
  ] }
] as const;
export type GreenhousePlantId = typeof GREENHOUSE_PLANT_DEFINITIONS[number]["id"];

// ---------------------------------------------------------------------------
// Template model (a library prefab seen as a placement template)
// ---------------------------------------------------------------------------

export type TemplateValue = Readonly<{
  assetKey: string;
  renderWidth: number;
  renderHeight: number;
  pivotX: number;
  pivotY: number;
  physicalFootprint: readonly Point[];
  touchArea: TouchArea;
}>;

const rectangle = (width: number, height: number): Point[] => [
  { x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
  { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 }
];

export function templateBounds(points: readonly Point[]): { width: number; height: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export function templateFromPrefab(prefab: ViewPrefab): TemplateValue {
  return {
    assetKey: prefab.assetKey,
    renderWidth: prefab.defaultWidth,
    renderHeight: prefab.defaultHeight,
    pivotX: prefab.pivotX,
    pivotY: prefab.pivotY,
    physicalFootprint: prefab.footprint ?? rectangle(prefab.defaultWidth, prefab.defaultHeight),
    touchArea: prefab.touchArea ?? { kind: "circle", radius: 90 }
  };
}

function touchSize(area: TouchArea): { width: number; height: number } {
  return area.kind === "circle" ? { width: area.radius * 2, height: area.radius * 2 } : templateBounds(area.points);
}

/** Applies one template editor field to a draft prefab (pivot is clamped, sizes stay positive, the footprint and touch area stay centered on the anchor). */
export function applyTemplateChange(prefab: ViewPrefab, dimension: TemplateDimension, value: string): void {
  const template = templateFromPrefab(prefab);
  if (dimension === "touchShape") {
    const { width, height } = touchSize(template.touchArea);
    prefab.touchArea = value === "rectangle"
      ? { kind: "polygon", points: rectangle(width, height) }
      : { kind: "circle", radius: Math.max(width, height) / 2 };
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  if (dimension === "pivotX" || dimension === "pivotY") {
    prefab[dimension] = clamp(numeric, 0, 1);
    return;
  }
  if (numeric <= 0) return;
  if (dimension === "touchWidth" || dimension === "touchHeight") {
    const current = touchSize(template.touchArea);
    prefab.touchArea = { kind: "polygon", points: rectangle(dimension === "touchWidth" ? numeric : current.width, dimension === "touchHeight" ? numeric : current.height) };
  } else if (dimension === "renderWidth") prefab.defaultWidth = numeric;
  else if (dimension === "renderHeight") prefab.defaultHeight = numeric;
  else if (dimension === "touchRadius") prefab.touchArea = { kind: "circle", radius: numeric };
  else {
    const bounds = templateBounds(template.physicalFootprint);
    prefab.footprint = rectangle(dimension === "width" ? numeric : bounds.width, dimension === "height" ? numeric : bounds.height);
  }
}

/** Applies one stage art field (pivot 0..1, scale 0.01..4) to the entry of a crop stage. */
export function applyStageArtChange(art: PlanterStageArt[], cropId: string, stage: number, field: StageArtField, value: string): void {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  const next = field === "pivotX" || field === "pivotY" ? clamp(numeric, 0, 1) : field === "scale" ? Math.max(0.01, Math.min(4, numeric)) : numeric;
  for (const entry of art) if (entry.cropId === cropId && entry.stage === stage) entry[field] = next;
}

/** The plant stage PNG frame on the Farm Plot render frame (the plant has no touch area of its own). */
export function plantStageArtFrame(
  plot: Pick<TemplateValue, "renderWidth" | "renderHeight">,
  stageArt: Pick<PlanterStageArt, "pivotX" | "pivotY" | "offsetX" | "offsetY" | "scale">,
  plotAnchorX: number,
  plotAnchorY: number
): { x: number; y: number; width: number; height: number } {
  const width = plot.renderWidth * stageArt.scale;
  const height = plot.renderHeight * stageArt.scale;
  return { x: plotAnchorX + stageArt.offsetX - stageArt.pivotX * width, y: plotAnchorY + stageArt.offsetY - stageArt.pivotY * height, width, height };
}

// ---------------------------------------------------------------------------
// PNG helpers
// ---------------------------------------------------------------------------

type TemplatePreviewFrame = { left: number; top: number; width: number; height: number };

const TEMPLATE_PREVIEW_MIN_ZOOM = 0.5;
const TEMPLATE_PREVIEW_MAX_ZOOM = 4;

/**
 * Return the image box inside the preview viewport. The fit is calculated in
 * normalized viewport coordinates so the same mapping can be used for the
 * visible image and the pivot handle, including transparent PNG margins.
 */
export function greenhouseTemplatePreviewImageFrame(
  imageWidth: number,
  imageHeight: number,
  zoom = 1,
  focusX = 0.5,
  focusY = 0.5,
  fitContain = true
): TemplatePreviewFrame {
  const safeWidth = imageWidth > 0 && Number.isFinite(imageWidth) ? imageWidth : 1;
  const safeHeight = imageHeight > 0 && Number.isFinite(imageHeight) ? imageHeight : 1;
  const safeZoom = clamp(zoom, TEMPLATE_PREVIEW_MIN_ZOOM, TEMPLATE_PREVIEW_MAX_ZOOM);
  const safeFocusX = clamp(focusX, 0, 1);
  const safeFocusY = clamp(focusY, 0, 1);
  const baseWidth = fitContain && safeWidth / safeHeight < 1 ? safeWidth / safeHeight : 1;
  const baseHeight = fitContain && safeWidth / safeHeight > 1 ? safeHeight / safeWidth : 1;
  const baseLeft = (1 - baseWidth) / 2;
  const baseTop = (1 - baseHeight) / 2;
  return {
    left: safeFocusX + (baseLeft - safeFocusX) * safeZoom,
    top: safeFocusY + (baseTop - safeFocusY) * safeZoom,
    width: baseWidth * safeZoom,
    height: baseHeight * safeZoom
  };
}

/**
 * Estimate a PNG's visible-art center. Fully opaque or unreadable images use
 * the stable center convention rather than treating a painted background as
 * authored transparent art.
 */
export function greenhouseAlphaWeightedPivot(rgba: ArrayLike<number>, width: number, height: number): { x: number; y: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length < width * height * 4) {
    return { x: 0.5, y: 0.5 };
  }
  let totalAlpha = 0;
  let weightedX = 0;
  let weightedY = 0;
  let visible = false;
  let hasTransparentPixel = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = Number(rgba[(y * width + x) * 4 + 3]) / 255;
      if (alpha <= 0) {
        hasTransparentPixel = true;
        continue;
      }
      visible = true;
      if (alpha < 1) hasTransparentPixel = true;
      totalAlpha += alpha;
      weightedX += (x + 0.5) * alpha;
      weightedY += (y + 0.5) * alpha;
    }
  }
  if (!visible || !hasTransparentPixel || totalAlpha <= 0) return { x: 0.5, y: 0.5 };
  return { x: clamp(weightedX / totalAlpha / width, 0, 1), y: clamp(weightedY / totalAlpha / height, 0, 1) };
}

export async function greenhousePngFilePivot(file: File): Promise<{ x: number; y: number }> {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return { x: 0.5, y: 0.5 };
        context.drawImage(bitmap, 0, 0);
        return greenhouseAlphaWeightedPivot(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      } finally {
        bitmap.close();
      }
    }
  } catch {
    return { x: 0.5, y: 0.5 };
  }
  return { x: 0.5, y: 0.5 };
}

export function greenhouseAssetPreviewUrl(asset: RuntimeAsset): string {
  if (!asset.imageUrl) return "";
  const revision = asset.contentHash || `${asset.bytes}-${asset.width}x${asset.height}`;
  return `${asset.imageUrl}${asset.imageUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(revision)}`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function AssetUpload({ asset, current, disabled, onChange }: Readonly<{ asset: { id: string; label: string; path: string }; current: RuntimeAsset | null; disabled: boolean; onChange(file: File): void }>): React.JSX.Element {
  const inputId = `greenhouse-asset-${asset.id.replace(/[^a-z0-9-]/giu, "-")}`;
  return <label className="greenhouse-art-card" htmlFor={inputId}><span className="field-label">{asset.label}</span><code>{asset.path}</code>{current?.imageUrl ? <img key={`${asset.id}:${current.contentHash}:${current.staged ? "staged" : "published"}`} className="greenhouse-art-preview" src={greenhouseAssetPreviewUrl(current)} alt={`${asset.label} preview`} /> : <span className="greenhouse-art-preview greenhouse-art-preview-fallback">No preview</span>}<span className={current?.missing ? "connection-error" : "status-copy"}>{current?.missing ? "Fallback square active" : current?.staged ? `PNG staged · ${current.width}×${current.height}px` : current ? `PNG registered · ${current.width}×${current.height}px` : "PNG not registered"}</span>{current?.staged ? <small className="connection-copy">Staged locally. The picker clears after staging so the same file can be selected again. Save publishes it.</small> : null}<input id={inputId} type="file" accept="image/png" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; if (file) onChange(file); event.currentTarget.value = ""; }} /></label>;
}

export function TemplatePivotEditor(props: Readonly<{
  label: string;
  asset: RuntimeAsset | null;
  renderWidth: number;
  renderHeight: number;
  pivotX: number;
  pivotY: number;
  disabled: boolean;
  onChange(axis: "pivotX" | "pivotY", value: string): void;
}>): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const draggingRef = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [zoomFocus, setZoomFocus] = useState({ x: 0.5, y: 0.5 });
  const hasImage = Boolean(props.asset?.imageUrl && props.asset.width > 0 && props.asset.height > 0);
  const imageWidth = hasImage ? props.asset?.width ?? props.renderWidth : props.renderWidth;
  const imageHeight = hasImage ? props.asset?.height ?? props.renderHeight : props.renderHeight;
  const previewFrame = greenhouseTemplatePreviewImageFrame(imageWidth, imageHeight, zoom, zoomFocus.x, zoomFocus.y, hasImage);
  const imagePointFromClient = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame || frame.width <= 0 || frame.height <= 0 || previewFrame.width <= 0 || previewFrame.height <= 0) return null;
    const viewportX = clamp((clientX - frame.left) / frame.width, 0, 1);
    const viewportY = clamp((clientY - frame.top) / frame.height, 0, 1);
    return {
      x: clamp((viewportX - previewFrame.left) / previewFrame.width, 0, 1),
      y: clamp((viewportY - previewFrame.top) / previewFrame.height, 0, 1)
    };
  };
  const updateFromPointer = (clientX: number, clientY: number): void => {
    const point = imagePointFromClient(clientX, clientY);
    if (!point) return;
    props.onChange("pivotX", point.x.toFixed(3));
    props.onChange("pivotY", point.y.toFixed(3));
  };
  const autoCenter = (): void => {
    const image = imageRef.current;
    if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      props.onChange("pivotX", "0.500");
      props.onChange("pivotY", "0.500");
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas 2D context unavailable");
      context.drawImage(image, 0, 0);
      const estimate = greenhouseAlphaWeightedPivot(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      props.onChange("pivotX", estimate.x.toFixed(3));
      props.onChange("pivotY", estimate.y.toFixed(3));
    } catch {
      props.onChange("pivotX", "0.500");
      props.onChange("pivotY", "0.500");
    }
  };
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (props.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame || frame.width <= 0 || frame.height <= 0) return;
    setZoomFocus({ x: clamp((event.clientX - frame.left) / frame.width, 0, 1), y: clamp((event.clientY - frame.top) / frame.height, 0, 1) });
    setZoom(clamp(zoom * Math.pow(1.001, -event.deltaY), TEMPLATE_PREVIEW_MIN_ZOOM, TEMPLATE_PREVIEW_MAX_ZOOM));
  };
  useEffect(() => {
    setZoom(1);
    setZoomFocus({ x: 0.5, y: 0.5 });
  }, [props.asset?.contentHash, props.asset?.imageUrl, props.asset?.width, props.asset?.height]);
  const resetView = (): void => {
    setZoom(1);
    setZoomFocus({ x: 0.5, y: 0.5 });
  };
  return <div className="greenhouse-template-pivot">
    <div
      ref={frameRef}
      className="greenhouse-template-pivot-editor"
      style={{ aspectRatio: "4 / 3" }}
      aria-label={`${props.label} image anchor editor`}
      data-zoom={zoom.toFixed(3)}
      onWheel={handleWheel}
      onPointerMove={(event) => { if (draggingRef.current) updateFromPointer(event.clientX, event.clientY); }}
      onPointerUp={() => { draggingRef.current = false; }}
      onPointerCancel={() => { draggingRef.current = false; }}
    >
      {props.asset?.imageUrl
        ? <img ref={imageRef} className="greenhouse-template-pivot-image" src={greenhouseAssetPreviewUrl(props.asset)} alt={`${props.label} anchor preview`} style={{ left: `${previewFrame.left * 100}%`, top: `${previewFrame.top * 100}%`, width: `${previewFrame.width * 100}%`, height: `${previewFrame.height * 100}%` }} />
        : <span>{props.label.toUpperCase()}<small>PNG fallback</small></span>}
      <button
        type="button"
        className="greenhouse-template-pivot-handle"
        aria-label={`${props.label} image anchor`}
        disabled={props.disabled}
        style={{ left: `${(previewFrame.left + previewFrame.width * props.pivotX) * 100}%`, top: `${(previewFrame.top + previewFrame.height * props.pivotY) * 100}%` }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          draggingRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          updateFromPointer(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => { if (draggingRef.current) updateFromPointer(event.clientX, event.clientY); }}
        onPointerUp={(event) => { draggingRef.current = false; event.currentTarget.releasePointerCapture?.(event.pointerId); }}
        onPointerCancel={() => { draggingRef.current = false; }}
        onClick={(event) => { event.stopPropagation(); updateFromPointer(event.clientX, event.clientY); }}
      >
        <span aria-hidden="true" />
      </button>
    </div>
    <div className="greenhouse-template-pivot-controls">
      <span className="connection-copy">Wheel zoom · {Math.round(zoom * 100)}%</span>
      <button type="button" disabled={props.disabled} onClick={resetView}>Fit</button>
      <button type="button" disabled={props.disabled} onClick={autoCenter}>Auto-center anchor</button>
    </div>
  </div>;
}

/** The image frame, physical footprint and touch area around the placement anchor (all local to the anchor). */
function TemplateGeometryPreview(props: Readonly<{ label: string; template: TemplateValue }>): React.JSX.Element {
  const { template } = props;
  const frame = { x: -template.pivotX * template.renderWidth, y: -template.pivotY * template.renderHeight, width: template.renderWidth, height: template.renderHeight };
  const touchPoints = template.touchArea.kind === "polygon" ? template.touchArea.points : null;
  const radius = template.touchArea.kind === "circle" ? template.touchArea.radius : 0;
  const xs = [frame.x, frame.x + frame.width, ...template.physicalFootprint.map((point) => point.x), ...(touchPoints?.map((point) => point.x) ?? [-radius, radius])];
  const ys = [frame.y, frame.y + frame.height, ...template.physicalFootprint.map((point) => point.y), ...(touchPoints?.map((point) => point.y) ?? [-radius, radius])];
  const margin = 12;
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const pointString = (points: readonly Point[]): string => points.map((point) => `${point.x},${point.y}`).join(" ");
  return <svg className="greenhouse-template-geometry-preview" viewBox={`${minX} ${minY} ${Math.max(...xs) + margin - minX} ${Math.max(...ys) + margin - minY}`} role="img" aria-label={`${props.label} frame, footprint and touch area`} style={{ width: "100%", maxHeight: 180 }}>
    <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} fill="none" stroke="#f8e8b0" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
    <polygon points={pointString(template.physicalFootprint)} className="greenhouse-template-footprint" />
    {template.touchArea.kind === "circle"
      ? <circle cx={0} cy={0} r={template.touchArea.radius} className="greenhouse-template-touch" />
      : <polygon points={pointString(template.touchArea.points)} className="greenhouse-template-touch" />}
    <circle cx={0} cy={0} r={6} className="greenhouse-template-anchor" />
  </svg>;
}

export function TemplateEditor(props: Readonly<{
  label: string;
  asset: { id: string; label: string; path: string };
  current: RuntimeAsset | null;
  disabled: boolean;
  onUpload(file: File): void;
  template: TemplateValue;
  onChange(dimension: TemplateDimension, value: string): void;
}>): React.JSX.Element {
  const bounds = templateBounds(props.template.physicalFootprint);
  const radius = props.template.touchArea.kind === "circle" ? props.template.touchArea.radius : 90;
  const touchBounds = props.template.touchArea.kind === "polygon" ? templateBounds(props.template.touchArea.points) : { width: radius * 2, height: radius * 2 };
  return <div className="greenhouse-template-editor" role="group" aria-label={`${props.label} template`}>
    <strong>{props.label}</strong>
    <AssetUpload asset={props.asset} current={props.current} disabled={props.disabled} onChange={props.onUpload} />
    <TemplatePivotEditor
      label={props.label}
      asset={props.current}
      renderWidth={props.template.renderWidth}
      renderHeight={props.template.renderHeight}
      pivotX={props.template.pivotX}
      pivotY={props.template.pivotY}
      disabled={props.disabled}
      onChange={(axis, value) => props.onChange(axis, value)}
    />
    <TemplateGeometryPreview label={props.label} template={props.template} />
    <div className="field-grid">
      <label>Render W <input type="number" min="1" value={Math.round(props.template.renderWidth)} disabled={props.disabled} onChange={(event) => props.onChange("renderWidth", event.target.value)} /></label>
      <label>Render H <input type="number" min="1" value={Math.round(props.template.renderHeight)} disabled={props.disabled} onChange={(event) => props.onChange("renderHeight", event.target.value)} /></label>
      <label>Footprint W <input type="number" min="1" value={Math.round(bounds.width)} disabled={props.disabled} onChange={(event) => props.onChange("width", event.target.value)} /></label>
      <label>Footprint H <input type="number" min="1" value={Math.round(bounds.height)} disabled={props.disabled} onChange={(event) => props.onChange("height", event.target.value)} /></label>
      <label>Anchor X <input type="number" min="0" max="1" step="0.01" value={props.template.pivotX} disabled={props.disabled} onChange={(event) => props.onChange("pivotX", event.target.value)} /></label>
      <label>Anchor Y <input type="number" min="0" max="1" step="0.01" value={props.template.pivotY} disabled={props.disabled} onChange={(event) => props.onChange("pivotY", event.target.value)} /></label>
      <label>Touch shape <select value={props.template.touchArea.kind === "circle" ? "circle" : "rectangle"} disabled={props.disabled} onChange={(event) => props.onChange("touchShape", event.target.value)}><option value="circle">Circle</option><option value="rectangle">Rectangle</option></select></label>
      {props.template.touchArea.kind === "circle" ? <label>Touch radius <input type="number" min="1" value={Math.round(radius)} disabled={props.disabled} onChange={(event) => props.onChange("touchRadius", event.target.value)} /></label> : <><label>Touch W <input type="number" min="1" value={Math.round(touchBounds.width)} disabled={props.disabled} onChange={(event) => props.onChange("touchWidth", event.target.value)} /></label><label>Touch H <input type="number" min="1" value={Math.round(touchBounds.height)} disabled={props.disabled} onChange={(event) => props.onChange("touchHeight", event.target.value)} /></label></>}
    </div>
  </div>;
}

export function PlantStageEditor(props: Readonly<{
  asset: { id: string; label: string; path: string; stage: number };
  current: RuntimeAsset | null;
  plotAsset: RuntimeAsset | null;
  plotTemplate: TemplateValue;
  stageArt: PlanterStageArt;
  disabled: boolean;
  onUpload(file: File): void;
  onChange(field: StageArtField, value: string): void;
}>): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const plotAnchorX = props.plotTemplate.pivotX * props.plotTemplate.renderWidth;
  const plotAnchorY = props.plotTemplate.pivotY * props.plotTemplate.renderHeight;
  const frame = plantStageArtFrame(props.plotTemplate, props.stageArt, plotAnchorX, plotAnchorY);
  const plantAnchorX = plotAnchorX + props.stageArt.offsetX;
  const plantAnchorY = plotAnchorY + props.stageArt.offsetY;
  const toPercentX = (value: number): string => `${value / props.plotTemplate.renderWidth * 100}%`;
  const toPercentY = (value: number): string => `${value / props.plotTemplate.renderHeight * 100}%`;
  const updateOffsetFromPointer = (clientX: number, clientY: number): void => {
    const bounds = previewRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const x = clamp((clientX - bounds.left) / bounds.width, 0, 1) * props.plotTemplate.renderWidth;
    const y = clamp((clientY - bounds.top) / bounds.height, 0, 1) * props.plotTemplate.renderHeight;
    props.onChange("offsetX", (x - plotAnchorX).toFixed(1));
    props.onChange("offsetY", (y - plotAnchorY).toFixed(1));
  };
  return <div className="greenhouse-plant-stage-card">
    <h3>{props.asset.label}</h3>
    <div
      ref={previewRef}
      className="greenhouse-plant-stage-preview"
      data-testid={`greenhouse-stage-preview-${props.asset.stage}`}
      aria-label={`Plant stage ${props.asset.stage} preview`}
      style={{ aspectRatio: `${props.plotTemplate.renderWidth} / ${props.plotTemplate.renderHeight}` }}
    >
      {props.plotAsset?.imageUrl
        ? <img className="greenhouse-plant-stage-plot" src={greenhouseAssetPreviewUrl(props.plotAsset)} alt="" />
        : <span className="greenhouse-plant-stage-plot-fallback">FARM PLOT</span>}
      {props.current?.imageUrl
        ? <img
          className="greenhouse-plant-stage-art"
          src={greenhouseAssetPreviewUrl(props.current)}
          alt=""
          style={{ left: toPercentX(frame.x), top: toPercentY(frame.y), width: toPercentX(frame.width), height: toPercentY(frame.height) }}
        />
        : <span className="greenhouse-plant-stage-art-fallback" style={{ left: toPercentX(frame.x), top: toPercentY(frame.y), width: toPercentX(frame.width), height: toPercentY(frame.height) }}>{`STAGE ${props.asset.stage}`}</span>}
      <span className="greenhouse-plant-stage-plot-anchor" style={{ left: toPercentX(plotAnchorX), top: toPercentY(plotAnchorY) }} aria-hidden="true" />
      <button
        type="button"
        className="greenhouse-plant-stage-anchor-handle"
        aria-label={`Plant stage ${props.asset.stage} image anchor`}
        disabled={props.disabled}
        style={{ left: toPercentX(plantAnchorX), top: toPercentY(plantAnchorY) }}
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          updateOffsetFromPointer(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => { if (draggingRef.current) updateOffsetFromPointer(event.clientX, event.clientY); }}
        onPointerUp={(event) => { draggingRef.current = false; event.currentTarget.releasePointerCapture?.(event.pointerId); }}
        onPointerCancel={() => { draggingRef.current = false; }}
        onClick={(event) => { event.stopPropagation(); updateOffsetFromPointer(event.clientX, event.clientY); }}
      ><span aria-hidden="true" /></button>
    </div>
    <p className="connection-copy">Yellow cross: Farm Plot anchor. White dot: plant image anchor. The plant has no touch area.</p>
    <AssetUpload asset={props.asset} current={props.current} disabled={props.disabled} onChange={props.onUpload} />
    <div className="field-grid greenhouse-plant-stage-fields">
      <label>Image anchor X <input type="number" min="0" max="1" step="0.01" value={props.stageArt.pivotX} disabled={props.disabled} onChange={(event) => props.onChange("pivotX", event.target.value)} /></label>
      <label>Image anchor Y <input type="number" min="0" max="1" step="0.01" value={props.stageArt.pivotY} disabled={props.disabled} onChange={(event) => props.onChange("pivotY", event.target.value)} /></label>
      <label>Offset X <input type="number" step="0.1" value={props.stageArt.offsetX} disabled={props.disabled} onChange={(event) => props.onChange("offsetX", event.target.value)} /></label>
      <label>Offset Y <input type="number" step="0.1" value={props.stageArt.offsetY} disabled={props.disabled} onChange={(event) => props.onChange("offsetY", event.target.value)} /></label>
      <label>Scale <input type="number" min="0.01" max="4" step="0.01" value={props.stageArt.scale} disabled={props.disabled} onChange={(event) => props.onChange("scale", event.target.value)} /></label>
    </div>
  </div>;
}

/**
 * The Greenhouse "Planters" inspector tab: both placement templates and the
 * plant stage art. Edits go through the callbacks (the Studio owns the draft,
 * history and save); PNG replacement is staged by the Studio.
 */
export function GreenhousePlantersPanel(props: Readonly<{
  pot: ViewPrefab;
  tank: ViewPrefab | null;
  stageArt: readonly PlanterStageArt[];
  capacity: number | null;
  assets: readonly RuntimeAsset[];
  disabled: boolean;
  onEditPrefab(prefabId: string, edit: (prefab: ViewPrefab) => void): void;
  onEditStageArt(edit: (art: PlanterStageArt[]) => void): void;
  /** Stages a replacement PNG for a runtime asset key; resolves true when it was staged. */
  onReplacePng(assetKey: string, file: File): Promise<boolean>;
}>): React.JSX.Element {
  const [selectedPlantId, setSelectedPlantId] = useState<GreenhousePlantId>("wheat");
  const [selectedStage, setSelectedStage] = useState<1 | 2 | 3 | 4>(1);
  // A pivot the author moved off center keeps its manual value when template art is replaced.
  const pivotOverridesRef = useRef<Set<string>>(new Set([props.pot, props.tank].flatMap((prefab) => prefab && (prefab.pivotX !== 0.5 || prefab.pivotY !== 0.5) ? [prefab.id] : [])));
  const currentAsset = (id: string): RuntimeAsset | null => props.assets.find((asset) => asset.id === id) ?? null;
  const changeTemplate = (prefab: ViewPrefab, dimension: TemplateDimension, value: string): void => {
    if (dimension === "pivotX" || dimension === "pivotY") pivotOverridesRef.current.add(prefab.id);
    props.onEditPrefab(prefab.id, (draft) => applyTemplateChange(draft, dimension, value));
  };
  const replaceTemplatePng = async (prefab: ViewPrefab, file: File): Promise<void> => {
    const estimated = pivotOverridesRef.current.has(prefab.id) ? null : await greenhousePngFilePivot(file);
    const staged = await props.onReplacePng(prefab.assetKey, file);
    if (staged && estimated) props.onEditPrefab(prefab.id, (draft) => { draft.pivotX = estimated.x; draft.pivotY = estimated.y; });
  };
  const plant = GREENHOUSE_PLANT_DEFINITIONS.find((candidate) => candidate.id === selectedPlantId) ?? GREENHOUSE_PLANT_DEFINITIONS[0];
  const stageEntry = plant.stages[selectedStage - 1] ?? plant.stages[0];
  const selectedStageArt = props.stageArt.find((art) => art.cropId === plant.id && art.stage === selectedStage) ?? null;
  const potTemplate = templateFromPrefab(props.pot);
  const templates: Array<{ label: string; asset: { id: string; label: string; path: string }; prefab: ViewPrefab }> = [
    { label: "Farm Plot", asset: { id: "greenhouse-pot", label: "Farm Plot PNG", path: props.pot.assetKey }, prefab: props.pot },
    ...(props.tank ? [{ label: "Water tank", asset: { id: "greenhouse-water-tank", label: "Tank PNG", path: props.tank.assetKey }, prefab: props.tank }] : [])
  ];
  return <section className="greenhouse-planters-panel" aria-label="Greenhouse planters">
    <fieldset className="greenhouse-template-tools"><legend>Placement templates</legend>
      {props.capacity !== null ? <p className="status-copy">Farm Plot capacity: {props.capacity} plots</p> : null}
      <p className="connection-copy">The physical footprint stays centered on the anchor as its width and height change. The image-local anchor marks the room placement point; the touch area stays around that point. A PNG upload auto-centers the anchor on visible art when available; dragging or editing Anchor X/Y keeps your manual override.</p>
      {templates.map(({ label, asset, prefab }) => <TemplateEditor key={prefab.id} label={label} asset={asset} current={currentAsset(prefab.assetKey)} disabled={props.disabled} onUpload={(file) => void replaceTemplatePng(prefab, file)} template={templateFromPrefab(prefab)} onChange={(dimension, value) => changeTemplate(prefab, dimension, value)} />)}
    </fieldset>
    <fieldset className="greenhouse-plant-art-grid"><legend>Plant stage art</legend>
      <p className="connection-copy">Select a plant, then choose one stage to preview and author on the current Farm Plot render frame. Plant art has no separate touch area: its anchor and offsets only control how it sits on the plot anchor.</p>
      <div className="greenhouse-plant-selection">
        <label className="greenhouse-plant-selector">Plant<select aria-label="Plant to author" value={plant.id} disabled={props.disabled} onChange={(event) => { setSelectedPlantId(event.target.value as GreenhousePlantId); setSelectedStage(1); }}>{GREENHOUSE_PLANT_DEFINITIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
        <div className="greenhouse-plant-stage-picker" role="group" aria-label={`${plant.label} stages`}><span className="field-label">Stage</span>{plant.stages.map((stage, index) => { const number = (index + 1) as 1 | 2 | 3 | 4; return <button key={stage.path} type="button" aria-pressed={selectedStage === number} className={selectedStage === number ? "active" : ""} disabled={props.disabled} onClick={() => setSelectedStage(number)}>{stage.label}</button>; })}</div>
      </div>
      {selectedStageArt ? <PlantStageEditor asset={{ id: `${plant.id}-${selectedStage}`, label: `${plant.label} · ${stageEntry.label}`, path: selectedStageArt.assetKey, stage: selectedStage }} current={currentAsset(selectedStageArt.assetKey)} plotAsset={currentAsset(props.pot.assetKey)} plotTemplate={potTemplate} stageArt={selectedStageArt} disabled={props.disabled} onUpload={(file) => void props.onReplacePng(selectedStageArt.assetKey, file)} onChange={(field, value) => props.onEditStageArt((art) => applyStageArtChange(art, plant.id, selectedStage, field, value))} /> : <p className="empty-copy">This greenhouse has no stage art for {plant.label} stage {selectedStage}.</p>}
    </fieldset>
  </section>;
}
