import {
  MANOR_MAIN_ROOM as BASE_MANOR_MAIN_ROOM,
  manorAuthoredRoom,
  manorAuthoredPortalId,
  manorAnchorDestinations,
  manorLobbyStations,
  manorTemplateRoomNavigation,
  manorTypeTemplate,
  manorRoomPlaceholderDataUrl,
  MANOR_PLAYER_VISUAL_HEIGHT_UNITS,
  portalIds,
  resolveManorDecorationDragPosition,
  type DroppedItemSnapshot,
  type ManorDecorationSnapshot,
  type ManorDecorationPlacement,
  type ManorDecorationDefinition,
  type ManorDecorationTransform,
  type ManorSpaceId,
  type ManorOccupantPresenceSnapshot,
  type IndoorPoint,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import smithUrl from "../assets/manor-smith.svg";
import jewelUrl from "../assets/manor-jewel.svg";
import { clientAssetKeyUrl } from "../map/runtimePngAssetUrl.js";
import { MANOR_STATION_WIDTH_SHARE as MANOR_MAP_STATION_WIDTH_SHARE, type ManorMapDecorationPreview } from "../features/interiorMap/manorMapInterior.js";
import { useIndoorMovementInput } from "../movement/indoorMovementInput.js";
import type { ManorMovementTimeline } from "../movement/manorMovementTimeline.js";
import type {
  ManorInteractionIntent,
  ManorInteractionKind
} from "../features/manor/manorInteraction.js";
import { GameActionPrompt, GameConfirmationPrompt, GamePromptButton } from "./GameActionPrompt.js";
import { IndoorSceneStage } from "./IndoorSceneStage.js";
import { IndoorSceneViewport } from "./IndoorSceneViewport.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { ManorPlayerLayer } from "./ManorPlayerLayer.js";
import { groundItemGeometryForArtwork } from "./groundItemGeometry.js";
import {
  clampIndoorZoom,
  indoorPinchZoom,
  indoorWheelZoom,
  type IndoorZoomLimits
} from "./dungeonZoom.js";
import {
  clampManorCameraPan,
  type ManorCameraPan
} from "./manorCamera.js";

type ManorDecorationPreview = {
  definitionId: string;
  placementId: string | null;
  position: IndoorPoint;
  transform: ManorDecorationTransform;
};

type ManorDecorationConfirmation = ManorDecorationPreview & {
  originalTransform: ManorDecorationTransform;
};

const MANOR_CAMERA_PAN_THRESHOLD_PX = 8;
type ManorCameraGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
};

