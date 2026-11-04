import type {
  ClientMessage,
  FieldConsumableItemId,
  HarvestStartAuthority,
  ResourceType
} from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type {
  ClientCommandPort,
  GameplayCommandAttempt
} from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class HarvestingClient {
  constructor(private readonly port: ClientCommandPort) {}

  requestNearbyCollectibles(): void {
      this.send({
        type: "REQUEST_NEARBY_COLLECTIBLES",
        requestId: crypto.randomUUID()
      });
    }

  startHarvest(
    nodeId: string,
    authority: HarvestStartAuthority,
    action: "primary" | "resin" = "primary"
  ): GameplayCommandAttempt {
      const requestId = crypto.randomUUID();
      const expectedGeneration = this.port.connectionGeneration?.();
      return {
        requestId,
        outcome: this.port.send({
        type: "START_HARVEST",
        requestId,
        nodeId,
        expectedPresentationOwner: authority.presentationOwner,
        expectedEntityRevision: authority.entityRevision,
        expectedRelocationRevision: authority.relocationRevision,
        expectedResourceVisionRevision: authority.resourceVisionRevision,
        expectedGameplayViewGeneration: authority.gameplayViewGeneration,
        ...(action === "resin" ? { action } : {})
        }, expectedGeneration)
      };
    }

  claimMine(nodeId: string, expectedAuthorityRevision: number): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "CLAIM_MINE",
      requestId,
      nodeId,
      expectedAuthorityRevision
    }) ? requestId : null;
  }

  useBalsamResin(stackId?: string): boolean {
      return this.useConsumable("giving_berry", stackId);
    }

  useSimpleFood(stackId?: string): boolean {
    return this.useConsumable("simple_food", stackId);
  }

  useFieldConsumable(itemId: FieldConsumableItemId, stackId?: string, targetEntityId?: string): boolean {
    return this.useConsumable(itemId, stackId, targetEntityId);
  }

  craftFieldConsumable(itemId: FieldConsumableItemId): boolean {
    return this.send({ type: "CRAFT_FIELD_CONSUMABLE", requestId: crypto.randomUUID(), itemId });
  }

  /** Water sites: Pearl Beds, whirlpools and Drowned City sites near the player. */
  requestWaterSites(): boolean {
    return this.send({ type: "REQUEST_WATER_SITES", requestId: crypto.randomUUID() });
  }

  waterSiteAction(type: "DIVE_PEARL_BED" | "ENTER_WHIRLPOOL" | "PRESENT_ABYSSAL_ORBS", siteId: string): string | null {
    const requestId = crypto.randomUUID();
    return this.send({ type, requestId, siteId }) ? requestId : null;
  }

  private useConsumable(
    itemId: "giving_berry" | "simple_food" | FieldConsumableItemId,
    stackId?: string,
    targetEntityId?: string
  ): boolean {
    return this.send({
      type: "USE_CONSUMABLE",
      requestId: crypto.randomUUID(),
      itemId,
      ...(stackId ? { stackId } : {}),
      ...(targetEntityId ? { targetEntityId } : {})
    });
  }

  completeHarvest(sessionId: string): GameplayCommandAttempt {
      const requestId = crypto.randomUUID();
      const expectedGeneration = this.port.connectionGeneration?.();
      return {
        requestId,
        outcome: this.port.send({
        type: "COMPLETE_HARVEST",
        requestId,
        sessionId
        }, expectedGeneration)
      };
    }

  cancelHarvest(sessionId: string): void {
      this.send({
        type: "CANCEL_HARVEST",
        requestId: crypto.randomUUID(),
        sessionId
      });
    }

  dropItem(
    itemId: ResourceType,
    variant: string | null,
    quantity = 1,
    stackId?: string,
    manorSessionId?: string
  ): boolean {
      return this.send({
        type: "DROP_ITEM",
        requestId: crypto.randomUUID(),
        itemId,
        variant,
        quantity,
        ...(stackId ? { stackId } : {}),
        ...(manorSessionId ? { manorSessionId } : {})
      });
    }

  dropEquipment(
    equipmentInstanceId: string,
    expectedEquipmentRevision: number,
    manorSessionId?: string
  ): boolean {
      return this.send({
        type: "DROP_EQUIPMENT",
        requestId: crypto.randomUUID(),
        equipmentInstanceId,
        expectedEquipmentRevision,
        ...(manorSessionId ? { manorSessionId } : {})
      });
    }

  updateMaterialKeep(
    itemId: ResourceType,
    variant: string | null,
    keepQuantity: number,
    expectedRevision: number
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "UPDATE_MATERIAL_KEEP",
      requestId,
      itemId,
      variant,
      keepQuantity,
      expectedRevision
    }) ? requestId : null;
  }

  updateUniqueItemProtection(
    equipmentInstanceId: string,
    protectedValue: boolean,
    expectedRevision: number
  ): string | null {
    const requestId = crypto.randomUUID();
    return this.send({
      type: "UPDATE_UNIQUE_ITEM_PROTECTION",
      requestId,
      equipmentInstanceId,
      protected: protectedValue,
      expectedRevision
    }) ? requestId : null;
  }

  splitInventoryStack(stackId: string, quantity: number): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "SPLIT_INVENTORY_STACK",
        requestId,
        stackId,
        quantity
      }) ? requestId : null;
    }

  restackInventoryStack(stackId: string): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "RESTACK_INVENTORY_STACK",
        requestId,
        stackId
      }) ? requestId : null;
    }

  moveInventoryStack(stackId: string, targetSlot: number): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "MOVE_INVENTORY_STACK",
        requestId,
        stackId,
        targetSlot
      }) ? requestId : null;
    }

  reorganizeInventory(): string | null {
      const requestId = crypto.randomUUID();
      return this.send({
        type: "REORGANIZE_INVENTORY",
        requestId
      }) ? requestId : null;
    }

  pickupDroppedItem(
      dropId: string,
      pickup: { mode: "all" } | { mode: "quantity"; quantity: number },
      manorSessionId?: string
    ): boolean {
      return this.send({
        type: "PICKUP_DROPPED_ITEM",
        requestId: crypto.randomUUID(),
        dropId,
        pickup,
        ...(manorSessionId ? { manorSessionId } : {})
      });
    }

  collectWaterAtCoordinate(lat: number, lon: number): void {
      this.send({
        type: "COLLECT_WATER_AT_COORDINATE",
        requestId: crypto.randomUUID(),
        lat,
        lon
      });
    }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
