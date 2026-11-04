/*
 * Ending wars, war-death losses and kingdom limits.
 *
 * Surrender: the loser's treasury loses 14% to the winner and another 12%
 * destroyed, then a 7-day forced peace holds between the pair. A kingdom's
 * treasury holds Bricks and a city's holds City Coins; when the two sides
 * hold different currencies (city vs kingdom), the winner cannot hold the
 * loser's currency, so the transfer share is destroyed too (our choice).
 * Mutual peace ends a war without that penalty but starts the same forced
 * peace (our choice), so a peace cannot be broken by the next stray attack.
 */
export const WAR_SURRENDER_TRANSFER_PERCENT = 14;
export const WAR_SURRENDER_DESTROY_PERCENT = 12;
export const WAR_FORCED_PEACE_MS = 7 * 24 * 60 * 60 * 1_000;

export type WarSurrenderSplit = Readonly<{ transferShare: number; destroyShare: number }>;

/** Each share is rounded down, so a small treasury may lose nothing. */
export function warSurrenderSplit(balance: number): WarSurrenderSplit {
  const safe = Number.isSafeInteger(balance) && balance > 0 ? balance : 0;
  return Object.freeze({
    transferShare: Math.floor((safe * WAR_SURRENDER_TRANSFER_PERCENT) / 100),
    destroyShare: Math.floor((safe * WAR_SURRENDER_DESTROY_PERCENT) / 100)
  });
}

/*
 * War death: killed by a member of a side at war with yours, you lose 9%
 * of your carried Bricks (rounded down, destroyed: player deaths drop no
 * items) and your kingdom treasury loses 115 Bricks, or 1,150 when you are
 * its leader, floored at an empty treasury.
 */
export const WAR_DEATH_CARRIED_BRICK_LOSS_PERCENT = 9;
export const WAR_DEATH_KINGDOM_BRICK_LOSS = 115;
export const WAR_DEATH_KINGDOM_LEADER_BRICK_LOSS = 1_150;

export function warDeathCarriedBrickLoss(carried: number): number {
  if (!Number.isSafeInteger(carried) || carried <= 0) return 0;
  return Math.floor((carried * WAR_DEATH_CARRIED_BRICK_LOSS_PERCENT) / 100);
}

/*
 * Kingdom limits. Kingdom Flags (Obelisks and Kingdom Towers included; the
 * Castle is not counted) are capped at 36 per member active in the last 6
 * days. The cap blocks new conversions and builds; it never removes a
 * standing structure. A new Kingdom Flag or Castle keeps 2.4 km from every
 * other kingdom's territory (no alliances exist, so every other kingdom is
 * non-allied).
 */
export const KINGDOM_STRUCTURES_PER_ACTIVE_MEMBER = 36;
export const KINGDOM_ACTIVE_MEMBER_WINDOW_MS = 6 * 24 * 60 * 60 * 1_000;
export const KINGDOM_TERRITORY_SPACING_M = 2_400;

export type KingdomStructureCapacitySnapshot = Readonly<{
  /** Standing Kingdom Flags, Obelisks and Kingdom Towers. */
  used: number;
  capacity: number;
  activeMembers: number;
}>;

export function kingdomStructureCapacity(activeMembers: number): number {
  return Math.max(0, Math.floor(activeMembers)) * KINGDOM_STRUCTURES_PER_ACTIVE_MEMBER;
}
