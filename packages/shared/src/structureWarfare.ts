/**
 * Structure warfare contract for personal, city, and kingdom flags. Keep these
 * values in shared code so the server and presentation layer cannot drift from
 * the retained warfare contract.
 *
 * Base Flags are soft 220-health anchors; a Buoy is a water anchor with
 * the same soft profile. Stone is the hardened 220-health tier, an Atlas Shrine
 * (Atlas Shrine, built on a Stone Flag) has 3,300 health and a 27 h burn, and a
 * Tower is the 2,700-health tier. The legacy hardened aliases stay
 * exported because older callers and persisted operation fixtures use them.
 */
export const STRUCTURE_WARFARE_BASE_HEALTH = 220;
export const STRUCTURE_WARFARE_HARDENED_HEALTH = 220;
export const STRUCTURE_WARFARE_TOWER_HEALTH = 2_700;
export const STRUCTURE_WARFARE_ATLAS_SHRINE_HEALTH = 3_300;
export const STRUCTURE_WARFARE_ATLAS_SHRINE_BURN_THRESHOLD_HEALTH = 1_650;
export const STRUCTURE_WARFARE_ATLAS_SHRINE_BURN_DURATION_MS = 27 * 60 * 60 * 1_000;
export const STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH = 110;
export const STRUCTURE_WARFARE_HARDENED_BURN_THRESHOLD_HEALTH = 110;
export const STRUCTURE_WARFARE_TOWER_BURN_THRESHOLD_HEALTH = 1_350;
/** Backwards-compatible hardened breach threshold alias. */
export const STRUCTURE_WARFARE_BURN_THRESHOLD_HEALTH = STRUCTURE_WARFARE_HARDENED_BURN_THRESHOLD_HEALTH;
export const STRUCTURE_WARFARE_ATTACK_DAMAGE = 25;
export const STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
export const STRUCTURE_WARFARE_BASE_BURN_DURATION_MS = 14_000;
export const STRUCTURE_WARFARE_STONE_BURN_DURATION_MS = 22 * 60 * 60 * 1_000;
export const STRUCTURE_WARFARE_TOWER_BURN_DURATION_MS = 22 * 60 * 60 * 1_000;
export const STRUCTURE_WARFARE_BOMBER_DAMAGE = 1_150;
export const STRUCTURE_WARFARE_INTERACTION_RADIUS_M = 50;
export const STRUCTURE_WARFARE_TORCH_COST = Object.freeze({
  itemId: "torch" as const,
  quantity: 1
});
export const STRUCTURE_WARFARE_REPAIR_DURATION_MS = 60_000;
export const STRUCTURE_WARFARE_DISRUPT_DURATION_MS = 8_000;
/** Legacy fixed-cost repair rows only; progressive repair is free. */
export const STRUCTURE_WARFARE_REPAIR_COST_BY_TIER = Object.freeze({
  stone: Object.freeze({
    repairKit: 1,
    stone: 5
  }),
  tower: Object.freeze({
    repairKit: 1,
    stone: 25
  })
} as const);

export const STRUCTURE_WARFARE_HEALTH_BY_TIER = Object.freeze({
  base: STRUCTURE_WARFARE_BASE_HEALTH,
  stone: STRUCTURE_WARFARE_HARDENED_HEALTH,
  atlas_shrine: STRUCTURE_WARFARE_ATLAS_SHRINE_HEALTH,
  tower: STRUCTURE_WARFARE_TOWER_HEALTH
} as const);

export const STRUCTURE_WARFARE_BURN_THRESHOLD_BY_TIER = Object.freeze({
  base: STRUCTURE_WARFARE_BASE_BURN_THRESHOLD_HEALTH,
  stone: STRUCTURE_WARFARE_HARDENED_BURN_THRESHOLD_HEALTH,
  atlas_shrine: STRUCTURE_WARFARE_ATLAS_SHRINE_BURN_THRESHOLD_HEALTH,
  tower: STRUCTURE_WARFARE_TOWER_BURN_THRESHOLD_HEALTH
} as const);

