import { randomUUID } from "node:crypto";

import {
  distanceMeters,
  type LatLon,
  type LocationFixAssurance,
  type LocationFixReason,
  type NativeLocationSignalsParse
} from "@ash-atlas/shared";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import {
  ATTEST_SIGNAL_WEIGHTS,
  LOCATION_MOCK_WEIGHT,
  RELOCATION_MOCK_WEIGHT,
  fixAssurance,
  type FixAttestation
} from "./attestation/assurance.js";
import type { AccountLinkMonitor } from "./accountLinks.js";
import type { LocationHistoryMonitor } from "./stateHopping.js";
import type { AttestationResolver } from "./attestation/attestationResolver.js";
import { environmentSignal, gnssZeroSatellites } from "./attestation/deviceEnvironment.js";
import { defaultGeoZoneLookup, type GeoZoneLookup } from "./geoZones.js";
import type { IpGeoLookup } from "./ipGeo.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "./trustReviewAccounts.js";
import {
  HARD_MISMATCH_FIXES,
  HARD_MISMATCH_WINDOW_MS,
  MISMATCH_SIGNAL_WEIGHTS,
  StaticFixTracker,
  evaluateMismatch,
  staticFixSignal
} from "./mismatchSignals.js";
import {
  assuranceCountsAsNative,
  type SettlementEvent,
  type SettlementFixUpdate,
  type SettlementRules,
  type SettlementTargets
} from "./settlement.js";
import {
  FAR_RELOCATION_M,
  cooldownMinutesForKm,
  decayLogodds,
  effectiveDistanceM,
  isTransitBucket,
  locationReportScore,
  neighborhoodCells,
  regionCell,
  speedBucket,
  staticPrior,
  trustTierPromotion,
  type SpeedBucket,
  type TrustSignal
} from "./trustScore.js";
import type {
  LandActionHoldReason,
  LandActionStore,
  LocationReportStore,
  TrustStateStore
} from "./trustStore.js";

const DAY_MS = 24 * 60 * 60_000;
const FAR_RELOCATION_WINDOW_MS = 7 * DAY_MS;
// Two fixes in the same instant still yield a finite implied speed.
const MIN_ELAPSED_MS = 1_000;
// GPS noise guard: a pair involving a passive fix this close in time only logs
// car/rail/air/impossible speeds as features; it never scores or holds on them.
export const PASSIVE_SPEED_MIN_ELAPSED_MS = 20_000;
// A passive fix this close to the last stored fix, with no signals or hold,
// only advances last_fix_* instead of inserting a report row.
export const PASSIVE_SKIP_STORE_MAX_DISTANCE_M = 50;
export const PASSIVE_SKIP_STORE_MAX_AGE_MS = 15 * 60_000;

export type LocationFixInput = Readonly<{
  accountId: string;
  playerId: string | null;
  source: "relocation" | "passive";
  requestId?: string;
  lat: number;
  lon: number;
  accuracyM?: number;
  clientPlatform?: "web" | "ios" | "android";
  deviceInstallationId: string | null;
  networkHash: string | null;
  networkPrefixHash: string | null;
  deviceTimeZone?: string;
  // Trusted-proxy client address for the IP signals. Used in memory only, never stored.
  clientIp?: string | null;
  // Android getNetworkCountryIso() from the native block (empty or absent skips).
  networkCountryIso?: string;
  // Why a passive client sent the fix (logged in features only).
  fixReason?: LocationFixReason;
  // Authenticated session (attestation scoping).
  sessionId?: string | null;
  // Parsed native signal block (NATIVE_ANTISPOOF_BUILD_PLAN.md 8.4); absent means legacy.
  native?: NativeLocationSignalsParse;
  // Opaque reference from /api/trust/attest/*, already format-checked.
  attestationRef?: string;
  // Avatar position before the relocation; last displacement fallback.
  avatarPosition: LatLon | null;
  now?: Date;
}>;

export type LocationFixEvaluation = Readonly<{
  verdict: "accepted" | "shadow_rejected" | "rejected";
  reason: string | null;
  distanceM: number | null;
  elapsedMs: number | null;
  impliedKmh: number | null;
  bucket: SpeedBucket | null;
  holdUntil: Date | null;
  holdReason: "relocation_cooldown" | "transit" | null;
  score: number;
  signals: TrustSignal[];
  prevReportId: string | null;
  // Far relocations in the trailing 7 days including this fix.
  farRelocations7d: number;
  // Redundant passive fix: advance last_fix_* without inserting a report row.
  skipStore?: boolean;
  // UTC day (YYYY-MM-DD) this passive fix confirms near home (alt doorway).
  presenceDay?: string | null;
  // Fix assurance before attestation: the WS platform claim (web never counts).
  assurance?: LocationFixAssurance | null;
  // Passive fix eligible to count toward Settled (subject to radius and gap).
  settlementCountable?: boolean;
  // Mismatch signals (TRUST_MISMATCH_MODE), already deduped for the day in this process.
  mismatchSignals?: TrustSignal[];
  // Hard mismatch reached HARD_MISMATCH_FIXES in 24 h on this fix (enforce revokes Settled).
  hardMismatch?: Readonly<{ kind: "ip_location_mismatch" | "carrier_country_mismatch"; fixes: number }> | null;
  // Resolved attestation (device_attestations.id) the fix carried.
  attestationId?: string | null;
  // Native block reported a mock/simulated location (TRUST_MOCK_LOCATION_MODE not off).
  mockLocation?: boolean;
  // Relocation bound-fix mismatch (TRUST_ATTESTATION_MODE not off).
  attestTamper?: boolean;
  features: Record<string, unknown>;
}>;

// Receives scored signals for the account trust ledger. WP6 implements it.
export interface TrustSignalSink {
  recordSignals(input: {
    accountId: string;
    reportId?: string;
    signals: ReadonlyArray<{ rule: string; weight: number; metadata?: Record<string, unknown> }>;
  }): Promise<void>;
}

export const noopTrustSignalSink: TrustSignalSink = {
  async recordSignals() {}
};

export type FamiliarityCheck = (input: Readonly<{
  accountId: string;
  lat: number;
  lon: number;
  now: Date;
}>) => Promise<boolean>;

