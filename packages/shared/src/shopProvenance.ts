/**
 * Glimmer Shop provenance (docs/design/GLIMMER_SHOP.md, "Provenance tags"): every copy bought from
 * the shop carries a permanent random tag and its original buyer. Kept free of other shared imports.
 */
export type ShopProvenance = Readonly<{
  /** Random 40-bit Crockford base32 tag, `XXXX-XXXX` (shown as `#XXXX-XXXX`). */
  tag: string;
  /** The buyer's name at purchase time. */
  originalBuyerName: string;
}>;

export const SHOP_TAG_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * Inventory items that exist only as distinct copies: the inventory variant is the copy id (a random
 * UUID), never the look, so two copies never merge into an anonymous stack.
 */
export const SHOP_COPY_ITEM_IDS = ["face_mask", "manor_skin"] as const;
export type ShopCopyItemId = (typeof SHOP_COPY_ITEM_IDS)[number];

const COPY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COPY_MARKET_IDENTITY_PATTERN =
  /^(face_mask|manor_skin):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isShopCopyItemId(itemId: string): itemId is ShopCopyItemId {
  return (SHOP_COPY_ITEM_IDS as readonly string[]).includes(itemId);
}

export function isShopCopyId(value: string): boolean {
  return COPY_ID_PATTERN.test(value);
}

/** Market identity of one exact copy: its own order book, quantity 1. */
export function shopCopyMarketIdentity(itemId: ShopCopyItemId, copyId: string): string {
  if (!isShopCopyId(copyId)) throw new Error("A shop copy market identity needs a copy id");
  return `${itemId}:${copyId}`;
}

export function parseShopCopyMarketIdentity(identity: string): { itemId: ShopCopyItemId; copyId: string } | null {
  const match = COPY_MARKET_IDENTITY_PATTERN.exec(identity);
  return match ? { itemId: match[1] as ShopCopyItemId, copyId: match[2]! } : null;
}
