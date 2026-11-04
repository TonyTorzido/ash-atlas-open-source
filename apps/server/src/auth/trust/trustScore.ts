// Pure location-trust math. No I/O. See
// docs/architecture/ACCOUNT_TRUST_AND_ANTISPOOF_PLAN.md decisions D11, D13, D14.

export type SpeedBucket =
  | "stationary"
  | "walk"
  | "cycle"
  | "car"
  | "rail"
  | "air"
  | "impossible";

export type TrustSignal = Readonly<{
  rule: string;
  weight: number;
  metadata?: Record<string, unknown>;
}>;

// Below this implied speed the fixes are treated as the same place.
const STATIONARY_MAX_KMH = 1;

// D14 bucket upper bounds in km/h; anything above air is impossible.
const SPEED_BUCKET_LIMITS: ReadonlyArray<readonly [SpeedBucket, number]> = [
  ["walk", 9],
  ["cycle", 43],
  ["car", 160],
  ["rail", 320],
  ["air", 900]
];

export function speedBucket(kmh: number): SpeedBucket {
  if (!Number.isFinite(kmh)) return "impossible";
  if (kmh < STATIONARY_MAX_KMH) return "stationary";
  for (const [bucket, limit] of SPEED_BUCKET_LIMITS) {
    if (kmh <= limit) return bucket;
  }
  return "impossible";
}

export function isTransitBucket(bucket: SpeedBucket | null): boolean {
  return bucket === "car" || bucket === "rail" || bucket === "air";
}

// D13: displacement discounted by both fixes' reported accuracy.
export function effectiveDistanceM(
  distanceM: number,
  accuracyAM: number | null | undefined,
  accuracyBM: number | null | undefined
): number {
  return Math.max(0, distanceM - ((accuracyAM ?? 0) + (accuracyBM ?? 0)));
}

// D13 cooldown table, km -> minutes, linearly interpolated.
const COOLDOWN_TABLE: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 1],
  [5, 2],
  [10, 7],
  [25, 11],
  [50, 17],
  [100, 30],
  [250, 45],
  [500, 60],
  [750, 75],
  [1000, 90],
  [1250, 105],
  [1500, 120]
];

export function cooldownMinutesForKm(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 0;
  const first = COOLDOWN_TABLE[0]!;
  const last = COOLDOWN_TABLE[COOLDOWN_TABLE.length - 1]!;
  if (km <= first[0]) return first[1];
  if (km >= last[0]) return last[1];
  for (let index = 1; index < COOLDOWN_TABLE.length; index += 1) {
    const [upperKm, upperMinutes] = COOLDOWN_TABLE[index]!;
    if (km <= upperKm) {
      const [lowerKm, lowerMinutes] = COOLDOWN_TABLE[index - 1]!;
      return lowerMinutes + ((km - lowerKm) / (upperKm - lowerKm)) * (upperMinutes - lowerMinutes);
    }
  }
  return last[1];
}

// D11 region key: 0.5 degree cells.
export function regionCell(lat: number, lon: number): string {
  return `${Math.floor(lat / 0.5)}:${Math.floor(lon / 0.5)}`;
}

export const FAR_RELOCATION_M = 100_000;
// Far relocations allowed in 7 days before each further one scores.
export const FAR_RELOCATION_FREE_COUNT = 3;

export const LOCATION_SIGNAL_WEIGHTS = {
  speed_impossible: 4,
  speed_air: 1,
  relocation_far_repeat: 2,
  region_familiar: -1,
  relocation_unfamiliar: 0.5,
  accuracy_constant: 0
} as const;

export type LocationScoreFeatures = Readonly<{
  bucket: SpeedBucket | null;
  // This fix moved at least FAR_RELOCATION_M from the previous accepted fix.
  farRelocation: boolean;
  // Far relocations already recorded in the trailing 7 days, excluding this one.
  priorFarRelocations7d: number;
  // null when familiarity is unknown (not wired or lookup failed).
  regionFamiliar: boolean | null;
  relocation: boolean;
  accuracyConstant: boolean;
}>;

export function locationReportScore(features: LocationScoreFeatures): {
  score: number;
  signals: TrustSignal[];
} {
  const signals: TrustSignal[] = [];
  if (features.bucket === "impossible") {
    signals.push({ rule: "speed_impossible", weight: LOCATION_SIGNAL_WEIGHTS.speed_impossible });
  } else if (features.bucket === "air") {
    signals.push({ rule: "speed_air", weight: LOCATION_SIGNAL_WEIGHTS.speed_air });
  }
  if (features.farRelocation && features.priorFarRelocations7d >= FAR_RELOCATION_FREE_COUNT) {
    signals.push({
      rule: "relocation_far_repeat",
      weight: LOCATION_SIGNAL_WEIGHTS.relocation_far_repeat,
      metadata: { priorFarRelocations7d: features.priorFarRelocations7d }
    });
  }
  // Familiarity scores relocations only: periodic passive fixes would otherwise
  // credit -1 every few minutes and wash out any other signal.
  if (features.regionFamiliar === true && features.relocation) {
    signals.push({ rule: "region_familiar", weight: LOCATION_SIGNAL_WEIGHTS.region_familiar });
  } else if (features.regionFamiliar === false && features.relocation) {
    signals.push({ rule: "relocation_unfamiliar", weight: LOCATION_SIGNAL_WEIGHTS.relocation_unfamiliar });
  }
  if (features.accuracyConstant) {
    signals.push({ rule: "accuracy_constant", weight: LOCATION_SIGNAL_WEIGHTS.accuracy_constant });
  }
  return {
    score: signals.reduce((total, signal) => total + signal.weight, 0),
    signals
  };
}

