import type {
  MarketServerMessage,
  EquipmentSnapshotV2,
  PlayerInventorySnapshot,
  PremiumWalletSnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import { useCallback, useRef, useSyncExternalStore } from "react";

import type { GameClient } from "../../gameClient.js";
import { MarketController } from "../../market/marketController.js";

const MARKET_FRAME_TYPES = new Set<ServerMessage["type"]>([
  "MARKET_OPEN_RESULT",
  "MARKET_BROWSE_RESULT",
  "MARKET_BOOK_RESULT",
  "MARKET_QUOTE_RESULT",
  "MARKET_MUTATION_RESULT",
  "MARKET_SUBSCRIPTIONS_SET",
  "MARKET_ITEM_SUMMARY_CHANGED",
  "MARKET_BOOK_CHANGED",
  "MARKET_PLAYER_STATE_CHANGED",
  "MARKET_ASSETS_CHANGED",
  "MARKET_ERROR"
]);

export function isMarketServerMessage(message: ServerMessage): message is MarketServerMessage {
  return MARKET_FRAME_TYPES.has(message.type);
}

export interface MarketFeatureOptions {
  getClient(): GameClient | null;
  receiveInventorySnapshot(inventory: PlayerInventorySnapshot): void;
  receiveEquipmentSnapshot?(equipment: EquipmentSnapshotV2): void;
  receiveWalletGold?(gold: string, revision?: string): void;
  receivePremiumWalletSnapshot?(snapshot: PremiumWalletSnapshot): void;
  /** A committed trade touched this player (e.g. one of their listings sold). */
  onAssetsChanged?(): void;
}

export function useMarketFeature({
  getClient,
  receiveInventorySnapshot,
  receiveEquipmentSnapshot,
  receiveWalletGold,
  receivePremiumWalletSnapshot,
  onAssetsChanged
}: MarketFeatureOptions) {
  const controllerRef = useRef<MarketController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new MarketController(getClient);
  const controller = controllerRef.current;
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );

  const handleServerMessage = useCallback((message: MarketServerMessage): void => {
    if (message.type === "MARKET_MUTATION_RESULT") {
      receiveInventorySnapshot(message.inventory);
      if (message.equipment) receiveEquipmentSnapshot?.(message.equipment);
      receiveWalletGold?.(
        message.result.player.walletGold,
        message.result.player.walletVersion
      );
    }
    if (message.type === "MARKET_ASSETS_CHANGED") {
      receiveInventorySnapshot(message.inventory);
      if (message.equipment) receiveEquipmentSnapshot?.(message.equipment);
      receiveWalletGold?.(message.wallet.gold, message.wallet.revision);
      if (message.premiumWallet) receivePremiumWalletSnapshot?.(message.premiumWallet);
      onAssetsChanged?.();
    }
    controller.handleMessage(message);
  }, [controller, onAssetsChanged, receiveEquipmentSnapshot, receiveInventorySnapshot, receivePremiumWalletSnapshot, receiveWalletGold]);

  const onReady = useCallback((): void => {
    controller.onReady();
  }, [controller]);

  const onDisconnected = useCallback((): void => {
    controller.onDisconnected();
  }, [controller]);

  return {
    controller,
    view,
    handleServerMessage,
    onReady,
    onDisconnected
  } as const;
}

export type MarketFeature = ReturnType<typeof useMarketFeature>;
