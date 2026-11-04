import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.js";
import { CombatEngine } from "./combat/combatEngine.js";
import {
  DeveloperSpawnedMobService,
  type DeveloperSpawnedMobInput
} from "./developerSpawnedMobs.js";

type StoredRow = {
  entity_id: string;
  creator_player_id: string | null;
  request_id: string;
  mob_archetype: string;
  appearance_variant: string;
  region_code: string;
  zone_id: string;
  spawn_lat: number;
  spawn_lon: number;
  origin_flag_id: string | null;
  created_at: Date;
};

describe("DeveloperSpawnedMobService", () => {
  it("persists a first spawn before creating its combat projection", async () => {
    const pool = new FakePool();
    const combat = engine();
    const realSpawn = combat.spawnMob.bind(combat);
    const spawn = vi.spyOn(combat, "spawnMob").mockImplementation((input) => {
      expect(pool.rows).toHaveLength(1);
      return realSpawn(input);
    });
    const service = new DeveloperSpawnedMobService(pool.asPool(), combat, createLogger("test"));

    const mob = await service.spawn(input());

    expect(mob.entityId).toMatch(/^mob:dev:/);
    expect(spawn).toHaveBeenCalledOnce();
    expect(pool.rows[0]).toMatchObject({ entity_id: mob.entityId, mob_archetype: "wolf" });
    expect(service.owns(mob.entityId)).toBe(true);
  });

  it("returns the same entity for a matching request retry without a duplicate projection", async () => {
    const pool = new FakePool();
    const combat = engine();
    const spawn = vi.spyOn(combat, "spawnMob");
    const service = new DeveloperSpawnedMobService(pool.asPool(), combat, createLogger("test"));

    const first = await service.spawn(input());
    const retried = await service.spawn(input());

    expect(retried).toEqual(first);
    expect(pool.rows).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("rejects a request retry whose payload changed", async () => {
    const pool = new FakePool();
    const combat = engine();
    const service = new DeveloperSpawnedMobService(pool.asPool(), combat, createLogger("test"));
    await service.spawn(input());

    await expect(service.spawn(input({ archetype: "goblin" })))
      .rejects.toThrow("reused with different payload");

    expect(pool.rows).toHaveLength(1);
  });

  it("recovers the exact entity id, species, home, region, zone, and origin", async () => {
    const pool = new FakePool([row({
      entity_id: "mob:dev:recovered",
      appearance_variant: "ashen"
    })]);
    const combat = engine();
    const spawn = vi.spyOn(combat, "spawnMob");
    const service = new DeveloperSpawnedMobService(pool.asPool(), combat, createLogger("test"));

    await service.recover();

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      entityId: "mob:dev:recovered",
      archetype: "wolf",
      worldAi: true,
      position: { lat: 35.1, lon: -106.6 },
      homePosition: { lat: 35.1, lon: -106.6 },
      regionCode: "us-nm",
      zoneId: "world:us-nm",
      originFlagId: "11111111-1111-4111-8111-111111111111"
    }));
    expect(service.owns("mob:dev:recovered")).toBe(true);
  });

  it("removes a defeated row so a later service cannot recover it", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedMobService(pool.asPool(), engine(), createLogger("test"));
    const spawned = await service.spawn(input());

    await service.removeAfterDefeat(spawned.entityId);
    const recoveredCombat = engine();
    await new DeveloperSpawnedMobService(
      pool.asPool(),
      recoveredCombat,
      createLogger("test")
    ).recover();

    expect(service.owns(spawned.entityId)).toBe(false);
    expect(pool.rows).toHaveLength(0);
    expect(recoveredCombat.entity(spawned.entityId)).toBeNull();
  });

  it("clears every persistent developer mob", async () => {
    const pool = new FakePool();
    const combat = engine();
    const service = new DeveloperSpawnedMobService(pool.asPool(), combat, createLogger("test"));
    const first = await service.spawn(input());
    const second = await service.spawn(input({
      requestId: "spawn-2",
      position: { lat: 35.2, lon: -106.5 }
    }));

    const removedCount = await service.clearPersisted();

    expect(removedCount).toBe(2);
    expect(pool.rows).toHaveLength(0);
    expect(service.owns(first.entityId)).toBe(false);
    expect(combat.entity(first.entityId)).toBeNull();
    expect(combat.entity(second.entityId)).toBeNull();
  });

  it("serializes a spawn followed concurrently by clear without leaving an orphan projection", async () => {
    const pool = new FakePool();
    const combat = engine();
    const service = new DeveloperSpawnedMobService(pool.asPool(), combat, createLogger("test"));

    const spawnedPromise = service.spawn(input());
    const clearedPromise = service.clearPersisted();
    const [spawned, cleared] = await Promise.all([spawnedPromise, clearedPromise]);

    expect(cleared).toBe(1);
    expect(pool.rows).toHaveLength(0);
    expect(combat.entity(spawned.entityId)).toBeNull();
    expect(service.owns(spawned.entityId)).toBe(false);
  });

  it("restores a normal ineligible mob without an explicit appearance override", async () => {
    const pool = new FakePool([row({
      entity_id: "mob:dev:dummy",
      mob_archetype: "training_dummy",
      appearance_variant: "normal"
    })]);
    const combat = engine();
    const spawn = vi.spyOn(combat, "spawnMob");

    await new DeveloperSpawnedMobService(
      pool.asPool(),
      combat,
      createLogger("test")
    ).recover();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![0]).not.toHaveProperty("appearanceVariant");
    expect(combat.entity("mob:dev:dummy")?.appearanceVariant).toBe("normal");
  });

  it("restores a retired persisted Ashen row as a normal mob", async () => {
    const pool = new FakePool([row({
      entity_id: "mob:dev:ashen",
      appearance_variant: "ashen"
    })]);
    const combat = engine();

    await new DeveloperSpawnedMobService(
      pool.asPool(),
      combat,
      createLogger("test")
    ).recover();

    expect(combat.entity("mob:dev:ashen")).toMatchObject({
      archetypeKey: "wolf",
      appearanceVariant: "normal"
    });
  });

  it("rejects a new developer spawn that asks for the retired Ashen appearance", async () => {
    const service = new DeveloperSpawnedMobService(new FakePool().asPool(), engine(), createLogger("test"));
    await expect(service.spawn(input({ appearanceVariant: "ashen" }))).rejects.toThrow("retired");
  });
});

