export type FlagTravelVisibilityPresence = Readonly<{
  inOrigin: boolean;
  inDestination: boolean;
  firstSeenAtMs?: number;
  relocating?: boolean;
}>;

export type FlagTravelVisibilityDecision = Readonly<{
  alpha: number;
  useDestination: boolean;
  interactive: boolean;
}>;

export type FlagTravelVisibilityTiming = Readonly<{
  startedAtMs: number;
  durationMs: number;
}>;

export function flagTravelVisibilityDecision(
  timing: FlagTravelVisibilityTiming | null,
  presence: FlagTravelVisibilityPresence,
  nowMs: number
): FlagTravelVisibilityDecision {
  if (timing === null) {
    return decision(presence.inOrigin ? 1 : 0, false);
  }
  if (timing.durationMs <= 0) {
    return decision(presence.inDestination ? 1 : 0, presence.inDestination);
  }
  const endAtMs = timing.startedAtMs + timing.durationMs;
  const midpointAtMs = timing.startedAtMs + timing.durationMs / 2;
  if (presence.relocating && presence.inOrigin && presence.inDestination) {
    if (nowMs < midpointAtMs) {
      return decision(
        1 - smoothstep((nowMs - timing.startedAtMs) / (timing.durationMs / 2)),
        false
      );
    }
    return decision(
      smoothstep((nowMs - midpointAtMs) / (timing.durationMs / 2)),
      true
    );
  }
  if (presence.inOrigin && presence.inDestination) {
    return decision(1, true);
  }
  if (presence.inOrigin) {
    return decision(
      1 - smoothstep((nowMs - timing.startedAtMs) / timing.durationMs),
      false
    );
  }
  if (presence.inDestination) {
    const firstSeenAtMs = Math.max(
      midpointAtMs,
      presence.firstSeenAtMs ?? timing.startedAtMs
    );
    const fadeEndAtMs = Math.max(endAtMs, firstSeenAtMs + timing.durationMs / 2);
    return decision(
      smoothstep((nowMs - firstSeenAtMs) / (fadeEndAtMs - firstSeenAtMs)),
      true
    );
  }
  return decision(0, false);
}

export function flagTravelVisibilityCleanupAt(
  timing: FlagTravelVisibilityTiming
): number {
  return timing.startedAtMs + timing.durationMs * 2;
}

function decision(alpha: number, useDestination: boolean): FlagTravelVisibilityDecision {
  const clamped = Math.max(0, Math.min(1, alpha));
  return {
    alpha: clamped,
    useDestination,
    interactive: clamped >= 0.08
  };
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