export const STRUCTURE_WARFARE_BURN_DURATION_BY_TIER = Object.freeze({
  base: STRUCTURE_WARFARE_BASE_BURN_DURATION_MS,
  stone: STRUCTURE_WARFARE_STONE_BURN_DURATION_MS,
  atlas_shrine: STRUCTURE_WARFARE_ATLAS_SHRINE_BURN_DURATION_MS,
  tower: STRUCTURE_WARFARE_TOWER_BURN_DURATION_MS
} as const);

export type StructureWarfareTier = keyof typeof STRUCTURE_WARFARE_HEALTH_BY_TIER;

export function structureWarfareTierForReinforcementLevel(
  reinforcementLevel: number
): StructureWarfareTier | null {
  if (reinforcementLevel === 0) return "base";
  if (reinforcementLevel === 1) return "stone";
  if (reinforcementLevel === 2) return "atlas_shrine";
  if (reinforcementLevel === 3) return "tower";
  return null;
}

/**
 * Personal flag maximum health. A Tower (level 3) uses its Guard Tower level
 * (flags.tower_level; omitted / null means level 1).
 */
export function structureWarfareHealthForReinforcementLevel(
  reinforcementLevel: number,
  towerLevel?: number | null
): number | null {
  const tier = structureWarfareTierForReinforcementLevel(reinforcementLevel);
  if (!tier) return null;
  if (tier !== "tower") return STRUCTURE_WARFARE_HEALTH_BY_TIER[tier];
  const level = normalizedPersonalTowerLevel(towerLevel);
  return level === null ? null : personalGuardTowerHealth(level);
}

export function structureWarfareBreachThresholdForReinforcementLevel(
  reinforcementLevel: number,
  towerLevel?: number | null
): number | null {
  const tier = structureWarfareTierForReinforcementLevel(reinforcementLevel);
  if (!tier) return null;
  if (tier !== "tower") return STRUCTURE_WARFARE_BURN_THRESHOLD_BY_TIER[tier];
  const health = structureWarfareHealthForReinforcementLevel(reinforcementLevel, towerLevel);
  return health === null ? null : Math.floor(health / 2);
}

export function structureWarfareBurnDurationForReinforcementLevel(
  reinforcementLevel: number
): number | null {
  const tier = structureWarfareTierForReinforcementLevel(reinforcementLevel);
  return tier ? STRUCTURE_WARFARE_BURN_DURATION_BY_TIER[tier] : null;
}

/*
 * Tower ladders.
 *
 * Personal Guard Tower: levels 1..25. A level 1 tower has 2,700 HP, gaining 440 HP per level up to level 25. Each level costs 12 x target level Iron Ore + 30 stone.
 */
export const PERSONAL_GUARD_TOWER_MAX_LEVEL = 25;
export const PERSONAL_GUARD_TOWER_HEALTH_PER_LEVEL = 440;
export const PERSONAL_GUARD_TOWER_IRON_PER_TARGET_LEVEL = 12;
export const PERSONAL_GUARD_TOWER_STONE_PER_LEVEL = 30;
export const PERSONAL_GUARD_TOWER_IRON_ITEM_ID = "iron" as const;

export function personalGuardTowerHealth(level: number): number {
  const safeLevel = Math.min(PERSONAL_GUARD_TOWER_MAX_LEVEL, Math.max(1, Math.floor(level)));
  return STRUCTURE_WARFARE_TOWER_HEALTH + PERSONAL_GUARD_TOWER_HEALTH_PER_LEVEL * (safeLevel - 1);
}

export type PersonalGuardTowerUpgradeCost = Readonly<{
  targetLevel: number;
  iron: number;
  stone: number;
}>;

/** Cost of upgrading a personal Guard Tower to `targetLevel` (2..25); null when out of range. */
export function personalGuardTowerUpgradeCost(targetLevel: number): PersonalGuardTowerUpgradeCost | null {
  if (!Number.isSafeInteger(targetLevel) || targetLevel < 2 || targetLevel > PERSONAL_GUARD_TOWER_MAX_LEVEL) {
    return null;
  }
  return Object.freeze({
    targetLevel,
    iron: PERSONAL_GUARD_TOWER_IRON_PER_TARGET_LEVEL * targetLevel,
    stone: PERSONAL_GUARD_TOWER_STONE_PER_LEVEL
  });
}

