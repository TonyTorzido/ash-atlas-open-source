import { registerDevPngAssets } from "./devPngCatalogRegistry.js";
import {
  SPRITE_PRESENTATION,
  type SpritePresentation
} from "../map/spritePresentation.js";
import type { RuntimeSpritePresentation } from "@ash-atlas/shared";
import { PLAYER_RAFT_PRESENTATION } from "../players/raftPresentation.js";

import {
  WORLD_PNG_PRESENTATION,
  type FixedWorldPngPresentation,
  type ZoomScaledWorldPngPresentation
} from "../map/worldPngPresentation.js";
import {
  worldPngFixedMasterScale,
  worldPngSpriteKeyMasterScale,
  worldPngSpriteMasterScale
} from "../map/worldPngMasterScale.js";

export type DevPngAnchor = Readonly<{ x: number; y: number; label: string }>;

export type DevPngProductionSize =
  | Readonly<{
      kind: "fixed";
      width: number;
      height: number;
      unit: "px";
      source: string;
      definedIn: string;
      masterScale(): number;
    }>
  | Readonly<{
      kind: "zoom-scaled";
      presentation: SpritePresentation;
      source: string;
      definedIn: string;
      masterScale(): number;
    }>
  | Readonly<{
      kind: "item-scaled";
      presentation: SpritePresentation;
      source: string;
      definedIn: string;
      masterScale(): number;
    }>;

export type DevPngAsset = Readonly<{
  id: string;
  label: string;
  category: string;
  url: string;
  usageLabel: string;
  sourcePath: string;
  productionSize: DevPngProductionSize | null;
  productionSource?: string;
  anchor: DevPngAnchor;
  placeable: boolean;
}>;

type Usage = Omit<DevPngAsset, "id" | "url" | "sourcePath"> & {
  idSuffix: string;
};

const assetModules = import.meta.glob<string>("../assets/**/*.png", {
  eager: true,
  import: "default",
  query: "?url"
});

const BOTTOM_CENTER: DevPngAnchor = { x: 0.5, y: 1, label: "Bottom center" };
const CENTER: DevPngAnchor = { x: 0.5, y: 0.5, label: "Center" };

function zoomScaled(
  key: keyof typeof SPRITE_PRESENTATION
): DevPngProductionSize {
  return {
    kind: "zoom-scaled",
    presentation: SPRITE_PRESENTATION[key],
    source: `SPRITE_PRESENTATION.${key}`,
    definedIn: "apps/client/src/map/spritePresentation.ts",
    masterScale: () => worldPngSpriteKeyMasterScale(key)
  };
}

function itemScaled(
  key: keyof typeof SPRITE_PRESENTATION
): DevPngProductionSize {
  return {
    kind: "item-scaled",
    presentation: SPRITE_PRESENTATION[key],
    source: `RUNTIME_PNG_PRESENTATION_CATALOG.sprites.${key}`,
    definedIn: "packages/shared/src/data/runtime-png-presentation.json",
    masterScale: () => 1
  };
}

function zoomScaledPresentation(
  presentation: SpritePresentation & Readonly<{ masterScaleKey?: string }>,
  source: string,
  definedIn: string
): DevPngProductionSize {
  return {
    kind: "zoom-scaled",
    presentation,
    source,
    definedIn,
    masterScale: () => presentation.masterScaleKey
      ? worldPngFixedMasterScale(presentation.masterScaleKey)
      : worldPngSpriteMasterScale(presentation as RuntimeSpritePresentation)
  };
}

function fixed(presentation: FixedWorldPngPresentation): DevPngProductionSize {
  return {
    kind: "fixed",
    width: presentation.width,
    height: presentation.height,
    unit: "px",
    source: presentation.source,
    definedIn: presentation.definedIn,
    masterScale: () => worldPngFixedMasterScale(presentation.masterScaleKey)
  };
}

function cssFixed(
  width: number,
  height: number,
  source: string
): DevPngProductionSize {
  return {
    kind: "fixed",
    width,
    height,
    unit: "px",
    source,
    definedIn: "apps/client/src/styles.css",
    masterScale: () => 1
  };
}

function chatCrestUsage(label: string, idSuffix: string): Usage {
  return {
    idSuffix,
    label: `Chat Crest · ${label}`,
    category: "Chat Crests",
    usageLabel: "Atlas Chats player identity crest",
    productionSize: cssFixed(38, 38, ".chat-message-crest"),
    productionSource: "ChatPanel.tsx message groups and Chat Settings",
    placeable: false,
    anchor: CENTER
  };
}

