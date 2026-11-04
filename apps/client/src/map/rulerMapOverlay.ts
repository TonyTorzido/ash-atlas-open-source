import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import type { PlanningAnchor, PlanningAnchorSource } from "./planningAnchors.js";
import { formatRulerDistance, type RulerLine, type RulerState } from "./rulerState.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type RulerMapOverlay = {
  update(
    state: RulerState,
    preview: LatLon | null,
    planningLines?: readonly RulerLine[],
    planningPreview?: RulerLine | null,
    planningSource?: PlanningAnchorSource | null,
    planningSourceDistanceM?: number | null,
    planningAnchors?: readonly PlanningAnchor[],
    planningFreehandLines?: readonly RulerLine[],
    planningFreehandPreview?: RulerLine | null
  ): void;
  destroy(): void;
};

export function mountRulerMapOverlay(map: maplibregl.Map): RulerMapOverlay {
  const root = document.createElement("div");
  root.className = "ruler-map-overlay";
  root.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("focusable", "false");
  root.append(svg);
  map.getCanvasContainer().append(root);

  let state: RulerState = { pending: null, lines: [] };
  let preview: LatLon | null = null;
  let planningLines: readonly RulerLine[] = [];
  let planningPreview: RulerLine | null = null;
  let planningSource: PlanningAnchorSource | null = null;
  let planningSourceDistanceM: number | null = null;
  let planningAnchors: readonly PlanningAnchor[] = [];
  let planningFreehandLines: readonly RulerLine[] = [];
  let planningFreehandPreview: RulerLine | null = null;

  const render = (): void => {
    const container = map.getContainer();
    const bounds = container.getBoundingClientRect();
    const width = bounds.width || container.clientWidth;
    const height = bounds.height || container.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const fragment = document.createDocumentFragment();
    for (const line of state.lines) appendLine(fragment, map, line);
    for (const line of planningLines) appendLine(fragment, map, line, "ruler-map-line planning-anchor-line");
    for (const line of planningFreehandLines) appendFreehandLine(fragment, map, line);
    if (planningSource) appendSource(fragment, map, planningSource, planningSourceDistanceM);
    else for (const anchor of planningAnchors) {
      appendSource(fragment, map, anchor.source, anchor.distanceM);
    }
    planningAnchors.forEach((anchor, index) => appendPlanningAnchorMarker(fragment, map, anchor, index));
    if (planningPreview) {
      appendLine(fragment, map, planningPreview, "ruler-map-line planning-anchor-preview");
    }
    if (planningFreehandPreview) appendFreehandLine(fragment, map, planningFreehandPreview, "ruler-map-line planning-pencil-preview");
    if (state.pending && preview) {
      appendLine(fragment, map, {
        start: state.pending,
        end: preview,
        distanceM: distanceMeters(state.pending, preview)
      });
    } else if (state.pending) {
      appendPoint(fragment, map, state.pending);
    }
    svg.replaceChildren(fragment);
  };

  map.on("render", render);
  render();

  return {
    update(
      nextState,
      nextPreview,
      nextPlanningLines = [],
      nextPlanningPreview = null,
      nextPlanningSource = null,
      nextPlanningSourceDistanceM = null,
      nextPlanningAnchors = [],
      nextPlanningFreehandLines = [],
      nextPlanningFreehandPreview = null
    ): void {
      state = nextState;
      preview = nextPreview;
      planningLines = nextPlanningLines;
      planningPreview = nextPlanningPreview;
      planningSource = nextPlanningSource;
      planningSourceDistanceM = nextPlanningSourceDistanceM;
      planningAnchors = nextPlanningAnchors;
      planningFreehandLines = nextPlanningFreehandLines;
      planningFreehandPreview = nextPlanningFreehandPreview;
      render();
    },
    destroy(): void {
      map.off("render", render);
      root.remove();
    }
  };
}

