import {
  GPS_RELOCATION_COOLDOWN_MS,
  distanceMeters,
  type LatLon,
  type NativeLocationSignalsParse,
  type TrustLabAlert,
  type TrustLabDoorway,
  type TrustLabDryRunResponse,
  type TrustLabProfile,
  type TrustLabRelocation,
  type TrustLabRun,
  type TrustLabSignal,
  type TrustLabStep
} from "@ash-atlas/shared";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import {
  AltDoorwayGate,
  type AltDoorwayStore,
  type DoorwayDecision,
  type DoorwayPlayerRecord
} from "./altDoorway.js";
import { DestinationAnchoring } from "./anchoring.js";
import {
  attestAppFail,
  attestDeviceFail,
  attestPass,
  attestRevocationReason,
  attestSignal,
  attestUnavailable,
  type AttestVerdict,
  type FixAttestation
} from "./attestation/assurance.js";
import { DeviceEnvironmentService, type DeviceEnvironmentStore } from "./attestation/deviceEnvironment.js";
import { DestinationAnchorGate, type DestinationAnchorStore } from "./destinationAnchorGate.js";
import { defaultGeoZoneLookup } from "./geoZones.js";
import { HostileActionGate, type HostileGateStore, type HostilePlayerStatus } from "./hostileGate.js";
import { unavailableIpGeo, type IpGeoLookup } from "./ipGeo.js";
import type { PopulationClass } from "./populationGrid.js";
import { RelocationGate, type RelocationZoneDecision } from "./relocationGate.js";
import {
  FREE_REPICK_ACCOUNT_AGE_MS,
  SettlementService,
  applySettlementFix,
  emptySettlementState,
  isSettledNow,
  raiseSettlementDifficulty,
  revokedSettlementState,
  rollSettlementTargets,
  type RelocationExemption,
  type SettlementEvent,
  type SettlementState,
  type SettlementStore
} from "./settlement.js";
import { redZoneLockEligible } from "./trustAdminOps.js";
import { ZONE_ALERT_SEVERITY, type TrustAlertWriter } from "./trustAlerts.js";
import {
  LocationReportService,
  type FixRevocationReason,
  type LocationFixEvaluation,
  type LocationFixInput,
  type TrustSignalSink
} from "./trustService.js";
import type { LocationReportStore } from "./trustStore.js";

// Developer Trust Lab (dry run). Runs the live trust classes (RelocationGate,
// LocationReportService, SettlementService, AltDoorwayGate, HostileActionGate,
// DestinationAnchorGate, DeviceEnvironmentService) against in-memory stores
// built from a simulated profile, so the decisions are the real ones while
// nothing is written: no travel, report rows, signals, alerts, locks, cooldown
// or DeviceCheck bits. The only database access is the read-only yellow-owner
// lookup. The relocation steps follow travelHandler RELOCATE_TO_CURRENT_LOCATION;
// keep runRelocationPipeline in step with it.

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const RELOCATED_MESSAGE = "Relocated to your current location.";
const COOLDOWN_MESSAGE = "You can relocate again after the 7-day cooldown.";
const REJECTED_MESSAGE = "Your device location could not be confirmed. Try again later.";

// Fixed ids for the simulated accounts, players and flags (never real rows).
const LAB_ACCOUNT = "7a1b0000-0000-4000-8000-00000000a001";
const GUEST_ACCOUNT = "7a1b0000-0000-4000-8000-00000000a002";
const VETERAN_ACCOUNT = "7a1b0000-0000-4000-8000-00000000a003";
const LAB_PLAYER = "trust-lab-player";
const GUEST_PLAYER = "trust-lab-guest";
const VETERAN_PLAYER = "trust-lab-veteran";
const LAB_FLAG = "7a1b0000-0000-4000-8000-00000000f001";
const VETERAN_FLAG = "7a1b0000-0000-4000-8000-00000000f002";
const LAB_ATTESTATION_REF = "trust-lab-attestation-ref";
const LAB_INSTALL_ID = "trust-lab-install";
const LAB_IP = "203.0.113.10";

const IP_NETWORKS = {
  mobile: { asn: 21928, organization: "T-Mobile USA" },
  fixed: { asn: 7922, organization: "Comcast Cable" },
  vpn: { asn: 16509, organization: "Amazon.com" }
} as const;

// Doorway signals that mean "a gate would refuse this in enforce".
const GATE_SIGNAL_RULES = new Set([
  "doorway_unconfirmed",
  "doorway_no_presence",
  "linked_device",
  "linked_network",
  "hostile_unsettled",
  "hostile_shielded_target",
  "travel_unanchored_destination",
  "structure_open_unsettled"
]);

const MODES = ["off", "shadow", "enforce"] as const;

