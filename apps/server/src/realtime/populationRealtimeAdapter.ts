import {
  type PopulationZoneV2Id
} from "../game/populationZonesV2Geometry.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { PopulationAreaOrchestrator } from "../game/populationAreaOrchestrator.js";
import type { PopulationFlagLocalityWarmer } from "../game/populationFlagLocalityWarmer.js";
import type {
  PopulationZonesV2ActivationDelta,
  PopulationZonesV2Runtime
} from "../game/populationZonesV2Runtime.js";
import type { PopulationV2RealtimeHooks } from "./websocket.js";

type PopulationRealtimeRegistry = Readonly<{
  isActivePlayerConnection(playerId: string, connectionId: string): boolean;
  sendToConnection(connectionId: string, message: PopulationDeltaFrame): void;
}>;

type PopulationDeltaFrame = Readonly<{
  type: "POPULATION_ZONE_DELTA";
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  preparationGeneration: number;
  preparationTrigger: PopulationZonesV2ActivationDelta["preparationTrigger"];
  preparationScope: "required-visible";
  requiredForGameplay: true;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
  retainedZoneIds: PopulationZoneV2Id[];
  activatedZoneIds: PopulationZoneV2Id[];
  releasedZoneIds: PopulationZoneV2Id[];
  withheldZoneIds: PopulationZoneV2Id[];
  upserts: Array<PopulationZonesV2ActivationDelta["upserts"][number] & {
    position: { lat: number; lon: number };
    homePosition: { lat: number; lon: number };
  }>;
  removedEntityIds: string[];
  visibleZoneCount: number;
  readyVisibleZoneCount: number;
  backgroundZoneCount: number;
  readyBackgroundZoneCount: number;
  zoneSnapshots: Array<{
    zoneId: PopulationZoneV2Id;
    generationId: string | null;
    entityIds: string[];
  }>;
  preparationReason: PopulationZonesV2ActivationDelta["preparationReason"];
  preparationResult: PopulationZonesV2ActivationDelta["preparationResult"];
  partial: boolean;
  terminal: boolean;
}>;

const MAX_POPULATION_DELTA_ENTITY_OPERATIONS_PER_FRAME = 256;

export class PopulationRealtimeAdapter implements PopulationV2RealtimeHooks {
  private readonly pendingDeltas = new Map<
    string,
    PopulationZonesV2ActivationDelta[]
  >();
  private readonly pendingTeleportDeltas = new Map<
    string,
    PopulationZonesV2ActivationDelta[]
  >();
  private deltaFlushScheduled = false;
  private deltaFramesReceived = 0;
  private deltaFramesSent = 0;
  private deltaFramesCoalesced = 0;
  private deltaBytesSent = 0;
  private deltaEntityOccurrencesSerialized = 0;
  private deltaUniqueEntitiesSerialized = 0;
  private deltaDuplicateEntityOccurrences = 0;
  private largestDeltaFrameBytes = 0;
  private readonly deltaPreparationMetrics = new Map<
    string,
    {
      frames: number;
      bytes: number;
      uniqueEntityIds: Set<string>;
    }
  >();
  private unsubscribe: (() => void) | null = null;
  private readonly givingTreesByConnection = new Map<
    string,
    {
      connectionGeneration: number;
      trees: Map<
        string,
        { zoneId: PopulationZoneV2Id; lat: number; lon: number }
      >;
    }
  >();
  private readonly admittedMobRolloutPreparations = new Set<string>();

  constructor(private readonly dependencies: Readonly<{
    orchestrator: Pick<
      PopulationAreaOrchestrator,
      | "startRelocation"
      | "republishConnection"
      | "releaseConnection"
      | "removeHarvestedTree"
      | "onDelta"
      | "prepareArea"
      | "releaseSource"
      | "adoptSource"
      | "hasPreparedZones"
      | "canAdmitSpeculative"
    >;
    registry: PopulationRealtimeRegistry;
    combat?: Pick<
      CombatEngine,
      "removeGivingTree" | "replaceGivingTreeSource"
    >;
    queueBackgroundMobRollout?(
      zoneIds: readonly PopulationZoneV2Id[]
    ): void;
    updateWithheldPopulationZones?(
      delta: Pick<
        PopulationZonesV2ActivationDelta,
        | "playerId"
        | "connectionId"
        | "connectionGeneration"
        | "preparationGeneration"
        | "relocationRevision"
        | "resourceVisionRevision"
        | "gameplayViewGeneration"
        | "withheldZoneIds"
      >
    ): void;
    localityWarmer?: Pick<
      PopulationFlagLocalityWarmer,
      "refresh" | "releasePlayer" | "close"
    >;
    teleportPublicationCoalescingEnabled?: boolean;
  }>) {}

