import { BASIC_ATTACK_INTERVAL_MS } from "./combatConstants.js";
import { EQUIPMENT_LEVEL_CAP } from "./progression.js";

/**
 * Pets: one whistle per species per account, one pet out at a time. Calling a pet brings it out for
 * an hour; whenever an outing ends (timer, 0 HP, sent home, owner death or a dungeon) it goes home
 * to rest (never permanent death). Training shortens rest. Every premium lever is paid in Glimmer on the server.
 * Design: docs/design/PETS_PLAN.md.
 */
export const PET_SPECIES_IDS = [
  "trail_hound",
  "brood_spinner",
  "emberclaw_raptor",
  "storm_chick",
  "thicket_wolf",
  "thornback_boar",
  "ember_drake",
  "deep_crawler",
  "glade_wisp"
] as const;
export type PetSpeciesId = (typeof PET_SPECIES_IDS)[number];

export const PET_ABILITY_IDS = [
  "track_hide", "find_open_land",
  "web_snare", "envenom",
  "pounce", "rending_bite",
  "squall_burst", "sky_sight",
  "hold_fast", "shadow_hide",
  "bull_rush", "fury",
  "ember_spit", "tail_lash",
  "hug", "latch",
  "mend", "mischief"
] as const;
export type PetAbilityId = (typeof PET_ABILITY_IDS)[number];

/** `map` pings a location, `enemy` needs the owner's current target, `area` hits around the pet, `self` buffs. */
export type PetAbilityTargeting = "map" | "enemy" | "area" | "self";

export type PetAbilityDefinition = Readonly<{
  id: PetAbilityId;
  name: string;
  description: string;
  cooldownMs: number;
  targeting: PetAbilityTargeting;
  /** Whether the ability may land on other players (PvP caps apply). */
  hitsPlayers: boolean;
  /** PNG basename under assets/abilities/pets/. */
  iconKey: string;
}>;

const ability = (
  id: PetAbilityId,
  name: string,
  description: string,
  cooldownSeconds: number,
  targeting: PetAbilityTargeting,
  hitsPlayers = false
): PetAbilityDefinition => ({
  id, name, description, cooldownMs: cooldownSeconds * 1_000, targeting, hitsPlayers,
  iconKey: `ability-${id.replace(/_/gu, "-")}`
});

export const PET_ABILITY_DEFINITIONS: Readonly<Record<PetAbilityId, PetAbilityDefinition>> = {
  track_hide: ability("track_hide", "Track Hide", "Marks the nearest creature that drops hide.", 55, "map"),
  find_open_land: ability("find_open_land", "Find Open Land", "Marks the nearest unclaimed land where you could plant a flag.", 66, "map"),
  web_snare: ability("web_snare", "Web Snare", "Roots your target in place.", 18, "enemy", true),
  envenom: ability("envenom", "Envenom", "Poisons your target.", 17, "enemy", true),
  pounce: ability("pounce", "Pounce", "Leaps onto your target for heavy damage and a short root.", 14, "enemy", true),
  rending_bite: ability("rending_bite", "Rending Bite", "Makes your target bleed; bleeding targets take +1 damage from you.", 22, "enemy", true),
  squall_burst: ability("squall_burst", "Squall Burst", "Blasts nearby enemies away and briefly holds them.", 27, "area", true),
  sky_sight: ability("sky_sight", "Sky Sight", "Marks the nearest elite or boss.", 54, "map"),
  hold_fast: ability("hold_fast", "Hold Fast", "Pins a monster in place for 27 seconds.", 66, "enemy"),
  shadow_hide: ability("shadow_hide", "Shadow Hide", "You and your wolf slip out of sight until you act.", 56, "self"),
  bull_rush: ability("bull_rush", "Bull Rush", "Rams your target for heavy damage and holds it in place.", 18, "enemy", true),
  fury: ability("fury", "Fury", "+3 attack and defense to your boar and nearby allies.", 64, "self"),
  ember_spit: ability("ember_spit", "Ember Spit", "Hurls fire at your target that splashes nearby enemies.", 17, "enemy", true),
  tail_lash: ability("tail_lash", "Tail Lash", "Sweeps everything within 90 m of the drake, including enemy flags and structures you could hit (90-112 damage each, your one hit per structure per day).", 22, "area", true),
  hug: ability("hug", "Hug", "Drains your target and heals you by the damage dealt.", 19, "enemy", true),
  latch: ability("latch", "Latch", "Latches onto your target and slows it.", 22, "enemy", true),
  mend: ability("mend", "Mend", "Heals you and the wisp by up to 22% of max health.", 33, "self"),
  mischief: ability("mischief", "Mischief", "Withers your target so it cannot be healed.", 18, "enemy", true)
};

