import type { ClientMessage, ServerMessage } from "@ash-atlas/shared";

import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { MarketError, type MarketActor } from "../../game/marketRules.js";
import type { MarketService } from "../../game/marketService.js";
import type { InventoryService } from "../../game/inventory.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type {
  MessageForFamily,
  RealtimeFamilyHandler,
  RealtimeMessageRouter
} from "../messageRouter.js";
import type { RealtimeConnectionState } from "./handlerExecutionContext.js";

const MARKET_EDGE_WINDOW_MS = 10_000;
const MARKET_EDGE_NETWORK_SUBJECT_CAP = 65_536;

export class MarketNetworkRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  take(key: string, maximum: number, windowMs: number, now: number): boolean {
    const existing = this.windows.get(key);
    if (!existing || now - existing.startedAt >= windowMs) {
      this.prune(now, windowMs);
      if (!existing && this.windows.size >= MARKET_EDGE_NETWORK_SUBJECT_CAP) return false;
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= maximum;
  }

  private prune(now: number, windowMs: number): void {
    if (this.windows.size < 1_024) return;
    for (const [key, value] of this.windows) {
      if (now - value.startedAt >= windowMs) this.windows.delete(key);
    }
  }
}

export type MarketHandler = RealtimeFamilyHandler<"market"> & Readonly<{
  admit(message: MessageForFamily<"market">): boolean;
}>;

export function isMarketMessage(
  message: ClientMessage
): message is MessageForFamily<"market"> {
  return message.type.startsWith("MARKET_");
}

export type MarketHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId" | "connectionId">;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  market?: MarketService | undefined;
  inventory?: Pick<InventoryService, "getInventorySnapshot"> | undefined;
  networkKey: string;
  networkRateLimiter: MarketNetworkRateLimiter;
  recordEdgeRateLimitRejection(): void;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
}>;

