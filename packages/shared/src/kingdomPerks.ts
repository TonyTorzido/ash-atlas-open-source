import { z } from "zod";

/*
 * Kingdom perk tree. Levels 2-8 each offer four perks and
 * the kingdom keeps one chosen perk per level. Level 9 exists but offers no
 * perks yet; it is shown as "coming soon". The leader chooses and
 * changes perks with treasury Bricks and Glimmer Oil. Level 6 holds three activated perks: the leader starts a
 * 24 h buff for every member, at most once per 24 h.
 *
 * Every effect line says whether it is live. A line that is not live is
 * stored and shown as "coming soon": its system does not exist yet, and it
 * is never faked.
 */
export const KINGDOM_PERK_LEVELS = [2, 3, 4, 5, 6, 7, 8, 9] as const;
export type KingdomPerkLevel = (typeof KINGDOM_PERK_LEVELS)[number];

export const KINGDOM_PERK_IDS = [
  "verdant_surge",
  "picket_lines",
  "boundary_writ",
  "reserved_game",
  "beacon_wardens",
  "braced_foundations",
  "grand_masonry",
  "forward_sappers",
  "skyward_stonework",
  "sworn_ramparts",
  "gilded_trim",
  "warded_monuments",
  "unyielding_assault",
  "picked_legion",
  "hearth_ground",
  "labor_corps",
  "breach_company",
  "the_spearhead",
  "the_watchfires",
  "caravan_guild",
  "arcane_reavers",
  "mortar_guard",
  "prism_knights",
  "cache_hunters",
  "treacherous_ground",
  "far_renown",
  "restless_herds",
  "prism_holdings"
] as const;
export type KingdomPerkId = (typeof KINGDOM_PERK_IDS)[number];

/** Treasury cost of choosing a perk on an empty level. */
export const KINGDOM_PERK_CHOOSE_COST = Object.freeze({ bricks: 23_500, glimmerOil: 1_150 });
/** Treasury cost of replacing the chosen perk of a level. */
export const KINGDOM_PERK_CHANGE_COST = Object.freeze({ bricks: 34_000, glimmerOil: 1_700 });
export const KINGDOM_PERK_BUFF_DURATION_MS = 24 * 60 * 60 * 1_000;
export const KINGDOM_PERK_ACTIVATION_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

