import {
  GENERAL_SKILL_DEFINITIONS,
  GENERAL_SKILL_OFFERINGS,
  offeringProgress,
  offeringSummary,
  type GeneralSkillId,
  type PlayerInventorySnapshot,
  type ResourceType,
  type UnlockOfferingPart
} from "@ash-atlas/shared";

import type { InventoryService } from "../inventory.js";
import { spendableItemCounts as spendableCounts } from "../materialSpend.js";
import { SkillRequestError, type SkillMutationResult, type SkillQueryable } from "./skillAuthority.js";
import type { SkillService } from "./skillService.js";

export type OfferingInventory = Pick<InventoryService, "debitItemsForOperationInTransaction" | "snapshotInTransaction">;

export const OFFERING_ITEMS_REQUIRED = "SKILL_OFFERING_ITEMS_REQUIRED";

async function spendableItemCounts(
  inventory: OfferingInventory,
  client: SkillQueryable,
  playerId: string
): Promise<(itemId: string) => number> {
  const counts = await spendableCounts(inventory, client, playerId);
  return (itemId) => counts.get(itemId) ?? 0;
}

/**
 * Re-checks and debits every part of an offering inside the caller's transaction. Throws
 * SKILL_OFFERING_ITEMS_REQUIRED (naming each missing part) before anything is spent.
 */
export async function debitOfferingInTransaction(
  inventory: OfferingInventory,
  client: SkillQueryable,
  input: Readonly<{
    operationKey: string;
    playerId: string;
    source: string;
    sourceEntityType: string;
    sourceEntityId: string;
    name: string;
    parts: readonly UnlockOfferingPart[];
  }>
): Promise<void> {
  const count = await spendableItemCounts(inventory, client, input.playerId);
  const progress = offeringProgress(input.parts, count);
  const missing = progress.filter((part) => !part.met);
  if (missing.length > 0) {
    throw new SkillRequestError(
      OFFERING_ITEMS_REQUIRED,
      `${input.name} needs ${missing.map((part) => `${part.need} ${part.label} (you have ${part.have})`).join(", ")}.`
    );
  }
  const totals = new Map<string, number>();
  for (const part of progress) for (const spend of part.spend) totals.set(spend.itemId, (totals.get(spend.itemId) ?? 0) + spend.quantity);
  await inventory.debitItemsForOperationInTransaction(client, {
    operationKey: input.operationKey,
    playerId: input.playerId,
    source: input.source,
    sourceEntityType: input.sourceEntityType,
    sourceEntityId: input.sourceEntityId,
    metadata: { unlockId: input.sourceEntityId },
    debits: [...totals].map(([itemId, quantity]) => ({ itemId: itemId as ResourceType, variant: null, quantity }))
  });
}

export type GeneralSkillOfferingResult = Readonly<{
  result: SkillMutationResult;
  inventory: PlayerInventorySnapshot;
  message: string;
}>;

/** Skills panel "Offer": the one-time discovery offering that opens Rank 1 of an Advanced General skill. */
export async function offerGeneralSkill(
  skills: Pick<SkillService, "discoverGeneralSkill">,
  inventory: OfferingInventory & Pick<InventoryService, "getInventorySnapshot">,
  playerId: string,
  skillId: GeneralSkillId,
  requestId: string
): Promise<GeneralSkillOfferingResult> {
  const offering = GENERAL_SKILL_OFFERINGS[skillId];
  if (!offering) throw new SkillRequestError("SKILL_OFFERING_NOT_REQUIRED", "This skill needs no offering");
  const name = GENERAL_SKILL_DEFINITIONS[skillId].displayName;
  const result = await skills.discoverGeneralSkill(playerId, skillId, requestId, (client) =>
    debitOfferingInTransaction(inventory, client, {
      operationKey: `skill-offering:${playerId}:${skillId}`,
      playerId,
      source: "skill_unlock_offering",
      sourceEntityType: "general_skill",
      sourceEntityId: skillId,
      name,
      parts: offering.parts
    })
  );
  return {
    result,
    inventory: await inventory.getInventorySnapshot(playerId),
    message: result.replayed
      ? `${name} is already discovered.`
      : `You offered ${offeringSummary(offering.parts)} and discovered ${name}. Spend Skill Points to learn it.`
  };
}