  start(): void {
    this.unsubscribe ??= this.dependencies.orchestrator.onDelta((delta) => {
      this.publishDelta(delta);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [connectionId, state] of this.givingTreesByConnection) {
      this.dependencies.combat?.replaceGivingTreeSource(
        populationGivingTreeSourceId(
          connectionId,
          state.connectionGeneration
        ),
        []
      );
    }
    this.givingTreesByConnection.clear();
    this.admittedMobRolloutPreparations.clear();
    this.pendingTeleportDeltas.clear();
    this.dependencies.localityWarmer?.close();
  }

  relocate(
    input: Parameters<PopulationV2RealtimeHooks["relocate"]>[0]
  ): ReturnType<PopulationV2RealtimeHooks["relocate"]> {
    if (!input.isCurrent()) return staleRelocationHandle();
    const ownershipToken = {};
    const relocation = this.dependencies.orchestrator.startRelocation({
      playerId: input.playerId,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      area: input.area,
      relocationRevision: input.relocationRevision,
      resourceVisionRevision: input.resourceVisionRevision,
      ...(input.challengeProfile
        ? { challengeProfile: input.challengeProfile }
        : {}),
      trigger: input.trigger,
      ownershipToken
    });
    const releaseIfStale = (): boolean => {
      if (input.isCurrent()) return false;
      this.dependencies.orchestrator.releaseConnection(
        input.connectionId,
        input.connectionGeneration,
        {
          relocationRevision: input.relocationRevision,
          resourceVisionRevision: input.resourceVisionRevision,
          ownershipToken
        }
      );
      return true;
    };
    return {
      visibleReady: relocation.visibleReady.then((outcome) => {
        if (releaseIfStale()) {
          return {
            status: "stale" as const,
            pendingVisibleZoneCount: outcome.pendingVisibleZoneCount
          };
        }
        return {
          status: outcome.status,
          pendingVisibleZoneCount: outcome.pendingVisibleZoneCount
        };
      }),
      presentationReady: relocation.presentationReady.then((outcome) => {
        if (releaseIfStale()) {
          return {
            status: "stale" as const,
            pendingVisibleZoneCount: outcome.pendingVisibleZoneCount
          };
        }
        return {
          status: outcome.status,
          pendingVisibleZoneCount: outcome.pendingVisibleZoneCount
        };
      }),
      completion: relocation.completion.then(() => {
        releaseIfStale();
      }),
      preparationGeneration: relocation.preparationGeneration,
      visibleZoneCount: relocation.visibleZoneCount,
      pendingVisibleZoneCount: relocation.pendingVisibleZoneCount
    };
  }

  releaseConnection(
    input: Parameters<PopulationV2RealtimeHooks["releaseConnection"]>[0]
  ): void {
    this.dependencies.localityWarmer?.releasePlayer(input.playerId);
    const preparationPrefix =
      `${input.connectionId}:${input.connectionGeneration}:`;
    for (const key of this.admittedMobRolloutPreparations) {
      if (key.startsWith(preparationPrefix)) {
        this.admittedMobRolloutPreparations.delete(key);
      }
    }
    this.releaseGivingTreeSource(
      input.connectionId,
      input.connectionGeneration
    );
    this.dependencies.orchestrator.releaseConnection(
      input.connectionId,
      input.connectionGeneration
    );
  }

  refreshFlagLocality(
    input: Parameters<
      NonNullable<PopulationV2RealtimeHooks["refreshFlagLocality"]>
    >[0]
  ): void {
    this.dependencies.localityWarmer?.refresh(input);
  }

  releaseFlagLocality(playerId: string): void {
    this.dependencies.localityWarmer?.releasePlayer(playerId);
  }

  resync(
    input: Parameters<NonNullable<PopulationV2RealtimeHooks["resync"]>>[0]
  ): ReturnType<NonNullable<PopulationV2RealtimeHooks["resync"]>> {
    return this.dependencies.orchestrator.republishConnection(input);
  }

  deltaCoalescingMetrics(): Readonly<{
    framesReceived: number;
    framesSent: number;
    coalescedFrames: number;
    pendingGroups: number;
    bytesSent: number;
    entityOccurrencesSerialized: number;
    uniqueEntitiesSerialized: number;
    duplicateEntityOccurrences: number;
    largestFrameBytes: number;
    largestPreparationFrameCount: number;
    largestPreparationBytes: number;
  }> {
    return {
      framesReceived: this.deltaFramesReceived,
      framesSent: this.deltaFramesSent,
      coalescedFrames: this.deltaFramesCoalesced,
      pendingGroups:
        this.pendingDeltas.size + this.pendingTeleportDeltas.size,
      bytesSent: this.deltaBytesSent,
      entityOccurrencesSerialized:
        this.deltaEntityOccurrencesSerialized,
      uniqueEntitiesSerialized: this.deltaUniqueEntitiesSerialized,
      duplicateEntityOccurrences:
        this.deltaDuplicateEntityOccurrences,
      largestFrameBytes: this.largestDeltaFrameBytes,
      largestPreparationFrameCount: Math.max(
        0,
        ...[...this.deltaPreparationMetrics.values()]
          .map((preparation) => preparation.frames)
      ),
      largestPreparationBytes: Math.max(
        0,
        ...[...this.deltaPreparationMetrics.values()]
          .map((preparation) => preparation.bytes)
      )
    };
  }

  prepareArea(
    input: Parameters<PopulationAreaOrchestrator["prepareArea"]>[0]
  ): ReturnType<PopulationAreaOrchestrator["prepareArea"]> {
    return this.dependencies.orchestrator.prepareArea(input);
  }

  releaseSource(sourceId: string): boolean {
    return this.dependencies.orchestrator.releaseSource(sourceId);
  }

  adoptSource(
    input: Parameters<PopulationAreaOrchestrator["adoptSource"]>[0]
  ): ReturnType<PopulationAreaOrchestrator["adoptSource"]> {
    return this.dependencies.orchestrator.adoptSource(input);
  }

  hasPreparedZones(
    ...input: Parameters<PopulationAreaOrchestrator["hasPreparedZones"]>
  ): ReturnType<PopulationAreaOrchestrator["hasPreparedZones"]> {
    return this.dependencies.orchestrator.hasPreparedZones(...input);
  }

  canAdmitSpeculative(): boolean {
    return this.dependencies.orchestrator.canAdmitSpeculative();
  }

  private publishDelta(delta: PopulationZonesV2ActivationDelta): void {
    if (!this.dependencies.registry.isActivePlayerConnection(
      delta.playerId,
      delta.connectionId
    )) return;
    this.dependencies.updateWithheldPopulationZones?.(delta);
    this.queuePostWorldEntryMobRollout(delta);
    this.reconcileGivingTreeSource(delta);
    this.deltaFramesReceived += 1;
    const key = populationDeltaGroupKey(delta);
    if (
      this.dependencies.teleportPublicationCoalescingEnabled === true
      && isTeleportPopulationDelta(delta)
    ) {
      const pending = this.pendingTeleportDeltas.get(key) ?? [];
      pending.push(delta);
      this.pendingTeleportDeltas.set(key, pending);
      if (!delta.terminal) return;
      this.pendingTeleportDeltas.delete(key);
      this.deltaFramesCoalesced += Math.max(0, pending.length - 1);
      this.publishDeltaNow(coalescePopulationDeltas(pending));
      return;
    }
    const pending = this.pendingDeltas.get(key) ?? [];
    pending.push(delta);
    this.pendingDeltas.set(key, pending);
    if (this.deltaFlushScheduled) return;
    this.deltaFlushScheduled = true;
    queueMicrotask(() => {
      this.deltaFlushScheduled = false;
      const groups = [...this.pendingDeltas.values()];
      this.pendingDeltas.clear();
      for (const group of groups) {
        this.deltaFramesCoalesced += Math.max(0, group.length - 1);
        this.publishDeltaNow(coalescePopulationDeltas(group));
      }
    });
  }

  private queuePostWorldEntryMobRollout(
    delta: PopulationZonesV2ActivationDelta
  ): void {
    if (
      delta.preparationTrigger !== "world-entry"
      || delta.preparationResult !== "ready"
      || !delta.terminal
      || delta.readyVisibleZoneCount !== delta.visibleZoneCount
    ) return;
    const key = [
      delta.connectionId,
      delta.connectionGeneration,
      delta.preparationGeneration
    ].join(":");
    if (this.admittedMobRolloutPreparations.has(key)) return;
    const zoneIds = [...new Set(delta.zoneSnapshots
      .filter((snapshot) => snapshot.generationId !== null)
      .map((snapshot) => snapshot.zoneId))]
      .sort();
    if (zoneIds.length === 0) return;
    this.admittedMobRolloutPreparations.add(key);
    setImmediate(() => {
      if (!this.dependencies.registry.isActivePlayerConnection(
        delta.playerId,
        delta.connectionId
      )) return;
      this.dependencies.queueBackgroundMobRollout?.(zoneIds);
    });
  }

  private publishDeltaNow(delta: PopulationZonesV2ActivationDelta): void {
    if (!this.dependencies.registry.isActivePlayerConnection(
      delta.playerId,
      delta.connectionId
    )) return;
    for (const frame of this.populationDeltaFrames(delta)) {
      this.recordPublishedDeltaFrame(frame);
      this.dependencies.registry.sendToConnection(delta.connectionId, frame);
    }
  }

  private populationDeltaFrames(
    delta: PopulationZonesV2ActivationDelta
  ): PopulationDeltaFrame[] {
    const frames: PopulationDeltaFrame[] = [];
    let upsertOffset = 0;
    let removalOffset = 0;
    do {
      const remainingCapacity =
        MAX_POPULATION_DELTA_ENTITY_OPERATIONS_PER_FRAME;
      const upserts = delta.upserts.slice(
        upsertOffset,
        upsertOffset + remainingCapacity
      );
      upsertOffset += upserts.length;
      const removalsCapacity = remainingCapacity - upserts.length;
      const removedEntityIds = delta.removedEntityIds.slice(
        removalOffset,
        removalOffset + removalsCapacity
      );
      removalOffset += removedEntityIds.length;
      const final =
        upsertOffset >= delta.upserts.length &&
        removalOffset >= delta.removedEntityIds.length;
      frames.push(this.populationDeltaFrame(delta, {
        upserts,
        removedEntityIds,
        final
      }));
    } while (
      upsertOffset < delta.upserts.length ||
      removalOffset < delta.removedEntityIds.length
    );
    return frames;
  }

  private recordPublishedDeltaFrame(frame: PopulationDeltaFrame): void {
    this.deltaFramesSent += 1;
    const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    this.deltaBytesSent += frameBytes;
    this.largestDeltaFrameBytes = Math.max(
      this.largestDeltaFrameBytes,
      frameBytes
    );
    const key = [
      frame.connectionId,
      frame.connectionGeneration,
      frame.preparationGeneration
    ].join(":");
    const preparation = this.deltaPreparationMetrics.get(key) ?? {
      frames: 0,
      bytes: 0,
      uniqueEntityIds: new Set<string>()
    };
    preparation.frames += 1;
    preparation.bytes += frameBytes;
    const occurrences = [
      ...frame.upserts.map((entity) => entity.entityId),
      ...frame.removedEntityIds,
      ...frame.zoneSnapshots.flatMap((snapshot) => snapshot.entityIds)
    ];
    for (const entityId of occurrences) {
      this.deltaEntityOccurrencesSerialized += 1;
      if (preparation.uniqueEntityIds.has(entityId)) {
        this.deltaDuplicateEntityOccurrences += 1;
      } else {
        preparation.uniqueEntityIds.add(entityId);
        this.deltaUniqueEntitiesSerialized += 1;
      }
    }
    this.deltaPreparationMetrics.set(key, preparation);
    while (this.deltaPreparationMetrics.size > 256) {
      const oldestKey = this.deltaPreparationMetrics.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) break;
      this.deltaPreparationMetrics.delete(oldestKey);
    }
  }