/** Every TRUST_*_MODE switched to enforce (the "everything enforce" config). */
export function enforceAllTrustModes(config: AppConfig): AppConfig {
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(config)) {
    if (/^TRUST_[A-Z_]+_MODE$/u.test(key) && (MODES as readonly unknown[]).includes(value)) next[key] = "enforce";
  }
  return next as AppConfig;
}

export function trustModes(config: AppConfig): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (/^TRUST_[A-Z_]+_MODE$/u.test(key) && typeof value === "string") modes[key] = value;
  }
  return modes;
}

// ---------------------------------------------------------------------------
// Relocation pipeline (shared by the lab and the simulated-players harness)

export type RelocationPipelineDeps = Readonly<{
  gate: Pick<RelocationGate, "checkPlatform" | "checkDestination" | "checkRefusedDestination">;
  settlement: Pick<SettlementService, "relocationExemption">;
  reports: Pick<LocationReportService, "evaluate" | "record">;
  relocationStatus(): Promise<Readonly<{ inCooldown: boolean; lastRelocatedAt: Date | null }>>;
  // The authoritative travel. False = travel failed (claims are released).
  commitTravel(exemption: RelocationExemption["kind"] | null): Promise<boolean>;
}>;

export type RelocationPipelineResult = Readonly<{
  outcome: "relocated" | "refused" | "locked";
  message: string;
  steps: TrustLabStep[];
  exemption: RelocationExemption["kind"] | null;
  cooldownConsumed: boolean;
  evaluation: LocationFixEvaluation | null;
}>;

/**
 * The trust steps of a GPS relocation in travelHandler order: phone-only,
 * cooldown + exemption, fix evaluation, alert zone, travel, report, zone
 * commit. Gate failures fail open exactly like the handler.
 */
export async function runRelocationPipeline(
  deps: RelocationPipelineDeps,
  input: Readonly<{ fix: LocationFixInput; clientPlatform: "web" | "ios" | "android" | undefined }>
): Promise<RelocationPipelineResult> {
  const steps: TrustLabStep[] = [];
  const step = (name: string, result: string, detail: string | null = null): void => {
    steps.push({ step: name, result, detail });
  };
  const { fix } = input;
  const refuse = (message: string, evaluation: LocationFixEvaluation | null, exemption: RelocationExemption["kind"] | null,
    outcome: "refused" | "locked" = "refused"): RelocationPipelineResult =>
    ({ outcome, message, steps, exemption, cooldownConsumed: false, evaluation });

  let platformRefusal: string | null = null;
  try {
    platformRefusal = await deps.gate.checkPlatform({ accountId: fix.accountId, clientPlatform: input.clientPlatform });
  } catch {
    step("Phone-only relocation", "check failed (fails open)");
  }
  if (platformRefusal) {
    step("Phone-only relocation", "refused", `platform ${input.clientPlatform ?? "unknown"}`);
    return refuse(platformRefusal, null, null);
  }
  step("Phone-only relocation", "passed", `platform ${input.clientPlatform ?? "unknown"}`);

  const status = await deps.relocationStatus();
  let exemption: RelocationExemption | null = null;
  try {
    exemption = await deps.settlement.relocationExemption({
      accountId: fix.accountId,
      lat: fix.lat,
      lon: fix.lon,
      inCooldown: status.inCooldown,
      lastRelocatedAt: status.lastRelocatedAt
    });
  } catch {
    step("Cooldown exemption", "check failed (fails open)");
  }
  if (status.inCooldown && !exemption) {
    step("7-day relocation cooldown", "refused", "in cooldown, no return-home or free re-pick exemption");
    return refuse(COOLDOWN_MESSAGE, null, null);
  }
  step(
    "7-day relocation cooldown",
    status.inCooldown ? `in cooldown, exempt (${exemption!.kind})` : exemption ? `available (${exemption.kind})` : "available",
    exemption?.kind === "return_home" ? "return home: no cooldown is consumed" : null
  );

  let evaluation: LocationFixEvaluation | null = null;
  try {
    evaluation = await deps.reports.evaluate(fix);
  } catch {
    step("Location trust", "evaluation failed (fails open)");
  }
  const record = async (outcome: "accepted" | "travel_failed"): Promise<void> => {
    if (!evaluation) return;
    try {
      await deps.reports.record(fix, evaluation, outcome);
    } catch {
      step("Location report", "could not be recorded");
    }
  };
  if (evaluation) {
    step(
      "Location trust",
      evaluation.verdict,
      [
        evaluation.reason ? `reason ${evaluation.reason}` : null,
        evaluation.bucket ? `speed ${evaluation.bucket}${evaluation.impliedKmh !== null ? ` (${Math.round(evaluation.impliedKmh)} km/h)` : ""}` : null,
        `assurance ${evaluation.assurance ?? "none"}`,
        evaluation.holdUntil ? `land-action hold ${evaluation.holdReason}` : null
      ].filter(Boolean).join(" · ")
    );
  }
  if (evaluation?.verdict === "rejected") {
    // The alert zone still runs for a rejected fix (red alert, signal, lock).
    let refused: Awaited<ReturnType<RelocationGate["checkRefusedDestination"]>> = { message: null };
    try {
      refused = await deps.gate.checkRefusedDestination({ accountId: fix.accountId, lat: fix.lat, lon: fix.lon });
    } catch {
      step("Alert zone", "check failed (fails open)");
    }
    const locked = refused.afterRefusal !== undefined;
    step("Alert zone (rejected fix)", locked ? "account locked" : refused.message ? "refused" : "recorded");
    await exemption?.release().catch(() => undefined);
    await record("travel_failed");
    if (refused.afterRefusal) void refused.afterRefusal().catch(() => undefined);
    return refuse(refused.message ?? REJECTED_MESSAGE, evaluation, null, locked ? "locked" : "refused");
  }

  let zone: RelocationZoneDecision | null = null;
  try {
    zone = await deps.gate.checkDestination({ accountId: fix.accountId, lat: fix.lat, lon: fix.lon });
  } catch {
    step("Alert zone", "check failed (fails open)");
  }
  if (zone && !zone.allowed) {
    const locked = zone.afterRefusal !== undefined;
    step("Alert zone", locked ? "refused and account locked" : "refused");
    await exemption?.release().catch(() => undefined);
    await record("travel_failed");
    if (zone.afterRefusal) void zone.afterRefusal().catch(() => undefined);
    return refuse(zone.message, evaluation, null, locked ? "locked" : "refused");
  }
  step("Alert zone", "passed");

  let travelled = false;
  try {
    travelled = await deps.commitTravel(exemption?.kind ?? null);
  } catch {
    travelled = false;
  }
  if (!travelled) {
    await exemption?.release().catch(() => undefined);
    if (zone?.allowed) await zone.release().catch(() => undefined);
    await record("travel_failed");
    step("Travel", "failed");
    return refuse("Your relocation could not be completed. Try again.", evaluation, null);
  }
  step("Travel", "committed");
  await record("accepted");
  if (zone?.allowed) await zone.committed();
  return {
    outcome: "relocated",
    message: RELOCATED_MESSAGE,
    steps,
    exemption: exemption?.kind ?? null,
    cooldownConsumed: exemption?.kind !== "return_home",
    evaluation
  };
}

