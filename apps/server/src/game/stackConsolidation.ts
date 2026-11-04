import { requireItemDefinition } from "./items.js";

export type ConsolidationStack = Readonly<{
  stackId: string;
  slotIndex: number;
  itemId: string;
  variant: string;
  quantity: string;
  manualSplit: boolean;
}>;

export type StackConsolidationPlan = Readonly<{
  updates: readonly Readonly<{ stackId: string; quantity: bigint }>[];
  deletions: readonly string[];
}>;

/** Physical manor and city warehouse storage only; player inventory uses quantity balances. */
export function planAutomaticStackConsolidation(
  stacks: readonly ConsolidationStack[]
): StackConsolidationPlan {
  const groups = new Map<string, ConsolidationStack[]>();
  for (const stack of stacks) {
    if (stack.manualSplit) continue;
    const key = `${stack.itemId}\u0000${stack.variant}`;
    const group = groups.get(key);
    if (group) group.push(stack);
    else groups.set(key, [stack]);
  }

  const updates: Array<{ stackId: string; quantity: bigint }> = [];
  const deletions: string[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) =>
      left.slotIndex - right.slotIndex || left.stackId.localeCompare(right.stackId)
    );
    const maximum = BigInt(
      requireItemDefinition(group[0]!.itemId).maxStack ?? Number.MAX_SAFE_INTEGER
    );
    const quantities = group.map((stack) => BigInt(stack.quantity));
    if (quantities.some((quantity) => quantity > maximum)) continue;

    const total = quantities.reduce((sum, quantity) => sum + quantity, 0n);
    const survivorCount = Number((total + maximum - 1n) / maximum);
    for (let index = 0; index < survivorCount; index += 1) {
      const stack = group[index]!;
      const targetQuantity = index === survivorCount - 1
        ? total - maximum * BigInt(survivorCount - 1)
        : maximum;
      if (BigInt(stack.quantity) !== targetQuantity) {
        updates.push({ stackId: stack.stackId, quantity: targetQuantity });
      }
    }
    for (const stack of group.slice(survivorCount)) deletions.push(stack.stackId);
  }
  return { updates, deletions };
}
