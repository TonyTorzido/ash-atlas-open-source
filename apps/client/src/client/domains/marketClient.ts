import type { BuyShopItemsInput, ClientMessage, MarketCollectionScope, MarketInteger, MarketOrderSide, MarketPriceCurrency } from "@ash-atlas/shared";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class MarketClient {
  constructor(private readonly port: ClientCommandPort) {}

  marketOpen(
      requestId: string,
      marketStructureId: string,
      expectedPlacementRevision: string,
      options: { listedOnly?: boolean } = {}
    ): boolean {
      return this.send({
        type: "MARKET_OPEN",
        requestId,
        marketStructureId,
        expectedPlacementRevision,
        ...(options.listedOnly ? { listedOnly: true } : {})
      });
    }

  marketBrowse(
      requestId: string,
      marketSessionId: string,
      options: {
        search?: string;
        category?: string;
        cursor?: string | null;
        limit?: number;
        listedOnly?: boolean;
      } = {}
    ): boolean {
      return this.send({
        type: "MARKET_BROWSE",
        requestId,
        marketSessionId,
        ...options
      });
    }

  marketGetBook(
    requestId: string,
    marketSessionId: string,
    itemIdentity: string,
    depth?: number,
    priceCurrency?: MarketPriceCurrency
  ): boolean {
      return this.send({
        type: "MARKET_GET_BOOK",
        requestId,
        marketSessionId,
        itemIdentity,
        ...(depth === undefined ? {} : { depth }),
        ...(priceCurrency === "glimmer" ? { priceCurrency } : {})
      });
    }

  marketRequestQuote(
      requestId: string,
      marketSessionId: string,
      itemIdentity: string,
      quantity: MarketInteger,
      maximumUnitPrice: MarketInteger,
      priceCurrency?: MarketPriceCurrency
    ): boolean {
      return this.send({
        type: "MARKET_REQUEST_QUOTE",
        requestId,
        marketSessionId,
        itemIdentity,
        quantity,
        maximumUnitPrice,
        ...(priceCurrency === "glimmer" ? { priceCurrency } : {})
      });
    }

  marketCreateOrder(
      requestId: string,
      marketSessionId: string,
      interfaceMode: "simple" | "merchant",
      side: MarketOrderSide,
      itemIdentity: string,
      quantity: MarketInteger,
      unitPrice: MarketInteger,
      priceCurrency?: MarketPriceCurrency
    ): boolean {
      return this.send({
        type: "MARKET_CREATE_ORDER",
        requestId,
        marketSessionId,
        interface: interfaceMode,
        side,
        itemIdentity,
        quantity,
        unitPrice,
        ...(priceCurrency === "glimmer" ? { priceCurrency } : {})
      });
    }

  marketSimpleBuy(
      requestId: string,
      marketSessionId: string,
      quoteId: string,
      maximumTotal: MarketInteger
    ): boolean {
      return this.send({
        type: "MARKET_SIMPLE_BUY",
        requestId,
        marketSessionId,
        quoteId,
        maximumTotal
      });
    }

  marketCancelOrder(requestId: string, marketSessionId: string, orderId: string): boolean {
      return this.send({ type: "MARKET_CANCEL_ORDER", requestId, marketSessionId, orderId });
    }

  marketClaim(
    requestId: string,
    marketSessionId: string,
    scope: MarketCollectionScope
  ): boolean {
      return this.send({ type: "MARKET_CLAIM", requestId, marketSessionId, scope });
    }

  marketCreateEquipmentListing(
    requestId: string,
    marketSessionId: string,
    equipmentInstanceId: string,
    askingPrice: MarketInteger,
    expectedEquipmentRevision: MarketInteger,
    priceCurrency?: MarketPriceCurrency
  ): boolean {
    return this.send({
      type: "MARKET_CREATE_EQUIPMENT_LISTING",
      requestId,
      marketSessionId,
      equipmentInstanceId,
      askingPrice,
      expectedEquipmentRevision,
      ...(priceCurrency === "glimmer" ? { priceCurrency } : {})
    });
  }

  marketPurchaseEquipmentListing(
    requestId: string,
    marketSessionId: string,
    listingId: string,
    expectedListingVersion: MarketInteger,
    maximumBuyerTotal: MarketInteger,
    expectedTaxRevision: MarketInteger,
    expectedPriceCurrency: MarketPriceCurrency = "gold"
  ): boolean {
    return this.send({
      type: "MARKET_PURCHASE_EQUIPMENT_LISTING",
      requestId,
      marketSessionId,
      listingId,
      expectedListingVersion,
      maximumBuyerTotal,
      expectedTaxRevision,
      expectedPriceCurrency
    });
  }

  marketCancelEquipmentListing(
    requestId: string,
    marketSessionId: string,
    listingId: string,
    expectedListingVersion: MarketInteger
  ): boolean {
    return this.send({
      type: "MARKET_CANCEL_EQUIPMENT_LISTING",
      requestId,
      marketSessionId,
      listingId,
      expectedListingVersion
    });
  }

  marketSetSubscriptions(
      requestId: string,
      marketSessionId: string,
      visibleItemIdentities: string[],
      focusedItemIdentity: string | null,
      privateState: boolean,
      revision: number
    ): boolean {
      return this.send({
        type: "MARKET_SET_SUBSCRIPTIONS",
        requestId,
        marketSessionId,
        visibleItemIdentities,
        focusedItemIdentity,
        privateState,
        revision
      });
    }

  /** Glimmer Shop: the on-sale catalog; answered by SHOP_CATALOG or SHOP_ERROR. */
  requestShopCatalog(requestId: string): boolean {
    return this.send({ type: "REQUEST_SHOP_CATALOG", requestId });
  }

  /** Glimmer Shop: one purchase for a single item or a whole cart; answered by SHOP_PURCHASE_RESULT or SHOP_ERROR. */
  buyShopItems(input: BuyShopItemsInput): boolean {
    return this.send({
      type: "BUY_SHOP_ITEMS",
      requestId: input.requestId,
      lines: input.lines.map(({ sku, quantity }) => ({ sku, quantity })),
      expectedTotalGlimmer: input.expectedTotalGlimmer
    });
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
