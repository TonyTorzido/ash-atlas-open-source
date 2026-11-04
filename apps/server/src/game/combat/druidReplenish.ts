import type pg from "pg";
import { DRUID_REPLENISH_BERRY_COST, GIVING_BERRY_ITEM_ID, INTERIOR_LOCATION_CAPABILITIES,
  type PlayerInventorySnapshot, type PlayerLocationSnapshot } from "@ash-atlas/shared";

import { CombatRequestError, type CombatEngine, type DirtyCombatProfile, type ReplenishPlan } from "./combatEngine.js";
import type { InventoryService } from "../inventory.js";
import type { PlayerAuthorityFence } from "../playerAuthorityFence.js";
import type { PlayerLocationService } from "../locations/playerLocationService.js";

type Receipt = Readonly<{
  casterId: string;
  targetId: string;
  casterBefore: number;
  targetBefore: number;
  casterAfter: number;
  targetAfter: number;
  casterVersion: number;
  targetVersion: number;
}>;

export class DruidReplenishService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "snapshotInTransaction">,
    private readonly combat: CombatEngine,
    private readonly fence: PlayerAuthorityFence,
    private readonly locations: Pick<PlayerLocationService, "load">
  ) {}

  use(input: {
    playerId: string;
    targetPlayerId: string;
    accountId: string;
    connectionId: string;
    requestId: string;
  }, onReserved?: () => void): Promise<{ replayed: boolean; receipt: Receipt; inventory: PlayerInventorySnapshot }> {
    if (input.playerId === input.targetPlayerId) {
      return Promise.reject(new CombatRequestError("ABILITY_FRIENDLY_TARGET_INVALID", "Replenish cannot target its caster"));
    }
    return this.fence.runMany([input.playerId, input.targetPlayerId], () => this.useLocked(input, onReserved));
  }

  private async useLocked(input: {
    playerId: string; targetPlayerId: string; accountId: string; connectionId: string; requestId: string;
  }, onReserved?: () => void): Promise<{ replayed: boolean; receipt: Receipt; inventory: PlayerInventorySnapshot }> {
    this.combat.validateReplenishAuthority(input.playerId, input.accountId, input.connectionId);
    const operationKey = `druid-replenish:${input.playerId}:${input.requestId}`;
    const previous = await this.readReceipt(operationKey);
    if (previous) {
      if (previous.casterId !== input.playerId || previous.targetId !== input.targetPlayerId) {
        throw new CombatRequestError("ABILITY_REQUEST_CONFLICT", "Replenish request ID belongs to a different target");
      }
      return { replayed: true, receipt: previous,
        inventory: await this.inventory.snapshotInTransaction(this.pool, input.playerId) };
    }
    const [casterLocation, targetLocation] = await Promise.all([
      this.locations.load(input.playerId), this.locations.load(input.targetPlayerId)
    ]);
    if (!sameCombatLocation(casterLocation, targetLocation)) {
      throw new CombatRequestError("ABILITY_LOCATION_INVALID", "Replenish requires both players in the same combat location");
    }
    const plan = this.combat.reserveReplenish(input);
    onReserved?.();
    let committed: Receipt | null = null;
    let installPlan = false;
    let inventory: PlayerInventorySnapshot | null = null;
    try {
      const client = await this.pool.connect();
      let commitAttempted = false;
      let released = false;
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ player_id: string; persistence_version: string }>(
          `SELECT player_id, persistence_version::text FROM player_combat_profiles
           WHERE player_id = ANY($1::text[]) ORDER BY player_id FOR UPDATE`,
          [[plan.casterId, plan.targetId]]
        );
        if (locked.rows.length !== 2) throw new Error("Replenish participant profile is missing");
        const replay = await this.readReceipt(operationKey, client);
        if (replay) {
          if (replay.casterId !== plan.casterId || replay.targetId !== plan.targetId) {
            throw new CombatRequestError("ABILITY_REQUEST_CONFLICT", "Replenish request ID belongs to a different target");
          }
          inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
          await client.query("ROLLBACK");
          committed = replay;
          return { replayed: true, receipt: replay, inventory };
        }
        const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey,
          playerId: plan.casterId,
          source: "druid-replenish",
          sourceEntityType: "player",
          sourceEntityId: plan.targetId,
          metadata: { requestId: input.requestId, targetPlayerId: plan.targetId },
          debits: [{ itemId: GIVING_BERRY_ITEM_ID, variant: null, quantity: DRUID_REPLENISH_BERRY_COST }]
        });
        if (!debit.applied) throw new Error("Replenish debit replay has no receipt");
        inventory = debit.inventory;
        const versions = new Map(locked.rows.map((row) => [row.player_id, Number(row.persistence_version)]));
        const casterVersion = Math.max(versions.get(plan.casterId) ?? 0, plan.casterProfile.persistenceVersion) + 1;
        const targetVersion = Math.max(versions.get(plan.targetId) ?? 0, plan.targetProfile.persistenceVersion) + 1;
        await this.writeProfile(client, plan.casterProfile, casterVersion);
        await this.writeProfile(client, plan.targetProfile, targetVersion);
        const receipt: Receipt = {
          casterId: plan.casterId, targetId: plan.targetId,
          casterBefore: plan.casterBefore, targetBefore: plan.targetBefore,
          casterAfter: plan.casterAfter, targetAfter: plan.targetAfter,
          casterVersion, targetVersion
        };
        await client.query(
          `UPDATE inventory_operations SET metadata = metadata || $2::jsonb WHERE operation_key = $1`,
          [operationKey, JSON.stringify({ replenishReceipt: receipt })]
        );
        commitAttempted = true;
        await client.query("COMMIT");
        committed = receipt;
        installPlan = true;
      } catch (error) {
        if (!commitAttempted) {
          try { await client.query("ROLLBACK"); } catch { /* connection may already be gone */ }
          throw error;
        }
        // A lost COMMIT response is resolved after its connection is destroyed. Locking
        // both profile rows on another connection waits for the old transaction's outcome.
        client.release(true);
        released = true;
        for (;;) {
          try {
            committed = await this.readSettledReceipt(operationKey, plan);
            if (!committed) throw new Error("Replenish commit did not persist");
            inventory = await this.inventory.snapshotInTransaction(this.pool, input.playerId);
            installPlan = true;
            break;
          } catch (lookupError) {
            if (lookupError instanceof Error && lookupError.message === "Replenish commit did not persist") throw lookupError;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } finally {
        if (!released) client.release();
      }
      return { replayed: !installPlan, receipt: committed!, inventory: inventory! };
    } finally {
      this.combat.completeReplenish(plan, installPlan && committed ? {
        caster: committed.casterVersion, target: committed.targetVersion
      } : undefined);
    }
  }

  private async readSettledReceipt(operationKey: string, plan: ReplenishPlan): Promise<Receipt | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT player_id FROM player_combat_profiles WHERE player_id = ANY($1::text[])
         ORDER BY player_id FOR UPDATE`, [[plan.casterId, plan.targetId]]
      );
      const receipt = await this.readReceipt(operationKey, client);
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be unavailable */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async readReceipt(operationKey: string, queryable: Pick<pg.Pool, "query"> = this.pool): Promise<Receipt | null> {
    const result = await queryable.query<{ metadata: { replenishReceipt?: Receipt } }>(
      `SELECT metadata FROM inventory_operations WHERE operation_key = $1`, [operationKey]
    );
    return result.rows[0]?.metadata?.replenishReceipt ?? null;
  }

  private async writeProfile(client: pg.PoolClient, profile: DirtyCombatProfile, version: number): Promise<void> {
    const result = await client.query(
      `UPDATE player_combat_profiles SET max_health=$2, current_health=$3,
         base_attack_damage=$4, persistence_version=$5, life_state=$6,
         downed_until=$7, death_penalty_operation_key=$8, respawn_available_at=$9
       WHERE player_id=$1`,
      [profile.playerId, profile.maxHealth, profile.currentHealth, profile.baseAttackDamage,
        version, profile.lifeState ?? "alive", profile.downedUntil ? new Date(profile.downedUntil) : null,
        profile.deathPenaltyOperationKey ?? null,
        profile.respawnAvailableAt ? new Date(profile.respawnAvailableAt) : null]
    );
    if (result.rowCount !== 1) throw new Error("Replenish participant profile vanished");
  }
}

function sameCombatLocation(left: PlayerLocationSnapshot, right: PlayerLocationSnapshot): boolean {
  if (left.kind === "world" && right.kind === "world") return true;
  if (left.kind !== "interior" || right.kind !== "interior") return false;
  const capabilities = INTERIOR_LOCATION_CAPABILITIES[left.locationType];
  return capabilities.abilities && capabilities.combat &&
    left.locationType === right.locationType && left.instanceId === right.instanceId &&
    left.spaceId === right.spaceId;
}
