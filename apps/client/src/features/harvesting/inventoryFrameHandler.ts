import type {
  HarvestingServerMessage,
  PlayerInventorySnapshot,
  DroppedItemSnapshot,
  EquipmentSnapshotV2,
  InventoryProtectionSnapshot,
  BackpackSnapshot
} from "@ash-atlas/shared";
import type { Dispatch, SetStateAction } from "react";

import {
  activeDroppedItems,
  droppedItemDisplayName,
  type DroppedItemPickupRequestGate
} from "../../droppedItems/droppedItemModel.js";
import type {
  InventoryDropRequestGate,
  InventoryStackActionRequestGate,
  InventoryDropSelection
} from "../../inventory/inventoryPanelModel.js";
import type { PixiGameOverlay } from "../../map/pixiOverlay.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";

type RefCell<T> = { current: T };

export interface ClearDroppedItemOptions {
  stopMovement?: boolean;
  clearSelection?: boolean;
  releaseRequestGate?: boolean;
  expectedDropId?: string;
}

export interface InventoryFrameHandlerOptions {
  ownPlayerId: string;
  inventoryDropRequestGateRef: RefCell<InventoryDropRequestGate>;
  inventoryStackActionRequestGateRef: RefCell<InventoryStackActionRequestGate>;
  droppedItemPickupRequestGateRef: RefCell<DroppedItemPickupRequestGate>;
  overlayRef: RefCell<PixiGameOverlay | null>;
  setDroppingInventoryItemKey: Dispatch<SetStateAction<string | null>>;
  setDropSelection: Dispatch<SetStateAction<InventoryDropSelection | null>>;
  setDropAmount: Dispatch<SetStateAction<number>>;
  setDroppedItems: Dispatch<SetStateAction<DroppedItemSnapshot[]>>;
  setManorDroppedEquipment?: Dispatch<SetStateAction<DroppedItemSnapshot[]>>;
  setWarning: Dispatch<SetStateAction<string | null>>;
  setEquipment?: Dispatch<SetStateAction<EquipmentSnapshotV2 | null>>;
  receiveBackpackSnapshot?(snapshot: BackpackSnapshot): void;
  installInventoryProtectionSnapshot?(snapshot: InventoryProtectionSnapshot): void;
  receiveInventorySnapshot(inventory: PlayerInventorySnapshot): void;
  receiveWalletGold?(gold: string, revision?: string): void;
  clearDroppedItemInteraction(options?: ClearDroppedItemOptions): boolean;
  attemptReadyDroppedItemPickup(): boolean;
}

type InventoryResultMessage = Extract<
  HarvestingServerMessage,
  {
    type:
      | "PLAYER_RESOURCES_UPDATED"
      | "WATER_COLLECTED"
      | "ITEM_DROP_RESULT"
      | "EQUIPMENT_DROP_RESULT"
      | "INVENTORY_STACK_UPDATED"
      | "INVENTORY_PROTECTION_SNAPSHOT"
      | "INVENTORY_PROTECTION_UPDATED"
      | "DROPPED_ITEM_PICKUP_RESULT"
      | "DROPPED_EQUIPMENT_PICKUP_RESULT"
      | "DROPPED_BACKPACK_PICKUP_RESULT"
      | "DROPPED_ITEMS_SNAPSHOT";
  }
>;

