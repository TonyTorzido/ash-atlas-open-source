import type { InventoryService } from "./inventory.js";

export const STARTER_RESOURCES_VERSION = 1;
export const STARTER_WOOD = 15;
export const STARTER_LEATHER = 10;
export const STARTER_STONE = 0;

export function starterResourceOperation(playerId: string) {
  return {
    operationKey: `starter-resources-v1:${playerId}`,
    playerId,
    source: "starter_resources_v1",
    sourceEntityType: "player",
    sourceEntityId: playerId,
    metadata: { version: STARTER_RESOURCES_VERSION, purpose: "five_basic_flags" },
    grants: [
      { itemId: "wood" as const, variant: null, quantity: STARTER_WOOD },
      { itemId: "leather" as const, variant: null, quantity: STARTER_LEATHER }
    ]
  };
}

export async function ensureStarterResources(
  inventory: Pick<InventoryService, "grantItemsForOperation">,
  playerId: string
) {
  return inventory.grantItemsForOperation(starterResourceOperation(playerId));
}