export function ManorScene({
  timeline,
  displayColor,
  appearance,
  disabled,
  movementDisabled,
  occupants,
  ownPlayerId,
  canKick,
  smithOpen = false,
  jewelOpen = false,
  interactionIntent,
  onMove,
  onInteract,
  onCancelInteraction,
  onKick,
  decorations = null,
  canEditDecorations = false,
  onRequestDecorations = () => false,
  onPlaceDecoration = () => false,
  onMoveDecoration = () => false,
  onRemoveDecoration = () => false,
  onUsePortal = () => false,
  manorId,
  manorTypeId,
  spaceId,
  drops = [],
  onSelectDroppedItem = () => undefined,
  mapRendered = false,
  mapPickRef,
  screenToLocal,
  onDecorationPreviewChange
}: {
  timeline: ManorMovementTimeline;
  disabled: boolean;
  movementDisabled: boolean;
  layout?: "desktop" | "phone";
  occupants: ManorOccupantPresenceSnapshot[];
  ownPlayerId: string;
  canKick: boolean;
  smithOpen?: boolean;
  jewelOpen?: boolean;
  interactionIntent: ManorInteractionIntent;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot | undefined;
  onMove(x: number, y: number): void;
  onInteract(kind: ManorInteractionKind): void;
  onCancelInteraction(): void;
  onKick(playerId: string): boolean;
  decorations?: ManorDecorationSnapshot | null;
  canEditDecorations?: boolean;
  onRequestDecorations?(): boolean;
  onPlaceDecoration?(definitionId: string, x?: number, y?: number): boolean;
  onMoveDecoration?(placementId: string, x: number, y: number): boolean;
  onRemoveDecoration?(placementId: string): boolean;
  onUsePortal?(
    portalId: string,
    options?: Readonly<{ approach?: "normal" | "immediate" }>
  ): boolean;
  manorId?: string;
  /** Manor type (interior space id) whose rooms, floor art, stations and doors are drawn. */
  manorTypeId?: string;
  spaceId?: ManorSpaceId;
  drops?: DroppedItemSnapshot[];
  onSelectDroppedItem?(drop: DroppedItemSnapshot): void;
  /** The map renderer draws the room; the scene keeps the HUD, prompts and placement drag. */
  mapRendered?: boolean;
  /** Map taps in room units: selects the hotspot/station/guest/drop there, true when something was hit. */
  mapPickRef?: MutableRefObject<((local: IndoorPoint) => boolean) | null>;
  /** Screen point to room units (map-rendered placement drag). */
  screenToLocal?(clientX: number, clientY: number): IndoorPoint | null;
  /** The live placement preview, drawn by the map renderer. */
  onDecorationPreviewChange?(preview: ManorMapDecorationPreview | null): void;
}): React.JSX.Element {
  const [smithSelected, setSmithSelected] = useState(false);
  const [jewelSelected, setJewelSelected] = useState(false);
  const [selectedAuthoredAnchorId, setSelectedAuthoredAnchorId] = useState<string | null>(null);
  const [selectedOccupantId, setSelectedOccupantId] = useState<string | null>(null);
  const [worldExitSelected, setWorldExitSelected] = useState(false);
  const [decorationMenuOpen, setDecorationMenuOpen] = useState(false);
  const [decorationPlacementPreview, setDecorationPlacementPreview] = useState<ManorDecorationPreview | null>(null);
  const [decorationPlacementConfirmation, setDecorationPlacementConfirmation] = useState<ManorDecorationConfirmation | null>(null);
  const decorationPlacementDragRef = useRef<{
    definitionId: string;
    placementId: string | null;
    pointerId: number | null;
    currentTransform: ManorDecorationTransform;
    latest: IndoorPoint;
  } | null>(null);
  const manorTouchPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const manorCapturedPointerIdsRef = useRef(new Set<number>());
  const manorButtonTouchPointerIdsRef = useRef(new Set<number>());
  const manorCameraGestureRef = useRef<ManorCameraGesture | null>(null);
  const manorPinchRef = useRef<{
    distance: number;
    zoom: number;
    lastCenterX: number;
    lastCenterY: number;
  } | null>(null);
  const manorPointerGestureSuppressedRef = useRef(false);
  const manorSuppressClicksUntilRef = useRef(0);
  const manorIgnoreUntrackedPointerUpsRef = useRef(true);
  const manorTemplate = manorTypeTemplate(manorTypeId);
  const authoredRoom = manorAuthoredRoom(spaceId ?? "manor_main_room", manorTypeId) ??
    manorAuthoredRoom("manor_main_room", manorTypeId)!;
  const isMainRoom = authoredRoom.id === manorTemplate.defaultRoomId;
  const lobbyStations = manorLobbyStations(manorTypeId);
  const smithStation = isMainRoom ? lobbyStations.smith : undefined;
  const jewelStation = isMainRoom ? lobbyStations.jewel : undefined;
  const worldExit = authoredRoom.worldExit;
  const worldExitPolygon = worldExit?.polygon ?? (worldExit ? [
    { x: worldExit.x - 60, y: worldExit.y - 60 }, { x: worldExit.x + 60, y: worldExit.y - 60 },
    { x: worldExit.x + 60, y: worldExit.y + 60 }, { x: worldExit.x - 60, y: worldExit.y + 60 }
  ] : null);
  const MANOR_MAIN_ROOM = { ...BASE_MANOR_MAIN_ROOM, ...manorTemplateRoomNavigation(authoredRoom) };
  const authoredTheme = manorTemplate.theme;
  const activeAuthoredAnchors = authoredRoom.anchors.filter((anchor) =>
    !anchor.retired && anchor.type !== "spawn"
  );
  const activeAuthoredHotspots = authoredRoom.portalHotspots.filter((hotspot) =>
    !hotspot.retired && activeAuthoredAnchors.some((anchor) => anchor.id === hotspot.anchorId)
  );
  const pointX = (value: number): string => `${value / MANOR_MAIN_ROOM.roomWidth * 100}%`;
  const pointY = (value: number): string => `${value / MANOR_MAIN_ROOM.roomHeight * 100}%`;
  const floorRef = useRef<HTMLDivElement>(null);
  const stageShellRef = useRef<HTMLDivElement>(null);
  const manorZoomLimits: IndoorZoomLimits = {
    minZoom: 1,
    defaultZoom: 1,
    maxZoom: 2.1
  };
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [cameraPan, setCameraPan] = useState<ManorCameraPan>({ x: 0, y: 0 });
  const cameraPanRef = useRef<ManorCameraPan>({ x: 0, y: 0 });
  const decorationPoint = (event: React.PointerEvent): { x: number; y: number } => {
    if (mapRendered && screenToLocal && decorations) {
      const local = screenToLocal(event.clientX, event.clientY) ?? { x: 0, y: 0 };
      return {
        x: Math.max(0, Math.min(decorations.roomWidth, local.x)),
        y: Math.max(0, Math.min(decorations.roomHeight, local.y))
      };
    }
    const bounds = floorRef.current?.getBoundingClientRect();
    if (!bounds || !decorations) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(decorations.roomWidth,
        (event.clientX - bounds.left) / Math.max(1, bounds.width) * decorations.roomWidth)),
      y: Math.max(0, Math.min(decorations.roomHeight,
        (event.clientY - bounds.top) / Math.max(1, bounds.height) * decorations.roomHeight))
    };
  };
  const clampCameraPan = (nextPan: ManorCameraPan, nextZoom = zoomRef.current): ManorCameraPan => {
    const bounds = stageShellRef.current?.getBoundingClientRect();
    return clampManorCameraPan(nextPan, {
      roomWidth: MANOR_MAIN_ROOM.roomWidth,
      roomHeight: MANOR_MAIN_ROOM.roomHeight,
      viewportWidth: bounds?.width ?? 0,
      viewportHeight: bounds?.height ?? 0,
      zoom: nextZoom
    });
  };
  const setClampedCameraPan = (nextPan: ManorCameraPan, nextZoom = zoomRef.current): void => {
    const clamped = clampCameraPan(nextPan, nextZoom);
    cameraPanRef.current = clamped;
    setCameraPan((current) => current.x === clamped.x && current.y === clamped.y ? current : clamped);
  };
  const applyZoom = (nextZoom: number): void => {
    const clamped = clampIndoorZoom(nextZoom, manorZoomLimits);
    zoomRef.current = clamped;
    setZoom(clamped);
    setClampedCameraPan(cameraPanRef.current, clamped);
  };
  const openDecorationMenu = (): void => {
    setWorldExitSelected(false);
    setDecorationMenuOpen(true);
    onRequestDecorations();
  };
  const resolveDecorationDefinitionDrag = (
    definition: ManorDecorationDefinition,
    requestedPosition: IndoorPoint,
    currentTransform = definition.transform
  ): IndoorPoint | null => {
    const surface = authoredRoom.placementSurfaces.find((candidate) =>
      candidate.id === definition.surfaceId && !candidate.retired
    );
    if (!surface) return null;
    return resolveManorDecorationDragPosition({
      decoration: definition,
      surface,
      currentTransform,
      requestedPosition,
      collisionPolygons: authoredRoom.colliders
        .filter((collider) => !collider.retired)
        .map((collider) => collider.points)
    });
  };
  const beginDecorationPlacement = (definitionId: string): void => {
    const entry = decorations?.definitions.find((candidate) => candidate.definition.id === definitionId);
    if (!entry || entry.definition.retired || entry.availableQuantity <= 0 || !canEditDecorations || disabled) return;
    setDecorationMenuOpen(false);
    setWorldExitSelected(false);
    setDecorationPlacementConfirmation(null);
    decorationPlacementDragRef.current = null;
    setDecorationPlacementPreview({
      definitionId,
      placementId: null,
      position: { x: entry.definition.transform.x, y: entry.definition.transform.y },
      transform: { ...entry.definition.transform }
    });
  };
  const beginDecorationMove = (placementId: string): void => {
    const placement = decorations?.placements.find((candidate) => candidate.placementId === placementId);
    const definition = placement && decorations?.definitions.find((entry) =>
      entry.definition.id === placement.definitionId
    )?.definition;
    if (!placement || !definition || definition.placementMode !== "movable" || !canEditDecorations || disabled) return;
    setDecorationMenuOpen(false);
    setWorldExitSelected(false);
    setDecorationPlacementConfirmation(null);
    decorationPlacementDragRef.current = null;
    setDecorationPlacementPreview({
      definitionId: definition.id,
      placementId: placement.placementId,
      position: { x: placement.transform.x, y: placement.transform.y },
      transform: { ...placement.transform }
    });
  };
  const beginDecorationPlacementPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const preview = decorationPlacementPreview;
    if (!preview || disabled) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const definition = decorations?.definitions.find((entry) =>
      entry.definition.id === preview.definitionId
    )?.definition;
    if (!definition) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const position = resolveDecorationDefinitionDrag(
      definition,
      decorationPoint(event),
      preview.transform
    );
    if (!position) return;
    decorationPlacementDragRef.current = {
      definitionId: definition.id,
      placementId: preview.placementId,
      pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
      currentTransform: preview.transform,
      latest: position
    };
    setDecorationPlacementPreview((current) => current
      ? { ...current, position }
      : current);
  };
  const moveDecorationPlacementPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = decorationPlacementDragRef.current;
    if (!drag) return;
    const definition = decorations?.definitions.find((entry) =>
      entry.definition.id === drag.definitionId
    )?.definition;
    if (!definition) return;
    event.preventDefault();
    event.stopPropagation();
    const position = resolveDecorationDefinitionDrag(
      definition,
      decorationPoint(event),
      drag.currentTransform
    );
    if (!position) return;
    drag.latest = position;
    setDecorationPlacementPreview((current) => current
      ? { ...current, position }
      : current);
  };
  const endDecorationPlacementPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = decorationPlacementDragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    decorationPlacementDragRef.current = null;
    const definition = decorations?.definitions.find((entry) =>
      entry.definition.id === drag.definitionId
    )?.definition;
    const position = definition
      ? resolveDecorationDefinitionDrag(definition, drag.latest, drag.currentTransform)
      : null;
    if (position) {
      const preview = decorationPlacementPreview;
      setDecorationPlacementPreview((current) => current
        ? { ...current, position }
        : current);
      setDecorationPlacementConfirmation({
        definitionId: drag.definitionId,
        placementId: drag.placementId,
        position,
        transform: preview?.transform ?? drag.currentTransform,
        originalTransform: preview?.transform ?? drag.currentTransform
      });
    }
  };
  const cancelDecorationPlacement = (): void => {
    decorationPlacementDragRef.current = null;
    setDecorationPlacementPreview(null);
    setDecorationPlacementConfirmation(null);
  };
  const confirmDecorationPlacement = (): void => {
    const confirmation = decorationPlacementConfirmation;
    if (!confirmation) return;
    const accepted = confirmation.placementId
      ? onMoveDecoration(confirmation.placementId, confirmation.position.x, confirmation.position.y)
      : onPlaceDecoration(confirmation.definitionId, confirmation.position.x, confirmation.position.y);
    if (accepted) {
      setDecorationPlacementPreview(null);
      setDecorationPlacementConfirmation(null);
    }
  };
  const movementInput = useIndoorMovementInput({
    stageRef: floorRef,
    roomWidth: MANOR_MAIN_ROOM.roomWidth,
    roomHeight: MANOR_MAIN_ROOM.roomHeight,
    movementDisabled: movementDisabled || decorationPlacementPreview !== null ||
      decorationPlacementConfirmation !== null,
    pointerGestureSuppressedRef: manorPointerGestureSuppressedRef,
    useTransformedBounds: true,
    onBeforeMove: () => {
      setSmithSelected(false);
      setJewelSelected(false);
      setSelectedAuthoredAnchorId(null);
      setSelectedOccupantId(null);
      setWorldExitSelected(false);
      setDecorationMenuOpen(false);
    },
    onMove
  });
  const suppressManorPointerGesture = (): void => {
    manorPointerGestureSuppressedRef.current = true;
    manorSuppressClicksUntilRef.current = performance.now() + 500;
    movementInput.clearPendingMovement();
  };
  const beginManorCameraPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (
      disabled ||
      movementDisabled ||
      event.button !== 0 ||
      !Number.isFinite(event.pointerId) ||
      (event.target as Element | null)?.closest("button") ||
      decorationPlacementPreview !== null
    ) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    manorCapturedPointerIdsRef.current.add(event.pointerId);
    manorCameraGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false
    };
  };
  const moveManorCameraPointer = (event: React.PointerEvent<HTMLDivElement>): boolean => {
    const gesture = manorCameraGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    const deltaX = event.clientX - gesture.lastX;
    const deltaY = event.clientY - gesture.lastY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (!gesture.active && zoomRef.current > manorZoomLimits.minZoom && Math.hypot(
      event.clientX - gesture.startX,
      event.clientY - gesture.startY
    ) > MANOR_CAMERA_PAN_THRESHOLD_PX) {
      gesture.active = true;
      suppressManorPointerGesture();
    }
    if (!gesture.active) return false;
    event.preventDefault();
    event.stopPropagation();
    setClampedCameraPan({
      x: cameraPanRef.current.x + deltaX,
      y: cameraPanRef.current.y + deltaY
    });
    return true;
  };
  const finishManorCameraPointer = (pointerId: number): boolean => {
    const gesture = manorCameraGestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return false;
    manorCameraGestureRef.current = null;
    return gesture.active;
  };
  const resetManorTouchPointers = (): void => {
    const stage = floorRef.current;
    for (const pointerId of manorCapturedPointerIdsRef.current) {
      try {
        if (!stage || !stage.hasPointerCapture || stage.hasPointerCapture(pointerId)) {
          stage?.releasePointerCapture?.(pointerId);
        }
      } catch {
        // Pointer capture can already be gone when the scene loses focus.
      }
    }
    manorTouchPointersRef.current.clear();
    manorCapturedPointerIdsRef.current.clear();
    manorButtonTouchPointerIdsRef.current.clear();
    manorCameraGestureRef.current = null;
    manorPinchRef.current = null;
    manorPointerGestureSuppressedRef.current = false;
    manorSuppressClicksUntilRef.current = 0;
    manorIgnoreUntrackedPointerUpsRef.current = true;
    movementInput.clearPendingMovement();
  };
  useEffect(() => {
    const reset = (): void => resetManorTouchPointers();
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    window.addEventListener("pageshow", reset);
    return () => {
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pagehide", reset);
      window.removeEventListener("pageshow", reset);
    };
  }, [movementInput.clearPendingMovement]);
  useEffect(() => {
    const clampCurrentPan = (): void => {
      const bounds = stageShellRef.current?.getBoundingClientRect();
      const clamped = clampManorCameraPan(cameraPanRef.current, {
        roomWidth: MANOR_MAIN_ROOM.roomWidth,
        roomHeight: MANOR_MAIN_ROOM.roomHeight,
        viewportWidth: bounds?.width ?? 0,
        viewportHeight: bounds?.height ?? 0,
        zoom: zoomRef.current
      });
      cameraPanRef.current = clamped;
      setCameraPan((current) => current.x === clamped.x && current.y === clamped.y ? current : clamped);
    };
    clampCurrentPan();
    window.addEventListener("resize", clampCurrentPan);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(clampCurrentPan);
    if (stageShellRef.current) observer?.observe(stageShellRef.current);
    return () => {
      window.removeEventListener("resize", clampCurrentPan);
      observer?.disconnect();
    };
  }, []);
  useEffect(() => {
    zoomRef.current = manorZoomLimits.defaultZoom;
    setZoom(manorZoomLimits.defaultZoom);
    cameraPanRef.current = { x: 0, y: 0 };
    setCameraPan({ x: 0, y: 0 });
    manorCameraGestureRef.current = null;
    manorPinchRef.current = null;
  }, [manorId, spaceId, timeline.currentSessionId()]);
  useEffect(() => () => resetManorTouchPointers(), [movementInput.clearPendingMovement]);
  const handleManorPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    movementInput.onPointerDownCapture(event);
    if (event.pointerType !== "touch") {
      beginDecorationPlacementPointer(event);
      if (!decorationPlacementDragRef.current) beginManorCameraPointer(event);
      return;
    }
    if (manorTouchPointersRef.current.size === 0 &&
        manorButtonTouchPointerIdsRef.current.size === 0 &&
        (manorPointerGestureSuppressedRef.current ||
          performance.now() < manorSuppressClicksUntilRef.current)) {
      manorPointerGestureSuppressedRef.current = false;
      manorSuppressClicksUntilRef.current = 0;
    }
    const target = event.target as Element | null;
    if (target?.closest("button")) {
      if (Number.isFinite(event.pointerId)) {
        if (manorButtonTouchPointerIdsRef.current.size > 0) {
          suppressManorPointerGesture();
        }
        manorButtonTouchPointerIdsRef.current.add(event.pointerId);
      }
      return;
    }
    if (!Number.isFinite(event.pointerId)) {
      manorIgnoreUntrackedPointerUpsRef.current = false;
      beginDecorationPlacementPointer(event);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    manorCapturedPointerIdsRef.current.add(event.pointerId);
    manorTouchPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY
    });
    if (manorTouchPointersRef.current.size < 2) {
      beginDecorationPlacementPointer(event);
      if (!decorationPlacementDragRef.current) beginManorCameraPointer(event);
      return;
    }
    manorCameraGestureRef.current = null;
    suppressManorPointerGesture();
    const [first, second] = [...manorTouchPointersRef.current.values()];
    if (first && second) {
      const centerX = (first.x + second.x) / 2;
      const centerY = (first.y + second.y) / 2;
      manorPinchRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        zoom: zoomRef.current,
        lastCenterX: centerX,
        lastCenterY: centerY
      };
    }
  };
  const handleManorPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    movementInput.onPointerMove(event);
    if (event.pointerType === "touch" && manorTouchPointersRef.current.has(event.pointerId)) {
      manorTouchPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });
      if (manorPinchRef.current && manorTouchPointersRef.current.size >= 2) {
        event.preventDefault();
        event.stopPropagation();
        const [first, second] = [...manorTouchPointersRef.current.values()];
        if (first && second) {
          const centerX = (first.x + second.x) / 2;
          const centerY = (first.y + second.y) / 2;
          const centerDeltaX = centerX - manorPinchRef.current.lastCenterX;
          const centerDeltaY = centerY - manorPinchRef.current.lastCenterY;
          applyZoom(indoorPinchZoom(
            manorPinchRef.current.zoom,
            manorPinchRef.current.distance,
            Math.hypot(second.x - first.x, second.y - first.y),
            manorZoomLimits
          ));
          setClampedCameraPan({
            x: cameraPanRef.current.x + centerDeltaX,
            y: cameraPanRef.current.y + centerDeltaY
          });
          manorPinchRef.current.lastCenterX = centerX;
          manorPinchRef.current.lastCenterY = centerY;
        }
      } else {
        moveManorCameraPointer(event);
      }
    } else {
      moveManorCameraPointer(event);
    }
    const drag = decorationPlacementDragRef.current;
    if (!drag || drag.pointerId === null || drag.pointerId === event.pointerId) {
      moveDecorationPlacementPointer(event);
    }
  };
  const handleManorPointerUpCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    const cameraPanGesture = finishManorCameraPointer(event.pointerId);
    if (cameraPanGesture) {
      suppressManorPointerGesture();
      event.preventDefault();
      event.stopPropagation();
    }
    const suppressedGesture = manorPointerGestureSuppressedRef.current;
    const trackedPointer = manorTouchPointersRef.current.has(event.pointerId) ||
      manorCapturedPointerIdsRef.current.has(event.pointerId) ||
      manorButtonTouchPointerIdsRef.current.has(event.pointerId);
    manorTouchPointersRef.current.delete(event.pointerId);
    manorCapturedPointerIdsRef.current.delete(event.pointerId);
    manorButtonTouchPointerIdsRef.current.delete(event.pointerId);
    try {
      if (!event.currentTarget.hasPointerCapture || event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // The browser may have released capture before this event.
    }
    if (manorTouchPointersRef.current.size === 0 && manorButtonTouchPointerIdsRef.current.size === 0 &&
        (suppressedGesture || performance.now() >= manorSuppressClicksUntilRef.current)) {
      manorPinchRef.current = null;
      manorPointerGestureSuppressedRef.current = false;
    }
    const drag = decorationPlacementDragRef.current;
    if (drag && (drag.pointerId === null || drag.pointerId === event.pointerId)) {
      endDecorationPlacementPointer(event);
      return;
    }
    if (!cameraPanGesture && !suppressedGesture &&
        (trackedPointer || !manorIgnoreUntrackedPointerUpsRef.current)) {
      movementInput.onPointerUp(event);
    }
  };
  const handleManorPointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    movementInput.onPointerCancel(event);
    const cameraPanGesture = manorCameraGestureRef.current?.pointerId === event.pointerId;
    const trackedPointer = manorTouchPointersRef.current.has(event.pointerId) ||
      manorCapturedPointerIdsRef.current.has(event.pointerId) ||
      manorButtonTouchPointerIdsRef.current.has(event.pointerId);
    const drag = decorationPlacementDragRef.current;
    const trackedDrag = Boolean(drag &&
      (drag.pointerId === null || drag.pointerId === event.pointerId));
    if (!trackedPointer && !trackedDrag && !cameraPanGesture && Number.isFinite(event.pointerId)) return;
    resetManorTouchPointers();
    cancelDecorationPlacement();
  };
  const handleManorLostPointerCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    movementInput.onLostPointerCapture(event);
    const cameraPanGesture = manorCameraGestureRef.current?.pointerId === event.pointerId;
    const trackedPointer = manorTouchPointersRef.current.has(event.pointerId) ||
      manorCapturedPointerIdsRef.current.has(event.pointerId) ||
      manorButtonTouchPointerIdsRef.current.has(event.pointerId);
    const drag = decorationPlacementDragRef.current;
    const trackedDrag = Boolean(drag &&
      (drag.pointerId === null || drag.pointerId === event.pointerId));
    if (!trackedPointer && !trackedDrag && !cameraPanGesture) return;
    resetManorTouchPointers();
    if (trackedDrag) cancelDecorationPlacement();
  };
  const handleManorClickCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (performance.now() < manorSuppressClicksUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const movementStageProps = {
    onClick: movementInput.onClick,
    onDoubleClick: movementInput.onDoubleClick
  };
  const openSelectedSmith = (): void => {
    setSmithSelected(false);
    onInteract("smith");
  };
  const openSelectedJewel = (): void => {
    setJewelSelected(false);
    onInteract("jewel");
  };
  const leaveThroughDoor = (): void => {
    setWorldExitSelected(false);
    if (manorId) {
      // The server walks the player to the authored door before committing;
      // moving elsewhere cancels the transition.
      onUsePortal(portalIds.manorMainToWorld(manorId));
      return;
    }
    // Keep the component's isolated/legacy harness behavior when no Manor
    // identity is supplied. The live scene always has manorId and uses the
    // universal portal callback above.
    onInteract("door");
  };
  useEffect(() => {
    if (smithOpen) setSmithSelected(false);
  }, [smithOpen]);
  useEffect(() => {
    if (jewelOpen) setJewelSelected(false);
  }, [jewelOpen]);
  const selectedOccupant = occupants.find(({ playerId }) => playerId === selectedOccupantId) ?? null;
  const selectedAuthoredHotspot = activeAuthoredHotspots.find((hotspot) =>
    hotspot.anchorId === selectedAuthoredAnchorId
  ) ?? null;
  const selectedAuthoredAnchor = activeAuthoredAnchors.find((anchor) =>
    anchor.id === selectedAuthoredAnchorId
  ) ?? null;
  const visibleManorDrops = aggregateManorDrops(drops.filter((drop) =>
    drop.manorId === manorId &&
    drop.spaceId === spaceId &&
    Number.isFinite(drop.localX) &&
    Number.isFinite(drop.localY)
  ));
  const visibleManorDropPiles = groupManorDropsByPile(visibleManorDrops);
  const decorationDefinitions = decorations?.definitions.filter((entry) => !entry.definition.retired) ?? [];
  useEffect(() => {
    if (mapRendered) onDecorationPreviewChange?.(decorationPlacementPreview);
  }, [mapRendered, decorationPlacementPreview, onDecorationPreviewChange]);
  useEffect(() => () => onDecorationPreviewChange?.(null), [onDecorationPreviewChange]);
  if (mapPickRef) {
    // Same targets, priority and selection side effects as the DOM scene's buttons (topmost first).
    mapPickRef.current = mapRendered ? (local: IndoorPoint): boolean => {
      if (decorationPlacementPreview) return true;
      const clearSelections = (): void => {
        setSmithSelected(false);
        setJewelSelected(false);
        setSelectedAuthoredAnchorId(null);
        setSelectedOccupantId(null);
        setWorldExitSelected(false);
        setDecorationMenuOpen(false);
      };
      const select = (apply: () => void): boolean => {
        if (interactionIntent) onCancelInteraction();
        clearSelections();
        apply();
        return true;
      };
      const stationHalf = MANOR_MAIN_ROOM.roomWidth * MANOR_MAP_STATION_WIDTH_SHARE / 2;
      const nearStation = (station: { x: number; y: number } | undefined): boolean => Boolean(station &&
        Math.abs(local.x - station.x) <= stationHalf && Math.abs(local.y - station.y) <= stationHalf);
      if (canKick) {
        const occupant = occupants.find((candidate) => candidate.playerId !== ownPlayerId &&
          Math.abs(local.x - candidate.position.x) <= MANOR_PLAYER_VISUAL_HEIGHT_UNITS * 0.4 &&
          local.y <= candidate.position.y + MANOR_PLAYER_VISUAL_HEIGHT_UNITS * 0.15 &&
          local.y >= candidate.position.y - MANOR_PLAYER_VISUAL_HEIGHT_UNITS * 1.1);
        if (occupant) return select(() => setSelectedOccupantId(occupant.playerId));
      }
      if (!disabled && interactionIntent?.phase !== "requesting") {
        if (nearStation(jewelStation)) return select(() => setJewelSelected(true));
        if (nearStation(smithStation)) return select(() => setSmithSelected(true));
      }
      for (const pile of [...visibleManorDropPiles].reverse()) {
        for (const drop of [...pile.drops].reverse()) {
          const ground = groundItemGeometryForArtwork(drop.backpackInstanceId ? "pack" : drop.itemId, drop.variant,
            MANOR_PLAYER_VISUAL_HEIGHT_UNITS);
          const centerX = drop.localX! + ground.hitOffsetXUnits;
          const centerY = drop.localY! + ground.hitOffsetYUnits;
          if (Math.abs(local.x - centerX) > ground.hitWidthUnits / 2 ||
              Math.abs(local.y - centerY) > ground.hitHeightUnits / 2) continue;
          if (!canEditDecorations || disabled) return true;
          clearSelections();
          onSelectDroppedItem(drop);
          return true;
        }
      }
      if (worldExit && worldExitPolygon && pointInManorPolygon(local, worldExitPolygon)) {
        return select(() => setWorldExitSelected(true));
      }
      const hotspot = [...activeAuthoredHotspots].reverse().find((candidate) => pointInManorPolygon(local, candidate.polygon));
      if (hotspot) return select(() => setSelectedAuthoredAnchorId(hotspot.anchorId));
      clearSelections();
      return false;
    } : null;
  }
  const hud = (
    <>
          <button
            type="button"
            className="manor-decorations-hud"
            disabled={disabled}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (interactionIntent) onCancelInteraction();
              setSmithSelected(false);
              setJewelSelected(false);
              setSelectedAuthoredAnchorId(null);
              setSelectedOccupantId(null);
              openDecorationMenu();
            }}
          >
            Decorations
          </button>
          {smithSelected ? (
            <GameActionPrompt
              title="Smithing Station"
              category="CRAFTING"
              actions={[{
                key: "use-smithing",
                label: "Use Smithing",
                enabled: !disabled,
                disabledReason: disabled
                  ? "The Smithing Station is unavailable while disconnected."
                  : null,
                onSelect: openSelectedSmith
              }]}
              onCancel={() => {
                setSmithSelected(false);
                onCancelInteraction();
              }}
            />
          ) : null}
          {jewelSelected ? (
            <GameActionPrompt
              title="Jewel Station"
              category="CRAFTING"
              actions={[{
                key: "use-jewel",
                label: "Use Jewel Station",
                enabled: !disabled,
                disabledReason: disabled
                  ? "The Jewel Station is unavailable while disconnected."
                  : null,
                onSelect: openSelectedJewel
              }]}
              onCancel={() => {
                setJewelSelected(false);
                onCancelInteraction();
              }}
            />
          ) : null}
          {worldExitSelected && worldExit ? (
            <GameActionPrompt
              title={worldExit.interactionLabel}
              category="PORTAL"
              actions={[{
                key: "leave-manor",
                label: worldExit.label ?? "Leave Manor",
                enabled: !disabled,
                disabledReason: disabled
                  ? "Leaving Manor is unavailable while disconnected."
                  : null,
                onSelect: leaveThroughDoor
              }]}
              onCancel={() => setWorldExitSelected(false)}
            />
          ) : null}
          {selectedOccupant ? (
            <GameActionPrompt
              title={selectedOccupant.displayName}
              category="MANOR GUEST"
              actions={[{
                key: "remove-guest",
                label: "Remove Guest",
                enabled: !disabled && canKick,
                disabledReason: "Only the manor owner can remove a guest.",
                tone: "danger",
                onSelect: () => {
                  if (onKick(selectedOccupant.playerId)) setSelectedOccupantId(null);
                }
              }]}
              onCancel={() => setSelectedOccupantId(null)}
            />
          ) : null}
          {selectedAuthoredAnchor ? (
            <GameActionPrompt
              title={selectedAuthoredAnchor.message ? "Manor Message" : selectedAuthoredHotspot?.interactionLabel ?? "Manor Interaction"}
              category={selectedAuthoredAnchor.type === "portal" ? "PORTAL" : "MANOR MESSAGE"}
              message={selectedAuthoredAnchor.message ? { text: selectedAuthoredAnchor.message } : null}
              actions={selectedAuthoredAnchor.type === "portal" && manorId ? (() => {
                // One button per destination, labelled with the text typed in Studio.
                const destinations = manorAnchorDestinations(selectedAuthoredAnchor);
                const several = destinations.length > 1;
                return destinations.map((destination) => ({
                  key: `use-${selectedAuthoredAnchor.id}-${destination.destinationRoomId}`,
                  label: destination.label ?? selectedAuthoredHotspot?.interactionLabel ?? "Enter room",
                  enabled: !disabled && !destination.locked,
                  disabledReason: destination.locked ? "This door is locked." : disabled ? "This doorway is unavailable while disconnected." : null,
                  onSelect: () => {
                    const portalId = manorAuthoredPortalId(manorId, authoredRoom.id, selectedAuthoredAnchor.id,
                      several ? destination.destinationRoomId : undefined);
                    setSelectedAuthoredAnchorId(null);
                    onUsePortal(portalId);
                  }
                }));
              })() : []}
              cancelLabel={selectedAuthoredAnchor.type === "portal" ? "Cancel" : "Close"}
              onCancel={() => setSelectedAuthoredAnchorId(null)}
            />
          ) : null}
          {decorationMenuOpen ? (
            <GameActionPrompt
              className="manor-decoration-menu-prompt"
              title="Manor Decorations"
              category="DECORATIONS"
              detail={canEditDecorations
                ? "Choose a decoration to preview it on its authored surface."
                : "Read-only view of this Manor."}
              content={!decorations ? <p role="status">Loading authored decorations…</p> : (
                <div className="manor-decoration-menu-content">
                  <div className="manor-decoration-menu-list">
                    {decorationDefinitions.map((entry) => {
                      const inventoryBacked = entry.definition.itemId !== null;
                      const disabledReason = !canEditDecorations
                        ? "Only the manor owner can place decorations."
                        : entry.availableQuantity <= 0
                          ? inventoryBacked
                            ? "All owned copies are already placed in this Manor."
                            : "This starter decoration is already placed in this Manor."
                          : disabled
                            ? "Decorations are unavailable while disconnected."
                            : null;
                      const availability = inventoryBacked
                        ? `Owned ${entry.ownedQuantity} · Available ${entry.availableQuantity}`
                        : entry.availableQuantity > 0
                          ? "Starter decoration · Available"
                          : "Starter decoration · Already placed";
                      return <GamePromptButton
                        key={entry.definition.id}
                        className="manor-decoration-menu-choice"
                        disabled={disabledReason !== null}
                        aria-label={`Place ${entry.definition.name}`}
                        onClick={() => beginDecorationPlacement(entry.definition.id)}
                      >
                        <span>
                          <strong>{`Place ${entry.definition.name}`}</strong>
                          <small>{availability}</small>
                          {disabledReason ? <small className="game-compact-disabled-reason">{disabledReason}</small> : null}
                        </span>
                        {inventoryBacked ? <span className="manor-decoration-menu-item-note">{entry.definition.itemId}</span> : null}
                      </GamePromptButton>;
                    })}
                    {decorationDefinitions.length === 0 ? <p className="empty-copy">No authored decorations are currently available.</p> : null}
                  </div>
                  {decorations.placements.length > 0 ? (
                    <div className="manor-decoration-placed-list">
                      <h3>Placed in this Manor</h3>
                      {decorations.placements.map((placement) => {
                        const definition = decorations.definitions.find((entry) =>
                          entry.definition.id === placement.definitionId
                        )?.definition;
                        const name = definition?.name ?? "Decoration";
                        if (placement.authoredDefault || definition?.placementMode !== "movable") {
                          return <div key={placement.placementId} className="manor-decoration-placed-row">
                            <span>
                              <strong>{name}</strong>
                              <small>{placement.authoredDefault
                                ? "Authored template default"
                                : "Permanent authored fixture"}</small>
                            </span>
                          </div>;
                        }
                        const disabledReason = !canEditDecorations
                          ? "Only the manor owner can store decorations."
                          : disabled
                            ? "Decorations are unavailable while disconnected."
                            : null;
                        const actionsDisabled = disabledReason !== null;
                        return <div key={placement.placementId} className="manor-decoration-placed-row">
                          <span>
                            <strong>{name}</strong>
                            <small>Placed in this Manor</small>
                            {disabledReason ? <small className="game-compact-disabled-reason">{disabledReason}</small> : null}
                          </span>
                          <span className="manor-decoration-row-actions">
                            <GamePromptButton
                              className="manor-decoration-menu-choice manor-decoration-menu-choice--inline"
                              disabled={actionsDisabled}
                              aria-label={`Move ${name}`}
                              onClick={() => beginDecorationMove(placement.placementId)}
                            >
                              Move
                            </GamePromptButton>
                            <GamePromptButton
                              className="manor-decoration-menu-choice manor-decoration-menu-choice--inline"
                              disabled={actionsDisabled}
                              aria-label={`Store ${name}`}
                              onClick={() => {
                                if (onRemoveDecoration(placement.placementId)) setDecorationMenuOpen(true);
                              }}
                            >
                              Store
                            </GamePromptButton>
                          </span>
                        </div>;
                      })}
                    </div>
                  ) : null}
                </div>
              )}
              actions={[]}
              cancelLabel="Close"
              onCancel={() => setDecorationMenuOpen(false)}
            />
          ) : null}
          {decorationPlacementConfirmation ? (() => {
            const definition = decorations?.definitions.find((entry) =>
              entry.definition.id === decorationPlacementConfirmation.definitionId
            )?.definition;
            return <GameConfirmationPrompt
              title={`${decorationPlacementConfirmation.placementId ? "Move" : "Place"} ${definition?.name ?? "Decoration"} Here?`}
              category="DECORATIONS"
              confirmLabel="Yes"
              cancelLabel="No"
              onConfirm={confirmDecorationPlacement}
              onCancel={cancelDecorationPlacement}
            />;
          })() : null}
    </>
  );
  if (mapRendered) {
    // The map renderer draws the room, players, stations and decorations (INTERIOR_MAP_RENDERER.md P4);
    // this layer keeps only the HUD, the prompts and, while a decoration is being placed, the drag surface.
    return (
      <IndoorSceneViewport className="manor-map-hud" ariaLabel="Private player manor">
        {decorationPlacementPreview ? <div
          className="manor-map-placement-capture"
          data-manor-placement-capture=""
          onPointerDown={beginDecorationPlacementPointer}
          onPointerMove={moveDecorationPlacementPointer}
          onPointerUp={endDecorationPlacementPointer}
          onPointerCancel={cancelDecorationPlacement}
        /> : null}
        {hud}
      </IndoorSceneViewport>
    );
  }
  return (
    <IndoorSceneViewport className="manor-scene" ariaLabel="Private player manor">
      <div
        className="manor-stage-shell"
        ref={stageShellRef}
        onWheel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          applyZoom(indoorWheelZoom(zoomRef.current, event.deltaY, manorZoomLimits));
        }}
      >
      <IndoorSceneStage
        roomWidth={MANOR_MAIN_ROOM.roomWidth}
        roomHeight={MANOR_MAIN_ROOM.roomHeight}
        scale={zoom}
        {...(cameraPan.x === 0 && cameraPan.y === 0 ? {} : { translation: cameraPan })}
        innerClassName="manor-floor"
        frameClassName="manor-stage-wrap"
        stageRef={floorRef}
        stageStyle={{
          "--manor-floor-color": authoredTheme.floorColor,
          "--manor-wall-color": authoredTheme.wallColor
        } as React.CSSProperties}
        data-manor-template={manorTemplate.id}
        data-manor-revision={manorTemplate.revision}
        data-manor-theme={authoredTheme.themeId}
        {...movementStageProps}
        onPointerDownCapture={handleManorPointerDownCapture}
        onPointerMove={handleManorPointerMove}
        onPointerUpCapture={handleManorPointerUpCapture}
        onPointerCancel={handleManorPointerCancel}
        onLostPointerCapture={handleManorLostPointerCapture}
        onClickCapture={handleManorClickCapture}
      >
          <img
            className="manor-floor-art"
            src={(authoredRoom.floorAssetKey ? manorDecorationAssetUrl(authoredRoom.floorAssetKey) : null) ?? manorRoomPlaceholderDataUrl(authoredRoom)}
            alt=""
            draggable={false}
            data-manor-asset-key={authoredRoom.floorAssetKey ?? authoredTheme.floorAssetKey}
          />
          {activeAuthoredHotspots.map((hotspot) => (
            <button
              key={hotspot.id}
              type="button"
              className="manor-authored-hotspot"
              aria-label={hotspot.interactionLabel}
              style={{ clipPath: manorPolygonClipPath(hotspot.polygon, MANOR_MAIN_ROOM.roomWidth, MANOR_MAIN_ROOM.roomHeight) }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (interactionIntent) onCancelInteraction();
                setSelectedAuthoredAnchorId(hotspot.anchorId);
                setSmithSelected(false);
                setJewelSelected(false);
                setSelectedOccupantId(null);
                setWorldExitSelected(false);
              }}
            />
          ))}
          {worldExit && worldExitPolygon ? <button
            type="button"
            className="manor-authored-hotspot manor-world-exit-hotspot"
            aria-label={worldExit.interactionLabel}
            data-manor-world-exit={worldExit.anchorId}
            style={{ clipPath: manorPolygonClipPath(worldExitPolygon, MANOR_MAIN_ROOM.roomWidth, MANOR_MAIN_ROOM.roomHeight) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (interactionIntent) onCancelInteraction();
              setWorldExitSelected(true);
              setSelectedAuthoredAnchorId(null);
              setSmithSelected(false);
              setJewelSelected(false);
              setSelectedOccupantId(null);
            }}
          /> : null}
          {visibleManorDropPiles.map((pile) => <div
            key={pile.pileId}
            className="manor-ground-pile"
            data-manor-pile-id={pile.pileId}
            style={{ display: "contents" }}
          >{pile.drops.map((drop) => {
            const artworkItemId = drop.backpackInstanceId ? "pack" : drop.itemId;
            const ground = groundItemGeometryForArtwork(
              artworkItemId,
              drop.variant,
              MANOR_PLAYER_VISUAL_HEIGHT_UNITS
            );
            return <button
              key={drop.dropId}
              type="button"
              className="manor-ground-equipment"
              data-ground-visual-height={ground.visualHeightUnits}
              data-ground-hit-mode={ground.geometry.shape === "rectangle" && ground.geometry.width === 1 && ground.geometry.height === 1 ? "locked" : "custom"}
              style={{
                left: pointX(drop.localX! + ground.hitOffsetXUnits),
                top: pointY(drop.localY! + ground.hitOffsetYUnits),
                width: pointX(ground.hitWidthUnits),
                height: pointY(ground.hitHeightUnits),
                boxSizing: "border-box"
              }}
              aria-label={`${drop.itemId}${drop.quantity > 1 ? ` ×${drop.quantity}` : ""} on Manor floor`}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (!canEditDecorations || disabled) return;
                onSelectDroppedItem(drop);
                setWorldExitSelected(false);
                setDecorationMenuOpen(false);
                setSmithSelected(false);
                setJewelSelected(false);
                setSelectedOccupantId(null);
              }}
            >
              <span
                className="manor-ground-visual-frame"
                style={{
                  width: `${ground.visualWidthUnits / Math.max(ground.hitWidthUnits, 0.001) * 100}%`,
                  height: `${ground.visualHeightUnits / Math.max(ground.hitHeightUnits, 0.001) * 100}%`
                }}
              >
                <ItemArtwork
                  itemId={artworkItemId}
                  variant={drop.variant}
                  size="ground"
                  nameTooltip="hover-only"
                  label={`${drop.itemId} on Manor floor`}
                />
              </span>
              {drop.quantity > 1 ? <span className="manor-ground-quantity" aria-hidden="true">×{drop.quantity}</span> : null}
            </button>;
          })}</div>)}
          {decorations ? <ManorDecorationLayer
            snapshot={decorations}
            roomId={authoredRoom.id}
            placementPreview={decorationPlacementPreview}
          /> : null}
          {smithStation ? <button
            type="button"
            className="manor-smith"
            disabled={disabled || interactionIntent?.phase === "requesting"}
            style={{ left: pointX(smithStation.x), top: pointY(smithStation.y) }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onPointerUp={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (interactionIntent) onCancelInteraction();
              setSmithSelected(true);
              setSelectedOccupantId(null);
              setWorldExitSelected(false);
              setJewelSelected(false);
            }}
            aria-label="Smithing Station"
          >
            <img src={smithUrl} alt="" draggable={false} />
          </button> : null}
          {jewelStation ? <button
            type="button"
            className="manor-smith manor-jewel"
            disabled={disabled || interactionIntent?.phase === "requesting"}
            style={{ left: pointX(jewelStation.x), top: pointY(jewelStation.y) }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (interactionIntent) onCancelInteraction();
              setJewelSelected(true);
              setSmithSelected(false);
              setSelectedOccupantId(null);
              setWorldExitSelected(false);
            }}
            aria-label="Jewel Station"
          >
            <img src={jewelUrl} alt="" draggable={false} />
          </button> : null}
          {canKick ? occupants
            .filter(({ playerId }) => playerId !== ownPlayerId)
            .map((occupant) => (
              <button
                key={occupant.playerId}
                type="button"
                className="manor-occupant"
                style={{
                  left: pointX(occupant.position.x),
                  top: pointY(occupant.position.y),
                  "--manor-occupant-color": occupant.displayColor ?? "#8b7355"
                } as React.CSSProperties}
                aria-label={occupant.displayName}
                onClick={(event) => {
                  event.stopPropagation();
                  if (interactionIntent) onCancelInteraction();
                  setSelectedOccupantId(occupant.playerId);
                  setSmithSelected(false);
                  setJewelSelected(false);
                  setWorldExitSelected(false);
                }}
              >
                <strong>{occupant.displayName}</strong>
              </button>
            )) : null}
          <ManorPlayerLayer
            room={MANOR_MAIN_ROOM}
            timeline={timeline}
            displayColor={displayColor}
            appearance={appearance}
            occupants={occupants.filter(({ playerId }) => playerId !== ownPlayerId)}
          />
      </IndoorSceneStage>
      </div>
      {hud}
    </IndoorSceneViewport>
  );
}

