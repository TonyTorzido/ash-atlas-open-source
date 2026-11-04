import { describe, expect, it } from "vitest";

import { MOB_DEFINITIONS } from "./combat/mobDefinitions.js";
import { ENVIRONMENT_PROFILE_VERSION } from "./gameplayEnvironmentProfileVersions.js";
import {
  legacyPopulationV2MobCandidateIdentity,
  registeredPopulationV2MobIdentity
} from "./populationV2MobIdentity.js";
import {
  POPULATION_V2_MOB_DEFINITIONS,
  POPULATION_V2_RUNTIME_MOB_ARCHETYPES,
  POPULATION_V2_RUNTIME_MOB_KINDS,
  createPopulationV2MobRegistry,
  createSinglePopulationV2MobCandidateBuilder,
  isPopulationV2RuntimeMobKind,
  populationV2MobDefinitionIsEligibleAtWorldPhase,
  populationV2MobRegistry,
  validatePopulationV2MobDefinitions,
  type PopulationV2MobDefinition,
  type PopulationV2MobPackFormation
} from "./populationV2MobRegistry.js";
import {
  populationZoneV2Halo,
  populationZoneV2IdForPoint
} from "./populationZonesV2Geometry.js";
import {
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity
} from "./populationZonesV2Identity.js";
import {
  generatePopulationZonesV2Plans,
  materializeSapCrawlerTemplateGroups,
  populationZoneV2GenerationId,
  populationZoneV3ConservativeHabitat,
  type GeneratedPopulationZoneV2Plan,
  type PopulationZoneV2PlanSlot
} from "./populationZonesV2Plan.js";

const WORLD_IDENTITY = "9".repeat(64);
const WORLD_SHA = "a".repeat(40);
const GENERATION_ID = "6f027f03-495f-8f4f-b253-3f90dd4ec618";

