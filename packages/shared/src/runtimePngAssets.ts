import {
  MILITARY_ART_HOOKS,
  MILITARY_UNIT_TYPES,
  type MilitaryUnitType
} from "./militaryIndustry.js";
import { DEFAULT_MANOR_TEMPLATE_CATALOG as manorCatalog } from "./manorTemplateCatalog.js";
import { INTERIOR_DATA } from "./data/interiors/index.js";
import { TERRITORY_STRUCTURE_CATALOG } from "./territoryStructures.js";
import { MONOLITH_DISPLAY_NAMES, MONOLITH_TYPES, type MonolithType } from "./monoliths.js";
import { MOB_DROP_ITEMS, type MobDropItemDefinition } from "./mobDropItems.js";
import {
  UNIVERSAL_FOOD_ITEMS,
  UNIVERSAL_FOOD_ITEM_IDS,
  type UniversalFoodItemId
} from "./universalFood.js";

/** The canonical repository root for PNGs loaded by the game client. */
export const RUNTIME_PNG_CLIENT_ASSET_ROOT = "apps/client/src/assets/";

export type RuntimePngAssetEditor =
  | { kind: "sprite"; key: string }
  | { kind: "fixed"; key: string }
  | { kind: "world-object"; key: string }
  | { kind: "readonly"; reason: string };

export type RuntimePngAssetUsage = Readonly<{
  id: string;
  label: string;
  context: string;
  editor: RuntimePngAssetEditor;
}>;

/**
 * Production-owned registration for a visible/placeable PNG slot.
 *
 * Appearance Studio consumes this registry in addition to recursive discovery,
 * so a registered asset remains editable before its first PNG is committed.
 * Keep paths rooted at the same canonical client asset tree consumed by the
 * renderer.
 */
export type RuntimePngAssetRegistration = Readonly<{
  id: string;
  relativeFile: string;
  label: string;
  category: string;
  fallbackKey: string;
  usages: readonly RuntimePngAssetUsage[];
}>;

const readonlyUsage = (
  id: string,
  label: string,
  context: string
): RuntimePngAssetUsage => ({
  id,
  label,
  context,
  editor: {
    kind: "readonly",
    reason: context
  }
});

const worldObjectUsage = (
  id: string,
  label: string,
  key: string,
  context = "World City Facility"
): RuntimePngAssetUsage => ({
  id,
  label,
  context,
  editor: { kind: "world-object", key }
});

const spriteUsage = (
  id: string,
  label: string,
  key: string,
  context = "World Ground Drop"
): RuntimePngAssetUsage => ({
  id,
  label,
  context,
  editor: { kind: "sprite", key }
});

type MilitaryUnitUsageId = MilitaryUnitType |
  "siege-packed" |
  "siege-deployed" |
  "siege-launch" |
  "siege-rock" |
  "bomber-idle" |
  "bomber-planting" | "bomber-escaping" | "bomber-detonation";

const militaryUnitUsage = (
  id: MilitaryUnitUsageId,
  label: string,
  key: string
): RuntimePngAssetUsage => ({
  id: `production-military-${id}-world`,
  label,
  context: "World military unit group",
  editor: { kind: "sprite", key }
});

const militaryUnitRegistration = (unitType: MilitaryUnitType): RuntimePngAssetRegistration => {
  const hook = MILITARY_ART_HOOKS[unitType]!;
  const label = unitType === "field_ballista"
    ? "Siege"
    : unitType === "infantry"
      ? "Melee Kippin"
      : unitType.charAt(0).toUpperCase() + unitType.slice(1);
  return {
    id: `military-${unitType}`,
    relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}${hook.assetKey}`,
    label,
    category: "Military",
    fallbackKey: hook.fallbackKey,
    usages: [militaryUnitUsage(unitType, label, `militaryUnits.${unitType}`)]
  };
};

const militaryStateRegistration = (
  id: "siege-packed" | "siege-deployed" | "siege-launch" | "siege-rock" | "bomber-idle" | "bomber-planting" | "bomber-escaping" | "bomber-detonation",
  label: string,
  assetKey: string,
  presentationKey: string,
  fallbackKey: string
): RuntimePngAssetRegistration => ({
  id: `military-${id}`,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}${assetKey}`,
  label,
  category: "Military",
  fallbackKey,
  usages: [militaryUnitUsage(
    id,
    label,
    presentationKey
  )]
});

