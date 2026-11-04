export const PVP_DAMAGE_WEAPON_PROFILES_V3 = [
  "unarmed", "sword", "spear", "dagger", "axe", "crossbow", "shuriken",
  "longbow", "blowdart", "sling", "martial_arts", "brass_knuckles", "staff", "wand"
] as const;
export type PvpDamageWeaponProfileV3 = (typeof PVP_DAMAGE_WEAPON_PROFILES_V3)[number];

export const PVP_DAMAGE_DEFENSE_PROFILES_V3 = [
  "unarmored", "shield", "breastplate", "martial_tunic", "leather", "wyrm_shield", "chainmail"
] as const;
export type PvpDamageDefenseProfileV3 = (typeof PVP_DAMAGE_DEFENSE_PROFILES_V3)[number];

/** The one universal weapon x armor table, used by PvP and PvE alike. */
export const PVP_RAW_MATRIX_V3_METADATA = Object.freeze({
  evidenceStatus: "designed",
  sourceVersion: "ash_pvp_raw_matrix_v2",
  fullMatrixPresent: true,
  roundingBasis: "ash_provisional",
  derivedRows: Object.freeze({})
} as const);

export const PVP_RAW_MATRIX_V3 = {
  unarmed:       { unarmored: 4.25, shield: 2.25, breastplate: 2.25, martial_tunic: 2.25, leather: 2.25, wyrm_shield: 2.25, chainmail: 2.5 },
  sword:         { unarmored: 9.25, shield: 7.25, breastplate: 4.25, martial_tunic: 7.5, leather: 8.5, wyrm_shield: 8.75, chainmail: 3.25 },
  spear:         { unarmored: 11.0, shield: 7.5, breastplate: 6.0, martial_tunic: 7.25, leather: 6.25, wyrm_shield: 5.25, chainmail: 11.75 },
  dagger:        { unarmored: 10.0, shield: 6.0, breastplate: 10.5, martial_tunic: 6.5, leather: 4.25, wyrm_shield: 5.0, chainmail: 5.25 },
  axe:           { unarmored: 10.5, shield: 9.25, breastplate: 4.25, martial_tunic: 11.0, leather: 9.0, wyrm_shield: 9.0, chainmail: 4.75 },
  crossbow:      { unarmored: 7.25, shield: 1.25, breastplate: 4.75, martial_tunic: 4.0, leather: 1.25, wyrm_shield: 0.75, chainmail: 4.75 },
  shuriken:      { unarmored: 6.5, shield: 1.25, breastplate: 4.5, martial_tunic: 4.0, leather: 1.25, wyrm_shield: 0.75, chainmail: 4.75 },
  longbow:       { unarmored: 6.5, shield: 0.25, breastplate: 4.25, martial_tunic: 4.25, leather: 1.25, wyrm_shield: 1.75, chainmail: 4.25 },
  blowdart:      { unarmored: 6.25, shield: 0.25, breastplate: 4.25, martial_tunic: 4.25, leather: 1.25, wyrm_shield: 1.75, chainmail: 4.75 },
  sling:         { unarmored: 7.5, shield: 4.25, breastplate: 4.25, martial_tunic: 9.75, leather: 3.5, wyrm_shield: 4.25, chainmail: 4.25 },
  martial_arts:  { unarmored: 6.75, shield: 5.5, breastplate: 4.75, martial_tunic: 5.25, leather: 4.75, wyrm_shield: 6.0, chainmail: 4.75 },
  brass_knuckles:{ unarmored: 8.25, shield: 6.25, breastplate: 3.75, martial_tunic: 6.25, leather: 7.25, wyrm_shield: 7.0, chainmail: 7.0 },
  staff:         { unarmored: 10.25, shield: 5.75, breastplate: 5.75, martial_tunic: 9.25, leather: 6.5, wyrm_shield: 7.25, chainmail: 3.25 },
  // Wand: its own row, tuned apart from the staff.
  wand:          { unarmored: 8.75, shield: 5.25, breastplate: 5.75, martial_tunic: 8.5, leather: 5.75, wyrm_shield: 5.5, chainmail: 3.25 }
} as const satisfies Readonly<Record<PvpDamageWeaponProfileV3, Readonly<Record<PvpDamageDefenseProfileV3, number>>>>;

