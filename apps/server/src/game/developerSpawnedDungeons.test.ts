import {
  DUNGEON_CATALOG,
  developerDungeonEntranceTemplates,
  type DungeonCatalog
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  DeveloperSpawnedDungeonService,
  type DeveloperSpawnedDungeonInput
} from "./developerSpawnedDungeons.js";

type StoredRow = {
  entrance_id: string;
  creator_player_id: string | null;
  request_id: string;
  template_id: string;
  template_revision: string;
  template_portal_revision: string;
  dungeon_revision: string;
  catalog_revision: number;
  placement_revision: number;
  region_code: string;
  spawn_lat: number;
  spawn_lon: number;
  created_at: Date;
  deleted_at: Date | null;
};

const SLIME_DUNGEON_ID = "readiness_tomorrow_slime_2026_09_20_long_accepted_name";

describe("DeveloperSpawnedDungeonService", () => {
  it("persists a catalog template as a durable dynamic entrance", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedDungeonService(pool.asPool());

    const result = await service.spawn(input());
    const snapshot = service.snapshotFor(result.entrance);

    expect(result.replayed).toBe(false);
    expect(result.entrance.entranceId).toMatch(/^dev-dungeon-/);
    expect(snapshot).toMatchObject({
      entranceId: result.entrance.entranceId,
      templateId: "cistern_warrens_world_entrance",
      developerSpawned: true,
      portalId: `dungeon:${result.entrance.entranceId}:world-to-entrance`,
      regionCode: "world_v1_lat35_lon-107"
    });
    expect(pool.rows).toHaveLength(1);
  });

  it("replays matching requests and rejects a changed payload", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedDungeonService(pool.asPool());
    const first = await service.spawn(input());

    const replay = await service.spawn(input());
    expect(replay).toEqual({ entrance: first.entrance, replayed: true });
    expect(pool.rows).toHaveLength(1);

    await expect(service.spawn(input({ position: { lat: 35.2, lon: -106.6 } })))
      .rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
    expect(pool.rows).toHaveLength(1);
  });

  it("replays after a template is retired while keeping the stored revisions", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const service = new DeveloperSpawnedDungeonService(new FakePool().asPool(), catalog);
    const first = await service.spawn(input());
    catalog.entrances[0]!.retired = true;

    const replay = await service.spawn(input());

    expect(replay).toEqual({ entrance: first.entrance, replayed: true });
  });

  it("tombstones placements, filters them from active discovery, and replays deletion", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedDungeonService(pool.asPool());
    const first = await service.spawn(input());

    const deleted = await service.delete("player-1", "delete-1", first.entrance.entranceId);
    expect(deleted.replayed).toBe(false);
    expect(deleted.entrance.deletedAt).not.toBeNull();
    expect(await service.listActive()).toEqual([]);

    const replay = await service.delete("player-1", "delete-1", first.entrance.entranceId);
    expect(replay).toEqual({ entrance: deleted.entrance, replayed: true });

    await expect(service.delete("player-1", "delete-1", "other-entrance"))
      .rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  });

  it("spawns and deletes an entrance for a dungeon without an authored template", async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedDungeonService(pool.asPool());
    const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === SLIME_DUNGEON_ID)!;
    expect(DUNGEON_CATALOG.entrances.some((entrance) => entrance.dungeonId === SLIME_DUNGEON_ID && !entrance.retired))
      .toBe(false);

    const spawned = await service.spawn(input({ templateId: `dungeon:${SLIME_DUNGEON_ID}` }));
    const snapshot = service.snapshotFor(spawned.entrance);

    expect(snapshot).toMatchObject({
      dungeonId: SLIME_DUNGEON_ID,
      name: dungeon.name,
      portalId: `dungeon:${spawned.entrance.entranceId}:${dungeon.entrance.portalId}`,
      assetKey: null,
      developerSpawned: true
    });
    expect(await service.listActive()).toHaveLength(1);
    const deleted = await service.delete("player-1", "delete-1", spawned.entrance.entranceId);
    expect(deleted.entrance.deletedAt).not.toBeNull();
    expect(await service.listActive()).toEqual([]);
  });

  it('spawns every dungeon, including the retired world entrances, from the dev menu', async () => {
    const pool = new FakePool();
    const service = new DeveloperSpawnedDungeonService(pool.asPool());
    for (const dungeonId of ["cistern_warrens", "fangrock_cavern", "the_eyrie", "blightwood_grove", "wyrm_hollow"]) {
      const template = developerDungeonEntranceTemplates(DUNGEON_CATALOG).find((candidate) => candidate.dungeonId === dungeonId);
      expect(template, dungeonId).toBeDefined();
      const spawned = await service.spawn(input({ templateId: template!.id, requestId: "req-" + dungeonId }));
      const snapshot = service.snapshotFor(spawned.entrance);
      expect(snapshot).toMatchObject({ dungeonId, developerSpawned: true });
      expect(snapshot.lat).toBe(spawned.entrance.position.lat);
    }
    expect(await service.listActive()).toHaveLength(5);
  });

  it("rejects unknown and retired-dungeon derived templates", async () => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const service = new DeveloperSpawnedDungeonService(new FakePool().asPool(), catalog);
    await expect(service.spawn(input({ templateId: "dungeon:missing" })))
      .rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    catalog.dungeons.find((candidate) => candidate.id === SLIME_DUNGEON_ID)!.retired = true;
    await expect(service.spawn(input({ templateId: `dungeon:${SLIME_DUNGEON_ID}` })))
      .rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("does not treat authored catalog IDs as deletable placements", async () => {
    const service = new DeveloperSpawnedDungeonService(new FakePool().asPool());

    await expect(service.delete("player-1", "delete-1", "cistern_warrens_world_entrance"))
      .rejects.toMatchObject({ code: "ENTRANCE_NOT_FOUND" });
  });
});