const militarySpecialRegistration = (
  id: "war_camp" | "fusion_badge",
  label: string
): RuntimePngAssetRegistration => {
  const hook = MILITARY_ART_HOOKS[id]!;
  return {
    id: `military-${id}`,
    relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}${hook.assetKey}`,
    label,
    category: "Military",
    fallbackKey: hook.fallbackKey,
    usages: [readonlyUsage(
      `production-military-${id}`,
      id === "fusion_badge" ? "Military Fusion Badge" : "Military War Camp",
      "Military presentation hook owns display size until production art is authored"
    )]
  };
};

const MILITARY_FACILITY_ART_TYPES = [
  "barracks",
  "armory",
  "demolition_factory",
  "siege_workshop",
  "powder_works"
] as const;
type MilitaryFacilityArtType = typeof MILITARY_FACILITY_ART_TYPES[number];

const militaryFacilityLabels: Readonly<Record<MilitaryFacilityArtType, string>> = {
  barracks: "Barracks",
  armory: "Armory",
  demolition_factory: "Demolition Factory",
  siege_workshop: "Siege Workshop",
  powder_works: "Powder Works"
};

const militaryFacilityRegistration = (
  facilityType: MilitaryFacilityArtType
): RuntimePngAssetRegistration => ({
  id: `military-facility-${facilityType}`,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/${facilityType.replace(/_/gu, "-")}.png`,
  label: militaryFacilityLabels[facilityType],
  category: "Buildings",
  fallbackKey: "city-foundation",
  usages: [worldObjectUsage(
    `production-${facilityType}-world-city-facility`,
    militaryFacilityLabels[facilityType],
    `cityStructures.${facilityType}`
  )]
});

const loomRegistration = (): RuntimePngAssetRegistration => ({
  id: "loom",
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/loom.png`,
  label: "Loom",
  category: "Buildings",
  fallbackKey: "tannery",
  usages: [worldObjectUsage(
    "production-loom-world-object",
    "Loom",
    "loom",
    "World Loom"
  )]
});

/** War monoliths: one slot per type. No art yet; the map draws a plain range marker until it lands. */
const monolithRegistration = (type: MonolithType): RuntimePngAssetRegistration => ({
  id: `war-monolith-${type}`,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/monoliths/${type}.png`,
  label: MONOLITH_DISPLAY_NAMES[type],
  category: "War Structures",
  fallbackKey: "generic",
  usages: [readonlyUsage(
    `production-war-monolith-${type}`,
    MONOLITH_DISPLAY_NAMES[type],
    "World map monolith marker inside its 540 m range ring, and the Construction → War card"
  )]
});

const manorFloorRegistration = (): RuntimePngAssetRegistration => ({
  id: "manor-floor",
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/manor-floor.png`,
  label: "Manor Lobby Floor",
  category: "Buildings",
  fallbackKey: "manor",
  usages: [readonlyUsage(
    "production-manor-lobby-floor",
    "Manor Studio Lobby Floor",
    "Studio-authored indoor floor surface; the Manor scene owns display geometry"
  )]
});

const greenhouseArtworkRegistration = (
  id: string,
  relativeFile: string,
  label: string,
  category: string,
  fallbackKey: string,
  context: string,
  worldObjectKey?: string
): RuntimePngAssetRegistration => ({
  id,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}${relativeFile}`,
  label,
  category,
  fallbackKey,
  usages: [worldObjectKey
    ? worldObjectUsage(`production-${id}`, label, worldObjectKey, context)
    : readonlyUsage(`production-${id}`, label, context)]
});

