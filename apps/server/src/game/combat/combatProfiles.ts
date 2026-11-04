import type pg from "pg";

import type { AppConfig } from "../../config.js";
import type { DirtyCombatProfile, PlayerCombatProfile } from "./combatEngine.js";

type CombatProfileRow = {
  player_id: string;
  max_health: number;
  current_health: number;
  base_attack_damage: number;
  persistence_version: string | number;
  life_state: "alive" | "downed" | "defeated" | "respawning";
  downed_until: Date | string | null;
  death_penalty_operation_key: string | null;
  respawn_available_at: Date | string | null;
};

export type CombatProfilePersistenceResult = {
  persisted: DirtyCombatProfile[];
  failed: DirtyCombatProfile[];
};

export class CombatProfileService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig
  ) {}

  async getOrCreate(playerId: string): Promise<PlayerCombatProfile> {
    const result = await this.pool.query<CombatProfileRow>(
      `
      INSERT INTO player_combat_profiles (
        player_id, max_health, current_health, base_attack_damage
      )
      VALUES ($1, $2, $2, $3)
      ON CONFLICT (player_id) DO UPDATE
      SET player_id = EXCLUDED.player_id
      RETURNING player_id, max_health, current_health, base_attack_damage, persistence_version,
        life_state, downed_until, death_penalty_operation_key, respawn_available_at
      `,
      [
        playerId,
        this.config.COMBAT_PLAYER_MAX_HEALTH,
        this.config.COMBAT_PLAYER_BASIC_DAMAGE
      ]
    );
    return rowToProfile(requireRow(result.rows[0]));
  }

  async persistProfiles(profiles: DirtyCombatProfile[]): Promise<CombatProfilePersistenceResult> {
    if (profiles.length === 0) {
      return { persisted: [], failed: [] };
    }
    const batches = chunk(profiles, this.config.COMBAT_PERSISTENCE_BATCH_SIZE);
    const persisted: DirtyCombatProfile[] = [];
    const failed: DirtyCombatProfile[] = [];
    let nextBatch = 0;
    const workers = Array.from(
      { length: Math.min(this.config.COMBAT_PERSISTENCE_CONCURRENCY, batches.length) },
      async () => {
        while (nextBatch < batches.length) {
          const batch = batches[nextBatch++];
          if (!batch) {
            continue;
          }
          try {
            const persistedIds = await this.persistBatch(batch);
            for (const profile of batch) {
              if (persistedIds.has(profile.playerId)) {
                persisted.push(profile);
              } else {
                failed.push(profile);
              }
            }
          } catch {
            failed.push(...batch);
          }
        }
      }
    );
    await Promise.all(workers);
    return { persisted, failed };
  }

  private async persistBatch(profiles: DirtyCombatProfile[]): Promise<Set<string>> {
    const values: string[] = [];
    const parameters: Array<string | number | null> = [];
    for (const [index, profile] of profiles.entries()) {
      const offset = index * 9;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
      );
      parameters.push(
        profile.playerId,
        profile.maxHealth,
        profile.currentHealth,
        profile.baseAttackDamage,
        profile.persistenceVersion,
        profile.lifeState ?? "alive",
        profile.downedUntil ? new Date(profile.downedUntil).toISOString() : null,
        profile.deathPenaltyOperationKey ?? null,
        profile.respawnAvailableAt !== null && profile.respawnAvailableAt !== undefined
          ? new Date(profile.respawnAvailableAt).toISOString()
          : null
      );
    }
    const result = await this.pool.query<{ player_id: string }>(
      `
      INSERT INTO player_combat_profiles (
        player_id, max_health, current_health, base_attack_damage, persistence_version, life_state,
        downed_until, death_penalty_operation_key, respawn_available_at
      )
      VALUES ${values.join(", ")}
      ON CONFLICT (player_id) DO UPDATE
      SET max_health = EXCLUDED.max_health,
          current_health = EXCLUDED.current_health,
          base_attack_damage = EXCLUDED.base_attack_damage,
          persistence_version = EXCLUDED.persistence_version,
          life_state = EXCLUDED.life_state,
          downed_until = EXCLUDED.downed_until,
          death_penalty_operation_key = EXCLUDED.death_penalty_operation_key,
          respawn_available_at = EXCLUDED.respawn_available_at
      WHERE player_combat_profiles.persistence_version <= EXCLUDED.persistence_version
      RETURNING player_id
      `,
      parameters
    );
    return new Set(result.rows.map((row) => row.player_id));
  }
}

function rowToProfile(row: CombatProfileRow): PlayerCombatProfile {
  return {
    playerId: row.player_id,
    maxHealth: Number(row.max_health),
    currentHealth: Number(row.current_health),
    baseAttackDamage: Number(row.base_attack_damage),
    persistenceVersion: Number(row.persistence_version),
    lifeState: row.life_state ?? "alive",
    downedUntil: row.downed_until ? new Date(row.downed_until).getTime() : null,
    deathPenaltyOperationKey: row.death_penalty_operation_key,
    respawnAvailableAt: row.respawn_available_at
      ? new Date(row.respawn_available_at).getTime()
      : null
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function requireRow(row: CombatProfileRow | undefined): CombatProfileRow {
  if (!row) {
    throw new Error("combat profile query did not return a row");
  }
  return row;
}
