import {
  isBeginnerProtectedLevel,
  CURRENT_LEVEL_CAP,
  ENCHANTMENT_STONE_VARIANTS,
  MAX_CURRENT_ERA_XP,
  POST_CAP_XP_PER_REWARD,
  PROGRESSION_CURVE_VERSION,
  PVP_MAX_HEALTH_PENALTY,
  addMaxHealthPenalty,
  maxHealthDebuffCap,
  levelForTotalXp,
  paidCharacterLevel,
  playerPveStats,
  totalXpForLevel,
  xpProgress,
  type ProgressionSnapshot,
  type PremiumWalletSnapshot,
  type ProgressionSourceType,
  type EnchantmentStoneVariant,
  type XpGrantResult
} from "@ash-atlas/shared";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { creditKingdomMemberXpInTransaction } from "./kingdomMemberXp.js";
import { PremiumWalletOperationError, type PremiumWalletService } from "./premiumWallet.js";

type Queryable = Pick<pg.Pool, "query">;

type ProgressionRow = {
  player_id: string;
  total_xp: string | number;
  level: number;
  curve_version: number;
  persistence_version: string | number;
};

type XpOperationRow = {
  player_id: string;
  source_type: ProgressionSourceType;
  source_id: string | null;
  requested_xp: number;
  replay_result: XpGrantResult;
};

type DeathPenaltyRow = {
  player_id: string;
  penalty_basis_points: number;
  replay_result: DeathPenaltyResult;
};

type DeathPenaltyPresentationRow = {
  xp_lost: string | number;
};

export const DEATH_PENALTY_BASIS_POINTS = 300 as const;
const HISTORICAL_DEATH_PENALTY_BASIS_POINTS = 1000 as const;
type DeathPenaltyBasisPoints =
  | typeof DEATH_PENALTY_BASIS_POINTS
  | typeof HISTORICAL_DEATH_PENALTY_BASIS_POINTS;

export type DeathPenaltyResult = {
  operationKey: string;
  penaltyBasisPoints: DeathPenaltyBasisPoints;
  previousXp: number;
  resultingXp: number;
  xpLost: number;
  penaltyBasisXp?: number;
  levelFloorXp?: number;
  previousLevel: number;
  resultingLevel: number;
  replayed: boolean;
  progression: ProgressionSnapshot;
};

export type StoredMaxHealthPenalty = Readonly<{ penalty: number; recoveryAnchorMs: number }>;

/**
 * Loads the stored max-HP penalty without ever failing the caller: login and stat refreshes
 * must not block on it. Returns undefined (leave the current penalty alone) when unavailable.
 */
export async function loadMaxHealthPenaltySafely(
  progression: Partial<Pick<ProgressionService, "maxHealthPenalty">>,
  playerId: string,
  onError?: (error: unknown) => void
): Promise<StoredMaxHealthPenalty | null | undefined> {
  if (typeof progression.maxHealthPenalty !== "function") return undefined;
  try {
    return await progression.maxHealthPenalty(playerId);
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

export type PvpMaxHealthLossResult = Readonly<{
  replayed: boolean;
  appliedLoss: number;
  penalty: StoredMaxHealthPenalty | null;
}>;

export type DeathPenaltyInput = {
  operationKey: string;
  playerId: string;
  metadata?: Record<string, unknown>;
};

export type DeathPenaltyPresentation = {
  operationKey: string;
  xpLost: number;
};

export type XpGrantInput = {
  operationKey: string;
  playerId: string;
  sourceType: ProgressionSourceType;
  sourceId?: string | null;
  requestedXp: number;
  metadata?: Record<string, unknown>;
};

export type ProgressionMetrics = {
  operationsRequested: number;
  xpGranted: number;
  xpDiscardedAtCap: number;
  levelUps: number;
  xpBySource: Record<ProgressionSourceType, number>;
};

export type LevelUpFeeOptions = Readonly<{
  glimmer: number;
  premiumWallet: Pick<PremiumWalletService, "debitForOperationInTransaction" | "snapshotInTransaction">;
}>;

export type ConfirmLevelUpInput = Readonly<{
  playerId: string;
  targetLevel: number;
  expectedGlimmerCost: number;
}>;

export type ConfirmLevelUpResult = Readonly<{
  replayed: boolean;
  level: number;
  glimmerCharged: number;
  progression: ProgressionSnapshot;
  premiumWallet: PremiumWalletSnapshot | null;
}>;

export class ProgressionRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProgressionRequestError";
  }
}

