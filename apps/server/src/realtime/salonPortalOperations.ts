import type { ServerMessage } from "@ash-atlas/shared";

import {
  SalonError,
  type SalonRuntime,
  type SalonService
} from "../game/salon.js";
import type { GameState } from "../game/state.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";

export function createSalonPortalOperations(context: Readonly<{
  registry: ConnectionRegistry;
  gameState: GameState;
  salon?: SalonService | undefined;
  salonRuntime?: SalonRuntime | undefined;
}>): Readonly<{
  projectEntry(input: Readonly<{
    playerId: string;
    requestId: string;
    structureId: string;
    expectedPlacementRevision: string;
  }>): Promise<void>;
  projectExit(input: Readonly<{
    playerId: string;
    requestId: string;
  }>): Promise<void>;
}> {
  const requireServices = (): { salon: SalonService; runtime: SalonRuntime } => {
    if (!context.salon || !context.salonRuntime) {
      throw new SalonError("UNAVAILABLE", "The Salon is unavailable.");
    }
    return { salon: context.salon, runtime: context.salonRuntime };
  };

  return {
    async projectEntry(input) {
      const { salon, runtime } = requireServices();
      const player = context.gameState.getPlayer(input.playerId);
      if (!player) throw new SalonError("NOT_CONNECTED", "Player state is unavailable.");
      const presence = await salon.enter(
        player,
        input.structureId,
        input.expectedPlacementRevision
      );
      const session = runtime.enter(presence);
      context.registry.send(
        input.playerId,
        enteredMessage(session, player, input.requestId)
      );
    },

    async projectExit(input) {
      const { salon, runtime } = requireServices();
      const session = runtime.get(input.playerId);
      if (!session) throw new SalonError("NOT_INSIDE", "You are not inside a Salon.");
      await salon.exit(input.playerId, session.sessionId);
      runtime.exit(input.playerId, session.sessionId);
      context.registry.send(input.playerId, {
        type: "SALON_EXITED",
        requestId: input.requestId,
        player: context.gameState.snapshotForPlayer(input.playerId)
      });
    }
  };
}

function enteredMessage(
  session: NonNullable<ReturnType<SalonRuntime["get"]>>,
  player: NonNullable<ReturnType<GameState["getPlayer"]>>,
  requestId: string
): ServerMessage {
  return {
    type: "SALON_ENTERED",
    requestId,
    structureId: session.structureId,
    salonSessionId: session.sessionId,
    displayColor: player.displayColor,
    ...(player.appearance ? { appearance: player.appearance } : {}),
    position: session.position,
    movementSequence: session.movementSequence,
    serverTime: Date.now()
  };
}
