import { CREATURE_BOOK_ROSTER } from "./creatureBook.js";
import { MOB_BIOME_VARIANT_FAMILIES, type MobBiomeVariantFamilyBase } from "./mobContracts.js";
import { BITTER_BLOOD_ACHIEVEMENT_ID, BITTER_BLOOD_POISON_DAMAGE_REQUIRED, POISON_DAMAGE_TAKEN_STAT_KEY } from "./achievements.js";
import { professionMaxRank, type ProfessionId } from "./masteries.js";
import { CURRENT_LEVEL_CAP } from "./progression.js";
import type {
  LegendCategory, LegendDefinition, LegendDifficulty, LegendMetric, LegendObjective
} from "./legends.js";

const objective = (metric: LegendMetric, target: number, label: string, hint: string): LegendObjective =>
  ({ metric, target, label, hint });

function achievement(
  key: string, title: string, description: string, category: LegendCategory,
  difficulty: LegendDifficulty, points: number, objectives: readonly LegendObjective[], honor?: string
): LegendDefinition {
  return {
    id: `legend_${key}`, title, description, kind: "achievement", category,
    difficulty, points, objectives, ...(honor ? { honor } : {})
  };
}

type CreatureKey = (typeof CREATURE_BOOK_ROSTER)[number]["archetypeKey"];
const creatureNames = Object.fromEntries(CREATURE_BOOK_ROSTER.map((entry) => [entry.archetypeKey, entry.name]));

const kill = (key: CreatureKey, target: number): LegendObjective => objective(
  `kills_${key}`, target, `Defeat ${target} ${creatureNames[key]}`,
  `Earn credited defeats of ${creatureNames[key]}. Your earlier credited defeats count.`
);
/** A family's base creature or any of its biome variants (e.g. Wolf, Frost Wolf, Dune Wolf). */
const familyKill = (base: MobBiomeVariantFamilyBase, target: number): LegendObjective => {
  const names = MOB_BIOME_VARIANT_FAMILIES[base].map((key) => creatureNames[key]);
  return objective(
    `kills_${base}_family`, target, `Defeat ${target} ${creatureNames[base]} of any kind`,
    `Earn credited defeats of ${names.slice(0, -1).join(", ")}, or ${names.at(-1)}. Your earlier credited defeats count.`
  );
};
const gather = (
  resource: "wood" | "stone" | "iron" | "coal" | "sulfur" | "flax_fiber",
  target: number
): LegendObjective => {
  const name = { wood: "Wood", stone: "Stone", iron: "Iron Ore", coal: "Coal", sulfur: "Sulfur", flax_fiber: "Wild Flax" }[resource];
  return objective(`harvest_${resource}`, target, `Complete ${target} ${name} harvests`,
    "Counts completed gathering actions, regardless of the quantity each action yields.");
};
const bars = (target: number) => objective("smelted_bars", target, `Collect ${target} successfully smelted bars`,
  "Collect finished bars from your Furnace. Successful Slag recovery counts; cores and failed iron smelts do not.");
const smeltVariety = (target: number) => objective("smelt_recipe_types", target, `Collect output from ${target} Furnace recipes`,
  "Collect successful output from different Furnace recipes, including cores and Slag recovery.");
const cloth = (target: number) => objective("cloth_woven", target, `Collect ${target} Cloth from your Loom`,
  "Weave Flax Fiber at your Loom and collect the finished Cloth.");
const meals = (target: number) => objective("meals_cooked", target, `Collect ${target} Simple Food from your Kitchen`,
  "Cook ingredients at your Kitchen, then collect the finished Simple Food.");
const kitchenVariety = (target: number) => objective("kitchen_recipe_types", target, `Collect food made from ${target} different ingredients`,
  "Different ingredient recipes count separately, even though each produces Simple Food.");
const leather = (target: number) => objective("leather_made", target, `Collect ${target} Leather from your Tannery`,
  "Tan a rare Deer Hide, Hog Hide, Wolf Pelt, Bear Hide, or Alligator Hide. Ordinary Leather drops do not count.");
const seen = (target: number) => objective("species_seen", target, `Discover ${target} creature species`,
  "Encounter different creatures to reveal their entries in the Encyclopedia.");
const defeated = (target: number) => objective("species_defeated", target, `Defeat ${target} different creature species`,
  "Each Encyclopedia creature species counts once, including legendary creatures.");
const habitats = (target: number) => objective("habitats_mastered", target, `Reveal ${target} creature habitat records`,
  "Meet the Encyclopedia defeat threshold for each natural creature. Legendary creatures have no habitat threshold.");
const drops = (target: number) => objective("drop_types", target, `Record ${target} different creature drops`,
  "Earn different item drops from credited creature encounters. Repeated copies count as one type.");
const birds = (target: number) => objective("legendary_bird_species", target, `Defeat ${target} different legendary Bird species`,
  "The Fire Bird, Lightning Bird, and Ice Bird each count once.");
const rings = (target: number) => objective("xoral_ring_types", target, `Record ${target} different Xoral Ring drops`,
  "Earn Chopping Ring, Mining Ring, and Attack Ring drops from credited Xoral encounters. Buying a ring does not count.");
const wardens = (target: number) => objective("sewer_wardens_defeated", target, `Record ${target} distinct credited Rat Warden defeats`,
  "Contribute damage against the Rat Warden in different Cistern Warrenss. An encounter counts once; revisiting an already credited encounter adds no progress.");
