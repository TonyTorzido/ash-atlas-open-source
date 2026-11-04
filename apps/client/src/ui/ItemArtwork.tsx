import {
  manorTypeSummary,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  appearanceAssetParts,
  baseAppearanceForEquipment,
  isEquipmentDefinitionId,
  isMobDropItemId,
  MOB_DROP_ITEMS,
  runtimePngItemDisplayScale
} from "@ash-atlas/shared";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import type { CSSProperties } from "react";
import { shopMaskArtUrl } from "../shop/shopModel.js";

import { useItemNameTooltip, type ItemNameTooltipMode } from "./ItemNameTooltip.js";

import bow from "../assets/items/bow.png";
import alligatorHide from "../assets/items/alligator-hide.png";
import bearHide from "../assets/items/bear-hide.png";
import coal from "../assets/items/coal.png";
import coin from "../assets/items/coin.png";
import crudeOil from "../assets/items/CrudeOil1.png";
import deerHide from "../assets/items/deer-hide.png";
import frostDeerCut from "../assets/items/frost-deer-cut.png";
import jungleDeerCut from "../assets/items/jungle-deer-cut.png";
import marshDeerCut from "../assets/items/marsh-deer-cut.png";
import sandDeerCut from "../assets/items/sand-deer-cut.png";
import deerCutArt from "../assets/items/deer-cut.png";
import wolfCutArt from "../assets/items/wolf-cut.png";
import hogCutArt from "../assets/items/hog-cut.png";
import bearCutArt from "../assets/items/bear-cut.png";
import frogLegsArt from "../assets/items/frog-legs.png";
import crabMeatArt from "../assets/items/crab-meat.png";
import alligatorTailArt from "../assets/items/alligator-tail.png";
import squidCutArt from "../assets/items/squid-cut.png";
import frostWolfCutArt from "../assets/items/frost-wolf-cut.png";
import duneWolfCutArt from "../assets/items/dune-wolf-cut.png";
import jungleWolfCutArt from "../assets/items/jungle-wolf-cut.png";
import bogWolfCutArt from "../assets/items/bog-wolf-cut.png";
import woollyHogCutArt from "../assets/items/woolly-hog-cut.png";
import warthogCutArt from "../assets/items/warthog-cut.png";
import jungleHogCutArt from "../assets/items/jungle-hog-cut.png";
import mudHogCutArt from "../assets/items/mud-hog-cut.png";
import javelinaCutArt from "../assets/items/javelina-cut.png";
import snowBearCutArt from "../assets/items/snow-bear-cut.png";
import blackBearCutArt from "../assets/items/black-bear-cut.png";
import sunBearCutArt from "../assets/items/sun-bear-cut.png";
import iceCrabMeatArt from "../assets/items/ice-crab-meat.png";
import sandCrabMeatArt from "../assets/items/sand-crab-meat.png";
import mangroveCrabMeatArt from "../assets/items/mangrove-crab-meat.png";
import frostFrogLegsArt from "../assets/items/frost-frog-legs.png";
import poisonFrogLegsArt from "../assets/items/poison-frog-legs.png";
import desertToadLegsArt from "../assets/items/desert-toad-legs.png";
import caimanTailArt from "../assets/items/caiman-tail.png";
import crocodileTailArt from "../assets/items/crocodile-tail.png";
import slagArt from "../assets/items/slag.png";
import sulfurArt from "../assets/items/sulfur.png";
import forgeSparkArt from "../assets/items/forge-spark.png";
import shardGritArt from "../assets/items/shard-grit.png";
import amuletClaspArt from "../assets/items/amulet-clasp.png";
import fireFeatherArt from "../assets/items/fire-feather.png";
import tempestQuillArt from "../assets/items/tempest-quill.png";
import iceFeatherArt from "../assets/items/ice-feather.png";
import fireBarArt from "../assets/items/fire-bar.png";
import lightningBarArt from "../assets/items/lightning-bar.png";
import iceBarArt from "../assets/items/ice-bar.png";
import fireCoreArt from "../assets/items/fire-core.png";
import lightningCoreArt from "../assets/items/lightning-core.png";
import iceCoreArt from "../assets/items/ice-core.png";
import crystalArt from "../assets/items/crystal.png";
import pearlArt from "../assets/items/pearl.png";
import shellbackPlateArt from "../assets/items/shellback-plate.png";
import abyssalOrbArt from "../assets/items/abyssal-orb.png";
import tidewaterDraughtArt from "../assets/items/tidewater-draught.png";
import undertowSnareArt from "../assets/items/undertow-snare.png";
import stillwaterOrbArt from "../assets/items/stillwater-orb.png";
import freeStepWardArt from "../assets/items/free-step-ward.png";
import masonsTomeArt from "../assets/items/masons-tome.png";
import freshwaterFishArt from "../assets/items/freshwater-fish.png";
import smallCatchArt from "../assets/items/small-catch.png";
import fishingRodArt from "../assets/items/fishing-rod.png";
import woodenAxeArt from "../assets/items/wooden-axe.png";
import stoneAxeArt from "../assets/items/stone-axe.png";
import woodenPickaxeArt from "../assets/items/wooden-pickaxe.png";
import stonePickaxeArt from "../assets/items/stone-pickaxe.png";
import starterFishingPoleArt from "../assets/items/starter-fishing-pole.png";
import flaxFiberArt from "../assets/items/flax-fiber.png";
import clothArt from "../assets/items/cloth.png";
import jellyfishJellyArt from "../assets/items/jellyfish-jelly.png";
import crawlerFleshArt from "../assets/items/crawler-flesh.png";
import xoralEssenceArt from "../assets/items/xoral-essence.png";
import scorchingBirdMeatArt from "../assets/items/scorching-bird-meat.png";
import zappyBirdMeatArt from "../assets/items/zappy-bird-meat.png";
import freezingBirdMeatArt from "../assets/items/freezing-bird-meat.png";
import jungleTapirCutArt from "../assets/items/jungle-tapir-cut.png";
import jaguarCutArt from "../assets/items/jaguar-cut.png";
import mandrillCutArt from "../assets/items/mandrill-cut.png";
import capercaillieMeatArt from "../assets/items/capercaillie-meat.png";
import elkCutArt from "../assets/items/elk-cut.png";
import redSquirrelCutArt from "../assets/items/red-squirrel-cut.png";
import badgerCutArt from "../assets/items/badger-cut.png";
import greySquirrelCutArt from "../assets/items/grey-squirrel-cut.png";
import stagBeetleCutArt from "../assets/items/stag-beetle-cut.png";
import greatGreyOwlMeatArt from "../assets/items/great-grey-owl-meat.png";
import flyingSquirrelCutArt from "../assets/items/flying-squirrel-cut.png";
import plainsBisonCutArt from "../assets/items/plains-bison-cut.png";
import prairieDogCutArt from "../assets/items/prairie-dog-cut.png";
import burrowingOwlMeatArt from "../assets/items/burrowing-owl-meat.png";
import giraffeCutArt from "../assets/items/giraffe-cut.png";
import lionessCutArt from "../assets/items/lioness-cut.png";
import spottedHyenaCutArt from "../assets/items/spotted-hyena-cut.png";
import sitatungaCutArt from "../assets/items/sitatunga-cut.png";
import emperorDragonflyCutArt from "../assets/items/emperor-dragonfly-cut.png";
import mountainIbexCutArt from "../assets/items/mountain-ibex-cut.png";
import wildYakCutArt from "../assets/items/wild-yak-cut.png";
import alpineMarmotCutArt from "../assets/items/alpine-marmot-cut.png";
import wildScrubGoatCutArt from "../assets/items/wild-scrub-goat-cut.png";
import crestedPorcupineCutArt from "../assets/items/crested-porcupine-cut.png";
import spurThighedTortoiseCutArt from "../assets/items/spur-thighed-tortoise-cut.png";
import dromedaryCutArt from "../assets/items/dromedary-cut.png";
import fennecFoxCutArt from "../assets/items/fennec-fox-cut.png";
import sidewinderCutArt from "../assets/items/sidewinder-cut.png";
import fieldHareCutArt from "../assets/items/field-hare-cut.png";
import arcticHareCutArt from "../assets/items/arctic-hare-cut.png";
import capybaraCutArt from "../assets/items/capybara-cut.png";
import armadilloCutArt from "../assets/items/armadillo-cut.png";
import redFoxCutArt from "../assets/items/red-fox-cut.png";
import wolverineCutArt from "../assets/items/wolverine-cut.png";
import ostrichCutArt from "../assets/items/ostrich-cut.png";
import goldenEagleCutArt from "../assets/items/golden-eagle-cut.png";
import muskOxCutArt from "../assets/items/musk-ox-cut.png";
import sealCutArt from "../assets/items/seal-cut.png";
import desertLionCutArt from "../assets/items/desert-lion-cut.png";
import saigaCutArt from "../assets/items/saiga-cut.png";
import wildHorseCutArt from "../assets/items/wild-horse-cut.png";
import steppeMarmotCutArt from "../assets/items/steppe-marmot-cut.png";
import lemmingCutArt from "../assets/items/lemming-cut.png";
import snowGooseMeatArt from "../assets/items/snow-goose-meat.png";
import mammothCutArt from "../assets/items/mammoth-cut.png";
import direWolfCutArt from "../assets/items/dire-wolf-cut.png";
import drakeCutArt from "../assets/items/drake-cut.png";
import dragonCutArt from "../assets/items/dragon-cut.png";
import grubMeatArt from "../assets/items/grub-meat.png";
import emperorPenguinMeatArt from "../assets/items/emperor-penguin-meat.png";
import pearyCaribouCutArt from "../assets/items/peary-caribou-cut.png";
import iceWormCutArt from "../assets/items/ice-worm-cut.png";
import seaOtterCutArt from "../assets/items/sea-otter-cut.png";
import herringGullMeatArt from "../assets/items/herring-gull-meat.png";
import spinyLobsterTailArt from "../assets/items/spiny-lobster-tail.png";
import hammerheadSharkSteakArt from "../assets/items/hammerhead-shark-steak.png";
import mantaRayWingArt from "../assets/items/manta-ray-wing.png";
import humpbackWhaleCutArt from "../assets/items/humpback-whale-cut.png";
import muskellungeFilletArt from "../assets/items/muskellunge-fillet.png";
import muteSwanMeatArt from "../assets/items/mute-swan-meat.png";
import pikeFilletArt from "../assets/items/pike-fillet.png";
import snappingTurtleCutArt from "../assets/items/snapping-turtle-cut.png";
import beaverCutArt from "../assets/items/beaver-cut.png";
import otterCutArt from "../assets/items/otter-cut.png";
import salmonFilletArt from "../assets/items/salmon-fillet.png";
import elementalRationArt from "../assets/items/elemental-ration.png";
import fieldRationArt from "../assets/items/field-ration.png";
import heartyRationArt from "../assets/items/hearty-ration.png";
import boneArt from "../assets/items/bone.png";
import bricksArt from "../assets/items/bricks.png";
import chitinArt from "../assets/items/chitin.png";
import fertilizerArt from "../assets/items/fertilizer.png";
import fluxPlantArt from "../assets/items/flux-plant.png";
import produceArt from "../assets/items/produce.png";
import seedArt from "../assets/items/seed.png";
import repairKitArt from "../assets/items/repair-kit.png";
import lumenArt from "../assets/items/lumen.png";
import torchArt from "../assets/items/torch.png";
import trainingHeavyBootsArt from "../assets/items/training-heavy-boots.png";
import trainingLightBootsArt from "../assets/items/training-light-boots.png";
import trainingHeavyGlovesArt from "../assets/items/training-heavy-gloves.png";
import trainingLightGlovesArt from "../assets/items/training-light-gloves.png";
import trainingHeavyHelmArt from "../assets/items/training-heavy-helm.png";
import trainingLightHoodArt from "../assets/items/training-light-hood.png";
import trainingShieldArt from "../assets/items/training-shield.png";
import rangedShieldArt from "../assets/items/ranged-shield.png";
import food from "../assets/items/food.png";
import generic from "../assets/items/generic.png";
import hogHide from "../assets/items/hog-hide.png";
import iron from "../assets/items/iron.png";
import ironBar from "../assets/items/iron-bar.png";
import jellyfishVenom from "../assets/items/jellyfish-venom.png";
import broodSilk from "../assets/items/brood-silk.png";
import raptorScale from "../assets/items/raptor-scale.png";
import giantEgg from "../assets/items/giant-egg-item.png";
import broodEggItem from "../assets/items/brood-egg.png";
import clutchEggItem from "../assets/items/clutch-egg.png";
import crawlerEggItem from "../assets/items/crawler-egg.png";
import brokenWhistleItem from "../assets/items/whistle-broken.png";
import bonewroughtBladeItem from "../assets/items/bonewrought-blade.png";
import bonewroughtMailItem from "../assets/items/bonewrought-mail.png";
import elderAcorn from "../assets/items/elder-acorn.png";
import wyrmEgg from "../assets/items/wyrm-egg.png";
import dragonScale from "../assets/items/dragon-scale.png";
import zephyr from "../assets/items/zephyr.png";
import refinedOil from "../assets/items/refined-oil.png";
import leather from "../assets/items/leather.png";
import missingItemSquare from "../assets/items/missing-item-square.svg";
import ore from "../assets/items/ore.png";
import givingBerry from "../assets/items/GivingBerry2.png";
import resin from "../assets/items/Resin1.png";
import ring from "../assets/items/ring.png";
import satchel from "../assets/items/satchel.png";
import staff from "../assets/items/staff.png";
import scepter from "../assets/items/scepter.png";
import stone from "../assets/items/stone.png";
import sword from "../assets/items/sword.png";
import tunic from "../assets/items/tunic.png";
import venomsteelBar from "../assets/items/venomsteel-bar.png";
import venomsteelCore from "../assets/items/venomsteel-core.png";
import water from "../assets/items/water.png";
import wood from "../assets/items/wood.png";
import wolfPelt from "../assets/items/wolf-pelt.png";
import squidFlesh from "../assets/items/squid-flesh.svg";
import crabCarapace from "../assets/items/crab-carapace.svg";
import rawMeat from "../assets/items/raw-meat.svg";
import shell from "../assets/items/shell.svg";
import atlasShrineShard from "../assets/items/atlas-shrine-shard.svg";
import amethystEnchantmentStone from "../assets/items/enchantment-stones/amethyst.png";
import defaultManorExterior from "../assets/structures/manor.png";
import diamondEnchantmentStone from "../assets/items/enchantment-stones/diamond.png";
import emeraldEnchantmentStone from "../assets/items/enchantment-stones/emerald.png";
import onyxEnchantmentStone from "../assets/items/enchantment-stones/onyx.png";
import opalEnchantmentStone from "../assets/items/enchantment-stones/opal.png";
import rubyEnchantmentStone from "../assets/items/enchantment-stones/ruby.png";
import sapphireEnchantmentStone from "../assets/items/enchantment-stones/sapphire.png";
import topazEnchantmentStone from "../assets/items/enchantment-stones/topaz.png";
import { clientAssetKeyUrl, runtimePngAssetUrl } from "../map/runtimePngAssetUrl.js";

