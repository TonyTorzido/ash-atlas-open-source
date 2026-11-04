import { describe, expect, it } from "vitest";

import {
  POPULATION_V2_RESOURCE_KIND_DEFINITIONS,
  createPopulationV2KindRegistry,
  populationV2KindHabitatPolicyMatches,
  validatePopulationV2KindDefinitions
} from "./populationV2KindRegistry.js";
import { populationV2MobRegistry } from "./populationV2MobRegistry.js";

describe("Population V2 kind registry", () => {
  it("routes mobs, generated trees, and permanent nodes through one contract", () => {
    const registry = populationV2MobRegistry.populationKinds;

    expect(registry.definitions.map((definition) => definition.kindKey))
      .toEqual([
        "alder_king",
        "alligator",
        "alpine_marmot",
        "arctic_hare",
        "armadillo",
        "ash_drake",
        "aurora_shade",
        "badger",
        "bandit",
        "barrow_wight",
        "basilisk",
        "bear",
        "beaver",
        "black_bear",
        "blizzard_lord",
        "bloat_leech",
        "bog_ghoul",
        "bog_hag",
        "bog_wolf",
        "bridge_troll",
        "bugbear_chieftain",
        "burrowing_owl",
        "caiman",
        "cairn_golem",
        "cairn_wight",
        "canopy_goblin",
        "capercaillie",
        "capybara",
        "carrion_ghoul",
        "centaur_khan",
        "centaur_outrider",
        "chimera",
        "coal",
        "coastal_crab",
        "coral_golem",
        "coven_matron",
        "crested_porcupine",
        "crocodile",
        "cyclops_shepherd",
        "darter",
        "deer",
        "desert_lion",
        "desert_marauder",
        "desert_toad",
        "dire_wolf",
        "draugr",
        "draugr_berserker",
        "dromedary",
        "drowned_bride",
        "drowned_citizen",
        "drowned_cultist",
        "drowned_deckhand",
        "drowned_thrall",
        "dune_goblin",
        "dune_wolf",
        "dust_mummy",
        "elder_mere_serpent",
        "elk",
        "ember_dragon",
        "ember_giant",
        "emperor_dragonfly",
        "emperor_penguin",
        "fennec_fox",
        "field_hare",
        "flax",
        "flying_squirrel",
        "frog",
        "frogfolk_blowgunner",
        "frogfolk_chief",
        "frogfolk_shaman",
        "frogfolk_tadpole",
        "frost_deer",
        "frost_frog",
        "frost_wolf",
        "frost_wraith",
        "frostborn_jarl",
        "frostborn_runecaster",
        "frostwater_troll",
        "gallows_ghost",
        "gate_warden",
        "giant_larva",
        "giant_scorpion",
        "gillfolk_netter",
        "gillfolk_scout",
        "giraffe",
        "gnoll_bonebow",
        "gnoll_packlord",
        "gnoll_packseer",
        "golden_eagle",
        "great_grey_owl",
        "grey_squirrel",
        "griffin",
        "hammerhead_shark",
        "hedge_witch",
        "herring_gull",
        "highland_reaver",
        "hog",
        "hollin_hut",
        "humpback_whale",
        "ice_crab",
        "ice_worm",
        "ink_pool",
        "iron",
        "jackalfolk_skirmisher",
        "jaguar",
        "javelina",
        "jellyfish",
        "jungle_deer",
        "jungle_hog",
        "jungle_tapir",
        "jungle_wolf",
        "kappa",
        "kappa_brawler",
        "kraken",
        "kurgan_wight",
        "lake_maiden",
        "leech_mother",
        "lemming",
        "lioness",
        "lizardfolk_warrior",
        "maelstrom_spirit",
        "mammoth_patriarch",
        "mandrill",
        "mangrove_crab",
        "manta_ray",
        "marsh_deer",
        "merfolk_harpooner",
        "moss_golem",
        "moss_troll",
        "mossjaw_hexer",
        "mossjaw_sneak",
        "mossjaw_spearman",
        "mossjaw_warboss",
        "mountain_ibex",
        "mud_hog",
        "musk_ox",
        "muskellunge",
        "mute_swan",
        "mysterious_traveler",
        "nixie",
        "northern_pike",
        "ogre",
        "olive_dryad",
        "orc_brute",
        "ostrich",
        "pantherfolk_stalker",
        "peary_caribou",
        "permafrost_elemental",
        "phantom_lookout",
        "pine_dryad",
        "pinewarden",
        "plains_bison",
        "poison_frog",
        "poisonfrog_raider",
        "possessed_scythe",
        "prairie_dog",
        "rapids_elemental",
        "red_fox",
        "red_squirrel",
        "reef_kraken",
        "restless_gravedigger",
        "rime_troll",
        "rime_witch",
        "river_otter",
        "river_salmon",
        "saiga",
        "salt_husk",
        "sand_crab",
        "sand_deer",
        "sap_crawler",
        "scorch_troll",
        "sea_otter",
        "sea_serpent",
        "seal",
        "serpent_priestess",
        "shellback",
        "sidewinder",
        "sitatunga",
        "skeleton",
        "skeleton_hoplite",
        "snapjaw_flytrap",
        "snapping_turtle",
        "snow_bear",
        "snow_goose",
        "snow_talonbear",
        "spiny_lobster",
        "spotted_hyena",
        "spur_thighed_tortoise",
        "squid",
        "stag_beetle",
        "stagfolk_warden",
        "steppe_horse_archer",
        "steppe_marmot",
        "steppe_raider",
        "stone",
        "storm_harpy",
        "stormwing",
        "stormwing_chick",
        "strawman_lord",
        "sulfur",
        "sun_bear",
        "sun_griffin",
        "tar_elemental",
        "thunderhorn",
        "tide_wraith",
        "tree",
        "underice_lurker",
        "vine_lurker",
        "vine_wrapped_corpse",
        "volt_elemental",
        "warthog",
        "wild_horse",
        "wild_scrub_goat",
        "wild_yak",
        "wolf",
        "wolverine",
        "woolly_hog",
        "woolly_mammoth",
        "yakfolk_stonehorn",
        "yeti"
      ]);
    expect(registry.requireDefinition("deer")).toMatchObject({
      category: "mob",
      lifecyclePolicy: "GENERATION_SCOPED",
      projectionAdapter: "combat_mob",
      interactionAuthorityAdapter: "combat_engine",
      requiresRuntimeActor: true
    });
    expect(registry.requireDefinition("tree")).toMatchObject({
      category: "harvestable_plant_tree",
      lifecyclePolicy: "GENERATION_SCOPED",
      projectionAdapter: "generated_tree",
      interactionAuthorityAdapter: "tree_harvest",
      requiresRuntimeActor: false
    });
    expect(registry.requireDefinition("stone")).toMatchObject({
      category: "permanent_repeatable_node",
      lifecyclePolicy: "PERMANENT_REPEATABLE",
      projectionAdapter: "permanent_resource",
      interactionAuthorityAdapter: "permanent_resource",
      requiresRuntimeActor: false
    });
    expect(registry.requireDefinition("coal")).toMatchObject({
      category: "permanent_repeatable_node",
      projectionAdapter: "permanent_resource"
    });
    expect(registry.requireDefinition("iron")).toMatchObject({
      category: "permanent_repeatable_node",
      projectionAdapter: "permanent_resource"
    });
    expect(registry.requireDefinition("sulfur")).toMatchObject({
      category: "permanent_repeatable_node",
      placementRevision: "ocean-sulfur-placement-v1",
      lifecyclePolicy: "PERMANENT_REPEATABLE",
      projectionAdapter: "permanent_resource",
      interactionAuthorityAdapter: "permanent_resource",
      requiresRuntimeActor: false
    });
    expect(registry.revision).toMatch(
      /^population-kind-registry-v2:[a-f0-9]{16}$/u
    );
  });

  it("makes the registry revision sensitive to per-kind contracts", () => {
    const tree = POPULATION_V2_RESOURCE_KIND_DEFINITIONS.find(
      (definition) => definition.kindKey === "tree"
    )!;
    const current = createPopulationV2KindRegistry([tree]);
    const revised = createPopulationV2KindRegistry([{
      ...tree,
      placementRevision: "legacy-generated-tree-placement-v2"
    }]);

    expect(revised.revision).not.toBe(current.revision);
  });

  it("offers the shared shoreline policy seam to content definitions", () => {
    const tree = POPULATION_V2_RESOURCE_KIND_DEFINITIONS.find(
      (definition) => definition.kindKey === "tree"
    )!;
    const shorelineTree = {
      ...tree,
      kindKey: "shore_tree",
      habitatPolicy: {
        requiredFacts: { isRiverbank: true },
        requiredPlacementTags: ["riverbank"]
      }
    } as const;
    expect(populationV2KindHabitatPolicyMatches(
      shorelineTree,
      {
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        isRiverbank: true,
        placementTags: ["land", "riverbank"]
      }
    )).toBe(true);
    expect(populationV2KindHabitatPolicyMatches(
      shorelineTree,
      {
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        isRiverbank: false,
        placementTags: ["land"]
      }
    )).toBe(false);
  });

  it("rejects incomplete, duplicate, non-atomic, or ticking decoration kinds", () => {
    const tree = POPULATION_V2_RESOURCE_KIND_DEFINITIONS.find(
      (definition) => definition.kindKey === "tree"
    )!;
    expect(() => validatePopulationV2KindDefinitions([tree, tree]))
      .toThrow(/duplicate.*kind/i);
    expect(() => validatePopulationV2KindDefinitions([{
      ...tree,
      kindKey: "grouped_plant",
      groupPolicy: { model: "group", atomic: false }
    }])).toThrow(/must be atomic/i);
    expect(() => validatePopulationV2KindDefinitions([{
      ...tree,
      kindKey: "visual_grass",
      category: "noninteractive_decoration",
      lifecyclePolicy: "STATIC_DECORATION",
      interactionAuthorityAdapter: "none",
      requiresRuntimeActor: true
    }])).toThrow(/cannot own gameplay/i);
  });
});