function appendLine(
  fragment: DocumentFragment,
  map: maplibregl.Map,
  line: RulerLine,
  className = "ruler-map-line"
): void {
  const start = map.project([line.start.lon, line.start.lat]);
  const end = map.project([line.end.lon, line.end.lat]);
  const segment = document.createElementNS(SVG_NAMESPACE, "line");
  segment.setAttribute("class", className);
  segment.setAttribute("x1", String(start.x));
  segment.setAttribute("y1", String(start.y));
  segment.setAttribute("x2", String(end.x));
  segment.setAttribute("y2", String(end.y));
  fragment.append(segment);
  appendPoint(fragment, map, line.start);
  appendPoint(fragment, map, line.end);

  const label = document.createElementNS(SVG_NAMESPACE, "text");
  label.setAttribute("class", "ruler-map-label");
  label.setAttribute("x", String((start.x + end.x) / 2));
  label.setAttribute("y", String((start.y + end.y) / 2 - 8));
  label.textContent = formatRulerDistance(line.distanceM);
  fragment.append(label);
}

function appendPoint(
  fragment: DocumentFragment,
  map: maplibregl.Map,
  point: LatLon
): void {
  const projected = map.project([point.lon, point.lat]);
  const dot = document.createElementNS(SVG_NAMESPACE, "circle");
  dot.setAttribute("class", "ruler-map-point");
  dot.setAttribute("cx", String(projected.x));
  dot.setAttribute("cy", String(projected.y));
  dot.setAttribute("r", "5");
  fragment.append(dot);
}

function appendFreehandLine(
  fragment: DocumentFragment,
  map: maplibregl.Map,
  line: RulerLine,
  className = "ruler-map-line planning-pencil-line"
): void {
  const start = map.project([line.start.lon, line.start.lat]);
  const end = map.project([line.end.lon, line.end.lat]);
  const segment = document.createElementNS(SVG_NAMESPACE, "line");
  segment.setAttribute("class", className);
  segment.setAttribute("x1", String(start.x));
  segment.setAttribute("y1", String(start.y));
  segment.setAttribute("x2", String(end.x));
  segment.setAttribute("y2", String(end.y));
  fragment.append(segment);
}

function appendSource(
  fragment: DocumentFragment,
  map: maplibregl.Map,
  source: PlanningAnchorSource,
  distanceM: number | null
): void {
  const projected = map.project([source.position.lon, source.position.lat]);
  if (distanceM !== null && Number.isFinite(distanceM) && distanceM > 0) {
    const edge = destinationPoint(source.position, distanceM, 90);
    const edgeProjected = map.project([edge.lon, edge.lat]);
    const circle = document.createElementNS(SVG_NAMESPACE, "circle");
    circle.setAttribute("class", "planning-anchor-source-circle");
    circle.setAttribute("cx", String(projected.x));
    circle.setAttribute("cy", String(projected.y));
    circle.setAttribute("r", String(Math.max(8, Math.hypot(edgeProjected.x - projected.x, edgeProjected.y - projected.y))));
    fragment.append(circle);
  }
  const dot = document.createElementNS(SVG_NAMESPACE, "circle");
  dot.setAttribute("class", "planning-anchor-source-dot");
  dot.setAttribute("cx", String(projected.x));
  dot.setAttribute("cy", String(projected.y));
  dot.setAttribute("r", "6");
  fragment.append(dot);
}

function appendPlanningAnchorMarker(
  fragment: DocumentFragment,
  map: maplibregl.Map,
  anchor: PlanningAnchor,
  fallbackNumber: number
): void {
  const projected = map.project([anchor.position.lon, anchor.position.lat]);
  const marker = document.createElementNS(SVG_NAMESPACE, "circle");
  marker.setAttribute("class", "planning-anchor-marker");
  marker.setAttribute("cx", String(projected.x));
  marker.setAttribute("cy", String(projected.y));
  marker.setAttribute("r", "7");
  fragment.append(marker);

  const label = document.createElementNS(SVG_NAMESPACE, "text");
  label.setAttribute("class", "planning-anchor-marker-label");
  label.setAttribute("x", String(projected.x + 10));
  label.setAttribute("y", String(projected.y - 10));
  label.textContent = `Anchor ${anchor.number ?? fallbackNumber + 1}`;
  fragment.append(label);
}
