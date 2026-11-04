import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DUNGEON_CATALOG as SHARED_DUNGEON_CATALOG, dungeonCatalogValidationIssues, validateDungeonCatalog, type DungeonCatalog } from "@ash-atlas/shared";

import { DungeonScaffoldError, scaffoldDungeon } from "./dungeonScaffold.js";
import { DungeonPlaytestRuntime } from "./dungeonPlaytestRuntime.js";
import { buildDungeonTopology } from "./dungeonTopology.js";

/** The example spec scaffolds the Ashen Crypt, so scaffold against the catalog from before it existed. */
const DUNGEON_CATALOG: DungeonCatalog = {
  ...SHARED_DUNGEON_CATALOG,
  dungeons: SHARED_DUNGEON_CATALOG.dungeons.filter((dungeon) => dungeon.id !== "ashen_crypt"),
  rewardTables: SHARED_DUNGEON_CATALOG.rewardTables.filter((table) => !table.id.startsWith("ashen_crypt_")),
  rewardTableIds: SHARED_DUNGEON_CATALOG.rewardTableIds.filter((id) => !id.startsWith("ashen_crypt_")),
  bossTemplates: SHARED_DUNGEON_CATALOG.bossTemplates.filter((boss) => boss.id !== "dungeon_ogre"),
  bossTemplateIds: SHARED_DUNGEON_CATALOG.bossTemplateIds.filter((id) => id !== "dungeon_ogre")
};

const example = JSON.parse(readFileSync(new URL("../../../tools/appearance-studio/interior-specs/example-crypt.json", import.meta.url), "utf8")) as Record<string, any>;
const clone = (): Record<string, any> => structuredClone(example);

function issuesFor(spec: unknown): string {
  try { scaffoldDungeon(DUNGEON_CATALOG, spec); } catch (error) {
    if (error instanceof DungeonScaffoldError) return error.issues.join("\n");
    throw error;
  }
  throw new Error("expected the spec to be rejected");
}

const live: DungeonPlaytestRuntime[] = [];
afterEach(async () => { for (const runtime of live.splice(0)) await runtime.dispose(); });