function normalizedPersonalTowerLevel(level: number | null | undefined): number | null {
  const value = level === null || level === undefined ? 1 : Number(level);
  return Number.isSafeInteger(value) && value >= 1 && value <= PERSONAL_GUARD_TOWER_MAX_LEVEL ? value : null;
}

/** City Tower: the Mayor upgrades a City Flag (36,500 HP, 27 h burn). */
export const STRUCTURE_WARFARE_CITY_TOWER_HEALTH = 36_500;
/** Our own choice: paid from the city treasury (City Coins) plus the Mayor's stone. */
export const CITY_TOWER_UPGRADE_COST = Object.freeze({
  cityCoins: 12_000,
  stone: 600
} as const);

/*
 * Kingdom Tower levels 1..5, built and upgraded on a
 * Kingdom Flag. Each level's cost is a step, not a cumulative total: Bricks
 * from the kingdom treasury plus Crystal (KINGDOM_TOWER_CRYSTAL_ITEM_ID),
 * produced by Quartz Huts (citySystem.ts QUARTZ_HUT_*). Influence and
 * conquest are stored for a later conquest system; nothing reads them yet.
 */
export const KINGDOM_TOWER_MAX_LEVEL = 5;
export const KINGDOM_TOWER_CRYSTAL_ITEM_ID = "crystal" as const;
export const KINGDOM_TOWER_LADDER = Object.freeze([
  Object.freeze({ level: 1, maximumHealth: 11500, influence: 12, conquest: 34, bricks: 2_400, crystal: 240 }),
  Object.freeze({ level: 2, maximumHealth: 23000, influence: 16, conquest: 44, bricks: 6_800, crystal: 660 }),
  Object.freeze({ level: 3, maximumHealth: 34500, influence: 22, conquest: 52, bricks: 22_000, crystal: 2_300 }),
  Object.freeze({ level: 4, maximumHealth: 46000, influence: 27, conquest: 66, bricks: 66_000, crystal: 6_500 }),
  Object.freeze({ level: 5, maximumHealth: 57500, influence: 33, conquest: 74, bricks: 185_000, crystal: 18_500 })
] as const);

/*
 * Kingdom Obelisk levels 1..5, built and upgraded on a
 * Kingdom Flag. Step costs: Bricks from the kingdom treasury plus crude oil
 * (from the treasury, or from the builder when the treasury lacks it).
 * Within KINGDOM_OBELISK_RADIUS_M an obelisk multiplies the brick yield of
 * gathering and hunting on its kingdom's land: x1..x5 for non-members and
 * x2..x8 for members. Influence comes from the Obelisk table below;
 * KINGDOM_OBELISK_OVERVIEW_INFLUENCE_BONUS adds 12 per level for the
 * later conquest system.
 */
export const KINGDOM_OBELISK_MAX_LEVEL = 5;
export const KINGDOM_OBELISK_RADIUS_M = 550;
export const KINGDOM_OBELISK_OVERVIEW_INFLUENCE_BONUS = 12;
export const KINGDOM_OBELISK_LADDER = Object.freeze([
  Object.freeze({ level: 1, maximumHealth: 2300, influence: 22, conquest: 12, bricks: 2_200, crudeOil: 1_100, nonMemberYieldMultiplier: 1, memberYieldMultiplier: 2 }),
  Object.freeze({ level: 2, maximumHealth: 4600, influence: 32, conquest: 17, bricks: 6_400, crudeOil: 3_300, nonMemberYieldMultiplier: 2, memberYieldMultiplier: 3 }),
  Object.freeze({ level: 3, maximumHealth: 6900, influence: 44, conquest: 22, bricks: 21_000, crudeOil: 9_500, nonMemberYieldMultiplier: 3, memberYieldMultiplier: 4 }),
  Object.freeze({ level: 4, maximumHealth: 9200, influence: 52, conquest: 28, bricks: 62_000, crudeOil: 32_000, nonMemberYieldMultiplier: 4, memberYieldMultiplier: 5 }),
  Object.freeze({ level: 5, maximumHealth: 11500, influence: 66, conquest: 34, bricks: 190_000, crudeOil: 95_000, nonMemberYieldMultiplier: 5, memberYieldMultiplier: 8 })
] as const);