export type PetSourceKind = "starter" | "egg" | "hermit" | "repair";

export type PetSpeciesDefinition = Readonly<{
  id: PetSpeciesId;
  displayName: string;
  /** PNG basename under assets/pets/ (the Trail Hound uses the existing dog art). */
  artKey: string;
  /** PNG basename under assets/items/ for the whistle. */
  whistleArtKey: string;
  /** Source stats (HP / attack / defense) before mapping onto the combat scale. */
  baseStats: Readonly<{ hp: number; attack: number; defense: number }>;
  abilities: readonly [PetAbilityId, PetAbilityId];
  source: Readonly<{
    kind: PetSourceKind;
    /** Egg or broken-whistle item that becomes this pet. */
    itemId?: string;
    description: string;
    /** False while the source content (dungeon, world spawn) has not shipped. */
    available: boolean;
  }>;
  /** World Knowledge skill rank needed to hatch or call this pet. */
  requiresSkill?: Readonly<{ skillId: "rare_beast_mastery"; rank: number }>;
}>;

const species = (definition: PetSpeciesDefinition): PetSpeciesDefinition => definition;

export const PET_SPECIES_DEFINITIONS: Readonly<Record<PetSpeciesId, PetSpeciesDefinition>> = {
  trail_hound: species({
    id: "trail_hound", displayName: "Trail Hound", artKey: "trail-hound", whistleArtKey: "whistle-trail",
    baseStats: { hp: 112, attack: 0, defense: 0 }, abilities: ["track_hide", "find_open_land"],
    source: { kind: "starter", description: "Every adventurer starts with a Trail Hound.", available: true }
  }),
  brood_spinner: species({
    id: "brood_spinner", displayName: "Brood Spinner", artKey: "brood-spinner", whistleArtKey: "whistle-spinner",
    baseStats: { hp: 172, attack: 4, defense: 5 }, abilities: ["web_snare", "envenom"],
    source: { kind: "egg", itemId: "brood_egg", description: "Hatch a Brood Egg, a rare drop from the Brood Matriarch in the Cistern Warrens.", available: true }
  }),
  emberclaw_raptor: species({
    id: "emberclaw_raptor", displayName: "Emberclaw Raptor", artKey: "raptor-hatchling", whistleArtKey: "whistle-raptor",
    baseStats: { hp: 164, attack: 6, defense: 3 }, abilities: ["pounce", "rending_bite"],
    source: { kind: "egg", itemId: "clutch_egg", description: "Hatch a Fangrock Clutch Egg, a rare drop from the Raptor Chieftain in Fangrock Cavern.", available: true }
  }),
  storm_chick: species({
    id: "storm_chick", displayName: "Storm Chick", artKey: "storm-chick", whistleArtKey: "whistle-storm",
    baseStats: { hp: 148, attack: -11, defense: 1 }, abilities: ["squall_burst", "sky_sight"],
    source: { kind: "egg", itemId: "giant_egg", description: "Hatch a Giant Egg from The Eyrie.", available: true }
  }),
  thicket_wolf: species({
    id: "thicket_wolf", displayName: "Thicket Wolf", artKey: "thicket-wolf", whistleArtKey: "whistle-wolf",
    baseStats: { hp: 143, attack: 4, defense: 2 }, abilities: ["hold_fast", "shadow_hide"],
    source: { kind: "hermit", description: "Bought from the Grove Hermit in Blightwood Grove.", available: true }
  }),
  thornback_boar: species({
    id: "thornback_boar", displayName: "Thornback Boar", artKey: "thornback-boar", whistleArtKey: "whistle-boar",
    baseStats: { hp: 177, attack: 2, defense: 4 }, abilities: ["bull_rush", "fury"],
    source: { kind: "hermit", description: "Bought from the Grove Hermit in Blightwood Grove.", available: true }
  }),
  ember_drake: species({
    id: "ember_drake", displayName: "Ember Drake", artKey: "ember-drake", whistleArtKey: "whistle-drake",
    baseStats: { hp: 181, attack: 1, defense: 3 }, abilities: ["ember_spit", "tail_lash"],
    source: { kind: "egg", itemId: "wyrm_egg", description: "Hatch a Wyrm Egg from the Elder Dragon in the Wyrm Hollow (needs Rare Beast Mastery).", available: true },
    requiresSkill: { skillId: "rare_beast_mastery", rank: 1 }
  }),
  deep_crawler: species({
    id: "deep_crawler", displayName: "Deep Crawler", artKey: "deep-crawler", whistleArtKey: "whistle-crawler",
    baseStats: { hp: 138, attack: 7, defense: 4 }, abilities: ["hug", "latch"],
    source: { kind: "egg", itemId: "crawler_egg", description: "Hatch a Crawler Egg from the Drowned City.", available: false }
  }),
  glade_wisp: species({
    id: "glade_wisp", displayName: "Glade Wisp", artKey: "glade-wisp", whistleArtKey: "whistle-wisp",
    baseStats: { hp: 152, attack: 2, defense: 4 }, abilities: ["mend", "mischief"],
    source: { kind: "repair", itemId: "broken_whistle", description: "Repair a Broken Whistle found in dense forests.", available: false }
  })
};

