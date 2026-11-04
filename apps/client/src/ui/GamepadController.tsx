import { markSyntheticTap } from "../gamepad/syntheticTap.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ButtonEdgeTracker,
  NavRepeater,
  PAD_A,
  PAD_B,
  PAD_DPAD_DOWN,
  PAD_DPAD_LEFT,
  PAD_DPAD_RIGHT,
  PAD_DPAD_UP,
  PAD_LB,
  PAD_R3,
  PAD_RB,
  PAD_RT,
  PAD_X,
  PAD_Y,
  chooseFocus,
  chordSlotIndex,
  resolveChord,
  stickToDirection,
  type Chord,
  type NavDirection
} from "../gamepad/gamepadLogic.js";
import { findCloseControl, findGamepadScope, focusableOptions, hotbarSlotButtons } from "../gamepad/gamepadScope.js";
import { HoldTapTracker } from "../gamepad/quickActionSelection.js";
import { dashClientState, padAAction } from "../movement/dash.js";
import { gamepadState, markGamepadUsed, setGamepadAggressive, useGamepadAggressive, useGamepadUsed } from "../gamepad/gamepadState.js";
import { AIM_STICK_THRESHOLD, AimAttackRepeater } from "../combat/twinStick.js";
import { swingClientState } from "../combat/swing.js";
import "./GamepadController.css";

export type GamepadQuickAction = Readonly<{ label: string; run(): void }>;

type Props = Readonly<{
  /** The map canvas that receives world taps. */
  getCanvas(): HTMLCanvasElement | null;
  getQuickAction(aggressive: boolean): GamepadQuickAction | null;
  /** Action combat is on (server flag and preference). The right stick aims and attacks, and Aggressive is hidden. */
  actionCombat: boolean;
  /**
   * Twin-stick aim: the right stick as a screen offset in -1..1 (null when released), and whether a
   * swing or shot is due this frame. The app draws the aim indicator and sends the swing.
   */
  onAim(stick: Readonly<{ x: number; y: number }> | null, attack: boolean): void;
  /** Brief toast for state changes. */
  notify(message: string): void;
  onRecenter(): void;
  onOpenMenu(): void;
  onCloseMenu(): void;
  onMenuBack(): void;
}>;

const FACE_LABELS = ["A", "X", "B", "Y"] as const;
const FOCUS_CLASS = "gamepad-focus";
const TAP_POINTER_ID = 9001;

/** Sends the same pointer and mouse sequence a real tap would, at the screen centre, to the map canvas. */
function tapScreenCentre(canvas: HTMLCanvasElement): void {
  const clientX = window.innerWidth / 2;
  const clientY = window.innerHeight / 2;
  const pointerInit = { bubbles: true, cancelable: true, clientX, clientY, pointerId: TAP_POINTER_ID, pointerType: "mouse", isPrimary: true, button: 0 };
  const mouseInit = { bubbles: true, cancelable: true, clientX, clientY, button: 0 };
  canvas.dispatchEvent(markSyntheticTap(new PointerEvent("pointerdown", { ...pointerInit, buttons: 1 })));
  canvas.dispatchEvent(markSyntheticTap(new MouseEvent("mousedown", { ...mouseInit, buttons: 1 })));
  window.setTimeout(() => {
    canvas.dispatchEvent(markSyntheticTap(new PointerEvent("pointerup", { ...pointerInit, buttons: 0 })));
    canvas.dispatchEvent(markSyntheticTap(new MouseEvent("mouseup", { ...mouseInit, buttons: 0 })));
    canvas.dispatchEvent(markSyntheticTap(new MouseEvent("click", { ...mouseInit, buttons: 0, detail: 1 })));
  }, 40);
}

function slotLabel(element: HTMLElement | undefined): string {
  if (!element) return "Empty";
  const text = (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 28) : "Empty";
}

