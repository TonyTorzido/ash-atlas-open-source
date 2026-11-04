import { describe, expect, it } from "vitest";

import {
  DUNGEON_CATALOG,
  dungeonCatalogRoomNavigation,
  dungeonCatalogValidationIssues,
  dungeonFormationOffset,
  type DungeonCatalog,
  type DungeonDefinition
} from "./dungeonCatalog.js";
import { DUNGEON_ELITE_MODIFIERS } from "./dungeonEliteModifiers.js";
import { dungeonHasRunRolls, materializeDungeonRun } from "./dungeonRunMaterializer.js";
import { dungeonTierProfile } from "./dungeonTierProfiles.js";
import { isIndoorNavigationPointWalkable } from "./indoor.js";

const SEEDS = Array.from({ length: 200 }, (_, index) => `run-${index}`);

describe("dungeon run materializer", () => {
  it.each(DUNGEON_CATALOG.dungeons.filter((dungeon) => !dungeonHasRunRolls(dungeon)).map((dungeon) => [dungeon.id, dungeon] as const))(
    "materializes the unrolled live dungeon %s to itself for 200 seeds", (_id, dungeon) => {
      const pristine = structuredClone(dungeon);
      for (const seed of SEEDS) expect(materializeDungeonRun(dungeon, seed)).toBe(dungeon);
      expect(dungeon).toEqual(pristine);
      // Identity for every seed, so one check covers all 200 outputs.
      expect(dungeonCatalogValidationIssues(soloCatalog(dungeon))).toEqual([]);
      expect(blockedSpawns(dungeon)).toEqual([]);
    });

  it("rolls the live Fangrock Cavern (t05) validly for 200 seeds: walkable spawns, tier mobs, 5% stat elites", () => {
    const fangrock = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === "fangrock_cavern")!;
    expect(dungeonHasRunRolls(fangrock)).toBe(true);
    const profile = dungeonTierProfile("t05");
    let vaults = 0;
    for (const seed of SEEDS) {
      const run = materializeDungeonRun(fangrock, seed);
      expect(dungeonCatalogValidationIssues(soloCatalog(run)), seed).toEqual([]);
      expect(blockedSpawns(run), seed).toEqual([]);
      const base = run.rooms.flatMap((room) => room.mobs).filter((mob) => !mob.retired && mob.partySet === undefined);
      expect(base.length, seed).toBeGreaterThanOrEqual(profile.mobsSoloMin);
      for (const encounter of run.encounters.filter((candidate) => !candidate.bossTemplateId)) {
        expect(encounter.waves.length, `${seed} ${encounter.id}`).toBeGreaterThanOrEqual(1);
        expect(encounter.waves.length, `${seed} ${encounter.id}`).toBeLessThanOrEqual(2);
      }
      for (const mob of base.filter((candidate) => candidate.elite)) {
        for (const modifier of mob.elite!.modifiers) expect(DUNGEON_ELITE_MODIFIERS[modifier].kind).toBe("stat");
      }
      if (run.triggers.some((trigger) => trigger.id === "run_flag_vault_open")) vaults += 1;
    }
    // vault_open rolls at 35%: some runs have the vault and most do not.
    expect(vaults).toBeGreaterThan(30);
    expect(vaults).toBeLessThan(110);
  });

  it("rolls a valid, walkable, deterministic run for 200 seeds", () => {
    const authored = rolledFixture();
    expect(dungeonCatalogValidationIssues(soloCatalog(authored))).toEqual([]);
    const waveCounts = new Set<number>();
    const torchSets = new Set<number>();
    let elites = 0;
    let flagsOn = 0;
    for (const seed of SEEDS) {
      const run = materializeDungeonRun(authored, seed);
      expect(dungeonCatalogValidationIssues(soloCatalog(run)), seed).toEqual([]);
      expect(blockedSpawns(run), seed).toEqual([]);
      expect(materializeDungeonRun(authored, seed), seed).toEqual(run);
      expect(run.encounters.some((encounter) => encounter.roll) || run.runRolls, seed).toBeFalsy();

      const pack = run.encounters.find((encounter) => encounter.id === "rolled-pack")!;
      waveCounts.add(pack.waves.length);
      const room = run.rooms.find((candidate) => candidate.id === pack.roomId)!;
      for (const wave of pack.waves) {
        const base = wave.mobSpawnIds.filter((id) => room.mobs.find((mob) => mob.id === id)!.partySet === undefined);
        expect(base.length, `${seed} ${wave.id}`).toBeGreaterThan(0);
      }
      for (const mob of room.mobs.filter((candidate) => candidate.generated)) {
        if (mob.partySet) torchSets.add(mob.partySet);
        if (mob.elite) {
          elites += 1;
          // Below level 20 only stat modifiers roll.
          for (const modifier of mob.elite.modifiers) expect(DUNGEON_ELITE_MODIFIERS[modifier].kind).toBe("stat");
        }
      }
      expect(room.mobs.filter((mob) => mob.encounterId === "rolled-pack" && mob.elite).length).toBeLessThanOrEqual(3);
      if (run.triggers.some((trigger) => trigger.id === "run_flag_vault_open")) flagsOn += 1;

      // The boss encounter stays fixed: exactly its one authored placement.
      const boss = run.encounters.find((encounter) => encounter.bossTemplateId)!;
      const bossRoom = run.rooms.find((candidate) => candidate.id === boss.roomId)!;
      expect(bossRoom.mobs.filter((mob) => mob.encounterId === boss.id && !mob.summonedByMobSpawnId)
        .map((mob) => mob.generated ?? false)).toEqual([false]);
    }
    expect([...waveCounts].sort()).toEqual([1, 2, 3]);
    expect([...torchSets].sort((left, right) => left - right)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(elites).toBeGreaterThan(0);
    // 35% flag over 200 seeds.
    expect(flagsOn).toBeGreaterThan(40);
    expect(flagsOn).toBeLessThan(100);
  });

  it("varies the roll between runs but never within one", () => {
    const authored = rolledFixture();
    const layout = (seed: string) => JSON.stringify(materializeDungeonRun(authored, seed).rooms
      .flatMap((room) => room.mobs.filter((mob) => mob.generated)));
    expect(layout("a")).toBe(layout("a"));
    expect(new Set(SEEDS.slice(0, 20).map(layout)).size).toBeGreaterThan(15);
    // A republish (new revision) re-rolls the same run id.
    expect(layout("a")).not.toBe(JSON.stringify(materializeDungeonRun({ ...authored, revision: "next" }, "a").rooms
      .flatMap((room) => room.mobs.filter((mob) => mob.generated))));
  });

  it("throws on a spawn zone with no walkable ground instead of falling back onto the player spawn", () => {
    const authored = rolledFixture();
    const room = authored.rooms.find((candidate) => candidate.id === "cave_mouth")!;
    const zone = room.zones.find((candidate) => candidate.id === "pack_spawns")!;
    // Entirely outside the room: no walkable point anywhere in it.
    Object.assign(zone, { points: [{ x: -900, y: -900 }, { x: -800, y: -900 }, { x: -800, y: -800 }, { x: -900, y: -800 }] });
    expect(() => materializeDungeonRun(authored, "bad-zone")).toThrow(/no walkable ground in spawn zone pack_spawns/u);
  });

  it("rejects rolled boss encounters, authored waves beside a roll, and behaviour elites below level 20", () => {
    const catalog = soloCatalog(rolledFixture());
    const dungeon = catalog.dungeons[0]!;
    const boss = dungeon.encounters.find((encounter) => encounter.bossTemplateId)!;
    boss.roll = structuredClone(dungeon.encounters.find((encounter) => encounter.id === "rolled-pack")!.roll);
    const pack = dungeon.encounters.find((encounter) => encounter.id === "rolled-pack")!;
    pack.waves = [{ id: "authored", mobSpawnIds: ["missing"], delayMs: 0 }];
    pack.roll!.elite!.modifierPool = ["hardy", "shielded"];
    const messages = dungeonCatalogValidationIssues(catalog).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      "boss encounters stay fixed; roll a separate trash encounter and chain it to the boss",
      "rolled encounters generate their own waves; leave waves empty",
      "shielded needs dungeon level 20 or higher (stat-only elites below 20)"
    ]));
    // The materializer never puts rolled adds into the boss encounter either.
    const run = materializeDungeonRun(dungeon, "boss");
    const bossRoom = run.rooms.find((room) => room.id === boss.roomId)!;
    expect(bossRoom.mobs.filter((mob) => mob.encounterId === boss.id && mob.generated)).toEqual([]);

    const unrolled = soloCatalog(rolledFixture());
    unrolled.dungeons[0]!.encounters.find((encounter) => encounter.id === "rolled-pack")!.roll = undefined;
    expect(dungeonCatalogValidationIssues(unrolled).map((issue) => issue.message))
      .toContain("needs at least one wave unless the encounter rolls its mobs");
  });
});

