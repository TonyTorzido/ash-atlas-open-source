import type pg from "pg";
import { describe, expect, it } from "vitest";

import { createLogger } from "../logger.js";
import {
  DeveloperSpawnedPlantService,
  type DeveloperSpawnedPlantInput
} from "./developerSpawnedPlants.js";

type StoredRow = {
  entity_id: string;
  creator_player_id: string | null;
  request_id: string;
  plant_key: string;
  resource_type: string;
  quantity: number;
  region_code: string;
  zone_id: string;
  spawn_lat: number;
  spawn_lon: number;
  state: "available" | "harvested";
  state_revision: number;
  created_at: Date;
  harvested_at: Date | null;
  harvested_by_player_id: string | null;
};

describe("DeveloperSpawnedPlantService", () => {
  it("persists a Wild Flax spawn and returns the same entity for a matching retry", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedPlantService(pool.asPool(), createLogger("test"));

    const first = await service.spawn(input());
    const retried = await service.spawn(input());

    expect(first).toEqual(retried);
    expect(first).toMatchObject({
      entityId: expect.stringMatching(/^plant:dev:/),
      plantKey: "flax",
      resourceType: "flax_fiber",
      quantity: 3,
      state: "available",
      stateRevision: 0
    });
    expect(pool.rows).toHaveLength(1);
  });

  it("rejects a reused request id with a changed placement", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedPlantService(pool.asPool(), createLogger("test"));
    await service.spawn(input());

    await expect(service.spawn(input({ position: { lat: 35.2, lon: -106.5 } })))
      .rejects.toThrow("reused with different payload");
    expect(pool.rows).toHaveLength(1);
  });

  it("recovers durable rows after a new service instance and clears them explicitly", async () => {
    const pool = new FakePool([row({ entity_id: "plant:dev:recovered" })]);
    const recovered = await new DeveloperSpawnedPlantService(
      pool.asPool(),
      createLogger("test")
    ).recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      entityId: "plant:dev:recovered",
      plantKey: "flax",
      position: { lat: 35.1, lon: -106.6 },
      state: "available"
    });

    const removed = await new DeveloperSpawnedPlantService(
      pool.asPool(),
      createLogger("test")
    ).clearPersisted();
    expect(removed).toBe(1);
    expect(pool.rows).toHaveLength(0);
  });

  it("serializes spawn and clear so a concurrent clear cannot leave a row behind", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedPlantService(pool.asPool(), createLogger("test"));
    const spawnedPromise = service.spawn(input());
    const clearedPromise = service.clearPersisted();
    const [spawned, removed] = await Promise.all([spawnedPromise, clearedPromise]);

    expect(spawned.entityId).toMatch(/^plant:dev:/);
    expect(removed).toBe(1);
    expect(pool.rows).toHaveLength(0);
  });
});

function input(overrides: Partial<DeveloperSpawnedPlantInput> = {}): DeveloperSpawnedPlantInput {
  return {
    creatorPlayerId: "player-1",
    requestId: "spawn-1",
    plantKey: "flax",
    regionCode: "us-nm",
    zoneId: "world:us-nm",
    position: { lat: 35.1, lon: -106.6 },
    ...overrides
  };
}

function row(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    entity_id: "plant:dev:stored",
    creator_player_id: "player-1",
    request_id: "spawn-1",
    plant_key: "flax",
    resource_type: "flax_fiber",
    quantity: 3,
    region_code: "us-nm",
    zone_id: "world:us-nm",
    spawn_lat: 35.1,
    spawn_lon: -106.6,
    state: "available",
    state_revision: 0,
    created_at: new Date("2026-09-02T00:00:00.000Z"),
    harvested_at: null,
    harvested_by_player_id: null,
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
    if (text.includes("INSERT INTO developer_spawned_plants")) {
      const duplicate = this.rows.some((candidate) =>
        candidate.creator_player_id === values[1] && candidate.request_id === values[2]
      );
      if (!duplicate) {
        this.rows.push(row({
          entity_id: String(values[0]),
          creator_player_id: String(values[1]),
          request_id: String(values[2]),
          plant_key: String(values[3]),
          resource_type: String(values[4]),
          quantity: Number(values[5]),
          region_code: String(values[6]),
          zone_id: String(values[7]),
          spawn_lat: Number(values[8]),
          spawn_lon: Number(values[9])
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
    if (text.includes("DELETE FROM developer_spawned_plants")) {
      const rows = this.rows.map(({ entity_id }) => ({ entity_id })) as StoredRow[];
      const rowCount = this.rows.length;
      this.rows.splice(0);
      return { rows, rowCount };
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}