export type KingdomStructureKind = "kingdom_tower" | "obelisk";

export type KingdomStructureBuildCost = Readonly<{
  kind: KingdomStructureKind;
  targetLevel: number;
  bricks: number;
  /** Second material: crude oil for an obelisk, Crystal for a tower. */
  materialItemId: "crude_oil" | typeof KINGDOM_TOWER_CRYSTAL_ITEM_ID;
  materialQuantity: number;
  maximumHealth: number;
}>;

/** Step cost of building `kind` at `targetLevel` (1 builds it on a Kingdom Flag); null when out of range. */
export function kingdomStructureBuildCost(
  kind: KingdomStructureKind,
  targetLevel: number
): KingdomStructureBuildCost | null {
  if (!Number.isSafeInteger(targetLevel) || targetLevel < 1) return null;
  if (kind === "kingdom_tower") {
    const rung = KINGDOM_TOWER_LADDER[targetLevel - 1];
    return rung
      ? Object.freeze({
          kind, targetLevel, bricks: rung.bricks, materialItemId: KINGDOM_TOWER_CRYSTAL_ITEM_ID,
          materialQuantity: rung.crystal, maximumHealth: rung.maximumHealth
        })
      : null;
  }
  if (kind === "obelisk") {
    const rung = KINGDOM_OBELISK_LADDER[targetLevel - 1];
    return rung
      ? Object.freeze({
          kind, targetLevel, bricks: rung.bricks, materialItemId: "crude_oil" as const,
          materialQuantity: rung.crudeOil, maximumHealth: rung.maximumHealth
        })
      : null;
  }
  return null;
}

/*
 * Towers shoot. A Guard Tower, City Tower or Kingdom Tower
 * fires one arrow per shared basic attack interval at the nearest hostile
 * player, Siege or Bomber within 450 m. Damage is the raw matrix
 * "Guard Tower" attack row against the target's armor column; City and
 * Kingdom Towers multiply it by 1 + 0.2 x (level - 1).
 *
 * Armor columns map one to one: unarmored, shield, breastplate, martial tunic,
 * leather, wyrm shield and chainmail; Siege and Bomber have their own raw values.
 * Bombers are an unarmored crew.
 */
export const TOWER_ATTACK_RANGE_M = 450;
export const TOWER_ATTACK_RAW_DAMAGE = Object.freeze({
  unarmored: 22,
  shield: 13,
  breastplate: 16,
  martial_tunic: 14,
  leather: 14,
  wyrm_shield: 13,
  chainmail: 16
} as const);
export type TowerAttackArmorProfile = keyof typeof TOWER_ATTACK_RAW_DAMAGE;
export const TOWER_ATTACK_RAW_DAMAGE_VS_SIEGE = 28;
export const TOWER_ATTACK_RAW_DAMAGE_VS_BOMBER = 22;
export const TOWER_ORGANIZATION_DAMAGE_STEP_PER_LEVEL = 0.2;
/** Combat source id prefix for tower volleys; the rest is the flag id. */
export const TOWER_COMBAT_SOURCE_PREFIX = "tower:";
export const TOWER_ATTACK_TECHNIQUE_ID = "guard_tower_arrow";

export function towerCombatSourceId(flagId: string): string {
  return TOWER_COMBAT_SOURCE_PREFIX + flagId;
}

export function towerFlagIdFromCombatSource(sourceEntityId: string | null | undefined): string | null {
  return sourceEntityId?.startsWith(TOWER_COMBAT_SOURCE_PREFIX)
    ? sourceEntityId.slice(TOWER_COMBAT_SOURCE_PREFIX.length) || null
    : null;
}

/** Damage multiplier: personal Guard Towers x1, City / Kingdom Towers x(1 + 0.2 x (level - 1)). */
export function towerAttackDamageMultiplier(
  profile: Pick<StructureWarfareProfile, "kind" | "towerLevel">
): number {
  if (profile.kind !== "city_tower" && profile.kind !== "kingdom_tower") return 1;
  const level = Math.max(1, profile.towerLevel ?? 1);
  return 1 + TOWER_ORGANIZATION_DAMAGE_STEP_PER_LEVEL * (level - 1);
}