export type LocationTrustConfig = Pick<
  AppConfig,
  | "TRUST_LOCATION_REJECT_MODE"
  | "TRUST_LAND_ACTION_MIN_DISPLACEMENT_M"
  | "TRUST_TRANSIT_HOLD_MINUTES"
  | "TRUST_SETTLE_ACCURACY_M"
> & Partial<Pick<
  AppConfig,
  | "TRUST_PRESENCE_RADIUS_KM"
  | "TRUST_DOORWAY_CONFIRMED_DAYS"
  | "TRUST_SETTLE_ASSURANCE_MODE"
  | "TRUST_MISMATCH_MODE"
  | "TRUST_ATTESTATION_MODE"
  | "TRUST_MOCK_LOCATION_MODE"
  | "TRUST_ENVIRONMENT_SIGNALS_MODE"
  | "TRUST_ENVIRONMENT_SIGNAL_WEIGHTS"
  | "TRUST_GNSS_ZERO_SAT_MAX_ACCURACY_M"
  | "TRUST_MISMATCH_REVOKE_WEIGHT"
>>;

// Fix-time revocation causes (hard mismatch, mock location, attestation tamper).
export type FixRevocationReason = "hard_mismatch" | "location_mock" | "relocation_mock" | "attest_tamper";

/** Settlement inputs for the report transaction (SettlementService implements it). */
export type SettlementFixSource = Readonly<{
  rules(): SettlementRules;
  rollTargets(): SettlementTargets;
  // Told about every committed Settled transition (cache invalidation).
  onSettlementEvent?(accountId: string, event: Exclude<SettlementEvent, null>): void;
  // Revocation for cause, each family in its own enforce mode only.
  revoke?(accountId: string, reason: FixRevocationReason, metadata?: Record<string, unknown>): Promise<void>;
}>;

