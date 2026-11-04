import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DUNGEON_CATALOG as SHARED_DUNGEON_CATALOG,
  INTERIOR_DATA_RELATIVE_DIR,
  MANOR_DOOR,
  dungeonCatalogFromInterior,
  interiorCatalogValidationIssues,
  interiorNavigation,
  manorPortalRecordId,
  manorRuntimePortalId,
  manorSpacesOf,
  parseDungeonCatalog,
  type DungeonCatalog
} from "@ash-atlas/shared";

import { readDungeonInteriorFiles } from "./dungeonInteriorStore.js";
import { scaffoldDungeon } from "./dungeonScaffold.js";
import { applyInteriorWrites, planInteriorSpaceWrites } from "./interiorCatalogStore.js";
import { InteriorScaffoldError, scaffoldInterior } from "./interiorScaffold.js";

const specDirectory = new URL("../../../tools/appearance-studio/interior-specs/", import.meta.url);
const readSpec = (name: string): Record<string, any> => JSON.parse(readFileSync(new URL(name, specDirectory), "utf8"));
const dataDirectory = path.join(fileURLToPath(new URL("../../../", import.meta.url)), INTERIOR_DATA_RELATIVE_DIR);

/** Dungeons that use the dungeon_ogre boss template; the fixtures below strip them with it. */
const OGRE_DUNGEONS = new Set(["ashen_crypt", "fangrock_cavern", "the_eyrie", "blightwood_grove", "wyrm_hollow"]);
const isOgreDungeonReward = (id: string): boolean => [...OGRE_DUNGEONS].some((dungeon) => id.startsWith(`${dungeon}_`));

/** The example crypt spec scaffolds the Ashen Crypt, so work from the catalog as it was before that dungeon existed. */
const DUNGEON_CATALOG: DungeonCatalog = {
  ...SHARED_DUNGEON_CATALOG,
  entrances: SHARED_DUNGEON_CATALOG.entrances.filter((entrance) => !OGRE_DUNGEONS.has(entrance.dungeonId)),
  dungeons: SHARED_DUNGEON_CATALOG.dungeons.filter((dungeon) => !OGRE_DUNGEONS.has(dungeon.id)),
  rewardTables: SHARED_DUNGEON_CATALOG.rewardTables.filter((table) => !isOgreDungeonReward(table.id)),
  rewardTableIds: SHARED_DUNGEON_CATALOG.rewardTableIds.filter((id) => !isOgreDungeonReward(id)),
  bossTemplates: SHARED_DUNGEON_CATALOG.bossTemplates.filter((boss) => boss.id !== "dungeon_ogre"),
  bossTemplateIds: SHARED_DUNGEON_CATALOG.bossTemplateIds.filter((id) => id !== "dungeon_ogre")
};

async function current() {
  const { interior } = await readDungeonInteriorFiles(dataDirectory);
  const { library } = interior;
  return {
    library: {
      ...library,
      entrances: library.entrances.filter((entrance) => !OGRE_DUNGEONS.has(entrance.dungeonId)),
      rewardTables: library.rewardTables.filter((table) => !isOgreDungeonReward(table.id)),
      rewardTableIds: library.rewardTableIds.filter((id) => !isOgreDungeonReward(id)),
      bossTemplates: library.bossTemplates.filter((boss) => boss.id !== "dungeon_ogre"),
      bossTemplateIds: library.bossTemplateIds.filter((id) => id !== "dungeon_ogre")
    },
    spaces: interior.spaces.filter((space) => !OGRE_DUNGEONS.has(space.id))
  };
}

function issuesOf(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof InteriorScaffoldError) return error.issues.join("\n");
    throw error;
  }
  throw new Error("expected the spec to be rejected");
}

describe("interior scaffolder: dungeon kind", () => {
  it("projects through the dungeon view to what the dungeon scaffolder produces", async () => {
    const interior = await current();
    const spec = readSpec("example-crypt.json");
    const legacy = scaffoldDungeon(DUNGEON_CATALOG, spec).catalog.dungeons.find((entry) => entry.id === "ashen_crypt")!;
    const result = scaffoldInterior(interior, "dungeon", spec);
    const projected = parseDungeonCatalog(dungeonCatalogFromInterior(result.proposed)).dungeons.find((entry) => entry.id === "ashen_crypt")!;
    expect(projected).toEqual(legacy);
    expect(result.space.kind).toBe("dungeon");
    expect(result.space.rooms.every((room) => room.floors.length === 1)).toBe(true);
    expect(result.library.catalogRevision).toBe(interior.library.catalogRevision + 1);
    expect(interiorCatalogValidationIssues(result.proposed)).toEqual([]);
  });

  it("refuses an existing dungeon id", async () => {
    const interior = await current();
    const spec = readSpec("example-crypt.json");
    spec.dungeon.id = interior.spaces.find((space) => space.kind === "dungeon")!.id;
    expect(() => scaffoldInterior(interior, "dungeon", spec)).toThrow(/already exists/u);
  });
});