/** The catalog narrowed to one dungeon (and its own entrances) so it validates in isolation. */
function soloCatalog(dungeon: DungeonDefinition): DungeonCatalog {
  return {
    ...DUNGEON_CATALOG,
    entrances: DUNGEON_CATALOG.entrances.filter((entrance) => entrance.dungeonId === dungeon.id),
    dungeons: [structuredClone(dungeon)]
  };
}

/** Runtime spawn points (anchor + formation offset) that are not walkable. */
function blockedSpawns(dungeon: DungeonDefinition): string[] {
  const blocked: string[] = [];
  for (const encounter of dungeon.encounters.filter((candidate) => !candidate.retired)) {
    const room = dungeon.rooms.find((candidate) => candidate.id === encounter.roomId)!;
    const navigation = dungeonCatalogRoomNavigation(room);
    for (const wave of encounter.waves) for (const spawnId of wave.mobSpawnIds) {
      const mob = room.mobs.find((candidate) => candidate.id === spawnId)!;
      if (mob.randomSpawnZoneId) continue;
      const grouped = wave.mobSpawnIds.filter((id) => room.mobs.find((candidate) => candidate.id === id)!.spawnGroupId === mob.spawnGroupId);
      const anchor = room.anchors.find((candidate) => candidate.id === mob.anchorId)!;
      const offset = dungeonFormationOffset(encounter.groupControls?.formation ?? "scatter", grouped.indexOf(spawnId), grouped.length);
      const point = {
        x: Math.max(0, Math.min(room.width, anchor.x + offset.x)),
        y: Math.max(0, Math.min(room.height, anchor.y + offset.y))
      };
      if (!isIndoorNavigationPointWalkable(navigation, point)) blocked.push(`${encounter.id}:${spawnId}`);
    }
  }
  return blocked;
}

