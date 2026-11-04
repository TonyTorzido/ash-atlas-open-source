import {
  isShopServerMessage,
  type EquipmentSnapshotV2,
  type GlimmerShopCatalogItem,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot,
  type ServerMessage,
  type ShopServerMessage
} from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { GameClient } from "../../gameClient.js";
import { requestIdCrypto as crypto } from "../../requestId.js";
import { clampShopQuantity, shopCartLines, shopCartTotal, shopErrorText, type ShopCart } from "../../shop/shopModel.js";

export { isShopServerMessage };
export type ShopFeatureMessage = ShopServerMessage;

const PURCHASE_TIMEOUT_MS = 20_000;

export type ShopFeature = ReturnType<typeof useShopFeature>;

/**
 * Glimmer Shop client state: the on-sale catalog, the cart and one pending purchase. Prices are
 * only ever the server's; a purchase sends the total the player saw and the server refuses it
 * (SHOP_PRICE_CHANGED) when it no longer matches.
 */
export function useShopFeature(options: Readonly<{
  getClient(): GameClient | null;
  receiveInventorySnapshot(snapshot: PlayerInventorySnapshot): void;
  receiveEquipmentSnapshot(snapshot: EquipmentSnapshotV2): void;
  receivePremiumWalletSnapshot(snapshot: PremiumWalletSnapshot): void;
  onPurchased?(): void;
}>) {
  const { getClient, receiveInventorySnapshot, receiveEquipmentSnapshot, receivePremiumWalletSnapshot, onPurchased } = options;
  const [items, setItems] = useState<readonly GlimmerShopCatalogItem[] | null>(null);
  const [shopOnlyDefinitionIds, setShopOnlyDefinitionIds] = useState<readonly string[]>([]);
  const [cart, setCart] = useState<ShopCart>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const catalogRequestRef = useRef<string | null>(null);
  const purchaseRef = useRef<{ requestId: string; signature: string } | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const toastRef = useRef(0);

  const clearPendingTimer = (): void => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  };
  useEffect(() => clearPendingTimer, []);

  const showToast = useCallback((text: string): void => {
    toastRef.current += 1;
    setToast({ id: toastRef.current, text });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback((): boolean => {
    const requestId = crypto.randomUUID();
    const sent = getClient()?.market.requestShopCatalog(requestId) ?? false;
    if (sent) catalogRequestRef.current = requestId;
    return sent;
  }, [getClient]);

  const addToCart = useCallback((sku: string, quantity: number): void => {
    setCart((current) => ({ ...current, [sku]: clampShopQuantity((current[sku] ?? 0) + quantity) }));
    setError(null);
  }, []);
  const setCartQuantity = useCallback((sku: string, quantity: number): void => {
    setCart((current) => ({ ...current, [sku]: clampShopQuantity(quantity) }));
    setError(null);
  }, []);
  const removeFromCart = useCallback((sku: string): void => {
    setCart((current) => {
      const { [sku]: _removed, ...rest } = current;
      return rest;
    });
    setError(null);
  }, []);

  /** Buys the given lines at the prices the player saw. Returns false when it could not be sent. */
  const buy = useCallback((lines: readonly Readonly<{ sku: string; quantity: number }>[], expectedTotalGlimmer: number): boolean => {
    if (pending || lines.length === 0) return false;
    const signature = JSON.stringify([lines, expectedTotalGlimmer]);
    // The same purchase retried keeps its request id, so the server can replay instead of charging twice.
    const requestId = purchaseRef.current?.signature === signature ? purchaseRef.current.requestId : crypto.randomUUID();
    purchaseRef.current = { requestId, signature };
    setError(null);
    const sent = getClient()?.market.buyShopItems({ requestId, lines: [...lines], expectedTotalGlimmer }) ?? false;
    if (!sent) {
      setError("You are offline. Reconnect to buy.");
      return false;
    }
    setPending(true);
    clearPendingTimer();
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setPending(false);
      setError("The shop did not answer. Check your inventory before trying again.");
    }, PURCHASE_TIMEOUT_MS);
    return true;
  }, [getClient, pending]);

  const handleServerMessage = useCallback((message: ServerMessage): boolean => {
    if (!isShopServerMessage(message)) return false;
    if (message.type === "SHOP_CATALOG") {
      setItems(message.items);
      setShopOnlyDefinitionIds(message.shopOnlyDefinitionIds);
      setCart((current) => {
        const skus = new Set(message.items.map((item) => item.sku));
        const kept = Object.entries(current).filter(([sku]) => skus.has(sku));
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
      });
      return true;
    }
    if (message.type === "SHOP_PURCHASE_RESULT") {
      clearPendingTimer();
      purchaseRef.current = null;
      setPending(false);
      setError(null);
      receiveInventorySnapshot(message.inventory);
      receiveEquipmentSnapshot(message.equipment);
      receivePremiumWalletSnapshot(message.premiumWallet);
      const bought = new Set(message.lines.map((line) => line.sku));
      setCart((current) => Object.fromEntries(Object.entries(current).filter(([sku]) => !bought.has(sku))));
      const count = message.lines.reduce((sum, line) => sum + line.quantity, 0);
      showToast(message.replayed ? "That purchase had already gone through." : `${count} ${count === 1 ? "item" : "items"} added to your inventory`);
      onPurchased?.();
      return true;
    }
    // SHOP_ERROR: a failed catalog read and a failed purchase both land here.
    if (message.requestId !== catalogRequestRef.current && message.requestId !== purchaseRef.current?.requestId) return true;
    clearPendingTimer();
    setPending(false);
    setError(shopErrorText(message.code, message.message));
    // Only a refused purchase can be retried with the same id; a changed price needs a new total.
    if (message.code !== "SHOP_FAILED") purchaseRef.current = null;
    if (message.code === "SHOP_PRICE_CHANGED" || message.code === "SHOP_ITEM_UNAVAILABLE") refresh();
    return true;
  }, [onPurchased, receiveEquipmentSnapshot, receiveInventorySnapshot, receivePremiumWalletSnapshot, refresh, showToast]);

  const cartLines = items ? shopCartLines(cart, items) : [];
  return {
    items,
    shopOnlyDefinitionIds,
    cart,
    cartLines,
    cartTotal: shopCartTotal(cartLines),
    pending,
    error,
    toast,
    refresh,
    addToCart,
    setCartQuantity,
    removeFromCart,
    buy,
    dismissError: () => setError(null),
    dismissToast,
    showToast,
    handleServerMessage
  };
}