const DEFAULT_PRESENCE_RADIUS_KM = 25;
// One mock or tamper revocation per account and hour (mock signals dedupe per hour too).
const DEVICE_REVOCATION_WINDOW_MS = 60 * 60_000;
const DEFAULT_DOORWAY_CONFIRMED_DAYS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class LocationReportService {
  private readonly sink: TrustSignalSink;
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;
  private readonly holdListener: LandActionHoldListener | undefined;
  private readonly familiarity: FamiliarityCheck | undefined;
  private readonly settlement: SettlementFixSource | undefined;
  private readonly ipGeo: IpGeoLookup | undefined;
  private readonly geoZones: GeoZoneLookup;
  private readonly attestations: Pick<AttestationResolver, "resolve"> | undefined;
  private readonly accountLinks: Pick<AccountLinkMonitor, "onFix"> | undefined;
  private readonly locationHistory: Pick<LocationHistoryMonitor, "onFix"> | undefined;
  private readonly staticFixes = new StaticFixTracker();
  // "rule:account" -> UTC day a per-day mismatch signal was last sent by this process.
  private readonly signalDays = new Map<string, string>();
  private readonly lastRevocations = new Map<string, number>();

  constructor(
    private readonly store: LocationReportStore,
    private readonly config: LocationTrustConfig,
    options: Readonly<{
      sink?: TrustSignalSink;
      logger?: Pick<AppLogger, "warn">;
      now?: () => Date;
      // Told about every hold this process commits (the LandActionGate cache).
      holdListener?: LandActionHoldListener;
      familiarity?: FamiliarityCheck;
      // Counts fixes toward Settled and moves the home anchor on relocation.
      settlement?: SettlementFixSource;
      // DB-IP City + ASN; absent or unavailable skips every IP signal.
      ipGeo?: IpGeoLookup;
      geoZones?: GeoZoneLookup;
      // Resolves attestationRef (TRUST_ATTESTATION_MODE not off).
      attestations?: Pick<AttestationResolver, "resolve">;
      // Multi-accounting / account sharing checks after each recorded fix (owner decision C).
      accountLinks?: Pick<AccountLinkMonitor, "onFix">;
      // State hopping over the stored history (owner decision D).
      locationHistory?: Pick<LocationHistoryMonitor, "onFix">;
    }> = {}
  ) {
    this.sink = options.sink ?? noopTrustSignalSink;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.holdListener = options.holdListener;
    this.familiarity = options.familiarity;
    this.settlement = options.settlement;
    this.ipGeo = options.ipGeo;
    this.geoZones = options.geoZones ?? defaultGeoZoneLookup;
    this.attestations = options.attestations;
    this.accountLinks = options.accountLinks;
    this.locationHistory = options.locationHistory;
  }

  // Reads state only; never writes.
  async evaluate(input: LocationFixInput): Promise<LocationFixEvaluation> {
    const now = input.now ?? this.now();
    const fix = { lat: input.lat, lon: input.lon };
    const { state, farRelocationsSince } = await this.store.loadLocationContext(
      input.accountId,
      new Date(now.getTime() - FAR_RELOCATION_WINDOW_MS),
      FAR_RELOCATION_M
    );
    const settleAccuracyM = this.config.TRUST_SETTLE_ACCURACY_M;
    const clampAccuracy = (value: number | null | undefined): number | null =>
      value === null || value === undefined ? null : Math.min(value, settleAccuracyM);
    const accuracyUsedM = clampAccuracy(input.accuracyM);

    // Speed between this fix and the previous accepted fix (relocation or passive).
    const previous = state?.lastFix ?? null;
    const passivePair = input.source === "passive" || state?.lastFixPassive === true;
    let distanceM: number | null = null;
    let speedDistanceM: number | null = null;
    let elapsedMs: number | null = null;
    let impliedKmh: number | null = null;
    let bucket: SpeedBucket | null = null;
    let speedNoiseGuarded: SpeedBucket | null = null;
    if (previous) {
      distanceM = distanceMeters(previous, fix);
      speedDistanceM = effectiveDistanceM(distanceM, clampAccuracy(previous.accuracyM), accuracyUsedM);
      elapsedMs = Math.max(0, now.getTime() - previous.at.getTime());
      impliedKmh = (speedDistanceM / 1000) / (Math.max(elapsedMs, MIN_ELAPSED_MS) / 3_600_000);
      bucket = speedBucket(impliedKmh);
      if (
        passivePair
        && elapsedMs < PASSIVE_SPEED_MIN_ELAPSED_MS
        && (isTransitBucket(bucket) || bucket === "impossible")
      ) {
        speedNoiseGuarded = bucket;
        bucket = null;
      }
    }

    const farRelocation = input.source === "relocation" && distanceM !== null && distanceM >= FAR_RELOCATION_M;
    const accuracyConstant = input.accuracyM !== undefined
      && previous?.accuracyM !== null
      && previous?.accuracyM !== undefined
      && previous.accuracyM === input.accuracyM;
    let regionFamiliar: boolean | null = null;
    if (this.familiarity) {
      try {
        regionFamiliar = await this.familiarity({ accountId: input.accountId, lat: input.lat, lon: input.lon, now });
      } catch (error) {
        this.logger?.warn({ err: error, accountId: input.accountId }, "Region familiarity could not be checked");
      }
    }
    const { score, signals } = locationReportScore({
      bucket,
      farRelocation,
      priorFarRelocations7d: farRelocationsSince,
      regionFamiliar,
      relocation: input.source === "relocation",
      accuracyConstant
    });

    const mode = this.config.TRUST_LOCATION_REJECT_MODE;
    let verdict: LocationFixEvaluation["verdict"] = "accepted";
    let reason: string | null = null;
    if (mode !== "off" && bucket === "impossible") {
      verdict = mode === "enforce" ? "rejected" : "shadow_rejected";
      reason = "speed_impossible";
    }

    // Device trust (plan 8.1): native block, attestation and per-fix assurance.
    const device = await this.deviceTrust(input, now);
    if (device.mock) {
      // enforce: a mock relocation is refused and a mock passive fix is not applied.
      if ((this.config.TRUST_MOCK_LOCATION_MODE ?? "shadow") === "enforce" && verdict !== "rejected") {
        verdict = "rejected";
        reason = "mock_location";
      } else if (verdict === "accepted") {
        verdict = "shadow_rejected";
        reason = "mock_location";
      }
    }

    // Land-action hold (D13/D14): displacement from the last land action,
    // else the last accepted fix, else the avatar position before relocating.
    let displacementReference: "land_action" | "last_fix" | "avatar" | null = null;
    let displacementM: number | null = null;
    let displacementEffectiveM: number | null = null;
    let holdUntil: Date | null = null;
    let holdReason: LocationFixEvaluation["holdReason"] = null;
    if (input.source === "passive" && isTransitBucket(bucket) && speedDistanceM !== null) {
      // Passive fixes set transit holds only, sized by the distance travelled
      // between the pair. Land actions sit at the avatar, which a player who
      // never relocated keeps far from the device, so they are not the reference.
      const cooldownMinutes = speedDistanceM >= this.config.TRUST_LAND_ACTION_MIN_DISPLACEMENT_M
        ? cooldownMinutesForKm(speedDistanceM / 1000)
        : 0;
      const holdMinutes = Math.max(cooldownMinutes, this.config.TRUST_TRANSIT_HOLD_MINUTES);
      if (holdMinutes > 0) {
        holdUntil = new Date(now.getTime() + Math.round(holdMinutes * 60_000));
        holdReason = "transit";
      }
    }
    if (input.source === "relocation") {
      let reference: LatLon | null = null;
      let referenceAccuracyM: number | null = null;
      if (state?.lastLandAction) {
        displacementReference = "land_action";
        reference = state.lastLandAction;
      } else if (previous) {
        displacementReference = "last_fix";
        reference = previous;
        referenceAccuracyM = clampAccuracy(previous.accuracyM);
      } else if (input.avatarPosition) {
        displacementReference = "avatar";
        reference = input.avatarPosition;
      }
      if (reference) {
        displacementM = distanceMeters(reference, fix);
        displacementEffectiveM = effectiveDistanceM(displacementM, referenceAccuracyM, accuracyUsedM);
      }
      const cooldownMinutes =
        displacementEffectiveM !== null && displacementEffectiveM >= this.config.TRUST_LAND_ACTION_MIN_DISPLACEMENT_M
          ? cooldownMinutesForKm(displacementEffectiveM / 1000)
          : 0;
      const transit = isTransitBucket(bucket);
      const holdMinutes = transit
        ? Math.max(cooldownMinutes, this.config.TRUST_TRANSIT_HOLD_MINUTES)
        : cooldownMinutes;
      if (holdMinutes > 0) {
        holdUntil = new Date(now.getTime() + Math.round(holdMinutes * 60_000));
        holdReason = transit ? "transit" : "relocation_cooldown";
      }
    }

    // Mismatch signals (plan section 5), gated by their own family mode.
    const mismatchMode = this.config.TRUST_MISMATCH_MODE ?? "shadow";
    const nativeFix = input.clientPlatform === "ios" || input.clientPlatform === "android";
    let mismatchSignals: TrustSignal[] = [];
    let mismatchFeatures: Record<string, unknown> = {};
    let hardMismatch: LocationFixEvaluation["hardMismatch"] = null;
    let mismatchExcludesSettled = false;
    let hardFlagged = false;
    if (mismatchMode !== "off") {
      const mismatchInput = {
        accountId: input.accountId,
        lat: input.lat,
        lon: input.lon,
        now,
        clientIp: input.clientIp,
        deviceTimeZone: input.deviceTimeZone,
        networkCountryIso: input.networkCountryIso
      };
      const result = evaluateMismatch(mismatchInput, { ipGeo: this.ipGeo, zones: this.geoZones });
      const candidates = [...result.signals];
      mismatchFeatures = { ...result.features };
      if (nativeFix && input.source === "passive") {
        const run = this.staticFixes.peek(input.accountId, StaticFixTracker.keyFor(input.lat, input.lon, input.accuracyM));
        mismatchFeatures.staticRun = run;
        const staticSignal = staticFixSignal(mismatchInput, run);
        if (staticSignal) candidates.push(staticSignal);
      }
      mismatchSignals = candidates.filter((candidate) => this.signalDays.get(`${candidate.rule}:${input.accountId}`) !== now.toISOString().slice(0, 10));
      mismatchExcludesSettled = result.excludeFromSettled;
      hardFlagged = result.hardIpMismatch || result.hardCarrierMismatch;
      mismatchFeatures.hardIpMismatch = result.hardIpMismatch;
      mismatchFeatures.hardCarrierMismatch = result.hardCarrierMismatch;
      if (hardFlagged && this.store.countHardMismatchFixes) {
        try {
          const prior = await this.store.countHardMismatchFixes(
            input.accountId,
            new Date(now.getTime() - HARD_MISMATCH_WINDOW_MS)
          );
          if (result.hardIpMismatch && prior.ip + 1 >= HARD_MISMATCH_FIXES) {
            hardMismatch = { kind: "ip_location_mismatch", fixes: prior.ip + 1 };
          } else if (result.hardCarrierMismatch && prior.carrier + 1 >= HARD_MISMATCH_FIXES) {
            hardMismatch = { kind: "carrier_country_mismatch", fixes: prior.carrier + 1 };
          }
        } catch (error) {
          this.logger?.warn({ err: error, accountId: input.accountId }, "Hard mismatch fixes could not be counted");
        }
      }
    }

    const lastStored = state?.lastStoredFix ?? null;
    const skipStore = input.source === "passive"
      && verdict === "accepted"
      && holdUntil === null
      && signals.every((signal) => signal.weight === 0)
      && mismatchSignals.every((signal) => signal.weight === 0)
      && !hardFlagged
      && !device.mock
      && device.attestation?.tamper !== true
      && lastStored !== null
      && now.getTime() - lastStored.at.getTime() < PASSIVE_SKIP_STORE_MAX_AGE_MS
      && effectiveDistanceM(
        distanceMeters(lastStored, fix),
        clampAccuracy(lastStored.accuracyM),
        accuracyUsedM
      ) <= PASSIVE_SKIP_STORE_MAX_DISTANCE_M;

    // Alt doorway: a passive fix within the presence radius of home confirms
    // today. With no home yet, this passive fix becomes home and counts.
    const home = state?.home ?? null;
    const homeDistanceM = home ? distanceMeters(home, fix) : null;
    const presenceRadiusM = (this.config.TRUST_PRESENCE_RADIUS_KM ?? DEFAULT_PRESENCE_RADIUS_KM) * 1000;
    const presenceDay = input.source === "passive"
      && verdict !== "rejected"
      && (homeDistanceM === null || homeDistanceM <= presenceRadiusM)
      ? now.toISOString().slice(0, 10)
      : null;

    // Settled counting (plan 2.3): native, speed-plausible, accurate passive
    // fixes. Mock and tamper are flagged; mismatch and VPN exclusions join here.
    const assurance = device.assurance;
    const settlementCountable = input.source === "passive"
      && verdict === "accepted"
      && input.accuracyM !== undefined
      && input.accuracyM <= settleAccuracyM
      && assuranceCountsAsNative(assurance, this.config.TRUST_SETTLE_ASSURANCE_MODE ?? "shadow")
      && !mismatchExcludesSettled;

    return {
      verdict,
      reason,
      presenceDay,
      assurance,
      settlementCountable,
      mismatchSignals,
      hardMismatch,
      attestationId: device.attestation?.id ?? null,
      mockLocation: device.mock,
      attestTamper: device.attestation?.tamper === true,
      distanceM,
      elapsedMs,
      impliedKmh,
      bucket,
      holdUntil,
      holdReason,
      score,
      signals,
      prevReportId: state?.lastAcceptedReportId ?? null,
      farRelocations7d: farRelocationsSince + (farRelocation ? 1 : 0),
      skipStore,
      features: {
        ...(input.fixReason === undefined ? {} : { fixReason: input.fixReason }),
        previousFixPassive: previous ? state?.lastFixPassive === true : null,
        speedNoiseGuarded,
        regionCell: regionCell(input.lat, input.lon),
        regionFamiliar,
        speedDistanceM,
        displacementReference,
        displacementM,
        displacementEffectiveM,
        accuracyUsedM,
        accuracyAboveSettle: input.accuracyM !== undefined && input.accuracyM > settleAccuracyM,
        accuracyConstant,
        farRelocation,
        priorFarRelocations7d: farRelocationsSince,
        rejectMode: mode,
        homeDistanceM,
        assurance,
        settlementCountable,
        mismatchMode,
        ...mismatchFeatures,
        ...device.features,
        signals: signals.map((signal) => ({ rule: signal.rule, weight: signal.weight }))
      }
    };
  }

  // One transaction for the report, seq, and (when accepted) fix/hold state.
  async record(
    input: LocationFixInput,
    evaluation: LocationFixEvaluation,
    outcome: "accepted" | "travel_failed"
  ): Promise<{ reportId: string | null; seq: number | null }> {
    const at = input.now ?? this.now();
    this.commitStaticRun(input);
    if (
      evaluation.skipStore === true
      && outcome === "accepted"
      && evaluation.verdict === "accepted"
      && evaluation.holdUntil === null
    ) {
      // Redundant passive fix: keep speed math current without a report row.
      const event = await this.store.updateLastFix({
        accountId: input.accountId,
        lat: input.lat,
        lon: input.lon,
        accuracyM: input.accuracyM ?? null,
        at,
        presenceDay: evaluation.presenceDay ?? null,
        confirmedDaysTarget: this.confirmedDaysTarget(),
        assurance: evaluation.assurance ?? null,
        settlement: this.settlementUpdate(input, evaluation, at)
      });
      if (event) this.settlement?.onSettlementEvent?.(input.accountId, event);
      await this.afterRecorded(input, at);
      return { reportId: null, seq: null };
    }
    const rejected = evaluation.verdict === "rejected";
    const verdict = rejected
      ? "rejected"
      : outcome === "travel_failed"
        ? "travel_failed"
        : evaluation.verdict;
    const accepted = outcome === "accepted" && !rejected;
    const reportId = randomUUID();
    const result = await this.store.recordLocationReport(
      {
        id: reportId,
        accountId: input.accountId,
        playerId: input.playerId,
        source: input.source,
        requestId: input.requestId ?? null,
        lat: input.lat,
        lon: input.lon,
        accuracyM: input.accuracyM ?? null,
        clientPlatform: input.clientPlatform ?? null,
        deviceInstallationId: input.deviceInstallationId,
        networkHash: input.networkHash,
        networkPrefixHash: input.networkPrefixHash,
        deviceTimeZone: input.deviceTimeZone ?? null,
        receivedAt: at,
        prevReportId: evaluation.prevReportId,
        distanceM: evaluation.distanceM,
        elapsedMs: evaluation.elapsedMs,
        impliedKmh: evaluation.impliedKmh,
        speedBucket: evaluation.bucket,
        verdict,
        verdictReason: evaluation.reason,
        features: { ...evaluation.features, evaluatedVerdict: evaluation.verdict },
        score: evaluation.score,
        assurance: evaluation.assurance ?? null,
        attestationId: evaluation.attestationId ?? null
      },
      accepted
        ? {
            holdUntil: evaluation.holdUntil,
            holdReason: evaluation.holdReason,
            relocations7dFar: evaluation.farRelocations7d,
            presenceDay: evaluation.presenceDay ?? null,
            confirmedDaysTarget: this.confirmedDaysTarget()
          }
        : null,
      accepted ? this.settlementUpdate(input, evaluation, at) : null
    );
    if (result.settlementEvent) this.settlement?.onSettlementEvent?.(input.accountId, result.settlementEvent);
    if (accepted && evaluation.holdUntil && evaluation.holdReason) {
      this.holdListener?.noteHold(input.accountId, evaluation.holdUntil, evaluation.holdReason);
    }
    const signals = evaluation.signals.filter((signal) => signal.weight !== 0);
    if (this.config.TRUST_LOCATION_REJECT_MODE !== "off" && signals.length > 0) {
      try {
        await this.sink.recordSignals({ accountId: input.accountId, reportId, signals });
      } catch (error) {
        this.logger?.warn(
          { err: error, accountId: input.accountId, reportId },
          "Location trust signals could not be recorded"
        );
      }
    }
    await this.afterMismatch(input, evaluation, reportId, at);
    await this.afterDeviceTrust(input, evaluation, reportId, at);
    await this.afterRecorded(input, at);
    return result;
  }

  // Cross-account and cross-device checks on the stored history. Never throws.
  private async afterRecorded(input: LocationFixInput, at: Date): Promise<void> {
    await this.locationHistory?.onFix({ accountId: input.accountId, lat: input.lat, lon: input.lon, at, source: input.source })
      .catch((error: unknown) => {
        this.logger?.warn({ err: error, accountId: input.accountId }, "Location history check failed");
      });
    if (!this.accountLinks) return;
    await this.accountLinks.onFix({
      accountId: input.accountId,
      deviceInstallationId: input.deviceInstallationId && UUID_PATTERN.test(input.deviceInstallationId)
        ? input.deviceInstallationId
        : null,
      lat: input.lat,
      lon: input.lon,
      at
    }).catch((error: unknown) => {
      this.logger?.warn({ err: error, accountId: input.accountId }, "Account link check failed");
    });
  }

  // Native block + attestation for this fix. Never throws: a lookup failure
  // leaves the fix at its platform/native-block assurance.
  private async deviceTrust(input: LocationFixInput, now: Date): Promise<Readonly<{
    assurance: LocationFixAssurance | null;
    mock: boolean;
    attestation: FixAttestation | null;
    features: Record<string, unknown>;
  }>> {
    const attestationMode = this.config.TRUST_ATTESTATION_MODE ?? "shadow";
    const mockMode = this.config.TRUST_MOCK_LOCATION_MODE ?? "shadow";
    const native: NativeLocationSignalsParse = input.native ?? { status: "absent", signals: null };
    const signals = native.status === "ok" ? native.signals : null;
    const nativePlatform = input.clientPlatform === "ios" || input.clientPlatform === "android";
    let attestation: FixAttestation | null = null;
    if (attestationMode !== "off" && nativePlatform && input.attestationRef && this.attestations) {
      try {
        attestation = await this.attestations.resolve({
          ref: input.attestationRef,
          accountId: input.accountId,
          sessionId: input.sessionId ?? null,
          installationId: input.deviceInstallationId,
          source: input.source,
          fix: {
            lat: input.lat,
            lon: input.lon,
            accuracy: input.accuracyM,
            fixTimestampMs: signals?.fixTimestampMs
          },
          now
        });
      } catch (error) {
        this.logger?.warn({ err: error, accountId: input.accountId }, "Attestation reference could not be resolved");
      }
    }
    const result = fixAssurance({
      clientPlatform: input.clientPlatform,
      native: signals,
      attestation,
      mockMode,
      attestationMode
    });
    return {
      assurance: result.assurance,
      mock: result.mock,
      attestation,
      features: {
        nativeBlock: native.status,
        ...(signals
          ? {
              nativeShellBuild: signals.shellBuild ?? null,
              nativePlugin: signals.plugin ?? null,
              nativeProvider: signals.provider ?? null,
              nativeMock: signals.mock ?? null,
              nativeSimulated: signals.simulated ?? null,
              nativeAccessory: signals.accessory ?? null,
              nativeDevOptions: signals.devOptions ?? null,
              nativeReducedAccuracy: signals.reducedAccuracy ?? null,
              nativeFixAgeMs: signals.fixAgeMs ?? null
            }
          : {}),
        mockMode,
        attestationMode,
        attestationRefPresent: input.attestationRef !== undefined,
        attestationId: attestation?.id ?? null,
        attestationOutcome: attestation?.outcome ?? null,
        attestationMethod: attestation?.method ?? null,
        attestTamper: attestation?.tamper === true
      }
    };
  }

  // Mock and tamper signals, then revocation in each family's enforce mode.
  // Never throws: the fix is already recorded.
  private async afterDeviceTrust(
    input: LocationFixInput,
    evaluation: LocationFixEvaluation,
    reportId: string | null,
    at: Date
  ): Promise<void> {
    const signals: TrustSignal[] = [];
    const revocations: FixRevocationReason[] = [];
    if (evaluation.mockLocation === true) {
      const relocation = input.source === "relocation";
      signals.push({
        rule: relocation ? "relocation_mock" : "location_mock",
        weight: relocation ? RELOCATION_MOCK_WEIGHT : LOCATION_MOCK_WEIGHT,
        metadata: {
          ...(relocation ? {} : { dedupeKey: `location_mock:${input.accountId}:${at.toISOString().slice(0, 13)}` }),
          verdict: evaluation.verdict
        }
      });
      if ((this.config.TRUST_MOCK_LOCATION_MODE ?? "shadow") === "enforce") {
        revocations.push(relocation ? "relocation_mock" : "location_mock");
      }
    }
    // GNSS shows no satellites in use while the fix claims good accuracy (shadow evidence).
    const native = input.native?.status === "ok" ? input.native.signals : null;
    if (gnssZeroSatellites(native, input.accuracyM, this.config.TRUST_GNSS_ZERO_SAT_MAX_ACCURACY_M ?? 50)) {
      const gnss = environmentSignal("gnss_zero_satellites", {
        TRUST_ENVIRONMENT_SIGNALS_MODE: this.config.TRUST_ENVIRONMENT_SIGNALS_MODE ?? "shadow",
        TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: this.config.TRUST_ENVIRONMENT_SIGNAL_WEIGHTS ?? {}
      }, input.accountId, at, {
        source: input.source,
        accuracyM: input.accuracyM,
        satellitesVisible: native?.gnssSatellitesVisible ?? null
      });
      if (gnss) signals.push(gnss);
    }
    if (evaluation.attestTamper === true) {
      signals.push({
        rule: "attest_tamper",
        weight: ATTEST_SIGNAL_WEIGHTS.attest_tamper,
        metadata: { reason: "bound_fix_mismatch", attestationId: evaluation.attestationId ?? null }
      });
      if ((this.config.TRUST_ATTESTATION_MODE ?? "shadow") === "enforce") revocations.push("attest_tamper");
    }
    if (signals.length > 0) {
      try {
        await this.sink.recordSignals({ accountId: input.accountId, ...(reportId ? { reportId } : {}), signals });
      } catch (error) {
        this.logger?.warn({ err: error, accountId: input.accountId }, "Device trust signals could not be recorded");
      }
    }
    for (const reason of revocations) {
      await this.revokeThrottled(input.accountId, reason, { reportId, source: input.source }, DEVICE_REVOCATION_WINDOW_MS, at);
    }
  }

  // At most one revocation per account and reason per window in this process.
  private async revokeThrottled(
    accountId: string,
    reason: FixRevocationReason,
    metadata: Record<string, unknown>,
    windowMs: number,
    at: Date
  ): Promise<void> {
    if (!this.settlement?.revoke) return;
    const key = `${reason}:${accountId}`;
    const lastMs = this.lastRevocations.get(key);
    if (lastMs !== undefined && at.getTime() - lastMs < windowMs) return;
    if (this.lastRevocations.size >= 50_000) this.lastRevocations.clear();
    this.lastRevocations.set(key, at.getTime());
    try {
      await this.settlement.revoke(accountId, reason, metadata);
    } catch (error) {
      this.lastRevocations.delete(key);
      this.logger?.warn({ err: error, accountId, reason }, "Settled revocation failed");
    }
  }

  private commitStaticRun(input: LocationFixInput): void {
    if ((this.config.TRUST_MISMATCH_MODE ?? "shadow") === "off") return;
    const native = input.clientPlatform === "ios" || input.clientPlatform === "android";
    if (native && input.source === "passive") {
      this.staticFixes.commit(input.accountId, StaticFixTracker.keyFor(input.lat, input.lon, input.accuracyM));
    } else {
      this.staticFixes.reset(input.accountId);
    }
  }

  // Sends mismatch signals and, in enforce only, revokes Settled on a hard mismatch.
  // Never throws: the fix is already recorded.
  private async afterMismatch(
    input: LocationFixInput,
    evaluation: LocationFixEvaluation,
    reportId: string | null,
    at: Date
  ): Promise<void> {
    const mode = this.config.TRUST_MISMATCH_MODE ?? "shadow";
    if (mode === "off") return;
    const day = at.toISOString().slice(0, 10);
    const signals = (evaluation.mismatchSignals ?? []).filter((signal) => signal.weight !== 0);
    if (signals.length > 0) {
      if (this.signalDays.size >= 100_000) this.signalDays.clear();
      for (const signal of signals) this.signalDays.set(`${signal.rule}:${input.accountId}`, day);
      try {
        await this.sink.recordSignals({
          accountId: input.accountId,
          ...(reportId ? { reportId } : {}),
          signals
        });
      } catch (error) {
        this.logger?.warn({ err: error, accountId: input.accountId }, "Mismatch trust signals could not be recorded");
      }
    }
    if (mode !== "enforce") return;
    const hard = evaluation.hardMismatch;
    if (hard) {
      await this.revokeThrottled(
        input.accountId,
        "hard_mismatch",
        { kind: hard.kind, fixes: hard.fixes },
        HARD_MISMATCH_WINDOW_MS,
        at
      );
      return;
    }
    // Owner decision F: repeated soft mismatches add up to a revocation too.
    const threshold = this.config.TRUST_MISMATCH_REVOKE_WEIGHT ?? 0;
    if (threshold <= 0 || signals.length === 0 || !this.store.mismatchWeightSince) return;
    try {
      const weight = await this.store.mismatchWeightSince(
        input.accountId,
        Object.keys(MISMATCH_SIGNAL_WEIGHTS),
        new Date(at.getTime() - HARD_MISMATCH_WINDOW_MS)
      );
      if (weight >= threshold) {
        await this.revokeThrottled(
          input.accountId,
          "hard_mismatch",
          { kind: "accumulated", weight },
          HARD_MISMATCH_WINDOW_MS,
          at
        );
      }
    } catch (error) {
      this.logger?.warn({ err: error, accountId: input.accountId }, "Mismatch weight could not be summed");
    }
  }

  // Applied relocations move the home anchor; countable passive fixes count.
  private settlementUpdate(
    input: LocationFixInput,
    evaluation: LocationFixEvaluation,
    at: Date
  ): SettlementFixUpdate | null {
    if (!this.settlement) return null;
    const countable = evaluation.settlementCountable === true;
    if (input.source === "passive" && !countable) return null;
    return {
      source: input.source,
      lat: input.lat,
      lon: input.lon,
      at,
      countable,
      baseTargets: this.settlement.rollTargets(),
      rules: this.settlement.rules()
    };
  }

  private confirmedDaysTarget(): number {
    return this.config.TRUST_DOORWAY_CONFIRMED_DAYS ?? DEFAULT_DOORWAY_CONFIRMED_DAYS;
  }
}

