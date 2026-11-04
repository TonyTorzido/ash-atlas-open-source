import type { MobArchetypeKey } from "./combat.js";
import { FLAX_FIBER_HARVEST_YIELD_QUANTITY, type ResourceType } from "./collectibles.js";
import type {
  WorldEnvironmentOverlayCategoryId,
  WorldEnvironmentOverlayGroupId
} from "./worldEnvironmentOverlay.js";

export type CreatureBookHabitatRestriction = Readonly<{
  groupId: WorldEnvironmentOverlayGroupId;
  categoryIds: readonly WorldEnvironmentOverlayCategoryId[];
  label: string;
}>;

export const CREATURE_BOOK_ROSTER = Object.freeze([
  { bookOrder: 0, archetypeKey: "deer", name: "Deer", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 1, archetypeKey: "frost_deer", name: "Frost Deer", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 2, archetypeKey: "jungle_deer", name: "Jungle Deer", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 3, archetypeKey: "marsh_deer", name: "Marsh Deer", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 4, archetypeKey: "sand_deer", name: "Sand Deer", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 5, archetypeKey: "hog", name: "Hog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 6, archetypeKey: "woolly_hog", name: "Woolly Hog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 7, archetypeKey: "warthog", name: "Warthog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 8, archetypeKey: "jungle_hog", name: "Jungle Hog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 9, archetypeKey: "mud_hog", name: "Mud Hog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 10, archetypeKey: "javelina", name: "Javelina", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 11, archetypeKey: "coastal_crab", name: "Coastal Crab", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 12, archetypeKey: "ice_crab", name: "Ice Crab", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 13, archetypeKey: "sand_crab", name: "Sand Crab", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 14, archetypeKey: "mangrove_crab", name: "Mangrove Crab", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 15, archetypeKey: "frog", name: "Frog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 16, archetypeKey: "frost_frog", name: "Frost Frog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 17, archetypeKey: "poison_frog", name: "Poison Frog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 18, archetypeKey: "desert_toad", name: "Desert Toad", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 19, archetypeKey: "wolf", name: "Wolf", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 20, archetypeKey: "frost_wolf", name: "Frost Wolf", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 21, archetypeKey: "dune_wolf", name: "Dune Wolf", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 22, archetypeKey: "jungle_wolf", name: "Jungle Wolf", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 23, archetypeKey: "bog_wolf", name: "Bog Wolf", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 24, archetypeKey: "bear", name: "Bear", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 25, archetypeKey: "snow_bear", name: "Snow Bear", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 26, archetypeKey: "black_bear", name: "Black Bear", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 27, archetypeKey: "sun_bear", name: "Sun Bear", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 28, archetypeKey: "squid", name: "Squid", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 29, archetypeKey: "sap_crawler", name: "Resin Crawler", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 30, archetypeKey: "alligator", name: "Alligator", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 31, archetypeKey: "caiman", name: "Caiman", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 32, archetypeKey: "crocodile", name: "Crocodile", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 33, archetypeKey: "jellyfish", name: "Jellyfish", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 34, archetypeKey: "frost_wraith", name: "Frost Wraith", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 35, archetypeKey: "yeti", name: "Yeti", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 36, archetypeKey: "barrow_wight", name: "Barrow Wight", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 37, archetypeKey: "moss_golem", name: "Moss Golem", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 38, archetypeKey: "vine_lurker", name: "Vine Lurker", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 39, archetypeKey: "lizardfolk_warrior", name: "Lizardfolk Warrior", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 40, archetypeKey: "bog_ghoul", name: "Bog Ghoul", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 41, archetypeKey: "giant_scorpion", name: "Giant Scorpion", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 42, archetypeKey: "dust_mummy", name: "Dust Mummy", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 43, archetypeKey: "thunderhorn", name: "Thunderhorn", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 44, archetypeKey: "griffin", name: "Griffin", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 45, archetypeKey: "basilisk", name: "Basilisk", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 46, archetypeKey: "ogre", name: "Ogre", rarity: "epic", habitatThreshold: 10 },
  { bookOrder: 47, archetypeKey: "mysterious_traveler", name: "Mysterious Traveler", rarity: "epic", habitatThreshold: 10 },
  { bookOrder: 48, archetypeKey: "fire_bird", name: "Fire Bird", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 49, archetypeKey: "lightning_bird", name: "Lightning Bird", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 50, archetypeKey: "ice_bird", name: "Ice Bird", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 51, archetypeKey: "xoral", name: "Xoral", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 52, archetypeKey: "jungle_tapir", name: "Jungle Tapir", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 53, archetypeKey: "jaguar", name: "Jaguar", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 54, archetypeKey: "mandrill", name: "Mandrill", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 55, archetypeKey: "canopy_goblin", name: "Canopy Goblin", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 56, archetypeKey: "poisonfrog_raider", name: "Poisonfrog Raider", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 57, archetypeKey: "pantherfolk_stalker", name: "Pantherfolk Stalker", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 58, archetypeKey: "vine_wrapped_corpse", name: "Vine-Wrapped Corpse", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 59, archetypeKey: "serpent_priestess", name: "Serpent Priestess", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 60, archetypeKey: "capercaillie", name: "Capercaillie", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 61, archetypeKey: "bugbear_chieftain", name: "Bugbear Chieftain", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 62, archetypeKey: "pinewarden", name: "Pinewarden", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 63, archetypeKey: "gallows_ghost", name: "Gallows Ghost", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 64, archetypeKey: "alder_king", name: "Alder King", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 65, archetypeKey: "elk", name: "Elk", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 66, archetypeKey: "red_squirrel", name: "Red Squirrel", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 67, archetypeKey: "pine_dryad", name: "Pine Dryad", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 68, archetypeKey: "badger", name: "Badger", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 69, archetypeKey: "grey_squirrel", name: "Grey Squirrel", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 70, archetypeKey: "stag_beetle", name: "Stag Beetle", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 71, archetypeKey: "mossjaw_sneak", name: "Mossjaw Sneak", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 72, archetypeKey: "mossjaw_spearman", name: "Mossjaw Spearman", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 73, archetypeKey: "mossjaw_hexer", name: "Mossjaw Hexer", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 74, archetypeKey: "mossjaw_warboss", name: "Mossjaw Warboss", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 75, archetypeKey: "hedge_witch", name: "Hedge Witch", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 76, archetypeKey: "restless_gravedigger", name: "Restless Gravedigger", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 77, archetypeKey: "coven_matron", name: "Coven Matron", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 78, archetypeKey: "great_grey_owl", name: "Great Grey Owl", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 79, archetypeKey: "flying_squirrel", name: "Flying Squirrel", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 80, archetypeKey: "stagfolk_warden", name: "Stagfolk Warden", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 81, archetypeKey: "rime_witch", name: "Rime Witch", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 82, archetypeKey: "draugr_berserker", name: "Draugr Berserker", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 83, archetypeKey: "snow_talonbear", name: "Snow Talonbear", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 84, archetypeKey: "frostwater_troll", name: "Frostwater Troll", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 85, archetypeKey: "underice_lurker", name: "Underice Lurker", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 86, archetypeKey: "plains_bison", name: "Plains Bison", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 87, archetypeKey: "prairie_dog", name: "Prairie Dog", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 88, archetypeKey: "burrowing_owl", name: "Burrowing Owl", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 89, archetypeKey: "centaur_outrider", name: "Centaur Outrider", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 90, archetypeKey: "volt_elemental", name: "Volt Elemental", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 91, archetypeKey: "possessed_scythe", name: "Possessed Scythe", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 92, archetypeKey: "strawman_lord", name: "Strawman Lord", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 93, archetypeKey: "giraffe", name: "Giraffe", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 94, archetypeKey: "lioness", name: "Lioness", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 95, archetypeKey: "spotted_hyena", name: "Spotted Hyena", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 96, archetypeKey: "gnoll_bonebow", name: "Gnoll Bonebow", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 97, archetypeKey: "gnoll_packseer", name: "Gnoll Packseer", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 98, archetypeKey: "gnoll_packlord", name: "Gnoll Packlord", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 99, archetypeKey: "carrion_ghoul", name: "Carrion Ghoul", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 100, archetypeKey: "sun_griffin", name: "Sun Griffin", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 101, archetypeKey: "sitatunga", name: "Sitatunga", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 102, archetypeKey: "emperor_dragonfly", name: "Emperor Dragonfly", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 103, archetypeKey: "frogfolk_tadpole", name: "Frogfolk Tadpole", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 104, archetypeKey: "frogfolk_blowgunner", name: "Frogfolk Blowgunner", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 105, archetypeKey: "frogfolk_shaman", name: "Frogfolk Shaman", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 106, archetypeKey: "frogfolk_chief", name: "Frogfolk Chief", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 107, archetypeKey: "bloat_leech", name: "Bloat Leech", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 108, archetypeKey: "bog_hag", name: "Bog Hag", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 109, archetypeKey: "leech_mother", name: "Leech Mother", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 110, archetypeKey: "mountain_ibex", name: "Mountain Ibex", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 111, archetypeKey: "wild_yak", name: "Wild Yak", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 112, archetypeKey: "alpine_marmot", name: "Alpine Marmot", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 113, archetypeKey: "yakfolk_stonehorn", name: "Yakfolk Stonehorn", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 114, archetypeKey: "highland_reaver", name: "Highland Reaver", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 115, archetypeKey: "storm_harpy", name: "Storm Harpy", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 116, archetypeKey: "cairn_wight", name: "Cairn Wight", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 117, archetypeKey: "stormwing_chick", name: "Stormwing Chick", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 118, archetypeKey: "stormwing", name: "Stormwing", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 119, archetypeKey: "wild_scrub_goat", name: "Wild Scrub Goat", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 120, archetypeKey: "crested_porcupine", name: "Crested Porcupine", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 121, archetypeKey: "spur_thighed_tortoise", name: "Spur-thighed Tortoise", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 122, archetypeKey: "cyclops_shepherd", name: "Cyclops Shepherd", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 123, archetypeKey: "skeleton_hoplite", name: "Skeleton Hoplite", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 124, archetypeKey: "tar_elemental", name: "Tar Elemental", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 125, archetypeKey: "olive_dryad", name: "Olive Dryad", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 126, archetypeKey: "chimera", name: "Chimera", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 127, archetypeKey: "dromedary", name: "Dromedary", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 128, archetypeKey: "fennec_fox", name: "Fennec Fox", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 129, archetypeKey: "sidewinder", name: "Sidewinder", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 130, archetypeKey: "desert_lion", name: "Desert Lion", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 131, archetypeKey: "jackalfolk_skirmisher", name: "Jackalfolk Skirmisher", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 132, archetypeKey: "dune_goblin", name: "Dune Goblin", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 133, archetypeKey: "desert_marauder", name: "Desert Marauder", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 134, archetypeKey: "scorch_troll", name: "Scorch Troll", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 135, archetypeKey: "ember_giant", name: "Ember Giant", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 136, archetypeKey: "saiga", name: "Saiga", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 137, archetypeKey: "wild_horse", name: "Steppe Wild Horse", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 138, archetypeKey: "steppe_marmot", name: "Steppe Marmot", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 139, archetypeKey: "steppe_raider", name: "Steppe Raider", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 140, archetypeKey: "steppe_horse_archer", name: "Steppe Horse Archer", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 141, archetypeKey: "salt_husk", name: "Salt Husk", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 142, archetypeKey: "kurgan_wight", name: "Kurgan Wight", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 143, archetypeKey: "centaur_khan", name: "Centaur Khan", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 144, archetypeKey: "lemming", name: "Lemming", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 145, archetypeKey: "snow_goose", name: "Snow Goose", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 146, archetypeKey: "frostborn_runecaster", name: "Frostborn Runecaster", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 147, archetypeKey: "frostborn_jarl", name: "Frostborn Jarl", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 148, archetypeKey: "permafrost_elemental", name: "Permafrost Elemental", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 149, archetypeKey: "draugr", name: "Draugr", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 150, archetypeKey: "mammoth_patriarch", name: "Mammoth Patriarch", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 151, archetypeKey: "emperor_penguin", name: "Emperor Penguin", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 152, archetypeKey: "peary_caribou", name: "Peary Caribou", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 153, archetypeKey: "ice_worm", name: "Ice Worm", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 154, archetypeKey: "rime_troll", name: "Rime Troll", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 155, archetypeKey: "aurora_shade", name: "Aurora Shade", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 156, archetypeKey: "blizzard_lord", name: "Blizzard Lord", rarity: "legendary", habitatThreshold: null },
  { bookOrder: 157, archetypeKey: "sea_otter", name: "Sea Otter", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 158, archetypeKey: "herring_gull", name: "Herring Gull", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 159, archetypeKey: "spiny_lobster", name: "Spiny Lobster", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 160, archetypeKey: "gillfolk_scout", name: "Gillfolk Scout", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 161, archetypeKey: "gillfolk_netter", name: "Gillfolk Netter", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 162, archetypeKey: "coral_golem", name: "Coral Golem", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 163, archetypeKey: "drowned_deckhand", name: "Drowned Deckhand", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 164, archetypeKey: "reef_kraken", name: "Reef Kraken", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 165, archetypeKey: "hammerhead_shark", name: "Hammerhead Shark", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 166, archetypeKey: "manta_ray", name: "Manta Ray", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 167, archetypeKey: "humpback_whale", name: "Humpback Whale", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 168, archetypeKey: "merfolk_harpooner", name: "Merfolk Harpooner", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 169, archetypeKey: "phantom_lookout", name: "Phantom Lookout", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 170, archetypeKey: "maelstrom_spirit", name: "Maelstrom Spirit", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 171, archetypeKey: "sea_serpent", name: "Sea Serpent", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 172, archetypeKey: "kraken", name: "Kraken", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 173, archetypeKey: "muskellunge", name: "Muskellunge", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 174, archetypeKey: "mute_swan", name: "Mute Swan", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 175, archetypeKey: "drowned_bride", name: "Drowned Bride", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 176, archetypeKey: "lake_maiden", name: "Lake Maiden", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 177, archetypeKey: "elder_mere_serpent", name: "Elder Mere Serpent", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 178, archetypeKey: "northern_pike", name: "Northern Pike", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 179, archetypeKey: "snapping_turtle", name: "Snapping Turtle", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 180, archetypeKey: "drowned_thrall", name: "Drowned Thrall", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 181, archetypeKey: "beaver", name: "Beaver", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 182, archetypeKey: "river_otter", name: "River Otter", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 183, archetypeKey: "river_salmon", name: "River Salmon", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 184, archetypeKey: "kappa", name: "Kappa", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 185, archetypeKey: "kappa_brawler", name: "Kappa Brawler", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 186, archetypeKey: "bridge_troll", name: "Bridge Troll", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 187, archetypeKey: "nixie", name: "Nixie", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 188, archetypeKey: "rapids_elemental", name: "Rapids Elemental", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 189, archetypeKey: "shellback", name: "Shellback", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 190, archetypeKey: "darter", name: "Darter", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 191, archetypeKey: "ink_pool", name: "Ink Pool", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 192, archetypeKey: "drowned_citizen", name: "Drowned Citizen", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 193, archetypeKey: "tide_wraith", name: "Tide Wraith", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 194, archetypeKey: "gate_warden", name: "Gate Warden", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 195, archetypeKey: "drowned_cultist", name: "Drowned Cultist", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 196, archetypeKey: "dire_wolf", name: "Dire Wolf", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 197, archetypeKey: "moss_troll", name: "Moss Troll", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 198, archetypeKey: "woolly_mammoth", name: "Woolly Mammoth", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 199, archetypeKey: "ash_drake", name: "Ash Drake", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 200, archetypeKey: "ember_dragon", name: "Ember Dragon", rarity: "rare", habitatThreshold: 25 },
  { bookOrder: 201, archetypeKey: "snapjaw_flytrap", name: "Snapjaw Flytrap", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 202, archetypeKey: "cairn_golem", name: "Cairn Golem", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 203, archetypeKey: "giant_larva", name: "Giant Larva", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 204, archetypeKey: "field_hare", name: "Field Hare", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 205, archetypeKey: "arctic_hare", name: "Arctic Hare", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 206, archetypeKey: "capybara", name: "Capybara", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 207, archetypeKey: "armadillo", name: "Armadillo", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 208, archetypeKey: "red_fox", name: "Red Fox", rarity: "common", habitatThreshold: 100 },
  { bookOrder: 209, archetypeKey: "wolverine", name: "Wolverine", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 210, archetypeKey: "ostrich", name: "Ostrich", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 211, archetypeKey: "golden_eagle", name: "Golden Eagle", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 212, archetypeKey: "musk_ox", name: "Musk Ox", rarity: "uncommon", habitatThreshold: 50 },
  { bookOrder: 213, archetypeKey: "seal", name: "Seal", rarity: "common", habitatThreshold: 100 }
] as const satisfies readonly Readonly<{
  bookOrder: number;
  archetypeKey: MobArchetypeKey;
  name: string;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  habitatThreshold: number | null;
}>[]);

