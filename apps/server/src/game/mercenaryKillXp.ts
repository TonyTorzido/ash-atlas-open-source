import type { XpGrantResult } from "@ash-atlas/shared";

import type { ProgressionService } from "./progression.js";

const MERCENARY_KILL_XP_COEFFICIENT = [0, 2, 3, 4] as const;

/** Mercenary PvP kill XP: coefficient (2/3/4 by rank) x min(killer level, 33) x Momentum stacks. */
export function mercenaryKillXp(rank: number, killerLevel: number, stacks: number): number {
  if (rank < 1 || stacks < 1) return 0;
  return MERCENARY_KILL_XP_COEFFICIENT[Math.min(3, Math.floor(rank))]! * Math.min(Math.max(0, Math.floor(killerLevel)), 33) * Math.floor(stacks);
}

/** Pays the kill XP once per death: the death operation key is the progression idempotency key. */
export async function grantMercenaryKillXp(
  progression: Pick<ProgressionService, "grantXp">,
  input: Readonly<{ deathOperationKey: string; killerPlayerId: string; victimPlayerId: string; rank: number; killerLevel: number; stacks: number }>
): Promise<XpGrantResult | null> {
  const requestedXp = mercenaryKillXp(input.rank, input.killerLevel, input.stacks);
  if (requestedXp <= 0) return null;
  const result = await progression.grantXp({
    operationKey: `mercenary-kill-xp:${input.deathOperationKey}`,
    playerId: input.killerPlayerId,
    sourceType: "combat",
    sourceId: input.victimPlayerId,
    requestedXp,
    metadata: { source: "mercenary_momentum", rank: input.rank, stacks: input.stacks }
  });
  return result.replayed ? null : result;
}
