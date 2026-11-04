import type { PlayerDeltaUpsert, PlayerSnapshot } from "@ash-atlas/shared";

import type { GameState } from "./state.js";
import type { CombatInterestFrame } from "./combat/combatEngine.js";

type RecipientState = {
  sequence: number;
  knownPlayers: Map<string, PlayerSnapshot>;
};

export type PlayerDelta = {
  serverTime: number;
  sequence: number;
  upserts: PlayerDeltaUpsert[];
  removedPlayerIds: string[];
};

export type WorldReplicationMetrics = {
  snapshotsSent: number;
  deltasSent: number;
  entitiesSent: number;
  maximumEntitiesPerDelta: number;
  resyncRequests: number;
};

export class WorldReplicationService {
  private readonly recipients = new Map<string, RecipientState>();
  private readonly pendingSnapshots = new Set<string>();
  private readonly metrics: WorldReplicationMetrics = {
    snapshotsSent: 0,
    deltasSent: 0,
    entitiesSent: 0,
    maximumEntitiesPerDelta: 0,
    resyncRequests: 0
  };

  constructor(private readonly gameState: GameState) {}

  resetPlayer(playerId: string): void {
    this.recipients.set(playerId, { sequence: 0, knownPlayers: new Map() });
    this.pendingSnapshots.add(playerId);
  }

  removePlayer(playerId: string): void {
    this.recipients.delete(playerId);
    this.pendingSnapshots.delete(playerId);
  }

  snapshotForPlayer(playerId: string, interest: CombatInterestFrame): PlayerSnapshot[] {
    const snapshots = this.visibleSnapshots(playerId, interest);
    const state = this.stateFor(playerId);
    state.sequence = 0;
    state.knownPlayers = snapshotsById(snapshots);
    this.pendingSnapshots.delete(playerId);
    this.metrics.snapshotsSent += 1;
    return snapshots;
  }

  deltaForPlayer(playerId: string, interest: CombatInterestFrame): PlayerDelta | null {
    const snapshots = this.visibleSnapshots(playerId, interest);
    const state = this.stateFor(playerId);
    const visibleById = new Map(snapshots.map((snapshot) => [snapshot.playerId, snapshot]));
    const upserts = snapshots.flatMap((snapshot): PlayerDeltaUpsert[] => {
      const known = state.knownPlayers.get(snapshot.playerId);
      if (!known) {
        return [{ kind: "full", player: snapshot }];
      }
      if (playerSnapshotUnchanged(known, snapshot)) {
        return [];
      }
      if (staticPlayerStateChanged(known, snapshot)) {
        return [{ kind: "full", player: snapshot }];
      }
      return [{
        kind: "movement",
        playerId: snapshot.playerId,
        lat: snapshot.lat,
        lon: snapshot.lon,
        movementRevision: snapshot.movementRevision,
        relocationRevision: snapshot.relocationRevision ?? 0,
        targetLat: snapshot.targetLat,
        targetLon: snapshot.targetLon,
        moving: snapshot.moving,
        online: snapshot.online,
        updatedAt: snapshot.updatedAt,
        dash: snapshot.dash ?? null,
        // Owner only: the walking speed the tick applies (mid-walk slows and gear swaps reach the prediction).
        ...(snapshot.playerId === playerId ? speedField(this.gameState.effectiveSpeedMps(playerId)) : {})
      }];
    });
    const removedPlayerIds = [...state.knownPlayers.keys()]
      .filter((knownPlayerId) => !visibleById.has(knownPlayerId))
      .sort();
    if (upserts.length === 0 && removedPlayerIds.length === 0) {
      return null;
    }
    state.knownPlayers = snapshotsById(snapshots);
    state.sequence += 1;
    this.metrics.deltasSent += 1;
    this.metrics.entitiesSent += upserts.length;
    this.metrics.maximumEntitiesPerDelta = Math.max(
      this.metrics.maximumEntitiesPerDelta,
      upserts.length
    );
    return {
      serverTime: Date.now(),
      sequence: state.sequence,
      upserts,
      removedPlayerIds
    };
  }

  visiblePlayerIdsFor(playerId: string, interest: CombatInterestFrame): string[] {
    return this.visibleSnapshots(playerId, interest).map((snapshot) => snapshot.playerId);
  }

  positionVisiblePlayerIdsFor(playerId: string, interest: CombatInterestFrame): string[] {
    return this.visibleSnapshots(playerId, interest).map((snapshot) => snapshot.playerId);
  }

  requestResync(playerId: string): void {
    this.metrics.resyncRequests += 1;
    this.resetPlayer(playerId);
  }

