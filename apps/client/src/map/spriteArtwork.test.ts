import {
  UNIVERSAL_FOOD_ITEM_IDS,
  type CollectibleNode,
  type EquipmentDefinitionId
} from "@ash-atlas/shared";
import { Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";

import {
  collectibleArtworkKey,
  collectiblesSignature,
  createMobSprite,
  DROPPED_ITEM_HIT_RADIUS_PX,
  droppedItemHitRadiusForArtwork,
  droppedItemArtworkKey,
  MOB_SPRITE_PRESENTATION,
  mobArtworkKey,
  shouldRecreateRetainedMobArtwork,
  SPRITE_ARTWORK_URLS,
  WORLD_SPRITE_PRESENTATION
} from "./pixiOverlay.js";
import { itemArtworkSource } from "../ui/ItemArtwork.js";
import { SPRITE_PRESENTATION } from "./spritePresentation.js";
import { setWorldPngMasterScalePreview } from "./worldPngMasterScale.js";

describe("canonical sprite artwork", () => {
  it("resolves production mobs to their shared PNG textures", () => {
    expect(mobArtworkKey("alligator")).toBe("alligator");
    expect(mobArtworkKey("bear")).toBe("bear");
    expect(mobArtworkKey("deer")).toBe("deer");
    expect(mobArtworkKey("frog")).toBe("frog");
    expect(mobArtworkKey("coastal_crab")).toBe("coastalCrab");
    expect(mobArtworkKey("hog")).toBe("hog");
    expect(mobArtworkKey("jellyfish")).toBe("jellyfish");
    expect(mobArtworkKey("fire_bird")).toBe("fireBird");
    expect(mobArtworkKey("lightning_bird")).toBe("lightningBird");
    expect(mobArtworkKey("ice_bird")).toBe("iceBird");
    expect(mobArtworkKey("mysterious_traveler")).toBe("mysteriousTraveler");
    expect(mobArtworkKey("ogre")).toBe("ogre");
    expect(mobArtworkKey("wolf")).toBe("wolf");
    expect(mobArtworkKey("sap_crawler")).toBe("sapCrawler");
    expect(mobArtworkKey("squid")).toBe("squid");
    expect(mobArtworkKey("goblin")).toBe("goblinBasic");
    expect(mobArtworkKey("goblin", "goblin")).toBe("goblinBasic");
    expect(mobArtworkKey("goblin", "goblin_warrior")).toBe("goblinWarrior");
    expect(mobArtworkKey("goblin", "goblin_archer")).toBe("goblinArcher");
    expect(mobArtworkKey("goblin", "goblin_healer")).toBe("goblinHealer");
    expect(MOB_SPRITE_PRESENTATION.deer.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.ogre.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.goblinBasic).toBe(SPRITE_PRESENTATION.goblinBasic);
    expect(MOB_SPRITE_PRESENTATION.goblinWarrior).toBe(SPRITE_PRESENTATION.goblinWarrior);
    expect(MOB_SPRITE_PRESENTATION.goblinArcher).toBe(SPRITE_PRESENTATION.goblinArcher);
    expect(MOB_SPRITE_PRESENTATION.goblinHealer).toBe(SPRITE_PRESENTATION.goblinHealer);
    expect(MOB_SPRITE_PRESENTATION.goblinBasic).not.toBe(SPRITE_PRESENTATION.ogre);
    expect(MOB_SPRITE_PRESENTATION.bear.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.mysteriousTraveler.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.wolf.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.sapCrawler.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.coastalCrab.hitGeometry.shape).toBe("rectangle");
    expect(MOB_SPRITE_PRESENTATION.sapCrawler.baseHeightPx)
      .toBeLessThan(MOB_SPRITE_PRESENTATION.wolf.baseHeightPx);
    expect(MOB_SPRITE_PRESENTATION.generic.baseHeightPx).toBe(54);
    expect(MOB_SPRITE_PRESENTATION.generic.minHeightPx).toBe(13.5);
    expect(MOB_SPRITE_PRESENTATION.generic.maxHeightPx).toBeNull();
  });

  it("uses the production-sized tree and stone-mine artwork presentations", () => {
    expect(collectibleArtworkKey(node({ type: "wood", berryAvailable: true }))).toBe("resinTree");
    expect(collectibleArtworkKey(node({
      type: "wood",
      resinAvailable: false, berryAvailable: true
    }))).toBe("resinTree");
    expect(collectibleArtworkKey(node({ type: "wood", berryAvailable: false }))).toBe("tree");
    expect(collectibleArtworkKey(node({
      id: "tree-200",
      type: "wood"
    }))).toBe("willowTree");
    expect(collectibleArtworkKey(node({
      id: "tree-204",
      type: "wood"
    }))).toBe("chinesePistache");
    expect(collectibleArtworkKey(node({
      type: "stone",
      repeatableNodeType: "stone_mine"
    }))).toBe("stoneMine");
    expect(collectibleArtworkKey(node({
      type: "coal",
      repeatableNodeType: "coal_mine"
    }))).toBe("coalMine");
    expect(collectibleArtworkKey(node({
      type: "iron",
      repeatableNodeType: "iron_mine"
    }))).toBe("ironMine");
    expect(collectibleArtworkKey(node({
      type: "sulfur",
      repeatableNodeType: "sulfur_mine"
    }))).toBe("sulfurMine");
    expect(collectibleArtworkKey(node({ type: "flax_fiber" }))).toBe("flax");
    expect(WORLD_SPRITE_PRESENTATION.sulfur).toBeDefined();
    expect(WORLD_SPRITE_PRESENTATION.flax).toBeDefined();
    expect(WORLD_SPRITE_PRESENTATION.sulfurMine).toBeDefined();
    expect(WORLD_SPRITE_PRESENTATION.tree.baseHeightPx).toBe(86.4);
    expect(WORLD_SPRITE_PRESENTATION.willowTree.baseHeightPx).toBe(113.8);
    expect(WORLD_SPRITE_PRESENTATION.chinesePistache.baseHeightPx).toBe(81.5);
    expect(WORLD_SPRITE_PRESENTATION.stoneMine.baseHeightPx).toBe(87.8);
    expect(WORLD_SPRITE_PRESENTATION.coalMine.baseHeightPx).toBe(87.8);
    expect(WORLD_SPRITE_PRESENTATION.ironMine.baseHeightPx).toBe(87.8);
    expect(WORLD_SPRITE_PRESENTATION.flax.baseHeightPx).toBe(54);
    expect(WORLD_SPRITE_PRESENTATION.sulfurMine.baseHeightPx).toBe(50);
  });

  it("invalidates collectible rendering for resin and tree-life changes", () => {
    const resinTree = node({
      resinAvailable: true,
      treeLifeRevision: 4
    });
    expect(collectiblesSignature([
      { ...resinTree, resinAvailable: false }
    ])).not.toBe(collectiblesSignature([resinTree]));
    expect(collectiblesSignature([
      { ...resinTree, treeLifeRevision: 5 }
    ])).not.toBe(collectiblesSignature([resinTree]));
  });

  it("routes gameplay flag variants through canonical world sprite presentation", () => {
    expect(WORLD_SPRITE_PRESENTATION.flag).toBeDefined();
    expect(WORLD_SPRITE_PRESENTATION.flag.baseHeightPx).toBe(25 * 1.5);
    expect(WORLD_SPRITE_PRESENTATION.flag.hitGeometry).toMatchObject({ shape: "circle", radiusPx: 24 });
    expect(WORLD_SPRITE_PRESENTATION.kingdomSeat.baseHeightPx).toBe(140);
    expect(WORLD_SPRITE_PRESENTATION.kingdomSeat.hitGeometry).toEqual({
      shape: "rectangle",
      centerX: 0.501,
      centerY: 0.5,
      width: 0.8,
      height: 0.8
    });
  });

  it("uses canonical item textures for every droppable material", () => {
    expect(droppedItemArtworkKey("stone")).toBe("stone");
    expect(droppedItemArtworkKey("wood")).toBe("wood");
    expect(droppedItemArtworkKey("leather")).toBe("leather");
    expect(droppedItemArtworkKey("food")).toBe("food");
    expect(droppedItemArtworkKey("ore")).toBe("ore");
    expect(droppedItemArtworkKey("water")).toBe("water");
    expect(droppedItemArtworkKey("balsam_resin")).toBe("balsam_resin");
    expect(droppedItemArtworkKey("crude_oil")).toBe("crude_oil");
    expect(droppedItemArtworkKey("jellyfish_venom")).toBe("jellyfish_venom");
    expect(droppedItemArtworkKey("sulfur")).toBe("sulfur");
    expect(WORLD_SPRITE_PRESENTATION.iron_bar).toBe(SPRITE_PRESENTATION.iron_bar);
    expect(WORLD_SPRITE_PRESENTATION.sulfur).toBe(SPRITE_PRESENTATION.sulfur);
    expect(WORLD_SPRITE_PRESENTATION.flax_fiber).toBe(SPRITE_PRESENTATION.flax_fiber);
    for (const itemId of UNIVERSAL_FOOD_ITEM_IDS) {
      expect(droppedItemArtworkKey(itemId)).toBe("food");
    }
    expect(droppedItemArtworkKey("breast_plate" as EquipmentDefinitionId)).toBe("breast_plate");
    expect(DROPPED_ITEM_HIT_RADIUS_PX).toBe(18);
    expect(WORLD_SPRITE_PRESENTATION.stone.hitGeometry.shape).toBe("rectangle");
    expect(WORLD_SPRITE_PRESENTATION.leather.hitGeometry.shape).toBe("rectangle");
  });

  it("scales PNG drop hit radii without changing vector fallbacks", () => {
    setWorldPngMasterScalePreview(2);
    try {
      expect(droppedItemHitRadiusForArtwork("stone"))
        .toBe(DROPPED_ITEM_HIT_RADIUS_PX * 2);
      expect(droppedItemHitRadiusForArtwork(null)).toBe(DROPPED_ITEM_HIT_RADIUS_PX);
    } finally {
      setWorldPngMasterScalePreview(null);
    }
  });

  it("loads every world sprite through a canonical repository asset import", () => {
    expect(SPRITE_ARTWORK_URLS.alligator).toMatch(/\/assets\/alligator\.png$/);
    expect(SPRITE_ARTWORK_URLS.bear).toMatch(/\/assets\/bear\.png$/);
    expect(SPRITE_ARTWORK_URLS.deer).toMatch(/\/assets\/deer\.png$/);
    expect(SPRITE_ARTWORK_URLS.frog).toMatch(/\/assets\/frog\.png$/);
    expect(SPRITE_ARTWORK_URLS.hog).toMatch(/\/assets\/hog\.png$/);
    expect(SPRITE_ARTWORK_URLS.jellyfish).toMatch(/\/assets\/jellyfish\.png$/);
    expect(SPRITE_ARTWORK_URLS.fireBird).toMatch(/\/assets\/fire-bird\.png$/);
    expect(SPRITE_ARTWORK_URLS.lightningBird).toMatch(/\/assets\/lightning-bird\.png$/);
    expect(SPRITE_ARTWORK_URLS.iceBird).toMatch(/\/assets\/ice-bird\.png$/);
    expect(SPRITE_ARTWORK_URLS.mysteriousTraveler)
      .toMatch(/\/assets\/mysterious-traveler\.png$/);
    expect(SPRITE_ARTWORK_URLS.ogre).toMatch(/\/assets\/ogre\.png$/);
    expect(SPRITE_ARTWORK_URLS.wolf).toMatch(/\/assets\/wolf\.png$/);
    expect(SPRITE_ARTWORK_URLS.sapCrawler)
      .toMatch(/\/assets\/resin-crawler\.png$/);
    expect(SPRITE_ARTWORK_URLS.squid).toMatch(/\/assets\/squid\.png$/);
    expect(SPRITE_ARTWORK_URLS.goblinBasic)
      .toMatch(/\/assets\/goblins\/goblin-basic\.png$/);
    expect(SPRITE_ARTWORK_URLS.goblinWarrior)
      .toMatch(/\/assets\/goblins\/goblin-warrior\.png$/);
    expect(SPRITE_ARTWORK_URLS.goblinArcher)
      .toMatch(/\/assets\/goblins\/goblin-archer\.png$/);
    expect(SPRITE_ARTWORK_URLS.goblinHealer)
      .toMatch(/\/assets\/goblins\/goblin-healer\.png$/);
    expect(SPRITE_ARTWORK_URLS.tree).toMatch(/\/assets\/tree\.png$/);
    expect(SPRITE_ARTWORK_URLS.resinTree).toMatch(/\/assets\/ResinTree1\.png$/);
    expect(SPRITE_ARTWORK_URLS.willowTree)
      .toMatch(/\/assets\/willow-tree\.png$/);
    expect(SPRITE_ARTWORK_URLS.chinesePistache)
      .toMatch(/\/assets\/chinese-pistache\.png$/);
    expect(SPRITE_ARTWORK_URLS.flax).toMatch(/\/assets\/wild-flax\.png$/);
    expect(SPRITE_ARTWORK_URLS.stoneMine).toMatch(/\/assets\/stone-mine\.png$/);
    expect(SPRITE_ARTWORK_URLS.coalMine).toMatch(/\/assets\/coal-mine\.png$/);
    expect(SPRITE_ARTWORK_URLS.ironMine).toMatch(/\/assets\/iron-mine\.png$/);
    expect(SPRITE_ARTWORK_URLS.sulfurMine).toMatch(/\/assets\/sulfur-mine\.png$/);
    expect(SPRITE_ARTWORK_URLS.stone).toMatch(/\/assets\/items\/stone\.png$/);
    expect(SPRITE_ARTWORK_URLS.coal).toMatch(/\/assets\/items\/coal\.png$/);
    expect(SPRITE_ARTWORK_URLS.iron).toMatch(/\/assets\/items\/iron\.png$/);
    expect(SPRITE_ARTWORK_URLS.wood).toMatch(/\/assets\/items\/wood\.png$/);
    expect(SPRITE_ARTWORK_URLS.leather).toMatch(/\/assets\/items\/leather\.png$/);
    expect(SPRITE_ARTWORK_URLS.food).toMatch(/\/assets\/items\/food\.png$/);
    expect(SPRITE_ARTWORK_URLS.ore).toMatch(/\/assets\/items\/ore\.png$/);
    expect(SPRITE_ARTWORK_URLS.water).toMatch(/\/assets\/items\/water\.png$/);
    expect(SPRITE_ARTWORK_URLS.balsam_resin).toMatch(/\/assets\/items\/Resin1\.png$/);
    expect(SPRITE_ARTWORK_URLS.jellyfish_venom)
      .toMatch(/\/assets\/items\/jellyfish-venom\.png$/);
    for (const url of Object.values(SPRITE_ARTWORK_URLS).filter(
      (value): value is string => typeof value === "string"
    )) {
      expect(url).not.toMatch(/^[A-Z]:\\/i);
    }
  });

  it("renders resolved goblin defender artwork as a sprite instead of fallback graphics", () => {
    const texture = Texture.WHITE;
    const textures = {
      goblinBasic: texture,
      goblinWarrior: texture,
      goblinArcher: texture,
      goblinHealer: texture
    } as unknown as Parameters<typeof createMobSprite>[3];

    for (const presentationKey of [
      "goblin",
      "goblin_warrior",
      "goblin_archer",
      "goblin_healer"
    ]) {
      const artworkKey = mobArtworkKey("goblin", presentationKey);
      const artwork = createMobSprite("goblin", artworkKey, 0x84cc16, textures);
      expect(artwork.children[0]).toBeInstanceOf(Sprite);
      expect((artwork.children[0] as Sprite).texture).toBe(texture);
    }
  });

  it("keeps inventory resources on the shared ItemArtwork registry", () => {
    expect(itemArtworkSource("stone")).toMatch(/\/assets\/items\/stone\.png$/);
    expect(itemArtworkSource("coal")).toMatch(/\/assets\/items\/coal\.png$/);
    expect(itemArtworkSource("iron")).toMatch(/\/assets\/items\/iron\.png$/);
    expect(itemArtworkSource("wood")).toMatch(/\/assets\/items\/wood\.png$/);
    expect(itemArtworkSource("leather")).toMatch(/\/assets\/items\/leather\.png$/);
    expect(itemArtworkSource("balsam_resin")).toMatch(/\/assets\/items\/Resin1\.png$/);
    expect(itemArtworkSource("crude_oil")).toMatch(/\/assets\/items\/CrudeOil1\.png$/);
    expect(itemArtworkSource("jellyfish_venom"))
      .toMatch(/\/assets\/items\/jellyfish-venom\.png$/);
    for (const itemId of [
      "fire_feather", "tempest_quill", "ice_feather",
      "fire_bar", "lightning_bar", "ice_bar",
      "fire_core", "lightning_core", "ice_core"
    ]) {
      expect(itemArtworkSource(itemId))
        .toMatch(new RegExp(`/assets/items/${itemId.replaceAll("_", "-")}\\.png$`));
    }
  });
});

function node(overrides: Partial<CollectibleNode>): CollectibleNode {
  return {
    id: "node",
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 1,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "cell",
    waterKind: null,
    ...overrides
  };
}
