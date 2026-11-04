import { DEFAULT_INTERACTION_RADIUS_M } from "./gameplayArea.js";
import type { GeoContext } from "./geoContext.js";

/** Shared Fishing rules and deterministic mechanics. */
export const FISHING_HUT_MAX_WATER_DISTANCE_M = 500;
/** The default overworld cast range for an unupgraded Fishing Rod. */
export const FISHING_BASE_CAST_RANGE_M = 300;
/** No Fishing Training rank may extend an active cast beyond this distance. */
export const FISHING_MAX_CAST_RANGE_M = 600;
export const FISHING_ROD_MAX_USES = 100;
/** Static catalog identity; each durable rod is traded as `fishing_rod:<uuid>`. */
export const FISHING_ROD_MARKET_IDENTITY = "fishing_rod";
const FISHING_ROD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FISHING_ROD_MARKET_IDENTITY_PATTERN =
  /^fishing_rod:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function fishingRodMarketIdentity(rodId: string): string {
  if (!FISHING_ROD_UUID_PATTERN.test(rodId)) {
    throw new Error("Fishing Rod market identity requires a UUID rod instance");
  }
  return `${FISHING_ROD_MARKET_IDENTITY}:${rodId.toLowerCase()}`;
}

export function parseFishingRodMarketIdentity(identity: string): string | null {
  const match = FISHING_ROD_MARKET_IDENTITY_PATTERN.exec(identity);
  return match?.[1]?.toLowerCase() ?? null;
}
export const FISHING_ROD_RECIPE_COST = Object.freeze({ wood: 50, flaxFiber: 30 });
export const FISHING_SPECIALIZATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
/** Matching weekly specialization grants a small handling-only advantage. */
export const FISHING_SPECIALIZATION_HANDLING_EFFECT = 0.05;
export const FISHING_UPGRADE_MAX_RANK = 3;
export const FISHING_UPGRADE_TRACKS = ["cast_range", "reel_power", "line_control"] as const;
export type FishingUpgradeTrack = (typeof FISHING_UPGRADE_TRACKS)[number];
export const FISHING_UPGRADE_GOLD_COSTS = Object.freeze([100, 250, 500]);
export const FISHING_UPGRADE_EFFECTS = Object.freeze({
  cast_range_m: [0, 100, 200, 300],
  reel_power: [0, 0.05, 0.1, 0.15],
  line_control: [0, 0.05, 0.1, 0.15]
});
export const FISHING_HUT_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export const FISHING_HUT_BUILD_DURATION_MS = 30_000;
export const FISHING_HUT_BUILD_COST = Object.freeze({ wood: 25, stone: 10 });
export const FISHING_HUT_PASSIVE_INTERVAL_MS = 45 * 60 * 1_000;
export const FISHING_HUT_PASSIVE_CAPACITY = 16;
export const FISHING_ACTIVE_FOOD_ACCUMULATOR_SCALE = 1_000;
// Active catches are trophy records first. 25 milli-food per pound keeps the
// ordinary resource yield near passive production over a normal encounter loop
// while still making weight meaningful progress toward the next standardized fish.
export const FISHING_ACTIVE_FOOD_YIELD_PER_POUND_MILLI = 25;
export const FISHING_ACTIVE_RECONNECT_GRACE_MS = 60_000;
export const FISHING_ACTIVE_ENCOUNTER_TIMEOUT_MS = 120_000;
export const FISHING_CAST_WINDOW_MS = 1_200;
export const FISHING_BITE_DELAY_MIN_MS = 1_500;
export const FISHING_BITE_DELAY_MAX_MS = 3_500;
export const FISHING_NIBBLE_DURATION_MS = 300;
export const FISHING_FAKE_NIBBLE_DURATION_MS = 450;
// Keep the full true-strike window for mobile taps and normal network jitter.
export const FISHING_TRUE_STRIKE_WINDOW_MS = FISHING_CAST_WINDOW_MS;
/** Client control cadence and the maximum simulation step accepted per input. */
export const FISHING_CONTROL_UPDATE_INTERVAL_MS = 250;
export const FISHING_CONTROL_MAX_STEP_MS = FISHING_CONTROL_UPDATE_INTERVAL_MS;
/** The authoritative fight pool is intentionally larger than the normalized HUD meter. */
export const FISHING_STAMINA_MAX = 150;
export const FISHING_STAMINA_LANDING_THRESHOLD = 25;
export const FISHING_CORRECT_STAMINA_DRAIN_PER_SECOND = 10;
export const FISHING_NEUTRAL_STAMINA_DRAIN_PER_SECOND = 3.5;
export const FISHING_WRONG_STAMINA_DRAIN_PER_SECOND = 0.75;
export const FISHING_RUNNER_DIRECTION_INTERVAL_MS = 6_500;
export const FISHING_DARTER_DIRECTION_INTERVAL_MS = 1_800;
export const FISHING_TANK_DIRECTION_INTERVAL_MS = 8_000;
export const FISHING_FEINTER_DIRECTION_INTERVAL_MS = 2_400;

