import type pg from "pg";

import type { LichCombatSnapshot } from "./combat/combatEngine.js";
import type { RevenantMetalLichStore, StoredLich } from "./combat/revenantMetalUndead.js";

type LichRow = {
  owner_player_id: string;
  death_operation_key: string;
  stats: LichCombatSnapshot;
  current_health: number;
  expires_at: Date;
};

/** Postgres store for the Revenant armor Lich: one row per owner, written by the newest death. */
export class PostgresRevenantMetalLichStore implements RevenantMetalLichStore {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async load(ownerPlayerId: string): Promise<StoredLich | null> {
    const result = await this.pool.query<LichRow>(
      `SELECT owner_player_id, death_operation_key, stats, current_health, expires_at
       FROM player_revenant_metal_liches WHERE owner_player_id = $1`,
      [ownerPlayerId]
    );
    const row = result.rows[0];
    return row
      ? {
          ownerPlayerId: row.owner_player_id,
          deathOperationKey: row.death_operation_key,
          snapshot: row.stats,
          currentHealth: Number(row.current_health),
          expiresAt: row.expires_at.getTime()
        }
      : null;
  }

  async replace(lich: StoredLich): Promise<void> {
    await this.pool.query(
      `INSERT INTO player_revenant_metal_liches (
         owner_player_id, death_operation_key, stats, max_health, current_health, expires_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, to_timestamp($6 / 1000.0))
       ON CONFLICT (owner_player_id) DO UPDATE SET
         death_operation_key = EXCLUDED.death_operation_key,
         stats = EXCLUDED.stats,
         max_health = EXCLUDED.max_health,
         current_health = EXCLUDED.current_health,
         expires_at = EXCLUDED.expires_at,
         created_at = now(),
         updated_at = now()`,
      [lich.ownerPlayerId, lich.deathOperationKey, JSON.stringify(lich.snapshot),
        lich.snapshot.maxHealth, lich.currentHealth, lich.expiresAt]
    );
  }

  async updateHealth(ownerPlayerId: string, deathOperationKey: string, currentHealth: number): Promise<void> {
    await this.pool.query(
      `UPDATE player_revenant_metal_liches
       SET current_health = LEAST(max_health, GREATEST(1, $3::integer)), updated_at = now()
       WHERE owner_player_id = $1 AND death_operation_key = $2`,
      [ownerPlayerId, deathOperationKey, Math.trunc(currentHealth)]
    );
  }

  async remove(ownerPlayerId: string, deathOperationKey: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM player_revenant_metal_liches WHERE owner_player_id = $1 AND death_operation_key = $2`,
      [ownerPlayerId, deathOperationKey]
    );
  }
}
