import {
  kingdomWarStructureCap,
  kingdomCommandBoardLevel,
  kingdomCommandBoardMaterials,
  kingdomStructureDowngradeRefund,
  type InventoryItemType,
  type KingdomWarMaterial,
  type KingdomWarStructureKind,
  type KingdomWarStructureSummary,
  type KingdomCommandBoardSnapshot,
  type KingdomCommandBoardUpgradeInput
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { KingdomBrickEconomyError } from "./kingdomBrickEconomy.js";
import {
  creditKingdomDowngradeRefundInTransaction,
  insertKingdomAuditEvent,
  lockKingdomTreasuryBalance,
  moveKingdomTreasuryInTransaction,
  type KingdomTreasuryLedgerSource
} from "./kingdomTreasuryLedger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type WarInventory = Pick<InventoryService, "debitItemsForOperationInTransaction">;

export type ChargedWarMaterial = Readonly<{ itemId: string; quantity: number; source: "treasury" | "builder" }>;

const MATERIAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bricks: "Bricks",
  pearl: "Pearl",
  refined_oil: "Glimmer Oil",
  crystal: "Crystal",
  iron: "Iron"
});

export function warMaterialLabel(itemId: string): string {
  return MATERIAL_LABELS[itemId] ?? itemId;
}

/**
 * Takes each material from the kingdom treasury when it holds the full
 * amount, otherwise from the builder's pack. Every treasury movement is
 * ledgered under `operationKey` (unique per resource and direction) and the
 * pack debits share one inventory operation, so a replayed operation can
 * never charge twice. Callers lock treasury rows after the player row.
 */
export async function chargeKingdomWarMaterialsInTransaction(
  client: Queryable,
  inventory: WarInventory,
  input: Readonly<{
    kingdomId: string;
    playerId: string;
    operationKey: string;
    materials: readonly KingdomWarMaterial[];
    ledgerSource: Extract<KingdomTreasuryLedgerSource, "command_board_upgrade" | "war_structure_build" | "castle_rebuild">;
    inventorySource: string;
    sourceEntityType: string;
    sourceEntityId: string;
    metadata: Record<string, unknown>;
    shortageMessage: (material: KingdomWarMaterial) => string;
    /** False: every material from the builder's pack; the treasury is never touched. */
    treasuryAllowed?: boolean;
  }>
): Promise<ChargedWarMaterial[]> {
  const charged: ChargedWarMaterial[] = [];
  const fromBuilder: KingdomWarMaterial[] = [];
  for (const material of input.materials) {
    const treasury = input.treasuryAllowed === false
      ? 0
      : await lockKingdomTreasuryBalance(client, input.kingdomId, material.itemId);
    if (input.treasuryAllowed !== false && treasury >= material.quantity) {
      const moved = await moveKingdomTreasuryInTransaction(client, {
        kingdomId: input.kingdomId,
        actorPlayerId: input.playerId,
        resourceType: material.itemId,
        direction: "debit",
        quantity: material.quantity,
        sourceType: input.ledgerSource,
        operationKey: input.operationKey,
        sourceId: input.sourceEntityId,
        metadata: input.metadata
      });
      if (!moved) throw new Error("A locked treasury balance changed during a war build");
      charged.push({ ...material, source: "treasury" });
    } else {
      fromBuilder.push(material);
      charged.push({ ...material, source: "builder" });
    }
  }
  if (fromBuilder.length > 0) {
    try {
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: input.operationKey,
        playerId: input.playerId,
        source: input.inventorySource,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        metadata: input.metadata,
        debits: fromBuilder.map((material) => ({
          itemId: material.itemId as InventoryItemType, variant: null, quantity: material.quantity
        }))
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Inventory does not contain enough items") {
        throw new KingdomBrickEconomyError("KINGDOM_WAR_MATERIAL_REQUIRED", input.shortageMessage(fromBuilder[0]!), {
          missing: fromBuilder.map((material) => material.itemId)
        });
      }
      throw error;
    }
  }
  return charged;
}

async function lockCommandBoard(client: Queryable, kingdomId: string): Promise<number> {
  const result = await client.query<{ level: number }>(
    "SELECT level FROM kingdom_command_boards WHERE kingdom_id = $1 FOR UPDATE",
    [kingdomId]
  );
  return result.rows[0] ? Number(result.rows[0].level) : 0;
}