describe("Population V2 combat-mob registry", () => {
  it("is authoritative for legacy runtime kinds, archetypes, and metadata", () => {
    expect(POPULATION_V2_RUNTIME_MOB_KINDS).toEqual([
      "alpine_marmot",
      "arctic_hare",
      "armadillo",
      "capercaillie",
      "capybara",
      "deer",
      "dromedary",
      "emperor_penguin",
      "fennec_fox",
      "field_hare",
      "flying_squirrel",
      "frost_deer",
      "giraffe",
      "grey_squirrel",
      "jungle_deer",
      "lemming",
      "marsh_deer",
      "mountain_ibex",
      "peary_caribou",
      "plains_bison",
      "prairie_dog",
      "red_fox",
      "red_squirrel",
      "saiga",
      "sand_deer",
      "seal",
      "sitatunga",
      "snow_goose",
      "steppe_marmot",
      "wild_horse",
      "wild_scrub_goat",
      "wild_yak",
      "bog_wolf",
      "desert_lion",
      "dire_wolf",
      "dune_wolf",
      "frost_wolf",
      "griffin",
      "jungle_wolf",
      "lioness",
      "mandrill",
      "spotted_hyena",
      "storm_harpy",
      "sun_griffin",
      "wolf",
      "blizzard_lord",
      "cairn_golem",
      "centaur_khan",
      "cyclops_shepherd",
      "ember_giant",
      "mammoth_patriarch",
      "moss_golem",
      "ogre",
      "permafrost_elemental",
      "pinewarden",
      "stormwing",
      "volt_elemental",
      "bear",
      "black_bear",
      "bugbear_chieftain",
      "chimera",
      "ember_dragon",
      "giant_larva",
      "jaguar",
      "pantherfolk_stalker",
      "snow_bear",
      "snow_talonbear",
      "sun_bear",
      "thunderhorn",
      "wolverine",
      "yeti",
      "mysterious_traveler",
      "alder_king",
      "ash_drake",
      "badger",
      "bandit",
      "basilisk",
      "bog_hag",
      "burrowing_owl",
      "canopy_goblin",
      "centaur_outrider",
      "coven_matron",
      "crested_porcupine",
      "desert_marauder",
      "dune_goblin",
      "elk",
      "frogfolk_blowgunner",
      "frogfolk_chief",
      "frogfolk_shaman",
      "frostborn_jarl",
      "frostborn_runecaster",
      "giant_scorpion",
      "gillfolk_netter",
      "gnoll_bonebow",
      "gnoll_packlord",
      "gnoll_packseer",
      "golden_eagle",
      "great_grey_owl",
      "hedge_witch",
      "herring_gull",
      "highland_reaver",
      "hog",
      "jackalfolk_skirmisher",
      "javelina",
      "jungle_hog",
      "jungle_tapir",
      "moss_troll",
      "mossjaw_hexer",
      "mossjaw_spearman",
      "mossjaw_warboss",
      "mud_hog",
      "musk_ox",
      "olive_dryad",
      "orc_brute",
      "ostrich",
      "pine_dryad",
      "poisonfrog_raider",
      "rime_troll",
      "rime_witch",
      "scorch_troll",
      "serpent_priestess",
      "sidewinder",
      "snapjaw_flytrap",
      "spur_thighed_tortoise",
      "stag_beetle",
      "stagfolk_warden",
      "steppe_horse_archer",
      "steppe_raider",
      "stormwing_chick",
      "strawman_lord",
      "tar_elemental",
      "warthog",
      "woolly_hog",
      "woolly_mammoth",
      "yakfolk_stonehorn",
      "coastal_crab",
      "gillfolk_scout",
      "ice_crab",
      "mangrove_crab",
      "sand_crab",
      "aurora_shade",
      "barrow_wight",
      "bog_ghoul",
      "cairn_wight",
      "carrion_ghoul",
      "draugr",
      "draugr_berserker",
      "drowned_deckhand",
      "dust_mummy",
      "frost_wraith",
      "gallows_ghost",
      "kurgan_wight",
      "lizardfolk_warrior",
      "possessed_scythe",
      "restless_gravedigger",
      "salt_husk",
      "skeleton",
      "skeleton_hoplite",
      "vine_wrapped_corpse",
      "desert_toad",
      "drowned_bride",
      "drowned_thrall",
      "elder_mere_serpent",
      "frog",
      "frogfolk_tadpole",
      "frost_frog",
      "lake_maiden",
      "leech_mother",
      "muskellunge",
      "mute_swan",
      "northern_pike",
      "poison_frog",
      "snapping_turtle",
      "underice_lurker",
      "alligator",
      "beaver",
      "bridge_troll",
      "caiman",
      "crocodile",
      "frostwater_troll",
      "kappa",
      "kappa_brawler",
      "nixie",
      "rapids_elemental",
      "river_otter",
      "river_salmon",
      "coral_golem",
      "darter",
      "drowned_citizen",
      "drowned_cultist",
      "gate_warden",
      "hammerhead_shark",
      "humpback_whale",
      "ink_pool",
      "kraken",
      "maelstrom_spirit",
      "manta_ray",
      "merfolk_harpooner",
      "phantom_lookout",
      "reef_kraken",
      "sea_otter",
      "sea_serpent",
      "shellback",
      "spiny_lobster",
      "squid",
      "tide_wraith",
      "jellyfish",
      "hollin_hut",
      "bloat_leech",
      "emperor_dragonfly",
      "ice_worm",
      "mossjaw_sneak",
      "sap_crawler",
      "vine_lurker"
    ]);
    expect(POPULATION_V2_RUNTIME_MOB_ARCHETYPES).toEqual([
      "alpine_marmot",
      "arctic_hare",
      "armadillo",
      "capercaillie",
      "capybara",
      "deer",
      "dromedary",
      "emperor_penguin",
      "fennec_fox",
      "field_hare",
      "flying_squirrel",
      "frost_deer",
      "giraffe",
      "grey_squirrel",
      "jungle_deer",
      "lemming",
      "marsh_deer",
      "mountain_ibex",
      "peary_caribou",
      "plains_bison",
      "prairie_dog",
      "red_fox",
      "red_squirrel",
      "saiga",
      "sand_deer",
      "seal",
      "sitatunga",
      "snow_goose",
      "steppe_marmot",
      "wild_horse",
      "wild_scrub_goat",
      "wild_yak",
      "bog_wolf",
      "desert_lion",
      "dire_wolf",
      "dune_wolf",
      "frost_wolf",
      "griffin",
      "jungle_wolf",
      "lioness",
      "mandrill",
      "spotted_hyena",
      "storm_harpy",
      "sun_griffin",
      "wolf",
      "blizzard_lord",
      "cairn_golem",
      "centaur_khan",
      "cyclops_shepherd",
      "ember_giant",
      "mammoth_patriarch",
      "moss_golem",
      "ogre",
      "permafrost_elemental",
      "pinewarden",
      "stormwing",
      "volt_elemental",
      "bear",
      "black_bear",
      "bugbear_chieftain",
      "chimera",
      "ember_dragon",
      "giant_larva",
      "jaguar",
      "pantherfolk_stalker",
      "snow_bear",
      "snow_talonbear",
      "sun_bear",
      "thunderhorn",
      "wolverine",
      "yeti",
      "mysterious_traveler",
      "alder_king",
      "ash_drake",
      "badger",
      "bandit",
      "basilisk",
      "bog_hag",
      "burrowing_owl",
      "canopy_goblin",
      "centaur_outrider",
      "coven_matron",
      "crested_porcupine",
      "desert_marauder",
      "dune_goblin",
      "elk",
      "frogfolk_blowgunner",
      "frogfolk_chief",
      "frogfolk_shaman",
      "frostborn_jarl",
      "frostborn_runecaster",
      "giant_scorpion",
      "gillfolk_netter",
      "gnoll_bonebow",
      "gnoll_packlord",
      "gnoll_packseer",
      "golden_eagle",
      "great_grey_owl",
      "hedge_witch",
      "herring_gull",
      "highland_reaver",
      "hog",
      "jackalfolk_skirmisher",
      "javelina",
      "jungle_hog",
      "jungle_tapir",
      "moss_troll",
      "mossjaw_hexer",
      "mossjaw_spearman",
      "mossjaw_warboss",
      "mud_hog",
      "musk_ox",
      "olive_dryad",
      "orc_brute",
      "ostrich",
      "pine_dryad",
      "poisonfrog_raider",
      "rime_troll",
      "rime_witch",
      "scorch_troll",
      "serpent_priestess",
      "sidewinder",
      "snapjaw_flytrap",
      "spur_thighed_tortoise",
      "stag_beetle",
      "stagfolk_warden",
      "steppe_horse_archer",
      "steppe_raider",
      "stormwing_chick",
      "strawman_lord",
      "tar_elemental",
      "warthog",
      "woolly_hog",
      "woolly_mammoth",
      "yakfolk_stonehorn",
      "coastal_crab",
      "gillfolk_scout",
      "ice_crab",
      "mangrove_crab",
      "sand_crab",
      "aurora_shade",
      "barrow_wight",
      "bog_ghoul",
      "cairn_wight",
      "carrion_ghoul",
      "draugr",
      "draugr_berserker",
      "drowned_deckhand",
      "dust_mummy",
      "frost_wraith",
      "gallows_ghost",
      "kurgan_wight",
      "lizardfolk_warrior",
      "possessed_scythe",
      "restless_gravedigger",
      "salt_husk",
      "skeleton",
      "skeleton_hoplite",
      "vine_wrapped_corpse",
      "desert_toad",
      "drowned_bride",
      "drowned_thrall",
      "elder_mere_serpent",
      "frog",
      "frogfolk_tadpole",
      "frost_frog",
      "lake_maiden",
      "leech_mother",
      "muskellunge",
      "mute_swan",
      "northern_pike",
      "poison_frog",
      "snapping_turtle",
      "underice_lurker",
      "alligator",
      "beaver",
      "bridge_troll",
      "caiman",
      "crocodile",
      "frostwater_troll",
      "kappa",
      "kappa_brawler",
      "nixie",
      "rapids_elemental",
      "river_otter",
      "river_salmon",
      "coral_golem",
      "darter",
      "drowned_citizen",
      "drowned_cultist",
      "gate_warden",
      "hammerhead_shark",
      "humpback_whale",
      "ink_pool",
      "kraken",
      "maelstrom_spirit",
      "manta_ray",
      "merfolk_harpooner",
      "phantom_lookout",
      "reef_kraken",
      "sea_otter",
      "sea_serpent",
      "shellback",
      "spiny_lobster",
      "squid",
      "tide_wraith",
      "jellyfish",
      "hollin_hut",
      "bloat_leech",
      "emperor_dragonfly",
      "ice_worm",
      "mossjaw_sneak",
      "sap_crawler",
      "vine_lurker"
    ]);
    expect(POPULATION_V2_MOB_DEFINITIONS.filter((definition) => definition.mobKind !== "hollin_hut").map((definition) => ({
      mobKind: definition.mobKind,
      combatArchetype: definition.combatArchetype,
      placementRevision: definition.placementRevision,
      generationPlacement: definition.generationPlacement,
      spawnModel: definition.spawnModel,
      encounterSurface: (definition as { encounterSurface?: string }).encounterSurface,
      mechanicalPhaseEligibility: definition.mechanicalPhaseEligibility
    }))).toEqual([
      ["deer", "deer", "encounter-v1-deer-formation-v2", "pack", "land"],
      ["frost_deer", "frost_deer", "encounter-v1-frost-deer-formation-v1", "pack", "land"],
      ["jungle_deer", "jungle_deer", "encounter-v1-jungle-deer-formation-v1", "pack", "land"],
      ["marsh_deer", "marsh_deer", "encounter-v1-marsh-deer-formation-v1", "pack", "land"],
      ["sand_deer", "sand_deer", "encounter-v1-sand-deer-formation-v1", "pack", "land"],
      ["wolf", "wolf", "encounter-v1-wolf-formation-v2", "pack", "land"],
      ["frost_wolf", "frost_wolf", "encounter-v1-frost-wolf-formation-v1", "pack", "land"],
      ["dune_wolf", "dune_wolf", "encounter-v1-dune-wolf-formation-v1", "pack", "land"],
      ["jungle_wolf", "jungle_wolf", "encounter-v1-jungle-wolf-formation-v1", "pack", "land"],
      ["bog_wolf", "bog_wolf", "encounter-v1-bog-wolf-formation-v1", "pack", "land"],
      ["ogre", "ogre", "encounter-v1-ogre-single-v1", "single", "land"],
      ["bear", "bear", "encounter-v1-bear-single-v1", "single", "land"],
      ["snow_bear", "snow_bear", "encounter-v1-snow-bear-single-v1", "single", "land"],
      ["black_bear", "black_bear", "encounter-v1-black-bear-single-v1", "single", "land"],
      ["sun_bear", "sun_bear", "encounter-v1-sun-bear-single-v1", "single", "land"],
      [
        "mysterious_traveler",
        "mysterious_traveler",
        "encounter-v1-mysterious-traveler-single-v1",
        "single",
        "land"
      ],
      ["sap_crawler", "sap_crawler", "encounter-v1-sap-crawler-formation-v2", "pack", "land"],
      ["hog", "hog", "encounter-v1-hog-single-v1", "single", "land"],
      ["woolly_hog", "woolly_hog", "encounter-v1-woolly-hog-single-v1", "single", "land"],
      ["warthog", "warthog", "encounter-v1-warthog-single-v1", "single", "land"],
      ["jungle_hog", "jungle_hog", "encounter-v1-jungle-hog-single-v1", "single", "land"],
      ["mud_hog", "mud_hog", "encounter-v1-mud-hog-single-v1", "single", "land"],
      ["javelina", "javelina", "encounter-v1-javelina-single-v1", "single", "land"],
      ["skeleton", "skeleton", "encounter-v1-skeleton-single-v1", "single", "land"],
      ["coastal_crab", "coastal_crab", "encounter-v1-coastal-crab-single-v1", "single", "land"],
      ["ice_crab", "ice_crab", "encounter-v1-ice-crab-single-v1", "single", "land"],
      ["sand_crab", "sand_crab", "encounter-v1-sand-crab-single-v1", "single", "land"],
      ["mangrove_crab", "mangrove_crab", "encounter-v1-mangrove-crab-single-v1", "single", "land"],
      ["frog", "frog", "encounter-v1-frog-lake-single-v1", "single", "lake"],
      ["frost_frog", "frost_frog", "encounter-v1-frost-frog-lake-single-v1", "single", "lake"],
      ["poison_frog", "poison_frog", "encounter-v1-poison-frog-lake-single-v1", "single", "lake"],
      ["desert_toad", "desert_toad", "encounter-v1-desert-toad-lake-single-v1", "single", "lake"],
      ["alligator", "alligator", "encounter-v1-alligator-river-single-v1", "single", "river"],
      ["caiman", "caiman", "encounter-v1-caiman-river-single-v1", "single", "river"],
      ["crocodile", "crocodile", "encounter-v1-crocodile-river-single-v1", "single", "river"],
      ["squid", "squid", "encounter-v1-squid-ocean-single-v1", "single", "ocean"],
      ["jellyfish", "jellyfish", "encounter-v1-jellyfish-ocean-single-v1", "single", "ocean"],
      ["frost_wraith", "frost_wraith", "encounter-v1-frost-wraith-single-v1", "single", "land"],
      ["yeti", "yeti", "encounter-v1-yeti-single-v1", "single", "land"],
      ["barrow_wight", "barrow_wight", "encounter-v1-barrow-wight-single-v1", "single", "land"],
      ["moss_golem", "moss_golem", "encounter-v1-moss-golem-single-v1", "single", "land"],
      ["vine_lurker", "vine_lurker", "encounter-v1-vine-lurker-formation-v1", "pack", "land"],
      ["lizardfolk_warrior", "lizardfolk_warrior", "encounter-v1-lizardfolk-warrior-single-v1", "single", "land"],
      ["bog_ghoul", "bog_ghoul", "encounter-v1-bog-ghoul-single-v1", "single", "land"],
      ["giant_scorpion", "giant_scorpion", "encounter-v1-giant-scorpion-single-v1", "single", "land"],
      ["dust_mummy", "dust_mummy", "encounter-v1-dust-mummy-single-v1", "single", "land"],
      ["thunderhorn", "thunderhorn", "encounter-v1-thunderhorn-single-v1", "single", "land"],
      ["griffin", "griffin", "encounter-v1-griffin-formation-v1", "pack", "land"],
      ["basilisk", "basilisk", "encounter-v1-basilisk-single-v1", "single", "land"],
      ["bandit", "bandit", "encounter-v1-bandit-single-v1", "single", "land"],
      ["orc_brute", "orc_brute", "encounter-v1-orc-brute-single-v1", "single", "land"],
      // Wave 1 mobs
      ["jungle_tapir", "jungle_tapir", "encounter-v1-jungle-tapir-single-v1", "single", "land"],
      ["jaguar", "jaguar", "encounter-v1-jaguar-single-v1", "single", "land"],
      ["mandrill", "mandrill", "encounter-v1-mandrill-formation-v1", "pack", "land"],
      ["canopy_goblin", "canopy_goblin", "encounter-v1-canopy-goblin-single-v1", "single", "land"],
      ["poisonfrog_raider", "poisonfrog_raider", "encounter-v1-poisonfrog-raider-single-v1", "single", "land"],
      ["pantherfolk_stalker", "pantherfolk_stalker", "encounter-v1-pantherfolk-stalker-single-v1", "single", "land"],
      ["vine_wrapped_corpse", "vine_wrapped_corpse", "encounter-v1-vine-wrapped-corpse-single-v1", "single", "land"],
      ["serpent_priestess", "serpent_priestess", "encounter-v1-serpent-priestess-single-v1", "single", "land"],
      ["capercaillie", "capercaillie", "encounter-v1-capercaillie-formation-v1", "pack", "land"],
      ["bugbear_chieftain", "bugbear_chieftain", "encounter-v1-bugbear-chieftain-single-v1", "single", "land"],
      ["pinewarden", "pinewarden", "encounter-v1-pinewarden-single-v1", "single", "land"],
      ["gallows_ghost", "gallows_ghost", "encounter-v1-gallows-ghost-single-v1", "single", "land"],
      ["alder_king", "alder_king", "encounter-v1-alder-king-single-v1", "single", "land"],
      ["elk", "elk", "encounter-v1-elk-single-v1", "single", "land"],
      ["red_squirrel", "red_squirrel", "encounter-v1-red-squirrel-formation-v1", "pack", "land"],
      ["pine_dryad", "pine_dryad", "encounter-v1-pine-dryad-single-v1", "single", "land"],
      ["badger", "badger", "encounter-v1-badger-single-v1", "single", "land"],
      ["grey_squirrel", "grey_squirrel", "encounter-v1-grey-squirrel-formation-v1", "pack", "land"],
      ["stag_beetle", "stag_beetle", "encounter-v1-stag-beetle-single-v1", "single", "land"],
      ["mossjaw_sneak", "mossjaw_sneak", "encounter-v1-mossjaw-sneak-formation-v1", "pack", "land"],
      ["mossjaw_spearman", "mossjaw_spearman", "encounter-v1-mossjaw-spearman-single-v1", "single", "land"],
      ["mossjaw_hexer", "mossjaw_hexer", "encounter-v1-mossjaw-hexer-single-v1", "single", "land"],
      ["mossjaw_warboss", "mossjaw_warboss", "encounter-v1-mossjaw-warboss-single-v1", "single", "land"],
      ["hedge_witch", "hedge_witch", "encounter-v1-hedge-witch-single-v1", "single", "land"],
      ["restless_gravedigger", "restless_gravedigger", "encounter-v1-restless-gravedigger-single-v1", "single", "land"],
      ["coven_matron", "coven_matron", "encounter-v1-coven-matron-single-v1", "single", "land"],
      ["great_grey_owl", "great_grey_owl", "encounter-v1-great-grey-owl-single-v1", "single", "land"],
      ["flying_squirrel", "flying_squirrel", "encounter-v1-flying-squirrel-formation-v1", "pack", "land"],
      ["stagfolk_warden", "stagfolk_warden", "encounter-v1-stagfolk-warden-single-v1", "single", "land"],
      ["rime_witch", "rime_witch", "encounter-v1-rime-witch-single-v1", "single", "land"],
      ["draugr_berserker", "draugr_berserker", "encounter-v1-draugr-berserker-single-v1", "single", "land"],
      ["snow_talonbear", "snow_talonbear", "encounter-v1-snow-talonbear-single-v1", "single", "land"],
      ["frostwater_troll", "frostwater_troll", "encounter-v1-frostwater-troll-river-single-v1", "single", "river"],
      ["underice_lurker", "underice_lurker", "encounter-v1-underice-lurker-lake-single-v1", "single", "lake"],
      ["plains_bison", "plains_bison", "encounter-v1-plains-bison-formation-v1", "pack", "land"],
      ["prairie_dog", "prairie_dog", "encounter-v1-prairie-dog-formation-v1", "pack", "land"],
      ["burrowing_owl", "burrowing_owl", "encounter-v1-burrowing-owl-single-v1", "single", "land"],
      ["centaur_outrider", "centaur_outrider", "encounter-v1-centaur-outrider-single-v1", "single", "land"],
      ["volt_elemental", "volt_elemental", "encounter-v1-volt-elemental-single-v1", "single", "land"],
      ["possessed_scythe", "possessed_scythe", "encounter-v1-possessed-scythe-single-v1", "single", "land"],
      ["strawman_lord", "strawman_lord", "encounter-v1-strawman-lord-single-v1", "single", "land"],
      ["giraffe", "giraffe", "encounter-v1-giraffe-formation-v1", "pack", "land"],
      ["lioness", "lioness", "encounter-v1-lioness-formation-v1", "pack", "land"],
      ["spotted_hyena", "spotted_hyena", "encounter-v1-spotted-hyena-formation-v1", "pack", "land"],
      ["gnoll_bonebow", "gnoll_bonebow", "encounter-v1-gnoll-bonebow-single-v1", "single", "land"],
      ["gnoll_packseer", "gnoll_packseer", "encounter-v1-gnoll-packseer-single-v1", "single", "land"],
      ["gnoll_packlord", "gnoll_packlord", "encounter-v1-gnoll-packlord-single-v1", "single", "land"],
      ["carrion_ghoul", "carrion_ghoul", "encounter-v1-carrion-ghoul-single-v1", "single", "land"],
      ["sun_griffin", "sun_griffin", "encounter-v1-sun-griffin-formation-v1", "pack", "land"],
      ["sitatunga", "sitatunga", "encounter-v1-sitatunga-formation-v1", "pack", "land"],
      ["emperor_dragonfly", "emperor_dragonfly", "encounter-v1-emperor-dragonfly-formation-v1", "pack", "land"],
      ["frogfolk_tadpole", "frogfolk_tadpole", "encounter-v1-frogfolk-tadpole-lake-single-v1", "single", "lake"],
      ["frogfolk_blowgunner", "frogfolk_blowgunner", "encounter-v1-frogfolk-blowgunner-single-v1", "single", "land"],
      ["frogfolk_shaman", "frogfolk_shaman", "encounter-v1-frogfolk-shaman-single-v1", "single", "land"],
      ["frogfolk_chief", "frogfolk_chief", "encounter-v1-frogfolk-chief-single-v1", "single", "land"],
      ["bloat_leech", "bloat_leech", "encounter-v1-bloat-leech-formation-v1", "pack", "land"],
      ["bog_hag", "bog_hag", "encounter-v1-bog-hag-single-v1", "single", "land"],
      ["leech_mother", "leech_mother", "encounter-v1-leech-mother-lake-single-v1", "single", "lake"],
      ["mountain_ibex", "mountain_ibex", "encounter-v1-mountain-ibex-formation-v1", "pack", "land"],
      ["wild_yak", "wild_yak", "encounter-v1-wild-yak-formation-v1", "pack", "land"],
      ["alpine_marmot", "alpine_marmot", "encounter-v1-alpine-marmot-formation-v1", "pack", "land"],
      ["yakfolk_stonehorn", "yakfolk_stonehorn", "encounter-v1-yakfolk-stonehorn-single-v1", "single", "land"],
      ["highland_reaver", "highland_reaver", "encounter-v1-highland-reaver-single-v1", "single", "land"],
      ["storm_harpy", "storm_harpy", "encounter-v1-storm-harpy-formation-v1", "pack", "land"],
      ["cairn_wight", "cairn_wight", "encounter-v1-cairn-wight-single-v1", "single", "land"],
      ["stormwing_chick", "stormwing_chick", "encounter-v1-stormwing-chick-single-v1", "single", "land"],
      ["stormwing", "stormwing", "encounter-v1-stormwing-single-v1", "single", "land"],
      ["wild_scrub_goat", "wild_scrub_goat", "encounter-v1-wild-scrub-goat-formation-v1", "pack", "land"],
      ["crested_porcupine", "crested_porcupine", "encounter-v1-crested-porcupine-single-v1", "single", "land"],
      ["spur_thighed_tortoise", "spur_thighed_tortoise", "encounter-v1-spur-thighed-tortoise-single-v1", "single", "land"],
      ["cyclops_shepherd", "cyclops_shepherd", "encounter-v1-cyclops-shepherd-single-v1", "single", "land"],
      ["skeleton_hoplite", "skeleton_hoplite", "encounter-v1-skeleton-hoplite-single-v1", "single", "land"],
      ["tar_elemental", "tar_elemental", "encounter-v1-tar-elemental-single-v1", "single", "land"],
      ["olive_dryad", "olive_dryad", "encounter-v1-olive-dryad-single-v1", "single", "land"],
      ["chimera", "chimera", "encounter-v1-chimera-single-v1", "single", "land"],
      ["dromedary", "dromedary", "encounter-v1-dromedary-formation-v1", "pack", "land"],
      ["fennec_fox", "fennec_fox", "encounter-v1-fennec-fox-formation-v1", "pack", "land"],
      ["sidewinder", "sidewinder", "encounter-v1-sidewinder-single-v1", "single", "land"],
      ["desert_lion", "desert_lion", "encounter-v1-desert-lion-formation-v1", "pack", "land"],
      ["jackalfolk_skirmisher", "jackalfolk_skirmisher", "encounter-v1-jackalfolk-skirmisher-single-v1", "single", "land"],
      ["dune_goblin", "dune_goblin", "encounter-v1-dune-goblin-single-v1", "single", "land"],
      ["desert_marauder", "desert_marauder", "encounter-v1-desert-marauder-single-v1", "single", "land"],
      ["scorch_troll", "scorch_troll", "encounter-v1-scorch-troll-single-v1", "single", "land"],
      ["ember_giant", "ember_giant", "encounter-v1-ember-giant-single-v1", "single", "land"],
      ["saiga", "saiga", "encounter-v1-saiga-formation-v1", "pack", "land"],
      ["wild_horse", "wild_horse", "encounter-v1-wild-horse-formation-v1", "pack", "land"],
      ["steppe_marmot", "steppe_marmot", "encounter-v1-steppe-marmot-formation-v1", "pack", "land"],
      ["steppe_raider", "steppe_raider", "encounter-v1-steppe-raider-single-v1", "single", "land"],
      ["steppe_horse_archer", "steppe_horse_archer", "encounter-v1-steppe-horse-archer-single-v1", "single", "land"],
      ["salt_husk", "salt_husk", "encounter-v1-salt-husk-single-v1", "single", "land"],
      ["kurgan_wight", "kurgan_wight", "encounter-v1-kurgan-wight-single-v1", "single", "land"],
      ["centaur_khan", "centaur_khan", "encounter-v1-centaur-khan-single-v1", "single", "land"],
      ["lemming", "lemming", "encounter-v1-lemming-formation-v1", "pack", "land"],
      ["snow_goose", "snow_goose", "encounter-v1-snow-goose-formation-v1", "pack", "land"],
      ["frostborn_runecaster", "frostborn_runecaster", "encounter-v1-frostborn-runecaster-single-v1", "single", "land"],
      ["frostborn_jarl", "frostborn_jarl", "encounter-v1-frostborn-jarl-single-v1", "single", "land"],
      ["permafrost_elemental", "permafrost_elemental", "encounter-v1-permafrost-elemental-single-v1", "single", "land"],
      ["draugr", "draugr", "encounter-v1-draugr-single-v1", "single", "land"],
      ["mammoth_patriarch", "mammoth_patriarch", "encounter-v1-mammoth-patriarch-single-v1", "single", "land"],
      ["emperor_penguin", "emperor_penguin", "encounter-v1-emperor-penguin-formation-v1", "pack", "land"],
      ["peary_caribou", "peary_caribou", "encounter-v1-peary-caribou-formation-v1", "pack", "land"],
      ["ice_worm", "ice_worm", "encounter-v1-ice-worm-formation-v1", "pack", "land"],
      ["rime_troll", "rime_troll", "encounter-v1-rime-troll-single-v1", "single", "land"],
      ["aurora_shade", "aurora_shade", "encounter-v1-aurora-shade-single-v1", "single", "land"],
      ["blizzard_lord", "blizzard_lord", "encounter-v1-blizzard-lord-single-v1", "single", "land"],
      ["sea_otter", "sea_otter", "encounter-v1-sea-otter-ocean-single-v1", "single", "ocean"],
      ["herring_gull", "herring_gull", "encounter-v1-herring-gull-single-v1", "single", "land"],
      ["spiny_lobster", "spiny_lobster", "encounter-v1-spiny-lobster-ocean-single-v1", "single", "ocean"],
      ["gillfolk_scout", "gillfolk_scout", "encounter-v1-gillfolk-scout-single-v1", "single", "land"],
      ["gillfolk_netter", "gillfolk_netter", "encounter-v1-gillfolk-netter-single-v1", "single", "land"],
      ["coral_golem", "coral_golem", "encounter-v1-coral-golem-ocean-single-v1", "single", "ocean"],
      ["drowned_deckhand", "drowned_deckhand", "encounter-v1-drowned-deckhand-single-v1", "single", "land"],
      ["reef_kraken", "reef_kraken", "encounter-v1-reef-kraken-ocean-single-v1", "single", "ocean"],
      ["hammerhead_shark", "hammerhead_shark", "encounter-v1-hammerhead-shark-ocean-single-v1", "single", "ocean"],
      ["manta_ray", "manta_ray", "encounter-v1-manta-ray-ocean-single-v1", "single", "ocean"],
      ["humpback_whale", "humpback_whale", "encounter-v1-humpback-whale-ocean-single-v1", "single", "ocean"],
      ["merfolk_harpooner", "merfolk_harpooner", "encounter-v1-merfolk-harpooner-ocean-single-v1", "single", "ocean"],
      ["phantom_lookout", "phantom_lookout", "encounter-v1-phantom-lookout-ocean-single-v1", "single", "ocean"],
      ["maelstrom_spirit", "maelstrom_spirit", "encounter-v1-maelstrom-spirit-ocean-single-v1", "single", "ocean"],
      ["sea_serpent", "sea_serpent", "encounter-v1-sea-serpent-ocean-single-v1", "single", "ocean"],
      ["kraken", "kraken", "encounter-v1-kraken-ocean-single-v1", "single", "ocean"],
      ["muskellunge", "muskellunge", "encounter-v1-muskellunge-lake-single-v1", "single", "lake"],
      ["mute_swan", "mute_swan", "encounter-v1-mute-swan-lake-single-v1", "single", "lake"],
      ["drowned_bride", "drowned_bride", "encounter-v1-drowned-bride-lake-single-v1", "single", "lake"],
      ["lake_maiden", "lake_maiden", "encounter-v1-lake-maiden-lake-single-v1", "single", "lake"],
      ["elder_mere_serpent", "elder_mere_serpent", "encounter-v1-elder-mere-serpent-lake-single-v1", "single", "lake"],
      ["northern_pike", "northern_pike", "encounter-v1-northern-pike-lake-single-v1", "single", "lake"],
      ["snapping_turtle", "snapping_turtle", "encounter-v1-snapping-turtle-lake-single-v1", "single", "lake"],
      ["drowned_thrall", "drowned_thrall", "encounter-v1-drowned-thrall-lake-single-v1", "single", "lake"],
      ["beaver", "beaver", "encounter-v1-beaver-river-single-v1", "single", "river"],
      ["river_otter", "river_otter", "encounter-v1-river-otter-river-single-v1", "single", "river"],
      ["river_salmon", "river_salmon", "encounter-v1-river-salmon-river-single-v1", "single", "river"],
      ["kappa", "kappa", "encounter-v1-kappa-river-single-v1", "single", "river"],
      ["kappa_brawler", "kappa_brawler", "encounter-v1-kappa-brawler-river-single-v1", "single", "river"],
      ["bridge_troll", "bridge_troll", "encounter-v1-bridge-troll-river-single-v1", "single", "river"],
      ["nixie", "nixie", "encounter-v1-nixie-river-single-v1", "single", "river"],
      ["rapids_elemental", "rapids_elemental", "encounter-v1-rapids-elemental-river-single-v1", "single", "river"],
      ["shellback", "shellback", "encounter-v1-shellback-ocean-formation-v1", "pack", "ocean"],
      ["darter", "darter", "encounter-v1-darter-ocean-formation-v1", "pack", "ocean"],
      ["ink_pool", "ink_pool", "encounter-v1-ink-pool-ocean-single-v1", "single", "ocean"],
      ["drowned_citizen", "drowned_citizen", "encounter-v1-drowned-citizen-ocean-single-v1", "single", "ocean"],
      ["tide_wraith", "tide_wraith", "encounter-v1-tide-wraith-ocean-single-v1", "single", "ocean"],
      ["gate_warden", "gate_warden", "encounter-v1-gate-warden-ocean-single-v1", "single", "ocean"],
      ["drowned_cultist", "drowned_cultist", "encounter-v1-drowned-cultist-ocean-single-v1", "single", "ocean"],
      ["dire_wolf", "dire_wolf", "encounter-v1-dire-wolf-formation-v1", "pack", "land"],
      ["moss_troll", "moss_troll", "encounter-v1-moss-troll-single-v1", "single", "land"],
      ["woolly_mammoth", "woolly_mammoth", "encounter-v1-woolly-mammoth-single-v1", "single", "land"],
      ["ash_drake", "ash_drake", "encounter-v1-ash-drake-single-v1", "single", "land"],
      ["ember_dragon", "ember_dragon", "encounter-v1-ember-dragon-single-v1", "single", "land"],
      ["snapjaw_flytrap", "snapjaw_flytrap", "encounter-v1-snapjaw-flytrap-single-v1", "single", "land"],
      ["cairn_golem", "cairn_golem", "encounter-v1-cairn-golem-single-v1", "single", "land"],
      ["giant_larva", "giant_larva", "encounter-v1-giant-larva-single-v1", "single", "land"],
      ["field_hare", "field_hare", "encounter-v1-field-hare-formation-v1", "pack", "land"],
      ["arctic_hare", "arctic_hare", "encounter-v1-arctic-hare-formation-v1", "pack", "land"],
      ["capybara", "capybara", "encounter-v1-capybara-formation-v1", "pack", "land"],
      ["armadillo", "armadillo", "encounter-v1-armadillo-formation-v1", "pack", "land"],
      ["red_fox", "red_fox", "encounter-v1-red-fox-formation-v1", "pack", "land"],
      ["wolverine", "wolverine", "encounter-v1-wolverine-single-v1", "single", "land"],
      ["ostrich", "ostrich", "encounter-v1-ostrich-single-v1", "single", "land"],
      ["golden_eagle", "golden_eagle", "encounter-v1-golden-eagle-single-v1", "single", "land"],
      ["musk_ox", "musk_ox", "encounter-v1-musk-ox-single-v1", "single", "land"],
      ["seal", "seal", "encounter-v1-seal-formation-v1", "pack", "land"]
    ].map(([
      mobKind,
      combatArchetype,
      placementRevision,
      spawnModel,
      encounterSurface
    ]) => ({
      mobKind,
      combatArchetype,
      placementRevision,
      generationPlacement: "encounter_table_v1",
      spawnModel,
      encounterSurface,
      mechanicalPhaseEligibility: mobKind === "mysterious_traveler"
        ? "NIGHT"
        : "ANY"
    })));
    for (const kind of POPULATION_V2_RUNTIME_MOB_KINDS) {
      const definition = populationV2MobRegistry.requireDefinition(kind);
      expect(MOB_DEFINITIONS[definition.combatArchetype]).toBeDefined();
      expect(isPopulationV2RuntimeMobKind(kind)).toBe(true);
    }
    expect(isPopulationV2RuntimeMobKind("tree")).toBe(false);
  });

  it("registers the deployed surface mobs in the runtime population registry", () => {
    const deployedMobIds = [
      "mysterious_traveler",
      "hog",
      "woolly_hog",
      "warthog",
      "jungle_hog",
      "mud_hog",
      "javelina",
      "frog",
      "frost_frog",
      "poison_frog",
      "desert_toad",
      "alligator",
      "caiman",
      "crocodile",
      "squid",
      "jellyfish"
    ];
    expect(POPULATION_V2_RUNTIME_MOB_KINDS)
      .toEqual(expect.arrayContaining(deployedMobIds));
    expect(POPULATION_V2_RUNTIME_MOB_ARCHETYPES)
      .toEqual(expect.arrayContaining(deployedMobIds));
  });

  it("admits Skeleton only during dusk and night", () => {
    const skeleton = populationV2MobRegistry.requireDefinition("skeleton");
    expect(skeleton.worldTimePhaseEligibility).toEqual(["dusk", "night"]);
    expect(populationV2MobDefinitionIsEligibleAtWorldPhase(skeleton, "dusk")).toBe(true);
    expect(populationV2MobDefinitionIsEligibleAtWorldPhase(skeleton, "night")).toBe(true);
    expect(populationV2MobDefinitionIsEligibleAtWorldPhase(skeleton, "day")).toBe(false);
    expect(populationV2MobDefinitionIsEligibleAtWorldPhase(skeleton, "dawn")).toBe(false);
  });

  it("keeps undead fantasy mobs on the Skeleton's dusk-and-night rule and Lizardfolk any time", () => {
    for (const kind of ["frost_wraith", "barrow_wight", "bog_ghoul", "dust_mummy"]) {
      expect(populationV2MobRegistry.requireDefinition(kind).worldTimePhaseEligibility)
        .toEqual(["dusk", "night"]);
    }
    const lizardfolk = populationV2MobRegistry.requireDefinition("lizardfolk_warrior");
    expect(lizardfolk.worldTimePhaseEligibility).toBeUndefined();
    expect(populationV2MobDefinitionIsEligibleAtWorldPhase(lizardfolk, "day")).toBe(true);
  });

  it("rejects incomplete, duplicate, or unsupported definitions", () => {
    const deer = POPULATION_V2_MOB_DEFINITIONS[0];
    expect(() => validatePopulationV2MobDefinitions([deer, deer]))
      .toThrow(/duplicate.*mob kind/i);
    expect(() => validatePopulationV2MobDefinitions([
      deer,
      { ...testBoarDefinition(), combatArchetype: "deer" }
    ])).toThrow(/duplicate.*archetype ownership/i);
    expect(() => validatePopulationV2MobDefinitions([
      { ...testBoarDefinition(), placementRevision: " " }
    ], testValidationOptions())).toThrow(/placement revision/i);
    expect(() => validatePopulationV2MobDefinitions([{
      ...testBoarDefinition(),
      mobKind: `b${"o".repeat(64)}`
    }], testValidationOptions())).toThrow(/invalid.*mob kind/i);
    expect(() => validatePopulationV2MobDefinitions([{
      ...testBoarDefinition(),
      generationPlacement: "invalid"
    } as unknown as PopulationV2MobDefinition], testValidationOptions()))
      .toThrow(/generation placement/i);
    expect(() => validatePopulationV2MobDefinitions([{
      ...testBoarDefinition(),
      density: {
        model: "common",
        densityPerEligibleKm2: 0,
        candidateOversamplingFactor: 1
      }
    }], testValidationOptions())).toThrow(/density/i);
    expect(() => validatePopulationV2MobDefinitions([{
      ...testBoarDefinition(),
      spacingClass: "unsupported" as never
    }], testValidationOptions())).toThrow(/spacing class/i);
    expect(() => validatePopulationV2MobDefinitions([{
      ...testBoarDefinition(),
      suppressionClass: "unsupported" as never
    }], testValidationOptions())).toThrow(/suppression class/i);
    expect(() => validatePopulationV2MobDefinitions([{
      ...testBoarDefinition(),
      mechanicalPhaseEligibility: "INVALID" as never
    }], testValidationOptions())).toThrow(/mechanical phase eligibility/i);
    expect(() => validatePopulationV2MobDefinitions([
      invalidPackDefinition()
    ])).toThrow(/no valid formation/i);
    expect(() => validatePopulationV2MobDefinitions([
      partialPackDefinition()
    ])).toThrow(/mixed or partial group/i);
  });

  it("accepts a test-only boar through one injected definition", () => {
    const boar = testBoarDefinition();
    const registry = createPopulationV2MobRegistry(
      [...POPULATION_V2_MOB_DEFINITIONS, boar],
      testValidationOptions()
    );

    expect(registry.runtimeMobKinds).toContain("registry_test_boar");
    expect(registry.runtimeArchetypes).toContain("registry_test_boar");
    expect(registry.requireDefinition("registry_test_boar")).toBe(boar);
    expect(boar.candidateBuilder({
      candidateId: "boar-candidate",
      anchor: { lat: 35, lon: -106 },
      memberPositions: []
    })).toEqual({
      candidateId: "boar-candidate",
      mobKind: "registry_test_boar",
      anchor: { lat: 35, lon: -106 },
      members: [{
        mobKind: "registry_test_boar",
        memberIndex: null,
        position: { lat: 35, lon: -106 }
      }]
    });
  });

  it("preserves exact legacy plan and Resin Crawler generation identities", () => {
    const plans = representativePlans();
    const legacyDefinitions = POPULATION_V2_MOB_DEFINITIONS.filter(
      (definition): definition is Extract<
        (typeof POPULATION_V2_MOB_DEFINITIONS)[number],
        { legacyIdentity: unknown }
      > => "legacyIdentity" in definition
    );
    for (const definition of legacyDefinitions) {
      const legacy = definition.legacyIdentity;
      expect(legacy).toBeDefined();
      const fixture = firstCandidateGroup(
        plans,
        definition.mobKind
      );
      const expected = legacy!.candidate({
        planIdentity: fixture.plan.identity,
        candidateId: fixture.slots[0]!.candidateId,
        sourceOwnerId: fixture.plan.identity.zoneId,
        memberCount: fixture.slots.length
      });
      const ordered = [...fixture.slots].sort(
        (left, right) =>
          (left.packMemberIndex ?? -1) - (right.packMemberIndex ?? -1)
      );
      expect({
        candidateId: expected.candidateId,
        encounterId: expected.encounterId,
        packId: expected.packId,
        members: expected.members
      }).toEqual({
        candidateId: ordered[0]!.candidateId,
        encounterId: ordered[0]!.encounterId,
        packId: ordered[0]!.packId,
        members: ordered.map((slot) => ({
          memberIndex: slot.packMemberIndex,
          slotId: slot.slotId,
          entityId: slot.entityId
        }))
      });
    }

    const sap = firstCandidateGroup(plans, "sap_crawler");
    const generationId = populationZoneV2GenerationId({
      identity: sap.plan.identity,
      generationNumber: 1
    });
    const materialized = materializeSapCrawlerTemplateGroups({
      templateSlots: sap.slots,
      generationId,
      generationNumber: 1
    });
    const materializer = populationV2MobRegistry
      .requireDefinition("sap_crawler")
      .legacyIdentity!.materializeGeneration!;
    expect(materialized.map((slot) => ({
      candidateId: slot.candidateId,
      encounterId: slot.encounterId,
      packId: slot.packId,
      slotId: slot.slotId,
      entityId: slot.entityId,
      memberIndex: slot.packMemberIndex
    })).sort(byMemberIndex)).toEqual(materialized.map((slot) =>
      materializer({
        templateCandidateId: sap.slots[0]!.candidateId,
        generationId,
        generationNumber: 1,
        memberIndex: slot.packMemberIndex!
      })
    ).sort(byMemberIndex));
  });

  it("isolates registered identities by mob kind and placement revision", () => {
    const sapBefore = populationV2MobRegistry.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "sap_crawler",
      deterministicCandidateId: "registered-candidate-17",
      memberIndex: 3
    });
    expect(sapBefore).toEqual({
      candidateId: "b2d631cc-ccf3-8803-b148-d1c921c36dbe",
      encounterId: "8c88068f-5e1d-8610-9400-efef1b222e8d",
      packId: "d98a933e-d9c2-85a0-9254-592acbbc24d9",
      slotId: "344fa29c-58f3-8d5e-a751-f0325998f94c",
      entityId: "20bc0c8e-99de-89a9-ba1f-5a4948513d0d",
      memberIndex: 3
    });

    const extended = createPopulationV2MobRegistry(
      [...POPULATION_V2_MOB_DEFINITIONS, testBoarDefinition()],
      testValidationOptions()
    );
    expect(extended.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "sap_crawler",
      deterministicCandidateId: "registered-candidate-17",
      memberIndex: 3
    })).toEqual(sapBefore);

    const revisedSap = createPopulationV2MobRegistry(
      POPULATION_V2_MOB_DEFINITIONS.map((definition) =>
        definition.mobKind === "sap_crawler"
          ? { ...definition, placementRevision: "sap-crawler-placement-v2" }
          : definition
      )
    );
    expect(revisedSap.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "sap_crawler",
      deterministicCandidateId: "registered-candidate-17",
      memberIndex: 3
    })).not.toEqual(sapBefore);
    expect(revisedSap.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "deer",
      deterministicCandidateId: "registered-candidate-17",
      memberIndex: 0
    })).toEqual(populationV2MobRegistry.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "deer",
      deterministicCandidateId: "registered-candidate-17",
      memberIndex: 0
    }));

    const boarV1 = extended.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "registry_test_boar",
      deterministicCandidateId: "registered-candidate-17"
    });
    const boarV2Registry = createPopulationV2MobRegistry(
      [
        ...POPULATION_V2_MOB_DEFINITIONS,
        testBoarDefinition("registry-test-boar-placement-v2")
      ],
      testValidationOptions()
    );
    expect(boarV2Registry.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "registry_test_boar",
      deterministicCandidateId: "registered-candidate-17"
    })).not.toEqual(boarV1);
    expect(boarV2Registry.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "sap_crawler",
      deterministicCandidateId: "registered-candidate-17",
      memberIndex: 3
    })).toEqual(sapBefore);

    const planIdentity = populationZoneV2PlanIdentity({
      zoneId: "ppz2-eag1/aq5/55e",
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION
    });
    const planAndGeneration = {
      planId: populationZoneV2PlanId(planIdentity),
      generationId: populationZoneV2GenerationId({
        identity: planIdentity,
        generationNumber: 1
      })
    };
    expect(planAndGeneration).toEqual({
      planId: "5ba7191b-24fa-8177-a227-4f3998d3f7d4",
      generationId: "f797f2f3-63ee-8847-b358-88fb19f47595"
    });
  });

  it("keeps legacy identities independent from per-mob revisions", () => {
    const identity = populationZoneV2PlanIdentity({
      zoneId: "ppz2-eag1/aq5/55e",
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION
    });
    const input = {
      planIdentity: identity,
      planKind: "deer" as const,
      entityKind: "deer" as const,
      spawnModel: "single" as const,
      candidateId: "legacy-deer-candidate",
      sourceOwnerId: identity.zoneId
    };
    expect(legacyPopulationV2MobCandidateIdentity(input))
      .toEqual(legacyPopulationV2MobCandidateIdentity(input));
    expect(registeredPopulationV2MobIdentity({
      generationId: GENERATION_ID,
      mobKind: "deer",
      placementRevision: "deer-placement-v1",
      deterministicCandidateId: input.candidateId,
      spawnModel: "single"
    })).not.toEqual(registeredPopulationV2MobIdentity({
      generationId: GENERATION_ID,
      mobKind: "deer",
      placementRevision: "deer-placement-v2",
      deterministicCandidateId: input.candidateId,
      spawnModel: "single"
    }));
  });
});

