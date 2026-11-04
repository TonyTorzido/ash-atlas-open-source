import type { KingdomService } from "./kingdoms.js";

export async function refreshDueKingdomPerks(
  kingdoms: Pick<KingdomService, "connectedQualificationDeadlines">,
  connectedPlayerIds: string[],
  activatedMemberships: Set<string>,
  refreshPlayerStats: (playerIds: string[]) => Promise<void>,
  nowMs = Date.now()
): Promise<string[]> {
  const deadlines = await kingdoms.connectedQualificationDeadlines(connectedPlayerIds);
  const activeIds = new Set(deadlines.map(({ membershipId }) => membershipId));
  for (const membershipId of [...activatedMemberships]) {
    if (!activeIds.has(membershipId)) activatedMemberships.delete(membershipId);
  }
  const due = deadlines.filter(({ membershipId, qualifiedAt }) =>
    qualifiedAt.getTime() <= nowMs && !activatedMemberships.has(membershipId));
  if (due.length === 0) return [];
  const results = await Promise.allSettled(due.map(async ({ playerId }) => {
    await refreshPlayerStats([playerId]);
    return playerId;
  }));
  const refreshed: string[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    activatedMemberships.add(due[index]!.membershipId);
    refreshed.push(result.value);
  });
  return refreshed;
}
