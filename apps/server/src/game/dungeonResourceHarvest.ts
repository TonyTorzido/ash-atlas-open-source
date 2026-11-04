import { NO_HARVEST_SKILL_ROLL, type HarvestSkillRoll } from "./dungeonSkills.js";
import { grantRingFindInTransaction, type RingFindEquipment } from "./ringFinds.js";
import { UTILITY_GEAR_GONE_MESSAGE, spendUtilityGearUseInTransaction, wornUtilityGearReady } from "./utilityGear.js";
import { UTILITY_GEAR_ACTION_DURATION_MS, isUtilityGearDefinitionId, type UtilityGearDefinitionId } from "@ash-atlas/shared";
import {
  dungeonResourceIdFromNodeId,
  applyRingSecondsToDuration,
  DEEPSTONE_RING_FIND_ID,
  rollMiningPoolRingTier,
  type EquipmentSnapshotV2,
  treeHarvestDurationMsForStableId,
  type DungeonSnapshot,
  type HarvestSessionSnapshot,
  type HarvestSessionStatus,
  type LatLon,
  type MasteryGrantResult,
  type PlayerInventorySnapshot,
  type DungeonResourceType,
  type ResourceType,
  type DroppedItemSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { CityDistrictBenefitService } from "./cityDistrictBenefits.js";
import { settlePhysicalItemRewardInTransaction } from "./droppedItems.js";
import {
  DungeonError,
  type DungeonResourceHarvestTarget,
  type DungeonRuntime
} from "./dungeon.js";
import { dungeonResourceRule } from "./dungeonResourceRules.js";
import { HarvestSessionError, HARVEST_SESSION_EXPIRY_GRACE_MS, woodcutterMasteryModifiers } from "./harvestSessions.js";
import { isInventoryCapacityError, type InventoryService } from "./inventory.js";
import { collectibleHarvestDurationMs } from "./items.js";
import type { MasteryService } from "./masteries.js";
import {
  effectiveMiningDurationMs,
  minerMasteryChances,
  MINING_SESSION_EXPIRY_GRACE_MS,
  RepeatableResourceError
} from "./repeatableResources.js";

const INSTANT_HARVEST_DURATION_MS = 1;
const RETAINED_SESSION_MS = 10 * 60_000;
const WOODCUT_RHYTHM_WINDOW_MS = 15_000;

type DungeonHarvestKind = ReturnType<typeof dungeonResourceRule>["kind"];

type MasteryResults = {
  instant: boolean;
  bonusYield: boolean;
  unbrokenVein: boolean;
  rhythm: boolean;
  utilityGlove?: UtilityGearDefinitionId;
};

type DungeonHarvestSession = {
  sessionId: string;
  playerId: string;
  nodeId: string;
  resourceId: string;
  resourceType: DungeonResourceType;
  kind: DungeonHarvestKind;
  instanceId: string;
  runId: string;
  lifeRevision: number;
  operationKey: string;
  status: HarvestSessionStatus;
  startedAt: number;
  completesAt: number;
  expiresAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  masteryResults: MasteryResults;
  cityBonusSucceeded: boolean;
  /** Deepstone / Grove Lore extra unit and rare find, rolled when the session starts. */
  skillBonus: boolean;
  rareFindItemId: string | null;
  completion: DungeonHarvestCompletionCore | null;
  /** The settlement currently running for this session; a concurrent complete waits for it. */
  inflight?: Promise<DungeonHarvestCompletion> | null;
};

type DungeonHarvestCompletionCore = Readonly<{
  rewardQuantity: number;
  position: LatLon;
}>;

export type DungeonHarvestCompletion = Readonly<{
  session: HarvestSessionSnapshot;
  nodeId: string;
  resourceType: DungeonResourceType;
  inventory: PlayerInventorySnapshot;
  rewardQuantity: number;
  professionResults: Readonly<{ bonusYield: boolean; instant: boolean; unbrokenVein: boolean }>;
  masteryGrant: MasteryGrantResult | null;
  droppedItems: DroppedItemSnapshot[];
  position: LatLon;
  /** The updated room snapshot; null when a replay finds the player already left. */
  snapshot: DungeonSnapshot | null;
  replayed: boolean;
}>;

export type DungeonHarvestStartOptions = Readonly<{
  actionDurationMultiplier?: number;
  miningDurationMultiplier?: number;
  choppingDurationMultiplier?: number;
  /** Fleet chopper / Fleet miner rings: negative seconds. */
  choppingRingSeconds?: number;
  miningRingSeconds?: number;
  /** Utility glove worn when the action started. */
  utilityGlove?: UtilityGearDefinitionId | null;
}>;

export type DungeonResourceHarvestDependencies = Readonly<{
  pool: pg.Pool;
  dungeon: Pick<
    DungeonRuntime,
    "resourceHarvestTarget" | "settleResourceHarvest" | "get"
  >;
  inventory: InventoryService;
  masteries?: MasteryService;
  districtBenefits?: CityDistrictBenefitService;
  now?: () => number;
  random?: () => number;
  dungeonSkills?: Readonly<{ rollHarvestBonus(playerId: string, resourceType: string): Promise<HarvestSkillRoll> }>;
  /** Deepstone Lore rare finds can be a ring (an equipment instance). */
  ringEquipment?: RingFindEquipment;
  onRingFound?: (playerId: string, equipment: EquipmentSnapshotV2) => void;
  /** Called after a utility glove spent a use, to refresh the runtime and the client. */
  onUtilityUse?: (playerId: string) => Promise<void>;
}>;

/**
 * Overworld gathering for dungeon resource nodes. Sessions, gather duration,
 * yield, mastery and city bonuses, overflow-to-ground and the harvest frames all
 * follow the overworld mine/tree/plant rules; only the node's home differs: it
 * lives in one dungeon instance and run and is gone when that run ends.
 */
export class DungeonResourceHarvestService {
  private readonly sessions = new Map<string, DungeonHarvestSession>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly deps: DungeonResourceHarvestDependencies) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async start(
    playerId: string,
    nodeId: string,
    options: DungeonHarvestStartOptions = {}
  ): Promise<{ session: HarvestSessionSnapshot; replayed: boolean }> {
    const resourceId = dungeonResourceIdFromNodeId(nodeId);
    if (!resourceId) throw new RepeatableResourceError("HARVEST_NODE_NOT_FOUND", "Resource not found.");
    const nowMs = this.now();
    this.expire(nowMs);
    for (const active of this.sessions.values()) {
      if (active.status !== "active") continue;
      if (active.playerId === playerId && active.nodeId === nodeId) {
        return { session: sessionSnapshot(active), replayed: true };
      }
      throw new RepeatableResourceError(
        "HARVEST_ALREADY_ACTIVE",
        active.playerId === playerId
          ? "Player already has an active gathering action"
          : "This resource is already being gathered"
      );
    }
    const target = this.target(playerId, resourceId);
    const rule = dungeonResourceRule(target.resourceType, target.resourceId);
    const rolls = await this.rollMastery(playerId, rule.kind, nodeId, nowMs, options);
    const sessionId = crypto.randomUUID();
    const durationMs = rolls.durationMs;
    const session: DungeonHarvestSession = {
      sessionId,
      playerId,
      nodeId,
      resourceId,
      resourceType: target.resourceType,
      kind: rule.kind,
      instanceId: target.instanceId,
      runId: target.runId,
      lifeRevision: target.lifeRevision,
      operationKey: `dungeon-harvest:${target.runId}:${sessionId}`,
      status: "active",
      startedAt: nowMs,
      completesAt: nowMs + durationMs,
      expiresAt: nowMs + durationMs + (rule.kind === "mine"
        ? MINING_SESSION_EXPIRY_GRACE_MS
        : HARVEST_SESSION_EXPIRY_GRACE_MS),
      completedAt: null,
      cancelledAt: null,
      masteryResults: rolls.masteryResults,
      cityBonusSucceeded: rolls.cityBonusSucceeded,
      ...(await (async () => {
        const roll = this.deps.dungeonSkills
          ? await this.deps.dungeonSkills.rollHarvestBonus(playerId, target.resourceType)
          : NO_HARVEST_SKILL_ROLL;
        return { skillBonus: roll.extraUnit, rareFindItemId: roll.rareItemId };
      })()),
      completion: null
    };
    this.sessions.set(sessionId, session);
    return { session: sessionSnapshot(session), replayed: false };
  }

  activeSessionForPlayer(playerId: string): HarvestSessionSnapshot | null {
    this.expire(this.now());
    for (const session of this.sessions.values()) {
      if (session.playerId === playerId && session.status === "active") return sessionSnapshot(session);
    }
    return null;
  }

  cancel(playerId: string, sessionId: string): { session: HarvestSessionSnapshot; replayed: boolean } {
    const session = this.ownedSession(playerId, sessionId);
    if (session.status === "completed") {
      throw new HarvestSessionError("HARVEST_ALREADY_COMPLETED", "Harvest session already completed");
    }
    if (session.status === "cancelled") return { session: sessionSnapshot(session), replayed: true };
    session.status = "cancelled";
    session.cancelledAt = this.now();
    return { session: sessionSnapshot(session), replayed: false };
  }

  cancelActiveForPlayer(playerId: string): void {
    for (const session of this.sessions.values()) {
      if (session.playerId !== playerId || session.status !== "active") continue;
      session.status = "cancelled";
      session.cancelledAt = this.now();
    }
  }

  async complete(playerId: string, sessionId: string): Promise<DungeonHarvestCompletion> {
    const session = this.ownedSession(playerId, sessionId);
    if (session.inflight) {
      // A concurrent complete of the same session waits for the first, then re-reads its outcome.
      try { await session.inflight; } catch { /* the outcome is read from the session below */ }
      return this.complete(playerId, sessionId);
    }
    const run = this.finish(playerId, session);
    session.inflight = run;
    try {
      return await run;
    } finally {
      session.inflight = null;
    }
  }

  private async finish(playerId: string, session: DungeonHarvestSession): Promise<DungeonHarvestCompletion> {
    if (session.status === "completed") return this.replay(session);
    if (session.status === "cancelled") {
      throw new RepeatableResourceError("HARVEST_CANCELLED", "Gathering was cancelled");
    }
    if (session.status === "expired") {
      throw new RepeatableResourceError("HARVEST_EXPIRED", "Gathering session expired");
    }
    const nowMs = this.now();
    if (nowMs < session.completesAt) {
      throw new RepeatableResourceError(
        "HARVEST_TOO_EARLY",
        "Gathering is not complete yet",
        session.completesAt - nowMs
      );
    }
    if (nowMs >= session.expiresAt) {
      session.status = "expired";
      throw new RepeatableResourceError("HARVEST_EXPIRED", "Gathering session expired");
    }
    try {
      const { result, snapshot } = await this.deps.dungeon.settleResourceHarvest({
        playerId,
        resourceId: session.resourceId,
        lifeRevision: session.lifeRevision,
        keepReady: session.masteryResults.unbrokenVein,
        settle: (target) => this.settle(session, target)
      });
      session.status = "completed";
      session.completedAt = this.now();
      session.completion = { rewardQuantity: result.rewardQuantity, position: result.position };
      return {
        session: sessionSnapshot(session),
        nodeId: session.nodeId,
        resourceType: session.resourceType,
        inventory: result.inventory,
        rewardQuantity: result.rewardQuantity,
        professionResults: professionResults(session),
        masteryGrant: result.masteryGrant,
        droppedItems: result.droppedItems,
        position: result.position,
        snapshot,
        replayed: false
      };
    } catch (error) {
      if (isInventoryCapacityError(error)) {
        throw new RepeatableResourceError(
          "HARVEST_INVENTORY_FULL",
          "Carrying capacity is full. Reduce carried weight and gather again.",
          undefined,
          { nodeId: session.nodeId, reconciliation: "refresh-node" }
        );
      }
      if (error instanceof DungeonError) {
        const mapped = mapDungeonError(error, session.nodeId);
        if (mapped.terminal) {
          session.status = "cancelled";
          session.cancelledAt = this.now();
        }
        throw mapped.error;
      }
      throw error;
    }
  }

  private async replay(session: DungeonHarvestSession): Promise<DungeonHarvestCompletion> {
    const completion = session.completion;
    if (!completion) throw new Error("Completed dungeon harvest has no stored result");
    const inventory = await this.deps.inventory.getInventorySnapshot(session.playerId);
    return {
      session: sessionSnapshot(session),
      nodeId: session.nodeId,
      resourceType: session.resourceType,
      inventory,
      rewardQuantity: completion.rewardQuantity,
      professionResults: professionResults(session),
      masteryGrant: null,
      droppedItems: [],
      position: completion.position,
      snapshot: this.deps.dungeon.get(session.playerId),
      replayed: true
    };
  }

  /** One transaction: reward (inventory, overflow to ground) plus profession mastery, idempotent on the session key. */
  private async settle(
    session: DungeonHarvestSession,
    target: DungeonResourceHarvestTarget
  ): Promise<{
    rewardQuantity: number;
    position: LatLon;
    inventory: PlayerInventorySnapshot;
    masteryGrant: MasteryGrantResult | null;
    droppedItems: DroppedItemSnapshot[];
  }> {
    const rule = dungeonResourceRule(target.resourceType, target.resourceId);
    const rewardQuantity = rule.yieldQuantity +
      (session.masteryResults.bonusYield ? 1 : 0) +
      (session.cityBonusSucceeded ? 1 : 0) +
      (session.skillBonus ? 1 : 0);
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const settlement = await settlePhysicalItemRewardInTransaction(client, this.deps.inventory, {
        delivery: "inventory_then_ground",
        lines: [
          { itemId: target.resourceType, variant: null, quantity: rewardQuantity },
          ...(session.rareFindItemId && session.rareFindItemId !== DEEPSTONE_RING_FIND_ID
            ? [{ itemId: session.rareFindItemId as ResourceType, variant: null, quantity: 1 }]
            : [])
        ],
        inventoryOperation: {
          operationKey: session.operationKey,
          playerId: session.playerId,
          source: "dungeon_resource_harvest",
          sourceEntityType: "dungeon_resource",
          sourceEntityId: target.resourceId,
          metadata: {
            dungeonId: target.dungeonId,
            instanceId: target.instanceId,
            runId: target.runId,
            kind: session.kind
          }
        },
        groundDrop: {
          operationKey: `harvest-overflow:${session.operationKey}`,
          droppedByPlayerId: session.playerId,
          regionCode: `interior:${target.instanceId}`,
          zoneId: `interior:${target.instanceId}:${target.spaceId}`,
          pileId: `harvest:${session.operationKey}`,
          sourceEntityType: "dungeon_resource",
          sourceEntityId: target.resourceId,
          position: target.position,
          reason: "harvest_inventory_overflow"
        }
      });
      let ringFindEquipment: EquipmentSnapshotV2 | null = null;
      if (session.rareFindItemId === DEEPSTONE_RING_FIND_ID && this.deps.ringEquipment) {
        ringFindEquipment = (await grantRingFindInTransaction(client, this.deps.ringEquipment, {
          operationKey: `rare-find-ring:${session.operationKey}`,
          playerId: session.playerId,
          tier: rollMiningPoolRingTier(session.operationKey),
          source: "deepstone_rare_find",
          ground: {
            regionCode: `interior:${target.instanceId}`,
            zoneId: `interior:${target.instanceId}:${target.spaceId}`,
            pileId: `harvest:${session.operationKey}`,
            pileOrder: 1_000,
            position: target.position,
            createdAt: new Date(this.now())
          }
        })).equipment;
      }
      const masteryActivity = session.kind === "mine"
        ? { kind: "stone-mine" as const }
        : session.kind === "tree" ? { kind: "wood-harvest" as const } : null;
      const masteryGrant = masteryActivity && this.deps.masteries && session.masteryResults.utilityGlove !== "delver_glove"
        ? await this.deps.masteries.grantProfessionXpInTransaction(client, {
            operationKey: `profession-xp:${session.operationKey}:${session.kind === "mine" ? "miner" : "woodcutter"}`,
            playerId: session.playerId,
            sourceId: session.sessionId,
            activity: masteryActivity,
            randomResults: session.masteryResults
          })
        : null;
      if (session.kind === "tree") {
        await client.query(
          `UPDATE player_mastery_state SET last_woodcut_completed_at = $2 WHERE player_id = $1`,
          [session.playerId, new Date(this.now())]
        );
      }
      // A utility glove spends one use per completed action, in the same transaction.
      const gloveId = session.masteryResults.utilityGlove;
      const gloveSpent = gloveId && isUtilityGearDefinitionId(gloveId)
        ? await spendUtilityGearUseInTransaction(client, session.playerId, gloveId)
        : null;
      if (gloveId && !gloveSpent) {
        // The glove went away during a 1-second action: nothing is granted and the session ends.
        session.status = "cancelled";
        session.cancelledAt = this.now();
        throw new RepeatableResourceError("HARVEST_CANCELLED", UTILITY_GEAR_GONE_MESSAGE);
      }
      await client.query("COMMIT");
      if (gloveSpent) await this.deps.onUtilityUse?.(session.playerId).catch(() => undefined);
      if (ringFindEquipment) {
        this.deps.ringEquipment?.installAuthoritativeSnapshot(session.playerId, ringFindEquipment);
        this.deps.onRingFound?.(session.playerId, ringFindEquipment);
      }
      return {
        rewardQuantity,
        position: target.position,
        inventory: settlement.inventory,
        masteryGrant,
        droppedItems: settlement.droppedItems
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection already closed */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollMastery(
    playerId: string,
    kind: DungeonHarvestKind,
    nodeId: string,
    nowMs: number,
    options: DungeonHarvestStartOptions
  ): Promise<{ durationMs: number; masteryResults: MasteryResults; cityBonusSucceeded: boolean }> {
    const { pool, masteries, districtBenefits } = this.deps;
    const actionMultiplier = clampMultiplier(options.actionDurationMultiplier, 0.9);
    const benefit = districtBenefits && (kind === "mine" || kind === "tree" || kind === "resin")
      ? await districtBenefits.resolveForPlayer(pool, playerId)
      : null;
    const cityBonusChance = kind === "mine"
      ? benefit?.miningExtraYieldChance ?? 0
      : benefit?.forestryExtraYieldChance ?? 0;
    const cityBonusSucceeded = cityBonusChance > 0 && this.random() < cityBonusChance;
    if (kind === "mine") {
      const minerRank = masteries ? await masteries.professionRankInTransaction(pool, playerId, "miner") : 0;
      const chances = minerMasteryChances(minerRank);
      const masteryResults: MasteryResults = {
        instant: chances.instantChance > 0 && this.random() < chances.instantChance,
        bonusYield: chances.bonusYieldChance > 0 && this.random() < chances.bonusYieldChance,
        unbrokenVein: chances.unbrokenChance > 0 && this.random() < chances.unbrokenChance,
        rhythm: false,
        ...(options.utilityGlove === "delver_glove" && await wornUtilityGearReady(pool, playerId, options.utilityGlove)
          ? { utilityGlove: options.utilityGlove }
          : {})
      };
      const multiplier = actionMultiplier * clampMultiplier(options.miningDurationMultiplier, 0.8);
      return {
        durationMs: masteryResults.utilityGlove && !masteryResults.instant
        ? UTILITY_GEAR_ACTION_DURATION_MS
        : applyRingSecondsToDuration(
          Math.ceil(effectiveMiningDurationMs(minerRank, masteryResults.instant) * multiplier),
          masteryResults.instant ? 0 : options.miningRingSeconds ?? 0
        ),
        masteryResults,
        cityBonusSucceeded
      };
    }
    if (kind === "tree") {
      const woodRank = masteries ? await masteries.professionRankInTransaction(pool, playerId, "woodcutter") : 0;
      let rhythm = false;
      if (woodRank >= 6) {
        const last = await pool.query<{ last_woodcut_completed_at: Date | string | null }>(
          `SELECT last_woodcut_completed_at FROM player_mastery_state WHERE player_id = $1`,
          [playerId]
        );
        const lastAt = last.rows[0]?.last_woodcut_completed_at;
        rhythm = Boolean(lastAt) && nowMs - new Date(lastAt!).getTime() <= WOODCUT_RHYTHM_WINDOW_MS;
      }
      const modifiers = woodcutterMasteryModifiers(woodRank, rhythm);
      const masteryResults: MasteryResults = {
        instant: modifiers.instantChance > 0 && this.random() < modifiers.instantChance,
        bonusYield: modifiers.bonusYieldChance > 0 && this.random() < modifiers.bonusYieldChance,
        unbrokenVein: false,
        rhythm,
        ...(options.utilityGlove === "lumber_glove" && await wornUtilityGearReady(pool, playerId, options.utilityGlove)
          ? { utilityGlove: options.utilityGlove }
          : {})
      };
      return {
        durationMs: masteryResults.instant
          ? INSTANT_HARVEST_DURATION_MS
          : masteryResults.utilityGlove
          ? UTILITY_GEAR_ACTION_DURATION_MS
          : applyRingSecondsToDuration(Math.ceil(
              treeHarvestDurationMsForStableId(nodeId) *
              (1 - modifiers.speedBonus - modifiers.rhythmBonus) *
              actionMultiplier *
              clampMultiplier(options.choppingDurationMultiplier, 0.8)
            ), options.choppingRingSeconds ?? 0),
        masteryResults,
        cityBonusSucceeded
      };
    }
    return {
      durationMs: Math.ceil(
        collectibleHarvestDurationMs(kind === "resin" ? "balsam_resin" : "flax_fiber") * actionMultiplier
      ),
      masteryResults: { instant: false, bonusYield: false, unbrokenVein: false, rhythm: false },
      cityBonusSucceeded
    };
  }

  private target(playerId: string, resourceId: string): DungeonResourceHarvestTarget {
    try {
      return this.deps.dungeon.resourceHarvestTarget(playerId, resourceId);
    } catch (error) {
      if (error instanceof DungeonError) throw mapDungeonError(error, resourceId).error;
      throw error;
    }
  }

  private ownedSession(playerId: string, sessionId: string): DungeonHarvestSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HarvestSessionError("HARVEST_NOT_FOUND", "Harvest session not found");
    if (session.playerId !== playerId) {
      throw new HarvestSessionError("HARVEST_NOT_OWNED", "Harvest session belongs to another player");
    }
    return session;
  }

  private expire(nowMs: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.status === "active" && nowMs >= session.expiresAt) session.status = "expired";
      const settledAt = session.completedAt ?? session.cancelledAt ?? (session.status === "expired" ? session.expiresAt : null);
      if (settledAt !== null && nowMs - settledAt > RETAINED_SESSION_MS) this.sessions.delete(sessionId);
    }
  }
}