type Props = {
  itemId: string;
  category?: string | null | undefined;
  variant?: string | null | undefined;
  label: string;
  size?: "inventory" | "ground";
  /** Item-name tooltip. "hover-only" on hosts with their own hold/drag/long-press; false to omit it. */
  nameTooltip?: ItemNameTooltipMode | false;
};

const GREENHOUSE_ITEM_ART_IDS = ["wheat_seed", "wheat", "gardening_bucket", "water_bucket"] as const;

export const ITEM_ARTWORK_URLS = {
  wood,
  stone,
  coal,
  iron,
  sulfur: sulfurArt,
  slag: slagArt,
  forge_spark: forgeSparkArt,
  shard_grit: shardGritArt,
  amulet_clasp: amuletClaspArt,
  iron_bar: ironBar,
  venomsteel_bar: venomsteelBar,
  venomsteel_core: venomsteelCore,
  fire_feather: fireFeatherArt,
  tempest_quill: tempestQuillArt,
  ice_feather: iceFeatherArt,
  fire_bar: fireBarArt,
  fire_core: fireCoreArt,
  lightning_bar: lightningBarArt,
  lightning_core: lightningCoreArt,
  ice_bar: iceBarArt,
  ice_core: iceCoreArt,
  food,
  simple_food: food,
  freshwater_fish: freshwaterFishArt,
  ashen_fish: freshwaterFishArt,
  fishing_rod: fishingRodArt,
  wooden_axe: woodenAxeArt,
  stone_axe: stoneAxeArt,
  wooden_pickaxe: woodenPickaxeArt,
  stone_pickaxe: stonePickaxeArt,
  starter_fishing_pole: starterFishingPoleArt,
  leather,
  deer_hide: deerHide,
  hog_hide: hogHide,
  wolf_pelt: wolfPelt,
  bear_hide: bearHide,
  alligator_hide: alligatorHide,
  squid_flesh: squidFlesh,
  squid_meat: squidCutArt,
  deer_meat: deerCutArt,
  wolf_meat: wolfCutArt,
  hog_meat: hogCutArt,
  bear_meat: bearCutArt,
  alligator_meat: alligatorTailArt,
  wild_meat: rawMeat,
  crab_carapace: crabCarapace,
  raw_meat: rawMeat,
  shell,
  ore,
  water,
  flax_fiber: flaxFiberArt,
  cloth: clothArt,
  giving_berry: givingBerry,
  balsam_resin: resin,
  crude_oil: crudeOil,
  jellyfish_venom: jellyfishVenom,
  brood_silk: broodSilk,
  raptor_scale: raptorScale,
  giant_egg: giantEgg,
  brood_egg: broodEggItem,
  clutch_egg: clutchEggItem,
  crawler_egg: crawlerEggItem,
  broken_whistle: brokenWhistleItem,
  bonewrought_blade: bonewroughtBladeItem,
  bonewrought_mail: bonewroughtMailItem,
  elder_acorn: elderAcorn,
  wyrm_egg: wyrmEgg,
  dragon_scale: dragonScale,
  zephyr,
  refined_oil: refinedOil,
  crystal: crystalArt,
  pearl: pearlArt,
  shellback_plate: shellbackPlateArt,
  abyssal_orb: abyssalOrbArt,
  tidewater_draught: tidewaterDraughtArt,
  undertow_snare: undertowSnareArt,
  stillwater_orb: stillwaterOrbArt,
  free_step_ward: freeStepWardArt,
  masons_tome: masonsTomeArt,
  // Dungeon special-metal ingredients (1101): no approved art yet.
  cave_lichen: missingItemSquare,
  gale_plume: missingItemSquare,
  heartsap: missingItemSquare,
  maw_bloom_petal: missingItemSquare,
  atlas_shrine_shard: atlasShrineShard,
  enchantment_stone: emeraldEnchantmentStone,
  frog_legs: frogLegsArt,
  frost_frog_legs: frostFrogLegsArt,
  poison_frog_legs: poisonFrogLegsArt,
  desert_toad_legs: desertToadLegsArt,
  crab_meat: crabMeatArt,
  ice_crab_meat: iceCrabMeatArt,
  sand_crab_meat: sandCrabMeatArt,
  mangrove_crab_meat: mangroveCrabMeatArt,
  small_catch: smallCatchArt,
  jellyfish_jelly: jellyfishJellyArt,
  crawler_flesh: crawlerFleshArt,
  squid_cut: squidCutArt,
  wolf_cut: wolfCutArt,
  frost_wolf_cut: frostWolfCutArt,
  dune_wolf_cut: duneWolfCutArt,
  jungle_wolf_cut: jungleWolfCutArt,
  bog_wolf_cut: bogWolfCutArt,
  deer_cut: deerCutArt,
  frost_deer_cut: frostDeerCut,
  jungle_deer_cut: jungleDeerCut,
  marsh_deer_cut: marshDeerCut,
  sand_deer_cut: sandDeerCut,
  hog_cut: hogCutArt,
  woolly_hog_cut: woollyHogCutArt,
  warthog_cut: warthogCutArt,
  jungle_hog_cut: jungleHogCutArt,
  mud_hog_cut: mudHogCutArt,
  javelina_cut: javelinaCutArt,
  alligator_tail: alligatorTailArt,
  caiman_tail: caimanTailArt,
  crocodile_tail: crocodileTailArt,
  bear_cut: bearCutArt,
  snow_bear_cut: snowBearCutArt,
  black_bear_cut: blackBearCutArt,
  sun_bear_cut: sunBearCutArt,
  jungle_tapir_cut: jungleTapirCutArt,
  jaguar_cut: jaguarCutArt,
  mandrill_cut: mandrillCutArt,
  capercaillie_meat: capercaillieMeatArt,
  elk_cut: elkCutArt,
  red_squirrel_cut: redSquirrelCutArt,
  badger_cut: badgerCutArt,
  grey_squirrel_cut: greySquirrelCutArt,
  stag_beetle_cut: stagBeetleCutArt,
  great_grey_owl_meat: greatGreyOwlMeatArt,
  flying_squirrel_cut: flyingSquirrelCutArt,
  plains_bison_cut: plainsBisonCutArt,
  prairie_dog_cut: prairieDogCutArt,
  burrowing_owl_meat: burrowingOwlMeatArt,
  giraffe_cut: giraffeCutArt,
  lioness_cut: lionessCutArt,
  spotted_hyena_cut: spottedHyenaCutArt,
  sitatunga_cut: sitatungaCutArt,
  emperor_dragonfly_cut: emperorDragonflyCutArt,
  mountain_ibex_cut: mountainIbexCutArt,
  wild_yak_cut: wildYakCutArt,
  alpine_marmot_cut: alpineMarmotCutArt,
  wild_scrub_goat_cut: wildScrubGoatCutArt,
  crested_porcupine_cut: crestedPorcupineCutArt,
  spur_thighed_tortoise_cut: spurThighedTortoiseCutArt,
  dromedary_cut: dromedaryCutArt,
  fennec_fox_cut: fennecFoxCutArt,
  sidewinder_cut: sidewinderCutArt,
  field_hare_cut: fieldHareCutArt,
  arctic_hare_cut: arcticHareCutArt,
  capybara_cut: capybaraCutArt,
  armadillo_cut: armadilloCutArt,
  red_fox_cut: redFoxCutArt,
  wolverine_cut: wolverineCutArt,
  ostrich_cut: ostrichCutArt,
  golden_eagle_cut: goldenEagleCutArt,
  musk_ox_cut: muskOxCutArt,
  seal_cut: sealCutArt,
  desert_lion_cut: desertLionCutArt,
  saiga_cut: saigaCutArt,
  wild_horse_cut: wildHorseCutArt,
  steppe_marmot_cut: steppeMarmotCutArt,
  lemming_cut: lemmingCutArt,
  snow_goose_meat: snowGooseMeatArt,
  mammoth_cut: mammothCutArt,
  dire_wolf_cut: direWolfCutArt,
  drake_cut: drakeCutArt,
  dragon_cut: dragonCutArt,
  grub_meat: grubMeatArt,
  emperor_penguin_meat: emperorPenguinMeatArt,
  peary_caribou_cut: pearyCaribouCutArt,
  ice_worm_cut: iceWormCutArt,
  sea_otter_cut: seaOtterCutArt,
  herring_gull_meat: herringGullMeatArt,
  spiny_lobster_tail: spinyLobsterTailArt,
  hammerhead_shark_steak: hammerheadSharkSteakArt,
  manta_ray_wing: mantaRayWingArt,
  humpback_whale_cut: humpbackWhaleCutArt,
  muskellunge_fillet: muskellungeFilletArt,
  mute_swan_meat: muteSwanMeatArt,
  pike_fillet: pikeFilletArt,
  snapping_turtle_cut: snappingTurtleCutArt,
  beaver_cut: beaverCutArt,
  otter_cut: otterCutArt,
  salmon_fillet: salmonFilletArt,
  elemental_ration: elementalRationArt,
  scorching_bird_meat: scorchingBirdMeatArt,
  zappy_bird_meat: zappyBirdMeatArt,
  freezing_bird_meat: freezingBirdMeatArt,
  field_ration: fieldRationArt,
  hearty_ration: heartyRationArt,
  xoral_essence: xoralEssenceArt,
  bone: boneArt,
  bricks: bricksArt,
  chitin: chitinArt,
  fertilizer: fertilizerArt,
  flux_plant: fluxPlantArt,
  produce: produceArt,
  seed: seedArt,
  repair_kit: repairKitArt,
  lumen: lumenArt,
  torch: torchArt,
  training_heavy_boots: trainingHeavyBootsArt,
  training_light_boots: trainingLightBootsArt,
  training_heavy_gloves: trainingHeavyGlovesArt,
  training_light_gloves: trainingLightGlovesArt,
  training_heavy_helm: trainingHeavyHelmArt,
  training_light_hood: trainingLightHoodArt,
  training_ring: ring,
  training_shield: trainingShieldArt,
  ranged_shield: rangedShieldArt,
  gold: coin,
  pack: satchel
} as const;