/* Effect values, kept as tunable constants next to the tree. */
export const KINGDOM_PERK_BOUNDARY_WRIT_BONUS = 2;
/** Verdant Surge: flat healing added to each heal a member receives on kingdom land and in dungeons. */
export const KINGDOM_PERK_VERDANT_SURGE_HEAL_BONUS = 4;
export const KINGDOM_PERK_PICKET_LINES_BRICK_MULTIPLIER = 2;
/** Boundary Writ: Bricks roll for members on the land of a kingdom their kingdom is at war with (normally 10%). */
export const KINGDOM_PERK_BOUNDARY_WRIT_WAR_BRICK_CHANCE = 0.25;
export const KINGDOM_PERK_RESERVED_GAME_GOLD_BONUS = 0.06;
export const KINGDOM_PERK_BEACON_WARDENS_ATTACK_BONUS = 3;
export const KINGDOM_PERK_BEACON_WARDENS_RANGE_M = 550;
export const KINGDOM_PERK_BRACED_FOUNDATIONS_REDUCTION = 8;
export const KINGDOM_PERK_GRAND_MASONRY_BRICK_BONUS = 0.12;
export const KINGDOM_PERK_FORWARD_SAPPERS_ATTACK_BONUS = 4;
export const KINGDOM_PERK_SKYWARD_STONEWORK_RADIUS_M = 900;
/** Sworn Ramparts: an obelisk shoots like a level 1 Kingdom Tower. */
export const KINGDOM_PERK_SWORN_RAMPARTS_TOWER_LEVEL = 1;
export const KINGDOM_PERK_GILDED_TRIM_BONUS_PER_OBELISK_LEVEL = 0.006;
export const KINGDOM_PERK_WARDED_MONUMENTS_REDUCTION_PER_OBELISK_LEVEL = 4;
export const KINGDOM_PERK_WARDED_MONUMENTS_RADIUS_M = 550;
export const KINGDOM_PERK_UNYIELDING_ASSAULT_MULTIPLIER = 1.35;
export const KINGDOM_PERK_PICKED_LEGION_ATTACK_BONUS = 4;
/** Hearth Ground: +4% Bricks per military unit following the gatherer. */
export const KINGDOM_PERK_HEARTH_GROUND_BRICK_BONUS_PER_UNIT = 0.04;
export const KINGDOM_PERK_LABOR_CORPS_TIME_MULTIPLIER = 0.8;
/** Breach Company: +1 attack per other kingdom member within this range, capped. */
export const KINGDOM_PERK_BREACH_COMPANY_RANGE_M = 550;
export const KINGDOM_PERK_BREACH_COMPANY_MAX_BONUS = 4;
export const KINGDOM_PERK_SPEARHEAD_ATTACK_BONUS = 2;
/** The Spearhead: flat movement speed (in the same units as class speed bonuses, base 125) while the buff runs. */
export const KINGDOM_PERK_SPEARHEAD_SPEED_BONUS = 25;
export const KINGDOM_PERK_WATCHFIRES_DEFENSE_BONUS = 3;
/** The Watchfires: an enemy human unit a member defeats takes this many times longer to recover (20 min -> 28 min). */
export const KINGDOM_PERK_WATCHFIRES_RECOVERY_MULTIPLIER = 1.4;
export const KINGDOM_PERK_CARAVAN_GUILD_DROP_CHANCE_MULTIPLIER = 1.2;
/** Level 7 perks pay once each time a member receives a ring from a Legendary mob. */
export const KINGDOM_PERK_MORTAR_GUARD_TREASURY_BRICKS = 1_250;
export const KINGDOM_PERK_PRISM_KNIGHTS_TREASURY_CRYSTAL = 1_800;
/** Cache Hunters: there is no treasury gold, so the member gets it. */
export const KINGDOM_PERK_CACHE_HUNTERS_GOLD = 18_000;
/** Treacherous Ground: flat attack for members within this range of an overworld dungeon entrance. */
export const KINGDOM_PERK_TREACHEROUS_GROUND_ATTACK_BONUS = 3;
export const KINGDOM_PERK_TREACHEROUS_GROUND_RANGE_M = 550;
export const KINGDOM_PERK_FAR_RENOWN_BRICK_BONUS = 0.12;
/** Restless Herds: members' dungeon repeat lockout is this many days shorter (never below 1 day). */
export const KINGDOM_PERK_RESTLESS_HERDS_LOCKOUT_REDUCTION_DAYS = 1;
/** Prism Holdings: each mob kill by a member has this chance to give the member Crystal. */
export const KINGDOM_PERK_PRISM_HOLDINGS_CHANCE = 0.012;
export const KINGDOM_PERK_PRISM_HOLDINGS_QUANTITY = 120;

export type KingdomPerkEffectLine = Readonly<{ text: string; live: boolean }>;

export type KingdomPerkDefinition = Readonly<{
  id: KingdomPerkId;
  level: KingdomPerkLevel;
  displayName: string;
  description: string;
  effects: readonly KingdomPerkEffectLine[];
  /** Always-on member attack / defense while the perk is chosen. */
  attackBonus: number;
  defenseBonus: number;
  /** A level 6 perk the leader activates as a 24 h member buff. */
  activated: boolean;
  /** Member attack / defense while the activated buff runs. */
  buffAttackBonus: number;
  buffDefenseBonus: number;
}>;

function perk(
  id: KingdomPerkId,
  level: KingdomPerkLevel,
  displayName: string,
  description: string,
  effects: KingdomPerkEffectLine[],
  extra: Partial<Pick<KingdomPerkDefinition,
    "attackBonus" | "defenseBonus" | "activated" | "buffAttackBonus" | "buffDefenseBonus">> = {}
): KingdomPerkDefinition {
  return Object.freeze({
    id,
    level,
    displayName,
    description,
    effects: Object.freeze(effects.map((line) => Object.freeze(line))),
    attackBonus: extra.attackBonus ?? 0,
    defenseBonus: extra.defenseBonus ?? 0,
    activated: extra.activated ?? false,
    buffAttackBonus: extra.buffAttackBonus ?? 0,
    buffDefenseBonus: extra.buffDefenseBonus ?? 0
  });
}

