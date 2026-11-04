import type {
  GlimmerShopCatalogSnapshot,
  GlimmerShopPurchaseResult
} from "../glimmerShop.js";

export type ShopServerMessage =
  | ({ type: "SHOP_CATALOG"; requestId?: string } & GlimmerShopCatalogSnapshot)
  | ({ type: "SHOP_PURCHASE_RESULT" } & GlimmerShopPurchaseResult)
  | { type: "SHOP_ERROR"; requestId: string; code: string; message: string };

export const SHOP_SERVER_MESSAGE_TYPES = new Set<ShopServerMessage["type"]>([
  "SHOP_CATALOG",
  "SHOP_PURCHASE_RESULT",
  "SHOP_ERROR"
]);

export function isShopServerMessage(message: { type: string }): message is ShopServerMessage {
  return SHOP_SERVER_MESSAGE_TYPES.has(message.type as ShopServerMessage["type"]);
}
