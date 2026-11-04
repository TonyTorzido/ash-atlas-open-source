/**
 * Player-versus-player timers: the strike-block rule.
 *
 * - One swing: when A hits B and B is not fighting A, A's hit lands once and
 *   A cannot attack B again for 20 hours (the strike block).
 * - Aggressor marks: every player who lands damage on B is marked as B's
 *   aggressor for 20 hours (refreshed by each of their hits). B may attack a
 *   marked aggressor at any time; the mark is the victim's revenge.
 * - Fighting: when B retaliates against a marked aggressor, the two fight
 *   normally while their aggression is up (the combat aggression timer,
 *   refreshed by every landed hit between them). While they fight, A's strike
 *   block does not apply. Once aggression drops, A is blocked again if the
 *   20 hours have not run out. B can re-engage at any time while the mark lasts.
 * - Aggressive players are fair game: while B is Aggressive (combat
 *   aggression timer up, from hitting anything), anyone may attack B, even
 *   inside a strike block or B's post-kill safety. B hits back automatically
 *   (only if B has no target of their own) and the strike starts a fight
 *   instead of a one-swing block. A is still marked; B's hits back never mark
 *   B. No new block comes from that exchange; once aggression drops, any
 *   earlier block or safety applies again for the rest of its 20 hours.
 * - Post-kill safety: a player killed by a player is safe from every player
 *   for 20 hours, except while they are Aggressive again.
 * - Beginner protection: at level 3 and under a death costs nothing (no XP,
 *   no gold, no max HP) and a killer takes no gold from a beginner.
 *
 * None of these override the trust shield, arrival protection, land-action
 * guard, or zone rules.
 */
export const PVP_STRIKE_BLOCK_MS = 20 * 60 * 60_000;
export const PVP_AGGRESSOR_MARK_MS = 20 * 60 * 60_000;
/** A player killed by a player is safe from every player this long (lifted while they are Aggressive). */
export const PVP_DEFEAT_SAFETY_MS = 20 * 60 * 60_000;
/** Highest character level that still has beginner protection (level 3 and under). */
export const BEGINNER_PROTECTION_MAX_LEVEL = 3;
/** Share of the victim's carried gold a PvP killer takes (12%, rounded down). */
export const PVP_DEATH_GOLD_LOSS_PERCENT = 12;
/**
 * The same killer takes death gold from the same victim at most once per this
 * window; a repeat kill inside it moves no gold either way (anti-farm).
 */
export const PVP_DEATH_GOLD_REPEAT_WINDOW_MS = 20 * 60 * 60_000;

/** True while a player of this level loses nothing on death. */
export function isBeginnerProtectedLevel(level: number): boolean {
  return level <= BEGINNER_PROTECTION_MAX_LEVEL;
}

export function pvpDeathGoldLoss(carriedGold: bigint): bigint {
  return carriedGold <= 0n ? 0n : carriedGold * BigInt(PVP_DEATH_GOLD_LOSS_PERCENT) / 100n;
}

export const PVP_TIMER_KINDS = [
  /** This player struck you: you may attack them back. */
  "aggressor",
  /** You struck this player: they may attack you. */
  "marked",
  /** You already used your one swing on this player: you cannot attack them. */
  "cannot_attack",
  /** You and this player are fighting: both may attack freely until aggression drops. */
  "fighting"
] as const;
export type PvpTimerKind = (typeof PVP_TIMER_KINDS)[number];

export type PvpTimerEntry = Readonly<{
  kind: PvpTimerKind;
  playerId: string;
  displayName: string;
  /**
   * Server epoch milliseconds. For "fighting" this is the expiry when the
   * status was sent; hits keep extending it and the server sends a new status
   * when the fight ends.
   */
  expiresAt: number;
}>;

/** "19h 40m", "35m", "1m" for a remaining duration. */
export function formatPvpTimerRemaining(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The refusal shown when a player tries to swing again inside their strike block. */
export function pvpStrikeBlockRefusal(targetName: string, remainingMs: number): string {
  return `You already struck ${targetName}; you can't attack them again for ` +
    `${formatPvpTimerRemaining(remainingMs)} unless they fight back or turn aggressive`;
}

/** The refusal shown when attacking a player inside their post-kill safety. */
export function pvpDefeatSafetyRefusal(targetName: string, remainingMs: number): string {
  return `${targetName} was recently defeated and is safe for ${formatPvpTimerRemaining(remainingMs)} unless they turn aggressive`;
}

export type PvpAttackVerdict = Readonly<{
  /**
   * False when the strike-block rule certainly refuses an attack on this player.
   * The viewer's timers alone never decide that any more: an Aggressive target
   * overrides every block, and only the server knows who is Aggressive.
   */
  allowed: boolean;
  /** True when an allowed attack lands one hit and then starts the 20-hour block. */
  oneSwing: boolean;
  /** Short player-facing reason, or null when there is nothing to say. */
  reason: string | null;
}>;

/**
 * Whether the strike-block rule lets the viewer attack a player, from the viewer's
 * PVP_STATUS timers. Only the strike-block rule: the trust shield, arrival
 * protection, and zone rules are still checked by the server.
 */
export function pvpAttackVerdict(
  timers: readonly PvpTimerEntry[],
  targetPlayerId: string,
  serverNowMs: number
): PvpAttackVerdict {
  const forTarget = timers.filter((timer) => timer.playerId === targetPlayerId);
  const find = (kind: PvpTimerKind) => forTarget.find((timer) => timer.kind === kind && timer.expiresAt > serverNowMs);
  const fighting = forTarget.find((timer) => timer.kind === "fighting");
  if (fighting) return { allowed: true, oneSwing: false, reason: `Fighting ${fighting.displayName}` };
  const aggressor = find("aggressor");
  if (aggressor) {
    return {
      allowed: true,
      oneSwing: false,
      reason: `They struck you: you may attack them (${formatPvpTimerRemaining(aggressor.expiresAt - serverNowMs)})`
    };
  }
  const blocked = find("cannot_attack");
  if (blocked) {
    // The client cannot see whether the target is Aggressive (which lifts the
    // block), so the attack stays available and the server decides.
    return {
      allowed: true,
      oneSwing: false,
      reason: pvpStrikeBlockRefusal(blocked.displayName, blocked.expiresAt - serverNowMs)
    };
  }
  return { allowed: true, oneSwing: true, reason: "One swing: they must fight back for more (an Aggressive player does at once)" };
}
