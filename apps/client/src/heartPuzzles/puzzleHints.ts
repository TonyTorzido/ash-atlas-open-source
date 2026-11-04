/** Tiered hint unlocks shared by every Ash Heart dungeon's NPC. Pure. */

export const HINT_TUNING = {
  /** Seconds in the room (and failures) that unlock tiers 1, 2 and 3. */
  secondsForTier: [40, 110, 220],
  failsForTier: [2, 5, 9]
} as const;

export type HintTier = 0 | 1 | 2 | 3;

/** Highest tier unlocked by either time in the room or number of failures. */
export const unlockedHintTier = (elapsedSeconds: number, fails: number, tuning = HINT_TUNING): HintTier => {
  let tier = 0;
  for (let i = 0; i < 3; i += 1) {
    if (elapsedSeconds >= tuning.secondsForTier[i]! || fails >= tuning.failsForTier[i]!) tier = i + 1;
  }
  return tier as HintTier;
};

/** Seconds until the next tier unlocks by time, or null when all are open. */
export const secondsToNextHint = (elapsedSeconds: number, tier: HintTier, tuning = HINT_TUNING): number | null =>
  tier >= 3 ? null : Math.max(0, tuning.secondsForTier[tier as 0 | 1 | 2] - elapsedSeconds);