/**
 * Builds or upgrades the Command Board to the next level. Runs inside the
 * kingdom mutation with the leader-only build permission already checked
 * (player row, kingdom row and membership locked; the request id is
 * replay-protected there). The level check under the Command Board row lock and
 * the (kingdom, level) unique key refuse a second build of the same level.
 */
export async function upgradeKingdomCommandBoardInTransaction(
  client: Queryable,
  inventory: WarInventory,
  actor: Readonly<{ playerId: string; kingdomId: string }>,
  input: KingdomCommandBoardUpgradeInput
): Promise<{ level: number; materials: ChargedWarMaterial[] }> {
  const next = kingdomCommandBoardLevel(input.targetLevel);
  if (!next) throw new KingdomBrickEconomyError("KINGDOM_COMMAND_BOARD_LEVEL_INVALID", "Choose the next Command Board level");
  const currentLevel = await lockCommandBoard(client, actor.kingdomId);
  if (currentLevel !== next.level - 1) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_COMMAND_BOARD_LEVEL_CHANGED",
      currentLevel >= next.level ? `The Command Board is already level ${currentLevel}` : `Build level ${currentLevel + 1} first`
    );
  }
  const operationKey = `kingdom-command-board:${actor.playerId}:${input.requestId}`;
  const materials = await chargeKingdomWarMaterialsInTransaction(client, inventory, {
    kingdomId: actor.kingdomId,
    playerId: actor.playerId,
    operationKey,
    materials: kingdomCommandBoardMaterials(next),
    ledgerSource: "command_board_upgrade",
    inventorySource: "kingdom_command_board_upgrade",
    sourceEntityType: "kingdom",
    sourceEntityId: actor.kingdomId,
    metadata: { targetLevel: next.level },
    shortageMessage: (material) =>
      `Command Board level ${next.level} needs ${material.quantity.toLocaleString("en-US")} ` +
      `${warMaterialLabel(material.itemId)} from the treasury or your pack`
  });
  if (currentLevel === 0) {
    await client.query("INSERT INTO kingdom_command_boards (kingdom_id, level) VALUES ($1, 1)", [actor.kingdomId]);
  } else {
    await client.query(
      "UPDATE kingdom_command_boards SET level = $2, updated_at = now() WHERE kingdom_id = $1 AND level = $3",
      [actor.kingdomId, next.level, currentLevel]
    );
  }
  await client.query(
    `INSERT INTO kingdom_command_board_operations (operation_key, kingdom_id, player_id, from_level, to_level, materials)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [operationKey, actor.kingdomId, actor.playerId, currentLevel === 0 ? null : currentLevel, next.level,
      JSON.stringify(materials)]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "command_board_upgraded",
    metadata: { level: next.level, materials }
  });
  return { level: next.level, materials };
}

/**
 * Takes the Command Board down one level (never below 1) and credits the
 * treasury half of each material of the removed step. Standing War Towers
 * and Outposts above the new cap stay up; the cap only refuses new ones.
 * Runs inside the kingdom mutation like the upgrade.
 */
export async function downgradeKingdomCommandBoardInTransaction(
  client: Queryable,
  actor: Readonly<{ playerId: string; kingdomId: string }>,
  input: Readonly<{ requestId: string; fromLevel: number }>
): Promise<{ level: number; refund: Array<{ itemId: string; quantity: number }> }> {
  const currentLevel = await lockCommandBoard(client, actor.kingdomId);
  if (currentLevel !== input.fromLevel) {
    throw new KingdomBrickEconomyError(
      "KINGDOM_COMMAND_BOARD_LEVEL_CHANGED",
      currentLevel === 0 ? "Build the Command Board first" : `The Command Board is now level ${currentLevel}`
    );
  }
  const refund = kingdomStructureDowngradeRefund("command_board", currentLevel);
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
    metadata: { structure: "command_board", fromLevel: currentLevel, toLevel }
  });
  await client.query(
    "UPDATE kingdom_command_boards SET level = $2, updated_at = now() WHERE kingdom_id = $1 AND level = $3",
    [actor.kingdomId, toLevel, currentLevel]
  );
  await client.query(
    `INSERT INTO kingdom_command_board_operations (operation_key, kingdom_id, player_id, from_level, to_level, materials, operation)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'downgrade')`,
    [operationKey, actor.kingdomId, actor.playerId, currentLevel, toLevel,
      JSON.stringify(refund.map((line) => ({ ...line, source: "treasury" })))]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "command_board_downgraded",
    metadata: { fromLevel: currentLevel, level: toLevel, refund }
  });
  return { level: toLevel, refund: refund.map((line) => ({ ...line })) };
}

/** Standing (not collapsing) War Towers or Outposts of a kingdom, read under the caller's locks. */
export async function countKingdomWarStructures(
  queryable: Queryable,
  kingdomId: string,
  kind: KingdomWarStructureKind
): Promise<number> {
  const result = await queryable.query<{ used: number }>(
    `SELECT count(*)::int AS used FROM flags
     WHERE kingdom_id = $1::uuid AND war_structure_kind = $2 AND territory_collapse_id IS NULL`,
    [kingdomId, kind]
  );
  return Number(result.rows[0]?.used ?? 0);
}

export async function kingdomCommandBoardLevelOf(queryable: Queryable, kingdomId: string): Promise<number> {
  const result = await queryable.query<{ level: number }>(
    "SELECT level FROM kingdom_command_boards WHERE kingdom_id = $1",
    [kingdomId]
  );
  return result.rows[0] ? Number(result.rows[0].level) : 0;
}

type WarStructureRow = {
  id: string;
  war_structure_kind: KingdomWarStructureKind;
  name: string;
  lat: number;
  lon: number;
  health: number | null;
  maximum_health: number | null;
  burning_until: Date | string | null;
  war_id: string;
  enemy_name: string | null;
};

export async function loadKingdomCommandBoard(
  queryable: Queryable,
  kingdomId: string,
  now: Date
): Promise<KingdomCommandBoardSnapshot> {
  const level = await kingdomCommandBoardLevelOf(queryable, kingdomId);
  const rows = await queryable.query<WarStructureRow>(
    `SELECT flag.id::text, flag.war_structure_kind, flag.name, flag.lat, flag.lon, flag.health,
            flag.maximum_health, flag.burning_until, flag.war_id::text,
            CASE
              WHEN war.side_a_kind = 'kingdom' AND war.side_a_id = $1::uuid THEN
                COALESCE(enemy_kingdom_b.display_name, enemy_city_b.name)
              ELSE COALESCE(enemy_kingdom_a.display_name, enemy_city_a.name)
            END AS enemy_name
     FROM flags flag
     JOIN organization_wars war ON war.war_id = flag.war_id
     LEFT JOIN kingdoms enemy_kingdom_a ON war.side_a_kind = 'kingdom' AND enemy_kingdom_a.id = war.side_a_id
     LEFT JOIN cities enemy_city_a ON war.side_a_kind = 'city' AND enemy_city_a.id = war.side_a_id
     LEFT JOIN kingdoms enemy_kingdom_b ON war.side_b_kind = 'kingdom' AND enemy_kingdom_b.id = war.side_b_id
     LEFT JOIN cities enemy_city_b ON war.side_b_kind = 'city' AND enemy_city_b.id = war.side_b_id
     WHERE flag.kingdom_id = $1::uuid AND flag.war_structure_kind IS NOT NULL
       AND flag.territory_collapse_id IS NULL
     ORDER BY flag.war_structure_kind, flag.created_at, flag.id
     LIMIT 64`,
    [kingdomId]
  );
  const structures: KingdomWarStructureSummary[] = rows.rows.map((row) => ({
    flagId: row.id,
    kind: row.war_structure_kind,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    health: row.health === null ? null : Number(row.health),
    maximumHealth: row.maximum_health === null ? null : Number(row.maximum_health),
    burning: row.burning_until !== null && new Date(row.burning_until).getTime() > now.getTime(),
    warId: row.war_id,
    enemyName: row.enemy_name
  }));
  const used = (kind: KingdomWarStructureKind) => structures.filter((structure) => structure.kind === kind).length;
  return {
    level,
    warTowers: { used: used("war_tower"), cap: kingdomWarStructureCap(level, "war_tower") },
    warOutposts: { used: used("war_outpost"), cap: kingdomWarStructureCap(level, "war_outpost") },
    structures
  };
}
