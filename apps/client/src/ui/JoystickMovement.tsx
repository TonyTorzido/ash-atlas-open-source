import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LatLon } from "@ash-atlas/shared";

import {
  JOYSTICK_DEAD_ZONE,
  JOYSTICK_SEND_INTERVAL_MS,
  computeJoystickTarget,
  shouldSendJoystickMove,
  type JoystickLeash,
  type JoystickSendState
} from "../movement/joystickMovementMath.js";
import { chooseDashDirection, dashClientState, type DashDirection } from "../movement/dash.js";
import { localAttackInput, localMoveInput } from "../movement/localMoveInput.js";
import { playCombatCue } from "../combat/combatFeedback.js";
import { swingClientState, type SwingDirection } from "../combat/swing.js";
import { ATTACK_AIM_DECISION_PX, ATTACK_BUTTON_DEAD_ZONE_PX, ATTACK_HOLD_REPEAT_MS, attackTouchGraceMs, classifyAttackDrag } from "../combat/swingAim.js";
import { beginAttackAimPress, decideAttackAim, noteAttackAimMove, takeAutoAimScreenX, type AttackAimPress } from "../combat/attackAimTelemetry.js";
import { captureLost, orientationFlipped, stickTouchGone } from "../combat/stickWatchdog.js";
import { clampBaseCenter, decideMeasure, floatingRegion, restingBaseCenter, stickVector, trailOrigin, type Point, type Rect } from "../combat/floatingStick.js";
import { useFlickDashEnabled, useFloatingSticksEnabled, useStickGuidesEnabled } from "../movement/floatingSticksPreference.js";
import { FLICK_IDLE, WALK_FLICK_IDLE, flickResolve, flickStep, walkFlickStep, type FlickState, type WalkFlickState } from "../combat/flickDash.js";
import { AimAttackRepeater, attackKnobOffset, nextAttackButtonMode, type AttackButtonMode } from "../combat/twinStick.js";
import { PAD_DPAD_DOWN, PAD_DPAD_LEFT, PAD_DPAD_RIGHT, PAD_DPAD_UP, dpadPanVector } from "../gamepad/gamepadLogic.js";
import { findGamepadScope, findKeyboardMovementBlock } from "../gamepad/gamepadScope.js";
import { perfMetrics } from "../perf/perfMetrics.js";
import { gamepadState, markGamepadUsed } from "../gamepad/gamepadState.js";
import "./JoystickMovement.css";

export type JoystickWorldState = Readonly<{
  /** Predicted (rendered) position of the local player. */
  position: LatLon;
  speedMps: number;
  leash: JoystickLeash | null;
  /** Map bearing in degrees. */
  mapBearingDeg: number;
}>;

type Props = Readonly<{
  /** Shows the on-screen stick and attack button (touch dash is a flick of the stick, no button). WASD, Space and a gamepad work either way. */
  stickVisible: boolean;
  getWorldState(): JoystickWorldState | null;
  /** Sends a MOVE_TO through the normal local-movement path. */
  onMove(lat: number, lon: number): unknown;
  /** Starts a dash (local prediction + DASH); false when it could not start. */
  onDash(direction: DashDirection): boolean;
  /** Tells the map when a movement input (stick, keys, pad) is held, so idle camera upkeep treats it as a gesture. */
  onMoveInputActive?(active: boolean): void;
  /** Pans the camera by a screen-space pixel offset (right stick). */
  panCamera(dxPx: number, dyPx: number): void;
  /** Action combat is on: the touch attack button shows. */
  actionCombat?: boolean;
  /** Tap / hold swing: App auto-aims (nearest mob in range, else `lastBearingDeg`) and swings. */
  onSwingAuto?(lastBearingDeg: number | null): boolean;
  /** Manual-aim swing in a world direction. */
  onSwing?(direction: SwingDirection): boolean;
  /** Shows (direction) or hides (null) the ground sector indicator while the button is dragged. */
  onAimIndicator?(direction: SwingDirection | null): void;
}>;

const STICK_RADIUS_PX = 46;
/** The drawn knob travels this fraction of the input vector, so it stays inside the rim of the compact base. */
const KNOB_VISUAL_TRAVEL = 0.58;
const GAMEPAD_DEAD_ZONE = 0.2;
/** Right-stick camera pan speed at full deflection, in screen pixels per second (zoom independent on screen). */
export const GAMEPAD_PAN_SPEED_PX_S = 650;
const KEY_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0]
};

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

