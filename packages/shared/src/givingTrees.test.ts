import { describe, expect, it } from "vitest";

import { COLLECTIBLE_PICKUP_RADIUS_M } from "./collectibles.js";
import {
  CHINESE_PISTACHE_DISPLAY_NAME,
  CHINESE_PISTACHE_WOOD_YIELD,
  BALSAM_RESIN_HEAL_PER_TICK,
  BALSAM_RESIN_TICK_INTERVAL_MS,
  BALSAM_RESIN_TOTAL_HEALING,
  BALSAM_RESIN_TOTAL_TICKS,
  GIVING_TREE_AURA_RADIUS_M,
  balsamResinTickIntervalMs,
  balsamResinTickHeal,
  GIVING_TREE_DISPLAY_NAME,
  GIVING_TREE_WOOD_YIELD,
  ELDER_FROND_SAP_REFILL_MS,
  ELDER_FERN_WOOD_YIELD,
  WILLOW_TREE_DISPLAY_NAME,
  WILLOW_TREE_WOOD_YIELD,
  givingTreeResinHash,
  elderFrondSapAvailable,
  isGivingTreeResinCapable,
  treeDisplayNameForStableId,
  treeProduceAvailable,
  treeVarietyForStableId,
  treeWoodYieldForStableId
} from "./givingTrees.js";

describe("Giving Tree resin assignment", () => {
  it("uses the authoritative collectible interaction range for its healing aura", () => {
    expect(GIVING_TREE_AURA_RADIUS_M).toBe(COLLECTIBLE_PICKUP_RADIUS_M);
  });

  it("is stable for a tree identity", () => {
    expect(givingTreeResinHash("tree-alpha")).toBe(372_550_553);
    expect(isGivingTreeResinCapable("tree-alpha")).toBe(true);
    expect(isGivingTreeResinCapable("tree-beta")).toBe(false);
  });

  it("holds the configured distribution across stable identities", () => {
    const sampleSize = 100_000;
    const capable = Array.from({ length: sampleSize }, (_, index) =>
      isGivingTreeResinCapable(`tree-${index}`)
    ).filter(Boolean).length;
    // 60% of the 76% Giving Trees.
    expect(capable / sampleSize).toBeGreaterThan(0.44);
    expect(capable / sampleSize).toBeLessThan(0.47);
  });

  it("assigns stable tree varieties with the configured 76/20/3/1 split", () => {
    expect(treeVarietyForStableId("tree-0")).toBe("giving_tree");
    expect(treeVarietyForStableId("tree-10")).toBe("elder_fern");
    expect(treeVarietyForStableId("tree-204")).toBe("chinese_pistache");
    expect(treeVarietyForStableId("tree-200")).toBe("willow");
    const varieties = Array.from({ length: 100_000 }, (_, index) =>
      treeVarietyForStableId(`tree-${index}`)
    );
    const fraction = (variety: ReturnType<typeof treeVarietyForStableId>) =>
      varieties.filter((candidate) => candidate === variety).length
        / varieties.length;
    expect(fraction("giving_tree")).toBeGreaterThan(0.75);
    expect(fraction("giving_tree")).toBeLessThan(0.77);
    expect(fraction("elder_fern")).toBeGreaterThan(0.19);
    expect(fraction("elder_fern")).toBeLessThan(0.21);
    expect(fraction("chinese_pistache")).toBeGreaterThan(0.025);
    expect(fraction("chinese_pistache")).toBeLessThan(0.035);
    expect(fraction("willow")).toBeGreaterThan(0.007);
    expect(fraction("willow")).toBeLessThan(0.013);
  });

  it("uses each variety's display name and wood yield", () => {
    expect(treeDisplayNameForStableId("tree-0")).toBe(GIVING_TREE_DISPLAY_NAME);
    expect(treeDisplayNameForStableId("tree-0", true)).toBe("Giving Tree (Fruiting)");
    expect(treeDisplayNameForStableId("tree-0", false)).toBe("Giving Tree");
    expect(treeWoodYieldForStableId("tree-0")).toBe(GIVING_TREE_WOOD_YIELD);
    expect(treeDisplayNameForStableId("tree-204"))
      .toBe(CHINESE_PISTACHE_DISPLAY_NAME);
    expect(treeWoodYieldForStableId("tree-204"))
      .toBe(CHINESE_PISTACHE_WOOD_YIELD);
    expect(treeDisplayNameForStableId("tree-200")).toBe(WILLOW_TREE_DISPLAY_NAME);
    expect(treeWoodYieldForStableId("tree-200")).toBe(WILLOW_TREE_WOOD_YIELD);
    expect(isGivingTreeResinCapable("tree-200")).toBe(false);
    expect(isGivingTreeResinCapable("tree-204")).toBe(false);
    expect(treeWoodYieldForStableId("tree-10")).toBe(ELDER_FERN_WOOD_YIELD);
    expect(treeDisplayNameForStableId("tree-10", true)).toBe("Elder Fern (Sap)");
    expect(treeDisplayNameForStableId("tree-10", false)).toBe("Elder Fern (Tapped)");
  });

  it("keeps player saplings as Giving Trees", () => {
    expect(treeVarietyForStableId("sapling:tree-10")).toBe("giving_tree");
  });

  it("never gives Elder Ferns berries", () => {
    const ferns = Array.from({ length: 20_000 }, (_, index) => `tree-${index}`)
      .filter((id) => treeVarietyForStableId(id) === "elder_fern");
    expect(ferns.length).toBeGreaterThan(3_000);
    expect(ferns.some(isGivingTreeResinCapable)).toBe(false);
    expect(treeProduceAvailable({ id: "tree-10", berryAvailable: true, sapReadyAt: "2026-10-06T12:00:00.000Z" },
      Date.parse("2026-10-06T11:00:00.000Z"))).toBe(false);
  });

  it("refills Elder Frond sap at its ready time", () => {
    const tappedAt = Date.parse("2026-10-06T06:00:00.000Z");
    const readyAt = new Date(tappedAt + ELDER_FROND_SAP_REFILL_MS).toISOString();
    expect(readyAt).toBe("2026-10-06T11:00:00.000Z");
    expect(elderFrondSapAvailable(null, tappedAt)).toBe(true);
    expect(elderFrondSapAvailable(undefined, tappedAt)).toBe(true);
    expect(elderFrondSapAvailable(readyAt, tappedAt + ELDER_FROND_SAP_REFILL_MS - 1)).toBe(false);
    expect(elderFrondSapAvailable(readyAt, tappedAt + ELDER_FROND_SAP_REFILL_MS)).toBe(true);
    expect(treeProduceAvailable({ id: "tree-10", sapReadyAt: null }, tappedAt)).toBe(true);
    expect(treeProduceAvailable({ id: "tree-0", sapReadyAt: null }, tappedAt)).toBe(false);
    expect(treeProduceAvailable({ id: "tree-0", berryAvailable: true }, tappedAt)).toBe(true);
  });
});

