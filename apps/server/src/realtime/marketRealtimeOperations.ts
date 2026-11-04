import type { MarketPriceCurrency } from "@ash-atlas/shared";

import { MarketError } from "../game/marketRules.js";
import type { MarketService } from "../game/marketService.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";

export async function publishMarketCommit(
  market: MarketService,
  registry: ConnectionRegistry,
  event: {
    venueId: string;
    itemIdentity?: string | null;
    /** @deprecated Default-asset compatibility only. */
    itemId?: string | null;
    playerIds: string[];
    /** Glimmer moved; the assets frame then carries the premium wallet. */
    premiumCurrencyChanged?: boolean;
    /** The committed book's price currency; Gold when omitted. */
    priceCurrency?: MarketPriceCurrency | undefined;
  },
  logger: AppLogger
): Promise<void> {
  const itemIdentity = event.itemIdentity ?? event.itemId ?? null;
  const accessByConnection = new Map<string, boolean>();
  const hasCurrentAccess = async (connectionId: string): Promise<boolean> => {
    const cached = accessByConnection.get(connectionId);
    if (cached !== undefined) return cached;
    const record = registry.recordForConnection(connectionId);
    if (!record?.accountId) {
      accessByConnection.set(connectionId, false);
      return false;
    }
    try {
      const subscription = registry.marketSubscriptionForConnection(connectionId);
      if (!subscription || subscription.venueId !== event.venueId) {
        accessByConnection.set(connectionId, false);
        return false;
      }
      await market.requireSession(
        { playerId: record.playerId, accountId: record.accountId },
        connectionId,
        subscription.marketSessionId
      );
      accessByConnection.set(connectionId, true);
      return true;
    } catch (error) {
      if (!(error instanceof MarketError) || error.code !== "MARKET_ACCESS_DENIED") {
        logger.warn(
          { err: error, connectionId, playerId: record.playerId },
          "failed to validate market subscriber access"
        );
      }
      accessByConnection.set(connectionId, false);
      return false;
    }
  };

  for (const playerId of new Set(event.playerIds)) {
    try {
      const assets = await market.assetsSnapshot(playerId, {
        premiumWallet: event.premiumCurrencyChanged === true
      });
      registry.send(playerId, {
        type: "MARKET_ASSETS_CHANGED",
        ...assets
      });
    } catch (error) {
      logger.warn(
        { err: error, playerId },
        "failed to publish committed market assets"
      );
    }
    const privateConnectionIds = [];
    for (
      const connectionId of registry.connectionIdsForMarketPrivatePlayer(
        event.venueId,
        playerId
      )
    ) {
      if (await hasCurrentAccess(connectionId)) privateConnectionIds.push(connectionId);
    }
    registry.sendToConnectionIds(
      privateConnectionIds,
      {
        type: "MARKET_PLAYER_STATE_CHANGED",
        reason: itemIdentity ? "order" : "claim"
      },
      "replaceable"
    );
  }
  if (!itemIdentity) {
    return;
  }
  const interestedConnectionIds = new Set([
    ...registry.connectionIdsForMarketSummary(event.venueId, itemIdentity),
    ...registry.connectionIdsForMarketBook(event.venueId, itemIdentity)
  ]);
  const allowedConnectionIds = new Set<string>();
  for (const connectionId of interestedConnectionIds) {
    if (await hasCurrentAccess(connectionId)) allowedConnectionIds.add(connectionId);
  }
  const reader = [...allowedConnectionIds]
    .map((connectionId) => registry.recordForConnection(connectionId))
    .find((record) => record?.accountId);
  if (!reader?.accountId) {
    return;
  }
  try {
    const book = await market.read.bookForRealtime(
      { playerId: reader.playerId, accountId: reader.accountId },
      event.venueId,
      itemIdentity
    );
    // The catalog summary is the Gold book; a Glimmer commit also bumps its own book.
    const changedBook = event.priceCurrency === "glimmer"
      ? await market.read.bookForRealtime(
          { playerId: reader.playerId, accountId: reader.accountId },
          event.venueId,
          itemIdentity,
          undefined,
          "glimmer"
        )
      : book;
    registry.sendToConnectionIds(
      registry.connectionIdsForMarketSummary(event.venueId, itemIdentity)
        .filter((connectionId) => allowedConnectionIds.has(connectionId)),
      { type: "MARKET_ITEM_SUMMARY_CHANGED", item: book.item },
      "replaceable"
    );
    registry.sendToConnectionIds(
      registry.connectionIdsForMarketBook(event.venueId, itemIdentity)
        .filter((connectionId) => allowedConnectionIds.has(connectionId)),
      {
        type: "MARKET_BOOK_CHANGED",
        itemIdentity,
        bookVersion: changedBook.item.bookVersion,
        ...(event.priceCurrency === "glimmer" ? { priceCurrency: "glimmer" as const } : {})
      },
      "replaceable"
    );
  } catch (error) {
    logger.warn({ err: error, itemIdentity }, "failed to read committed market update");
  }
}