export const PET_ACTIVE_DURATION_MS = 75 * 60 * 1_000;
/** Each relocation or teleport while the pet is out shaves this much off its timer. */
export const PET_TRAVEL_SHAVE_MS = 80 * 1_000;
/** Rest after every outing: 14 h, 40 min less per trained level, never under 7 h. */
export const PET_REST_BASE_MS = 14 * 60 * 60 * 1_000;
export const PET_REST_PER_LEVEL_MS = 40 * 60 * 1_000;
export const PET_REST_MIN_MS = 7 * 60 * 60 * 1_000;
/** Druid rank 2+ caps pet rest. */
export const PET_REST_DRUID_MAX_MS = 7 * 60 * 60 * 1_000;
/** Rare Beast Mastery R2/R3 lengthen the drake's time out. */
export const PET_RARE_BEAST_BONUS_MS = [0, 0, 40 * 60 * 1_000, 75 * 60 * 1_000] as const;
export const PET_MAX_LEVEL = EQUIPMENT_LEVEL_CAP;
export const PET_HEAL_ITEM_ID = "giving_berry";
export const PET_GLIMMER_COSTS = Object.freeze({
  hatch: 330,
  hermit: 120,
  train: 40,
  feed: 55,
  unlockAbility: 230
});
export type PetGlimmerCostKey = keyof typeof PET_GLIMMER_COSTS;
/** PvP: pet roots/holds on players stop at this length and repeat holds shrink (diminishing returns). */
export const PET_PVP_MAX_HOLD_MS = 2_000;
export const PET_PVP_DAMAGE_MULTIPLIER = 0.5;
/** Companion Bond by rank: heal per pet hit, ability cooldown multiplier, max-HP multiplier. */
export const COMPANION_BOND_HEAL_PER_HIT = [0, 2, 4, 5] as const;
export const COMPANION_BOND_ABILITY_COOLDOWN_MULTIPLIERS = [1, 0.93, 0.87, 0.8] as const;
export const COMPANION_BOND_MAX_HEALTH_MULTIPLIERS = [1, 1.25, 1.45, 1.75] as const;

const DAY_MS = 24 * 60 * 60 * 1_000;
const rankIndex = (rank: number): 0 | 1 | 2 | 3 => Math.max(0, Math.min(3, Math.trunc(rank))) as 0 | 1 | 2 | 3;

export function isPetSpeciesId(value: unknown): value is PetSpeciesId {
  return typeof value === "string" && (PET_SPECIES_IDS as readonly string[]).includes(value);
}

export function isPetAbilityId(value: unknown): value is PetAbilityId {
  return typeof value === "string" && (PET_ABILITY_IDS as readonly string[]).includes(value);
}

/** The species an egg (or broken whistle) item becomes, or null. */
export function petSpeciesForItem(itemId: string): PetSpeciesId | null {
  return PET_SPECIES_IDS.find((id) => PET_SPECIES_DEFINITIONS[id].source.itemId === itemId) ?? null;
}

/** Rest = 14 h − 40 min per trained level, at least 7 h; Druid rank 2+ caps it at 7 h. */
export function petRestDurationMs(level: number, druidRank = 0): number {
  const byLevel = Math.max(PET_REST_MIN_MS, PET_REST_BASE_MS - Math.max(0, Math.trunc(level)) * PET_REST_PER_LEVEL_MS);
  return druidRank >= 2 ? Math.min(byLevel, PET_REST_DRUID_MAX_MS) : byLevel;
}

