/**
 * Land owner hunting bonus: a kill on someone else's flag territory pays the
 * land owner this share of the kill's gold, newly minted (the hunter's own
 * reward is untouched). The owner is the personal flag's owner, the city's
 * Gold Reserve, or the kingdom's Gold Reserve.
 */
export const LAND_OWNER_HUNTING_BONUS_PERCENT = 4;

/** Stored on each durable combat candidate; settlements queued before it existed never pay a bonus. */
export const LAND_OWNER_BONUS_POLICY_VERSION = 1;

export type LandBonusPayeeKind = "player" | "city" | "kingdom";

/** Exact (fractional) bonus for one kill; the server rounds it deterministically per settlement. */
export function landOwnerBonusExact(killGold: number): number {
  const gold = Math.max(0, Math.trunc(killGold));
  return (gold * LAND_OWNER_HUNTING_BONUS_PERCENT) / 100;
}
