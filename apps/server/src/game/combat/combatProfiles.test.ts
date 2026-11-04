import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import { CombatProfileService } from "./combatProfiles.js";

describe("CombatProfileService", () => {
  it("loads or creates one durable profile with server-owned defaults", async () => {
    const query = vi.fn<(
      sql: string,
      parameters?: unknown[]
    ) => Promise<{ rows: Array<Record<string, string | number>> }>>();
    query.mockResolvedValue({
      rows: [{
        player_id: "p1",
        max_health: 100,
        current_health: 100,
        base_attack_damage: 10,
        persistence_version: 7,
        life_state: "respawning",
        death_penalty_operation_key: "player-death:persisted",
        respawn_available_at: "2026-08-30T06:00:10.000Z"
      }]
    });
    const service = new CombatProfileService(
      { query } as unknown as pg.Pool,
      loadConfig({ NODE_ENV: "test" })
    );
    await expect(service.getOrCreate("p1")).resolves.toEqual({
      playerId: "p1",
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10,
      persistenceVersion: 7,
      lifeState: "respawning",
      downedUntil: null,
      deathPenaltyOperationKey: "player-death:persisted",
      respawnAvailableAt: new Date("2026-08-30T06:00:10.000Z").getTime()
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("checkpoints multiple dirty profiles in one database statement", async () => {
    const query = vi.fn<(
      sql: string,
      parameters?: unknown[]
    ) => Promise<{ rows: Array<Record<string, string | number>> }>>();
    query.mockResolvedValue({ rows: [{ player_id: "p1" }, { player_id: "p2" }] });
    const service = new CombatProfileService(
      { query } as unknown as pg.Pool,
      loadConfig({ NODE_ENV: "test" })
    );
    await service.persistProfiles([
      { playerId: "p1", maxHealth: 100, currentHealth: 0, baseAttackDamage: 10,
        persistenceVersion: 1, lifeState: "downed", downedUntil: 110_000 },
      { playerId: "p2", maxHealth: 100, currentHealth: 80, baseAttackDamage: 10, persistenceVersion: 2 }
    ]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (player_id) DO UPDATE");
    expect(query.mock.calls[0]?.[0]).toContain("persistence_version <= EXCLUDED.persistence_version");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "p1", 100, 0, 10, 1, "downed", new Date(110_000).toISOString(), null, null,
      "p2", 100, 80, 10, 2, "alive", null, null, null
    ]);
  });

  it("continues bounded batches when one profile batch fails", async () => {
    const query = vi.fn();
    query
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ rows: [{ player_id: "p2" }] });
    const service = new CombatProfileService(
      { query } as unknown as pg.Pool,
      loadConfig({
        NODE_ENV: "test",
        COMBAT_PERSISTENCE_BATCH_SIZE: "1",
        COMBAT_PERSISTENCE_CONCURRENCY: "1"
      })
    );
    const result = await service.persistProfiles([
      { playerId: "p1", maxHealth: 100, currentHealth: 90, baseAttackDamage: 10, persistenceVersion: 1 },
      { playerId: "p2", maxHealth: 100, currentHealth: 80, baseAttackDamage: 10, persistenceVersion: 2 }
    ]);

    expect(result.failed.map((profile) => profile.playerId)).toEqual(["p1"]);
    expect(result.persisted.map((profile) => profile.playerId)).toEqual(["p2"]);
  });
});