const regions = (target: number) => objective("biomes_discovered", target, `Discover ${target} world regions`,
  "Travel the open world; each of the 16 named regions counts the first time you stand in it.");
const level = (target: number) => objective("level", target, `Reach character level ${target}`,
  "Gain character XP through play. Once this journal entry is earned, it stays earned.");
const masters = (target: number) => objective("profession_masters", target, `Master ${target} different professions`,
  "Reach the maximum rank in different professions.");

const professionNames: Record<ProfessionId, string> = {
  woodcutter: "Woodcutter", miner: "Miner", builder: "Builder",
  oil_worker: "Oil Worker", metallurgy: "Metallurgy"
};
const professionHints: Record<ProfessionId, string> = {
  woodcutter: "Earn Woodcutter XP by gathering Wood.",
  miner: "Earn Miner XP through mining.",
  builder: "Earn Builder XP through construction, flag building, and reinforcement.",
  oil_worker: "Earn Oil Worker XP through Oil Well work.",
  metallurgy: "Earn Metallurgy XP by smelting Iron Ore; both successful and failed attempts teach you."
};
const profession = (key: ProfessionId, rank: number): LegendObjective => objective(
  `profession_${key}`, rank,
  `Reach ${professionNames[key]} rank ${rank}`,
  professionHints[key]
);

/**
 * Hunt achievement names per Creature Book species. Optional: a species without
 * names has no hunt achievements (hunts are added only on the owner's request).
 */
const huntNames: Readonly<Partial<Record<CreatureKey, readonly [string, string, string]>>> = {
  deer: ["A Stag Beginning", "Antler Etiquette", "The Hart of the Matter"],
  frost_deer: ["Cold Feet", "Frost Bitten", "A Winter's Tale"],
  jungle_deer: ["Into the Thicket", "Canopy Chase", "King of the Jungle"],
  marsh_deer: ["Bog Standard", "Wading In", "Swamped with Success"],
  sand_deer: ["Sand Trap", "Dune Deal", "Mirage No More"],
  hog: ["Hog Wild", "Boar of Directors", "Whole Hog"],
  woolly_hog: ["Pulling the Wool", "Fleece Lightning", "Wool Over Their Eyes"],
  warthog: ["Warts and All", "Tusk Force", "The Grassland Grunt"],
  jungle_hog: ["Root and Branch", "Snout of Bounds", "Truffle Shuffle"],
  mud_hog: ["Mud Slinger", "Pig in Clover", "Clear as Mud"],
  javelina: ["Prickly Customer", "Cactus Crunch", "Desert Bristle"],
  coastal_crab: ["A Pinch of Courage", "Claws for Applause", "Shell We Dance?"],
  ice_crab: ["Cold Claws", "Pinch of Frost", "Frozen Pincers"],
  sand_crab: ["Sandy Claws", "Beach Brawl", "Sidestep the Tide"],
  mangrove_crab: ["Root Cause", "Tangled Up", "King of the Mangroves"],
  frog: ["A Hop of Faith", "Leap Year", "Croak and Dagger"],
  frost_frog: ["Chill Hop", "Frog in a Blizzard", "Thaw and Order"],
  poison_frog: ["Bright Warning", "Toxic Relationship", "Venom and Victory"],
  desert_toad: ["Toad Trip", "Dry Spell", "Oasis of Calm"],
  wolf: ["Who's Afraid?", "Pack a Punch", "Howl of Fame"],
  frost_wolf: ["Cold Snap", "Winter Is Howling", "Leader of the Frost Pack"],
  dune_wolf: ["Dust Devil", "Howl at the Sun", "Lord of the Dunes"],
  jungle_wolf: ["Call of the Wild", "Vine and Dandy", "Apex of the Canopy"],
  bog_wolf: ["Bogged Down", "Mire Trouble", "Howl from the Hollow"],
  bear: ["Bear Witness", "Grin and Bear It", "Unbearably Good"],
  snow_bear: ["Polar Opposite", "Snow Problem", "Ice to Meet You"],
  black_bear: ["Into the Black", "Bark and Bite", "Black Belt"],
  sun_bear: ["Sunny Disposition", "Honey Trap", "A Moment in the Sun"],
  squid: ["Inkling of Trouble", "Armed and Dangerous", "Inkredible"],
  sap_crawler: ["Sticky Situation", "Resin to Believe", "Sap Happens"],
  alligator: ["See You Later", "Jawbreaker", "The Last Laugh"],
  caiman: ["Caiman Through", "Snap Judgement", "River Royalty"],
  crocodile: ["Crocodile Smile", "Tears of a Croc", "Croc of Ages"],
  jellyfish: ["A Sting in the Tale", "Jelly Good Show", "Crown of Tentacles"],
  frost_wraith: ["Chilling Encounter", "Spirits on Ice", "Warden of the Wastes"],
  yeti: ["Big Footprints", "Abominable Odds", "Myth Busted"],
  barrow_wight: ["Grave Matters", "Mound Rounds", "Barrow Breaker"],
  moss_golem: ["Rolling Stone", "Gathering No Moss", "Overgrown Victory"],
  vine_lurker: ["Out on a Vine", "Tangled Webs", "Weed Whacker"],
  lizardfolk_warrior: ["Cold-Blooded Start", "Scale of Battle", "Sovereign of Scales"],
  bog_ghoul: ["Ghoul Intentions", "Swamp Thing", "Fen Fright Night"],
  giant_scorpion: ["Tail Spin", "Sting Operation", "Scorpion King"],
  dust_mummy: ["Under Wraps", "That's a Wrap", "Dust to Dust"],
  thunderhorn: ["Rolling Thunder", "Horns of Plenty", "Stampede Stopper"],
  griffin: ["Taking Wing", "Feather in Your Cap", "Lord of the Heights"],
  basilisk: ["Stone Cold Stare", "Don't Look Now", "Gaze Breaker"],
  ogre: ["Ogre and Out", "Big Shoes to Fill", "Giant Reputation"],
  mysterious_traveler: ["Stranger Danger", "Unfamiliar Company", "End of the Road"],
  fire_bird: ["Playing with Fire", "A Flare for Drama", "Ashes to Applause"],
  lightning_bird: ["Thunderstruck", "Bolt from the Blue", "Thunder Without End"],
  ice_bird: ["Breaking the Ice", "Cold Front", "The Final Thaw"],
  xoral: ["The Tree Fights Back", "Root of the Problem", "A Legend Takes Root"]
};

