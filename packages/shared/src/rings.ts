/**
 * Random-roll rings (docs/design/RINGS_AND_AMULETS.md). Everything here is data plus pure rolls:
 * tiers, the bonus ladder, roll weights, drop odds, polish and dump values, and the worn-ring
 * resolver (non-stacking, inactive rows). The server owns every roll and every write.
 */
import type { EquipmentMetal } from "./equipmentEnhancements.js";
import {
  MOB_BIOME_VARIANT_FAMILY_BASES,
  type MobBiomeVariantFamilyBase
} from "./mobContracts.js";

export const RING_TIERS = ["plain", "fine", "prime", "peerless"] as const;
export type RingTier = (typeof RING_TIERS)[number];

export const RING_DEFINITION_IDS = {
  plain: "ring_plain",
  fine: "ring_fine",
  prime: "ring_prime",
  peerless: "ring_peerless"
} as const satisfies Record<RingTier, string>;
export type RingDefinitionId = (typeof RING_DEFINITION_IDS)[RingTier];
export const RING_DEFINITION_ID_LIST: readonly RingDefinitionId[] = Object.freeze(
  RING_TIERS.map((tier) => RING_DEFINITION_IDS[tier])
);

/** The four retired stock rings; every copy converts into a Plain ring (migration 1070). */
export const RETIRED_STOCK_RING_IDS = [
  "training_ring", "chopping_ring", "mining_ring", "attack_ring"
] as const;

export const RING_SHARD_ITEM_ID = "ring_shard" as const;

/** Low, Medium and High strength, indexed 0, 1, 2. */
export type RingStrength = 0 | 1 | 2;
export const RING_STRENGTH_NAMES = ["Low", "Medium", "High"] as const;

export type RingTierRule = Readonly<{
  displayName: string;
  bonusCount: 1 | 2;
  strength: RingStrength;
  /** Glimmer Oil to polish: normal and Atlas Pass. Plain is never Rough. */
  polishOil: number;
  polishOilAtlasPass: number;
  dumpShardsRough: number;
  dumpShardsPolished: number;
}>;

export const RING_TIER_RULES: Readonly<Record<RingTier, RingTierRule>> = Object.freeze({
  plain: { displayName: "Plain Ring", bonusCount: 1, strength: 0, polishOil: 0, polishOilAtlasPass: 0, dumpShardsRough: 4, dumpShardsPolished: 4 },
  fine: { displayName: "Fine Ring", bonusCount: 2, strength: 0, polishOil: 12, polishOilAtlasPass: 7, dumpShardsRough: 8, dumpShardsPolished: 13 },
  prime: { displayName: "Prime Ring", bonusCount: 2, strength: 1, polishOil: 30, polishOilAtlasPass: 18, dumpShardsRough: 14, dumpShardsPolished: 22 },
  peerless: { displayName: "Peerless Ring", bonusCount: 2, strength: 2, polishOil: 60, polishOilAtlasPass: 36, dumpShardsRough: 22, dumpShardsPolished: 38 }
});

export function ringTierForDefinitionId(definitionId: string): RingTier | null {
  for (const tier of RING_TIERS) if (RING_DEFINITION_IDS[tier] === definitionId) return tier;
  return null;
}

export function ringPolishCost(tier: RingTier, atlasPass: boolean): number {
  const rule = RING_TIER_RULES[tier];
  return atlasPass ? rule.polishOilAtlasPass : rule.polishOil;
}

export function ringDumpShards(tier: RingTier, rough: boolean): number {
  const rule = RING_TIER_RULES[tier];
  return rough ? rule.dumpShardsRough : rule.dumpShardsPolished;
}

/**
 * live: has an effect today. lever: the mechanic exists but no ring hook yet. inflict: needs the
 * matching metal (and a hook). inert: waits on a system that has not shipped. replaced: themed swap,
 * inert for now. Only `wired` rows change gameplay; every row is still a legal roll.
 */