/**
 * One tower arrow against a player. A carried shield uses the same
 * "minimum of body and shield column" policy as the weapon matrix.
 */
export function towerAttackDamageAgainstPlayer(
  bodyProfile: TowerAttackArmorProfile,
  shieldProfile: "shield" | "wyrm_shield" | null,
  multiplier: number,
  /** Flat raw damage added before the multiplier (Beacon Wardens). */
  attackBonus = 0
): number {
  const body = TOWER_ATTACK_RAW_DAMAGE[bodyProfile];
  const raw = (shieldProfile === null ? body : Math.min(body, TOWER_ATTACK_RAW_DAMAGE[shieldProfile])) +
    Math.max(0, attackBonus);
  return Math.max(1, Math.round(raw * Math.max(0, multiplier)));
}

/** True for the structures that shoot: every tower profile. */
export function structureWarfareProfileShoots(
  profile: Pick<StructureWarfareProfile, "kind"> | null | undefined
): boolean {
  return profile?.kind === "tower" || profile?.kind === "city_tower" || profile?.kind === "kingdom_tower" ||
    profile?.kind === "war_tower";
}

/*
 * City and kingdom structures. A kingdom's seat is the
 * player-facing Castle. Every organization structure must burn: bombers and
 * hand attacks stop at the 50% burn threshold, so defenders always get the
 * full burn window to respond.
 */
export const STRUCTURE_WARFARE_CITY_FLAG_HEALTH = 4_500;
export const STRUCTURE_WARFARE_CITY_CENTER_HEALTH = 230_000;
export const STRUCTURE_WARFARE_KINGDOM_FLAG_HEALTH = 220;
export const STRUCTURE_WARFARE_CASTLE_HEALTH = 230_000;
export const STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS = 27 * 60 * 60 * 1_000;
export const STRUCTURE_WARFARE_ORGANIZATION_SEAT_BURN_DURATION_MS = 90 * 60 * 60 * 1_000;

/*
 * Repair: free and time-only. Health returns at 5x the burn
 * rate, where a burn deals half of maximum health over its duration. The
 * burn pauses while a repair runs and hostile damage dealt to a repairing
 * structure counts 3x.
 */
export const STRUCTURE_WARFARE_REPAIR_RATE_MULTIPLIER = 5;
export const STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER = 3;
/** Server tick for progressive repair channels. */
export const STRUCTURE_WARFARE_REPAIR_TICK_MS = 5_000;

export type StructureWarfareProfileKind =
  | StructureWarfareTier
  | "city_flag"
  | "city_tower"
  | "city_center"
  | "kingdom_flag"
  | "kingdom_tower"
  | "kingdom_obelisk"
  | "castle"
  | "war_tower"
  | "war_outpost";

export type StructureWarfareOrganizationKind = "city" | "kingdom";

export type StructureWarfareProfile = Readonly<{
  kind: StructureWarfareProfileKind;
  organization: StructureWarfareOrganizationKind | null;
  /** City Center or Castle: burning it out ends the whole territory. */
  seat: boolean;
  maximumHealth: number;
  burnThreshold: number;
  burnDurationMs: number;
  /** Bombers and hand attacks stop at the burn threshold (ignite, never delete). */
  mustBurn: boolean;
  repairable: boolean;
  /** Tower level (personal Guard Tower 1..25, City Tower 1, Kingdom Tower 1..5); null when not a tower. */
  towerLevel: number | null;
  /** Kingdom Obelisk level 1..5; absent / null when not an obelisk. */
  obeliskLevel?: number | null;
}>;

export type StructureWarfareProfileInput = Readonly<{
  controlType?: string | null;
  anchorKind?: string | null;
  systemControlled?: boolean | null;
  cityId?: string | null;
  kingdomId?: string | null;
  reinforcementLevel?: number | null;
  /** flags.tower_level; null / omitted means level 1 for a personal Tower and "not a tower" otherwise. */
  towerLevel?: number | null;
  /** flags.obelisk_level (Kingdom Flags only, 1..5); null / omitted means "not an obelisk". */
  obeliskLevel?: number | null;
  /** flags.war_structure_kind ("war_tower" / "war_outpost" on a Kingdom Flag); null / omitted otherwise. */
  warStructureKind?: string | null;
}>;