  needsSnapshot(playerId: string): boolean {
    return this.pendingSnapshots.has(playerId);
  }

  metricsSnapshot(): WorldReplicationMetrics & { averageEntitiesPerDelta: number } {
    return {
      ...this.metrics,
      averageEntitiesPerDelta:
        this.metrics.deltasSent === 0
          ? 0
          : this.metrics.entitiesSent / this.metrics.deltasSent
    };
  }

  private stateFor(playerId: string): RecipientState {
    let state = this.recipients.get(playerId);
    if (!state) {
      state = { sequence: 0, knownPlayers: new Map() };
      this.recipients.set(playerId, state);
    }
    return state;
  }

  private visibleSnapshots(
    playerId: string,
    interest: CombatInterestFrame
  ): PlayerSnapshot[] {
    if (!this.gameState.isWorldPresent(playerId)) return [];
    const visibleEntityIds = new Set(interest.nearbyIdsByPlayer.get(playerId) ?? [playerId]);
    const snapshots: PlayerSnapshot[] = [];
    for (const entityId of visibleEntityIds) {
      const player = this.gameState.getPlayer(entityId);
      if (player?.online && this.gameState.isWorldPresent(entityId)) {
        snapshots.push(this.gameState.snapshotForPlayer(entityId));
      }
    }
    if (!snapshots.some((snapshot) => snapshot.playerId === playerId)) {
      const localPlayer = this.gameState.getPlayer(playerId);
      if (localPlayer && this.gameState.isWorldPresent(playerId)) {
        snapshots.push(this.gameState.snapshotForPlayer(playerId));
      }
    }
    return snapshots.sort((left, right) => left.playerId.localeCompare(right.playerId));
  }
}

function speedField(speedMps: number | undefined): { speedMps?: number } {
  return speedMps !== undefined && Number.isFinite(speedMps) && speedMps > 0 ? { speedMps } : {};
}

function snapshotsById(snapshots: PlayerSnapshot[]): Map<string, PlayerSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.playerId, snapshot]));
}

function staticPlayerStateChanged(previous: PlayerSnapshot, next: PlayerSnapshot): boolean {
  return (
    previous.username !== next.username ||
    previous.displayColor !== next.displayColor ||
    previous.regionCode !== next.regionCode ||
    previous.zoneId !== next.zoneId ||
    previous.anchorLat !== next.anchorLat ||
    previous.anchorLon !== next.anchorLon ||
    previous.moveLeashRadiusM !== next.moveLeashRadiusM ||
    (previous.afloat === true) !== (next.afloat === true) ||
    (previous.classId ?? null) !== (next.classId ?? null) ||
    gatheringChanged(previous.gathering, next.gathering) ||
    appearanceChanged(previous.appearance, next.appearance)
  );
}

function gatheringChanged(
  previous: PlayerSnapshot["gathering"],
  next: PlayerSnapshot["gathering"]
): boolean {
  if (!previous || !next) return Boolean(previous) !== Boolean(next);
  return (
    previous.kind !== next.kind ||
    previous.toolDefinitionId !== next.toolDefinitionId ||
    previous.targetLat !== next.targetLat ||
    previous.targetLon !== next.targetLon ||
    previous.startedAt !== next.startedAt ||
    previous.completesAt !== next.completesAt
  );
}

function playerSnapshotUnchanged(previous: PlayerSnapshot, next: PlayerSnapshot): boolean {
  return previous.updatedAt === next.updatedAt &&
    previous.movementRevision === next.movementRevision &&
    (previous.relocationRevision ?? 0) === (next.relocationRevision ?? 0) &&
    previous.lat === next.lat &&
    previous.lon === next.lon &&
    previous.targetLat === next.targetLat &&
    previous.targetLon === next.targetLon &&
    previous.moving === next.moving &&
    previous.online === next.online &&
    dashKey(previous.dash) === dashKey(next.dash) &&
    !staticPlayerStateChanged(previous, next);
}

function dashKey(dash: PlayerSnapshot["dash"]): string {
  return dash ? `${dash.startedAt}:${dash.active ? 1 : 0}` : "";
}

function appearanceChanged(
  previous: PlayerSnapshot["appearance"],
  next: PlayerSnapshot["appearance"]
): boolean {
  if (!previous || !next) return previous !== next;
  return (
    previous.revision !== next.revision ||
    previous.catalogRevision !== next.catalogRevision ||
    previous.bodyVariantId !== next.bodyVariantId ||
    previous.poseId !== next.poseId ||
    previous.activeHand !== next.activeHand
  );
}
