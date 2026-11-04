import { randomUUID } from "node:crypto";

import {
  BRICKS_ITEM_ID,
  GLIMMER_OIL_ITEM_ID,
  KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS,
  kingdomBrickDepositSplit,
  kingdomBrickFurnaceLevel,
  kingdomStructureDowngradeRefund,
  type KingdomBrickDepositInput,
  type KingdomBrickFurnacePackageInput,
  type KingdomBrickFurnaceSnapshot,
  type KingdomBrickFurnaceUpgradeInput
} from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import {
  creditKingdomDowngradeRefundInTransaction,
  insertKingdomAuditEvent,
  lockKingdomTreasuryBalance,
  moveKingdomTreasuryInTransaction
} from "./kingdomTreasuryLedger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Raised with the kingdom service's error codes; the caller maps it to a KingdomError. */
export class KingdomBrickEconomyError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "KingdomBrickEconomyError";
  }
}

type BrickActor = Readonly<{ playerId: string; kingdomId: string }>;
type BrickInventory = Pick<
  InventoryService, "debitItemsForOperationInTransaction" | "lockPlayerInventoryForOperationInTransaction"
>;

/**
 * Deposits carried Bricks into the actor's kingdom treasury. The full
 * quantity leaves the member's pack; 10% (rounded up) is destroyed and the
 * rest is credited. Runs inside the kingdom mutation (player row, kingdom
 * row, membership already locked; the request id is replay-protected there
 * and again by kingdom_brick_deposits' (player, request) key).
 */
