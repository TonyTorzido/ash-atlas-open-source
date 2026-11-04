import { describe, expect, it } from "vitest";

import { runtimeAssetCategory, runtimeAssetUsages } from "./runtimeAssetCatalog.js";

const ROOT = "apps/client/src/assets/";

describe("runtime asset catalog production usages", () => {
  it.each([
    ["structures/manor.png", ["manor"]],
    ["manor-marker.png", ["worldMapManor"]],
    ["structures/furnace.png", ["furnace"]],
    ["structures/atlas-shrine.png", ["worldMapAtlasShrine"]],
    ["structures/tannery.png", ["tannery"]],
    ["structures/loom.png", ["loom"]],
    ["structures/city-hall.png", ["city"]],
    ["city-marker.png", ["worldMapCity"]],
    ["structures/mayor-house.png", ["cityStructures.mayor_house"]],
    ["structures/OilWell1.png", ["cityStructures.oil_well"]],
    ["structures/city-house.png", ["cityStructures.city_house"]],
    ["structures/city-warehouse.png", ["cityStructures.warehouse"]],
    ["structures/cistern-warrens.png", ["cityStructures.cistern_warrens"]],
    ["structures/city-salon.png", ["cityStructures.salon"]],
    ["structures/city-kennel.png", ["cityStructures.city_kennel"]],
    ["structures/city-market.png", ["cityStructures.market"]],
    ["structures/city-monument-mining.png", ["cityStructures.monument_mining"]],
    ["structures/city-monument-forestry.png", ["cityStructures.monument_forestry"]],
    ["structures/city-monument-hunting.png", ["cityStructures.monument_hunting"]],
    ["structures/kingdom-seat.png", ["kingdomSeat"]],
    ["kingdom-seat-marker.png", ["worldMapKingdom"]],
    ["flags/buoy-color.png", ["buoy"]],
    ["flags/buoy-hardware.png", ["buoy"]]
  ])("maps %s only to its production presentation", (path, keys) => {
    expect(editableKeys(`${ROOT}${path}`)).toEqual(keys);
  });

  it.each([
    ["structures/city-monument-mining.png", "Mining Monument"],
    ["structures/city-monument-forestry.png", "Forestry Monument"],
    ["structures/city-monument-hunting.png", "Hunting Monument"]
  ])("names %s as its district Monument", (path, label) => {
    expect(runtimeAssetUsages(`${ROOT}${path}`).map((usage) => usage.label))
      .toEqual([label]);
  });

  it("keeps each Territory Flag layer named, searchable, and geometry-readonly", () => {
    for (const [path, pieceName] of [
      ["flags/default-cloth.png", "Soft flag cloth"],
      ["flags/default-hardware.png", "Pole and fittings"],
      ["flags/bastion-cloth.png", "Bastion flag cloth"],
      ["flags/bastion-hardware.png", "Pole, fittings and stone base"],
      ["flags/tower-cloth.png", "Tower pennant cloth"],
      ["flags/tower-hardware.png", "Tower and flagpole"]
    ] as const) {
      expect(runtimeAssetCategory(`${ROOT}${path}`)).toBe("Territory");
      const usages = runtimeAssetUsages(`${ROOT}${path}`);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.label).toBe(`Stock Flag Pack · ${pieceName}`);
      expect(usages[0]?.editor.kind).toBe("readonly");
    }
  });

  it("retains unrelated shared bird artwork runtime ownership", () => {
    expect(editableKeys(`${ROOT}fire-bird.png`)).toEqual(["fireBird"]);
    expect(editableKeys(`${ROOT}lightning-bird.png`)).toEqual(["lightningBird"]);
    expect(editableKeys(`${ROOT}ice-bird.png`)).toEqual(["iceBird"]);
  });

  it("marks persistent buildings as zoom-scaled and map markers as fixed", () => {
    expect(runtimeAssetUsages(`${ROOT}structures/tannery.png`)[0]?.editor)
      .toEqual({ kind: "world-object", key: "tannery" });
    expect(runtimeAssetUsages(`${ROOT}structures/loom.png`)[0]?.editor)
      .toEqual({ kind: "world-object", key: "loom" });
    expect(runtimeAssetUsages(`${ROOT}structures/cistern-warrens.png`)[0]?.editor)
      .toEqual({ kind: "world-object", key: "cityStructures.cistern_warrens" });
    expect(runtimeAssetUsages(`${ROOT}city-marker.png`)[0]?.editor)
      .toEqual({ kind: "fixed", key: "worldMapCity" });
  });

  it("gives item artwork one shared editable presentation for every surface", () => {
    expect(runtimeAssetUsages(`${ROOT}items/iron-bar.png`)).toMatchObject([{
      label: "Item Artwork — Shared Size",
      context: "Permanent runtime size authored here and shared by inventory, menus, and every ground-drop scene",
      editor: { kind: "sprite", key: "iron_bar" }
    }]);
    expect(runtimeAssetUsages(`${ROOT}items/Resin1.png`).map(({ editor }) => editor)).toEqual([
      { kind: "sprite", key: "balsam_resin" },
      { kind: "fixed", key: "resinGain" }
    ]);
    expect(editableKeys(`${ROOT}items/coin.png`)).toEqual(["gold"]);
    expect(editableKeys(`${ROOT}items/enchantment-stones/amethyst.png`))
      .toEqual(["enchantment_stone:amethyst"]);
    expect(editableKeys(`${ROOT}items/generic.png`)).toEqual(["generic"]);
  });

  it("exposes production military slots before their PNGs exist", () => {
    expect(runtimeAssetCategory(`${ROOT}military/units/infantry.png`)).toBe("Military");
    expect(runtimeAssetUsages(`${ROOT}military/units/infantry.png`)[0]?.editor)
      .toEqual({ kind: "sprite", key: "militaryUnits.infantry" });
    expect(runtimeAssetUsages(`${ROOT}structures/barracks.png`)[0]?.editor)
      .toEqual({ kind: "world-object", key: "cityStructures.barracks" });
    expect(runtimeAssetUsages(`${ROOT}structures/powder-works.png`)[0]?.editor)
      .toEqual({ kind: "world-object", key: "cityStructures.powder_works" });
  });

  it("exposes every independently authored Siege and Bomber state slot", () => {
    const slots = [
      ["military/units/siege-packed.png", "Kippen Siege · Mobile / Idle", "militaryUnits.field_ballista.packed"],
      ["military/units/siege-deployed.png", "Kippen Siege · Deployed / Loading", "militaryUnits.field_ballista.deployed"],
      ["military/units/siege-launch.png", "Kippen Siege · Launch", "militaryUnits.field_ballista.launch"],
      ["military/units/bomber-idle.png", "Kippen Bomber · Idle", "militaryUnits.bomber.idle"],
      ["military/units/bomber-planting.png", "Kippen Bomber · Planting", "militaryUnits.bomber.planting"]
    ] as const;
    for (const [path, label, key] of slots) {
      const usage = runtimeAssetUsages(`${ROOT}${path}`)[0];
      expect(runtimeAssetCategory(`${ROOT}${path}`)).toBe("Military");
      expect(usage).toMatchObject({ label, editor: { kind: "sprite", key } });
    }
  });

  it.each(["DogBaby1.png", "DogAdult1.png", "DogOld1.png"])(
    "maps dogs/%s to editable world dog sizing",
    (fileName) => {
      const usages = runtimeAssetUsages(`${ROOT}dogs/${fileName}`);
      expect(usages.map(({ editor }) => editor.kind)).toEqual(["readonly", "sprite"]);
      expect(editableKeys(`${ROOT}dogs/${fileName}`)).toEqual(["dog"]);
    }
  );
});

function editableKeys(relativeFile: string): string[] {
  return runtimeAssetUsages(relativeFile).flatMap(({ editor }) =>
    editor.kind === "sprite" || editor.kind === "fixed" || editor.kind === "world-object"
      ? [editor.key]
      : []
  );
}