export type RingBonusStatus = "live" | "lever" | "inflict" | "inert" | "replaced";
export type RingBonusUnit = "percent" | "points" | "seconds" | "flat" | "minutes";

export type RingBonusDefinition = Readonly<{
  id: string;
  /** Ladder row. */
  row: number;
  name: string;
  /** Low / Medium / High; null where that strength has no value. */
  values: readonly [number | null, number | null, number | null];
  unit: RingBonusUnit;
  status: RingBonusStatus;
  /** True when a server hook applies the value today. */
  wired: boolean;
  /** Inflict rows: the metal the weapon or worn armor must carry. */
  metal?: EquipmentMetal;
  /** Quarry rows store the mob family chosen at roll time. */
  quarry?: true;
  /** Grouped rows share one roll entry, then one member is picked evenly. */
  group?: "gear_attunement" | "pet_tamer";
  /** Shown under the value in the tooltip. */
  note?: string;
}>;

function bonus(
  row: number,
  id: string,
  name: string,
  values: readonly [number | null, number | null, number | null],
  unit: RingBonusUnit,
  status: RingBonusStatus,
  extra: Partial<Pick<RingBonusDefinition, "metal" | "quarry" | "group" | "note" | "wired">> = {}
): RingBonusDefinition {
  return Object.freeze({ row, id, name, values, unit, status, wired: false, ...extra });
}

const pct = (low: number, medium: number, high: number) => [low, medium, high] as const;

const GEAR_ATTUNEMENT_PIECES = [
  [62, "sword", "Sword"], [63, "axe", "Axe"], [64, "bow", "Bow"], [65, "crossbow", "Crossbow"],
  [66, "sling", "Sling"], [67, "shuriken", "Shuriken"], [68, "blowdart", "Blowdart"],
  [69, "spear", "Spear"], [70, "dagger", "Dagger"], [71, "brass_knuckles", "Brass Knuckles"],
  [72, "staff", "Staff"], [73, "leather", "Leather"], [74, "breastplate", "Breastplate"],
  [75, "tunic", "Tunic"], [76, "shield", "Shield"], [77, "drake_scalemail", "Drake scalemail"],
  [78, "drake_shield", "Drake shield"]
] as const;
const GEAR_ATTUNEMENT_ARMOR = new Set(["leather", "breastplate", "tunic", "shield", "drake_scalemail", "drake_shield"]);
const GEAR_ATTUNEMENT_INERT = new Set(["drake_scalemail", "drake_shield"]);

