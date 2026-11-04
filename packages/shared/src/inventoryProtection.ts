export type InventoryProtectionStatus = "none" | "partial" | "protected" | "system";

export type InventoryStackProtection = {
  stackId: string;
  itemId: string;
  variant: string | null;
  protectedQuantity: number;
  movableQuantity: number;
  status: InventoryProtectionStatus;
  reason: string | null;
};

export type MaterialKeepPolicy = {
  itemId: string;
  variant: string | null;
  keepQuantity: number;
  currentTotal: number;
};

export type UniqueItemProtection = {
  equipmentInstanceId: string;
  protected: boolean;
  systemReason: string | null;
};

export type InventoryProtectionSnapshot = {
  playerId: string;
  revision: number;
  materialPolicies: MaterialKeepPolicy[];
  uniqueItems: UniqueItemProtection[];
  stackAllocations: InventoryStackProtection[];
};
