import {
  treeWoodYieldForStableId,
  type CollectibleNode,
  type PopulationZoneEntitySnapshot,
  type ServerMessage
} from "@ash-atlas/shared";

export type PopulationZoneDelta = Extract<
  ServerMessage,
  { type: "POPULATION_ZONE_DELTA" }
>;

export type PopulationZoneProjectionState = Readonly<{
  authority: PopulationZoneProjectionAuthority | null;
  activeZoneIds: ReadonlySet<string>;
  zoneAuthorities: ReadonlyMap<string, PopulationZoneSnapshotAuthority>;
  entities: ReadonlyMap<string, PopulationZoneEntitySnapshot>;
  collectibleTombstones: ReadonlyMap<string, number>;
  preparationProgress: PopulationPreparationProgress;
}>;

export type PopulationZoneSnapshotAuthority = Readonly<{
  generationId: string | null;
  entityIds: ReadonlySet<string>;
}>;

export type PopulationPreparationProgress = Readonly<{
  completed: number;
  total: number;
  status: "idle" | "pending" | "ready" | "degraded" | "failed";
  reason: PopulationZoneDelta["preparationReason"] | null;
  operation: PopulationPreparationOperation | null;
}>;

export type PopulationPreparationOperation = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  preparationGeneration: number;
  trigger: PopulationZoneDelta["preparationTrigger"];
  scope: PopulationZoneDelta["preparationScope"];
  requiredForGameplay: boolean;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
}>;

export type PopulationZoneProjectionAuthority = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  preparationGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
}>;

export type PopulationZoneProjectionExpectation = Readonly<{
  playerId: string;
  relocationRevision: number;
  resourceVisionRevision: number;
}>;

export type PopulationZoneProjectionResult = Readonly<{
  accepted: boolean;
  replacesProjection: boolean;
  state: PopulationZoneProjectionState;
  collectibleUpserts: readonly CollectibleNode[];
  removedCollectibleIds: ReadonlySet<string>;
  preparationProgress: PopulationPreparationProgress;
}>;

export type CollectibleSnapshotReconciliationResult = Readonly<{
  state: PopulationZoneProjectionState;
  collectibles: CollectibleNode[];
  removedCollectibleIds: ReadonlySet<string>;
}>;

export function emptyPopulationZoneProjection(): PopulationZoneProjectionState {
  return {
    authority: null,
    activeZoneIds: new Set(),
    zoneAuthorities: new Map(),
    entities: new Map(),
    collectibleTombstones: new Map(),
    preparationProgress: idlePopulationPreparationProgress()
  };
}

export function idlePopulationPreparationProgress(): PopulationPreparationProgress {
  return {
    completed: 0,
    total: 0,
    status: "idle",
    reason: null,
    operation: null
  };
}

export function populationPreparationOperationKey(
  operation: PopulationPreparationOperation | null
): string | null {
  return operation
    ? [
        operation.playerId,
        operation.connectionId,
        operation.connectionGeneration,
        operation.preparationGeneration,
        operation.relocationRevision,
        operation.resourceVisionRevision
      ].join(":")
    : null;
}

export function populationPreparationCheckpointKey(
  progress: PopulationPreparationProgress
): string | null {
  const operationKey = populationPreparationOperationKey(progress.operation);
  return operationKey
    ? [
        operationKey,
        progress.completed,
        progress.total,
        progress.status,
        progress.reason
      ].join(":")
    : null;
}