function input(overrides: Partial<DeveloperSpawnedDungeonInput> = {}): DeveloperSpawnedDungeonInput {
  return {
    creatorPlayerId: "player-1",
    requestId: "spawn-1",
    templateId: "cistern_warrens_world_entrance",
    regionCode: "world_v1_lat35_lon-107",
    position: { lat: 35.1, lon: -106.6 },
    ...overrides
  };
}

class FakePool {
  readonly rows: StoredRow[] = [];
  readonly deletions: Array<{ actor_player_id: string; request_id: string; entrance_id: string }> = [];

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<{
    rows: StoredRow[];
    rowCount: number;
  }> {
    if (text.includes("INSERT INTO developer_spawned_dungeon_entrances")) {
      const duplicate = this.rows.some((candidate) =>
        candidate.creator_player_id === values[1] && candidate.request_id === values[2]
      );
      if (!duplicate) {
        this.rows.push({
          entrance_id: String(values[0]),
          creator_player_id: String(values[1]),
          request_id: String(values[2]),
          template_id: String(values[3]),
          template_revision: String(values[4]),
          template_portal_revision: String(values[5]),
          dungeon_revision: String(values[6]),
          catalog_revision: Number(values[7]),
          placement_revision: 1,
          region_code: String(values[8]),
          spawn_lat: Number(values[9]),
          spawn_lon: Number(values[10]),
          created_at: new Date("2026-09-07T00:00:00.000Z"),
          deleted_at: null
        });
      }
      return { rows: [], rowCount: duplicate ? 0 : 1 };
    }
    if (text.includes("WHERE creator_player_id=$1 AND request_id=$2")) {
      const rows = this.rows.filter((candidate) =>
        candidate.creator_player_id === values[0] && candidate.request_id === values[1]
      );
      return { rows, rowCount: rows.length };
    }
    if (text.includes("WHERE deleted_at IS NULL")) {
      const rows = this.rows.filter((candidate) => candidate.deleted_at === null);
      return { rows, rowCount: rows.length };
    }
    if (text.includes("WHERE entrance_id=$1")) {
      const row = this.rows.find((candidate) => candidate.entrance_id === values[0]);
      const includeDeleted = values[1] === true;
      const rows = row && (includeDeleted || row.deleted_at === null) ? [row] : [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  async connect(): Promise<FakeClient> {
    return new FakeClient(this);
  }
}

class FakeClient {
  constructor(private readonly pool: FakePool) {}

  async query(text: string, values: readonly unknown[] = []): Promise<{
    rows: StoredRow[] | Array<{ entrance_id: string }>;
    rowCount: number;
  }> {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("FROM developer_spawned_dungeon_entrance_deletions")) {
      const rows = this.pool.deletions
        .filter((candidate) => candidate.actor_player_id === values[0] && candidate.request_id === values[1])
        .map((candidate) => ({ entrance_id: candidate.entrance_id }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM developer_spawned_dungeon_entrances") && text.includes("FOR UPDATE")) {
      const row = this.pool.rows.find((candidate) => candidate.entrance_id === values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes("UPDATE developer_spawned_dungeon_entrances")) {
      const row = this.pool.rows.find((candidate) => candidate.entrance_id === values[0]);
      if (row) row.deleted_at = new Date("2026-09-07T00:01:00.000Z");
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (text.includes("INSERT INTO developer_spawned_dungeon_entrance_deletions")) {
      this.pool.deletions.push({
        actor_player_id: String(values[0]),
        request_id: String(values[1]),
        entrance_id: String(values[2])
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SELECT entrance_id,creator_player_id,request_id")) {
      const row = this.pool.rows.find((candidate) => candidate.entrance_id === values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Unexpected client query: ${text}`);
  }

  release(): void {}
}
