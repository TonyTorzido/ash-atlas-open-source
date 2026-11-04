import { describe, expect, it } from "vitest";

import { measureSpriteSizes, type SpriteSizeRow } from "../developer/spriteVisibleSize.js";

/**
 * On-screen creature height is `baseHeightPx * (opaque bbox height / canvas height)`: the base height
 * is applied to the whole PNG canvas, transparent margin included. A redraw or a new art drop that
 * changes the canvas padding without updating `baseHeightPx` silently shrinks (or grows) the mob.
 * This guard measures every wired PNG (`pnpm sprite:sizes`) and pins the visible height of the
 * reference mobs and each size class, so such a drop fails here instead of in game.
 */

const rows = measureSpriteSizes();
const mobRow = (key: string): SpriteSizeRow => {
  const row = rows.find((candidate) => candidate.group === "mob" && candidate.artKey === key);
  expect(row, `mob artwork key ${key} is not wired`).toBeDefined();
  return row!;
};

/** [min, max] visible height in px at the base zoom. */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  // Original reference mobs that were sized by hand and are the yardstick for everything else.
  wolf: [33, 37],
  hog: [32, 36],
  deer: [49, 54],
  bear: [45, 50],
  ogre: [59, 65],
  goblinWarrior: [46, 52],
  goblinArcher: [48, 53],
  sewerRatMiniboss: [80, 90],
  sewerRat: [26, 30],
  // Redrawn / re-padded art restored to its old on-screen size.
  goblinBasic: [42, 46],
  goblinHealer: [46, 51],
  mysteriousTraveler: [50, 56],
  broodMatriarch: [76, 86],
  rotWolf: [37, 43],
  risenSkeleton: [46, 52],
  skeleton: [46, 52],
  trainingDummy: [40, 45],
  // Small critters.
  spiderling: [26, 36],
  duneTick: [26, 36],
  nestMouse: [26, 36],
  caveBat: [28, 36],
  raptorRunt: [28, 36],
  blightSprite: [28, 36],
  slime: [28, 36],
  lavaSlime: [28, 36],
  drakeling: [30, 40],
  // Monastery: monks are standard humanoids, the Grandmaster a much bigger but not absurd boss.
  initiateMonk: [46, 52],
  staffAdept: [48, 56],
  shadowAcrobat: [46, 52],
  grandmaster: [125, 135],
  grandmasterClone: [58, 66],
  // Fallen Prison: medium humanoids ~49, large ~62, elite ~75, hatchling ~30, bosses 110-125.
  skyScout: [46, 52],
  wardenScout: [46, 52],
  zealot: [46, 52],
  legionSoldier: [46, 52],
  cagedValkyrie: [46, 52],
  cloudSentry: [59, 65],
  serpentJailer: [59, 65],
  cloudArbiter: [72, 78],
  coilHatchling: [28, 33],
  centurion: [145, 155],
  broodMatron: [155, 165],
  trifangWarden: [145, 155],
  gateWarden: [49, 56],
  // Dungeon bosses.
  elderDragon: [125, 140],
  forgemaster: [150, 165]
};

/** Standard humanoids all stand about as tall as the old goblins. */
const STANDARD_HUMANOIDS = [
  "dustMummy", "lizardfolkWarrior", "canopyGoblin", "poisonfrogRaider", "mossjawSneak",
  "mossjawSpearman", "mossjawHexer", "frogfolkBlowgunner", "duneGoblin", "gillfolkScout", "kappa",
  "nixie", "frostWraith", "barrowWight", "bogGhoul", "serpentPriestess", "gallowsGhost", "pineDryad",
  "mossjawWarboss", "hedgeWitch", "restlessGravedigger", "covenMatron", "stagfolkWarden", "rimeWitch",
  "draugrBerserker", "gnollBonebow", "gnollPackseer", "carrionGhoul", "frogfolkShaman", "bogHag",
  "highlandReaver", "cairnWight", "skeletonHoplite", "oliveDryad", "jackalfolkSkirmisher",
  "desertMarauder", "steppeRaider", "saltHusk", "kurganWight", "frostbornRunecaster", "draugr",
  "auroraShade", "gillfolkNetter", "drownedDeckhand", "merfolkHarpooner", "phantomLookout",
  "drownedBride", "lakeMaiden", "drownedThrall", "kappaBrawler", "drownedCitizen", "drownedCultist",
  "vineWrappedCorpse", "revenantLich", "pantherfolkStalker", "tideWraith"
] as const;

describe("mob sprite visible sizes", () => {
  it("wires a measurable PNG for every guarded key", () => {
    expect(rows.length).toBeGreaterThan(250);
    for (const key of [...Object.keys(RANGES), ...STANDARD_HUMANOIDS]) mobRow(key);
  });

  it.each(Object.entries(RANGES))("%s stays within its visible height range", (key, [min, max]) => {
    const { visibleHeightPx } = mobRow(key);
    expect(visibleHeightPx).toBeGreaterThanOrEqual(min);
    expect(visibleHeightPx).toBeLessThanOrEqual(max);
  });

  it("keeps standard humanoids at goblin height", () => {
    for (const key of STANDARD_HUMANOIDS) {
      const { visibleHeightPx } = mobRow(key);
      expect(visibleHeightPx, key).toBeGreaterThanOrEqual(46);
      expect(visibleHeightPx, key).toBeLessThanOrEqual(52);
    }
  });

  it("keeps the Grandmaster a believable multiple of an initiate monk", () => {
    const ratio = mobRow("grandmaster").visibleHeightPx / mobRow("initiateMonk").visibleHeightPx;
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.8);
  });

  it("keeps every creature sprite above a minimum on-screen size", () => {
    // Floor, not a target: the smallest Hollin NPCs and tiny overworld critters sit just above it.
    for (const row of rows) {
      expect(row.visibleHeightPx, `${row.group} ${row.artKey}`).toBeGreaterThanOrEqual(20);
    }
  });

  it("keeps pets at critter-to-beast size", () => {
    for (const row of rows.filter((candidate) => candidate.group === "pet")) {
      expect(row.visibleHeightPx, row.artKey).toBeGreaterThanOrEqual(30);
      expect(row.visibleHeightPx, row.artKey).toBeLessThanOrEqual(62);
    }
  });

  it("does not let a presentation key serve PNGs with different transparent margins", () => {
    // A shared base height only works while the shared PNGs fill their canvases about the same way.
    // Boss phase art shares one transform per family by design; Tidemaw and Abyssal One phase poses are
    // intentionally different in their canvases.
    const intentionallyUneven = new Set(["tidemaw", "abyssalOne"]);
    const byPresentation = new Map<string, SpriteSizeRow[]>();
    for (const row of rows.filter((candidate) => candidate.group !== "boss")) {
      byPresentation.set(row.presentationKey, [...(byPresentation.get(row.presentationKey) ?? []), row]);
    }
    for (const [presentationKey, group] of byPresentation) {
      const fills = group.filter((row) => row.file !== group[0]!.file).map((row) => row.fillHeight);
      if (fills.length === 0 || intentionallyUneven.has(presentationKey)) continue;
      for (const fill of fills) {
        expect(
          Math.abs(fill - group[0]!.fillHeight),
          `${presentationKey} is shared by artwork with different fill (${group.map((row) => row.artKey).join(", ")})`
        ).toBeLessThan(0.15);
      }
    }
  });
});