function organizationProfile(
  kind: Exclude<StructureWarfareProfileKind, StructureWarfareTier>,
  organization: StructureWarfareOrganizationKind,
  seat: boolean,
  maximumHealth: number,
  towerLevel: number | null = null
): StructureWarfareProfile {
  return Object.freeze({
    kind,
    organization,
    seat,
    maximumHealth,
    burnThreshold: Math.floor(maximumHealth / 2),
    burnDurationMs: seat
      ? STRUCTURE_WARFARE_ORGANIZATION_SEAT_BURN_DURATION_MS
      : STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS,
    mustBurn: true,
    repairable: true,
    towerLevel
  });
}

const ORGANIZATION_PROFILES = Object.freeze({
  city: organizationProfile("city_flag", "city", false, STRUCTURE_WARFARE_CITY_FLAG_HEALTH),
  city_seat: organizationProfile("city_center", "city", true, STRUCTURE_WARFARE_CITY_CENTER_HEALTH),
  kingdom: organizationProfile("kingdom_flag", "kingdom", false, STRUCTURE_WARFARE_KINGDOM_FLAG_HEALTH),
  kingdom_seat: organizationProfile("castle", "kingdom", true, STRUCTURE_WARFARE_CASTLE_HEALTH)
} as const);

const CITY_TOWER_PROFILE = organizationProfile("city_tower", "city", false, STRUCTURE_WARFARE_CITY_TOWER_HEALTH, 1);
const KINGDOM_TOWER_PROFILES = Object.freeze(
  KINGDOM_TOWER_LADDER.map((rung) =>
    organizationProfile("kingdom_tower", "kingdom", false, rung.maximumHealth, rung.level)
  )
);
/*
 * War structures (B2). A War Tower is as strong as a level-1 Kingdom Tower
 * and shoots like one; a War Outpost has the War Camp's 2,200 HP and 1 h burn.
 */
export const STRUCTURE_WARFARE_WAR_OUTPOST_HEALTH = 2_200;
export const STRUCTURE_WARFARE_WAR_OUTPOST_BURN_DURATION_MS = 60 * 60 * 1_000;
const WAR_TOWER_PROFILE = organizationProfile("war_tower", "kingdom", false, KINGDOM_TOWER_LADDER[0].maximumHealth, 1);
const WAR_OUTPOST_PROFILE: StructureWarfareProfile = Object.freeze({
  ...organizationProfile("war_outpost", "kingdom", false, STRUCTURE_WARFARE_WAR_OUTPOST_HEALTH),
  burnDurationMs: STRUCTURE_WARFARE_WAR_OUTPOST_BURN_DURATION_MS
});
const KINGDOM_OBELISK_PROFILES = Object.freeze(
  KINGDOM_OBELISK_LADDER.map((rung) =>
    Object.freeze({
      ...organizationProfile("kingdom_obelisk", "kingdom", false, rung.maximumHealth),
      obeliskLevel: rung.level
    })
  )
);

/**
 * The single warfare classification for a flag row. Returns null for every
 * immune structure: system-controlled (goblin/NPC) territory and unknown
 * control shapes. A Buoy (personal, never reinforced) uses the soft base
 * profile. Mirrors the database health trigger.
 */