function pointInManorPolygon(point: IndoorPoint, polygon: readonly IndoorPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || Number.EPSILON) + a.x) inside = !inside;
  }
  return inside;
}

function manorPolygonClipPath(
  points: readonly { x: number; y: number }[],
  roomWidth: number,
  roomHeight: number
): string {
  return `polygon(${points.map((point) =>
    `${point.x / roomWidth * 100}% ${point.y / roomHeight * 100}%`).join(", ")})`;
}

/** Resolve a shared catalog asset key using the client build's canonical asset roots. */
export function manorDecorationAssetUrl(assetKey: string): string | null {
  return clientAssetKeyUrl(assetKey);
}

function ManorDecorationLayer(props: {
  snapshot: ManorDecorationSnapshot;
  roomId: string;
  placementPreview: ManorDecorationPreview | null;
}): React.JSX.Element {
  const renderPlacement = (
    placement: ManorDecorationPlacement,
    preview = false
  ): React.JSX.Element | null => {
    const definition = props.snapshot.definitions.find((entry) => entry.definition.id === placement.definitionId)?.definition;
    if (!definition) return null;
    const sourceUrl = manorDecorationAssetUrl(definition.assetKey);
    if (!sourceUrl) return null;
    const transform = placement.transform;
    const mirror = definition.mirrorX === true;
    return <div
      key={placement.placementId}
      className={`manor-decoration-runtime${preview ? " preview" : ""} ${definition.collision ? "collision" : ""}`}
      data-manor-decoration-id={definition.id}
      data-manor-surface={placement.surfaceId}
      data-manor-layer={definition.layer}
      aria-hidden="true"
      style={{
        // x/y are the authored normalized anchor position, not the PNG's
        // untransformed top-left. Keep the CSS frame and shared footprint
        // transform anchored at the same room point.
        left: `${(transform.x - transform.width * transform.anchorX) / props.snapshot.roomWidth * 100}%`,
        top: `${(transform.y - transform.height * transform.anchorY) / props.snapshot.roomHeight * 100}%`,
        width: `${transform.width / props.snapshot.roomWidth * 100}%`,
        height: `${transform.height / props.snapshot.roomHeight * 100}%`,
        transform: `rotate(${transform.rotationDeg}deg) scale(${mirror ? -transform.scaleX : transform.scaleX}, ${transform.scaleY})`,
        transformOrigin: `${transform.anchorX * 100}% ${transform.anchorY * 100}%`,
        zIndex: manorDecorationLayerZIndex(definition.layer, definition.zIndex)
      }}
    >
      <img src={sourceUrl} alt="" draggable={false} />
    </div>;
  };
  return <div className="manor-decoration-layer" aria-hidden="true">
    {props.snapshot.placements
      .filter((placement) => placement.roomId === props.roomId)
      .filter((placement) => placement.placementId !== props.placementPreview?.placementId)
      .map((placement) => renderPlacement(placement))}
    {props.placementPreview ? (() => {
      const definition = props.snapshot.definitions.find((entry) =>
        entry.definition.id === props.placementPreview?.definitionId
      )?.definition;
      if (!definition) return null;
      return renderPlacement({
        placementId: "preview",
        definitionId: definition.id,
        itemId: definition.itemId,
        itemVariant: null,
        roomId: definition.roomId,
        surfaceId: definition.surfaceId,
        transform: { ...props.placementPreview.transform, ...props.placementPreview.position }
      }, true);
    })() : null}
  </div>;
}