/** Every ring bonus, rows 1-78 of the bonus ladder (Low / Medium / High values). */
export const RING_BONUSES: readonly RingBonusDefinition[] = Object.freeze([
  bonus(1, "storm_chance", "Storm chance", pct(11, 22, 33), "percent", "inflict", { metal: "lightning" }),
  bonus(2, "storm_damage", "Storm damage", pct(12, 16, 26), "percent", "inflict", { metal: "lightning" }),
  bonus(3, "skyrise_chance", "Skyrise chance", pct(11, 24, 36), "percent", "inflict", { metal: "skyrise" }),
  bonus(4, "skyrise_duration", "Skyrise duration", pct(1.25, 2.5, 3.25), "seconds", "inflict", { metal: "skyrise" }),
  bonus(5, "gale_distance", "Gale distance", pct(12, 23, 33), "percent", "inflict", { metal: "gale" }),
  bonus(6, "gale_chance", "Gale chance", pct(8, 17, 26), "percent", "inflict", { metal: "gale" }),
  bonus(7, "mirage_chance", "Mirage chance", pct(8, 16, 24), "percent", "inflict", { metal: "mirage" }),
  bonus(8, "cleave_chance", "Cleave chance", pct(1.25, 3.5, 5.5), "points", "lever"),
  bonus(9, "cleave_damage", "Cleave damage", pct(6, 9, 16), "percent", "lever"),
  bonus(10, "tactics_hold", "Tactics hold", pct(2.5, 4.5, 7.5), "seconds", "lever", { note: "slower drain" }),
  bonus(11, "tactics_build", "Tactics build", pct(2.5, 4.5, 6.5), "seconds", "lever", { note: "faster gain" }),
  bonus(12, "scavenge_chance", "Scavenge chance", pct(1.25, 2.25, 3.25), "points", "lever"),
  bonus(13, "huntsman_chance", "Huntsman chance", pct(1.25, 1.75, 2.75), "points", "lever"),
  bonus(14, "huntsman_damage", "Huntsman damage", pct(17, 33, 60), "percent", "lever"),
  bonus(15, "perfect_strike_chance", "Perfect Strike chance", pct(1.25, 2.25, 2.75), "points", "lever"),
  bonus(16, "war_standard_cooldown", "War Standard cooldown", pct(-1.25, -2.25, -3.25), "minutes", "lever"),
  bonus(17, "second_wind_health", "Second Wind health", pct(1.25, 3.5, 5.5), "points", "lever"),
  bonus(18, "taunt_cooldown", "Taunt cooldown", pct(-11, -22, -32), "seconds", "lever"),
  bonus(19, "deathburst_damage", "Deathburst damage", pct(4, 6.5, 10), "percent", "lever"),
  bonus(20, "cleanse_cooldown", "Cleanse cooldown", pct(-13, -22, -34), "seconds", "lever"),
  bonus(21, "peerless_luck", "Peerless luck", pct(4, 5, 9), "points", "live", { wired: true, note: "better ring drops" }),
  bonus(22, "dodge", "Dodge", pct(1.25, 3.5, 5.5), "points", "lever", { note: "only if you can already dodge" }),
  bonus(23, "max_hp", "Max HP", pct(6, 11, 17), "flat", "live", { wired: true }),
  bonus(24, "land_speed", "Land speed", pct(1.25, 2.5, 3.75), "percent", "live", { wired: true }),
  bonus(25, "water_speed", "Water speed", pct(1.25, 2.5, 3.5), "percent", "inert"),
  bonus(26, "bow_reach", "Bow reach", pct(13, 18, 31), "flat", "lever"),
  bonus(27, "frost_bite", "Frost bite", pct(-8, -12, -17), "flat", "inflict", { metal: "ice", note: "target speed" }),
  bonus(28, "frost_ward", "Frost ward", pct(11, 14, 21), "flat", "lever"),
  bonus(29, "expel_touch", "Expel touch", pct(1.25, 3, 6), "points", "inflict", { metal: "expel" }),
  bonus(30, "expel_ward", "Expel ward", pct(1.25, 3, 5.5), "points", "lever"),
  bonus(31, "venom_bite", "Venom bite", pct(0.6, 0.75, 1.75), "flat", "inflict", { metal: "venomsteel" }),
  bonus(32, "venom_ward", "Venom ward", pct(0.6, 0.75, 1.75), "flat", "live", { wired: true, note: "less Venom damage per tick" }),
  bonus(33, "gloom_reach", "Gloom reach", pct(1.5, 2.5, 5.5), "seconds", "inflict", { metal: "gloom" }),
  bonus(34, "gloom_ward", "Gloom ward", [null, 3, 6], "seconds", "lever"),
  bonus(35, "whetted_edge", "Whetted edge", pct(9, 12, 17), "points", "inflict", { metal: "whetted" }),
  bonus(36, "whetted_ward", "Whetted ward", pct(9, 16, 21), "points", "lever"),
  bonus(37, "revenant_attack", "Revenant attack", pct(1.25, 2.25, 3.5), "flat", "inert"),
  bonus(38, "revenant_defense", "Revenant defense", pct(0.75, 2.25, 2.5), "flat", "inert"),
  bonus(39, "ember_bite", "Ember bite", pct(0.6, 1.25, 2.25), "flat", "inflict", { metal: "fire" }),
  bonus(40, "ember_ward", "Ember ward", pct(0.6, 1.25, 2.25), "flat", "live", { wired: true, note: "less Ember damage per tick" }),
  bonus(41, "fleet_chopper", "Fleet chopper", pct(-3.5, -5.5, -10.5), "seconds", "live", { wired: true, note: "chop time" }),
  bonus(42, "fleet_miner", "Fleet miner", pct(-3.5, -5.5, -11), "seconds", "live", { wired: true, note: "mine time" }),
  bonus(43, "fleet_builder", "Fleet builder", pct(-11, -23, -59), "percent", "lever"),
  bonus(44, "fleet_crafter", "Fleet crafter", pct(-11, -21, -62), "percent", "lever"),
  bonus(45, "root_ward", "Root ward", pct(-3.5, -5.5, -9.5), "seconds", "live", { wired: true, note: "shorter web roots" }),
  bonus(46, "snare_ward", "Snare ward", pct(-2.5, -4.5, -10.5), "seconds", "live", { wired: true, note: "shorter nets and trap roots" }),
  bonus(47, "weaken_ward", "Weaken ward", pct(-3.5, -4, -5.5), "seconds", "replaced"),
  bonus(48, "knockdown_ward", "Knockdown ward", pct(-2.5, -4, -6), "seconds", "inert"),
  bonus(49, "hound_trainer", "Hound trainer", pct(1.25, 2.25, 3.25), "flat", "inert", { group: "pet_tamer" }),
  bonus(50, "wolf_tamer", "Wolf tamer", pct(1.25, 2.25, 2.75), "flat", "inert", { group: "pet_tamer" }),
  bonus(51, "boar_tamer", "Boar tamer", pct(1.25, 2.25, 3.25), "flat", "inert", { group: "pet_tamer" }),
  bonus(52, "stormbird_tamer", "Stormbird tamer", pct(1.25, 2.25, 3.75), "flat", "inert", { group: "pet_tamer" }),
  bonus(53, "drake_tamer", "Drake tamer", pct(1.25, 2.25, 3.25), "flat", "inert", { group: "pet_tamer" }),
  bonus(54, "quarry_hunter", "Quarry hunter", pct(1.25, 2.25, 3.25), "flat", "lever", { quarry: true, note: "attack" }),
  bonus(55, "quarry_guard", "Quarry guard", pct(1.25, 2.25, 3.75), "flat", "lever", { quarry: true, note: "defense" }),
  bonus(56, "hollin_helper_attack", "Hollin helper attack", pct(1.25, 2.25, 3.25), "flat", "inert"),
  bonus(57, "hollin_helper_defense", "Hollin helper defense", pct(1.25, 2.25, 3.5), "flat", "inert"),
  bonus(58, "treant_attack", "Treant strength attack", pct(1.25, 2.25, 3.25), "flat", "inert"),
  bonus(59, "treant_defense", "Treant strength defense", pct(0.75, 1.75, 2.75), "flat", "inert"),
  bonus(60, "deepstone_yield", "Deepstone yield", pct(6, 11, 16), "points", "live", { wired: true, note: "needs Deepstone Lore" }),
  bonus(61, "blight_ward", "Blight ward", pct(-29, -65, -114), "percent", "replaced"),
  ...GEAR_ATTUNEMENT_PIECES.map(([row, piece, name]) => bonus(
    row,
    `attune_${piece}`,
    `${name} attunement`,
    [null, null, GEAR_ATTUNEMENT_INERT.has(piece) ? 3 : 2],
    "flat",
    GEAR_ATTUNEMENT_INERT.has(piece) ? "inert" : "lever",
    {
      group: "gear_attunement",
      wired: !GEAR_ATTUNEMENT_INERT.has(piece),
      note: GEAR_ATTUNEMENT_ARMOR.has(piece) ? "defense with that piece" : "damage with that weapon"
    }
  ))
]);

