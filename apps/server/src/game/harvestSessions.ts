import { NO_HARVEST_SKILL_ROLL, type HarvestSkillRoll } from "./dungeonSkills.js";
import { grantRingFindInTransaction, overworldRingGroundPlacement, type RingFindEquipment } from "./ringFinds.js";
import {
  FLAX_FIBER_HARVEST_YIELD_QUANTITY,
  applyRingSecondsToDuration,
  DEEPSTONE_MINED_RESOURCES,
  DEEPSTONE_RING_FIND_ID,
  rollMiningPoolRingTier,
  type EquipmentSnapshotV2,
  HARVEST_XP_BY_RESOURCE,
  type LatLon,
  type CollectibleNode,
  type DroppedItemSnapshot,
  type MasteryGrantResult,
  type HarvestSessionSnapshot,
  type HarvestSessionStatus,
  type PlayerInventorySnapshot,
  type ResourceVision,
  type ResourceType,
  treeHarvestDurationMsForStableId,
  treeWoodYieldForStableId,
  UTILITY_GEAR_ACTION_DURATION_MS,
  isUtilityGearDefinitionId,
  type UtilityGearDefinitionId,
  type XpGrantResult
} from "@ash-atlas/shared";
import type pg from "pg";

import { CollectibleHarvestError } from "./collectibles.js";
import {
  UTILITY_GEAR_GONE_MESSAGE,
  spendUtilityGearUseInTransaction,
  wornUtilityGearReady,
  type UtilityGearHooks,
  type UtilityGearSpend
} from "./utilityGear.js";
import type {
  CollectiblePlayer,
  CollectibleService,
  CollectibleTransaction,
  HarvestedPopulationTreeTransition
} from "./collectibles.js";
import { collectibleHarvestDurationMs } from "./items.js";
import type {
  recordCreatureBookPlantHarvestInTransaction,
  CreatureBookPlantHarvestInput
} from "./creatureBook.js";
import type { ProgressionService } from "./progression.js";
import type { MasteryService } from "./masteries.js";
import type { CityDistrictBenefitService } from "./cityDistrictBenefits.js";

export const HARVEST_SESSION_EXPIRY_GRACE_MS = 10_000;
const INSTANT_HARVEST_DURATION_MS = 1;

export type HarvestSessionErrorCode =
  | "HARVEST_NOT_FOUND"
  | "HARVEST_NOT_OWNED"
  | "HARVEST_ALREADY_ACTIVE"
  | "HARVEST_TOO_EARLY"
  | "HARVEST_CANCELLED"
  | "HARVEST_EXPIRED"
  | "HARVEST_ALREADY_COMPLETED";

export class HarvestSessionError extends Error {
  constructor(
    readonly code: HarvestSessionErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "HarvestSessionError";
  }
}

type HarvestCollectibleGateway = Pick<
  CollectibleService,
  | "validateHarvestStartInTransaction"
  | "validateResinHarvestStartInTransaction"
  | "completeHarvestInTransaction"
  | "completeResinHarvestInTransaction"
  | "grantRareFindInTransaction"
  | "inventoryForPlayerInTransaction"
  | "harvestedPopulationTreeTransitionInTransaction"
  | "findHarvestedPopulationTreeTransitionInTransaction"
> & Partial<Pick<CollectibleService, "grantKingdomBricksInTransaction">>;

type HarvestSessionRow = {
  id: string;
  player_id: string;
  node_id: string;
  resource_type: string;
  operation_key: string;
  status: HarvestSessionStatus;
  started_at: Date | string;
  completes_at: Date | string;
  expires_at: Date | string;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  mastery_results: { bonusYield?: boolean; instant?: boolean; rhythm?: boolean; skillBonus?: boolean; rareFindItemId?: string | null; utilityGlove?: string };
  city_id: string | null;
  city_district_type: "mining" | "forestry" | null;
  city_district_revision: string | null;
  city_monument_tier: 1 | 2 | 3 | null;
  city_bonus_chance: number;
  city_bonus_succeeded: boolean;
};

export type StartHarvestResult = {
  session: HarvestSessionSnapshot;
  /** The harvested node; null on a replay, which does not look the node up again. */
  nodePosition?: LatLon | null;
  replayed: boolean;
};

