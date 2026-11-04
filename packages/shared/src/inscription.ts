import type { EquipmentCategory } from "./equipmentContracts.js";

/** Lumen charged for every inscription, including a re-inscription. */
export const INSCRIBE_LUMEN_COST = 140;
/** Enhancement level (+N) an item needs before it can be inscribed. */
export const INSCRIBE_MIN_ITEM_LEVEL = 18;
export const INSCRIPTION_NAME_MIN = 3;
export const INSCRIPTION_NAME_MAX = 24;

export const WEAPON_INSCRIPTION_STATS = [
  "totalDamageDealt", "hits", "monstersKilledLand", "monstersKilledWater", "playersKilled",
  "debuffsApplied", "timesBroken"
] as const;
export const ARMOR_INSCRIPTION_STATS = [
  "totalDamageTaken", "hitsTaken", "highestDamageTaken", "reducedToOne", "deathsByMonsters",
  "deathsByPlayers", "debuffsApplied", "timesBroken"
] as const;
export type InscriptionStatKey =
  | (typeof WEAPON_INSCRIPTION_STATS)[number]
  | (typeof ARMOR_INSCRIPTION_STATS)[number];
export type InscriptionStats = Partial<Record<InscriptionStatKey, number>>;
export type InscriptionKind = "weapon" | "armor";

export type InscriptionSnapshot = Readonly<{
  name: string;
  inscriberName: string;
  inscribedAt: string;
  kind: InscriptionKind;
  stats: InscriptionStats;
}>;

export function inscriptionKind(category: EquipmentCategory): InscriptionKind | null {
  if (category === "melee_weapon" || category === "ranged_weapon") return "weapon";
  if (category === "shield" || category === "head_armor" || category === "chest_armor"
    || category === "gloves" || category === "boots") return "armor";
  return null;
}

/** Trimmed, single-spaced name, or null when it breaks the length or character rules. */
export function normalizeInscriptionName(raw: string): string | null {
  const name = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (name.length < INSCRIPTION_NAME_MIN || name.length > INSCRIPTION_NAME_MAX) return null;
  return /^[\p{L}\p{N}][\p{L}\p{N} '.\-]*$/u.test(name) ? name : null;
}

/** The shown average, e.g. damage per hit; 0 with no hits. */
export function inscriptionAverage(total: number | undefined, count: number | undefined): number {
  return count && count > 0 ? Math.round(((total ?? 0) / count) * 10) / 10 : 0;
}

/** Display rows for an inscription's counters (label, value). */
export function inscriptionStatRows(inscription: InscriptionSnapshot): readonly (readonly [string, string])[] {
  const s = inscription.stats;
  const n = (key: InscriptionStatKey): string => String(s[key] ?? 0);
  if (inscription.kind === "weapon") {
    return [
      ["Damage dealt", n("totalDamageDealt")],
      ["Damage per hit", String(inscriptionAverage(s.totalDamageDealt, s.hits))],
      ["Land creatures felled", n("monstersKilledLand")],
      ["Water creatures felled", n("monstersKilledWater")],
      ["Duelists felled", n("playersKilled")],
      ["Debuffs applied", n("debuffsApplied")],
      ["Times broken", n("timesBroken")]
    ];
  }
  return [
    ["Damage absorbed", n("totalDamageTaken")],
    ["Absorbed per hit", String(inscriptionAverage(s.totalDamageTaken, s.hitsTaken))],
    ["Heaviest blow taken", n("highestDamageTaken")],
    ["Brought to the brink", n("reducedToOne")],
    ["Felled by creatures", n("deathsByMonsters")],
    ["Felled by duelists", n("deathsByPlayers")],
    ["Debuffs applied", n("debuffsApplied")],
    ["Times broken", n("timesBroken")]
  ];
}