export type RingBonusId = string;
const RING_BONUS_BY_ID: ReadonlyMap<string, RingBonusDefinition> = new Map(
  RING_BONUSES.map((entry) => [entry.id, entry])
);

export function ringBonusDefinition(id: string): RingBonusDefinition | null {
  return RING_BONUS_BY_ID.get(id) ?? null;
}

/** Gear attunement rows: piece -> equipment gameplay families it matches. */
export const RING_GEAR_ATTUNEMENT_FAMILIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  attune_sword: ["sword"], attune_axe: ["axe"], attune_bow: ["bow"], attune_crossbow: ["crossbow"],
  attune_sling: ["sling"], attune_shuriken: ["shuriken"], attune_blowdart: ["blowdart"],
  attune_spear: ["spear"], attune_dagger: ["dagger"], attune_brass_knuckles: ["brass_knuckles"],
  attune_staff: ["staff"], attune_leather: ["leather"], attune_breastplate: ["breastplate"],
  attune_tunic: ["tunic"], attune_shield: ["melee_shield", "ranged_shield"]
});

/** Roll weights (spec "Bonus roll weights"); inert rows roll at half their normal weight. */
const RING_BONUS_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  max_hp: 5, land_speed: 3, fleet_chopper: 3, fleet_miner: 3,
  dodge: 4, bow_reach: 2, frost_ward: 2.5, venom_ward: 3.5, ember_ward: 2.5, fleet_builder: 2,
  fleet_crafter: 2.5, root_ward: 2, snare_ward: 3.5,
  peerless_luck: 1.5, weaken_ward: 1.5, blight_ward: 0.75,
  water_speed: 2.5, revenant_attack: 0.75, revenant_defense: 0.75, knockdown_ward: 1.25,
  hollin_helper_attack: 1.25, hollin_helper_defense: 0.75, treant_attack: 1.25, treant_defense: 1.25
});
const RING_GROUP_WEIGHTS = Object.freeze({ gear_attunement: 1.25, pet_tamer: 0.75 });
const DEFAULT_RING_BONUS_WEIGHT = 2.25;