export type CreatureBookArchetypeKey = (typeof CREATURE_BOOK_ROSTER)[number]["archetypeKey"];

/**
 * Every archetype that is not in the Creature Book says why here. Together
 * with the roster this covers every MobArchetypeKey, so a new mob that is
 * neither listed nor excluded fails to compile.
 */
export const CREATURE_BOOK_EXCLUDED_ARCHETYPES = Object.freeze({
  training_dummy: "Practice target, not a creature",
  goblin: "Goblin Village actor, not a wild creature",
  bandit: "Humanoid encounter, not a wild creature",
  orc_brute: "Humanoid encounter, not a wild creature",
  skeleton: "Undead encounter, not a wild creature",
  risen_skeleton: "Revenant Metal summon, not a wild creature",
  revenant_lich: "Revenant Metal summon, not a wild creature",
  sewer_rat: "Dungeon actor",
  sick_sewer_rat: "Dungeon actor",
  sewer_rat_miniboss: "Dungeon boss",
  slime: "Dungeon actor",
  slime_miniboss: "Dungeon boss",
  shellback_turtle: "Dungeon actor (Cistern Warrens)",
  sewer_spider: "Dungeon actor (Cistern Warrens)",
  dune_tick: "Dungeon actor (Cistern Warrens)",
  spiderling: "Dungeon actor (Cistern Warrens)",
  brood_matriarch: "Dungeon boss (Cistern Warrens)",
  cave_raptor: "Dungeon actor (Fangrock Cavern)",
  raptor_runt: "Dungeon actor (Fangrock Cavern)",
  raptor_spitter: "Dungeon actor (Fangrock Cavern)",
  cave_bat: "Dungeon actor (Fangrock Cavern)",
  raptor_chieftain: "Dungeon boss (Fangrock Cavern)",
  nest_mouse: "Dungeon actor (The Eyrie)",
  carrion_chick: "Dungeon actor (The Eyrie)",
  cliff_hawk: "Dungeon actor (The Eyrie)",
  thunderwing: "Dungeon boss (The Eyrie)",
  rot_wolf: "Dungeon actor (Blightwood Grove)",
  blighted_stag: "Dungeon actor (Blightwood Grove)",
  thornfern: "Dungeon actor (Blightwood Grove)",
  blight_treant: "Dungeon actor (Blightwood Grove)",
  blight_sprite: "Dungeon actor (Blightwood Grove)",
  hollow_elder: "Dungeon boss (Blightwood Grove)",
  drakeling: "Dungeon actor (Wyrm Hollow)",
  magma_salamander: "Dungeon actor (Wyrm Hollow)",
  lava_slime: "Dungeon actor (Wyrm Hollow)",
  ash_wyvern: "Dungeon actor (Wyrm Hollow)",
  drake_broodguard: "Dungeon actor (Wyrm Hollow)",
  elder_dragon: "Dungeon boss (Wyrm Hollow)",
  initiate_monk: "Dungeon actor (Monastery of the Still Hand)",
  staff_adept: "Dungeon actor (Monastery of the Still Hand)",
  shadow_acrobat: "Dungeon actor (Monastery of the Still Hand)",
  iron_statue: "Dungeon actor (Monastery of the Still Hand)",
  bell_spirit: "Dungeon actor (Monastery of the Still Hand)",
  ember_shade: "Dungeon actor (The Tilted Vault)",
  ashbound_revenant: "Dungeon actor (The Tilted Vault)",
  vault_warden: "Dungeon elite (The Tilted Vault)",
  grandmaster: "Dungeon boss (Monastery of the Still Hand)",
  grandmaster_clone: "Dungeon boss add (Monastery of the Still Hand)",
  hollin_hut: "Hollin Huts structure",
  hollin_guard: "Hollin Huts settlement actor",
  hollin_brute: "Hollin Huts settlement actor",
  hollin_elder: "Hollin Huts settlement actor",
  hollin_farmer: "Hollin Huts settlement actor",
  hollin_helper: "Hollin Lore helper minion",
  sky_scout: "Dungeon roster (Fallen Prison)",
  cloud_sentry: "Dungeon roster (Fallen Prison)",
  cloud_arbiter: "Dungeon roster (Fallen Prison)",
  warden_scout: "Dungeon roster (Fallen Prison)",
  zealot: "Dungeon roster (Fallen Prison)",
  serpent_jailer: "Dungeon roster (Fallen Prison)",
  caged_valkyrie: "Dungeon roster (Fallen Prison)",
  coil_hatchling: "Dungeon roster (Fallen Prison)",
  legion_soldier: "Dungeon roster (Fallen Prison)",
  mimic: "Dungeon roster (Fallen Prison)",
  centurion: "Dungeon boss (Fallen Prison)",
  brood_matron: "Dungeon boss (Fallen Prison)",
  trifang_warden: "Dungeon boss (Fallen Prison)",
  tide_wraith_dc: "Dungeon roster (Drowned City)",
  darter_dc: "Dungeon roster (Drowned City)",
  ink_pool_dc: "Dungeon roster (Drowned City)",
  drowned_cultist_dc: "Dungeon roster (Drowned City)",
  shellback_dc: "Dungeon roster (Drowned City)",
  coral_golem_dc: "Dungeon roster (Drowned City)",
  drowned_deckhand_dc: "Dungeon roster (Drowned City)",
  phantom_lookout_dc: "Dungeon roster (Drowned City)",
  merfolk_harpooner_dc: "Dungeon roster (Drowned City)",
  gate_warden_dc: "Dungeon roster (Drowned City)",
  void_wisp: "Dungeon roster (Drowned City)",
  deep_crawler: "Dungeon roster (Drowned City)",
  maw_lily: "Dungeon roster (Drowned City)",
  chrono_wisp: "Dungeon roster (Drowned City)",
  the_watcher: "Dungeon boss (Drowned City)",
  drowned_admiral: "Dungeon boss (Drowned City)",
  tidemaw: "Dungeon boss (Drowned City)",
  abyssal_one: "Dungeon boss (Drowned City)",
  tidemaw_tentacle: "Dungeon boss part (Drowned City)",
  tidemaw_tentacle_marked: "Dungeon boss part (Drowned City)",
  abyssal_cultist: "Dungeon boss add (Drowned City)",
  iron_golem_gf: "Dungeon roster (Golem Forge)",
  stone_golem_gf: "Dungeon roster (Golem Forge)",
  geode_golem_gf: "Dungeon roster (Golem Forge)",
  mender_golem_gf: "Dungeon roster (Golem Forge)",
  sentinel_statue_gf: "Dungeon roster (Golem Forge)",
  spark_wisp_gf: "Dungeon roster (Golem Forge)",
  slag_crawler_gf: "Dungeon roster (Golem Forge)",
  golem_smith_gf: "Dungeon roster (Golem Forge)",
  corrupted_husk_gf: "Dungeon boss part (Golem Forge)",
  gem_husk_gf: "Dungeon boss part (Golem Forge)",
  walking_hammer_gf: "Dungeon boss part (Golem Forge)",
  healer_monolith_gf: "Dungeon boss part (Golem Forge)",
  granite_bull: "Dungeon boss (Golem Forge)",
  corrupted_core: "Dungeon boss (Golem Forge)",
  forgemaster: "Dungeon boss (Golem Forge)"
} as const satisfies Readonly<Partial<Record<MobArchetypeKey, string>>>);