export type LandActionHoldListener = Readonly<{
  noteHold(accountId: string, holdUntil: Date, reason: LandActionHoldReason): void;
}>;

export type LandActionKind =
  | "flag_place"
  | "flag_reinforce"
  | "flag_upgrade"
  | "flag_burn"
  | "flag_attack"
  | "city_found"
  | "city_convert"
  | "pvp_engage";

export type LandActionInput = Readonly<{
  accountId: string;
  playerId: string;
  action: LandActionKind;
  position: LatLon | null;
}>;

export type LandActionDecision =
  | { allowed: true; shadowBlocked: boolean }
  | { allowed: false; code: "LAND_ACTION_SETTLING"; message: "Try again later."; retryAfterMs: number };

export const LAND_ACTION_DURING_HOLD_WEIGHT = 0.5;
// Holds read from the database are trusted this long; another process may
// have written a newer hold meanwhile (cache staleness only).
const HOLD_CACHE_TTL_MS = 30_000;
// A land action in the same region cell and day is persisted at most this often.
const LAND_ACTION_WRITE_INTERVAL_MS = 60_000;
const MAX_CACHED_ACCOUNTS = 50_000;

type CachedHold = {
  untilMs: number | null;
  reason: LandActionHoldReason | null;
  loadedAtMs: number;
  signaledUntilMs: number | null;
};

