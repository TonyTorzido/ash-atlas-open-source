import type { RuntimeAssetUsage } from "./bridgeTypes.js";
import { mobArtworkSlotForPath } from "./mobArtworkSlots.js";
import { runtimePngAssetRegistration } from "@ash-atlas/shared";

type EditableTarget =
  | { kind: "sprite"; key: string }
  | { kind: "fixed"; key: string }
  | { kind: "world-object"; key: string };

export type RuntimeAssetMetadata = {
  label?: string;
  category?: string;
  usages?: RuntimeAssetUsage[];
};

const CLIENT_ASSET_ROOT = "apps/client/src/assets/";
const PLAYER_ASSET_ROOT = "packages/player-renderer/src/assets/player-appearance/";
const BOSS_ASSET_ROOT = "packages/player-renderer/src/assets/boss-appearance/";

const editableByClientAsset: Readonly<Record<string, readonly [string, EditableTarget][]>> = {
  "city-marker.png": [
    ["World Map City", { kind: "fixed", key: "worldMapCity" }]
  ],
  "kingdom-seat-marker.png": [
    ["World Map Kingdom", { kind: "fixed", key: "worldMapKingdom" }]
  ],
  "deer.png": [["World Mob", { kind: "sprite", key: "deer" }]],
  "frost-deer.png": [["World Mob", { kind: "sprite", key: "frostDeer" }]],
  "jungle-deer.png": [["World Mob", { kind: "sprite", key: "jungleDeer" }]],
  "marsh-deer.png": [["World Mob", { kind: "sprite", key: "marshDeer" }]],
  "sand-deer.png": [["World Mob", { kind: "sprite", key: "sandDeer" }]],
  "wolf.png": [["World Mob", { kind: "sprite", key: "wolf" }]],
  "frost-wolf.png": [["World Mob", { kind: "sprite", key: "frostWolf" }]],
  "dune-wolf.png": [["World Mob", { kind: "sprite", key: "duneWolf" }]],
  "jungle-wolf.png": [["World Mob", { kind: "sprite", key: "jungleWolf" }]],
  "bog-wolf.png": [["World Mob", { kind: "sprite", key: "bogWolf" }]],
  "frost-wraith.png": [["World Mob", { kind: "sprite", key: "frostWraith" }]],
  "yeti.png": [["World Mob", { kind: "sprite", key: "yeti" }]],
  "barrow-wight.png": [["World Mob", { kind: "sprite", key: "barrowWight" }]],
  "risen-skeleton.png": [["World Mob", { kind: "sprite", key: "risenSkeleton" }]],
  "revenant-lich.png": [["World Mob", { kind: "sprite", key: "revenantLich" }]],
  "moss-golem.png": [["World Mob", { kind: "sprite", key: "mossGolem" }]],
  "vine-lurker.png": [["World Mob", { kind: "sprite", key: "vineLurker" }]],
  "lizardfolk-warrior.png": [["World Mob", { kind: "sprite", key: "lizardfolkWarrior" }]],
  "bog-ghoul.png": [["World Mob", { kind: "sprite", key: "bogGhoul" }]],
  "giant-scorpion.png": [["World Mob", { kind: "sprite", key: "giantScorpion" }]],
  "dust-mummy.png": [["World Mob", { kind: "sprite", key: "dustMummy" }]],
  "thunderhorn.png": [["World Mob", { kind: "sprite", key: "thunderhorn" }]],
  "griffin.png": [["World Mob", { kind: "sprite", key: "griffin" }]],
  "basilisk.png": [["World Mob", { kind: "sprite", key: "basilisk" }]],
  "bandit.png": [["World Mob", { kind: "sprite", key: "bandit" }]],
  "jungle-tapir.png": [["World Mob", { kind: "sprite", key: "jungleTapir" }]],
  "jaguar.png": [["World Mob", { kind: "sprite", key: "jaguar" }]],
  "mandrill.png": [["World Mob", { kind: "sprite", key: "mandrill" }]],
  "canopy-goblin.png": [["World Mob", { kind: "sprite", key: "canopyGoblin" }]],
  "poisonfrog-raider.png": [["World Mob", { kind: "sprite", key: "poisonfrogRaider" }]],
  "pantherfolk-stalker.png": [["World Mob", { kind: "sprite", key: "pantherfolkStalker" }]],
  "vine-wrapped-corpse.png": [["World Mob", { kind: "sprite", key: "vineWrappedCorpse" }]],
  "serpent-priestess.png": [["World Mob", { kind: "sprite", key: "serpentPriestess" }]],
  "capercaillie.png": [["World Mob", { kind: "sprite", key: "capercaillie" }]],
  "bugbear-chieftain.png": [["World Mob", { kind: "sprite", key: "bugbearChieftain" }]],
  "pinewarden.png": [["World Mob", { kind: "sprite", key: "pinewarden" }]],
  "gallows-ghost.png": [["World Mob", { kind: "sprite", key: "gallowsGhost" }]],
  "alder-king.png": [["World Mob", { kind: "sprite", key: "alderKing" }]],
  "elk.png": [["World Mob", { kind: "sprite", key: "elk" }]],
  "red-squirrel.png": [["World Mob", { kind: "sprite", key: "redSquirrel" }]],
  "pine-dryad.png": [["World Mob", { kind: "sprite", key: "pineDryad" }]],
  "badger.png": [["World Mob", { kind: "sprite", key: "badger" }]],
  "grey-squirrel.png": [["World Mob", { kind: "sprite", key: "greySquirrel" }]],
  "stag-beetle.png": [["World Mob", { kind: "sprite", key: "stagBeetle" }]],
  "mossjaw-sneak.png": [["World Mob", { kind: "sprite", key: "mossjawSneak" }]],
  "mossjaw-spearman.png": [["World Mob", { kind: "sprite", key: "mossjawSpearman" }]],
  "mossjaw-hexer.png": [["World Mob", { kind: "sprite", key: "mossjawHexer" }]],
  "mossjaw-warboss.png": [["World Mob", { kind: "sprite", key: "mossjawWarboss" }]],
  "hedge-witch.png": [["World Mob", { kind: "sprite", key: "hedgeWitch" }]],
  "restless-gravedigger.png": [["World Mob", { kind: "sprite", key: "restlessGravedigger" }]],
  "coven-matron.png": [["World Mob", { kind: "sprite", key: "covenMatron" }]],
  "great-grey-owl.png": [["World Mob", { kind: "sprite", key: "greatGreyOwl" }]],
  "flying-squirrel.png": [["World Mob", { kind: "sprite", key: "flyingSquirrel" }]],
  "stagfolk-warden.png": [["World Mob", { kind: "sprite", key: "stagfolkWarden" }]],
  "rime-witch.png": [["World Mob", { kind: "sprite", key: "rimeWitch" }]],
  "draugr-berserker.png": [["World Mob", { kind: "sprite", key: "draugrBerserker" }]],
  "snow-talonbear.png": [["World Mob", { kind: "sprite", key: "snowTalonbear" }]],
  "frostwater-troll.png": [["World Mob", { kind: "sprite", key: "frostwaterTroll" }]],
  "underice-lurker.png": [["World Mob", { kind: "sprite", key: "undericeLurker" }]],
  "plains-bison.png": [["World Mob", { kind: "sprite", key: "plainsBison" }]],
  "prairie-dog.png": [["World Mob", { kind: "sprite", key: "prairieDog" }]],
  "burrowing-owl.png": [["World Mob", { kind: "sprite", key: "burrowingOwl" }]],
  "centaur-outrider.png": [["World Mob", { kind: "sprite", key: "centaurOutrider" }]],
  "volt-elemental.png": [["World Mob", { kind: "sprite", key: "voltElemental" }]],
  "possessed-scythe.png": [["World Mob", { kind: "sprite", key: "possessedScythe" }]],
  "strawman-lord.png": [["World Mob", { kind: "sprite", key: "strawmanLord" }]],
  "giraffe.png": [["World Mob", { kind: "sprite", key: "giraffe" }]],
  "lioness.png": [["World Mob", { kind: "sprite", key: "lioness" }]],
  "spotted-hyena.png": [["World Mob", { kind: "sprite", key: "spottedHyena" }]],
  "gnoll-bonebow.png": [["World Mob", { kind: "sprite", key: "gnollBonebow" }]],
  "gnoll-packseer.png": [["World Mob", { kind: "sprite", key: "gnollPackseer" }]],
  "gnoll-packlord.png": [["World Mob", { kind: "sprite", key: "gnollPacklord" }]],
  "carrion-ghoul.png": [["World Mob", { kind: "sprite", key: "carrionGhoul" }]],
  "sun-griffin.png": [["World Mob", { kind: "sprite", key: "sunGriffin" }]],
  "sitatunga.png": [["World Mob", { kind: "sprite", key: "sitatunga" }]],
  "emperor-dragonfly.png": [["World Mob", { kind: "sprite", key: "emperorDragonfly" }]],
  "frogfolk-tadpole.png": [["World Mob", { kind: "sprite", key: "frogfolkTadpole" }]],
  "frogfolk-blowgunner.png": [["World Mob", { kind: "sprite", key: "frogfolkBlowgunner" }]],
  "frogfolk-shaman.png": [["World Mob", { kind: "sprite", key: "frogfolkShaman" }]],
  "frogfolk-chief.png": [["World Mob", { kind: "sprite", key: "frogfolkChief" }]],
  "bloat-leech.png": [["World Mob", { kind: "sprite", key: "bloatLeech" }]],
  "bog-hag.png": [["World Mob", { kind: "sprite", key: "bogHag" }]],
  "leech-mother.png": [["World Mob", { kind: "sprite", key: "leechMother" }]],
  "mountain-ibex.png": [["World Mob", { kind: "sprite", key: "mountainIbex" }]],
  "wild-yak.png": [["World Mob", { kind: "sprite", key: "wildYak" }]],
  "alpine-marmot.png": [["World Mob", { kind: "sprite", key: "alpineMarmot" }]],
  "yakfolk-stonehorn.png": [["World Mob", { kind: "sprite", key: "yakfolkStonehorn" }]],
  "highland-reaver.png": [["World Mob", { kind: "sprite", key: "highlandReaver" }]],
  "storm-harpy.png": [["World Mob", { kind: "sprite", key: "stormHarpy" }]],
  "cairn-wight.png": [["World Mob", { kind: "sprite", key: "cairnWight" }]],
  "stormwing-chick.png": [["World Mob", { kind: "sprite", key: "stormwingChick" }]],
  "stormwing.png": [["World Mob", { kind: "sprite", key: "stormwing" }]],
  "wild-scrub-goat.png": [["World Mob", { kind: "sprite", key: "wildScrubGoat" }]],
  "crested-porcupine.png": [["World Mob", { kind: "sprite", key: "crestedPorcupine" }]],
  "spur-thighed-tortoise.png": [["World Mob", { kind: "sprite", key: "spurThighedTortoise" }]],
  "cyclops-shepherd.png": [["World Mob", { kind: "sprite", key: "cyclopsShepherd" }]],
  "skeleton-hoplite.png": [["World Mob", { kind: "sprite", key: "skeletonHoplite" }]],
  "tar-elemental.png": [["World Mob", { kind: "sprite", key: "tarElemental" }]],
  "olive-dryad.png": [["World Mob", { kind: "sprite", key: "oliveDryad" }]],
  "chimera.png": [["World Mob", { kind: "sprite", key: "chimera" }]],
  "dromedary.png": [["World Mob", { kind: "sprite", key: "dromedary" }]],
  "fennec-fox.png": [["World Mob", { kind: "sprite", key: "fennecFox" }]],
  "sidewinder.png": [["World Mob", { kind: "sprite", key: "sidewinder" }]],
  "desert-lion.png": [["World Mob", { kind: "sprite", key: "desertLion" }]],
  "jackalfolk-skirmisher.png": [["World Mob", { kind: "sprite", key: "jackalfolkSkirmisher" }]],
  "dune-goblin.png": [["World Mob", { kind: "sprite", key: "duneGoblin" }]],
  "desert-marauder.png": [["World Mob", { kind: "sprite", key: "desertMarauder" }]],
  "scorch-troll.png": [["World Mob", { kind: "sprite", key: "scorchTroll" }]],
  "ember-giant.png": [["World Mob", { kind: "sprite", key: "emberGiant" }]],
  "saiga.png": [["World Mob", { kind: "sprite", key: "saiga" }]],
  "wild-horse.png": [["World Mob", { kind: "sprite", key: "wildHorse" }]],
  "steppe-marmot.png": [["World Mob", { kind: "sprite", key: "steppeMarmot" }]],
  "steppe-raider.png": [["World Mob", { kind: "sprite", key: "steppeRaider" }]],
  "steppe-horse-archer.png": [["World Mob", { kind: "sprite", key: "steppeHorseArcher" }]],
  "salt-husk.png": [["World Mob", { kind: "sprite", key: "saltHusk" }]],
  "kurgan-wight.png": [["World Mob", { kind: "sprite", key: "kurganWight" }]],
  "centaur-khan.png": [["World Mob", { kind: "sprite", key: "centaurKhan" }]],
  "lemming.png": [["World Mob", { kind: "sprite", key: "lemming" }]],
  "snow-goose.png": [["World Mob", { kind: "sprite", key: "snowGoose" }]],
  "frostborn-runecaster.png": [["World Mob", { kind: "sprite", key: "frostbornRunecaster" }]],
  "frostborn-jarl.png": [["World Mob", { kind: "sprite", key: "frostbornJarl" }]],
  "permafrost-elemental.png": [["World Mob", { kind: "sprite", key: "permafrostElemental" }]],
  "draugr.png": [["World Mob", { kind: "sprite", key: "draugr" }]],
  "mammoth-patriarch.png": [["World Mob", { kind: "sprite", key: "mammothPatriarch" }]],
  "emperor-penguin.png": [["World Mob", { kind: "sprite", key: "emperorPenguin" }]],
  "peary-caribou.png": [["World Mob", { kind: "sprite", key: "pearyCaribou" }]],
  "ice-worm.png": [["World Mob", { kind: "sprite", key: "iceWorm" }]],
  "rime-troll.png": [["World Mob", { kind: "sprite", key: "rimeTroll" }]],
  "aurora-shade.png": [["World Mob", { kind: "sprite", key: "auroraShade" }]],
  "blizzard-lord.png": [["World Mob", { kind: "sprite", key: "blizzardLord" }]],
  "sea-otter.png": [["World Mob", { kind: "sprite", key: "seaOtter" }]],
  "herring-gull.png": [["World Mob", { kind: "sprite", key: "herringGull" }]],
  "spiny-lobster.png": [["World Mob", { kind: "sprite", key: "spinyLobster" }]],
  "gillfolk-scout.png": [["World Mob", { kind: "sprite", key: "gillfolkScout" }]],
  "gillfolk-netter.png": [["World Mob", { kind: "sprite", key: "gillfolkNetter" }]],
  "coral-golem.png": [["World Mob", { kind: "sprite", key: "coralGolem" }]],
  "drowned-deckhand.png": [["World Mob", { kind: "sprite", key: "drownedDeckhand" }]],
  "reef-kraken.png": [["World Mob", { kind: "sprite", key: "reefKraken" }]],
  "hammerhead-shark.png": [["World Mob", { kind: "sprite", key: "hammerheadShark" }]],
  "manta-ray.png": [["World Mob", { kind: "sprite", key: "mantaRay" }]],
  "humpback-whale.png": [["World Mob", { kind: "sprite", key: "humpbackWhale" }]],
  "merfolk-harpooner.png": [["World Mob", { kind: "sprite", key: "merfolkHarpooner" }]],
  "phantom-lookout.png": [["World Mob", { kind: "sprite", key: "phantomLookout" }]],
  "maelstrom-spirit.png": [["World Mob", { kind: "sprite", key: "maelstromSpirit" }]],
  "sea-serpent.png": [["World Mob", { kind: "sprite", key: "seaSerpent" }]],
  "kraken.png": [["World Mob", { kind: "sprite", key: "kraken" }]],
  "muskellunge.png": [["World Mob", { kind: "sprite", key: "muskellunge" }]],
  "mute-swan.png": [["World Mob", { kind: "sprite", key: "muteSwan" }]],
  "drowned-bride.png": [["World Mob", { kind: "sprite", key: "drownedBride" }]],
  "lake-maiden.png": [["World Mob", { kind: "sprite", key: "lakeMaiden" }]],
  "elder-mere-serpent.png": [["World Mob", { kind: "sprite", key: "elderMereSerpent" }]],
  "northern-pike.png": [["World Mob", { kind: "sprite", key: "northernPike" }]],
  "snapping-turtle.png": [["World Mob", { kind: "sprite", key: "snappingTurtle" }]],
  "drowned-thrall.png": [["World Mob", { kind: "sprite", key: "drownedThrall" }]],
  "beaver.png": [["World Mob", { kind: "sprite", key: "beaver" }]],
  "river-otter.png": [["World Mob", { kind: "sprite", key: "riverOtter" }]],
  "river-salmon.png": [["World Mob", { kind: "sprite", key: "riverSalmon" }]],
  "kappa.png": [["World Mob", { kind: "sprite", key: "kappa" }]],
  "kappa-brawler.png": [["World Mob", { kind: "sprite", key: "kappaBrawler" }]],
  "bridge-troll.png": [["World Mob", { kind: "sprite", key: "bridgeTroll" }]],
  "nixie.png": [["World Mob", { kind: "sprite", key: "nixie" }]],
  "rapids-elemental.png": [["World Mob", { kind: "sprite", key: "rapidsElemental" }]],
  "shellback.png": [["World Mob", { kind: "sprite", key: "shellback" }]],
  "darter.png": [["World Mob", { kind: "sprite", key: "darter" }]],
  "ink-pool.png": [["World Mob", { kind: "sprite", key: "inkPool" }]],
  "drowned-citizen.png": [["World Mob", { kind: "sprite", key: "drownedCitizen" }]],
  "tide-wraith.png": [["World Mob", { kind: "sprite", key: "tideWraith" }]],
  "gate-warden.png": [["World Mob", { kind: "sprite", key: "gateWarden" }]],
  "drowned-cultist.png": [["World Mob", { kind: "sprite", key: "drownedCultist" }]],
  "dire-wolf.png": [["World Mob", { kind: "sprite", key: "direWolf" }]],
  "moss-troll.png": [["World Mob", { kind: "sprite", key: "mossTroll" }]],
  "woolly-mammoth.png": [["World Mob", { kind: "sprite", key: "woollyMammoth" }]],
  "field-hare.png": [["World Mob", { kind: "sprite", key: "fieldHare" }]],
  "arctic-hare.png": [["World Mob", { kind: "sprite", key: "arcticHare" }]],
  "capybara.png": [["World Mob", { kind: "sprite", key: "capybara" }]],
  "armadillo.png": [["World Mob", { kind: "sprite", key: "armadillo" }]],
  "red-fox.png": [["World Mob", { kind: "sprite", key: "redFox" }]],
  "wolverine.png": [["World Mob", { kind: "sprite", key: "wolverine" }]],
  "ostrich.png": [["World Mob", { kind: "sprite", key: "ostrich" }]],
  "golden-eagle.png": [["World Mob", { kind: "sprite", key: "goldenEagle" }]],
  "musk-ox.png": [["World Mob", { kind: "sprite", key: "muskOx" }]],
  "seal.png": [["World Mob", { kind: "sprite", key: "seal" }]],
  "ash-drake.png": [["World Mob", { kind: "sprite", key: "ashDrake" }]],
  "ember-dragon.png": [["World Mob", { kind: "sprite", key: "emberDragon" }]],
  "snapjaw-flytrap.png": [["World Mob", { kind: "sprite", key: "snapjawFlytrap" }]],
  "cairn-golem.png": [["World Mob", { kind: "sprite", key: "cairnGolem" }]],
  "giant-larva.png": [["World Mob", { kind: "sprite", key: "giantLarva" }]],
  "training-dummy.png": [["World Mob", { kind: "sprite", key: "trainingDummy" }]],
  "orc-brute.png": [["World Mob", { kind: "sprite", key: "orcBrute" }]],
  "hollin-hut.png": [["World Mob", { kind: "sprite", key: "hollinHut" }]],
  "hollin-guard.png": [["World Mob", { kind: "sprite", key: "hollinGuard" }]],
  "hollin-farmer.png": [["World Mob", { kind: "sprite", key: "hollinFarmer" }]],
  "hollin-helper.png": [["World Mob", { kind: "sprite", key: "hollinHelper" }]],
  "dogs/DogBaby1.png": [["World Dog", { kind: "sprite", key: "dog" }]],
  "dogs/DogAdult1.png": [["World Dog", { kind: "sprite", key: "dog" }]],
  "dogs/DogOld1.png": [["World Dog", { kind: "sprite", key: "dog" }]],
  "ogre.png": [["World Mob", { kind: "sprite", key: "ogre" }]],
  "resin-crawler.png": [["World Mob", { kind: "sprite", key: "sapCrawler" }]],
  "hog.png": [["World Mob", { kind: "sprite", key: "hog" }]],
  "woolly-hog.png": [["World Mob", { kind: "sprite", key: "woollyHog" }]],
  "warthog.png": [["World Mob", { kind: "sprite", key: "warthog" }]],
  "jungle-hog.png": [["World Mob", { kind: "sprite", key: "jungleHog" }]],
  "mud-hog.png": [["World Mob", { kind: "sprite", key: "mudHog" }]],
  "javelina.png": [["World Mob", { kind: "sprite", key: "javelina" }]],
  "bear.png": [["World Mob", { kind: "sprite", key: "bear" }]],
  "snow-bear.png": [["World Mob", { kind: "sprite", key: "snowBear" }]],
  "black-bear.png": [["World Mob", { kind: "sprite", key: "blackBear" }]],
  "sun-bear.png": [["World Mob", { kind: "sprite", key: "sunBear" }]],
  "mysterious-traveler.png": [["World Mob", { kind: "sprite", key: "mysteriousTraveler" }]],
  "frog.png": [["World Mob", { kind: "sprite", key: "frog" }]],
  "frost-frog.png": [["World Mob", { kind: "sprite", key: "frostFrog" }]],
  "poison-frog.png": [["World Mob", { kind: "sprite", key: "poisonFrog" }]],
  "desert-toad.png": [["World Mob", { kind: "sprite", key: "desertToad" }]],
  "alligator.png": [["World Mob", { kind: "sprite", key: "alligator" }]],
  "caiman.png": [["World Mob", { kind: "sprite", key: "caiman" }]],
  "crocodile.png": [["World Mob", { kind: "sprite", key: "crocodile" }]],
  "squid.png": [["World Mob", { kind: "sprite", key: "squid" }]],
  "jellyfish.png": [["World Mob", { kind: "sprite", key: "jellyfish" }]],
  "fire-bird.png": [["World Mob", { kind: "sprite", key: "fireBird" }]],
  "lightning-bird.png": [["World Mob", { kind: "sprite", key: "lightningBird" }]],
  "ice-bird.png": [["World Mob", { kind: "sprite", key: "iceBird" }]],
  "tree.png": [["World Resource", { kind: "sprite", key: "tree" }]],
  "ResinTree1.png": [["World Resource", { kind: "sprite", key: "tree" }]],
  "willow-tree.png": [["World Resource", { kind: "sprite", key: "willowTree" }]],
  "chinese-pistache.png": [["World Resource", { kind: "sprite", key: "chinesePistache" }]],
  "stone-mine.png": [["World Resource", { kind: "sprite", key: "stoneMine" }]],
  "coal-mine.png": [["World Resource", { kind: "sprite", key: "coalMine" }]],
  "iron-mine.png": [["World Resource", { kind: "sprite", key: "ironMine" }]],
  "structures/atlas-shrine.png": [
    ["World Map Atlas Shrine", { kind: "fixed", key: "worldMapAtlasShrine" }]
  ],
  "manor-marker.png": [
    ["World Map Manor", { kind: "fixed", key: "worldMapManor" }]
  ],
  "structures/manor.png": [["Manor", { kind: "world-object", key: "manor" }]],
  "structures/city-hall.png": [["City Hall", { kind: "sprite", key: "city" }]],
  "structures/kingdom-seat.png": [["Kingdom Seat", { kind: "sprite", key: "kingdomSeat" }]],
  "structures/furnace.png": [["World Furnace", { kind: "world-object", key: "furnace" }]],
  "structures/tannery.png": [["Tannery", { kind: "world-object", key: "tannery" }]],
  "structures/OilWell1.png": [["World City Facility", { kind: "world-object", key: "cityStructures.oil_well" }]],
  "structures/city-house.png": [["City House", { kind: "world-object", key: "cityStructures.city_house" }]],
  "structures/city-monument-mining.png": [["Mining Monument", { kind: "world-object", key: "cityStructures.monument_mining" }]],
  "structures/city-monument-forestry.png": [["Forestry Monument", { kind: "world-object", key: "cityStructures.monument_forestry" }]],
  "structures/city-monument-hunting.png": [["Hunting Monument", { kind: "world-object", key: "cityStructures.monument_hunting" }]],
  "structures/city-warehouse.png": [["Warehouse", { kind: "world-object", key: "cityStructures.warehouse" }]],
  "structures/cistern-warrens.png": [["Cistern Warrens", { kind: "world-object", key: "cityStructures.cistern_warrens" }]],
  "structures/city-salon.png": [["City Salon", { kind: "world-object", key: "cityStructures.salon" }]],
  "structures/city-kennel.png": [["City Kennel", { kind: "world-object", key: "cityStructures.city_kennel" }]],
  "structures/city-market.png": [["City Market", { kind: "world-object", key: "cityStructures.market" }]],
  "structures/mayor-house.png": [["World City Facility", { kind: "world-object", key: "cityStructures.mayor_house" }]],
  "flags/buoy-color.png": [["Territory Buoy Color Layer", { kind: "sprite", key: "buoy" }]],
  "flags/buoy-hardware.png": [["Territory Buoy Hardware Layer", { kind: "sprite", key: "buoy" }]],
  "items/alligator-hide.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "alligator_hide" }]],
  "items/bear-hide.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "bear_hide" }]],
  "items/coal.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "coal" }]],
  "items/coin.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "gold" }]],
  "items/CrudeOil1.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "crude_oil" }]],
  "items/deer-hide.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "deer_hide" }]],
  "items/food.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "food" }]],
  "items/generic.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "generic" }]],
  "items/hog-hide.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "hog_hide" }]],
  "items/iron-bar.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "iron_bar" }]],
  "items/iron.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "iron" }]],
  "items/enchantment-stones/amethyst.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:amethyst" }]],
  "items/enchantment-stones/diamond.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:diamond" }]],
  "items/enchantment-stones/emerald.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:emerald" }]],
  "items/enchantment-stones/onyx.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:onyx" }]],
  "items/enchantment-stones/opal.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:opal" }]],
  "items/enchantment-stones/ruby.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:ruby" }]],
  "items/enchantment-stones/sapphire.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:sapphire" }]],
  "items/enchantment-stones/topaz.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "enchantment_stone:topaz" }]],
  "items/brood-silk.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "brood_silk" }]],
  "items/raptor-scale.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "raptor_scale" }]],
  "items/giant-egg-item.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "giant_egg" }]],
  "items/brood-egg.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "brood_egg" }]],
  "items/clutch-egg.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "clutch_egg" }]],
  "items/crawler-egg.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "crawler_egg" }]],
  "items/whistle-broken.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "broken_whistle" }]],
  "items/bonewrought-blade.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "bonewrought_blade" }]],
  "items/bonewrought-mail.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "bonewrought_mail" }]],
  "items/elder-acorn.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "elder_acorn" }]],
  "items/wyrm-egg.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "wyrm_egg" }]],
  "items/dragon-scale.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "dragon_scale" }]],
  "items/zephyr.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "zephyr" }]],
  "items/refined-oil.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "refined_oil" }]],
  "items/jellyfish-venom.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "jellyfish_venom" }]],
  "items/leather.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "leather" }]],
  "items/ore.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "ore" }]],
  "items/satchel.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "pack" }]],
  "items/stone.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "stone" }]],
  "items/Resin1.png": [
    ["Item Artwork — Shared Size", { kind: "sprite", key: "balsam_resin" }],
    ["Frond Sap Gain", { kind: "fixed", key: "resinGain" }]
  ],
  "items/venomsteel-bar.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "venomsteel_bar" }]],
  "items/venomsteel-core.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "venomsteel_core" }]],
  "items/water.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "water" }]],
  "items/wolf-pelt.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "wolf_pelt" }]],
  "items/wood.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "wood" }]],
  "items/sulfur.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "sulfur" }]],
  "items/fire-feather.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "fire_feather" }]],
  "items/tempest-quill.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "tempest_quill" }]],
  "items/ice-feather.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "ice_feather" }]],
  "items/fire-bar.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "fire_bar" }]],
  "items/lightning-bar.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "lightning_bar" }]],
  "items/ice-bar.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "ice_bar" }]],
  "items/fire-core.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "fire_core" }]],
  "items/lightning-core.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "lightning_core" }]],
  "items/ice-core.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "ice_core" }]],
  "items/crystal.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "crystal" }]],
  "items/pearl.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "pearl" }]],
  "items/shellback-plate.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "shellback_plate" }]],
  "items/abyssal-orb.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "abyssal_orb" }]],
  "items/freshwater-fish.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "freshwater_fish" }]],
  "items/fishing-rod.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "fishing_rod" }]],
  "items/flax-fiber.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "flax_fiber" }]],
  "items/cloth.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "cloth" }]],
  "items/bone.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "bone" }]],
  "items/bricks.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "bricks" }]],
  "items/chitin.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "chitin" }]],
  "items/fertilizer.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "fertilizer" }]],
  "items/flux-plant.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "flux_plant" }]],
  "items/produce.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "produce" }]],
  "items/seed.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "seed" }]],
  "items/repair-kit.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "repair_kit" }]],
  "items/lumen.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "lumen" }]],
  "items/training-heavy-boots.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_heavy_boots" }]],
  "items/training-light-boots.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_light_boots" }]],
  "items/training-heavy-gloves.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_heavy_gloves" }]],
  "items/training-light-gloves.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_light_gloves" }]],
  "items/training-heavy-helm.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_heavy_helm" }]],
  "items/training-light-hood.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_light_hood" }]],
  "items/training-shield.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "training_shield" }]],
  "items/ranged-shield.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "ranged_shield" }]],
  "items/torch.png": [["Item Artwork — Shared Size", { kind: "sprite", key: "torch" }]]
};