type CreatureBookCoverageGap = Exclude<
  MobArchetypeKey,
  CreatureBookArchetypeKey | keyof typeof CREATURE_BOOK_EXCLUDED_ARCHETYPES
>;
type CreatureBookCoverageOverlap = Extract<
  CreatureBookArchetypeKey,
  keyof typeof CREATURE_BOOK_EXCLUDED_ARCHETYPES
>;
// A compile error here names the archetype: add it to CREATURE_BOOK_ROSTER or
// CREATURE_BOOK_EXCLUDED_ARCHETYPES (never both).
const creatureBookCoverage: Readonly<{
  missing: [CreatureBookCoverageGap] extends [never] ? true : CreatureBookCoverageGap;
  duplicated: [CreatureBookCoverageOverlap] extends [never] ? true : CreatureBookCoverageOverlap;
}> = { missing: true, duplicated: true };
void creatureBookCoverage;

const CREATURE_BOOK_ARCHETYPE_SET: ReadonlySet<string> = new Set(
  CREATURE_BOOK_ROSTER.map(({ archetypeKey }) => archetypeKey)
);

/** Server-side gate for every Creature Book write (the database only checks the key format). */
export function isCreatureBookArchetype(value: string | null | undefined): value is CreatureBookArchetypeKey {
  return typeof value === "string" && CREATURE_BOOK_ARCHETYPE_SET.has(value);
}

