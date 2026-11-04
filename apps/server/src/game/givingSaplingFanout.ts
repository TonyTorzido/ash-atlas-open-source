import {
  SAPLING_VIEW_RADIUS_M,
  distanceMeters,
  type LatLon,
  type SaplingMapItem
} from "@ash-atlas/shared";

import type { SaplingViewChange } from "./givingSaplings.js";

export type SaplingFanoutDependencies = Readonly<{
  /** Ids of connected players near a point, from a spatial index (never a scan of all connections). */
  nearbyPlayerIds(position: LatLon, radiusM: number): readonly string[];
  /** The player's open-world position, or null when they are not on the open world. */
  playerPosition(playerId: string): LatLon | null;
  send(
    playerId: string,
    message: Readonly<{ type: "SAPLING_DELTA"; upserts: SaplingMapItem[]; removed: string[]; serverNowMs: number }>
  ): void;
  now?(): number;
}>;

/**
 * Pushes each changed tree only to the players within view range of it, one batched SAPLING_DELTA per
 * player. Work is bounded by the changed trees and the players near them.
 */
export function fanOutSaplingViewChanges(
  changes: readonly SaplingViewChange[],
  deps: SaplingFanoutDependencies
): number {
  const perPlayer = new Map<string, { upserts: SaplingMapItem[]; removed: string[] }>();
  for (const change of changes) {
    for (const playerId of deps.nearbyPlayerIds(change.position, SAPLING_VIEW_RADIUS_M)) {
      const position = deps.playerPosition(playerId);
      if (!position || distanceMeters(position, change.position) > SAPLING_VIEW_RADIUS_M) continue;
      let batch = perPlayer.get(playerId);
      if (!batch) perPlayer.set(playerId, batch = { upserts: [], removed: [] });
      if (change.upsert) batch.upserts.push(change.upsert);
      if (change.removedId) batch.removed.push(change.removedId);
    }
  }
  const serverNowMs = (deps.now ?? Date.now)();
  for (const [playerId, batch] of perPlayer) {
    deps.send(playerId, { type: "SAPLING_DELTA", upserts: batch.upserts, removed: batch.removed, serverNowMs });
  }
  return perPlayer.size;
}