const ALLOWED: LandActionDecision = { allowed: true, shadowBlocked: false };

export class LandActionGate implements LandActionHoldListener {
  private readonly holds = new Map<string, CachedHold>();
  private readonly hydrations = new Map<string, Promise<CachedHold>>();
  private readonly lastWrites = new Map<string, { atMs: number; cell: string; day: string }>();
  private readonly sink: TrustSignalSink;
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly store: LandActionStore,
    private readonly config: Pick<AppConfig, "TRUST_LAND_ACTION_MODE">,
    options: Readonly<{
      sink?: TrustSignalSink;
      logger?: Pick<AppLogger, "warn">;
      now?: () => Date;
    }> = {}
  ) {
    this.sink = options.sink ?? noopTrustSignalSink;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  noteHold(accountId: string, holdUntil: Date, reason: LandActionHoldReason): void {
    const untilMs = holdUntil.getTime();
    const cached = this.holds.get(accountId);
    if (cached && cached.untilMs !== null && cached.untilMs >= untilMs) return;
    if (!cached && this.holds.size >= MAX_CACHED_ACCOUNTS) this.holds.clear();
    this.holds.set(accountId, {
      untilMs,
      reason,
      loadedAtMs: cached?.loadedAtMs ?? this.now().getTime(),
      signaledUntilMs: cached?.signaledUntilMs ?? null
    });
  }

  async check(input: LandActionInput): Promise<LandActionDecision> {
    const mode = this.config.TRUST_LAND_ACTION_MODE;
    if (mode === "off") return ALLOWED;
    let hold: CachedHold;
    try {
      hold = await this.currentHold(input.accountId);
    } catch (error) {
      // Fail open: the database is unavailable, not the player.
      this.logger?.warn({ err: error, accountId: input.accountId }, "Land-action hold could not be loaded");
      return ALLOWED;
    }
    const nowMs = this.now().getTime();
    if (hold.untilMs === null || hold.untilMs <= nowMs) return ALLOWED;
    if (mode === "enforce") {
      return {
        allowed: false,
        code: "LAND_ACTION_SETTLING",
        message: "Try again later.",
        retryAfterMs: hold.untilMs - nowMs
      };
    }
    if (hold.signaledUntilMs !== hold.untilMs) {
      hold.signaledUntilMs = hold.untilMs;
      // WP6 enforces the dedupe key; this process also signals once per hold.
      void this.sink.recordSignals({
        accountId: input.accountId,
        signals: [{
          rule: "land_action_during_hold",
          weight: LAND_ACTION_DURING_HOLD_WEIGHT,
          metadata: {
            dedupeKey: `hold:${input.accountId}:${hold.untilMs}`,
            action: input.action,
            holdReason: hold.reason,
            holdUntil: new Date(hold.untilMs).toISOString(),
            remainingMs: hold.untilMs - nowMs
          }
        }]
      }).catch((error: unknown) => {
        this.logger?.warn({ err: error, accountId: input.accountId }, "Land-action trust signal could not be recorded");
      });
    }
    return { allowed: true, shadowBlocked: true };
  }

  // Epoch ms when land actions are available again, or null when no hold applies.
  async availableAt(accountId: string): Promise<number | null> {
    if (this.config.TRUST_LAND_ACTION_MODE === "off") return null;
    try {
      const hold = await this.currentHold(accountId);
      return hold.untilMs !== null && hold.untilMs > this.now().getTime() ? hold.untilMs : null;
    } catch (error) {
      this.logger?.warn({ err: error, accountId }, "Land-action hold could not be loaded");
      return null;
    }
  }

  // Remembers where land actions happen (displacement reference, region days).
  // Never throws; failures are logged.
  async recordLandAction(input: LandActionInput): Promise<void> {
    if (this.config.TRUST_LAND_ACTION_MODE === "off" || !input.position) return;
    const at = this.now();
    const atMs = at.getTime();
    const cell = regionCell(input.position.lat, input.position.lon);
    const day = at.toISOString().slice(0, 10);
    const last = this.lastWrites.get(input.accountId);
    if (last && atMs - last.atMs < LAND_ACTION_WRITE_INTERVAL_MS && last.cell === cell && last.day === day) {
      return;
    }
    if (!last && this.lastWrites.size >= MAX_CACHED_ACCOUNTS) this.lastWrites.clear();
    const marker = { atMs, cell, day };
    this.lastWrites.set(input.accountId, marker);
    try {
      await this.store.recordLandAction({
        accountId: input.accountId,
        lat: input.position.lat,
        lon: input.position.lon,
        at,
        regionCell: cell,
        day
      });
    } catch (error) {
      if (this.lastWrites.get(input.accountId) === marker) this.lastWrites.delete(input.accountId);
      this.logger?.warn(
        { err: error, accountId: input.accountId, action: input.action },
        "Land action could not be recorded"
      );
    }
  }

  private async currentHold(accountId: string): Promise<CachedHold> {
    const cached = this.holds.get(accountId);
    if (cached && this.now().getTime() - cached.loadedAtMs < HOLD_CACHE_TTL_MS) return cached;
    let pending = this.hydrations.get(accountId);
    if (!pending) {
      pending = this.hydrate(accountId).finally(() => this.hydrations.delete(accountId));
      this.hydrations.set(accountId, pending);
    }
    return pending;
  }

  private async hydrate(accountId: string): Promise<CachedHold> {
    const loaded = await this.store.loadLandActionHold(accountId);
    const loadedUntilMs = loaded.holdUntil?.getTime() ?? null;
    // Holds only grow, so a hold noted while loading wins over an older read.
    const existing = this.holds.get(accountId);
    const keepExisting = existing !== undefined
      && existing.untilMs !== null
      && (loadedUntilMs === null || existing.untilMs >= loadedUntilMs);
    if (!existing && this.holds.size >= MAX_CACHED_ACCOUNTS) this.holds.clear();
    const next: CachedHold = {
      untilMs: keepExisting ? existing.untilMs : loadedUntilMs,
      reason: keepExisting ? existing.reason : loaded.holdReason,
      loadedAtMs: this.now().getTime(),
      signaledUntilMs: existing?.signaledUntilMs ?? null
    };
    this.holds.set(accountId, next);
    return next;
  }
}