export function petActiveDurationMs(speciesId: PetSpeciesId, rareBeastRank = 0): number {
  return PET_ACTIVE_DURATION_MS + (speciesId === "ember_drake" ? PET_RARE_BEAST_BONUS_MS[rankIndex(rareBeastRank)] : 0);
}

/** Training only counts up to the average of the owner's best weapon and best armour level. */
export function petGearCapLevel(bestWeaponLevel: number, bestArmorLevel: number): number {
  return Math.max(0, Math.floor((Math.max(0, bestWeaponLevel) + Math.max(0, bestArmorLevel)) / 2));
}

export function petEffectiveLevel(level: number, gearCapLevel: number): number {
  return Math.max(0, Math.min(level, gearCapLevel, PET_MAX_LEVEL));
}

export type PetCombatStats = Readonly<{ maxHp: number; damage: number; defense: number }>;

/**
 * Species HP scales by 0.9; species attack adds to a base hit of 4;
 * species defense is armour. Each effective level alternates +1 damage (odd) and +1 defense (even).
 */
export function petCombatStats(speciesId: PetSpeciesId, effectiveLevel: number): PetCombatStats {
  const base = PET_SPECIES_DEFINITIONS[speciesId].baseStats;
  const level = Math.max(0, Math.trunc(effectiveLevel));
  return {
    maxHp: Math.max(1, Math.round(base.hp * 0.9)),
    damage: Math.max(1, 4 + base.attack + Math.ceil(level / 2)),
    defense: Math.max(0, base.defense + Math.floor(level / 2))
  };
}

export function petAbilityCooldownMs(abilityId: PetAbilityId, companionBondRank = 0): number {
  return Math.round(PET_ABILITY_DEFINITIONS[abilityId].cooldownMs *
    COMPANION_BOND_ABILITY_COOLDOWN_MULTIPLIERS[rankIndex(companionBondRank)]);
}

export type PetStatus = "ready" | "active" | "resting";

export type PetSnapshot = Readonly<{
  id: string;
  species: PetSpeciesId;
  name: string;
  level: number;
  effectiveLevel: number;
  unlockedAbilities: PetAbilityId[];
  status: PetStatus;
  activeUntil: string | null;
  restUntil: string | null;
  /** How long this pet rests after an outing (level reduces it). */
  restDurationMs: number;
  lastFedAt: string;
  health: number;
  maxHealth: number;
  damage: number;
  defense: number;
  /** ISO time each ability is ready again (only while the pet is out). */
  abilityReadyAt: Partial<Record<PetAbilityId, string>>;
}>;

export type PetEggHolding = Readonly<{ itemId: string; species: PetSpeciesId; quantity: number }>;

export type PetStateSnapshot = Readonly<{
  pets: PetSnapshot[];
  activePetId: string | null;
  gearCapLevel: number;
  eggs: PetEggHolding[];
  healItemQuantity: number;
  /** Species the Grove Hermit sells, when the owner stands near the Hermit. */
  hermitOffers: PetSpeciesId[];
  /** Minions out right now (treants, thralls, echo). */
  minions?: MinionSnapshot[];
  /** Treants the owner may grow (Grove Lore rank). */
  treantCap?: number;
  serverTime: string;
}>;

/** A map ping from a tracking ability. */
export type PetTrackPing = Readonly<{
  abilityId: PetAbilityId;
  label: string;
  lat: number;
  lon: number;
  distanceM: number;
}>;

export type PetCompanionCommand = "stay" | "follow";

/** Drag-to-place Stay: the chosen spot may be at most this far from the owner. */
export const PET_STAY_PLACE_MAX_DISTANCE_M = 1_000;

/** Tail Lash reaches creatures, players and attackable structures this far from the drake. */
export const PET_TAIL_LASH_RADIUS_M = 90;
/** Tail Lash structure damage per structure per swing (a normal player hit does 25). */
export const PET_TAIL_LASH_STRUCTURE_DAMAGE = Object.freeze({ min: 90, max: 112 });

/**
 * Minions: granted by skills or gear rather than whistles, may enter dungeons, can't be sent home.
 * At most 5 at once per owner across every kind.
 */
