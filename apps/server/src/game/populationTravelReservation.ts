import type { GameplayAreaContract } from "@ash-atlas/shared";
import type { EquipmentChallengeProfile } from "@ash-atlas/shared";

import type { PopulationAreaOrchestrator } from "./populationAreaOrchestrator.js";
import {
  populationStageAtLeast,
  type PopulationPreparationReason,
  type PopulationZoneAuthorityFingerprint,
  type PopulationStreamingSourceKind
} from "./populationStreamingContract.js";
import {
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";

export const POPULATION_TRAVEL_RESERVATION_TTL_MS = 2 * 60_000;
export const POPULATION_TRAVEL_ADOPTION_BRIDGE_TTL_MS = 30_000;

export type PopulationTravelPreparationResult =
  | Readonly<{
      status: "ready";
      zoneIds: readonly PopulationZoneV2Id[];
      authorities: readonly PopulationZoneAuthorityFingerprint[];
    }>
  | Readonly<{
      status: "not-ready";
      reasons: readonly PopulationPreparationReason[];
      pendingZoneIds: readonly PopulationZoneV2Id[];
    }>;

type PopulationTravelReservationHooks = Pick<
  PopulationAreaOrchestrator,
  "prepareArea" | "releaseSource" | "adoptSource"
>;

export type PopulationTravelReservation = Readonly<{
  sourceId: string;
  authorityToken: string;
  area: GameplayAreaContract;
  preparation: Promise<PopulationTravelPreparationResult>;
  ensureDurable(): Promise<PopulationTravelPreparationResult>;
  ensureSimulation(
    challengeProfile: EquipmentChallengeProfile
  ): Promise<PopulationTravelPreparationResult>;
  promote(
    challengeProfile: EquipmentChallengeProfile
  ): Promise<PopulationTravelPreparationResult>;
  capturedChallengeProfile(): EquipmentChallengeProfile | null;
  matchesChallengeProfile(challengeProfile: EquipmentChallengeProfile): boolean;
  matchesAuthority(input: Readonly<{
    connectionId: string;
    connectionGeneration: number;
    expectedRelocationRevision: number;
    expectedResourceVisionRevision: number;
    expectedGameplayViewGeneration: number;
  }>): boolean;
  adopt(input: Readonly<{
    relocationRevision: number;
    resourceVisionRevision: number;
    gameplayViewGeneration: number;
    area: GameplayAreaContract;
  }>): "adopted" | "pending" | "missing" | "rejected";
  release(reason?: string): boolean;
  releaseAdopted(reason?: string): boolean;
}>;

export type PopulationTravelPreparationDisposition =
  | "retryable"
  | "terminal"
  | "invariant"
  | "unknown";

export type PopulationTravelLifecycleEvent = Readonly<{
  sourceId: string;
  authorityToken: string;
  event: "stage-attempt" | "stage-result" | "release" | "adoption";
  stage?: "DURABLE_READY" | "SIMULATION_READY";
  attempt?: number;
  durationMs?: number;
  disposition?: PopulationTravelPreparationDisposition
    | "ready"
    | "released"
    | "missing"
    | "ignored"
    | "adopted"
    | "pending"
    | "rejected";
  reasons?: readonly string[];
  reason?: string;
}>;

const RETRYABLE_PREPARATION_REASONS = new Set<PopulationPreparationReason>([
  "initial-world-generation",
  "generation-missing",
  "generation-expired",
  "replacement-required",
  "plan-pending",
  "durable-rehydration",
  "simulation-activation",
  "backpressure-retry",
  "guarded-materialization"
]);
const TERMINAL_PREPARATION_REASONS = new Set<PopulationPreparationReason>([
  "plan-terminal-failure",
  "unsupported-kind-isolated",
  "stale-authority",
  "cancelled"
]);

export function classifyPopulationTravelPreparationReasons(
  reasons: readonly PopulationPreparationReason[]
): PopulationTravelPreparationDisposition {
  if (reasons.length === 0) return "unknown";
  if (reasons.some((reason) => TERMINAL_PREPARATION_REASONS.has(reason))) {
    return "terminal";
  }
  if (reasons.some((reason) => reason === "ready")) return "invariant";
  if (reasons.some((reason) => !RETRYABLE_PREPARATION_REASONS.has(reason))) {
    return "unknown";
  }
  return "retryable";
}

export function reservePopulationTravelArea(input: Readonly<{
  hooks: PopulationTravelReservationHooks;
  area: GameplayAreaContract;
  kind: Extract<
    PopulationStreamingSourceKind,
    | "flag-travel"
    | "shrine-travel"
    | "city-travel"
    | "kingdom-travel"
    | "party-travel"
    | "separate-space-exit"
    | "administrative-relocation"
  >;
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  travelId: string;
  expectedRelocationRevision: number;
  expectedResourceVisionRevision: number;
  expectedGameplayViewGeneration: number;
  ttlMs?: number;
  signal?: AbortSignal;
  now?: number;
  diagnostic?(input: Readonly<{
    sourceId: string;
    authorityToken: string;
    stage: "DURABLE_READY" | "SIMULATION_READY";
    disposition: PopulationTravelPreparationDisposition;
    reasons: readonly string[];
  }>): void;
  lifecycle?(event: PopulationTravelLifecycleEvent): void;
}>): PopulationTravelReservation {
  const createdAtMs = input.now ?? Date.now();
  const expiresAtMs =
    createdAtMs + (input.ttlMs ?? POPULATION_TRAVEL_RESERVATION_TTL_MS);
  const sourceId = populationTravelSourceId(
    input.playerId,
    input.connectionGeneration,
    input.travelId
  );
  const authorityToken =
    `${sourceId}:${input.connectionId}`
    + `:relocation:${input.expectedRelocationRevision}`
    + `:vision:${input.expectedResourceVisionRevision}`
    + `:view:${input.expectedGameplayViewGeneration}`;
  let state: "active" | "adopted" | "released" = "active";
  let durableReady: PopulationTravelPreparationResult | null = null;
  let simulationReady: PopulationTravelPreparationResult | null = null;
  let durableFlight: Promise<PopulationTravelPreparationResult> | null = null;
  let simulationFlight: Promise<PopulationTravelPreparationResult> | null =
    null;
  let capturedProfile: EquipmentChallengeProfile | null = null;
  let capturedProfileFingerprint: string | null = null;
  let adoptedSourceId: string | null = null;
  let durableAttempts = 0;
  let simulationAttempts = 0;
  const emitLifecycle = (
    event: Omit<PopulationTravelLifecycleEvent, "sourceId" | "authorityToken">
  ): void => input.lifecycle?.({ sourceId, authorityToken, ...event });
  const release = (reason = "released"): boolean => {
    if (state !== "active") {
      emitLifecycle({
        event: "release",
        disposition: "ignored",
        reason
      });
      return false;
    }
    state = "released";
    const released = input.hooks.releaseSource(sourceId);
    emitLifecycle({
      event: "release",
      disposition: released ? "released" : "missing",
      reason
    });
    return released;
  };
  input.signal?.addEventListener(
    "abort",
    () => release("aborted"),
    { once: true }
  );
  const prepareStage = (
    targetStage: "DURABLE_READY" | "SIMULATION_READY",
    priority: 0 | 1,
    challengeProfile?: EquipmentChallengeProfile
  ): Promise<PopulationTravelPreparationResult> => {
    const attempt = targetStage === "DURABLE_READY"
      ? ++durableAttempts
      : ++simulationAttempts;
    const startedAtMs = Date.now();
    emitLifecycle({ event: "stage-attempt", stage: targetStage, attempt });
    return input.hooks.prepareArea({
      area: input.area,
      source: {
        sourceId,
        kind: input.kind,
        targetStage,
        priority,
        createdAtMs,
        playerId: input.playerId,
        connectionId: input.connectionId,
        connectionGeneration: input.connectionGeneration,
        travelId: input.travelId,
        expiresAtMs,
        authorityToken,
        ...(challengeProfile === undefined ? {} : { challengeProfile })
      },
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }).then((result): PopulationTravelPreparationResult => {
    if (state !== "active" || input.signal?.aborted) {
      release();
      return {
        status: "not-ready",
        reasons: ["cancelled"],
        pendingZoneIds: result.zoneIds
      };
    }
    const outcomeByZone = new Map(result.outcomes.map((outcome) => [
      outcome.zoneId,
      outcome
    ]));
    const pendingZoneIds = result.zoneIds.filter((zoneId) => {
      const outcome = outcomeByZone.get(zoneId);
      return outcome?.status !== "ready"
        || !populationStageAtLeast(
          outcome.completedStage,
          targetStage
        )
        || outcome.authority === null;
    });
    if (pendingZoneIds.length > 0) {
      const reasons = [...new Set(pendingZoneIds.map((zoneId) =>
        outcomeByZone.get(zoneId)?.reason ?? "plan-pending"
      ))].sort();
      const result = {
        status: "not-ready",
        reasons,
        pendingZoneIds
      } as const;
      const disposition =
        classifyPopulationTravelPreparationReasons(reasons);
      emitLifecycle({
        event: "stage-result",
        stage: targetStage,
        attempt,
        durationMs: Date.now() - startedAtMs,
        disposition,
        reasons
      });
      if (disposition !== "retryable") {
        input.diagnostic?.({
          sourceId,
          authorityToken,
          stage: targetStage,
          disposition,
          reasons
        });
        release(`preparation-${disposition}`);
      }
      return result;
    }
    emitLifecycle({
      event: "stage-result",
      stage: targetStage,
      attempt,
      durationMs: Date.now() - startedAtMs,
      disposition: "ready"
    });
    return {
      status: "ready",
      zoneIds: result.zoneIds,
      authorities: result.zoneIds.map((zoneId) =>
        outcomeByZone.get(zoneId)!.authority!
      )
    };
  }).catch((error: unknown) => {
    release("preparation-error");
    throw error;
  });
  };

  const ensureDurable = (): Promise<PopulationTravelPreparationResult> => {
    if (state !== "active") {
      return Promise.resolve(cancelledPreparationResult());
    }
    if (durableReady) return Promise.resolve(durableReady);
    if (durableFlight) return durableFlight;
    durableFlight = prepareStage("DURABLE_READY", 1).then((result) => {
      if (result.status === "ready") durableReady = result;
      else durableFlight = null;
      return result;
    }, (error: unknown) => {
      durableFlight = null;
      throw error;
    });
    return durableFlight;
  };

  const captureChallengeProfile = (
    profile: EquipmentChallengeProfile
  ): boolean => {
    const fingerprint = challengeProfileFingerprint(profile);
    if (capturedProfileFingerprint !== null) {
      return capturedProfileFingerprint === fingerprint;
    }
    capturedProfile = freezeChallengeProfile(profile);
    capturedProfileFingerprint = fingerprint;
    return true;
  };

  const ensureSimulation = (
    profile: EquipmentChallengeProfile
  ): Promise<PopulationTravelPreparationResult> => {
    if (state !== "active") {
      return Promise.resolve(cancelledPreparationResult());
    }
    if (!captureChallengeProfile(profile)) {
      input.diagnostic?.({
        sourceId,
        authorityToken,
        stage: "SIMULATION_READY",
        disposition: "terminal",
        reasons: ["stale-authority"]
      });
      release("profile-mismatch");
      return Promise.resolve({
        status: "not-ready",
        reasons: ["stale-authority"],
        pendingZoneIds: []
      });
    }
    if (simulationReady) return Promise.resolve(simulationReady);
    if (simulationFlight) return simulationFlight;
    if (!capturedProfile) {
      return Promise.resolve(cancelledPreparationResult());
    }
    const initialDurableFlight = durableFlight;
    simulationFlight = (
      initialDurableFlight ?? Promise.resolve(null)
    ).then((durable) => {
      if (state !== "active") return cancelledPreparationResult();
      if (durable?.status === "ready") durableReady = durable;
      return prepareStage("SIMULATION_READY", 0, capturedProfile!);
    }).then((result) => {
      if (result.status === "ready") {
        durableReady = result;
        simulationReady = result;
      } else {
        simulationFlight = null;
      }
      return result;
    }, (error: unknown) => {
      simulationFlight = null;
      throw error;
    });
    return simulationFlight;
  };

  const preparation = ensureDurable();

  return {
    sourceId,
    authorityToken,
    area: input.area,
    preparation,
    ensureDurable,
    ensureSimulation,
    promote: ensureSimulation,
    capturedChallengeProfile() {
      return capturedProfile;
    },
    matchesChallengeProfile(challengeProfile) {
      return capturedProfileFingerprint !== null
        && capturedProfileFingerprint === challengeProfileFingerprint(
          challengeProfile
        );
    },
    matchesAuthority(authority) {
      return authority.connectionId === input.connectionId
        && authority.connectionGeneration === input.connectionGeneration
        && authority.expectedRelocationRevision ===
          input.expectedRelocationRevision
        && authority.expectedResourceVisionRevision ===
          input.expectedResourceVisionRevision
        && authority.expectedGameplayViewGeneration ===
          input.expectedGameplayViewGeneration;
    },
    adopt(adoption) {
      if (state === "adopted") return "adopted";
      if (state === "released") return "missing";
      if (!durableReady || (capturedProfile && !simulationReady)) {
        emitLifecycle({ event: "adoption", disposition: "pending" });
        return "pending";
      }
      if (
        adoption.relocationRevision !== input.expectedRelocationRevision
        || adoption.resourceVisionRevision !==
          input.expectedResourceVisionRevision
        || adoption.gameplayViewGeneration !==
          input.expectedGameplayViewGeneration
        || adoption.gameplayViewGeneration !== adoption.area.generation
      ) {
        release("adoption-authority-rejected");
        emitLifecycle({ event: "adoption", disposition: "rejected" });
        return "rejected";
      }
      const adoptedAtMs = Date.now();
      const adoptedExpiresAtMs =
        adoptedAtMs + POPULATION_TRAVEL_ADOPTION_BRIDGE_TTL_MS;
      const adoptedIdentity =
        `${input.playerId}:${input.connectionGeneration}:`
        + `${adoption.relocationRevision}:${input.travelId}`;
      adoptedSourceId = `player-visible:${adoptedIdentity}`;
      const visibleAdoption = input.hooks.adoptSource({
        sourceId,
        adoptedSourceId,
        adoptedKind: "player-visible",
        expectedArea: adoption.area,
        expectedAuthorityToken: authorityToken,
        expectedPlayerId: input.playerId,
        expectedConnectionId: input.connectionId,
        expectedConnectionGeneration: input.connectionGeneration,
        expectedTravelId: input.travelId,
        requireReadyAuthority: true,
        expiresAtMs: adoptedExpiresAtMs
      });
      state = visibleAdoption === "adopted" ? "adopted" : "released";
      if (visibleAdoption !== "adopted") {
        input.hooks.releaseSource(sourceId);
      }
      emitLifecycle({ event: "adoption", disposition: visibleAdoption });
      return visibleAdoption;
    },
    release,
    releaseAdopted(reason = "adoption-abandoned") {
      if (state !== "adopted" || !adoptedSourceId) {
        emitLifecycle({
          event: "release",
          disposition: "ignored",
          reason
        });
        return false;
      }
      state = "released";
      const released = input.hooks.releaseSource(adoptedSourceId);
      emitLifecycle({
        event: "release",
        disposition: released ? "released" : "missing",
        reason
      });
      return released;
    }
  };
}

function challengeProfileFingerprint(profile: EquipmentChallengeProfile): string {
  return [
    profile.balanceVersion,
    profile.currentGearLevel,
    profile.unlockedGearLevel,
    profile.tier,
    profile.contributors.melee,
    profile.contributors.chest,
    profile.contributors.secondary
  ].join(":");
}

function freezeChallengeProfile(
  profile: EquipmentChallengeProfile
): EquipmentChallengeProfile {
  if (Object.isFrozen(profile) && Object.isFrozen(profile.contributors)) {
    return profile;
  }
  return Object.freeze({
    balanceVersion: profile.balanceVersion,
    currentGearLevel: profile.currentGearLevel,
    unlockedGearLevel: profile.unlockedGearLevel,
    tier: profile.tier,
    contributors: Object.freeze({
      melee: profile.contributors.melee,
      chest: profile.contributors.chest,
      secondary: profile.contributors.secondary
    })
  });
}

function cancelledPreparationResult(): PopulationTravelPreparationResult {
  return {
    status: "not-ready",
    reasons: ["cancelled"],
    pendingZoneIds: []
  };
}

export function populationTravelSourceId(
  playerId: string,
  connectionGeneration: number,
  travelId: string
): string {
  return `travel:${playerId}:${connectionGeneration}:${travelId}`;
}

type PopulationSoftTravelHooks = PopulationTravelReservationHooks & Readonly<{
  hasPreparedZones?(
    zoneIds: readonly PopulationZoneV2Id[],
    stage: "DURABLE_READY" | "SIMULATION_READY"
  ): boolean;
  canAdmitSpeculative?(): boolean;
}>;

type ManagedSoftReservation = {
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  travelId: string;
  expectedRelocationRevision: number;
  expectedResourceVisionRevision: number;
  expectedGameplayViewGeneration: number;
  area: GameplayAreaContract;
  reservation: PopulationTravelReservation;
  zoneIds: readonly PopulationZoneV2Id[];
  promotionTimer: ReturnType<typeof setTimeout> | null;
  expirationTimer: ReturnType<typeof setTimeout>;
  durableSlot: boolean;
  durableReferencesHeld: boolean;
  promotionSlot: boolean;
};

/**
 * Bounded, process-local ownership for optional PREPARE-window work.
 * Runtime/orchestrator zone flights remain the shared source of truth; this
 * coordinator only bounds speculative admission and one reservation per
 * player.
 */
export class PopulationSoftTravelReservationManager {
  private readonly reservations = new Map<string, ManagedSoftReservation>();
  private readonly durableZoneReferences = new Map<PopulationZoneV2Id, number>();
  private durableFlights = 0;
  private promotions = 0;
  private closed = false;

  constructor(
    private readonly hooks: PopulationSoftTravelHooks,
    private readonly options: Readonly<{
      durableConcurrency: number;
      promotionConcurrency: number;
      reservationTtlMs: number;
      activationLeadMs: number;
      autoPromote?: boolean;
    }>
  ) {}

  prepare(input: Readonly<{
    area: GameplayAreaContract;
    kind: Extract<
      PopulationStreamingSourceKind,
      "flag-travel" | "shrine-travel" | "city-travel" | "kingdom-travel"
    >;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    travelId: string;
    expectedRelocationRevision: number;
    expectedResourceVisionRevision: number;
    expectedGameplayViewGeneration: number;
    expectedPresentationDurationMs: number;
    challengeProfile?: EquipmentChallengeProfile;
  }>): "admitted" | "reused" | "skipped" {
    const current = this.reservations.get(input.playerId);
    if (
      current
      && current.connectionId === input.connectionId
      && current.connectionGeneration === input.connectionGeneration
      && current.travelId === input.travelId
      && current.expectedRelocationRevision ===
        input.expectedRelocationRevision
      && current.expectedResourceVisionRevision ===
        input.expectedResourceVisionRevision
      && current.expectedGameplayViewGeneration ===
        input.expectedGameplayViewGeneration
      && sameTravelArea(current.area, input.area)
    ) {
      return "reused";
    }
    this.releasePlayer(input.playerId);
    if (this.closed || this.hooks.canAdmitSpeculative?.() === false) {
      return "skipped";
    }
    const criticalFlagTravel = input.kind === "flag-travel"
      || input.kind === "kingdom-travel";
    const zoneIds = criticalFlagTravel
      ? [populationZoneV2IdForPoint(input.area.center)]
      : populationZonesV2IntersectingCircle(
          input.area.center,
          input.area.certifiedVisibleRadiusM
        );
    const resident = this.hooks.hasPreparedZones?.(
      zoneIds,
      "DURABLE_READY"
    ) === true;
    const joinsExistingFlight = zoneIds.every((zoneId) =>
      this.durableZoneReferences.has(zoneId)
    );
    const durableSlot =
      !resident && !joinsExistingFlight;
    if (
      durableSlot
      && this.durableFlights >= this.options.durableConcurrency
    ) return "skipped";
    if (durableSlot) this.durableFlights += 1;
    for (const zoneId of zoneIds) {
      this.durableZoneReferences.set(
        zoneId,
        (this.durableZoneReferences.get(zoneId) ?? 0) + 1
      );
    }
    const reservation = reservePopulationTravelArea({
      hooks: this.hooks,
      area: input.area,
      kind: input.kind,
      playerId: input.playerId,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      travelId: input.travelId,
      expectedRelocationRevision: input.expectedRelocationRevision,
      expectedResourceVisionRevision: input.expectedResourceVisionRevision,
      expectedGameplayViewGeneration: input.expectedGameplayViewGeneration,
      ttlMs: this.options.reservationTtlMs
    });
    const managed: ManagedSoftReservation = {
      playerId: input.playerId,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      travelId: input.travelId,
      area: input.area,
      expectedRelocationRevision: input.expectedRelocationRevision,
      expectedResourceVisionRevision: input.expectedResourceVisionRevision,
      expectedGameplayViewGeneration: input.expectedGameplayViewGeneration,
      reservation,
      zoneIds,
      promotionTimer: null,
      expirationTimer: setTimeout(
        () => this.releasePlayer(input.playerId, input.travelId),
        this.options.reservationTtlMs
      ),
      durableSlot,
      durableReferencesHeld: true,
      promotionSlot: false
    };
    managed.expirationTimer.unref?.();
    this.reservations.set(input.playerId, managed);
    void reservation.preparation.finally(() => {
      this.releaseDurableCapacity(managed);
    }).catch(() => undefined);
    if (input.challengeProfile) {
      this.promote(managed, input.challengeProfile);
    }
    return "admitted";
  }

  take(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    travelId: string;
    area: GameplayAreaContract;
  }>): PopulationTravelReservation | null {
    const managed = this.reservations.get(input.playerId);
    if (!managed) return null;
    this.reservations.delete(input.playerId);
    this.clearTimers(managed);
    this.releaseDurableCapacity(managed);
    this.releasePromotionCapacity(managed);
    if (
      managed.connectionId !== input.connectionId
      || managed.connectionGeneration !== input.connectionGeneration
      || managed.travelId !== input.travelId
      || !sameTravelArea(managed.area, input.area)
    ) {
      managed.reservation.release();
      return null;
    }
    return managed.reservation;
  }

  releasePlayer(playerId: string, travelId?: string): boolean {
    const managed = this.reservations.get(playerId);
    if (!managed || (travelId !== undefined && managed.travelId !== travelId)) {
      return false;
    }
    this.reservations.delete(playerId);
    this.clearTimers(managed);
    this.releaseDurableCapacity(managed);
    this.releasePromotionCapacity(managed);
    managed.reservation.release();
    return true;
  }

  releaseConnection(
    connectionId: string,
    connectionGeneration: number
  ): number {
    const playerIds = [...this.reservations.values()]
      .filter((reservation) =>
        reservation.connectionId === connectionId
        && reservation.connectionGeneration === connectionGeneration
      )
      .map((reservation) => reservation.playerId);
    for (const playerId of playerIds) this.releasePlayer(playerId);
    return playerIds.length;
  }

  snapshot(): Readonly<{
    reservations: number;
    durableFlights: number;
    promotions: number;
    referencedZones: number;
  }> {
    return {
      reservations: this.reservations.size,
      durableFlights: this.durableFlights,
      promotions: this.promotions,
      referencedZones: this.durableZoneReferences.size
    };
  }

  close(): void {
    this.closed = true;
    for (const playerId of [...this.reservations.keys()]) {
      this.releasePlayer(playerId);
    }
  }

  private promote(
    managed: ManagedSoftReservation,
    challengeProfile: EquipmentChallengeProfile
  ): void {
    if (
      this.closed
      || this.reservations.get(managed.playerId) !== managed
      || this.hooks.canAdmitSpeculative?.() === false
      || (
        this.hooks.hasPreparedZones?.(
          managed.zoneIds,
          "SIMULATION_READY"
        ) !== true
        && this.promotions >= this.options.promotionConcurrency
      )
    ) return;
    managed.promotionSlot = this.hooks.hasPreparedZones?.(
      managed.zoneIds,
      "SIMULATION_READY"
    ) !== true;
    if (managed.promotionSlot) this.promotions += 1;
    void managed.reservation.promote(challengeProfile).finally(() => {
      this.releasePromotionCapacity(managed);
    }).catch(() => undefined);
  }

  private clearTimers(managed: ManagedSoftReservation): void {
    if (managed.promotionTimer) clearTimeout(managed.promotionTimer);
    managed.promotionTimer = null;
    clearTimeout(managed.expirationTimer);
  }

  private releaseDurableCapacity(managed: ManagedSoftReservation): void {
    if (managed.durableSlot) {
      managed.durableSlot = false;
      this.durableFlights = Math.max(0, this.durableFlights - 1);
    }
    if (managed.durableReferencesHeld) {
      managed.durableReferencesHeld = false;
      for (const zoneId of managed.zoneIds) {
        const next = (this.durableZoneReferences.get(zoneId) ?? 1) - 1;
        if (next <= 0) this.durableZoneReferences.delete(zoneId);
        else this.durableZoneReferences.set(zoneId, next);
      }
    }
  }

  private releasePromotionCapacity(managed: ManagedSoftReservation): void {
    if (!managed.promotionSlot) return;
    managed.promotionSlot = false;
    this.promotions = Math.max(0, this.promotions - 1);
  }
}

function sameTravelArea(
  left: GameplayAreaContract,
  right: GameplayAreaContract
): boolean {
  return left.center.lat === right.center.lat
    && left.center.lon === right.center.lon
    && left.certifiedVisibleRadiusM === right.certifiedVisibleRadiusM
    && left.preparedRadiusM === right.preparedRadiusM
    && left.sourceType === right.sourceType
    && left.sourceId === right.sourceId
    && left.generation === right.generation;
}
