import type { PartySnapshot } from "./PartyAuthority.js";

export function autoFollowPlayerIdsForLeader(
  party: PartySnapshot | null,
  leaderPlayerId: string
): string[] {
  if (!party || !party.allowTravel || party.leaderPlayerId !== leaderPlayerId) return [];
  return party.autoFollowPlayerIds.filter((playerId) =>
    playerId !== leaderPlayerId && party.memberPlayerIds.includes(playerId)
  );
}
