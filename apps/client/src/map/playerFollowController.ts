/**
 * Per-frame driver of the player camera: the joystick follow and the combat zoom (docs/plans/hud-landscape.md,
 * docs/plans/combat-zoom-smooth.md). One rAF loop owns the camera: it pans with map.panBy (duration 0, the same call the
 * gamepad camera pan uses) and, while the combat zoom runs, writes zoom and pan together in ONE map.jumpTo per frame (the
 * zoom is interpolated here, around the player, never with a competing map.easeTo). Player prediction, joystick direction,
 * tap auto-aim and dash all stay in world space. The loop runs only while a follow settles or the zoom animates; the combat
 * state is sampled on a slow timer.
 */
import {
  PLAYER_CAMERA,
  combatZoomTarget,
  framingPan,
  hardRect,
  limitPanToKeepPlayer,
  safeRect,
  smoothingShare,
  smootherstep,
  zoomFramingCenter,
  type Point
} from "./playerFollow.js";
import { groundScaleZoomOffset } from "./groundScaleZoom.js";
import { CameraTargetFilter } from "./cameraTargetFilter.js";
import { cameraFilterMode } from "./cameraDriverMode.js";
import { cameraSnapMode, quantizePanToDevicePixels } from "./followSwitches.js";
import { noteFollowFrame } from "../perf/motionReport.js";

type LatLon = Readonly<{ lat: number; lon: number }>;

export interface PlayerFollowMap {
  project(lngLat: [number, number]): { x: number; y: number };
  getCenter(): { lng: number; lat: number };
  getCanvas(): HTMLCanvasElement;
  panBy(offset: [number, number], options: { duration: number }): unknown;
  getZoom(): number;
  getBearing(): number;
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
}

export interface PlayerFollowDeps {
  getMap(): PlayerFollowMap | null;
  /** Rendered (predicted) position of the local player. */
  playerPosition(nowMs?: number): LatLon | null;
  /** The player is fighting right now: attacking a mob or being attacked (the engaged state). */
  inCombat(): boolean;
  /** A programmatic camera move (travel, recenter ease, interior) owns the camera: do nothing this frame. */
  cameraBusy(): boolean;
  /** A user gesture on the map: a drag stops the follow, a pinch or wheel zoom is the player's own zoom. */
  userGesture(): "drag" | "zoom" | null;
  /** The overworld camera may follow and zoom (world map, not an interior). */
  followEnabled(): boolean;
  /** Combat zoom may run (action combat on, the setting allows it). */
  combatZoomEnabled(): boolean;
  /** Joystick, keyboard or pad movement input is held right now (not a tap-to-move). */
  moveInputHeld(): boolean;
  /** The play zoom (ground-scale), null when unknown. The combat zoom target is this plus one step. */
  playZoom(): number | null;
  /** The combat zoom reached its target: that is now the play zoom (idle zoom upkeep keeps it, repeated fights do not ratchet). */
  commitPlayZoom(groundZoom: number): void;
  now?(): number;
}

type Phase = "idle" | "following";
/** off: no fight. in: the zoom animates. held: zoomed (or already past the target) for this fight. pinched: the player took the zoom over. */
type ZoomPhase = "off" | "in" | "held" | "pinched";
type ZoomAnim = { startMs: number; from: number; to: number; targetGround: number };

export class PlayerFollowController {
  phase: Phase = "idle";
  zoomPhase: ZoomPhase = "off";
  private raf = 0;
  /** The loop is running (own rAF, or driven by the overlay frame). */
  private loopActive = false;
  /** The overlay frame drives the camera (setExternalDriver): no own rAF, so camera, map render and sprites share one tick. */
  private external = false;
  private pollTimer = 0;
  private lastFrameMs = 0;
  /** Pan applied last frame (screen px): the next pan is blended from it so speed changes gradually. */
  private lastPan: Point = { x: 0, y: 0 };
  /** Length (ms) of the frame that pan covered, to turn it back into a speed. */
  private lastPanMs = 16;
  /** Player's screen point last frame, for the follow feed-forward. */
  private prevPlayerPx: Point | null = null;
  /** Until this time the follow keeps the slower settle and blend (a dash just happened). */
  private gentleUntilMs = 0;
  /** The running zoom (camera zoom from and to), or null. */
  private zoomAnim: ZoomAnim | null = null;
  /** The last combat zoom target reached: while the play zoom still equals it the next fight reuses it (no ratchet). */
  private lastTargetGround: number | null = null;
  /** The camera zoom after our last write: a different zoom at the next frame was set by someone else (the player's pinch). */
  private lastWrittenZoom = 0;
  private lastCombatMs = 0;
  /** Test hook (full-app specs): freezes the camera so a spec can hold the player off screen. */
  paused = false;
  /** Low-pass, prediction-stable follow target (cameraTargetFilter.ts), in world px relative to filterOrigin. */
  private readonly targetFilter = new CameraTargetFilter();
  /** Fixed world point (and the zoom and bearing) the filter's world px are measured from; a zoom or bearing change restarts it. */
  private filterOrigin: { lngLat: [number, number]; zoom: number; bearing: number } | null = null;
  /** Follow pans that went backwards along the movement axis and were held (debug readout for the specs). */
  private heldBackSteps = 0;