/** Fangrock Cavern plus two rolled trash encounters (zone and anchor spawns) and a vault flag. */
function rolledFixture(): DungeonDefinition {
  const dungeon = structuredClone(DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === "fangrock_cavern")!);
  dungeon.tier = { id: "t05" };
  dungeon.runRolls = { flags: [{ flagId: "vault_open", chancePct: 35 }] };
  const room = dungeon.rooms.find((candidate) => candidate.id === "cave_mouth")!;
  room.zones.push(
    { id: "pack_area", retired: false, kind: "rectangle", purpose: "encounter_boundary", x: 300, y: 300, width: 400, height: 300 },
    { id: "pack_leash", retired: false, kind: "rectangle", purpose: "leash", x: 150, y: 250, width: 700, height: 500 },
    { id: "pack_spawns", retired: false, kind: "polygon", purpose: "trigger",
      points: [{ x: 320, y: 320 }, { x: 680, y: 320 }, { x: 680, y: 580 }, { x: 320, y: 580 }] }
  );
  room.anchors.push(
    { id: "pack_west", retired: false, x: 360, y: 450, facing: 0 },
    { id: "pack_east", retired: false, x: 640, y: 450, facing: 180 }
  );
  const encounter = (id: string, spawn: { zoneIds: string[] } | { anchorIds: string[] }) => ({
    id, retired: false, name: `Rolled ${id}`, roomId: room.id, boundaryZoneId: "pack_area", leashZoneId: "pack_leash",
    waves: [], completion: "all_spawned_mobs_defeated" as const,
    reset: { onPartyWipe: true, delayMs: 1_000 }, retry: { allowed: true, maxAttempts: null }, lockPortalIds: []
  , roll: {
      pool: [
        { archetype: "wolf" as const, cost: 2, min: 1, weight: 3 },
        { archetype: "goblin" as const, cost: 3, max: 4 },
        { archetype: "cave_raptor" as const, cost: 5, max: 2, eliteEligible: false }
      ],
      budget: { min: 8, max: 20 },
      waves: { min: 1, max: 3, delayMs: 500 },
      spawn,
      formations: ["scatter", "line", "wedge", "circle"] as Array<"scatter" | "line" | "wedge" | "circle">,
      elite: { chancePct: 30, maxPerEncounter: 3 }
    } });
  dungeon.encounters.push(encounter("rolled-pack", { zoneIds: ["pack_spawns"] }));
  dungeon.encounters.push(encounter("rolled-flank", { anchorIds: ["pack_west", "pack_east"] }));
  return dungeon;
}
