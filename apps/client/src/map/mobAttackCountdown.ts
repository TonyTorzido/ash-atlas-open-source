import { Graphics } from "pixi.js";
import type { CombatEntitySnapshot } from "@ash-atlas/shared";

export type MobAttackCountdownState = Readonly<{
  phase: "acquiring" | "disengaging";
  /** Red only when the mob's target is the local player. */
  tone: "amber" | "red";
  /** Whole seconds remaining, rounded up. */
  seconds: number;
  /** Remaining share of the countdown, quantized; drains toward 0. */
  fraction: number;
  /** Final second of an acquisition: gentle scale pulse. */
  pulse: boolean;
}>;

const SWEEP_STEPS = 48;
export const ATTACK_BADGE_RADIUS = 11;
const SWEEP_RADIUS = 8;
const COLORS = { fill: 0x1c1917, rim: 0xd4b26a, amber: 0xf59e0b, red: 0xef4444 } as const;

/**
 * The attack countdown shows only while a mob is counting down: acquiring (about
 * to attack) or disengaging (bear grace). Idle mobs and observers show nothing.
 */
export function mobAttackCountdownState(
  entity: Pick<CombatEntitySnapshot, "aiPresentation" | "targetEntityId">,
  localPlayerId: string | null,
  nowMs: number
): MobAttackCountdownState | null {
  const presentation = entity.aiPresentation ?? null;
  if (
    !presentation ||
    presentation.deadlineAt === null ||
    (presentation.phase !== "acquiring" && presentation.phase !== "disengaging")
  ) return null;
  const remaining = Math.max(0, presentation.deadlineAt - nowMs);
  const duration = Math.max(presentation.durationMs ?? remaining, remaining, 1);
  const targetId = presentation.targetEntityId ?? entity.targetEntityId;
  return {
    phase: presentation.phase,
    tone: localPlayerId !== null && targetId === localPlayerId ? "red" : "amber",
    seconds: Math.ceil(remaining / 1_000),
    fraction: Math.round(Math.min(1, remaining / duration) * SWEEP_STEPS) / SWEEP_STEPS,
    pulse: presentation.phase === "acquiring" && remaining <= 1_000
  };
}

export function mobAttackCountdownKey(state: MobAttackCountdownState | null): string {
  return state ? `${state.phase}|${state.tone}|${state.seconds}|${state.fraction}` : "";
}

export function drawMobAttackCountdown(graphics: Graphics, state: MobAttackCountdownState): void {
  const sweepColor = state.tone === "red" ? COLORS.red : COLORS.amber;
  // Disengage keeps the same token but a dimmer sweep so it never reads as an imminent attack.
  const sweepAlpha = state.phase === "disengaging" ? 0.6 : 1;
  graphics.clear();
  graphics
    .circle(0, 0, ATTACK_BADGE_RADIUS)
    .fill({ color: COLORS.fill, alpha: 0.9 })
    .stroke({ color: COLORS.rim, width: 1.5, alpha: 1 });
  if (state.fraction > 0) {
    if (state.fraction >= 1) {
      graphics.circle(0, 0, SWEEP_RADIUS).stroke({ color: sweepColor, width: 3, alpha: sweepAlpha });
    } else {
      const end = Math.PI * 1.5;
      graphics
        .arc(0, 0, SWEEP_RADIUS, end - state.fraction * Math.PI * 2, end)
        .stroke({ color: sweepColor, width: 3, alpha: sweepAlpha });
    }
  }
}

/** 1.0 to 1.12 scale pulse in the last second of an acquisition. */
export function mobAttackCountdownScale(
  state: MobAttackCountdownState | null,
  nowMs: number,
  reducedMotion: boolean
): number {
  if (!state?.pulse || reducedMotion) return 1;
  return 1.06 + 0.06 * Math.sin((nowMs / 250) * Math.PI * 2);
}