  constructor(private readonly deps: PlayerFollowDeps) {
    (window as unknown as { __ASH_ATLAS_PLAYER_CAMERA__?: unknown }).__ASH_ATLAS_PLAYER_CAMERA__ = this.debugView();
    this.pollTimer = window.setInterval(this.poll, PLAYER_CAMERA.combatZoom.pollMs);
  }

  private debugView(): object {
    const self = this;
    return {
      get phase() { return self.phase; },
      get zoomPhase() { return self.zoomPhase; },
      get paused() { return self.paused; },
      set paused(value: boolean) { self.paused = value; },
      get lastTargetGround() { return self.lastTargetGround; },
      /** Screen distance (px) of the rendered player from the camera centre; null while unknown (full-app specs). */
      get playerOffsetPx() { return self.playerOffsetPx(); },
      get cameraDelta() { return self.cameraDelta(); },
      get heldBackSteps() { return self.heldBackSteps; }
    };
  }

  private playerOffsetPx(): number | null {
    const map = this.deps.getMap();
    const player = this.deps.playerPosition();
    if (!map || !player) return null;
    const c = map.project([map.getCenter().lng, map.getCenter().lat]);
    const p = map.project([player.lon, player.lat]);
    return Math.hypot(p.x - c.x, p.y - c.y);
  }

  /** Test hook: the camera centre in screen px of the current projection origin (compare across frames). */
  private cameraDelta(): { x: number; y: number } | null {
    const map = this.deps.getMap();
    if (!map) return null;
    const o = map.project([0, 0]);
    return { x: o.x, y: o.y };
  }

  private now(): number { return this.deps.now ? this.deps.now() : performance.now(); }

  /** True while the combat zoom animates (idle ground-zoom upkeep must leave it alone). */
  holdsZoom(): boolean { return this.zoomAnim !== null; }

  /** A confirmed player hit landed: combat is on even before the server marks the player engaged. */
  noteCombatActivity(): void {
    if (!this.deps.combatZoomEnabled()) return;
    this.lastCombatMs = this.now();
    this.poll();
  }

  /**
   * Movement input (joystick, keys, pad) started or stopped. Starting resumes the follow (also after a drag stopped it);
   * stopping lets the camera finish settling on the player.
   */
  noteMoveInput(active: boolean): void {
    if (!active || !this.deps.followEnabled()) return;
    this.startFollow();
  }

  /** Inside a room the camera keeps the player in view whatever moved them (tap, dash, joystick): follow until settled. */
  followPlayer(): void {
    if (!this.deps.followEnabled()) return;
    this.startFollow();
  }

  /** A tap-to-move: the camera does not follow it. */
  noteTapMove(): void {
    if (this.phase === "following") this.clearFollow();
  }

  /** The recenter control or the off-screen badge: drop the follow (the recenter owns the camera move). The combat zoom is left as it is. */
  clear(): void {
    this.clearFollow();
  }

  /** A manual camera pan (gamepad pan, drag) stops the follow. */
  noteManualPan(): void {
    if (this.phase !== "idle") this.clearFollow();
  }

  dispose(): void {
    this.clearFollow();
    this.unwatchMapPointer();
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
    this.unwatchPinch();
    const w = window as unknown as { __ASH_ATLAS_PLAYER_CAMERA__?: unknown };
    delete w.__ASH_ATLAS_PLAYER_CAMERA__;
  }

  private startFollow(): void {
    this.watchMapPointer();
    if (this.phase === "idle") {
      this.phase = "following";
      this.activateLoop();
    }
  }

