import { describe, expect, it } from "vitest";

import { INTERIOR_DATA } from "./data/interiors/index.js";
import { DUNGEON_CATALOG, DUNGEON_TIER_IDS, type DungeonDefinition } from "./dungeonCatalog.js";
import { DUNGEON_TIER_PROFILES, dungeonTierIssues, dungeonTierProfile } from "./dungeonTierProfiles.js";
import { dungeonCatalogFromInterior } from "./interior/dungeonView.js";
import { interiorCatalogValidationIssues, type InteriorCatalog } from "./interior/interiorCatalog.js";

const live = (id: string) => structuredClone(DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === id)!) as DungeonDefinition;

describe("dungeon tier profiles", () => {
  it("defines every tier with minimums that never fall as the tier rises", () => {
    expect(Object.keys(DUNGEON_TIER_PROFILES)).toEqual([...DUNGEON_TIER_IDS]);
    const profiles = DUNGEON_TIER_IDS.map((id) => dungeonTierProfile(id));
    profiles.forEach((profile, index) => {
      expect(profile.id).toBe(DUNGEON_TIER_IDS[index]);
      expect(profile.level).toBe(index * 5);
      expect(profile.eliteModifiers.every((modifier) => profile.level >= 20 || modifier === "hardy" || modifier === "swift")).toBe(true);
      const previous = profiles[index - 1];
      if (!previous) return;
      for (const pick of [
        (value: typeof profile) => value.roomsMin, (value: typeof profile) => value.mobsSoloMin,
        (value: typeof profile) => value.wavesPerFight.min, (value: typeof profile) => value.elitePctMin,
        (value: typeof profile) => value.rewards.completionGoldPerMember, (value: typeof profile) => value.rewards.chestsMin,
        (value: typeof profile) => value.rewards.rarePlusPctMin, (value: typeof profile) => value.requiredRoomKinds.length
      ]) expect(pick(profile)).toBeGreaterThanOrEqual(pick(previous));
    });
    expect(profiles.map((profile) => profile.rewards.completionGoldPerMember))
      .toEqual([500, 1_000, 1_750, 2_500, 3_500, 5_000, 7_500, 10_000, 15_000]);
  });

  it("holds every live dungeon that declares a tier to that tier's minimums", () => {
    for (const dungeon of DUNGEON_CATALOG.dungeons.filter((candidate) => candidate.tier)) {
      expect(dungeonTierIssues(dungeon, dungeonTierProfile(dungeon.tier!.id)), dungeon.id).toEqual([]);
    }
  });

  // Live dungeons declare their tier as their retrofit lands.
  it.todo("cistern_warrens declares t00 and meets it");
  it("fangrock_cavern declares t05 and meets it (WP4 pilot)", () => {
    const fangrock = live("fangrock_cavern");
    expect(fangrock.tier).toEqual({ id: "t05" });
    expect(dungeonTierIssues(fangrock, dungeonTierProfile("t05"))).toEqual([]);
  });
  it.todo("the_eyrie declares t10 and meets it");
  it.todo("blightwood_grove declares t15 and meets it");

  it("fails a tiered dungeon below its minimums and passes one that meets them", () => {
    const sewer = live("cistern_warrens");
    sewer.tier = { id: "t40" };
    const paths = dungeonTierIssues(sewer, dungeonTierProfile("t40")).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining([
      "tier.roomsMin", "tier.mobsSoloMin", "tier.elitePctMin", "tier.bossesMin", "tier.rewards.chestsMin"
    ]));
    expect(paths.some((path) => path.startsWith("tier.wavesPerFight."))).toBe(true);

    const reachable = { ...dungeonTierProfile("t00"), roomsMin: 1, mobsSoloMin: 1, rewards: { ...dungeonTierProfile("t00").rewards, chestsMin: 0 } };
    expect(dungeonTierIssues(sewer, reachable)).toEqual([]);
  });

  it("counts rolled solo mobs on every sampled run and checks rolled elites against the tier", () => {
    const fangrock = live("fangrock_cavern");
    const room = fangrock.rooms.find((candidate) => candidate.id === "cave_mouth")!;
    room.zones.push(
      { id: "pack_area", retired: false, kind: "rectangle", purpose: "encounter_boundary", x: 300, y: 300, width: 400, height: 300 },
      { id: "pack_leash", retired: false, kind: "rectangle", purpose: "leash", x: 150, y: 250, width: 700, height: 500 }
    );
    fangrock.encounters.push({
      id: "rolled-pack", retired: false, name: "Rolled Pack", roomId: room.id,
      boundaryZoneId: "pack_area", leashZoneId: "pack_leash", waves: [],
      completion: "all_spawned_mobs_defeated", reset: { onPartyWipe: true, delayMs: 0 },
      retry: { allowed: true, maxAttempts: null }, lockPortalIds: [],
      roll: {
        pool: [{ archetype: "wolf", cost: 2 }], budget: { min: 20, max: 20 }, waves: { min: 1, max: 2 },
        spawn: { zoneIds: ["pack_area"] }, elite: { chancePct: 2, maxPerEncounter: 2, modifierPool: ["hardy", "shielded"] }
      }
    });
    const before = dungeonTierIssues(live("fangrock_cavern"), { ...dungeonTierProfile("t05"), mobsSoloMin: 200 })
      .find((issue) => issue.path === "tier.mobsSoloMin")!.message;
    const after = dungeonTierIssues(fangrock, { ...dungeonTierProfile("t05"), mobsSoloMin: 200 })
      .find((issue) => issue.path === "tier.mobsSoloMin")!.message;
    // Ten wolves (20 points at 2 each) join the solo count on every run.
    expect(Number(after.split("found ")[1]) - Number(before.split("found ")[1])).toBe(10);
    expect(dungeonTierIssues(fangrock, dungeonTierProfile("t05")).map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "tier.elitePctMin.rolled-pack", "tier.eliteModifiers.rolled-pack"
    ]));
  });

  it("mirrors modules.tier and modules.runRolls from interior data into the dungeon view", () => {
    const interior = structuredClone(INTERIOR_DATA) as unknown as InteriorCatalog;
    const sewer = interior.spaces.find((space) => space.id === "cistern_warrens")!;
    sewer.modules = { ...sewer.modules, tier: { id: "t00" }, runRolls: { flags: [{ flagId: "side_room", chancePct: 50 }] } };
    expect(interiorCatalogValidationIssues(interior)).toEqual([]);
    const projected = dungeonCatalogFromInterior(interior).dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!;
    expect(projected.tier).toEqual({ id: "t00" });
    expect(projected.runRolls).toEqual({ flags: [{ flagId: "side_room", chancePct: 50 }] });
    expect(DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")).not.toHaveProperty("tier");

    const manor = interior.spaces.find((space) => space.kind === "manor")!;
    manor.modules = { ...manor.modules, tier: { id: "t00" } };
    expect(interiorCatalogValidationIssues(interior)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "is only supported on dungeon spaces" })
    ]));
  });
});
