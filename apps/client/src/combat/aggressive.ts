import { AGGRESSIVE_FLAG_TRAVEL_LOCK_MS, type SkillSystemV3Snapshot } from "@ash-atlas/shared";

export function aggressiveRemainingMs(deadlineMs: number | null | undefined, nowMs: number): number {
  return Math.max(0, (deadlineMs ?? 0) - nowMs);
}

/**
 * Return the server-configured aggression window for the current authoritative
 * V3 build. Legacy players use the shared base duration; active V3 reductions
 * mirror the server's Calm Mind and Assassin rules without creating a local
 * deadline or expiry decision.
 */
export function aggressiveDurationMs(
  snapshot: Pick<SkillSystemV3Snapshot, "generalSkills" | "specializations" | "activeSpecializationId"> | null | undefined
): number {
  const calmMindRank = snapshot?.generalSkills.find(({ skillId }) => skillId === "calm_mind")?.rank ?? 0;
  const calmMindReduction = calmMindRank >= 3 ? 0.30 : calmMindRank >= 2 ? 0.20 : calmMindRank >= 1 ? 0.10 : 0;
  const assassinRank = snapshot?.activeSpecializationId === "assassin"
    ? snapshot.specializations.find(({ specializationId }) => specializationId === "assassin")?.rank ?? 0
    : 0;
  const assassinReduction = assassinRank >= 5 ? 0.15 : assassinRank >= 4 ? 0.10 : assassinRank >= 2 ? 0.05 : 0;
  return Math.round(AGGRESSIVE_FLAG_TRAVEL_LOCK_MS * (1 - calmMindReduction) * (1 - assassinReduction));
}

/** Keep a deadline-derived fill in the closed interval [0, 1]. */
export function aggressiveProgressRatio(remainingMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, (Number.isFinite(remainingMs) ? remainingMs : 0) / durationMs));
}

export function formatAggressiveSeconds(remainingMs: number): string {
  return `${(Math.ceil(Math.max(0, remainingMs) / 100) / 10).toFixed(1)}s`;
}

export function flagVisitLockLabel(remainingMs: number): string {
  return `Aggressive · ${formatAggressiveSeconds(remainingMs)}`;
}

export function shouldSendFlagVisit(deadlineMs: number, nowMs: number): boolean {
  return aggressiveRemainingMs(deadlineMs, nowMs) === 0;
}