export const KINGDOM_PERKS: Readonly<Record<KingdomPerkId, KingdomPerkDefinition>> = Object.freeze({
  verdant_surge: perk("verdant_surge", 2, "Verdant Surge", "Members heal faster at home.", [
    { text: "+4 to each heal a member receives on kingdom land and in dungeons", live: true }
  ]),
  picket_lines: perk("picket_lines", 2, "Picket Lines", "Patrols keep the kingdom's own land productive.", [
    { text: "2x Bricks for members on connected kingdom land", live: true },
    { text: "20 h respawn", live: false }
  ]),
  boundary_writ: perk("boundary_writ", 2, "Boundary Writ", "Members fight harder for the realm.", [
    { text: "+2 attack and +2 defense for members", live: true },
    { text: "25% Brick roll (instead of 10%) on the land of a kingdom at war with yours", live: true }
  ], { attackBonus: KINGDOM_PERK_BOUNDARY_WRIT_BONUS, defenseBonus: KINGDOM_PERK_BOUNDARY_WRIT_BONUS }),
  reserved_game: perk("reserved_game", 2, "Reserved Game", "The kingdom's hunting grounds pay better.", [
    { text: "+6% gold from kills on connected kingdom land", live: true }
  ]),
  beacon_wardens: perk("beacon_wardens", 3, "Beacon Wardens", "Kingdom Towers are manned day and night.", [
    { text: "Kingdom Towers +3 attack", live: true },
    { text: "Kingdom Tower range 550 m", live: true }
  ]),
  braced_foundations: perk("braced_foundations", 3, "Braced Foundations", "Braced towers shrug off blows.", [
    { text: "Kingdom Towers take 8 less damage per hit", live: true }
  ]),
  grand_masonry: perk("grand_masonry", 3, "Grand Masonry", "Members find more building stone.", [
    { text: "+12% Bricks for members", live: true }
  ]),
  forward_sappers: perk("forward_sappers", 3, "Forward Sappers", "Sharper siege engineers at the front.", [
    { text: "War Towers +4 attack", live: true }
  ]),
  skyward_stonework: perk("skyward_stonework", 4, "Skyward Stonework", "Taller obelisks reach further.", [
    { text: "Obelisk radius 900 m", live: true }
  ]),
  sworn_ramparts: perk("sworn_ramparts", 4, "Sworn Ramparts", "Obelisks are armed.", [
    { text: "Obelisks shoot like a level 1 Kingdom Tower", live: true }
  ]),
  gilded_trim: perk("gilded_trim", 4, "Gilded Trim", "Gilded obelisks enrich the hunt.", [
    { text: "+0.6% gold per obelisk level for members hunting near an obelisk", live: true }
  ]),
  warded_monuments: perk("warded_monuments", 4, "Warded Monuments", "Monuments shield the realm.", [
    { text: "Kingdom structures take 4 less damage per hit per obelisk level within 550 m", live: true }
  ]),
  unyielding_assault: perk("unyielding_assault", 5, "Unyielding Assault", "Members' Sieges hit harder.", [
    { text: "+35% Siege damage", live: true }
  ]),
  picked_legion: perk("picked_legion", 5, "Picked Legion", "Drilled soldiers.", [
    { text: "Infantry and Archers +4 attack per unit", live: true }
  ]),
  hearth_ground: perk("hearth_ground", 5, "Hearth Ground", "Escorted members gather more.", [
    { text: "+4% Bricks per military unit following the member", live: true }
  ]),
  labor_corps: perk("labor_corps", 5, "Labor Corps", "Builders work faster for the realm.", [
    { text: "Kingdom construction and advancement projects 20% quicker", live: true }
  ]),
  breach_company: perk("breach_company", 6, "Breach Company", "Members fight better together.", [
    { text: "+1 attack per other kingdom member within 550 m, up to +4", live: true }
  ]),
  the_spearhead: perk("the_spearhead", 6, "The Spearhead", "Leader-activated 24 h buff.", [
    { text: "24 h: +2 attack for members", live: true },
    { text: "24 h: +25 movement speed for members", live: true }
  ], { activated: true, buffAttackBonus: KINGDOM_PERK_SPEARHEAD_ATTACK_BONUS }),
  the_watchfires: perk("the_watchfires", 6, "The Watchfires", "Leader-activated 24 h buff.", [
    { text: "24 h: +3 defense for members", live: true },
    { text: "24 h: enemy units your members defeat recover 1.4x slower", live: false }
  ], { activated: true, buffDefenseBonus: KINGDOM_PERK_WATCHFIRES_DEFENSE_BONUS }),
  caravan_guild: perk("caravan_guild", 6, "Caravan Guild", "Leader-activated 24 h buff.", [
    { text: "24 h: +20% item drop chance for members", live: true }
  ], { activated: true }),
  arcane_reavers: perk("arcane_reavers", 7, "Arcane Reavers", "Legendary hunts pay in rings.", [
    { text: "+1 Peerless Ring when a member receives a ring from a Legendary mob", live: true }
  ]),
  mortar_guard: perk("mortar_guard", 7, "Mortar Guard", "Legendary hunts fill the brickyard.", [
    { text: "+1,250 treasury Bricks when a member receives a ring from a Legendary mob", live: true }
  ]),
  prism_knights: perk("prism_knights", 7, "Prism Knights", "Legendary hunts fill the vaults.", [
    { text: "+1,800 treasury Crystal when a member receives a ring from a Legendary mob", live: true }
  ]),
  cache_hunters: perk("cache_hunters", 7, "Cache Hunters", "Legendary hunts pay in gold.", [
    { text: "+18,000 gold to the member when they receive a ring from a Legendary mob", live: true }
  ]),
  treacherous_ground: perk("treacherous_ground", 8, "Treacherous Ground", "Members fight hard at the dungeon gates.", [
    { text: "+3 attack for members within 550 m of a dungeon entrance", live: true }
  ]),
  far_renown: perk("far_renown", 8, "Far Renown", "Members find more building stone.", [
    { text: "+12% Bricks for members", live: true },
    { text: "Lampwright eligibility", live: false }
  ]),
  restless_herds: perk("restless_herds", 8, "Restless Herds", "Members return to dungeons sooner.", [
    { text: "Members' dungeon repeat lockout 1 day shorter (at least 1 day)", live: true }
  ]),
  prism_holdings: perk("prism_holdings", 8, "Prism Holdings", "Crystal turns up on the hunt.", [
    { text: "Each mob kill by a member has a 1.2% chance to give 120 Crystal", live: true }
  ])
});

