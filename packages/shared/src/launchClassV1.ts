import type { ClassId, PassiveTier, TechniqueDefinition, WeaponCategory } from "./classContracts.js";

type CatalogClassId = Exclude<ClassId, "hunter">;
type ActiveSpec = { activation?: "armed" | "instant" | "drag"; targetType?: TechniqueDefinition["targetType"];
  dragTargetKind?: "position" | "direction"; weapons?: readonly WeaponCategory[];
  supportKind?: TechniqueDefinition["supportKind"]; healthOnly?: boolean;
  targetRangeM?: number; targetRadiusM?: number; damageMultiplier?: number;
  weaponRequirement?: TechniqueDefinition["weaponRequirement"] };
const active = (classId: CatalogClassId, id: string, name: string, kind: "normal" | "ultimate", unlockLevel: number,
  cooldownMs: number, description: string, spec: ActiveSpec = {}): TechniqueDefinition => ({
  id, classId, subclassId: null, name, shortLabel: name, kind, unlockLevel, description, rageCost: 0,
  resourceCost: 0, cooldownMs, targetType: spec.targetType ?? "hostile",
  weaponRequirement: spec.weaponRequirement ?? (spec.weapons?.some((v) => ["bow", "crossbow", "sling", "shuriken"].includes(v)) ? "ranged" : spec.weapons ? "melee" : "any"),
  ...(spec.activation ? { activation: spec.activation } : {}), ...(spec.dragTargetKind ? { dragTargetKind: spec.dragTargetKind } : {}),
  ...(spec.weapons ? { allowedWeaponCategories: spec.weapons } : {}), ...(spec.supportKind ? { supportKind: spec.supportKind } : {}),
  ...(spec.healthOnly ? { healthOnly: true } : {}), ...(spec.targetRangeM ? { targetRangeM: spec.targetRangeM } : {}),
  ...(spec.targetRadiusM ? { targetRadiusM: spec.targetRadiusM } : {}),
  ...(spec.damageMultiplier !== undefined ? { damageMultiplier: spec.damageMultiplier } : {})
});
const passive = (classId: CatalogClassId, id: string, name: string, unlockLevel: number, passiveTier: PassiveTier,
  description: string, spec: Pick<ActiveSpec, "targetRadiusM"> = {}): TechniqueDefinition => ({ id, classId, subclassId: null, name, shortLabel: name, kind: "passive",
  unlockLevel, passiveTier, description, rageCost: 0, resourceCost: 0, cooldownMs: 0, targetType: "self", weaponRequirement: "any",
  ...(spec.targetRadiusM ? { targetRadiusM: spec.targetRadiusM } : {}) });