const usagesByFile: Readonly<Record<string, readonly Usage[]>> = {
  "chat-crests/lion.png": [chatCrestUsage("Lion", "chat-crest-lion")],
  "chat-crests/leaf.png": [chatCrestUsage("Leaf", "chat-crest-leaf")],
  "chat-crests/stag.png": [chatCrestUsage("Stag", "chat-crest-stag")],
  "chat-crests/cross.png": [chatCrestUsage("Cross", "chat-crest-cross")],
  "military/units/archer.png": [militaryUnitUsage("Archer", "archer")],
  "military/units/bomber.png": [militaryUnitUsage("Bomber", "bomber")],
  "military/units/field-ballista-crew.png": [militaryUnitUsage("Siege", "field_ballista")],
  "military/units/infantry.png": [militaryUnitUsage("Melee Kippin", "infantry")],
  "fishing/PixelFish.png": [{
    idSuffix: "fishing-encounter-fish",
    label: "Fishing Encounter Fish",
    category: "Fishing",
    usageLabel: "Fishing Fight Scene Fish",
    productionSize: null,
    productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
    placeable: false,
    anchor: CENTER
  }],
  "fishing/RiverBackground.png": [{
    idSuffix: "fishing-river-background",
    label: "Fishing River Background",
    category: "Fishing",
    usageLabel: "Fishing River Fight Scene",
    productionSize: null,
    productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
    placeable: false,
    anchor: CENTER
  }],
  "fishing/LakeBackground.png": [{
    idSuffix: "fishing-lake-background",
    label: "Fishing Lake Background",
    category: "Fishing",
    usageLabel: "Fishing Lake Fight Scene",
    productionSize: null,
    productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
    placeable: false,
    anchor: CENTER
  }],
  "fishing/OceanBackground.png": [{
    idSuffix: "fishing-ocean-background",
    label: "Fishing Ocean Background",
    category: "Fishing",
    usageLabel: "Fishing Ocean Fight Scene",
    productionSize: null,
    productionSource: "FishingEncounterScene in apps/client/src/ui/FishingPrompt.tsx",
    placeable: false,
    anchor: CENTER
  }],
  "city-marker.png": [worldMapDestinationUsage("City", WORLD_PNG_PRESENTATION.worldMapCity)],
  "kingdom-seat-marker.png": [
    worldMapDestinationUsage("Castle", WORLD_PNG_PRESENTATION.worldMapKingdom)
  ],
  "deer.png": [{
    idSuffix: "world-mob",
    label: "Deer",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("deer"),
    productionSource: "SPRITE_PRESENTATION.deer",
    placeable: true,
    anchor: { x: 0.5, y: 0.875, label: "Center, 87.5% down" }
  }],
  "frost-deer.png": [{
    idSuffix: "world-mob",
    label: "Frost Deer",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("frostDeer"),
    productionSource: "SPRITE_PRESENTATION.frostDeer",
    placeable: true,
    anchor: { x: 0.5, y: 0.875, label: "Center, 87.5% down" }
  }],
  "jungle-deer.png": [{
    idSuffix: "world-mob",
    label: "Jungle Deer",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("jungleDeer"),
    productionSource: "SPRITE_PRESENTATION.jungleDeer",
    placeable: true,
    anchor: { x: 0.5, y: 0.875, label: "Center, 87.5% down" }
  }],
  "marsh-deer.png": [{
    idSuffix: "world-mob",
    label: "Marsh Deer",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("marshDeer"),
    productionSource: "SPRITE_PRESENTATION.marshDeer",
    placeable: true,
    anchor: { x: 0.5, y: 0.875, label: "Center, 87.5% down" }
  }],
  "sand-deer.png": [{
    idSuffix: "world-mob",
    label: "Sand Deer",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("sandDeer"),
    productionSource: "SPRITE_PRESENTATION.sandDeer",
    placeable: true,
    anchor: { x: 0.5, y: 0.875, label: "Center, 87.5% down" }
  }],
  "wolf.png": [
    {
      idSuffix: "world-mob",
      label: "Wolf",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("wolf"),
      productionSource: "SPRITE_PRESENTATION.wolf",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "frost-wolf.png": [
    {
      idSuffix: "world-mob",
      label: "Frost Wolf",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frostWolf"),
      productionSource: "SPRITE_PRESENTATION.frostWolf",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "dune-wolf.png": [
    {
      idSuffix: "world-mob",
      label: "Dune Wolf",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("duneWolf"),
      productionSource: "SPRITE_PRESENTATION.duneWolf",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "jungle-wolf.png": [
    {
      idSuffix: "world-mob",
      label: "Jungle Wolf",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("jungleWolf"),
      productionSource: "SPRITE_PRESENTATION.jungleWolf",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "bog-wolf.png": [
    {
      idSuffix: "world-mob",
      label: "Bog Wolf",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bogWolf"),
      productionSource: "SPRITE_PRESENTATION.bogWolf",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "frost-wraith.png": [
    {
      idSuffix: "world-mob",
      label: "Frost Wraith",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frostWraith"),
      productionSource: "SPRITE_PRESENTATION.frostWraith",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "yeti.png": [
    {
      idSuffix: "world-mob",
      label: "Yeti",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("yeti"),
      productionSource: "SPRITE_PRESENTATION.yeti",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "barrow-wight.png": [
    {
      idSuffix: "world-mob",
      label: "Barrow Wight",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("barrowWight"),
      productionSource: "SPRITE_PRESENTATION.barrowWight",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "risen-skeleton.png": [
    {
      idSuffix: "world-mob",
      label: "Risen Skeleton",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("risenSkeleton"),
      productionSource: "SPRITE_PRESENTATION.risenSkeleton",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "revenant-lich.png": [
    {
      idSuffix: "world-mob",
      label: "Revenant Lich",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("revenantLich"),
      productionSource: "SPRITE_PRESENTATION.revenantLich",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "moss-golem.png": [
    {
      idSuffix: "world-mob",
      label: "Moss Golem",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mossGolem"),
      productionSource: "SPRITE_PRESENTATION.mossGolem",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "vine-lurker.png": [
    {
      idSuffix: "world-mob",
      label: "Vine Lurker",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("vineLurker"),
      productionSource: "SPRITE_PRESENTATION.vineLurker",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "lizardfolk-warrior.png": [
    {
      idSuffix: "world-mob",
      label: "Lizardfolk Warrior",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("lizardfolkWarrior"),
      productionSource: "SPRITE_PRESENTATION.lizardfolkWarrior",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "bog-ghoul.png": [
    {
      idSuffix: "world-mob",
      label: "Bog Ghoul",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bogGhoul"),
      productionSource: "SPRITE_PRESENTATION.bogGhoul",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "giant-scorpion.png": [
    {
      idSuffix: "world-mob",
      label: "Giant Scorpion",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("giantScorpion"),
      productionSource: "SPRITE_PRESENTATION.giantScorpion",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "dust-mummy.png": [
    {
      idSuffix: "world-mob",
      label: "Dust Mummy",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("dustMummy"),
      productionSource: "SPRITE_PRESENTATION.dustMummy",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "thunderhorn.png": [
    {
      idSuffix: "world-mob",
      label: "Thunderhorn",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("thunderhorn"),
      productionSource: "SPRITE_PRESENTATION.thunderhorn",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "griffin.png": [
    {
      idSuffix: "world-mob",
      label: "Griffin",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("griffin"),
      productionSource: "SPRITE_PRESENTATION.griffin",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "basilisk.png": [
    {
      idSuffix: "world-mob",
      label: "Basilisk",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("basilisk"),
      productionSource: "SPRITE_PRESENTATION.basilisk",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "jungle-tapir.png": [
    {
      idSuffix: "world-mob",
      label: "Jungle Tapir",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("jungleTapir"),
      productionSource: "SPRITE_PRESENTATION.jungleTapir",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "jaguar.png": [
    {
      idSuffix: "world-mob",
      label: "Jaguar",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("jaguar"),
      productionSource: "SPRITE_PRESENTATION.jaguar",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mandrill.png": [
    {
      idSuffix: "world-mob",
      label: "Mandrill",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mandrill"),
      productionSource: "SPRITE_PRESENTATION.mandrill",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "canopy-goblin.png": [
    {
      idSuffix: "world-mob",
      label: "Canopy Goblin",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("canopyGoblin"),
      productionSource: "SPRITE_PRESENTATION.canopyGoblin",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "poisonfrog-raider.png": [
    {
      idSuffix: "world-mob",
      label: "Poisonfrog Raider",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("poisonfrogRaider"),
      productionSource: "SPRITE_PRESENTATION.poisonfrogRaider",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "pantherfolk-stalker.png": [
    {
      idSuffix: "world-mob",
      label: "Pantherfolk Stalker",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("pantherfolkStalker"),
      productionSource: "SPRITE_PRESENTATION.pantherfolkStalker",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "vine-wrapped-corpse.png": [
    {
      idSuffix: "world-mob",
      label: "Vine-Wrapped Corpse",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("vineWrappedCorpse"),
      productionSource: "SPRITE_PRESENTATION.vineWrappedCorpse",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "serpent-priestess.png": [
    {
      idSuffix: "world-mob",
      label: "Serpent Priestess",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("serpentPriestess"),
      productionSource: "SPRITE_PRESENTATION.serpentPriestess",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "capercaillie.png": [
    {
      idSuffix: "world-mob",
      label: "Capercaillie",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("capercaillie"),
      productionSource: "SPRITE_PRESENTATION.capercaillie",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "bugbear-chieftain.png": [
    {
      idSuffix: "world-mob",
      label: "Bugbear Chieftain",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bugbearChieftain"),
      productionSource: "SPRITE_PRESENTATION.bugbearChieftain",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "pinewarden.png": [
    {
      idSuffix: "world-mob",
      label: "Pinewarden",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("pinewarden"),
      productionSource: "SPRITE_PRESENTATION.pinewarden",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gallows-ghost.png": [
    {
      idSuffix: "world-mob",
      label: "Gallows Ghost",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gallowsGhost"),
      productionSource: "SPRITE_PRESENTATION.gallowsGhost",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "alder-king.png": [
    {
      idSuffix: "world-mob",
      label: "Alder King",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("alderKing"),
      productionSource: "SPRITE_PRESENTATION.alderKing",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "elk.png": [
    {
      idSuffix: "world-mob",
      label: "Elk",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("elk"),
      productionSource: "SPRITE_PRESENTATION.elk",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "red-squirrel.png": [
    {
      idSuffix: "world-mob",
      label: "Red Squirrel",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("redSquirrel"),
      productionSource: "SPRITE_PRESENTATION.redSquirrel",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "pine-dryad.png": [
    {
      idSuffix: "world-mob",
      label: "Pine Dryad",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("pineDryad"),
      productionSource: "SPRITE_PRESENTATION.pineDryad",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "badger.png": [
    {
      idSuffix: "world-mob",
      label: "Badger",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("badger"),
      productionSource: "SPRITE_PRESENTATION.badger",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "grey-squirrel.png": [
    {
      idSuffix: "world-mob",
      label: "Grey Squirrel",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("greySquirrel"),
      productionSource: "SPRITE_PRESENTATION.greySquirrel",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "stag-beetle.png": [
    {
      idSuffix: "world-mob",
      label: "Stag Beetle",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("stagBeetle"),
      productionSource: "SPRITE_PRESENTATION.stagBeetle",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mossjaw-sneak.png": [
    {
      idSuffix: "world-mob",
      label: "Mossjaw Sneak",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mossjawSneak"),
      productionSource: "SPRITE_PRESENTATION.mossjawSneak",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mossjaw-spearman.png": [
    {
      idSuffix: "world-mob",
      label: "Mossjaw Spearman",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mossjawSpearman"),
      productionSource: "SPRITE_PRESENTATION.mossjawSpearman",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mossjaw-hexer.png": [
    {
      idSuffix: "world-mob",
      label: "Mossjaw Hexer",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mossjawHexer"),
      productionSource: "SPRITE_PRESENTATION.mossjawHexer",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mossjaw-warboss.png": [
    {
      idSuffix: "world-mob",
      label: "Mossjaw Warboss",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mossjawWarboss"),
      productionSource: "SPRITE_PRESENTATION.mossjawWarboss",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "hedge-witch.png": [
    {
      idSuffix: "world-mob",
      label: "Hedge Witch",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("hedgeWitch"),
      productionSource: "SPRITE_PRESENTATION.hedgeWitch",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "restless-gravedigger.png": [
    {
      idSuffix: "world-mob",
      label: "Restless Gravedigger",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("restlessGravedigger"),
      productionSource: "SPRITE_PRESENTATION.restlessGravedigger",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "coven-matron.png": [
    {
      idSuffix: "world-mob",
      label: "Coven Matron",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("covenMatron"),
      productionSource: "SPRITE_PRESENTATION.covenMatron",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "great-grey-owl.png": [
    {
      idSuffix: "world-mob",
      label: "Great Grey Owl",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("greatGreyOwl"),
      productionSource: "SPRITE_PRESENTATION.greatGreyOwl",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "flying-squirrel.png": [
    {
      idSuffix: "world-mob",
      label: "Flying Squirrel",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("flyingSquirrel"),
      productionSource: "SPRITE_PRESENTATION.flyingSquirrel",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "stagfolk-warden.png": [
    {
      idSuffix: "world-mob",
      label: "Stagfolk Warden",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("stagfolkWarden"),
      productionSource: "SPRITE_PRESENTATION.stagfolkWarden",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "rime-witch.png": [
    {
      idSuffix: "world-mob",
      label: "Rime Witch",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("rimeWitch"),
      productionSource: "SPRITE_PRESENTATION.rimeWitch",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "draugr-berserker.png": [
    {
      idSuffix: "world-mob",
      label: "Draugr Berserker",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("draugrBerserker"),
      productionSource: "SPRITE_PRESENTATION.draugrBerserker",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "snow-talonbear.png": [
    {
      idSuffix: "world-mob",
      label: "Snow Talonbear",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("snowTalonbear"),
      productionSource: "SPRITE_PRESENTATION.snowTalonbear",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frostwater-troll.png": [
    {
      idSuffix: "world-mob",
      label: "Frostwater Troll",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frostwaterTroll"),
      productionSource: "SPRITE_PRESENTATION.frostwaterTroll",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "underice-lurker.png": [
    {
      idSuffix: "world-mob",
      label: "Underice Lurker",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("undericeLurker"),
      productionSource: "SPRITE_PRESENTATION.undericeLurker",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "plains-bison.png": [
    {
      idSuffix: "world-mob",
      label: "Plains Bison",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("plainsBison"),
      productionSource: "SPRITE_PRESENTATION.plainsBison",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "prairie-dog.png": [
    {
      idSuffix: "world-mob",
      label: "Prairie Dog",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("prairieDog"),
      productionSource: "SPRITE_PRESENTATION.prairieDog",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "burrowing-owl.png": [
    {
      idSuffix: "world-mob",
      label: "Burrowing Owl",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("burrowingOwl"),
      productionSource: "SPRITE_PRESENTATION.burrowingOwl",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "centaur-outrider.png": [
    {
      idSuffix: "world-mob",
      label: "Centaur Outrider",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("centaurOutrider"),
      productionSource: "SPRITE_PRESENTATION.centaurOutrider",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "volt-elemental.png": [
    {
      idSuffix: "world-mob",
      label: "Volt Elemental",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("voltElemental"),
      productionSource: "SPRITE_PRESENTATION.voltElemental",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "possessed-scythe.png": [
    {
      idSuffix: "world-mob",
      label: "Possessed Scythe",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("possessedScythe"),
      productionSource: "SPRITE_PRESENTATION.possessedScythe",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "strawman-lord.png": [
    {
      idSuffix: "world-mob",
      label: "Strawman Lord",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("strawmanLord"),
      productionSource: "SPRITE_PRESENTATION.strawmanLord",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "giraffe.png": [
    {
      idSuffix: "world-mob",
      label: "Giraffe",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("giraffe"),
      productionSource: "SPRITE_PRESENTATION.giraffe",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "lioness.png": [
    {
      idSuffix: "world-mob",
      label: "Lioness",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("lioness"),
      productionSource: "SPRITE_PRESENTATION.lioness",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "spotted-hyena.png": [
    {
      idSuffix: "world-mob",
      label: "Spotted Hyena",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("spottedHyena"),
      productionSource: "SPRITE_PRESENTATION.spottedHyena",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gnoll-bonebow.png": [
    {
      idSuffix: "world-mob",
      label: "Gnoll Bonebow",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gnollBonebow"),
      productionSource: "SPRITE_PRESENTATION.gnollBonebow",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gnoll-packseer.png": [
    {
      idSuffix: "world-mob",
      label: "Gnoll Packseer",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gnollPackseer"),
      productionSource: "SPRITE_PRESENTATION.gnollPackseer",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gnoll-packlord.png": [
    {
      idSuffix: "world-mob",
      label: "Gnoll Packlord",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gnollPacklord"),
      productionSource: "SPRITE_PRESENTATION.gnollPacklord",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "carrion-ghoul.png": [
    {
      idSuffix: "world-mob",
      label: "Carrion Ghoul",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("carrionGhoul"),
      productionSource: "SPRITE_PRESENTATION.carrionGhoul",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "sun-griffin.png": [
    {
      idSuffix: "world-mob",
      label: "Sun Griffin",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("sunGriffin"),
      productionSource: "SPRITE_PRESENTATION.sunGriffin",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "sitatunga.png": [
    {
      idSuffix: "world-mob",
      label: "Sitatunga",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("sitatunga"),
      productionSource: "SPRITE_PRESENTATION.sitatunga",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "emperor-dragonfly.png": [
    {
      idSuffix: "world-mob",
      label: "Emperor Dragonfly",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("emperorDragonfly"),
      productionSource: "SPRITE_PRESENTATION.emperorDragonfly",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frogfolk-tadpole.png": [
    {
      idSuffix: "world-mob",
      label: "Frogfolk Tadpole",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frogfolkTadpole"),
      productionSource: "SPRITE_PRESENTATION.frogfolkTadpole",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frogfolk-blowgunner.png": [
    {
      idSuffix: "world-mob",
      label: "Frogfolk Blowgunner",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frogfolkBlowgunner"),
      productionSource: "SPRITE_PRESENTATION.frogfolkBlowgunner",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frogfolk-shaman.png": [
    {
      idSuffix: "world-mob",
      label: "Frogfolk Shaman",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frogfolkShaman"),
      productionSource: "SPRITE_PRESENTATION.frogfolkShaman",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frogfolk-chief.png": [
    {
      idSuffix: "world-mob",
      label: "Frogfolk Chief",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frogfolkChief"),
      productionSource: "SPRITE_PRESENTATION.frogfolkChief",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "bloat-leech.png": [
    {
      idSuffix: "world-mob",
      label: "Bloat Leech",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bloatLeech"),
      productionSource: "SPRITE_PRESENTATION.bloatLeech",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "bog-hag.png": [
    {
      idSuffix: "world-mob",
      label: "Bog Hag",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bogHag"),
      productionSource: "SPRITE_PRESENTATION.bogHag",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "leech-mother.png": [
    {
      idSuffix: "world-mob",
      label: "Leech Mother",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("leechMother"),
      productionSource: "SPRITE_PRESENTATION.leechMother",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mountain-ibex.png": [
    {
      idSuffix: "world-mob",
      label: "Mountain Ibex",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mountainIbex"),
      productionSource: "SPRITE_PRESENTATION.mountainIbex",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "wild-yak.png": [
    {
      idSuffix: "world-mob",
      label: "Wild Yak",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("wildYak"),
      productionSource: "SPRITE_PRESENTATION.wildYak",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "alpine-marmot.png": [
    {
      idSuffix: "world-mob",
      label: "Alpine Marmot",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("alpineMarmot"),
      productionSource: "SPRITE_PRESENTATION.alpineMarmot",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "yakfolk-stonehorn.png": [
    {
      idSuffix: "world-mob",
      label: "Yakfolk Stonehorn",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("yakfolkStonehorn"),
      productionSource: "SPRITE_PRESENTATION.yakfolkStonehorn",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "highland-reaver.png": [
    {
      idSuffix: "world-mob",
      label: "Highland Reaver",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("highlandReaver"),
      productionSource: "SPRITE_PRESENTATION.highlandReaver",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "storm-harpy.png": [
    {
      idSuffix: "world-mob",
      label: "Storm Harpy",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("stormHarpy"),
      productionSource: "SPRITE_PRESENTATION.stormHarpy",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "cairn-wight.png": [
    {
      idSuffix: "world-mob",
      label: "Cairn Wight",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("cairnWight"),
      productionSource: "SPRITE_PRESENTATION.cairnWight",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "stormwing-chick.png": [
    {
      idSuffix: "world-mob",
      label: "Stormwing Chick",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("stormwingChick"),
      productionSource: "SPRITE_PRESENTATION.stormwingChick",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "stormwing.png": [
    {
      idSuffix: "world-mob",
      label: "Stormwing",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("stormwing"),
      productionSource: "SPRITE_PRESENTATION.stormwing",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "wild-scrub-goat.png": [
    {
      idSuffix: "world-mob",
      label: "Wild Scrub Goat",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("wildScrubGoat"),
      productionSource: "SPRITE_PRESENTATION.wildScrubGoat",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "crested-porcupine.png": [
    {
      idSuffix: "world-mob",
      label: "Crested Porcupine",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("crestedPorcupine"),
      productionSource: "SPRITE_PRESENTATION.crestedPorcupine",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "spur-thighed-tortoise.png": [
    {
      idSuffix: "world-mob",
      label: "Spur-thighed Tortoise",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("spurThighedTortoise"),
      productionSource: "SPRITE_PRESENTATION.spurThighedTortoise",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "cyclops-shepherd.png": [
    {
      idSuffix: "world-mob",
      label: "Cyclops Shepherd",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("cyclopsShepherd"),
      productionSource: "SPRITE_PRESENTATION.cyclopsShepherd",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "skeleton-hoplite.png": [
    {
      idSuffix: "world-mob",
      label: "Skeleton Hoplite",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("skeletonHoplite"),
      productionSource: "SPRITE_PRESENTATION.skeletonHoplite",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "tar-elemental.png": [
    {
      idSuffix: "world-mob",
      label: "Tar Elemental",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("tarElemental"),
      productionSource: "SPRITE_PRESENTATION.tarElemental",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "olive-dryad.png": [
    {
      idSuffix: "world-mob",
      label: "Olive Dryad",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("oliveDryad"),
      productionSource: "SPRITE_PRESENTATION.oliveDryad",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "chimera.png": [
    {
      idSuffix: "world-mob",
      label: "Chimera",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("chimera"),
      productionSource: "SPRITE_PRESENTATION.chimera",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "dromedary.png": [
    {
      idSuffix: "world-mob",
      label: "Dromedary",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("dromedary"),
      productionSource: "SPRITE_PRESENTATION.dromedary",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "fennec-fox.png": [
    {
      idSuffix: "world-mob",
      label: "Fennec Fox",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("fennecFox"),
      productionSource: "SPRITE_PRESENTATION.fennecFox",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "sidewinder.png": [
    {
      idSuffix: "world-mob",
      label: "Sidewinder",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("sidewinder"),
      productionSource: "SPRITE_PRESENTATION.sidewinder",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "desert-lion.png": [
    {
      idSuffix: "world-mob",
      label: "Desert Lion",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("desertLion"),
      productionSource: "SPRITE_PRESENTATION.desertLion",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "jackalfolk-skirmisher.png": [
    {
      idSuffix: "world-mob",
      label: "Jackalfolk Skirmisher",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("jackalfolkSkirmisher"),
      productionSource: "SPRITE_PRESENTATION.jackalfolkSkirmisher",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "dune-goblin.png": [
    {
      idSuffix: "world-mob",
      label: "Dune Goblin",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("duneGoblin"),
      productionSource: "SPRITE_PRESENTATION.duneGoblin",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "desert-marauder.png": [
    {
      idSuffix: "world-mob",
      label: "Desert Marauder",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("desertMarauder"),
      productionSource: "SPRITE_PRESENTATION.desertMarauder",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "scorch-troll.png": [
    {
      idSuffix: "world-mob",
      label: "Scorch Troll",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("scorchTroll"),
      productionSource: "SPRITE_PRESENTATION.scorchTroll",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "ember-giant.png": [
    {
      idSuffix: "world-mob",
      label: "Ember Giant",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("emberGiant"),
      productionSource: "SPRITE_PRESENTATION.emberGiant",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "saiga.png": [
    {
      idSuffix: "world-mob",
      label: "Saiga",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("saiga"),
      productionSource: "SPRITE_PRESENTATION.saiga",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "wild-horse.png": [
    {
      idSuffix: "world-mob",
      label: "Steppe Wild Horse",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("wildHorse"),
      productionSource: "SPRITE_PRESENTATION.wildHorse",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "steppe-marmot.png": [
    {
      idSuffix: "world-mob",
      label: "Steppe Marmot",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("steppeMarmot"),
      productionSource: "SPRITE_PRESENTATION.steppeMarmot",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "steppe-raider.png": [
    {
      idSuffix: "world-mob",
      label: "Steppe Raider",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("steppeRaider"),
      productionSource: "SPRITE_PRESENTATION.steppeRaider",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "steppe-horse-archer.png": [
    {
      idSuffix: "world-mob",
      label: "Steppe Horse Archer",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("steppeHorseArcher"),
      productionSource: "SPRITE_PRESENTATION.steppeHorseArcher",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "salt-husk.png": [
    {
      idSuffix: "world-mob",
      label: "Salt Husk",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("saltHusk"),
      productionSource: "SPRITE_PRESENTATION.saltHusk",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "kurgan-wight.png": [
    {
      idSuffix: "world-mob",
      label: "Kurgan Wight",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("kurganWight"),
      productionSource: "SPRITE_PRESENTATION.kurganWight",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "centaur-khan.png": [
    {
      idSuffix: "world-mob",
      label: "Centaur Khan",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("centaurKhan"),
      productionSource: "SPRITE_PRESENTATION.centaurKhan",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "lemming.png": [
    {
      idSuffix: "world-mob",
      label: "Lemming",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("lemming"),
      productionSource: "SPRITE_PRESENTATION.lemming",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "snow-goose.png": [
    {
      idSuffix: "world-mob",
      label: "Snow Goose",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("snowGoose"),
      productionSource: "SPRITE_PRESENTATION.snowGoose",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frostborn-runecaster.png": [
    {
      idSuffix: "world-mob",
      label: "Frostborn Runecaster",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frostbornRunecaster"),
      productionSource: "SPRITE_PRESENTATION.frostbornRunecaster",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "frostborn-jarl.png": [
    {
      idSuffix: "world-mob",
      label: "Frostborn Jarl",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("frostbornJarl"),
      productionSource: "SPRITE_PRESENTATION.frostbornJarl",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "permafrost-elemental.png": [
    {
      idSuffix: "world-mob",
      label: "Permafrost Elemental",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("permafrostElemental"),
      productionSource: "SPRITE_PRESENTATION.permafrostElemental",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "draugr.png": [
    {
      idSuffix: "world-mob",
      label: "Draugr",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("draugr"),
      productionSource: "SPRITE_PRESENTATION.draugr",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mammoth-patriarch.png": [
    {
      idSuffix: "world-mob",
      label: "Mammoth Patriarch",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mammothPatriarch"),
      productionSource: "SPRITE_PRESENTATION.mammothPatriarch",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "emperor-penguin.png": [
    {
      idSuffix: "world-mob",
      label: "Emperor Penguin",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("emperorPenguin"),
      productionSource: "SPRITE_PRESENTATION.emperorPenguin",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "peary-caribou.png": [
    {
      idSuffix: "world-mob",
      label: "Peary Caribou",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("pearyCaribou"),
      productionSource: "SPRITE_PRESENTATION.pearyCaribou",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "ice-worm.png": [
    {
      idSuffix: "world-mob",
      label: "Ice Worm",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("iceWorm"),
      productionSource: "SPRITE_PRESENTATION.iceWorm",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "rime-troll.png": [
    {
      idSuffix: "world-mob",
      label: "Rime Troll",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("rimeTroll"),
      productionSource: "SPRITE_PRESENTATION.rimeTroll",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "aurora-shade.png": [
    {
      idSuffix: "world-mob",
      label: "Aurora Shade",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("auroraShade"),
      productionSource: "SPRITE_PRESENTATION.auroraShade",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "blizzard-lord.png": [
    {
      idSuffix: "world-mob",
      label: "Blizzard Lord",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("blizzardLord"),
      productionSource: "SPRITE_PRESENTATION.blizzardLord",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "sea-otter.png": [
    {
      idSuffix: "world-mob",
      label: "Sea Otter",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("seaOtter"),
      productionSource: "SPRITE_PRESENTATION.seaOtter",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "herring-gull.png": [
    {
      idSuffix: "world-mob",
      label: "Herring Gull",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("herringGull"),
      productionSource: "SPRITE_PRESENTATION.herringGull",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "spiny-lobster.png": [
    {
      idSuffix: "world-mob",
      label: "Spiny Lobster",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("spinyLobster"),
      productionSource: "SPRITE_PRESENTATION.spinyLobster",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gillfolk-scout.png": [
    {
      idSuffix: "world-mob",
      label: "Gillfolk Scout",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gillfolkScout"),
      productionSource: "SPRITE_PRESENTATION.gillfolkScout",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gillfolk-netter.png": [
    {
      idSuffix: "world-mob",
      label: "Gillfolk Netter",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gillfolkNetter"),
      productionSource: "SPRITE_PRESENTATION.gillfolkNetter",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "coral-golem.png": [
    {
      idSuffix: "world-mob",
      label: "Coral Golem",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("coralGolem"),
      productionSource: "SPRITE_PRESENTATION.coralGolem",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "drowned-deckhand.png": [
    {
      idSuffix: "world-mob",
      label: "Drowned Deckhand",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("drownedDeckhand"),
      productionSource: "SPRITE_PRESENTATION.drownedDeckhand",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "reef-kraken.png": [
    {
      idSuffix: "world-mob",
      label: "Reef Kraken",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("reefKraken"),
      productionSource: "SPRITE_PRESENTATION.reefKraken",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "hammerhead-shark.png": [
    {
      idSuffix: "world-mob",
      label: "Hammerhead Shark",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("hammerheadShark"),
      productionSource: "SPRITE_PRESENTATION.hammerheadShark",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "manta-ray.png": [
    {
      idSuffix: "world-mob",
      label: "Manta Ray",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mantaRay"),
      productionSource: "SPRITE_PRESENTATION.mantaRay",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "humpback-whale.png": [
    {
      idSuffix: "world-mob",
      label: "Humpback Whale",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("humpbackWhale"),
      productionSource: "SPRITE_PRESENTATION.humpbackWhale",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "merfolk-harpooner.png": [
    {
      idSuffix: "world-mob",
      label: "Merfolk Harpooner",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("merfolkHarpooner"),
      productionSource: "SPRITE_PRESENTATION.merfolkHarpooner",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "phantom-lookout.png": [
    {
      idSuffix: "world-mob",
      label: "Phantom Lookout",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("phantomLookout"),
      productionSource: "SPRITE_PRESENTATION.phantomLookout",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "maelstrom-spirit.png": [
    {
      idSuffix: "world-mob",
      label: "Maelstrom Spirit",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("maelstromSpirit"),
      productionSource: "SPRITE_PRESENTATION.maelstromSpirit",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "sea-serpent.png": [
    {
      idSuffix: "world-mob",
      label: "Sea Serpent",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("seaSerpent"),
      productionSource: "SPRITE_PRESENTATION.seaSerpent",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "kraken.png": [
    {
      idSuffix: "world-mob",
      label: "Kraken",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("kraken"),
      productionSource: "SPRITE_PRESENTATION.kraken",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "muskellunge.png": [
    {
      idSuffix: "world-mob",
      label: "Muskellunge",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("muskellunge"),
      productionSource: "SPRITE_PRESENTATION.muskellunge",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "mute-swan.png": [
    {
      idSuffix: "world-mob",
      label: "Mute Swan",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("muteSwan"),
      productionSource: "SPRITE_PRESENTATION.muteSwan",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "drowned-bride.png": [
    {
      idSuffix: "world-mob",
      label: "Drowned Bride",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("drownedBride"),
      productionSource: "SPRITE_PRESENTATION.drownedBride",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "lake-maiden.png": [
    {
      idSuffix: "world-mob",
      label: "Lake Maiden",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("lakeMaiden"),
      productionSource: "SPRITE_PRESENTATION.lakeMaiden",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "elder-mere-serpent.png": [
    {
      idSuffix: "world-mob",
      label: "Elder Mere Serpent",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("elderMereSerpent"),
      productionSource: "SPRITE_PRESENTATION.elderMereSerpent",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "northern-pike.png": [
    {
      idSuffix: "world-mob",
      label: "Northern Pike",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("northernPike"),
      productionSource: "SPRITE_PRESENTATION.northernPike",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "snapping-turtle.png": [
    {
      idSuffix: "world-mob",
      label: "Snapping Turtle",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("snappingTurtle"),
      productionSource: "SPRITE_PRESENTATION.snappingTurtle",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "drowned-thrall.png": [
    {
      idSuffix: "world-mob",
      label: "Drowned Thrall",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("drownedThrall"),
      productionSource: "SPRITE_PRESENTATION.drownedThrall",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "beaver.png": [
    {
      idSuffix: "world-mob",
      label: "Beaver",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("beaver"),
      productionSource: "SPRITE_PRESENTATION.beaver",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "river-otter.png": [
    {
      idSuffix: "world-mob",
      label: "River Otter",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("riverOtter"),
      productionSource: "SPRITE_PRESENTATION.riverOtter",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "river-salmon.png": [
    {
      idSuffix: "world-mob",
      label: "River Salmon",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("riverSalmon"),
      productionSource: "SPRITE_PRESENTATION.riverSalmon",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "kappa.png": [
    {
      idSuffix: "world-mob",
      label: "Kappa",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("kappa"),
      productionSource: "SPRITE_PRESENTATION.kappa",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "kappa-brawler.png": [
    {
      idSuffix: "world-mob",
      label: "Kappa Brawler",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("kappaBrawler"),
      productionSource: "SPRITE_PRESENTATION.kappaBrawler",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "bridge-troll.png": [
    {
      idSuffix: "world-mob",
      label: "Bridge Troll",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bridgeTroll"),
      productionSource: "SPRITE_PRESENTATION.bridgeTroll",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "nixie.png": [
    {
      idSuffix: "world-mob",
      label: "Nixie",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("nixie"),
      productionSource: "SPRITE_PRESENTATION.nixie",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "rapids-elemental.png": [
    {
      idSuffix: "world-mob",
      label: "Rapids Elemental",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("rapidsElemental"),
      productionSource: "SPRITE_PRESENTATION.rapidsElemental",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "shellback.png": [
    {
      idSuffix: "world-mob",
      label: "Shellback",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("shellback"),
      productionSource: "SPRITE_PRESENTATION.shellback",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "darter.png": [
    {
      idSuffix: "world-mob",
      label: "Darter",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("darter"),
      productionSource: "SPRITE_PRESENTATION.darter",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "ink-pool.png": [
    {
      idSuffix: "world-mob",
      label: "Ink Pool",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("inkPool"),
      productionSource: "SPRITE_PRESENTATION.inkPool",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "drowned-citizen.png": [
    {
      idSuffix: "world-mob",
      label: "Drowned Citizen",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("drownedCitizen"),
      productionSource: "SPRITE_PRESENTATION.drownedCitizen",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "tide-wraith.png": [
    {
      idSuffix: "world-mob",
      label: "Tide Wraith",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("tideWraith"),
      productionSource: "SPRITE_PRESENTATION.tideWraith",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "gate-warden.png": [
    {
      idSuffix: "world-mob",
      label: "Gate Warden",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("gateWarden"),
      productionSource: "SPRITE_PRESENTATION.gateWarden",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "drowned-cultist.png": [
    {
      idSuffix: "world-mob",
      label: "Drowned Cultist",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("drownedCultist"),
      productionSource: "SPRITE_PRESENTATION.drownedCultist",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "dire-wolf.png": [
    {
      idSuffix: "world-mob",
      label: "Dire Wolf",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("direWolf"),
      productionSource: "SPRITE_PRESENTATION.direWolf",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "moss-troll.png": [
    {
      idSuffix: "world-mob",
      label: "Moss Troll",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("mossTroll"),
      productionSource: "SPRITE_PRESENTATION.mossTroll",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "woolly-mammoth.png": [
    {
      idSuffix: "world-mob",
      label: "Woolly Mammoth",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("woollyMammoth"),
      productionSource: "SPRITE_PRESENTATION.woollyMammoth",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "field-hare.png": [
    {
      idSuffix: "world-mob",
      label: "Field Hare",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("fieldHare"),
      productionSource: "SPRITE_PRESENTATION.fieldHare",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "arctic-hare.png": [
    {
      idSuffix: "world-mob",
      label: "Arctic Hare",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("arcticHare"),
      productionSource: "SPRITE_PRESENTATION.arcticHare",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "capybara.png": [
    {
      idSuffix: "world-mob",
      label: "Capybara",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("capybara"),
      productionSource: "SPRITE_PRESENTATION.capybara",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "armadillo.png": [
    {
      idSuffix: "world-mob",
      label: "Armadillo",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("armadillo"),
      productionSource: "SPRITE_PRESENTATION.armadillo",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "red-fox.png": [
    {
      idSuffix: "world-mob",
      label: "Red Fox",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("redFox"),
      productionSource: "SPRITE_PRESENTATION.redFox",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "wolverine.png": [
    {
      idSuffix: "world-mob",
      label: "Wolverine",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("wolverine"),
      productionSource: "SPRITE_PRESENTATION.wolverine",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "ostrich.png": [
    {
      idSuffix: "world-mob",
      label: "Ostrich",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("ostrich"),
      productionSource: "SPRITE_PRESENTATION.ostrich",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "golden-eagle.png": [
    {
      idSuffix: "world-mob",
      label: "Golden Eagle",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("goldenEagle"),
      productionSource: "SPRITE_PRESENTATION.goldenEagle",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "musk-ox.png": [
    {
      idSuffix: "world-mob",
      label: "Musk Ox",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("muskOx"),
      productionSource: "SPRITE_PRESENTATION.muskOx",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "seal.png": [
    {
      idSuffix: "world-mob",
      label: "Seal",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("seal"),
      productionSource: "SPRITE_PRESENTATION.seal",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "ash-drake.png": [
    {
      idSuffix: "world-mob",
      label: "Ash Drake",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("ashDrake"),
      productionSource: "SPRITE_PRESENTATION.ashDrake",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "ember-dragon.png": [
    {
      idSuffix: "world-mob",
      label: "Ember Dragon",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("emberDragon"),
      productionSource: "SPRITE_PRESENTATION.emberDragon",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "snapjaw-flytrap.png": [
    {
      idSuffix: "world-mob",
      label: "Snapjaw Flytrap",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("snapjawFlytrap"),
      productionSource: "SPRITE_PRESENTATION.snapjawFlytrap",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "cairn-golem.png": [
    {
      idSuffix: "world-mob",
      label: "Cairn Golem",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("cairnGolem"),
      productionSource: "SPRITE_PRESENTATION.cairnGolem",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "giant-larva.png": [
    {
      idSuffix: "world-mob",
      label: "Giant Larva",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("giantLarva"),
      productionSource: "SPRITE_PRESENTATION.giantLarva",
      placeable: true,
      anchor: { x: 0.5, y: 0.985, label: "Center, 98.5% down" }
    }
  ],
  "training-dummy.png": [
    {
      idSuffix: "world-mob",
      label: "Training Dummy",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("trainingDummy"),
      productionSource: "SPRITE_PRESENTATION.trainingDummy",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "bandit.png": [
    {
      idSuffix: "world-mob",
      label: "Bandit",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("bandit"),
      productionSource: "SPRITE_PRESENTATION.bandit",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "orc-brute.png": [
    {
      idSuffix: "world-mob",
      label: "Orc Brute",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("orcBrute"),
      productionSource: "SPRITE_PRESENTATION.orcBrute",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "hollin-hut.png": [
    {
      idSuffix: "world-mob",
      label: "Hollin Hut",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("hollinHut"),
      productionSource: "SPRITE_PRESENTATION.hollinHut",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "hollin-guard.png": [
    {
      idSuffix: "world-mob",
      label: "Hollin Guard",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("hollinGuard"),
      productionSource: "SPRITE_PRESENTATION.hollinGuard",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "hollin-farmer.png": [
    {
      idSuffix: "world-mob",
      label: "Hollin Farmer",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("hollinFarmer"),
      productionSource: "SPRITE_PRESENTATION.hollinFarmer",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "hollin-helper.png": [
    {
      idSuffix: "world-mob",
      label: "Hollin Helper",
      category: "Mobs & Animals",
      usageLabel: "World Mob",
      productionSize: zoomScaled("hollinHelper"),
      productionSource: "SPRITE_PRESENTATION.hollinHelper",
      placeable: true,
      anchor: { x: 0.5, y: 0.918, label: "Center, 92% down" }
    }
  ],
  "sewer-rat.png": [dungeonMobUsage("Sewer Rat", "sewerRat")],
  "sick-sewer-rat.png": [dungeonMobUsage("Sick Sewer Rat", "sickSewerRat")],
  "sewer-rat-miniboss.png": [dungeonMobUsage("Sewer Rat Miniboss", "sewerRatMiniboss")],
  "dogs/DogBaby1.png": [
    {
      idSuffix: "pets-profile",
      label: "Dog Baby",
      category: "Mobs & Animals",
      usageLabel: "Pets Puppy / Young Profile",
      productionSize: cssFixed(64, 64, ".dog-kennel-card img, .dog-detail-portrait"),
      productionSource: ".dog-kennel-card img, .dog-detail-portrait",
      placeable: true,
      anchor: CENTER
    },
    {
      idSuffix: "world-companion",
      label: "Dog Baby",
      category: "Mobs & Animals",
      usageLabel: "Puppy / Young World Companion",
      productionSize: zoomScaled("dog"),
      productionSource: "SPRITE_PRESENTATION.dog",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "dogs/DogAdult1.png": [
    {
      idSuffix: "pets-profile",
      label: "Dog Adult",
      category: "Mobs & Animals",
      usageLabel: "Pets Adult Profile",
      productionSize: cssFixed(64, 64, ".dog-kennel-card img, .dog-detail-portrait"),
      productionSource: ".dog-kennel-card img, .dog-detail-portrait",
      placeable: true,
      anchor: CENTER
    },
    {
      idSuffix: "world-companion",
      label: "Dog Adult",
      category: "Mobs & Animals",
      usageLabel: "Adult World Companion",
      productionSize: zoomScaled("dog"),
      productionSource: "SPRITE_PRESENTATION.dog",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "dogs/DogOld1.png": [
    {
      idSuffix: "pets-profile",
      label: "Dog Elder",
      category: "Mobs & Animals",
      usageLabel: "Pets Elder Profile",
      productionSize: cssFixed(64, 64, ".dog-kennel-card img, .dog-detail-portrait"),
      productionSource: ".dog-kennel-card img, .dog-detail-portrait",
      placeable: true,
      anchor: CENTER
    },
    {
      idSuffix: "world-companion",
      label: "Dog Elder",
      category: "Mobs & Animals",
      usageLabel: "Elder World Companion",
      productionSize: zoomScaled("dog"),
      productionSource: "SPRITE_PRESENTATION.dog",
      placeable: true,
      anchor: { x: 0.5, y: 0.86, label: "Center, 86% down" }
    }
  ],
  "ogre.png": [{
    idSuffix: "world-mob",
    label: "Ogre",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("ogre"),
    productionSource: "SPRITE_PRESENTATION.ogre",
    placeable: true,
    anchor: { x: 0.5, y: 0.896, label: "Center, 89.6% down" }
  }],
  "coastal-crab.png": [worldMobUsage("Coastal Crab", "coastalCrab")],
  "ice-crab.png": [worldMobUsage("Ice Crab", "iceCrab")],
  "sand-crab.png": [worldMobUsage("Sand Crab", "sandCrab")],
  "mangrove-crab.png": [worldMobUsage("Mangrove Crab", "mangroveCrab")],
  "goblins/goblin-basic.png": [worldMobUsage("Goblin", "goblinBasic")],
  "goblins/goblin-warrior.png": [worldMobUsage("Goblin Warrior", "goblinWarrior")],
  "goblins/goblin-archer.png": [worldMobUsage("Goblin Archer", "goblinArcher")],
  "goblins/goblin-healer.png": [worldMobUsage("Goblin Healer", "goblinHealer")],
  "goblins/goblin-hall.png": [spriteBuildingUsage("Goblin Hall", "goblinHall")],
  "goblins/goblin-market.png": [structureUsage("Goblin Market", "goblin_market")],
  "resin-crawler.png": [{
    idSuffix: "world-mob",
    label: "Resin Crawler",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("sapCrawler"),
    productionSource: "SPRITE_PRESENTATION.sapCrawler",
    placeable: true,
    anchor: { x: 0.5, y: 0.816, label: "Center, 81.6% down" }
  }],
  "hog.png": [{
    idSuffix: "world-mob",
    label: "Hog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("hog"),
    productionSource: "SPRITE_PRESENTATION.hog",
    placeable: true,
    anchor: { x: 0.5, y: 0.843, label: "Center, 84.3% down" }
  }],
  "woolly-hog.png": [{
    idSuffix: "world-mob",
    label: "Woolly Hog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("woollyHog"),
    productionSource: "SPRITE_PRESENTATION.woollyHog",
    placeable: true,
    anchor: { x: 0.5, y: 0.843, label: "Center, 84.3% down" }
  }],
  "warthog.png": [{
    idSuffix: "world-mob",
    label: "Warthog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("warthog"),
    productionSource: "SPRITE_PRESENTATION.warthog",
    placeable: true,
    anchor: { x: 0.5, y: 0.843, label: "Center, 84.3% down" }
  }],
  "jungle-hog.png": [{
    idSuffix: "world-mob",
    label: "Jungle Hog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("jungleHog"),
    productionSource: "SPRITE_PRESENTATION.jungleHog",
    placeable: true,
    anchor: { x: 0.5, y: 0.843, label: "Center, 84.3% down" }
  }],
  "mud-hog.png": [{
    idSuffix: "world-mob",
    label: "Mud Hog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("mudHog"),
    productionSource: "SPRITE_PRESENTATION.mudHog",
    placeable: true,
    anchor: { x: 0.5, y: 0.843, label: "Center, 84.3% down" }
  }],
  "javelina.png": [{
    idSuffix: "world-mob",
    label: "Javelina",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("javelina"),
    productionSource: "SPRITE_PRESENTATION.javelina",
    placeable: true,
    anchor: { x: 0.5, y: 0.843, label: "Center, 84.3% down" }
  }],
  "bear.png": [{
    idSuffix: "world-mob",
    label: "Bear",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("bear"),
    productionSource: "SPRITE_PRESENTATION.bear",
    placeable: true,
    anchor: { x: 0.5, y: 0.78, label: "Center, 78% down" }
  }],
  "snow-bear.png": [{
    idSuffix: "world-mob",
    label: "Snow Bear",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("snowBear"),
    productionSource: "SPRITE_PRESENTATION.snowBear",
    placeable: true,
    anchor: { x: 0.5, y: 0.78, label: "Center, 78% down" }
  }],
  "black-bear.png": [{
    idSuffix: "world-mob",
    label: "Black Bear",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("blackBear"),
    productionSource: "SPRITE_PRESENTATION.blackBear",
    placeable: true,
    anchor: { x: 0.5, y: 0.78, label: "Center, 78% down" }
  }],
  "sun-bear.png": [{
    idSuffix: "world-mob",
    label: "Sun Bear",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("sunBear"),
    productionSource: "SPRITE_PRESENTATION.sunBear",
    placeable: true,
    anchor: { x: 0.5, y: 0.78, label: "Center, 78% down" }
  }],
  "mysterious-traveler.png": [{
    idSuffix: "world-mob",
    label: "Mysterious Traveler",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("mysteriousTraveler"),
    productionSource: "SPRITE_PRESENTATION.mysteriousTraveler",
    placeable: true,
    anchor: { x: 0.5, y: 0.88, label: "Center, 88% down" }
  }],
  "frog.png": [{
    idSuffix: "world-mob",
    label: "Frog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("frog"),
    productionSource: "SPRITE_PRESENTATION.frog",
    placeable: true,
    anchor: { x: 0.5, y: 0.737, label: "Center, 73.7% down" }
  }],
  "frost-frog.png": [{
    idSuffix: "world-mob",
    label: "Frost Frog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("frostFrog"),
    productionSource: "SPRITE_PRESENTATION.frostFrog",
    placeable: true,
    anchor: { x: 0.5, y: 0.737, label: "Center, 73.7% down" }
  }],
  "poison-frog.png": [{
    idSuffix: "world-mob",
    label: "Poison Frog",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("poisonFrog"),
    productionSource: "SPRITE_PRESENTATION.poisonFrog",
    placeable: true,
    anchor: { x: 0.5, y: 0.737, label: "Center, 73.7% down" }
  }],
  "desert-toad.png": [{
    idSuffix: "world-mob",
    label: "Desert Toad",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("desertToad"),
    productionSource: "SPRITE_PRESENTATION.desertToad",
    placeable: true,
    anchor: { x: 0.5, y: 0.737, label: "Center, 73.7% down" }
  }],
  "alligator.png": [{
    idSuffix: "world-mob",
    label: "Alligator",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("alligator"),
    productionSource: "SPRITE_PRESENTATION.alligator",
    placeable: true,
    anchor: { x: 0.5, y: 0.804, label: "Center, 80.4% down" }
  }],
  "caiman.png": [{
    idSuffix: "world-mob",
    label: "Caiman",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("caiman"),
    productionSource: "SPRITE_PRESENTATION.caiman",
    placeable: true,
    anchor: { x: 0.5, y: 0.804, label: "Center, 80.4% down" }
  }],
  "crocodile.png": [{
    idSuffix: "world-mob",
    label: "Crocodile",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("crocodile"),
    productionSource: "SPRITE_PRESENTATION.crocodile",
    placeable: true,
    anchor: { x: 0.5, y: 0.804, label: "Center, 80.4% down" }
  }],
  "squid.png": [{
    idSuffix: "world-mob",
    label: "Squid",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("squid"),
    productionSource: "SPRITE_PRESENTATION.squid",
    placeable: true,
    anchor: { x: 0.5, y: 0.882, label: "Center, 88.2% down" }
  }],
  "jellyfish.png": [{
    idSuffix: "world-mob",
    label: "Jellyfish",
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled("jellyfish"),
    productionSource: "SPRITE_PRESENTATION.jellyfish",
    placeable: true,
    anchor: { x: 0.5, y: 0.9, label: "Center, 90% down" }
  }],
  "tree.png": [{
    idSuffix: "world-resource",
    label: "Giving Tree",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("tree"),
    productionSource: "SPRITE_PRESENTATION.tree",
    placeable: true,
    anchor: { x: 0.5, y: 0.888, label: "Center, 88.8% down" }
  }],
  "ResinTree1.png": [{
    idSuffix: "world-resource",
    label: "Giving Tree (Fruiting)",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("tree"),
    productionSource: "SPRITE_PRESENTATION.tree",
    placeable: true,
    anchor: { x: 0.5, y: 0.888, label: "Center, 88.8% down" }
  }],
  "willow-tree.png": [{
    idSuffix: "world-resource",
    label: "Willow",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("willowTree"),
    productionSource: "SPRITE_PRESENTATION.willowTree",
    placeable: true,
    anchor: { x: 0.5, y: 0.888, label: "Center, 88.8% down" }
  }],
  "chinese-pistache.png": [{
    idSuffix: "world-resource",
    label: "Chinese Pistache",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("chinesePistache"),
    productionSource: "SPRITE_PRESENTATION.chinesePistache",
    placeable: true,
    anchor: { x: 0.5, y: 0.888, label: "Center, 88.8% down" }
  }],
  "wild-flax.png": [{
    idSuffix: "world-resource",
    label: "Wild Flax",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("flax"),
    productionSource: "SPRITE_PRESENTATION.flax",
    placeable: true,
    anchor: { x: 0.5, y: 0.94, label: "Center, 94% down" }
  }],
  "stone-mine.png": [{
    idSuffix: "world-resource",
    label: "Stone Mine",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("stoneMine"),
    productionSource: "SPRITE_PRESENTATION.stoneMine",
    placeable: true,
    anchor: { x: 0.5, y: 0.779, label: "Center, 77.9% down" }
  }],
  "sulfur-mine.png": [{
    idSuffix: "world-resource",
    label: "Sulfur Mine",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("sulfurMine"),
    productionSource: "SPRITE_PRESENTATION.sulfurMine",
    placeable: true,
    anchor: { x: 0.5, y: 0.94, label: "Center, 94% down" }
  }],
  "coal-mine.png": [{
    idSuffix: "world-resource",
    label: "Coal Mine",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("coalMine"),
    productionSource: "SPRITE_PRESENTATION.coalMine",
    placeable: true,
    anchor: { x: 0.5, y: 0.779, label: "Center, 77.9% down" }
  }],
  "iron-mine.png": [{
    idSuffix: "world-resource",
    label: "Iron Mine",
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("ironMine"),
    productionSource: "SPRITE_PRESENTATION.ironMine",
    placeable: true,
    anchor: { x: 0.5, y: 0.779, label: "Center, 77.9% down" }
  }],
  "structures/atlas-shrine.png": [
    {
      idSuffix: "world-flag-upgrade",
      label: "Atlas Shrine",
      category: "Buildings",
      usageLabel: "World Flag Upgrade",
      productionSize: zoomScaledPresentation(
        WORLD_PNG_PRESENTATION.atlasShrine,
        WORLD_PNG_PRESENTATION.atlasShrine.source,
        WORLD_PNG_PRESENTATION.atlasShrine.definedIn
      ),
      productionSource: WORLD_PNG_PRESENTATION.atlasShrine.source,
      placeable: true,
      anchor: { x: 0.5, y: 0.92, label: "Center, 92% down" }
    },
    worldMapDestinationUsage("Atlas Shrine", WORLD_PNG_PRESENTATION.worldMapAtlasShrine)
  ],
  "manor-marker.png": [worldMapDestinationUsage("Manor", WORLD_PNG_PRESENTATION.worldMapManor)],
  "structures/manor.png": [worldBuildingUsage("Manor", WORLD_PNG_PRESENTATION.manor)],
  "structures/greenhouse.png": [zoomScaledBuildingUsage("Greenhouse", WORLD_PNG_PRESENTATION.greenhouse)],
  "structures/city-hall.png": [spriteBuildingUsage("City Hall", "city")],
  "structures/kingdom-seat.png": [spriteBuildingUsage("Castle", "kingdomSeat")],
  "structures/furnace.png": [{
    idSuffix: "world-furnace",
    label: "Furnace",
    category: "Buildings",
    usageLabel: "World Furnace",
    productionSize: zoomScaledPresentation(
      WORLD_PNG_PRESENTATION.furnace,
      WORLD_PNG_PRESENTATION.furnace.source,
      WORLD_PNG_PRESENTATION.furnace.definedIn
    ),
    productionSource: WORLD_PNG_PRESENTATION.furnace.source,
    placeable: true,
    anchor: BOTTOM_CENTER
  }],
  "structures/tannery.png": [zoomScaledBuildingUsage("Tannery", WORLD_PNG_PRESENTATION.tannery)],
  "structures/OilWell1.png": [structureUsage("Oil Well", "oil_well")],
  "structures/city-house.png": [structureUsage("City House", "city_house")],
  "structures/city-monument-mining.png": [structureUsage("Mining Monument", "monument_mining")],
  "structures/city-monument-forestry.png": [structureUsage("Forestry Monument", "monument_forestry")],
  "structures/city-monument-hunting.png": [structureUsage("Hunting Monument", "monument_hunting")],
  "structures/city-warehouse.png": [structureUsage("City Warehouse", "warehouse")],
  "structures/cistern-warrens.png": [structureUsage("Cistern Warrens", "cistern_warrens")],
  "structures/city-salon.png": [structureUsage("City Salon", "salon")],
  "structures/city-kennel.png": [structureUsage("City Kennel", "city_kennel")],
  "structures/city-market.png": [structureUsage("City Market", "market")],
  "structures/mayor-house.png": [structureUsage("Mayor House", "mayor_house")],
  "flags/default-cloth.png": [territoryFlagLayerUsage("Territory Flag Default Cloth Layer")],
  "flags/default-hardware.png": [territoryFlagLayerUsage("Territory Flag Default Hardware Layer")],
  "flags/bastion-cloth.png": [territoryFlagLayerUsage("Territory Flag Bastion Cloth Layer")],
  "flags/bastion-hardware.png": [territoryFlagLayerUsage("Territory Flag Bastion Hardware Layer")],
  "flags/tower-cloth.png": [territoryFlagLayerUsage("Territory Flag Tower Cloth Layer")],
  "flags/tower-hardware.png": [territoryFlagLayerUsage("Territory Flag Tower Hardware Layer")],
  "flags/buoy-color.png": [buoyLayerUsage("Territory Buoy Color Layer")],
  "flags/buoy-hardware.png": [buoyLayerUsage("Territory Buoy Hardware Layer")],
  "water/raft.png": [{
    idSuffix: "player-raft",
    label: "Player Raft",
    category: "Characters",
    usageLabel: "Afloat Player Raft",
    productionSize: null,
    productionSource: "PLAYER_RAFT_PRESENTATION in apps/client/src/players/playerSprite.ts",
    placeable: false,
    anchor: {
      x: PLAYER_RAFT_PRESENTATION.anchorX,
      y: PLAYER_RAFT_PRESENTATION.anchorY,
      label: "Deck centre (feet)"
    }
  }]
};

function militaryUnitUsage(label: string, unitType: string): Usage {
  const key = `militaryUnits.${unitType}` as keyof typeof SPRITE_PRESENTATION;
  return {
    idSuffix: "world-military-unit",
    label,
    category: "Military",
    usageLabel: "World Military Unit",
    productionSize: zoomScaled(key),
    productionSource: `SPRITE_PRESENTATION.${key}`,
    placeable: true,
    anchor: {
      x: SPRITE_PRESENTATION[key].anchorX,
      y: SPRITE_PRESENTATION[key].anchorY,
      label: `Anchor ${SPRITE_PRESENTATION[key].anchorX}, ${SPRITE_PRESENTATION[key].anchorY}`
    }
  };
}

const groundDropPresentation: Readonly<Record<string, keyof typeof SPRITE_PRESENTATION>> = {
  "items/stone.png": "stone",
  "items/coal.png": "coal",
  "items/iron.png": "iron",
  "items/wood.png": "wood",
  "items/generic.png": "generic",
  "items/leather.png": "leather",
  "items/food.png": "food",
  "items/ore.png": "ore",
  "items/water.png": "water",
  "items/GivingBerry2.png": "giving_berry",
  "items/Resin1.png": "balsam_resin",
  "items/jellyfish-venom.png": "jellyfish_venom",
  "items/brood-silk.png": "brood_silk",
  "items/raptor-scale.png": "raptor_scale",
  "items/giant-egg-item.png": "giant_egg",
  "items/brood-egg.png": "brood_egg",
  "items/clutch-egg.png": "clutch_egg",
  "items/crawler-egg.png": "crawler_egg",
  "items/whistle-broken.png": "broken_whistle",
  "items/bonewrought-blade.png": "bonewrought_blade",
  "items/bonewrought-mail.png": "bonewrought_mail",
  "items/elder-acorn.png": "elder_acorn",
  "items/wyrm-egg.png": "wyrm_egg",
  "items/dragon-scale.png": "dragon_scale",
  "items/zephyr.png": "zephyr",
  "items/refined-oil.png": "refined_oil",
  "items/CrudeOil1.png": "crude_oil",
  "items/iron-bar.png": "iron_bar",
  "items/venomsteel-bar.png": "venomsteel_bar",
  "items/venomsteel-core.png": "venomsteel_core",
  "items/deer-hide.png": "deer_hide",
  "items/hog-hide.png": "hog_hide",
  "items/wolf-pelt.png": "wolf_pelt",
  "items/bear-hide.png": "bear_hide",
  "items/alligator-hide.png": "alligator_hide",
  "items/slag.png": "slag",
  "items/sulfur.png": "sulfur",
  "items/fire-feather.png": "fire_feather",
  "items/tempest-quill.png": "tempest_quill",
  "items/ice-feather.png": "ice_feather",
  "items/fire-bar.png": "fire_bar",
  "items/lightning-bar.png": "lightning_bar",
  "items/ice-bar.png": "ice_bar",
  "items/fire-core.png": "fire_core",
  "items/lightning-core.png": "lightning_core",
  "items/ice-core.png": "ice_core",
  "items/crystal.png": "crystal",
  "items/pearl.png": "pearl",
  "items/shellback-plate.png": "shellback_plate",
  "items/abyssal-orb.png": "abyssal_orb",
  "items/freshwater-fish.png": "freshwater_fish",
  "items/fishing-rod.png": "fishing_rod",
  "items/flax-fiber.png": "flax_fiber",
  "items/cloth.png": "cloth",
  "items/bone.png": "bone",
  "items/bricks.png": "bricks",
  "items/chitin.png": "chitin",
  "items/fertilizer.png": "fertilizer",
  "items/flux-plant.png": "flux_plant",
  "items/produce.png": "produce",
  "items/seed.png": "seed",
  "items/repair-kit.png": "repair_kit",
  "items/lumen.png": "lumen",
  "items/training-heavy-boots.png": "training_heavy_boots",
  "items/training-light-boots.png": "training_light_boots",
  "items/training-heavy-gloves.png": "training_heavy_gloves",
  "items/training-light-gloves.png": "training_light_gloves",
  "items/training-heavy-helm.png": "training_heavy_helm",
  "items/training-light-hood.png": "training_light_hood",
  "items/training-shield.png": "training_shield",
  "items/ranged-shield.png": "ranged_shield",
  "items/torch.png": "torch"
};

const itemPresentationByPath: Readonly<Record<string, keyof typeof SPRITE_PRESENTATION>> = {
  ...groundDropPresentation,
  "items/satchel.png": "pack",
  "items/coin.png": "gold",
  "items/bow.png": "generic",
  "items/ring.png": "generic",
  "items/staff.png": "generic",
  "items/scepter.png": "generic",
  "items/sword.png": "generic",
  "items/tunic.png": "generic",
  "items/enchantment-stones/amethyst.png": "enchantment_stone:amethyst",
  "items/enchantment-stones/diamond.png": "enchantment_stone:diamond",
  "items/enchantment-stones/emerald.png": "enchantment_stone:emerald",
  "items/enchantment-stones/onyx.png": "enchantment_stone:onyx",
  "items/enchantment-stones/opal.png": "enchantment_stone:opal",
  "items/enchantment-stones/ruby.png": "enchantment_stone:ruby",
  "items/enchantment-stones/sapphire.png": "enchantment_stone:sapphire",
  "items/enchantment-stones/topaz.png": "enchantment_stone:topaz"
};

function structureUsage(
  label: string,
  type: keyof typeof WORLD_PNG_PRESENTATION.cityStructures
): Usage {
  const presentation = WORLD_PNG_PRESENTATION.cityStructures[type];
  return {
    idSuffix: "world-city-facility",
    label,
    category: "Buildings",
    usageLabel: "World City Facility",
    productionSize: zoomScaledPresentation(
      presentation,
      presentation.source,
      presentation.definedIn
    ),
    productionSource: presentation.source,
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
    }
  };
}

function worldMobUsage(
  label: string,
  key: "coastalCrab" | "iceCrab" | "sandCrab" | "mangroveCrab" | "goblinBasic" | "goblinWarrior" | "goblinArcher" | "goblinHealer"
): Usage {
  const presentation = SPRITE_PRESENTATION[key];
  return {
    idSuffix: "world-mob",
    label,
    category: "Mobs & Animals",
    usageLabel: "World Mob",
    productionSize: zoomScaled(key),
    productionSource: `SPRITE_PRESENTATION.${key}`,
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
    }
  };
}

function dungeonMobUsage(
  label: string,
  key: keyof typeof SPRITE_PRESENTATION
): Usage {
  const presentation = SPRITE_PRESENTATION[key];
  return {
    idSuffix: "dungeon-mob",
    label,
    category: "Mobs & Animals",
    usageLabel: "Dungeon Mob",
    productionSize: zoomScaled(key),
    productionSource: `SPRITE_PRESENTATION.${key}`,
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
    }
  };
}

function worldBuildingUsage(
  label: string,
  presentation: FixedWorldPngPresentation & SpritePresentation
): Usage {
  return {
    idSuffix: "world-building",
    label,
    category: "Buildings",
    usageLabel: `World ${label}`,
    productionSize: zoomScaledPresentation(
      presentation,
      presentation.source,
      presentation.definedIn
    ),
    productionSource: presentation.source,
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
    }
  };
}

function zoomScaledBuildingUsage(
  label: string,
  presentation: ZoomScaledWorldPngPresentation
): Usage {
  return {
    idSuffix: "world-building",
    label,
    category: "Buildings",
    usageLabel: `World ${label}`,
    productionSize: zoomScaledPresentation(
      presentation,
      presentation.source,
      presentation.definedIn
    ),
    productionSource: presentation.source,
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
    }
  };
}

function spriteBuildingUsage(
  label: string,
  key: "city" | "kingdomSeat" | "goblinHall"
): Usage {
  const presentation = SPRITE_PRESENTATION[key];
  return {
    idSuffix: "world-building",
    label,
    category: "Buildings",
    usageLabel: `World ${label}`,
    productionSize: zoomScaled(key),
    productionSource: `SPRITE_PRESENTATION.${key}`,
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
    }
  };
}

function territoryFlagLayerUsage(label: string): Usage {
  return {
    idSuffix: "territory-flag-layer",
    label,
    category: "Buildings",
    usageLabel: "Territory Flag Layer",
    productionSize: null,
    productionSource: "apps/client/src/map/flagArtwork.ts",
    placeable: true,
    anchor: BOTTOM_CENTER
  };
}

function buoyLayerUsage(label: string): Usage {
  const presentation = SPRITE_PRESENTATION.buoy;
  return {
    idSuffix: "territory-buoy-layer",
    label,
    category: "Buildings",
    usageLabel: "Territory Buoy Layer",
    productionSize: zoomScaled("buoy"),
    productionSource: "SPRITE_PRESENTATION.buoy",
    placeable: true,
    anchor: {
      x: presentation.anchorX,
      y: presentation.anchorY,
      label: "Center, 39/41 down"
    }
  };
}

function worldMapDestinationUsage(
  label: string,
  presentation: FixedWorldPngPresentation
): Usage {
  return {
    idSuffix: "world-map-destination",
    label,
    category: "Map Icons",
    usageLabel: "World Map Destination",
    productionSize: fixed(presentation),
    productionSource: presentation.source,
    placeable: true,
    anchor: CENTER
  };
}

function itemUsage(path: string): Usage[] {
  const label = friendlyFileName(path);
  const presentationKey = itemPresentationByPath[path];
  const presentation = presentationKey ? SPRITE_PRESENTATION[presentationKey] : null;
  const result: Usage[] = [
    {
      idSuffix: "inventory-artwork",
      label,
      category: itemCategory(path),
      usageLabel: "Inventory / Equipment Icon",
      productionSize: presentationKey && presentation ? itemScaled(presentationKey) : null,
      productionSource: presentationKey
        ? `RUNTIME_PNG_PRESENTATION_CATALOG.sprites.${presentationKey}`
        : "ItemArtwork component; safe default size until an item presentation is authored",
      placeable: true,
      anchor: presentation
        ? { x: presentation.anchorX, y: presentation.anchorY, label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}` }
        : CENTER
    },
    itemCssUsage(label, "dropped-item-prompt", "Dropped Item Prompt", 46, ".dropped-item-prompt-heading > .item-artwork"),
    itemCssUsage(label, "pickup-dialog", "Pickup Dialog", 52, ".pickup-item-dialog-heading > .item-artwork"),
    itemCssUsage(label, "mobile-world-action", "Mobile World Action", 44, "html[data-ui-profile=\"phone\"] .mobile-world-action-artwork .item-artwork")
  ];
  if (path === "items/Resin1.png") {
    result.push({
      idSuffix: "resource-gain-effect",
      label,
      category: "Effects",
      usageLabel: "Frond Sap Gain Floater",
      productionSize: fixed(WORLD_PNG_PRESENTATION.resinGain),
      productionSource: WORLD_PNG_PRESENTATION.resinGain.source,
      placeable: true,
      anchor: { x: 0, y: 1, label: "Bottom left" }
    });
  }
  const groundPresentationKey = groundDropPresentation[path];
  if (groundPresentationKey) {
    const presentation = SPRITE_PRESENTATION[groundPresentationKey];
    result.unshift({
      idSuffix: "ground-drop",
      label,
      category: "Ground Drops",
      usageLabel: "World Ground Drop",
      productionSize: zoomScaled(groundPresentationKey),
      productionSource: `RUNTIME_PNG_PRESENTATION_CATALOG.sprites.${groundPresentationKey}`,
      placeable: true,
      anchor: {
        x: presentation.anchorX,
        y: presentation.anchorY,
        label: `Anchor ${presentation.anchorX}, ${presentation.anchorY}`
      }
    });
  }
  return result;
}

function itemCssUsage(
  label: string,
  idSuffix: string,
  usageLabel: string,
  size: number,
  selector: string
): Usage {
  return {
    idSuffix,
    label,
    category: "UI Icons",
    usageLabel,
    productionSize: cssFixed(size, size, selector),
    productionSource: selector,
    placeable: true,
    anchor: CENTER
  };
}

function itemCategory(path: string): string {
  return /(?:bow|staff|sword|tunic)\.png$/i.test(path)
    ? "Equipment"
    : "Items & Materials";
}

function friendlyFileName(path: string): string {
  const filename = path.split("/").at(-1)?.replace(/\.png$/i, "") ?? path;
  return filename
    .replace(/^Resin1$/i, "Frond Sap")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function assetSourcePath(globPath: string): string {
  return `apps/client/src/${globPath.replace(/^\.\.\//, "")}`;
}

function assetRelativePath(globPath: string): string {
  return globPath.replace(/^\.\.\/assets\//, "");
}

function stableId(path: string, suffix: string): string {
  return `${path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}--${suffix}`;
}

/** Per-biome Giving Tree and Elder Fern art (map/biomeTreeArt.ts), framed like tree.png. */
function biomeTreeUsage(relativePath: string): Usage[] {
  const name = relativePath.slice("trees/".length, -".png".length);
  const fern = name.startsWith("elder-fern-");
  const words = name.replace(/^(giving-tree|elder-fern)-/u, "").split("-");
  const state = words.at(-1) === "fruiting" || words.at(-1) === "tapped" ? words.pop() : null;
  const biome = words.join(" ").replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
  const stateLabel = fern ? (state === "tapped" ? "Tapped" : "Sap") : state === "fruiting" ? "Fruiting" : null;
  return [{
    idSuffix: "world-resource",
    label: `${fern ? "Elder Fern" : "Giving Tree"} (${biome}${stateLabel ? `, ${stateLabel}` : ""})`,
    category: "Resources",
    usageLabel: "World Resource",
    productionSize: zoomScaled("tree"),
    productionSource: "SPRITE_PRESENTATION.tree",
    placeable: true,
    anchor: { x: 0.5, y: 0.888, label: "Center, 88.8% down" }
  }];
}

const bundledAssets = Object.entries(assetModules).flatMap(([globPath, url]) => {
  const relativePath = assetRelativePath(globPath);
  const usages = usagesByFile[relativePath]
    ?? (relativePath.startsWith("trees/")
      ? biomeTreeUsage(relativePath)
      : relativePath.startsWith("items/")
      ? itemUsage(relativePath)
      : [{
          idSuffix: "runtime-asset",
          label: friendlyFileName(relativePath),
          category: "Other Runtime PNGs",
          usageLabel: "Runtime Asset",
          productionSize: null,
          placeable: true,
          anchor: BOTTOM_CENTER
        } satisfies Usage]);
  return usages.map((usage): DevPngAsset => ({
    ...usage,
    id: stableId(relativePath, usage.idSuffix),
    url,
    sourcePath: assetSourcePath(globPath),
    anchor: usage.productionSize?.kind === "zoom-scaled" || usage.productionSize?.kind === "item-scaled"
      ? {
          x: usage.productionSize.presentation.anchorX,
          y: usage.productionSize.presentation.anchorY,
          label: `Anchor ${usage.productionSize.presentation.anchorX}, ${usage.productionSize.presentation.anchorY}`
        }
      : usage.anchor
  }));
});

const publicPngPaths = [
  "assets/dungeons/blightwood_grove/blight-nest-broken.png",
  "assets/dungeons/blightwood_grove/blighted-path-floor.png",
  "assets/dungeons/blightwood_grove/entrance.png",
  "assets/dungeons/blightwood_grove/fern-hollow-floor.png",
  "assets/dungeons/blightwood_grove/grove-gate-floor.png",
  "assets/dungeons/blightwood_grove/grove-hermit.png",
  "assets/dungeons/blightwood_grove/healing-spring.png",
  "assets/dungeons/blightwood_grove/heartwood-floor.png",
  "assets/dungeons/blightwood_grove/hermit-clearing-floor.png",
  "assets/dungeons/blightwood_grove/root-barricade.png",
  "assets/dungeons/blightwood_grove/treant-ring-floor.png",
  "assets/dungeons/wyrm_hollow/bone-bridge-floor.png",
  "assets/dungeons/wyrm_hollow/wyrm-nest.png",
  "assets/dungeons/wyrm_hollow/ember-tunnels-floor.png",
  "assets/dungeons/wyrm_hollow/entrance.png",
  "assets/dungeons/wyrm_hollow/hatchery-floor.png",
  "assets/dungeons/wyrm_hollow/hoard-chamber-floor.png",
  "assets/dungeons/wyrm_hollow/hoard-vault-floor.png",
  "assets/dungeons/wyrm_hollow/lair-mouth-floor.png",
  "assets/dungeons/wyrm_hollow/salamander-pools-floor.png",
  "assets/dungeons/drowned_city/abyssal-arm-bombed.png",
  "assets/dungeons/drowned_city/abyssal-arm-intact.png",
  "assets/dungeons/drowned_city/abyssal-gate-open.png",
  "assets/dungeons/drowned_city/abyssal-gate-sealed.png",
  "assets/dungeons/drowned_city/abyssal-sanctum-floor.png",
  "assets/dungeons/drowned_city/circle-of-tides-floor.png",
  "assets/dungeons/drowned_city/circle-segment-east-lit.png",
  "assets/dungeons/drowned_city/circle-segment-north-lit.png",
  "assets/dungeons/drowned_city/circle-segment-west-lit.png",
  "assets/dungeons/drowned_city/coral-barricade.png",
  "assets/dungeons/drowned_city/drowned-causeway-floor.png",
  "assets/dungeons/drowned_city/drowned-citizen.png",
  "assets/dungeons/drowned_city/entrance.png",
  "assets/dungeons/drowned_city/flooded-plaza-floor.png",
  "assets/dungeons/drowned_city/floodgate-closed.png",
  "assets/dungeons/drowned_city/floodgate-open.png",
  "assets/dungeons/drowned_city/harbor-boss-floor.png",
  "assets/dungeons/drowned_city/harbor-square-floor.png",
  "assets/dungeons/drowned_city/harbor-street-floor.png",
  "assets/dungeons/drowned_city/harbor-warden-hall-floor.png",
  "assets/dungeons/drowned_city/kelp-boss-floor.png",
  "assets/dungeons/drowned_city/kelp-square-floor.png",
  "assets/dungeons/drowned_city/kelp-street-floor.png",
  "assets/dungeons/drowned_city/kelp-warden-hall-floor.png",
  "assets/dungeons/drowned_city/obs-boss-floor.png",
  "assets/dungeons/drowned_city/obs-square-floor.png",
  "assets/dungeons/drowned_city/obs-street-floor.png",
  "assets/dungeons/drowned_city/obs-warden-hall-floor.png",
  "assets/dungeons/drowned_city/past-square-floor.png",
  "assets/dungeons/drowned_city/past-street-floor.png",
  "assets/dungeons/drowned_city/return-rift.png",
  "assets/dungeons/drowned_city/sunken-stair-floor.png",
  "assets/dungeons/drowned_city/tide-bomb.png",
  "assets/dungeons/drowned_city/tide-switch-off.png",
  "assets/dungeons/drowned_city/tide-switch-on.png",
  "assets/dungeons/drowned_city/tidecraft-altar.png",
  "assets/dungeons/drowned_city/time-rift-dormant.png",
  "assets/dungeons/drowned_city/time-rift-open.png",
  "assets/dungeons/fallen_prison/entrance.png",
  "assets/dungeons/cistern_warrens/brood-chamber-floor.png",
  "assets/dungeons/cistern_warrens/entrance.png",
  "assets/dungeons/cistern_warrens/exit-ladder.png",
  "assets/dungeons/cistern_warrens/grate-barricade.png",
  "assets/dungeons/cistern_warrens/hatch-landing-floor.png",
  "assets/dungeons/cistern_warrens/overflow-channel-floor.png",
  "assets/dungeons/cistern_warrens/sewer-door.png",
  "assets/dungeons/cistern_warrens/sewer-floor.png",
  "assets/dungeons/cistern_warrens/turtle-cistern-floor.png",
  "assets/dungeons/cistern_warrens/warden-junction-floor.png",
  "assets/dungeons/cistern_warrens/web-snare.png",
  "assets/dungeons/cistern_warrens/webbed-tunnels-floor.png",
  "assets/dungeons/fangrock_cavern/bone-pit-floor.png",
  "assets/dungeons/fangrock_cavern/cave-mouth-floor.png",
  "assets/dungeons/fangrock_cavern/chieftain-throne-floor.png",
  "assets/dungeons/fangrock_cavern/mushroom-grotto-floor.png",
  "assets/dungeons/fangrock_cavern/narrow-pass-floor.png",
  "assets/dungeons/fangrock_cavern/entrance.png",
  "assets/dungeons/fangrock_cavern/raptor-den-floor.png",
  "assets/dungeons/fangrock_cavern/rockfall-barricade.png",
  "assets/dungeons/fangrock_cavern/scale-shrine.png",
  "assets/dungeons/fangrock_cavern/the-fork-floor.png",
  "assets/dungeons/golem_forge/anvil-stair-floor.png",
  "assets/dungeons/golem_forge/bellows-hall-floor.png",
  "assets/dungeons/golem_forge/bull-pen-floor.png",
  "assets/dungeons/golem_forge/coil-works-floor.png",
  "assets/dungeons/golem_forge/containment-floor.png",
  "assets/dungeons/golem_forge/cooling-hall-floor.png",
  "assets/dungeons/golem_forge/cracked-wall.png",
  "assets/dungeons/golem_forge/crucible-hub-floor.png",
  "assets/dungeons/golem_forge/cutting-floor-floor.png",
  "assets/dungeons/golem_forge/entrance-collapsed.png",
  "assets/dungeons/golem_forge/entrance.png",
  "assets/dungeons/golem_forge/forge-door-open.png",
  "assets/dungeons/golem_forge/forge-door-sealed.png",
  "assets/dungeons/golem_forge/forge-gate-floor.png",
  "assets/dungeons/golem_forge/gem-vault-floor.png",
  "assets/dungeons/golem_forge/great-anvil-lit.png",
  "assets/dungeons/golem_forge/great-forge-floor.png",
  "assets/dungeons/golem_forge/healer-monolith-broken.png",
  "assets/dungeons/golem_forge/healer-monolith.png",
  "assets/dungeons/golem_forge/husk-foundry-floor.png",
  "assets/dungeons/golem_forge/monolith-gallery-floor.png",
  "assets/dungeons/golem_forge/sentinel-walk-floor.png",
  "assets/dungeons/golem_forge/slag-barricade.png",
  "assets/dungeons/golem_forge/slag-vault-floor.png",
  "assets/dungeons/golem_forge/slag-yard-floor.png",
  "assets/dungeons/golem_forge/spark-forge.png",
  "assets/dungeons/golem_forge/wing-sigil-lit.png",
  "assets/dungeons/shared/brazier-lit.png",
  "assets/dungeons/shared/brazier-unlit.png",
  "assets/dungeons/shared/chest-closed.png",
  "assets/dungeons/shared/chest-open.png",
  "assets/dungeons/shared/lever-off.png",
  "assets/dungeons/shared/lever-on.png",
  "assets/dungeons/shared/mimic-chest-closed.png",
  "assets/dungeons/shared/orc-cave-entrance.png",
  "assets/dungeons/shared/pressure-plate-pressed.png",
  "assets/dungeons/shared/pressure-plate-released.png",
  "assets/dungeons/shared/rune-seal-broken.png",
  "assets/dungeons/shared/rune-seal-intact.png",
  "assets/dungeons/shared/vault-chest-closed.png",
  "assets/dungeons/shared/vault-chest-open.png",
  "assets/dungeons/still_hand_monastery/bamboo-barricade.png",
  "assets/dungeons/still_hand_monastery/bell-hall-floor.png",
  "assets/dungeons/still_hand_monastery/zephyr-altar.png",
  "assets/dungeons/still_hand_monastery/entrance.png",
  "assets/dungeons/still_hand_monastery/grandmaster-sanctum-floor.png",
  "assets/dungeons/still_hand_monastery/mountain-gate-floor.png",
  "assets/dungeons/still_hand_monastery/statue-hall-floor.png",
  "assets/dungeons/still_hand_monastery/still-garden-floor.png",
  "assets/dungeons/still_hand_monastery/training-courtyard-floor.png",
  "assets/dungeons/the_eyrie/bramble-barricade.png",
  "assets/dungeons/the_eyrie/cliff-base-floor.png",
  "assets/dungeons/the_eyrie/entrance.png",
  "assets/dungeons/the_eyrie/giant-egg.png",
  "assets/dungeons/the_eyrie/nest-crown-floor.png",
  "assets/dungeons/the_eyrie/scrap-hollow-floor.png",
  "assets/dungeons/the_eyrie/switchback-ledge-floor.png",
  "assets/dungeons/the_eyrie/wind-bridge-floor.png",
  "assets/manor/simpledoublebed.png",
  "assets/skills/class-icons-v3.png",
  "assets/skills/general-skills-v3.png",
  "assets/skills/new/deepstone-lore.png",
  "assets/skills/new/field-engineering.png",
  "assets/skills/new/grove-lore.png",
  "assets/skills/new/hollin-lore.png",
  "assets/skills/new/rare-beast-mastery.png",
  "assets/skills/new/tidecraft.png",
  "assets/skills/profession-icons-v3.png",
  "assets/skills/profession-skill-icons-v3.png",
  "brand/ash-atlas-logo.png",
  "brand/sign-in-with-apple-continue-white@3x.png",
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-48x48.png",
  "icon-192x192.png",
  "icon-512x512.png",
  "icon-maskable-192x192.png",
  "icon-maskable-512x512.png"
] as const;

const publicAssets: DevPngAsset[] = publicPngPaths.map((path) => {
  const isDungeonAsset = path.startsWith("assets/dungeons/");
  const isManorAsset = path.startsWith("assets/manor/");
  return {
    id: stableId(
      `public/${path}`,
      isDungeonAsset ? "dungeon-scene" : isManorAsset ? "manor-asset" : "app-icon"
    ),
    label: friendlyFileName(path),
    category: isDungeonAsset ? "Dungeon Scenes" : isManorAsset ? "Manor Assets" : "App Icons",
    url: `${import.meta.env.BASE_URL}${path}`,
    usageLabel: isDungeonAsset
      ? "Dungeon Scene Asset"
      : isManorAsset ? "Manor Template Asset" : "Browser / Installed App Icon",
    sourcePath: `apps/client/public/${path}`,
    productionSize: null,
    productionSource: isDungeonAsset
      ? "Dungeon catalog scene assets"
      : isManorAsset ? "Manor template catalog assets" : "Browser manifest or document metadata",
    placeable: isDungeonAsset || isManorAsset,
    anchor: CENTER
  };
});

export const DEV_PNG_ASSETS: readonly DevPngAsset[] = [...bundledAssets, ...publicAssets]
  .sort((left, right) =>
    left.category.localeCompare(right.category)
      || left.label.localeCompare(right.label)
      || left.usageLabel.localeCompare(right.usageLabel)
  );

export const DEV_PNG_CATEGORIES: readonly string[] = [
  ...new Set(DEV_PNG_ASSETS.map(({ category }) => category))
].sort();

export function findDevPngAsset(assetId: string): DevPngAsset | null {
  return DEV_PNG_ASSETS.find(({ id }) => id === assetId) ?? null;
}

export function filterDevPngAssets(
  query: string,
  category: string,
  placeableOnly = false
): readonly DevPngAsset[] {
  const normalizedQuery = query.trim().toLowerCase();
  return DEV_PNG_ASSETS.filter((asset) =>
    (category === "all" || asset.category === category)
    && (!placeableOnly || asset.placeable)
    && (!normalizedQuery
      || `${asset.label} ${asset.usageLabel} ${asset.sourcePath}`
        .toLowerCase()
        .includes(normalizedQuery))
  );
}

registerDevPngAssets(DEV_PNG_ASSETS);