export const ASH_V3_PROVISIONAL_SHIELD_COMBINATION = "minimum_damage" as const;
export const PVP_DAMAGE_PROFILE_MODES = ["matrix_v3", "compatibility_v1"] as const;
export type PvpDamageProfileMode = (typeof PVP_DAMAGE_PROFILE_MODES)[number];
export const PENDING_V3_MATRIX_PROFILE = "PENDING_V3_MATRIX_PROFILE" as const;

export type PvpWeaponProfileResolutionV3 = Readonly<{
  pvpDamageProfileMode: PvpDamageProfileMode;
  profile: PvpDamageWeaponProfileV3 | null;
  compatibilityStatus: typeof PENDING_V3_MATRIX_PROFILE | null;
}>;
export type PvpDefenseProfileResolutionV3 = Readonly<{
  pvpDamageProfileMode: PvpDamageProfileMode;
  profile: PvpDamageDefenseProfileV3 | null;
  compatibilityStatus: typeof PENDING_V3_MATRIX_PROFILE | null;
}>;

export const CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE = Object.freeze({
  sword: "sword",
  starter_sword: "sword",
  god_sword: "sword",
  axe: "axe",
  training_axe: "axe",
  double_axe: "axe",
  // Paladin Hammer: hits like the Double Axe until matrix v4 gives it a Blunt row.
  hammer: "axe",
  staff: "staff",
  starter_staff: "staff",
  bow: "longbow",
  starter_bow: "longbow",
  shuriken: "shuriken",
  starter_shuriken: "shuriken",
  wand: "wand",
  starter_wand: "wand",
  spear: "spear",
  training_spear: "spear",
  dagger: "dagger",
  training_dagger: "dagger",
  brass_knuckles: "brass_knuckles",
  training_knuckles: "brass_knuckles",
  crossbow: "crossbow",
  training_crossbow: "crossbow",
  blowdart: "blowdart",
  training_blowdart: "blowdart",
  sling: "sling",
  training_sling: "sling",
  // Placeholder: the scepter borrows the staff row until it is tuned in the matrix.
  scepter: "staff",
  training_scepter: "staff"
} as const satisfies Readonly<Record<string, PvpDamageWeaponProfileV3>>);

export const FUTURE_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE = Object.freeze(
  {} as const satisfies Readonly<Record<string, PvpDamageWeaponProfileV3>>
);

export const CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE = Object.freeze({
  tunic: "martial_tunic",
  padded_tunic: "martial_tunic",
  leather: "leather",
  leather_armor: "leather",
  chain_mail: "chainmail",
  chain_armor: "chainmail",
  breastplate: "breastplate",
  breast_plate: "breastplate",
  heavy_chest: "breastplate",
  melee_shield: "shield",
  training_shield: "shield",
  ranged_shield: "wyrm_shield"
} as const satisfies Readonly<Record<string, PvpDamageDefenseProfileV3>>);

export const FUTURE_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE = Object.freeze({
  wyrm_shield: "wyrm_shield"
} as const satisfies Readonly<Record<string, PvpDamageDefenseProfileV3>>);

export const V3_UNSUPPORTED_CURRENT_WEAPON_FAMILIES = [] as const;
export const V3_UNSUPPORTED_CURRENT_DEFENSE_FAMILIES = [] as const;

export function resolveV3WeaponProfileForEquipmentFamily(equipmentFamilyId: string | null): PvpWeaponProfileResolutionV3 {
  if (equipmentFamilyId === null) return { pvpDamageProfileMode: "matrix_v3", profile: "unarmed", compatibilityStatus: null };
  const current = CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE[equipmentFamilyId as keyof typeof CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE];
  const future = FUTURE_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE[equipmentFamilyId as keyof typeof FUTURE_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE];
  const profile = current ?? future;
  return profile === undefined
    ? { pvpDamageProfileMode: "compatibility_v1", profile: null, compatibilityStatus: PENDING_V3_MATRIX_PROFILE }
    : { pvpDamageProfileMode: "matrix_v3", profile, compatibilityStatus: null };
}