export function populationDeltaAuthorityKey(
  delta: PopulationZoneDelta
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

export function coalescePopulationZoneDeltas(
  deltas: readonly PopulationZoneDelta[]
): PopulationZoneDelta {
  const last = deltas.at(-1);
  if (!last) throw new Error("cannot coalesce empty population deltas");
  const retained = new Set<string>();
  const activated = new Set<string>();
  const released = new Set<string>();
  const upserts = new Map<string, PopulationZoneDelta["upserts"][number]>();
  const removed = new Set<string>();
  const snapshots = new Map<
    string,
    PopulationZoneDelta["zoneSnapshots"][number]
  >();
  for (const delta of deltas) {
    if (populationDeltaAuthorityKey(delta) !==
      populationDeltaAuthorityKey(last)) {
      throw new Error("cannot coalesce population authority generations");
    }
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
    withheldZoneIds: [...last.withheldZoneIds].sort(),
    upserts: [...upserts.values()],
    removedEntityIds: [...removed].sort(),
    zoneSnapshots: [...snapshots.values()]
  };
}

const MAX_COLLECTIBLE_TOMBSTONES = 512;

export function removePopulationCollectible(
  current: PopulationZoneProjectionState,
  entityId: string,
  authoritativeRevision?: number
): PopulationZoneProjectionState {
  const entities = new Map(current.entities);
  const revision = Math.max(
    entities.get(entityId)?.stateRevision ?? 0,
    current.collectibleTombstones.get(entityId) ?? 0,
    Number.isSafeInteger(authoritativeRevision) ? authoritativeRevision! : 0
  );
  entities.delete(entityId);
  const collectibleTombstones = new Map(current.collectibleTombstones);
  collectibleTombstones.delete(entityId);
  collectibleTombstones.set(entityId, revision);
  while (collectibleTombstones.size > MAX_COLLECTIBLE_TOMBSTONES) {
    const oldest = collectibleTombstones.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    collectibleTombstones.delete(oldest);
  }
  return { ...current, entities, collectibleTombstones };
}

export function applyPopulationZoneDelta(
  current: PopulationZoneProjectionState,
  delta: PopulationZoneDelta,
  expectation: PopulationZoneProjectionExpectation
): PopulationZoneProjectionResult {
  const deltaAuthority = {
    playerId: delta.playerId,
    connectionId: delta.connectionId,
    connectionGeneration: delta.connectionGeneration,
    preparationGeneration: delta.preparationGeneration,
    relocationRevision: delta.relocationRevision,
    resourceVisionRevision: delta.resourceVisionRevision,
    gameplayViewGeneration: delta.gameplayViewGeneration
  };
  const matchesExpectedAuthority =
    delta.playerId === expectation.playerId &&
    delta.relocationRevision === expectation.relocationRevision &&
    delta.resourceVisionRevision === expectation.resourceVisionRevision;
  const matchesProjectionAuthority = current.authority !== null &&
    samePopulationProjectionAuthority(deltaAuthority, current.authority);
  const supersededByProjection = current.authority !== null &&
    comparePopulationProjectionAuthority(
      deltaAuthority,
      current.authority
    ) < 0;
  const advancesRelocation = delta.relocationRevision > Math.max(
    expectation.relocationRevision,
    current.authority?.relocationRevision ?? -1
  );
  const advancesResourceVision =
    delta.relocationRevision >= expectation.relocationRevision &&
    delta.resourceVisionRevision > Math.max(
      expectation.resourceVisionRevision,
      current.authority?.resourceVisionRevision ?? -1
    );
  const advancesOperation = current.authority !== null &&
    delta.relocationRevision >= current.authority.relocationRevision &&
    delta.resourceVisionRevision >=
      current.authority.resourceVisionRevision &&
    comparePopulationOperation(deltaAuthority, current.authority) > 0;
  if (
    delta.playerId !== expectation.playerId ||
    supersededByProjection ||
    (
      !matchesExpectedAuthority &&
      !matchesProjectionAuthority &&
      !advancesRelocation &&
      !advancesResourceVision &&
      !advancesOperation
    )
  ) {
    return {
      accepted: false,
      replacesProjection: false,
      state: current,
      collectibleUpserts: [],
      removedCollectibleIds: new Set(),
      preparationProgress: current.preparationProgress
    };
  }

  // Operation and view advances are streamed incrementally. Retain the prior
  // projection until the server explicitly releases zones, removes entities,
  // or supplies an exact ready-zone snapshot that omits them.
  const replacesProjection = false;
  const base = current;
  const activeZoneIds = new Set(base.activeZoneIds);
  for (const zoneId of delta.retainedZoneIds) activeZoneIds.add(zoneId);
  for (const zoneId of delta.activatedZoneIds) activeZoneIds.add(zoneId);

  const zoneAuthorities = new Map(base.zoneAuthorities);
  const entities = new Map(base.entities);
  const collectibleTombstones = new Map(base.collectibleTombstones);
  const removedCollectibleIds = new Set<string>();
  const removeEntity = (
    entityId: string,
    retainAuthoritativeTombstone = true
  ): void => {
    const removed = entities.get(entityId);
    entities.delete(entityId);
    if (removed?.kind === "tree") removedCollectibleIds.add(entityId);
    if (
      retainAuthoritativeTombstone
      && removed
      && isCollectibleKind(removed.kind)
    ) {
      collectibleTombstones.set(entityId, removed.stateRevision);
    }
  };

  const releasedZoneIds = new Set([
    ...delta.releasedZoneIds,
    ...delta.withheldZoneIds
  ]);
  for (const zoneId of releasedZoneIds) {
    activeZoneIds.delete(zoneId);
    const previousAuthority = zoneAuthorities.get(zoneId);
    if (previousAuthority) {
      for (const entityId of previousAuthority.entityIds) {
        removeEntity(entityId, false);
      }
    }
    for (const [entityId, entity] of entities) {
      if (entity.zoneId === zoneId) removeEntity(entityId, false);
    }
    zoneAuthorities.delete(zoneId);
  }

  for (const snapshot of delta.zoneSnapshots) {
    if (
      releasedZoneIds.has(snapshot.zoneId) ||
      !activeZoneIds.has(snapshot.zoneId)
    ) {
      continue;
    }
    const entityIds = new Set(snapshot.entityIds);
    const previousAuthority = zoneAuthorities.get(snapshot.zoneId);
    if (previousAuthority) {
      for (const entityId of previousAuthority.entityIds) {
        if (!entityIds.has(entityId)) removeEntity(entityId);
      }
    }
    for (const [entityId, entity] of entities) {
      if (
        entity.zoneId === snapshot.zoneId &&
        (
          !entityIds.has(entityId) ||
          !entityMatchesGeneration(entity, snapshot.generationId)
        )
      ) {
        removeEntity(entityId);
        if (entityIds.has(entityId)) {
          collectibleTombstones.delete(entityId);
        }
      }
    }
    zoneAuthorities.set(snapshot.zoneId, {
      generationId: snapshot.generationId,
      entityIds
    });
  }

  for (const entityId of delta.removedEntityIds) {
    removeEntity(entityId);
    for (const [zoneId, snapshot] of zoneAuthorities) {
      if (!snapshot.entityIds.has(entityId)) continue;
      const entityIds = new Set(snapshot.entityIds);
      entityIds.delete(entityId);
      zoneAuthorities.set(zoneId, { ...snapshot, entityIds });
    }
  }

  const collectibleUpserts: CollectibleNode[] = [];
  for (const entity of delta.upserts) {
    const zoneAuthority = zoneAuthorities.get(entity.zoneId);
    if (
      !activeZoneIds.has(entity.zoneId)
      || !zoneAuthority?.entityIds.has(entity.entityId)
      || !entityMatchesGeneration(entity, zoneAuthority.generationId)
    ) {
      continue;
    }
    const tombstoneRevision = collectibleTombstones.get(entity.entityId);
    if (
      tombstoneRevision !== undefined
      && entity.stateRevision <= tombstoneRevision
    ) {
      continue;
    }
    if (tombstoneRevision !== undefined) {
      collectibleTombstones.delete(entity.entityId);
    }
    const existing = entities.get(entity.entityId);
    if (existing && existing.stateRevision > entity.stateRevision) continue;
    if (
      existing &&
      isCollectibleKind(existing.kind) &&
      !isCollectibleKind(entity.kind)
    ) {
      removedCollectibleIds.add(entity.entityId);
    }
    entities.set(entity.entityId, entity);
    if (isCollectibleEntity(entity)) {
      removedCollectibleIds.delete(entity.entityId);
      collectibleUpserts.push(populationEntityAsCollectible(entity));
    }
  }
  while (collectibleTombstones.size > MAX_COLLECTIBLE_TOMBSTONES) {
    const oldest = collectibleTombstones.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    collectibleTombstones.delete(oldest);
  }

  const preparationProgress = progressFromDelta(
    delta,
    base.preparationProgress
  );
  return {
    accepted: true,
    replacesProjection,
    state: {
      authority: deltaAuthority,
      activeZoneIds,
      zoneAuthorities,
      entities,
      collectibleTombstones,
      preparationProgress
    },
    collectibleUpserts,
    removedCollectibleIds,
    preparationProgress
  };
}

export function populationProjectionMatchesAuthority(
  projection: PopulationZoneProjectionState,
  authority: Pick<
    PopulationZoneProjectionAuthority,
    "relocationRevision" | "resourceVisionRevision"
  >
): boolean {
  return projection.authority !== null &&
    projection.authority.relocationRevision === authority.relocationRevision &&
    projection.authority.resourceVisionRevision ===
      authority.resourceVisionRevision;
}

export function mergePopulationCollectibles(
  current: readonly CollectibleNode[],
  upserts: readonly CollectibleNode[],
  removedIds: ReadonlySet<string>
): CollectibleNode[] {
  const next = current.filter((node) => !removedIds.has(node.id));
  const indexById = new Map(next.map((node, index) => [node.id, index]));
  for (const upsert of upserts) {
    const index = indexById.get(upsert.id);
    if (index === undefined) {
      indexById.set(upsert.id, next.length);
      next.push(upsert);
    } else {
      next[index] = reconcileTreeLife(next[index]!, upsert);
    }
  }
  return next;
}

export function mergeCollectibleSnapshotWithPopulation(
  current: readonly CollectibleNode[],
  snapshot: readonly CollectibleNode[],
  population: PopulationZoneProjectionState
): CollectibleNode[] {
  return reconcileCollectibleSnapshot(
    current,
    snapshot,
    population
  ).collectibles;
}

export function reconcileCollectibleSnapshot(
  current: readonly CollectibleNode[],
  snapshot: readonly CollectibleNode[],
  population: PopulationZoneProjectionState
): CollectibleSnapshotReconciliationResult {
  const state = population;
  const collectibleTombstones = new Map(population.collectibleTombstones);
  const currentById = new Map(current.map((node) => [node.id, node]));
  const populationIds = new Set(
    [...population.entities.values()]
      .filter(isCollectibleEntity)
      .map((entity) => entity.entityId)
  );
  const collectibles: CollectibleNode[] = [...population.entities.values()]
    .filter(isCollectibleEntity)
    .map((entity) =>
      currentById.get(entity.entityId) ?? populationEntityAsCollectible(entity)
    );
  for (const node of snapshot) {
    if (populationIds.has(node.id)) continue;
    const tombstoneRevision = collectibleTombstones.get(node.id);
    if (tombstoneRevision !== undefined) {
      const incomingRevision = node.treeLifeRevision;
      if (
        incomingRevision === undefined ||
        incomingRevision <= tombstoneRevision
      ) {
        continue;
      }
      collectibleTombstones.delete(node.id);
    }
    const previous = currentById.get(node.id);
    collectibles.push(previous ? reconcileTreeLife(previous, node) : node);
  }
  const nextState = { ...state, collectibleTombstones };
  const nextIds = new Set(collectibles.map((node) => node.id));
  return {
    state: nextState,
    collectibles,
    removedCollectibleIds: new Set(
      current.filter((node) => !nextIds.has(node.id)).map((node) => node.id)
    )
  };
}

function isCollectibleKind(
  kind: PopulationZoneEntitySnapshot["kind"]
): kind is "tree" {
  return kind === "tree";
}

function isCollectibleEntity(
  entity: PopulationZoneEntitySnapshot
): entity is PopulationZoneEntitySnapshot & { kind: "tree" } {
  return isCollectibleKind(entity.kind);
}

function entityMatchesGeneration(
  entity: PopulationZoneEntitySnapshot,
  generationId: string | null
): boolean {
  return entity.kind === "stone"
    ? entity.generationId === null
    : generationId !== null && entity.generationId === generationId;
}

function progressFromDelta(
  delta: PopulationZoneDelta,
  current: PopulationPreparationProgress
): PopulationPreparationProgress {
  if (
    !delta.requiredForGameplay ||
    delta.preparationScope !== "required-visible"
  ) {
    return current;
  }
  if (
    delta.preparationResult === "stale" ||
    delta.preparationResult === "cancelled"
  ) {
    return idlePopulationPreparationProgress();
  }
  return {
    completed: Math.min(delta.readyVisibleZoneCount, delta.visibleZoneCount),
    total: delta.visibleZoneCount,
    status: delta.preparationResult === "retryable-failure"
      ? "failed"
      : delta.preparationResult,
    reason: delta.preparationReason,
    operation: {
      playerId: delta.playerId,
      connectionId: delta.connectionId,
      connectionGeneration: delta.connectionGeneration,
      preparationGeneration: delta.preparationGeneration,
      trigger: delta.preparationTrigger,
      scope: delta.preparationScope,
      requiredForGameplay: delta.requiredForGameplay,
      relocationRevision: delta.relocationRevision,
      resourceVisionRevision: delta.resourceVisionRevision,
      gameplayViewGeneration: delta.gameplayViewGeneration
    }
  };
}

function samePopulationProjectionAuthority(
  left: PopulationZoneProjectionAuthority,
  right: PopulationZoneProjectionAuthority
): boolean {
  return left.playerId === right.playerId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.preparationGeneration === right.preparationGeneration &&
    left.relocationRevision === right.relocationRevision &&
    left.resourceVisionRevision === right.resourceVisionRevision &&
    left.gameplayViewGeneration === right.gameplayViewGeneration;
}

function comparePopulationProjectionAuthority(
  left: PopulationZoneProjectionAuthority,
  right: PopulationZoneProjectionAuthority
): number {
  const revisionOrder =
    left.relocationRevision - right.relocationRevision ||
    left.resourceVisionRevision - right.resourceVisionRevision ||
    left.gameplayViewGeneration - right.gameplayViewGeneration;
  if (revisionOrder !== 0) return revisionOrder;
  return comparePopulationOperation(left, right);
}

function comparePopulationOperation(
  left: Pick<
    PopulationZoneProjectionAuthority,
    "connectionId" | "connectionGeneration" | "preparationGeneration"
  >,
  right: Pick<
    PopulationZoneProjectionAuthority,
    "connectionId" | "connectionGeneration" | "preparationGeneration"
  >
): number {
  const connectionOrder =
    left.connectionGeneration - right.connectionGeneration;
  if (connectionOrder !== 0) return connectionOrder;
  if (left.connectionId !== right.connectionId) return -1;
  return left.preparationGeneration - right.preparationGeneration;
}

function populationEntityAsCollectible(
  entity: PopulationZoneEntitySnapshot & { kind: "tree" }
): CollectibleNode {
  return {
    id: entity.entityId,
    type: "wood",
    lat: entity.position.lat,
    lon: entity.position.lon,
    quantity: treeWoodYieldForStableId(entity.entityId),
    state: "available" as const,
    createdAt: "1970-01-01T00:00:00.000Z",
    harvestedAt: null,
    sourceCellId: `population-v2:${entity.zoneId}`,
    waterKind: null,
    presentationOwner: "population",
    treeLifeRevision: entity.stateRevision,
    ...(entity.berryAvailable !== undefined ? { berryAvailable: entity.berryAvailable } : {}),
    ...(entity.resinAvailable !== undefined
      ? { resinAvailable: entity.resinAvailable }
      : {}),
    ...(entity.sapReadyAt !== undefined ? { sapReadyAt: entity.sapReadyAt } : {})
  };
}

function reconcileTreeLife(
  current: CollectibleNode,
  incoming: CollectibleNode
): CollectibleNode {
  if (current.type !== "wood" || incoming.type !== "wood") return incoming;
  // A newer sap tap wins over a stale snapshot of the same fern.
  if (
    current.sapReadyAt
    && (incoming.sapReadyAt === null
      || (incoming.sapReadyAt && Date.parse(current.sapReadyAt) > Date.parse(incoming.sapReadyAt)))
  ) {
    incoming = { ...incoming, sapReadyAt: current.sapReadyAt };
  }
  const currentLife = current.treeLifeRevision;
  const incomingLife = incoming.treeLifeRevision;
  if (
    currentLife !== undefined
    && incomingLife !== undefined
    && currentLife === incomingLife
    && (current.resinAvailable === false || incoming.resinAvailable === false
      || current.berryAvailable === false || incoming.berryAvailable === false)
  ) {
    return { ...incoming,
      ...(current.resinAvailable === false || incoming.resinAvailable === false ? { resinAvailable: false } : {}),
      ...(current.berryAvailable === false || incoming.berryAvailable === false ? { berryAvailable: false } : {})
    };
  }
  if (
    currentLife !== undefined
    && incomingLife !== undefined
    && currentLife > incomingLife
  ) {
    return current;
  }
  return incoming;
}