  /** Residual of the device-pixel quantized pan (ash-atlas:camera-snap). */
  private snapCarry: Point = { x: 0, y: 0 };

  private clearFollow(): void {
    this.snapCarry = { x: 0, y: 0 };
    this.phase = "idle";
    this.lastPan = { x: 0, y: 0 };
    this.prevPlayerPx = null;
    this.resetTargetFilter();
    if (!this.zoomAnim) this.stopLoop();
  }

  private activateLoop(): void {
    if (this.loopActive) return;
    this.loopActive = true;
    this.lastFrameMs = 0;
    this.lastPan = { x: 0, y: 0 };
    if (!this.external && !this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    this.loopActive = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * The overlay frame (pixiOverlay drawFrame) calls externalFrame before it projects anything, then renders the map
   * synchronously when the camera moved: the follow pan, the MapLibre render and the Pixi sprites all use one timestamp and
   * one camera, whatever order requestAnimationFrame callbacks run in. Without a driver the controller runs its own rAF.
   */
  setExternalDriver(on: boolean): void {
    if (this.external === on) return;
    this.external = on;
    if (on) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (this.loopActive && !this.raf) {
      this.lastFrameMs = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  /** One camera update at the overlay's frame time. True when the camera moved (the caller renders the map). */
  externalFrame(timestamp: number): boolean {
    if (!this.external || !this.loopActive) return false;
    if (this.phase === "idle" && !this.zoomAnim) { this.loopActive = false; return false; }
    const moved = this.step(timestamp);
    if (this.phase === "idle" && !this.zoomAnim) this.loopActive = false;
    return moved;
  }

  // ---- combat zoom ----

  private groundZoomOf(map: PlayerFollowMap): number {
    return map.getZoom() + groundScaleZoomOffset(map.getCenter().lat);
  }

  private stopZoom(phase: ZoomPhase): void {
    this.zoomAnim = null;
    this.zoomPhase = phase;
    this.unwatchPinch();
  }

  /**
   * A drag on the map stops the follow here, straight from the pointer events on the map container: a mouse or pen moving more
   * than 4 px with a button down, or ONE finger that started on the map moving more than 6 px. MapLibre's own dragstart can be
   * lost while the follow moves the camera every frame (a programmatic move resets its handlers), and the overlay frame that
   * would otherwise notice the gesture pauses during a drag. The joystick, the attack button, the rails and every other HUD
   * control are outside the map container (and stop their own pointer events), so their fingers never reach these listeners.
   * A second finger on the map is a pinch and has its own handling, so it never counts as a drag.
   */
  private pointerTarget: HTMLElement | null = null;
  private readonly pointerStarts = new Map<number, Point>();
  /** More than one finger has been down on the map since the last time all were up: a pinch, never a drag. */
  private multiTouch = false;
  private lastPointerMs = 0;
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "touch" && this.pointerStarts.size > 0) this.multiTouch = true;
    this.pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.lastPointerMs = this.now();
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    const start = this.pointerStarts.get(event.pointerId);
    if (!start) return;
    this.lastPointerMs = this.now();
    if (event.buttons === 0 && event.pointerType !== "touch") { this.pointerStarts.delete(event.pointerId); return; }
    if (this.multiTouch) return;
    const limit = event.pointerType === "touch" ? 6 : 4;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < limit) return;
    // A real drag: the follow ends. (Until then the camera is only held still, see holdForPointer.)
    if (this.phase !== "idle") this.clearFollow();
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointerStarts.delete(event.pointerId);
    if (this.pointerStarts.size === 0) this.multiTouch = false;
  };
  /**
   * While a finger or button is down on the map the camera is not moved by the follow: a programmatic move resets MapLibre's
   * drag handler, which would kill the player's drag before it started. A tap or a wobble just resumes the follow afterwards.
   * Pointer events that stop arriving (finger lost off the window) release the hold after a moment.
   */
  private holdForPointer(): boolean {
    if (this.pointerStarts.size === 0) return false;
    if (this.now() - this.lastPointerMs > 1500) { this.pointerStarts.clear(); this.multiTouch = false; return false; }
    return true;
  }
  private watchMapPointer(): void {
    if (this.pointerTarget) return;
    const canvas = this.deps.getMap()?.getCanvas();
    const target = canvas?.parentElement ?? canvas ?? null;
    if (!target || typeof target.addEventListener !== "function") return;
    this.pointerTarget = target;
    target.addEventListener("pointerdown", this.onPointerDown, { capture: true, passive: true });
    target.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: true });
    target.addEventListener("pointerup", this.onPointerUp, { capture: true, passive: true });
    target.addEventListener("pointercancel", this.onPointerUp, { capture: true, passive: true });
  }
  private unwatchMapPointer(): void {
    const target = this.pointerTarget;
    if (!target) return;
    target.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    target.removeEventListener("pointermove", this.onPointerMove, { capture: true });
    target.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    target.removeEventListener("pointercancel", this.onPointerUp, { capture: true });
    this.pointerTarget = null;
    this.pointerStarts.clear();
    this.multiTouch = false;
  }

  /** While the zoom runs, a second finger or the wheel on the map is the player's zoom: it cancels ours at once. */
  private pinchTarget: HTMLElement | null = null;
  private readonly onTouchStart = (event: TouchEvent): void => { if (event.touches.length >= 2) this.stopZoom("pinched"); };
  private readonly onWheel = (): void => { this.stopZoom("pinched"); };
  private watchPinch(map: PlayerFollowMap): void {
    const target = map.getCanvas();
    if (typeof target.addEventListener !== "function") return;
    this.pinchTarget = target;
    target.addEventListener("touchstart", this.onTouchStart, { passive: true });
    target.addEventListener("wheel", this.onWheel, { passive: true });
  }
  private unwatchPinch(): void {
    this.pinchTarget?.removeEventListener("touchstart", this.onTouchStart);
    this.pinchTarget?.removeEventListener("wheel", this.onWheel);
    this.pinchTarget = null;
  }

  /** Samples the combat state; the only periodic work while nothing else runs. */
  private readonly poll = (): void => {
    const nowMs = this.now();
    if (!this.deps.combatZoomEnabled() || !this.deps.followEnabled()) {
      if (this.zoomPhase !== "off") this.stopZoom("off");
      return;
    }
    const map = this.deps.getMap();
    const player = this.deps.playerPosition();
    if (!map || !player) return;
    if (this.deps.inCombat()) this.lastCombatMs = nowMs;
    const fighting = this.lastCombatMs > 0 && nowMs - this.lastCombatMs <= PLAYER_CAMERA.combatZoom.exitDelayMs;
    if (!fighting) {
      // The fight is over: nothing zooms back out. A running zoom finishes; the next fight may start a new one.
      if (this.zoomPhase !== "off" && !this.zoomAnim) this.zoomPhase = "off";
      return;
    }
    if (this.zoomPhase !== "off" || this.deps.cameraBusy()) return;
    if (this.deps.userGesture() === "zoom") { this.zoomPhase = "pinched"; return; }

    // Target = the play zoom plus one step (capped). Reached once per play zoom: repeated fights never zoom further.
    const current = this.groundZoomOf(map);
    const play = this.deps.playZoom() ?? current;
    const canvas = map.getCanvas();
    const size = { width: canvas.clientWidth || canvas.width, height: canvas.clientHeight || canvas.height };
    const target = this.lastTargetGround !== null && Math.abs(play - this.lastTargetGround) < 0.02 ? this.lastTargetGround : combatZoomTarget(play, size);
    if (current >= target - PLAYER_CAMERA.combatZoom.minStepLevels) { this.zoomPhase = "held"; return; }
    this.lastWrittenZoom = map.getZoom();
    this.zoomAnim = { startMs: nowMs, from: map.getZoom(), to: target - groundScaleZoomOffset(map.getCenter().lat), targetGround: target };
    this.zoomPhase = "in";
    this.watchPinch(map);
    // The follow centres the player while the zoom runs, in the same frame loop.
    this.startFollow();
    this.activateLoop();
  };

  // ---- frame loop: follow pan and zoom in one camera update ----

  private readonly frame = (timestamp: number): void => {
    this.raf = 0;
    if (this.phase === "idle" && !this.zoomAnim) { this.loopActive = false; return; }
    this.step(timestamp);
    if (this.phase !== "idle" || this.zoomAnim) this.raf = requestAnimationFrame(this.frame);
    else this.loopActive = false;
  };

  private step(timestamp: number): boolean {
    const dtMs = this.lastFrameMs === 0 ? 16 : Math.min(PLAYER_CAMERA.maxFrameMs, timestamp - this.lastFrameMs);
    this.lastFrameMs = timestamp;
    if (!this.deps.followEnabled()) { this.stopZoom("off"); this.clearFollow(); return false; }
    if (this.paused) return false;
    const map = this.deps.getMap();
    const player = this.deps.playerPosition(timestamp);
    if (!map || !player) return false;
    const nowMs = this.now();
    const gesture = this.deps.userGesture();
    // The player's own pinch or wheel zoom wins at once: our zoom stops (no commit), theirs stays.
    // The map's own zoom flag is not enough (our per-frame jump also fires zoom events), so compare with what we wrote.
    if (this.zoomAnim && (gesture === "zoom" || Math.abs(map.getZoom() - this.lastWrittenZoom) > 1e-4)) this.stopZoom("pinched");
    if (gesture === "drag") this.clearFollow();
    if (this.deps.cameraBusy()) { if (this.zoomAnim) this.stopZoom("off"); return false; }
    if (gesture === "zoom") return false;
    if (this.holdForPointer()) { this.prevPlayerPx = null; this.resetTargetFilter(); return false; }

    const canvas = map.getCanvas();
    const size = { width: canvas.clientWidth || canvas.width, height: canvas.clientHeight || canvas.height };
    if (size.width <= 0 || size.height <= 0) return false;
    const centerPoint = map.project([map.getCenter().lng, map.getCenter().lat]);
    const center: Point = { x: centerPoint.x, y: centerPoint.y };
    const playerPoint = map.project([player.lon, player.lat]);
    const playerPx: Point = { x: playerPoint.x, y: playerPoint.y };

    // The camera follows a filtered target (corrections and uneven samples removed); the hard limit still uses the real point.
    let targetPx = playerPx;
    let axisPx: Point | null = null;
    // Only while movement input is held: after the stick is released the follow settles on the real point (no filter overshoot).
    if (this.phase === "following" && !this.zoomAnim && cameraFilterMode() === "on" && this.deps.moveInputHeld()) {
      const zoom = map.getZoom();
      const bearing = map.getBearing();
      const o = this.filterOrigin;
      if (!o || Math.abs(o.zoom - zoom) > 1e-6 || Math.abs(o.bearing - bearing) > 1e-6) {
        this.targetFilter.reset();
        this.filterOrigin = { lngLat: [player.lon, player.lat], zoom, bearing };
      }
      const originPx = map.project(this.filterOrigin!.lngLat);
      const f = this.targetFilter.update({ x: playerPx.x - originPx.x, y: playerPx.y - originPx.y }, dtMs);
      targetPx = { x: f.x + originPx.x, y: f.y + originPx.y };
      axisPx = this.targetFilter.axis();
    } else if (this.filterOrigin) {
      // Leaving the filtered target: the target point jumps to the real one, which must not be fed forward as a move.
      this.resetTargetFilter();
      this.prevPlayerPx = null;
    }

    let pan: Point = { x: 0, y: 0 };
    if (this.phase === "following") pan = this.followPan(targetPx, center, size, dtMs, nowMs, playerPx, axisPx);
    noteFollowFrame(this.phase === "following" && this.deps.moveInputHeld(), timestamp, pan.x, pan.y);

    const anim = this.zoomAnim;
    if (anim) {
      const t = (nowMs - anim.startMs) / PLAYER_CAMERA.combatZoom.easeMs;
      const zoom = t >= 1 ? anim.to : anim.from + (anim.to - anim.from) * smootherstep(t);
      // One camera update: zoom around the player and the follow pan, together.
      const next = zoomFramingCenter(player, { x: playerPx.x - center.x, y: playerPx.y - center.y }, pan, zoom, map.getBearing());
      map.jumpTo({ center: [next.lng, next.lat], zoom });
      this.lastWrittenZoom = map.getZoom();
      this.lastPan = pan;
      this.lastPanMs = Math.max(1, dtMs);
      if (t >= 1) {
        this.lastTargetGround = anim.targetGround;
        this.stopZoom("held");
        this.deps.commitPlayZoom(anim.targetGround);
      }
      return true;
    }
    if (Math.abs(pan.x) < 0.02 && Math.abs(pan.y) < 0.02) return false;
    if (cameraSnapMode() === "device") {
      const q = quantizePanToDevicePixels(pan, this.snapCarry, window.devicePixelRatio || 1);
      this.snapCarry = q.carry;
      pan = q.pan;
      if (pan.x === 0 && pan.y === 0) return false;
    } else {
      this.snapCarry = { x: 0, y: 0 };
    }
    map.panBy([pan.x, pan.y], { duration: 0 });
    return true;
  }

  private resetTargetFilter(): void {
    this.targetFilter.reset();
    this.filterOrigin = null;
  }

  /**
   * The follow's smoothed, feed-forward, hard-limited pan for this frame; ends the follow once settled. `playerPx` is the follow
   * target (filtered when the filter is on), `actualPlayerPx` the rendered player for the hard limit, `axisPx` the movement axis
   * on screen: while movement input is held the pan never goes backwards along it (a correction slows the camera, never reverses it).
   */
  private followPan(
    playerPx: Point,
    center: Point,
    size: Readonly<{ width: number; height: number }>,
    dtMs: number,
    nowMs: number,
    actualPlayerPx: Point = playerPx,
    axisPx: Point | null = null
  ): Point {
    const previousPlayerPx = this.prevPlayerPx;
    this.prevPlayerPx = playerPx;
    const error = Math.hypot(actualPlayerPx.x - center.x, actualPlayerPx.y - center.y);
    if (!this.deps.moveInputHeld() && error < PLAYER_CAMERA.doneEpsilonPx) {
      this.phase = "idle";
      return { x: 0, y: 0 };
    }
    const wanted = framingPan(playerPx, playerPx, center, safeRect(size));
    let ffOk = false;
    let moveX = 0;
    let moveY = 0;
    if (previousPlayerPx) {
      moveX = playerPx.x - previousPlayerPx.x + this.lastPan.x;
      moveY = playerPx.y - previousPlayerPx.y + this.lastPan.y;
      ffOk = Math.hypot(moveX, moveY) <= PLAYER_CAMERA.follow.feedForwardMaxPx;
      // A step bigger than a walk (dash, teleport): pull back gently for a while so the dash never jerks the camera.
      if (!ffOk) this.gentleUntilMs = nowMs + PLAYER_CAMERA.follow.gentleMs;
    }
    const gentle = nowMs < this.gentleUntilMs;
    const share = smoothingShare(dtMs, gentle ? PLAYER_CAMERA.settleMs : PLAYER_CAMERA.follow.settleMs);
    const blend = smoothingShare(dtMs, gentle ? PLAYER_CAMERA.panBlendMs : PLAYER_CAMERA.follow.blendMs);
    let desired: Point = { x: wanted.x * share, y: wanted.y * share };
    if (ffOk) {
      // Feed-forward: the camera moves with the player's own movement this frame (the rendered, smoothed position), and only
      // the leftover error is smoothed, so there is no trailing at walk speed.
      desired = { x: moveX + (wanted.x - moveX) * share, y: moveY + (wanted.y - moveY) * share };
    }
    // Blend in speed (px/ms), not in distance: after one long frame the last pan is a big distance, and blending distances
    // would overshoot on the next short frame (and at 120 Hz every frame is short). Speeds make the blend frame-rate independent.
    const frameMs = Math.max(1, dtMs);
    const lastVx = this.lastPan.x / this.lastPanMs;
    const lastVy = this.lastPan.y / this.lastPanMs;
    let pan: Point = {
      x: (lastVx + (desired.x / frameMs - lastVx) * blend) * frameMs,
      y: (lastVy + (desired.y / frameMs - lastVy) * blend) * frameMs
    };
    if (axisPx && this.deps.moveInputHeld()) {
      const along = pan.x * axisPx.x + pan.y * axisPx.y;
      if (along < 0) {
        pan = { x: pan.x - axisPx.x * along, y: pan.y - axisPx.y * along };
        if (along < -0.05) this.heldBackSteps += 1;
      }
    }
    // Never let a fast player (dash, sprint) leave the hard area; skipped when the player already is outside it
    // (a manual pan), where the soft pan alone brings them back without a snap.
    const hard = hardRect(size);
    const slack = PLAYER_CAMERA.hardSlackPx;
    const real = actualPlayerPx;
    const inside = real.x >= hard.minX - slack && real.x <= hard.maxX + slack && real.y >= hard.minY - slack && real.y <= hard.maxY + slack;
    if (inside) pan = limitPanToKeepPlayer(pan, real, hard);
    this.lastPan = pan;
    this.lastPanMs = frameMs;
    return pan;
  }
}
