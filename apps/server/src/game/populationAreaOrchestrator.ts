import {
  assertPopulationAreaPreparationRequest,
  populationStageAtLeast,
  type PopulationAreaPreparationRequest,
  type PopulationZoneAuthorityFingerprint,
  type PopulationZonePreparationOutcome
} from "./populationStreamingContract.js";
import type { PopulationZoneV2Id } from "./populationZonesV2Geometry.js";
import {
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";
import type {
  PopulationConnectionRepublishResult,
  PopulationRelocationHandle,
  PopulationV2HarvestedTreeTransition,
  PopulationZoneV2RuntimeTrigger,
  PopulationZonesV2ActivationDelta,
  PopulationZonesV2Runtime
} from "./populationZonesV2Runtime.js";

/**
 * Authoritative process-local boundary for population preparation,
 * connection publication, and runtime ownership.
 *
 * Zone work intentionally enters PopulationZonesV2Runtime so foreground
 * relocation, speculative preparation, and recovery share its keyed
 * activation queue instead of calling planner/backend services independently.
 */
export class PopulationAreaOrchestrator {
  private readonly expirationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly sourceRecords = new Map<string, Readonly<{
    request: PopulationAreaPreparationRequest;
    authorities: readonly PopulationZoneAuthorityFingerprint[] | null;
  }>>();

  constructor(
    private readonly runtime: PopulationZonesV2Runtime,
    private readonly options: Readonly<{
      speculativePressureElevated?(): boolean;
    }> = {}
  ) {}

  async prepareArea(
    request: PopulationAreaPreparationRequest
  ): Promise<Readonly<{
    sourceId: string;
    zoneIds: readonly PopulationZoneV2Id[];
    outcomes: readonly PopulationZonePreparationOutcome[];
  }>> {
    assertPopulationAreaPreparationRequest(request);
    if (request.source.targetStage === "PUBLISHED") {
      throw new Error(
        "published population preparation requires authoritative relocation"
      );
    }
    const startedAt = performance.now();
    const targetStage = request.source.targetStage;
    const visibleOnlyTravel = isTravelSource(request.source.kind);
    const radiusM = targetStage === "SIMULATION_READY" || visibleOnlyTravel
      ? request.area.certifiedVisibleRadiusM
      : request.area.preparedRadiusM;
    const areaZoneIds = populationZonesV2IntersectingCircle(
      request.area.center,
      radiusM
    );
    const criticalFlagTravel = request.source.kind === "flag-travel"
      || request.source.kind === "kingdom-travel";
    const zoneIds = criticalFlagTravel
      ? [populationZoneV2IdForPoint(request.area.center)]
      : areaZoneIds;
    const previous = this.sourceRecords.get(request.source.sourceId);
    const currentAuthorities = previous?.authorities
      ? this.runtime.streamingSourceAuthorities(request.source.sourceId)
      : null;
    const preserveDurableLease = visibleOnlyTravel
      && targetStage === "SIMULATION_READY"
      && previous?.request.source.targetStage === "DURABLE_READY"
      && previous.authorities !== null
      && !previous.request.signal?.aborted
      && !request.signal?.aborted
      && (previous.request.source.expiresAtMs === undefined
        || previous.request.source.expiresAtMs > Date.now())
      && currentAuthorities !== null
      && sameArea(previous.request.area, request.area)
      && sameSourceOwner(previous.request.source, request.source)
      && sameAuthorities(previous.authorities, currentAuthorities);
    this.runtime.retainStreamingSource({
      sourceId: request.source.sourceId,
      zoneIds,
      targetStage: preserveDurableLease
        ? "DURABLE_READY"
        : visibleOnlyTravel ? "PLAN_READY" : targetStage
    });
    this.sourceRecords.set(request.source.sourceId, {
      request,
      authorities: null
    });
    this.armExpiration(
      request.source.sourceId,
      request.source.expiresAtMs
    );
    try {
      const activations = await this.runtime.prepareZones({
        zoneIds,
        trigger: triggerForSource(request.source.kind),
        priority: criticalFlagTravel
          ? 0
          : request.source.priority,
        targetStage,
        activateRuntime: targetStage === "SIMULATION_READY",
        ...(request.source.challengeProfile === undefined
          ? {}
          : { challengeProfile: request.source.challengeProfile }),
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      const byZone = new Map(activations.map((activation) => [
        activation.zoneId,
        activation
      ]));
      const durationMs = performance.now() - startedAt;
      if (request.signal?.aborted) {
        this.releaseSource(request.source.sourceId);
      } else {
        const authorities = zoneIds
          .map((zoneId) => byZone.get(zoneId)?.authority ?? null);
        const record = this.sourceRecords.get(request.source.sourceId);
        if (
          record
          && record.request === request
          && (
            !visibleOnlyTravel
            || activations.every((activation) =>
              populationStageAtLeast(
                activation.completedStage ?? null,
                targetStage
              )
            )
          )
          && authorities.every(
            (authority): authority is PopulationZoneAuthorityFingerprint =>
              authority !== null
          )
        ) {
          if (visibleOnlyTravel) {
            this.runtime.retainStreamingSource({
              sourceId: request.source.sourceId,
              zoneIds,
              targetStage
            });
          }
          this.sourceRecords.set(request.source.sourceId, {
            request: record.request,
            authorities
          });
        }
      }
      return {
        sourceId: request.source.sourceId,
        zoneIds,
        outcomes: zoneIds.map((zoneId) => {
          const activation = byZone.get(zoneId);
          const completedStage = activation?.completedStage ?? null;
          const ready = populationStageAtLeast(completedStage, targetStage);
          return {
            zoneId,
            requestedStage: targetStage,
            completedStage,
            status: request.signal?.aborted
              ? "cancelled"
              : ready
                ? "ready"
                : activation?.reason === "backpressure-retry"
                  ? "deferred"
                  : "pending",
            reason: activation?.reason ?? (
              request.signal?.aborted ? "backpressure-retry" : "plan-pending"
            ),
            authority: activation?.authority ?? null,
            durationMs
          };
        })
      };
    } catch (error) {
      this.releaseSource(request.source.sourceId);
      throw error;
    }
  }

  releaseSource(sourceId: string): boolean {
    const timer = this.expirationTimers.get(sourceId);
    if (timer) clearTimeout(timer);
    this.expirationTimers.delete(sourceId);
    this.sourceRecords.delete(sourceId);
    return this.runtime.releaseStreamingSource(sourceId);
  }

  hasPreparedZones(
    zoneIds: readonly PopulationZoneV2Id[],
    stage: "DURABLE_READY" | "SIMULATION_READY"
  ): boolean {
    return this.runtime.hasPreparedZones(zoneIds, stage);
  }

  canAdmitSpeculative(): boolean {
    return this.options.speculativePressureElevated?.() !== true;
  }

  adoptSource(input: Readonly<{
    sourceId: string;
    adoptedSourceId: string;
    adoptedKind: PopulationAreaPreparationRequest["source"]["kind"];
    expectedArea: PopulationAreaPreparationRequest["area"];
    expectedAuthorityToken: string;
    expectedPlayerId?: string;
    expectedConnectionId?: string;
    expectedConnectionGeneration?: number;
    expectedBuildId?: string;
    expectedTravelId?: string;
    requireReadyAuthority?: boolean;
    expiresAtMs?: number;
  }>): "adopted" | "missing" | "rejected" {
    const record = this.sourceRecords.get(input.sourceId);
    if (!record) return "missing";
    const request = record.request;
    const currentAuthorities = input.requireReadyAuthority
      ? this.runtime.streamingSourceAuthorities(input.sourceId)
      : null;
    if (
      request.source.authorityToken !== input.expectedAuthorityToken
      || request.source.playerId !== input.expectedPlayerId
      || request.source.connectionId !== input.expectedConnectionId
      || request.source.connectionGeneration !== input.expectedConnectionGeneration
      || request.source.buildId !== input.expectedBuildId
      || request.source.travelId !== input.expectedTravelId
      || !sameArea(request.area, input.expectedArea)
      || this.sourceRecords.has(input.adoptedSourceId)
      || (
        input.requireReadyAuthority === true
        && (
          record.authorities === null
          || currentAuthorities === null
          || !sameAuthorities(record.authorities, currentAuthorities)
        )
      )
    ) return "rejected";
    if (!this.runtime.adoptStreamingSource(
      input.sourceId,
      input.adoptedSourceId
    )) return "rejected";
    const priorTimer = this.expirationTimers.get(input.sourceId);
    if (priorTimer) clearTimeout(priorTimer);
    this.expirationTimers.delete(input.sourceId);
    this.sourceRecords.delete(input.sourceId);
    this.sourceRecords.set(input.adoptedSourceId, {
      ...record,
      request: {
        ...request,
        source: {
          ...request.source,
          sourceId: input.adoptedSourceId,
          kind: input.adoptedKind,
          ...(input.expiresAtMs === undefined
            ? {}
            : { expiresAtMs: input.expiresAtMs })
        }
      }
    });
    this.armExpiration(input.adoptedSourceId, input.expiresAtMs);
    return "adopted";
  }

  startRelocation(
    input: Parameters<PopulationZonesV2Runtime["startRelocation"]>[0]
  ): PopulationRelocationHandle {
    return this.runtime.startRelocation(input);
  }

  republishConnection(
    input: Parameters<PopulationZonesV2Runtime["republishConnection"]>[0]
  ): PopulationConnectionRepublishResult {
    return this.runtime.republishConnection(input);
  }

  releaseConnection(
    ...input: Parameters<PopulationZonesV2Runtime["releaseConnection"]>
  ): void {
    this.runtime.releaseConnection(...input);
  }

  removeHarvestedTree(input: PopulationV2HarvestedTreeTransition): void {
    this.runtime.removeHarvestedTree(input);
  }

  onDelta(
    listener: (delta: PopulationZonesV2ActivationDelta) => void | Promise<void>
  ): () => void {
    return this.runtime.onDelta(listener);
  }

  close(): void {
    for (const timer of this.expirationTimers.values()) clearTimeout(timer);
    this.expirationTimers.clear();
    for (const sourceId of this.sourceRecords.keys()) {
      this.runtime.releaseStreamingSource(sourceId);
    }
    this.sourceRecords.clear();
  }

  private armExpiration(
    sourceId: string,
    expiresAtMs: number | undefined
  ): void {
    const existing = this.expirationTimers.get(sourceId);
    if (existing) clearTimeout(existing);
    this.expirationTimers.delete(sourceId);
    if (expiresAtMs === undefined) return;
    const timer = setTimeout(() => {
      this.expirationTimers.delete(sourceId);
      this.sourceRecords.delete(sourceId);
      this.runtime.releaseStreamingSource(sourceId);
    }, Math.max(0, expiresAtMs - Date.now()));
    timer.unref?.();
    this.expirationTimers.set(sourceId, timer);
  }
}

function isTravelSource(
  kind: PopulationAreaPreparationRequest["source"]["kind"]
): boolean {
  return kind === "flag-travel"
    || kind === "shrine-travel"
    || kind === "city-travel"
    || kind === "kingdom-travel"
    || kind === "party-travel"
    || kind === "separate-space-exit"
    || kind === "administrative-relocation";
}

function sameSourceOwner(
  left: PopulationAreaPreparationRequest["source"],
  right: PopulationAreaPreparationRequest["source"]
): boolean {
  return left.sourceId === right.sourceId
    && left.kind === right.kind
    && left.authorityToken === right.authorityToken
    && left.playerId === right.playerId
    && left.connectionId === right.connectionId
    && left.connectionGeneration === right.connectionGeneration
    && left.requestId === right.requestId
    && left.buildId === right.buildId
    && left.travelId === right.travelId;
}

function sameArea(
  left: PopulationAreaPreparationRequest["area"],
  right: PopulationAreaPreparationRequest["area"]
): boolean {
  return left.center.lat === right.center.lat
    && left.center.lon === right.center.lon
    && left.certifiedVisibleRadiusM === right.certifiedVisibleRadiusM
    && left.preparedRadiusM === right.preparedRadiusM
    && left.sourceType === right.sourceType
    && left.sourceId === right.sourceId
    && left.generation === right.generation;
}

function sameAuthorities(
  left: readonly PopulationZoneAuthorityFingerprint[],
  right: readonly PopulationZoneAuthorityFingerprint[]
): boolean {
  if (left.length !== right.length) return false;
  const byZone = (authorities: readonly PopulationZoneAuthorityFingerprint[]) =>
    [...authorities].sort((first, second) =>
      first.zoneId.localeCompare(second.zoneId)
    );
  const sortedLeft = byZone(left);
  const sortedRight = byZone(right);
  return sortedLeft.every((authority, index) => {
    const candidate = sortedRight[index];
    return candidate !== undefined
      && authority.zoneId === candidate.zoneId
      && authority.selectedPlanId === candidate.selectedPlanId
      && authority.generationId === candidate.generationId
      && authority.cutoverRevision === candidate.cutoverRevision
      && authority.commonSchemaRevision === candidate.commonSchemaRevision
      && authority.registryRevision === candidate.registryRevision
      && authority.stateRevisionFingerprint ===
        candidate.stateRevisionFingerprint
      && authority.ownershipToken === candidate.ownershipToken;
  });
}

function triggerForSource(
  kind: PopulationAreaPreparationRequest["source"]["kind"]
): PopulationZoneV2RuntimeTrigger {
  switch (kind) {
    case "world-entry": return "world-entry";
    case "reconnect": return "reconnect";
    case "flag-build": return "flag-placement";
    case "flag-travel":
    case "shrine-travel":
    case "city-travel":
    case "kingdom-travel":
      return "flag-travel";
    case "party-travel": return "party-travel";
    case "separate-space-exit": return "separate-space-exit";
    case "administrative-relocation": return "administrative-relocation";
    case "explicit-recovery": return "explicit-relocation";
    case "player-visible":
    case "player-prepared-envelope":
    case "optional-neighbor-preload":
      return "plan-ready";
  }
}