export function resolveV3DefenseProfileForEquipmentFamily(equipmentFamilyId: string | null): PvpDefenseProfileResolutionV3 {
  if (equipmentFamilyId === null) return { pvpDamageProfileMode: "matrix_v3", profile: "unarmored", compatibilityStatus: null };
  const current = CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE[equipmentFamilyId as keyof typeof CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE];
  const future = FUTURE_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE[equipmentFamilyId as keyof typeof FUTURE_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE];
  const profile = current ?? future;
  return profile === undefined
    ? { pvpDamageProfileMode: "compatibility_v1", profile: null, compatibilityStatus: PENDING_V3_MATRIX_PROFILE }
    : { pvpDamageProfileMode: "matrix_v3", profile, compatibilityStatus: null };
}

export type DamageMatrixV3Input = Readonly<{
  weaponProfile: PvpDamageWeaponProfileV3;
  bodyDefenseProfile?: PvpDamageDefenseProfileV3;
  shieldDefenseProfile?: "shield" | "wyrm_shield" | null;
  weaponUpgrade?: number;
  bodyArmorUpgrade?: number;
  shieldUpgrade?: number;
  flatAttack?: number;
  flatBodyDefense?: number;
  flatShieldDefense?: number;
  /** @deprecated Prefer the profile-specific defense fields. */
  flatDefense?: number;
  otherAdditiveModifier?: number;
  multiplier?: number;
}>;

export type DamageMatrixV3Resolution = Readonly<{
  bodyRawDamage: number;
  shieldRawDamage: number | null;
  selectedRawDamage: number;
  finalDamage: number;
  shieldCombinationPolicy: typeof ASH_V3_PROVISIONAL_SHIELD_COMBINATION;
}>;

export function combineV3BodyAndShieldDamage(bodyRawDamage: number, shieldRawDamage: number | null): number {
  return shieldRawDamage === null ? bodyRawDamage : Math.min(bodyRawDamage, shieldRawDamage);
}

export function normalizeV3NormalWeaponDamage(resolvedRawDamage: number): number {
  if (!Number.isFinite(resolvedRawDamage)) throw new Error("resolved raw damage must be finite");
  return Math.max(1, Math.round(resolvedRawDamage));
}

export function resolveDamageMatrixV3(input: DamageMatrixV3Input): DamageMatrixV3Resolution {
  const bodyProfile = input.bodyDefenseProfile ?? "unarmored";
  const weaponUpgrade = requireFiniteNonNegative(input.weaponUpgrade ?? 0, "weapon upgrade");
  const bodyArmorUpgrade = bodyProfile === "unarmored" ? 0 : requireFiniteNonNegative(input.bodyArmorUpgrade ?? 0, "body armor upgrade");
  const shieldUpgrade = requireFiniteNonNegative(input.shieldUpgrade ?? 0, "shield upgrade");
  const flatAttack = requireFinite(input.flatAttack ?? 0, "flat Attack");
  const flatDefense = requireFinite(input.flatDefense ?? 0, "flat Defense");
  const flatBodyDefense = requireFinite(input.flatBodyDefense ?? flatDefense, "flat body Defense");
  const flatShieldDefense = requireFinite(input.flatShieldDefense ?? flatDefense, "flat shield Defense");
  const otherAdditive = requireFinite(input.otherAdditiveModifier ?? 0, "other additive modifier");
  const multiplier = requireFiniteNonNegative(input.multiplier ?? 1, "multiplier");
  const common = weaponUpgrade + flatAttack + otherAdditive;
  const bodyRawDamage = (PVP_RAW_MATRIX_V3[input.weaponProfile][bodyProfile] + common - flatBodyDefense - bodyArmorUpgrade) * multiplier;
  const shieldRawDamage = input.shieldDefenseProfile === undefined || input.shieldDefenseProfile === null
    ? null
    : (PVP_RAW_MATRIX_V3[input.weaponProfile][input.shieldDefenseProfile] + common - flatShieldDefense - shieldUpgrade) * multiplier;
  const selectedRawDamage = combineV3BodyAndShieldDamage(bodyRawDamage, shieldRawDamage);
  return {
    bodyRawDamage,
    shieldRawDamage,
    selectedRawDamage,
    finalDamage: normalizeV3NormalWeaponDamage(selectedRawDamage),
    shieldCombinationPolicy: ASH_V3_PROVISIONAL_SHIELD_COMBINATION
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