describe("Giving Berry tick interval", () => {
  const monk = { activeSpecializationId: "monk", specializationRank: 1, aggressiveUntilMs: 0 };
  it("speeds the cadence only for a nonaggressive Monk at rank 1 or more", () => {
    expect(balsamResinTickIntervalMs(monk, 1_000)).toBe(Math.round(BALSAM_RESIN_TICK_INTERVAL_MS / 1.3));
    expect(balsamResinTickIntervalMs({ ...monk, specializationRank: 3 }, 1_000)).toBe(Math.round(BALSAM_RESIN_TICK_INTERVAL_MS / 1.6));
    expect(balsamResinTickIntervalMs({ ...monk, specializationRank: 5 }, 1_000)).toBe(BALSAM_RESIN_TICK_INTERVAL_MS / 2);
    expect(balsamResinTickIntervalMs({ ...monk, aggressiveUntilMs: 2_000 }, 1_000)).toBe(BALSAM_RESIN_TICK_INTERVAL_MS);
    expect(balsamResinTickIntervalMs({ ...monk, specializationRank: 0 }, 1_000)).toBe(BALSAM_RESIN_TICK_INTERVAL_MS);
    expect(balsamResinTickIntervalMs({ ...monk, activeSpecializationId: "warrior" }, 1_000)).toBe(BALSAM_RESIN_TICK_INTERVAL_MS);
    expect(balsamResinTickIntervalMs(null, 1_000)).toBe(BALSAM_RESIN_TICK_INTERVAL_MS);
  });

  it("spreads a 1.5x Balsam Resin multiplier into exactly 50% more total healing", () => {
    const total = (multiplier: number) => Array.from({ length: BALSAM_RESIN_TOTAL_TICKS }, (_, tick) => balsamResinTickHeal(tick, multiplier))
      .reduce((sum, heal) => sum + heal, 0);
    expect(balsamResinTickHeal(0)).toBe(BALSAM_RESIN_HEAL_PER_TICK);
    expect(total(1)).toBe(BALSAM_RESIN_TOTAL_HEALING);
    expect(total(1.5)).toBe(Math.round(BALSAM_RESIN_TOTAL_HEALING * 1.5));
  });
});
