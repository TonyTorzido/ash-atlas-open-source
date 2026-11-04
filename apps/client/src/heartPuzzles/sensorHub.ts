/**
 * Browser wiring for the puzzle sensor layer. All maths lives in sensorMath.ts.
 * Every input has a touch/mouse/keyboard fallback so PC and sensorless phones
 * can play (slightly harder: fallback tilt is capped and slewed).
 */
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

import {
  centsOff,
  clamp,
  compassHeading,
  detectPitchHz,
  heldTouchPoints,
  isFaceDownFromAccel,
  isFaceDownFromOrientation,
  normalizeTilt,
  rmsLevel,
  shakeMagnitude,
  slopeFromOrientation,
  smooth,
  snapGravity,
  type TouchPoint,
  type Vec2
} from "./sensorMath.js";

export const SENSOR_TUNING = {
  /** Phone slope (degrees) that counts as full tilt. */
  maxTiltDeg: 22,
  deadZoneDeg: 1.5,
  tiltSmoothing: 0.35,
  /** Fallback (pointer/keyboard) tilt is capped and slews at this rate per second: the "slightly harder" part. */
  fallbackMaxTilt: 0.8,
  fallbackSlewPerSecond: 2.6,
  /** Pointer-drag distance (px) that equals the fallback maximum. */
  dragFullTiltPx: 50,
  shakeSmoothing: 0.5
} as const;

export type SensorKind = "tilt" | "motion" | "mic" | "compass";

export type SensorSnapshot = Readonly<{
  tilt: Vec2;
  tiltSource: "sensor" | "fallback";
  shake: number;
  faceDown: boolean;
  micLevel: number;
  pitchHz: number | null;
  heading: number | null;
  gravity: Vec2;
  touches: readonly TouchPoint[];
  sensorsLive: Readonly<Record<SensorKind, boolean>>;
}>;

type PermissionAware = { requestPermission?: () => Promise<"granted" | "denied"> };

const askMotionPermission = async (ctor: unknown): Promise<boolean> => {
  const fn = (ctor as PermissionAware | undefined)?.requestPermission;
  if (typeof fn !== "function") return true;
  try {
    return (await fn.call(ctor)) === "granted";
  } catch {
    return false;
  }
};

export class SensorHub {
  private sensorTilt: Vec2 = { x: 0, y: 0 };
  private rawSlope: Vec2 | null = null;
  private neutral: Vec2 = { x: 0, y: 0 };
  private lastOrientationAt = 0;
  private fallbackTarget: Vec2 = { x: 0, y: 0 };
  private fallbackTilt: Vec2 = { x: 0, y: 0 };
  private keys = new Set<string>();
  private shake = 0;
  private faceDown = false;
  private micLevelValue = 0;
  private pitch: number | null = null;
  private heading: number | null = null;
  private gravity: Vec2 = { x: 0, y: 1 };
  private touchPoints = new Map<number, TouchPoint>();
  private live: Record<SensorKind, boolean> = { tilt: false, motion: false, mic: false, compass: false };
  private cleanup: Array<() => void> = [];
  private audio: { ctx: AudioContext; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private lastReadAt = 0;

  /** Must be called from a user gesture (iOS permission prompts require one). */
  async start(kinds: readonly SensorKind[]): Promise<void> {
    this.attachKeyboard();
    for (const kind of kinds) {
      if (kind === "tilt") await this.startTilt();
      else if (kind === "motion") await this.startMotion();
      else if (kind === "mic") await this.startMic();
      else if (kind === "compass") await this.startCompass();
    }
  }

  private async startTilt(): Promise<void> {
    if (typeof DeviceOrientationEvent === "undefined") return;
    if (!(await askMotionPermission(DeviceOrientationEvent))) return;
    const handler = (e: DeviceOrientationEvent): void => {
      if (e.beta === null || e.gamma === null) return;
      const screenAngle = typeof screen !== "undefined" && screen.orientation ? screen.orientation.angle : 0;
      this.rawSlope = slopeFromOrientation(e.beta, e.gamma, screenAngle);
      this.lastOrientationAt = performance.now();
      this.live.tilt = true;
      const slope = { x: this.rawSlope.x - this.neutral.x, y: this.rawSlope.y - this.neutral.y };
      const target = normalizeTilt(slope, SENSOR_TUNING.maxTiltDeg, SENSOR_TUNING.deadZoneDeg);
      this.sensorTilt = {
        x: smooth(this.sensorTilt.x, target.x, SENSOR_TUNING.tiltSmoothing),
        y: smooth(this.sensorTilt.y, target.y, SENSOR_TUNING.tiltSmoothing)
      };
      if (isFaceDownFromOrientation(e.beta, e.gamma)) this.faceDown = true;
    };
    window.addEventListener("deviceorientation", handler);
    this.cleanup.push(() => window.removeEventListener("deviceorientation", handler));
  }

  /** Treat the current phone angle as level. */
  recalibrate(): void {
    if (this.rawSlope) this.neutral = this.rawSlope;
  }

  private async startMotion(): Promise<void> {
    if (typeof DeviceMotionEvent === "undefined") return;
    if (!(await askMotionPermission(DeviceMotionEvent))) return;
    const handler = (e: DeviceMotionEvent): void => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return;
      this.live.motion = true;
      this.shake = smooth(this.shake, shakeMagnitude(a.x, a.y, a.z), SENSOR_TUNING.shakeSmoothing);
      this.faceDown = isFaceDownFromAccel(a.z);
      this.gravity = snapGravity(a.x, a.y, this.gravity);
    };
    window.addEventListener("devicemotion", handler);
    this.cleanup.push(() => window.removeEventListener("devicemotion", handler));
  }