export type RingBonusRoll = Readonly<{
  id: RingBonusId;
  /** Quarry rows only: the mob family the bonus applies to. */
  family?: MobBiomeVariantFamilyBase;
}>;

export const RING_QUARRY_FAMILIES: readonly MobBiomeVariantFamilyBase[] = MOB_BIOME_VARIANT_FAMILY_BASES;

export type RingRandom = () => number;

function pickIndex(random: RingRandom, length: number): number {
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
}

function withQuarry(definition: RingBonusDefinition, random: RingRandom): RingBonusRoll {
  return definition.quarry
    ? { id: definition.id, family: RING_QUARRY_FAMILIES[pickIndex(random, RING_QUARRY_FAMILIES.length)]! }
    : { id: definition.id };
}

/**
 * Picks the ring's bonuses without replacement: rows without a value at the tier's strength and
 * the Peerless-only gear rows (outside Peerless) are skipped; grouped rows share one weighted entry.
 */
export function rollRingBonuses(tier: RingTier, random: RingRandom): RingBonusRoll[] {
  const rule = RING_TIER_RULES[tier];
  type Entry = { weight: number; members: RingBonusDefinition[] };
  const groups = new Map<string, Entry>();
  const entries: Entry[] = [];
  for (const definition of RING_BONUSES) {
    if (definition.values[rule.strength] === null) continue;
    if (definition.group) {
      let entry = groups.get(definition.group);
      if (!entry) {
        entry = { weight: RING_GROUP_WEIGHTS[definition.group], members: [] };
        groups.set(definition.group, entry);
        entries.push(entry);
      }
      entry.members.push(definition);
      continue;
    }
    entries.push({ weight: RING_BONUS_WEIGHTS[definition.id] ?? DEFAULT_RING_BONUS_WEIGHT, members: [definition] });
  }
  const picked: RingBonusRoll[] = [];
  while (picked.length < rule.bonusCount && entries.length > 0) {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    let target = random() * total;
    let index = entries.length - 1;
    for (let candidate = 0; candidate < entries.length; candidate += 1) {
      target -= entries[candidate]!.weight;
      if (target < 0) { index = candidate; break; }
    }
    const [entry] = entries.splice(index, 1);
    const member = entry!.members[pickIndex(random, entry!.members.length)]!;
    picked.push(withQuarry(member, random));
  }
  return picked;
}

