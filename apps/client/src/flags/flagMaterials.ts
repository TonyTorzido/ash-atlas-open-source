import type {
  FlagBuildMaterial,
  PlayerInventorySnapshot,
  ResourceType
} from "@ash-atlas/shared";

import type { FloatingFeedbackInput } from "../combat/damageFloaters.js";

export const INSUFFICIENT_FLAG_FEEDBACK_COOLDOWN_MS = 2_200;

export type InsufficientFlagFeedbackReceipt = Readonly<{
  fingerprint: string;
  shownAt: number;
}>;

export type FlagMaterialStatus = Readonly<{
  ready: boolean;
  affordable: boolean;
  materials: readonly FlagMaterialQuantity[];
}>;

export type FlagMaterialQuantity = Readonly<{
  itemId: ResourceType;
  current: number;
  required: number;
  missing: boolean;
}>;

export function flagMaterialGate(
  status: FlagMaterialStatus,
  inventoryReceived: boolean
): "syncing" | "insufficient" | "allowed" {
  if (!inventoryReceived || !status.ready) return "syncing";
  return status.affordable ? "allowed" : "insufficient";
}

export function flagMaterialStatus(
  recipe: readonly FlagBuildMaterial[],
  inventory: PlayerInventorySnapshot
): FlagMaterialStatus {
  const materials = recipe.map(({ itemId, quantity }) => {
    const current = Math.max(0, inventory.totals[itemId] ?? 0);
    const required = Math.max(0, quantity);
    return {
      itemId,
      current,
      required,
      missing: current < required
    };
  });
  return {
    ready: materials.length > 0,
    affordable: materials.length > 0 && materials.every(({ missing }) => !missing),
    materials
  };
}

export function flagRecipeRequirements(
  recipe: readonly FlagBuildMaterial[]
): Array<{ itemId: ResourceType; quantity: number }> {
  return recipe.map(({ itemId, quantity }) => ({ itemId, quantity }));
}

export function insufficientFlagFeedback(
  status: FlagMaterialStatus,
  targetEntityId: string,
  eventGroupId: string
): FloatingFeedbackInput[] {
  return status.materials.map((material) => ({
    eventId: `${eventGroupId}:${material.itemId}`,
    targetEntityId,
    kind: material.missing ? "resource_missing" : "resource",
    amount: Math.max(1, material.required),
    label:
      `${material.current.toLocaleString()} / ` +
      material.required.toLocaleString(),
    icon: material.itemId
  }));
}

export function flagDeductionFeedback(
  consumedMaterials: readonly FlagBuildMaterial[],
  inventory: PlayerInventorySnapshot,
  targetEntityId: string,
  eventGroupId: string
): FloatingFeedbackInput[] {
  return consumedMaterials.map(({ itemId, quantity }) => ({
    eventId: `${eventGroupId}:${itemId}`,
    targetEntityId,
    kind: "resource_spent",
    amount: Math.max(1, quantity),
    label:
      `\u2212${quantity.toLocaleString()} \u00b7 ` +
      Math.max(0, inventory.totals[itemId] ?? 0).toLocaleString(),
    icon: itemId
  }));
}

export function flagMaterialFingerprint(status: FlagMaterialStatus): string {
  return status.materials
    .map(({ itemId, current, required }) => `${itemId}:${current}/${required}`)
    .join("|");
}

export function shouldShowInsufficientFlagFeedback(
  previous: InsufficientFlagFeedbackReceipt | null,
  fingerprint: string,
  now: number
): boolean {
  return previous?.fingerprint !== fingerprint ||
    now - previous.shownAt >= INSUFFICIENT_FLAG_FEEDBACK_COOLDOWN_MS;
}