// Removed historical classes stay in the durable catalog and remain executable/serializable.
export const DRUID_ACTIVE_DEFINITIONS = [
  active("druid", "druid_nature_bolt", "Nature Bolt", "normal", 1, 10_000, "Deal 125% basic-attack damage and Root the target for 2 seconds.", { damageMultiplier: 1.25 }),
  active("druid", "druid_rejuvenation", "Rejuvenation", "normal", 3, 15_000, "Heal self or an eligible ally for about 3 HP every 1.4 seconds for 9.8 seconds.", { targetType: "friendly", supportKind: "healing", healthOnly: true }),
  active("druid", "druid_thorn_burst", "Thorn Burst", "normal", 8, 18_000, "Deal 50% basic-attack damage to eligible hostile PvE enemies within 100 meters.", { targetType: "self", damageMultiplier: 0.5 }),
  active("druid", "druid_regrowth", "Regrowth", "normal", 11, 25_000, "Heal self or an eligible ally for 20 HP, then about 3 HP every 1.4 seconds for 5.6 seconds.", { targetType: "friendly", supportKind: "healing", healthOnly: true })
] as const satisfies readonly TechniqueDefinition[];
export const DRUID_PASSIVE_TIERS = { 0: [passive("druid", "druid_natural_focus", "Natural Focus", 2, 0, "Damaging Druid class skills deal +1 flat damage."), passive("druid", "druid_gentle_touch", "Gentle Touch", 2, 0, "Druid healing spells restore +2 HP once per successful cast.")], 10: [passive("druid", "druid_thorned_growth", "Thorned Growth", 7, 10, "Thorn Burst deals +2 flat damage to each valid enemy."), passive("druid", "druid_deep_roots", "Deep Roots", 7, 10, "Druid periodic healing restores +1 HP per tick.")], 20: [passive("druid", "druid_predatory_growth", "Predatory Growth", 12, 20, "Damaging actions deal +2 flat damage to enemies below 35% HP."), passive("druid", "druid_flourish", "Flourish", 12, 20, "Healing an eligible living target below 35% HP restores +5 HP once per cast.")] } as const;
export const KNIGHT_ACTIVE_DEFINITIONS = [active("knight", "knight_heavy_slash", "Heavy Slash", "normal", 1, 10_000, "Deal 125% basic-attack damage.", { damageMultiplier: 1.25, weaponRequirement: "melee" }), active("knight", "knight_taunt", "Taunt", "normal", 3, 15_000, "Taunt eligible hostile PvE enemies within 150 meters.", { targetType: "self" }), active("knight", "knight_brace", "Brace", "normal", 8, 20_000, "Reduce incoming Knight damage by 30% for 6 seconds.", { targetType: "self", supportKind: "buff" }), active("knight", "knight_intervene", "Intervene", "normal", 11, 25_000, "Redirect an eligible nearby party member's next damaging hit to the Knight with 25% mitigation.", { targetType: "friendly", supportKind: "buff" })] as const;
export const KNIGHT_PASSIVE_TIERS = { 0: [passive("knight", "knight_heavy_blade", "Heavy Blade", 2, 0, "Basic Sword attacks deal +1 flat damage."), passive("knight", "knight_stalwart", "Stalwart", 2, 0, "Gain +1 Defense while Knight is active.")], 10: [passive("knight", "knight_threatening_presence", "Threatening Presence", 7, 10, "Qualifying damaging actions generate twice normal PvE threat."), passive("knight", "knight_surrounded", "Surrounded", 7, 10, "Gain +2 Defense while at least two eligible PvE enemies target the Knight.")], 20: [passive("knight", "knight_unyielding", "Unyielding", 12, 20, "Brace lasts 8 seconds instead of 6."), passive("knight", "knight_guardians_duty", "Guardian's Duty", 12, 20, "Intervene redirected-hit mitigation becomes 35%.")] } as const;

