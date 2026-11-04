import {
  HIGH_GRADE_MIN,
  highGradeGuardMessage,
  materialGrade,
  pickCategoryInputs,
  type CategoryPick,
  type CategoryRecipeInput,
  type ExactRecipeInput,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import { lockInventoryProtection, materialProtectionAllocation } from "./inventoryProtection.js";

type Queryable = Parameters<InventoryService["snapshotInTransaction"]>[0];
export type SpendInventory = Pick<InventoryService, "snapshotInTransaction">;

/**
 * How many of each plain (default-variant) item the player can spend right now: stacks held back
 * by a material keep policy are not spendable, and market-listed items are already escrowed out of
 * the inventory. Takes the inventory-protection and inventory row locks.
 */
export async function spendableItemCounts(
  inventory: SpendInventory,
  client: Queryable,
  playerId: string,
  /** False where the caller already holds the inventory lock (keeps lock order). */
  lockProtection = true
): Promise<Map<string, number>> {
  if (lockProtection) await lockInventoryProtection(client, playerId);
  const snapshot: PlayerInventorySnapshot = await inventory.snapshotInTransaction(client, playerId);
  const protection = await materialProtectionAllocation(client, playerId);
  const counts = new Map<string, number>();
  for (const stack of snapshot.items) {
    if ((stack.variant ?? DEFAULT_INVENTORY_VARIANT) !== DEFAULT_INVENTORY_VARIANT) continue;
    const spendable = (stack.stackId ? protection.byStackId.get(stack.stackId)?.movableQuantity : undefined) ?? stack.quantity;
    counts.set(stack.resourceType, (counts.get(stack.resourceType) ?? 0) + spendable);
  }
  return counts;
}

export type MaterialSpendFailure = Readonly<{
  code: "MATERIALS_REQUIRED" | "PICKS_CHANGED" | "HIGH_GRADE_CONFIRMATION_REQUIRED";
  message: string;
}>;

/**
 * Resolves exact plus category inputs against what the player can spend (R3-R7). Returns the
 * debits, or the refusal to raise before anything is spent.
 */
export function resolveMaterialSpend(
  recipeName: string,
  exactInputs: readonly (ExactRecipeInput & { displayName?: string })[],
  categoryInputs: readonly CategoryRecipeInput[],
  spendable: ReadonlyMap<string, number>,
  options: Readonly<{ picks?: readonly (readonly CategoryPick[])[]; confirmHighGrade?: boolean }>
): Readonly<{ ok: true; debits: readonly CategoryPick[] }> | Readonly<{ ok: false; failure: MaterialSpendFailure }> {
  const resolution = pickCategoryInputs(exactInputs, categoryInputs, spendable, options.picks);
  if (!resolution.ok) {
    const describe = [
      ...exactInputs.map((input) => `${input.quantity} ${input.displayName ?? input.itemId}`),
      ...categoryInputs.map((input) => `${input.quantity} ${input.category.label}`)
    ].join(", ");
    return {
      ok: false,
      failure: resolution.reason === "picks_changed"
        ? { code: "PICKS_CHANGED", message: `Your ${resolution.label} changed. Check the items and try again.` }
        : { code: "MATERIALS_REQUIRED", message: `${recipeName} requires ${describe}.` }
    };
  }
  if (resolution.highGrade.length > 0 && options.confirmHighGrade !== true) {
    return { ok: false, failure: { code: "HIGH_GRADE_CONFIRMATION_REQUIRED", message: highGradeGuardMessage(resolution.highGrade) } };
  }
  return { ok: true, debits: resolution.debits };
}

/** R5 for a single-item breakdown: G4+ inputs need confirmation. */
export function breakdownGuardFailure(itemId: string, quantity: number, confirmHighGrade: boolean | undefined): MaterialSpendFailure | null {
  if ((materialGrade(itemId) ?? 0) < HIGH_GRADE_MIN || confirmHighGrade === true) return null;
  return { code: "HIGH_GRADE_CONFIRMATION_REQUIRED", message: highGradeGuardMessage([{ itemId, quantity }]) };
}
