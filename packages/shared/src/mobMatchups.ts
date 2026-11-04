import {
  CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE,
  CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE,
  PVP_DAMAGE_DEFENSE_PROFILES_V3,
  PVP_DAMAGE_WEAPON_PROFILES_V3,
  PVP_RAW_MATRIX_V3,
  normalizeV3NormalWeaponDamage,
  type PvpDamageDefenseProfileV3,
  type PvpDamageWeaponProfileV3
} from "./damageMatrixV3.js";
import type { MobChallengeTier } from "./equipmentBalanceContracts.js";
import type { MobArchetypeKey } from "./mobContracts.js";

/**
 * Monster matchups on the one universal weapon x armor table
 * (PVP_RAW_MATRIX_V3). Players and monsters both attack with a weapon type
 * and defend with an armor type; there are no creature-specific rows.
 */
export type MatchupWeaponType = PvpDamageWeaponProfileV3;
export type MatchupArmorType = PvpDamageDefenseProfileV3;
/** Monsters wear body armor only; shields are a player-only column. */
export type MobArmorType = Exclude<MatchupArmorType, "shield" | "wyrm_shield">;

export const MATCHUP_WEAPON_TYPE_LABELS = Object.freeze({
  unarmed: "Unarmed",
  sword: "Sword",
  spear: "Spear",
  dagger: "Dagger",
  axe: "Axe",
  crossbow: "Crossbow",
  shuriken: "Shuriken",
  longbow: "Longbow",
  blowdart: "Blowdart",
  sling: "Sling",
  martial_arts: "Martial Arts",
  brass_knuckles: "Brass Knuckles",
  staff: "Staff",
  wand: "Wand"
} as const satisfies Readonly<Record<MatchupWeaponType, string>>);

export const MATCHUP_ARMOR_TYPE_LABELS = Object.freeze({
  unarmored: "Unarmored",
  shield: "Shield",
  breastplate: "Breastplate",
  martial_tunic: "Tunic",
  leather: "Leather",
  wyrm_shield: "Wyrm Shield",
  chainmail: "Chainmail"
} as const satisfies Readonly<Record<MatchupArmorType, string>>);

export const MATCHUP_WEAPON_TYPES = PVP_DAMAGE_WEAPON_PROFILES_V3;
export const MATCHUP_ARMOR_TYPES = PVP_DAMAGE_DEFENSE_PROFILES_V3;

/** Presentation order: body armor light to heavy, then the shield columns. */
export const MATCHUP_ARMOR_DISPLAY_ORDER = Object.freeze([
  "unarmored", "martial_tunic", "leather", "chainmail", "breastplate", "shield", "wyrm_shield"
] as const satisfies readonly MatchupArmorType[]);

/** Weapon types a player can wield today (bare hands plus current equipment families). */
export const MATCHUP_IN_GAME_WEAPON_TYPES: readonly MatchupWeaponType[] = Object.freeze(
  MATCHUP_WEAPON_TYPES.filter((type) => type === "unarmed" ||
    Object.values(CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE).includes(type as never))
);

/** Armor types a player can wear today (bare skin plus current equipment families). */
export const MATCHUP_IN_GAME_ARMOR_TYPES: readonly MatchupArmorType[] = Object.freeze(
  MATCHUP_ARMOR_DISPLAY_ORDER.filter((type) => type === "unarmored" ||
    Object.values(CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE).includes(type as never))
);

/** Equal-level raw hits at or above this are a strong matchup. */
export const MATCHUP_STRONG_AT = 8;
/** Equal-level raw hits at or below this are a weak matchup. */
export const MATCHUP_WEAK_AT = 3;

export type MatchupTone = "strong" | "standard" | "weak";

/** One classification of an equal-level raw table value, used everywhere. */
export function matchupTone(rawValue: number): MatchupTone {
  if (rawValue >= MATCHUP_STRONG_AT) return "strong";
  if (rawValue <= MATCHUP_WEAK_AT) return "weak";
  return "standard";
}

export type MobMatchup = Readonly<{
  /** Flavor name shown to players, e.g. "Bite". */
  weaponName: string;
  weaponType: MatchupWeaponType;
  /** Flavor name shown to players, e.g. "Hide". */
  armorName: string;
  armorType: MobArmorType;
  /**
   * 1 for every normal mob. Bosses and reviewed elites differ, and a mob may
   * use its challenge tier's MOB_TIER_DAMAGE_MULTIPLIERS value.
   */
  damageMultiplier: number;
}>;

/**
 * The damage multiplier a mob may take from its challenge tier (definition
 * level band) without being a boss: tier 4 (epic) 1.25, tier 5 (legendary) 1.5.
 */
export const MOB_TIER_DAMAGE_MULTIPLIERS: Readonly<Partial<Record<MobChallengeTier, number>>> = Object.freeze({
  epic: 1.25,
  legendary: 1.5
});

