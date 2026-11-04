import type { LocationFixReason } from "@ash-atlas/shared";

import { isNativeApp, subscribeNativeAppStateChange } from "../native/nativeApp.js";
import { setActionFixHandler, type ActionFixReason } from "./actionFixHook.js";
import {
  getPassiveDeviceLocation,
  hasPassiveLocationPermission,
  PASSIVE_LOCATION_MAX_AGE_MS,
  type DeviceLocation,
  type PassiveLocationOptions
} from "./deviceGeolocation.js";

// Location trust (docs/architecture/ACCOUNT_TRUST_AND_ANTISPOOF_PLAN.md):
// foreground-only passive LOCATION_FIX messages at random intervals (uniform
// between a min and max, re-rolled after every fix, so the next check cannot be
// predicted). Land actions never wait on location: unsettled native accounts
// only fire a deduped action fix beside them (requestActionFix, plan §2.8).
// Every read goes through getPassiveDeviceLocation(), which never prompts.

/** First periodic fix after the connection is online. */
export const INITIAL_PASSIVE_FIX_DELAY_MS = 10_000;
export const PERIODIC_FIX_TIMEOUT_MS = 10_000;
export const MIN_PASSIVE_FIX_SECONDS = 60;
export const DEFAULT_PASSIVE_FIX_MIN_SECONDS = 180;
export const DEFAULT_PASSIVE_FIX_MAX_SECONDS = 420;
/** Action fixes: at most one per this window, whatever the reason. */
export const ACTION_FIX_MIN_INTERVAL_MS = 60_000;
export const ACTION_FIX_TIMEOUT_MS = 10_000;

export type { ActionFixReason } from "./actionFixHook.js";

export type LocationFixSink = (location: DeviceLocation, reason: LocationFixReason) => boolean;

type TimerHandle = ReturnType<typeof setTimeout>;