function manorDecorationLayerZIndex(
  layer: ManorDecorationSnapshot["definitions"][number]["definition"]["layer"],
  authoredZIndex: number
): number {
  const layerBase = layer === "behind" ? 0 : layer === "rug" ? 1 : 3;
  return layerBase * 100 + authoredZIndex;
}

function aggregateManorDrops(drops: readonly DroppedItemSnapshot[]): DroppedItemSnapshot[] {
  const aggregate = new Map<string, DroppedItemSnapshot>();
  for (const drop of drops) {
    const key = drop.equipmentInstanceId
      ? `equipment:${drop.dropId}`
      : drop.backpackInstanceId
        ? `backpack:${drop.backpackInstanceId}`
      : `item:${drop.pileId ?? drop.dropId}:${drop.itemId}:${drop.variant ?? ""}`;
    const existing = aggregate.get(key);
    if (!existing) {
      aggregate.set(key, drop);
      continue;
    }
    aggregate.set(key, {
      ...existing,
      quantity: existing.quantity + drop.quantity
    });
  }
  return [...aggregate.values()];
}

function groupManorDropsByPile(
  drops: readonly DroppedItemSnapshot[]
): Array<{ pileId: string; drops: DroppedItemSnapshot[] }> {
  const piles = new Map<string, DroppedItemSnapshot[]>();
  for (const drop of drops) {
    const pileId = drop.pileId ?? drop.dropId;
    const pile = piles.get(pileId);
    if (pile) pile.push(drop);
    else piles.set(pileId, [drop]);
  }
  return [...piles.entries()].map(([pileId, pile]) => ({ pileId, drops: pile }));
}