/** Controller scheme: screen-centre cursor, A dash (select in menus), RT tap at cursor, B back, X quick action, right stick aim and attack (action combat), bumper hotbar chords, Y menu, R3 recenter camera. */
export function GamepadController(props: Props): React.JSX.Element | null {
  const latest = useRef(props);
  latest.current = props;
  const used = useGamepadUsed();
  const aggressive = useGamepadAggressive();
  const [chordHidden, setChordHidden] = useState(false);
  const [chord, setChord] = useState<Chord>(null);
  const [slotLabels, setSlotLabels] = useState<string[]>([]);
  const [quick, setQuick] = useState<GamepadQuickAction | null>(null);
  const focused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const tracker = new ButtonEdgeTracker();
    const repeater = new NavRepeater();
    const xHold = new HoldTapTracker();
    let chordNow: Chord = null;
    const aimRepeater = new AimAttackRepeater();
    let aiming = false;
    let raf = 0;

    const clearFocus = (): void => {
      focused.current?.classList.remove(FOCUS_CLASS);
      focused.current = null;
    };
    const moveFocus = (direction: NavDirection): void => {
      const scope = findGamepadScope();
      if (!scope) { clearFocus(); return; }
      const options = focusableOptions(scope);
      if (options.length === 0) return;
      const currentIndex = focused.current ? options.indexOf(focused.current) : -1;
      const next = chooseFocus(
        options.map((element) => element.getBoundingClientRect()),
        currentIndex >= 0 ? currentIndex : null,
        direction
      );
      const element = next === null ? null : options[next] ?? null;
      if (!element) return;
      focused.current?.classList.remove(FOCUS_CLASS);
      focused.current = element;
      element.classList.add(FOCUS_CLASS);
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const ensureFocusInScope = (): HTMLElement | null => {
      const scope = findGamepadScope();
      if (!scope) { clearFocus(); return null; }
      if (!focused.current || !scope.root.contains(focused.current) || !focused.current.isConnected) {
        clearFocus();
        moveFocus("down");
      }
      return focused.current;
    };

    const onButton = (button: number): void => {
      const api = latest.current;
      const slot = chordSlotIndex(chordNow, button);
      if (slot !== null) {
        const side = slot < 4 ? "left" : "right";
        const slotButton = hotbarSlotButtons(side)[slot % 4];
        slotButton?.click();
        if (slotButton?.classList.contains("empty")) {
          // Empty slot: the click opened its assign menu. Hide the legend and focus the menu's first option.
          setChordHidden(true);
          window.setTimeout(() => { if (findGamepadScope()) { clearFocus(); moveFocus("down"); } }, 60);
        }
        return;
      }
      if (button === PAD_LB || button === PAD_RB) return;
      const scope = findGamepadScope();
      switch (button) {
        case PAD_A: {
          // Menus and popups keep A as select; in the world A dashes (left stick, else last direction).
          const action = padAAction(scope !== null, false);
          if (action === "select") {
            const target = ensureFocusInScope();
            target?.click();
          } else if (action === "dash") {
            dashClientState.requestDash();
          }
          break;
        }
        case PAD_RT: {
          // The old A: tap at the centre cursor.
          if (scope) break;
          const canvas = api.getCanvas();
          if (canvas) tapScreenCentre(canvas);
          break;
        }
        case PAD_B: {
          if (!scope) break;
          clearFocus();
          if (scope.kind === "menu") { api.onMenuBack(); break; }
          const close = findCloseControl(scope);
          if (close) close.click();
          else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          break;
        }
        case PAD_X: {
          if (scope) break;
          // X is only the nearest quick action (harvest, pick up); attacking is the right stick.
          xHold.down(performance.now());
          break;
        }
        case PAD_Y:
          clearFocus();
          if (scope?.kind === "menu") api.onCloseMenu(); else api.onOpenMenu();
          break;
        case PAD_R3:
          api.onRecenter();
          break;
        case PAD_DPAD_UP: moveFocus("up"); break;
        case PAD_DPAD_DOWN: moveFocus("down"); break;
        case PAD_DPAD_LEFT: moveFocus("left"); break;
        case PAD_DPAD_RIGHT: moveFocus("right"); break;
        default: break;
      }
    };

    const poll = (now: number): void => {
      raf = requestAnimationFrame(poll);
      let pad: Gamepad | null = null;
      try {
        pad = Array.from(navigator.getGamepads?.() ?? []).find((candidate) => candidate?.connected) ?? null;
      } catch { pad = null; }
      if (!pad) {
        tracker.reset();
        gamepadState.rightStickAttacks = false;
        if (aiming) { aiming = false; aimRepeater.release(); latest.current.onAim(null, false); }
        return;
      }
      // In action combat the right stick aims and attacks instead of panning the camera.
      gamepadState.rightStickAttacks = latest.current.actionCombat;
      const pressed = pad.buttons.map((button) => button.pressed);
      const edges = tracker.update(pressed);
      if (edges.length > 0 || Math.hypot(pad.axes[0] ?? 0, pad.axes[1] ?? 0) > 0.2) markGamepadUsed();

      if (!pressed[PAD_LB] && !pressed[PAD_RB]) setChordHidden(false);
      const nextChord = resolveChord(Boolean(pressed[PAD_LB]), Boolean(pressed[PAD_RB]));
      if (nextChord !== chordNow) {
        chordNow = nextChord;
        setChord(nextChord);
        if (nextChord) {
          const buttons = hotbarSlotButtons(nextChord);
          setSlotLabels([0, 1, 2, 3].map((i) => slotLabel(buttons[i])));
        }
      }
      for (const button of edges) onButton(button);
      // Aggressive is a queued-combat setting: no hold-X toggle in action combat.
      if (!latest.current.actionCombat && xHold.poll(now) === "toggle") {
        const next = !gamepadState.aggressive;
        setGamepadAggressive(next);
        latest.current.notify(next ? "Aggressive on: X can attack" : "Aggressive off");
      }
      if (!pressed[PAD_X] && xHold.up(now) === "tap") {
        latest.current.getQuickAction(gamepadState.aggressive && !latest.current.actionCombat)?.run();
      }

      // Right stick: aim and attack for as long as it is deflected (swings are gated by the recovery).
      const stickX = pad.axes[2] ?? 0;
      const stickY = pad.axes[3] ?? 0;
      const wantsAim = latest.current.actionCombat && !findGamepadScope() && Math.hypot(stickX, stickY) >= AIM_STICK_THRESHOLD;
      if (wantsAim) {
        aiming = true;
        markGamepadUsed();
        latest.current.onAim({ x: stickX, y: stickY }, aimRepeater.due(now, swingClientState.nextSwingAtMs));
      } else if (aiming) {
        aiming = false;
        aimRepeater.release();
        latest.current.onAim(null, false);
      }

      // Left stick moves menu focus while a menu or popup is open (JoystickMovement ignores it then).
      const direction = repeater.step(stickToDirection(pad.axes[0] ?? 0, pad.axes[1] ?? 0), now);
      if (direction && !chordNow) {
        if (findGamepadScope()) { ensureFocusInScope(); moveFocus(direction); }
      }
      if (focused.current && !focused.current.isConnected) clearFocus();
    };
    raf = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(raf);
      clearFocus();
    };
  }, []);

  // Nearest quick action, refreshed a few times a second while a pad is in use.
  useEffect(() => {
    if (!used) { setQuick(null); return undefined; }
    const refresh = (): void => {
      const api = latest.current;
      const next = api.getQuickAction(aggressive && !api.actionCombat);
      setQuick((previous) => (previous?.label === next?.label ? previous : next));
    };
    refresh();
    const timer = window.setInterval(refresh, 250);
    return () => window.clearInterval(timer);
  }, [used, aggressive, props.actionCombat]);

  if (!used) return null;
  const stack = document.querySelector(".gameplay-status-stack");
  const scopeOpen = findGamepadScope() !== null;
  return (
    <>
      <div className="gamepad-cursor" aria-hidden="true" />
      {quick && !scopeOpen && stack ? createPortal(
        <div className="gamepad-quick-action" role="status">
          <kbd className="gamepad-quick-key">X</kbd>
          <span className="gamepad-quick-label">{quick.label}</span>
          {aggressive && !props.actionCombat ? <span className="gamepad-quick-badge">Aggressive</span> : null}
        </div>,
        stack
      ) : null}
      {chord && !chordHidden ? (
        <div className="gamepad-chord" role="status" aria-label={`Hotbar ${chord === "left" ? "left rail" : "right rail"}`}>
          {FACE_LABELS.map((face, index) => (
            <div key={face} className="gamepad-chord-row">
              <kbd className="gamepad-quick-key">{face}</kbd>
              <span>{slotLabels[index] ?? "Empty"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