export const FISHING_BEHAVIOR_PROFILES = ["runner", "darter", "tank", "feinter"] as const;
export type FishingBehaviorProfile = (typeof FISHING_BEHAVIOR_PROFILES)[number];
export const FISHING_WATERBODY_KINDS = ["river", "lake", "ocean"] as const;
export type FishingWaterbodyKind = (typeof FISHING_WATERBODY_KINDS)[number];
export const FISHING_SPECIALIZATION_TYPES = FISHING_WATERBODY_KINDS;
export type FishingSpecializationType = FishingWaterbodyKind;
export const WATERBODY_RESOLUTION_STATUSES = [
  "resolved", "unresolved", "ambiguous", "invalid"
] as const;
export type WaterbodyResolutionStatus = (typeof WATERBODY_RESOLUTION_STATUSES)[number];
export const FISHING_ENCOUNTER_PHASES = [
  "cast", "bite", "hooked", "fighting", "landed", "escaped", "expired", "cancelled"
] as const;
export type FishingEncounterPhase = (typeof FISHING_ENCOUNTER_PHASES)[number];
export const FISHING_CONTROL_DIRECTIONS = ["left", "right", "neutral"] as const;
export type FishingControlDirection = (typeof FISHING_CONTROL_DIRECTIONS)[number];

export type FishingBehaviorState = Readonly<{
  direction: FishingControlDirection;
  pull: number;
}>;

export const FISHING_BITE_EVENT_KINDS = ["nibble", "fake_nibble", "true_strike"] as const;
export type FishingBiteEventKind = (typeof FISHING_BITE_EVENT_KINDS)[number];

export type FishingBiteEvent = Readonly<{
  kind: FishingBiteEventKind;
  startedAt: number;
  endsAt: number;
}>;

export type FishingWaterbodyIdentity = Readonly<{
  kind: FishingWaterbodyKind;
  /** Null means World proved the fishable water class/location but could not resolve a canonical feature. */
  sourceId: string | null;
  displayName: string;
  distanceM: number;
  sourceRevision?: string | null;
}>;
/** Retained name for the V1 wire contract; it now carries ocean identities too. */
export type FreshwaterWaterbodyIdentity = FishingWaterbodyIdentity;

/** Presentation-only nearest-name metadata; it never supplies canonical identity. */
export type FishingWaterNameFallback = Readonly<{
  name: string;
  referenceId?: string | null;
  waterClass: FishingWaterbodyKind;
  distanceM: number | null;
  authority: string;
}>;

export type FishingWaterbodyCandidate = Readonly<{
  kind: FishingWaterbodyKind;
  /** Candidates may be independently fishable before canonical feature resolution completes. */
  sourceId: string | null;
  displayName: string;
  distanceM: number;
  sourceRevision?: string | null;
}>;

export type FishingUpgradeSnapshot = Readonly<{
  track: FishingUpgradeTrack;
  rank: number;
  maxRank: number;
  nextRank: number | null;
  nextCostGold: number | null;
  effect: number;
  nextEffect: number | null;
}>;