const huntTiers = {
  common: { targets: [1, 25, 250], points: [5, 20, 50], difficulties: ["Adventurer", "Veteran", "Elite"] },
  uncommon: { targets: [1, 10, 100], points: [10, 30, 60], difficulties: ["Adventurer", "Veteran", "Master"] },
  rare: { targets: [1, 5, 50], points: [20, 40, 75], difficulties: ["Veteran", "Elite", "Master"] },
  epic: { targets: [1, 3, 20], points: [30, 55, 90], difficulties: ["Elite", "Master", "Legend"] },
  legendary: { targets: [1, 3, 10], points: [45, 75, 100], difficulties: ["Elite", "Master", "Legend"] }
} as const;

/** Honor title for a legendary species' last hunt. */
const legendaryHuntHonors: Readonly<Partial<Record<CreatureKey, string>>> = {
  fire_bird: "Ember Chronicler", lightning_bird: "Thunder Chronicler",
  ice_bird: "Frost Chronicler", xoral: "Rootbound Legend"
};

const huntingAchievements: LegendDefinition[] = CREATURE_BOOK_ROSTER.flatMap((creature) => {
  const tier = huntTiers[creature.rarity];
  const names = huntNames[creature.archetypeKey];
  if (names === undefined) return [];
  return tier.targets.map((target, index) => achievement(
    `hunt_${creature.archetypeKey}_${index + 1}`, names[index]!,
    index === 0 ? `Give your ${creature.name} chapter its first victory.`
      : index === 1 ? `Turn a memorable encounter into a practiced pursuit.`
        : `Leave a lasting record in the ${creature.name} chapter.`,
    creature.rarity === "legendary" ? "Legends" : "Hunting",
    tier.difficulties[index]!, tier.points[index]!, [kill(creature.archetypeKey, target)],
    index === 2 && creature.rarity === "legendary" ? legendaryHuntHonors[creature.archetypeKey] : undefined
  ));
});

const professionAchievements: LegendDefinition[] = (
  [
    ["woodcutter", "Getting into the Swing", "Against the Grain", "Keeper of the Grain"],
    ["miner", "A Vein of Talent", "Rock Solid", "Deep Delver"],
    ["builder", "Firm Foundations", "Built to Last", "Foundation Keeper"],
    ["oil_worker", "Well Begun", "Well Worth It", "Well Keeper"],
    ["metallurgy", "Trial by Furnace", "Metal of Honor", "Furnace Scholar"]
  ] as const
).flatMap(([key, firstTitle, finalTitle, honor]) => [
  achievement(`profession_${key}_apprentice`, firstTitle,
    `Find your footing in ${professionNames[key]}.`, "Mastery", "Veteran", 25,
    [profession(key, 2)]),
  achievement(`profession_${key}_master`, finalTitle,
    `Complete the ${professionNames[key]} profession track.`, "Mastery", "Legend", 100,
    [profession(key, professionMaxRank(key))], honor)
]);

type JourneyChapter = Readonly<{
  title: string; description: string; difficulty: LegendDifficulty;
  points: number; objectives: readonly LegendObjective[];
}>;
function journey(
  key: string, title: string, category: LegendCategory, honor: string,
  chapters: readonly [JourneyChapter, JourneyChapter, JourneyChapter]
): LegendDefinition[] {
  return chapters.map((chapter, index) => ({
    ...chapter, id: `legend_quest_${key}_${index + 1}`, kind: "quest", category,
    journey: { id: `legend_journey_${key}`, title, chapter: index + 1, chapters: chapters.length },
    ...(index > 0 ? { requires: [`legend_quest_${key}_${index}`] } : {}),
    ...(index === chapters.length - 1 ? { honor } : {})
  }));
}

/**
 * Journal points and honors are collectible records only: no currency, XP,
 * equipment, inventory items, or equippable character titles are awarded here.
 * Objectives use retained lifetime records and can complete retroactively.
 */