export function kingdomPerksForLevel(level: KingdomPerkLevel): KingdomPerkDefinition[] {
  return KINGDOM_PERK_IDS.map((id) => KINGDOM_PERKS[id]).filter((definition) => definition.level === level);
}

export function isKingdomPerkId(value: unknown): value is KingdomPerkId {
  return typeof value === "string" && (KINGDOM_PERK_IDS as readonly string[]).includes(value);
}

/** True when every effect line of the perk is still "coming soon". */
export function kingdomPerkIsInert(definition: Pick<KingdomPerkDefinition, "effects">): boolean {
  return definition.effects.every((line) => !line.live);
}

/** A kingdom's chosen perk for one level. */
export type KingdomPerkSelectionSnapshot = {
  level: KingdomPerkLevel;
  perkId: KingdomPerkId;
  selectedAt: string;
  /** Activated perks: when the current 24 h buff ends (null when none runs). */
  activeUntil: string | null;
  /** Activated perks: when the leader may activate again (null when ready now). */
  nextActivationAt: string | null;
};

export const kingdomPerkChooseInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  perkId: z.enum(KINGDOM_PERK_IDS),
  /**
   * The perk the leader saw chosen on that level (null for an empty level).
   * A level that changed since is refused rather than charged the other price.
   */
  expectedCurrentPerkId: z.enum(KINGDOM_PERK_IDS).nullable()
}).strict();

export const kingdomPerkActivateInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  perkId: z.enum(KINGDOM_PERK_IDS)
}).strict();

export type KingdomPerkChooseInput = z.infer<typeof kingdomPerkChooseInputSchema>;
export type KingdomPerkActivateInput = z.infer<typeof kingdomPerkActivateInputSchema>;