export type FishingSpecializationSnapshot = Readonly<{
  selectedType: FishingSpecializationType | null;
  selectedAt: string | null;
  unlocksAt: string | null;
  canChange: boolean;
}>;

export type FishingHutWorldSnapshot = Readonly<{
  fishingHutId: string;
  ownerPlayerId: string;
  ownerUsername: string;
  worldId: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
  waterbody: FreshwaterWaterbodyIdentity;
  passiveStoredQuantity: number;
  passiveCapacity: number;
  passiveReadyQuantity: number;
  upgrades?: readonly FishingUpgradeSnapshot[];
  specialization?: FishingSpecializationSnapshot;
}>;

export type FishingHutBuildSnapshot = Readonly<{
  buildId: string;
  position: Readonly<{ lat: number; lon: number }>;
  waterbody: FreshwaterWaterbodyIdentity;
  startedAt: number;
  completesAt: number;
  durationMs: number;
}>;

export type FishingCatchSnapshot = Readonly<{
  catchId: string;
  encounterId: string;
  player?: Readonly<{ playerId: string; username: string }>;
  fishItemId: "freshwater_fish" | "ashen_fish";
  /** Legacy wire field, always false: older clients still require it. */
  ashen: boolean;
  behaviorProfile: FishingBehaviorProfile;
  difficulty: number;
  lengthIn: number;
  weightLb: number;
  score: number;
  perfect: boolean;
  durationMs: number;
  waterbody: FreshwaterWaterbodyIdentity;
  caughtAt: string;
  rodId?: string;
  /** Stable generator label and empirical CDF percentile at catch time. */
  fishSpecies?: string;
  percentile?: number;
  geography?: Readonly<{ region: string; country: string }>;
  /** Authoritative catch-time geographic provenance; presentation fields remain explicit. */
  geoContext?: GeoContext;
  source?: "active" | "passive";
}>;

export type FishingEncounterSnapshot = Readonly<{
  encounterId: string;
  fishingHutId: string | null;
  rodId?: string;
  rodUsesRemaining?: number;
  /** Persisted server-authoritative range for this encounter's cast. */
  castRangeM?: number;
  phase: FishingEncounterPhase;
  waterbody: FreshwaterWaterbodyIdentity | null;
  waterbodyCandidates?: readonly FishingWaterbodyCandidate[];
  /** The server-bound overworld cast spot, once a cast has been accepted. */
  castPoint: Readonly<{ lat: number; lon: number }> | null;
  behaviorProfile: FishingBehaviorProfile;
  difficulty: number;
  ashen: boolean;
  castQuality: number | null;
  biteAt: number;
  biteEvent: FishingBiteEvent | null;
  serverTime: number;
  tension: number;
  distance: number;
  stamina: number;
  slackMs: number;
  criticalMs: number;
  /** Authoritative current fish pull direction for the live fight HUD. */
  fishDirection: FishingControlDirection;
  fishPull: number;
  executionQuality: number;
  catch: FishingCatchSnapshot | null;
  reconnectDeadlineAt: number;
}>;

/** A stable seed decides whether this bite includes a deceptive false nibble. */
export function fishingBiteIncludesFakeNibble(seed: number): boolean {
  const safeSeed = Number.isSafeInteger(seed) ? Math.abs(seed) : 0;
  return safeSeed % 3 === 0;
}

/** Build the authoritative bite timeline from the encounter seed and bite timestamp. */
export function fishingBiteTimeline(seed: number, biteAtMs: number): readonly FishingBiteEvent[] {
  const start = Number.isFinite(biteAtMs) ? biteAtMs : 0;
  const events: FishingBiteEvent[] = [];
  let cursor = start;
  events.push({ kind: "nibble", startedAt: cursor, endsAt: cursor + FISHING_NIBBLE_DURATION_MS });
  cursor += FISHING_NIBBLE_DURATION_MS;
  if (fishingBiteIncludesFakeNibble(seed)) {
    events.push({ kind: "fake_nibble", startedAt: cursor, endsAt: cursor + FISHING_FAKE_NIBBLE_DURATION_MS });
    cursor += FISHING_FAKE_NIBBLE_DURATION_MS;
  }
  events.push({ kind: "true_strike", startedAt: cursor, endsAt: cursor + FISHING_TRUE_STRIKE_WINDOW_MS });
  return events;
}

