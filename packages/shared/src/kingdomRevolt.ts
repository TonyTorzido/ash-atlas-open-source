import { z } from "zod";

/*
 * Revolt and anarchy.
 *
 * Any kingdom member except the leader starts a revolt vote against the
 * leader. It passes when the yes votes are strictly more than 55% of the
 * members active in the last 6 days (the leader, who cannot vote, is not
 * counted: our choice), plus a boost of 12 points for every war death of
 * that leader in the last 2 days, capped at 24. A vote stays open for at
 * most 4 days and ends as soon as it passes.
 *
 * A passed revolt demotes the leader to member and starts 2 days of
 * anarchy: nobody holds the leader role, so every leader-only action is
 * refused, while towers keep defending. When anarchy ends the revolt's
 * starter becomes leader if still a member active in the last 6 days;
 * otherwise the longest-serving member active in the last 6 days (the
 * deposed leader last), otherwise the longest-serving member (our choice).
 * After a failed vote, a new one can start only 24 hours later (our choice).
 */
export const KINGDOM_REVOLT_VOTE_DURATION_MS = 4 * 24 * 60 * 60 * 1_000;
export const KINGDOM_REVOLT_PASS_PERCENT = 55;
export const KINGDOM_REVOLT_BOOST_PER_LEADER_DEATH = 12;
export const KINGDOM_REVOLT_BOOST_CAP = 24;
export const KINGDOM_REVOLT_BOOST_DURATION_MS = 2 * 24 * 60 * 60 * 1_000;
export const KINGDOM_ANARCHY_DURATION_MS = 2 * 24 * 60 * 60 * 1_000;
export const KINGDOM_REVOLT_FAILED_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

export function kingdomRevoltBoostPoints(leaderWarDeaths: number): number {
  const safe = Number.isSafeInteger(leaderWarDeaths) && leaderWarDeaths > 0 ? leaderWarDeaths : 0;
  return Math.min(KINGDOM_REVOLT_BOOST_CAP, safe * KINGDOM_REVOLT_BOOST_PER_LEADER_DEATH);
}

/** Yes share of the eligible voters in percent, plus the boost points. */
export function kingdomRevoltSupportPercent(input: {
  yesVotes: number;
  eligibleVoters: number;
  boostPoints: number;
}): number {
  const share = input.eligibleVoters > 0 ? (input.yesVotes * 100) / input.eligibleVoters : 0;
  return share + input.boostPoints;
}

/** Strictly more than 55%, compared in integers so 1 of 2 never rounds up. */
export function kingdomRevoltPasses(input: {
  yesVotes: number;
  eligibleVoters: number;
  boostPoints: number;
}): boolean {
  if (input.eligibleVoters <= 0) return false;
  return input.yesVotes * 100 + input.boostPoints * input.eligibleVoters >
    KINGDOM_REVOLT_PASS_PERCENT * input.eligibleVoters;
}

export type KingdomRevoltSnapshot = {
  revoltId: string;
  targetLeaderPlayerId: string;
  targetLeaderName: string;
  startedByPlayerId: string;
  startedByName: string;
  openedAt: string;
  closesAt: string;
  yesVotes: number;
  noVotes: number;
  /** Members active in the last 6 days, the leader excluded. */
  eligibleVoters: number;
  boostPoints: number;
  /** When the last counted leader war death stops boosting; null without a boost. */
  boostEndsAt: string | null;
  supportPercent: number;
  viewerVote: "yes" | "no" | null;
  viewerCanVote: boolean;
};

export type KingdomAnarchySnapshot = {
  endsAt: string;
  revoltId: string;
  deposedLeaderPlayerId: string;
  deposedLeaderName: string;
};

export type KingdomRevoltState = {
  revolt: KingdomRevoltSnapshot | null;
  anarchy: KingdomAnarchySnapshot | null;
  /** The current leader's revolt boost even without an open vote. */
  boostPoints: number;
  /** After a failed vote, when the next one may start; null when none is waiting. */
  nextRevoltAt: string | null;
  serverTime: string;
};

export const kingdomRevoltVoteInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  revoltId: z.string().uuid(),
  support: z.boolean()
}).strict();
export type KingdomRevoltVoteInput = z.infer<typeof kingdomRevoltVoteInputSchema>;
