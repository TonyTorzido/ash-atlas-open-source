import type {
  KingdomSpatialEntity,
  KingdomSpatialEntityReference,
  KingdomSpatialWireChange,
  KingdomStateSnapshot
} from "@ash-atlas/shared";

export class KingdomSpatialRevisionTracker {
  private readonly revisions = new Map<string, bigint>();

  reconcileSnapshot(current: KingdomStateSnapshot | null, snapshot: KingdomStateSnapshot): KingdomStateSnapshot {
    const boundary = parseRevision(snapshot.spatialRevision);
    if (!current) {
      this.revisions.clear();
      this.seedSnapshot(snapshot);
      return snapshot;
    }
    let reconciled: KingdomStateSnapshot = {
      ...snapshot,
      nearbyKingdoms: current.nearbyKingdoms,
      nearbyObjects: current.nearbyObjects ?? []
    };
    const snapshotKeys = new Set<string>();
    for (const kingdom of snapshot.nearbyKingdoms) {
      if (!kingdom.seat) continue;
      snapshotKeys.add(`seat:${kingdom.seat.id}`);
      reconciled = this.applyChange(reconciled, { action: "upsert", entity: {
        entityType: "seat", id: kingdom.seat.id, kingdomId: kingdom.id, kingdom
      } });
    }
    for (const object of snapshot.nearbyObjects ?? []) {
      snapshotKeys.add(`object:${object.kind}:${object.id}`);
      reconciled = this.applyChange(reconciled, { action: "upsert", entity: {
        entityType: "object", id: object.id, kingdomId: object.kingdomId,
        objectKind: object.kind, object
      } });
    }
    for (const kingdom of [...reconciled.nearbyKingdoms]) {
      if (!kingdom.seat) continue;
      const key = `seat:${kingdom.seat.id}`;
      if (!snapshotKeys.has(key) && (this.revisions.get(key) ?? 0n) <= boundary) {
        reconciled = removeKingdomSpatialEntity(reconciled, {
          entityType: "seat", id: kingdom.seat.id, kingdomId: kingdom.id,
          spatialRevision: snapshot.spatialRevision
        });
        this.revisions.set(key, boundary);
      }
    }
    for (const object of [...(reconciled.nearbyObjects ?? [])]) {
      const key = `object:${object.kind}:${object.id}`;
      if (!snapshotKeys.has(key) && (this.revisions.get(key) ?? 0n) <= boundary) {
        reconciled = removeKingdomSpatialEntity(reconciled, {
          entityType: "object", id: object.id, kingdomId: object.kingdomId,
          objectKind: object.kind, spatialRevision: snapshot.spatialRevision
        });
        this.revisions.set(key, boundary);
      }
    }
    return reconciled;
  }

  applyBatch(state: KingdomStateSnapshot, changes: readonly KingdomSpatialWireChange[]): KingdomStateSnapshot {
    return changes.reduce((current, change) => this.applyChange(current, change), state);
  }

  reset(): void {
    this.revisions.clear();
  }

  private applyChange(state: KingdomStateSnapshot, change: KingdomSpatialWireChange): KingdomStateSnapshot {
    const revision = parseRevision(spatialChangeRevision(change));
    const key = spatialChangeKey(change);
    if (revision <= (this.revisions.get(key) ?? 0n)) return state;
    this.revisions.set(key, revision);
    return change.action === "upsert"
      ? upsertKingdomSpatialEntity(state, change.entity)
      : removeKingdomSpatialEntity(state, change.entity);
  }

  private seedSnapshot(snapshot: KingdomStateSnapshot): void {
    for (const kingdom of snapshot.nearbyKingdoms) {
      if (kingdom.seat) this.revisions.set(`seat:${kingdom.seat.id}`, parseRevision(kingdom.spatialRevision));
    }
    for (const object of snapshot.nearbyObjects ?? []) {
      this.revisions.set(`object:${object.kind}:${object.id}`, parseRevision(object.spatialRevision));
    }
  }
}

export function upsertKingdomSpatialEntity(state: KingdomStateSnapshot, entity: KingdomSpatialEntity): KingdomStateSnapshot {
  if (entity.entityType === "seat") {
    if (entity.kingdom.id !== entity.kingdomId || entity.kingdom.seat?.id !== entity.id) return state;
    const existing = state.nearbyKingdoms.find(({ seat }) => seat?.id === entity.id);
    if (existing && existing.id !== entity.kingdomId) return state;
    return { ...state, nearbyKingdoms: [
      ...state.nearbyKingdoms.filter(({ id }) => id !== entity.kingdomId), entity.kingdom
    ] };
  }
  if (entity.object.id !== entity.id || entity.object.kingdomId !== entity.kingdomId ||
      entity.object.kind !== entity.objectKind) return state;
  const nearbyObjects = state.nearbyObjects ?? [];
  const existing = nearbyObjects.find(({ id }) => id === entity.id);
  if (existing && existing.kind !== entity.objectKind) return state;
  return { ...state, nearbyObjects: [
    ...nearbyObjects.filter(({ id }) => id !== entity.id), entity.object
  ] };
}

export function removeKingdomSpatialEntity(
  state: KingdomStateSnapshot,
  entity: KingdomSpatialEntityReference
): KingdomStateSnapshot {
  if (entity.entityType === "seat") {
    return { ...state, nearbyKingdoms: state.nearbyKingdoms.filter(({ id, seat }) =>
      id !== entity.kingdomId || seat?.id !== entity.id) };
  }
  return { ...state, nearbyObjects: (state.nearbyObjects ?? []).filter((object) =>
    object.id !== entity.id || object.kingdomId !== entity.kingdomId || object.kind !== entity.objectKind) };
}

function spatialChangeRevision(change: KingdomSpatialWireChange): string {
  if (change.action === "remove") return change.entity.spatialRevision;
  return change.entity.entityType === "seat"
    ? change.entity.kingdom.spatialRevision
    : change.entity.object.spatialRevision;
}

function spatialChangeKey(change: KingdomSpatialWireChange): string {
  const entity = change.entity;
  return entity.entityType === "seat" ? `seat:${entity.id}` : `object:${entity.objectKind}:${entity.id}`;
}

function parseRevision(revision: string): bigint {
  return /^\d+$/.test(revision) ? BigInt(revision) : 0n;
}