export const WARRIOR_V2_ACTIVE_DEFINITIONS = [
  active("warrior", "warrior_v2_sundering_arc", "Cleave", "normal", 1, 18_000, "Your next Axe attack hits the primary target normally and deals 4 damage to up to three nearby enemies.", { activation: "armed", weapons: ["axe"], targetRadiusM: 150 }),
  active("warrior", "warrior_v2_iron_reversal", "Iron Reversal", "normal", 3, 22_000, "For 3 seconds, block the next targeted basic or weapon attack. Blocking empowers your next Axe attack for +4 damage.", { activation: "instant", targetType: "self" }),
  active("warrior", "warrior_v2_faultline", "Blood Rush", "normal", 8, 25_000, "Rush up to 250 meters toward an enemy and immediately perform an Axe attack. If it dies within 5 seconds, reduce this cooldown by 10 seconds.", { activation: "instant", weapons: ["axe"], targetRangeM: 250 }),
  active("warrior", "warrior_v2_rallying_roar", "Rallying Roar", "normal", 11, 35_000, "You and nearby party members gain +2 Defense for 10 seconds.", {
    activation: "instant",
    targetType: "self",
    supportKind: "buff",
    targetRadiusM: 650,
  }),
] as const;
export const WARRIOR_V2_ULTIMATE_DEFINITIONS = [active("warrior", "warrior_v2_worldbreaker", "Worldbreaker", "ultimate", 14, 300_000, "Enemies within 350 meters take 12 damage and are Strong Slowed for 4 seconds.", { activation: "instant", targetType: "self", targetRadiusM: 350 })] as const;
export const WARRIOR_V2_PASSIVE_TIERS = {
  0: [passive("warrior", "warrior_v2_retaliation", "Bloodthirst", 2, 0, "Mob kills heal 5 HP."), passive("warrior", "warrior_v2_battle_hardened", "Battle Hardened", 2, 0, "The first damaging hit every 8 seconds deals 3 less.")],
  10: [passive("warrior", "warrior_v2_relentless", "Parting Blow", 7, 10, "Killing an enemy deals 4 damage to nearby enemies. Passive damage cannot chain."), passive("warrior", "warrior_v2_battle_grit", "Crowd Fighter", 7, 10, "Gain +2 Defense while fighting at least two enemies.")],
  20: [passive("warrior", "warrior_v2_berserker", "Blood Frenzy", 12, 20, "Kills reduce Cleave and Blood Rush cooldowns by 5 seconds."), passive("warrior", "warrior_v2_juggernaut", "Juggernaut", 12, 20, "Below 25% HP, targeted attacks deal 2 less damage.")],
} as const;

export const RANGER_ACTIVE_DEFINITIONS = [
  active("ranger", "ranger_v2_throughshot", "Piercing Arrow", "normal", 1, 18_000, "Your next Bow, Crossbow or Sling attack hits normally, then deals 5 damage to one enemy directly behind the target.", { activation: "armed", weapons: ["bow", "crossbow", "sling"], targetRadiusM: 150 }),
  active("ranger", "ranger_v2_threefold_volley", "Retreat Volley", "normal", 3, 24_000, "Backstep up to 120 meters away from your current enemy and immediately perform a Bow, Crossbow or Sling attack as one action.", { activation: "instant", weapons: ["bow", "crossbow", "sling"] }),
  active("ranger", "ranger_v2_marked_quarry", "Quarry Sign", "normal", 8, 25_000, "Mark an enemy for 12 seconds. It loses 2 Defense and is marked for your party.", { activation: "instant" }),
  active("ranger", "ranger_v2_snare_shot", "Snare Trap", "normal", 11, 25_000, "Place a visible trap within 300 meters for 30 seconds. The first enemy to trigger it takes 4 damage and Strong Slow for 4 seconds.", {
    activation: "drag",
    targetType: "self",
    dragTargetKind: "position",
    targetRangeM: 300,
    targetRadiusM: 25,
  }),
] as const;
export const RANGER_ULTIMATE_DEFINITIONS = [
  active("ranger", "ranger_v2_black_rain", "Black Rain", "ultimate", 14, 300_000, "Place a 300-meter arrow storm within 650 meters for 6 seconds. Enemies inside take 7 damage every 1.4 seconds and are Strong Slowed.", {
    activation: "drag",
    targetType: "self",
    dragTargetKind: "position",
    targetRangeM: 650,
    targetRadiusM: 300,
  }),
] as const;
export const RANGER_PASSIVE_TIERS = {
  0: [passive("ranger", "ranger_v2_broadheads", "Far Sight", 2, 0, "Gain +50 meters Bow range."), passive("ranger", "ranger_v2_clear_shot", "Trailcraft", 2, 0, "Gain +10% movement speed while wearing Leather without a Shield.")],
  10: [passive("ranger", "ranger_v2_quick_draw", "Clear Shot", 7, 10, "Isolated targets take +2 Bow damage."), passive("ranger", "ranger_v2_keep_your_distance", "Trapper", 7, 10, "Snare Trap deals +4 damage.")],
  20: [passive("ranger", "ranger_v2_deadeye", "Deadeye", 12, 20, "Bow attacks from at least 200 meters deal +3 damage."), passive("ranger", "ranger_v2_suppressing_fire", "Wild Slayer", 12, 20, "Killing a mob grants +2 damage against that species for 60 seconds.")],
} as const;

