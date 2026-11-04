import {
  BALSAM_RESIN_EFFECT_DURATION_MS,
  GIVING_BERRY_ITEM_ID,
  type BalsamResinEffectSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import { CityDistrictBenefitService } from "./cityDistrictBenefits.js";

type EffectRow = {
  effect_id: string;
  operation_key: string;
  player_id: string;
  started_at: Date | string;
  ends_at: Date | string;
  status: "active" | "completed" | "cleared";
  resin_consumed: boolean;
  hunting_district_preserved: boolean;
};

export class BalsamResinError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BalsamResinError";
  }
}

export type ConsumeBalsamResinResult = {
  effect: BalsamResinEffectSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
};

export type ConsumeBalsamResinOptions = Readonly<{
  atFullHealth?: boolean;
}>;

export class BalsamResinService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: InventoryService,
    private readonly now: () => Date = () => new Date(),
    private readonly roll: () => number = Math.random,
    private readonly districtBenefits = new CityDistrictBenefitService(pool)
  ) {}

  async consume(
    playerId: string,
    requestId: string,
    stackId?: string,
    options: ConsumeBalsamResinOptions = {}
  ): Promise<ConsumeBalsamResinResult> {
    const operationKey = `use-giving-berry:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const replay = await this.effectForOperation(client, operationKey, playerId);
      if (replay) {
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { effect: rowToSnapshot(replay), inventory, replayed: true };
      }
      if (options.atFullHealth) {
        throw new BalsamResinError(
          "BALSAM_RESIN_FULL_HEALTH",
          "You are already at full health."
        );
      }

      const now = this.now();
      await expireEffects(client, playerId, now);
      const active = await client.query<{ effect_id: string }>(
        `SELECT effect_id
         FROM balsam_resin_effects
         WHERE player_id = $1 AND status = 'active'
         FOR UPDATE`,
        [playerId]
      );
      if (active.rows[0]) {
        throw new BalsamResinError(
          "BALSAM_RESIN_ALREADY_ACTIVE",
          "Giving Berry is already active."
        );
      }

      const benefit = await this.districtBenefits.resolveForPlayer(client, playerId);
      const preservationChance = benefit.resinPreservationChance;
      const preserved =
        preservationChance > 0 && this.roll() < preservationChance;
      let inventory: PlayerInventorySnapshot;
      if (preserved) {
        const operation = await client.query(
          `INSERT INTO inventory_operations (
             operation_key, player_id, source, source_entity_type,
             source_entity_id, metadata
           ) VALUES ($1,$2,'consumable-use-preserved','item_definition',$3,$4::jsonb)
           ON CONFLICT (operation_key) DO NOTHING
           RETURNING operation_key`,
          [
            operationKey,
            playerId,
            GIVING_BERRY_ITEM_ID,
            JSON.stringify({
              requestId,
              cityId: benefit.cityId,
              districtRevision: benefit.districtRevision,
              monumentTier: benefit.monumentTiers.hunting,
              preservationChance
            })
          ]
        );
        if (!operation.rows[0]) {
          throw new Error("Giving Berry preservation operation already exists");
        }
        inventory = await this.inventory.snapshotInTransaction(client, playerId);
      } else {
        const debit = await this.inventory.debitItemsForOperationInTransaction(
          client,
          {
            operationKey,
            playerId,
            source: "consumable-use",
            sourceEntityType: "item_definition",
            sourceEntityId: GIVING_BERRY_ITEM_ID,
            metadata: {
              requestId,
              preservationChance,
              cityId: benefit.cityId,
              districtRevision: benefit.districtRevision,
              monumentTier: benefit.monumentTiers.hunting
            },
            ...(stackId ? { preferredStackId: stackId } : {}),
            debits: [{ itemId: GIVING_BERRY_ITEM_ID, variant: null, quantity: 1 }]
          }
        );
        if (!debit.applied) {
          throw new Error("Giving Berry debit replay had no durable effect");
        }
        inventory = debit.inventory;
      }

      const endsAt = new Date(
        now.getTime() + BALSAM_RESIN_EFFECT_DURATION_MS
      );
      const inserted = await client.query<EffectRow>(
        `INSERT INTO balsam_resin_effects (
           effect_id, operation_key, player_id, started_at, ends_at, status,
           resin_consumed, hunting_district_preserved, city_id,
           city_district_revision, city_monument_tier, preservation_chance
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11)
         RETURNING effect_id, operation_key, player_id, started_at, ends_at, status,
                   resin_consumed, hunting_district_preserved`,
        [
          crypto.randomUUID(),
          operationKey,
          playerId,
          now,
          endsAt,
          !preserved,
          preserved,
          preservationChance > 0 ? benefit.cityId : null,
          preservationChance > 0 ? benefit.districtRevision : null,
          preservationChance > 0 ? benefit.monumentTiers.hunting : null,
          preservationChance
        ]
      );
      const effect = inserted.rows[0];
      if (!effect) throw new Error("Giving Berry effect insert returned no row");
      await client.query("COMMIT");
      return {
        effect: rowToSnapshot(effect),
        inventory,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error instanceof Error &&
        error.message === "Inventory does not contain enough items"
      ) {
        throw new BalsamResinError(
          "BALSAM_RESIN_NOT_OWNED",
          "You do not have any Giving Berry."
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async activeEffect(
    playerId: string
  ): Promise<BalsamResinEffectSnapshot | null> {
    const now = this.now();
    await expireEffects(this.pool, playerId, now);
    const result = await this.pool.query<EffectRow>(
      `SELECT effect_id, operation_key, player_id, started_at, ends_at, status,
              resin_consumed, hunting_district_preserved
       FROM balsam_resin_effects
       WHERE player_id = $1 AND status = 'active'`,
      [playerId]
    );
    return result.rows[0] ? rowToSnapshot(result.rows[0]) : null;
  }

  async finish(
    playerId: string,
    effectId: string,
    reason: "completed" | "death"
  ): Promise<void> {
    await this.pool.query(
      `UPDATE balsam_resin_effects
       SET status = $3,
           cleared_reason = $4,
           completed_at = clock_timestamp()
       WHERE effect_id = $1::uuid
         AND player_id = $2
         AND status = 'active'`,
      [
        effectId,
        playerId,
        reason === "completed" ? "completed" : "cleared",
        reason
      ]
    );
  }

  private async effectForOperation(
    queryable: Pick<pg.PoolClient, "query">,
    operationKey: string,
    playerId: string
  ): Promise<EffectRow | null> {
    const result = await queryable.query<EffectRow>(
      `SELECT effect_id, operation_key, player_id, started_at, ends_at, status,
              resin_consumed, hunting_district_preserved
       FROM balsam_resin_effects
       WHERE operation_key = $1`,
      [operationKey]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.player_id !== playerId) {
      throw new Error("Giving Berry request id conflicts with another player");
    }
    return row;
  }
}

async function expireEffects(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  now: Date
): Promise<void> {
  await queryable.query(
    `UPDATE balsam_resin_effects
     SET status = 'completed',
         cleared_reason = 'elapsed',
         completed_at = $2
     WHERE player_id = $1
       AND status = 'active'
       AND ends_at < $2`,
    [playerId, now]
  );
}

function rowToSnapshot(row: EffectRow): BalsamResinEffectSnapshot {
  return {
    effectId: row.effect_id,
    playerId: row.player_id,
    startedAt: iso(row.started_at),
    endsAt: iso(row.ends_at),
    resinConsumed: row.resin_consumed,
    huntingDistrictPreserved: row.hunting_district_preserved
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
