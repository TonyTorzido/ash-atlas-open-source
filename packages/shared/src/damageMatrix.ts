export const DAMAGE_WEAPON_TYPES = [
  "axe",
  "sword",
  "staff",
  "bow",
  "shuriken",
  "wand"
] as const;
export type DamageWeaponType = (typeof DAMAGE_WEAPON_TYPES)[number];

export const DAMAGE_ARMOR_TYPES = [
  "naked",
  "tunic",
  "leather",
  "chainmail",
  "breastplate"
] as const;
export type DamageArmorType = (typeof DAMAGE_ARMOR_TYPES)[number];

export const DAMAGE_SHIELD_TYPES = ["melee", "ranged"] as const;
export type DamageShieldType = (typeof DAMAGE_SHIELD_TYPES)[number];

export const DAMAGE_MATRIX_V1 = {
  axe: { naked: 11, tunic: 10, leather: 9, chainmail: 8, breastplate: 7 },
  sword: { naked: 10, tunic: 9, leather: 8, chainmail: 7, breastplate: 6 },
  staff: { naked: 9, tunic: 8, leather: 8, chainmail: 8, breastplate: 8 },
  bow: { naked: 8, tunic: 8, leather: 7, chainmail: 6, breastplate: 5 },
  shuriken: { naked: 7, tunic: 7, leather: 6, chainmail: 5, breastplate: 3 },
  wand: { naked: 7, tunic: 7, leather: 7, chainmail: 7, breastplate: 7 }
} as const satisfies Readonly<Record<
  DamageWeaponType,
  Readonly<Record<DamageArmorType, number>>
>>;

export const SHIELD_DAMAGE_MATRIX_V1 = {
  axe: { melee: 5, ranged: 11 },
  sword: { melee: 4, ranged: 10 },
  staff: { melee: 5, ranged: 9 },
  bow: { melee: 8, ranged: 3 },
  shuriken: { melee: 7, ranged: 2 },
  wand: { melee: 7, ranged: 5 }
} as const satisfies Readonly<Record<
  DamageWeaponType,
  Readonly<Record<DamageShieldType, number>>
>>;

export type DamageMatrixV1Input = {
  weaponType: DamageWeaponType;
  weaponUpgrade: number;
  armorType?: DamageArmorType;
  armorUpgrade?: number;
  shieldType?: DamageShieldType | null;
  shieldUpgrade?: number;
};

export type DamageMatrixV1Resolution = {
  armorDamage: number;
  shieldDamage: number | null;
  finalDamage: number;
};

export function resolveDamageMatrixV1(
  input: DamageMatrixV1Input
): DamageMatrixV1Resolution {
  const weaponUpgrade = requireWholeUpgrade(input.weaponUpgrade, "weapon");
  const armorType = input.armorType ?? "naked";
  const armorUpgrade = armorType === "naked"
    ? 0
    : requireWholeUpgrade(input.armorUpgrade ?? 0, "armor");
  const armorDamage = DAMAGE_MATRIX_V1[input.weaponType][armorType]
    + weaponUpgrade
    - armorUpgrade;
  const shieldDamage = input.shieldType === undefined || input.shieldType === null
    ? null
    : SHIELD_DAMAGE_MATRIX_V1[input.weaponType][input.shieldType]
      + weaponUpgrade
      - requireWholeUpgrade(input.shieldUpgrade ?? 0, "shield");
  return {
    armorDamage,
    shieldDamage,
    finalDamage: Math.max(1, Math.min(armorDamage, shieldDamage ?? armorDamage))
  };
}

function requireWholeUpgrade(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 25) {
    throw new Error(`${label} upgrade must be a whole number from 0 through 25`);
  }
  return value;
}