function matchup(
  weaponName: string,
  weaponType: MatchupWeaponType,
  armorName: string,
  armorType: MobArmorType,
  damageMultiplier = 1
): MobMatchup {
  return Object.freeze({ weaponName, weaponType, armorName, armorType, damageMultiplier });
}

/** Every archetype must declare its matchup; a missing key is a compile error. */
export const MOB_MATCHUPS: Readonly<Record<MobArchetypeKey, MobMatchup>> = Object.freeze({
  training_dummy: matchup("None", "unarmed", "Straw", "unarmored"),
  deer: matchup("Antlers", "spear", "Fur", "martial_tunic"),
  // Biome deer variants share the Deer matchup exactly.
  frost_deer: matchup("Antlers", "spear", "Fur", "martial_tunic"),
  jungle_deer: matchup("Antlers", "spear", "Fur", "martial_tunic"),
  marsh_deer: matchup("Antlers", "spear", "Fur", "martial_tunic"),
  sand_deer: matchup("Antlers", "spear", "Fur", "martial_tunic"),
  coastal_crab: matchup("Pincers", "spear", "Carapace", "chainmail"),
  // Biome Coastal Crab variants share the Coastal Crab matchup exactly.
  ice_crab: matchup("Pincers", "spear", "Carapace", "chainmail"),
  sand_crab: matchup("Pincers", "spear", "Carapace", "chainmail"),
  mangrove_crab: matchup("Pincers", "spear", "Carapace", "chainmail"),
  wolf: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  // Biome Wolf variants share the Wolf matchup exactly.
  frost_wolf: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  dune_wolf: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  jungle_wolf: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  bog_wolf: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  goblin: matchup("Shiv", "dagger", "Rags", "martial_tunic"),
  bandit: matchup("Cutlass", "sword", "Jerkin", "leather"),
  orc_brute: matchup("Cleaver", "axe", "Iron Plate", "breastplate"),
  ogre: matchup("Club", "axe", "Stone Skin", "breastplate"),
  bear: matchup("Claws", "dagger", "Fur", "martial_tunic"),
  // Biome Bear variants share the Bear matchup exactly.
  snow_bear: matchup("Claws", "dagger", "Fur", "martial_tunic"),
  black_bear: matchup("Claws", "dagger", "Fur", "martial_tunic"),
  sun_bear: matchup("Claws", "dagger", "Fur", "martial_tunic"),
  sap_crawler: matchup("Mandibles", "unarmed", "Soft Body", "unarmored"),
  hog: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  // Biome Hog variants share the Hog matchup exactly.
  woolly_hog: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  warthog: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  jungle_hog: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  mud_hog: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  javelina: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  skeleton: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  frog: matchup("Tongue", "unarmed", "Skin", "unarmored"),
  // Biome Frog variants share the Frog matchup exactly.
  frost_frog: matchup("Tongue", "unarmed", "Skin", "unarmored"),
  poison_frog: matchup("Tongue", "unarmed", "Skin", "unarmored"),
  desert_toad: matchup("Tongue", "unarmed", "Skin", "unarmored"),
  alligator: matchup("Jaws", "spear", "Scales", "chainmail"),
  // Biome Alligator variants share the Alligator matchup exactly.
  caiman: matchup("Jaws", "spear", "Scales", "chainmail"),
  crocodile: matchup("Jaws", "spear", "Scales", "chainmail"),
  squid: matchup("Tentacles", "unarmed", "Mantle", "leather"),
  // Miniboss: the direct sting is a token hit (x0 floors at 1); its Poison
  // and Shade mechanics deal the damage.
  jellyfish: matchup("Sting", "unarmed", "Membrane", "unarmored", 0),
  mysterious_traveler: matchup("Blade", "sword", "Cuirass", "breastplate", 1.5),
  fire_bird: matchup("Talons", "spear", "Feathers", "martial_tunic", 1.5),
  lightning_bird: matchup("Talons", "spear", "Feathers", "martial_tunic", 1.5),
  ice_bird: matchup("Talons", "spear", "Feathers", "martial_tunic", 1.5),
  xoral: matchup("Crushing Roots", "axe", "Ironbark", "chainmail", 2),
  sewer_rat: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  sick_sewer_rat: matchup("Gnaw", "unarmed", "Mangy Fur", "unarmored"),
  sewer_rat_miniboss: matchup("Gnaw", "unarmed", "Matted Fur", "unarmored"),
  slime: matchup("Engulf", "unarmed", "Ooze", "unarmored"),
  slime_miniboss: matchup("Engulf", "unarmed", "Ooze", "unarmored"),

  // Placeholder matchups for the dungeon and Hollin archetypes: weapon and
  // armor types are copied from the closest existing monster (named per
  // group). Tune with the dungeon designer. Health keeps each mob's hit count.
  // Cistern Warrens v2 -- copied from coastal_crab (turtle), sap_crawler (spiders),
  // sewer_rat (flea).
  shellback_turtle: matchup("Beak", "spear", "Shell", "chainmail"),
  sewer_spider: matchup("Fangs", "unarmed", "Chitin", "unarmored"),
  dune_tick: matchup("Bite", "unarmed", "Shell", "unarmored"),
  spiderling: matchup("Fangs", "unarmed", "Soft Body", "unarmored"),
  // Dungeon boss: sap_crawler types with the x1.5 boss multiplier.
  brood_matriarch: matchup("Fangs", "unarmed", "Chitin", "unarmored", 1.5),
  // Raptor Den -- copied from wolf (raptors, bat), goblin (spitter).
  cave_raptor: matchup("Claws", "dagger", "Hide", "martial_tunic"),
  raptor_runt: matchup("Claws", "dagger", "Hide", "martial_tunic"),
  raptor_spitter: matchup("Spit", "dagger", "Hide", "martial_tunic"),
  cave_bat: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  // Dungeon boss: wolf types with the x1.5 boss multiplier.
  raptor_chieftain: matchup("Claws", "dagger", "Hide", "martial_tunic", 1.5),
  // Roost -- copied from sewer_rat (mouse), hog (chick), the legendary
  // birds without their multiplier (hawk).
  nest_mouse: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  carrion_chick: matchup("Beak", "spear", "Matted Down", "chainmail"),
  cliff_hawk: matchup("Talons", "spear", "Feathers", "martial_tunic"),
  // Dungeon boss: lightning_bird types with the x1.5 boss multiplier.
  thunderwing: matchup("Talons", "spear", "Feathers", "martial_tunic", 1.5),
  // Blightwood Grove -- copied from wolf (rot wolf), deer (stag),
  // sap_crawler (fern, sprite), xoral without its multiplier (treant).
  rot_wolf: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  blighted_stag: matchup("Antlers", "spear", "Fur", "martial_tunic"),
  thornfern: matchup("Thorns", "unarmed", "Fronds", "unarmored"),
  blight_treant: matchup("Crushing Roots", "axe", "Bark", "chainmail"),
  blight_sprite: matchup("Spores", "unarmed", "Soft Body", "unarmored"),
  // Dungeon boss: xoral types with the x1.5 boss multiplier (x2 stays
  // reserved for the top-tier Xoral).
  hollow_elder: matchup("Crushing Roots", "axe", "Ironbark", "chainmail", 1.5),
  // Wyrm Hollow -- copied from fire_bird (drakeling, wyvern), raptor (salamander),
  // slime (lava slime), bear (broodguard), and the boss multiplier for the dragon.
  drakeling: matchup("Fire Spit", "spear", "Scales", "leather"),
  magma_salamander: matchup("Burning Bite", "dagger", "Magma Hide", "leather"),
  lava_slime: matchup("Molten Touch", "unarmed", "Crust", "unarmored"),
  ash_wyvern: matchup("Talons", "spear", "Feathers", "martial_tunic"),
  drake_broodguard: matchup("Claws", "axe", "Plated Scales", "breastplate"),
  // Dungeon boss: x1.5 boss multiplier (x2 stays reserved for the top-tier Xoral).
  elder_dragon: matchup("Dragonfire", "axe", "Dragon Scales", "breastplate", 1.5),
  // Monastery of the Still Hand: martial fighters in robes; the statue is
  // iron and the spirit has no body to armor.
  initiate_monk: matchup("Wrapped Fists", "martial_arts", "Robe", "martial_tunic"),
  staff_adept: matchup("Staff", "staff", "Robe", "martial_tunic"),
  shadow_acrobat: matchup("Hidden Blades", "dagger", "Wrappings", "leather"),
  iron_statue: matchup("Iron Fists", "brass_knuckles", "Iron Body", "chainmail"),
  bell_spirit: matchup("Shockwave", "wand", "Temple Cloth", "unarmored"),
  ember_shade: matchup("Ember Grasp", "wand", "Ash Shroud", "unarmored"),
  ashbound_revenant: matchup("Scorched Blade", "sword", "Charred Mail", "chainmail"),
  vault_warden: matchup("Marble Fists", "brass_knuckles", "Ash-Marble Plating", "breastplate", 1.25),
  // Dungeon boss: martial types with the x1.5 boss multiplier; clones are
  // plain copies without it.
  grandmaster: matchup("Palm Strike", "martial_arts", "Master's Robe", "martial_tunic", 1.5),
  grandmaster_clone: matchup("Shadow Palm", "martial_arts", "Shadow Robe", "martial_tunic"),
  // Hollin settlement -- copied from training_dummy (hut and non-combatants),
  // goblin (guard).
  hollin_hut: matchup("None", "unarmed", "Thatch", "unarmored"),
  hollin_guard: matchup("Knife", "dagger", "Tunic", "martial_tunic"),
  hollin_brute: matchup("Hammer", "axe", "Hide", "chainmail"),
  hollin_elder: matchup("Staff", "staff", "Robe", "martial_tunic"),
  hollin_farmer: matchup("None", "unarmed", "Clothes", "unarmored"),
  hollin_helper: matchup("None", "unarmed", "Clothes", "unarmored"),
  // The first world fantasy mobs share their template's matchup exactly
  // (FANTASY_MOB_TEMPLATES). Template mobs added after them declare their own
  // weapon/armor types and flavor names.
  frost_wraith: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  yeti: matchup("Claws", "dagger", "Fur", "martial_tunic"),
  barrow_wight: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  risen_skeleton: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  revenant_lich: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  moss_golem: matchup("Club", "axe", "Stone Skin", "breastplate"),
  vine_lurker: matchup("Mandibles", "unarmed", "Soft Body", "unarmored"),
  lizardfolk_warrior: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  bog_ghoul: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  giant_scorpion: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  dust_mummy: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  thunderhorn: matchup("Claws", "dagger", "Fur", "martial_tunic"),
  griffin: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  basilisk: matchup("Tusks", "spear", "Bristled Hide", "chainmail"),
  sky_scout: matchup("Javelin", "spear", "Sky Mail", "chainmail"),
  cloud_sentry: matchup("Halberd", "spear", "Sky Plate", "breastplate"),
  cloud_arbiter: matchup("Sky Blade", "sword", "Sky Plate", "breastplate"),
  warden_scout: matchup("Cudgel", "dagger", "Prison Leathers", "leather"),
  zealot: matchup("Zealot Blade", "sword", "Chain Robes", "chainmail"),
  serpent_jailer: matchup("Barbed Whip", "spear", "Scales", "chainmail"),
  caged_valkyrie: matchup("Spear", "spear", "Winged Plate", "breastplate"),
  coil_hatchling: matchup("Fangs", "unarmed", "Soft Scales", "unarmored"),
  legion_soldier: matchup("Gladius", "sword", "Legion Plate", "breastplate"),
  mimic: matchup("Jaws", "axe", "Timber", "chainmail"),
  centurion: matchup("Gladius", "sword", "Marshal Plate", "breastplate", 1.5),
  brood_matron: matchup("Fangs", "dagger", "Scales", "chainmail", 1.5),
  trifang_warden: matchup("Fangs", "dagger", "Hellhide", "martial_tunic", 1.5),
  jungle_tapir: matchup("Shove", "spear", "Thick Hide", "chainmail"),
  jaguar: matchup("Claws", "dagger", "Rosette Fur", "martial_tunic"),
  mandrill: matchup("Fangs", "dagger", "Shaggy Fur", "martial_tunic"),
  canopy_goblin: matchup("Shiv", "dagger", "Leaf Rags", "martial_tunic"),
  poisonfrog_raider: matchup("Poison Barb", "dagger", "Slick Skin", "martial_tunic"),
  pantherfolk_stalker: matchup("Claws", "dagger", "Sleek Fur", "martial_tunic"),
  vine_wrapped_corpse: matchup("Rusted Machete", "sword", "Vine Wrappings", "breastplate"),
  serpent_priestess: matchup("Fang Dagger", "dagger", "Cult Robes", "leather", 1.25),
  capercaillie: matchup("Beak", "spear", "Feathers", "martial_tunic"),
  bugbear_chieftain: matchup("Jaw-crowned Club", "dagger", "Shag Fur", "martial_tunic"),
  pinewarden: matchup("Crushing Boughs", "axe", "Pine Bark", "breastplate"),
  gallows_ghost: matchup("Noose", "sword", "Ectoplasm", "breastplate"),
  alder_king: matchup("Fog Touch", "wand", "Bark Cloak", "leather", 1.25),
  elk: matchup("Antlers", "spear", "Thick Hide", "chainmail"),
  red_squirrel: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  pine_dryad: matchup("Thorned Branch", "spear", "Bark Skin", "chainmail"),
  badger: matchup("Claws", "spear", "Thick Hide", "chainmail"),
  grey_squirrel: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  stag_beetle: matchup("Mandibles", "spear", "Wing Cases", "chainmail"),
  mossjaw_sneak: matchup("Thrown Pebbles", "unarmed", "Moss Rags", "unarmored"),
  mossjaw_spearman: matchup("Moss Spear", "spear", "Moss Rags", "martial_tunic"),
  mossjaw_hexer: matchup("Hex Staff", "staff", "Bone Charms", "leather"),
  mossjaw_warboss: matchup("Scrap Cleaver", "axe", "Scrap Plate", "breastplate", 1.25),
  hedge_witch: matchup("Broom Staff", "staff", "Patched Shawl", "martial_tunic"),
  restless_gravedigger: matchup("Grave Spade", "sword", "Grave Cloth", "breastplate"),
  coven_matron: matchup("Candle Staff", "staff", "Coven Robes", "martial_tunic", 1.25),
  great_grey_owl: matchup("Talons", "spear", "Feathers", "martial_tunic"),
  flying_squirrel: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  stagfolk_warden: matchup("Antler Glaive", "sword", "Winter Fur", "leather"),
  rime_witch: matchup("Broom Staff", "staff", "Patched Shawl", "martial_tunic"),
  draugr_berserker: matchup("Frost Blade", "sword", "Bear Pelt", "breastplate"),
  snow_talonbear: matchup("Talons", "dagger", "Feathered Fur", "martial_tunic"),
  frostwater_troll: matchup("Ice-crusted Claws", "spear", "Frost Hide", "chainmail"),
  underice_lurker: matchup("Lamprey Bite", "unarmed", "Slick Hide", "leather"),
  plains_bison: matchup("Horns", "spear", "Shaggy Hide", "chainmail"),
  prairie_dog: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  burrowing_owl: matchup("Talons", "unarmed", "Feathers", "unarmored"),
  centaur_outrider: matchup("Javelin", "spear", "Barding Vest", "chainmail"),
  volt_elemental: matchup("Arc Fists", "axe", "Storm-glass Plates", "breastplate"),
  possessed_scythe: matchup("Scythe Blade", "sword", "Haunted Iron", "breastplate"),
  strawman_lord: matchup("Harvest Scythe", "axe", "Straw Body", "martial_tunic", 1.25),
  giraffe: matchup("Kick", "spear", "Thick Hide", "chainmail"),
  lioness: matchup("Claws", "dagger", "Tawny Fur", "martial_tunic"),
  spotted_hyena: matchup("Bite", "dagger", "Spotted Fur", "martial_tunic"),
  gnoll_bonebow: matchup("Bone Bow", "longbow", "Hide Scraps", "martial_tunic"),
  gnoll_packseer: matchup("Fetish Staff", "staff", "Bone Charms", "leather"),
  gnoll_packlord: matchup("Bone Flail", "axe", "Bone Plate", "breastplate", 1.25),
  carrion_ghoul: matchup("Ghoul Claws", "sword", "Leathery Hide", "breastplate"),
  sun_griffin: matchup("Bite", "dagger", "Fur", "martial_tunic"),
  sitatunga: matchup("Spiral Horns", "spear", "Shaggy Coat", "martial_tunic"),
  emperor_dragonfly: matchup("Mandibles", "unarmed", "Wings", "unarmored"),
  frogfolk_tadpole: matchup("Tongue", "unarmed", "Skin", "unarmored"),
  frogfolk_blowgunner: matchup("Reed Blowgun", "blowdart", "Slick Skin", "martial_tunic"),
  frogfolk_shaman: matchup("Fetish Staff", "staff", "Warty Hide", "leather"),
  frogfolk_chief: matchup("Toad-king Club", "axe", "Bloated Hide", "breastplate", 1.25),
  bloat_leech: matchup("Sucker", "unarmed", "Soft Body", "unarmored"),
  bog_hag: matchup("Rusty Sickle", "sword", "Moss Rags", "leather"),
  leech_mother: matchup("Ring Maw", "spear", "Rubbery Hide", "chainmail", 1.25),
  mountain_ibex: matchup("Scimitar Horns", "spear", "Coarse Coat", "martial_tunic"),
  wild_yak: matchup("Horns", "spear", "Woolly Skirt", "chainmail"),
  alpine_marmot: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  yakfolk_stonehorn: matchup("Iron-capped Horns", "spear", "Felt Armour", "chainmail"),
  highland_reaver: matchup("Dirk", "dagger", "Plaid Kilt", "martial_tunic"),
  storm_harpy: matchup("Talons", "dagger", "Feathers", "martial_tunic"),
  cairn_wight: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  stormwing_chick: matchup("Beak", "spear", "Matted Down", "chainmail"),
  stormwing: matchup("Talons", "spear", "Feathers", "martial_tunic", 1.5),
  wild_scrub_goat: matchup("Scimitar Horns", "spear", "Coarse Coat", "martial_tunic"),
  crested_porcupine: matchup("Quills", "spear", "Quill Coat", "chainmail"),
  spur_thighed_tortoise: matchup("Beak", "spear", "Shell", "chainmail"),
  cyclops_shepherd: matchup("Crook Club", "axe", "Hide Wraps", "breastplate"),
  skeleton_hoplite: matchup("Kopis", "sword", "Bronze Cuirass", "breastplate"),
  tar_elemental: matchup("Tar Lash", "unarmed", "Pitch Body", "leather"),
  olive_dryad: matchup("Thorned Branch", "spear", "Bark Skin", "chainmail"),
  chimera: matchup("Three Heads", "dagger", "Lion Hide", "martial_tunic", 1.25),
  dromedary: matchup("Kick", "spear", "Shaggy Coat", "martial_tunic"),
  fennec_fox: matchup("Nip", "unarmed", "Fur", "unarmored"),
  sidewinder: matchup("Fangs", "unarmed", "Scales", "unarmored"),
  desert_lion: matchup("Claws", "dagger", "Tawny Fur", "martial_tunic"),
  jackalfolk_skirmisher: matchup("Bronze Dagger", "dagger", "Linen Kilt", "martial_tunic"),
  dune_goblin: matchup("Shiv", "dagger", "Sand Rags", "martial_tunic"),
  desert_marauder: matchup("Scimitar", "sword", "Layered Robes", "leather"),
  scorch_troll: matchup("Huge Fists", "axe", "Cracked Hide", "breastplate"),
  ember_giant: matchup("Magma Maul", "axe", "Obsidian Skin", "breastplate", 1.5),
  saiga: matchup("Horns", "spear", "Pale Coat", "martial_tunic"),
  wild_horse: matchup("Hooves", "spear", "Dun Coat", "martial_tunic"),
  steppe_marmot: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  steppe_raider: matchup("Curved Sabre", "sword", "Quilted Coat", "leather"),
  steppe_horse_archer: matchup("Recurve Bow", "longbow", "Quilted Coat", "leather"),
  salt_husk: matchup("Salt Claws", "sword", "Salt Crust", "breastplate"),
  kurgan_wight: matchup("Rusted Blade", "sword", "Bone Plate", "breastplate"),
  centaur_khan: matchup("War Lance", "spear", "Lamellar Barding", "chainmail", 1.5),
  lemming: matchup("Gnaw", "unarmed", "Fur", "unarmored"),
  snow_goose: matchup("Beak", "spear", "Down", "martial_tunic"),
  frostborn_runecaster: matchup("Rune Staff", "staff", "Fur Cloak", "leather"),
  frostborn_jarl: matchup("Bearded Axe", "axe", "Iron-ringed Mail", "breastplate", 1.25),
  permafrost_elemental: matchup("Frozen Fists", "axe", "Frozen Earth", "breastplate"),
  draugr: matchup("Frost Blade", "sword", "Rimed Mail", "breastplate"),
  mammoth_patriarch: matchup("Great Tusks", "spear", "Frosted Wool", "chainmail", 1.5),
  emperor_penguin: matchup("Beak", "spear", "Blubber", "martial_tunic"),
  peary_caribou: matchup("Antlers", "spear", "Snow Coat", "martial_tunic"),
  ice_worm: matchup("Bite", "unarmed", "Soft Body", "unarmored"),
  rime_troll: matchup("Huge Fists", "axe", "Cracked Hide", "breastplate"),
  aurora_shade: matchup("Shadow Blade", "sword", "Aurora Veil", "breastplate"),
  blizzard_lord: matchup("Glacier Fists", "axe", "Ice Plate", "breastplate", 1.5),
  sea_otter: matchup("Paws", "unarmed", "Dense Fur", "unarmored"),
  herring_gull: matchup("Beak", "unarmed", "Feathers", "unarmored"),
  spiny_lobster: matchup("Spiny Antennae", "spear", "Spiked Carapace", "chainmail"),
  gillfolk_scout: matchup("Coral Dart", "spear", "Fish Scales", "chainmail"),
  gillfolk_netter: matchup("Net and Gaff", "spear", "Banded Scales", "chainmail"),
  coral_golem: matchup("Coral Fists", "axe", "Coral Plates", "breastplate"),
  drowned_deckhand: matchup("Rusty Cutlass", "sword", "Waterlogged Shirt", "breastplate"),
  reef_kraken: matchup("Tentacles", "unarmed", "Mantle", "leather"),
  hammerhead_shark: matchup("Jaws", "spear", "Sandpaper Skin", "chainmail"),
  manta_ray: matchup("Wing Slap", "unarmed", "Smooth Skin", "leather"),
  humpback_whale: matchup("Tail Slam", "unarmed", "Blubber", "leather"),
  merfolk_harpooner: matchup("Barbed Harpoon", "spear", "Scale Mail", "chainmail"),
  phantom_lookout: matchup("Spectral Cutlass", "sword", "Ghostly Coat", "breastplate"),
  maelstrom_spirit: matchup("Crushing Current", "axe", "Spinning Water", "breastplate"),
  sea_serpent: matchup("Fangs", "spear", "Sea-green Scales", "chainmail"),
  kraken: matchup("Crushing Tentacles", "unarmed", "Ridged Mantle", "leather", 1.25),
  muskellunge: matchup("Toothy Jaws", "spear", "Scales", "chainmail"),
  mute_swan: matchup("Wing Buffet", "spear", "Down", "martial_tunic"),
  drowned_bride: matchup("Cold Embrace", "sword", "Wedding Shroud", "breastplate"),
  lake_maiden: matchup("Drowning Touch", "unarmed", "Flowing Water", "leather"),
  elder_mere_serpent: matchup("Crushing Coils", "spear", "Ancient Scales", "chainmail", 1.5),
  northern_pike: matchup("Toothy Jaws", "spear", "Scales", "chainmail"),
  snapping_turtle: matchup("Beak", "spear", "Shell", "chainmail"),
  drowned_thrall: matchup("Grasping Hands", "sword", "Grave Cloth", "breastplate"),
  beaver: matchup("Chisel Teeth", "spear", "Waterproof Fur", "chainmail"),
  river_otter: matchup("Bite", "spear", "Sleek Fur", "martial_tunic"),
  river_salmon: matchup("Fin Slap", "unarmed", "Scales", "unarmored"),
  kappa: matchup("Beak", "spear", "Shell", "chainmail"),
  kappa_brawler: matchup("Beak", "spear", "Shell", "chainmail"),
  bridge_troll: matchup("Ice-crusted Claws", "spear", "Frost Hide", "chainmail", 1.25),
  nixie: matchup("Splash", "unarmed", "Water Skin", "unarmored"),
  rapids_elemental: matchup("Torrent Fists", "axe", "Churning Water", "breastplate"),
  shellback: matchup("Crushing Beak", "spear", "Plated Shell", "breastplate"),
  darter: matchup("Needle Snout", "dagger", "Slick Hide", "martial_tunic"),
  ink_pool: matchup("Corrosive Touch", "unarmed", "Ink Body", "unarmored"),
  drowned_citizen: matchup("Empty Hands", "unarmed", "Sodden Robes", "martial_tunic"),
  tide_wraith: matchup("Tidal Claws", "sword", "Brine Shroud", "leather"),
  gate_warden: matchup("Rift Glaive", "spear", "Barnacled Plate", "chainmail"),
  drowned_cultist: matchup("Ritual Knife", "dagger", "Cult Robes", "leather"),
  // Overworld bestiary additions: each declares its own entry, chosen for the creature.
  dire_wolf: matchup("Crushing Bite", "dagger", "Thick Fur", "martial_tunic"),
  moss_troll: matchup("Mossy Club", "axe", "Mossy Hide", "leather"),
  woolly_mammoth: matchup("Curved Tusks", "spear", "Shaggy Wool", "leather"),
  ash_drake: matchup("Bite", "dagger", "Ash Scales", "leather"),
  ember_dragon: matchup("Flame Breath", "staff", "Ember Scales", "breastplate", 1.25),
  snapjaw_flytrap: matchup("Snapping Trap", "unarmed", "Leafy Hide", "unarmored"),
  field_hare: matchup("Nip", "unarmed", "Fur", "unarmored"),
  arctic_hare: matchup("Nip", "unarmed", "Snow Fur", "unarmored"),
  capybara: matchup("Gnaw", "unarmed", "Coarse Fur", "unarmored"),
  armadillo: matchup("Digging Claws", "dagger", "Banded Shell", "chainmail"),
  red_fox: matchup("Snap", "unarmed", "Russet Fur", "unarmored"),
  wolverine: matchup("Rending Claws", "dagger", "Dense Fur", "martial_tunic"),
  ostrich: matchup("Kick", "spear", "Plumage", "martial_tunic"),
  golden_eagle: matchup("Raking Talons", "spear", "Golden Feathers", "martial_tunic"),
  musk_ox: matchup("Horns", "spear", "Guard Hair", "leather"),
  seal: matchup("Bite", "unarmed", "Blubber", "unarmored"),
  cairn_golem: matchup("Stone Fists", "axe", "Stacked Stone", "breastplate"),
  giant_larva: matchup("Crushing Mandibles", "dagger", "Soft Chitin", "leather"),
  // Drowned City: dungeon variants share their base's matchup exactly.
  tide_wraith_dc: matchup("Tidal Claws", "sword", "Brine Shroud", "leather"),
  darter_dc: matchup("Needle Snout", "dagger", "Slick Hide", "martial_tunic"),
  ink_pool_dc: matchup("Corrosive Touch", "unarmed", "Ink Body", "unarmored"),
  drowned_cultist_dc: matchup("Ritual Knife", "dagger", "Cult Robes", "leather"),
  shellback_dc: matchup("Crushing Beak", "spear", "Plated Shell", "breastplate"),
  coral_golem_dc: matchup("Coral Fists", "axe", "Coral Plates", "breastplate"),
  drowned_deckhand_dc: matchup("Rusty Cutlass", "sword", "Waterlogged Shirt", "breastplate"),
  phantom_lookout_dc: matchup("Spectral Cutlass", "sword", "Ghostly Coat", "breastplate"),
  merfolk_harpooner_dc: matchup("Barbed Harpoon", "spear", "Scale Mail", "chainmail"),
  gate_warden_dc: matchup("Rift Glaive", "spear", "Barnacled Plate", "chainmail"),
  void_wisp: matchup("Void Touch", "dagger", "Shadow Flame", "unarmored"),
  deep_crawler: matchup("Hooked Forelegs", "spear", "Abyssal Plates", "breastplate"),
  maw_lily: matchup("Tooth Tendril", "unarmed", "Waxen Petals", "leather"),
  chrono_wisp: matchup("Clockwork Spark", "dagger", "Brass Flame", "martial_tunic"),
  the_watcher: matchup("Stone Fists", "axe", "Bronze Shell", "breastplate", 1.5),
  drowned_admiral: matchup("Admiral's Cutlass", "sword", "Drowned Greatcoat", "chainmail", 1.5),
  tidemaw: matchup("Lamprey Maw", "spear", "Slick Hide", "leather", 1.5),
  abyssal_one: matchup("Abyssal Arms", "axe", "Violet Chitin", "breastplate", 1.5),
  tidemaw_tentacle: matchup("Crushing Coil", "axe", "Slick Hide", "leather"),
  tidemaw_tentacle_marked: matchup("Crushing Coil", "axe", "Rune-scarred Hide", "leather"),
  abyssal_cultist: matchup("Ritual Knife", "dagger", "Abyssal Robes", "leather"),
  iron_golem_gf: matchup("Iron Fists", "axe", "Riveted Iron", "breastplate"),
  stone_golem_gf: matchup("Boulder Roll", "axe", "Quarry Stone", "breastplate"),
  geode_golem_gf: matchup("Crystal Fists", "axe", "Gem Plating", "breastplate"),
  mender_golem_gf: matchup("Tool Arms", "axe", "Patched Plates", "breastplate"),
  sentinel_statue_gf: matchup("Stone Slam", "axe", "Granite Shell", "breastplate"),
  spark_wisp_gf: matchup("Chain Zap", "dagger", "Static Flame", "unarmored"),
  slag_crawler_gf: matchup("Molten Mandibles", "spear", "Slag Carapace", "breastplate"),
  golem_smith_gf: matchup("Thrown Hammer", "axe", "Leather Apron", "leather"),
  corrupted_husk_gf: matchup("Husk Fists", "axe", "Cracked Shell", "breastplate"),
  gem_husk_gf: matchup("Crystal Fists", "axe", "Gem Plating", "breastplate"),
  walking_hammer_gf: matchup("Iron Head", "axe", "Hammer Haft", "unarmored"),
  healer_monolith_gf: matchup("Mending Pulse", "unarmed", "Runed Stone", "breastplate"),
  granite_bull: matchup("Stone Horns", "axe", "Quarry Hide", "breastplate", 1.5),
  corrupted_core: matchup("Arc Lightning", "dagger", "Husk Shell", "breastplate", 1.5),
  forgemaster: matchup("Forge Hammer", "axe", "Furnace Plating", "breastplate", 1.5)
});