// ---------------------------------------------------------------------------
// Sandbox (in-memory stores built from the profile)

type Sandbox = {
  readonly profile: TrustLabProfile;
  readonly createdAt: Date;
  settlement: SettlementState;
  freeRepickUsed: boolean;
  signals: TrustLabSignal[];
  alerts: TrustLabAlert[];
  revocations: string[];
  source: string;
  settlementEvent: SettlementEvent;
};

function labHome(profile: TrustLabProfile): LatLon | null {
  return profile.homeLat !== null && profile.homeLon !== null ? { lat: profile.homeLat, lon: profile.homeLon } : null;
}

function initialSettlement(profile: TrustLabProfile, config: AppConfig, now: Date): SettlementState {
  const home = labHome(profile);
  const base = emptySettlementState(rollSettlementTargets(config));
  const state: SettlementState = { ...base, home, homeSetAt: home ? new Date(now.getTime() - 30 * DAY_MS) : null };
  const settledAt = new Date(now.getTime() - 10 * DAY_MS);
  switch (profile.settled) {
    case "settled":
      return { ...state, settledAt, settledHome: home, settledHomeAt: home ? settledAt : null };
    case "provisional":
      return {
        ...state,
        settledAt,
        settledHome: home,
        settledHomeAt: home ? settledAt : null,
        provisionalUntil: new Date(now.getTime() + 20 * DAY_MS)
      };
    case "moved_away":
      return {
        ...state,
        settledHome: home,
        settledHomeAt: home ? settledAt : null,
        unsettledAt: new Date(now.getTime() - DAY_MS),
        unsettleReason: "moved_away"
      };
    default:
      return state;
  }
}

function describeSettlement(state: SettlementState, now: Date): string {
  if (isSettledNow(state, now)) return state.provisionalUntil ? "Settled (provisional)" : "Settled";
  if (state.settledAt && state.provisionalUntil) return "Not settled (provisional window expired)";
  if (state.unsettleReason === "review_hold") return "Settled paused for review";
  return state.unsettleReason ? `Not settled (${state.unsettleReason.replaceAll("_", " ")})` : "Not settled";
}