export type CompleteHarvestResult = {
  session: HarvestSessionSnapshot;
  nodeId: string;
  nodePosition: LatLon | null;
  inventory: PlayerInventorySnapshot;
  xpGrant: XpGrantResult | null;
  masteryGrant: MasteryGrantResult | null;
  reward: { itemId: ResourceType; quantity: number };
  professionResults: { bonusYield: boolean; instant: boolean };
  node: CollectibleNode | null;
  nodeRemoved: boolean;
  populationTreeTransition: HarvestedPopulationTreeTransition | null;
  droppedItems: DroppedItemSnapshot[];
  replayed: boolean;
};

export type CancelHarvestResult = {
  session: HarvestSessionSnapshot;
  replayed: boolean;
};

/** Woodcutter mastery modifiers shared by overworld trees and dungeon trees. */
export function woodcutterMasteryModifiers(woodRank: number, rhythm: boolean): Readonly<{
  speedBonus: number;
  rhythmBonus: number;
  instantChance: number;
  bonusYieldChance: number;
}> {
  return {
    speedBonus: woodRank >= 8 ? 0.08 : woodRank >= 4 ? 0.06 : woodRank >= 1 ? 0.03 : 0,
    rhythmBonus: rhythm ? (woodRank >= 8 ? 0.05 : 0.04) : 0,
    instantChance: woodRank >= 8 ? 0.04 : woodRank >= 7 ? 0.03 : woodRank >= 3 ? 0.02 : 0,
    bonusYieldChance: woodRank >= 8 ? 0.08 : woodRank >= 5 ? 0.06 : woodRank >= 2 ? 0.03 : 0
  };
}

export class HarvestSessionService {
  private ringEquipment: RingFindEquipment | null = null;
  private onRingFound: (playerId: string, equipment: EquipmentSnapshotV2) => void = () => undefined;

  private utilityGear: UtilityGearHooks | null = null;

  /** Refreshes the equipment runtime and the client after a utility glove spent a use. */
  setUtilityGear(hooks: UtilityGearHooks): void {
    this.utilityGear = hooks;
  }

  /** Deepstone Lore rare finds can be a ring (an equipment instance). */
  setRingFinds(
    equipment: RingFindEquipment,
    onFound: (playerId: string, equipment: EquipmentSnapshotV2) => void
  ): void {
    this.ringEquipment = equipment;
    this.onRingFound = onFound;
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly collectibles: HarvestCollectibleGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly progression?: ProgressionService,
    private readonly masteries?: MasteryService,
    private readonly districtBenefits?: CityDistrictBenefitService,
    private readonly random: () => number = serverRoll,
    private readonly creatureBook?: Readonly<{
      recordPlantHarvestInTransaction: typeof recordCreatureBookPlantHarvestInTransaction;
    }>,
    private readonly dungeonSkills?: Readonly<{ rollHarvestBonus(playerId: string, resourceType: string): Promise<HarvestSkillRoll> }>
  ) {}

  async startHarvest(
    player: CollectiblePlayer,
    nodeId: string,
    resourceVision: ResourceVision | null,
    action: "primary" | "resin" = "primary",
    expectedStateRevision?: number,
    actionDurationMultiplier = 1,
    choppingDurationMultiplier = 1,
    /** Fleet chopper ring: negative seconds off a tree chop. */
    choppingRingSeconds = 0,
    /** Fleet miner ring: negative seconds off mined collectibles (stone, ore, coal, sulfur, iron). */
    miningRingSeconds = 0,
    /** Utility glove worn when the action started (server-read from the equipment runtime). */
    utilityGlove: UtilityGearDefinitionId | null = null
  ): Promise<StartHarvestResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = this.now();
      await expireStaleSessions(client, now, player.playerId, nodeId);
      const active = await findActiveSession(client, player.playerId, nodeId);
      if (active) {
        if (active.player_id === player.playerId && active.node_id === nodeId) {
          await client.query("COMMIT");
          return { session: rowToSession(active), replayed: true };
        }
        throw new HarvestSessionError(
          "HARVEST_ALREADY_ACTIVE",
          active.player_id === player.playerId
            ? "Player already has an active harvest"
            : "Collectible is already being harvested"
        );
      }

