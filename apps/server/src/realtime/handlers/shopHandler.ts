import type { ServerMessage } from "@ash-atlas/shared";

import { GlimmerShopError, type GlimmerShopService } from "../../game/glimmerShop.js";
import type { SocketLike } from "../connectionRegistry.js";
import type {
  RealtimeFamilyHandler,
  RealtimeMessageRouter
} from "../messageRouter.js";
import {
  requireHello,
  type RealtimeConnectionState
} from "./handlerExecutionContext.js";

/** Glimmer Shop commands: the catalog read and the one purchase command for items and carts. */
export function createShopHandler(context: Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  shop: GlimmerShopService;
  enforcePlayerClassRate(key: string, maximum: number, windowMs: number): void;
  safeSendServerMessage(socket: SocketLike, message: ServerMessage): boolean;
  logError?(error: unknown, messageType: string): void;
}>): RealtimeFamilyHandler<"shop"> {
  const fail = (requestId: string, error: unknown, messageType: string) => {
    if (!(error instanceof GlimmerShopError)) context.logError?.(error, messageType);
    context.safeSendServerMessage(context.socket, {
      type: "SHOP_ERROR",
      requestId,
      code: error instanceof GlimmerShopError ? error.code : "SHOP_FAILED",
      message: error instanceof GlimmerShopError ? error.message : "The shop request failed."
    });
  };
  return async (message) => {
    requireHello(context.state.playerId);
    const playerId = context.state.playerId;
    switch (message.type) {
      case "REQUEST_SHOP_CATALOG":
        context.enforcePlayerClassRate("shop-catalog", 12, 10_000);
        try {
          context.safeSendServerMessage(context.socket, {
            type: "SHOP_CATALOG",
            requestId: message.requestId,
            ...await context.shop.catalog()
          });
        } catch (error) {
          fail(message.requestId, error, message.type);
        }
        return;
      case "BUY_SHOP_ITEMS":
        context.enforcePlayerClassRate("shop-buy", 6, 10_000);
        try {
          const { type: _type, ...input } = message;
          void _type;
          const result = await context.shop.buy(playerId, input);
          context.safeSendServerMessage(context.socket, { type: "SHOP_PURCHASE_RESULT", ...result });
        } catch (error) {
          fail(message.requestId, error, message.type);
        }
        return;
    }
  };
}

export function registerShopHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"shop">
): void {
  router.register("shop", handler);
}
