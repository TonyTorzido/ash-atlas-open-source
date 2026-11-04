import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEV_PNG_ASSETS,
  filterDevPngAssets
} from "./devPngCatalog.js";

describe("development PNG catalog", () => {
  it("has stable unique usage IDs and non-empty build URLs", () => {
    const ids = DEV_PNG_ASSETS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEV_PNG_ASSETS.length).toBeGreaterThan(20);
    for (const asset of DEV_PNG_ASSETS) {
      expect(asset.id).toMatch(/^[a-z0-9-]+$/);
      expect(asset.url).toMatch(/\S/);
      expect(asset.sourcePath).toMatch(/\.png$/i);
    }
  });

  it("uses each zoom-scaled production presentation as the anchor authority", () => {
    for (const asset of DEV_PNG_ASSETS) {
      if (asset.productionSize?.kind !== "zoom-scaled") continue;
      expect(asset.anchor.x).toBe(asset.productionSize.presentation.anchorX);
      expect(asset.anchor.y).toBe(asset.productionSize.presentation.anchorY);
    }
  });

  it("keeps persistent building PNGs on the shared zoom presentation", () => {
    for (const label of ["Tannery", "Cistern Warrens"]) {
      const asset = DEV_PNG_ASSETS.find(({ label: assetLabel }) => assetLabel === label);
      expect(asset?.productionSize?.kind, label).toBe("zoom-scaled");
    }
  });

  it("uses the authored item presentation for inventory and ground-drop PNGs", () => {
    const ironBar = DEV_PNG_ASSETS.filter(({ sourcePath }) =>
      sourcePath.endsWith("items/iron-bar.png")
    );
    expect(ironBar.map(({ usageLabel }) => usageLabel)).toEqual([
      "World Ground Drop",
      "Inventory / Equipment Icon",
      "Dropped Item Prompt",
      "Mobile World Action",
      "Pickup Dialog"
    ]);
    expect(ironBar[0]?.productionSize).toMatchObject({
      kind: "zoom-scaled",
      presentation: { baseHeightPx: 28 }
    });
    expect(ironBar[1]?.productionSize).toMatchObject({
      kind: "item-scaled",
      presentation: { baseHeightPx: 28 }
    });
    expect(ironBar[1]?.productionSource)
      .toBe("RUNTIME_PNG_PRESENTATION_CATALOG.sprites.iron_bar");
  });

  it("registers fishing encounter art with its scene usages", () => {
    expect(DEV_PNG_ASSETS.find(({ sourcePath }) => sourcePath.endsWith("fishing/PixelFish.png")))
      .toMatchObject({
        label: "Fishing Encounter Fish",
        category: "Fishing",
        usageLabel: "Fishing Fight Scene Fish",
        productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
        placeable: false
      });
    expect(DEV_PNG_ASSETS.find(({ sourcePath }) => sourcePath.endsWith("fishing/RiverBackground.png")))
      .toMatchObject({
        label: "Fishing River Background",
        category: "Fishing",
        usageLabel: "Fishing River Fight Scene",
        productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
        placeable: false
      });
    expect(DEV_PNG_ASSETS.find(({ sourcePath }) => sourcePath.endsWith("fishing/LakeBackground.png")))
      .toMatchObject({
        label: "Fishing Lake Background",
        category: "Fishing",
        usageLabel: "Fishing Lake Fight Scene",
        productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
        placeable: false
      });
    expect(DEV_PNG_ASSETS.find(({ sourcePath }) => sourcePath.endsWith("fishing/OceanBackground.png")))
      .toMatchObject({
        label: "Fishing Ocean Background",
        category: "Fishing",
        usageLabel: "Fishing Ocean Fight Scene",
        productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
        placeable: false
      });
  });

  it("includes every PNG in the client asset and public directories", () => {
    const clientRoot = fileURLToPath(new URL("../../", import.meta.url));
    const files = [
      ...pngFiles(join(clientRoot, "src", "assets")),
      ...pngFiles(join(clientRoot, "public"))
    ].map((path) => relative(clientRoot, path).replaceAll("\\", "/"));
    const catalogSources = new Set(DEV_PNG_ASSETS.map(({ sourcePath }) =>
      sourcePath.replace(/^apps\/client\//, "")
    ));
    expect(files.filter((path) => !catalogSources.has(path))).toEqual([]);
  });

  it("filters by friendly name, file path, and discovered category", () => {
    expect(filterDevPngAssets("wolf.png", "all").some(({ label }) => label === "Wolf")).toBe(true);
    expect(filterDevPngAssets("bear.png", "all").some(({ label }) => label === "Bear")).toBe(true);
    expect(filterDevPngAssets("mysterious-traveler.png", "all")
      .some(({ label }) => label === "Mysterious Traveler")).toBe(true);
    expect(filterDevPngAssets("weaponsmith", "Buildings")).toHaveLength(0);
    expect(filterDevPngAssets("wolf", "App Icons")).toHaveLength(0);
    expect(filterDevPngAssets("city-salon.png", "Buildings").map(({ label }) => label))
      .toEqual(["City Salon"]);
    expect(filterDevPngAssets("city-kennel.png", "Buildings").map(({ label }) => label))
      .toEqual(["City Kennel"]);
    expect(filterDevPngAssets("city-market.png", "Buildings").map(({ label }) => label))
      .toEqual(["City Market"]);
    expect(filterDevPngAssets("Monument", "Buildings").map(({ label }) => label).sort())
      .toEqual(["Forestry Monument", "Hunting Monument", "Mining Monument"]);
    expect(filterDevPngAssets("", "all", true).every(({ placeable }) => placeable)).toBe(true);
    expect(DEV_PNG_ASSETS.filter(({ category }) => category === "App Icons").every(({ placeable }) => !placeable)).toBe(true);
    const dungeonScenes = filterDevPngAssets("", "Dungeon Scenes", true);
    expect(dungeonScenes).toHaveLength(139);
    expect(dungeonScenes.every(({ sourcePath, usageLabel }) =>
      sourcePath.startsWith("apps/client/public/assets/dungeons/") && usageLabel === "Dungeon Scene Asset"
    )).toBe(true);
  });

  it.each([
    ["structures/manor.png", ["WORLD_PNG_PRESENTATION.manor"]],
    ["manor-marker.png", ["WORLD_PNG_PRESENTATION.worldMapManor"]],
    ["structures/furnace.png", ["WORLD_PNG_PRESENTATION.furnace"]],
    ["structures/atlas-shrine.png", [
      "WORLD_PNG_PRESENTATION.atlasShrine",
      "WORLD_PNG_PRESENTATION.worldMapAtlasShrine"
    ]],
    ["structures/tannery.png", ["WORLD_PNG_PRESENTATION.tannery"]],
    ["structures/city-hall.png", ["SPRITE_PRESENTATION.city"]],
    ["city-marker.png", ["WORLD_PNG_PRESENTATION.worldMapCity"]],
    ["structures/mayor-house.png", ["WORLD_PNG_PRESENTATION.cityStructures.mayor_house"]],
    ["structures/OilWell1.png", ["WORLD_PNG_PRESENTATION.cityStructures.oil_well"]],
    ["structures/city-house.png", ["WORLD_PNG_PRESENTATION.cityStructures.city_house"]],
    ["structures/city-warehouse.png", ["WORLD_PNG_PRESENTATION.cityStructures.warehouse"]],
    ["structures/cistern-warrens.png", ["WORLD_PNG_PRESENTATION.cityStructures.cistern_warrens"]],
    ["structures/city-salon.png", ["WORLD_PNG_PRESENTATION.cityStructures.salon"]],
    ["structures/city-kennel.png", ["WORLD_PNG_PRESENTATION.cityStructures.city_kennel"]],
    ["structures/city-market.png", ["WORLD_PNG_PRESENTATION.cityStructures.market"]],
    ["coastal-crab.png", ["SPRITE_PRESENTATION.coastalCrab"]],
    ["goblins/goblin-basic.png", ["SPRITE_PRESENTATION.goblinBasic"]],
    ["goblins/goblin-warrior.png", ["SPRITE_PRESENTATION.goblinWarrior"]],
    ["goblins/goblin-archer.png", ["SPRITE_PRESENTATION.goblinArcher"]],
    ["goblins/goblin-healer.png", ["SPRITE_PRESENTATION.goblinHealer"]],
    ["goblins/goblin-hall.png", ["SPRITE_PRESENTATION.goblinHall"]],
    ["goblins/goblin-market.png", ["WORLD_PNG_PRESENTATION.cityStructures.goblin_market"]],
    ["structures/city-monument-mining.png", ["WORLD_PNG_PRESENTATION.cityStructures.monument_mining"]],
    ["structures/city-monument-forestry.png", ["WORLD_PNG_PRESENTATION.cityStructures.monument_forestry"]],
    ["structures/city-monument-hunting.png", ["WORLD_PNG_PRESENTATION.cityStructures.monument_hunting"]],
    ["structures/kingdom-seat.png", ["SPRITE_PRESENTATION.kingdomSeat"]],
    ["kingdom-seat-marker.png", ["WORLD_PNG_PRESENTATION.worldMapKingdom"]],
    ["flags/buoy-color.png", ["SPRITE_PRESENTATION.buoy"]],
    ["flags/buoy-hardware.png", ["SPRITE_PRESENTATION.buoy"]]
  ])("maps %s only to its production presentation", (path, sources) => {
    expect(productionSources(path)).toEqual(sources);
  });

  it("makes named Territory Flag and Buoy layers searchable as Buildings", () => {
    expect(filterDevPngAssets("Territory Flag", "Buildings").map(({ label }) => label)).toEqual([
      "Territory Flag Bastion Cloth Layer",
      "Territory Flag Bastion Hardware Layer",
      "Territory Flag Default Cloth Layer",
      "Territory Flag Default Hardware Layer",
      "Territory Flag Tower Cloth Layer",
      "Territory Flag Tower Hardware Layer"
    ]);
    expect(filterDevPngAssets("Territory Buoy", "Buildings").map(({ label }) => label)).toEqual([
      "Territory Buoy Color Layer",
      "Territory Buoy Hardware Layer"
    ]);
    expect(filterDevPngAssets("Territory Flag", "Buildings")
      .every(({ productionSize }) => productionSize === null)).toBe(true);
  });
});

function productionSources(relativePath: string): Array<string | undefined> {
  const sourcePath = `apps/client/src/assets/${relativePath}`;
  return DEV_PNG_ASSETS
    .filter((asset) => asset.sourcePath === sourcePath)
    .map(({ productionSource }) => productionSource);
}

function pngFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? pngFiles(path)
      : entry.name.toLowerCase().endsWith(".png") ? [path] : [];
  });
}