  private populationDeltaFrame(
    delta: PopulationZonesV2ActivationDelta,
    input: Readonly<{
      upserts: PopulationZonesV2ActivationDelta["upserts"];
      removedEntityIds: string[];
      final: boolean;
    }>
  ): PopulationDeltaFrame {
    return {
      type: "POPULATION_ZONE_DELTA",
      playerId: delta.playerId,
      connectionId: delta.connectionId,
      connectionGeneration: delta.connectionGeneration,
      preparationGeneration: delta.preparationGeneration,
      preparationTrigger: delta.preparationTrigger,
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: delta.relocationRevision,
      resourceVisionRevision: delta.resourceVisionRevision,
      gameplayViewGeneration: delta.gameplayViewGeneration,
      retainedZoneIds: input.final ? [...delta.retainedZoneIds] : [],
      activatedZoneIds: input.final ? [...delta.activatedZoneIds] : [],
      releasedZoneIds: input.final ? [...delta.releasedZoneIds] : [],
      withheldZoneIds: input.final ? [...delta.withheldZoneIds] : [],
      upserts: input.upserts.map((entity) => ({
        ...entity,
        position: { ...entity.position },
        homePosition: { ...entity.homePosition }
      })),
      removedEntityIds: [...input.removedEntityIds],
      visibleZoneCount: delta.visibleZoneCount,
      readyVisibleZoneCount: delta.readyVisibleZoneCount,
      backgroundZoneCount: delta.backgroundZoneCount,
      readyBackgroundZoneCount: delta.readyBackgroundZoneCount,
      zoneSnapshots: input.final
        ? delta.zoneSnapshots.map((snapshot) => ({
            zoneId: snapshot.zoneId,
            generationId: snapshot.generationId,
            entityIds: [...snapshot.entityIds]
          }))
        : [],
      preparationReason: delta.preparationReason,
      preparationResult: input.final
        ? delta.preparationResult
        : "pending",
      partial: input.final ? delta.partial : true,
      terminal: input.final ? delta.terminal : false
    };
  }