describe("interior scaffolder: manor kind", () => {
  it("builds a valid manor from the example spec", async () => {
    const interior = await current();
    const { space, proposed } = scaffoldInterior(interior, "manor", readSpec("example-manor.json"));
    expect(interiorCatalogValidationIssues(proposed)).toEqual([]);
    expect(manorSpacesOf(proposed).map((entry) => entry.id)).toContain("example_manor");
    expect(space.defaultRoomId).toBe("example_lobby");
    expect(space.modules?.decoration?.playerPlacement.enabled).toBe(true);

    const lobby = space.rooms.find((room) => room.id === "example_lobby")!;
    expect(lobby.objects.map((object) => object.stationKind)).toEqual(["smith", "jewel", "breeder"]);
    expect(lobby.anchors.find((anchor) => anchor.id === "station_smith")).toMatchObject({ x: 1009.47, y: 307.23, role: "point" });
    expect(lobby.anchors.find((anchor) => anchor.id === "world_exit")).toMatchObject({ x: MANOR_DOOR.x, y: MANOR_DOOR.y, role: "portal" });
    expect(lobby.anchors.find((anchor) => anchor.id === "notice_board")).toMatchObject({ role: "message", message: "Welcome home." });
    expect(lobby.walls[0]!.imagePolygon).toHaveLength(4);
    expect(lobby.colliders[0]).toMatchObject({ kind: "polygon" });
    const hall = space.rooms.find((room) => room.id === "example_hall")!;
    expect(hall.floors[0]!.id).toBe("floor");
    expect(hall.spawnAnchorId).toBe("spawn");
    const study = space.rooms.find((room) => room.id === "example_study")!;
    expect(interiorNavigation(study).walkableSurfaces).toHaveLength(1);
  });

  it("pairs doors into reciprocal portal records with Manor runtime ids", async () => {
    const { space } = scaffoldInterior(await current(), "manor", readSpec("example-manor.json"));
    const forward = space.portals.find((portal) => portal.id === manorPortalRecordId("example_lobby", "lobby_stairs"))!;
    const back = space.portals.find((portal) => portal.id === manorPortalRecordId("example_hall", "lobby_stairs_back"))!;
    expect(forward).toMatchObject({ reciprocalPortalId: back.id, enabled: true, interactionLabel: "Upstairs" });
    expect(back).toMatchObject({ reciprocalPortalId: forward.id, interactionLabel: "Back downstairs" });
    expect(manorRuntimePortalId("example_manor", forward)).toBe("manor:example_manor:room:example_lobby:lobby_stairs");
    expect(space.portals.find((portal) => portal.id === manorPortalRecordId("example_hall", "hall_study"))!.enabled).toBe(false);
    expect(space.portals.find((portal) => portal.destination.kind === "world")).toMatchObject({ source: { roomId: "example_lobby", anchorId: "world_exit" } });
    const hall = space.rooms.find((room) => room.id === "example_hall")!;
    expect(hall.clickAreas.map((area) => area.id)).toEqual(["lobby_stairs_back_click_area", "hall_study_click_area"]);
  });

  it("honors station overrides and turning stations off", async () => {
    const interior = await current();
    const moved = readSpec("example-manor.json");
    moved.stations = { smith: { x: 400, y: 500 }, jewel: false };
    const lobby = scaffoldInterior(interior, "manor", moved).space.rooms[0]!;
    expect(lobby.objects.map((object) => object.stationKind)).toEqual(["smith", "breeder"]);
    expect(lobby.anchors.find((anchor) => anchor.id === "station_smith")).toMatchObject({ x: 400, y: 500 });
    moved.stations = false;
    expect(scaffoldInterior(interior, "manor", moved).space.rooms[0]!.objects).toEqual([]);
  });

  it("reports spec problems with spec paths", async () => {
    const interior = await current();
    const bad = readSpec("example-manor.json");
    bad.manor.id = "manor_lobby";
    bad.doors[0].from.room = "nowhere";
    bad.rooms[2].anchors = { hidden_door: { x: 100, y: 100, type: "portal" } };
    const message = issuesOf(() => scaffoldInterior(interior, "manor", bad));
    expect(message).toContain('manor.id: a space with id "manor_lobby" already exists');
    expect(message).toContain('doors[0].from.room: unknown room "nowhere"');
    expect(message).toContain("rooms[2].anchors.hidden_door: portal anchor is not used by any door");
  });

  it("refuses room ids already used elsewhere and doors off the walkable floor", async () => {
    const interior = await current();
    const clash = readSpec("example-manor.json");
    clash.rooms[1].id = "manor_lobby_room";
    clash.doors[0].to.room = "manor_lobby_room";
    clash.doors[1].from.room = "manor_lobby_room";
    expect(issuesOf(() => scaffoldInterior(interior, "manor", clash))).toContain("already used by another interior");
    const offFloor = readSpec("example-manor.json");
    offFloor.doors[0].to.at = { x: 5, y: 5 };
    expect(issuesOf(() => scaffoldInterior(interior, "manor", offFloor))).toMatch(/interior validation|Manor view/u);
  });
});

describe("interior scaffolder: publishing", () => {
  it("writes the space, bumped library and index into a data directory copy and aborts on a stale read", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "interiors-"));
    try {
      await cp(dataDirectory, directory, { recursive: true });
      const before = await readDungeonInteriorFiles(directory);
      const result = scaffoldInterior(before.interior, "manor", readSpec("example-manor.json"));
      const writes = planInteriorSpaceWrites(before.texts, before.interior, [result.space], result.library);
      expect(writes.map((write) => write.fileName).sort()).toEqual(["_library.json", "example_manor.json", "index.ts"]);
      expect(await applyInteriorWrites(directory, before.texts, writes)).toEqual({ ok: true });
      expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
      const after = await readDungeonInteriorFiles(directory);
      expect(after.interior.library.catalogRevision).toBe(before.interior.library.catalogRevision + 1);
      expect(after.texts.get("index.ts")).toContain("example_manor.json");
      expect(await readFile(path.join(directory, "example_manor.json"), "utf8")).toContain('"kind": "manor"');
      const stale = await applyInteriorWrites(directory, before.texts, [{ fileName: "_library.json", text: "{}\n" }]);
      expect(stale.ok).toBe(false);
      expect((await readDungeonInteriorFiles(directory)).texts.get("_library.json")).toBe(after.texts.get("_library.json"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