/** Applies inventory and dropped-item results in their authoritative arrival order. */
export function handleInventoryFrame(
  message: InventoryResultMessage,
  options: InventoryFrameHandlerOptions
): void {
  const {
    ownPlayerId,
    inventoryDropRequestGateRef,
    inventoryStackActionRequestGateRef,
    droppedItemPickupRequestGateRef,
    overlayRef,
    setDroppingInventoryItemKey,
    setDropSelection,
    setDropAmount,
    setDroppedItems,
    setManorDroppedEquipment,
    setWarning,
    setEquipment,
    receiveBackpackSnapshot,
    installInventoryProtectionSnapshot,
    receiveInventorySnapshot,
    clearDroppedItemInteraction,
    attemptReadyDroppedItemPickup
  } = options;
  switch (message.type) {
    case "PLAYER_RESOURCES_UPDATED":
      if (message.playerId === ownPlayerId) {
        receiveInventorySnapshot(message.inventory);
        if (message.walletGold !== undefined) options.receiveWalletGold?.(message.walletGold, message.walletVersion);
      }
      return;
    case "WATER_COLLECTED":
      if (message.playerId === ownPlayerId) {
        receiveInventorySnapshot(message.inventory);
      }
      return;
    case "ITEM_DROP_RESULT":
      receiveInventorySnapshot(message.inventory);
      if (message.drop.manorId) {
        setManorDroppedEquipment?.((current) => [
          ...current.filter((drop) => drop.dropId !== message.drop.dropId),
          message.drop
        ]);
      } else {
        setDroppedItems((current) => [
          ...current.filter((drop) => drop.dropId !== message.drop.dropId),
          message.drop
        ]);
      }
      inventoryDropRequestGateRef.current.finish();
      setDroppingInventoryItemKey(null);
      setDropSelection(null);
      setDropAmount(1);
      setWarning(null);
      return;
    case "EQUIPMENT_DROP_RESULT":
      setEquipment?.(message.equipment);
      if (message.drop.manorId) {
        setManorDroppedEquipment?.((current) => [
          ...current.filter((drop) => drop.dropId !== message.drop.dropId),
          message.drop
        ]);
      } else {
        setDroppedItems((current) => [
          ...current.filter((drop) => drop.dropId !== message.drop.dropId),
          message.drop
        ]);
      }
      setWarning(null);
      return;
    case "INVENTORY_STACK_UPDATED":
      {
        const pending = inventoryStackActionRequestGateRef.current.finish(
          message.requestId
        );
        const receivedAt = performance.now();
        gameplayLatencyTrace.record("networking", "inventory_stack_response_received", {
          action: message.action,
          roundTripMs: pending ? receivedAt - pending.startedAt : -1
        }, { traceId: message.requestId });
        receiveInventorySnapshot(message.inventory);
        if (message.equipment) setEquipment?.(message.equipment);
        if (message.walletGold !== undefined) options.receiveWalletGold?.(message.walletGold, message.walletVersion);
        globalThis.requestAnimationFrame?.(() => {
          gameplayLatencyTrace.record("ui", "inventory_stack_response_painted", {
            action: message.action,
            responseToPaintMs: performance.now() - receivedAt
          }, { traceId: message.requestId });
        });
      }
      return;
    case "INVENTORY_PROTECTION_SNAPSHOT":
    case "INVENTORY_PROTECTION_UPDATED":
      installInventoryProtectionSnapshot?.(message.protection);
      if (message.type === "INVENTORY_PROTECTION_UPDATED") {
        setWarning(null);
      }
      return;
    case "DROPPED_ITEM_PICKUP_RESULT":
      receiveInventorySnapshot(message.inventory);
      if (!message.replayed && message.pickedUpQuantity > 0) {
        overlayRef.current?.enqueueFloatingFeedback({
          eventId: `ground-pickup:${message.requestId}`,
          targetEntityId: ownPlayerId,
          kind: "resource",
          // The gain flies out of the spot the item lay (outdoor drops only).
          ...(message.drop.manorId ? {} : { worldPosition: { lat: message.drop.lat, lon: message.drop.lon } }),
          amount: message.pickedUpQuantity,
          icon: message.itemId,
          subject: droppedItemDisplayName({
            itemId: message.itemId,
            variant: message.drop.variant
          }),
          label: `+${message.pickedUpQuantity.toLocaleString()} ${
            droppedItemDisplayName({
              itemId: message.itemId,
              variant: message.drop.variant
            })
          }`
        });
      }
      droppedItemPickupRequestGateRef.current.finish(message.drop.dropId);
      if (message.drop.manorId) {
        setManorDroppedEquipment?.((current) => message.removed
          ? current.filter((drop) => drop.dropId !== message.drop.dropId)
          : current.map((drop) =>
              drop.dropId === message.drop.dropId ? message.drop : drop
            ));
      } else {
        setDroppedItems((current) => message.removed
          ? current.filter((drop) => drop.dropId !== message.drop.dropId)
          : current.map((drop) =>
              drop.dropId === message.drop.dropId ? message.drop : drop
            ));
      }
      clearDroppedItemInteraction({
        expectedDropId: message.drop.dropId,
        stopMovement: true,
        clearSelection: message.removed
      });
      attemptReadyDroppedItemPickup();
      setWarning(null);
      return;
    case "DROPPED_EQUIPMENT_PICKUP_RESULT":
      setEquipment?.(message.equipment);
      droppedItemPickupRequestGateRef.current.finish(message.drop.dropId);
      if (message.drop.manorId) {
        setManorDroppedEquipment?.((current) => current.filter((drop) => drop.dropId !== message.drop.dropId));
      } else {
        setDroppedItems((current) => current.filter((drop) => drop.dropId !== message.drop.dropId));
      }
      clearDroppedItemInteraction({
        expectedDropId: message.drop.dropId,
        stopMovement: true,
        clearSelection: true
      });
      attemptReadyDroppedItemPickup();
      setWarning(null);
      return;
    case "DROPPED_BACKPACK_PICKUP_RESULT":
      receiveBackpackSnapshot?.(message.backpacks);
      receiveInventorySnapshot(message.inventory);
      droppedItemPickupRequestGateRef.current.finish(message.drop.dropId);
      if (message.drop.manorId) {
        setManorDroppedEquipment?.((current) => current.filter((drop) => drop.dropId !== message.drop.dropId));
      } else {
        setDroppedItems((current) => current.filter((drop) => drop.dropId !== message.drop.dropId));
      }
      clearDroppedItemInteraction({
        expectedDropId: message.drop.dropId,
        stopMovement: true,
        clearSelection: true
      });
      attemptReadyDroppedItemPickup();
      setWarning(null);
      return;
    case "DROPPED_ITEMS_SNAPSHOT":
      setDroppedItems(activeDroppedItems(message.drops, message.serverTime));
      return;
  }
  message satisfies never;
}
