import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import {
  WorldMapClickArbitrator,
  type WorldMapClick
} from "../src/movement/worldMapClickArbitrator.js";
import { MobileWorldActionSheet } from "../src/ui/MobileWorldActionSheet.js";

type ObjectKind = "flag" | "tree" | "mob" | "dropped_item";
type PresentationState = "entering" | "visible" | "exiting";

const PROVISIONAL_EXIT_MS = 80;

export function WorldMapInteractionStory() {
  const [pending, setPending] = useState<ObjectKind | null>(null);
  const [menu, setMenu] = useState<ObjectKind | null>(null);
  const [menuCount, setMenuCount] = useState(0);
  const [movementCount, setMovementCount] = useState(0);
  const [presentationState, setPresentationState] = useState<PresentationState | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const entranceFrameRef = useRef<number | null>(null);
  const arbitrator = useMemo(() => new WorldMapClickArbitrator<ObjectKind>({
    onPending: ({ value }) => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setPending(value);
      if (value === "dropped_item") return;
      setMenu(value);
      setPresentationState("entering");
      entranceFrameRef.current = window.requestAnimationFrame(() => {
        entranceFrameRef.current = null;
        setPresentationState("visible");
      });
    },
    onPendingEnd: (_, outcome) => {
      setPending(null);
      if (entranceFrameRef.current !== null) {
        window.cancelAnimationFrame(entranceFrameRef.current);
        entranceFrameRef.current = null;
      }
      if (outcome === "confirmed") {
        setPresentationState(null);
        return;
      }
      setPresentationState("exiting");
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;
        setMenu(null);
        setPresentationState(null);
      }, PROVISIONAL_EXIT_MS);
    },
    onSingle: ({ value }) => {
      setMenu(value);
      setMenuCount((count) => count + 1);
    },
    onDouble: () => {
      setMovementCount((count) => count + 1);
    }
  }), []);

  useEffect(() => () => {
    arbitrator.cancel();
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    if (entranceFrameRef.current !== null) window.cancelAnimationFrame(entranceFrameRef.current);
  }, [arbitrator]);

  const click = (kind: ObjectKind, event: MouseEvent<HTMLButtonElement>): void => {
    arbitrator.click(input(kind, event));
  };
  const doubleClick = (kind: ObjectKind, event: MouseEvent<HTMLButtonElement>): void => {
    arbitrator.nativeDoubleClick(input(kind, event));
  };
  const reset = (): void => {
    arbitrator.cancel();
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (entranceFrameRef.current !== null) {
      window.cancelAnimationFrame(entranceFrameRef.current);
      entranceFrameRef.current = null;
    }
    setPending(null);
    setMenu(null);
    setPresentationState(null);
    setMenuCount(0);
    setMovementCount(0);
  };

  return (
    <main>
      <div aria-label="world map">
        {(["flag", "tree", "mob", "dropped_item"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={kind}
            onClick={(event) => click(kind, event)}
            onDoubleClick={(event) => doubleClick(kind, event)}
          >
            {kind}
          </button>
        ))}
      </div>
      <output data-testid="pending">{pending ?? "none"}</output>
      <output data-testid="menu">{menu ?? "none"}</output>
      <output data-testid="presentation-state">{presentationState ?? "committed"}</output>
      <output data-testid="menu-count">{menuCount}</output>
      <output data-testid="movement-count">{movementCount}</output>
      {menu && menu !== "dropped_item" ? <MobileWorldActionSheet
        displayName={menu}
        primaryActionLabel="Interact"
        primaryActionEnabled
        {...(presentationState ? { presentationState } : {})}
        actionsReady={presentationState === null}
        onPrimaryAction={() => undefined}
        onClose={() => setMenu(null)}
      /> : null}
      <button type="button" onClick={reset}>Reset</button>
    </main>
  );
}

function input(
  value: ObjectKind,
  event: MouseEvent<HTMLButtonElement>
): WorldMapClick<ObjectKind> {
  return {
    value,
    screenX: event.clientX,
    screenY: event.clientY,
    button: event.button,
    pointerType: "mouse"
  };
}
