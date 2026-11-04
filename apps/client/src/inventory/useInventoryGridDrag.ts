import { useCallback, useEffect, useRef, useState } from "react";

type PointerPhase =
  | "pressed"
  | "held"
  | "dragging"
  | "completed"
  | "cancelled";

type PointerGesture = {
  phase: PointerPhase;
  pointerId: number;
  pointerType: string;
  stackId: string;
  sourceSlot: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  armingTimer: number;
  holdTimer: number;
  hitTestFrame: number | null;
  element: HTMLElement;
  moveDispatched: boolean;
  activated: boolean;
  moveListener: (event: PointerEvent) => void;
  upListener: (event: PointerEvent) => void;
  cancelListener: (event: PointerEvent) => void;
};

type SuppressedGestureClick = {
  pointerId: number;
  stackId: string;
  activated: boolean;
  moveDispatched: boolean;
  outcome: "completed" | "cancelled";
  expiresAt: number;
};

const HOLD_MS = 500;
const PRESS_FEEDBACK_DELAY_MS = 100;
const DRAG_DISTANCE_PX = 10;

export function useInventoryGridDrag(options: {
  enabled: boolean;
  touchEnabled?: boolean;
  onMove?(stackId: string, targetSlot: number): boolean | void;
  sourcePane?: string;
  canTransfer?(stackId: string, targetPane: string): boolean;
  onTransfer?(stackId: string, targetPane: string): boolean | void;
}) {
  const {
    enabled,
    touchEnabled = false,
    onMove,
    sourcePane,
    canTransfer,
    onTransfer
  } = options;
  const [armingStackId, setArmingStackId] = useState<string | null>(null);
  const [draggingStackId, setDraggingStackId] = useState<string | null>(null);
  const [dragTargetSlot, setDragTargetSlot] = useState<number | null>(null);
  const [dragTransferTarget, setDragTransferTarget] = useState<string | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const suppressedClickRef = useRef<SuppressedGestureClick | null>(null);
  const targetRef = useRef<number | null>(null);

  const updateTarget = useCallback((slot: number | null): void => {
    if (targetRef.current === slot) return;
    targetRef.current = slot;
    setDragTargetSlot(slot);
  }, []);

  const slotAtPoint = (x: number, y: number): number | null => {
    const slot = document.elementFromPoint?.(x, y)
      ?.closest<HTMLElement>("[data-inventory-slot-index]");
    if (!slot) return null;
    const value = Number(slot.dataset.inventorySlotIndex);
    return Number.isSafeInteger(value) ? value : null;
  };

  const paneAtPoint = (x: number, y: number): string | null =>
    document.elementFromPoint?.(x, y)
      ?.closest<HTMLElement>("[data-inventory-transfer-pane]")
      ?.dataset.inventoryTransferPane ?? null;

  const updatePointTarget = (gesture: PointerGesture): void => {
    const pane = paneAtPoint(gesture.latestX, gesture.latestY);
    if (
      sourcePane &&
      pane &&
      pane !== sourcePane &&
      (canTransfer?.(gesture.stackId, pane) ?? true)
    ) {
      updateTarget(null);
      setDragTransferTarget(pane);
      return;
    }
    setDragTransferTarget(null);
    const target = slotAtPoint(gesture.latestX, gesture.latestY);
    updateTarget(target === gesture.sourceSlot ? null : target);
  };

  const clearMechanics = (gesture: PointerGesture): void => {
    window.clearTimeout(gesture.armingTimer);
    window.clearTimeout(gesture.holdTimer);
    if (gesture.hitTestFrame !== null) {
      window.cancelAnimationFrame?.(gesture.hitTestFrame);
      gesture.hitTestFrame = null;
    }
    window.removeEventListener("pointermove", gesture.moveListener);
    window.removeEventListener("pointerup", gesture.upListener);
    window.removeEventListener("pointercancel", gesture.cancelListener);
    try {
      if (gesture.element.hasPointerCapture?.(gesture.pointerId)) {
        gesture.element.releasePointerCapture?.(gesture.pointerId);
      }
    } catch {
      // Window listeners are the pointer-capture fallback.
    }
  };

  const clearPresentation = useCallback((): void => {
    setArmingStackId(null);
    setDraggingStackId(null);
    setDragTransferTarget(null);
    updateTarget(null);
  }, [updateTarget]);

  const finish = (gesture: PointerGesture): void => {
    clearPresentation();
    if (document.activeElement === gesture.element) gesture.element.blur();
  };

  const suppressGestureClick = (
    gesture: PointerGesture,
    outcome: SuppressedGestureClick["outcome"]
  ): void => {
    suppressedClickRef.current = {
      pointerId: gesture.pointerId,
      stackId: gesture.stackId,
      activated: gesture.activated,
      moveDispatched: gesture.moveDispatched,
      outcome,
      expiresAt: performance.now() + 1_000
    };
  };

  const activate = (gesture: PointerGesture): void => {
    if (gesture.phase !== "pressed" && gesture.phase !== "held") return;
    gesture.phase = "dragging";
    gesture.activated = true;
    setArmingStackId(null);
    setDraggingStackId(gesture.stackId);
    updatePointTarget(gesture);
  };

  const scheduleHitTest = (gesture: PointerGesture): void => {
    if (gesture.hitTestFrame !== null) return;
    const update = (): void => {
      gesture.hitTestFrame = null;
      if (gestureRef.current !== gesture || gesture.phase !== "dragging") return;
      updatePointTarget(gesture);
    };
    if (!window.requestAnimationFrame) {
      update();
      return;
    }
    gesture.hitTestFrame = window.requestAnimationFrame(update);
  };

  function move(event: PointerEvent): void {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.latestX = event.clientX;
    gesture.latestY = event.clientY;
    if (
      gesture.phase === "pressed" &&
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >
        DRAG_DISTANCE_PX
    ) {
      if (gesture.pointerType === "touch" || gesture.pointerType === "pen") {
        activate(gesture);
        if (event.cancelable) event.preventDefault();
        scheduleHitTest(gesture);
      } else {
        gesture.phase = "cancelled";
        clearMechanics(gesture);
        clearPresentation();
        suppressGestureClick(gesture, "cancelled");
        gestureRef.current = null;
      }
      return;
    }
    if (gesture.phase !== "dragging") return;
    if (event.cancelable) event.preventDefault();
    scheduleHitTest(gesture);
  }

  function drop(event: PointerEvent): void {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.latestX = event.clientX;
    gesture.latestY = event.clientY;
    if (gesture.phase === "pressed") {
      clearMechanics(gesture);
      clearPresentation();
      gestureRef.current = null;
      return;
    }
    if (gesture.phase === "held") {
      gesture.phase = "completed";
      clearMechanics(gesture);
      finish(gesture);
      suppressGestureClick(gesture, "completed");
      gestureRef.current = null;
      return;
    }
    if (gesture.phase !== "dragging") return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    const targetPane = paneAtPoint(gesture.latestX, gesture.latestY);
    const target = slotAtPoint(gesture.latestX, gesture.latestY);
    gesture.phase = "completed";
    clearMechanics(gesture);
    finish(gesture);
    if (
      !gesture.moveDispatched &&
      sourcePane &&
      targetPane &&
      targetPane !== sourcePane &&
      (canTransfer?.(gesture.stackId, targetPane) ?? true) &&
      onTransfer
    ) {
      gesture.moveDispatched = true;
      onTransfer(gesture.stackId, targetPane);
    } else if (!gesture.moveDispatched && target !== null && target !== gesture.sourceSlot) {
      gesture.moveDispatched = true;
      onMove?.(gesture.stackId, target);
    }
    suppressGestureClick(gesture, "completed");
    gestureRef.current = null;
  }

  function cancel(event: PointerEvent): void {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.phase = "cancelled";
    clearMechanics(gesture);
    finish(gesture);
    suppressGestureClick(gesture, "cancelled");
    gestureRef.current = null;
  }

  const reset = useCallback((): void => {
    const gesture = gestureRef.current;
    if (gesture) clearMechanics(gesture);
    gestureRef.current = null;
    clearPresentation();
  }, [clearPresentation]);

  useEffect(() => reset, [reset]);
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const begin = (
    event: React.PointerEvent<HTMLButtonElement>,
    stackId: string,
    sourceSlot: number
  ): void => {
    if (
      !enabled ||
      (!onMove && !onTransfer) ||
      ((event.pointerType === "touch" || event.pointerType === "pen") && !touchEnabled) ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) return;
    reset();
    const element = event.currentTarget;
    const pending: PointerGesture = {
      phase: "pressed",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      stackId,
      sourceSlot,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      armingTimer: 0,
      holdTimer: 0,
      hitTestFrame: null,
      element,
      moveDispatched: false,
      activated: false,
      moveListener: move,
      upListener: drop,
      cancelListener: cancel
    };
    gestureRef.current = pending;
    pending.armingTimer = window.setTimeout(() => {
      if (gestureRef.current === pending && pending.phase === "pressed") {
        setArmingStackId(stackId);
      }
    }, PRESS_FEEDBACK_DELAY_MS);
    window.addEventListener("pointermove", pending.moveListener, { passive: false });
    window.addEventListener("pointerup", pending.upListener);
    window.addEventListener("pointercancel", pending.cancelListener);
    try {
      element.setPointerCapture?.(pending.pointerId);
    } catch {
      // Window listeners are the pointer-capture fallback.
    }
    pending.holdTimer = window.setTimeout(() => {
      if (gestureRef.current === pending && pending.phase === "pressed") {
        pending.phase = "held";
        activate(pending);
      }
    }, HOLD_MS);
  };

  const consumeClick = (event: React.MouseEvent): boolean => {
    const suppressed = suppressedClickRef.current;
    if (suppressed && suppressed.expiresAt >= performance.now()) {
      suppressedClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    suppressedClickRef.current = null;
    gestureRef.current = null;
    return false;
  };

  const contextMenu = (event: React.MouseEvent): void => {
    if (gestureRef.current?.phase === "held" || gestureRef.current?.phase === "dragging") {
      event.preventDefault();
    }
  };

  const lostPointerCapture = (event: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (
      gesture?.pointerId === event.pointerId &&
      (
        gesture.phase === "pressed" ||
        gesture.phase === "held" ||
        gesture.phase === "dragging"
      )
    ) {
      cancel(event.nativeEvent);
    }
  };

  return {
    armingStackId,
    draggingStackId,
    dragTargetSlot,
    dragTransferTarget,
    begin,
    consumeClick,
    contextMenu,
    lostPointerCapture,
    reset
  } as const;
}
