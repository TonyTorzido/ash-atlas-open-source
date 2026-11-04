import {
  GREENHOUSE_FARM_PLOT_PLACEMENT_COST,
  GREENHOUSE_POT_ASSET_PATH,
  GREENHOUSE_DOOR_ASSET_PATH,
  GREENHOUSE_GARDENING_BUCKET_CAPACITY_TENTHS,
  GREENHOUSE_CLIPPING_ACTION_DURATION_MS,
  GREENHOUSE_INTERACTION_APPROACH_INSET,
  GREENHOUSE_PLANT_ACTION_DURATION_MS,
  GREENHOUSE_PLANT_AND_WATER_ACTION_DURATION_MS,
  GREENHOUSE_PLANTER_INTERACTION_RADIUS,
  GREENHOUSE_WATER_ACTION_DURATION_MS,
  GREENHOUSE_ROOM_HEIGHT,
  GREENHOUSE_ROOM_WIDTH,
  GREENHOUSE_GIVING_BERRY_TREE_CROP_ID,
  GREENHOUSE_TANK_CAPACITY_TENTHS,
  GREENHOUSE_STUDIO_CATALOG,
  GREENHOUSE_TANK_INTERACTION_RADIUS,
  STANDARD_INDOOR_SPATIAL_PROFILE,
  greenhousePlacementIssue,
  resolveGreenhousePlacementPosition,
  greenhousePlantStageArtFrame,
  greenhouseTemplateFootprint,
  greenhouseTemplateImageFrame,
  greenhouseTemplateTouchContainsPoint,
  greenhouseTemplateTouchBounds,
  type GreenhousePlacementKind,
  indoorInteractionApproachPoint,
  isIndoorInteractionInRange,
  type GreenhouseAnchorSnapshot,
  type GreenhouseCropCatalogEntrySnapshot,
  type GreenhouseStateSnapshot,
  type IndoorPoint,
  type PlayerAppearanceSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useIndoorMovementInput } from "../movement/indoorMovementInput.js";
import type { GreenhouseMovementTimeline } from "../movement/greenhouseMovementTimeline.js";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { MaterialChips } from "./MaterialRequirements.js";
import { GameTargetPicker, type GameTargetChoice } from "./GameTargetPicker.js";
import { GreenhousePlayerLayer } from "./GreenhousePlayerLayer.js";
import { IndoorSceneStage } from "./IndoorSceneStage.js";
import { IndoorSceneViewport } from "./IndoorSceneViewport.js";
import {
  clampIndoorZoom,
  indoorPinchZoom,
  indoorWheelZoom,
  type IndoorZoomLimits
} from "./dungeonZoom.js";
import { type ManorCameraBounds, type ManorCameraPan } from "./manorCamera.js";
import {
  runtimePngAssetUrl,
  selectedRuntimePngContentPack
} from "../map/runtimePngAssetUrl.js";
import {
  greenhouseCropStageArt,
  type GreenhouseCropStageArt,
  type GreenhouseMapPlacementPreview
} from "../features/interiorMap/greenhouseMapInterior.js";
import type {
  GreenhousePositionSnapshot
} from "../features/greenhouse/useGreenhouseFeature.js";

const ROOM_WIDTH = GREENHOUSE_ROOM_WIDTH;
const ROOM_HEIGHT = GREENHOUSE_ROOM_HEIGHT;
const GREENHOUSE_CAMERA_OVERSCROLL = 0.25;

/**
 * Greenhouse-only camera bounds: retain the Manor fitted-room clamp, while
 * allowing a small amount of empty space around the authored room at the
 * greenhouse's higher zoom levels. Manor and other interiors keep their
 * stricter shared bounds.
 */
function clampGreenhouseCameraPan(pan: ManorCameraPan, bounds: ManorCameraBounds): ManorCameraPan {
  if (!Number.isFinite(bounds.roomWidth) || !Number.isFinite(bounds.roomHeight) ||
      !Number.isFinite(bounds.viewportWidth) || !Number.isFinite(bounds.viewportHeight) ||
      !Number.isFinite(bounds.zoom) || bounds.roomWidth <= 0 || bounds.roomHeight <= 0 ||
      bounds.viewportWidth <= 0 || bounds.viewportHeight <= 0 || bounds.zoom <= 0) {
    return { x: 0, y: 0 };
  }
  const fittedScale = Math.min(bounds.viewportWidth / bounds.roomWidth, bounds.viewportHeight / bounds.roomHeight);
  const renderedWidth = bounds.roomWidth * fittedScale * bounds.zoom;
  const renderedHeight = bounds.roomHeight * fittedScale * bounds.zoom;
  const maxX = Math.max(0, (renderedWidth - bounds.viewportWidth) / 2) + bounds.viewportWidth * GREENHOUSE_CAMERA_OVERSCROLL;
  const maxY = Math.max(0, (renderedHeight - bounds.viewportHeight) / 2) + bounds.viewportHeight * GREENHOUSE_CAMERA_OVERSCROLL;
  const finite = (value: number): number => Number.isFinite(value) ? value : 0;
  return {
    x: Math.min(maxX, Math.max(-maxX, finite(pan.x))),
    y: Math.min(maxY, Math.max(-maxY, finite(pan.y)))
  };
}