function testBoarDefinition(
  placementRevision = "registry-test-boar-placement-v1"
): PopulationV2MobDefinition<"registry_test_boar", "registry_test_boar"> {
  return {
    mobKind: "registry_test_boar",
    combatArchetype: "registry_test_boar",
    placementRevision,
    generationPlacement: "registered_overlay",
    spawnModel: "single",
    behaviorCategory: "hostile",
    mechanicalPhaseEligibility: "ANY",
    plannerPriority: 40,
    density: {
      model: "common",
      densityPerEligibleKm2: 1,
      candidateOversamplingFactor: 1
    },
    eligibleAreaKm2: (habitat) => habitat.eligibleLandKm2,
    isEligibleAnchor: (site) => site.weights.eligibleLand > 0,
    candidateBuilder:
      createSinglePopulationV2MobCandidateBuilder("registry_test_boar"),
    spacingClass: "passive_single",
    suppressionClass: "deer-safe",
    clientPresentational: true,
    defaultRolloutPolicy: "next_generation_only",
    existingGenerationRolloutEligible: false,
    diagnosticsLabel: "Registry test boar"
  };
}

function testValidationOptions() {
  return {
    supportedArchetypes: new Set([
      ...Object.keys(MOB_DEFINITIONS),
      "registry_test_boar"
    ])
  };
}

