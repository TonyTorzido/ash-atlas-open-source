export const MOB_SPAWN_FADE_MS = 600;
export const MOB_SPAWN_INTERACTION_ALPHA = 0.08;

export function mobSpawnAlpha(
  firstPresentedAtMs: number,
  nowMs: number,
  reducedMotion: boolean
): number {
  if (reducedMotion) return 1;
  const progress = Math.max(
    0,
    Math.min(1, (nowMs - firstPresentedAtMs) / MOB_SPAWN_FADE_MS)
  );
  return progress * progress * (3 - 2 * progress);
}
