import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  CREATURE_BOOK_ROSTER,
  bossAppearanceForArchetype,
  type CombatEntitySnapshot,
  type MobAppearanceVariant,
  type MobArchetypeKey
} from "@ash-atlas/shared";
import { bossAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";

import alligator from "../assets/alligator.png";
import bear from "../assets/bear.png";
import coastalCrab from "../assets/coastal-crab.png";
import deer from "../assets/deer.png";
import frostDeer from "../assets/frost-deer.png";
import jungleDeer from "../assets/jungle-deer.png";
import marshDeer from "../assets/marsh-deer.png";
import sandDeer from "../assets/sand-deer.png";
import frostWolf from "../assets/frost-wolf.png";
import duneWolf from "../assets/dune-wolf.png";
import jungleWolf from "../assets/jungle-wolf.png";
import bogWolf from "../assets/bog-wolf.png";
import woollyHog from "../assets/woolly-hog.png";
import warthog from "../assets/warthog.png";
import jungleHog from "../assets/jungle-hog.png";
import mudHog from "../assets/mud-hog.png";
import javelina from "../assets/javelina.png";
import snowBear from "../assets/snow-bear.png";
import blackBear from "../assets/black-bear.png";
import sunBear from "../assets/sun-bear.png";
import iceCrab from "../assets/ice-crab.png";
import sandCrab from "../assets/sand-crab.png";
import mangroveCrab from "../assets/mangrove-crab.png";
import frostFrog from "../assets/frost-frog.png";
import poisonFrog from "../assets/poison-frog.png";
import desertToad from "../assets/desert-toad.png";
import caiman from "../assets/caiman.png";
import crocodile from "../assets/crocodile.png";
import frostWraith from "../assets/frost-wraith.png";
import yeti from "../assets/yeti.png";
import barrowWight from "../assets/barrow-wight.png";
import risenSkeleton from "../assets/risen-skeleton.png";
import revenantLich from "../assets/revenant-lich.png";
import mossGolem from "../assets/moss-golem.png";
import vineLurker from "../assets/vine-lurker.png";
import lizardfolkWarrior from "../assets/lizardfolk-warrior.png";
import bogGhoul from "../assets/bog-ghoul.png";
import giantScorpion from "../assets/giant-scorpion.png";
import dustMummy from "../assets/dust-mummy.png";
import thunderhorn from "../assets/thunderhorn.png";
import griffin from "../assets/griffin.png";
import basilisk from "../assets/basilisk.png";
import bandit from "../assets/bandit.png";
import trainingDummy from "../assets/training-dummy.png";
import orcBrute from "../assets/orc-brute.png";
import hollinHut from "../assets/hollin-hut.png";
import hollinGuard from "../assets/hollin-guard.png";
import hollinFarmer from "../assets/hollin-farmer.png";
import hollinHelper from "../assets/hollin-helper.png";
import fireBird from "../assets/fire-bird.png";
import frog from "../assets/frog.png";
import hog from "../assets/hog.png";
import iceBird from "../assets/ice-bird.png";
import jellyfish from "../assets/jellyfish.png";
import lightningBird from "../assets/lightning-bird.png";
import mysteriousTraveler from "../assets/mysterious-traveler.png";
import ogre from "../assets/ogre.png";
import sapCrawler from "../assets/resin-crawler.png";
import squid from "../assets/squid.png";
import wolf from "../assets/wolf.png";
import sewerRat from "../assets/sewer-rat.png";
import sickSewerRat from "../assets/sick-sewer-rat.png";
import sewerRatMiniboss from "../assets/sewer-rat-miniboss.png";
import skeleton from "../assets/skeleton.png";
import goblinBasic from "../assets/goblins/goblin-basic.png";
import goblinWarrior from "../assets/goblins/goblin-warrior.png";
import goblinArcher from "../assets/goblins/goblin-archer.png";
import goblinHealer from "../assets/goblins/goblin-healer.png";
import jungleTapir from "../assets/jungle-tapir.png";
import jaguar from "../assets/jaguar.png";
import mandrill from "../assets/mandrill.png";
import canopyGoblin from "../assets/canopy-goblin.png";
import poisonfrogRaider from "../assets/poisonfrog-raider.png";
import pantherfolkStalker from "../assets/pantherfolk-stalker.png";
import vineWrappedCorpse from "../assets/vine-wrapped-corpse.png";
import serpentPriestess from "../assets/serpent-priestess.png";
import capercaillie from "../assets/capercaillie.png";
import bugbearChieftain from "../assets/bugbear-chieftain.png";
import pinewarden from "../assets/pinewarden.png";
import gallowsGhost from "../assets/gallows-ghost.png";
import alderKing from "../assets/alder-king.png";
import elk from "../assets/elk.png";
import redSquirrel from "../assets/red-squirrel.png";
import pineDryad from "../assets/pine-dryad.png";
import badger from "../assets/badger.png";
import greySquirrel from "../assets/grey-squirrel.png";
import stagBeetle from "../assets/stag-beetle.png";
import mossjawSneak from "../assets/mossjaw-sneak.png";
import mossjawSpearman from "../assets/mossjaw-spearman.png";
import mossjawHexer from "../assets/mossjaw-hexer.png";
import mossjawWarboss from "../assets/mossjaw-warboss.png";
import hedgeWitch from "../assets/hedge-witch.png";
import restlessGravedigger from "../assets/restless-gravedigger.png";
import covenMatron from "../assets/coven-matron.png";
import greatGreyOwl from "../assets/great-grey-owl.png";
import flyingSquirrel from "../assets/flying-squirrel.png";
import stagfolkWarden from "../assets/stagfolk-warden.png";
import rimeWitch from "../assets/rime-witch.png";
import draugrBerserker from "../assets/draugr-berserker.png";
import snowTalonbear from "../assets/snow-talonbear.png";
import frostwaterTroll from "../assets/frostwater-troll.png";
import undericeLurker from "../assets/underice-lurker.png";
import plainsBison from "../assets/plains-bison.png";
import prairieDog from "../assets/prairie-dog.png";
import burrowingOwl from "../assets/burrowing-owl.png";
import centaurOutrider from "../assets/centaur-outrider.png";
import voltElemental from "../assets/volt-elemental.png";
import possessedScythe from "../assets/possessed-scythe.png";
import strawmanLord from "../assets/strawman-lord.png";
import giraffe from "../assets/giraffe.png";
import lioness from "../assets/lioness.png";
import spottedHyena from "../assets/spotted-hyena.png";
import gnollBonebow from "../assets/gnoll-bonebow.png";
import gnollPackseer from "../assets/gnoll-packseer.png";
import gnollPacklord from "../assets/gnoll-packlord.png";
import carrionGhoul from "../assets/carrion-ghoul.png";
import sunGriffin from "../assets/sun-griffin.png";
import sitatunga from "../assets/sitatunga.png";
import emperorDragonfly from "../assets/emperor-dragonfly.png";
import frogfolkTadpole from "../assets/frogfolk-tadpole.png";
import frogfolkBlowgunner from "../assets/frogfolk-blowgunner.png";
import frogfolkShaman from "../assets/frogfolk-shaman.png";
import frogfolkChief from "../assets/frogfolk-chief.png";
import bloatLeech from "../assets/bloat-leech.png";
import bogHag from "../assets/bog-hag.png";
import leechMother from "../assets/leech-mother.png";
import mountainIbex from "../assets/mountain-ibex.png";
import wildYak from "../assets/wild-yak.png";
import alpineMarmot from "../assets/alpine-marmot.png";
import yakfolkStonehorn from "../assets/yakfolk-stonehorn.png";
import highlandReaver from "../assets/highland-reaver.png";
import stormHarpy from "../assets/storm-harpy.png";
import cairnWight from "../assets/cairn-wight.png";
import stormwingChick from "../assets/stormwing-chick.png";
import stormwing from "../assets/stormwing.png";
import wildScrubGoat from "../assets/wild-scrub-goat.png";
import crestedPorcupine from "../assets/crested-porcupine.png";
import spurThighedTortoise from "../assets/spur-thighed-tortoise.png";
import cyclopsShepherd from "../assets/cyclops-shepherd.png";
import skeletonHoplite from "../assets/skeleton-hoplite.png";
import tarElemental from "../assets/tar-elemental.png";
import oliveDryad from "../assets/olive-dryad.png";
import chimera from "../assets/chimera.png";
import dromedary from "../assets/dromedary.png";
import fennecFox from "../assets/fennec-fox.png";
import sidewinder from "../assets/sidewinder.png";
import desertLion from "../assets/desert-lion.png";
import jackalfolkSkirmisher from "../assets/jackalfolk-skirmisher.png";
import duneGoblin from "../assets/dune-goblin.png";
import desertMarauder from "../assets/desert-marauder.png";
import scorchTroll from "../assets/scorch-troll.png";
import emberGiant from "../assets/ember-giant.png";
import saiga from "../assets/saiga.png";
import wildHorse from "../assets/wild-horse.png";
import steppeMarmot from "../assets/steppe-marmot.png";
import steppeRaider from "../assets/steppe-raider.png";
import steppeHorseArcher from "../assets/steppe-horse-archer.png";
import saltHusk from "../assets/salt-husk.png";
import kurganWight from "../assets/kurgan-wight.png";
import centaurKhan from "../assets/centaur-khan.png";
import lemming from "../assets/lemming.png";
import snowGoose from "../assets/snow-goose.png";
import frostbornRunecaster from "../assets/frostborn-runecaster.png";
import frostbornJarl from "../assets/frostborn-jarl.png";
import permafrostElemental from "../assets/permafrost-elemental.png";
import draugr from "../assets/draugr.png";
import mammothPatriarch from "../assets/mammoth-patriarch.png";
import emperorPenguin from "../assets/emperor-penguin.png";
import pearyCaribou from "../assets/peary-caribou.png";
import iceWorm from "../assets/ice-worm.png";
import rimeTroll from "../assets/rime-troll.png";
import auroraShade from "../assets/aurora-shade.png";
import blizzardLord from "../assets/blizzard-lord.png";
import seaOtter from "../assets/sea-otter.png";
import herringGull from "../assets/herring-gull.png";
import spinyLobster from "../assets/spiny-lobster.png";
import gillfolkScout from "../assets/gillfolk-scout.png";
import gillfolkNetter from "../assets/gillfolk-netter.png";
import coralGolem from "../assets/coral-golem.png";
import drownedDeckhand from "../assets/drowned-deckhand.png";
import reefKraken from "../assets/reef-kraken.png";
import hammerheadShark from "../assets/hammerhead-shark.png";
import mantaRay from "../assets/manta-ray.png";
import humpbackWhale from "../assets/humpback-whale.png";
import merfolkHarpooner from "../assets/merfolk-harpooner.png";
import phantomLookout from "../assets/phantom-lookout.png";
import maelstromSpirit from "../assets/maelstrom-spirit.png";
import seaSerpent from "../assets/sea-serpent.png";
import kraken from "../assets/kraken.png";
import muskellunge from "../assets/muskellunge.png";
import muteSwan from "../assets/mute-swan.png";
import drownedBride from "../assets/drowned-bride.png";
import lakeMaiden from "../assets/lake-maiden.png";
import elderMereSerpent from "../assets/elder-mere-serpent.png";
import northernPike from "../assets/northern-pike.png";
import snappingTurtle from "../assets/snapping-turtle.png";
import drownedThrall from "../assets/drowned-thrall.png";
import beaver from "../assets/beaver.png";
import riverOtter from "../assets/river-otter.png";
import riverSalmon from "../assets/river-salmon.png";
import kappa from "../assets/kappa.png";
import kappaBrawler from "../assets/kappa-brawler.png";
import bridgeTroll from "../assets/bridge-troll.png";
import nixie from "../assets/nixie.png";
import rapidsElemental from "../assets/rapids-elemental.png";
import shellback from "../assets/shellback.png";
import darter from "../assets/darter.png";
import inkPool from "../assets/ink-pool.png";
import drownedCitizen from "../assets/drowned-citizen.png";
import tideWraith from "../assets/tide-wraith.png";
import gateWarden from "../assets/gate-warden.png";
import drownedCultist from "../assets/drowned-cultist.png";
import direWolf from "../assets/dire-wolf.png";
import mossTroll from "../assets/moss-troll.png";
import woollyMammoth from "../assets/woolly-mammoth.png";
import fieldHare from "../assets/field-hare.png";
import arcticHare from "../assets/arctic-hare.png";
import capybara from "../assets/capybara.png";
import armadillo from "../assets/armadillo.png";
import redFox from "../assets/red-fox.png";
import wolverine from "../assets/wolverine.png";
import ostrich from "../assets/ostrich.png";
import goldenEagle from "../assets/golden-eagle.png";
import muskOx from "../assets/musk-ox.png";
import seal from "../assets/seal.png";
import ashDrake from "../assets/ash-drake.png";
import emberDragon from "../assets/ember-dragon.png";
import snapjawFlytrap from "../assets/snapjaw-flytrap.png";
import cairnGolem from "../assets/cairn-golem.png";
import giantLarva from "../assets/giant-larva.png";

const dungeonsMobArtwork = import.meta.glob<string>("../assets/mobs/dungeons/*.png", { eager: true, import: "default", query: "?url" });
const dungeonMobArtwork = import.meta.glob<string>("../assets/mobs/dungeon/*.png", { eager: true, import: "default", query: "?url" });

const xoralAppearance = bossAppearanceForArchetype(DEFAULT_BOSS_APPEARANCE_CATALOG, "xoral");
const xoral = xoralAppearance ? bossAppearanceAssetUrl(xoralAppearance.bodyAssetKey) : null;
if (!xoral) throw new Error("The official Xoral boss body asset is missing");

export const MOB_ARTWORK_URLS = {
  alligator,
  bear,
  coastalCrab,
  deer,
  frostDeer,
  jungleDeer,
  marshDeer,
  sandDeer,
  frostWolf,
  duneWolf,
  jungleWolf,
  bogWolf,
  woollyHog,
  warthog,
  jungleHog,
  mudHog,
  javelina,
  snowBear,
  blackBear,
  sunBear,
  iceCrab,
  sandCrab,
  mangroveCrab,
  frostFrog,
  poisonFrog,
  desertToad,
  caiman,
  crocodile,
  frostWraith,
  yeti,
  barrowWight,
  risenSkeleton,
  revenantLich,
  mossGolem,
  vineLurker,
  lizardfolkWarrior,
  bogGhoul,
  giantScorpion,
  dustMummy,
  thunderhorn,
  griffin,
  basilisk,
  bandit,
  trainingDummy,
  orcBrute,
  hollinHut,
  hollinGuard,
  hollinFarmer,
  hollinHelper,
  fireBird,
  frog,
  hog,
  iceBird,
  jellyfish,
  lightningBird,
  mysteriousTraveler,
  ogre,
  sapCrawler,
  squid,
  wolf,
  sewerRat,
  slime: dungeonMobArtwork["../assets/mobs/dungeon/slime.png"] ?? null,
  slimeMiniboss: dungeonMobArtwork["../assets/mobs/dungeon/slime_miniboss.png"] ?? null,
  sickSewerRat,
  shellbackTurtle: dungeonsMobArtwork["../assets/mobs/dungeons/shellback-turtle.png"] ?? null,
  sewerSpider: dungeonsMobArtwork["../assets/mobs/dungeons/sewer-spider.png"] ?? null,
  duneTick: dungeonsMobArtwork["../assets/mobs/dungeons/dune-tick.png"] ?? null,
  spiderling: dungeonsMobArtwork["../assets/mobs/dungeons/spiderling.png"] ?? null,
  broodMatriarch: dungeonsMobArtwork["../assets/mobs/dungeons/brood-matriarch.png"] ?? null,
  caveRaptor: dungeonsMobArtwork["../assets/mobs/dungeons/cave-raptor.png"] ?? null,
  raptorRunt: dungeonsMobArtwork["../assets/mobs/dungeons/raptor-runt.png"] ?? null,
  raptorSpitter: dungeonsMobArtwork["../assets/mobs/dungeons/raptor-spitter.png"] ?? null,
  caveBat: dungeonsMobArtwork["../assets/mobs/dungeons/cave-bat.png"] ?? null,
  raptorChieftain: dungeonsMobArtwork["../assets/mobs/dungeons/raptor-chieftain.png"] ?? null,
  nestMouse: dungeonsMobArtwork["../assets/mobs/dungeons/nest-mouse.png"] ?? null,
  carrionChick: dungeonsMobArtwork["../assets/mobs/dungeons/carrion-chick.png"] ?? null,
  cliffHawk: dungeonsMobArtwork["../assets/mobs/dungeons/cliff-hawk.png"] ?? null,
  thunderwing: dungeonsMobArtwork["../assets/mobs/dungeons/thunderwing.png"] ?? null,
  rotWolf: dungeonsMobArtwork["../assets/mobs/dungeons/rot-wolf.png"] ?? null,
  blightedStag: dungeonsMobArtwork["../assets/mobs/dungeons/blighted-stag.png"] ?? null,
  thornfern: dungeonsMobArtwork["../assets/mobs/dungeons/thornfern.png"] ?? null,
  blightTreant: dungeonsMobArtwork["../assets/mobs/dungeons/blight-treant.png"] ?? null,
  blightSprite: dungeonsMobArtwork["../assets/mobs/dungeons/blight-sprite.png"] ?? null,
  mimic: dungeonsMobArtwork["../assets/mobs/dungeons/mimic.png"] ?? null,
  hollowElder: dungeonsMobArtwork["../assets/mobs/dungeons/hollow-elder.png"] ?? null,
  drakeling: dungeonsMobArtwork["../assets/mobs/dungeons/drakeling.png"] ?? null,
  magmaSalamander: dungeonsMobArtwork["../assets/mobs/dungeons/magma-salamander.png"] ?? null,
  lavaSlime: dungeonsMobArtwork["../assets/mobs/dungeons/lava-slime.png"] ?? null,
  ashWyvern: dungeonsMobArtwork["../assets/mobs/dungeons/ash-wyvern.png"] ?? null,
  drakeBroodguard: dungeonsMobArtwork["../assets/mobs/dungeons/drake-broodguard.png"] ?? null,
  elderDragon: dungeonsMobArtwork["../assets/mobs/dungeons/elder-dragon.png"] ?? null,
  // Drowned City (art drop drowned-city-01). Boss phase states (shielded, harpoon, ...) come later.
  deepCrawler: dungeonsMobArtwork["../assets/mobs/dungeons/deep-crawler.png"] ?? null,
  voidWisp: dungeonsMobArtwork["../assets/mobs/dungeons/void-wisp.png"] ?? null,
  chronoWisp: dungeonsMobArtwork["../assets/mobs/dungeons/chrono-wisp.png"] ?? null,
  mawLily: dungeonsMobArtwork["../assets/mobs/dungeons/maw-lily.png"] ?? null,
  theWatcher: dungeonsMobArtwork["../assets/mobs/dungeons/the-watcher.png"] ?? null,
  drownedAdmiral: dungeonsMobArtwork["../assets/mobs/dungeons/drowned-admiral-cutlass.png"] ?? null,
  tidemaw: dungeonsMobArtwork["../assets/mobs/dungeons/tidemaw-surfaced.png"] ?? null,
  abyssalOne: dungeonsMobArtwork["../assets/mobs/dungeons/abyssal-one.png"] ?? null,
  abyssalOneWeakened: dungeonsMobArtwork["../assets/mobs/dungeons/abyssal-one-weakened.png"] ?? null,
  theWatcherShielded: dungeonsMobArtwork["../assets/mobs/dungeons/the-watcher-shielded.png"] ?? null,
  tidemawSubmerged: dungeonsMobArtwork["../assets/mobs/dungeons/tidemaw-submerged.png"] ?? null,
  drownedAdmiralHarpoon: dungeonsMobArtwork["../assets/mobs/dungeons/drowned-admiral-harpoon.png"] ?? null,
  drownedAdmiralAnchor: dungeonsMobArtwork["../assets/mobs/dungeons/drowned-admiral-anchor.png"] ?? null,
  tidemawTentacle: dungeonsMobArtwork["../assets/mobs/dungeons/tidemaw-tentacle.png"] ?? null,
  tidemawTentacleMarked: dungeonsMobArtwork["../assets/mobs/dungeons/tidemaw-tentacle-marked.png"] ?? null,
  // Golem Forge (art drop golem-forge-01). Awake and possessed art is bundled, but nothing selects it yet (no mob wake-state signal reaches the client); the archetypes wear the dormant sprite.
  ironGolem: dungeonsMobArtwork["../assets/mobs/dungeons/iron-golem.png"] ?? null,
  stoneGolem: dungeonsMobArtwork["../assets/mobs/dungeons/stone-golem.png"] ?? null,
  geodeGolem: dungeonsMobArtwork["../assets/mobs/dungeons/geode-golem.png"] ?? null,
  menderGolem: dungeonsMobArtwork["../assets/mobs/dungeons/mender-golem.png"] ?? null,
  sentinelStatueDormant: dungeonsMobArtwork["../assets/mobs/dungeons/sentinel-statue-dormant.png"] ?? null,
  sentinelStatueAwake: dungeonsMobArtwork["../assets/mobs/dungeons/sentinel-statue-awake.png"] ?? null,
  sparkWisp: dungeonsMobArtwork["../assets/mobs/dungeons/spark-wisp.png"] ?? null,
  slagCrawler: dungeonsMobArtwork["../assets/mobs/dungeons/slag-crawler.png"] ?? null,
  golemSmith: dungeonsMobArtwork["../assets/mobs/dungeons/golem-smith.png"] ?? null,
  walkingHammer: dungeonsMobArtwork["../assets/mobs/dungeons/walking-hammer.png"] ?? null,
  corruptedHuskDormant: dungeonsMobArtwork["../assets/mobs/dungeons/corrupted-husk-dormant.png"] ?? null,
  corruptedHuskPossessed: dungeonsMobArtwork["../assets/mobs/dungeons/corrupted-husk-possessed.png"] ?? null,
  gemHusk: dungeonsMobArtwork["../assets/mobs/dungeons/gem-husk.png"] ?? null,
  graniteBull: dungeonsMobArtwork["../assets/mobs/dungeons/granite-bull.png"] ?? null,
  corruptedCore: dungeonsMobArtwork["../assets/mobs/dungeons/corrupted-core.png"] ?? null,
  forgemaster: dungeonsMobArtwork["../assets/mobs/dungeons/forgemaster.png"] ?? null,
  initiateMonk: dungeonsMobArtwork["../assets/mobs/dungeons/initiate-monk.png"] ?? null,
  staffAdept: dungeonsMobArtwork["../assets/mobs/dungeons/staff-adept.png"] ?? null,
  shadowAcrobat: dungeonsMobArtwork["../assets/mobs/dungeons/shadow-acrobat.png"] ?? null,
  ironStatue: dungeonsMobArtwork["../assets/mobs/dungeons/iron-statue.png"] ?? null,
  bellSpirit: dungeonsMobArtwork["../assets/mobs/dungeons/bell-spirit.png"] ?? null,
  emberShade: dungeonsMobArtwork["../assets/mobs/dungeons/ember-shade.png"] ?? null,
  ashboundRevenant: dungeonsMobArtwork["../assets/mobs/dungeons/ashbound-revenant.png"] ?? null,
  vaultWarden: dungeonsMobArtwork["../assets/mobs/dungeons/vault-warden.png"] ?? null,
  grandmaster: dungeonsMobArtwork["../assets/mobs/dungeons/grandmaster.png"] ?? null,
  // Shadow clones reuse the Grandmaster PNG, drawn smaller and tinted dark.
  grandmasterClone: dungeonsMobArtwork["../assets/mobs/dungeons/grandmaster.png"] ?? null,
  // Fallen Prison (art drop fallen-prison-mobs-01).
  skyScout: dungeonsMobArtwork["../assets/mobs/dungeons/sky-scout.png"] ?? null,
  cloudSentry: dungeonsMobArtwork["../assets/mobs/dungeons/cloud-sentry.png"] ?? null,
  cloudArbiter: dungeonsMobArtwork["../assets/mobs/dungeons/cloud-arbiter.png"] ?? null,
  wardenScout: dungeonsMobArtwork["../assets/mobs/dungeons/warden-scout.png"] ?? null,
  zealot: dungeonsMobArtwork["../assets/mobs/dungeons/zealot.png"] ?? null,
  serpentJailer: dungeonsMobArtwork["../assets/mobs/dungeons/serpent-jailer.png"] ?? null,
  cagedValkyrie: dungeonsMobArtwork["../assets/mobs/dungeons/caged-valkyrie.png"] ?? null,
  coilHatchling: dungeonsMobArtwork["../assets/mobs/dungeons/coil-hatchling.png"] ?? null,
  legionSoldier: dungeonsMobArtwork["../assets/mobs/dungeons/legion-soldier.png"] ?? null,
  centurion: dungeonsMobArtwork["../assets/mobs/dungeons/centurion.png"] ?? null,
  broodMatron: dungeonsMobArtwork["../assets/mobs/dungeons/brood-matron.png"] ?? null,
  trifangWarden: dungeonsMobArtwork["../assets/mobs/dungeons/trifang-warden.png"] ?? null,
  sewerRatMiniboss,
  skeleton,
  goblinBasic,
  goblinWarrior,
  goblinArcher,
  goblinHealer,
  xoral,
  jungleTapir,
  jaguar,
  mandrill,
  canopyGoblin,
  poisonfrogRaider,
  pantherfolkStalker,
  vineWrappedCorpse,
  serpentPriestess,
  capercaillie,
  bugbearChieftain,
  pinewarden,
  gallowsGhost,
  alderKing,
  elk,
  redSquirrel,
  pineDryad,
  badger,
  greySquirrel,
  stagBeetle,
  mossjawSneak,
  mossjawSpearman,
  mossjawHexer,
  mossjawWarboss,
  hedgeWitch,
  restlessGravedigger,
  covenMatron,
  greatGreyOwl,
  flyingSquirrel,
  stagfolkWarden,
  rimeWitch,
  draugrBerserker,
  snowTalonbear,
  frostwaterTroll,
  undericeLurker,
  plainsBison,
  prairieDog,
  burrowingOwl,
  centaurOutrider,
  voltElemental,
  possessedScythe,
  strawmanLord,
  giraffe,
  lioness,
  spottedHyena,
  gnollBonebow,
  gnollPackseer,
  gnollPacklord,
  carrionGhoul,
  sunGriffin,
  sitatunga,
  emperorDragonfly,
  frogfolkTadpole,
  frogfolkBlowgunner,
  frogfolkShaman,
  frogfolkChief,
  bloatLeech,
  bogHag,
  leechMother,
  mountainIbex,
  wildYak,
  alpineMarmot,
  yakfolkStonehorn,
  highlandReaver,
  stormHarpy,
  cairnWight,
  stormwingChick,
  stormwing,
  wildScrubGoat,
  crestedPorcupine,
  spurThighedTortoise,
  cyclopsShepherd,
  skeletonHoplite,
  tarElemental,
  oliveDryad,
  chimera,
  dromedary,
  fennecFox,
  sidewinder,
  desertLion,
  jackalfolkSkirmisher,
  duneGoblin,
  desertMarauder,
  scorchTroll,
  emberGiant,
  saiga,
  wildHorse,
  steppeMarmot,
  steppeRaider,
  steppeHorseArcher,
  saltHusk,
  kurganWight,
  centaurKhan,
  lemming,
  snowGoose,
  frostbornRunecaster,
  frostbornJarl,
  permafrostElemental,
  draugr,
  mammothPatriarch,
  emperorPenguin,
  pearyCaribou,
  iceWorm,
  rimeTroll,
  auroraShade,
  blizzardLord,
  seaOtter,
  herringGull,
  spinyLobster,
  gillfolkScout,
  gillfolkNetter,
  coralGolem,
  drownedDeckhand,
  reefKraken,
  hammerheadShark,
  mantaRay,
  humpbackWhale,
  merfolkHarpooner,
  phantomLookout,
  maelstromSpirit,
  seaSerpent,
  kraken,
  muskellunge,
  muteSwan,
  drownedBride,
  lakeMaiden,
  elderMereSerpent,
  northernPike,
  snappingTurtle,
  drownedThrall,
  beaver,
  riverOtter,
  riverSalmon,
  kappa,
  kappaBrawler,
  bridgeTroll,
  nixie,
  rapidsElemental,
  shellback,
  darter,
  inkPool,
  drownedCitizen,
  tideWraith,
  gateWarden,
  drownedCultist,
  direWolf,
  mossTroll,
  woollyMammoth,
  fieldHare,
  arcticHare,
  capybara,
  armadillo,
  redFox,
  wolverine,
  ostrich,
  goldenEagle,
  muskOx,
  seal,
  ashDrake,
  emberDragon,
  snapjawFlytrap,
  cairnGolem,
  giantLarva
} as const;

export type MobArtworkKey = keyof typeof MOB_ARTWORK_URLS;

/**
 * The one place an archetype picks its world PNG. `null` means the archetype
 * has no PNG yet: it renders as a silhouette or generic marker until art lands
 * (list it in the art backlog). A missing entry is a compile error.
 */
export const MOB_ARCHETYPE_ARTWORK = {
  training_dummy: "trainingDummy",
  deer: "deer",
  frost_deer: "frostDeer",
  jungle_deer: "jungleDeer",
  marsh_deer: "marshDeer",
  sand_deer: "sandDeer",
  coastal_crab: "coastalCrab",
  ice_crab: "iceCrab",
  sand_crab: "sandCrab",
  mangrove_crab: "mangroveCrab",
  wolf: "wolf",
  frost_wolf: "frostWolf",
  dune_wolf: "duneWolf",
  jungle_wolf: "jungleWolf",
  bog_wolf: "bogWolf",
  goblin: "goblinBasic",
  bandit: "bandit",
  orc_brute: "orcBrute",
  ogre: "ogre",
  bear: "bear",
  snow_bear: "snowBear",
  black_bear: "blackBear",
  sun_bear: "sunBear",
  sap_crawler: "sapCrawler",
  hog: "hog",
  woolly_hog: "woollyHog",
  warthog: "warthog",
  jungle_hog: "jungleHog",
  mud_hog: "mudHog",
  javelina: "javelina",
  skeleton: "skeleton",
  frog: "frog",
  frost_frog: "frostFrog",
  poison_frog: "poisonFrog",
  desert_toad: "desertToad",
  alligator: "alligator",
  caiman: "caiman",
  crocodile: "crocodile",
  squid: "squid",
  jellyfish: "jellyfish",
  mysterious_traveler: "mysteriousTraveler",
  fire_bird: "fireBird",
  lightning_bird: "lightningBird",
  ice_bird: "iceBird",
  xoral: "xoral",
  sewer_rat: "sewerRat",
  sick_sewer_rat: "sickSewerRat",
  sewer_rat_miniboss: "sewerRatMiniboss",
  slime: "slime",
  slime_miniboss: "slimeMiniboss",
  // dungeon mobs (assets/mobs/dungeons).
  shellback_turtle: "shellbackTurtle",
  sewer_spider: "sewerSpider",
  dune_tick: "duneTick",
  spiderling: "spiderling",
  brood_matriarch: "broodMatriarch",
  cave_raptor: "caveRaptor",
  raptor_runt: "raptorRunt",
  raptor_spitter: "raptorSpitter",
  cave_bat: "caveBat",
  raptor_chieftain: "raptorChieftain",
  nest_mouse: "nestMouse",
  carrion_chick: "carrionChick",
  cliff_hawk: "cliffHawk",
  thunderwing: "thunderwing",
  rot_wolf: "rotWolf",
  blighted_stag: "blightedStag",
  thornfern: "thornfern",
  blight_treant: "blightTreant",
  blight_sprite: "blightSprite",
  hollow_elder: "hollowElder",
  // Drowned City: dungeon variants wear their base's art.
  tide_wraith_dc: "tideWraith",
  darter_dc: "darter",
  ink_pool_dc: "inkPool",
  drowned_cultist_dc: "drownedCultist",
  shellback_dc: "shellback",
  coral_golem_dc: "coralGolem",
  drowned_deckhand_dc: "drownedDeckhand",
  phantom_lookout_dc: "phantomLookout",
  merfolk_harpooner_dc: "merfolkHarpooner",
  gate_warden_dc: "gateWarden",
  deep_crawler: "deepCrawler",
  void_wisp: "voidWisp",
  chrono_wisp: "chronoWisp",
  maw_lily: "mawLily",
  the_watcher: "theWatcher",
  drowned_admiral: "drownedAdmiral",
  tidemaw: "tidemaw",
  abyssal_one: "abyssalOne",
  tidemaw_tentacle: "tidemawTentacle",
  tidemaw_tentacle_marked: "tidemawTentacleMarked",
  // Spec: the ritual cultists wear the Drowned Cultist art.
  abyssal_cultist: "drownedCultist",
  // Golem Forge.
  iron_golem_gf: "ironGolem",
  stone_golem_gf: "stoneGolem",
  geode_golem_gf: "geodeGolem",
  mender_golem_gf: "menderGolem",
  sentinel_statue_gf: "sentinelStatueDormant",
  spark_wisp_gf: "sparkWisp",
  slag_crawler_gf: "slagCrawler",
  golem_smith_gf: "golemSmith",
  corrupted_husk_gf: "corruptedHuskDormant",
  gem_husk_gf: "gemHusk",
  walking_hammer_gf: "walkingHammer",
  healer_monolith_gf: null,
  granite_bull: "graniteBull",
  corrupted_core: "corruptedCore",
  forgemaster: "forgemaster",
  hollin_hut: "hollinHut",
  hollin_guard: "hollinGuard",
  // No dedicated art yet: the elites reuse the guard sprite.
  hollin_brute: "hollinGuard",
  hollin_elder: "hollinGuard",
  hollin_farmer: "hollinFarmer",
  hollin_helper: "hollinHelper",
  // World fantasy mobs.
  frost_wraith: "frostWraith",
  yeti: "yeti",
  barrow_wight: "barrowWight",
  risen_skeleton: "risenSkeleton",
  revenant_lich: "revenantLich",
  moss_golem: "mossGolem",
  vine_lurker: "vineLurker",
  lizardfolk_warrior: "lizardfolkWarrior",
  bog_ghoul: "bogGhoul",
  giant_scorpion: "giantScorpion",
  dust_mummy: "dustMummy",
  thunderhorn: "thunderhorn",
  griffin: "griffin",
  basilisk: "basilisk",
  // Fallen Prison (art drop fallen-prison-mobs-01).
  sky_scout: "skyScout",
  cloud_sentry: "cloudSentry",
  cloud_arbiter: "cloudArbiter",
  warden_scout: "wardenScout",
  zealot: "zealot",
  serpent_jailer: "serpentJailer",
  caged_valkyrie: "cagedValkyrie",
  coil_hatchling: "coilHatchling",
  legion_soldier: "legionSoldier",
  mimic: "mimic",
  centurion: "centurion",
  brood_matron: "broodMatron",
  trifang_warden: "trifangWarden",
  jungle_tapir: "jungleTapir",
  jaguar: "jaguar",
  mandrill: "mandrill",
  canopy_goblin: "canopyGoblin",
  poisonfrog_raider: "poisonfrogRaider",
  pantherfolk_stalker: "pantherfolkStalker",
  vine_wrapped_corpse: "vineWrappedCorpse",
  serpent_priestess: "serpentPriestess",
  capercaillie: "capercaillie",
  bugbear_chieftain: "bugbearChieftain",
  pinewarden: "pinewarden",
  gallows_ghost: "gallowsGhost",
  alder_king: "alderKing",
  elk: "elk",
  red_squirrel: "redSquirrel",
  pine_dryad: "pineDryad",
  badger: "badger",
  grey_squirrel: "greySquirrel",
  stag_beetle: "stagBeetle",
  mossjaw_sneak: "mossjawSneak",
  mossjaw_spearman: "mossjawSpearman",
  mossjaw_hexer: "mossjawHexer",
  mossjaw_warboss: "mossjawWarboss",
  hedge_witch: "hedgeWitch",
  restless_gravedigger: "restlessGravedigger",
  coven_matron: "covenMatron",
  great_grey_owl: "greatGreyOwl",
  flying_squirrel: "flyingSquirrel",
  stagfolk_warden: "stagfolkWarden",
  rime_witch: "rimeWitch",
  draugr_berserker: "draugrBerserker",
  snow_talonbear: "snowTalonbear",
  frostwater_troll: "frostwaterTroll",
  underice_lurker: "undericeLurker",
  plains_bison: "plainsBison",
  prairie_dog: "prairieDog",
  burrowing_owl: "burrowingOwl",
  centaur_outrider: "centaurOutrider",
  volt_elemental: "voltElemental",
  possessed_scythe: "possessedScythe",
  strawman_lord: "strawmanLord",
  giraffe: "giraffe",
  lioness: "lioness",
  spotted_hyena: "spottedHyena",
  gnoll_bonebow: "gnollBonebow",
  gnoll_packseer: "gnollPackseer",
  gnoll_packlord: "gnollPacklord",
  carrion_ghoul: "carrionGhoul",
  sun_griffin: "sunGriffin",
  sitatunga: "sitatunga",
  emperor_dragonfly: "emperorDragonfly",
  frogfolk_tadpole: "frogfolkTadpole",
  frogfolk_blowgunner: "frogfolkBlowgunner",
  frogfolk_shaman: "frogfolkShaman",
  frogfolk_chief: "frogfolkChief",
  bloat_leech: "bloatLeech",
  bog_hag: "bogHag",
  leech_mother: "leechMother",
  mountain_ibex: "mountainIbex",
  wild_yak: "wildYak",
  alpine_marmot: "alpineMarmot",
  yakfolk_stonehorn: "yakfolkStonehorn",
  highland_reaver: "highlandReaver",
  storm_harpy: "stormHarpy",
  cairn_wight: "cairnWight",
  stormwing_chick: "stormwingChick",
  stormwing: "stormwing",
  wild_scrub_goat: "wildScrubGoat",
  crested_porcupine: "crestedPorcupine",
  spur_thighed_tortoise: "spurThighedTortoise",
  cyclops_shepherd: "cyclopsShepherd",
  skeleton_hoplite: "skeletonHoplite",
  tar_elemental: "tarElemental",
  olive_dryad: "oliveDryad",
  chimera: "chimera",
  dromedary: "dromedary",
  fennec_fox: "fennecFox",
  sidewinder: "sidewinder",
  desert_lion: "desertLion",
  jackalfolk_skirmisher: "jackalfolkSkirmisher",
  dune_goblin: "duneGoblin",
  desert_marauder: "desertMarauder",
  scorch_troll: "scorchTroll",
  ember_giant: "emberGiant",
  saiga: "saiga",
  wild_horse: "wildHorse",
  steppe_marmot: "steppeMarmot",
  steppe_raider: "steppeRaider",
  steppe_horse_archer: "steppeHorseArcher",
  salt_husk: "saltHusk",
  kurgan_wight: "kurganWight",
  centaur_khan: "centaurKhan",
  lemming: "lemming",
  snow_goose: "snowGoose",
  frostborn_runecaster: "frostbornRunecaster",
  frostborn_jarl: "frostbornJarl",
  permafrost_elemental: "permafrostElemental",
  draugr: "draugr",
  mammoth_patriarch: "mammothPatriarch",
  emperor_penguin: "emperorPenguin",
  peary_caribou: "pearyCaribou",
  ice_worm: "iceWorm",
  rime_troll: "rimeTroll",
  aurora_shade: "auroraShade",
  blizzard_lord: "blizzardLord",
  sea_otter: "seaOtter",
  herring_gull: "herringGull",
  spiny_lobster: "spinyLobster",
  gillfolk_scout: "gillfolkScout",
  gillfolk_netter: "gillfolkNetter",
  coral_golem: "coralGolem",
  drowned_deckhand: "drownedDeckhand",
  reef_kraken: "reefKraken",
  hammerhead_shark: "hammerheadShark",
  manta_ray: "mantaRay",
  humpback_whale: "humpbackWhale",
  merfolk_harpooner: "merfolkHarpooner",
  phantom_lookout: "phantomLookout",
  maelstrom_spirit: "maelstromSpirit",
  sea_serpent: "seaSerpent",
  kraken: "kraken",
  muskellunge: "muskellunge",
  mute_swan: "muteSwan",
  drowned_bride: "drownedBride",
  lake_maiden: "lakeMaiden",
  elder_mere_serpent: "elderMereSerpent",
  northern_pike: "northernPike",
  snapping_turtle: "snappingTurtle",
  drowned_thrall: "drownedThrall",
  beaver: "beaver",
  river_otter: "riverOtter",
  river_salmon: "riverSalmon",
  kappa: "kappa",
  kappa_brawler: "kappaBrawler",
  bridge_troll: "bridgeTroll",
  nixie: "nixie",
  rapids_elemental: "rapidsElemental",
  // Wyrm Hollow.
  drakeling: "drakeling",
  magma_salamander: "magmaSalamander",
  lava_slime: "lavaSlime",
  ash_wyvern: "ashWyvern",
  drake_broodguard: "drakeBroodguard",
  elder_dragon: "elderDragon",
  shellback: "shellback",
  darter: "darter",
  ink_pool: "inkPool",
  drowned_citizen: "drownedCitizen",
  tide_wraith: "tideWraith",
  gate_warden: "gateWarden",
  drowned_cultist: "drownedCultist",
  dire_wolf: "direWolf",
  moss_troll: "mossTroll",
  woolly_mammoth: "woollyMammoth",
  field_hare: "fieldHare",
  arctic_hare: "arcticHare",
  capybara: "capybara",
  armadillo: "armadillo",
  red_fox: "redFox",
  wolverine: "wolverine",
  ostrich: "ostrich",
  golden_eagle: "goldenEagle",
  musk_ox: "muskOx",
  seal: "seal",
  ash_drake: "ashDrake",
  ember_dragon: "emberDragon",
  snapjaw_flytrap: "snapjawFlytrap",
  cairn_golem: "cairnGolem",
  giant_larva: "giantLarva",
  initiate_monk: "initiateMonk",
  staff_adept: "staffAdept",
  shadow_acrobat: "shadowAcrobat",
  iron_statue: "ironStatue",
  bell_spirit: "bellSpirit",
  ember_shade: "emberShade",
  ashbound_revenant: "ashboundRevenant",
  vault_warden: "vaultWarden",
  grandmaster: "grandmaster",
  grandmaster_clone: "grandmasterClone"
} as const satisfies Readonly<Record<MobArchetypeKey, MobArtworkKey | null>>;

/** Goblin presentation variants override the archetype's own artwork. */
const PRESENTATION_ARTWORK: ReadonlyMap<string, MobArtworkKey> = new Map([
  ["goblin", "goblinBasic"],
  ["goblin_warrior", "goblinWarrior"],
  ["goblin_archer", "goblinArcher"],
  ["goblin_healer", "goblinHealer"]
]);

export function mobArtworkKey(
  archetypeKey: CombatEntitySnapshot["archetypeKey"] | null,
  presentationKey?: string | null
): MobArtworkKey | null {
  const presentation = presentationKey ? PRESENTATION_ARTWORK.get(presentationKey) : undefined;
  if (presentation) return presentation;
  const key: MobArtworkKey | null = archetypeKey ? MOB_ARCHETYPE_ARTWORK[archetypeKey] ?? null : null;
  // Optional (globbed) PNGs resolve to null until the file exists.
  return key && MOB_ARTWORK_URLS[key] ? key : null;
}

export function mobArtworkSource(
  archetypeKey: CombatEntitySnapshot["archetypeKey"]
): string | null {
  const key = mobArtworkKey(archetypeKey);
  return key ? MOB_ARTWORK_URLS[key] : null;
}

/**
 * Boss phase art: (archetype, boss phase id) to a sprite, falling back to the base art. Phase ids
 * come from the boss encounter projection (the Admiral's weapon phases, Tidemaw submerged, the
 * Abyssal One weakened, and the phased kit's `<phase>_shielded` while the Watcher's wave lives).
 */
const BOSS_PHASE_ARTWORK: Readonly<Partial<Record<string, readonly (readonly [RegExp, MobArtworkKey])[]>>> = {
  the_watcher: [[/_shielded$/u, "theWatcherShielded"]],
  tidemaw: [[/^submerged$/u, "tidemawSubmerged"]],
  drowned_admiral: [[/^harpoon$/u, "drownedAdmiralHarpoon"], [/^anchor$/u, "drownedAdmiralAnchor"]],
  abyssal_one: [[/^weakened$/u, "abyssalOneWeakened"]]
};

/** Dormant art that wakes: the server flags a live "awake" mob buff and the dormant sprite swaps for its awake one. */
const AWAKE_ARTWORK: Readonly<Partial<Record<MobArtworkKey, MobArtworkKey>>> = {
  sentinelStatueDormant: "sentinelStatueAwake",
  corruptedHuskDormant: "corruptedHuskPossessed"
};

export function awakeArtworkKey(
  key: MobArtworkKey | null,
  mobBuffs: CombatEntitySnapshot["mobBuffs"],
  nowMs: number
): MobArtworkKey | null {
  const awake = key ? AWAKE_ARTWORK[key] : undefined;
  if (!key || !awake || !mobBuffs?.some((buff) => buff.kind === "awake" && buff.endsAt > nowMs)) return key;
  return MOB_ARTWORK_URLS[awake] ? awake : key;
}

export function bossPhaseArtworkKey(
  archetypeKey: CombatEntitySnapshot["archetypeKey"] | null,
  phaseId: string | null | undefined
): MobArtworkKey | null {
  if (!archetypeKey || !phaseId) return null;
  const key = BOSS_PHASE_ARTWORK[archetypeKey]?.find(([pattern]) => pattern.test(phaseId))?.[1] ?? null;
  return key && MOB_ARTWORK_URLS[key] ? key : null;
}