  private async startCompass(): Promise<void> {
    if (typeof DeviceOrientationEvent === "undefined") return;
    if (!(await askMotionPermission(DeviceOrientationEvent))) return;
    const handler = (e: Event): void => {
      const o = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      const heading = compassHeading(o.alpha, o.webkitCompassHeading);
      if (heading !== null) { this.heading = heading; this.live.compass = true; }
    };
    window.addEventListener("deviceorientationabsolute", handler);
    window.addEventListener("deviceorientation", handler);
    this.cleanup.push(() => {
      window.removeEventListener("deviceorientationabsolute", handler);
      window.removeEventListener("deviceorientation", handler);
    });
  }

  private async startMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      this.audio = { ctx, analyser, buf: new Float32Array(analyser.fftSize) };
      this.live.mic = true;
      this.cleanup.push(() => {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        this.audio = null;
        this.live.mic = false;
      });
    } catch {
      this.live.mic = false;
    }
  }

  private attachKeyboard(): void {
    const down = (e: KeyboardEvent): void => { this.keys.add(e.key.toLowerCase()); };
    const up = (e: KeyboardEvent): void => { this.keys.delete(e.key.toLowerCase()); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    this.cleanup.push(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    });
  }

  /** Pointer/mouse drag fallback: pass the drag offset in pixels, or null on release. */
  setDragOffset(offsetPx: Vec2 | null): void {
    if (!offsetPx) { this.fallbackTarget = { x: 0, y: 0 }; return; }
    this.fallbackTarget = {
      x: clamp(offsetPx.x / SENSOR_TUNING.dragFullTiltPx, -1, 1),
      y: clamp(offsetPx.y / SENSOR_TUNING.dragFullTiltPx, -1, 1)
    };
  }

  /** Track multi-touch points on an element (for multi-finger plates). Returns an unsubscribe. */
  trackTouches(el: HTMLElement): () => void {
    const update = (e: TouchEvent): void => {
      const rect = el.getBoundingClientRect();
      this.touchPoints.clear();
      for (const p of heldTouchPoints(Array.from(e.touches).map((t) => (
        { id: t.identifier, x: t.clientX - rect.left, y: t.clientY - rect.top }
      )))) this.touchPoints.set(p.id, p);
    };
    const types = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const t of types) el.addEventListener(t, update);
    return () => { for (const t of types) el.removeEventListener(t, update); };
  }

  /** Call once per frame. Advances fallback slewing and mic analysis, and returns the merged input. */
  read(nowMs: number = performance.now()): SensorSnapshot {
    const dt = this.lastReadAt === 0 ? 0 : Math.min(0.1, (nowMs - this.lastReadAt) / 1000);
    this.lastReadAt = nowMs;
    const held = (...names: string[]): number => (names.some((n) => this.keys.has(n)) ? 1 : 0);
    const keyX = held("arrowright", "d") - held("arrowleft", "a");
    const keyY = held("arrowdown", "s") - held("arrowup", "w");
    const cap = SENSOR_TUNING.fallbackMaxTilt;
    const want = {
      x: clamp(this.fallbackTarget.x + keyX, -1, 1) * cap,
      y: clamp(this.fallbackTarget.y + keyY, -1, 1) * cap
    };
    const slew = SENSOR_TUNING.fallbackSlewPerSecond * dt;
    this.fallbackTilt = {
      x: this.fallbackTilt.x + clamp(want.x - this.fallbackTilt.x, -slew, slew),
      y: this.fallbackTilt.y + clamp(want.y - this.fallbackTilt.y, -slew, slew)
    };
    const sensorFresh = this.live.tilt && nowMs - this.lastOrientationAt < 1000;
    const fallbackActive = Math.hypot(want.x, want.y) > 0.02 || Math.hypot(this.fallbackTilt.x, this.fallbackTilt.y) > 0.02;
    const useFallback = !sensorFresh || fallbackActive;

    if (this.audio) {
      this.audio.analyser.getFloatTimeDomainData(this.audio.buf);
      this.micLevelValue = smooth(this.micLevelValue, rmsLevel(this.audio.buf), 0.5);
      this.pitch = detectPitchHz(this.audio.buf, this.audio.ctx.sampleRate);
    }
    // Shake decays between motion events.
    this.shake *= Math.pow(0.02, dt);

    return {
      tilt: useFallback ? this.fallbackTilt : this.sensorTilt,
      tiltSource: useFallback ? "fallback" : "sensor",
      shake: this.shake,
      faceDown: this.faceDown,
      micLevel: this.micLevelValue,
      pitchHz: this.pitch,
      heading: this.heading,
      gravity: this.gravity,
      touches: [...this.touchPoints.values()],
      sensorsLive: { ...this.live }
    };
  }

  /** Vibrate: Capacitor Haptics on native, navigator.vibrate on the web, a no-op elsewhere. */
  haptic(pattern: number | readonly number[]): void {
    try {
      if (Capacitor.isNativePlatform()) {
        const longest = typeof pattern === "number" ? pattern : Math.max(...pattern);
        void Haptics.impact({ style: longest > 40 ? ImpactStyle.Medium : ImpactStyle.Light }).catch(() => undefined);
      } else if (typeof navigator.vibrate === "function") {
        navigator.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
      }
    } catch {
      // Haptics are best effort.
    }
  }

  /** How far (cents) the live hum is from a target pitch, or null when no pitch. */
  centsFrom(targetHz: number): number | null {
    return this.pitch === null ? null : centsOff(this.pitch, targetHz);
  }

  dispose(): void {
    for (const fn of this.cleanup.splice(0)) fn();
  }
}