export function runtimeAssetCategory(relativeFile: string): string {
  const registered = runtimePngAssetRegistration(relativeFile);
  if (registered) return registered.category;
  if (mobArtworkSlotForPath(relativeFile)) return "Mobs & Animals";
  if (relativeFile.startsWith(PLAYER_ASSET_ROOT)) return "Player Appearance";
  if (relativeFile.startsWith(BOSS_ASSET_ROOT)) return "Boss Appearance";
  if (relativeFile.startsWith("apps/client/public/")) return "App Icons";
  const key = relativeFile.slice(CLIENT_ASSET_ROOT.length);
  if (key.startsWith("world-environment-overlays/")) return "Environment";
  if (key.startsWith("status-effects/")) return "Effects";
  if (key.startsWith("structures/") || key.startsWith("flags/") || /(?:city|manor)-marker\.png$|kingdom-seat-marker\.png$/iu.test(key)) {
    return "Buildings";
  }
  if (key.startsWith("items/")) return "Items & Equipment";
  if (editableByClientAsset[key]?.some((entry) => entry[1].kind === "sprite")) {
    return key.includes("mine") || /tree/i.test(key) ? "Resources" : "Mobs & Animals";
  }
  return "Other Runtime PNGs";
}

export function runtimeAssetUsages(relativeFile: string): RuntimeAssetUsage[] {
  const registered = runtimePngAssetRegistration(relativeFile);
  if (registered) return registered.usages.map((usage) => ({
    id: usage.id,
    label: usage.label,
    context: usage.context,
    editor: usage.editor
  }));
  const mobSlot = mobArtworkSlotForPath(relativeFile);
  if (mobSlot) {
    if (mobSlot.slot.archetypeKey === "xoral") {
      return [{
        id: "boss-appearance",
        label: "Boss Appearance",
        context: "Xoral's existing boss presentation",
        editor: { kind: "appearance", domain: "boss" }
      }];
    }
    return [{
      id: "world-mob",
      label: "World Mob",
      context: "Production sprite presentation",
      editor: { kind: "sprite", key: mobSlot.slot.presentationKey }
    }];
  }
  if (relativeFile.startsWith(PLAYER_ASSET_ROOT)) {
    const isBody = relativeFile.includes("/bodies/");
    return [
      {
        id: "player-appearance",
        label: "Player Appearance",
        context: isBody ? "Appearance composition and world player sprite" : "Appearance composition",
        editor: { kind: "appearance", domain: "player" }
      },
      ...(isBody ? [{
        id: "world-player",
        label: "World Player Size",
        context: "Shared world-map player presentation",
        editor: { kind: "sprite" as const, key: "player" }
      }] : [])
    ];
  }
  if (relativeFile.startsWith(BOSS_ASSET_ROOT)) {
    return [{
      id: "boss-appearance",
      label: "Boss Appearance",
      context: "Boss body or pose-driven equipment",
      editor: { kind: "appearance", domain: "boss" }
    }];
  }
  if (relativeFile.startsWith("apps/client/public/")) {
    return [readonlyUsage("Installed App Icon", "Icon dimensions are selected by the browser or operating system")];
  }
  const key = relativeFile.slice(CLIENT_ASSET_ROOT.length);
  const editable = editableByClientAsset[key];
  if (editable) {
    const usages: RuntimeAssetUsage[] = editable.map(([label, editor], index) => ({
      id: `production-${index}`,
      label,
      context: key.startsWith("items/")
        ? "Permanent runtime size authored here and shared by inventory, menus, and every ground-drop scene"
        : "Production renderer",
      editor
    }));
    if (key.startsWith("dogs/")) {
      usages.unshift(readonlyUsage(
        "Pets Profile Artwork",
        "Profile dimensions are owned by the Pets UI"
      ));
    }
    return usages;
  }
  if (key.startsWith("items/")) {
    return [readonlyUsage("Inventory & Dialog Artwork", "Owning UI tiles set this display size")];
  }
  if (key.startsWith("status-effects/")) {
    return [readonlyUsage("Status Effect", "The status-effect component owns display size")];
  }
  if (key.startsWith("world-environment-overlays/")) {
    return [readonlyUsage("World Environment Overlay", "Overlay coverage follows map geometry, not sprite pixels")];
  }
  const flagLayerLabel = territoryFlagLayerLabel(key);
  if (flagLayerLabel) {
    return [readonlyUsage(flagLayerLabel, "Flags Studio owns the complete root transform and interaction area")];
  }
  return [readonlyUsage("Runtime Artwork", "The owning game component controls display size")];
}