export async function depositBricksInTransaction(
  client: Queryable,
  inventory: BrickInventory,
  actor: BrickActor,
  input: KingdomBrickDepositInput
): Promise<{ depositId: string; quantity: number; tax: number; credited: number }> {
  const split = kingdomBrickDepositSplit(input.quantity);
  if (!split) {
    throw new KingdomBrickEconomyError("KINGDOM_BRICK_DEPOSIT_INVALID", "Deposit at least 2 Bricks");
  }
  // The inventory carry lock first, then the Bricks row: the order every inventory writer uses.
  await inventory.lockPlayerInventoryForOperationInTransaction(client, actor.playerId);
  const stack = await client.query<{ quantity: number }>(
    `SELECT quantity FROM player_inventory
     WHERE player_id = $1 AND resource_type = $2 AND variant = $3 FOR UPDATE`,
    [actor.playerId, BRICKS_ITEM_ID, DEFAULT_INVENTORY_VARIANT]
  );
  const playerBefore = stack.rows.reduce((total, row) => total + Number(row.quantity), 0);
  if (playerBefore < split.quantity) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_BRICK_DEPOSIT_INSUFFICIENT",
      `You carry ${playerBefore.toLocaleString("en-US")} Bricks`,
      { available: playerBefore }
    );
  }
  const operationKey = `kingdom-brick-deposit:${actor.playerId}:${input.requestId}`;
  try {
    await inventory.debitItemsForOperationInTransaction(client, {
      operationKey,
      playerId: actor.playerId,
      source: "kingdom_brick_deposit",
      sourceEntityType: "kingdom",
      sourceEntityId: actor.kingdomId,
      metadata: { requestId: input.requestId, quantity: split.quantity, tax: split.tax, credited: split.credited },
      debits: [{ itemId: BRICKS_ITEM_ID, variant: null, quantity: split.quantity }]
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Inventory does not contain enough items") {
      throw new KingdomBrickEconomyError("KINGDOM_BRICK_DEPOSIT_INSUFFICIENT", "You do not carry that many Bricks");
    }
    throw error;
  }
  const depositId = randomUUID();
  const treasury = await moveKingdomTreasuryInTransaction(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    resourceType: BRICKS_ITEM_ID,
    direction: "credit",
    quantity: split.credited,
    sourceType: "brick_deposit",
    operationKey,
    sourceId: depositId,
    metadata: { quantity: split.quantity, tax: split.tax }
  });
  if (!treasury) throw new Error("Brick deposit credit cannot fail");
  await client.query(
    `INSERT INTO kingdom_brick_deposits (
       id, kingdom_id, player_id, request_id, quantity, tax_destroyed, credited,
       player_balance_before, player_balance_after, treasury_balance_before, treasury_balance_after
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [depositId, actor.kingdomId, actor.playerId, input.requestId, split.quantity, split.tax, split.credited,
      playerBefore, playerBefore - split.quantity, treasury.before, treasury.after]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "bricks_deposited",
    entityType: "brick_deposit",
    entityId: depositId,
    metadata: { quantity: split.quantity, tax: split.tax, credited: split.credited }
  });
  return { depositId, ...split };
}

type FurnaceRow = { level: number; last_package_at: Date | string | null };

async function lockFurnace(client: Queryable, kingdomId: string): Promise<FurnaceRow | null> {
  const result = await client.query<FurnaceRow>(
    "SELECT level, last_package_at FROM kingdom_brick_furnaces WHERE kingdom_id = $1 FOR UPDATE",
    [kingdomId]
  );
  return result.rows[0] ?? null;
}

/**
 * Builds or upgrades the Brick Furnace to `targetLevel` (the next level).
 * Glimmer Oil comes from the treasury when it holds the full amount,
 * otherwise from the actor's pack. Runs inside the kingdom mutation with
 * the build permission already checked.
 */
export async function upgradeBrickFurnaceInTransaction(
  client: Queryable,
  inventory: BrickInventory,
  actor: BrickActor,
  input: KingdomBrickFurnaceUpgradeInput
): Promise<{ level: number; glimmerOil: number; source: "treasury" | "player" }> {
  const next = kingdomBrickFurnaceLevel(input.targetLevel);
  if (!next) throw new KingdomBrickEconomyError("KINGDOM_BRICK_FURNACE_LEVEL_INVALID", "Choose the next furnace level");
  const furnace = await lockFurnace(client, actor.kingdomId);
  const currentLevel = furnace ? Number(furnace.level) : 0;
  if (currentLevel !== next.level - 1) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_BRICK_FURNACE_LEVEL_CHANGED",
      currentLevel >= next.level ? `The Brick Furnace is already level ${currentLevel}` : `Build level ${currentLevel + 1} first`
    );
  }
  const operationKey = `kingdom-brick-furnace:${actor.playerId}:${input.requestId}`;
  const treasuryOil = await lockKingdomTreasuryBalance(client, actor.kingdomId, GLIMMER_OIL_ITEM_ID);
  const source = treasuryOil >= next.upgradeGlimmerOil ? "treasury" : "player";
  if (source === "treasury") {
    await moveKingdomTreasuryInTransaction(client, {
      kingdomId: actor.kingdomId,
      actorPlayerId: actor.playerId,
      resourceType: GLIMMER_OIL_ITEM_ID,
      direction: "debit",
      quantity: next.upgradeGlimmerOil,
      sourceType: "brick_furnace_upgrade",
      operationKey,
      metadata: { targetLevel: next.level }
    });
  } else {
    try {
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId: actor.playerId,
        source: "kingdom_brick_furnace_upgrade",
        sourceEntityType: "kingdom",
        sourceEntityId: actor.kingdomId,
        metadata: { targetLevel: next.level },
        debits: [{ itemId: GLIMMER_OIL_ITEM_ID, variant: null, quantity: next.upgradeGlimmerOil }]
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Inventory does not contain enough items") {
        throw new KingdomBrickEconomyError(
          "KINGDOM_BRICK_FURNACE_GLIMMER_OIL_REQUIRED",
          `Level ${next.level} needs ${next.upgradeGlimmerOil.toLocaleString("en-US")} Glimmer Oil from the treasury or your pack`
        );
      }
      throw error;
    }
  }
  if (furnace) {
    await client.query(
      "UPDATE kingdom_brick_furnaces SET level = $2, updated_at = now() WHERE kingdom_id = $1 AND level = $3",
      [actor.kingdomId, next.level, currentLevel]
    );
  } else {
    await client.query(
      "INSERT INTO kingdom_brick_furnaces (kingdom_id, level) VALUES ($1, $2)",
      [actor.kingdomId, next.level]
    );
  }
  await client.query(
    `INSERT INTO kingdom_brick_furnace_operations (
       operation_key, kingdom_id, player_id, action, furnace_level, glimmer_oil_quantity, glimmer_oil_source
     ) VALUES ($1,$2,$3,'upgrade',$4,$5,$6)`,
    [operationKey, actor.kingdomId, actor.playerId, next.level, next.upgradeGlimmerOil, source]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "brick_furnace_upgraded",
    metadata: { level: next.level, glimmerOil: next.upgradeGlimmerOil, source }
  });
  return { level: next.level, glimmerOil: next.upgradeGlimmerOil, source };
}

/**
 * Takes the Brick Furnace down one level (never below 1) and credits the
 * treasury half of the removed step's Glimmer Oil. Runs inside the kingdom
 * mutation (kingdom row locked, leader-only build permission checked, the
 * request id replay-protected there); the furnace row lock and the level
 * check refuse a second downgrade of the same level.
 */
export async function downgradeBrickFurnaceInTransaction(
  client: Queryable,
  actor: BrickActor,
  input: Readonly<{ requestId: string; fromLevel: number }>
): Promise<{ level: number; refund: Array<{ itemId: string; quantity: number }> }> {
  const furnace = await lockFurnace(client, actor.kingdomId);
  const currentLevel = furnace ? Number(furnace.level) : 0;
  if (currentLevel !== input.fromLevel) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_BRICK_FURNACE_LEVEL_CHANGED",
      currentLevel === 0 ? "Build the Brick Furnace first" : `The Brick Furnace is now level ${currentLevel}`
    );
  }
  const refund = kingdomStructureDowngradeRefund("brick_furnace", currentLevel);
  if (!refund) {
    throw new KingdomBrickEconomyError("KINGDOM_STRUCTURE_DOWNGRADE_FLOOR", "A level 1 structure cannot be downgraded");
  }
  const operationKey = `kingdom-structure-downgrade:${actor.playerId}:${input.requestId}`;
  const toLevel = currentLevel - 1;
  await creditKingdomDowngradeRefundInTransaction(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    operationKey,
    refund,
    metadata: { structure: "brick_furnace", fromLevel: currentLevel, toLevel }
  });
  await client.query(
    "UPDATE kingdom_brick_furnaces SET level = $2, updated_at = now() WHERE kingdom_id = $1 AND level = $3",
    [actor.kingdomId, toLevel, currentLevel]
  );
  await client.query(
    `INSERT INTO kingdom_brick_furnace_operations (
       operation_key, kingdom_id, player_id, action, furnace_level, glimmer_oil_quantity, glimmer_oil_source
     ) VALUES ($1,$2,$3,'downgrade',$4,$5,'treasury')`,
    [operationKey, actor.kingdomId, actor.playerId, toLevel, refund[0]!.quantity]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "brick_furnace_downgraded",
    metadata: { fromLevel: currentLevel, level: toLevel, refund }
  });
  return { level: toLevel, refund: refund.map((line) => ({ ...line })) };
}

/**
 * Buys the furnace's brick package: the buyer's carried Glimmer Oil for the
 * level's Bricks, credited to the treasury. One package per kingdom every
 * 20 hours, enforced under the furnace row lock (taken after the kingdom
 * row), so two members racing for the same window cannot both buy.
 */
export async function buyBrickFurnacePackageInTransaction(
  client: Queryable,
  inventory: BrickInventory,
  actor: BrickActor,
  input: KingdomBrickFurnacePackageInput,
  now: Date
): Promise<{ bricks: number; glimmerOil: number; nextPackageAt: string }> {
  const furnace = await lockFurnace(client, actor.kingdomId);
  const level = furnace ? kingdomBrickFurnaceLevel(Number(furnace.level)) : null;
  if (!furnace || !level) {
    throw new KingdomBrickEconomyError("KINGDOM_BRICK_FURNACE_REQUIRED", "Build the Brick Furnace first");
  }
  if (level.level !== input.furnaceLevel) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_BRICK_FURNACE_LEVEL_CHANGED",
      `The Brick Furnace is now level ${level.level}; check the new package`
    );
  }
  const availableAt = furnace.last_package_at === null
    ? 0
    : new Date(furnace.last_package_at).getTime() + KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS;
  if (now.getTime() < availableAt) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_BRICK_FURNACE_COOLDOWN",
      "The Brick Furnace is cooling; the next package is ready later",
      { nextPackageAt: new Date(availableAt).toISOString() }
    );
  }
  const operationKey = `kingdom-brick-package:${actor.playerId}:${input.requestId}`;
  try {
    await inventory.debitItemsForOperationInTransaction(client, {
      operationKey,
      playerId: actor.playerId,
      source: "kingdom_brick_furnace_package",
      sourceEntityType: "kingdom",
      sourceEntityId: actor.kingdomId,
      metadata: { furnaceLevel: level.level, bricks: level.packageBricks },
      debits: [{ itemId: GLIMMER_OIL_ITEM_ID, variant: null, quantity: level.packageGlimmerOil }]
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Inventory does not contain enough items") {
      throw new KingdomBrickEconomyError(
        "KINGDOM_BRICK_FURNACE_GLIMMER_OIL_REQUIRED",
        `This package costs ${level.packageGlimmerOil} Glimmer Oil from your pack`
      );
    }
    throw error;
  }
  await moveKingdomTreasuryInTransaction(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    resourceType: BRICKS_ITEM_ID,
    direction: "credit",
    quantity: level.packageBricks,
    sourceType: "brick_furnace_package",
    operationKey,
    metadata: { furnaceLevel: level.level, glimmerOil: level.packageGlimmerOil }
  });
  await client.query(
    "UPDATE kingdom_brick_furnaces SET last_package_at = $2, updated_at = now() WHERE kingdom_id = $1",
    [actor.kingdomId, now]
  );
  await client.query(
    `INSERT INTO kingdom_brick_furnace_operations (
       operation_key, kingdom_id, player_id, action, furnace_level, glimmer_oil_quantity,
       glimmer_oil_source, bricks_quantity
     ) VALUES ($1,$2,$3,'package',$4,$5,'player',$6)`,
    [operationKey, actor.kingdomId, actor.playerId, level.level, level.packageGlimmerOil, level.packageBricks]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "brick_furnace_package_bought",
    metadata: { level: level.level, bricks: level.packageBricks, glimmerOil: level.packageGlimmerOil }
  });
  return {
    bricks: level.packageBricks,
    glimmerOil: level.packageGlimmerOil,
    nextPackageAt: new Date(now.getTime() + KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS).toISOString()
  };
}

export async function loadBrickFurnace(
  queryable: Queryable,
  kingdomId: string,
  now: Date
): Promise<KingdomBrickFurnaceSnapshot> {
  const result = await queryable.query<FurnaceRow>(
    "SELECT level, last_package_at FROM kingdom_brick_furnaces WHERE kingdom_id = $1",
    [kingdomId]
  );
  const row = result.rows[0];
  if (!row) return { level: 0, lastPackageAt: null, nextPackageAt: null };
  const last = row.last_package_at === null ? null : new Date(row.last_package_at);
  const next = last ? last.getTime() + KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS : 0;
  return {
    level: Number(row.level),
    lastPackageAt: last ? last.toISOString() : null,
    nextPackageAt: next > now.getTime() ? new Date(next).toISOString() : null
  };
}