export type LocationFixSchedulerDeps = Readonly<{
  readLocation(options: PassiveLocationOptions): Promise<DeviceLocation | null>;
  hasPermission(): Promise<boolean>;
  isForeground(): boolean;
  subscribeForeground(handler: (foreground: boolean) => void): () => void;
  now(): number;
  /** Uniform in [0, 1); Math.random in production, injected in tests. */
  random(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** Action fixes are native-app only; absent means web. */
  isNative?(): boolean;
}>;

export class LocationFixScheduler {
  private sink: LocationFixSink | null = null;
  private minMs = DEFAULT_PASSIVE_FIX_MIN_SECONDS * 1000;
  private maxMs = DEFAULT_PASSIVE_FIX_MAX_SECONDS * 1000;
  private foreground = true;
  private permissionGranted = false;
  private lastFixAt = Number.NEGATIVE_INFINITY;
  private periodicTimer: TimerHandle | null = null;
  private periodicInFlight = false;
  private unsubscribeForeground: (() => void) | null = null;
  private actionFixesEnabled = false;
  private lastActionFixAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: LocationFixSchedulerDeps) {}

  /** Mirrors the session's `trustActionFixes` (unsettled native accounts only). */
  setActionFixesEnabled(enabled: boolean): void {
    this.actionFixesEnabled = enabled;
  }

  /**
   * Fire-and-forget fix beside a land action. Never awaited, never prompts;
   * native, foreground and started only; at most one per minute.
   */
  requestActionFix(reason: ActionFixReason): void {
    if (!this.actionFixesEnabled || !this.sink || !this.foreground || this.deps.isNative?.() !== true) return;
    const now = this.deps.now();
    if (now - this.lastActionFixAt < ACTION_FIX_MIN_INTERVAL_MS) return;
    this.lastActionFixAt = now;
    void this.acquire(reason, ACTION_FIX_TIMEOUT_MS);
  }

  /** Starts periodic fixes for an online, enabled session. Idempotent per session. */
  start(sink: LocationFixSink, minSeconds?: number, maxSeconds?: number): void {
    this.stop();
    this.sink = sink;
    const min = Math.max(
      MIN_PASSIVE_FIX_SECONDS,
      Number.isFinite(minSeconds) ? minSeconds! : DEFAULT_PASSIVE_FIX_MIN_SECONDS
    );
    const max = Math.max(
      min,
      Number.isFinite(maxSeconds) ? maxSeconds! : DEFAULT_PASSIVE_FIX_MAX_SECONDS
    );
    this.minMs = min * 1000;
    this.maxMs = max * 1000;
    this.foreground = this.deps.isForeground();
    this.unsubscribeForeground = this.deps.subscribeForeground((foreground) => this.setForeground(foreground));
    this.refreshPermission();
    const sinceLastMs = this.deps.now() - this.lastFixAt;
    this.schedulePeriodic(Math.max(INITIAL_PASSIVE_FIX_DELAY_MS, this.rollDelayMs() - sinceLastMs));
  }

  stop(): void {
    this.sink = null;
    this.clearPeriodic();
    this.unsubscribeForeground?.();
    this.unsubscribeForeground = null;
  }

  /** Pauses while hidden/backgrounded; on return, fixes at once if the last fix is older than the min, then resumes random scheduling. */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      this.clearPeriodic();
      return;
    }
    if (!this.sink) return;
    this.refreshPermission();
    const sinceLastMs = this.deps.now() - this.lastFixAt;
    this.schedulePeriodic(sinceLastMs >= this.minMs ? 0 : Math.max(0, this.rollDelayMs() - sinceLastMs));
  }

  /** Uniform delay in [min, max] milliseconds. */
  private rollDelayMs(): number {
    return Math.round(this.minMs + this.deps.random() * (this.maxMs - this.minMs));
  }

  private refreshPermission(): void {
    void this.deps.hasPermission()
      .then((granted) => {
        this.permissionGranted = granted;
      })
      .catch(() => {
        this.permissionGranted = false;
      });
  }

  private schedulePeriodic(delayMs: number): void {
    this.clearPeriodic();
    if (!this.sink || !this.foreground) return;
    this.periodicTimer = this.deps.setTimer(() => {
      this.periodicTimer = null;
      void this.periodicTick();
    }, delayMs);
  }

  private clearPeriodic(): void {
    if (this.periodicTimer === null) return;
    this.deps.clearTimer(this.periodicTimer);
    this.periodicTimer = null;
  }

  private async periodicTick(): Promise<void> {
    if (!this.sink || !this.foreground || this.periodicInFlight) return;
    this.periodicInFlight = true;
    try {
      await this.acquire("periodic", PERIODIC_FIX_TIMEOUT_MS);
    } finally {
      this.periodicInFlight = false;
    }
    this.schedulePeriodic(this.rollDelayMs());
  }

  // Never throws; skips silently when not permitted, hidden, stopped, or on error.
  private async acquire(reason: LocationFixReason, timeoutMs: number): Promise<void> {
    try {
      const location = await this.deps.readLocation({ maximumAgeMs: PASSIVE_LOCATION_MAX_AGE_MS, timeoutMs });
      this.permissionGranted = location !== null || await this.deps.hasPermission();
      if (!location || !this.sink || !this.foreground) return;
      if (this.sink(location, reason)) this.lastFixAt = this.deps.now();
    } catch {
      // Best effort only.
    }
  }
}

function subscribeForeground(handler: (foreground: boolean) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onVisibility = (): void => handler(document.visibilityState !== "hidden");
  document.addEventListener("visibilitychange", onVisibility);
  const unsubscribeNative = subscribeNativeAppStateChange(handler);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    unsubscribeNative();
  };
}

/** The app-wide scheduler: App.tsx starts/stops it. */
export const locationFixes = new LocationFixScheduler({
  readLocation: getPassiveDeviceLocation,
  hasPermission: hasPassiveLocationPermission,
  isForeground: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  subscribeForeground,
  now: () => Date.now(),
  random: () => Math.random(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
  isNative: isNativeApp
});

setActionFixHandler((reason) => locationFixes.requestActionFix(reason));
