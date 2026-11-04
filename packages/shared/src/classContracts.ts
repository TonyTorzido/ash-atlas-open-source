/** Durable catalog. `hunter` is retained only to deserialize/migrate the historical class. */
export const CLASS_IDS = ["warrior", "druid", "ranger", "knight", "ninja", "hunter"] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const SUBCLASS_IDS = ["reaver", "warden", "sharpshooter", "stalker"] as const;
export type SubclassId = (typeof SUBCLASS_IDS)[number];

export type ClassResourceId = "none" | "rage" | "focus";
export type ClassResourceDisplayName = "None" | "Rage" | "Focus";
export type ClassWeaponMode = "ranged" | "melee";

export const WEAPON_CATEGORIES = [
  "sword", "axe", "hammer", "shield", "two_handed_martial",
  "bow", "crossbow", "dagger", "spear", "staff", "shuriken", "wand",
  "brass_knuckles", "blowdart", "sling", "scepter"
] as const;
export type WeaponCategory = (typeof WEAPON_CATEGORIES)[number];

export type TechniqueKind = "reset" | "normal" | "passive" | "ultimate";
export type PassiveTier = 0 | 10 | 20;
export type TechniqueActivation = "armed" | "instant" | "drag";
export type TechniqueDragTargetKind = "position" | "direction";
export type TechniqueTargetType = "hostile" | "friendly" | "self" | "friendly_or_hostile";
export type TechniqueSupportKind = "healing" | "buff";
export type TechniqueWeaponRequirement = "melee" | "ranged" | "shield" | "any";

export type TechniqueDefinition = {
  id: string;
  classId: ClassId;
  subclassId: SubclassId | null;
  name: string;
  shortLabel: string;
  kind: TechniqueKind;
  unlockLevel: number;
  passiveTier?: PassiveTier;
  description: string;
  rageCost: number;
  resourceCost: number;
  cooldownMs: number;
  cooldownGroup?: "basic_attack_reset";
  damageMultiplier?: number;
  /** Defaults to hostile for active techniques and self for passives. */
  targetType?: TechniqueTargetType;
  /** Marks player-support actions that can be activated outside combat. */
  supportKind?: TechniqueSupportKind;
  /** A successful friendly resolution only restores health and is a no-op at full HP. */
  healthOnly?: boolean;
  weaponRequirement: TechniqueWeaponRequirement;
  activation?: TechniqueActivation;
  dragTargetKind?: TechniqueDragTargetKind;
  allowedWeaponCategories?: readonly WeaponCategory[];
  /** Maximum authoritative cast/placement distance in meters. */
  targetRangeM?: number;
  /** Authoritative area or zone radius in meters. */
  targetRadiusM?: number;
};