function territoryFlagLayerLabel(key: string): string | null {
  switch (key) {
    case "flags/default-cloth.png": return "Territory Flag Default Cloth Layer";
    case "flags/default-hardware.png": return "Territory Flag Default Hardware Layer";
    case "flags/bastion-cloth.png": return "Territory Flag Bastion Cloth Layer";
    case "flags/bastion-hardware.png": return "Territory Flag Bastion Hardware Layer";
    case "flags/tower-cloth.png": return "Territory Flag Tower Cloth Layer";
    case "flags/tower-hardware.png": return "Territory Flag Tower Hardware Layer";
    default: return null;
  }
}

function readonlyUsage(label: string, reason: string): RuntimeAssetUsage {
  return {
    id: label.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
    label,
    context: reason,
    editor: { kind: "readonly", reason }
  };
}

export function friendlyRuntimeAssetName(relativeFile: string): string {
  const registered = runtimePngAssetRegistration(relativeFile);
  if (registered) return registered.label;
  const mobSlot = mobArtworkSlotForPath(relativeFile);
  if (mobSlot) return mobSlot.slot.label;
  const fileName = relativeFile.split("/").at(-1)?.replace(/\.png$/iu, "") ?? relativeFile;
  return fileName
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function runtimeAssetMetadata(
  relativeFile: string,
  metadata: Readonly<Record<string, RuntimeAssetMetadata>>
): Required<RuntimeAssetMetadata> {
  const override = metadata[relativeFile];
  return {
    label: override?.label ?? friendlyRuntimeAssetName(relativeFile),
    category: override?.category ?? runtimeAssetCategory(relativeFile),
    usages: override?.usages ?? runtimeAssetUsages(relativeFile)
  };
}
