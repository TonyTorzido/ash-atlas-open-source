import type { PlayerSnapshot } from "@ash-atlas/shared";

export function upsertPlayerSnapshot(
  players: PlayerSnapshot[],
  next: PlayerSnapshot
): PlayerSnapshot[] {
  const existingIndex = players.findIndex(
    (player) => player.playerId === next.playerId
  );
  if (existingIndex === -1) return [next, ...players];

  const existing = players[existingIndex]!;
  const existingRelocation = existing.relocationRevision ?? 0;
  const nextRelocation = next.relocationRevision ?? existingRelocation;
  if (
    nextRelocation < existingRelocation ||
    (
      nextRelocation === existingRelocation &&
      Date.parse(next.updatedAt) < Date.parse(existing.updatedAt)
    )
  ) {
    return players;
  }
  return players.map((player) =>
    player.playerId === next.playerId ? next : player
  );
}
