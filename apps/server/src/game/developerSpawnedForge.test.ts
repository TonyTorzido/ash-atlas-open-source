import { describe, expect, it } from "vitest";
import { DUNGEON_CATALOG } from "@ash-atlas/shared";
import type pg from "pg";

import { DeveloperSpawnedDungeonService, type DeveloperSpawnedDungeonEntrance } from "./developerSpawnedDungeons.js";

describe("developer-placed Golem Forge snapshot", () => {
  it("carries the real price and Forge art, and is not a developerSpawned bypass", () => {
    const service = new DeveloperSpawnedDungeonService({} as pg.Pool);
    const templateId = "dungeon:golem_forge";
    const placement: DeveloperSpawnedDungeonEntrance = {
      entranceId: "dev-forge-1", creatorPlayerId: "p", requestId: "r", templateId, templateRevision: "t",
      templatePortalRevision: "tp", dungeonRevision: "d", catalogRevision: 1, placementRevision: 1, regionCode: "NM",
      position: { lat: 35, lon: -106 }, createdAt: new Date().toISOString(), deletedAt: null, expiresAt: null, eventKind: null
    };
    const snapshot = service.snapshotFor(placement);
    expect(snapshot.dungeonId).toBe("golem_forge");
    expect(snapshot.developerSpawned).toBe(false);
    expect(snapshot.access?.entryCost?.length).toBeGreaterThan(0);
    expect(snapshot.assetKey).toContain("golem_forge/entrance.png");
    expect(DUNGEON_CATALOG.dungeons.some((dungeon) => dungeon.id === "golem_forge")).toBe(true);
  });
});

import { dungeonServerMessageSchemas } from "../../../../packages/shared/src/protocol/dungeonServerSchemas.js";

describe("entrance wire schema", () => {
  it("keeps the access block so the client can open the torch lobby", () => {
    const service = new DeveloperSpawnedDungeonService({} as pg.Pool);
    const entrance = service.snapshotFor({
      entranceId: "dev-forge-2", creatorPlayerId: "p", requestId: "r", templateId: "dungeon:golem_forge", templateRevision: "t",
      templatePortalRevision: "tp", dungeonRevision: "d", catalogRevision: 1, placementRevision: 1, regionCode: "NM",
      position: { lat: 35, lon: -106 }, createdAt: new Date().toISOString(), deletedAt: null, expiresAt: null, eventKind: null
    });
    const parsed = dungeonServerMessageSchemas.DUNGEON_ENTRANCE_UPSERTED.parse({ type: "DUNGEON_ENTRANCE_UPSERTED", entrance });
    expect(parsed.entrance.access?.entryCost?.length).toBeGreaterThan(0);
  });
});