const slagRegistration = (): RuntimePngAssetRegistration => ({
  id: "slag",
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/slag.png`,
  label: "Slag",
  category: "Items & Equipment",
  fallbackKey: "missing-item-square",
  usages: [
    spriteUsage(
      "production-slag-ground-drop",
      "Slag Ground Drop",
      "slag"
    ),
    readonlyUsage(
      "production-slag-inventory",
      "Slag Inventory & Dialog Artwork",
      "Owning UI tiles set this display size"
    )
  ]
});
const universalFoodRegistration = (
  itemId: UniversalFoodItemId
): RuntimePngAssetRegistration => {
  const food = UNIVERSAL_FOOD_ITEMS[itemId];
  return {
    id: `item-${itemId}`,
    relativeFile: food.assetPath,
    label: food.displayName,
    category: "Items & Materials",
    fallbackKey: "generic",
    usages: [spriteUsage(
      `production-${itemId}-item`,
      food.displayName,
      "food",
      "Inventory, dropped-item prompt, pickup dialog, and Kitchen recipe input share the authored item size"
    )]
  };
};

const mobDropItemRegistration = (
  item: MobDropItemDefinition
): RuntimePngAssetRegistration => ({
  id: `item-${item.itemId}`,
  relativeFile: item.assetPath,
  label: item.displayName,
  category: "Items & Materials",
  fallbackKey: "generic",
  usages: [spriteUsage(
    `production-${item.itemId}-item`,
    item.displayName,
    "generic",
    "Inventory, dropped-item prompt and pickup dialog share the authored item size"
  )]
});

const fishingBackgroundRegistration = (
  kind: "river" | "lake" | "ocean",
  fileName: string,
  label: string
): RuntimePngAssetRegistration => ({
  id: `fishing-background-${kind}`,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}fishing/${fileName}`,
  label: `${label} Fishing Background`,
  category: "Fishing",
  fallbackKey: "generic",
  usages: [readonlyUsage(
    `production-fishing-${kind}-background`,
    `${label} Fishing Background`,
    "Overworld fishing encounter scene for the authoritative gameplay water type"
  )]
});

const dungeonMobRegistration = (
  id: string,
  fileName: string,
  label: string,
  spriteKey: string
): RuntimePngAssetRegistration => ({
  id: `mob-${id}`,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}${fileName}`,
  label,
  category: "Mobs & Animals",
  fallbackKey: "generic",
  usages: [spriteUsage(
    `production-${id}-dungeon-mob`,
    `${label} Dungeon Mob`,
    spriteKey,
    "Dungeon Studio combat placement"
  )]
});

const chatCrestRegistration = (
  id: "lion" | "leaf" | "stag" | "cross",
  label: string
): RuntimePngAssetRegistration => ({
  id: `chat-crest-${id}`,
  relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}chat-crests/${id}.png`,
  label: `Chat Crest · ${label}`,
  category: "Chat Crests",
  fallbackKey: "chat-crest-leaf",
  usages: [readonlyUsage(
    `production-chat-crest-${id}`,
    `Chat Crest · ${label}`,
    "Atlas Chats message groups and Chat Settings; fixed 34–40px circular identity medallion"
  )]
});

/**
 * Canonical slots for production-visible artwork. New production PNG hooks
 * should be registered here rather than in Appearance Studio.
 */
const greenhouseTreeStageRegistration = (
  stage: number,
  relativeFile: string,
  label: string
): RuntimePngAssetRegistration => ({
  id: `greenhouse-giving-berry-tree-stage-${stage}`,
  relativeFile,
  label,
  category: "Greenhouse",
  fallbackKey: "generic",
  usages: [readonlyUsage(
    `greenhouse-giving-berry-tree-stage-${stage}`,
    label,
    "Greenhouse Studio Plants → Giving Berry Tree stage artwork"
  )]
});

