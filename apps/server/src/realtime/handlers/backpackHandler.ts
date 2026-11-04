import type { BackpackOperationResult, ServerMessage } from "@ash-atlas/shared";

import type { AuthenticatedSession } from "../../auth/types.js";
import { BackpackError, type BackpackService } from "../../game/backpacks.js";
import type { AppLogger } from "../../logger.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import {
  requireHello,
  type RealtimeConnectionState
} from "./handlerExecutionContext.js";

export type BackpackHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId" | "connectionId">;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  registry: ConnectionRegistry;
  backpacks?: BackpackService | undefined;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
}>;

export function createBackpackHandler(
  context: BackpackHandlerContext
): RealtimeFamilyHandler<"backpack"> {
  return async (message) => {
    const {
      state,
      socket,
      authenticatedSession,
      registry,
      backpacks,
      safeSendServerMessage
    } = context;
    requireHello(state.playerId);
    if (!backpacks || !authenticatedSession || !state.connectionId) {
      safeSendServerMessage(socket, {
        type: "BACKPACK_ERROR",
        requestId: message.requestId,
        code: "BACKPACK_INVALID_REQUEST",
        message: "Backpacks are unavailable."
      });
      return;
    }
    if (!registry.isActiveConnection(
      authenticatedSession.account.id,
      state.connectionId
    )) {
      safeSendServerMessage(socket, {
        type: "BACKPACK_ERROR",
        requestId: message.requestId,
        code: "BACKPACK_INVALID_REQUEST",
        message: "This connection is no longer authoritative."
      });
      return;
    }
    try {
      const actor = {
        playerId: state.playerId,
        accountId: authenticatedSession.account.id
      };
      let result: BackpackOperationResult;
      switch (message.type) {
        case "CRAFT_BACKPACK":
          result = await backpacks.craft(actor, message.requestId);
          break;
        case "CREATE_STARTER_BACKPACK":
          result = await backpacks.createStarter(
            actor,
            message.requestId,
            message.targetEquippedSlot
          );
          break;
        case "EQUIP_BACKPACK":
        case "UNEQUIP_BACKPACK":
          throw new BackpackError(
            "BACKPACK_INVALID_REQUEST",
            "Backpack equip and unequip actions are no longer supported."
          );
        case "UPGRADE_BACKPACK":
          result = await backpacks.upgrade(
            actor,
            message.requestId,
            message.instanceId
          );
          break;
      }
      registry.send(state.playerId, {
        type: "BACKPACK_OPERATION_RESULT",
        result
      });
    } catch (error) {
      const backpackError = error instanceof BackpackError ? error : null;
      safeSendServerMessage(socket, {
        type: "BACKPACK_ERROR",
        requestId: message.requestId,
        code: backpackError?.code ?? "BACKPACK_INVALID_REQUEST",
        message: backpackError?.message ?? "Backpack request could not be completed.",
        ...(backpackError?.diagnostic
          ? { diagnostic: backpackError.diagnostic }
          : {})
      });
    }
  };
}

export function registerBackpackHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"backpack">
): void {
  router.register("backpack", handler);
}