/** Old stock rings convert to a Plain ring with one Low bonus picked evenly (no weights). */
export const RING_LOW_ELIGIBLE_BONUS_IDS: readonly string[] = Object.freeze(
  RING_BONUSES.filter((entry) => entry.values[0] !== null).map((entry) => entry.id)
);

export function rollConversionRingBonus(random: RingRandom): RingBonusRoll {
  const definition = ringBonusDefinition(
    RING_LOW_ELIGIBLE_BONUS_IDS[pickIndex(random, RING_LOW_ELIGIBLE_BONUS_IDS.length)]!
  )!;
  return withQuarry(definition, random);
}

export function isValidRingBonusRolls(tier: RingTier, bonuses: readonly RingBonusRoll[]): boolean {
  const rule = RING_TIER_RULES[tier];
  if (bonuses.length !== rule.bonusCount) return false;
  const seen = new Set<string>();
  for (const roll of bonuses) {
    const definition = ringBonusDefinition(roll.id);
    if (!definition || seen.has(roll.id)) return false;
    seen.add(roll.id);
    if (definition.quarry !== undefined) {
      if (!roll.family || !RING_QUARRY_FAMILIES.includes(roll.family)) return false;
    } else if (roll.family !== undefined) return false;
    // A converted Plain may carry any Low row; dropped rings carry their tier's strength.
    if (definition.values[rule.strength] === null) return false;
  }
  return true;
}

export function parseRingBonusRolls(value: unknown): RingBonusRoll[] | null {
  if (!Array.isArray(value)) return null;
  const rolls: RingBonusRoll[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !ringBonusDefinition(record.id)) return null;
    if (record.family !== undefined) {
      if (typeof record.family !== "string" ||
        !RING_QUARRY_FAMILIES.includes(record.family as MobBiomeVariantFamilyBase)) return null;
      rolls.push({ id: record.id, family: record.family as MobBiomeVariantFamilyBase });
    } else {
      rolls.push({ id: record.id });
    }
  }
  return rolls;
}