  private reconcileGivingTreeSource(
    delta: PopulationZonesV2ActivationDelta
  ): void {
    if (!this.dependencies.combat) return;
    const previous = this.givingTreesByConnection.get(delta.connectionId);
    if (
      previous &&
      previous.connectionGeneration !== delta.connectionGeneration
    ) {
      this.dependencies.combat.replaceGivingTreeSource(
        populationGivingTreeSourceId(
          delta.connectionId,
          previous.connectionGeneration
        ),
        []
      );
    }
    const trees = previous?.connectionGeneration === delta.connectionGeneration
      ? new Map(previous.trees)
      : new Map<
          string,
          { zoneId: PopulationZoneV2Id; lat: number; lon: number }
        >();
    const releasedZoneIds = new Set(delta.releasedZoneIds);
    const removedEntityIds = new Set(delta.removedEntityIds);
    for (const [entityId, tree] of trees) {
      if (
        releasedZoneIds.has(tree.zoneId) ||
        removedEntityIds.has(entityId)
      ) {
        trees.delete(entityId);
      }
    }
    for (const entity of delta.upserts) {
      if (entity.kind === "tree") {
        trees.set(entity.entityId, {
          zoneId: entity.zoneId,
          lat: entity.position.lat,
          lon: entity.position.lon
        });
      } else {
        trees.delete(entity.entityId);
      }
    }
    for (const snapshot of delta.zoneSnapshots) {
      const authoritativeIds = new Set(snapshot.entityIds);
      for (const [entityId, tree] of trees) {
        if (
          tree.zoneId === snapshot.zoneId &&
          !authoritativeIds.has(entityId)
        ) {
          trees.delete(entityId);
        }
      }
    }
    this.givingTreesByConnection.set(delta.connectionId, {
      connectionGeneration: delta.connectionGeneration,
      trees
    });
    this.dependencies.combat.replaceGivingTreeSource(
      populationGivingTreeSourceId(
        delta.connectionId,
        delta.connectionGeneration
      ),
      [...trees].map(([id, tree]) => ({
        id,
        lat: tree.lat,
        lon: tree.lon
      }))
    );
  }