function labVerdict(profile: TrustLabProfile): AttestVerdict | null {
  if (profile.platform === "web" || !profile.plugin) return null;
  switch (profile.attestation) {
    case "pass":
      return attestPass("attested");
    case "basic_only":
      return attestDeviceFail("basic_integrity_only");
    case "fail":
      return attestAppFail("app_not_recognized");
    case "unavailable":
      return attestUnavailable("unavailable");
    default:
      return null;
  }
}

function labIpGeo(profile: TrustLabProfile): IpGeoLookup {
  if (profile.network === "none") return unavailableIpGeo;
  const network = IP_NETWORKS[profile.network];
  const point = profile.ipLat !== null && profile.ipLon !== null
    ? { lat: profile.ipLat, lon: profile.ipLon }
    : { lat: profile.lat, lon: profile.lon };
  const zones = defaultGeoZoneLookup;
  const [country] = [...zones.countriesForZones(zones.zonesAt(point.lat, point.lon))].sort();
  return {
    isAvailable: () => true,
    lookup: () => ({ asn: network.asn, organization: network.organization, country: country ?? null, point })
  };
}

function nativeBlock(profile: TrustLabProfile, now: Date): NativeLocationSignalsParse {
  if (profile.platform === "web") return { status: "absent", signals: null };
  if (!profile.plugin) return { status: "ok", signals: { v: 1, plugin: false } };
  return {
    status: "ok",
    signals: {
      v: 1,
      plugin: true,
      ...(profile.platform === "android" ? { mock: profile.mock } : { simulated: profile.mock }),
      ...(profile.gnssSatellitesUsed === null ? {} : { gnssSatellitesUsed: profile.gnssSatellitesUsed }),
      ...(profile.platform === "android" && profile.networkCountry ? { networkCountryIso: profile.networkCountry } : {}),
      fixTimestampMs: now.getTime()
    }
  };
}

function recordingSink(box: Sandbox): TrustSignalSink {
  return {
    async recordSignals(input) {
      for (const signal of input.signals) box.signals.push({ rule: signal.rule, weight: signal.weight, source: box.source });
    }
  };
}

function settlementStore(box: Sandbox): SettlementStore {
  const ageMs = (now: Date) => now.getTime() - box.createdAt.getTime();
  // Mirrors FREE_REPICK_ELIGIBLE_SQL (settlement.ts): young account, exactly one applied relocation, unused.
  const repickEligible = (now: Date) =>
    !box.freeRepickUsed && ageMs(now) < FREE_REPICK_ACCOUNT_AGE_MS && box.profile.priorRelocations === 1;
  return {
    isSettled: async (_accountId, now) => isSettledNow(box.settlement, now),
    settledHome: async () => box.settlement.settledHome,
    revoke: async (_accountId, reason, now, baseTargets) => {
      const wasSettled = isSettledNow(box.settlement, now);
      box.settlement = revokedSettlementState(box.settlement, reason, now, baseTargets);
      return { wasSettled, playerIds: [LAB_PLAYER] };
    },
    adminSettle: async () => null,
    expireProvisional: async () => [],
    claimFreeRepick: async (_accountId, now) => {
      if (!repickEligible(now)) return false;
      box.freeRepickUsed = true;
      return true;
    },
    freeRepickEligible: async (_accountId, now) => repickEligible(now),
    raiseDifficulty: async (_accountId, difficulty) => {
      const next = raiseSettlementDifficulty(box.settlement, difficulty);
      if (next) box.settlement = next;
      return next !== null;
    },
    releaseFreeRepick: async () => {
      box.freeRepickUsed = false;
    },
    suspendForReview: async (_accountId, _alertId, now) => {
      if (!isSettledNow(box.settlement, now)) return null;
      box.settlement = {
        ...box.settlement,
        settledAt: null,
        provisionalUntil: null,
        unsettledAt: now,
        unsettleReason: "review_hold"
      };
      return { playerIds: [LAB_PLAYER] };
    },
    releaseReviewHold: async () => false
  };
}

function locationStore(box: Sandbox, now: Date): LocationReportStore {
  const home = labHome(box.profile);
  const minutes = box.profile.lastFixMinutesAgo;
  const lastFix = home && minutes !== null
    ? { lat: home.lat, lon: home.lon, accuracyM: 20, at: new Date(now.getTime() - minutes * MINUTE_MS) }
    : null;
  const applySettlement = (update: Parameters<LocationReportStore["recordLocationReport"]>[2]): SettlementEvent => {
    if (!update) return null;
    const transition = applySettlementFix(box.settlement, update, box.createdAt);
    if (transition.changed) box.settlement = transition.next;
    box.settlementEvent = transition.event;
    return transition.event;
  };
  return {
    loadLocationContext: async (accountId) => ({
      state: {
        accountId,
        lastSeq: 1,
        lastAcceptedReportId: null,
        lastFix,
        lastFixPassive: true,
        lastStoredFix: lastFix,
        lastLandAction: null,
        landActionHoldUntil: null,
        landActionHoldReason: null,
        relocations7dFar: 0,
        home: home ? { ...home, source: "relocation" } : null
      },
      farRelocationsSince: 0
    }),
    recordLocationReport: async (row, _accepted, settlement) => {
      const event = applySettlement(settlement);
      return { reportId: row.id, seq: 2, ...(event ? { settlementEvent: event } : {}) };
    },
    updateLastFix: async (fix) => applySettlement(fix.settlement ?? null),
    countHardMismatchFixes: async () => ({ ip: box.profile.hardMismatchFixes24h, carrier: box.profile.hardMismatchFixes24h }),
    deleteLocationReportsBefore: async () => 0
  };
}

