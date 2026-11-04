import { describe, expect, it } from "vitest";
import { DUNGEON_CATALOG, dungeonCatalogValidationIssues, MOB_ARCHETYPE_KEYS, RUNTIME_PNG_ASSET_REGISTRY } from "@ash-atlas/shared";
import { archiveCreatorDungeon, saveDungeonWorldEntrance, dungeonAssetId, resourceShapeFromZone, createDungeonFromWizard, createDungeonResourceSpawnZone } from "./dungeonStudioV2.js";

describe("creator readiness regressions", () => {
  it("retains the editable slime example without custom bitmap art or world placement", () => {
    const example = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.name === "Example - Slime Dungeon Template")!;
    expect(example.retired).toBe(false);
    expect(DUNGEON_CATALOG.entrances.filter((entrance) => entrance.dungeonId === example.id).every((entrance) => entrance.retired)).toBe(true);
    expect(example.portals.filter((portal) => portal.source.kind === "world").every((portal) => !portal.enabled)).toBe(true);
    expect(example.encounters[0]!.waves).toHaveLength(2);
    expect(example.rooms[0]!.mobs.filter((mob) => mob.summonAtHealthPercent === 50)).toHaveLength(3);
    expect(example.rooms[0]!.resourceSpawnZones).toHaveLength(1);
    const reward = DUNGEON_CATALOG.rewardTables.find((table) => table.id === example.rewardTableIds[0])!;
    expect(reward.chestLoot!.rarities).toHaveLength(5);
    expect(reward.chestLoot!.rarities.every((rarity) => !rarity.assetKey)).toBe(true);
  });
  it("copies strict polygon geometry from a room zone into a saveable resource zone", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const room = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[0]!;
    const drawn = { id: "drawn", retired: false, kind: "polygon" as const, purpose: "trigger" as const, points: [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 250, y: 400 }] };
    room.zones.push(drawn);
    const shape = resourceShapeFromZone(drawn, "ore_polygon");
    room.resourceSpawnZones = [createDungeonResourceSpawnZone({ id: "ore_polygon", shape, resourceTypes: ["ore"], minCount: 2, maxCount: 4, seed: 1, interactionRadius: 72, minimumSpacing: 20, resetOnRun: true, respawnSeconds: null })];
    expect(shape).not.toHaveProperty("purpose");
    expect(shape).not.toBe(drawn);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
  });

  it("bounds all rarity art IDs and resolves collisions for maximum accepted dungeon names", () => {
    const used: string[] = [];
    expect(dungeonAssetId(`${"a".repeat(55)}_trailing_boundary`, [])).toMatch(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
    for (const rarity of ["common", "uncommon", "rare", "epic", "legendary"]) {
      for (let index = 0; index < 3; index++) {
        const id = dungeonAssetId(`chest_${rarity}_${"very_long_dungeon_".repeat(8)}_treasure_chest`, used);
        expect(id.length).toBeLessThanOrEqual(64);
        expect(id).toMatch(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
        expect(used).not.toContain(id); used.push(id);
      }
    }
  });

  it("archives a saved creator dungeon without deleting identities or changing stock content", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const stock = structuredClone(catalog.dungeons.find((entry) => entry.id === "cistern_warrens"));
    const created = createDungeonFromWizard(catalog, { name: "Creator Archive", themeId: "stone", backgroundColor: "#071116", floorColor: "#182a2d", wallColor: "#405052", accentColor: "#8fbc8f", instancePolicy: "party_ephemeral", resetPolicy: "when_empty", width: 1000, height: 1000 });
    catalog.dungeons.push(created);
    saveDungeonWorldEntrance(catalog, created.id, { name: "Archive fixture entrance", description: "Temporary test", lat: 40, lon: -105, assetKey: "apps/client/public/assets/dungeons/shared/orc-cave-entrance.png" });
    const entranceId = catalog.entrances.find((entrance) => entrance.dungeonId === created.id)!.id;
    archiveCreatorDungeon(catalog, created.id);
    expect(created.retired).toBe(true);
    expect(catalog.entrances.find((entrance) => entrance.id === entranceId)).toMatchObject({ retired: true });
    expect(created.rooms).not.toHaveLength(0);
    expect(catalog.dungeons.find((entry) => entry.id === "cistern_warrens")).toEqual(stock);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    expect(() => archiveCreatorDungeon(catalog, "cistern_warrens")).toThrow(/stock Cistern Warrens/);
  });

  it("offers both slime identities and independent missing-art registration", () => {
    expect(MOB_ARCHETYPE_KEYS).toContain("slime");
    expect(MOB_ARCHETYPE_KEYS).toContain("slime_miniboss");
    for (const key of ["slime", "slime_miniboss"]) expect(RUNTIME_PNG_ASSET_REGISTRY.some((entry) => entry.relativeFile.endsWith(`/mobs/dungeon/${key}.png`))).toBe(true);
  });

});
