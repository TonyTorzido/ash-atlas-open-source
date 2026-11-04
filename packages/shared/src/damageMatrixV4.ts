import {
  CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE,
  CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE,
  FUTURE_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE,
  normalizeV3NormalWeaponDamage,
  type PvpDamageDefenseProfileV3,
  type PvpDamageWeaponProfileV3
} from "./damageMatrixV3.js";

/**
 * Damage matrix v4 (docs/plans/class-roster-v2.md section 6): plain multipliers over five damage
 * types and nine armour types, replacing the raw table. Behind DAMAGE_MATRIX_V4_ENABLED; with the
 * flag off nothing here is read by combat.
 *
 * final damage = (weapon base + flat attack - flat defense) x multiplier x level factor x swing/shot factor
 */
export const DAMAGE_TYPES_V4 = ["slash", "pierce", "blunt", "radiant", "arcane"] as const;
export type DamageTypeV4 = (typeof DAMAGE_TYPES_V4)[number];

/** The first five apply to players and mobs; bone, spirit, ooze and bark are mob-only. */
export const ARMOUR_TYPES_V4 = [
  "unarmoured", "cloth", "leather", "mail", "plate", "bone", "spirit", "ooze", "bark"
] as const;
export type ArmourTypeV4 = (typeof ARMOUR_TYPES_V4)[number];
export type PlayerArmourTypeV4 = Extract<ArmourTypeV4, "unarmoured" | "cloth" | "leather" | "mail" | "plate">;

export const DAMAGE_TYPE_V4_LABELS = Object.freeze({
  slash: "Slash", pierce: "Pierce", blunt: "Blunt", radiant: "Radiant", arcane: "Arcane"
} as const satisfies Readonly<Record<DamageTypeV4, string>>);

export const ARMOUR_TYPE_V4_LABELS = Object.freeze({
  unarmoured: "Unarmoured", cloth: "Cloth", leather: "Leather", mail: "Mail", plate: "Plate",
  bone: "Bone", spirit: "Spirit", ooze: "Ooze", bark: "Bark"
} as const satisfies Readonly<Record<ArmourTypeV4, string>>);

/** Plain multipliers per damage type and armour type. */
export const DAMAGE_MATRIX_V4 = Object.freeze({
  slash:   { unarmoured: 1.50, cloth: 1.30, leather: 1.15, mail: 0.70, plate: 0.60, bone: 0.75, spirit: 0.60, ooze: 0.75, bark: 1.25 },
  pierce:  { unarmoured: 1.40, cloth: 1.20, leather: 1.15, mail: 1.00, plate: 0.80, bone: 0.50, spirit: 0.60, ooze: 0.75, bark: 0.50 },
  blunt:   { unarmoured: 1.25, cloth: 1.10, leather: 1.00, mail: 1.10, plate: 1.15, bone: 1.50, spirit: 0.60, ooze: 0.50, bark: 0.75 },
  radiant: { unarmoured: 1.25, cloth: 1.00, leather: 1.00, mail: 1.00, plate: 1.00, bone: 1.40, spirit: 1.50, ooze: 1.00, bark: 1.00 },
  arcane:  { unarmoured: 1.25, cloth: 1.00, leather: 1.00, mail: 1.05, plate: 1.05, bone: 1.00, spirit: 1.15, ooze: 1.25, bark: 1.25 }
} as const satisfies Readonly<Record<DamageTypeV4, Readonly<Record<ArmourTypeV4, number>>>>);

/** Spec 6.4: +-5% per level of difference, capped at +-50%. */
export const DAMAGE_V4_LEVEL_STEP = 0.05;
export const DAMAGE_V4_LEVEL_CAP = 0.5;

export function damageV4LevelFactor(attackerLevel: number, defenderLevel: number): number {
  const delta = (attackerLevel - defenderLevel) * DAMAGE_V4_LEVEL_STEP;
  return 1 + Math.min(DAMAGE_V4_LEVEL_CAP, Math.max(-DAMAGE_V4_LEVEL_CAP, delta));
}

/**
 * Weapon profiles: the v3 profile ids plus the two new families. Players and mobs share them (a mob's
 * base hit comes from its v3 weapon type; its damage type comes from MOB_V4_PROFILES).
 */
export type WeaponProfileV4 = PvpDamageWeaponProfileV3 | "hammer" | "scepter";

export type WeaponProfileV4Stats = Readonly<{ damageType: DamageTypeV4; baseDamage: number }>;

/**
 * Spec 6.6 bases for sword, axe (Double Axe), hammer, bow, scepter and staff. The legacy off-class
 * families (spec section 7) have no spec base: each takes the spec base of the v3 row it matched
 * (crossbow, shuriken, blowdart = longbow; wand = staff), otherwise its v3 unarmored cell scaled by
 * 8/9 (the sword's 9 -> 8) and rounded to the half.
 */
export const WEAPON_PROFILES_V4 = Object.freeze({
  sword: { damageType: "slash", baseDamage: 8 },
  axe: { damageType: "slash", baseDamage: 10 },
  hammer: { damageType: "blunt", baseDamage: 9 },
  longbow: { damageType: "pierce", baseDamage: 7 },
  // Placeholder until the Cleric's scepter family exists.
  scepter: { damageType: "radiant", baseDamage: 6 },
  staff: { damageType: "arcane", baseDamage: 7 },
  wand: { damageType: "arcane", baseDamage: 7 },
  spear: { damageType: "pierce", baseDamage: 8 },
  dagger: { damageType: "pierce", baseDamage: 7.5 },
  crossbow: { damageType: "pierce", baseDamage: 7 },
  shuriken: { damageType: "pierce", baseDamage: 7 },
  blowdart: { damageType: "pierce", baseDamage: 7 },
  sling: { damageType: "blunt", baseDamage: 6 },
  brass_knuckles: { damageType: "blunt", baseDamage: 7 },
  martial_arts: { damageType: "blunt", baseDamage: 5.5 },
  unarmed: { damageType: "blunt", baseDamage: 3 }
} as const satisfies Readonly<Record<WeaponProfileV4, WeaponProfileV4Stats>>);