function invalidPackDefinition(): PopulationV2MobDefinition {
  return {
    ...testBoarDefinition(),
    mobKind: "invalid_pack",
    combatArchetype: "wolf",
    spawnModel: "pack",
    candidateBuilder: createSinglePopulationV2MobCandidateBuilder(
      "invalid_pack"
    )
  };
}

function partialPackDefinition(): PopulationV2MobDefinition {
  const formation: PopulationV2MobPackFormation = {
    allowedMemberCounts: [2],
    memberCountForCandidate: () => 2
  };
  return {
    ...testBoarDefinition(),
    mobKind: "partial_pack",
    combatArchetype: "wolf",
    spawnModel: "pack",
    packFormation: formation,
    candidateBuilder: () => ({
      candidateId: "population-v2-registry-validation/partial_pack",
      mobKind: "partial_pack",
      anchor: { lat: 0, lon: 0 },
      members: [{
        mobKind: "partial_pack",
        memberIndex: 0,
        position: { lat: 0, lon: 0 }
      }]
    })
  };
}

function representativePlans(): GeneratedPopulationZoneV2Plan[] {
  const origin = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  return generatePopulationZonesV2Plans({
    outputZoneIds: populationZoneV2Halo(origin, 7),
    worldEnvironmentIdentityKey: WORLD_IDENTITY,
    worldPipelineSha: WORLD_SHA,
    habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    })
  });
}

function firstCandidateGroup(
  plans: readonly GeneratedPopulationZoneV2Plan[],
  mobKind: "deer" | "wolf" | "ogre" | "sap_crawler"
): Readonly<{
  plan: GeneratedPopulationZoneV2Plan;
  slots: PopulationZoneV2PlanSlot[];
}> {
  for (const plan of plans) {
    const first = plan.slots.find((slot) => slot.entityKind === mobKind);
    if (first === undefined) continue;
    return {
      plan,
      slots: plan.slots.filter((slot) =>
        slot.candidateId === first.candidateId
      )
    };
  }
  throw new Error(`representative plan has no ${mobKind}`);
}

function byMemberIndex(
  left: Readonly<{ memberIndex: number | null }>,
  right: Readonly<{ memberIndex: number | null }>
): number {
  return (left.memberIndex ?? -1) - (right.memberIndex ?? -1);
}