  removeHarvestedTree(
    transition: Parameters<PopulationZonesV2Runtime["removeHarvestedTree"]>[0]
  ): void {
    this.dependencies.orchestrator.removeHarvestedTree(transition);
    for (const state of this.givingTreesByConnection.values()) {
      state.trees.delete(transition.entityId);
    }
    this.dependencies.combat?.removeGivingTree(transition.entityId);
  }

  private releaseGivingTreeSource(
    connectionId: string,
    connectionGeneration: number
  ): void {
    const state = this.givingTreesByConnection.get(connectionId);
    if (!state || state.connectionGeneration !== connectionGeneration) return;
    this.dependencies.combat?.replaceGivingTreeSource(
      populationGivingTreeSourceId(connectionId, connectionGeneration),
      []
    );
    this.givingTreesByConnection.delete(connectionId);
  }

}

function populationGivingTreeSourceId(
  connectionId: string,
  connectionGeneration: number
): string {
  return `population-v2:${connectionId}:${connectionGeneration}`;
}

function populationDeltaGroupKey(
  delta: PopulationZonesV2ActivationDelta
): string {
  return [
    delta.playerId,
    delta.connectionId,
    delta.connectionGeneration,
    delta.preparationGeneration,
    delta.relocationRevision,
    delta.resourceVisionRevision,
    delta.gameplayViewGeneration
  ].join(":");
}