export const MINION_CAP = 5;
export const TREANT_KINDS = ["duskroot", "mendbark", "fernguard", "frostwillow", "redwood", "shadespine"] as const;
export type TreantKind = (typeof TREANT_KINDS)[number];
export const MINION_SPECIES_IDS = [
  "treant_duskroot", "treant_mendbark", "treant_fernguard", "treant_frostwillow", "treant_redwood",
  "treant_shadespine", "bone_thrall", "grave_echo", "valkyrie"
] as const;
export type MinionSpeciesId = (typeof MINION_SPECIES_IDS)[number];
/** Everything that can walk beside a player: whistle pets and minions. */
export const COMPANION_SPECIES_IDS = [...PET_SPECIES_IDS, ...MINION_SPECIES_IDS] as const;
export type CompanionSpeciesId = PetSpeciesId | MinionSpeciesId;

export type TreantDefinition = Readonly<{ kind: TreantKind; displayName: string; description: string; artKey: string }>;
export const TREANT_DEFINITIONS: Readonly<Record<TreantKind, TreantDefinition>> = {
  duskroot: { kind: "duskroot", displayName: "Dusk Elderbark", description: "18% chance to poison on hit.", artKey: "treant-duskroot" },
  mendbark: { kind: "mendbark", displayName: "Mendbark", description: "Heals your other treants.", artKey: "treant-mendbark" },
  fernguard: { kind: "fernguard", displayName: "Elder Fern", description: "18% chance to Hone (dull the attack of) whatever attacks it.", artKey: "treant-fernguard" },
  frostwillow: { kind: "frostwillow", displayName: "Frostwillow", description: "Chills and slows what it hits.", artKey: "treant-frostwillow" },
  redwood: { kind: "redwood", displayName: "Redwood Bulwark", description: "Knocks enemies back.", artKey: "treant-redwood" },
  shadespine: { kind: "shadespine", displayName: "Shadespine Cactus", description: "Ranged; Withers its target.", artKey: "treant-shadespine" }
};
/** Grove Lore rank → treants at once. */
export const GROVE_LORE_TREANTS = [0, 1, 3, 4] as const;
export const TREANT_GROW_COOLDOWN_MS = 60_000;
export const TREANT_STATS = Object.freeze({ maxHp: 135, damage: 6, defense: 3 });
/**
 * Bone Thrall by level 1–5: HP 60→280, attack bonus 0→4. The design self-heal (9% max HP every
 * 12 s → 9.6 s) rounds to the nearest whole number of 1.4 s beats (ties to the shorter).
 * The heal scales by the same ratio, so heal per second holds.
 */
export const BONE_THRALL_MAX_LEVEL = 5;
export const BONE_THRALL_DURATION_MS = 45 * 60 * 1_000;
export const BONE_THRALL_SELF_HEAL_FRACTION = 0.09;
export function boneThrallStats(level: number): Readonly<{
  maxHp: number; damage: number; selfHealIntervalMs: number; selfHealFraction: number;
}> {
  const clamped = Math.max(1, Math.min(BONE_THRALL_MAX_LEVEL, Math.trunc(level)));
  const designIntervalMs = 12_000 - (clamped - 1) * 600;
  const beats = Math.max(1, Math.ceil(designIntervalMs / BASIC_ATTACK_INTERVAL_MS - 0.5));
  const selfHealIntervalMs = beats * BASIC_ATTACK_INTERVAL_MS;
  return {
    maxHp: 60 + 55 * (clamped - 1),
    damage: 4 + (clamped - 1),
    selfHealIntervalMs,
    selfHealFraction: BONE_THRALL_SELF_HEAL_FRACTION * selfHealIntervalMs / designIntervalMs
  };
}
/** Grave Echo: dying in Bonewrought Mail usually raises one echo of you; it never heals. */
export const GRAVE_ECHO_CHANCE = 0.75;
export const GRAVE_ECHO_DURATION_MS = 35 * 60 * 1_000;

/** Fallen Prison: a freed Caged Valkyrie fights beside the player who was in the cell wing, then leaves with the run. */
export const VALKYRIE_STATS = Object.freeze({ maxHp: 430, damage: 15, defense: 5 });
export const VALKYRIE_DURATION_MS = 40 * 60 * 1_000;

export type MinionSnapshot = Readonly<{
  species: MinionSpeciesId;
  level: number;
  expiresAt: string | null;
}>;
