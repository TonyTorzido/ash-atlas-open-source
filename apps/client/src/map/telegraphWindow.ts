import type { BossCastSnapshot } from "@ash-atlas/shared";

/**
 * Local-clock window for a server telegraph.
 *
 * Everyday-mob telegraphs carry `remainingMs` (time left when the server serialized them) and
 * `durationMs`. The first time this client sees a cast it anchors
 * `localEnd = now + remainingMs - oneWayMs` and keeps that anchor for the cast's whole life, so clock
 * skew and delta batching never move it and later deltas never re-anchor it. `oneWayMs` is half the
 * measured round trip (PING/PONG), capped: the frame spent that long on the wire, so without it the
 * decal ended that much after the server had already resolved the strike (telegraph time: +165 ms
 * median on the simulated phone network). A cast seen late shows part-filled with its true time
 * left; the fill is never restarted. Boss casts without those fields fall back to the server
 * `startTime`/`resolveTime`.
 */
export type TelegraphWindow = Readonly<{ localStart: number; localEnd: number }>;

const anchors = new Map<string, TelegraphWindow>();
const KEEP_AFTER_END_MS = 2_000;
/** Latency compensation never exceeds this (a stalled ping must not swallow a warning). */
export const TELEGRAPH_MAX_ONE_WAY_MS = 150;
/** Smoothing of the round-trip estimate (share of each new PONG sample). */
const RTT_SMOOTHING = 0.25;
let smoothedRttMs: number | null = null;

/** Feeds a measured round trip (ms) into the telegraph latency compensation. */
export function noteTelegraphRtt(rttMs: number): void {
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  smoothedRttMs = smoothedRttMs === null ? rttMs : smoothedRttMs + (rttMs - smoothedRttMs) * RTT_SMOOTHING;
}

/** One-way latency the anchor subtracts: half the smoothed round trip, 0 before the first PONG, capped. */
export function telegraphOneWayMs(): number {
  return smoothedRttMs === null ? 0 : Math.min(TELEGRAPH_MAX_ONE_WAY_MS, smoothedRttMs / 2);
}

export function telegraphWindow(
  cast: Pick<BossCastSnapshot, "castInstanceId" | "startTime" | "resolveTime" | "remainingMs" | "durationMs">,
  now: number
): TelegraphWindow {
  if (cast.remainingMs === undefined) return { localStart: cast.startTime, localEnd: cast.resolveTime };
  const known = anchors.get(cast.castInstanceId);
  if (known) return known;
  if (anchors.size > 128) {
    for (const [id, window] of anchors) if (window.localEnd < now - KEEP_AFTER_END_MS) anchors.delete(id);
  }
  const localEnd = now + Math.max(0, cast.remainingMs - telegraphOneWayMs());
  const window = { localStart: localEnd - (cast.durationMs ?? Math.max(0, cast.resolveTime - cast.startTime)), localEnd };
  anchors.set(cast.castInstanceId, window);
  return window;
}

/** True while the warning should still be drawn on the local clock. */
export function telegraphActive(cast: Parameters<typeof telegraphWindow>[0], now: number): boolean {
  const window = telegraphWindow(cast, now);
  return window.localEnd > now && window.localStart <= now;
}

/** Mob id -> clock ms until which its telegraphs and lifted shots stay hidden (it died or was removed). */
const goneMobs = new Map<string, number>();
export const GONE_MOB_TELEGRAPH_TTL_MS = 3_000;

/**
 * A defeated or removed mob owns no warning: from this call every cast it made (decals, aim lanes, charge lanes,
 * signature decals, lifted projectiles) is dropped, wherever the snapshot carries it (a player can carry a gone
 * mob's cast). Cast ids are `<mobId>:<ability>:<tick>`.
 */
export function noteMobTelegraphsGone(mobId: string, nowMs: number): void {
  goneMobs.set(mobId, nowMs + GONE_MOB_TELEGRAPH_TTL_MS);
}

/** True when the cast belongs to a mob reported gone and must not be drawn. */
export function isCastOfGoneMob(castInstanceId: string, nowMs: number): boolean {
  if (goneMobs.size === 0) return false;
  for (const [mobId, until] of goneMobs) {
    if (until < nowMs) goneMobs.delete(mobId);
    else if (castInstanceId.startsWith(mobId + ":")) return true;
  }
  return false;
}

export function resetTelegraphAnchors(): void {
  goneMobs.clear();
  anchors.clear();
  smoothedRttMs = null;
}