function isTeleportPopulationDelta(
  delta: PopulationZonesV2ActivationDelta
): boolean {
  return delta.preparationTrigger === "flag-travel"
    || delta.preparationTrigger === "party-travel"
    || delta.preparationTrigger === "administrative-relocation"
    || delta.preparationTrigger === "separate-space-exit";
}

function coalescePopulationDeltas(
  deltas: readonly PopulationZonesV2ActivationDelta[]
): PopulationZonesV2ActivationDelta {
  const last = deltas.at(-1);
  if (!last) throw new Error("cannot coalesce an empty population delta group");
  const retained = new Set<PopulationZoneV2Id>();
  const activated = new Set<PopulationZoneV2Id>();
  const released = new Set<PopulationZoneV2Id>();
  const upserts = new Map<
    string,
    PopulationZonesV2ActivationDelta["upserts"][number]
  >();
  const removed = new Set<string>();
  const snapshots = new Map<
    PopulationZoneV2Id,
    PopulationZonesV2ActivationDelta["zoneSnapshots"][number]
  >();
  for (const delta of deltas) {
    for (const zoneId of delta.retainedZoneIds) {
      released.delete(zoneId);
      retained.add(zoneId);
    }
    for (const zoneId of delta.activatedZoneIds) {
      released.delete(zoneId);
      activated.add(zoneId);
    }
    for (const zoneId of delta.releasedZoneIds) {
      retained.delete(zoneId);
      activated.delete(zoneId);
      released.add(zoneId);
      snapshots.delete(zoneId);
    }
    for (const entity of delta.upserts) {
      removed.delete(entity.entityId);
      upserts.set(entity.entityId, entity);
    }
    for (const entityId of delta.removedEntityIds) {
      upserts.delete(entityId);
      removed.add(entityId);
    }
    for (const snapshot of delta.zoneSnapshots) {
      if (released.has(snapshot.zoneId)) continue;
      snapshots.set(snapshot.zoneId, snapshot);
    }
  }
  return {
    ...last,
    retainedZoneIds: [...retained].sort(),
    activatedZoneIds: [...activated].sort(),
    releasedZoneIds: [...released].sort(),
    upserts: [...upserts.values()],
    removedEntityIds: [...removed].sort(),
    zoneSnapshots: [...snapshots.values()]
  };
}


function staleRelocationHandle(): ReturnType<PopulationV2RealtimeHooks["relocate"]> {
  return {
    visibleReady: Promise.resolve({
      status: "stale",
      pendingVisibleZoneCount: 0
    }),
    presentationReady: Promise.resolve({
      status: "stale",
      pendingVisibleZoneCount: 0
    }),
    completion: Promise.resolve(),
    pendingVisibleZoneCount: () => 0
  };
}