export const LEGEND_CATALOG: readonly LegendDefinition[] = Object.freeze([
  {
    id: BITTER_BLOOD_ACHIEVEMENT_ID,
    title: "Bitter Blood",
    description: "The venom leaves its mark. Turn a hard-earned poison record into a new path through the forge.",
    kind: "achievement", category: "Mastery", difficulty: "Veteran", points: 25,
    completionAuthority: "gameplay",
    objectives: [objective(POISON_DAMAGE_TAKEN_STAT_KEY, BITTER_BLOOD_POISON_DAMAGE_REQUIRED,
      `Take ${BITTER_BLOOD_POISON_DAMAGE_REQUIRED} poison damage`,
      "Poison damage actually taken during combat counts toward this lifetime goal. Earlier recorded damage counts.")],
    reward: "Unlocks Venom Core application and eligibility to equip Venomsteel gear."
  },
  ...huntingAchievements,
  achievement("bounty_forest_friends", "Not Quite a Picnic", "The woodland welcoming committee has teeth.", "Hunting", "Veteran", 30,
    [familyKill("deer", 5), familyKill("hog", 5), familyKill("wolf", 5)]),
  achievement("bounty_big_teeth", "Dental Plan", "Take a closer look at three very different sets of teeth.", "Hunting", "Elite", 50,
    [familyKill("wolf", 10), familyKill("bear", 5), familyKill("alligator", 3)]),
  achievement("bounty_seafood", "Catch of the Day", "Build a coastal hunting record, one awkward encounter at a time.", "Hunting", "Veteran", 40,
    [familyKill("coastal_crab", 10), kill("squid", 5), kill("jellyfish", 3)]),
  achievement("bounty_murky", "Something in the Water", "Small splashes do not always mean small trouble.", "Hunting", "Elite", 45,
    [familyKill("frog", 10), familyKill("alligator", 3), kill("sap_crawler", 3)]),
  achievement("bounty_thick_skin", "A Thick Skin", "Earn your record against a particularly stubborn trio.", "Hunting", "Elite", 50,
    [familyKill("hog", 10), familyKill("bear", 5), kill("ogre", 3)]),
  achievement("bounty_odd_company", "Unusual Acquaintances", "Some Encyclopedia entries are stranger than others.", "Hunting", "Elite", 50,
    [kill("sap_crawler", 5), kill("mysterious_traveler", 3)]),
  achievement("bounty_common_ground", "Common Ground", "Give all four common creatures their fair share of ink.", "Hunting", "Veteran", 45,
    [familyKill("deer", 25), familyKill("hog", 25), familyKill("coastal_crab", 25), familyKill("frog", 25)]),
  achievement("bounty_uncommon_courage", "Uncommon Courage", "Follow the uncommon trail across land and water.", "Hunting", "Elite", 55,
    [familyKill("wolf", 10), familyKill("bear", 10), kill("squid", 10)]),
  achievement("bounty_rare_company", "Rare Company", "Three rare creatures, three reasons to stay alert.", "Hunting", "Elite", 60,
    [kill("sap_crawler", 5), familyKill("alligator", 5), kill("jellyfish", 5)]),
  achievement("bounty_epic_double", "A Tall Tale and a Stranger", "Make an epic double entry in your journal.", "Hunting", "Master", 80,
    [kill("ogre", 5), kill("mysterious_traveler", 5)]),
  achievement("hunt_total_100", "One Hundred Stories", "Every credited encounter leaves a mark.", "Hunting", "Veteran", 25,
    [objective("kills_total", 100, "Record 100 creature defeats", "All credited Encyclopedia creature defeats contribute.")]),
  achievement("hunt_total_500", "Well Traveled Blade", "Your hunting journal is getting comfortably heavy.", "Hunting", "Elite", 50,
    [objective("kills_total", 500, "Record 500 creature defeats", "All credited Encyclopedia creature defeats contribute.")]),
  achievement("hunt_total_2000", "An Atlas of Encounters", "A long career, written one encounter at a time.", "Hunting", "Master", 90,
    [objective("kills_total", 2_000, "Record 2,000 creature defeats", "All credited Encyclopedia creature defeats contribute.")], "Veteran of Many Trails"),
  achievement("bird_first", "A Feather in Your Journal", "Begin the legendary sky collection.", "Legends", "Elite", 35, [birds(1)]),
  achievement("bird_pair", "Birds of Two Feathers", "One element was never going to be enough.", "Legends", "Master", 65, [birds(2)]),
  achievement("bird_triumvirate", "The Bird Triumvirate", "Fire, lightning, and ice share a single page.", "Legends", "Legend", 100, [birds(3)], "Witness of Three Skies"),
  achievement("bird_encore", "Three Skies, Three Times", "Give every member of the triumvirate an encore.", "Legends", "Legend", 100,
    [kill("fire_bird", 3), kill("lightning_bird", 3), kill("ice_bird", 3)], "Keeper of the Triumvirate"),
  achievement("ring_first", "One for the Record", "Let Xoral's first ring begin a collection.", "Legends", "Elite", 40, [rings(1)]),
  achievement("ring_pair", "A Ring of Possibilities", "Two different rings, two branches of the same legend.", "Legends", "Master", 70, [rings(2)]),
  achievement("ring_set", "Three Rings to Remember", "Complete the Chopping, Mining, and Attack Ring drop collection.", "Legends", "Legend", 100, [rings(3)], "Keeper of the Three Rings"),
  achievement("legendary_quartet", "Four Names, One Legend", "Bring the three Birds and Xoral together in your record.", "Legends", "Legend", 100,
    [kill("fire_bird", 1), kill("lightning_bird", 1), kill("ice_bird", 1), kill("xoral", 1)], "Chronicler of the Four"),

  achievement("seen_4", "Eyes Open", "The world begins to fill the blank pages.", "Discovery", "Adventurer", 10, [seen(4)]),
  achievement("seen_10", "A Familiar Face", "Learn to recognize ten very different neighbors.", "Discovery", "Veteran", 30, [seen(10)]),
  achievement("seen_16", "No Blank Faces", "Discover the full current creature roster.", "Discovery", "Legend", 90, [seen(16)], "Witness of the Atlas"),
  achievement("species_4", "Four Corners of the Hunt", "Start collecting experiences, not just repeats.", "Discovery", "Adventurer", 15, [defeated(4)]),
  achievement("species_10", "Ten Chapters Deep", "Keep widening your hunting repertoire.", "Discovery", "Elite", 45, [defeated(10)]),
  achievement("species_16", "The Complete Creature Chapter", "Record a victory over every current Encyclopedia creature.", "Discovery", "Legend", 100, [defeated(16)], "Complete Chronicler"),
  achievement("habitat_first", "Reading the Ground", "Know a creature well enough to understand where it belongs.", "Discovery", "Veteran", 25, [habitats(1)]),
  achievement("habitat_six", "Field Guide", "Turn six creature chapters into useful habitat knowledge.", "Discovery", "Master", 65, [habitats(6)]),
  achievement("habitat_twelve", "The Wild, Annotated", "Reveal every natural creature's habitat record.", "Discovery", "Legend", 100, [habitats(12)], "Atlas Naturalist"),
  achievement("drops_5", "Pocket Curiosities", "Five different drops are the beginning of a good story.", "Discovery", "Adventurer", 15, [drops(5)]),
  achievement("drops_12", "Cabinet of Curiosities", "A broad hunt makes an interesting collection.", "Discovery", "Veteran", 40, [drops(12)]),
  achievement("drops_20", "Every Drop Tells a Story", "Collect a record worth leafing through.", "Discovery", "Master", 80, [drops(20)], "Curiosity Keeper"),
  achievement("regions_3", "New Horizons", "Step past the edge of the familiar map.", "Discovery", "Adventurer", 10, [regions(3)]),
  achievement("regions_6", "Well Traveled", "Six regions leave their dust on your boots.", "Discovery", "Veteran", 25, [regions(6)]),
  achievement("regions_10", "Cartographer", "Fill in most of the Atlas with your own footsteps.", "Discovery", "Elite", 50, [regions(10)]),
  achievement("regions_16", "Worldwalker", "Stand in every named region of the world.", "Discovery", "Legend", 100, [regions(16)], "Worldwalker"),
  achievement("region_open_ocean", "Out of Sight of Land", "Sail until the coast disappears behind you.", "Discovery", "Veteran", 20,
    [objective("biome_open_ocean", 1, "Discover the Open Ocean", "Travel past the coastal shallows into deep water.")]),
  achievement("region_frozen_waste", "Where the Map Ends", "Reach the ice beyond the last forests and tundra.", "Discovery", "Elite", 40,
    [objective("biome_frozen_waste", 1, "Discover the Frozen Waste", "Find the permanent ice of the far north or south, or the highest glaciers.")]),
  achievement("region_jungle", "Canopy Crossing", "Step beneath a roof of leaves so thick the sky is a rumor.", "Discovery", "Veteran", 20,
    [objective("biome_jungle", 1, "Discover the Jungle", "Find the hot, wet forests near the equator: the Amazon, Congo basin or Southeast Asia.")]),
  achievement("region_pinewild", "Among the Pines", "Breathe resin and cold air under endless evergreens.", "Discovery", "Adventurer", 10,
    [objective("biome_pinewild", 1, "Discover the Pinewild", "Find the evergreen forests of Canada, Scandinavia or Siberia.")]),
  achievement("region_greenwood", "Leaf and Bough", "Wander where broadleaf trees close in over the path.", "Discovery", "Adventurer", 10,
    [objective("biome_greenwood", 1, "Discover the Greenwood", "Find the temperate woodlands of Europe, the eastern United States or East Asia.")]),
  achievement("region_frostwood", "Under the Snow Boughs", "Walk the quiet forests where winter never quite lets go.", "Discovery", "Veteran", 15,
    [objective("biome_frostwood", 1, "Discover the Frostwood", "Find the snowbound forests near the cold northern treeline.")]),
  achievement("region_plains", "Endless Horizon", "Cross open country where the land runs flat to the edge of sight.", "Discovery", "Adventurer", 10,
    [objective("biome_plains", 1, "Discover the Plains", "Find broad grassland such as the American Midwest or the Pampas.")]),
  achievement("region_savanna", "Sun on the Grass", "Follow golden grass and lone trees through the warm lands.", "Discovery", "Veteran", 15,
    [objective("biome_savanna", 1, "Discover the Savanna", "Find the warm grasslands of East and Southern Africa, northern Australia or Brazil.")]),
  achievement("region_marsh", "Knee-Deep", "Wade where land and water cannot agree.", "Discovery", "Veteran", 15,
    [objective("biome_marsh", 1, "Discover the Marsh", "Find wetlands and swamps such as the Everglades, the Pantanal or the Sudd.")]),
  achievement("region_highmeadow", "High Pastures", "Climb to grassy heights where the air thins and the views widen.", "Discovery", "Veteran", 20,
    [objective("biome_highmeadow", 1, "Discover the High Meadow", "Find alpine grasslands high in mountain ranges such as the Alps, Andes or Rockies.")]),
  achievement("region_scrubland", "Sun-Baked Hills", "Cross dry hills of thorn and hardy brush.", "Discovery", "Adventurer", 10,
    [objective("biome_scrubland", 1, "Discover the Scrubland", "Find dry shrubland such as the Mediterranean, southern California or the Australian bush.")]),
  achievement("region_badlands", "Heat Shimmer", "Reach the parched ground where rain is a memory.", "Discovery", "Veteran", 20,
    [objective("biome_badlands", 1, "Discover the Badlands", "Find hot deserts and barren country such as the Sahara, Arabia or the American Southwest.")]),
  achievement("region_steppe", "Wind Across the Steppe", "Ride the wide dry grasslands where the wind never rests.", "Discovery", "Veteran", 15,
    [objective("biome_steppe", 1, "Discover the Steppe", "Find the vast cool grasslands of Kazakhstan, Mongolia or the Russian south.")]),
  achievement("region_tundra", "The Frozen Flats", "Stand on treeless ground held hard by frost.", "Discovery", "Elite", 25,
    [objective("biome_tundra", 1, "Discover the Tundra", "Find the treeless Arctic fringe of northern Russia, Alaska, Canada or Greenland's coast.")]),
  achievement("region_coast", "Salt on the Wind", "Reach the shore where the land gives way to the sea.", "Discovery", "Adventurer", 10,
    [objective("biome_coast", 1, "Discover the Coast", "Stand at the water's edge on any ocean shoreline.")]),
  achievement("region_lake", "Still Waters", "Find a lake calm enough to hold the sky.", "Discovery", "Adventurer", 10,
    [objective("biome_lake", 1, "Discover the Lake", "Reach a large lake such as the Great Lakes, Lake Victoria or Lake Baikal.")]),

  achievement("wood_25", "Knock on Wood", "Find the rhythm of a working axe.", "Gathering", "Adventurer", 10, [gather("wood", 25)]),
  achievement("wood_250", "Out of the Woods", "Build a substantial Wood gathering record.", "Gathering", "Elite", 45, [gather("wood", 250)]),
  achievement("stone_25", "Leave No Stone", "Put a little weight behind your gathering record.", "Gathering", "Adventurer", 10, [gather("stone", 25)]),
  achievement("stone_250", "A Rolling Record", "Keep the Stone harvests coming.", "Gathering", "Elite", 45, [gather("stone", 250)]),
  achievement("iron_10", "Iron Intentions", "Follow Iron Ore toward the Furnace.", "Gathering", "Veteran", 20, [gather("iron", 10)]),
  achievement("iron_100", "Ore to the Story", "A hundred mining actions make a convincing chapter.", "Gathering", "Elite", 55, [gather("iron", 100)]),
  achievement("coal_10", "Coal Calling", "Add a darker mineral to the collection.", "Gathering", "Veteran", 20, [gather("coal", 10)]),
  achievement("coal_100", "Black Gold, Small Print", "Keep a patient record of Coal gathering.", "Gathering", "Elite", 55, [gather("coal", 100)]),
  achievement("sulfur_5", "A Sulfur Discovery", "Broaden your mineral gathering beyond familiar ground.", "Gathering", "Veteran", 25, [gather("sulfur", 5)]),
  achievement("sulfur_50", "A Bright Yellow Streak", "Make Sulfur a regular part of your gathering travels.", "Gathering", "Master", 65, [gather("sulfur", 50)]),
  achievement("flax_5", "A Flax of Inspiration", "Find the first threads of something useful.", "Gathering", "Adventurer", 10, [gather("flax_fiber", 5)]),
  achievement("flax_100", "Field of Possibilities", "Give your Loom a reason to stay busy.", "Gathering", "Elite", 45, [gather("flax_fiber", 100)]),
  achievement("gather_100", "Busy Hands", "Put one hundred completed gathering actions on the record.", "Gathering", "Veteran", 25,
    [objective("harvests_total", 100, "Complete 100 resource harvests", "Completed resource gathering actions count, not individual items.")]),
  achievement("gather_1000", "A Thousand Small Efforts", "An industrious chapter is written in small actions.", "Gathering", "Master", 80,
    [objective("harvests_total", 1_000, "Complete 1,000 resource harvests", "Completed resource gathering actions count, not individual items.")], "Industrious Wayfarer"),
  achievement("gather_sampler", "A Little of Everything", "Bring six different gathering pursuits into one record.", "Gathering", "Veteran", 40,
    [gather("wood", 5), gather("stone", 5), gather("iron", 5), gather("coal", 5), gather("sulfur", 5), gather("flax_fiber", 5)]),
  achievement("gather_diversity", "The Full Basket", "Give every current resource on this list a proper outing.", "Gathering", "Master", 75,
    [gather("wood", 50), gather("stone", 50), gather("iron", 25), gather("coal", 25), gather("sulfur", 25), gather("flax_fiber", 50)], "Gatherer of Many Things"),

  achievement("bars_1", "Strike While It Is Ready", "Collect the first successful bar from your Furnace.", "Crafting", "Adventurer", 10, [bars(1)]),
  achievement("bars_25", "Raising the Bar", "A useful stock of successful Furnace work.", "Crafting", "Veteran", 35, [bars(25)]),
  achievement("bars_100", "A Bar Above", "Build a lasting smelting record.", "Crafting", "Master", 75, [bars(100)], "Keeper of the Coals"),
  achievement("smelt_types_3", "Beyond Iron", "Explore three collected Furnace recipes.", "Crafting", "Elite", 50, [smeltVariety(3)]),
  achievement("smelt_types_6", "A Many-Colored Furnace", "Broaden the recipe record beyond a single material.", "Crafting", "Master", 80, [smeltVariety(6)]),
  achievement("smelt_types_10", "The Complete Furnace", "Collect successful output from all ten Furnace recipes.", "Crafting", "Legend", 100, [smeltVariety(10)], "Tenfold Forger"),
  achievement("cloth_1", "A Common Thread", "Weave your first piece of Cloth.", "Crafting", "Adventurer", 5, [cloth(1)]),
  achievement("cloth_50", "Looming Large", "Fifty pieces begin to look like a proper workshop record.", "Crafting", "Veteran", 30, [cloth(50)]),
  achievement("cloth_250", "The Long Thread", "A patient weaver leaves a substantial record.", "Crafting", "Master", 65, [cloth(250)], "Keeper of the Loom"),
  achievement("meals_5", "Dinner Is Served", "Turn gathered ingredients into five Simple Food.", "Crafting", "Adventurer", 10, [meals(5)]),
  achievement("meals_100", "A Table for Many", "Cook enough to fill a cheerful journal page.", "Crafting", "Veteran", 35, [meals(100)]),
  achievement("meals_500", "The Endless Picnic", "Keep a generous Kitchen running.", "Crafting", "Master", 75, [meals(500)], "Keeper of the Table"),
  achievement("kitchen_types_4", "An Acquired Taste", "Give four different ingredients a turn in the Kitchen.", "Crafting", "Veteran", 30, [kitchenVariety(4)]),
  achievement("kitchen_types_12", "The Traveling Menu", "Build a menu from twelve ingredient recipes.", "Crafting", "Master", 80, [kitchenVariety(12)], "Atlas Epicure"),
  achievement("leather_250", "A Hide to Remember", "Give a rare hide its second life at the Tannery.", "Crafting", "Elite", 55, [leather(250)]),
  achievement("leather_2000", "Well Tanned", "Turn rare hides into a remarkable Leather haul.", "Crafting", "Legend", 90, [leather(2_000)], "Rare Hide Artisan"),
  achievement("tannery_types_2", "Two of a Rare Kind", "Try two different rare-hide recipes.", "Crafting", "Legend", 90,
    [objective("tannery_recipe_types", 2, "Collect Leather from 2 different hide recipes", "Use two different rare hide or pelt types at your Tannery, then collect the Leather.")]),

  ...professionAchievements,
  achievement("level_5", "Finding Your Feet", "Grow into the journey ahead.", "Mastery", "Adventurer", 20, [level(5)]),
  achievement("level_15", "A Name on the Road", "Experience begins to show.", "Mastery", "Elite", 50, [level(15)]),
  achievement("level_25", "The Current Summit", `Reach character level ${CURRENT_LEVEL_CAP}, the level cap.`, "Mastery", "Legend", 100, [level(CURRENT_LEVEL_CAP)], "Summit Chronicler"),
  achievement("masters_3", "Three Trades Deep", "One mastered profession led naturally to another.", "Mastery", "Master", 80, [masters(3)], "Practiced Polymath"),
  achievement("dungeon_1", "Down the Hatch", "Earn your first distinct Rat Warden defeat credit in the Cistern Warrens.", "Dungeons", "Veteran", 30, [wardens(1)]),
  achievement("dungeon_5", "Familiar Depths", "Seek the Rat Warden in five distinct credited sewer encounters.", "Dungeons", "Elite", 55, [wardens(5)]),
  achievement("dungeon_25", "A Regular Below", "Build a record of twenty-five distinct credited Rat Warden encounters.", "Dungeons", "Master", 90, [wardens(25)], "Veteran of the Depths"),
  ...journey("field_notes", "The Living Field Guide", "Discovery", "Keeper of Field Notes", [
    { title: "A Blank Page", description: "Begin by looking around, then put four victories beside the sketches.", difficulty: "Adventurer", points: 20, objectives: [seen(4), defeated(4)] },
    { title: "Between the Lines", description: "Expand your encounters and start revealing where creatures belong.", difficulty: "Veteran", points: 45, objectives: [defeated(8), habitats(3)] },
    { title: "The Wild in Full", description: "Finish the current creature roster and all twelve natural habitat records.", difficulty: "Legend", points: 100, objectives: [seen(16), habitats(12)] }
  ]),
  ...journey("iron_story", "Ore, Fire, and Patience", "Crafting", "Friend of the Furnace", [
    { title: "Fuel for a Beginning", description: "Gather Wood and Iron Ore to start the Furnace story.", difficulty: "Adventurer", points: 20, objectives: [gather("wood", 20), gather("iron", 5)] },
    { title: "Lessons in the Heat", description: "Collect your first working stock of bars and learn Metallurgy.", difficulty: "Veteran", points: 35, objectives: [bars(5), profession("metallurgy", 1)] },
    { title: "More Than Iron", description: "Turn patient smelting into a wider craft.", difficulty: "Master", points: 85, objectives: [bars(50), smeltVariety(3), profession("metallurgy", 4)] }
  ]),
  ...journey("flax_story", "From Field to Fabric", "Crafting", "Thread Keeper", [
    { title: "A Handful of Flax", description: "Gather Wild Flax and weave the first Cloth.", difficulty: "Adventurer", points: 15, objectives: [gather("flax_fiber", 5), cloth(1)] },
    { title: "Finding the Thread", description: "Keep both the field work and the Loom moving.", difficulty: "Veteran", points: 30, objectives: [gather("flax_fiber", 25), cloth(25)] },
    { title: "A Story Woven Well", description: "Bring a hundred harvests and a hundred Cloth into the same journal.", difficulty: "Elite", points: 60, objectives: [gather("flax_fiber", 100), cloth(100)] }
  ]),
  ...journey("camp_cook", "The Traveling Kitchen", "Crafting", "Trail Chef", [
    { title: "Supper on the Trail", description: "Begin a hunting and cooking record with familiar woodland creatures.", difficulty: "Adventurer", points: 20, objectives: [familyKill("deer", 3), familyKill("hog", 3), meals(5)] },
    { title: "A Change of Menu", description: "Widen the hunt and try four different Kitchen ingredients.", difficulty: "Veteran", points: 40, objectives: [familyKill("wolf", 3), familyKill("coastal_crab", 3), kitchenVariety(4), meals(25)] },
    { title: "The Farther Table", description: "Add more adventurous encounters and a well-traveled recipe book.", difficulty: "Master", points: 75, objectives: [kill("squid", 3), familyKill("alligator", 3), kitchenVariety(8), meals(100)] }
  ]),
  ...journey("shore_patrol", "Trouble at the Waterline", "Hunting", "Keeper of Tides", [
    { title: "Mind the Claws", description: "Begin at the shore with ten Coastal Crab defeats.", difficulty: "Adventurer", points: 15, objectives: [familyKill("coastal_crab", 10)] },
    { title: "Ink and Sting", description: "Broaden the aquatic patrol to Squid and Jellyfish.", difficulty: "Veteran", points: 40, objectives: [kill("squid", 5), kill("jellyfish", 3)] },
    { title: "The Tide Turns", description: "Complete a seasoned record across all three aquatic creatures.", difficulty: "Master", points: 75, objectives: [familyKill("coastal_crab", 100), kill("squid", 25), kill("jellyfish", 10)] }
  ]),
  ...journey("oldwood", "A Walk in the Wild", "Hunting", "Woodland Chronicler", [
    { title: "Just a Pleasant Walk", description: "Gather Wood and meet the quieter end of the creature roster.", difficulty: "Adventurer", points: 20, objectives: [gather("wood", 20), familyKill("deer", 10), familyKill("hog", 10)] },
    { title: "The Walk Gets Interesting", description: "Wolves, Bears, and Resin Crawlers complicate the itinerary.", difficulty: "Elite", points: 50, objectives: [familyKill("wolf", 10), familyKill("bear", 5), kill("sap_crawler", 3)] },
    { title: "A Very Long Walk", description: "Return with a substantial gathering and hunting record.", difficulty: "Master", points: 85, objectives: [gather("wood", 200), familyKill("wolf", 50), familyKill("bear", 25), kill("sap_crawler", 10)] }
  ]),
  ...journey("sky_accord", "An Accord of Three Skies", "Legends", "Chronicler of Three Skies", [
    { title: "The First Element", description: "Let any one of the legendary Birds open the story.", difficulty: "Elite", points: 40, objectives: [birds(1)] },
    { title: "A Second Sky", description: "Find a different elemental Bird and earn its defeat credit.", difficulty: "Master", points: 65, objectives: [birds(2)] },
    { title: "The Sky Remembers", description: "Defeat every elemental Bird three times across your adventures.", difficulty: "Legend", points: 100, objectives: [birds(3), kill("fire_bird", 3), kill("lightning_bird", 3), kill("ice_bird", 3)] }
  ]),
  ...journey("xoral_roots", "The Legend Beneath the Bark", "Legends", "Ring Chronicler", [
    { title: "A Habit of Chopping", description: "Start the story with fifty completed Wood harvests.", difficulty: "Veteran", points: 25, objectives: [gather("wood", 50)] },
    { title: "An Unexpected Reply", description: "Earn your first credited defeat of Xoral.", difficulty: "Elite", points: 55, objectives: [kill("xoral", 1)] },
    { title: "Three Rings in the Record", description: "Complete Xoral's ring-drop collection and return for three credited victories.", difficulty: "Legend", points: 100, objectives: [kill("xoral", 3), rings(3)] }
  ]),
  ...journey("understreets", "Beneath Familiar Streets", "Dungeons", "Below and Beyond", [
    { title: "The First Descent", description: "Earn Rat Warden defeat credit to begin a sewer expedition diary.", difficulty: "Veteran", points: 30, objectives: [wardens(1)] },
    { title: "Provision and Return", description: "Prepare food and seek Rat Warden credit in three distinct sewer encounters.", difficulty: "Elite", points: 50, objectives: [wardens(3), meals(10)] },
    { title: "A Name Below", description: "Explore other cistern warrens for ten distinct Rat Warden credits and reach character level ten.", difficulty: "Master", points: 80, objectives: [wardens(10), level(10)] }
  ]),
  ...journey("many_trades", "Hands of Many Trades", "Mastery", "Hand of Many Trades", [
    { title: "Wood and Stone", description: "Take the first step in two gathering professions.", difficulty: "Adventurer", points: 20, objectives: [profession("woodcutter", 1), profession("miner", 1)] },
    { title: "Beyond the Gathering", description: "Learn the basics of building and Oil Well work.", difficulty: "Veteran", points: 50, objectives: [profession("builder", 2), profession("oil_worker", 2)] },
    { title: "A Versatile Calling", description: "Master three professions and learn Metallurgy.", difficulty: "Legend", points: 100, objectives: [masters(3), profession("metallurgy", 2)] }
  ])
]);
