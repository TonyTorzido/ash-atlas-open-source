import type {
  CombatEntitySnapshot,
  CombatStateBatch
} from "@ash-atlas/shared";

export type CombatStoreMetrics = {
  entityCount: number;
  sequence: number;
};

export type CombatApplyResult = "applied" | "ignored" | "gap";

/**
 * Server time (epoch ms, the batch's `serverTime`) each stored snapshot was sampled at. Keyed by the snapshot object, so
 * a newer upsert (a new object) carries its own stamp and a snapshot that did not change keeps the old one. The overlay's
 * mob snapshot buffer reads it to interpolate on server time instead of on packet arrival.
 */
export const combatSampleServerMs = new WeakMap<CombatEntitySnapshot, number>();

export class CombatStore {
  private readonly entitiesById = new Map<string, CombatEntitySnapshot>();
  private sequence = 0;
  /** `entities()` hands out one array until something is written (it was copied on every call, several times a frame). */
  private entityList: readonly CombatEntitySnapshot[] | null = null;

  /**
   * A snapshot is the server's complete view, so it always replaces the store, even at a lower sequence. One socket
   * delivers frames in order and the server's per-player sequence only climbs on a connection, so a lower sequence means
   * the server restarted its combat stream (a reconnect that re-registered the player), and the old state is stale. The
   * world-authority reset that clears the store on WELCOME does not fire for a same-authority reconnect, so ignoring it
   * here froze the old view: a player who reconnected dead kept the death card after the server had respawned them.
   */
  applySnapshot(batch: CombatStateBatch): CombatApplyResult {
    this.entitiesById.clear();
    this.entityList = null;
    for (const entity of batch.upserts) {
      this.entitiesById.set(entity.entityId, entity);
      combatSampleServerMs.set(entity, batch.serverTime);
    }
    this.sequence = batch.sequence;
    return "applied";
  }

  applyDelta(batch: CombatStateBatch): CombatApplyResult {
    if (batch.sequence <= this.sequence) {
      return "ignored";
    }
    if (batch.sequence !== this.sequence + 1) {
      return "gap";
    }
    for (const entity of batch.upserts) {
      const current = this.entitiesById.get(entity.entityId);
      if (!current || entity.revision >= current.revision) {
        this.entitiesById.set(entity.entityId, entity);
        combatSampleServerMs.set(entity, batch.serverTime);
      }
    }
    for (const entityId of batch.removedEntityIds) {
      this.entitiesById.delete(entityId);
    }
    this.entityList = null;
    this.sequence = batch.sequence;
    return "applied";
  }

  get(entityId: string): CombatEntitySnapshot | null {
    return this.entitiesById.get(entityId) ?? null;
  }

  remove(entityId: string): boolean {
    const removed = this.entitiesById.delete(entityId);
    if (removed) this.entityList = null;
    return removed;
  }

  /** The live snapshots. The same array until the store changes; callers must not modify it. */
  entities(): readonly CombatEntitySnapshot[] {
    return this.entityList ??= [...this.entitiesById.values()];
  }

  metrics(): CombatStoreMetrics {
    return { entityCount: this.entitiesById.size, sequence: this.sequence };
  }

  clear(): void {
    this.entitiesById.clear();
    this.entityList = null;
    this.sequence = 0;
  }
}

export function resolveCombatSelection(
  store: CombatStore,
  selectedEntityId: string | null
): { entityId: string | null; entity: CombatEntitySnapshot | null } {
  const entity = selectedEntityId ? store.get(selectedEntityId) : null;
  return {
    entityId: entity ? selectedEntityId : null,
    entity
  };
}