/** Equipment families v3 has no row for. */
export const V4_ONLY_EQUIPMENT_FAMILY_TO_WEAPON_PROFILE = Object.freeze({
  hammer: "hammer",
  scepter: "scepter"
} as const satisfies Readonly<Record<string, WeaponProfileV4>>);

/** Bare hands are `unarmed`; an unknown family is null (the caller keeps its legacy path). */
export function resolveV4WeaponProfileForEquipmentFamily(equipmentFamilyId: string | null): WeaponProfileV4 | null {
  if (equipmentFamilyId === null) return "unarmed";
  return V4_ONLY_EQUIPMENT_FAMILY_TO_WEAPON_PROFILE[equipmentFamilyId as keyof typeof V4_ONLY_EQUIPMENT_FAMILY_TO_WEAPON_PROFILE] ??
    CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE[equipmentFamilyId as keyof typeof CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE] ??
    null;
}

/** v3 body profiles to v4 armour (tunic = cloth, chainmail = mail, breastplate = plate). */
export const V3_BODY_PROFILE_TO_V4_ARMOUR = Object.freeze({
  unarmored: "unarmoured",
  martial_tunic: "cloth",
  leather: "leather",
  chainmail: "mail",
  breastplate: "plate"
} as const satisfies Readonly<Record<Exclude<PvpDamageDefenseProfileV3, "shield" | "wyrm_shield">, PlayerArmourTypeV4>>);

/**
 * v4 has no shield column. Today's provisional rule is kept (a shielded defender takes the lower of
 * the body and shield results); the shield result reads this column. Provisional: both shields defend
 * as plate until the Paladin's block design lands.
 */
export const V4_SHIELD_ARMOUR_TYPE: PlayerArmourTypeV4 = "plate";

export type PlayerDefenseV4Resolution = Readonly<{ kind: "body"; armourType: PlayerArmourTypeV4 } | { kind: "shield" }>;

/** Bare skin is unarmoured; an unknown family is null (the caller keeps its legacy path). */
export function resolveV4DefenseForEquipmentFamily(equipmentFamilyId: string | null): PlayerDefenseV4Resolution | null {
  if (equipmentFamilyId === null) return { kind: "body", armourType: "unarmoured" };
  const v3 = CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE[equipmentFamilyId as keyof typeof CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE] ??
    FUTURE_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE[equipmentFamilyId as keyof typeof FUTURE_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE];
  if (v3 === undefined) return null;
  if (v3 === "shield" || v3 === "wyrm_shield") return { kind: "shield" };
  return { kind: "body", armourType: V3_BODY_PROFILE_TO_V4_ARMOUR[v3] };
}

export type DamageMatrixV4Input = Readonly<{
  damageType: DamageTypeV4;
  baseDamage: number;
  armourType: ArmourTypeV4;
  /** Shielded player defenders only; the shield defends as V4_SHIELD_ARMOUR_TYPE at its own level. */
  shielded?: boolean;
  /** Weapon item level for players, combat level for mobs. */
  attackerLevel: number;
  /** Mob combat level, or the player's body-armour level. */
  defenderLevel: number;
  shieldLevel?: number;
  /** Additive attack above the weapon base (rings, class bonuses, weapon base bonus). */
  flatAttack?: number;
  flatBodyDefense?: number;
  flatShieldDefense?: number;
  /** Everything multiplicative after the matrix: swing/shot factors, class and mob multipliers. */
  multiplier?: number;
}>;

export type DamageMatrixV4Resolution = Readonly<{
  bodyRawDamage: number;
  shieldRawDamage: number | null;
  selectedRawDamage: number;
  finalDamage: number;
}>;

export function resolveDamageMatrixV4(input: DamageMatrixV4Input): DamageMatrixV4Resolution {
  const baseDamage = requireFiniteNonNegative(input.baseDamage, "base damage");
  const attackerLevel = requireFiniteNonNegative(input.attackerLevel, "attacker level");
  const defenderLevel = requireFiniteNonNegative(input.defenderLevel, "defender level");
  const flatAttack = requireFinite(input.flatAttack ?? 0, "flat attack");
  const flatBodyDefense = requireFinite(input.flatBodyDefense ?? 0, "flat body defense");
  const flatShieldDefense = requireFinite(input.flatShieldDefense ?? 0, "flat shield defense");
  const multiplier = requireFiniteNonNegative(input.multiplier ?? 1, "multiplier");
  const row = DAMAGE_MATRIX_V4[input.damageType];
  const bodyRawDamage = (baseDamage + flatAttack - flatBodyDefense) * row[input.armourType] *
    damageV4LevelFactor(attackerLevel, defenderLevel) * multiplier;
  const shieldRawDamage = input.shielded === true
    ? (baseDamage + flatAttack - flatShieldDefense) * row[V4_SHIELD_ARMOUR_TYPE] *
      damageV4LevelFactor(attackerLevel, requireFiniteNonNegative(input.shieldLevel ?? 0, "shield level")) * multiplier
    : null;
  const selectedRawDamage = shieldRawDamage === null ? bodyRawDamage : Math.min(bodyRawDamage, shieldRawDamage);
  return {
    bodyRawDamage,
    shieldRawDamage,
    selectedRawDamage,
    finalDamage: normalizeV3NormalWeaponDamage(selectedRawDamage)
  };
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}
