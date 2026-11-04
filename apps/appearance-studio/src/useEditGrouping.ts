import { useCallback, useEffect, useMemo, useRef } from "react";
import { burstGroup, gestureGroup, type EditGroup } from "./historyCore.js";

type Gesture = { id: number; cancelled: boolean };

const TEXT_INPUT_TYPES = new Set(["text", "number", "range", "search", "email", "url", "tel", "password", "color"]);

function activeTextField(): Element | null {
  const element = document.activeElement;
  if (!element) return null;
  if (element.tagName === "TEXTAREA") return element;
  if (element.tagName === "INPUT" && TEXT_INPUT_TYPES.has((element as HTMLInputElement).type)) return element;
  return null;
}

/**
 * Tells a history which undo group the next edit belongs to, from what the author is doing right now:
 * a pointer gesture (pointerdown to pointerup) is one group, typing or scrubbing in one field is one
 * burst group, and everything else is a discrete step. It also ends the open group at the natural
 * boundaries (pointerup, blur, Enter) and cancels a gesture on pointercancel or Escape.
 */
export function useEditGrouping(handlers: {
  /** The group should close: pointerup, blur, Enter. */
  onEnd(): void;
  /** The gesture identified by `key` was cancelled; restore its pre-gesture state. */
  onCancel(key: string): void;
}): {
  /** The group an edit made now belongs to, or undefined for a discrete step. */
  groupForEdit(explicit?: EditGroup): EditGroup | undefined;
  /** True while a cancelled gesture is still held down; its edits must be ignored. */
  isCancelled(): boolean;
  /** Runs `fn` so every edit it makes joins `group` (keyboard nudges). */
  runGrouped<T>(group: EditGroup, fn: () => T): T;
} {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const gestureRef = useRef<Gesture | null>(null);
  const counterRef = useRef(0);
  const overrideRef = useRef<EditGroup | null>(null);
  const fieldIds = useRef(new WeakMap<Element, number>());

  useEffect(() => {
    const finish = (cancel: boolean): void => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture && cancel && !gesture.cancelled) handlersRef.current.onCancel(gestureGroup(gesture.id).key);
      handlersRef.current.onEnd();
    };
    const onPointerDown = (): void => {
      if (gestureRef.current) finish(false);
      counterRef.current += 1;
      gestureRef.current = { id: counterRef.current, cancelled: false };
    };
    const onPointerUp = (): void => finish(false);
    const onPointerCancel = (): void => finish(true);
    const onKeyDown = (event: KeyboardEvent): void => {
      const gesture = gestureRef.current;
      if (event.key === "Escape" && gesture && !gesture.cancelled) {
        gesture.cancelled = true;
        handlersRef.current.onCancel(gestureGroup(gesture.id).key);
        return;
      }
      if (event.key === "Enter") handlersRef.current.onEnd();
    };
    const onFocusOut = (): void => handlersRef.current.onEnd();
    const onBlur = (): void => finish(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const groupForEdit = useCallback((explicit?: EditGroup): EditGroup | undefined => {
    if (explicit) return explicit;
    if (overrideRef.current) return overrideRef.current;
    const gesture = gestureRef.current;
    if (gesture) return gestureGroup(gesture.id);
    const field = activeTextField();
    if (!field) return undefined;
    let id = fieldIds.current.get(field);
    if (id === undefined) { counterRef.current += 1; id = counterRef.current; fieldIds.current.set(field, id); }
    return burstGroup(`field:${id}`);
  }, []);
  const isCancelled = useCallback((): boolean => Boolean(gestureRef.current?.cancelled), []);
  const runGrouped = useCallback(<T,>(group: EditGroup, fn: () => T): T => {
    const previous = overrideRef.current;
    overrideRef.current = group;
    try { return fn(); } finally { overrideRef.current = previous; }
  }, []);
  return useMemo(() => ({ groupForEdit, isCancelled, runGrouped }), [groupForEdit, isCancelled, runGrouped]);
}
