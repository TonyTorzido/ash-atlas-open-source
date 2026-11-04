import type { ServerMessage } from "@ash-atlas/shared";

import { PlayerGiftError, type PlayerGiftService } from "../../game/playerGifts.js";
import type { SocketLike } from "../connectionRegistry.js";
import type {
  RealtimeFamilyHandler,
  RealtimeMessageRouter
} from "../messageRouter.js";
import {
  requireHello,
  type RealtimeConnectionState
} from "./handlerExecutionContext.js";

export function createPlayerGiftHandler(context: Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  gifts: PlayerGiftService;
  sendToPlayer(playerId: string, message: ServerMessage): void;
  enforcePlayerClassRate(key: string, maximum: number, windowMs: number): void;
  safeSendServerMessage(socket: SocketLike, message: ServerMessage): boolean;
  logError?(error: unknown, messageType: string): void;
}>): RealtimeFamilyHandler<"gifts"> {
  const fail = (requestId: string, error: unknown, fallbackCode: string, fallbackMessage: string, messageType: string) => {
    if (!(error instanceof PlayerGiftError)) context.logError?.(error, messageType);
    context.safeSendServerMessage(context.socket, {
      type: "PLAYER_GIFT_ERROR",
      requestId,
      code: error instanceof PlayerGiftError ? error.code : fallbackCode,
      message: error instanceof PlayerGiftError ? error.message : fallbackMessage
    });
  };
  return async (message) => {
    requireHello(context.state.playerId);
    const playerId = context.state.playerId;
    switch (message.type) {
      case "REQUEST_GIFT_STATUS":
        context.enforcePlayerClassRate("player-gift-status", 12, 10_000);
        try {
          context.safeSendServerMessage(context.socket, {
            type: "PLAYER_GIFT_STATUS",
            requestId: message.requestId,
            ...await context.gifts.status(playerId)
          });
        } catch (error) {
          fail(message.requestId, error, "PLAYER_GIFT_FAILED", "Gift status is unavailable", message.type);
        }
        return;
      case "BUY_GIFT_BOX":
        context.enforcePlayerClassRate("gift-box-buy", 6, 10_000);
        try {
          const result = await context.gifts.buyGiftBoxes(playerId, message.requestId, message.quantity);
          context.safeSendServerMessage(context.socket, { type: "GIFT_BOX_PURCHASE_RESULT", ...result });
        } catch (error) {
          fail(message.requestId, error, "GIFT_BOX_PURCHASE_FAILED", "Gift Box purchase failed", message.type);
        }
        return;
      case "SEND_PLAYER_GIFT":
        context.enforcePlayerClassRate("player-gift-send", 6, 10_000);
        try {
          const { type: _type, ...input } = message;
          void _type;
          const result = await context.gifts.send(playerId, input);
          context.safeSendServerMessage(context.socket, {
            type: "PLAYER_GIFT_SEND_RESULT",
            requestId: result.requestId,
            replayed: result.replayed,
            packageId: result.packageId,
            recipientPlayerId: result.recipientPlayerId,
            recipientName: result.recipientName,
            inventory: result.inventory,
            equipment: result.equipment
          });
          if (!result.replayed) {
            context.sendToPlayer(result.recipientPlayerId, {
              type: "PLAYER_PACKAGE_AVAILABLE",
              package: result.package
            });
          }
        } catch (error) {
          fail(message.requestId, error, "PLAYER_GIFT_FAILED", "Gift could not be sent", message.type);
        }
        return;
    }
  };
}

export function registerPlayerGiftHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"gifts">
): void {
  router.register("gifts", handler);
}
