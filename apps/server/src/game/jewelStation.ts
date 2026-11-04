import { createHash } from "node:crypto";

import {
  INSCRIBE_LUMEN_COST,
  INSCRIBE_MIN_ITEM_LEVEL,
  INSCRIPTION_NAME_MAX,
  INSCRIPTION_NAME_MIN,
  inscriptionKind,
  normalizeInscriptionName,
  ENCHANTMENT_STONE_VARIANTS,
  LUMEN_ITEM_ID,
  METAL_BARS_PER_INFUSION,
  METAL_REFORGE_BARS_RETURNED,
  jewelReforgeLumenCost,
  POISON_IMBUEMENT_REQUIRED_ACHIEVEMENT_ID,
  equipmentMetalDefinition,
  equipmentMetalDisplayName,
  metalEquipmentEnhancement,
  metalInfusionKind,
  parseEquipmentEnhancement,
  preparedEquipmentEnhancement,
  requireEquipmentDefinition,
  serializeEquipmentEnhancement,
  supportsJewelStationEnhancement,
  venomsteelImbuementKind,
  type EnchantmentStoneVariant,
  type EquipmentMetal,
  type EquipmentMetalDefinition,
  type JewelStationMutationResult,
  type JewelStationState
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AchievementService } from "./achievements.js";
import type { EquipmentService } from "./equipment.js";
import { isInventoryCapacityError, type InventoryService } from "./inventory.js";

type EnhancementAction = "prepare" | "imbue" | "reforge";
type ImbuementMetal = EquipmentMetal;
type LegacyCoreItemId = NonNullable<EquipmentMetalDefinition["legacyCoreItemId"]>;
type EquipmentRow = {
  instance_id: string;
  definition_id: string;
  owner_player_id: string;
  location: string;
  enchantment_identity: string | null;
};
type OperationRow = {
  player_id: string;
  action: EnhancementAction;
  instance_id: string;
  request_hash: string;
  result: { metal?: ImbuementMetal | null } | null;
};

export class JewelStationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JewelStationError";
  }
}