// Water biome variants (frog and alligator families); each lists the biomes it spawns in.
const FROST_FROG_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "environment", categoryIds: ["frostwood", "tundra", "frozen_waste"], label: "Frostwood, Tundra & Frozen Waste"
});
const POISON_FROG_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "environment", categoryIds: ["jungle"], label: "Jungle"
});
const DESERT_TOAD_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "environment", categoryIds: ["savanna", "steppe", "badlands"], label: "Savanna, Steppe & Badlands"
});
const CAIMAN_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "environment", categoryIds: ["jungle"], label: "Jungle"
});
const CROCODILE_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "environment", categoryIds: ["savanna", "steppe", "badlands"], label: "Savanna, Steppe & Badlands"
});
const WETLAND_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "environment", categoryIds: ["marsh"], label: "Wetland"
});
const OCEAN_HABITAT: CreatureBookHabitatRestriction = Object.freeze({
  groupId: "ocean_depth", categoryIds: ["shallow", "deep", "abyssal"], label: "Ocean"
});

/**
 * The biomes a mob spawns in (exactly the biomes of its spawn rules), for
 * mobs whose habitat is written inline below.
 */
function biomeHabitat(
  categoryIds: readonly WorldEnvironmentOverlayCategoryId[],
  label: string
): CreatureBookHabitatRestriction {
  return Object.freeze({ groupId: "environment", categoryIds, label });
}