function describeTarget(target: EventTarget | null): string {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return "none";
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`.slice(0, 50);
}

/** Overworld virtual thumbstick. Drives the same MOVE_TO path as a double-tap, nothing server-side. */
export function JoystickMovement({ stickVisible, getWorldState, onMove, onDash, onMoveInputActive, panCamera, actionCombat, onSwingAuto, onSwing, onAimIndicator }: Props): React.JSX.Element {
  const latest = useRef({ getWorldState, onMove, onDash, onMoveInputActive, panCamera });
  latest.current = { getWorldState, onMove, onDash, onMoveInputActive, panCamera };
  const swingApi = useRef<AttackApi>({ onSwingAuto, onSwing, onAimIndicator });
  swingApi.current = { onSwingAuto, onSwing, onAimIndicator };
  /** Compass bearing of the last movement input (a dash with nothing held goes this way). */
  const lastBearing = useRef<number | null>(null);
  const stick = useRef({ dx: 0, dy: 0, pointerId: null as number | null, touchId: null as number | null, origin: null as Point | null });
  const [floatingPref] = useFloatingSticksEnabled();
  const [guidesPref] = useStickGuidesEnabled();
  const [flickPref] = useFlickDashEnabled();
  const flickPrefRef = useRef(flickPref);
  flickPrefRef.current = flickPref;
  /** Flick tracking for the current movement-stick touch (touch-down time/point and the pure flick state). */
  const flick = useRef<{ downAtMs: number; downX: number; downY: number; state: FlickState; walk: WalkFlickState }>({ downAtMs: 0, downX: 0, downY: 0, state: FLICK_IDLE, walk: WALK_FLICK_IDLE });
  const floating = floatingPref && stickVisible;
  const geometry = useFloatingGeometry(floating);
  /** Floating movement stick origin (where the thumb landed, trailing a finger past the rim) while held. */
  const [plant, setPlant] = useState<Point | null>(null);
  const keys = useRef(new Set<string>());
  const pad = useRef({ dx: 0, dy: 0, deflected: false });
  /** The knob and the floating base are moved by writing their transform directly (no React state per pointer move). */
  const knobElementRef = useRef<HTMLSpanElement | null>(null);
  const plantRef = useRef<Point | null>(null);
  const paintGeometry = useRef<{ geo: FloatingGeometry | null; baseRadius: number }>({ geo: null, baseRadius: STICK_RADIUS_PX });
  const paintKnob = (x: number, y: number): void => {
    // Render-only facing: every input change lands here, so the sprite turns on this frame (outside the dead zone).
    const length = Math.hypot(x, y);
    if (length >= JOYSTICK_DEAD_ZONE * STICK_RADIUS_PX) {
      localMoveInput.dx = x / length;
      localMoveInput.dy = y / length;
    }
    const el = knobElementRef.current;
    if (el) el.style.transform = `translate(${x * KNOB_VISUAL_TRAVEL}px, ${y * KNOB_VISUAL_TRAVEL}px)`;
  };
  const paintBase = (origin: Point): void => {
    const { geo, baseRadius } = paintGeometry.current;
    const el = baseRef.current;
    if (!el || !geo?.moveRest || !geo.move) return;
    const center = clampBaseCenter(origin, baseRadius, geo.move);
    el.style.transform = `translate(${center.x - baseRadius}px, ${center.y - baseRadius}px)`;
  };
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const baseRef = useRef<HTMLDivElement | null>(null);
  const stickElementRef = useRef<HTMLDivElement | null>(null);

  const currentVector = (): { dx: number; dy: number } => {
    if (stick.current.pointerId !== null) return stick.current;
    if (pad.current.deflected) return pad.current;
    let kx = 0;
    let ky = 0;
    for (const code of keys.current) {
      const direction = KEY_DIRECTIONS[code];
      if (direction) { kx += direction[0]; ky += direction[1]; }
    }
    const length = Math.hypot(kx, ky);
    return length > 0
      ? { dx: (kx / length) * STICK_RADIUS_PX, dy: (ky / length) * STICK_RADIUS_PX }
      : { dx: 0, dy: 0 };
  };

  // The camera never follows the player: movement input is only a "gesture held" signal for idle camera upkeep.
  useEffect(() => {
    latest.current.onMoveInputActive?.(active);
    return () => latest.current.onMoveInputActive?.(false);
  }, [active]);

  // One loop for the MOVE_TO send cadence, running only while a movement input is held.
  useEffect(() => {
    if (!active) return undefined;
    let lastSend: JoystickSendState | null = null;
    let lastSentAt = Number.NEGATIVE_INFINITY;
    let moving = false;
    let raf = 0;
    let noWorldNoted = false;
    const tick = (now: number): void => {
      const world = latest.current.getWorldState();
      if (!world && !noWorldNoted) { noWorldNoted = true; perfMetrics.noteKeyIgnored("no-world-state"); }
      if (world) {
        const vector = currentVector();
        const next = computeJoystickTarget({
          dxPx: vector.dx,
          dyPx: vector.dy,
          radiusPx: STICK_RADIUS_PX,
          mapBearingDeg: world.mapBearingDeg,
          position: world.position,
          speedMps: world.speedMps,
          leash: world.leash
        });
        if (next) lastBearing.current = next.bearingDeg;
        // Render-only facing input for the local player sprite (outside the stick dead zone only).
        localMoveInput.active = next !== null;
        if (next) {
          const length = Math.hypot(vector.dx, vector.dy) || 1;
          localMoveInput.dx = vector.dx / length;
          localMoveInput.dy = vector.dy / length;
        }
        if (dashClientState.isActive(now)) {
          // The dash owns movement; its own target replaced any walk, so nothing to stop afterwards.
          // Clearing the send state makes the first frame after the dash send at once.
          lastSend = null;
          lastSentAt = Number.NEGATIVE_INFINITY;
          moving = false;
        } else if (next && now - lastSentAt >= JOYSTICK_SEND_INTERVAL_MS
          && shouldSendJoystickMove(lastSend, next, world.position, world.speedMps)) {
          latest.current.onMove(next.target.lat, next.target.lon);
          lastSend = { target: next.target, bearingDeg: next.bearingDeg };
          lastSentAt = now;
          moving = true;
        } else if (!next && moving) {
          // Back in the dead zone: stop where the player is predicted to be.
          latest.current.onMove(world.position.lat, world.position.lon);
          lastSend = null;
          moving = false;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      localMoveInput.active = false;
      const world = latest.current.getWorldState();
      if (moving && world && !dashClientState.isActive(performance.now())) {
        latest.current.onMove(world.position.lat, world.position.lon);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const refreshActive = (): void => {
    const vector = currentVector();
    const nowActive = stick.current.pointerId !== null || pad.current.deflected || keys.current.size > 0 || vector.dx !== 0 || vector.dy !== 0;
    activeRef.current = nowActive;
    setActive(nowActive);
    paintKnob(vector.dx, vector.dy);
  };

  // Dash: Space, gamepad A and the stick flick all land here.
  useEffect(() => {
    const triggerDash = (): boolean => {
      const world = latest.current.getWorldState();
      if (!world) return false;
      const vector = currentVector();
      const held = vector.dx !== 0 || vector.dy !== 0;
      const direction = chooseDashDirection({
        stick: held ? { dx: vector.dx, dy: vector.dy, radiusPx: STICK_RADIUS_PX } : null,
        lastBearingDeg: lastBearing.current,
        mapBearingDeg: world.mapBearingDeg
      });
      const started = latest.current.onDash(direction);
      if (started) lastBearing.current = direction.bearingDeg;
      return started;
    };
    dashClientState.registerTrigger(triggerDash);
    const space = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || event.repeat || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) { perfMetrics.noteKeyIgnored(`space typing-target ${describeTarget(event.target)}`); return; }
      const element = event.target as HTMLElement | null;
      if (element && typeof element.closest === "function" && element.closest("button, a, [role='button']")) return;
      const blocked = findKeyboardMovementBlock(event.code);
      if (blocked) { perfMetrics.noteKeyIgnored(`space ${blocked.reason}`); return; }
      event.preventDefault();
      triggerDash();
    };
    window.addEventListener("keydown", space);
    return () => {
      dashClientState.registerTrigger(null);
      window.removeEventListener("keydown", space);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      // Keyboard movement never depends on the on-screen stick being shown (desktop defaults it off).
      if (!(event.code in KEY_DIRECTIONS) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) { perfMetrics.noteKeyIgnored(`typing-target ${describeTarget(event.target)}`); return; }
      const blocked = findKeyboardMovementBlock(event.code);
      if (blocked) { perfMetrics.noteKeyIgnored(blocked.reason); return; }
      keys.current.add(event.code);
      refreshActive();
    };
    const up = (event: KeyboardEvent): void => {
      if (keys.current.delete(event.code)) refreshActive();
    };
    const blur = (): void => { keys.current.clear(); refreshActive(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Physical controller: standard-mapping left stick (axes 0/1), polled only while a pad is connected.
  useEffect(() => {
    const getPads = (): (Gamepad | null)[] => {
      try { return Array.from(navigator.getGamepads?.() ?? []); } catch { return []; }
    };
    let raf = 0;
    let lastPollAt = 0;
    let scopeOpen = false;
    let scopeCheckedAt = 0;
    const poll = (): void => {
      const nowMs = performance.now();
      const dtS = lastPollAt ? Math.min(0.1, (nowMs - lastPollAt) / 1000) : 0;
      lastPollAt = nowMs;
      let rx = 0;
      let ry = 0;
      let ax = 0;
      let ay = 0;
      let padUp = false;
      let padDown = false;
      let padLeft = false;
      let padRight = false;
      for (const gamepad of getPads()) {
        if (!gamepad?.connected) continue;
        padUp ||= Boolean(gamepad.buttons[PAD_DPAD_UP]?.pressed);
        padDown ||= Boolean(gamepad.buttons[PAD_DPAD_DOWN]?.pressed);
        padLeft ||= Boolean(gamepad.buttons[PAD_DPAD_LEFT]?.pressed);
        padRight ||= Boolean(gamepad.buttons[PAD_DPAD_RIGHT]?.pressed);
        const x = gamepad.axes[0] ?? 0;
        const y = gamepad.axes[1] ?? 0;
        if (Math.hypot(x, y) > Math.hypot(ax, ay)) { ax = x; ay = y; }
        const px = gamepad.axes[2] ?? 0;
        const py = gamepad.axes[3] ?? 0;
        if (Math.hypot(px, py) > Math.hypot(rx, ry)) { rx = px; ry = py; }
      }
      if (nowMs - scopeCheckedAt > 120) { scopeOpen = findGamepadScope() !== null; scopeCheckedAt = nowMs; }
      if (gamepadState.rightStickAttacks) {
        // Action combat: the right stick aims and attacks, so the D-pad pans (menus keep the D-pad for focus).
        const pan = scopeOpen ? { x: 0, y: 0 } : dpadPanVector(padUp, padDown, padLeft, padRight);
        if ((pan.x !== 0 || pan.y !== 0) && dtS > 0) {
          const panScale = GAMEPAD_PAN_SPEED_PX_S * dtS;
          markGamepadUsed();
          latest.current.panCamera(pan.x * panScale, pan.y * panScale);
        }
      } else {
        const panMagnitude = Math.hypot(rx, ry);
        if (panMagnitude >= GAMEPAD_DEAD_ZONE && dtS > 0) {
          const panScale = (panMagnitude > 1 ? 1 / panMagnitude : 1) * GAMEPAD_PAN_SPEED_PX_S * dtS;
          markGamepadUsed();
          latest.current.panCamera(rx * panScale, ry * panScale);
        }
      }
      if (scopeOpen) { ax = 0; ay = 0; }
      const magnitude = Math.hypot(ax, ay);
      const deflected = magnitude >= GAMEPAD_DEAD_ZONE;
      const scale = magnitude > 1 ? 1 / magnitude : 1;
      const wasDeflected = pad.current.deflected;
      pad.current = { dx: deflected ? ax * scale * STICK_RADIUS_PX : 0, dy: deflected ? ay * scale * STICK_RADIUS_PX : 0, deflected };
      if (deflected || wasDeflected) refreshActive();
      raf = requestAnimationFrame(poll);
    };
    const start = (): void => { if (!raf) raf = requestAnimationFrame(poll); };
    const stop = (): void => {
      if (getPads().some((gamepad) => gamepad?.connected)) return;
      cancelAnimationFrame(raf);
      raf = 0;
      if (pad.current.deflected) { pad.current = { dx: 0, dy: 0, deflected: false }; refreshActive(); }
    };
    if (getPads().some((gamepad) => gamepad?.connected)) start();
    window.addEventListener("gamepadconnected", start);
    window.addEventListener("gamepaddisconnected", stop);
    return () => {
      window.removeEventListener("gamepadconnected", start);
      window.removeEventListener("gamepaddisconnected", stop);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One finger sample (a pointer event, or one of the events the browser coalesced into it). `main` is the event itself. */
  type FingerSample = { x: number; y: number; t: number };
  const sampleFlick = (event: React.PointerEvent<HTMLDivElement>, at: FingerSample, dx: number, dy: number, main: boolean, coalesced: boolean): void => {
    if (!flickPrefRef.current) return;
    const f = flick.current;
    if (main) {
      f.state = flickStep(f.state, {
        elapsedMs: performance.now() - f.downAtMs,
        dx,
        dy,
        travelPx: Math.hypot(event.clientX - f.downX, event.clientY - f.downY),
        radiusPx: STICK_RADIUS_PX
      });
    }
    // Mid-hold flick: a fast thumb flick while already walking dashes the way the thumb now points.
    const walked = walkFlickStep(f.walk, { t: at.t, fx: at.x, fy: at.y, dx, dy, radiusPx: STICK_RADIUS_PX, quietMeansStill: coalesced });
    f.walk = walked.state;
    if (!walked.flick) return;
    f.state = FLICK_IDLE;
    const now = performance.now();
    const world = latest.current.getWorldState();
    if (!world) return;
    if (!dashClientState.acceptsInput(now)) { dashClientState.denied(); return; }
    const direction = chooseDashDirection({
      stick: { dx: walked.flick.dx, dy: walked.flick.dy, radiusPx: STICK_RADIUS_PX },
      lastBearingDeg: lastBearing.current,
      mapBearingDeg: world.mapBearingDeg
    });
    if (latest.current.onDash(direction)) lastBearing.current = direction.bearingDeg;
  };
  /**
   * The finger samples this event carries: every event the browser coalesced into it (a loaded main thread delivers one
   * event per frame with the in-between positions inside), else the event itself. `coalesced` says the browser
   * supports that, so a quiet stretch really was a still finger.
   */
  const fingerSamples = (event: React.PointerEvent<HTMLDivElement>): { points: FingerSample[]; coalesced: boolean } => {
    const own = { x: event.clientX, y: event.clientY, t: event.timeStamp > 0 ? event.timeStamp : performance.now() };
    const native = event.nativeEvent;
    if (typeof native.getCoalescedEvents !== "function") return { points: [own], coalesced: false };
    const list = native.getCoalescedEvents();
    const points = list.length > 0 ? list.map((e) => ({ x: e.clientX, y: e.clientY, t: e.timeStamp > 0 ? e.timeStamp : own.t })) : [own];
    // The dispatched event is the newest position: make sure the last sample is exactly it.
    const last = points[points.length - 1]!;
    if (last.x !== own.x || last.y !== own.y) points.push(own);
    return { points, coalesced: true };
  };
  const update = (event: React.PointerEvent<HTMLDivElement>): void => {
    const { points, coalesced } = fingerSamples(event);
    if (stick.current.origin) {
      // Floating: the origin is where the thumb landed and trails a finger that leaves the base.
      let origin = stick.current.origin;
      let vector = { dx: stick.current.dx, dy: stick.current.dy };
      points.forEach((at, i) => {
        const finger = { x: at.x, y: at.y };
        origin = trailOrigin(origin, finger, STICK_RADIUS_PX);
        vector = stickVector(origin, finger, STICK_RADIUS_PX);
        sampleFlick(event, at, vector.dx, vector.dy, i === points.length - 1, coalesced);
      });
      stick.current.origin = origin;
      stick.current.dx = vector.dx;
      stick.current.dy = vector.dy;
      if (!plantRef.current) setPlant(origin);
      plantRef.current = origin;
      paintBase(origin);
      paintKnob(vector.dx, vector.dy);
      return;
    }
    const rect = baseRef.current?.getBoundingClientRect();
    if (!rect) return;
    let dx = 0;
    let dy = 0;
    points.forEach((at, i) => {
      dx = at.x - (rect.left + rect.width / 2);
      dy = at.y - (rect.top + rect.height / 2);
      const length = Math.hypot(dx, dy);
      if (length > STICK_RADIUS_PX) {
        dx = (dx / length) * STICK_RADIUS_PX;
        dy = (dy / length) * STICK_RADIUS_PX;
      }
      sampleFlick(event, at, dx, dy, i === points.length - 1, coalesced);
    });
    stick.current.dx = dx;
    stick.current.dy = dy;
    paintKnob(dx, dy);
  };
  const release = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (stick.current.pointerId !== event.pointerId) return;
    // Flick to dash: only a real lift (not a cancel / lost capture) that qualifies, and never while the dash is on cooldown.
    let flickDash: DashDirection | null = null;
    if (flickPrefRef.current && event.type === "pointerup") {
      const now = performance.now();
      const outcome = flickResolve(flick.current.state, now - flick.current.downAtMs, dashClientState.acceptsInput(now));
      const world = latest.current.getWorldState();
      if (outcome.dash && world) {
        flickDash = chooseDashDirection({
          stick: { dx: outcome.dx, dy: outcome.dy, radiusPx: STICK_RADIUS_PX },
          lastBearingDeg: lastBearing.current,
          mapBearingDeg: world.mapBearingDeg
        });
      }
    }
    resetStick();
    if (flickDash && latest.current.onDash(flickDash)) lastBearing.current = flickDash.bearingDeg;
  };

  /** Lets the stick go (the knob recentres, the move loop sends its stop frame and the follow settles). Safe to call when idle. */
  const resetStick = (): void => {
    if (stick.current.pointerId === null && stick.current.touchId === null && stick.current.origin === null) return;
    flick.current.state = FLICK_IDLE;
    flick.current.walk = WALK_FLICK_IDLE;
    stick.current = { dx: 0, dy: 0, pointerId: null, touchId: null, origin: null };
    plantRef.current = null;
    setPlant(null);
    refreshActive();
  };
  const resetStickRef = useRef(resetStick);
  resetStickRef.current = resetStick;

  // The finger can vanish without a pointerup or pointercancel (iOS system gestures, banners, backgrounding): let the stick
  // go on every other signal that it is gone, so it can never stay drawn active or keep the player walking.
  useEffect(() => {
    const release = (): void => resetStickRef.current();
    const onHidden = (): void => { if (document.hidden) release(); };
    let size = { width: window.innerWidth, height: window.innerHeight };
    const onResize = (): void => {
      const next = { width: window.innerWidth, height: window.innerHeight };
      if (orientationFlipped(size, next)) release();
      size = next;
    };
    // Any touch event whose active list no longer holds the stick's own touch means that finger is gone.
    const onTouchList = (event: TouchEvent): void => {
      if (stick.current.pointerId === null) return;
      if (event.touches.length === 0 || stickTouchGone(event.touches, stick.current.touchId)) release();
    };
    window.addEventListener("blur", release);
    window.addEventListener("pagehide", release);
    window.addEventListener("orientationchange", release);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onHidden);
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) document.addEventListener(name, onTouchList, { capture: true, passive: true });
    // Pointer capture is the browser's hold on the finger: when it is gone the stick is no longer held.
    const timer = window.setInterval(() => {
      const el = stickElementRef.current;
      if (stick.current.pointerId !== null && el && captureLost(stick.current.pointerId, (id) => el.hasPointerCapture(id))) release();
    }, 300);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("orientationchange", release);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onHidden);
      for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) document.removeEventListener(name, onTouchList, { capture: true });
      window.clearInterval(timer);
    };
  }, []);

  // Tells the HUD stylesheet the thumb zones are in use (dock width, slot rail size) without per-component props.
  useEffect(() => {
    if (!stickVisible) return undefined;
    const root = document.documentElement;
    root.dataset.combatControls = "on";
    return () => { delete root.dataset.combatControls; };
  }, [stickVisible]);

  if (!stickVisible) return <DashCooldownPip />;
  const geo = floating ? geometry.value : null;
  const baseRadius = geo?.moveRest ? geo.moveRest.w / 2 : STICK_RADIUS_PX;
  // Resting: the exact centre of the zone, in both orientations. While a thumb is down the base is where it landed.
  const baseCenter: Point | null = geo?.moveRest
    ? (plant && geo.move ? clampBaseCenter(plant, baseRadius, geo.move) : restingBaseCenter(geo.move, baseRadius))
    : null;
  paintGeometry.current = { geo, baseRadius };
  const regionStyle = (r: Rect): React.CSSProperties => ({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top });
  return (
    <>
    {floating ? <div ref={geometry.probeRef} className="joystick-geometry-probe" aria-hidden="true" /> : null}
    {floating && geo && guidesPref ? (
      <>
        <div className="floating-region-guide is-left" data-region-guide="left" style={regionStyle(geo.move)} aria-hidden="true" />
        <div className="floating-region-guide is-right" data-region-guide="right" style={regionStyle(geo.attack)} aria-hidden="true" />
      </>
    ) : null}
    {floating ? <div ref={geometry.moveAnchorRef} className="joystick-rest-anchor" aria-hidden="true" /> : null}
    {/* Right thumb: attack is the anchor. Dash has no button on touch: a flick of the stick dashes, and the recharge shows as the pip. */}
    <div ref={geometry.attackAnchorRef} className="joystick-combat-cluster">
      {actionCombat ? <AttackButton api={swingApi} getWorldState={getWorldState} lastBearing={lastBearing} floating={geo} /> : null}
    </div>
    <DashCooldownPip />
    <div
      ref={stickElementRef}
      className={`joystick-move${active ? " is-active" : ""}${floating ? " is-floating" : ""}${floating && geo?.suspended ? " is-suspended" : ""}${plant ? " is-held" : ""}`}
      style={floating && geo ? regionStyle(geo.move) : undefined}
      role="application"
      aria-label="Movement joystick"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        // A stale hold (its finger is gone but no release arrived) must never block the next touch: take over.
        if (stick.current.pointerId !== null && captureLost(stick.current.pointerId, (id) => event.currentTarget.hasPointerCapture(id))) resetStick();
        if (stick.current.pointerId !== null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        stick.current.pointerId = event.pointerId;
        stick.current.touchId = null;
        flick.current = { downAtMs: performance.now(), downX: event.clientX, downY: event.clientY, state: FLICK_IDLE, walk: WALK_FLICK_IDLE };
        if (floating) stick.current.origin = { x: event.clientX, y: event.clientY };
        update(event);
        refreshActive();
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        if (stick.current.pointerId === event.pointerId) update(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onTouchStart={(event) => {
        event.stopPropagation();
        // The stick's own touch: the first finger that lands while it is held and not yet identified.
        if (stick.current.pointerId !== null && stick.current.touchId === null) stick.current.touchId = event.changedTouches[0]?.identifier ?? null;
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        ref={baseRef}
        className="joystick-move-base"
        style={baseCenter ? { transform: `translate(${baseCenter.x - baseRadius}px, ${baseCenter.y - baseRadius}px)` } : floating ? { visibility: "hidden" } : undefined}
      >
        <span className="joystick-move-ring" aria-hidden="true" />
        <span ref={knobElementRef} className="joystick-move-knob" />
      </div>
    </div>
    </>
  );
}

/** A measured rect plus its centre. */
type Measured = Rect & Readonly<{ w: number; h: number; cx: number; cy: number }>;
type FloatingGeometry = Readonly<{
  move: Rect;
  attack: Rect;
  moveRest: Measured | null;
  attackRest: Measured | null;
  /** A menu or popup is open: the regions stop taking touches. */
  suspended: boolean;
}>;

const SHORT_LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 520px)";

function measured(element: Element | null): Measured | null {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  if (r.width < 1) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

/**
 * Measures the screen for the floating regions: viewport, safe insets and dock (through a hidden probe that reads the
 * HUD custom properties as pixels) and the resting corner positions. Re-measured on resize and on a slow tick, which
 * also tracks whether a menu or popup is open.
 */
/** Survives the stick unmounting (a reconnect) so a remount starts at the correct spot instead of mid-screen. */
let lastGoodGeometry: { value: FloatingGeometry; key: string; values: number[]; leftRail: boolean; rightRail: boolean; width: number; height: number } | null = null;

function geometryValues(g: FloatingGeometry): number[] {
  const rect = (r: Rect): number[] => [r.left, r.top, r.right, r.bottom];
  const rest = (m: Measured | null): number[] => (m ? [m.left, m.top, m.right, m.bottom] : [0, 0, 0, 0]);
  return [...rect(g.move), ...rect(g.attack), ...rest(g.moveRest), ...rest(g.attackRest)];
}

function useFloatingGeometry(enabled: boolean): {
  value: FloatingGeometry | null;
  probeRef: React.RefObject<HTMLDivElement | null>;
  moveAnchorRef: React.RefObject<HTMLDivElement | null>;
  attackAnchorRef: React.RefObject<HTMLDivElement | null>;
} {
  const probeRef = useRef<HTMLDivElement | null>(null);
  const moveAnchorRef = useRef<HTMLDivElement | null>(null);
  const attackAnchorRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState<FloatingGeometry | null>(() => (enabled ? lastGoodGeometry?.value ?? null : null));
  useEffect(() => {
    if (!enabled) { setValue(null); return undefined; }
    let pendingKey: string | null = null;
    let pendingFrame = 0;
    const measure = (): void => {
      const probe = probeRef.current;
      if (!probe) return;
      // Hidden or zero-sized viewport (phone just resumed): keep the last good geometry instead of measuring a broken layout.
      if (document.visibilityState === "hidden" || window.innerWidth < 1 || window.innerHeight < 1) return;
      const cs = getComputedStyle(probe);
      const shortLandscape = typeof window.matchMedia === "function" && window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
      const dock = document.querySelector(".phone-bottom-bar")?.getBoundingClientRect();
      const lowestSlotBottom = (side: "left" | "right"): number | null => {
        let bottom: number | null = null;
        document.querySelectorAll(`.ash-hotbar-rail-${side} .ash-hotbar-slot`).forEach((slot) => {
          const r = slot.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (bottom === null || r.bottom > bottom)) bottom = r.bottom;
        });
        return bottom;
      };
      const viewport = {
        leftRailBottom: lowestSlotBottom("left"),
        rightRailBottom: lowestSlotBottom("right"),
        width: window.innerWidth,
        height: window.innerHeight,
        safeLeft: parseFloat(cs.paddingLeft) || 0,
        safeRight: parseFloat(cs.paddingRight) || 0,
        safeBottom: parseFloat(cs.paddingBottom) || 0,
        dockHeight: parseFloat(cs.width) || 0,
        shortLandscape,
        dockSpan: dock && dock.width > 0 ? { left: dock.left, right: dock.right } : null
      };
      const attackRest = measured(attackAnchorRef.current);
      const attackCorner = floatingRegion("right", viewport);
      const moveRegion = floatingRegion("left", viewport);
      // Short landscape: the whole bottom-right corner is the attack zone (nothing there reaches the map); otherwise the thumb square.
      const attackRegion = attackCorner;
      const next: FloatingGeometry = {
        move: moveRegion,
        attack: attackRegion,
        moveRest: measured(moveAnchorRef.current),
        attackRest,
        suspended: findGamepadScope() !== null
      };
      const key = JSON.stringify(next, (_k, v: unknown) => (typeof v === "number" ? Math.round(v * 2) / 2 : v));
      const good = lastGoodGeometry;
      const decision = decideMeasure({
        committed: good,
        candidate: { key, values: geometryValues(next) },
        pendingKey,
        // Not laid out yet (first frame after resume): never commit that, or the sticks slide from mid-screen.
        restMissing: next.moveRest === null,
        railLost: good !== null && good.width === viewport.width && good.height === viewport.height && ((good.leftRail && viewport.leftRailBottom === null) || (good.rightRail && viewport.rightRailBottom === null))
      });
      if (decision === "ignore") { pendingKey = null; return; }
      if (decision === "pending") {
        pendingKey = key;
        if (!pendingFrame) pendingFrame = window.requestAnimationFrame(() => { pendingFrame = 0; measure(); });
        return;
      }
      pendingKey = null;
      lastGoodGeometry = { value: next, key, values: geometryValues(next), leftRail: viewport.leftRailBottom !== null, rightRail: viewport.rightRailBottom !== null, width: viewport.width, height: viewport.height };
      setValue(next);
    };
    measure();
    const timer = window.setInterval(measure, 250);
    // iOS settles the layout a frame after resume: re-measure now and again on the next animation frame.
    const onResumed = (): void => {
      measure();
      window.requestAnimationFrame(measure);
    };
    document.addEventListener("visibilitychange", onResumed);
    window.addEventListener("pageshow", onResumed);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.clearInterval(timer);
      if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      document.removeEventListener("visibilitychange", onResumed);
      window.removeEventListener("pageshow", onResumed);
    };
  }, [enabled]);
  return { value, probeRef, moveAnchorRef, attackAnchorRef };
}

/** Drives a `--dash-ready` (0..1) CSS variable on the element while the dash recharges. */
function useDashCooldownStyle(ref: React.RefObject<HTMLElement | null>): { cooling: boolean; readyPop: boolean } {
  const revision = useSyncExternalStore(dashClientState.subscribe, dashClientState.getRevision);
  const [cooling, setCooling] = useState(false);
  const [readyPop, setReadyPop] = useState(false);
  const wasCooling = useRef(false);
  useEffect(() => {
    let raf = 0;
    const step = (): void => {
      const progress = dashClientState.cooldownProgress(performance.now());
      ref.current?.style.setProperty("--dash-ready", progress.toFixed(3));
      setCooling(progress < 1);
      if (progress < 1) {
        wasCooling.current = true;
        raf = requestAnimationFrame(step);
      } else if (wasCooling.current) {
        // The charge is back: a short bright pulse on the recharge pip plus the ready cue.
        wasCooling.current = false;
        playCombatCue("dashReady");
        setReadyPop(true);
        window.setTimeout(() => setReadyPop(false), 380);
      }
    };
    step();
    return () => { cancelAnimationFrame(raf); };
  }, [revision, ref]);
  return { cooling, readyPop };
}

/** True for a moment after a gesture (a flick) asked for a dash that was still recharging. */
function useDashDenied(): boolean {
  const revision = useSyncExternalStore(dashClientState.subscribe, dashClientState.getDeniedRevision);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (revision === 0) return undefined;
    setDenied(true);
    const timer = window.setTimeout(() => setDenied(false), 420);
    return () => window.clearTimeout(timer);
  }, [revision]);
  return denied;
}

/** The dash recharge cue (also shown when a flick asked for a dash that is still recharging). */
function DashCooldownPip(): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const { cooling, readyPop } = useDashCooldownStyle(ref);
  const denied = useDashDenied();
  return <div ref={ref} className={`joystick-dash-pip${cooling ? " is-cooling" : ""}${denied ? " is-denied" : ""}${readyPop ? " is-ready-pop" : ""}`} aria-hidden="true" />;
}


/** True for a moment after a press came too early to buffer (the ring blinks, like a refused dash). */
function useSwingTooEarly(): boolean {
  const revision = useSyncExternalStore(swingClientState.subscribe, swingClientState.getIgnoredRevision);
  const [early, setEarly] = useState(false);
  useEffect(() => {
    if (revision === 0) return undefined;
    setEarly(true);
    const timer = window.setTimeout(() => setEarly(false), 320);
    return () => window.clearTimeout(timer);
  }, [revision]);
  return early;
}

/** Drives a `--swing-ready` (0..1) CSS variable while the swing recovers; `readyPop` is true briefly when recovery ends. */
function useSwingCooldownStyle(ref: React.RefObject<HTMLElement | null>): { cooling: boolean; readyPop: boolean } {
  const revision = useSyncExternalStore(swingClientState.subscribe, swingClientState.getRevision);
  const [cooling, setCooling] = useState(false);
  const [readyPop, setReadyPop] = useState(false);
  const wasCooling = useRef(false);
  useEffect(() => {
    let raf = 0;
    const step = (): void => {
      const now = performance.now();
      const total = swingClientState.nextSwingAtMs - swingClientState.lastSwingAtMs;
      const progress = total > 0 ? Math.min(1, Math.max(0, (now - swingClientState.lastSwingAtMs) / total)) : 1;
      ref.current?.style.setProperty("--swing-ready", progress.toFixed(3));
      setCooling(progress < 1);
      if (progress < 1) {
        wasCooling.current = true;
        raf = requestAnimationFrame(step);
      } else if (wasCooling.current) {
        wasCooling.current = false;
        // Only a recovery that ran out on its own is a "ready" beat (a dash-cancel clears nextSwingAtMs to 0).
        if (swingClientState.nextSwingAtMs > 0) {
          playCombatCue("ready");
          setReadyPop(true);
          window.setTimeout(() => setReadyPop(false), 300);
        }
      }
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [revision, ref]);
  return { cooling, readyPop };
}

type AttackApi = {
  onSwingAuto: ((lastBearingDeg: number | null) => boolean) | undefined;
  onSwing: ((direction: SwingDirection) => boolean) | undefined;
  onAimIndicator: ((direction: SwingDirection | null) => void) | undefined;
};

type AttackGesture = {
  pointerId: number;
  centerX: number;
  centerY: number;
  /** Base radius (px), the trailing limit in floating mode. */
  radius: number;
  startedAtMs: number;
  mode: AttackButtonMode;
  direction: SwingDirection | null;
  raf: number;
  repeater: AimAttackRepeater;
  /** Timing telemetry for the first aim decision (the session's first 50 presses), else null. */
  aimLog: AttackAimPress | null;
  /** Where the finger landed (client px): the first aim decision reads the pull from here (the fixed button's centre can be
   *  well off the landing point; in floating mode they coincide). */
  downX: number;
  downY: number;
  /** The finger's last offset from the landing point (px) while deciding: a finger still travelling when the grace ends
   *  extends it. */
  offsetPx: number;
};

/** How far the knob travels from the button centre while the attack button is dragged (px). */
const ATTACK_KNOB_MAX_PX = 13;

/**
 * Touch attack button, a second stick. Touch-down opens the ATTACK_TOUCH_GRACE_MS window (150 ms): a drag past
 * ATTACK_AIM_DECISION_PX (9 px) inside it swings at once toward the drag (a land-and-pull swings that way first, not
 * along the last movement bearing; a finger still travelling at the window end extends it to 250 ms); a lift inside
 * it swings toward the lift point when that is past 9 px, else auto-aimed; a still hold swings auto-aimed when it ends and keeps auto-aim swings repeating at the recovery cadence
 * (leaving the full dead zone later switches to aiming). Press and drag: aim and attack
 * continuously toward the drag direction (the ground sector follows; the swing already sent keeps its aim, the
 * next one uses the drag), dragging back into the centre pauses, release stops. SwingClientState gates the cadence.
 */
function AttackButton({ api, getWorldState, lastBearing, floating }: {
  api: React.RefObject<AttackApi>;
  getWorldState(): JoystickWorldState | null;
  lastBearing: React.RefObject<number | null>;
  /** Floating mode: the measured regions; null keeps the fixed corner button. */
  floating: FloatingGeometry | null;
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);
  const faceRef = useRef<HTMLSpanElement | null>(null);
  const { cooling, readyPop } = useSwingCooldownStyle(ref);
  const tooEarly = useSwingTooEarly();
  const gesture = useRef<AttackGesture | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number; deg: number } | null>(null);
  /** Floating: the thumb's landing point (trailing the finger past the rim) while the attack stick is held. */
  const [plant, setPlant] = useState<Point | null>(null);

  const end = (): AttackGesture | null => {
    const g = gesture.current;
    if (!g) return null;
    cancelAnimationFrame(g.raf);
    gesture.current = null;
    localAttackInput.touch = false;
    localAttackInput.dx = null;
    api.current?.onAimIndicator?.(null);
    setKnob(null);
    setPlant(null);
    return g;
  };
  useEffect(() => () => { end(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The finger can vanish without a pointerup or pointercancel (backgrounding, banners): release the gesture on every other signal.
  useEffect(() => {
    const onBackground = (): void => { end(); };
    const onHidden = (): void => { if (document.visibilityState === "hidden") end(); };
    window.addEventListener("blur", onBackground);
    window.addEventListener("pagehide", onBackground);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", onBackground);
      window.removeEventListener("pagehide", onBackground);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const autoSwing = (): boolean => api.current?.onSwingAuto?.(lastBearing.current) ?? false;
  const moveScreenX = (): number | null => (localMoveInput.active ? localMoveInput.dx : null);
  /** The auto-aimed first swing (tap or still hold), logged with the side App's auto-aim chose. */
  const autoSwingDecided = (g: AttackGesture, source: "tap" | "hold", now: number): void => {
    const swung = autoSwing();
    decideAttackAim(g.aimLog, source, now, takeAutoAimScreenX(), moveScreenX(), swung);
  };
  // One frame loop while the finger is down: promotes a still hold to auto repeat and drives continuous swings.
  const loop = (): void => {
    const g = gesture.current;
    if (!g) return;
    const now = performance.now();
    g.mode = nextAttackButtonMode(g.mode, "idle", now - g.startedAtMs, attackTouchGraceMs(g.offsetPx));
    if (g.mode === "aim" && g.direction) {
      // Keeps the sector under the player's feet while they move during the drag.
      api.current?.onAimIndicator?.(g.direction);
      if (g.repeater.due(now, swingClientState.nextSwingAtMs)) api.current?.onSwing?.(g.direction);
    } else if (g.mode === "auto" && g.repeater.due(now, swingClientState.nextSwingAtMs)) {
      if (g.aimLog && !g.aimLog.decided) autoSwingDecided(g, "hold", now);
      else autoSwing();
    }
    g.raf = requestAnimationFrame(loop);
  };

  const onDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const mapBearingDeg = getWorldState()?.mapBearingDeg ?? 0;
    if (floating) {
      // The stick base trails a finger that leaves its rim, so a change of direction answers at once.
      const origin = trailOrigin({ x: g.centerX, y: g.centerY }, { x: event.clientX, y: event.clientY }, g.radius);
      g.centerX = origin.x;
      g.centerY = origin.y;
      setPlant(origin);
    }
    const now = performance.now();
    const pullX = event.clientX - g.downX;
    const pullY = event.clientY - g.downY;
    if (g.mode === "pending") {
      g.offsetPx = Math.hypot(pullX, pullY);
      noteAttackAimMove(g.aimLog, now, pullX, pullY);
    }
    // Inside the touch-down grace the first aim decision reads the pull from the landing point with the smaller dead zone,
    // so a pull is caught early; afterwards the offset from the stick centre with the full dead zone.
    const deciding = g.mode === "pending" && now - g.startedAtMs < attackTouchGraceMs(g.offsetPx);
    const dx = deciding ? pullX : event.clientX - g.centerX;
    const dy = deciding ? pullY : event.clientY - g.centerY;
    const state = classifyAttackDrag(dx, dy, mapBearingDeg, g.mode === "aim" || g.mode === "paused", deciding ? ATTACK_AIM_DECISION_PX : ATTACK_BUTTON_DEAD_ZONE_PX);
    g.mode = nextAttackButtonMode(g.mode, state.kind === "aim" ? "aim" : state.kind === "cancel" ? "cancel" : "idle", now - g.startedAtMs, attackTouchGraceMs(g.offsetPx));
    if (state.kind === "aim") {
      g.direction = state.direction;
      localAttackInput.dx = dx / Math.hypot(dx, dy);
      // The first move past the dead zone swings at once (no waiting for the next frame), then the loop repeats it.
      let swung = false;
      if (g.mode === "aim" && g.repeater.due(now, swingClientState.nextSwingAtMs)) {
        swung = api.current?.onSwing?.(state.direction) ?? false;
      }
      decideAttackAim(g.aimLog, "drag", now, localAttackInput.dx, moveScreenX(), swung, Math.hypot(dx, dy));
      api.current?.onAimIndicator?.(state.direction);
    } else if (state.kind === "cancel") {
      g.direction = null;
      localAttackInput.dx = null;
      api.current?.onAimIndicator?.(null);
    }
    if (g.mode === "aim" || g.mode === "paused") setKnob({ ...attackKnobOffset(dx, dy, ATTACK_KNOB_MAX_PX), deg: (Math.atan2(dy, dx) * 180) / Math.PI });
  };
  const onRelease = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const g = gesture.current;
    if (g?.pointerId !== event.pointerId) return;
    // Lifted inside the touch-down grace: swings now. A lift point past the decision distance is a flick whose moves
    // were coalesced into the pointerup: it swings that way; otherwise auto-aimed. Later, lifting only stops the repeat.
    const now = performance.now();
    if (g.mode !== "pending") { end(); return; }
    const dx = event.clientX - g.downX;
    const dy = event.clientY - g.downY;
    const flick = event.type === "pointerup"
      ? classifyAttackDrag(dx, dy, getWorldState()?.mapBearingDeg ?? 0, false, ATTACK_AIM_DECISION_PX)
      : null;
    end();
    if (flick?.kind === "aim") {
      const swung = api.current?.onSwing?.(flick.direction) ?? false;
      decideAttackAim(g.aimLog, "flick", now, dx / Math.hypot(dx, dy), moveScreenX(), swung, Math.hypot(dx, dy));
    } else {
      autoSwingDecided(g, "tap", now);
    }
  };

  const rest = floating?.attackRest ?? null;
  const faceRadius = rest ? rest.w / 2 : 0;
  const faceCenter: Point | null = rest
    ? (plant ? clampBaseCenter(plant, faceRadius, floating!.attack) : restingBaseCenter(floating!.attack, faceRadius))
    : null;
  const faceStyle: React.CSSProperties | undefined = faceCenter
    ? ({
      transform: `translate(${faceCenter.x - faceRadius}px, ${faceCenter.y - faceRadius}px)`,
      "--kx": `${knob?.x ?? 0}px`,
      "--ky": `${knob?.y ?? 0}px`
    } as React.CSSProperties)
    : floating ? { visibility: "hidden" } : undefined;
  const regionStyle: React.CSSProperties | undefined = floating
    ? { left: floating.attack.left, top: floating.attack.top, right: "auto", bottom: "auto", width: floating.attack.right - floating.attack.left, height: floating.attack.bottom - floating.attack.top }
    : undefined;
  return (
    <button
      ref={ref}
      type="button"
      style={regionStyle}
      className={`joystick-attack${cooling ? " is-cooling" : ""}${knob ? " is-aiming" : ""}${floating ? " is-floating" : ""}${floating?.suspended ? " is-suspended" : ""}${plant ? " is-held" : ""}${readyPop ? " is-ready-pop" : ""}${tooEarly ? " is-too-early" : ""}`}
      aria-label="Attack"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        if (gesture.current) return;
        const rect = (faceRef.current ?? event.currentTarget).getBoundingClientRect();
        event.currentTarget.setPointerCapture(event.pointerId);
        const radius = (floating?.attackRest?.w ?? rect.width) / 2;
        const g: AttackGesture = {
          pointerId: event.pointerId,
          centerX: floating ? event.clientX : rect.left + rect.width / 2,
          centerY: floating ? event.clientY : rect.top + rect.height / 2,
          radius,
          startedAtMs: performance.now(),
          // "pending" for the touch-down grace: a drag inside it aims, a lift swings, a still hold turns "auto".
          mode: nextAttackButtonMode("pending", "idle", 0, ATTACK_HOLD_REPEAT_MS),
          direction: null,
          raf: 0,
          repeater: new AimAttackRepeater(),
          aimLog: beginAttackAimPress(performance.now()),
          downX: event.clientX,
          downY: event.clientY,
          offsetPx: 0
        };
        gesture.current = g;
        localAttackInput.touch = true;
        localAttackInput.dx = null;
        if (floating) setPlant({ x: g.centerX, y: g.centerY });
        // Act on touch-down (common in action games), after the 150 ms grace (owner 2026-10-20, t1559): the loop fires the
        // auto-aimed swing when the grace ends unless a drag aimed first. A buffered or too-early press falls through
        // to the loop, which repeats when the recovery ends while the finger is still down.
        g.raf = requestAnimationFrame(loop);
      }}
      onPointerMove={onDrag}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onLostPointerCapture={onRelease}
      onTouchStart={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <span ref={faceRef} className="joystick-attack-face" style={faceStyle}>
      <svg className="joystick-attack-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <g strokeLinejoin="round" strokeLinecap="round" strokeWidth="1.9" stroke="currentColor">
          <path d="M27.5 4.5v4.2L14.6 21.6l-4.2-4.2L23.3 4.5z" fill="#f4ecd8" />
          <path d="M8.2 15.6l8.2 8.2-2.3 2.3-8.2-8.2z" fill="var(--aa-ui-bronze-500)" />
          <path d="M10.3 21.7l-4.9 4.9" fill="none" strokeWidth="3.4" />
          <circle cx="4.6" cy="27.4" r="2.1" fill="var(--aa-ui-bronze-500)" />
        </g>
        <path d="M24 7.6L13.6 18" fill="none" stroke="currentColor" strokeWidth="1" opacity=".35" strokeLinecap="round" />
      </svg>
      {knob ? <span className="joystick-attack-marker" aria-hidden="true" style={{ transform: `rotate(${knob.deg.toFixed(1)}deg)` }} /> : null}
      {knob ? <span className="joystick-attack-knob" data-testid="attack-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} /> : null}
      </span>
    </button>
  );
}
