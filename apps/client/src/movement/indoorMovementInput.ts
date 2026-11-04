import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

import {
  MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX,
  mapClickPointerType
} from "./mapMovementInput.js";
import {
  WorldMapClickArbitrator,
  type WorldMapClick
} from "./worldMapClickArbitrator.js";

export type TapPoint = { x: number; y: number };

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button"));
}

function toIndoorClick(
  point: TapPoint,
  button: number,
  pointerType: WorldMapClick<TapPoint>["pointerType"]
): WorldMapClick<TapPoint> {
  return {
    value: point,
    screenX: point.x,
    screenY: point.y,
    button,
    pointerType
  };
}

export function useIndoorMovementInput<TStage extends HTMLElement>({
  stageRef,
  roomWidth,
  roomHeight,
  movementDisabled,
  onBeforeMove,
  onMove,
  useTransformedBounds = false,
  pointerGestureSuppressedRef
}: {
  stageRef: RefObject<TStage | null>;
  roomWidth: number;
  roomHeight: number;
  movementDisabled: boolean;
  onBeforeMove(): void;
  onMove(x: number, y: number): void;
  useTransformedBounds?: boolean;
  pointerGestureSuppressedRef?: RefObject<boolean>;
}): {
  onClick(event: React.MouseEvent<TStage>): void;
  onDoubleClick(event: React.MouseEvent<TStage>): void;
  onPointerDownCapture(event: React.PointerEvent<TStage>): void;
  onPointerMove(event: React.PointerEvent<TStage>): void;
  onPointerUp(event: React.PointerEvent<TStage>): void;
  onPointerCancel(event: React.PointerEvent<TStage>): void;
  onLostPointerCapture(event: React.PointerEvent<TStage>): void;
  clearPendingMovement(): void;
} {
  const disabledRef = useRef(movementDisabled);
  const beforeMoveRef = useRef(onBeforeMove);
  const onMoveRef = useRef(onMove);
  const dimensionsRef = useRef({ roomWidth, roomHeight });
  const lastTouchAtRef = useRef(Number.NEGATIVE_INFINITY);
  const activePointerRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  disabledRef.current = movementDisabled;
  beforeMoveRef.current = onBeforeMove;
  onMoveRef.current = onMove;
  dimensionsRef.current = { roomWidth, roomHeight };

  const moveAt = useCallback((point: TapPoint): void => {
    const stage = stageRef.current;
    if (!stage || disabledRef.current) return;
    const bounds = stage.getBoundingClientRect();
    const hasClientWidth = !useTransformedBounds && stage.clientWidth > 0;
    const hasClientHeight = !useTransformedBounds && stage.clientHeight > 0;
    const width = hasClientWidth ? stage.clientWidth : bounds.width;
    const height = hasClientHeight ? stage.clientHeight : bounds.height;
    if (width <= 0 || height <= 0) return;
    const originX = bounds.left + (hasClientWidth ? stage.clientLeft : 0);
    const originY = bounds.top + (hasClientHeight ? stage.clientTop : 0);
    if (
      point.x < originX || point.x > originX + width ||
      point.y < originY || point.y > originY + height
    ) return;
    beforeMoveRef.current();
    onMoveRef.current(
      (point.x - originX) / width * dimensionsRef.current.roomWidth,
      (point.y - originY) / height * dimensionsRef.current.roomHeight
    );
  }, [stageRef, useTransformedBounds]);

  const clickArbitrator = useMemo(() => new WorldMapClickArbitrator<TapPoint>({
    onPending: () => undefined,
    onPendingEnd: () => undefined,
    // A single floor click remains inert. The shared arbitrator only delays it
    // so a second click can become one movement, matching the World Map path.
    onSingle: () => undefined,
    onDouble: ({ value }) => moveAt(value)
  }), [moveAt]);

  useEffect(() => {
    const cancel = (): void => {
      activePointerRef.current = null;
      clickArbitrator.cancel();
    };
    const ownerDocument = stageRef.current?.ownerDocument ??
      (typeof document === "undefined" ? null : document);
    const ownerWindow = ownerDocument?.defaultView ??
      (typeof window === "undefined" ? null : window);
    ownerDocument?.addEventListener("visibilitychange", cancel);
    ownerWindow?.addEventListener("blur", cancel);
    ownerWindow?.addEventListener("pagehide", cancel);
    return () => {
      ownerDocument?.removeEventListener("visibilitychange", cancel);
      ownerWindow?.removeEventListener("blur", cancel);
      ownerWindow?.removeEventListener("pagehide", cancel);
      clickArbitrator.cancel();
    };
  }, [clickArbitrator, stageRef]);
  useEffect(() => {
    if (movementDisabled) {
      activePointerRef.current = null;
      clickArbitrator.cancel();
    }
  }, [clickArbitrator, movementDisabled]);
  const clearPendingMovement = useCallback(() => {
    activePointerRef.current = null;
    clickArbitrator.cancel();
  }, [clickArbitrator]);

  return {
    onClick(event): void {
      if (
        disabledRef.current ||
        event.button !== 0 ||
        isInteractiveTarget(event.target)
      ) {
        clearPendingMovement();
        return;
      }
      // Touch/pen pointerup already entered the arbitrator. Browsers emit a
      // compatibility click afterward; do not enqueue that same tap again.
      if (performance.now() - lastTouchAtRef.current < 500) return;
      clickArbitrator.click(toIndoorClick(
        { x: event.clientX, y: event.clientY },
        event.button,
        mapClickPointerType(event.nativeEvent)
      ));
    },
    onDoubleClick(event): void {
      if (
        disabledRef.current ||
        event.button !== 0 ||
        isInteractiveTarget(event.target)
      ) {
        clearPendingMovement();
        return;
      }
      event.preventDefault();
      clickArbitrator.nativeDoubleClick(toIndoorClick(
        { x: event.clientX, y: event.clientY },
        event.button,
        mapClickPointerType(event.nativeEvent)
      ));
    },
    onPointerDownCapture(event): void {
      if (
        disabledRef.current ||
        event.button !== 0 ||
        isInteractiveTarget(event.target)
      ) {
        clearPendingMovement();
        return;
      }
      activePointerRef.current = Number.isFinite(event.pointerId)
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
    },
    onPointerMove(event): void {
      const active = activePointerRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) >
          MAP_LONG_PRESS_MOVEMENT_TOLERANCE_PX) {
        clearPendingMovement();
      }
    },
    onPointerUp(event): void {
      if (
        disabledRef.current ||
        pointerGestureSuppressedRef?.current ||
        event.button !== 0 ||
        isInteractiveTarget(event.target)
      ) {
        clearPendingMovement();
        return;
      }
      if (activePointerRef.current?.pointerId === event.pointerId) {
        activePointerRef.current = null;
      }
      const pointerType = mapClickPointerType(event.nativeEvent);
      if (pointerType === "mouse") return;
      lastTouchAtRef.current = performance.now();
      clickArbitrator.click(toIndoorClick(
        { x: event.clientX, y: event.clientY },
        event.button,
        pointerType
      ));
    },
    onPointerCancel(): void {
      clearPendingMovement();
    },
    onLostPointerCapture(event): void {
      if (activePointerRef.current?.pointerId === event.pointerId) {
        clearPendingMovement();
      }
    },
    clearPendingMovement
  };
}