export function createMarketHandler(context: MarketHandlerContext): MarketHandler {
  let windowStartedAt = 0;
  let windowCount = 0;
  const sendMarketError = (
    requestId: string,
    code: string,
    message: string,
    retryable: boolean
  ): void => {
    context.safeSendServerMessage(context.socket, {
      type: "MARKET_ERROR",
      requestId,
      code,
      message,
      retryable
    });
  };
  const admit = (message: MessageForFamily<"market">): boolean => {
    const now = Date.now();
    if (now - windowStartedAt >= MARKET_EDGE_WINDOW_MS) {
      windowStartedAt = now;
      windowCount = 0;
    }
    windowCount += 1;
    const connectionAllowed =
      windowCount <= (context.config?.WS_MARKET_REQUESTS_PER_10_SECONDS ?? 40);
    const networkAllowed = context.networkRateLimiter.take(
      context.networkKey,
      context.config?.WS_MARKET_IP_REQUESTS_PER_10_SECONDS ?? 160,
      MARKET_EDGE_WINDOW_MS,
      now
    );
    if (connectionAllowed && networkAllowed) return true;
    context.recordEdgeRateLimitRejection();
    sendMarketError(
      message.requestId,
      "MARKET_RATE_LIMITED",
      "Market request rate limit reached",
      true
    );
    return false;
  };
  const handler: RealtimeFamilyHandler<"market"> = async (message) => {
    const { state, authenticatedSession, logger, registry, market } = context;
    const handleMarketRequest = async (
      requestId: string,
      operation: (actor: MarketActor, connectionId: string) => Promise<void>
    ): Promise<void> => {
      const targetConnectionId = state.connectionId;
      if (!targetConnectionId || !state.playerId || !authenticatedSession?.player) {
        sendMarketError(
          requestId,
          "MARKET_HELLO_REQUIRED",
          "HELLO is required before market requests",
          false
        );
        return;
      }
      if (!market) {
        sendMarketError(requestId, "MARKET_UNAVAILABLE", "Market service is unavailable", true);
        return;
      }
      const actor: MarketActor = {
        playerId: state.playerId,
        accountId: authenticatedSession.account.id
      };
      try {
        await operation(actor, targetConnectionId);
      } catch (error) {
        if (error instanceof MarketError && error.code === "MARKET_ACCESS_DENIED") {
          logger.info(
            {
              ...error.diagnostics,
              playerId: actor.playerId,
              connectionId: targetConnectionId,
              requestId,
              invalidationReason:
                error.diagnostics?.invalidationReason ?? "access_denied"
            },
            "market access denied"
          );
        }
        if (!(error instanceof MarketError)) {
          logger.warn(
            { err: error, accountId: actor.accountId, playerId: actor.playerId, requestId },
            "market websocket request failed"
          );
        }
        sendMarketError(
          requestId,
          error instanceof MarketError ? error.code : "MARKET_REQUEST_FAILED",
          error instanceof MarketError ? error.message : "Market request could not be completed",
          error instanceof MarketError ? error.retryable : false
        );
      }
    };
    switch (message.type) {
      case "MARKET_OPEN": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          const venue = await market!.openSession(
            actor,
            targetConnectionId,
            message.marketStructureId,
            message.expectedPlacementRevision
          );
          const snapshot = await market!.read.snapshot(actor, venue, {
            ...(message.search !== undefined ? { search: message.search } : {}),
            ...(message.category !== undefined ? { category: message.category } : {}),
            ...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
            ...(message.limit !== undefined ? { limit: message.limit } : {}),
            ...(message.listedOnly ? { listedOnly: true } : {})
          });
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_OPEN_RESULT",
            requestId: message.requestId,
            snapshot
          });
        });
        return;
      }
      case "MARKET_BROWSE": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          const venue = await market!.requireSession(
            actor,
            targetConnectionId,
            message.marketSessionId
          );
          const snapshot = await market!.read.snapshot(actor, venue, {
            ...(message.search !== undefined ? { search: message.search } : {}),
            ...(message.category !== undefined ? { category: message.category } : {}),
            ...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
            ...(message.limit !== undefined ? { limit: message.limit } : {}),
            ...(message.listedOnly ? { listedOnly: true } : {})
          });
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_BROWSE_RESULT",
            requestId: message.requestId,
            snapshot
          });
        });
        return;
      }
      case "MARKET_GET_BOOK": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          const venue = await market!.requireSession(
            actor,
            targetConnectionId,
            message.marketSessionId
          );
          const book = await market!.read.book(
            actor,
            venue,
            message.itemIdentity ?? message.itemId!,
            message.depth,
            message.priceCurrency
          );
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_BOOK_RESULT",
            requestId: message.requestId,
            book
          });
        });
        return;
      }
      case "MARKET_REQUEST_QUOTE": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          const quote = await market!.quote(
            actor,
            targetConnectionId,
            message.marketSessionId,
            message.requestId,
            message.itemIdentity ?? message.itemId!,
            message.quantity,
            message.maximumUnitPrice,
            message.priceCurrency
          );
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_QUOTE_RESULT",
            requestId: message.requestId,
            quote
          });
        });
        return;
      }
      case "MARKET_CREATE_ORDER": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          if (!context.inventory) {
            throw new MarketError("MARKET_INVARIANT_FAILURE", "Inventory service is unavailable", true);
          }
          const result = await market!.createOrder(
            actor,
            targetConnectionId,
            message.marketSessionId,
            {
              requestId: message.requestId,
              interface: message.interface,
              side: message.side,
              itemIdentity: message.itemIdentity ?? message.itemId!,
              quantity: message.quantity,
              unitPrice: message.unitPrice,
              ...(message.priceCurrency ? { priceCurrency: message.priceCurrency } : {})
            }
          );
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_MUTATION_RESULT",
            requestId: message.requestId,
            result,
            inventory: await context.inventory.getInventorySnapshot(actor.playerId)
          });
        });
        return;
      }
      case "MARKET_SIMPLE_BUY": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          if (!context.inventory) {
            throw new MarketError("MARKET_INVARIANT_FAILURE", "Inventory service is unavailable", true);
          }
          const result = await market!.simpleBuy(
            actor,
            targetConnectionId,
            message.marketSessionId,
            message.requestId,
            message.quoteId,
            message.maximumTotal
          );
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_MUTATION_RESULT",
            requestId: message.requestId,
            result,
            inventory: await context.inventory.getInventorySnapshot(actor.playerId)
          });
        });
        return;
      }
      case "MARKET_CANCEL_ORDER": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          if (!context.inventory) {
            throw new MarketError("MARKET_INVARIANT_FAILURE", "Inventory service is unavailable", true);
          }
          const result = await market!.cancelOrder(
            actor,
            targetConnectionId,
            message.marketSessionId,
            message.requestId,
            message.orderId
          );
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_MUTATION_RESULT",
            requestId: message.requestId,
            result,
            inventory: await context.inventory.getInventorySnapshot(actor.playerId)
          });
        });
        return;
      }
      case "MARKET_CLAIM": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          if (!context.inventory) {
            throw new MarketError("MARKET_INVARIANT_FAILURE", "Inventory service is unavailable", true);
          }
          const result = await market!.claim(
            actor,
            targetConnectionId,
            message.marketSessionId,
            message.requestId,
            message.scope
          );
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_MUTATION_RESULT",
            requestId: message.requestId,
            result,
            inventory: await context.inventory.getInventorySnapshot(actor.playerId),
            ...(result.claimedEquipment > 0
              ? { equipment: await market!.equipmentSnapshot(actor.playerId) }
              : {})
          });
        });
        return;
      }
      case "MARKET_CREATE_EQUIPMENT_LISTING": {
        await handleMarketRequest(
          message.requestId,
          async (actor, targetConnectionId) => {
            if (!context.inventory) {
              throw new MarketError(
                "MARKET_INVARIANT_FAILURE",
                "Inventory service is unavailable",
                true
              );
            }
            const mutation = await market!.createEquipmentListing(
              actor,
              targetConnectionId,
              message.marketSessionId,
              message.requestId,
              message.equipmentInstanceId,
              message.askingPrice,
              message.expectedEquipmentRevision,
              message.priceCurrency
            );
            registry.sendToConnection(targetConnectionId, {
              type: "MARKET_MUTATION_RESULT",
              requestId: message.requestId,
              result: mutation.result,
              inventory:
                await context.inventory.getInventorySnapshot(actor.playerId),
              equipment: mutation.equipment
            });
          }
        );
        return;
      }
      case "MARKET_PURCHASE_EQUIPMENT_LISTING": {
        await handleMarketRequest(
          message.requestId,
          async (actor, targetConnectionId) => {
            if (!context.inventory) {
              throw new MarketError(
                "MARKET_INVARIANT_FAILURE",
                "Inventory service is unavailable",
                true
              );
            }
            const mutation = await market!.purchaseEquipmentListing(
              actor,
              targetConnectionId,
              message.marketSessionId,
              message.requestId,
              message.listingId,
              message.expectedListingVersion,
              message.maximumBuyerTotal,
              message.expectedTaxRevision,
              message.expectedPriceCurrency
            );
            registry.sendToConnection(targetConnectionId, {
              type: "MARKET_MUTATION_RESULT",
              requestId: message.requestId,
              result: mutation.result,
              inventory:
                await context.inventory.getInventorySnapshot(actor.playerId),
              equipment: mutation.equipment
            });
          }
        );
        return;
      }
      case "MARKET_CANCEL_EQUIPMENT_LISTING": {
        await handleMarketRequest(
          message.requestId,
          async (actor, targetConnectionId) => {
            if (!context.inventory) {
              throw new MarketError(
                "MARKET_INVARIANT_FAILURE",
                "Inventory service is unavailable",
                true
              );
            }
            const mutation = await market!.cancelEquipmentListing(
              actor,
              targetConnectionId,
              message.marketSessionId,
              message.requestId,
              message.listingId,
              message.expectedListingVersion
            );
            registry.sendToConnection(targetConnectionId, {
              type: "MARKET_MUTATION_RESULT",
              requestId: message.requestId,
              result: mutation.result,
              inventory:
                await context.inventory.getInventorySnapshot(actor.playerId),
              equipment: mutation.equipment
            });
          }
        );
        return;
      }
      case "MARKET_SET_SUBSCRIPTIONS": {
        await handleMarketRequest(message.requestId, async (actor, targetConnectionId) => {
          const venue = await market!.read.assertSubscriptionAccess(
            actor,
            targetConnectionId,
            message.marketSessionId
          );
          const updated = registry.setMarketSubscriptions(targetConnectionId, {
            venueId: venue.venueId,
            marketSessionId: message.marketSessionId,
            visibleItemIds: message.visibleItemIdentities ?? message.visibleItemIds ?? [],
            focusedItemId: message.focusedItemIdentity ?? message.focusedItemId ?? null,
            privateState: message.privateState,
            revision: message.revision
          });
          if (!updated) {
            throw new Error("Market connection no longer exists");
          }
          registry.sendToConnection(targetConnectionId, {
            type: "MARKET_SUBSCRIPTIONS_SET",
            requestId: message.requestId,
            revision: updated.revision
          });
        });
        return;
      }
    }
  };
  return Object.assign(handler, { admit });
}

export function registerMarketHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"market">
): void {
  router.register("market", handler);
}
