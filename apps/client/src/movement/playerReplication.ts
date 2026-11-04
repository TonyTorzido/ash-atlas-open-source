import type { PlayerDeltaUpsert, PlayerSnapshot } from "@ash-atlas/shared";

export type PlayerDeltaSequenceResult = "apply" | "ignore" | "gap";

export function classifyPlayerDeltaSequence(
  currentSequence: number,
  incomingSequence: number
): PlayerDeltaSequenceResult {
  if (incomingSequence <= currentSequence) {
    return "ignore";
  }
  return incomingSequence === currentSequence + 1 ? "apply" : "gap";
}

/**
 * What to do with a player delta. Old or duplicate deltas are dropped (stale-message protection). A delta past a
 * gap is still applied: every upsert carries the player's absolute state (position, target, revisions), so it is
 * correct on its own, and the movement revision checks in the render timeline still reject anything older. The
 * gap is repaired by a resync in the background instead of freezing every player until the (rate-limited) snapshot.
 */
export function playerDeltaAction(
  currentSequence: number,
  incomingSequence: number
): Readonly<{ apply: boolean; resync: boolean }> {
  const result = classifyPlayerDeltaSequence(currentSequence, incomingSequence);
  return { apply: result !== "ignore", resync: result === "gap" };
}

export function applyPlayerDelta(
  players: readonly PlayerSnapshot[],
  upserts: readonly PlayerDeltaUpsert[],
  removedPlayerIds: readonly string[]
): PlayerSnapshot[] {
  const removed = new Set(removedPlayerIds);
  const byId = new Map(
    players
      .filter((player) => !removed.has(player.playerId))
      .map((player) => [player.playerId, player])
  );
  for (const upsert of upserts) {
    if (upsert.kind === "full") {
      const current = byId.get(upsert.player.playerId);
      if (
        !current ||
        relocationRevision(upsert.player.relocationRevision) >=
          relocationRevision(current.relocationRevision)
      ) {
        const appearance =
          current?.appearance &&
          upsert.player.appearance &&
          current.appearance.revision > upsert.player.appearance.revision
            ? current.appearance
            : upsert.player.appearance;
        byId.set(upsert.player.playerId, {
          ...upsert.player,
          ...(appearance ? { appearance } : {})
        });
      }
      continue;
    }
    const player = byId.get(upsert.playerId);
    if (
      player &&
      relocationRevision(upsert.relocationRevision, player.relocationRevision) >=
        relocationRevision(player.relocationRevision)
    ) {
      byId.set(upsert.playerId, {
        ...player,
        lat: upsert.lat,
        lon: upsert.lon,
        movementRevision: upsert.movementRevision,
        relocationRevision: relocationRevision(upsert.relocationRevision, player.relocationRevision),
        targetLat: upsert.targetLat,
        targetLon: upsert.targetLon,
        moving: upsert.moving,
        online: upsert.online,
        updatedAt: upsert.updatedAt,
        ...(upsert.dash !== undefined ? { dash: upsert.dash } : {})
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.playerId.localeCompare(right.playerId));
}

function relocationRevision(value: number | undefined, fallback = 0): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}