describe("dungeon scaffolder", () => {
  it("turns the example spec into a valid, reachable dungeon without touching the input catalog", () => {
    const before = structuredClone(DUNGEON_CATALOG);
    const { catalog, summary } = scaffoldDungeon(DUNGEON_CATALOG, example);
    expect(DUNGEON_CATALOG).toEqual(before);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    validateDungeonCatalog(catalog);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "ashen_crypt")!;
    expect(buildDungeonTopology(dungeon).issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(dungeon.rooms.map((room) => room.id)).toEqual(["gatehouse", "bone_hall", "ossuary", "crypt_well"]);
    expect(dungeon.entrance.roomId).toBe("gatehouse");
    expect(dungeon.portals.find((portal) => portal.source.kind === "world")!.enabled).toBe(false);
    expect(dungeon.portals.find((portal) => portal.id === "hall_to_ossuary")!.gates).toEqual([{ type: "dungeon_flag", flagId: "hall_to_ossuary_unlocked", value: true }]);
    expect(dungeon.triggers.find((trigger) => trigger.id === "bone_guard_complete")!.actions).toEqual([
      { type: "set_dungeon_flag", flagId: "hall_to_ossuary_unlocked", value: true },
      { type: "show_message", text: "The Ossuary door grinds open.", tone: "success" }
    ]);
    expect(dungeon.rooms.find((room) => room.id === "ossuary")!.objects.find((object) => object.id === "crypt_chest")).toMatchObject({ available: false, type: "chest" });
    expect(catalog.bossTemplates.map((template) => template.id)).toContain("dungeon_ogre");
    expect(catalog.catalogRevision).toBe(DUNGEON_CATALOG.catalogRevision);
    expect(summary.readiness.topologyErrors).toBe(0);
  });

  it("validates onComplete messages and accepts a raw show_message action", () => {
    const tooLong = clone();
    tooLong.encounters[0].onComplete = [{ message: "x".repeat(141) }];
    expect(issuesFor(tooLong)).toContain("onComplete[0].message");
    const raw = clone();
    raw.encounters[0].onComplete = [{ raw: { type: "show_message", text: "Dust settles.", tone: "info" } }];
    const { catalog } = scaffoldDungeon(DUNGEON_CATALOG, raw);
    expect(catalog.dungeons.find((entry) => entry.id === "ashen_crypt")!.triggers
      .find((trigger) => trigger.id === "bone_guard_complete")!.actions)
      .toEqual([{ type: "show_message", text: "Dust settles.", tone: "info" }]);
  });

  it("splits trash plus boss into chained encounters with exactly one boss placement", () => {
    const { catalog } = scaffoldDungeon(DUNGEON_CATALOG, example);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "ashen_crypt")!;
    const ossuary = dungeon.rooms.find((room) => room.id === "ossuary")!;
    const trash = dungeon.encounters.find((entry) => entry.id === "ossuary_lord")!;
    const boss = dungeon.encounters.find((entry) => entry.id === "ossuary_lord_boss")!;
    expect(trash.bossTemplateId).toBeUndefined();
    expect(boss.bossTemplateId).toBe("dungeon_ogre");
    expect(ossuary.mobs.filter((mob) => mob.encounterId === boss.id && !mob.summonedByMobSpawnId)).toHaveLength(1);
    expect(dungeon.triggers.find((trigger) => trigger.event.type === "encounter_state" && trigger.event.encounterId === trash.id)!.actions)
      .toEqual([{ type: "start_encounter", encounterId: boss.id }]);
  });

  it("starts the boss encounter after the trash clears without AMBIGUOUS_BOSS_PLACEMENT", async () => {
    const { catalog } = scaffoldDungeon(DUNGEON_CATALOG, example);
    const runtime = await DungeonPlaytestRuntime.create({ catalog, dungeonId: "ashen_crypt", mode: "room", roomId: "ossuary", seed: "scaffold-chain" });
    live.push(runtime);
    expect(runtime.snapshot().snapshot.encounters).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ossuary_lord", state: "active" })]));
    await runtime.command({ type: "kill_room" });
    let frame = runtime.snapshot();
    for (let index = 0; index < 40 && !frame.snapshot.encounters.some((entry) => entry.id === "ossuary_lord_boss" && entry.state === "active"); index += 1) frame = await runtime.advance(0.25);
    expect(frame.snapshot.encounters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ossuary_lord", state: "completed" }),
      expect.objectContaining({ id: "ossuary_lord_boss", state: "active" })
    ]));
    expect(frame.snapshot.enemies.some((enemy) => enemy.archetype === "ogre" && enemy.lifeState === "alive")).toBe(true);
  });

  it("refuses an existing dungeon id and reports spec-path messages", () => {
    expect(issuesFor({ ...clone(), dungeon: { ...clone().dungeon, id: "cistern_warrens" } })).toContain("dungeon.id");

    const unreachable = clone();
    unreachable.doors = unreachable.doors.filter((door: { id: string }) => door.id !== "gate_to_well");
    expect(issuesFor(unreachable)).toMatch(/rooms\[3\]: room "crypt_well" cannot be reached from the entrance room "gatehouse"/u);

    const badBoss = clone();
    badBoss.encounters[1].boss.template = "dragon";
    expect(issuesFor(badBoss)).toMatch(/encounters\[1\]\.boss\.template: "dragon" is not a registered dungeon boss. Use one of: xoral, sewer_rat_miniboss, brood_matriarch, raptor_chieftain, thunderwing, hollow_elder, centurion, brood_matron, trifang_warden, elder_dragon, the_watcher, drowned_admiral, tidemaw, abyssal_one, granite_bull, corrupted_core, forgemaster, grandmaster, dungeon_slime_miniboss/u);

    const badPoint = clone();
    badPoint.rooms[2].chests[0].at = { x: 5000, y: 5000 };
    expect(issuesFor(badPoint)).toMatch(/rooms\[2\]\.chests\[0\]\.at: \(5000, 5000\) is not inside walkable floor/u);

    const typo = clone();
    typo.encounters[0].startson = "room_enter";
    expect(issuesFor(typo)).toMatch(/encounters\[0\]: Unrecognized key/u);

    const unlockUnlocked = clone();
    unlockUnlocked.encounters[0].onComplete = [{ unlockDoor: "gate_to_well" }];
    expect(issuesFor(unlockUnlocked)).toMatch(/encounters\[0\]\.onComplete\[0\]\.unlockDoor: door "gate_to_well" is not locked/u);
  });
});