/** Return only the bite cue currently visible to the player; the server owns the clock. */
export function fishingBiteEventAt(seed: number, biteAtMs: number, nowMs: number): FishingBiteEvent | null {
  if (!Number.isFinite(nowMs)) return null;
  return fishingBiteTimeline(seed, biteAtMs).find(
    (event) => nowMs >= event.startedAt && nowMs < event.endsAt
  ) ?? null;
}

export type FishingHookTiming = "early" | "valid" | "late";

/** Deterministic timing classification used by server tests and client-safe previews. */
export function fishingHookTiming(seed: number, biteAtMs: number, nowMs: number): FishingHookTiming {
  const strike = fishingBiteTimeline(seed, biteAtMs).find((event) => event.kind === "true_strike")!;
  if (!Number.isFinite(nowMs) || nowMs < strike.startedAt) return "early";
  return nowMs < strike.endsAt ? "valid" : "late";
}

export type FishingStateSnapshot = Readonly<{
  /** Universal encounters may carry no hut at runtime; legacy consumers keep
   * the historical non-null type while wire validation accepts the null case. */
  hut: FishingHutWorldSnapshot;
  encounter: FishingEncounterSnapshot | null;
  personalBestWeightLb: number | null;
  personalBestScore: number | null;
  weeklyBestFiveScore: number;
  serverTime: number;
  upgrades?: readonly FishingUpgradeSnapshot[];
  specialization?: FishingSpecializationSnapshot;
}>;

export type FishingWeeklyAnglerSnapshot = Readonly<{
  playerId: string;
  username: string;
  score: number;
  catchCount: number;
}>;

export type FishingRecordSnapshot = Readonly<{
  waterbody: FreshwaterWaterbodyIdentity | null;
  heaviest: FishingCatchSnapshot | null;
  highestScore: FishingCatchSnapshot | null;
  personalBestWeight: FishingCatchSnapshot | null;
  personalBestScore: FishingCatchSnapshot | null;
  personalBestPerfect: FishingCatchSnapshot | null;
  /** Legacy wire field, always empty: older clients still require it. */
  ashenCatches: readonly FishingCatchSnapshot[];
  weeklyBestFiveScore: number;
  weeklyTopAnglers: readonly FishingWeeklyAnglerSnapshot[];
  recentCatches: readonly FishingCatchSnapshot[];
}>;

/** The World-authoritative fields needed for placement eligibility. */
export type FreshwaterEligibilityInput = Readonly<{
  isLand: boolean;
  isSaltwater: boolean;
  insideMajorLake: boolean;
  majorLakeId: string | null;
  majorLakeName: string | null;
  majorLakeDistanceM: number | null;
  majorLakeSearchComplete: boolean;
  namedRiverId: string | null;
  namedRiverName: string | null;
  riverDistanceM: number | null;
  namedRiverSearchComplete: boolean;
  sourceRevision?: string | null;
  waterNameFallback?: FishingWaterNameFallback | null;
  /**
   * Final square-grid authority, when available. Legacy lake/river fields are
   * retained for older callers, but never override a completed grid search.
   */
  canonicalWaterbody?: Readonly<{
    kind: FishingWaterbodyKind | "ocean" | "inland_water" | "unknown" | null;
    sourceId: string | null;
    sourceName: string | null;
    distanceM: number | null;
    searchComplete: boolean;
    resolutionStatus?: WaterbodyResolutionStatus;
    sourceRevision?: string | null;
    waterNameFallback?: FishingWaterNameFallback | null;
  }> | null;
}>;