function alertWriter(box: Sandbox): TrustAlertWriter {
  return {
    fileRedAlert: async ({ now, severity: fixed }) => {
      if (box.profile.pendingRedAlert) return { created: false, alertId: "trust-lab-pending-red-alert", severity: fixed ?? 3 };
      // trustAlerts.ts: red alerts of accounts younger than 24 h are severity 4.
      const severity = fixed ?? (now.getTime() - box.createdAt.getTime() < DAY_MS ? 4 : 3);
      box.alerts.push({ kind: "zone_red", status: "pending", severity });
      return { created: true, alertId: "trust-lab-red-alert", severity };
    },
    fileZoneAlert: async ({ kind }) => {
      box.alerts.push({ kind, status: "pending", severity: ZONE_ALERT_SEVERITY[kind] });
      return { created: true };
    },
    consumeRedAllowance: async () => null,
    restoreRedAllowance: async () => undefined
  };
}

export type TrustLabDependencies = Readonly<{
  config: AppConfig;
  classify(lat: number, lon: number): PopulationClass;
  zoneGridLoaded(): boolean;
  // Read-only: other accounts' territory near the point (the live yellow lookup).
  yellowOwners(lat: number, lon: number, radiusKm: number, excludeAccountId: string, limit: number): Promise<string[]>;
  // Read-only: other accounts' kingdoms near the point.
  kingdomOwners?(lat: number, lon: number, radiusKm: number, excludeAccountId: string, limit: number): Promise<string[]>;
  logger?: Pick<AppLogger, "warn" | "info"> | undefined;
  now?: () => Date;
}>;

export class TrustLab {
  private readonly now: () => Date;

