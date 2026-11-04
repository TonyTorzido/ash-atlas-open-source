import type { LatLon } from "@ash-atlas/shared";

export const DEFAULT_PLANNING_ANCHOR_LAYER_ID = "main";
export const MAX_PLANNING_ANCHOR_DISTANCE_M = 100_000;
export const MAX_PLANNING_ANCHOR_LAYERS = 3;

export type PlanningAnchorSourceKind = "flag" | "city" | "city_structure" | "planning_anchor";

export type PlanningAnchorSource = Readonly<{
  kind: PlanningAnchorSourceKind;
  id: string;
  label: string;
  position: LatLon;
}>;

export type PlanningAnchorLayer = Readonly<{
  id: string;
  name: string;
  visible: boolean;
}>;

export type PlanningAnchor = Readonly<{
  id: string;
  layerId: string;
  /** Stable, human-facing number within the layer. Older records are normalized into one. */
  number?: number;
  source: PlanningAnchorSource;
  distanceM: number;
  position: LatLon;
  createdAt: number;
}>;

export type PlanningAnchorsState = Readonly<{
  layers: readonly PlanningAnchorLayer[];
  selectedLayerId: string;
  anchors: readonly PlanningAnchor[];
}>;

export const EMPTY_PLANNING_ANCHORS: PlanningAnchorsState = Object.freeze({
  layers: Object.freeze([
    Object.freeze({
      id: DEFAULT_PLANNING_ANCHOR_LAYER_ID,
      name: "Main",
      visible: true
    })
  ]),
  selectedLayerId: DEFAULT_PLANNING_ANCHOR_LAYER_ID,
  anchors: Object.freeze([])
});

export function validatePlanningAnchorDistance(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PLANNING_ANCHOR_DISTANCE_M) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

export function readPlanningAnchors(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string
): PlanningAnchorsState {
  if (!storage) return EMPTY_PLANNING_ANCHORS;
  try {
    const raw = storage.getItem(key);
    if (!raw) return EMPTY_PLANNING_ANCHORS;
    return normalizePlanningAnchors(JSON.parse(raw) as unknown);
  } catch {
    return EMPTY_PLANNING_ANCHORS;
  }
}

export function writePlanningAnchors(
  storage: Pick<Storage, "setItem"> | null | undefined,
  key: string,
  state: PlanningAnchorsState
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in private browsing or a constrained WebView.
  }
}

export function addPlanningAnchor(
  state: PlanningAnchorsState,
  input: Readonly<{
    source: PlanningAnchorSource;
    distanceM: number;
    position: LatLon;
    layerId?: string;
    number?: number;
    id?: string;
    createdAt?: number;
  }>
): PlanningAnchorsState {
  const distanceM = validatePlanningAnchorDistance(input.distanceM);
  if (
    distanceM === null ||
    !validPosition(input.position) ||
    !validSource(input.source)
  ) return state;
  const layerId = state.layers.some((layer) => layer.id === input.layerId)
    ? input.layerId!
    : state.selectedLayerId;
  return {
    ...state,
    anchors: [
      ...state.anchors,
      {
        id: input.id ?? createAnchorId(),
        layerId,
        number: input.number ?? nextLayerAnchorNumber(state.anchors, layerId),
        source: {
          kind: input.source.kind,
          id: input.source.id,
          label: input.source.label,
          position: { lat: input.source.position.lat, lon: input.source.position.lon }
        },
        distanceM,
        position: { lat: input.position.lat, lon: input.position.lon },
        createdAt: Number.isFinite(input.createdAt) ? input.createdAt! : Date.now()
      }
    ]
  };
}

export function removePlanningAnchor(
  state: PlanningAnchorsState,
  anchorId: string
): PlanningAnchorsState {
  const anchors = state.anchors.filter((anchor) => anchor.id !== anchorId);
  return anchors.length === state.anchors.length ? state : { ...state, anchors };
}

export function clearPlanningAnchorLayer(
  state: PlanningAnchorsState,
  layerId = state.selectedLayerId
): PlanningAnchorsState {
  if (!state.layers.some((layer) => layer.id === layerId)) return state;
  const anchors = state.anchors.filter((anchor) => anchor.layerId !== layerId);
  return anchors.length === state.anchors.length ? state : { ...state, anchors };
}

export function selectPlanningAnchorLayer(
  state: PlanningAnchorsState,
  layerId: string
): PlanningAnchorsState {
  return state.layers.some((layer) => layer.id === layerId)
    ? { ...state, selectedLayerId: layerId }
    : state;
}

export function setPlanningAnchorLayerVisibility(
  state: PlanningAnchorsState,
  layerId: string,
  visible: boolean
): PlanningAnchorsState {
  if (!state.layers.some((layer) => layer.id === layerId)) return state;
  return {
    ...state,
    layers: state.layers.map((layer) =>
      layer.id === layerId ? { ...layer, visible } : layer
    )
  };
}