export function ringBonusValue(tier: RingTier, id: string): number {
  const definition = ringBonusDefinition(id);
  return definition?.values[RING_TIER_RULES[tier].strength] ?? 0;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

/** "+10%", "-3 s", "+5" ... for the tooltip. */
export function formatRingBonusValue(id: string, value: number): string {
  const definition = ringBonusDefinition(id);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const magnitude = formatNumber(Math.abs(value));
  switch (definition?.unit) {
    case "percent": return `${sign}${magnitude}%`;
    case "points": return `${sign}${magnitude} pts`;
    case "seconds": return `${sign}${magnitude} s`;
    case "minutes": return `${sign}${magnitude} min`;
    default: return `${sign}${magnitude}`;
  }
}

export function ringBonusLabel(roll: RingBonusRoll): string {
  const definition = ringBonusDefinition(roll.id);
  const name = definition?.name ?? roll.id;
  return roll.family ? `${name} (${roll.family.replaceAll("_", " ")})` : name;
}

export function ringBonusKey(roll: RingBonusRoll): string {
  return roll.family ? `${roll.id}:${roll.family}` : roll.id;
}

/** What the client sees of one ring. Rough rings carry no bonuses (tier only). */
export type RingInstanceView = Readonly<{
  tier: RingTier;
  rough: boolean;
  bonuses: readonly RingBonusRoll[];
}>;

export type WornRing = Readonly<{
  instanceId: string;
  tier: RingTier;
  rough: boolean;
  bonuses: readonly RingBonusRoll[];
}>;

export type WornRingBonusState = "active" | "duplicate" | "inactive";

export type WornRingBonusLine = Readonly<{
  instanceId: string;
  id: string;
  key: string;
  value: number;
  state: WornRingBonusState;
}>;

export type WornRingResolution = Readonly<{
  lines: readonly WornRingBonusLine[];
  /** Effective values of wired rows, keyed by bonus key (quarry rows carry their family). */
  totals: Readonly<Record<string, number>>;
}>;

/**
 * Both worn rings (slot 1 first). The same bonus never stacks: only the highest absolute value
 * counts and equal values keep slot 1. Rows that are not wired, and inflict rows without their
 * metal, show "inactive".
 */
export function resolveWornRingBonuses(
  rings: readonly (WornRing | null)[],
  metals: ReadonlySet<string> = new Set()
): WornRingResolution {
  const candidates: { instanceId: string; roll: RingBonusRoll; value: number; order: number }[] = [];
  let order = 0;
  for (const ring of rings) {
    if (!ring || ring.rough) continue;
    for (const roll of ring.bonuses) {
      candidates.push({ instanceId: ring.instanceId, roll, value: ringBonusValue(ring.tier, roll.id), order: order++ });
    }
  }
  const winners = new Map<string, number>();
  for (const candidate of candidates) {
    const key = ringBonusKey(candidate.roll);
    const current = winners.get(key);
    if (current === undefined || Math.abs(candidate.value) > Math.abs(candidates[current]!.value)) {
      winners.set(key, candidates.indexOf(candidate));
    }
  }
  const totals: Record<string, number> = {};
  const lines = candidates.map((candidate, index) => {
    const key = ringBonusKey(candidate.roll);
    const definition = ringBonusDefinition(candidate.roll.id)!;
    const metalMissing = definition.metal !== undefined && !metals.has(definition.metal);
    let state: WornRingBonusState;
    if (winners.get(key) !== index) state = "duplicate";
    else if (!definition.wired || metalMissing) state = "inactive";
    else {
      state = "active";
      totals[key] = candidate.value;
    }
    return { instanceId: candidate.instanceId, id: candidate.roll.id, key, value: candidate.value, state };
  });
  return { lines, totals };
}

/** Fleet chopper / Fleet miner: negative seconds off a gathering action, never below 1 s. */
export const RING_MIN_ACTION_DURATION_MS = 1_000;
export function applyRingSecondsToDuration(durationMs: number, ringSeconds: number): number {
  if (!(ringSeconds < 0) || durationMs <= RING_MIN_ACTION_DURATION_MS) return durationMs;
  return Math.max(RING_MIN_ACTION_DURATION_MS, Math.round(durationMs + ringSeconds * 1_000));
}

// --- Drop odds (Ash Atlas design; data so odds change without logic) ---

export type RingDropSource = "normal" | "elite" | "boss" | "legendary";

export const RING_DROP_CHANCES: Readonly<Record<RingDropSource, number>> = Object.freeze({
  normal: 0.006,
  elite: 0.035,
  boss: 0.22,
  legendary: 0.45
});
/** Legendaries also get a second, independent ring roll. */
export const RING_LEGENDARY_SECOND_CHANCE = 0.12;

/** Tier weights (Plain, Fine, Prime, Peerless) by mob level row. */
export const RING_TIER_WEIGHT_ROWS: readonly Readonly<{ minLevel: number; weights: readonly [number, number, number, number] }>[] =
  Object.freeze([
    { minLevel: 0, weights: [76, 24, 0, 0] },
    { minLevel: 10, weights: [48, 36, 16, 0] },
    { minLevel: 20, weights: [18, 42, 28, 12] },
    { minLevel: 30, weights: [6, 26, 42, 26] }
  ]);
export const RING_ELITE_WEIGHT_SHIFT = 15;

export function ringTierWeightRowIndex(mobLevel: number, source: RingDropSource): number {
  const safe = Number.isFinite(mobLevel) ? Math.max(0, Math.trunc(mobLevel)) : 0;
  let index = 0;
  for (const [candidate, row] of RING_TIER_WEIGHT_ROWS.entries()) if (safe >= row.minLevel) index = candidate;
  if (source === "boss" || source === "legendary") index = Math.min(RING_TIER_WEIGHT_ROWS.length - 1, index + 1);
  return index;
}

/** Final tier weights for a drop: elite shift first, then Peerless luck (only where Peerless already has weight). */
export function ringTierWeights(input: Readonly<{
  mobLevel: number;
  source: RingDropSource;
  peerlessLuck?: number;
  rowIndex?: number;
}>): [number, number, number, number] {
  const weights = [...RING_TIER_WEIGHT_ROWS[
    input.rowIndex ?? ringTierWeightRowIndex(input.mobLevel, input.source)
  ]!.weights] as [number, number, number, number];
  if (input.source === "elite") {
    // Move 15 points up one tier, taken from Plain, then Fine.
    let remaining = RING_ELITE_WEIGHT_SHIFT;
    for (let tier = 0; tier < 3 && remaining > 0; tier += 1) {
      const moved = Math.min(weights[tier]!, remaining);
      weights[tier]! -= moved;
      weights[tier + 1]! += moved;
      remaining -= moved;
    }
  }
  const luck = Math.max(0, input.peerlessLuck ?? 0);
  if (luck > 0 && weights[3] > 0) {
    let remaining = luck;
    for (let tier = 0; tier < 3 && remaining > 0; tier += 1) {
      const moved = Math.min(weights[tier]!, remaining);
      weights[tier]! -= moved;
      weights[3] += moved;
      remaining -= moved;
    }
  }
  return weights;
}

export function rollRingTier(weights: readonly [number, number, number, number], random: RingRandom): RingTier {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = random() * total;
  for (const [index, weight] of weights.entries()) {
    target -= weight;
    if (target < 0 && weight > 0) return RING_TIERS[index]!;
  }
  for (let index = weights.length - 1; index >= 0; index -= 1) if (weights[index]! > 0) return RING_TIERS[index]!;
  return "plain";
}

/** Rolls a kill's ring drops (0, 1 or, for a legendary, 2 tiers). */
export function rollRingDrops(input: Readonly<{
  source: RingDropSource | null;
  mobLevel: number;
  peerlessLuck?: number;
  random: RingRandom;
}>): RingTier[] {
  if (input.source === null) return [];
  const source = input.source;
  const rolls = [RING_DROP_CHANCES[source], ...(source === "legendary" ? [RING_LEGENDARY_SECOND_CHANCE] : [])];
  const tiers: RingTier[] = [];
  for (const chance of rolls) {
    if (input.random() >= chance) continue;
    tiers.push(rollRingTier(ringTierWeights({
      mobLevel: input.mobLevel,
      source,
      ...(input.peerlessLuck === undefined ? {} : { peerlessLuck: input.peerlessLuck })
    }), input.random));
  }
  return tiers;
}

/** Mining-pool rings (Deepstone Lore rare find) always use the 1-9 row. */
export function rollMiningPoolRingTier(key: string): RingTier {
  return rollRingTier(RING_TIER_WEIGHT_ROWS[0]!.weights, seededRingRandom(`mining-ring:${key}`));
}

/** Deterministic [0, 1) stream from a string key (replay-safe server rolls). */
export function seededRingRandom(key: string): RingRandom {
  let h = 1779033703 ^ key.length;
  for (let index = 0; index < key.length; index += 1) {
    h = Math.imul(h ^ key.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