const LAT_CELLS = 360; // 0.5 degree cells from -90 to 90
const LON_CELLS = 720; // 0.5 degree cells from -180 to 180

// D11: the cell and its 3x3 neighborhood; longitude wraps at the antimeridian.
export function neighborhoodCells(lat: number, lon: number): string[] {
  const latCell = Math.floor(lat / 0.5);
  const lonCell = Math.floor(lon / 0.5);
  const cells = new Set<string>();
  for (let dLat = -1; dLat <= 1; dLat += 1) {
    const nextLat = latCell + dLat;
    if (nextLat < -LAT_CELLS / 2 || nextLat > LAT_CELLS / 2) continue;
    for (let dLon = -1; dLon <= 1; dLon += 1) {
      const wrapped = ((lonCell + dLon + LON_CELLS / 2) % LON_CELLS + LON_CELLS) % LON_CELLS - LON_CELLS / 2;
      cells.add(`${nextLat}:${wrapped}`);
    }
  }
  return [...cells];
}

const DAY_MS = 24 * 60 * 60_000;

// D12: R decays as R * exp(-dt / tau).
export function decayLogodds(value: number, from: Date, to: Date, tauDays: number): number {
  const elapsedMs = Math.max(0, to.getTime() - from.getTime());
  return value * Math.exp(-elapsedMs / (tauDays * DAY_MS));
}

export type AccountTrustTier = "new" | "standard" | "trusted" | "restricted";

// D12 static priors, computed at read time. Providers are read generically;
// an account is as costly as its strongest identity, so the lowest prior wins.
export function staticPrior(input: Readonly<{
  providers: ReadonlyArray<Readonly<{ provider: string; email: string | null }>>;
  createdAt: Date;
  riskScore: number;
  now: Date;
}>): number {
  const providerPriors = input.providers.map(({ provider, email }) => {
    if (provider === "email") return 1;
    if (provider === "google") return email && isGmailAddress(email) ? 0 : 0.5;
    return 0;
  });
  const providerPrior = providerPriors.length > 0 ? Math.min(...providerPriors) : 0;
  const agePrior = input.now.getTime() - input.createdAt.getTime() < 7 * DAY_MS ? 0.5 : 0;
  return providerPrior + agePrior + input.riskScore / 25;
}

function isGmailAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  return domain === "gmail.com" || domain === "googlemail.com";
}

export type LadderThresholds = Readonly<{
  quarantine: number;
  quarantineNew: number;
  warning: number;
}>;

// Score-driven ladder tiers only: 3 quarantine, 4 warning. Tiers 1-2 are
// per-action friction and 5-6 need strikes, so neither comes from the score.
export function shadowTierFor(
  effective: number,
  trustTier: AccountTrustTier,
  thresholds: LadderThresholds
): 0 | 3 | 4 {
  if (effective >= thresholds.warning) return 4;
  const quarantine = trustTier === "new" ? thresholds.quarantineNew : thresholds.quarantine;
  return effective >= quarantine ? 3 : 0;
}

// Quarantine exits 24 h after the score falls below it; a warning after 7 days.
const TIER_EXIT_DELAY_MS: Readonly<Record<number, number>> = { 3: DAY_MS, 4: 7 * DAY_MS };

export type ShadowTierState = Readonly<{
  tier: number;
  enteredAt: Date | null;
  exitEligibleAt: Date | null;
}>;

export function nextShadowTier(
  current: ShadowTierState,
  target: number,
  now: Date
): ShadowTierState & { changed: boolean } {
  if (target > current.tier) {
    return { tier: target, enteredAt: now, exitEligibleAt: null, changed: true };
  }
  if (target === current.tier) {
    return { ...current, exitEligibleAt: null, changed: false };
  }
  if (current.exitEligibleAt === null) {
    const delayMs = TIER_EXIT_DELAY_MS[current.tier] ?? 0;
    if (delayMs > 0) {
      return { ...current, exitEligibleAt: new Date(now.getTime() + delayMs), changed: false };
    }
  } else if (now.getTime() < current.exitEligibleAt.getTime()) {
    return { ...current, changed: false };
  }
  return { tier: target, enteredAt: now, exitEligibleAt: null, changed: true };
}

// D18: new -> standard after 14 days, 5 distinct login days and a low score.
export function trustTierPromotion(
  account: Readonly<{ trustTier: AccountTrustTier; createdAt: Date }>,
  loginDays: number,
  effective: number,
  now: Date
): "standard" | null {
  if (account.trustTier !== "new") return null;
  if (now.getTime() - account.createdAt.getTime() < 14 * DAY_MS) return null;
  if (loginDays < 5 || effective >= 4) return null;
  return "standard";
}
