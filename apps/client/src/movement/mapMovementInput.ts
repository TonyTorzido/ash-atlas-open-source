import {
  resolveGameplayAreaTarget,
  type GameplayAreaMovementAuthority,
  type ResolvedGameplayAreaTarget
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import {
  WorldMapClickArbitrator,
  WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS,
  WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX,
  type WorldMapClick,
  type WorldMapClickPointerType
} from "./worldMapClickArbitrator.js";

export const MAP_LONG_PRESS_DURATION_MS = 420;
export const MAP_OUTSIDE_LONG_PRESS_DURATION_MS = 525;
export const MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX = 14;
export const MAP_PRECISION_CURSOR_OFFSET_X_PX = 44;
export const MAP_PRECISION_CURSOR_OFFSET_Y_PX = 64;
const COMPLETED_HOLD_SUPPRESSION_MS = 800;

export type MapMovementInputHandlers = {
  getGameplayArea(): GameplayAreaMovementAuthority | null;
  usePrecisionLongPressOutside?(): boolean;
  onMove(intent: ResolvedGameplayAreaTarget): void;
  onLongPressStart(intent: ResolvedGameplayAreaTarget): void;
  onLongPressMove(intent: ResolvedGameplayAreaTarget): void;
  onLongPressRelease(intent: ResolvedGameplayAreaTarget): void;
  onLongPressCancel(): void;
  onPendingClick(event: maplibregl.MapMouseEvent): void;
  onPendingClickEnd(
    event: maplibregl.MapMouseEvent,
    outcome: "confirmed" | "cancelled"
  ): void;
  /**
   * Targeting surfaces own a single map tap and must not wait for the
   * movement double-click arbitration window before dispatching it. The map
   * also retains that ownership through the paired click/native dblclick when
   * the action exits synchronously after the first tap.
   */
  handleClickImmediately?(event: maplibregl.MapMouseEvent): boolean;
  /**
   * Action combat: a mouse left click is a swing, so it skips the double-click wait and double-clicks
   * do not move (spamming clicks must keep swinging; right click moves instead).
   */
  clicksSwing?(event: maplibregl.MapMouseEvent): boolean;
  onClick(event: maplibregl.MapMouseEvent): void;
};

export type MapMovementInputBinding = {
  cancelPendingInteraction(): void;
  destroy(): void;
};

type ActivePress = {
  pointerId: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  fired: boolean;
  committed: boolean;
  precision: boolean;
  intent: ResolvedGameplayAreaTarget | null;
  cursorX: number;
  cursorY: number;
};

type ImmediateClickOwnership<T> = {
  click: WorldMapClick<T>;
  startedAt: number;
};

export function bindMapMovementInput(
  map: maplibregl.Map,
  handlers: MapMovementInputHandlers
): MapMovementInputBinding {
  const canvas = map.getCanvas();
  const ownerDocument = canvas.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  let active: ActivePress | null = null;
  const pressedPointers = new Set<number>();
  let suppressUntil = 0;
  let suppressGestureClick = false;
  let immediateClickOwnership: ImmediateClickOwnership<maplibregl.MapMouseEvent> | null = null;
  let restoreDragPan = false;
  let restoreTouchZoom = false;
  const moveFromMapClick = (event: maplibregl.MapMouseEvent): void => {
    if (performance.now() < suppressUntil) return;
    const area = handlers.getGameplayArea();
    if (!area) return;
    const intent = resolveGameplayAreaTarget(area, {
      lat: event.lngLat.lat,
      lon: event.lngLat.lng
    });
    if (intent) handlers.onMove(intent);
  };
  const clickArbitrator = new WorldMapClickArbitrator<maplibregl.MapMouseEvent>({
    onPending: ({ value }) => handlers.onPendingClick(value),
    onPendingEnd: ({ value }, outcome) => handlers.onPendingClickEnd(value, outcome),
    onSingle: ({ value }) => {
      if (!active) handlers.onClick(value);
    },
    onDouble: ({ value }) => moveFromMapClick(value)
  });

  const clearImmediateClickOwnership = (): void => {
    immediateClickOwnership = null;
  };

  const toWorldMapClick = (
    event: maplibregl.MapMouseEvent
  ): WorldMapClick<maplibregl.MapMouseEvent> => ({
    value: event,
    screenX: event.point.x,
    screenY: event.point.y,
    button: event.originalEvent?.button ?? 0,
    pointerType: mapClickPointerType(event.originalEvent)
  });

  const restoreMapInteraction = (): void => {
    if (restoreDragPan) map.dragPan.enable();
    if (restoreTouchZoom) {
      map.touchZoomRotate.enable();
      map.touchZoomRotate.disableRotation();
    }
    restoreDragPan = false;
    restoreTouchZoom = false;
  };
  const rememberImmediateClickOwnership = (
    click: WorldMapClick<maplibregl.MapMouseEvent>,
    now = performance.now()
  ): void => {
    clearImmediateClickOwnership();
    immediateClickOwnership = {
      click,
      startedAt: now
    };
  };
  const matchesImmediateClickOwnership = (
    click: WorldMapClick<maplibregl.MapMouseEvent>,
    now: number,
    nativeDoubleClick = false
  ): boolean => {
    const owned = immediateClickOwnership;
    if (!owned) return false;
    return (
      click.pointerType === owned.click.pointerType &&
      click.button === owned.click.button &&
      (nativeDoubleClick || now - owned.startedAt <= WORLD_MAP_DOUBLE_CLICK_RECOGNITION_MS) &&
      Math.hypot(click.screenX - owned.click.screenX, click.screenY - owned.click.screenY) <=
        WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX
    );
  };
  const cancelActive = (notify = false): void => {
    if (!active) return;
    const fired = active.fired;
    const committed = active.committed;
    clearTimeout(active.timer);
    active = null;
    restoreMapInteraction();
    if (notify && fired && !committed) handlers.onLongPressCancel();
  };
  const handlePointerDown = (event: PointerEvent): void => {
    pressedPointers.add(event.pointerId);
    if (event.target !== canvas || !event.isPrimary || event.button !== 0 || pressedPointers.size > 1) {
      cancelActive(true);
      clickArbitrator.cancel();
      return;
    }
    suppressGestureClick = false;
    cancelActive(true);
    const press: ActivePress = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fired: false,
      committed: false,
      precision: false,
      intent: null,
      cursorX: 0,
      cursorY: 0,
      timer: setTimeout(() => {
        if (active !== press || pressedPointers.size !== 1) return;
        const area = handlers.getGameplayArea();
        if (!area) return;
        const rect = canvas.getBoundingClientRect();
        const pressedPoint = map.unproject([press.x - rect.left, press.y - rect.top]);
        const pressedIntent = resolveGameplayAreaTarget(area, {
          lat: pressedPoint.lat,
          lon: pressedPoint.lng
        });
        if (!pressedIntent) return;
        const useUnboundedPrecision = Boolean(handlers.usePrecisionLongPressOutside?.());
        if (pressedIntent.outside && !useUnboundedPrecision) {
          press.timer = setTimeout(() => {
            if (active !== press || pressedPointers.size !== 1) return;
            press.fired = true;
            press.committed = true;
            press.intent = pressedIntent;
            restoreDragPan = map.dragPan.isEnabled();
            restoreTouchZoom = map.touchZoomRotate.isEnabled();
            map.dragPan.disable();
            map.touchZoomRotate.disable();
            canvas.setPointerCapture?.(press.pointerId);
            suppressUntil = performance.now() + COMPLETED_HOLD_SUPPRESSION_MS;
            handlers.onLongPressRelease(pressedIntent);
          }, MAP_OUTSIDE_LONG_PRESS_DURATION_MS - MAP_LONG_PRESS_DURATION_MS);
          return;
        }
        let intent = pressedIntent;
        const offsetPoint = map.unproject([
          press.x - rect.left - MAP_PRECISION_CURSOR_OFFSET_X_PX,
          press.y - rect.top - MAP_PRECISION_CURSOR_OFFSET_Y_PX
        ]);
        const offsetIntent = resolveGameplayAreaTarget(area, {
          lat: offsetPoint.lat,
          lon: offsetPoint.lng
        });
        if (!offsetIntent) return;
        intent = offsetIntent;
        press.fired = true;
        press.intent = intent;
        restoreDragPan = map.dragPan.isEnabled();
        restoreTouchZoom = map.touchZoomRotate.isEnabled();
        map.dragPan.disable();
        map.touchZoomRotate.disable();
        canvas.setPointerCapture?.(press.pointerId);
        press.precision = true;
        const cursorTarget = useUnboundedPrecision ? intent.requested : intent.target;
        const cursorPoint = map.project([cursorTarget.lon, cursorTarget.lat]);
        press.cursorX = cursorPoint.x;
        press.cursorY = cursorPoint.y;
        handlers.onLongPressStart(intent);
      }, MAP_LONG_PRESS_DURATION_MS)
    };
    active = press;
  };
  const handlePointerMove = (event: PointerEvent): void => {
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.fired) {
      event.preventDefault();
      event.stopPropagation();
      if (!active.precision) return;
      const area = handlers.getGameplayArea();
      const cursorPoint = map.unproject([
        active.cursorX + event.clientX - active.x,
        active.cursorY + event.clientY - active.y
      ]);
      const intent = area
        ? resolveGameplayAreaTarget(area, { lat: cursorPoint.lat, lon: cursorPoint.lng })
        : null;
      if (!intent) return;
      active.intent = intent;
      handlers.onLongPressMove(intent);
      return;
    }
    const movement = Math.hypot(event.clientX - active.x, event.clientY - active.y);
    if (movement > WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX) {
      clickArbitrator.cancel();
    }
    if (movement > MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX) {
      cancelActive();
    }
  };
  const handlePointerEnd = (event: PointerEvent): void => {
    const wasPressed = pressedPointers.delete(event.pointerId);
    // Touch pointers hold implicit capture, so every finished tap dispatches
    // lostpointercapture after pointerup. Only a capture lost mid-press cancels;
    // the completed tap must stay available to the double-tap recognizer.
    if (event.type === "pointercancel" || (event.type === "lostpointercapture" && wasPressed)) {
      clickArbitrator.cancel();
    }
    if (!active || event.pointerId !== active.pointerId) return;
    const fired = active.fired;
    const committed = active.committed;
    const intent = active.intent;
    cancelActive();
    if (fired && intent && !committed) {
      clickArbitrator.cancel();
      suppressUntil = performance.now() + COMPLETED_HOLD_SUPPRESSION_MS;
      event.preventDefault();
      event.stopPropagation();
      handlers.onLongPressRelease(intent);
    }
  };
  const suppressCompletedHold = (event: Event): void => {
    if (performance.now() >= suppressUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const handleContextMenu = (event: Event): void => {
    if (active || performance.now() < suppressUntil) event.preventDefault();
  };
  const handleDoubleClick = (event: maplibregl.MapMouseEvent): void => {
    event.preventDefault();
    const click = toWorldMapClick(event);
    if (click.button === 0 && handlers.clicksSwing?.(event)) {
      clickArbitrator.cancel();
      return;
    }
    if (click.button === 0 && handlers.handleClickImmediately?.(event)) {
      clickArbitrator.cancel();
      clearImmediateClickOwnership();
      return;
    }
    if (click.button === 0 && matchesImmediateClickOwnership(click, performance.now(), true)) {
      clearImmediateClickOwnership();
      return;
    }
    clickArbitrator.nativeDoubleClick(click);
  };
  const handleClick = (event: maplibregl.MapMouseEvent): void => {
    if (suppressGestureClick) return;
    const click = toWorldMapClick(event);
    if (click.button === 0 && handlers.clicksSwing?.(event)) {
      clickArbitrator.cancel();
      handlers.onClick(event);
      return;
    }
    if (click.button === 0 && handlers.handleClickImmediately?.(event)) {
      clickArbitrator.cancel();
      rememberImmediateClickOwnership(click);
      handlers.onClick(event);
      return;
    }
    if (click.button === 0) {
      const now = performance.now();
      const nativeSecondClick = (event.originalEvent?.detail ?? 0) >= 2;
      if (matchesImmediateClickOwnership(click, now, nativeSecondClick)) {
        rememberImmediateClickOwnership(click, now);
        return;
      }
      clearImmediateClickOwnership();
    }
    clickArbitrator.click(click);
  };
  const cancelForMapInteraction = (): void => {
    suppressGestureClick = true;
    cancelActive(true);
    clickArbitrator.cancel();
    clearImmediateClickOwnership();
  };
  const cancelForOutsidePointer = (event: PointerEvent): void => {
    if (event.target !== canvas) {
      clickArbitrator.cancel();
      clearImmediateClickOwnership();
    }
  };
  const cancelForWindowState = (): void => {
    clickArbitrator.cancel();
    clearImmediateClickOwnership();
  };

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerEnd);
  canvas.addEventListener("pointercancel", handlePointerEnd);
  canvas.addEventListener("lostpointercapture", handlePointerEnd);
  canvas.addEventListener("click", suppressCompletedHold, true);
  canvas.addEventListener("dblclick", suppressCompletedHold, true);
  canvas.addEventListener("contextmenu", handleContextMenu);
  ownerDocument?.addEventListener("pointerdown", cancelForOutsidePointer, true);
  ownerDocument?.addEventListener("visibilitychange", cancelForWindowState);
  ownerWindow?.addEventListener("blur", cancelForWindowState);
  map.on("click", handleClick);
  map.on("dblclick", handleDoubleClick);
  map.on("dragstart", cancelForMapInteraction);
  map.on("zoomstart", cancelForMapInteraction);

  return {
    cancelPendingInteraction: () => {
      clickArbitrator.cancel();
      clearImmediateClickOwnership();
    },
    destroy: () => {
      cancelActive(true);
      clickArbitrator.cancel();
      clearImmediateClickOwnership();
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerEnd);
      canvas.removeEventListener("pointercancel", handlePointerEnd);
      canvas.removeEventListener("lostpointercapture", handlePointerEnd);
      canvas.removeEventListener("click", suppressCompletedHold, true);
      canvas.removeEventListener("dblclick", suppressCompletedHold, true);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      ownerDocument?.removeEventListener("pointerdown", cancelForOutsidePointer, true);
      ownerDocument?.removeEventListener("visibilitychange", cancelForWindowState);
      ownerWindow?.removeEventListener("blur", cancelForWindowState);
      map.off("click", handleClick);
      map.off("dblclick", handleDoubleClick);
      map.off("dragstart", cancelForMapInteraction);
      map.off("zoomstart", cancelForMapInteraction);
    }
  };
}

export function mapClickPointerType(
  event: MouseEvent | undefined
): WorldMapClickPointerType {
  const inputEvent = event as (MouseEvent & {
    pointerType?: string;
    sourceCapabilities?: { firesTouchEvents?: boolean };
  }) | undefined;
  const pointerType = inputEvent?.pointerType;
  if (pointerType === "touch" || pointerType === "pen") return pointerType;
  if (inputEvent?.sourceCapabilities?.firesTouchEvents) return "touch";
  // iOS Safari can report a finger tap's click without a pointer type.
  if (globalThis.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return "touch";
  return "mouse";
}