/** Resolve any exact World water membership, including ocean cells. */
export function selectFishingWaterbody(
  canonical: Readonly<{
    kind: FishingWaterbodyKind | "inland_water" | "unknown" | null;
    sourceId: string | null;
    sourceName: string | null;
    distanceM: number | null;
    searchComplete: boolean;
    resolutionStatus?: WaterbodyResolutionStatus;
    sourceRevision?: string | null;
    waterNameFallback?: FishingWaterNameFallback | null;
  }> | null | undefined,
  maxDistanceM = FISHING_BASE_CAST_RANGE_M
): FishingWaterbodyIdentity | null {
  if (!canonical?.searchComplete || canonical.resolutionStatus === "invalid") return null;
  if (!FISHING_WATERBODY_KINDS.includes(canonical.kind as FishingWaterbodyKind)) return null;
  const isResolved = canonical.resolutionStatus === undefined || canonical.resolutionStatus === "resolved";
  const sourceId = isResolved ? canonical.sourceId : null;
  // An unresolved/ambiguous identity may not carry an ID, and an explicitly
  // resolved result must carry one. Never substitute a legacy or fallback ID.
  if ((isResolved && !sourceId) || (!isResolved && canonical.sourceId !== null)) return null;
  if (!Number.isFinite(maxDistanceM) || maxDistanceM < 0 || !Number.isFinite(canonical.distanceM ?? Number.NaN) || (canonical.distanceM as number) > maxDistanceM) return null;
  const kind = canonical.kind as FishingWaterbodyKind;
  return {
    kind,
    sourceId,
    // A non-resolved source name is not canonical either; only use it for
    // presentation after a resolved identity has been proven.
    displayName: usableWaterName(isResolved ? canonical.sourceName : null) || displayNameForWaterbody(kind, canonical.waterNameFallback),
    distanceM: Math.max(0, canonical.distanceM as number),
    sourceRevision: canonical.sourceRevision ?? null
  };
}

function displayNameForWaterbody(
  kind: FishingWaterbodyKind,
  fallback?: FishingWaterNameFallback | null
): string {
  const fallbackName = fallback?.name.trim();
  if (
    fallback?.waterClass === kind &&
    fallbackName &&
    fallbackName.toLowerCase() !== "unknown water"
  ) return `Near ${fallbackName}`;
  return kind === "river" ? "Unnamed River" : kind === "lake" ? "Unnamed Lake" : "Open Ocean";
}

function usableWaterName(value: string | null | undefined): string | null {
  const name = value?.trim();
  return name && name.toLowerCase() !== "unknown water" ? name : null;
}

/** Select a named, completely searched, freshwater waterbody from World data. */
export function selectFreshwaterWaterbody(
  input: FreshwaterEligibilityInput
): FreshwaterWaterbodyIdentity | null {
  if (input.canonicalWaterbody !== undefined) {
    const canonical = input.canonicalWaterbody;
    if (!canonical?.searchComplete) return null;
    if (
      canonical.resolutionStatus !== undefined &&
      canonical.resolutionStatus !== "resolved"
    ) return null;
    if (
      (canonical.kind !== "lake" && canonical.kind !== "river") ||
      !canonical.sourceId ||
      !Number.isFinite(canonical.distanceM ?? Number.NaN) ||
      (canonical.distanceM as number) > FISHING_HUT_MAX_WATER_DISTANCE_M
    ) return null;
    return {
      kind: canonical.kind,
      sourceId: canonical.sourceId,
      displayName: canonical.sourceName?.trim() || (
        canonical.kind === "lake" ? "Unnamed Lake" : "Unnamed River"
      ),
      distanceM: Math.max(0, canonical.distanceM as number),
      sourceRevision: canonical.sourceRevision ?? input.sourceRevision ?? null
    };
  }
  if (!input.isLand || input.isSaltwater) return null;
  const candidates: FreshwaterWaterbodyIdentity[] = [];
  if (
    input.majorLakeId &&
    input.majorLakeSearchComplete &&
    (input.insideMajorLake ||
      (Number.isFinite(input.majorLakeDistanceM ?? Number.NaN) &&
        (input.majorLakeDistanceM as number) <= FISHING_HUT_MAX_WATER_DISTANCE_M))
  ) {
    candidates.push({
      kind: "lake",
      sourceId: input.majorLakeId,
      displayName: input.majorLakeName?.trim() || "Unnamed Lake",
      distanceM: Math.max(0, input.majorLakeDistanceM ?? 0),
      sourceRevision: input.sourceRevision ?? null
    });
  }
  if (
    input.namedRiverId &&
    input.namedRiverSearchComplete &&
    Number.isFinite(input.riverDistanceM ?? Number.NaN) &&
    (input.riverDistanceM as number) <= FISHING_HUT_MAX_WATER_DISTANCE_M
  ) {
    candidates.push({
      kind: "river",
      sourceId: input.namedRiverId,
      displayName: input.namedRiverName?.trim() || "Unnamed River",
      distanceM: Math.max(0, input.riverDistanceM as number),
      sourceRevision: input.sourceRevision ?? null
    });
  }
  candidates.sort((left, right) => left.distanceM - right.distanceM || left.kind.localeCompare(right.kind));
  return candidates[0] ?? null;
}