export function structureWarfareProfileForFlag(
  flag: StructureWarfareProfileInput
): StructureWarfareProfile | null {
  const anchorKind = flag.anchorKind ?? "flag";
  if ((anchorKind !== "flag" && anchorKind !== "buoy") || flag.systemControlled === true) return null;
  const controlType = flag.controlType ?? "personal";
  const cityId = flag.cityId ?? null;
  const kingdomId = flag.kingdomId ?? null;
  if (anchorKind === "buoy" && (controlType !== "personal" || Number(flag.reinforcementLevel ?? 0) !== 0)) {
    return null;
  }
  if (controlType === "personal") {
    if (cityId !== null || kingdomId !== null) return null;
    const tier = structureWarfareTierForReinforcementLevel(Number(flag.reinforcementLevel ?? 0));
    if (!tier) return null;
    const towerLevel = tier === "tower" ? normalizedPersonalTowerLevel(flag.towerLevel) : null;
    if (tier === "tower" && towerLevel === null) return null;
    const maximumHealth = towerLevel === null
      ? STRUCTURE_WARFARE_HEALTH_BY_TIER[tier]
      : personalGuardTowerHealth(towerLevel);
    return {
      kind: tier,
      organization: null,
      seat: false,
      maximumHealth,
      burnThreshold: towerLevel === null
        ? STRUCTURE_WARFARE_BURN_THRESHOLD_BY_TIER[tier]
        : Math.floor(maximumHealth / 2),
      burnDurationMs: STRUCTURE_WARFARE_BURN_DURATION_BY_TIER[tier],
      mustBurn: false,
      // Soft base Flags burn out in seconds by design and are not repairable.
      repairable: tier !== "base",
      towerLevel
    };
  }
  const towerLevel = flag.towerLevel ?? null;
  const obeliskLevel = flag.obeliskLevel ?? null;
  const warStructureKind = flag.warStructureKind ?? null;
  if (warStructureKind !== null) {
    if (controlType !== "kingdom" || kingdomId === null || cityId !== null || obeliskLevel !== null) return null;
    if (warStructureKind === "war_tower") return towerLevel === 1 ? WAR_TOWER_PROFILE : null;
    if (warStructureKind === "war_outpost") return towerLevel === null ? WAR_OUTPOST_PROFILE : null;
    return null;
  }
  if (obeliskLevel !== null) {
    return controlType === "kingdom" && kingdomId !== null && cityId === null && towerLevel === null
      ? KINGDOM_OBELISK_PROFILES[obeliskLevel - 1] ?? null
      : null;
  }
  if ((controlType === "city" || controlType === "city_seat") && cityId !== null && kingdomId === null) {
    if (controlType === "city" && towerLevel !== null) {
      return towerLevel === 1 ? CITY_TOWER_PROFILE : null;
    }
    return towerLevel === null ? ORGANIZATION_PROFILES[controlType] : null;
  }
  if ((controlType === "kingdom" || controlType === "kingdom_seat") && kingdomId !== null && cityId === null) {
    if (controlType === "kingdom" && towerLevel !== null) {
      return KINGDOM_TOWER_PROFILES[towerLevel - 1] ?? null;
    }
    return towerLevel === null ? ORGANIZATION_PROFILES[controlType] : null;
  }
  return null;
}

/** Milliseconds a repair needs to restore the profile's full maximum health. */
export function structureWarfareFullRepairMs(profile: Pick<StructureWarfareProfile, "burnDurationMs">): number {
  // Burn rate = (max / 2) / burnDuration, so 5x that rate restores max in
  // burnDuration / 2.5.
  return Math.max(1, Math.round(profile.burnDurationMs / (STRUCTURE_WARFARE_REPAIR_RATE_MULTIPLIER / 2)));
}

/** Health restored after `elapsedMs` of repair channel (floored, monotone). */
export function structureWarfareRepairHealthAfter(
  profile: Pick<StructureWarfareProfile, "burnDurationMs" | "maximumHealth">,
  elapsedMs: number
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor((elapsedMs * profile.maximumHealth) / structureWarfareFullRepairMs(profile));
}

/** Player-facing structure name; a kingdom seat is always the Castle. */
export function structureWarfareDisplayKind(kind: StructureWarfareProfileKind): string {
  switch (kind) {
    case "city_flag": return "City Flag";
    case "city_tower": return "City Tower";
    case "kingdom_tower": return "Kingdom Tower";
    case "kingdom_obelisk": return "Obelisk";
    case "war_tower": return "War Tower";
    case "war_outpost": return "War Outpost";
    case "city_center": return "City Center";
    case "kingdom_flag": return "Kingdom Flag";
    case "castle": return "Castle";
    case "tower": return "Tower";
    case "stone": return "Stone Flag";
    case "atlas_shrine": return "Atlas Shrine";
    default: return "Flag";
  }
}

export function formatStructureWarfareDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${Math.max(1, Math.round(durationMs / 1_000))} seconds`;
  const hours = Math.round(durationMs / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.round(durationMs / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
