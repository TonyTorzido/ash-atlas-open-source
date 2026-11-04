import type { LatLon } from "@ash-atlas/shared";

import type { AltDoorwayGate } from "../../auth/trust/altDoorway.js";
import type { HostileActionGate } from "../../auth/trust/hostileGate.js";
import type { LandActionGate, LandActionKind } from "../../auth/trust/trustService.js";
import type { SocketLike } from "../connectionRegistry.js";

type SendCombatError = (
  socket: SocketLike,
  requestId: string,
  code: string,
  message: string,
  details?: { retryAfterMs?: number; retryable?: boolean }
) => void;

export type LandActionGuardInput = Readonly<{
  landActions: LandActionGate | undefined;
  accountId: string | null | undefined;
  playerId: string;
  action: LandActionKind;
  position: LatLon | null | undefined;
}>;

// Returns false (after sending LAND_ACTION_SETTLING) only when an enforced
// relocation hold refuses the land action.
export async function landActionAllowed(
  input: LandActionGuardInput,
  socket: SocketLike,
  requestId: string,
  sendCombatError: SendCombatError
): Promise<boolean> {
  if (!input.landActions || !input.accountId) return true;
  const decision = await input.landActions.check({
    accountId: input.accountId,
    playerId: input.playerId,
    action: input.action,
    position: input.position ? { lat: input.position.lat, lon: input.position.lon } : null
  });
  if (decision.allowed) return true;
  sendCombatError(socket, requestId, decision.code, decision.message, {
    retryable: true,
    retryAfterMs: decision.retryAfterMs
  });
  return false;
}

// Fire-and-forget; the gate logs its own failures.
export function noteLandAction(input: LandActionGuardInput): void {
  if (!input.landActions || !input.accountId || !input.position) return;
  void input.landActions.recordLandAction({
    accountId: input.accountId,
    playerId: input.playerId,
    action: input.action,
    position: { lat: input.position.lat, lon: input.position.lon }
  });
}

// Returns false (after sending ARRIVAL_RAID_HOLD) when a player who just
// arrived by Travel Invite or Party Travel tries to burn or attack a flag
// they do not own. PvP never goes through this check.
export async function arrivalRaidAllowed(
  input: Readonly<{
    altDoorway: AltDoorwayGate | undefined;
    accountId: string | null | undefined;
    playerId: string;
    action: "flag_burn" | "flag_attack";
    flagId: string;
  }>,
  socket: SocketLike,
  requestId: string,
  sendCombatError: SendCombatError
): Promise<boolean> {
  if (!input.altDoorway) return true;
  const decision = await input.altDoorway.checkRaid({
    accountId: input.accountId ?? null,
    playerId: input.playerId,
    action: input.action,
    flagId: input.flagId
  });
  if (decision.allowed) return true;
  sendCombatError(socket, requestId, decision.code, decision.message, {
    retryable: true,
    ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs })
  });
  return false;
}

// Flag burn/attack on a flag the player does not own: refused (after sending
// the refusal) while the player is on an arrival hold (ARRIVAL_RAID_HOLD) or
// while their account is not Settled (HOSTILE_UNSETTLED, plan 3.4).
export async function raidAllowed(
  input: Readonly<{
    altDoorway: AltDoorwayGate | undefined;
    hostileGate: HostileActionGate | undefined;
    accountId: string | null | undefined;
    playerId: string;
    action: "flag_burn" | "flag_attack";
    flagId: string;
  }>,
  socket: SocketLike,
  requestId: string,
  sendCombatError: SendCombatError
): Promise<boolean> {
  if (input.hostileGate) {
    const decision = await input.hostileGate.checkFlagRaid({
      playerId: input.playerId,
      flagId: input.flagId,
      action: input.action
    });
    if (!decision.allowed) {
      sendCombatError(socket, requestId, decision.code, decision.message);
      return false;
    }
  }
  return arrivalRaidAllowed(input, socket, requestId, sendCombatError);
}