export class ProgressionService {
  private readonly metrics: ProgressionMetrics = {
    operationsRequested: 0,
    xpGranted: 0,
    xpDiscardedAtCap: 0,
    levelUps: 0,
    xpBySource: { combat: 0, harvest: 0, development: 0 }
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory?: Pick<
      InventoryService,
      "grantItemsForOperationInTransaction" | "snapshotInTransaction"
    >,
    options: Readonly<{ levelUpFee?: LevelUpFeeOptions | undefined }> = {}
  ) {
    this.levelUpFee = options.levelUpFee;
  }

  /**
   * GLIMMER_LEVEL_UP_FEE_ENABLED: XP still banks, but the stored level only rises through a paid
   * confirmLevelUp. Absent = levels apply automatically from XP (today's behaviour).
   */
  private readonly levelUpFee: LevelUpFeeOptions | undefined;

  /** Glimmer per character level while the fee is on, else null. */
  get levelUpGlimmerFee(): number | null {
    return this.levelUpFee?.glimmer ?? null;
  }

  private get paidLevels(): boolean {
    return this.levelUpFee !== undefined;
  }

  async getOrCreate(playerId: string): Promise<ProgressionSnapshot> {
    await this.pool.query(
      `INSERT INTO player_progression_profiles (player_id)
       VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
      [playerId]
    );
    const result = await this.pool.query<ProgressionRow>(
      `SELECT player_id, total_xp, level, curve_version, persistence_version
       FROM player_progression_profiles WHERE player_id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Progression profile does not exist");
    const xpLevel = levelForTotalXp(Number(row.total_xp));
    if (!this.paidLevels && Number(row.level) < xpLevel) {
      // The fee was turned off while levels were pending: apply them now (levels only rise).
      const caughtUp = await this.pool.query<ProgressionRow>(
        `UPDATE player_progression_profiles
         SET level = $2, persistence_version = persistence_version + 1, updated_at = now()
         WHERE player_id = $1 AND level < $2
         RETURNING player_id, total_xp, level, curve_version, persistence_version`,
        [playerId, xpLevel]
      );
      return snapshotFromRow(caughtUp.rows[0] ?? row, false);
    }
    return snapshotFromRow(row, this.paidLevels);
  }

  /** The stored PvP max-HP penalty (the effective value recovers lazily from the anchor). */
  async maxHealthPenalty(playerId: string): Promise<StoredMaxHealthPenalty | null> {
    const result = await this.pool.query<{ penalty: number; recovery_anchor_at: Date }>(
      `SELECT penalty, recovery_anchor_at FROM player_max_health_penalties WHERE player_id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    return row && row.penalty > 0
      ? { penalty: Number(row.penalty), recoveryAnchorMs: row.recovery_anchor_at.getTime() }
      : null;
  }

  /**
   * PvP death: -6 max HP, or -4 with Revenant armor, idempotent per death operation key.
   * `unpenalizedMaxHealth` caps the total at the 50% floor so recovery never hides behind it.
   */
  async applyPvpMaxHealthLoss(input: Readonly<{
    operationKey: string;
    playerId: string;
    killerPlayerId: string;
    revenantArmor: boolean;
    unpenalizedMaxHealth: number;
    nowMs?: number;
  }>): Promise<PvpMaxHealthLossResult> {
    if (!input.operationKey || input.operationKey.length > 240) {
      throw new Error("Max-HP loss operation key is required and must be at most 240 characters");
    }
    if (!input.playerId || !input.killerPlayerId || input.killerPlayerId === input.playerId) {
      throw new Error("Max-HP loss needs a victim and a different killer");
    }
    const nowMs = input.nowMs ?? Date.now();
    const requestedLoss = input.revenantArmor ? PVP_MAX_HEALTH_PENALTY.revenantArmorLoss : PVP_MAX_HEALTH_PENALTY.loss;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO player_max_health_penalties (player_id, penalty, recovery_anchor_at)
         VALUES ($1, 0, to_timestamp($2 / 1000.0)) ON CONFLICT (player_id) DO NOTHING`,
        [input.playerId, nowMs]
      );
      const locked = await client.query<{ penalty: number; recovery_anchor_at: Date }>(
        `SELECT penalty, recovery_anchor_at FROM player_max_health_penalties
         WHERE player_id = $1 FOR UPDATE`,
        [input.playerId]
      );
      const replay = await client.query<{ player_id: string; applied_loss: number }>(
        `SELECT player_id, applied_loss FROM player_pvp_max_health_losses WHERE operation_key = $1`,
        [input.operationKey]
      );
      const row = locked.rows[0]!;
      const current = { penalty: Number(row.penalty), recoveryAnchorMs: row.recovery_anchor_at.getTime() };
      if (replay.rows[0]) {
        if (replay.rows[0].player_id !== input.playerId) {
          throw new Error("Max-HP loss idempotency key conflicts with another player");
        }
        await client.query("COMMIT");
        return { replayed: true, appliedLoss: Number(replay.rows[0].applied_loss), penalty: current.penalty > 0 ? current : null };
      }
      // Beginner protection (level 3 and under, "lose nothing"): the death is
      // recorded with no loss so a replay stays a no-op.
      const victimXp = await client.query<{ total_xp: string; level: number }>(
        "SELECT total_xp::text, level FROM player_progression_profiles WHERE player_id = $1",
        [input.playerId]
      );
      const beginnerProtected = isBeginnerProtectedLevel(
        paidCharacterLevel(Number(victimXp.rows[0]?.total_xp ?? 0), victimXp.rows[0]?.level)
      );
      const next = beginnerProtected
        ? { penalty: current.penalty, recoveryAnchorMs: current.recoveryAnchorMs, appliedLoss: 0, penaltyBefore: current.penalty }
        : addMaxHealthPenalty(current, requestedLoss, maxHealthDebuffCap(input.unpenalizedMaxHealth), nowMs);
      await client.query(
        `UPDATE player_max_health_penalties
         SET penalty = $2, recovery_anchor_at = to_timestamp($3 / 1000.0), updated_at = now()
         WHERE player_id = $1`,
        [input.playerId, next.penalty, next.recoveryAnchorMs]
      );
      await client.query(
        `INSERT INTO player_pvp_max_health_losses (
           operation_key, player_id, killer_player_id, revenant_armor, requested_loss, applied_loss,
           penalty_before, penalty_after
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.operationKey, input.playerId, input.killerPlayerId, input.revenantArmor, requestedLoss,
          next.appliedLoss, next.penaltyBefore, next.penalty]
      );
      await client.query("COMMIT");
      const penalty = { penalty: next.penalty, recoveryAnchorMs: next.recoveryAnchorMs };
      return { replayed: false, appliedLoss: next.appliedLoss, penalty: penalty.penalty > 0 ? penalty : null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deathPenaltyPresentation(input: Readonly<{
    operationKey: string;
    playerId: string;
    currentTotalXp: number;
  }>): Promise<DeathPenaltyPresentation> {
    if (!input.operationKey || input.operationKey.length > 240) {
      throw new Error("Death penalty operation key is required and must be at most 240 characters");
    }
    if (!input.playerId) throw new Error("Death penalty player is required");
    const existing = await this.pool.query<DeathPenaltyPresentationRow>(
      `SELECT xp_lost FROM player_death_xp_penalties
       WHERE operation_key = $1 AND player_id = $2`,
      [input.operationKey, input.playerId]
    );
    return {
      operationKey: input.operationKey,
      xpLost: existing.rows[0]
        ? Number(existing.rows[0].xp_lost)
        : deathXpPenalty(input.currentTotalXp).xpLost
    };
  }

  async grantXp(input: XpGrantInput): Promise<XpGrantResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.grantXpInTransaction(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async applyDeathPenalty(input: DeathPenaltyInput): Promise<DeathPenaltyResult> {
    if (!input.operationKey || input.operationKey.length > 240) {
      throw new Error("Death penalty operation key is required and must be at most 240 characters");
    }
    if (!input.playerId) throw new Error("Death penalty player is required");
    const metadata = input.metadata ?? {};
    if (JSON.stringify(metadata).length > 4_096) throw new Error("Death penalty metadata is too large");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<DeathPenaltyRow>(
        `SELECT player_id, penalty_basis_points, replay_result
         FROM player_death_xp_penalties WHERE operation_key = $1`,
        [input.operationKey]
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        assertDeathPenaltyReplayOwnership(row, input.playerId);
        const current = await this.progressionSnapshotInTransaction(client, input.playerId);
        await client.query("COMMIT");
        return { ...row.replay_result, replayed: true, progression: current };
      }
      await client.query(
        `INSERT INTO player_progression_profiles (player_id)
         VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
        [input.playerId]
      );
      const locked = await client.query<ProgressionRow>(
        `SELECT player_id, total_xp, level, curve_version, persistence_version
         FROM player_progression_profiles WHERE player_id = $1 FOR UPDATE`,
        [input.playerId]
      );
      const row = locked.rows[0];
      if (!row) throw new Error("Progression profile does not exist");
      const replay = await client.query<DeathPenaltyRow>(
        `SELECT player_id, penalty_basis_points, replay_result
         FROM player_death_xp_penalties WHERE operation_key = $1`,
        [input.operationKey]
      );
      if (replay.rows[0]) {
        const replayRow = replay.rows[0];
        assertDeathPenaltyReplayOwnership(replayRow, input.playerId);
        const current = snapshotFromRow(row, this.paidLevels);
        await client.query("COMMIT");
        return { ...replayRow.replay_result, replayed: true, progression: current };
      }
      const previousXp = Number(row.total_xp);
      // XP math is unchanged. With paid levels the stored level never moves on death (the XP floor
      // keeps banked thresholds, so a death cannot cancel a ready level either).
      const previousLevel = this.paidLevels ? Number(row.level) : levelForTotalXp(previousXp);
      const { penaltyBasisXp, levelFloorXp, xpLost } = deathXpPenalty(previousXp);
      const resultingXp = previousXp - xpLost;
      const resultingLevel = this.paidLevels ? Number(row.level) : levelForTotalXp(resultingXp);
      const updated = await client.query<ProgressionRow>(
        `UPDATE player_progression_profiles
         SET total_xp = $2, level = $3, curve_version = $4,
             persistence_version = persistence_version + 1, updated_at = now()
         WHERE player_id = $1 AND persistence_version = $5
         RETURNING player_id, total_xp, level, curve_version, persistence_version`,
        [input.playerId, resultingXp, resultingLevel, PROGRESSION_CURVE_VERSION, Number(row.persistence_version)]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("Progression profile changed concurrently");
      const result: DeathPenaltyResult = {
        operationKey: input.operationKey,
        penaltyBasisPoints: DEATH_PENALTY_BASIS_POINTS,
        previousXp,
        resultingXp,
        xpLost,
        penaltyBasisXp,
        levelFloorXp,
        previousLevel,
        resultingLevel,
        replayed: false,
        progression: snapshotFromRow(updatedRow, this.paidLevels)
      };
      await client.query(
        `INSERT INTO player_death_xp_penalties (
           operation_id, operation_key, player_id, penalty_basis_points,
            previous_xp, resulting_xp, xp_lost, penalty_basis_xp, level_floor_xp, previous_level, resulting_level,
            replay_result, metadata
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
        [randomUUID(), input.operationKey, input.playerId, DEATH_PENALTY_BASIS_POINTS,
          previousXp, resultingXp, xpLost, penaltyBasisXp, levelFloorXp, previousLevel,
          resultingLevel, JSON.stringify(result), JSON.stringify(metadata)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async grantXpInTransaction(queryable: Queryable, input: XpGrantInput): Promise<XpGrantResult> {
    const normalized = normalizeGrant(input);
    this.metrics.operationsRequested += 1;
    const replay = await this.loadReplay(queryable, normalized);
    if (replay) return replay;

    await queryable.query(
      `INSERT INTO player_progression_profiles (player_id)
       VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
      [normalized.playerId]
    );
    const locked = await queryable.query<ProgressionRow>(
      `SELECT player_id, total_xp, level, curve_version, persistence_version
       FROM player_progression_profiles WHERE player_id = $1 FOR UPDATE`,
      [normalized.playerId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error("Progression profile does not exist");

    const replayAfterLock = await this.loadReplay(queryable, normalized);
    if (replayAfterLock) return replayAfterLock;

    const transition = calculateXpTransition(Number(row.total_xp), normalized.requestedXp);
    const { previousXp, resultingXp, grantedXp, discardedXp, postCapRewardCycles } = transition;
    // Paid levels: XP banks and the stored level waits for confirmLevelUp (no automatic level-ups).
    const previousLevel = this.paidLevels ? Number(row.level) : transition.previousLevel;
    const resultingLevel = this.paidLevels ? Number(row.level) : transition.resultingLevel;
    const levelsGained = this.paidLevels ? [] : transition.levelsGained;
    const persistenceVersion = Number(row.persistence_version) + 1;
    const updated = await queryable.query<ProgressionRow>(
      `UPDATE player_progression_profiles
       SET total_xp = $2, level = $3, curve_version = $4,
           persistence_version = persistence_version + 1, updated_at = now()
       WHERE player_id = $1 AND persistence_version = $5
       RETURNING player_id, total_xp, level, curve_version, persistence_version`,
      [normalized.playerId, resultingXp, resultingLevel, PROGRESSION_CURVE_VERSION, Number(row.persistence_version)]
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow || Number(updatedRow.persistence_version) !== persistenceVersion) {
      throw new Error("Progression profile changed concurrently");
    }

    const enchantmentStoneRewards = postCapRewardCycles.map((cycle) => ({
      itemId: "enchantment_stone" as const,
      variant: resolveEnchantmentStoneVariant(normalized.operationKey, cycle)
    }));
    const rewardInventory = enchantmentStoneRewards.length > 0
      ? await this.grantEnchantmentStoneRewards(
          queryable,
          normalized.playerId,
          normalized.operationKey,
          enchantmentStoneRewards.map(({ variant }) => variant)
        )
      : undefined;
    const operationId = randomUUID();
    const result: XpGrantResult = {
      operationKey: normalized.operationKey,
      sourceType: normalized.sourceType,
      sourceId: normalized.sourceId,
      requestedXp: normalized.requestedXp,
      grantedXp,
      discardedXp,
      previousXp,
      resultingXp,
      previousLevel,
      resultingLevel,
      levelsGained,
      replayed: false,
      progression: snapshotFromRow(updatedRow, this.paidLevels),
      ...(enchantmentStoneRewards.length > 0
        ? { enchantmentStoneRewards, inventory: rewardInventory! }
        : {})
    };
    await queryable.query(
      `INSERT INTO xp_operations (
         operation_id, operation_key, player_id, source_type, source_id,
         requested_xp, granted_xp, discarded_xp, previous_xp, resulting_xp,
         previous_level, resulting_level, replay_result, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,
      [
        operationId, normalized.operationKey, normalized.playerId, normalized.sourceType,
        normalized.sourceId, normalized.requestedXp, grantedXp, discardedXp, previousXp,
        resultingXp, previousLevel, resultingLevel, JSON.stringify(result),
        JSON.stringify(normalized.metadata)
      ]
    );
    await queryable.query(
      `INSERT INTO xp_events (
         operation_id, operation_key, player_id, event_type, xp_delta,
         resulting_xp, resulting_level, metadata
       ) VALUES ($1,$2,$3,'xp_granted',$4,$5,$6,$7::jsonb)`,
      [operationId, normalized.operationKey, normalized.playerId, grantedXp, resultingXp, resultingLevel, JSON.stringify(normalized.metadata)]
    );
    // After the replay checks above, so a replayed grant never feeds the kingdom twice.
    await creditKingdomMemberXpInTransaction(queryable, {
      playerId: normalized.playerId,
      xp: grantedXp,
      operationKey: normalized.operationKey
    });
    for (const level of levelsGained) {
      await queryable.query(
        `INSERT INTO xp_events (
           operation_id, operation_key, player_id, event_type, xp_delta,
           resulting_xp, resulting_level, metadata
         ) VALUES ($1,$2,$3,'level_up',0,$4,$5,$6::jsonb)`,
        [operationId, normalized.operationKey, normalized.playerId, totalXpForLevel(level), level, JSON.stringify({ curveVersion: PROGRESSION_CURVE_VERSION })]
      );
    }
    this.metrics.xpGranted += grantedXp;
    this.metrics.xpDiscardedAtCap += discardedXp;
    this.metrics.levelUps += levelsGained.length;
    this.metrics.xpBySource[normalized.sourceType] += grantedXp;
    return result;
  }

  private async grantEnchantmentStoneRewards(
    queryable: Queryable,
    playerId: string,
    xpOperationKey: string,
    variants: readonly EnchantmentStoneVariant[]
  ) {
    if (!this.inventory) {
      throw new Error("Enchantment Stone rewards require the inventory service");
    }
    const keyHash = createHash("sha256").update(xpOperationKey).digest("hex");
    return (await this.inventory.grantItemsForOperationInTransaction(queryable, {
      operationKey: `post-cap-stones:${keyHash}`,
      playerId,
      source: "post_cap_xp_reward",
      sourceEntityType: "xp_operation",
      sourceEntityId: xpOperationKey,
      metadata: { xpOperationKey, variants },
      grants: variants.map((variant) => ({
        itemId: "enchantment_stone" as const,
        variant,
        quantity: 1
      }))
    })).inventory;
  }

  metricsSnapshot(): ProgressionMetrics {
    return structuredClone(this.metrics);
  }

  async reconcilePlayer(playerId: string): Promise<{ totalXp: number; ledgerXp: number; ok: boolean }> {
    const result = await this.pool.query<{ total_xp: number; ledger_xp: string }>(
      `SELECT p.total_xp, (
         COALESCE(o.granted_xp, 0) + COALESCE(d.adjusted_xp, 0) + COALESCE(c.curve_xp, 0)
         - COALESCE(pen.xp_lost, 0)
       )::text AS ledger_xp
       FROM player_progression_profiles p
       LEFT JOIN (
         SELECT player_id, sum(granted_xp)::bigint AS granted_xp FROM xp_operations GROUP BY player_id
       ) o ON o.player_id = p.player_id
       LEFT JOIN (
         SELECT player_id, sum(character_xp_delta)::bigint AS adjusted_xp
         FROM dev_progression_operations GROUP BY player_id
       ) d ON d.player_id = p.player_id
       LEFT JOIN (
         SELECT player_id, sum(xp_delta)::bigint AS curve_xp
         FROM character_xp_curve_adjustments GROUP BY player_id
       ) c ON c.player_id = p.player_id
       LEFT JOIN (
         SELECT player_id, sum(xp_lost)::bigint AS xp_lost
         FROM player_death_xp_penalties GROUP BY player_id
       ) pen ON pen.player_id = p.player_id
       WHERE p.player_id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Progression profile does not exist");
    const totalXp = Number(row.total_xp);
    const ledgerXp = Number(row.ledger_xp);
    return { totalXp, ledgerXp, ok: totalXp === ledgerXp };
  }

  private async loadReplay(
    queryable: Queryable,
    input: ReturnType<typeof normalizeGrant>
  ): Promise<XpGrantResult | null> {
    const existing = await queryable.query<XpOperationRow>(
      `SELECT player_id, source_type, source_id, requested_xp, replay_result
       FROM xp_operations WHERE operation_key = $1`,
      [input.operationKey]
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (
      row.player_id !== input.playerId || row.source_type !== input.sourceType ||
      row.source_id !== input.sourceId || Number(row.requested_xp) !== input.requestedXp
    ) {
      throw new Error("XP idempotency key conflicts with another operation");
    }
    const current = await queryable.query<ProgressionRow>(
      `SELECT player_id, total_xp, level, curve_version, persistence_version
       FROM player_progression_profiles WHERE player_id = $1`,
      [input.playerId]
    );
    const currentRow = current.rows[0];
    if (!currentRow) throw new Error("Progression profile does not exist");
    const replayResult: XpGrantResult = {
      ...row.replay_result,
      replayed: true,
      progression: snapshotFromRow(currentRow, this.paidLevels)
    };
    if (replayResult.enchantmentStoneRewards?.length && this.inventory) {
      replayResult.inventory = await this.inventory.snapshotInTransaction(
        queryable,
        input.playerId
      );
    }
    return replayResult;
  }

  private async progressionSnapshotInTransaction(
    queryable: Queryable,
    playerId: string
  ): Promise<ProgressionSnapshot> {
    const current = await queryable.query<ProgressionRow>(
      `SELECT player_id, total_xp, level, curve_version, persistence_version
       FROM player_progression_profiles WHERE player_id = $1`,
      [playerId]
    );
    if (!current.rows[0]) throw new Error("Progression profile does not exist");
    return snapshotFromRow(current.rows[0], this.paidLevels);
  }

  /**
   * Glimmer level-up fee: pay for and apply exactly one ready level. Idempotent: the wallet debit
   * key is per character and target level, and a target the stored level already reached is a
   * replay with no charge. The progression row is locked before the wallet row, and the debit and
   * the level change commit together: never a level without payment, never a double charge.
   */
  async confirmLevelUp(input: ConfirmLevelUpInput): Promise<ConfirmLevelUpResult> {
    const fee = this.levelUpFee;
    if (!fee) throw new ProgressionRequestError("LEVEL_UP_FEE_DISABLED", "Levels apply automatically.");
    const { playerId, targetLevel } = input;
    if (!playerId) throw new ProgressionRequestError("LEVEL_UP_INVALID", "Player is required.");
    if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > CURRENT_LEVEL_CAP) {
      throw new ProgressionRequestError("LEVEL_UP_INVALID", `Level must be between 1 and ${CURRENT_LEVEL_CAP}.`);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO player_progression_profiles (player_id)
         VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
        [playerId]
      );
      const locked = await client.query<ProgressionRow>(
        `SELECT player_id, total_xp, level, curve_version, persistence_version
         FROM player_progression_profiles WHERE player_id = $1 FOR UPDATE`,
        [playerId]
      );
      const row = locked.rows[0];
      if (!row) throw new Error("Progression profile does not exist");
      const account = await client.query<{ account_id: string | null }>(
        "SELECT account_id::text FROM players WHERE id = $1", [playerId]
      );
      const accountId = account.rows[0]?.account_id ?? null;
      const storedLevel = Number(row.level);
      if (storedLevel >= targetLevel) {
        const premiumWallet = accountId ? await fee.premiumWallet.snapshotInTransaction(client, accountId) : null;
        await client.query("COMMIT");
        return { replayed: true, level: storedLevel, glimmerCharged: 0, progression: snapshotFromRow(row, true), premiumWallet };
      }
      if (targetLevel !== storedLevel + 1) {
        throw new ProgressionRequestError("LEVEL_UP_STALE", `You are level ${storedLevel}. Level up one level at a time.`);
      }
      if (levelForTotalXp(Number(row.total_xp)) < targetLevel) {
        throw new ProgressionRequestError("LEVEL_UP_NOT_READY", `You need more XP to reach level ${targetLevel}.`);
      }
      if (input.expectedGlimmerCost !== fee.glimmer) {
        throw new ProgressionRequestError("LEVEL_UP_PRICE_CHANGED", `Level up costs ${fee.glimmer} Glimmer. Check the price and try again.`);
      }
      if (!accountId) throw new ProgressionRequestError("LEVEL_UP_UNAVAILABLE", "Your account cannot pay Glimmer right now.");
      try {
        await fee.premiumWallet.debitForOperationInTransaction(client, {
          accountId,
          currency: "glimmer",
          amount: BigInt(fee.glimmer),
          operationKey: `character-level-up:${playerId}:${targetLevel}`,
          reason: "spend",
          actorPlayerId: playerId,
          refType: "character_level",
          refId: `${playerId}:${targetLevel}`,
          metadata: { fromLevel: storedLevel, toLevel: targetLevel, totalXp: Number(row.total_xp) }
        });
      } catch (error) {
        if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
          throw new ProgressionRequestError(
            "LEVEL_UP_INSUFFICIENT_GLIMMER",
            `You need ${fee.glimmer} Glimmer to reach level ${targetLevel}.`
          );
        }
        throw error;
      }
      const updated = await client.query<ProgressionRow>(
        `UPDATE player_progression_profiles
         SET level = $2, persistence_version = persistence_version + 1, updated_at = now()
         WHERE player_id = $1 AND persistence_version = $3 AND level = $4
         RETURNING player_id, total_xp, level, curve_version, persistence_version`,
        [playerId, targetLevel, Number(row.persistence_version), storedLevel]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("Progression profile changed concurrently");
      const premiumWallet = await fee.premiumWallet.snapshotInTransaction(client, accountId);
      await client.query("COMMIT");
      this.metrics.levelUps += 1;
      return {
        replayed: false,
        level: targetLevel,
        glimmerCharged: fee.glimmer,
        progression: snapshotFromRow(updatedRow, true),
        premiumWallet
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function calculateDeathXpPenalty(totalXp: number): number {
  return deathXpPenalty(totalXp).xpLost;
}

function deathXpPenalty(totalXp: number): {
  penaltyBasisXp: number;
  levelFloorXp: number;
  xpLost: number;
} {
  if (!Number.isSafeInteger(totalXp) || totalXp < 0) {
    throw new Error("Total XP is outside the supported range");
  }
  const progress = xpProgress(totalXp);
  const penaltyBasisXp = progress.xpForNextLevel ?? 0;
  // Beginner protection: at level 3 and under the floor is the current XP, so
  // a death costs nothing. Death never drops a level, so passing it is permanent.
  const levelFloorXp = isBeginnerProtectedLevel(progress.level)
    ? totalXp
    : totalXpForLevel(progress.level);
  return {
    penaltyBasisXp,
    levelFloorXp,
    xpLost: Math.min(
      totalXp - levelFloorXp,
      Math.floor(penaltyBasisXp * DEATH_PENALTY_BASIS_POINTS / 10_000)
    )
  };
}

function assertDeathPenaltyReplayOwnership(
  row: Pick<DeathPenaltyRow, "player_id" | "penalty_basis_points">,
  playerId: string
): asserts row is DeathPenaltyRow & { penalty_basis_points: DeathPenaltyBasisPoints } {
  if (row.player_id !== playerId || !isSupportedDeathPenaltyBasisPoints(row.penalty_basis_points)) {
    throw new Error("Death penalty idempotency key conflicts with another operation");
  }
}

function isSupportedDeathPenaltyBasisPoints(value: number): value is DeathPenaltyBasisPoints {
  return value === DEATH_PENALTY_BASIS_POINTS || value === HISTORICAL_DEATH_PENALTY_BASIS_POINTS;
}

function normalizeGrant(input: XpGrantInput) {
  if (!input.operationKey || input.operationKey.length > 240) {
    throw new Error("XP operation key is required and must be at most 240 characters");
  }
  if (!input.playerId) throw new Error("XP operation player is required");
  if (!Number.isSafeInteger(input.requestedXp) || input.requestedXp < 0) {
    throw new Error("Requested XP must be a nonnegative safe integer");
  }
  const metadata = input.metadata ?? {};
  if (JSON.stringify(metadata).length > 4_096) throw new Error("XP metadata is too large");
  return {
    operationKey: input.operationKey,
    playerId: input.playerId,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    requestedXp: input.requestedXp,
    metadata
  };
}

/**
 * `paidLevels` (Glimmer level-up fee on): the level is the stored, paid level and the bar runs
 * toward the next level; banked XP can fill it past 100%, which the client reads as "Level up
 * ready". Otherwise the level is derived from XP exactly as before.
 */
function snapshotFromRow(row: ProgressionRow, paidLevels: boolean): ProgressionSnapshot {
  const totalXp = Number(row.total_xp);
  const derived = xpProgress(totalXp);
  const level = paidLevels ? paidCharacterLevel(totalXp, row.level) : derived.level;
  const progress = level === derived.level ? derived : {
    level,
    xpIntoLevel: totalXp - totalXpForLevel(level),
    xpForNextLevel: totalXpForLevel(level + 1) - totalXpForLevel(level),
    nextLevelTotalXp: totalXpForLevel(level + 1),
    atCap: false
  };
  return {
    playerId: row.player_id,
    totalXp,
    level: progress.level,
    curveVersion: Number(row.curve_version),
    persistenceVersion: Number(row.persistence_version),
    xpIntoLevel: progress.xpIntoLevel,
    xpForNextLevel: progress.xpForNextLevel,
    nextLevelTotalXp: progress.nextLevelTotalXp,
    atCap: progress.atCap,
    pveStats: playerPveStats(progress.level)
  };
}

function levelsBetween(previousLevel: number, resultingLevel: number): number[] {
  const levels: number[] = [];
  for (let level = previousLevel + 1; level <= Math.min(CURRENT_LEVEL_CAP, resultingLevel); level += 1) {
    levels.push(level);
  }
  return levels;
}

export function calculateXpTransition(previousXp: number, requestedXp: number): {
  previousXp: number;
  previousLevel: number;
  resultingXp: number;
  grantedXp: number;
  discardedXp: number;
  resultingLevel: number;
  levelsGained: number[];
  postCapRewardCycles: number[];
} {
  if (!Number.isSafeInteger(previousXp) || previousXp < 0) {
    throw new Error("Previous XP is outside the supported range");
  }
  if (!Number.isSafeInteger(requestedXp) || requestedXp < 0) {
    throw new Error("Requested XP must be a nonnegative safe integer");
  }
  const previousLevel = levelForTotalXp(previousXp);
  const resultingXp = previousXp + requestedXp;
  if (!Number.isSafeInteger(resultingXp)) {
    throw new Error("Resulting XP exceeds the supported range");
  }
  const grantedXp = requestedXp;
  const discardedXp = 0;
  const resultingLevel = levelForTotalXp(resultingXp);
  const previousRewardCount = completedPostCapRewardCount(previousXp);
  const resultingRewardCount = completedPostCapRewardCount(resultingXp);
  return {
    previousXp,
    previousLevel,
    resultingXp,
    grantedXp,
    discardedXp,
    resultingLevel,
    levelsGained: levelsBetween(previousLevel, resultingLevel),
    postCapRewardCycles: Array.from(
      { length: resultingRewardCount - previousRewardCount },
      (_, index) => previousRewardCount + index + 1
    )
  };
}

function completedPostCapRewardCount(totalXp: number): number {
  return Math.floor(
    Math.max(0, totalXp - MAX_CURRENT_ERA_XP) / POST_CAP_XP_PER_REWARD
  );
}

export function resolveEnchantmentStoneVariant(
  operationKey: string,
  rewardCycle: number
): EnchantmentStoneVariant {
  if (!operationKey || !Number.isSafeInteger(rewardCycle) || rewardCycle <= 0) {
    throw new Error("Enchantment Stone reward identity is invalid");
  }
  const roll = createHash("sha256")
    .update(`${operationKey}:${rewardCycle}`)
    .digest()
    .readUInt32BE(0) % 100;
  return enchantmentStoneVariantForRoll(roll);
}

export function enchantmentStoneVariantForRoll(roll: number): EnchantmentStoneVariant {
  if (!Number.isInteger(roll) || roll < 0 || roll > 99) {
    throw new Error("Enchantment Stone roll must be an integer from 0 through 99");
  }
  if (roll < 4) return ENCHANTMENT_STONE_VARIANTS[0];
  if (roll < 10) return ENCHANTMENT_STONE_VARIANTS[1];
  if (roll < 18) return ENCHANTMENT_STONE_VARIANTS[2];
  if (roll < 28) return ENCHANTMENT_STONE_VARIANTS[3];
  if (roll < 40) return ENCHANTMENT_STONE_VARIANTS[4];
  if (roll < 56) return ENCHANTMENT_STONE_VARIANTS[5];
  if (roll < 76) return ENCHANTMENT_STONE_VARIANTS[6];
  return ENCHANTMENT_STONE_VARIANTS[7];
}