export const NINJA_ACTIVE_DEFINITIONS = [
  active("ninja", "ninja_v2_twin_fang", "Steel Tempest", "normal", 1, 20_000, "Rapidly throw three Shuriken at your current target for 3 damage each as one authoritative action.", { activation: "instant", weapons: ["shuriken"] }),
  active("ninja", "ninja_v2_smoke_bomb", "Substitution", "normal", 3, 25_000, "Prepare for 3 seconds. The next targeted basic or weapon attack misses and relocates you 50 meters away from the attacker.", { activation: "instant", targetType: "self" }),
  active("ninja", "ninja_v2_shadowstep", "Ghost Step", "normal", 8, 20_000, "Teleport to a valid point up to 120 meters away and remove Slow, Root, and movement restrictions.", {
    activation: "drag",
    targetType: "self",
    dragTargetKind: "position",
    targetRangeM: 120,
  }),
  active("ninja", "ninja_v2_shuriken_fan", "Razor Fan", "normal", 11, 18_000, "Throw Shuriken through a wide frontal fan, hitting up to four enemies for 4 damage each.", { activation: "instant", weapons: ["shuriken"], targetRadiusM: 300 }),
] as const;
export const NINJA_ULTIMATE_DEFINITIONS = [active("ninja", "ninja_v2_thousand_shadows", "Thousand Blades", "ultimate", 14, 300_000, "Unleash six ordered Shuriken hits for 4 damage each against one enemy as one authoritative action.", { activation: "instant", weapons: ["shuriken"] })] as const;
export const NINJA_PASSIVE_TIERS = {
  0: [passive("ninja", "ninja_v2_razor_edge", "Razor Edge", 2, 0, "Shuriken deal +1 damage."), passive("ninja", "ninja_v2_light_feet", "Light Feet", 2, 0, "Gain +10% movement speed while wearing Cloth.")],
  10: [passive("ninja", "ninja_v2_quick_hands", "Quick Hands", 7, 10, "Razor Fan and Steel Tempest cooldowns are reduced by 3 seconds."), passive("ninja", "ninja_v2_elusive", "Fleet Shadow", 7, 10, "Ghost Step and Substitution cooldowns are reduced by 3 seconds.")],
  20: [passive("ninja", "ninja_v2_flow_state", "Close Quarters", 12, 20, "Shuriken deal +2 damage within 100 meters."), passive("ninja", "ninja_v2_afterimage", "Untouchable", 12, 20, "Successfully Dodging grants +20% movement speed for 3 seconds.")],
} as const;

export const LAUNCH_KIT_ACTIVE_DEFINITIONS = [...DRUID_ACTIVE_DEFINITIONS, ...KNIGHT_ACTIVE_DEFINITIONS, ...RANGER_ACTIVE_DEFINITIONS, ...RANGER_ULTIMATE_DEFINITIONS, ...NINJA_ACTIVE_DEFINITIONS, ...NINJA_ULTIMATE_DEFINITIONS] as const;
export const LAUNCH_KIT_PASSIVE_DEFINITIONS = [...Object.values(DRUID_PASSIVE_TIERS).flat(), ...Object.values(KNIGHT_PASSIVE_TIERS).flat(), ...Object.values(RANGER_PASSIVE_TIERS).flat(), ...Object.values(NINJA_PASSIVE_TIERS).flat()] as readonly TechniqueDefinition[];
export const LAUNCH_CLASS_TITLES = { warrior: "Master Warrior", druid: "Master Druid", ranger: "Master Ranger", knight: "Master Knight", ninja: "Master Ninja" } as const satisfies Record<Exclude<ClassId, "hunter">, string>;