export const RUNTIME_PNG_ASSET_REGISTRY: readonly RuntimePngAssetRegistration[] = Object.freeze([
  { id: "giving-berry", relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}items/GivingBerry2.png`,
    label: "Giving Berry", category: "Items", fallbackKey: "resource",
    usages: [{ id: "giving-berry-item", label: "Giving Berry",
      context: "Inventory, hotbar, market, ground drops, and healing feedback",
      editor: { kind: "sprite", key: "giving_berry" } }] },
  greenhouseTreeStageRegistration(1, `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-seedling.png`, "Giving Berry Tree · Seedling"),
  greenhouseTreeStageRegistration(2, `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-middle-2.png`, "Giving Berry Tree · Middle 2"),
  greenhouseTreeStageRegistration(3, `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-fruiting.png`, "Giving Berry Tree · Stage 3 (Fruiting)"),
  greenhouseTreeStageRegistration(4, `${RUNTIME_PNG_CLIENT_ASSET_ROOT}plants/giving-berry-tree-mature.png`, "Giving Berry Tree · Stage 4 (Mature)"),
  ...Object.entries(TERRITORY_STRUCTURE_CATALOG.packs).flatMap(([packId, pack]) =>
    Object.values(pack.structures).flatMap((visual) => visual!.pieces.map((piece) => ({
      id: `territory-${packId}-${visual!.structureType}-${piece.id}`,
      relativeFile: piece.asset,
      label: `${pack.displayName} · ${TERRITORY_STRUCTURE_CATALOG.structures[visual!.structureType]!.displayName} · ${piece.name}`,
      category: "Territory",
      fallbackKey: "flag",
      usages: [
        readonlyUsage(`territory-${visual!.id}-${piece.id}`, `${pack.displayName} · ${piece.name}`,
          "Flags → Components owns this layer; the structure owns its root transform and interaction area"),
        ...(piece.asset === `${RUNTIME_PNG_CLIENT_ASSET_ROOT}structures/atlas-shrine.png` ? [{
          id: "world-map-atlas-shrine", label: "World Map Atlas Shrine", context: "World Map destination marker",
          editor: { kind: "fixed" as const, key: "worldMapAtlasShrine" }
        }] : [])
      ]
    })))
  ),
  ...MILITARY_UNIT_TYPES.map(militaryUnitRegistration),
  militaryStateRegistration(
    "siege-packed",
    "Kippen Siege · Mobile / Idle",
    "military/units/siege-packed.png",
    "militaryUnits.field_ballista.packed",
    "ballista-with-crew-silhouette"
  ),
  militaryStateRegistration(
    "siege-deployed",
    "Kippen Siege · Deployed / Loading",
    "military/units/siege-deployed.png",
    "militaryUnits.field_ballista.deployed",
    "ballista-with-crew-silhouette"
  ),
  militaryStateRegistration(
    "siege-launch",
    "Kippen Siege · Launch",
    "military/units/siege-launch.png",
    "militaryUnits.field_ballista.launch",
    "ballista-with-crew-silhouette"
  ),
  militaryStateRegistration(
    "siege-rock",
    "Kippen Siege · Sling Stone",
    "military/units/siege-rock.png",
    "militaryUnits.field_ballista.rock",
    "ballista-with-crew-silhouette"
  ),
  militaryStateRegistration(
    "bomber-idle",
    "Kippen Bomber · Idle",
    "military/units/bomber-idle.png",
    "militaryUnits.bomber.idle",
    "unit-silhouette"
  ),
  militaryStateRegistration(
    "bomber-planting",
    "Kippen Bomber · Planting",
    "military/units/bomber-planting.png",
    "militaryUnits.bomber.planting",
    "unit-silhouette"
  ),
  militaryStateRegistration(
    "bomber-escaping", "Kippen Bomber · Escape", "military/units/bomber-escaping.png",
    "militaryUnits.bomber.escaping", "unit-silhouette"
  ),
  militaryStateRegistration(
    "bomber-detonation", "Kippen Bomber · Detonation", "military/units/bomber-detonation.png",
    "militaryUnits.bomber.detonation", "unit-silhouette"
  ),
  militarySpecialRegistration("war_camp", "War Camp"),
  militarySpecialRegistration("fusion_badge", "Fusion Count Badge"),
  ...MILITARY_FACILITY_ART_TYPES.map(militaryFacilityRegistration),
  loomRegistration(),
  ...MONOLITH_TYPES.map(monolithRegistration),
  manorFloorRegistration(),
  greenhouseArtworkRegistration(
    "greenhouse-exterior",
    "structures/greenhouse.png",
    "Greenhouse Exterior",
    "Buildings",
    "manor",
    "World Greenhouse exterior; owner placement uses the universal portal registry",
    "greenhouse"
  ),
  greenhouseArtworkRegistration(
    "greenhouse-floor",
    "structures/greenhouse-floor.png",
    "Greenhouse Floor",
    "Greenhouse",
    "manor",
    "Greenhouse interior floor; Studio uploads may replace the fallback square"
  ),
  greenhouseArtworkRegistration(
    "greenhouse-pot",
    "structures/greenhouse-pot.png",
    "Greenhouse Farm Plot",
    "Greenhouse",
    "manor",
    "Centered reusable Farm Plot template art; a generic square fallback is used until uploaded"
  ),
  greenhouseArtworkRegistration(
    "greenhouse-water-tank",
    "structures/greenhouse-water-tank.png",
    "Greenhouse Water Tank",
    "Greenhouse",
    "manor",
    "Separate centered water-tank template art; placement uses the durable tank instance"
  ),
  ...[1, 2, 3, 4].map((slot) => greenhouseArtworkRegistration(
    `greenhouse-overlay-${slot}`,
    `structures/greenhouse-overlays/overlay-0${slot}.png`,
    `Greenhouse Overlay ${slot}`,
    "Greenhouse",
    "manor",
    "Studio-authored greenhouse overlay placed above the shared floor transform"
  )),
  greenhouseArtworkRegistration(
    "wheat-seedling",
    "plants/wheat-seedling.png",
    "Wheat · Seedling",
    "Greenhouse Plants",
    "generic",
    "Greenhouse wheat stage 1 anchor art"
  ),
  greenhouseArtworkRegistration(
    "wheat-middle-2",
    "plants/wheat-middle-2.png",
    "Wheat · Middle 2",
    "Greenhouse Plants",
    "generic",
    "Greenhouse wheat stage 2 anchor art"
  ),
  greenhouseArtworkRegistration(
    "wheat-middle-3",
    "plants/wheat-middle-3.png",
    "Wheat · Middle 3",
    "Greenhouse Plants",
    "generic",
    "Greenhouse wheat stage 3 anchor art"
  ),
  greenhouseArtworkRegistration(
    "wheat-full",
    "plants/wheat-full.png",
    "Wheat · Full",
    "Greenhouse Plants",
    "generic",
    "Greenhouse wheat stage 4 harvestable anchor art"
  ),
  greenhouseArtworkRegistration(
    "item-wheat-seed",
    "items/wheat-seed.png",
    "Wheat Seed",
    "Items & Materials",
    "generic",
    "Inventory, Farm Plot prompt, and starter allotment artwork"
  ),
  greenhouseArtworkRegistration(
    "item-wheat",
    "items/wheat.png",
    "Wheat",
    "Items & Materials",
    "generic",
    "Inventory and harvest result artwork"
  ),
  greenhouseArtworkRegistration(
    "item-gardening-bucket",
    "items/gardening-bucket.png",
    "Gardening Bucket",
    "Items & Materials",
    "generic",
    "Inventory and greenhouse water interaction artwork"
  ),
  greenhouseArtworkRegistration(
    "item-water-bucket",
    "items/water-bucket.png",
    "Water Bucket",
    "Items & Materials",
    "generic",
    "Inventory and river refill interaction artwork"
  ),
  // One entry per Manor PNG (rooms of a type may share a floor picture), plus each type's overworld building.
  ...manorCatalog.templates.flatMap((template) => [
    ...template.rooms.flatMap((room) => {
      const assetKey = (room as { floorAssetKey?: string }).floorAssetKey;
      return assetKey ? [{ id: `manor-room-${template.id}-${room.id}`, relativeFile: assetKey,
        label: `${template.name} · ${room.name}`, category: "Manor rooms", fallbackKey: "manor",
        usages: [readonlyUsage(`manor-room-${template.id}-${room.id}`, `${room.name} floor`, "Authored Manor room background")] }] : [];
    }),
    ...(template.exterior ? [{ id: `manor-exterior-${template.id}`, relativeFile: template.exterior.assetKey,
      label: `${template.name} · Overworld`, category: "Manor rooms", fallbackKey: "manor",
      usages: [readonlyUsage(`manor-exterior-${template.id}`, `${template.name} building`, "Manor type overworld building")] }] : [])
  ]).filter((entry, index, entries) => entries.findIndex((candidate) => candidate.relativeFile === entry.relativeFile) === index),
  // Only dungeon art belongs to this group (one entry per PNG, so size variants of a prefab share it); the Greenhouse prefabs' PNGs are registered with the greenhouse slots.
  ...INTERIOR_DATA.library.prefabs.filter((prefab, index, prefabs) => prefab.assetKey.startsWith("apps/client/public/assets/dungeons/") &&
    prefabs.findIndex((candidate) => candidate.assetKey === prefab.assetKey) === index).map((prefab) => ({ id: `dungeon-prefab-${prefab.id}`, relativeFile: prefab.assetKey,
    label: prefab.name, category: "Dungeons", fallbackKey: "dungeon",
    usages: [readonlyUsage(`dungeon-prefab-${prefab.id}`, prefab.name, "Authored dungeon art, objects and entrance pictures")] })),
  slagRegistration(),
  dungeonMobRegistration("slime", "mobs/dungeon/slime.png", "Slime", "slime"),
  dungeonMobRegistration("slime-miniboss", "mobs/dungeon/slime_miniboss.png", "Slime Miniboss", "slimeMiniboss"),
  dungeonMobRegistration("sewer-rat", "sewer-rat.png", "Sewer Rat", "sewerRat"),
  dungeonMobRegistration("sick-sewer-rat", "sick-sewer-rat.png", "Sick Sewer Rat", "sickSewerRat"),
  dungeonMobRegistration("sewer-rat-miniboss", "sewer-rat-miniboss.png", "Sewer Rat Miniboss", "sewerRatMiniboss"),
  dungeonMobRegistration("shellback-turtle", "mobs/dungeons/shellback-turtle.png", "Shell-back Turtle", "shellbackTurtle"),
  dungeonMobRegistration("sewer-spider", "mobs/dungeons/sewer-spider.png", "Sewer Spider", "sewerSpider"),
  dungeonMobRegistration("dune-tick", "mobs/dungeons/dune-tick.png", "Dune Tick", "duneTick"),
  dungeonMobRegistration("spiderling", "mobs/dungeons/spiderling.png", "Spiderling", "spiderling"),
  dungeonMobRegistration("cave-raptor", "mobs/dungeons/cave-raptor.png", "Cave Raptor", "caveRaptor"),
  dungeonMobRegistration("raptor-runt", "mobs/dungeons/raptor-runt.png", "Raptor Runt", "raptorRunt"),
  dungeonMobRegistration("raptor-spitter", "mobs/dungeons/raptor-spitter.png", "Raptor Spitter", "raptorSpitter"),
  dungeonMobRegistration("cave-bat", "mobs/dungeons/cave-bat.png", "Cave Bat", "caveBat"),
  dungeonMobRegistration("raptor-chieftain", "mobs/dungeons/raptor-chieftain.png", "Raptor Chieftain", "raptorChieftain"),
  dungeonMobRegistration("nest-mouse", "mobs/dungeons/nest-mouse.png", "Nest Mouse", "nestMouse"),
  dungeonMobRegistration("carrion-chick", "mobs/dungeons/carrion-chick.png", "Carrion Chick", "carrionChick"),
  dungeonMobRegistration("cliff-hawk", "mobs/dungeons/cliff-hawk.png", "Cliff Hawk", "cliffHawk"),
  dungeonMobRegistration("thunderwing", "mobs/dungeons/thunderwing.png", "Thunderwing", "thunderwing"),
  dungeonMobRegistration("rot-wolf", "mobs/dungeons/rot-wolf.png", "Rot Wolf", "rotWolf"),
  dungeonMobRegistration("blighted-stag", "mobs/dungeons/blighted-stag.png", "Blighted Stag", "blightedStag"),
  dungeonMobRegistration("thornfern", "mobs/dungeons/thornfern.png", "Thornfern", "thornfern"),
  dungeonMobRegistration("blight-treant", "mobs/dungeons/blight-treant.png", "Blight Treant", "blightTreant"),
  dungeonMobRegistration("blight-sprite", "mobs/dungeons/blight-sprite.png", "Blight Sprite", "blightSprite"),
  dungeonMobRegistration("mimic", "mobs/dungeons/mimic.png", "Mimic", "mimic"),
  dungeonMobRegistration("hollow-elder", "mobs/dungeons/hollow-elder.png", "Hollow Elder", "hollowElder"),
  dungeonMobRegistration("drakeling", "mobs/dungeons/drakeling.png", "Drakeling", "drakeling"),
  dungeonMobRegistration("magma-salamander", "mobs/dungeons/magma-salamander.png", "Magma Salamander", "magmaSalamander"),
  dungeonMobRegistration("lava-slime", "mobs/dungeons/lava-slime.png", "Lava Slime", "lavaSlime"),
  dungeonMobRegistration("ash-wyvern", "mobs/dungeons/ash-wyvern.png", "Ash Wyvern", "ashWyvern"),
  dungeonMobRegistration("drake-broodguard", "mobs/dungeons/drake-broodguard.png", "Drake Broodguard", "drakeBroodguard"),
  dungeonMobRegistration("elder-dragon", "mobs/dungeons/elder-dragon.png", "Elder Dragon", "elderDragon"),
  dungeonMobRegistration("initiate-monk", "mobs/dungeons/initiate-monk.png", "Initiate Monk", "initiateMonk"),
  dungeonMobRegistration("staff-adept", "mobs/dungeons/staff-adept.png", "Staff Adept", "staffAdept"),
  dungeonMobRegistration("shadow-acrobat", "mobs/dungeons/shadow-acrobat.png", "Shadow Acrobat", "shadowAcrobat"),
  dungeonMobRegistration("iron-statue", "mobs/dungeons/iron-statue.png", "Iron Statue Guardian", "ironStatue"),
  dungeonMobRegistration("bell-spirit", "mobs/dungeons/bell-spirit.png", "Bell Spirit", "bellSpirit"),
  dungeonMobRegistration("ember-shade", "mobs/dungeons/ember-shade.png", "Ember Shade", "emberShade"),
  dungeonMobRegistration("ashbound-revenant", "mobs/dungeons/ashbound-revenant.png", "Ashbound Revenant", "ashboundRevenant"),
  dungeonMobRegistration("vault-warden", "mobs/dungeons/vault-warden.png", "Vault Warden", "vaultWarden"),
  dungeonMobRegistration("sky-scout", "mobs/dungeons/sky-scout.png", "Spire Scout", "skyScout"),
  dungeonMobRegistration("cloud-sentry", "mobs/dungeons/cloud-sentry.png", "Cloud Sentry", "cloudSentry"),
  dungeonMobRegistration("cloud-arbiter", "mobs/dungeons/cloud-arbiter.png", "Cloud Arbiter", "cloudArbiter"),
  dungeonMobRegistration("warden-scout", "mobs/dungeons/warden-scout.png", "Warden Scout", "wardenScout"),
  dungeonMobRegistration("zealot", "mobs/dungeons/zealot.png", "Zealot", "zealot"),
  dungeonMobRegistration("serpent-jailer", "mobs/dungeons/serpent-jailer.png", "Serpent Jailer", "serpentJailer"),
  dungeonMobRegistration("caged-valkyrie", "mobs/dungeons/caged-valkyrie.png", "Caged Valkyrie", "cagedValkyrie"),
  dungeonMobRegistration("coil-hatchling", "mobs/dungeons/coil-hatchling.png", "Coil Hatchling", "coilHatchling"),
  dungeonMobRegistration("legion-soldier", "mobs/dungeons/legion-soldier.png", "Legion Soldier", "legionSoldier"),
  dungeonMobRegistration("centurion", "mobs/dungeons/centurion.png", "Cohort Marshal", "centurion"),
  dungeonMobRegistration("brood-matron", "mobs/dungeons/brood-matron.png", "Brood Matron", "broodMatron"),
  dungeonMobRegistration("trifang-warden", "mobs/dungeons/trifang-warden.png", "Trifang Warden", "trifangWarden"),
  dungeonMobRegistration("grandmaster", "mobs/dungeons/grandmaster.png", "The Grandmaster", "grandmaster"),
  dungeonMobRegistration("brood-matriarch", "mobs/dungeons/brood-matriarch.png", "Brood Matriarch", "broodMatriarch"),
  {
    id: "mob-skeleton",
    relativeFile: `${RUNTIME_PNG_CLIENT_ASSET_ROOT}skeleton.png`,
    label: "Skeleton",
    category: "Mobs & Animals",
    fallbackKey: "generic",
    usages: [spriteUsage(
      "production-skeleton-world",
      "Skeleton",
      "skeleton",
      "Overworld dusk/night combat mob"
    )]
  },
  ...UNIVERSAL_FOOD_ITEM_IDS.map(universalFoodRegistration),
  ...Object.values(MOB_DROP_ITEMS).map(mobDropItemRegistration),
  fishingBackgroundRegistration("river", "RiverBackground.png", "River"),
  fishingBackgroundRegistration("lake", "LakeBackground.png", "Lake"),
  fishingBackgroundRegistration("ocean", "OceanBackground.png", "Ocean"),
  chatCrestRegistration("lion", "Lion"),
  chatCrestRegistration("leaf", "Leaf"),
  chatCrestRegistration("stag", "Stag"),
  chatCrestRegistration("cross", "Cross")
]);

// Cosmetic packs can share a PNG. Preserve every authored use instead of letting
// the last pack silently replace the file's Game PNGs metadata.
const registrationsByPath = new Map<string, RuntimePngAssetRegistration>();
for (const registration of RUNTIME_PNG_ASSET_REGISTRY) {
  const previous = registrationsByPath.get(registration.relativeFile);
  registrationsByPath.set(registration.relativeFile, previous ? {
    ...previous,
    usages: [...new Map([...previous.usages, ...registration.usages].map((usage) => [usage.id, usage])).values()]
  } : registration);
}
const registrationsById = new Map(
  RUNTIME_PNG_ASSET_REGISTRY.map((registration) => [registration.id, registration] as const)
);

export function runtimePngAssetRegistration(
  relativeFile: string
): RuntimePngAssetRegistration | null {
  return registrationsByPath.get(relativeFile) ?? null;
}

export function runtimePngAssetRegistrationById(
  id: string
): RuntimePngAssetRegistration | null {
  return registrationsById.get(id) ?? null;
}
