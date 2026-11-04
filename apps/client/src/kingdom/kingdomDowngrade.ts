import {
  KINGDOM_DOWNGRADE_REFUND_PERCENT,
  kingdomStructureDowngradeRefund,
  type KingdomDowngradeStructure
} from "@ash-atlas/shared";

const MATERIAL_LABELS: Readonly<Record<string, string>> = {
  bricks: "Bricks",
  crude_oil: "Crude Oil",
  crystal: "Crystal",
  pearl: "Pearl",
  refined_oil: "Glimmer Oil"
};

export const KINGDOM_DOWNGRADE_ACTION_LABEL = `Downgrade (refund ${KINGDOM_DOWNGRADE_REFUND_PERCENT}%)`;

/** The confirmation text for a downgrade: which level is removed and what the treasury gets back. */
export function downgradeConfirmationMessage(structure: KingdomDowngradeStructure, fromLevel: number): string {
  const refund = kingdomStructureDowngradeRefund(structure, fromLevel) ?? [];
  const refundText = refund
    .map((line) => `${line.quantity.toLocaleString()} ${MATERIAL_LABELS[line.itemId] ?? line.itemId}`)
    .join(" · ");
  return `Level ${fromLevel} is removed and the treasury gets back ${KINGDOM_DOWNGRADE_REFUND_PERCENT}% of its cost: ` +
    `${refundText || "nothing"}. Building the level again costs the full price.`;
}