/** The shared fallback used when an item has no approved dedicated artwork. */
export const GENERIC_ITEM_ARTWORK_URL = generic;
/** The grey square shown for an item whose art is known to be missing. */
export const MISSING_ITEM_ARTWORK_URL = missingItemSquare;

const LEGACY_EQUIPMENT_ART: Readonly<Record<string, string>> = {
  starter_sword: sword,
  starter_bow: bow,
  starter_staff: staff,
  training_scepter: scepter,
  padded_tunic: tunic,
  double_axe: requirePlayerAppearanceAsset("weapons/double-axe.png"),
  breast_plate: requirePlayerAppearanceAsset("armor/chest/breast-plate.png"),
  hammer: requirePlayerAppearanceAsset("weapons/hammer.png"),
  leather_armor: requirePlayerAppearanceAsset("armor/chest/leather-armor.png"),
  chopping_ring: ring,
  mining_ring: ring,
  attack_ring: ring,
  ring_plain: ring,
  ring_fine: ring,
  ring_prime: ring,
  ring_peerless: ring
};

export function ItemArtwork({ itemId, category, variant, label, size = "inventory", nameTooltip = "full" }: Props): React.JSX.Element {
  const source = itemArtworkSource(itemId, category, variant);
  const style = itemArtworkStyle(itemId, variant, size);
  const { bind, tip } = useItemNameTooltip(label, nameTooltip === false ? "hover-only" : nameTooltip);
  // The display name is the image's accessible name; an empty label stays decorative.
  const imgA11y = label === "" ? { alt: "", "aria-hidden": true as const } : { alt: label };
  if (nameTooltip === false || label === "") return <img className="item-artwork" src={source} style={style} {...imgA11y} />;
  return <><img className="item-artwork" src={source} style={style} {...imgA11y} {...bind} />{tip}</>;
}