export function passiveFishProducedSince(lastProducedAtMs: number, nowMs: number, storedFish: number): number {
  if (!Number.isFinite(lastProducedAtMs) || !Number.isFinite(nowMs) || nowMs <= lastProducedAtMs) return 0;
  const available = Math.max(0, Math.floor((nowMs - lastProducedAtMs) / FISHING_HUT_PASSIVE_INTERVAL_MS));
  return Math.max(0, Math.min(FISHING_HUT_PASSIVE_CAPACITY - Math.max(0, storedFish), available));
}

export function passiveFishNextTimestampMs(lastProducedAtMs: number, produced: number): number {
  return lastProducedAtMs + Math.max(0, produced) * FISHING_HUT_PASSIVE_INTERVAL_MS;
}

/** Deterministic behavior cues let players learn each archetype without giving the client authority. */
export function fishingBehaviorAt(
  profile: FishingBehaviorProfile,
  seed: number,
  elapsedMs: number
): FishingBehaviorState {
  const safeSeed = Number.isSafeInteger(seed) ? seed : 0;
  const initialDirection: FishingControlDirection = (safeSeed & 1) === 0 ? "left" : "right";
  const elapsed = Math.max(0, Math.floor(Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const interval = profile === "runner"
    ? FISHING_RUNNER_DIRECTION_INTERVAL_MS
    : profile === "darter"
      ? FISHING_DARTER_DIRECTION_INTERVAL_MS
      : profile === "tank"
        ? FISHING_TANK_DIRECTION_INTERVAL_MS
        : FISHING_FEINTER_DIRECTION_INTERVAL_MS;
  const phase = Math.floor(elapsed / interval);
  const direction = phase % 2 === 0 ? initialDirection : oppositeFishingDirection(initialDirection);
  if (profile === "runner") return { direction, pull: 1.25 };
  if (profile === "darter") return { direction, pull: phase % 2 === 0 ? 1.15 : 1.35 };
  if (profile === "tank") return { direction, pull: 0.7 };
  return { direction, pull: phase % 2 === 0 ? 0.65 : 1.6 };
}

function oppositeFishingDirection(direction: FishingControlDirection): FishingControlDirection {
  return direction === "left" ? "right" : direction === "right" ? "left" : "neutral";
}

export type FishingFightState = Readonly<{
  distance: number;
  stamina: number;
  tension: number;
  slackMs: number;
  criticalMs: number;
  fishDirection: FishingControlDirection;
  fishPull: number;
}>;

export type FishingFightUpdate = Readonly<{
  direction: FishingControlDirection;
  reeling: boolean;
  elapsedMs: number;
}>;

/** Convert the authoritative stamina pool to the 0..100 presentation scale. */
export function fishingStaminaPercent(stamina: number): number {
  const safeStamina = Number.isFinite(stamina) ? stamina : 0;
  return Math.max(0, Math.min(100, safeStamina / FISHING_STAMINA_MAX * 100));
}

/** Deterministic server-side fight physics. Distance/tension are 0..100; stamina is 0..150. */
export function advanceFishingFight(state: FishingFightState, update: FishingFightUpdate): FishingFightState {
  const elapsedMs = Math.max(0, Math.min(FISHING_CONTROL_MAX_STEP_MS, update.elapsedMs));
  // Fish direction describes the pull. The rod should point against that pull
  // to counter it; neutral deliberately gives up directional control.
  const directionMatch = state.fishDirection !== "neutral"
    && update.direction !== "neutral"
    && update.direction === oppositeFishingDirection(state.fishDirection);
  // Correct counter-direction work becomes progressively better as the fish
  // tires, while neutral and wrong inputs retain their existing tension rules.
  // No-reel countering gets stronger, while reeling pressure gets gentler so
  // tired fish never become harder to manage with the correct input.
  const staminaFraction = fishingStaminaPercent(state.stamina) / 100;
  const correctTensionDeltaPerMs = update.reeling
    ? 0.004 * staminaFraction
    : -0.002 * (2 - staminaFraction);
  const tensionDeltaPerMs = directionMatch
    ? correctTensionDeltaPerMs
    : update.direction === "neutral"
      ? (update.reeling ? 0.008 : -0.008)
      : (update.reeling ? 0.02 : 0.012);
  const reelDeltaPerMs = update.reeling
    ? directionMatch
      ? -0.06
      : update.direction === "neutral"
        ? -0.045
        : 0.03
    : 0;
  const pullDeltaPerMs = state.fishPull * (directionMatch ? 0.015 : 0.025);
  const tension = Math.max(0, Math.min(100, state.tension + tensionDeltaPerMs * elapsedMs));
  const distance = Math.max(0, Math.min(100, state.distance + (pullDeltaPerMs + reelDeltaPerMs) * elapsedMs));
  const staminaDrainPerSecond = directionMatch && tension >= 35 && tension <= 80
    ? FISHING_CORRECT_STAMINA_DRAIN_PER_SECOND
    : directionMatch || update.direction === "neutral"
      ? FISHING_NEUTRAL_STAMINA_DRAIN_PER_SECOND
      : FISHING_WRONG_STAMINA_DRAIN_PER_SECOND;
  const stamina = Math.max(
    0,
    Math.min(FISHING_STAMINA_MAX, state.stamina - staminaDrainPerSecond / 1_000 * elapsedMs)
  );
  return {
    ...state,
    distance,
    stamina,
    tension,
    slackMs: tension < 15 ? state.slackMs + elapsedMs : 0,
    criticalMs: tension >= 92 ? state.criticalMs + elapsedMs : 0
  };
}

export function fishingFightCanLand(state: FishingFightState): boolean {
  return state.distance <= 12 && state.stamina <= FISHING_STAMINA_LANDING_THRESHOLD && state.tension >= 25 && state.tension < 92;
}

export function fishingFightSnapped(state: FishingFightState): boolean {
  return state.criticalMs >= 2_000 || state.slackMs >= 3_000;
}

export function fishingCatchScore(input: Readonly<{ executionQuality: number; difficulty: number; sizePercentile: number }>): number {
  const execution = Math.max(0, Math.min(1, input.executionQuality));
  const difficulty = Math.max(0, Math.min(1, input.difficulty));
  const size = Math.max(0, Math.min(1, input.sizePercentile));
  return Math.round((execution * 0.45 + difficulty * 0.35 + size * 0.2) * 1_000);
}

export function activeFoodAccumulatorContribution(weightLb: number): number {
  return Math.max(0, Math.round(weightLb * FISHING_ACTIVE_FOOD_YIELD_PER_POUND_MILLI));
}

export function activeFoodFromAccumulator(accumulatorMilli: number): Readonly<{ fish: number; remainderMilli: number }> {
  const safe = Math.max(0, Math.floor(accumulatorMilli));
  return {
    fish: Math.floor(safe / FISHING_ACTIVE_FOOD_ACCUMULATOR_SCALE),
    remainderMilli: safe % FISHING_ACTIVE_FOOD_ACCUMULATOR_SCALE
  };
}