export function mobMatchup(archetype: MobArchetypeKey): MobMatchup {
  return MOB_MATCHUPS[archetype];
}

export type MatchupDamageInput = Readonly<{
  weaponType: MatchupWeaponType;
  armorType: MatchupArmorType;
  /** Player defenders only. */
  shieldType?: "shield" | "wyrm_shield" | null;
  /** Weapon item level for players, combat level for monsters. */
  attackerLevel: number;
  /** Monster combat level, or the player's body-armor level. */
  defenderLevel: number;
  shieldLevel?: number;
  flatAttack?: number;
  multiplier?: number;
}>;

export type MatchupDamageResolution = Readonly<{
  bodyRawDamage: number;
  shieldRawDamage: number | null;
  selectedRawDamage: number;
  finalDamage: number;
}>;

/**
 * Universal table with the level rule: +1 raw damage per level the attacker
 * is above the defender and -1 per level below. A shielded defender takes the
 * lower of the body and shield results. Final damage is floored at 1.
 */
export function resolveMatchupDamage(input: MatchupDamageInput): MatchupDamageResolution {
  const attackerLevel = requireFiniteNonNegative(input.attackerLevel, "attacker level");
  const defenderLevel = requireFiniteNonNegative(input.defenderLevel, "defender level");
  const flatAttack = requireFinite(input.flatAttack ?? 0, "flat attack");
  const multiplier = requireFiniteNonNegative(input.multiplier ?? 1, "multiplier");
  const row = PVP_RAW_MATRIX_V3[input.weaponType];
  const bodyRawDamage = (row[input.armorType] + attackerLevel - defenderLevel + flatAttack) * multiplier;
  const shieldRawDamage = input.shieldType === undefined || input.shieldType === null
    ? null
    : (
      row[input.shieldType] + attackerLevel -
        requireFiniteNonNegative(input.shieldLevel ?? 0, "shield level") + flatAttack
    ) * multiplier;
  const selectedRawDamage = shieldRawDamage === null
    ? bodyRawDamage
    : Math.min(bodyRawDamage, shieldRawDamage);
  return {
    bodyRawDamage,
    shieldRawDamage,
    selectedRawDamage,
    finalDamage: normalizeV3NormalWeaponDamage(selectedRawDamage)
  };
}

/** Equal-level sword hit into an armor type (swings to kill = ceil(health / this)). */
export function equalLevelSwordHit(armorType: MatchupArmorType): number {
  return resolveMatchupDamage({
    weaponType: "sword",
    armorType,
    attackerLevel: 0,
    defenderLevel: 0
  }).finalDamage;
}

/**
 * The monster health unit: the neutral hit, an equal-level sword into
 * unarmored (9). Monster health = target hit count x this, whatever the
 * monster wears; its armor type then decides how many swings it really takes.
 */
export const MOB_HEALTH_UNIT: number = equalLevelSwordHit("unarmored");

/** Equal-level sword swings to empty a health pool through an armor type. */
export function equalLevelSwordSwings(maxHealth: number, armorType: MatchupArmorType): number {
  return Math.ceil(maxHealth / equalLevelSwordHit(armorType));
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}