export function itemArtworkStyle(
  itemId: string,
  variant?: string | null | undefined,
  size: "inventory" | "ground" = "inventory"
): CSSProperties {
  const presentationKey = itemId === "enchantment_stone" && variant
    ? `enchantment_stone:${variant}`
    : itemId;
  return {
    "--item-artwork-scale": size === "ground"
      // Indoor ground renderers size their visual frame from the shared
      // player-relative geometry helper. Keep this image at one scale so the
      // frame and its locked hit box cannot double-apply the authored value.
      ? 1
      : runtimePngItemDisplayScale(presentationKey)
  } as CSSProperties;
}

export function itemArtworkSource(
  itemId: string,
  category?: string | null | undefined,
  variant?: string | null | undefined
): string {
  if (itemId === "enchantment_stone" && variant) {
    return ENCHANTMENT_STONE_ARTWORK[variant] ?? ITEM_ARTWORK_URLS.enchantment_stone;
  }
  if (itemId === "face_mask") {
    // Masks are per-copy items; the look (mask appearance id) is passed as the variant.
    const mask = shopMaskArtUrl(variant);
    if (mask) return mask;
  }
  if (itemId === "manor_skin") {
    // A skin shows the overworld building of its Manor type.
    const exterior = variant ? manorTypeSummary(variant).exteriorAssetKey : null;
    return (exterior ? clientAssetKeyUrl(exterior) : null) ?? defaultManorExterior;
  }
  const studioArtwork = equipmentStudioArtwork(itemId);
  const greenhouseArtwork = greenhouseItemArtwork(itemId);
  return ITEM_ARTWORK_URLS[itemId as keyof typeof ITEM_ARTWORK_URLS]
    ?? greenhouseArtwork
    ?? mobDropItemArtwork(itemId)
    ?? studioArtwork
    ?? LEGACY_EQUIPMENT_ART[itemId]
    ?? categoryArtwork(category)
    ?? generic;
}