  constructor(private readonly deps: TrustLabDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async dryRun(profile: TrustLabProfile): Promise<TrustLabDryRunResponse> {
    const now = this.now();
    const zone = this.deps.classify(profile.lat, profile.lon);
    const owners = await this.deps.yellowOwners(
      profile.lat, profile.lon, this.deps.config.TRUST_KINGDOM_ALERT_RADIUS_KM, LAB_ACCOUNT, 25
    ).catch(() => []);
    const kingdomRadiusKm = this.deps.config.TRUST_KINGDOM_PROXIMITY_RED_KM;
    const kingdoms = this.deps.kingdomOwners && kingdomRadiusKm > 0
      ? await this.deps.kingdomOwners(profile.lat, profile.lon, kingdomRadiusKm, LAB_ACCOUNT, 25).catch(() => [])
      : [];
    const runs: TrustLabRun[] = [];
    for (const [label, config] of [
      ["current", this.deps.config],
      ["enforce", enforceAllTrustModes(this.deps.config)]
    ] as const) {
      runs.push(await this.run(label, config, profile, now));
    }
    return {
      zone,
      zoneGridLoaded: this.deps.zoneGridLoaded(),
      yellowOwners: owners.length,
      kingdomOwners: kingdoms.length,
      runs,
      generatedAt: now.toISOString()
    };
  }

  private async run(
    label: "current" | "enforce",
    config: AppConfig,
    profile: TrustLabProfile,
    now: Date
  ): Promise<TrustLabRun> {
    const createdAt = new Date(now.getTime() - profile.accountAgeDays * DAY_MS);
    const box: Sandbox = {
      profile,
      createdAt,
      settlement: initialSettlement(profile, config, now),
      freeRepickUsed: false,
      signals: [],
      alerts: [],
      revocations: [],
      source: "attestation",
      settlementEvent: null
    };
    const settledBefore = describeSettlement(box.settlement, now);
    const sink = recordingSink(box);
    const clock = () => now;
    const settlement = new SettlementService(settlementStore(box), config, { sink, now: clock });
    const revoke = async (accountId: string, reason: FixRevocationReason | "attest_app_fail", metadata?: Record<string, unknown>) => {
      box.revocations.push(reason);
      await settlement.revoke(accountId, reason, metadata);
    };

    // Attestation request (per relocation, fix-bound): verdict signals, environment
    // signals, and revocation in TRUST_ATTESTATION_MODE=enforce (attestationService).
    const verdict = labVerdict(profile);
    if (verdict && config.TRUST_ATTESTATION_MODE !== "off" && profile.attestation !== "none") {
      await sink.recordSignals({
        accountId: LAB_ACCOUNT,
        signals: verdict.signals.map((rule) => attestSignal(rule, LAB_ACCOUNT, now, "trust-lab"))
      });
      const revocation = attestRevocationReason(verdict.signals);
      if (revocation && config.TRUST_ATTESTATION_MODE === "enforce") await revoke(LAB_ACCOUNT, revocation, { source: "trust_lab" });
    }
    if (profile.platform !== "web" && profile.plugin) {
      await new DeviceEnvironmentService(this.environmentStore(profile), config, { sink, now: clock }).record({
        accountId: LAB_ACCOUNT,
        attestationId: null,
        platform: profile.platform,
        environment: {
          v: 1,
          installId: LAB_INSTALL_ID,
          ...(profile.emulator ? { emulatorHints: ["qemu_props"] } : {}),
          ...(profile.root ? { rootHints: ["su_binary"] } : {}),
          vpnActive: profile.vpnActive,
          ...(profile.simCountry ? { simCountryIso: profile.simCountry } : {}),
          ...(profile.networkCountry ? { networkCountryIso: profile.networkCountry } : {}),
          ...(profile.deviceTimeZone ? { timeZone: profile.deviceTimeZone } : {})
        },
        fix: { lat: profile.lat, lon: profile.lon }
      });
    }

    box.source = "relocation";
    const fixAttestation: FixAttestation | null = verdict && profile.attestation !== "none"
      ? {
          id: "trust-lab-attestation",
          method: profile.platform === "android" ? "play_integrity" : "app_attest",
          outcome: verdict.outcome,
          assurance: verdict.assurance,
          tamper: false
        }
      : null;
    const reports = new LocationReportService(locationStore(box, now), config, {
      sink,
      now: clock,
      familiarity: async ({ lat, lon }) => {
        const home = labHome(profile);
        return home !== null && distanceMeters(home, { lat, lon }) <= config.TRUST_SETTLE_RADIUS_KM * 1000;
      },
      settlement: {
        rules: () => settlement.rules(),
        rollTargets: () => settlement.rollTargets(),
        revoke: (accountId, reason, metadata) => revoke(accountId, reason, metadata)
      },
      ipGeo: labIpGeo(profile),
      attestations: { resolve: async () => fixAttestation }
    });
    const gate = new RelocationGate({
      config,
      classify: this.deps.classify,
      yellowOwners: (lat, lon, radiusKm, _exclude, limit) =>
        this.deps.yellowOwners(lat, lon, radiusKm, LAB_ACCOUNT, limit),
      ...(this.deps.kingdomOwners
        ? {
            kingdomOwners: (lat: number, lon: number, radiusKm: number, _exclude: string, limit: number) =>
              this.deps.kingdomOwners!(lat, lon, radiusKm, LAB_ACCOUNT, limit)
          }
        : {}),
      alerts: alertWriter(box),
      redZoneLock: {
        lockNewAccountForRedZone: async (input) => {
          const ageMs = input.now.getTime() - createdAt.getTime();
          if (!redZoneLockEligible({ ageMs, settled: box.settlement.settledAt !== null, maxAgeDays: input.maxAgeDays })) {
            return null;
          }
          box.alerts.push({ kind: "zone_red", status: "locked", severity: 4 });
          return {
            alertId: "trust-lab-locked-alert",
            accountAgeHours: Math.floor((ageMs / HOUR_MS) * 10) / 10,
            closeConnections: async () => undefined
          };
        }
      },
      settlement,
      sink,
      now: clock
    });
    const lastRelocatedAt = profile.lastRelocatedHoursAgo === null
      ? null
      : new Date(now.getTime() - profile.lastRelocatedHoursAgo * HOUR_MS);
    const pipeline = await runRelocationPipeline({
      gate,
      settlement,
      reports,
      relocationStatus: async () => ({
        lastRelocatedAt,
        inCooldown: lastRelocatedAt !== null && lastRelocatedAt.getTime() + GPS_RELOCATION_COOLDOWN_MS > now.getTime()
      }),
      commitTravel: async () => true
    }, {
      clientPlatform: profile.platform,
      fix: {
        accountId: LAB_ACCOUNT,
        playerId: LAB_PLAYER,
        source: "relocation",
        requestId: "trust-lab",
        lat: profile.lat,
        lon: profile.lon,
        accuracyM: profile.accuracyM,
        clientPlatform: profile.platform,
        deviceInstallationId: null,
        networkHash: null,
        networkPrefixHash: null,
        ...(profile.deviceTimeZone ? { deviceTimeZone: profile.deviceTimeZone } : {}),
        clientIp: profile.network === "none" ? null : LAB_IP,
        ...(profile.platform === "android" && profile.networkCountry ? { networkCountryIso: profile.networkCountry } : {}),
        sessionId: "trust-lab-session",
        native: nativeBlock(profile, now),
        ...(fixAttestation ? { attestationRef: LAB_ATTESTATION_REF } : {}),
        avatarPosition: labHome(profile),
        now
      }
    });
    const relocation: TrustLabRelocation = {
      outcome: pipeline.outcome,
      playerMessage: pipeline.message,
      steps: pipeline.steps,
      signals: [...box.signals],
      alerts: [...box.alerts],
      revocations: [...box.revocations],
      cooldown: { exemption: pipeline.exemption, consumed: pipeline.cooldownConsumed },
      verdict: pipeline.evaluation?.verdict ?? null,
      assurance: pipeline.evaluation?.assurance ?? null,
      holdMinutes: pipeline.evaluation?.holdUntil
        ? Math.round((pipeline.evaluation.holdUntil.getTime() - now.getTime()) / MINUTE_MS)
        : null,
      settledBefore,
      settledAfter: describeSettlement(box.settlement, now),
      settlementEvent: box.settlementEvent,
      difficulty: box.settlement.difficulty
    };
    const doorways = await this.doorways(config, profile, box, pipeline, now);
    return { config: label, modes: trustModes(config), relocation, doorways };
  }

  private environmentStore(profile: TrustLabProfile): DeviceEnvironmentStore {
    return {
      lastFix: async () => null,
      insertReport: async () => undefined,
      installAccountCount: async () => profile.installAccounts,
      saveDeviceCheckToken: async () => undefined,
      loadDeviceCheckToken: async () => null,
      cleanup: async () => 0
    };
  }

  // Doorways one hour after a committed relocation (the always-on party cooldown
  // has passed), or for the profile as entered when the relocation was refused.
  private async doorways(
    config: AppConfig,
    profile: TrustLabProfile,
    box: Sandbox,
    pipeline: RelocationPipelineResult,
    relocationAt: Date
  ): Promise<TrustLabDoorway[]> {
    const relocated = pipeline.outcome === "relocated";
    const now = relocated ? new Date(relocationAt.getTime() + HOUR_MS + MINUTE_MS) : relocationAt;
    const clock = () => now;
    const point = { lat: profile.lat, lon: profile.lon };
    const avatar = relocated ? point : labHome(profile) ?? point;
    const settled = isSettledNow(box.settlement, now);
    const signals: TrustLabSignal[] = [];
    const sink: TrustSignalSink = {
      async recordSignals(input) {
        for (const signal of input.signals) signals.push({ rule: signal.rule, weight: signal.weight, source: "doorway" });
      }
    };
    const lastRelocatedAt = relocated
      ? relocationAt
      : profile.lastRelocatedHoursAgo === null ? null : new Date(now.getTime() - profile.lastRelocatedHoursAgo * HOUR_MS);
    const host: DoorwayPlayerRecord = {
      accountId: LAB_ACCOUNT,
      accountCreatedAt: box.createdAt,
      devProfile: false,
      settled,
      settledHome: box.settlement.settledHome,
      lastFix: { ...point, at: new Date(now.getTime() - MINUTE_MS) },
      lastFixAssurance: pipeline.evaluation?.assurance ?? (profile.platform === "web" ? "web" : "native_legacy"),
      lastRelocatedAt
    };
    const guest: DoorwayPlayerRecord = {
      accountId: GUEST_ACCOUNT,
      accountCreatedAt: new Date(now.getTime() - 200 * DAY_MS),
      devProfile: false,
      settled: true,
      settledHome: null,
      lastFix: null,
      lastFixAssurance: null,
      lastRelocatedAt: null
    };
    const doorwayStore = (sameDevice: boolean): AltDoorwayStore => ({
      loadDoorwayPlayer: async (playerId) => (playerId === LAB_PLAYER ? host : playerId === GUEST_PLAYER ? guest : null),
      ownedDestinationPosition: async (playerId, destination) =>
        playerId === LAB_PLAYER && destination.id === LAB_FLAG ? point : null,
      linkedAccounts: async () => ({ device: sameDevice, network: false }),
      loadArrivalHold: async () => null,
      setArrivalHold: async () => undefined,
      playerOwnsFlag: async (playerId, flagId) => playerId === LAB_PLAYER && flagId === LAB_FLAG,
      isDevProfile: async () => false
    });
    const status = (playerId: string): HostilePlayerStatus | null => {
      if (playerId === LAB_PLAYER) {
        return {
          accountId: LAB_ACCOUNT,
          settledAt: box.settlement.settledAt,
          provisionalUntil: box.settlement.provisionalUntil,
          devProfile: false
        };
      }
      if (playerId === VETERAN_PLAYER || playerId === GUEST_PLAYER) {
        return {
          accountId: playerId === GUEST_PLAYER ? GUEST_ACCOUNT : VETERAN_ACCOUNT,
          settledAt: new Date(now.getTime() - 100 * DAY_MS),
          provisionalUntil: null,
          devProfile: false
        };
      }
      return null;
    };
    const hostileStore: HostileGateStore = {
      loadPlayerStatus: async (playerId) => status(playerId),
      playerOwnsFlag: async (playerId, flagId) => playerId === LAB_PLAYER && flagId === LAB_FLAG,
      militaryGroupUnitType: async () => null,
      siegeThreatensOwnFlag: async () => false
    };
    const anchorStore: DestinationAnchorStore = {
      resolveDestination: async (ref) => ref.kind === "flag" && ref.id === LAB_FLAG
        ? {
            kind: "flag",
            id: LAB_FLAG,
            anchorPlayerId: LAB_PLAYER,
            anchorAccountId: LAB_ACCOUNT,
            ownerPlayerId: LAB_PLAYER,
            anchorDevProfile: false,
            lat: point.lat,
            lon: point.lon,
            openToOthers: true,
            personalFlag: true
          }
        : null,
      loadPlayerStatus: async (playerId) => status(playerId),
      revertOpenStructures: async () => ({ harvestAssets: 0 }),
      countOpenStructures: async () => ({ harvestAssets: 0 })
    };
    const options = { sink, now: clock, devProfilesExempt: () => false };
    const doorway = new AltDoorwayGate(doorwayStore(false), config, options);
    const sharedDevice = new AltDoorwayGate(doorwayStore(true), config, options);
    const hostile = new HostileActionGate(hostileStore, config, options);
    const anchors = new DestinationAnchorGate(
      anchorStore,
      new DestinationAnchoring({
        loadOwnerSettlement: async () => ({
          settledAt: box.settlement.settledAt,
          provisionalUntil: box.settlement.provisionalUntil,
          settledHome: box.settlement.settledHome
        })
      }, config, clock),
      config,
      options
    );

    const results: TrustLabDoorway[] = [];
    const check = async (
      action: string,
      run: () => Promise<DoorwayDecision | Readonly<{ code: string; message: string }> | null | Readonly<{ allowed: true }>>
    ): Promise<void> => {
      const start = signals.length;
      const decision = await run();
      // Signals are recorded without being awaited; let them land.
      await Promise.resolve();
      const fired = signals.slice(start);
      const refusal = decision === null
        ? null
        : "allowed" in decision
          ? (decision.allowed ? null : decision)
          : decision;
      results.push({
        action,
        allowed: refusal === null,
        shadowOnly: refusal === null && fired.some((signal) => GATE_SIGNAL_RULES.has(signal.rule)),
        code: refusal?.code ?? null,
        message: refusal?.message ?? null,
        signals: fired
      });
    };
    const invite = (gate: AltDoorwayGate, destination: Parameters<AltDoorwayGate["check"]>[0]["destination"]) =>
      gate.check({
        kind: "invite",
        hostPlayerId: LAB_PLAYER,
        guestPlayerId: GUEST_PLAYER,
        hostPosition: avatar,
        destination,
        hostClientPlatform: profile.platform
      });
    await check("Send a Travel Invite (open world)", () => invite(doorway, { kind: "world" }));
    await check("Send a Travel Invite to my flag here", () => invite(doorway, { kind: "flag", id: LAB_FLAG }));
    await check("Invite an account on the same device", () => invite(sharedDevice, { kind: "world" }));
    await check("Lead Party Travel", () => doorway.check({
      kind: "party_manual",
      hostPlayerId: LAB_PLAYER,
      guestPlayerId: GUEST_PLAYER,
      hostPosition: avatar,
      destination: { kind: "world" }
    }));
    await check("Found a city", () => anchors.checkOpenStructure({ playerId: LAB_PLAYER, kind: "city_found" }));
    await check("Others travel to my public flag here", () => anchors.checkTravel({
      travellerPlayerId: GUEST_PLAYER,
      kind: "flag",
      destination: { kind: "flag", id: LAB_FLAG }
    }));
    await check("Burn or attack another player's flag", () => hostile.checkFlagRaid({
      playerId: LAB_PLAYER,
      flagId: VETERAN_FLAG,
      action: "flag_attack"
    }));
    await check("Attack a Settled player", () => hostile.checkPvp({ attackerPlayerId: LAB_PLAYER, targetPlayerId: VETERAN_PLAYER }));
    await check("A Settled player attacks me", () => hostile.checkPvp({ attackerPlayerId: VETERAN_PLAYER, targetPlayerId: LAB_PLAYER }));
    return results;
  }
}
