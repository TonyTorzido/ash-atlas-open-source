import type { CombatEngine } from "./combat/combatEngine.js";
import type { GameState } from "./state.js";
import type { WorldRuntime } from "./worldRuntime.js";

export type TravelBlockReason = Readonly<{
  code: string;
  message: string;
  retryAfterMs?: number;
  retryable?: boolean;
  currentTollGold?: string;
  requiredGold?: string;
  relocationRevision?: number;
  resourceVisionRevision?: number;
  gameplayViewGeneration?: number;
}>;

export function getCityConstructionBlockReason(
  gameState: Pick<GameState, "isMovementBlocked">,
  playerId: string
): TravelBlockReason | null {
  return gameState.isMovementBlocked(playerId, "city-construction")
    ? {
        code: "CITY_CONSTRUCTION_ACTIVE",
        message: "Finish the current city construction before relocating."
      }
    : null;
}

/**
 * One authoritative restriction source for flag visits, Travel Invites, and
 * party travel. Callers still own destination authorization and transition
 * reservation; this function owns traveler eligibility.
 */
export function getTravelBlockReason(input: {
  playerId: string;
  gameState: GameState;
  worldRuntime?: WorldRuntime;
  combat?: CombatEngine;
  hasActiveClassMutation?: (playerId: string) => boolean;
  xoralExitRole?: (playerId: string) => "leader" | "follower" | null;
}): TravelBlockReason | null {
  const player = input.gameState.getPlayer(input.playerId);
  if (!player?.online) {
    return { code: "TRAVEL_PLAYER_OFFLINE", message: "Player is not connected." };
  }
  if (!input.gameState.isWorldPresent(input.playerId)) {
    return { code: "TRAVEL_LOCATION_INCOMPATIBLE", message: "Travel is unavailable from this private location." };
  }
  const xoralExitRole = input.xoralExitRole?.(input.playerId) ?? null;
  if (xoralExitRole) {
    return xoralExitRole === "leader"
      ? {
          code: "XORAL_LEADER_EXIT_CONFIRMATION_REQUIRED",
          message: "Travelling will cancel The Xoral event for the entire locked party. Confirm before leaving."
        }
      : {
          code: "XORAL_FOLLOWER_EXIT_CONFIRMATION_REQUIRED",
          message: "Travelling will permanently remove you from The Xoral event. Confirm before leaving."
        };
  }
  const cityConstructionBlock = getCityConstructionBlockReason(
    input.gameState,
    input.playerId
  );
  if (cityConstructionBlock) return cityConstructionBlock;
  if (input.gameState.isMovementBlocked(input.playerId, "fishing")) {
    return {
      code: "FISHING_ACTIVE",
      message: "Leave the active Fishing encounter before travelling."
    };
  }
  if (input.worldRuntime?.hasPendingCommand(input.playerId)) {
    return { code: "PLAYER_WORLD_COMMAND_PENDING", message: "A world command must finish before travelling." };
  }
  if (input.hasActiveClassMutation?.(input.playerId)) {
    return { code: "CLASS_MUTATION_PENDING", message: "A class mutation must finish before travelling." };
  }
  if (input.combat?.hasQueuedAbility(input.playerId)) {
    return { code: "TRAVEL_ACTION_PENDING", message: "A queued combat action must resolve before travelling." };
  }
  if (input.combat && !input.combat.isPlayerAlive(input.playerId)) {
    return { code: "TRAVEL_PLAYER_DEFEATED", message: "You cannot travel while defeated or respawning." };
  }
  const aggressionRemainingMs = input.combat?.aggressionRemainingMs(input.playerId) ?? 0;
  // A Battle Draught lifts the aggression travel lock for as long as it lasts.
  if (aggressionRemainingMs > 0 && !input.combat?.hasBattleDraught?.(input.playerId)) {
    return {
      code: "TRAVEL_AGGRESSIVE",
      message: `Cannot travel while Aggressive. ${(aggressionRemainingMs / 1_000).toFixed(1)}s remaining.`,
      retryAfterMs: aggressionRemainingMs
    };
  }
  return null;
}