function clampMultiplier(value: number | undefined, floor: number): number {
  return Math.max(floor, Math.min(1, Number.isFinite(value) ? value! : 1));
}

function professionResults(session: DungeonHarvestSession) {
  return {
    bonusYield: session.masteryResults.bonusYield,
    instant: session.masteryResults.instant,
    unbrokenVein: session.masteryResults.unbrokenVein
  };
}

function sessionSnapshot(session: DungeonHarvestSession): HarvestSessionSnapshot {
  return {
    sessionId: session.sessionId,
    playerId: session.playerId,
    nodeId: session.nodeId,
    resourceType: session.resourceType,
    operationKey: session.operationKey,
    status: session.status,
    startedAt: new Date(session.startedAt).toISOString(),
    completesAt: new Date(session.completesAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    completedAt: session.completedAt === null ? null : new Date(session.completedAt).toISOString(),
    cancelledAt: session.cancelledAt === null ? null : new Date(session.cancelledAt).toISOString()
  };
}

function mapDungeonError(
  error: DungeonError,
  nodeId: string
): { error: RepeatableResourceError; terminal: boolean } {
  const details = { nodeId, reconciliation: "refresh-node" as const };
  switch (error.code) {
    case "OUT_OF_RANGE":
      return { error: new RepeatableResourceError("HARVEST_NODE_OUT_OF_RANGE", error.message, undefined, details), terminal: false };
    case "RESOURCE_DEPLETED":
      return { error: new RepeatableResourceError("HARVEST_NODE_DEPLETED", error.message, undefined, details), terminal: true };
    case "RESOURCE_CHANGED":
      return { error: new RepeatableResourceError("HARVEST_NODE_CHANGED", error.message, undefined, details), terminal: true };
    default:
      return { error: new RepeatableResourceError("HARVEST_NODE_NOT_FOUND", error.message, undefined, { nodeId, reconciliation: "remove-node" }), terminal: true };
  }
}