export function addPlanningAnchorLayer(
  state: PlanningAnchorsState,
  name: string,
  id = createLayerId()
): PlanningAnchorsState {
  const normalizedName = name.trim().slice(0, 48);
  if (
    !normalizedName ||
    state.layers.length >= MAX_PLANNING_ANCHOR_LAYERS ||
    state.layers.some((layer) => layer.id === id)
  ) return state;
  return {
    ...state,
    // A newly selected layer is the only visible layer by default. Players
    // can opt other layers back in from the visibility list.
    layers: [
      ...state.layers.map((layer) => ({ ...layer, visible: false })),
      { id, name: normalizedName, visible: true }
    ],
    selectedLayerId: id
  };
}

function normalizePlanningAnchors(value: unknown): PlanningAnchorsState {
  if (!value || typeof value !== "object") return EMPTY_PLANNING_ANCHORS;
  const record = value as Record<string, unknown>;
  const layers = Array.isArray(record.layers)
    ? record.layers.map(normalizeLayer).filter((layer): layer is PlanningAnchorLayer => layer !== null)
    : [];
  const uniqueLayers = dedupeById(layers);
  const safeLayers = (uniqueLayers.length > 0 ? uniqueLayers : [...EMPTY_PLANNING_ANCHORS.layers])
    .slice(0, MAX_PLANNING_ANCHOR_LAYERS);
  const layerIds = new Set(safeLayers.map((layer) => layer.id));
  const anchors = Array.isArray(record.anchors)
    ? record.anchors
      .map((anchor) => normalizeAnchor(anchor, layerIds))
      .filter((anchor): anchor is PlanningAnchor => anchor !== null)
    : [];
  const selectedLayerId = typeof record.selectedLayerId === "string" && layerIds.has(record.selectedLayerId)
    ? record.selectedLayerId
    : safeLayers[0]!.id;
  return {
    layers: safeLayers,
    selectedLayerId,
    anchors: assignMissingAnchorNumbers(dedupeById(anchors))
  };
}

function normalizeLayer(value: unknown): PlanningAnchorLayer | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.name !== "string") return null;
  return { id: record.id.slice(0, 80), name: record.name.trim().slice(0, 48) || "Layer", visible: record.visible !== false };
}

function normalizeAnchor(value: unknown, layerIds: ReadonlySet<string>): PlanningAnchor | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const source = normalizeSource(record.source);
  const position = normalizePosition(record.position);
  const distanceM = typeof record.distanceM === "number"
    ? validatePlanningAnchorDistance(record.distanceM)
    : null;
  if (
    typeof record.id !== "string" || !record.id ||
    typeof record.layerId !== "string" || !layerIds.has(record.layerId) ||
    !source || !position || distanceM === null
  ) return null;
  return {
    id: record.id.slice(0, 100),
    layerId: record.layerId,
    ...(validAnchorNumber(record.number) ? { number: record.number } : {}),
    source,
    distanceM,
    position,
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now()
  };
}

function normalizeSource(value: unknown): PlanningAnchorSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== "flag" && record.kind !== "city" && record.kind !== "city_structure" && record.kind !== "planning_anchor") ||
    typeof record.id !== "string" ||
    typeof record.label !== "string"
  ) return null;
  const position = normalizePosition(record.position);
  return position
    ? { kind: record.kind, id: record.id.slice(0, 100), label: record.label.slice(0, 120), position }
    : null;
}

function normalizePosition(value: unknown): LatLon | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const lat = typeof record.lat === "number" ? record.lat : NaN;
  const lon = typeof record.lon === "number" ? record.lon : NaN;
  return validPosition({ lat, lon }) ? { lat, lon } : null;
}

function validPosition(position: LatLon): boolean {
  return Number.isFinite(position.lat) && Number.isFinite(position.lon) &&
    position.lat >= -90 && position.lat <= 90 &&
    position.lon >= -180 && position.lon <= 180;
}

function validSource(source: PlanningAnchorSource): boolean {
  return Boolean(source.id && source.label && validPosition(source.position));
}

function validAnchorNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

function nextLayerAnchorNumber(anchors: readonly PlanningAnchor[], layerId: string): number {
  let next = 1;
  for (const anchor of anchors) {
    if (anchor.layerId !== layerId || !validAnchorNumber(anchor.number)) continue;
    next = Math.max(next, anchor.number + 1);
  }
  return next;
}

function assignMissingAnchorNumbers(anchors: readonly PlanningAnchor[]): PlanningAnchor[] {
  const usedByLayer = new Map<string, Set<number>>();
  const nextByLayer = new Map<string, number>();
  return anchors.map((anchor) => {
    const used = usedByLayer.get(anchor.layerId) ?? new Set<number>();
    usedByLayer.set(anchor.layerId, used);
    let number = validAnchorNumber(anchor.number) ? anchor.number : undefined;
    if (number === undefined || used.has(number)) {
      number = nextByLayer.get(anchor.layerId) ?? 1;
      while (used.has(number)) number += 1;
    }
    used.add(number);
    nextByLayer.set(anchor.layerId, Math.max(nextByLayer.get(anchor.layerId) ?? 1, number + 1));
    return number === anchor.number ? anchor : { ...anchor, number };
  });
}

function dedupeById<T extends Readonly<{ id: string }>>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function createAnchorId(): string {
  return `anchor-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function createLayerId(): string {
  return `layer-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