export class JewelStationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: Pick<InventoryService,
      "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction" |
      "lockPlayerInventoryForOperationInTransaction" | "snapshotInTransaction">,
    private readonly equipment: Pick<EquipmentService, "refreshInventorySlots">,
    private readonly achievements: Pick<AchievementService, "snapshot">
  ) {}

  async state(playerId: string): Promise<JewelStationState> {
    const [equipment, inventory, achievements] = await Promise.all([
      this.equipment.refreshInventorySlots(playerId),
      this.inventorySnapshot(playerId),
      this.achievements.snapshot(playerId)
    ]);
    return { equipment, inventory, achievements };
  }

  async prepare(
    playerId: string,
    requestId: string,
    instanceId: string,
    gemstone: EnchantmentStoneVariant
  ): Promise<JewelStationMutationResult> {
    return this.mutate(playerId, requestId, instanceId, "prepare", gemstone);
  }

  async imbue(
    playerId: string,
    requestId: string,
    instanceId: string,
    metal: ImbuementMetal = "venomsteel"
  ): Promise<JewelStationMutationResult> {
    return this.mutate(playerId, requestId, instanceId, "imbue", null, metal);
  }

  /**
   * Strips the metal (returning some bars), swaps the gem for a new Enchantment Stone, or both,
   * for one Lumen fee (see jewelReforgeLumenCost). Omitting both options strips the metal.
   */
  async reforge(
    playerId: string,
    requestId: string,
    instanceId: string,
    options: { gemstone?: EnchantmentStoneVariant | null; changeMetal?: boolean } = {}
  ): Promise<JewelStationMutationResult> {
    const gemstone = options.gemstone ?? null;
    const changeMetal = options.changeMetal ?? gemstone === null;
    if (!changeMetal && gemstone === null) {
      throw new JewelStationError("JEWEL_INVALID_REQUEST", "Choose a metal or gem change.");
    }
    return this.mutate(playerId, requestId, instanceId, "reforge", gemstone, "venomsteel", changeMetal);
  }

  /**
   * Inscribe: names a weapon, armor piece or shield at +18 or higher for ${INSCRIBE_LUMEN_COST} Lumen. Anyone
   * holding the Lumen may inscribe (or re-inscribe) it; the stats stay with the item. The name is
   * unique across all items (case-insensitive unique index). One transaction: the Lumen debit, the
   * new name and the operation record; a replayed request charges once.
   */
  async inscribe(
    playerId: string,
    requestId: string,
    instanceId: string,
    rawName: string,
    filter: (name: string) => boolean = () => true
  ): Promise<Readonly<{ replayed: boolean; name: string; state: JewelStationState }>> {
    requireInput(playerId, requestId, instanceId);
    const name = normalizeInscriptionName(rawName);
    if (!name) {
      throw new JewelStationError("INSCRIPTION_NAME_INVALID", `Use ${INSCRIPTION_NAME_MIN} to ${INSCRIPTION_NAME_MAX} letters, numbers, spaces, apostrophes, periods or hyphens.`);
    }
    if (!filter(name)) throw new JewelStationError("INSCRIPTION_NAME_REJECTED", "That name is not allowed.");
    const requestHash = createHash("sha256").update(JSON.stringify([playerId, "inscribe", instanceId, name.toLowerCase()])).digest("hex");
    const operationKey = `equipment:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    let replayed = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [operationKey]);
      await this.inventory.lockPlayerInventoryForOperationInTransaction(client, playerId);
      const existing = await client.query<OperationRow>(
        `SELECT player_id,action,instance_id::text,request_hash,result FROM equipment_operations WHERE operation_key=$1`,
        [operationKey]
      );
      const equipmentRow = await lockEquipment(client, instanceId);
      await lockEquipmentInventoryAuthority(client, playerId);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.player_id !== playerId || (row.action as string) !== "inscribe" || row.instance_id !== instanceId || row.request_hash !== requestHash) {
          throw new JewelStationError("EQUIPMENT_IDEMPOTENCY_CONFLICT", "Request ID was reused with different inscription intent.");
        }
        replayed = true;
      } else {
        const home = await client.query(
          `SELECT 1 FROM players player JOIN player_manors manor ON manor.id::text = player.location_id
            WHERE player.id=$1 AND player.location_kind='interior' AND player.location_type='manor'
              AND manor.owner_player_id=$1`,
          [playerId]
        );
        if (home.rowCount !== 1) throw new JewelStationError("JEWEL_NOT_AT_STATION", "Inscribe at the Jewel Station in your manor.");
        if (equipmentRow.owner_player_id !== playerId) {
          throw new JewelStationError("EQUIPMENT_NOT_OWNED", "Equipment instance is not owned by this player.");
        }
        if (equipmentRow.location !== "inventory") {
          throw new JewelStationError("EQUIPMENT_NOT_CARRIED", "Only unequipped equipment in Inventory can use the Jewel Station.");
        }
        const definition = requireEquipmentDefinition(equipmentRow.definition_id);
        const level = await client.query<{ item_level: number }>("SELECT item_level FROM equipment_instances WHERE instance_id=$1", [instanceId]);
        if (inscriptionKind(definition.category) === null || definition.retired === true ||
            (definition.equipmentRole !== "stock" && definition.equipmentRole !== "cosmetic")) {
          throw new JewelStationError("EQUIPMENT_NOT_ELIGIBLE", "Only weapons, armor and shields can be inscribed.");
        }
        if (Number(level.rows[0]?.item_level ?? 0) < INSCRIBE_MIN_ITEM_LEVEL) {
          throw new JewelStationError("INSCRIPTION_LEVEL_TOO_LOW", `Only equipment at +${INSCRIBE_MIN_ITEM_LEVEL} or higher can be inscribed.`);
        }
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `jewel:inscribe:${playerId}:${requestId}`,
          playerId,
          source: "equipment_enhancement",
          sourceEntityType: "equipment",
          sourceEntityId: instanceId,
          metadata: { requestId, action: "inscribe", instanceId, name },
          debits: [{ itemId: LUMEN_ITEM_ID, variant: null, quantity: INSCRIBE_LUMEN_COST }]
        });
        await client.query(
          `UPDATE equipment_instances
              SET inscription_name=$2,
                  inscribed_by_name=(SELECT username FROM players WHERE id=$3),
                  inscribed_at=now(), updated_at=now()
            WHERE instance_id=$1`,
          [instanceId, name, playerId]
        );
        await client.query(`UPDATE player_equipment_state SET inventory_revision=inventory_revision+1 WHERE player_id=$1`, [playerId]);
        await client.query(
          `INSERT INTO equipment_operations (operation_key,player_id,action,instance_id,request_hash,result,completed_at)
           VALUES ($1,$2,'inscribe',$3,$4,$5::jsonb,now())`,
          [operationKey, playerId, instanceId, requestHash, JSON.stringify({ name })]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof JewelStationError) throw error;
      if ((error as { code?: string }).code === "23505") {
        throw new JewelStationError("INSCRIPTION_NAME_TAKEN", "That name is already inscribed on another item.");
      }
      if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
        throw new JewelStationError("JEWEL_LUMEN_REQUIRED", `Needs ${INSCRIBE_LUMEN_COST} Lumen.`);
      }
      throw error;
    } finally {
      client.release();
    }
    return { replayed, name, state: await this.state(playerId) };
  }

  private async mutate(
    playerId: string,
    requestId: string,
    instanceId: string,
    action: EnhancementAction,
    requestedGemstone: EnchantmentStoneVariant | null,
    metal: ImbuementMetal = "venomsteel",
    changeMetal = true
  ): Promise<JewelStationMutationResult> {
    requireInput(playerId, requestId, instanceId);
    if (requestedGemstone && !ENCHANTMENT_STONE_VARIANTS.includes(requestedGemstone)) {
      throw new JewelStationError("JEWEL_GEMSTONE_INVALID", "Choose a valid Enchantment Stone.");
    }
    const requestHashIntent = action !== "imbue" || metal === "venomsteel"
      ? action === "reforge" && requestedGemstone
        ? [playerId, action, instanceId, requestedGemstone, changeMetal]
        : [playerId, action, instanceId, requestedGemstone]
      : [playerId, action, instanceId, requestedGemstone, metal];
    const lumenCost = action === "reforge" ? jewelReforgeLumenCost(changeMetal, requestedGemstone !== null) : 0;
    const requestHash = createHash("sha256")
      .update(JSON.stringify(requestHashIntent))
      .digest("hex");
    const operationKey = `equipment:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    let gemstone: EnchantmentStoneVariant | null = requestedGemstone;
    let resultMetal: ImbuementMetal | null = metal;
    let replayed = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [operationKey]);
      await this.inventory.lockPlayerInventoryForOperationInTransaction(client, playerId);
      const existing = await client.query<OperationRow>(
        `SELECT player_id,action,instance_id::text,request_hash,result
         FROM equipment_operations WHERE operation_key=$1`,
        [operationKey]
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.player_id !== playerId || row.action !== action ||
          row.instance_id !== instanceId || row.request_hash !== requestHash
        ) throw new JewelStationError("EQUIPMENT_IDEMPOTENCY_CONFLICT", "Request ID was reused with different jewel intent.");
        const equipmentRow = await lockEquipment(client, instanceId);
        await lockEquipmentInventoryAuthority(client, playerId);
        gemstone = parseEquipmentEnhancement(equipmentRow.enchantment_identity)?.gemstone ?? requestedGemstone;
        if (action === "reforge") resultMetal = row.result?.metal ?? null;
        replayed = true;
      } else {
        const equipmentRow = await lockEquipment(client, instanceId);
        await lockEquipmentInventoryAuthority(client, playerId);
        if (equipmentRow.owner_player_id !== playerId) {
          throw new JewelStationError("EQUIPMENT_NOT_OWNED", "Equipment instance is not owned by this player.");
        }
        if (equipmentRow.location !== "inventory") {
          throw new JewelStationError("EQUIPMENT_NOT_CARRIED", "Only unequipped equipment in Inventory can use the Jewel Station.");
        }
        const definition = requireEquipmentDefinition(equipmentRow.definition_id);
        if (!supportsJewelStationEnhancement(definition)) {
          throw new JewelStationError("EQUIPMENT_NOT_ELIGIBLE", "Developer, special, and retired equipment cannot be prepared.");
        }
        const current = parseEquipmentEnhancement(equipmentRow.enchantment_identity);
        if (action === "prepare") {
          if (venomsteelImbuementKind(definition.category) === null) {
            throw new JewelStationError("EQUIPMENT_NOT_ELIGIBLE", "Only weapons and armor can be prepared.");
          }
          if (equipmentRow.enchantment_identity !== null) {
            throw new JewelStationError("EQUIPMENT_ALREADY_ENHANCED", "This equipment already has an enhancement identity.");
          }
          gemstone = requestedGemstone;
          if (!gemstone) throw new JewelStationError("JEWEL_GEMSTONE_INVALID", "Choose an Enchantment Stone.");
          await this.debit(client, playerId, requestId, instanceId, action, "enchantment_stone", gemstone, 1);
          await client.query(
            `UPDATE equipment_instances SET enchantment_identity=$2,updated_at=now() WHERE instance_id=$1`,
            [instanceId, serializeEquipmentEnhancement(preparedEquipmentEnhancement(gemstone))]
          );
        } else if (action === "imbue") {
          if (metalInfusionKind(definition.category) === null) {
            throw new JewelStationError(
              "EQUIPMENT_NOT_ELIGIBLE",
              "Only weapons, chest armor and shields can be infused."
            );
          }
          if (equipmentRow.enchantment_identity !== null && !current) {
            throw new JewelStationError("EQUIPMENT_NOT_ELIGIBLE", "This equipment has an unrecognized enhancement.");
          }
          if (current?.metal) {
            throw new JewelStationError(
              "EQUIPMENT_ALREADY_INFUSED",
              "Infusion is permanent. Reforge this equipment to remove its metal first."
            );
          }
          if (metal === "venomsteel" && !await playerHasAchievement(
            client,
            playerId,
            POISON_IMBUEMENT_REQUIRED_ACHIEVEMENT_ID
          )) {
            throw new JewelStationError(
              "JEWEL_ACHIEVEMENT_REQUIRED",
              "Bitter Blood is required to infuse equipment with Venom."
            );
          }
          gemstone = current?.gemstone ?? null;
          const metalDefinition = equipmentMetalDefinition(metal);
          const coreId = metalDefinition.legacyCoreItemId;
          const hasLegacyCore = coreId !== null &&
            ((await this.inventory.snapshotInTransaction(client, playerId)).totals[coreId] ?? 0) >= 1;
          await this.debit(
            client, playerId, requestId, instanceId, action,
            hasLegacyCore ? coreId : metalDefinition.barItemId, null,
            hasLegacyCore ? 1 : METAL_BARS_PER_INFUSION
          );
          await client.query(
            `UPDATE equipment_instances SET enchantment_identity=$2,updated_at=now() WHERE instance_id=$1`,
            [instanceId, serializeEquipmentEnhancement(metalEquipmentEnhancement(gemstone, metal))]
          );
        } else {
          if (changeMetal && !current?.metal) {
            throw new JewelStationError("EQUIPMENT_NOT_INFUSED", "This equipment has no metal to remove.");
          }
          if (requestedGemstone) {
            if (!current?.gemstone) {
              throw new JewelStationError("EQUIPMENT_NO_GEMSTONE", "This equipment has no gem to change.");
            }
            if (current.gemstone === requestedGemstone) {
              throw new JewelStationError("JEWEL_GEMSTONE_INVALID", "Choose a different gem.");
            }
          }
          const keptMetal = changeMetal ? null : current?.metal ?? null;
          resultMetal = current?.metal ?? null;
          gemstone = requestedGemstone ?? current?.gemstone ?? null;
          // One operation: the Lumen fee, the replacement stone and the new identity commit together.
          await this.inventory.debitItemsForOperationInTransaction(client, {
            operationKey: `jewel:reforge:${playerId}:${requestId}`,
            playerId,
            source: "equipment_enhancement",
            sourceEntityType: "equipment",
            sourceEntityId: instanceId,
            metadata: { requestId, action, instanceId, changeMetal, gemstone: requestedGemstone },
            debits: [
              { itemId: LUMEN_ITEM_ID, variant: null, quantity: lumenCost },
              ...(requestedGemstone
                ? [{ itemId: "enchantment_stone" as const, variant: requestedGemstone, quantity: 1 }]
                : [])
            ]
          });
          if (changeMetal && current?.metal) {
            await this.inventory.grantItemsForOperationInTransaction(client, {
              operationKey: `jewel:reforge:bars:${playerId}:${requestId}`,
              playerId,
              source: "equipment_enhancement",
              sourceEntityType: "equipment",
              sourceEntityId: instanceId,
              metadata: { requestId, action, instanceId, metal: current.metal },
              grants: [{
                itemId: equipmentMetalDefinition(current.metal).barItemId,
                variant: null,
                quantity: METAL_REFORGE_BARS_RETURNED
              }]
            });
          }
          await client.query(
            `UPDATE equipment_instances SET enchantment_identity=$2,updated_at=now() WHERE instance_id=$1`,
            [instanceId, keptMetal
              ? serializeEquipmentEnhancement(metalEquipmentEnhancement(gemstone, keptMetal))
              : gemstone ? serializeEquipmentEnhancement(preparedEquipmentEnhancement(gemstone)) : null]
          );
        }
        await client.query(
          `UPDATE player_equipment_state SET inventory_revision=inventory_revision+1 WHERE player_id=$1`,
          [playerId]
        );
        await client.query(
          `INSERT INTO equipment_operations (
             operation_key,player_id,action,instance_id,request_hash,result,completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())`,
          [operationKey, playerId, action, instanceId, requestHash, JSON.stringify({ gemstone, metal: resultMetal })]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof JewelStationError) throw error;
      if (action === "reforge" && isInventoryCapacityError(error)) {
        throw new JewelStationError("JEWEL_INVENTORY_FULL", "You cannot carry the returned bars.");
      }
      if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
        if (action === "reforge") {
          throw new JewelStationError(
            "JEWEL_LUMEN_REQUIRED",
            requestedGemstone
              ? `Needs ${lumenCost} Lumen and the selected Enchantment Stone.`
              : `Needs ${lumenCost} Lumen.`
          );
        }
        throw new JewelStationError(
          "JEWEL_MATERIALS_REQUIRED",
          action === "prepare"
            ? "The selected Enchantment Stone is not available."
            : `${METAL_BARS_PER_INFUSION} ${displayMetal(metal)} Bars (or 1 ${displayMetal(metal)} Core) are required.`
        );
      }
      throw error;
    } finally {
      client.release();
    }
    if (action === "prepare" && !gemstone) {
      throw new JewelStationError("JEWEL_GEMSTONE_INVALID", "The equipment gemstone identity is unavailable.");
    }
    return {
      requestId,
      action,
      instanceId,
      gemstone,
      ...(action === "prepare" || resultMetal === null ? {} : { metal: resultMetal }),
      ...(action === "reforge"
        ? { metalChanged: changeMetal, gemstoneChanged: requestedGemstone !== null }
        : {}),
      replayed,
      state: await this.state(playerId)
    };
  }

  private async debit(
    client: pg.PoolClient,
    playerId: string,
    requestId: string,
    instanceId: string,
    action: EnhancementAction,
    itemId: "enchantment_stone" | EquipmentMetalDefinition["barItemId"] | LegacyCoreItemId,
    variant: EnchantmentStoneVariant | null,
    quantity: number
  ): Promise<void> {
    await this.inventory.debitItemsForOperationInTransaction(client, {
      operationKey: `jewel:${action}:${playerId}:${requestId}`,
      playerId,
      source: "equipment_enhancement",
      sourceEntityType: "equipment",
      sourceEntityId: instanceId,
      metadata: { requestId, action, instanceId, gemstone: variant },
      debits: [{ itemId, variant, quantity }]
    });
  }

  private async inventorySnapshot(playerId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const snapshot = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function displayMetal(metal: ImbuementMetal): string {
  return equipmentMetalDisplayName(metal);
}

async function lockEquipment(client: pg.PoolClient, instanceId: string): Promise<EquipmentRow> {
  const result = await client.query<EquipmentRow>(
    `SELECT instance_id::text,definition_id,owner_player_id,location,enchantment_identity
     FROM equipment_instances WHERE instance_id=$1 FOR UPDATE`,
    [instanceId]
  );
  const row = result.rows[0];
  if (!row) throw new JewelStationError("EQUIPMENT_NOT_FOUND", "Equipment instance was not found.");
  return row;
}

async function lockEquipmentInventoryAuthority(
  client: pg.PoolClient,
  playerId: string
): Promise<void> {
  const state = await client.query(
    `SELECT inventory_revision FROM player_equipment_state
     WHERE player_id=$1 FOR UPDATE`,
    [playerId]
  );
  if (state.rowCount !== 1) {
    throw new JewelStationError("JEWEL_EQUIPMENT_STATE_REQUIRED", "Equipment Inventory is unavailable.");
  }
}

async function playerHasAchievement(
  client: pg.PoolClient,
  playerId: string,
  achievementId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM player_achievements
     WHERE player_id=$1 AND achievement_id=$2`,
    [playerId, achievementId]
  );
  return result.rowCount === 1;
}

function requireInput(playerId: string, requestId: string, instanceId: string): void {
  if (!playerId || playerId.length > 160 || !requestId || requestId.length > 128 || !instanceId) {
    throw new JewelStationError("JEWEL_INVALID_REQUEST", "A valid Jewel Station request is required.");
  }
}