/** Creature Book entries that unlock a habitat page (legendary entries have none). */
export type CreatureBookHabitatArchetypeKey = Extract<
  (typeof CREATURE_BOOK_ROSTER)[number],
  { habitatThreshold: number }
>["archetypeKey"];

/** Habitat shown once a creature's habitat threshold is reached. */
// Overworld habitats come from the land rules in mobSpawnRules.ts. A mob with no
// overworld spawn rule has an empty list (the panel then shows only its kill count).
export const CREATURE_BOOK_HABITATS: Readonly<
  Record<CreatureBookHabitatArchetypeKey, readonly CreatureBookHabitatRestriction[]>
> = Object.freeze({
  deer: [],
  frost_deer: [],
  jungle_deer: [],
  marsh_deer: [],
  sand_deer: [],
  hog: [biomeHabitat(["pinewild", "greenwood", "scrubland"], "Pinewild, Greenwood & Scrubland")],
  woolly_hog: [biomeHabitat(["frostwood"], "Frostwood")],
  warthog: [biomeHabitat(["savanna"], "Savanna")],
  jungle_hog: [],
  mud_hog: [biomeHabitat(["marsh"], "Marsh")],
  javelina: [biomeHabitat(["badlands"], "Badlands")],
  coastal_crab: [],
  ice_crab: [],
  sand_crab: [],
  mangrove_crab: [],
  frog: [WETLAND_HABITAT],
  frost_frog: [FROST_FROG_HABITAT],
  poison_frog: [POISON_FROG_HABITAT],
  desert_toad: [DESERT_TOAD_HABITAT],
  wolf: [biomeHabitat(["pinewild", "plains"], "Pinewild & Plains")],
  frost_wolf: [biomeHabitat(["frostwood", "tundra"], "Frostwood & Tundra")],
  dune_wolf: [biomeHabitat(["steppe"], "Steppe")],
  jungle_wolf: [],
  bog_wolf: [],
  bear: [biomeHabitat(["pinewild"], "Pinewild")],
  snow_bear: [biomeHabitat(["frozen_waste"], "Frozen Waste")],
  black_bear: [],
  sun_bear: [],
  squid: [OCEAN_HABITAT],
  sap_crawler: [],
  alligator: [WETLAND_HABITAT],
  caiman: [CAIMAN_HABITAT],
  crocodile: [CROCODILE_HABITAT],
  jellyfish: [OCEAN_HABITAT],
  frost_wraith: [biomeHabitat(["tundra"], "Tundra")],
  yeti: [biomeHabitat(["tundra", "frozen_waste"], "Tundra & Frozen Waste")],
  barrow_wight: [biomeHabitat(["pinewild", "frostwood"], "Pinewild & Frostwood")],
  moss_golem: [biomeHabitat(["greenwood"], "Greenwood")],
  vine_lurker: [biomeHabitat(["jungle"], "Jungle")],
  lizardfolk_warrior: [biomeHabitat(["jungle"], "Jungle")],
  bog_ghoul: [],
  giant_scorpion: [biomeHabitat(["badlands"], "Badlands")],
  dust_mummy: [biomeHabitat(["badlands"], "Badlands")],
  thunderhorn: [biomeHabitat(["savanna"], "Savanna")],
  griffin: [biomeHabitat(["plains", "highmeadow"], "Plains & Highmeadow")],
  basilisk: [biomeHabitat(["savanna", "scrubland"], "Savanna & Scrubland")],
  ogre: [],
  mysterious_traveler: [],
  jungle_tapir: [biomeHabitat(["jungle"], "Jungle")],
  jaguar: [biomeHabitat(["jungle"], "Jungle")],
  mandrill: [biomeHabitat(["jungle"], "Jungle")],
  canopy_goblin: [],
  poisonfrog_raider: [],
  pantherfolk_stalker: [],
  vine_wrapped_corpse: [],
  serpent_priestess: [],
  capercaillie: [],
  bugbear_chieftain: [],
  pinewarden: [],
  gallows_ghost: [],
  alder_king: [],
  elk: [],
  red_squirrel: [biomeHabitat(["pinewild"], "Pinewild")],
  pine_dryad: [biomeHabitat(["pinewild"], "Pinewild")],
  badger: [biomeHabitat(["greenwood"], "Greenwood")],
  grey_squirrel: [biomeHabitat(["greenwood"], "Greenwood")],
  stag_beetle: [],
  mossjaw_sneak: [],
  mossjaw_spearman: [biomeHabitat(["greenwood"], "Greenwood")],
  mossjaw_hexer: [],
  mossjaw_warboss: [],
  hedge_witch: [biomeHabitat(["greenwood"], "Greenwood")],
  restless_gravedigger: [],
  coven_matron: [],
  great_grey_owl: [biomeHabitat(["frostwood"], "Frostwood")],
  flying_squirrel: [],
  stagfolk_warden: [],
  rime_witch: [biomeHabitat(["frostwood"], "Frostwood")],
  draugr_berserker: [],
  snow_talonbear: [biomeHabitat(["frostwood"], "Frostwood")],
  frostwater_troll: [biomeHabitat(["frostwood", "tundra"], "Frostwood & Tundra")],
  underice_lurker: [biomeHabitat(["frostwood", "tundra", "frozen_waste"], "Frostwood, Tundra & Frozen Waste")],
  plains_bison: [biomeHabitat(["plains"], "Plains")],
  prairie_dog: [biomeHabitat(["plains"], "Plains")],
  burrowing_owl: [],
  centaur_outrider: [biomeHabitat(["plains", "steppe"], "Plains & Steppe")],
  volt_elemental: [biomeHabitat(["plains"], "Plains")],
  possessed_scythe: [],
  strawman_lord: [],
  giraffe: [biomeHabitat(["savanna"], "Savanna")],
  lioness: [biomeHabitat(["savanna"], "Savanna")],
  spotted_hyena: [biomeHabitat(["savanna"], "Savanna")],
  gnoll_bonebow: [biomeHabitat(["savanna"], "Savanna")],
  gnoll_packseer: [],
  gnoll_packlord: [],
  carrion_ghoul: [],
  sun_griffin: [],
  sitatunga: [],
  emperor_dragonfly: [],
  frogfolk_tadpole: [biomeHabitat(["marsh"], "Marsh")],
  frogfolk_blowgunner: [biomeHabitat(["marsh"], "Marsh")],
  frogfolk_shaman: [],
  frogfolk_chief: [],
  bloat_leech: [biomeHabitat(["marsh"], "Marsh")],
  bog_hag: [biomeHabitat(["marsh"], "Marsh")],
  leech_mother: [biomeHabitat(["marsh"], "Marsh")],
  mountain_ibex: [biomeHabitat(["highmeadow"], "Highmeadow")],
  wild_yak: [biomeHabitat(["highmeadow"], "Highmeadow")],
  alpine_marmot: [biomeHabitat(["highmeadow"], "Highmeadow")],
  yakfolk_stonehorn: [],
  highland_reaver: [],
  storm_harpy: [biomeHabitat(["highmeadow"], "Highmeadow")],
  cairn_wight: [],
  stormwing_chick: [],
  wild_scrub_goat: [biomeHabitat(["scrubland"], "Scrubland")],
  crested_porcupine: [biomeHabitat(["scrubland"], "Scrubland")],
  spur_thighed_tortoise: [biomeHabitat(["scrubland"], "Scrubland")],
  cyclops_shepherd: [biomeHabitat(["scrubland"], "Scrubland")],
  skeleton_hoplite: [],
  tar_elemental: [],
  olive_dryad: [biomeHabitat(["scrubland"], "Scrubland")],
  chimera: [],
  dromedary: [biomeHabitat(["badlands"], "Badlands")],
  fennec_fox: [biomeHabitat(["badlands"], "Badlands")],
  sidewinder: [biomeHabitat(["badlands"], "Badlands")],
  desert_lion: [],
  jackalfolk_skirmisher: [],
  dune_goblin: [],
  desert_marauder: [],
  scorch_troll: [],
  saiga: [biomeHabitat(["steppe"], "Steppe")],
  wild_horse: [biomeHabitat(["plains", "steppe"], "Plains & Steppe")],
  steppe_marmot: [biomeHabitat(["steppe"], "Steppe")],
  steppe_raider: [],
  steppe_horse_archer: [],
  salt_husk: [],
  kurgan_wight: [biomeHabitat(["steppe"], "Steppe")],
  lemming: [biomeHabitat(["frozen_waste"], "Frozen Waste")],
  snow_goose: [biomeHabitat(["tundra"], "Tundra")],
  frostborn_runecaster: [],
  frostborn_jarl: [],
  permafrost_elemental: [biomeHabitat(["tundra"], "Tundra")],
  draugr: [],
  emperor_penguin: [],
  peary_caribou: [],
  ice_worm: [],
  rime_troll: [biomeHabitat(["frozen_waste"], "Frozen Waste")],
  aurora_shade: [biomeHabitat(["frozen_waste"], "Frozen Waste")],
  sea_otter: [biomeHabitat(["pinewild", "greenwood", "frostwood", "plains", "marsh", "highmeadow", "scrubland", "steppe", "tundra", "frozen_waste"], "Pinewild, Greenwood, Frostwood, Plains, Marsh, Highmeadow, Scrubland, Steppe, Tundra & Frozen Waste")],
  herring_gull: [],
  spiny_lobster: [biomeHabitat(["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe"], "Jungle, Pinewild, Greenwood, Plains, Savanna, Marsh, Highmeadow, Scrubland, Badlands & Steppe")],
  gillfolk_scout: [],
  gillfolk_netter: [],
  coral_golem: [biomeHabitat(["jungle", "savanna", "marsh", "scrubland", "badlands"], "Jungle, Savanna, Marsh, Scrubland & Badlands")],
  drowned_deckhand: [],
  reef_kraken: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  hammerhead_shark: [biomeHabitat(["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe"], "Jungle, Pinewild, Greenwood, Plains, Savanna, Marsh, Highmeadow, Scrubland, Badlands & Steppe")],
  manta_ray: [biomeHabitat(["jungle", "savanna", "marsh", "scrubland", "badlands"], "Jungle, Savanna, Marsh, Scrubland & Badlands")],
  humpback_whale: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  merfolk_harpooner: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  phantom_lookout: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  maelstrom_spirit: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  sea_serpent: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  kraken: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  muskellunge: [biomeHabitat(["pinewild", "greenwood", "frostwood", "plains", "highmeadow"], "Pinewild, Greenwood, Frostwood, Plains & Highmeadow")],
  mute_swan: [biomeHabitat(["pinewild", "greenwood", "plains", "marsh", "highmeadow", "scrubland", "steppe"], "Pinewild, Greenwood, Plains, Marsh, Highmeadow, Scrubland & Steppe")],
  drowned_bride: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  lake_maiden: [biomeHabitat(["pinewild", "greenwood", "plains", "marsh", "highmeadow", "scrubland", "steppe"], "Pinewild, Greenwood, Plains, Marsh, Highmeadow, Scrubland & Steppe")],
  elder_mere_serpent: [biomeHabitat(["pinewild", "greenwood", "frostwood", "plains", "marsh", "highmeadow", "steppe", "tundra"], "Pinewild, Greenwood, Frostwood, Plains, Marsh, Highmeadow, Steppe & Tundra")],
  northern_pike: [biomeHabitat(["pinewild", "greenwood", "frostwood", "plains", "marsh", "highmeadow", "steppe", "tundra"], "Pinewild, Greenwood, Frostwood, Plains, Marsh, Highmeadow, Steppe & Tundra")],
  snapping_turtle: [biomeHabitat(["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "scrubland"], "Jungle, Pinewild, Greenwood, Plains, Savanna, Marsh & Scrubland")],
  drowned_thrall: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  beaver: [biomeHabitat(["pinewild", "greenwood", "frostwood", "plains", "marsh", "highmeadow", "steppe", "tundra"], "Pinewild, Greenwood, Frostwood, Plains, Marsh, Highmeadow, Steppe & Tundra")],
  river_otter: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "steppe", "tundra"], "Jungle, Pinewild, Greenwood, Frostwood, Plains, Savanna, Marsh, Highmeadow, Scrubland, Steppe & Tundra")],
  river_salmon: [biomeHabitat(["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "tundra"], "Pinewild, Greenwood, Frostwood, Plains, Highmeadow & Tundra")],
  kappa: [biomeHabitat(["jungle", "pinewild", "greenwood", "plains", "marsh", "highmeadow", "scrubland"], "Jungle, Pinewild, Greenwood, Plains, Marsh, Highmeadow & Scrubland")],
  kappa_brawler: [biomeHabitat(["jungle", "pinewild", "greenwood", "plains", "marsh", "highmeadow", "scrubland"], "Jungle, Pinewild, Greenwood, Plains, Marsh, Highmeadow & Scrubland")],
  bridge_troll: [biomeHabitat(["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "frozen_waste"], "Jungle, Pinewild, Greenwood, Plains, Savanna, Marsh, Highmeadow, Scrubland, Badlands, Steppe & Frozen Waste")],
  nixie: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "steppe", "tundra"], "Jungle, Pinewild, Greenwood, Frostwood, Plains, Savanna, Marsh, Highmeadow, Scrubland, Steppe & Tundra")],
  rapids_elemental: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  shellback: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  darter: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  ink_pool: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  drowned_citizen: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  tide_wraith: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  gate_warden: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  drowned_cultist: [biomeHabitat(["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"], "All biomes")],
  dire_wolf: [],
  moss_troll: [biomeHabitat(["pinewild"], "Pinewild")],
  woolly_mammoth: [biomeHabitat(["steppe", "tundra"], "Steppe & Tundra")],
  ash_drake: [biomeHabitat(["badlands"], "Badlands")],
  ember_dragon: [],
  snapjaw_flytrap: [biomeHabitat(["jungle"], "Jungle")],
  cairn_golem: [biomeHabitat(["highmeadow", "steppe"], "Highmeadow & Steppe")],
  giant_larva: [],
  field_hare: [biomeHabitat(["pinewild", "greenwood", "plains", "scrubland"], "Pinewild, Greenwood, Plains & Scrubland")],
  arctic_hare: [biomeHabitat(["frostwood", "tundra", "frozen_waste"], "Frostwood, Tundra & Frozen Waste")],
  capybara: [biomeHabitat(["jungle", "marsh"], "Jungle & Marsh")],
  armadillo: [biomeHabitat(["jungle", "badlands"], "Jungle & Badlands")],
  red_fox: [biomeHabitat(["greenwood"], "Greenwood")],
  wolverine: [biomeHabitat(["frostwood", "highmeadow"], "Frostwood & Highmeadow")],
  ostrich: [biomeHabitat(["savanna"], "Savanna")],
  golden_eagle: [biomeHabitat(["highmeadow"], "Highmeadow")],
  musk_ox: [biomeHabitat(["tundra", "frozen_waste"], "Tundra & Frozen Waste")],
  seal: [biomeHabitat(["frozen_waste"], "Frozen Waste")]
});

/**
 * Plant entries live beside the established creature roster so future plants
 * only need a catalog row and the matching authoritative harvest key.
 */
export const PLANT_BOOK_ROSTER = Object.freeze([
  {
    bookOrder: 0,
    plantKey: "flax",
    name: "Wild Flax",
    itemId: "flax_fiber",
    harvestQuantity: FLAX_FIBER_HARVEST_YIELD_QUANTITY,
    rarity: "common",
    habitatThreshold: 5,
    habitatRestrictions: [{
      groupId: "environment",
      categoryIds: [
        "jungle",
        "pinewild",
        "greenwood",
        "plains",
        "savanna",
        "marsh"
      ],
      label: "Ordinary temperate land; wetlands reduced"
    }]
  }
] as const satisfies readonly Readonly<{
  bookOrder: number;
  plantKey: string;
  name: string;
  itemId: ResourceType;
  harvestQuantity: number;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  habitatThreshold: number;
  habitatRestrictions: readonly CreatureBookHabitatRestriction[];
}>[]);

export type CreatureBookDropSnapshot =
  | Readonly<{ slotOrder: number; observed: false }>
  | Readonly<{
      slotOrder: number;
      observed: true;
      itemId: string;
      displayName: string;
      occurrenceCount: number;
      observedRate: number;
    }>;

export type PlantBookKey = (typeof PLANT_BOOK_ROSTER)[number]["plantKey"];

export type PlantBookSlotSnapshot =
  | Readonly<{ bookOrder: number; unlocked: false }>
  | Readonly<{
      bookOrder: number;
      unlocked: true;
      plantKey: PlantBookKey;
      name: string;
      rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
      active: number;
      totalHarvests: number;
      habitat: Readonly<{
        kind: "natural";
        progress: number;
        threshold: number;
        restrictions: readonly CreatureBookHabitatRestriction[] | null;
      }>;
    }>;

/** Compatibility alias for callers that name the section explicitly. */
export type CreatureBookPlantSlotSnapshot = PlantBookSlotSnapshot;

export type CreatureBookSlotSnapshot =
  | Readonly<{ bookOrder: number; unlocked: false }>
  | Readonly<{
      bookOrder: number;
      unlocked: true;
      archetypeKey: MobArchetypeKey;
      name: string;
      rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
      /** Legacy wire field, always false: older clients still require it. */
      ashenUnlocked: boolean;
      habitat:
        | Readonly<{
            kind: "natural";
            progress: number;
            threshold: number;
            restrictions: readonly CreatureBookHabitatRestriction[] | null;
            active: "any_time" | "day" | "night";
          }>
        | Readonly<{ kind: "legendary"; habitat: "N/A"; active: "any_time" }>;
      killCount: number | null;
      drops: readonly CreatureBookDropSnapshot[];
    }>;

export type CreatureBookSnapshot = Readonly<{
  slots: readonly CreatureBookSlotSnapshot[];
  /** Optional on the wire for forward compatibility with pre-Encyclopedia clients. */
  plants?: readonly PlantBookSlotSnapshot[];
}>;
