import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { useSyncExternalStore } from "react";

/**
 * Combat cues: one named event per beat (swing, hit, kill, hurt, dash, ready, dashReady) that fans out to
 * - haptics (native only, behind a setting, a no-op on web and when the native plugin is missing), and
 * - a sound hook (no sound ships yet: `setCombatSfxHandler` is the drop-in point, null by default).
 * Docs: docs/plans/combat-polish.md.
 */

export type CombatCueName = "swing" | "hit" | "kill" | "hurt" | "dash" | "ready" | "dashReady";

export type CombatCueDetail = Readonly<{
  /** A bigger variant (a heavy hit taken, a finisher). */
  heavy?: boolean;
}>;

export type CombatSfxHandler = (name: CombatCueName, detail: CombatCueDetail) => void;

export type CombatHapticStyle = "light" | "medium" | "heavy";

/** Which haptic a cue plays (null = none). */
export function hapticStyleForCue(name: CombatCueName, detail: CombatCueDetail = {}): CombatHapticStyle | null {
  switch (name) {
    case "hit": return detail.heavy ? "medium" : "light";
    case "kill": return "medium";
    case "hurt": return detail.heavy ? "heavy" : "medium";
    case "dash": return "light";
    default: return null;
  }
}

/** A weaker haptic right after a stronger one is dropped (a kill lands the same tick as its hit). */
export const HAPTIC_SUPPRESS_MS = 70;
const HAPTIC_RANK: Readonly<Record<CombatHapticStyle, number>> = { light: 1, medium: 2, heavy: 3 };

/** Counters for tests and the perf probe (window.__ASH_ATLAS_COMBAT_CUES__). */
export const combatCueStats = {
  /** Cues fired, by name. */
  counts: {} as Record<string, number>,
  /** The last 32 cues: name and performance.now() at the call. */
  log: [] as Array<{ name: CombatCueName; atMs: number }>,
  /** Haptic calls that would reach the native plugin (0 on web). */
  hapticCalls: 0,
  /** Haptic requests skipped because the setting is off, the platform is web or the plugin is missing. */
  hapticSkipped: 0
};

if (typeof window !== "undefined") {
  (window as unknown as { __ASH_ATLAS_COMBAT_CUES__?: typeof combatCueStats }).__ASH_ATLAS_COMBAT_CUES__ = combatCueStats;
}

let sfxHandler: CombatSfxHandler | null = null;

/** Installs the sound player (called once audio assets exist). Null removes it. */
export function setCombatSfxHandler(handler: CombatSfxHandler | null): void {
  sfxHandler = handler;
}

// Haptics setting: per device, default on.
const hapticsKey = "ashAtlas.combatHaptics.v1";
const hapticsListeners = new Set<() => void>();

export function readStoredCombatHaptics(): boolean {
  try {
    return window.localStorage.getItem(hapticsKey) !== "off";
  } catch {
    return true;
  }
}

let hapticsEnabled = typeof window === "undefined" ? true : readStoredCombatHaptics();

export function combatHapticsEnabled(): boolean {
  return hapticsEnabled;
}

export function setCombatHapticsEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(hapticsKey, enabled ? "on" : "off"); } catch { /* Still applies for this session. */ }
  hapticsEnabled = enabled;
  for (const listener of hapticsListeners) listener();
}

function subscribeHaptics(listener: () => void): () => void {
  hapticsListeners.add(listener);
  return () => { hapticsListeners.delete(listener); };
}

export function useCombatHapticsSetting(): readonly [boolean, (enabled: boolean) => void] {
  const value = useSyncExternalStore(subscribeHaptics, () => hapticsEnabled, () => true);
  return [value, setCombatHapticsEnabled] as const;
}

/** True only inside a native shell whose binary registered the Haptics plugin (older binaries lack it). */
export function nativeHapticsAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Haptics");
  } catch {
    return false;
  }
}

const IMPACT_STYLE: Readonly<Record<CombatHapticStyle, ImpactStyle>> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy
};

let lastHaptic: { atMs: number; rank: number } = { atMs: Number.NEGATIVE_INFINITY, rank: 0 };

function playHaptic(style: CombatHapticStyle, nowMs: number): void {
  if (!hapticsEnabled || !nativeHapticsAvailable()) {
    combatCueStats.hapticSkipped += 1;
    return;
  }
  const rank = HAPTIC_RANK[style];
  if (nowMs - lastHaptic.atMs < HAPTIC_SUPPRESS_MS && rank < lastHaptic.rank) return;
  lastHaptic = { atMs: nowMs, rank };
  combatCueStats.hapticCalls += 1;
  try {
    void Haptics.impact({ style: IMPACT_STYLE[style] }).catch(() => undefined);
  } catch {
    // Haptics are a nicety; never let them break combat.
  }
}

/** Loot ticks are throttled to one per this many ms. */
export const LOOT_HAPTIC_THROTTLE_MS = 80;
let lastLootHapticMs = Number.NEGATIVE_INFINITY;

/** A light tick when loot reaches the player: native impact where available, else a 10ms vibrate. Never throws. */
export function playLootHaptic(nowMs: number = typeof performance === "undefined" ? 0 : performance.now()): void {
  if (!hapticsEnabled || nowMs - lastLootHapticMs < LOOT_HAPTIC_THROTTLE_MS) return;
  lastLootHapticMs = nowMs;
  try {
    if (nativeHapticsAvailable()) void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    else if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(10);
  } catch {
    // A nicety only.
  }
}

/** Fires one combat cue now: the sound hook and, where the platform allows, the haptic. Never throws. */
export function playCombatCue(name: CombatCueName, detail: CombatCueDetail = {}): void {
  const nowMs = typeof performance === "undefined" ? 0 : performance.now();
  combatCueStats.counts[name] = (combatCueStats.counts[name] ?? 0) + 1;
  combatCueStats.log.push({ name, atMs: nowMs });
  if (combatCueStats.log.length > 32) combatCueStats.log.shift();
  if (sfxHandler) {
    try { sfxHandler(name, detail); } catch { /* A broken sound hook never breaks combat. */ }
  }
  const style = hapticStyleForCue(name, detail);
  if (style) playHaptic(style, nowMs);
}

/** Fires the cue after `delayMs` (0 = now), for cues tied to a future contact frame. */
export function playCombatCueAfter(delayMs: number, name: CombatCueName, detail: CombatCueDetail = {}): void {
  if (!(delayMs > 1) || typeof window === "undefined") {
    playCombatCue(name, detail);
    return;
  }
  window.setTimeout(() => playCombatCue(name, detail), delayMs);
}