      const node = action === "resin"
        ? await this.collectibles.validateResinHarvestStartInTransaction(
            client,
            player,
            nodeId,
            resourceVision,
            expectedStateRevision
          )
        : await this.collectibles.validateHarvestStartInTransaction(
            client,
            player,
            nodeId,
            resourceVision,
            expectedStateRevision
          );
      const woodRank = node.type === "wood" && this.masteries
        ? await this.masteries.professionRankInTransaction(client, player.playerId, "woodcutter")
        : 0;
      const lastWoodcut = woodRank >= 6 ? await client.query<{ last_woodcut_completed_at: Date | string | null }>(
        `SELECT last_woodcut_completed_at FROM player_mastery_state WHERE player_id = $1`, [player.playerId]
      ) : null;
      const rhythm = Boolean(lastWoodcut?.rows[0]?.last_woodcut_completed_at &&
        startedWithin(lastWoodcut.rows[0].last_woodcut_completed_at, now, 15_000));
      const { speedBonus, rhythmBonus, instantChance, bonusYieldChance } =
        woodcutterMasteryModifiers(woodRank, rhythm);
      // Deepstone / Grove Lore: server-rolled extra unit and rare find, fixed for the session.
      const skillRoll = this.dungeonSkills
        ? await this.dungeonSkills.rollHarvestBonus(player.playerId, node.type)
        : NO_HARVEST_SKILL_ROLL;
      const gloveFits = (utilityGlove === "lumber_glove" && node.type === "wood" && action === "primary") ||
        (utilityGlove === "delver_glove" && DEEPSTONE_MINED_RESOURCES.has(node.type));
      // The 1-second action needs the glove worn with a use left in the database, not just in memory.
      const gloveReady = gloveFits && await wornUtilityGearReady(client, player.playerId, utilityGlove);
      const gloveChops = gloveReady && utilityGlove === "lumber_glove";
      const gloveMines = gloveReady && utilityGlove === "delver_glove";
      const masteryResults = {
        ...(gloveChops || gloveMines ? { utilityGlove } : {}),
        instant: instantChance > 0 && this.random() < instantChance,
        bonusYield: bonusYieldChance > 0 && this.random() < bonusYieldChance,
        rhythm,
        skillBonus: skillRoll.extraUnit,
        rareFindItemId: skillRoll.rareItemId,
        actionDurationMultiplier: Math.max(
          0.9,
          Math.min(
            1,
            Number.isFinite(actionDurationMultiplier)
              ? actionDurationMultiplier
              : 1
          )
        )
      };
      const ringDurationMultiplier = node.type === "wood" && action === "primary"
        ? Math.max(
            0.8,
            Math.min(
              1,
              Number.isFinite(choppingDurationMultiplier)
                ? choppingDurationMultiplier
                : 1
            )
          )
        : 1;
      const benefit = this.districtBenefits
        ? await this.districtBenefits.resolveForPlayer(client, player.playerId)
        : null;
      const cityBonusChance = node.type === "wood" ||
          (node.type === "balsam_resin" || node.type === "giving_berry")
        ? benefit?.forestryExtraYieldChance ?? 0
        : 0;
      const cityBonusSucceeded =
        cityBonusChance > 0 && this.random() < cityBonusChance;
      const startedAt = now;
      const completesAt = new Date(
        startedAt.getTime() + (
          masteryResults.instant
            ? INSTANT_HARVEST_DURATION_MS
            : gloveChops || gloveMines
            ? UTILITY_GEAR_ACTION_DURATION_MS
            : applyRingSecondsToDuration(Math.ceil(
                (node.type === "wood"
                  ? treeHarvestDurationMsForStableId(node.id)
                  : collectibleHarvestDurationMs(node.type))
                * (1 - speedBonus - rhythmBonus)
                * masteryResults.actionDurationMultiplier
                * ringDurationMultiplier
              ), node.type === "wood" && action === "primary"
                ? choppingRingSeconds
                : DEEPSTONE_MINED_RESOURCES.has(node.type) ? miningRingSeconds : 0)
        )
      );
      const expiresAt = new Date(completesAt.getTime() + HARVEST_SESSION_EXPIRY_GRACE_MS);
      const inserted = await client.query<HarvestSessionRow>(
        `
        INSERT INTO harvest_sessions (
          id, player_id, node_id, resource_type, operation_key, status,
          started_at, completes_at, expires_at, mastery_results
          ,city_id,city_district_type,city_district_revision,
          city_monument_tier,city_bonus_chance,city_bonus_succeeded
        )
        VALUES (
          $1,$2,$3,$4,$5,'active',$6,$7,$8,$9::jsonb,
          $10,$11,$12,$13,$14,$15
        )
        RETURNING id, player_id, node_id, resource_type, operation_key, status,
                  started_at, completes_at, expires_at, completed_at, cancelled_at,
                  mastery_results,city_id,city_district_type,
                  city_district_revision::text,city_monument_tier,
                  city_bonus_chance,city_bonus_succeeded
        `,
        [
          crypto.randomUUID(),
          player.playerId,
          node.id,
          node.type,
          node.harvestOperationKey,
          startedAt,
          completesAt,
          expiresAt,
          JSON.stringify(masteryResults),
          cityBonusChance > 0 ? benefit!.cityId : null,
          cityBonusChance > 0 ? "forestry" : null,
          cityBonusChance > 0 ? benefit!.districtRevision : null,
          cityBonusChance > 0 ? benefit!.monumentTiers.forestry : null,
          cityBonusChance,
          cityBonusSucceeded
        ]
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error("Harvest session insert did not return a row");
      }
      await client.query("COMMIT");
      return {
        session: rowToSession(row),
        nodePosition: { lat: node.lat, lon: node.lon },
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new HarvestSessionError(
          "HARVEST_ALREADY_ACTIVE",
          "Player or collectible already has an active harvest"
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async completeHarvest(
    player: CollectiblePlayer,
    sessionId: string,
    resourceVision: ResourceVision | null
  ): Promise<CompleteHarvestResult> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const row = await lockSession(client, sessionId);
      assertSessionOwner(row, player.playerId);

      if (row.status === "completed") {
        const populationTreeTransition = row.resource_type === "wood"
          ? await this.collectibles.findHarvestedPopulationTreeTransitionInTransaction(
              client,
              row.node_id
            )
          : null;
        const inventory = await this.collectibles.inventoryForPlayerInTransaction(
          client,
          player.playerId
        );
        const xpGrant = await this.grantHarvestXp(client, row);
        const masteryGrant = await this.grantHarvestMastery(client, row);
        await client.query("COMMIT");
        committed = true;
        return {
          session: rowToSession(row),
          nodeId: row.node_id,
          nodePosition: populationTreeTransition?.position ?? null,
          inventory,
          xpGrant,
          masteryGrant,
          reward: {
            itemId: row.resource_type as ResourceType,
            // Replayed completions never emit a gain popup; preserve the authoritative
            // node yield for the response's otherwise-unused reward description.
            quantity: (
              row.resource_type === "wood"
                ? treeWoodYieldForStableId(row.node_id)
                : row.resource_type === "flax_fiber" ? FLAX_FIBER_HARVEST_YIELD_QUANTITY : 1
            ) +
              (row.resource_type === "wood" && row.mastery_results?.bonusYield ? 1 : 0) +
              (row.city_bonus_succeeded ? 1 : 0) +
              (row.mastery_results?.skillBonus ? 1 : 0)
          },
          professionResults: { bonusYield: Boolean(row.mastery_results?.bonusYield), instant: Boolean(row.mastery_results?.instant) },
          node: null,
          nodeRemoved: !(row.resource_type === "balsam_resin" || row.resource_type === "giving_berry"),
          populationTreeTransition,
          droppedItems: [],
          replayed: true
        };
      }
      if (row.status === "cancelled") {
        throw new HarvestSessionError("HARVEST_CANCELLED", "Harvest session was cancelled");
      }
      if (row.status === "expired") {
        throw new HarvestSessionError("HARVEST_EXPIRED", "Harvest session expired");
      }

      const now = this.now();
      if (now.getTime() < dateMs(row.completes_at)) {
        throw new HarvestSessionError(
          "HARVEST_TOO_EARLY",
          "Harvest is not complete yet",
          dateMs(row.completes_at) - now.getTime()
        );
      }
      if (now.getTime() >= dateMs(row.expires_at)) {
        const expired = await updateSessionStatus(client, row.id, "expired", now);
        await client.query("COMMIT");
        committed = true;
        throw new HarvestSessionError(
          "HARVEST_EXPIRED",
          `Harvest session expired at ${rowToSession(expired).expiresAt}`
        );
      }

      await client.query("SAVEPOINT harvest_completion");
      try {
        const collected = (row.resource_type === "balsam_resin" || row.resource_type === "giving_berry")
          ? await this.collectibles.completeResinHarvestInTransaction(
              client,
              player,
              row.node_id,
              resourceVision,
              row.operation_key,
              row.city_bonus_succeeded ? 1 : 0
            )
          : await this.collectibles.completeHarvestInTransaction(
              client,
              player,
              row.node_id,
              resourceVision,
              (row.resource_type === "wood" && row.mastery_results?.bonusYield ? 1 : 0) +
                (row.city_bonus_succeeded ? 1 : 0) +
                (row.mastery_results?.skillBonus ? 1 : 0),
              row.operation_key
            );
        if (row.resource_type === "flax_fiber" && this.creatureBook) {
          const plantHarvest: CreatureBookPlantHarvestInput = {
            playerId: row.player_id,
            plantKey: "flax",
            sourceId: row.operation_key
          };
          await this.creatureBook.recordPlantHarvestInTransaction(client, plantHarvest);
        }
        let ringFindEquipment: EquipmentSnapshotV2 | null = null;
        if (row.mastery_results?.rareFindItemId === DEEPSTONE_RING_FIND_ID) {
          // A ring that does not fit lands on the ground at the harvested node.
          if (this.ringEquipment) {
            ringFindEquipment = (await grantRingFindInTransaction(client, this.ringEquipment, {
              operationKey: `rare-find-ring:${row.operation_key}`,
              playerId: player.playerId,
              tier: rollMiningPoolRingTier(row.operation_key),
              source: "deepstone_rare_find",
              ground: overworldRingGroundPlacement(
                { lat: collected.node.lat, lon: collected.node.lon },
                `harvest:${row.operation_key}`
              )
            })).equipment;
          }
        } else if (row.mastery_results?.rareFindItemId) {
          await this.collectibles.grantRareFindInTransaction(client, player.playerId, row.mastery_results.rareFindItemId, row.operation_key);
        }
        const brickInventory = await this.collectibles.grantKingdomBricksInTransaction?.(
          client,
          player.playerId,
          { lat: collected.node.lat, lon: collected.node.lon },
          row.operation_key
        ) ?? null;
        const xpGrant = await this.grantHarvestXp(client, row);
        const masteryGrant = await this.grantHarvestMastery(client, row);
        if (row.resource_type === "wood") {
          await client.query(`UPDATE player_mastery_state SET last_woodcut_completed_at = $2 WHERE player_id = $1`, [player.playerId, now]);
        }
        // A utility glove spends one use per completed action, in the same transaction.
        const gloveId = row.mastery_results?.utilityGlove;
        const gloveSpent = gloveId && isUtilityGearDefinitionId(gloveId)
          ? await spendUtilityGearUseInTransaction(client, player.playerId, gloveId)
          : null;
        if (gloveId && !gloveSpent) {
          // The glove went away during a 1-second action: nothing is granted and the session ends.
          await client.query("ROLLBACK TO SAVEPOINT harvest_completion");
          await updateSessionStatus(client, row.id, "cancelled", now);
          await client.query("COMMIT");
          committed = true;
          throw new HarvestSessionError("HARVEST_CANCELLED", UTILITY_GEAR_GONE_MESSAGE);
        }
        const completed = await updateSessionStatus(client, row.id, "completed", now);
        await client.query("COMMIT");
        committed = true;
        if (gloveSpent) await this.afterGloveUse(player.playerId, gloveSpent);
        if (ringFindEquipment) {
          this.ringEquipment?.installAuthoritativeSnapshot(player.playerId, ringFindEquipment);
          this.onRingFound(player.playerId, ringFindEquipment);
        }
        return {
          session: rowToSession(completed),
          nodeId: collected.node.id,
          nodePosition: { lat: collected.node.lat, lon: collected.node.lon },
          inventory: brickInventory ?? collected.inventory,
          xpGrant,
          masteryGrant,
          reward: {
            itemId: row.resource_type as ResourceType,
            quantity: collected.rewardQuantity ?? collected.node.quantity
          },
          professionResults: { bonusYield: Boolean(row.mastery_results?.bonusYield), instant: Boolean(row.mastery_results?.instant) },
          node: collected.node,
          nodeRemoved: !(row.resource_type === "balsam_resin" || row.resource_type === "giving_berry"),
          populationTreeTransition:
            "populationTreeTransition" in collected
              ? collected.populationTreeTransition
              : null,
          droppedItems: collected.droppedItems,
          replayed: false
        };
      } catch (error) {
        if (isAuthoritativeHarvestRemoval(error)) {
          await client.query("ROLLBACK TO SAVEPOINT harvest_completion");
          await updateSessionStatus(client, row.id, "cancelled", now);
          await client.query("COMMIT");
          committed = true;
        }
        throw error;
      }
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async afterGloveUse(playerId: string, _spent: UtilityGearSpend): Promise<void> {
    try {
      await this.utilityGear?.afterUse(playerId);
    } catch {
      // The use is committed; the next equipment snapshot shows it.
    }
  }

  private async grantHarvestXp(
    queryable: Pick<pg.Pool, "query">,
    row: HarvestSessionRow
  ): Promise<XpGrantResult | null> {
    if (!this.progression || row.mastery_results?.utilityGlove === "delver_glove") return null;
    const requestedXp = HARVEST_XP_BY_RESOURCE[row.resource_type as ResourceType] ?? 0;
    if (requestedXp === 0) return null;
    return this.progression.grantXpInTransaction(queryable, {
      operationKey: `harvest-xp:${row.operation_key}`,
      playerId: row.player_id,
      sourceType: "harvest",
      sourceId: row.id,
      requestedXp,
      metadata: {
        resourceType: row.resource_type,
        harvestSessionId: row.id,
        balanceVersion: 1
      }
    });
  }

  private async grantHarvestMastery(queryable: Pick<pg.Pool, "query">, row: HarvestSessionRow): Promise<MasteryGrantResult | null> {
    // The Delver Glove trades XP for speed: the resources are still given.
    if (row.mastery_results?.utilityGlove === "delver_glove") return null;
    if (!this.masteries || row.resource_type !== "wood") return null;
    return this.masteries.grantProfessionXpInTransaction(queryable, {
      operationKey: `profession-xp:${row.operation_key}:woodcutter`,
      playerId: row.player_id,
      sourceId: row.id,
      activity: { kind: "wood-harvest" },
      randomResults: row.mastery_results ?? {}
    });
  }

  async cancelHarvest(
    playerId: string,
    sessionId: string
  ): Promise<CancelHarvestResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await lockSession(client, sessionId);
      assertSessionOwner(row, playerId);
      if (row.status === "completed") {
        await client.query("COMMIT");
        return null;
      }
      if (row.status === "cancelled" || row.status === "expired") {
        await client.query("COMMIT");
        return { session: rowToSession(row), replayed: true };
      }
      const cancelled = await updateSessionStatus(client, row.id, "cancelled", this.now());
      await client.query("COMMIT");
      return { session: rowToSession(cancelled), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activeSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await expireStaleSessions(client, this.now(), playerId, null);
      const result = await client.query<HarvestSessionRow>(
        `
        SELECT id, player_id, node_id, resource_type, operation_key, status,
               started_at, completes_at, expires_at, completed_at, cancelled_at,
               mastery_results,city_id,city_district_type,
               city_district_revision::text,city_monument_tier,
               city_bonus_chance,city_bonus_succeeded
        FROM harvest_sessions
        WHERE player_id = $1
          AND status = 'active'
        ORDER BY started_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [playerId]
      );
      await client.query("COMMIT");
      return result.rows[0] ? rowToSession(result.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelActiveForPlayer(playerId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE harvest_sessions
       SET status = 'cancelled', cancelled_at = $2
       WHERE player_id = $1 AND status = 'active'`,
      [playerId, this.now()]
    );
    return result.rowCount ?? 0;
  }

  async expireStaleActiveSessions(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE harvest_sessions
       SET status = 'expired'
       WHERE status = 'active' AND expires_at <= $1`,
      [this.now()]
    );
    return result.rowCount ?? 0;
  }
}

async function expireStaleSessions(
  queryable: CollectibleTransaction,
  now: Date,
  playerId: string,
  nodeId: string | null
): Promise<void> {
  await queryable.query(
    `
    UPDATE harvest_sessions
    SET status = 'expired'
    WHERE status = 'active'
      AND expires_at <= $1
      AND (player_id = $2 OR ($3::text IS NOT NULL AND node_id = $3))
    `,
    [now, playerId, nodeId]
  );
}

async function findActiveSession(
  queryable: CollectibleTransaction,
  playerId: string,
  nodeId: string
): Promise<HarvestSessionRow | null> {
  const result = await queryable.query<HarvestSessionRow>(
    `
    SELECT id, player_id, node_id, resource_type, operation_key, status,
           started_at, completes_at, expires_at, completed_at, cancelled_at,
           mastery_results,city_id,city_district_type,
           city_district_revision::text,city_monument_tier,
           city_bonus_chance,city_bonus_succeeded
    FROM harvest_sessions
    WHERE status = 'active'
      AND (player_id = $1 OR node_id = $2)
    ORDER BY started_at ASC
    LIMIT 1
    FOR UPDATE
    `,
    [playerId, nodeId]
  );
  return result.rows[0] ?? null;
}

async function lockSession(
  queryable: CollectibleTransaction,
  sessionId: string
): Promise<HarvestSessionRow> {
  const result = await queryable.query<HarvestSessionRow>(
    `
    SELECT id, player_id, node_id, resource_type, operation_key, status,
           started_at, completes_at, expires_at, completed_at, cancelled_at,
           mastery_results,city_id,city_district_type,
           city_district_revision::text,city_monument_tier,
           city_bonus_chance,city_bonus_succeeded
    FROM harvest_sessions
    WHERE id = $1
    FOR UPDATE
    `,
    [sessionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HarvestSessionError("HARVEST_NOT_FOUND", "Harvest session does not exist");
  }
  return row;
}

async function updateSessionStatus(
  queryable: CollectibleTransaction,
  sessionId: string,
  status: "completed" | "cancelled" | "expired",
  at: Date
): Promise<HarvestSessionRow> {
  const result = await queryable.query<HarvestSessionRow>(
    `
    UPDATE harvest_sessions
    SET status = $2,
        completed_at = CASE WHEN $2 = 'completed' THEN $3 ELSE completed_at END,
        cancelled_at = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancelled_at END
    WHERE id = $1
    RETURNING id, player_id, node_id, resource_type, operation_key, status,
              started_at, completes_at, expires_at, completed_at, cancelled_at,
              mastery_results,city_id,city_district_type,
              city_district_revision::text,city_monument_tier,
              city_bonus_chance,city_bonus_succeeded
    `,
    [sessionId, status, at]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HarvestSessionError("HARVEST_NOT_FOUND", "Harvest session does not exist");
  }
  return row;
}

function assertSessionOwner(row: HarvestSessionRow, playerId: string): void {
  if (row.player_id !== playerId) {
    throw new HarvestSessionError(
      "HARVEST_NOT_OWNED",
      "Harvest session belongs to another player"
    );
  }
}

function rowToSession(row: HarvestSessionRow): HarvestSessionSnapshot {
  return {
    sessionId: row.id,
    playerId: row.player_id,
    nodeId: row.node_id,
    resourceType: row.resource_type as ResourceType,
    operationKey: row.operation_key,
    status: row.status,
    startedAt: dateIso(row.started_at),
    completesAt: dateIso(row.completes_at),
    expiresAt: dateIso(row.expires_at),
    completedAt: row.completed_at === null ? null : dateIso(row.completed_at),
    cancelledAt: row.cancelled_at === null ? null : dateIso(row.cancelled_at)
  };
}

function dateIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function startedWithin(value: Date | string, now: Date, windowMs: number): boolean {
  const elapsed = now.getTime() - dateMs(value);
  return elapsed >= 0 && elapsed <= windowMs;
}

function serverRoll(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function isAuthoritativeHarvestRemoval(
  error: unknown
): error is CollectibleHarvestError {
  return error instanceof CollectibleHarvestError
    && error.details.reconciliation === "remove-node";
}