function greenhouseItemArtwork(itemId: string): string | null {
  if (!GREENHOUSE_ITEM_ART_IDS.includes(itemId as (typeof GREENHOUSE_ITEM_ART_IDS)[number])) {
    return null;
  }
  return runtimePngAssetUrl(
    `apps/client/src/assets/items/${itemId.replaceAll("_", "-")}.png`
  );
}

function mobDropItemArtwork(itemId: string): string | null {
  return isMobDropItemId(itemId) ? runtimePngAssetUrl(MOB_DROP_ITEMS[itemId].assetPath) : null;
}

function equipmentStudioArtwork(itemId: string): string | null {
  if (!isEquipmentDefinitionId(itemId)) return null;
  const appearance = baseAppearanceForEquipment(
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    itemId
  );
  const assetKey = appearance
    ? appearanceAssetParts(appearance)[0]?.assetKey
    : null;
  return assetKey ? playerAppearanceAssetUrl(assetKey) : null;
}

const ENCHANTMENT_STONE_ARTWORK: Readonly<Record<string, string>> = {
  amethyst: amethystEnchantmentStone,
  diamond: diamondEnchantmentStone,
  emerald: emeraldEnchantmentStone,
  onyx: onyxEnchantmentStone,
  opal: opalEnchantmentStone,
  ruby: rubyEnchantmentStone,
  sapphire: sapphireEnchantmentStone,
  topaz: topazEnchantmentStone
};

function categoryArtwork(category: string | null | undefined): string | null {
  switch (category) {
    case "melee_weapon": return sword;
    case "ranged_weapon": return bow;
    case "chest_armor": return tunic;
    // Empty gathering tool slots: the starter tool of that kind.
    case "gathering_axe": return woodenAxeArt;
    case "gathering_pickaxe": return woodenPickaxeArt;
    case "gathering_fishing_pole": return starterFishingPoleArt;
    default: return null;
  }
}

function requirePlayerAppearanceAsset(assetKey: string): string {
  const source = playerAppearanceAssetUrl(assetKey);
  if (!source) throw new Error(`Missing player appearance asset: ${assetKey}`);
  return source;
}