function engine(): CombatEngine {
  return new CombatEngine({ tickRateHz: 20 });
}

function input(overrides: Partial<DeveloperSpawnedMobInput> = {}): DeveloperSpawnedMobInput {
  return {
    creatorPlayerId: "player-1",
    requestId: "spawn-1",
    archetype: "wolf",
    regionCode: "us-nm",
    zoneId: "world:us-nm",
    position: { lat: 35.1, lon: -106.6 },
    originFlagId: "11111111-1111-4111-8111-111111111111",
    ...overrides
  };
}

function row(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    entity_id: "mob:dev:stored",
    creator_player_id: "player-1",
    request_id: "spawn-1",
    mob_archetype: "wolf",
    appearance_variant: "normal",
    region_code: "us-nm",
    zone_id: "world:us-nm",
    spawn_lat: 35.1,
    spawn_lon: -106.6,
    origin_flag_id: "11111111-1111-4111-8111-111111111111",
    created_at: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides
  };
}

class FakePool {
  readonly rows: StoredRow[];

  constructor(rows: StoredRow[] = []) {
    this.rows = rows;
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<{
    rows: StoredRow[];
    rowCount: number;
  }> {
    if (text.includes("INSERT INTO developer_spawned_mobs")) {
      const duplicate = this.rows.some((candidate) =>
        candidate.creator_player_id === values[1] && candidate.request_id === values[2]
      );
      if (!duplicate) {
        this.rows.push(row({
          entity_id: String(values[0]),
          creator_player_id: String(values[1]),
          request_id: String(values[2]),
          mob_archetype: String(values[3]),
          appearance_variant: String(values[4]),
          region_code: String(values[5]),
          zone_id: String(values[6]),
          spawn_lat: Number(values[7]),
          spawn_lon: Number(values[8]),
          origin_flag_id: values[9] === null ? null : String(values[9])
        }));
      }
      return { rows: [], rowCount: duplicate ? 0 : 1 };
    }
    if (text.includes("WHERE creator_player_id=$1 AND request_id=$2")) {
      const rows = this.rows.filter((candidate) =>
        candidate.creator_player_id === values[0] && candidate.request_id === values[1]
      );
      return { rows, rowCount: rows.length };
    }
    if (text.includes("ORDER BY created_at,entity_id")) {
      return { rows: [...this.rows], rowCount: this.rows.length };
    }
    if (text.includes("DELETE FROM developer_spawned_mobs WHERE entity_id=$1")) {
      const index = this.rows.findIndex((candidate) => candidate.entity_id === values[0]);
      if (index >= 0) this.rows.splice(index, 1);
      return { rows: [], rowCount: index >= 0 ? 1 : 0 };
    }
    if (text.includes("DELETE FROM developer_spawned_mobs")) {
      const rows = this.rows.map(({ entity_id }) => ({ entity_id })) as StoredRow[];
      const rowCount = this.rows.length;
      this.rows.splice(0);
      return { rows, rowCount };
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}