export type TrustScoreConfig = Pick<
  AppConfig,
  | "TRUST_QUARANTINE_MODE"
  | "TRUST_DECAY_TAU_DAYS"
  | "TRUST_FAMILIAR_REGION_DAYS"
  | "TRUST_FAMILIAR_REGION_STALE_DAYS"
  | "TRUST_QUARANTINE_THRESHOLD"
  | "TRUST_QUARANTINE_THRESHOLD_NEW"
  | "TRUST_WARNING_THRESHOLD"
> & TrustReviewConfig;

// The account trust ledger (D12, D16, D18). Shadow only: it records the
// decaying score and shadow tier; nothing here changes gameplay.
export class TrustService implements TrustSignalSink {
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly store: TrustStateStore,
    private readonly config: TrustScoreConfig,
    options: Readonly<{ logger?: Pick<AppLogger, "warn">; now?: () => Date }> = {}
  ) {
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async recordSignals(input: Parameters<TrustSignalSink["recordSignals"]>[0]): Promise<void> {
    if (input.signals.length === 0) return;
    // Store-review accounts: every signal is kept for review at weight 0, so it
    // never moves the score, the ladder or quarantine.
    const reviewAccount = isTrustReviewAccount(this.config, input.accountId);
    await this.store.applySignals({
      accountId: input.accountId,
      reportId: input.reportId ?? null,
      signals: input.signals.map((signal) => {
        const metadata = reviewAccount
          ? { ...signal.metadata, reviewAccount: true, originalWeight: signal.weight }
          : signal.metadata ?? {};
        const explicitKey = typeof metadata.dedupeKey === "string" ? metadata.dedupeKey : null;
        return {
          rule: signal.rule,
          weight: reviewAccount ? 0 : signal.weight,
          metadata,
          dedupeKey: explicitKey ?? (input.reportId ? `report:${input.reportId}:${signal.rule}` : null)
        };
      }),
      now: this.now(),
      tauDays: this.config.TRUST_DECAY_TAU_DAYS,
      ladder: this.ladder()
    });
  }

  // D11: familiar when any cell in the 3x3 neighborhood has enough fresh days.
  isFamiliar: FamiliarityCheck = async ({ accountId, lat, lon, now }) =>
    this.store.hasFamiliarCell(
      accountId,
      neighborhoodCells(lat, lon),
      this.config.TRUST_FAMILIAR_REGION_DAYS,
      new Date(now.getTime() - this.config.TRUST_FAMILIAR_REGION_STALE_DAYS * 24 * 60 * 60_000)
    );

  // Decayed score plus static priors, computed at read time.
  async effectiveLogodds(accountId: string): Promise<number | null> {
    const context = await this.store.loadAccountTrustContext(accountId);
    if (!context) return null;
    const now = this.now();
    const decayed = context.logoddsUpdatedAt
      ? decayLogodds(context.logodds, context.logoddsUpdatedAt, now, this.config.TRUST_DECAY_TAU_DAYS)
      : 0;
    return decayed + staticPrior({ ...context, now });
  }

  // Login hook: refresh decay and shadow tier, then apply D18 promotion.
  // Never throws; login must not depend on the trust ledger.
  async onLogin(accountId: string): Promise<void> {
    try {
      const now = this.now();
      await this.store.applySignals({
        accountId,
        reportId: null,
        signals: [],
        now,
        tauDays: this.config.TRUST_DECAY_TAU_DAYS,
        ladder: this.ladder()
      });
      const context = await this.store.loadAccountTrustContext(accountId);
      if (!context) return;
      const decayed = context.logoddsUpdatedAt
        ? decayLogodds(context.logodds, context.logoddsUpdatedAt, now, this.config.TRUST_DECAY_TAU_DAYS)
        : 0;
      const effective = decayed + staticPrior({ ...context, now });
      const promotion = trustTierPromotion(context, context.loginDays, effective, now);
      if (promotion) {
        await this.store.promoteTrustTier(accountId, promotion, now, {
          loginDays: context.loginDays,
          effective
        });
      }
    } catch (error) {
      this.logger?.warn({ err: error, accountId }, "Account trust login refresh failed");
    }
  }

  private ladder() {
    return {
      computeTiers: this.config.TRUST_QUARANTINE_MODE !== "off",
      thresholds: {
        quarantine: this.config.TRUST_QUARANTINE_THRESHOLD,
        quarantineNew: this.config.TRUST_QUARANTINE_THRESHOLD_NEW,
        warning: this.config.TRUST_WARNING_THRESHOLD
      }
    };
  }
}