function greenhousePolygonPoints(points: readonly { x: number; y: number }[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function greenhouseExitTouchBounds(area: Readonly<{ kind: "circle"; radius: number } | { kind: "polygon"; points: readonly { x: number; y: number }[] }>): { minX: number; minY: number; maxX: number; maxY: number } {
  if (area.kind === "circle") return { minX: ROOM_WIDTH / 2 - area.radius, minY: ROOM_HEIGHT - area.radius, maxX: ROOM_WIDTH / 2 + area.radius, maxY: ROOM_HEIGHT + area.radius };
  const xs = area.points.map((point) => point.x);
  const ys = area.points.map((point) => point.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

type PlanterActionKind = "plant" | "plant-and-water" | "water" | "clip" | "harvest" | "tap";
type PendingPlanterAction = Readonly<{ anchorId: string; kind: PlanterActionKind; cropId?: string }>;
type ActivePlanterAction = Readonly<PendingPlanterAction & { startedAt: number; durationMs: number }>;
type GreenhouseCameraGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
};
export type GreenhousePlanterActionState = Readonly<{
  label: string;
  startedAt: number;
  durationMs: number;
}>;

export function GreenhouseScene({
  state,
  timeline,
  displayColor,
  appearance,
  position,
  disabled,
  movementDisabled,
  onMove,
  onPlant,
  onPlantAndWater,
  onWater,
  onClip,
  onHarvest,
  onTapTree,
  onPlace,
  onDepositWater,
  onRefillGardeningBucket,
  onPlanterActionChange,
  synchronizedNow,
  onExit,
  inventory,
  mapRendered = false,
  mapPickRef,
  screenToLocal,
  onPlacementPreviewChange
}: Readonly<{
  state: GreenhouseStateSnapshot;
  timeline: GreenhouseMovementTimeline;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
  position: GreenhousePositionSnapshot | null;
  disabled: boolean;
  movementDisabled: boolean;
  onMove(x: number, y: number): void;
  onPlant(anchorId: string, cropId: string): void;
  onPlantAndWater(anchorId: string, cropId: string): void;
  onWater(anchorId: string): void;
  onClip(anchorId: string): void;
  onHarvest(anchorId: string): void;
  onTapTree?(anchorId: string): void;
  onPlace?(kind: GreenhousePlacementKind, x: number, y: number, anchorId?: string): void;
  onDepositWater(): void;
  onRefillGardeningBucket(): void;
  onPlanterActionChange(action: GreenhousePlanterActionState | null): void;
  synchronizedNow(): number;
  onExit(): void;
  inventory?: PlayerInventorySnapshot;
  /** The map renderer draws the room; the scene keeps the HUD, prompts and placement pointer surface. */
  mapRendered?: boolean;
  /** Map taps in room units: selects the plot/tank/exit there, true when something was hit. */
  mapPickRef?: MutableRefObject<((local: IndoorPoint) => boolean) | null>;
  /** Screen point to room units (map-rendered placement). */
  screenToLocal?(clientX: number, clientY: number): IndoorPoint | null;
  /** The live placement preview, drawn by the map renderer. */
  onPlacementPreviewChange?(preview: GreenhouseMapPlacementPreview | null): void;
}>): React.JSX.Element {
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);
  const [tankSelected, setTankSelected] = useState(false);
  const [targetChoices, setTargetChoices] = useState<readonly GameTargetChoice[] | null>(null);
  const [selfSelected, setSelfSelected] = useState(false);
  const [pendingTankAction, setPendingTankAction] = useState<"deposit" | "refill" | null>(null);
  const [pendingPlanterAction, setPendingPlanterAction] = useState<PendingPlanterAction | null>(null);
  const [activePlanterAction, setActivePlanterAction] = useState<ActivePlanterAction | null>(null);
  const [placementMode, setPlacementMode] = useState<{ kind: GreenhousePlacementKind; anchorId?: string } | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<{ kind: GreenhousePlacementKind; anchorId?: string; x: number; y: number } | null>(null);
  const [placementPreview, setPlacementPreview] = useState<{ x: number; y: number } | null>(null);
  const [greenhouseNow, setGreenhouseNow] = useState(() => synchronizedNow());
  const greenhouseZoomLimits: IndoorZoomLimits = { minZoom: 1, defaultZoom: 1, maxZoom: 4 };
  const [zoom, setZoom] = useState(greenhouseZoomLimits.defaultZoom);
  const zoomRef = useRef(greenhouseZoomLimits.defaultZoom);
  const [cameraPan, setCameraPan] = useState<ManorCameraPan>({ x: 0, y: 0 });
  const cameraPanRef = useRef<ManorCameraPan>({ x: 0, y: 0 });
  const cameraGestureRef = useRef<GreenhouseCameraGesture | null>(null);
  const touchPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const pinchSuppressClicksUntilRef = useRef(0);
  const pointerGestureSuppressedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const stageShellRef = useRef<HTMLDivElement>(null);
  const movementInput = useIndoorMovementInput({
    stageRef,
    roomWidth: ROOM_WIDTH,
    roomHeight: ROOM_HEIGHT,
    movementDisabled: disabled || movementDisabled,
    useTransformedBounds: true,
    pointerGestureSuppressedRef,
    onBeforeMove: () => {
      setSelectedAnchor(null);
      setTankSelected(false);
      setTargetChoices(null);
      setSelfSelected(false);
      setPendingTankAction(null);
      setPendingPlanterAction(null);
      setActivePlanterAction(null);
      setPlacementMode(null);
      setPendingPlacement(null);
      setPlacementPreview(null);
    },
    onMove
  });
  const applyZoom = (nextZoom: number): void => {
    const clamped = clampIndoorZoom(nextZoom, greenhouseZoomLimits);
    zoomRef.current = clamped;
    setZoom(clamped);
    const bounds = stageShellRef.current?.getBoundingClientRect();
    const clampedPan = clampGreenhouseCameraPan(cameraPanRef.current, {
      roomWidth: ROOM_WIDTH,
      roomHeight: ROOM_HEIGHT,
      viewportWidth: bounds?.width ?? 0,
      viewportHeight: bounds?.height ?? 0,
      zoom: clamped
    });
    cameraPanRef.current = clampedPan;
    setCameraPan(clampedPan);
  };
  const resetView = (): void => {
    zoomRef.current = greenhouseZoomLimits.defaultZoom;
    cameraPanRef.current = { x: 0, y: 0 };
    setZoom(greenhouseZoomLimits.defaultZoom);
    setCameraPan({ x: 0, y: 0 });
  };
  const setClampedCameraPan = (nextPan: ManorCameraPan): void => {
    const bounds = stageShellRef.current?.getBoundingClientRect();
    const clamped = clampGreenhouseCameraPan(nextPan, {
      roomWidth: ROOM_WIDTH,
      roomHeight: ROOM_HEIGHT,
      viewportWidth: bounds?.width ?? 0,
      viewportHeight: bounds?.height ?? 0,
      zoom: zoomRef.current
    });
    cameraPanRef.current = clamped;
    setCameraPan((current) => current.x === clamped.x && current.y === clamped.y ? current : clamped);
  };
  const beginCameraPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as Element | null;
    if (disabled || movementDisabled || event.button !== 0 || !Number.isFinite(event.pointerId) ||
        placementMode !== null || (target?.closest("button") && !target.closest(".greenhouse-self"))) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    cameraGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false
    };
  };
  const moveCameraPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = cameraGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.lastX;
    const deltaY = event.clientY - gesture.lastY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (!gesture.active && zoomRef.current > greenhouseZoomLimits.minZoom && Math.hypot(
      event.clientX - gesture.startX,
      event.clientY - gesture.startY
    ) > 2) {
      gesture.active = true;
      pointerGestureSuppressedRef.current = true;
      movementInput.clearPendingMovement();
    }
    if (!gesture.active) return;
    event.preventDefault();
    event.stopPropagation();
    setClampedCameraPan({ x: cameraPanRef.current.x + deltaX, y: cameraPanRef.current.y + deltaY });
  };
  const finishCameraPointer = (pointerId: number): boolean => {
    const gesture = cameraGestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return false;
    cameraGestureRef.current = null;
    return gesture.active;
  };
  const handleZoomPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== "touch") return;
    touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchPointersRef.current.size !== 2) return;
    const points = [...touchPointersRef.current.values()];
    const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
    if (distance <= 0) return;
    pointerGestureSuppressedRef.current = true;
    pinchRef.current = { distance, zoom: zoomRef.current };
    movementInput.clearPendingMovement();
    event.preventDefault();
    cameraGestureRef.current = null;
    return;
  };
  const handleStagePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    handleZoomPointerDown(event);
    if (!pinchRef.current && !pointerGestureSuppressedRef.current) beginCameraPointer(event);
  };
  const handleZoomPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== "touch" || !touchPointersRef.current.has(event.pointerId)) {
      moveCameraPointer(event);
      return;
    }
    touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (!pinch || touchPointersRef.current.size !== 2) {
      moveCameraPointer(event);
      return;
    }
    const points = [...touchPointersRef.current.values()];
    const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
    if (distance <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    applyZoom(indoorPinchZoom(pinch.zoom, pinch.distance, distance, greenhouseZoomLimits));
    return;
  };
  const handleZoomPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== "touch") {
      cameraGestureRef.current = null;
      pointerGestureSuppressedRef.current = false;
      return;
    }
    touchPointersRef.current.delete(event.pointerId);
    if (pinchRef.current && touchPointersRef.current.size < 2) {
      pinchRef.current = null;
      pinchSuppressClicksUntilRef.current = performance.now() + 500;
    }
    if (touchPointersRef.current.size === 0) pointerGestureSuppressedRef.current = false;
  };
  const handleStagePointerUpCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (finishCameraPointer(event.pointerId)) {
      pinchSuppressClicksUntilRef.current = performance.now() + 500;
      pointerGestureSuppressedRef.current = true;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const selected = state.greenhouse.anchors.find((anchor) => anchor.anchorId === selectedAnchor) ?? null;
  const selectedContentPack = selectedRuntimePngContentPack();
  const cropCatalog = state.cropCatalog;
  const cropCatalogMatchesSelectedPack = Boolean(cropCatalog?.packId && selectedContentPack.packId === cropCatalog.packId);
  const cropDefinition = (cropId: string): GreenhouseCropCatalogEntrySnapshot | null =>
    cropCatalog?.crops.find((crop) => crop.cropId === cropId) ?? null;
  const cropArtForStage = (cropId: string, stage: number, _artId?: string): GreenhouseCropStageArt | null =>
    greenhouseCropStageArt(cropCatalog, cropId, stage);
  const cropHasVerifiedPresentation = (crop: GreenhouseCropCatalogEntrySnapshot): boolean =>
    [1, 2, 3, 4].every((stage) => cropArtForStage(crop.cropId, stage) !== null);
  const plantableCrops = (cropCatalog?.crops ?? []).filter((crop) =>
    crop.plantingAvailable && cropHasVerifiedPresentation(crop)
  );
  const tankAnchor = state.greenhouse.waterStorage ?? { ...GREENHOUSE_STUDIO_CATALOG.waterStorage, placed: true };
  const tankPlaced = tankAnchor.placed !== false;
  const nearTank = Boolean(position && !position.position.moving &&
    tankPlaced &&
    Math.hypot(position.position.x - tankAnchor.x, position.position.y - tankAnchor.y) <= GREENHOUSE_TANK_INTERACTION_RADIUS);
  const waterAvailable = state.gardeningBucketGallons >= 0.1;
  const canRefillGardeningBucket = state.greenhouse.tankWaterTenths > 0 &&
    state.gardeningBucketGallons < GREENHOUSE_GARDENING_BUCKET_CAPACITY_TENTHS / 10;
  const planterActionDuration = (kind: PlanterActionKind): number => {
    if (kind === "plant") return GREENHOUSE_PLANT_ACTION_DURATION_MS;
    if (kind === "water") return GREENHOUSE_WATER_ACTION_DURATION_MS;
    if (kind === "plant-and-water") return GREENHOUSE_PLANT_AND_WATER_ACTION_DURATION_MS;
    if (kind === "clip") return GREENHOUSE_CLIPPING_ACTION_DURATION_MS;
    if (kind === "tap") return GREENHOUSE_CLIPPING_ACTION_DURATION_MS;
    return 0;
  };
  const placedPotCount = state.greenhouse.anchors.filter((anchor) => anchor.placed !== false).length;
  const availablePotSlots = Math.max(0, state.greenhouse.planterCapacity - placedPotCount);
  const plotNumberFor = (anchor: GreenhouseAnchorSnapshot): number => {
    const index = state.greenhouse.anchors.findIndex((candidate) => candidate.anchorId === anchor.anchorId);
    return index >= 0 ? index + 1 : anchor.row * 5 + anchor.column + 1;
  };
  const placementOccupants: Array<{ kind: GreenhousePlacementKind; x: number; y: number }> = state.greenhouse.anchors
    .filter((anchor) => anchor.placed !== false)
    .map((anchor) => ({ kind: "pot" as const, x: anchor.x, y: anchor.y }));
  if (tankPlaced) placementOccupants.push({ kind: "water_tank", x: tankAnchor.x, y: tankAnchor.y });
  const roomPointFromClient = (clientX: number, clientY: number): { x: number; y: number } | null => {
    if (mapRendered && screenToLocal) {
      const local = screenToLocal(clientX, clientY);
      return local ? {
        x: Math.max(0, Math.min(ROOM_WIDTH, local.x)),
        y: Math.max(0, Math.min(ROOM_HEIGHT, local.y))
      } : null;
    }
    const stage = stageRef.current;
    if (!stage) return null;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(ROOM_WIDTH, (clientX - bounds.left) / bounds.width * ROOM_WIDTH)),
      y: Math.max(0, Math.min(ROOM_HEIGHT, (clientY - bounds.top) / bounds.height * ROOM_HEIGHT))
    };
  };
  const selectAnchor = (anchor: GreenhouseAnchorSnapshot, event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const point = roomPointFromClient(event.clientX, event.clientY) ?? { x: anchor.x, y: anchor.y };
    if (!greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "pot", anchor.x, anchor.y, point.x, point.y)) return;
    selectAnchorAt(anchor, point);
  };
  /** Selects the plot at a room point, or offers a chooser when plots (and the tank) overlap there. */
  const selectAnchorAt = (anchor: GreenhouseAnchorSnapshot, point: IndoorPoint): void => {
    const choices: GameTargetChoice[] = state.greenhouse.anchors
      .filter((candidate) => candidate.placed !== false)
      .filter((candidate) => greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "pot", candidate.x, candidate.y, point.x, point.y))
      .map((candidate) => ({
        key: `planter:${candidate.anchorId}`,
        name: candidate.plant
          ? `Farm Plot ${plotNumberFor(candidate)} · ${cropDefinition(candidate.plant.cropId)?.displayName ?? "Crop"} · Stage ${candidate.plant.stage}`
          : `Farm Plot ${plotNumberFor(candidate)}`,
        category: "Greenhouse Farm Plot",
        meta: candidate.plant ? (cropDefinition(candidate.plant.cropId)?.displayName ?? "Crop") : "Empty",
        detail: candidate.plant && candidate.plant.stage === cropDefinition(candidate.plant.cropId)?.maxStage ? "Ready to harvest." : null
      }));
    if (tankPlaced && greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "water_tank", tankAnchor.x, tankAnchor.y, point.x, point.y)) {
      choices.push({ key: "water-tank", name: "Water Storage Tank", category: "Greenhouse storage", meta: tankWaterLabelForState(state) });
    }
    if (choices.length > 1) {
      setTargetChoices(choices);
      return;
    }
    setTargetChoices(null);
    setSelectedAnchor(anchor.anchorId);
    setTankSelected(false);
    setSelfSelected(false);
  };
  const selectTank = (event?: React.MouseEvent<HTMLButtonElement>): void => {
    if (event) {
      event.stopPropagation();
      const point = roomPointFromClient(event.clientX, event.clientY) ?? { x: tankAnchor.x, y: tankAnchor.y };
      if (!greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "water_tank", tankAnchor.x, tankAnchor.y, point.x, point.y)) return;
    }
    setTargetChoices(null);
    setSelectedAnchor(null);
    setTankSelected(true);
    setSelfSelected(false);
    setPendingTankAction(null);
  };
  const beginPlanterAction = (anchorId: string, kind: PlanterActionKind, cropId?: string): void => {
    if (disabled || movementDisabled) return;
    const anchor = state.greenhouse.anchors.find((candidate) => candidate.anchorId === anchorId);
    if (!anchor) return;
    const current = position?.position ?? null;
    if (!current || current.moving || !isIndoorInteractionInRange(current, anchor, GREENHOUSE_PLANTER_INTERACTION_RADIUS)) {
      setPendingPlanterAction({ anchorId, kind, ...(cropId ? { cropId } : {}) });
      setSelectedAnchor(null);
      if (current) {
        const approach = indoorInteractionApproachPoint(
          current,
          anchor,
          GREENHOUSE_PLANTER_INTERACTION_RADIUS,
          GREENHOUSE_INTERACTION_APPROACH_INSET
        );
        onMove(approach.x, approach.y);
      }
      return;
    }
    const durationMs = planterActionDuration(kind);
    if (durationMs <= 0) {
      setSelectedAnchor(null);
      if (kind === "clip") onClip(anchorId);
      else if (kind === "harvest") onHarvest(anchorId);
      return;
    }
    setPendingPlanterAction(null);
    setSelectedAnchor(null);
    setActivePlanterAction({ anchorId, kind, ...(cropId ? { cropId } : {}), startedAt: performance.now(), durationMs });
  };
  const beginPlacement = (kind: GreenhousePlacementKind, anchorId?: string): void => {
    if (disabled || movementDisabled) return;
    if (kind === "pot" && availablePotSlots <= 0 && !anchorId) return;
    setSelectedAnchor(null);
    setTankSelected(false);
    setSelfSelected(false);
    setPendingPlacement(null);
    const requested = position ? { x: position.position.x, y: position.position.y } : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 };
    const resolved = resolveGreenhousePlacementPosition(
      GREENHOUSE_STUDIO_CATALOG,
      kind,
      requested,
      placementOccupants.filter((occupant) => !(kind === "water_tank" && occupant.kind === "water_tank"))
    );
    if (!resolved) {
      setPlacementPreview(null);
      setPlacementMode(null);
      return;
    }
    setPlacementPreview(resolved);
    setTargetChoices(null);
    setPlacementMode({ kind, ...(anchorId ? { anchorId } : {}) });
  };
  const roomPointFromPointer = (event: React.PointerEvent): { x: number; y: number } | null => roomPointFromClient(event.clientX, event.clientY);
  const placementResolvedAt = (point: IndoorPoint | null): { x: number; y: number } | null => {
    if (!placementMode || disabled || movementDisabled || !point) return null;
    return resolveGreenhousePlacementPosition(
      GREENHOUSE_STUDIO_CATALOG,
      placementMode.kind,
      point,
      placementOccupants.filter((occupant) => !(placementMode.kind === "water_tank" && occupant.kind === "water_tank")),
      placementPreview ?? undefined
    );
  };
  const updatePlacementPreviewAt = (point: IndoorPoint | null): void => {
    const resolved = placementResolvedAt(point);
    if (resolved) setPlacementPreview(resolved);
  };
  const commitPlacementAt = (point: IndoorPoint | null): void => {
    const resolved = placementResolvedAt(point);
    if (!resolved || !placementMode) return;
    setPendingPlacement({ ...placementMode, ...resolved });
    setPlacementMode(null);
    setPlacementPreview(resolved);
  };
  const handlePlacementClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!placementMode || disabled || movementDisabled || (event.target instanceof Element && event.target.closest("button"))) {
      movementInput.onClick(event);
      return;
    }
    const point = roomPointFromPointer(event as unknown as React.PointerEvent);
    if (!point) return;
    movementInput.clearPendingMovement();
    const resolved = resolveGreenhousePlacementPosition(
      GREENHOUSE_STUDIO_CATALOG,
      placementMode.kind,
      point,
      placementOccupants.filter((occupant) => !(placementMode.kind === "water_tank" && occupant.kind === "water_tank")),
      placementPreview ?? undefined
    );
    if (!resolved) return;
    setPendingPlacement({ ...placementMode, ...resolved });
    setPlacementMode(null);
    setPlacementPreview(resolved);
  };
  const placementIssue = pendingPlacement
    ? greenhousePlacementIssue(
      GREENHOUSE_STUDIO_CATALOG,
      pendingPlacement.kind,
      pendingPlacement.x,
      pendingPlacement.y,
      placementOccupants.filter((occupant) => !(pendingPlacement.kind === "water_tank" && occupant.kind === "water_tank"))
    )
    : null;
  const confirmPlacement = (): void => {
    if (!pendingPlacement || placementIssue) return;
    const placement = pendingPlacement;
    setPendingPlacement(null);
    setPlacementPreview(null);
    onPlace?.(placement.kind, placement.x, placement.y, placement.anchorId);
  };
  const chooseTankAction = (action: "deposit" | "refill"): void => {
    setTankSelected(false);
    setTargetChoices(null);
    setSelfSelected(false);
    if (disabled || !tankPlaced) return;
    if (nearTank) {
      if (action === "deposit") onDepositWater();
      else onRefillGardeningBucket();
      return;
    }
    setPendingTankAction(action);
    onMove(tankAnchor.x, tankAnchor.y);
  };
  useEffect(() => {
    if (disabled || movementDisabled) {
      setPendingTankAction(null);
      setPendingPlanterAction(null);
      setActivePlanterAction(null);
      setTargetChoices(null);
      setPlacementMode(null);
      setPendingPlacement(null);
      setPlacementPreview(null);
    }
  }, [disabled, movementDisabled]);
  useEffect(() => {
    if (position?.position.moving) setActivePlanterAction(null);
  }, [position?.position.moving]);
  useEffect(() => {
    if (!selected?.plant || selected.plant.dry || !selected.plant.nextStageAt) return;
    const update = (): void => setGreenhouseNow(synchronizedNow());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [selected?.plant?.dry, selected?.plant?.nextStageAt, synchronizedNow]);
  useEffect(() => {
    if (!pendingTankAction || !tankPlaced || !position || position.position.moving || disabled || movementDisabled) return;
    const arrivedAtTank = Math.hypot(position.position.x - tankAnchor.x, position.position.y - tankAnchor.y) <= GREENHOUSE_TANK_INTERACTION_RADIUS;
    if (!arrivedAtTank) return;
    const action = pendingTankAction;
    setPendingTankAction(null);
    if (action === "deposit") onDepositWater();
    else onRefillGardeningBucket();
  }, [disabled, movementDisabled, onDepositWater, onRefillGardeningBucket, pendingTankAction, position, tankAnchor.x, tankAnchor.y, tankPlaced]);
  useEffect(() => {
    if (!pendingPlanterAction || !position || position.position.moving || disabled || movementDisabled) return;
    const anchor = state.greenhouse.anchors.find((candidate) => candidate.anchorId === pendingPlanterAction.anchorId);
    if (!anchor || !isIndoorInteractionInRange(position.position, anchor, GREENHOUSE_PLANTER_INTERACTION_RADIUS)) return;
    const action = pendingPlanterAction;
    const durationMs = planterActionDuration(action.kind);
    setPendingPlanterAction(null);
    if (durationMs <= 0) {
      setSelectedAnchor(null);
      if (action.kind === "clip") onClip(action.anchorId);
      else if (action.kind === "harvest") onHarvest(action.anchorId);
      return;
    }
    setSelectedAnchor(null);
    setActivePlanterAction({ ...action, startedAt: performance.now(), durationMs });
  }, [disabled, movementDisabled, onClip, onHarvest, pendingPlanterAction, position, state.greenhouse.anchors]);
  useEffect(() => {
    const action = activePlanterAction
      ? {
          label: planterActionLabel(activePlanterAction.kind),
          startedAt: activePlanterAction.startedAt,
          durationMs: activePlanterAction.durationMs
        }
      : null;
    onPlanterActionChange(action);
    return () => onPlanterActionChange(null);
  }, [activePlanterAction, onPlanterActionChange]);
  useEffect(() => {
    if (!activePlanterAction) return;
    const remaining = activePlanterAction.startedAt + activePlanterAction.durationMs - performance.now();
    const timer = window.setTimeout(() => {
      const anchor = state.greenhouse.anchors.find((candidate) => candidate.anchorId === activePlanterAction.anchorId);
      const valid = Boolean(anchor && !disabled && !movementDisabled && position && !position.position.moving &&
        isIndoorInteractionInRange(position.position, anchor, GREENHOUSE_PLANTER_INTERACTION_RADIUS));
      setActivePlanterAction(null);
      if (!valid) return;
      if (activePlanterAction.kind === "plant" && activePlanterAction.cropId) onPlant(activePlanterAction.anchorId, activePlanterAction.cropId);
      else if (activePlanterAction.kind === "plant-and-water" && activePlanterAction.cropId) onPlantAndWater(activePlanterAction.anchorId, activePlanterAction.cropId);
      else if (activePlanterAction.kind === "water") onWater(activePlanterAction.anchorId);
      else if (activePlanterAction.kind === "clip") onClip(activePlanterAction.anchorId);
      else if (activePlanterAction.kind === "tap") onTapTree?.(activePlanterAction.anchorId);
      else onHarvest(activePlanterAction.anchorId);
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [activePlanterAction, disabled, movementDisabled, onClip, onHarvest, onPlant, onPlantAndWater, onTapTree, onWater, position, state.greenhouse.anchors]);
  const planterActionBusy = pendingPlanterAction?.anchorId === selectedAnchor || activePlanterAction?.anchorId === selectedAnchor;
  const actions = selected ? actionsForAnchor(
    selected,
    cropCatalog?.crops ?? [],
    plantableCrops,
    (crop) => cropSeedCount(inventory ?? state.inventory, crop),
    waterAvailable,
    (anchorId, cropId) => beginPlanterAction(anchorId, "plant", cropId),
    (anchorId, cropId) => beginPlanterAction(anchorId, "plant-and-water", cropId),
    (anchorId) => beginPlanterAction(anchorId, "water"),
    (anchorId) => beginPlanterAction(anchorId, "clip"),
    (anchorId) => beginPlanterAction(anchorId, "harvest"),
    (anchorId) => beginPlanterAction(anchorId, "tap"),
    planterActionBusy,
    cropCatalogMatchesSelectedPack,
    disabled
  ) : [];
  const selectedCrop = selected?.plant ? cropDefinition(selected.plant.cropId) : null;
  const selectedPlantStatus = selected?.plant
    ? !selectedCrop
      ? "Crop details are unavailable."
      : selected.plant.stage >= selectedCrop.maxStage
        ? "Ready to harvest."
        : selected.plant.dry
          ? `Needs water to start stage ${selected.plant.stage + 1}.`
          : selected.plant.nextStageAt
            ? `Growing · next stage in ${greenhouseTimeRemainingLabel(Math.max(0, Date.parse(selected.plant.nextStageAt) - greenhouseNow))}.`
            : "Growing."
    : null;
  const selectedArtUnavailable = Boolean(selected?.plant && !cropArtForStage(selected.plant.cropId, selected.plant.stage));
  const selectedPlantDetail = selected?.plant
    ? `${selectedPlantStatus}${selectedArtUnavailable ? " Crop artwork unavailable. Retry after the content update." : ""}`
    : plantableCrops.length > 0
      ? `Plant ${plantableCrops.length === 1 ? plantableCrops[0]!.seedDisplayName : "a crop"}.`
      : "Verified crop artwork is unavailable. Try again after the content update.";
  const tankWaterLabel = `${state.greenhouse.tankWaterTenths / 10}/${GREENHOUSE_TANK_CAPACITY_TENTHS / 10} gal`;
  const tankTouch = greenhouseTemplateTouchBounds(GREENHOUSE_STUDIO_CATALOG, "water_tank", 0, 0);
  const tankImage = greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, "water_tank", tankAnchor.x, tankAnchor.y);
  const previewPlacement = pendingPlacement ?? (placementMode && placementPreview ? { ...placementMode, ...placementPreview } : null);
  const previewTemplate = previewPlacement?.kind === "pot"
    ? GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot
    : previewPlacement
      ? GREENHOUSE_STUDIO_CATALOG.geometry.templates.waterTank
      : null;
  const previewImage = previewPlacement ? greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, previewPlacement.kind, previewPlacement.x, previewPlacement.y) : null;
  const previewImageUrl = previewTemplate ? runtimePngAssetUrl(previewTemplate.assetPath) : null;
  const mapPreview: GreenhouseMapPlacementPreview | null = previewPlacement
    ? { kind: previewPlacement.kind, x: previewPlacement.x, y: previewPlacement.y, valid: !placementIssue }
    : null;
  useEffect(() => {
    if (mapRendered) onPlacementPreviewChange?.(mapPreview);
    // Primitive deps: the preview object is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRendered, onPlacementPreviewChange, mapPreview?.kind, mapPreview?.x, mapPreview?.y, mapPreview?.valid]);
  useEffect(() => () => onPlacementPreviewChange?.(null), [onPlacementPreviewChange]);
  if (mapPickRef) {
    // Same targets and priority as the DOM scene's buttons (topmost first): self, tank, plots, exit.
    mapPickRef.current = mapRendered ? (local: IndoorPoint): boolean => {
      if (placementMode) return true;
      const playerHeight = STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits;
      const self = position?.position;
      const clear = (): void => {
        setTargetChoices(null);
        setSelectedAnchor(null);
        setTankSelected(false);
        setSelfSelected(false);
      };
      if (self && Math.abs(local.x - self.x) <= playerHeight * 0.4 &&
          local.y <= self.y + playerHeight * 0.15 && local.y >= self.y - playerHeight * 1.1) {
        clear();
        setSelfSelected(true);
        setPendingTankAction(null);
        return true;
      }
      if (tankPlaced && greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "water_tank", tankAnchor.x, tankAnchor.y, local.x, local.y)) {
        selectTank();
        return true;
      }
      const anchor = [...state.greenhouse.anchors].reverse().find((candidate) => candidate.placed !== false &&
        greenhouseTemplateTouchContainsPoint(GREENHOUSE_STUDIO_CATALOG, "pot", candidate.x, candidate.y, local.x, local.y));
      if (anchor) {
        selectAnchorAt(anchor, local);
        return true;
      }
      const exitTouch = greenhouseExitTouchBounds(GREENHOUSE_STUDIO_CATALOG.geometry.exit.touchArea);
      if (local.x >= exitTouch.minX && local.x <= exitTouch.maxX && local.y >= exitTouch.minY && local.y <= exitTouch.maxY) {
        clear();
        setSelfSelected(true);
        return true;
      }
      clear();
      return false;
    } : null;
  }
  const placementTools = <div className="greenhouse-placement-tools" role="toolbar" aria-label="Greenhouse placement tools">
    <button type="button" disabled={disabled || movementDisabled || availablePotSlots <= 0} onClick={(event) => { event.stopPropagation(); beginPlacement("pot"); }}>
      Place Farm Plot{availablePotSlots > 0 ? ` · ${availablePotSlots} open` : ""}
    </button>
    <button type="button" disabled={disabled || movementDisabled} onClick={(event) => { event.stopPropagation(); beginPlacement("water_tank"); }}>
      {tankPlaced ? "Move Water Tank" : "Place Water Tank"}
    </button>
  </div>;
  const tankStatus = <div className="greenhouse-tank-status" role="status">
    Tank {state.greenhouse.tankWaterTenths / 10}/{GREENHOUSE_TANK_CAPACITY_TENTHS / 10} gal · Bucket {state.gardeningBucketGallons.toFixed(1)} gal
  </div>;
  const prompts = <>
    {targetChoices ? <GameTargetPicker
      title="Choose Greenhouse Target"
      choices={targetChoices}
      onSelect={(key) => {
        setTargetChoices(null);
        if (key === "water-tank") {
          selectTank();
          return;
        }
        const anchorId = key.startsWith("planter:") ? key.slice("planter:".length) : null;
        if (anchorId) {
          setSelectedAnchor(anchorId);
          setTankSelected(false);
          setSelfSelected(false);
        }
      }}
      onQuickAction={(key) => {
        setTargetChoices(null);
        if (key === "water-tank") selectTank();
        else if (key.startsWith("planter:")) setSelectedAnchor(key.slice("planter:".length));
      }}
      onCancel={() => setTargetChoices(null)}
    /> : null}
    {pendingPlacement ? <GameActionPrompt
      title={pendingPlacement.kind === "pot" ? "Place Farm Plot Here?" : "Place Water Tank Here?"}
      detail={placementIssue ?? (pendingPlacement.kind === "pot"
        ? "Also uses 1 gallon from your Gardening Bucket. The full physical footprint fits inside the authored floor and does not overlap another object."
        : "The full physical footprint fits inside the authored floor and does not overlap another object.")}
      content={pendingPlacement.kind === "pot" ? <MaterialChips label="Farm Plot materials" materials={GREENHOUSE_FARM_PLOT_PLACEMENT_COST.map(({ itemId, quantity }) => ({
        itemId,
        quantity,
        name: itemId.charAt(0).toUpperCase() + itemId.slice(1),
        have: (inventory ?? state.inventory).totals[itemId] ?? 0
      }))} /> : null}
      actions={[{
        key: "place-here",
        label: "Place Here",
        enabled: !placementIssue && !disabled,
        disabledReason: placementIssue ?? (disabled ? "Greenhouse actions are unavailable." : null),
        onSelect: confirmPlacement
      }]}
      onCancel={() => { setPendingPlacement(null); setPlacementPreview(null); }}
    /> : null}
    {selected ? <GameActionPrompt
      title={selected.plant
        ? `Farm Plot ${plotNumberFor(selected)} · ${selectedCrop?.displayName ?? "Crop"} · Stage ${selected.plant.stage}`
        : `Farm Plot ${plotNumberFor(selected)}`}
      detail={selectedPlantDetail}
      actions={actions}
      onCancel={() => setSelectedAnchor(null)}
    /> : null}
    {tankSelected ? <GameActionPrompt
      title={`Water Storage Tank · ${tankWaterLabel}`}
      detail={nearTank ? "Within range." : "Move closer to use."}
      actions={[
        {
          key: "deposit",
          label: "Deposit Water Bucket",
          enabled: !disabled,
          disabledReason: disabled ? "Greenhouse actions are unavailable." : null,
          onSelect: () => chooseTankAction("deposit")
        },
        {
          key: "refill",
          label: "Refill Gardening Bucket",
          enabled: canRefillGardeningBucket && !disabled,
          disabledReason: disabled ? "Greenhouse actions are unavailable." : canRefillGardeningBucket ? null : "The tank is empty or your bucket is full.",
          onSelect: () => chooseTankAction("refill")
        },
        {
          key: "move-tank",
          label: "Move Water Tank",
          enabled: !disabled,
          disabledReason: disabled ? "Greenhouse actions are unavailable." : null,
          onSelect: () => { setTankSelected(false); beginPlacement("water_tank"); }
        }
      ]}
      onCancel={() => setTankSelected(false)}
    /> : null}
    {selfSelected ? <GameActionPrompt
      title="Your Greenhouse"
      actions={[{
        key: "exit-greenhouse",
        label: "Exit Greenhouse",
        enabled: !disabled,
        disabledReason: disabled ? "Leaving the Greenhouse is unavailable while disconnected." : null,
        onSelect: () => {
          setSelfSelected(false);
          onExit();
        }
      }]}
      onCancel={() => setSelfSelected(false)}
    /> : null}
  </>;
  if (mapRendered) {
    // The map renderer draws the room, plots, crops, tank and player (INTERIOR_MAP_RENDERER.md P4); this layer keeps
    // the placement tools, tank status, prompts and, while placing, the pointer surface for the preview.
    return <IndoorSceneViewport className="interior-map-hud greenhouse-map-hud" ariaLabel="Greenhouse">
      {placementMode ? <div
        className="interior-map-placement-capture"
        data-greenhouse-placement-capture=""
        onPointerMove={(event) => updatePlacementPreviewAt(roomPointFromClient(event.clientX, event.clientY))}
        onClick={(event) => {
          event.stopPropagation();
          commitPlacementAt(roomPointFromClient(event.clientX, event.clientY));
        }}
      /> : null}
      {placementTools}
      {tankStatus}
      {prompts}
    </IndoorSceneViewport>;
  }
  return <IndoorSceneViewport className="greenhouse-scene" ariaLabel="Greenhouse">
    <div
      className="greenhouse-stage-shell"
      ref={stageShellRef}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        applyZoom(indoorWheelZoom(zoomRef.current, event.deltaY, greenhouseZoomLimits));
      }}
      onPointerDownCapture={handleStagePointerDown}
      onPointerMove={handleZoomPointerMove}
      onDoubleClick={movementInput.onDoubleClick}
      onPointerUpCapture={handleStagePointerUpCapture}
      onPointerUp={handleZoomPointerEnd}
      onPointerCancel={handleZoomPointerEnd}
      onLostPointerCapture={handleZoomPointerEnd}
    >
    <IndoorSceneStage
      roomWidth={ROOM_WIDTH}
      roomHeight={ROOM_HEIGHT}
      scale={zoom}
      {...(cameraPan.x === 0 && cameraPan.y === 0 ? {} : { translation: cameraPan })}
      innerClassName="greenhouse-room"
      frameClassName="greenhouse-stage-wrap"
      stageRef={stageRef}
      onClick={(event) => {
        if (performance.now() < pinchSuppressClicksUntilRef.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        handlePlacementClick(event);
      }}
      onPointerDownCapture={(event) => {
        if (!pointerGestureSuppressedRef.current) movementInput.onPointerDownCapture(event);
      }}
      onPointerMove={(event) => {
        if (placementMode && !disabled && !movementDisabled) {
          const point = roomPointFromPointer(event);
          if (point) {
            const resolved = resolveGreenhousePlacementPosition(
              GREENHOUSE_STUDIO_CATALOG,
              placementMode.kind,
              point,
              placementOccupants.filter((occupant) => !(placementMode.kind === "water_tank" && occupant.kind === "water_tank")),
              placementPreview ?? undefined
            );
            if (resolved) setPlacementPreview(resolved);
          }
        }
        if (!pointerGestureSuppressedRef.current) movementInput.onPointerMove(event);
      }}
      onPointerUp={(event) => {
        if (!pointerGestureSuppressedRef.current) movementInput.onPointerUp(event);
      }}
      onPointerCancel={(event) => {
        if (!pointerGestureSuppressedRef.current) movementInput.onPointerCancel(event);
      }}
      onLostPointerCapture={movementInput.onLostPointerCapture}
    >
      <div className="greenhouse-floor-art" aria-hidden="true">
        {runtimePngAssetUrl("apps/client/src/assets/structures/greenhouse-floor.png")
          ? <img src={runtimePngAssetUrl("apps/client/src/assets/structures/greenhouse-floor.png")!} alt="" />
          : null}
      </div>
      {GREENHOUSE_STUDIO_CATALOG.overlays.map((overlay) => {
        const overlayUrl = runtimePngAssetUrl(overlay.assetPath);
        return overlayUrl ? <img
          key={overlay.overlayId}
          className="greenhouse-authored-overlay"
          src={overlayUrl}
          alt=""
          style={{
            left: `${overlay.x / ROOM_WIDTH * 100}%`,
            top: `${overlay.y / ROOM_HEIGHT * 100}%`,
            width: `${overlay.width / ROOM_WIDTH * 100}%`,
            height: `${overlay.height / ROOM_HEIGHT * 100}%`,
            zIndex: overlay.zIndex,
            transform: `rotate(${overlay.rotationDeg}deg) scale(${overlay.scaleX}, ${overlay.scaleY})`
          }}
        /> : null;
      })}
      {(() => {
        const exit = GREENHOUSE_STUDIO_CATALOG.geometry.exit;
        const touch = greenhouseExitTouchBounds(exit.touchArea);
        const doorUrl = runtimePngAssetUrl(exit.assetPath || GREENHOUSE_DOOR_ASSET_PATH);
        return <>
          {doorUrl ? <img className="greenhouse-stage-art greenhouse-door-art" src={doorUrl} alt="" style={{ left: `${(exit.x - exit.pivotX * exit.renderWidth) / ROOM_WIDTH * 100}%`, top: `${(exit.y - exit.pivotY * exit.renderHeight) / ROOM_HEIGHT * 100}%`, width: `${exit.renderWidth / ROOM_WIDTH * 100}%`, height: `${exit.renderHeight / ROOM_HEIGHT * 100}%`, objectFit: "fill" }} aria-hidden="true" /> : null}
          <button type="button" className="greenhouse-door-anchor" aria-label="Greenhouse exit" style={{ left: `${touch.minX / ROOM_WIDTH * 100}%`, top: `${touch.minY / ROOM_HEIGHT * 100}%`, width: `${(touch.maxX - touch.minX) / ROOM_WIDTH * 100}%`, height: `${(touch.maxY - touch.minY) / ROOM_HEIGHT * 100}%` }} onClick={(event) => { event.stopPropagation(); setSelectedAnchor(null); setTankSelected(false); setSelfSelected(true); }}><span className="sr-only">Exit Greenhouse</span></button>
        </>;
      })()}
      <svg
        className="greenhouse-physical-footprints"
        data-testid="greenhouse-physical-footprints"
        viewBox={`0 0 ${ROOM_WIDTH} ${ROOM_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {previewPlacement ? <polygon
          className={`greenhouse-placement-footprint ${placementIssue ? "invalid" : "valid"}`}
          points={greenhousePolygonPoints(greenhouseTemplateFootprint(GREENHOUSE_STUDIO_CATALOG, previewPlacement.kind, previewPlacement.x, previewPlacement.y))}
        /> : null}
      </svg>
      <div className="greenhouse-title">GREENHOUSE</div>
      {placementTools}
      {tankStatus}
      {state.greenhouse.anchors.filter((anchor) => anchor.placed !== false).map((anchor) => <GreenhouseAnchor
        key={anchor.anchorId}
        anchor={anchor}
        plotNumber={plotNumberFor(anchor)}
        crop={anchor.plant ? cropDefinition(anchor.plant.cropId) : null}
        stageArt={anchor.plant ? cropArtForStage(anchor.plant.cropId, anchor.plant.stage, anchor.plant.artId) : null}
        onSelect={(event) => selectAnchor(anchor, event)}
        touchKind={GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot.touchArea.kind}
      />)}
      {previewImage && previewImageUrl ? <img
        className="greenhouse-stage-art greenhouse-placement-preview-art"
        src={previewImageUrl}
        alt=""
        style={{ left: `${previewImage.x / ROOM_WIDTH * 100}%`, top: `${previewImage.y / ROOM_HEIGHT * 100}%`, width: `${previewImage.width / ROOM_WIDTH * 100}%`, height: `${previewImage.height / ROOM_HEIGHT * 100}%`, objectFit: "fill" }}
        aria-hidden="true"
      /> : null}
      {tankPlaced && runtimePngAssetUrl(GREENHOUSE_STUDIO_CATALOG.geometry.templates.waterTank.assetPath) ? <img
        className="greenhouse-stage-art greenhouse-tank-art"
        src={runtimePngAssetUrl(GREENHOUSE_STUDIO_CATALOG.geometry.templates.waterTank.assetPath)!}
        alt=""
        style={{ left: `${tankImage.x / ROOM_WIDTH * 100}%`, top: `${tankImage.y / ROOM_HEIGHT * 100}%`, width: `${tankImage.width / ROOM_WIDTH * 100}%`, height: `${tankImage.height / ROOM_HEIGHT * 100}%`, objectFit: "fill" }}
        aria-hidden="true"
      /> : null}
      {tankPlaced ? <button
        type="button"
        className={`greenhouse-tank-anchor touch-${GREENHOUSE_STUDIO_CATALOG.geometry.templates.waterTank.touchArea.kind}`}
        style={{ left: `${(tankAnchor.x + tankTouch.minX) / ROOM_WIDTH * 100}%`, top: `${(tankAnchor.y + tankTouch.minY) / ROOM_HEIGHT * 100}%`, width: `${(tankTouch.maxX - tankTouch.minX) / ROOM_WIDTH * 100}%`, height: `${(tankTouch.maxY - tankTouch.minY) / ROOM_HEIGHT * 100}%`, transform: "none" }}
        aria-label="Water storage tank"
        onClick={(event) => {
          event.stopPropagation();
          selectTank(event);
        }}
      >
        <span className="sr-only">Select water storage tank</span>
      </button> : null}
      <GreenhousePlayerLayer
        timeline={timeline}
        displayColor={displayColor}
        {...(appearance ? { appearance } : {})}
      />
      {position ? <button
        type="button"
        className="greenhouse-self"
        aria-label="Your character"
        style={{ left: `${position.position.x / ROOM_WIDTH * 100}%`, top: `${position.position.y / ROOM_HEIGHT * 100}%` }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setSelectedAnchor(null);
          setTankSelected(false);
          setSelfSelected(true);
          setPendingTankAction(null);
        }}
      /> : null}
    </IndoorSceneStage>
    </div>
    <div className="greenhouse-zoom-tools" role="toolbar" aria-label="Greenhouse zoom controls">
      <button type="button" aria-label="Zoom out greenhouse" onClick={(event) => { event.stopPropagation(); applyZoom(zoomRef.current - 0.1); }}>−</button>
      <span aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in greenhouse" onClick={(event) => { event.stopPropagation(); applyZoom(zoomRef.current + 0.1); }}>+</button>
      <button type="button" className="greenhouse-reset-view" aria-label="Reset greenhouse view" onClick={(event) => { event.stopPropagation(); resetView(); }}>Reset</button>
    </div>
    {prompts}
  </IndoorSceneViewport>;
}

export function GreenhouseLoadingScene({ onExit }: Readonly<{ onExit(): void }>): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  return <IndoorSceneViewport className="greenhouse-scene" ariaLabel="Greenhouse">
    <IndoorSceneStage
      roomWidth={ROOM_WIDTH}
      roomHeight={ROOM_HEIGHT}
      innerClassName="greenhouse-room"
      frameClassName="greenhouse-stage-wrap"
      stageRef={stageRef}
    >
      <div className="greenhouse-floor-art" aria-hidden="true">
        {runtimePngAssetUrl("apps/client/src/assets/structures/greenhouse-floor.png")
          ? <img src={runtimePngAssetUrl("apps/client/src/assets/structures/greenhouse-floor.png")!} alt="" />
          : null}
      </div>
      <div className="greenhouse-title">GREENHOUSE</div>
      <p className="greenhouse-loading" role="status">Loading greenhouse state…</p>
      <button type="button" className="greenhouse-door" onClick={onExit}>Exit Greenhouse</button>
    </IndoorSceneStage>
  </IndoorSceneViewport>;
}

function GreenhouseAnchor({ anchor, crop, stageArt, plotNumber, onSelect, touchKind }: Readonly<{
  anchor: GreenhouseAnchorSnapshot;
  crop: GreenhouseCropCatalogEntrySnapshot | null;
  stageArt: GreenhouseCropStageArt | null;
  plotNumber: number;
  onSelect(event: React.MouseEvent<HTMLButtonElement>): void;
  touchKind: "circle" | "polygon";
}>): React.JSX.Element {
  const artUrl = anchor.plant && (stageArt?.stagePresentation.artId === anchor.plant.artId || anchor.plant.cropId === GREENHOUSE_GIVING_BERRY_TREE_CROP_ID) ? stageArt?.url ?? null : null;
  const potUrl = runtimePngAssetUrl(GREENHOUSE_POT_ASSET_PATH);
  const touch = greenhouseTemplateTouchBounds(GREENHOUSE_STUDIO_CATALOG, "pot", anchor.x, anchor.y);
  const image = greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, "pot", anchor.x, anchor.y);
  const stageImage = artUrl && stageArt ? greenhousePlantStageArtFrame(GREENHOUSE_STUDIO_CATALOG, stageArt.stagePresentation, anchor.x, anchor.y) : null;
  return <>
    {potUrl ? <img
      className="greenhouse-stage-art greenhouse-pot-art"
      src={potUrl}
      alt=""
      style={{ left: `${image.x / ROOM_WIDTH * 100}%`, top: `${image.y / ROOM_HEIGHT * 100}%`, width: `${image.width / ROOM_WIDTH * 100}%`, height: `${image.height / ROOM_HEIGHT * 100}%`, objectFit: "fill" }}
      aria-hidden="true"
    /> : null}
    {artUrl && stageImage ? <img
      className="greenhouse-stage-art greenhouse-crop-art"
      src={artUrl}
      alt=""
      style={{ left: `${stageImage.x / ROOM_WIDTH * 100}%`, top: `${stageImage.y / ROOM_HEIGHT * 100}%`, width: `${stageImage.width / ROOM_WIDTH * 100}%`, height: `${stageImage.height / ROOM_HEIGHT * 100}%`, objectFit: "contain" }}
      aria-hidden="true"
    /> : null}
    <button
      type="button"
      className={`greenhouse-anchor touch-${touchKind}${anchor.plant ? " planted" : " empty"}`}
      style={{ left: `${touch.minX / ROOM_WIDTH * 100}%`, top: `${touch.minY / ROOM_HEIGHT * 100}%`, width: `${(touch.maxX - touch.minX) / ROOM_WIDTH * 100}%`, height: `${(touch.maxY - touch.minY) / ROOM_HEIGHT * 100}%`, transform: "none" }}
      aria-label={anchor.plant
        ? `Farm Plot ${plotNumber} · ${crop?.displayName ?? "Crop"} stage ${anchor.plant.stage}${artUrl ? "" : ", crop artwork unavailable"}`
        : `Farm Plot ${plotNumber}`}
      onClick={onSelect}
    >
      <span className="sr-only">Select Farm Plot</span>
    </button>
  </>;
}

function cropSeedCount(
  inventory: PlayerInventorySnapshot,
  crop: GreenhouseCropCatalogEntrySnapshot
): number {
  const matchingItems = (inventory.items ?? []).filter((item) =>
    item.resourceType === crop.seed.itemId &&
    (item.variant === crop.seed.variant ||
      (crop.seed.itemId === "giving_berry" && (item.variant === null || item.variant === "default")))
  );
  if (matchingItems.length > 0) return matchingItems.reduce((total, item) => total + item.quantity, 0);
  if (crop.seed.itemId === "wheat_seed") return inventory.totals.wheat_seed ?? 0;
  if (crop.seed.itemId === "giving_berry") return inventory.totals.giving_berry ?? 0;
  return 0;
}

function actionsForAnchor(
  anchor: GreenhouseAnchorSnapshot,
  allCrops: readonly GreenhouseCropCatalogEntrySnapshot[],
  plantableCrops: readonly GreenhouseCropCatalogEntrySnapshot[],
  seedCountFor: (crop: GreenhouseCropCatalogEntrySnapshot) => number,
  waterAvailable: boolean,
  onPlant: (anchorId: string, cropId: string) => void,
  onPlantAndWater: (anchorId: string, cropId: string) => void,
  onWater: (anchorId: string) => void,
  onClip: (anchorId: string) => void,
  onHarvest: (anchorId: string) => void,
  onTapTree: (anchorId: string) => void,
  actionBusy: boolean,
  hasVerifiedPack: boolean,
  disabled: boolean
) {
  if (!anchor.plant) {
    const candidates = plantableCrops.length > 0 ? plantableCrops : [null];
    return candidates.map((crop) => {
      const seedCount = crop ? seedCountFor(crop) : 0;
      const multiple = plantableCrops.length > 1;
      const label = crop
        ? `${waterAvailable ? "Plant and Water" : "Plant"}${multiple ? ` ${crop.displayName}` : ""}`
        : "Plant";
      const disabledReason = !crop
        ? hasVerifiedPack
          ? "No compatible crop presentation is available in this content pack."
          : "Verified crop artwork is unavailable. Try again after the content update."
        : seedCount <= 0
          ? `You need ${crop.seedDisplayName}.`
          : disabled
            ? "Greenhouse actions are unavailable."
            : actionBusy
              ? "Action in progress."
              : null;
      return {
        key: crop ? `${waterAvailable ? "plant-and-water" : "plant"}:${crop.cropId}` : "plant-unavailable",
        label,
        enabled: Boolean(crop && seedCount > 0 && !disabled && !actionBusy),
        busy: actionBusy,
        disabledReason,
        onSelect: () => {
          if (!crop || seedCount <= 0 || disabled || actionBusy) return;
          if (waterAvailable) onPlantAndWater(anchor.anchorId, crop.cropId);
          else onPlant(anchor.anchorId, crop.cropId);
        }
      };
    });
  }
  const crop = allCrops.find((entry) => entry.cropId === anchor.plant?.cropId);
  if (!crop) return [];
  const actions: Array<{
    key: string;
    label: string;
    enabled: boolean;
    busy?: boolean;
    disabledReason: string | null;
    onSelect(): void;
  }> = [];
  if (anchor.plant.stage < crop.maxStage && anchor.plant.dry && waterAvailable) actions.push({ key: "water", label: "Water", enabled: !disabled && !actionBusy, busy: actionBusy, disabledReason: disabled ? "Greenhouse actions are unavailable." : actionBusy ? "Action in progress." : null, onSelect: () => onWater(anchor.anchorId) });
  if (crop.cropId === "giving_berry_tree" && anchor.plant.dry) {
    if (anchor.plant.stage === 3 && (anchor.plant.berriesRemaining ?? 0) > 0) actions.push({ key: "clip", label: "Gather 3 Giving Berries", enabled: !disabled && !actionBusy, busy: actionBusy, disabledReason: disabled ? "Greenhouse actions are unavailable." : actionBusy ? "Action in progress." : null, onSelect: () => onClip(anchor.anchorId) });
    else if (anchor.plant.stage === crop.maxStage) {
      if (!anchor.plant.resinHarvested) actions.push({ key: "tap", label: "Tap Resin", enabled: !disabled && !actionBusy, busy: actionBusy, disabledReason: disabled ? "Greenhouse actions are unavailable." : actionBusy ? "Action in progress." : null, onSelect: () => onTapTree(anchor.anchorId) });
      actions.push({ key: "harvest", label: "Chop Tree · 4 Wood", enabled: !disabled && !actionBusy, busy: actionBusy, disabledReason: disabled ? "Greenhouse actions are unavailable." : actionBusy ? "Action in progress." : null, onSelect: () => onHarvest(anchor.anchorId) });
    }
  } else {
    if (crop.clippingStages.includes(anchor.plant.stage) && anchor.plant.dry) actions.push({ key: "clip", label: "Take Clipping", enabled: !disabled && !actionBusy, busy: actionBusy, disabledReason: disabled ? "Greenhouse actions are unavailable." : actionBusy ? "Action in progress." : null, onSelect: () => onClip(anchor.anchorId) });
    if (anchor.plant.stage === crop.maxStage) actions.push({ key: "harvest", label: `Harvest ${crop.harvestQuantity} ${crop.displayName}`, enabled: !disabled && !actionBusy, busy: actionBusy, disabledReason: disabled ? "Greenhouse actions are unavailable." : actionBusy ? "Action in progress." : null, onSelect: () => onHarvest(anchor.anchorId) });
  }
  return actions;
}

function planterActionLabel(kind: PlanterActionKind): string {
  switch (kind) {
    case "plant": return "Planting";
    case "plant-and-water": return "Planting and watering";
    case "water": return "Watering";
    case "clip": return "Taking a clipping";
    case "harvest": return "Harvesting";
    case "tap": return "Tapping resin";
  }
}

function greenhouseTimeRemainingLabel(remainingMs: number): string {
  if (remainingMs <= 0) return "ready now";
  if (remainingMs >= 60 * 60 * 1_000) return `${(remainingMs / (60 * 60 * 1_000)).toFixed(1)}h`;
  if (remainingMs >= 60 * 1_000) return `${Math.ceil(remainingMs / (60 * 1_000))}m`;
  return `${Math.ceil(remainingMs / 1_000)}s`;
}

function tankWaterLabelForState(state: GreenhouseStateSnapshot): string {
  return `${state.greenhouse.tankWaterTenths / 10}/${GREENHOUSE_TANK_CAPACITY_TENTHS / 10} gal`;
}
