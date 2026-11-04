/** The smallest Hunger debit for a deliberate long-distance journey. */
export const TRAVEL_HUNGER_MIN_COST = 1;
/** Keep one journey from consuming more than the current base Hunger capacity's useful unit. */
export const TRAVEL_HUNGER_MAX_COST = 100;
/** Hunger balance is independent of the World Map presentation duration. */
export const TRAVEL_HUNGER_MAX_RANGE_M = 5_000_000;

/**
 * Calculate the Hunger debit for an authoritative long-distance journey.
 * The distance and range are metres. A zero-distance jump still costs the
 * minimum, and journeys beyond the established range stop at the maximum.
 */
export function travelHungerCost(
  distanceM: number,
  maxRangeM = TRAVEL_HUNGER_MAX_RANGE_M
): number {
  if (!Number.isFinite(maxRangeM) || maxRangeM <= 0) {
    throw new RangeError("travel Hunger max range must be positive");
  }
  const safeDistanceM = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  return Math.min(
    TRAVEL_HUNGER_MAX_COST,
    Math.max(
      TRAVEL_HUNGER_MIN_COST,
      Math.ceil((TRAVEL_HUNGER_MAX_COST * safeDistanceM) / maxRangeM)
    )
  );
}

/** Descriptive alias for call sites that prefer an explicit calculation name. */
export const calculateTravelHungerCost = travelHungerCost;
