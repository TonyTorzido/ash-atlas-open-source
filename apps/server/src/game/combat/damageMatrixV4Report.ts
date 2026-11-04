/**
 * Damage matrix v4 review report (docs/plans/damage-matrix-v4-review.md): every archetype's v4 types next to its
 * v3 matchup, and old (v3) versus new (v4) hits to kill at equal level, both directions. Mob and player HP are
 * today's values (the spec retunes them after the matrix lands).
 *
 *   pnpm --filter @ash-atlas/server report:damage-matrix-v4 > docs/plans/damage-matrix-v4-review.md
 */
import {
  ARMOUR_TYPE_V4_LABELS,
  DAMAGE_TYPES_V4,
  DAMAGE_TYPE_V4_LABELS,
  DEFAULT_ATTACK_PROFILE,
  MATCHUP_ARMOR_TYPE_LABELS,
  MATCHUP_WEAPON_TYPE_LABELS,
  MOB_MATCHUPS,
  MOB_V4_TIERS,
  MOB_V4_TIER_BASE_DAMAGE,
  MOB_V4_TYPES,
  SHOT_DAMAGE_FACTOR,
  SHOT_RECOVERY_TICKS,
  SWORD_GENERIC_ATTACK_PROFILE,
  V3_BODY_PROFILE_TO_V4_ARMOUR,
  WEAPON_PROFILES_V4,
  attackStepCycleMs,
  mobV4Profile,
  resolveDamageMatrixV4,
  resolveMatchupDamage,
  type AttackProfile,
  type MobArchetypeKey,
  type PvpDamageWeaponProfileV3,
  type WeaponProfileV4
} from "@ash-atlas/shared";

import { resolveMobCombatProfile } from "./mobDefinitions.js";

const LEVEL = 10;
const PLAYER_HEALTH = 100;
const TICK_MS = 50;

type Cadence = Readonly<{ label: string; steps: readonly Readonly<{ factor: number; cycleMs: number }>[] }>;

function comboCadence(profile: AttackProfile): Cadence {
  return {
    label: `${profile.id} combo`,
    steps: profile.combo.map((step) => ({ factor: step.damageMultiplier, cycleMs: attackStepCycleMs(step) }))
  };
}

const SHOT: Cadence = { label: "shot", steps: [{ factor: SHOT_DAMAGE_FACTOR, cycleMs: SHOT_RECOVERY_TICKS * TICK_MS }] };

/** Today's action-combat cadence per weapon (attack profiles); the staff is a melee weapon today. */
const WEAPONS: readonly Readonly<{ label: string; v3: PvpDamageWeaponProfileV3 | null; v4: WeaponProfileV4; cadence: Cadence }>[] = [
  { label: "Sword", v3: "sword", v4: "sword", cadence: comboCadence(SWORD_GENERIC_ATTACK_PROFILE) },
  { label: "Double Axe", v3: "axe", v4: "axe", cadence: comboCadence(DEFAULT_ATTACK_PROFILE) },
  { label: "Hammer (new)", v3: null, v4: "hammer", cadence: comboCadence(DEFAULT_ATTACK_PROFILE) },
  { label: "Bow", v3: "longbow", v4: "longbow", cadence: SHOT },
  { label: "Scepter (new)", v3: null, v4: "scepter", cadence: SHOT },
  { label: "Staff", v3: "staff", v4: "staff", cadence: comboCadence(DEFAULT_ATTACK_PROFILE) },
  { label: "Spear (legacy)", v3: "spear", v4: "spear", cadence: comboCadence(DEFAULT_ATTACK_PROFILE) },
  { label: "Dagger (legacy)", v3: "dagger", v4: "dagger", cadence: comboCadence(DEFAULT_ATTACK_PROFILE) }
];

/** One archetype per v4 armour type, plus two common overworld mobs. */
const SAMPLE_MOBS: readonly MobArchetypeKey[] = [
  "wolf", "bear", "deer", "frog", "alligator", "coastal_crab", "orc_brute", "skeleton", "barrow_wight", "slime",
  "blight_treant", "hedge_witch"
];

/** Hits (and seconds) to empty a pool, cycling the cadence steps; null when a hit rounds to nothing useful. */
function toKill(health: number, cadence: Cadence, hit: (factor: number) => number): { hits: number; seconds: number } {
  let remaining = health;
  let hits = 0;
  let ms = 0;
  while (remaining > 0 && hits < 1_000) {
    const step = cadence.steps[hits % cadence.steps.length]!;
    remaining -= hit(step.factor);
    hits += 1;
    if (remaining > 0) ms += step.cycleMs;
  }
  return { hits, seconds: ms / 1_000 };
}

function cell(result: { hits: number; seconds: number } | null): string {
  return result === null ? "n/a" : `${result.hits} (${result.seconds.toFixed(1)} s)`;
}

function change(before: { hits: number } | null, after: { hits: number }): string {
  if (before === null) return "new";
  const delta = (after.hits - before.hits) / before.hits;
  return `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%`;
}

/** The owner-requested review pass over the drafted table (archetype, was, now, why). */
const REVIEW_CHANGES: readonly (readonly [string, string, string, string])[] = [
  ["dune_tick", "Slash / Plate", "Slash / Cloth", "A small insect; its thin shell is not plate."],
  ["sewer_spider", "Slash / Mail", "Slash / Cloth", "A small sewer spider is soft-bodied."],
  ["giant_scorpion", "Pierce / Leather", "Pierce / Plate", "Flavor was copied from the hog template; a giant scorpion is an armoured carapace."],
  ["basilisk", "Pierce / Leather", "Slash / Mail", "Flavor was copied from the hog template; a basilisk is a scaled reptile that bites."],
  ["thunderhorn", "Slash / Leather", "Pierce / Leather", "Flavor was copied from the bear template; it is a horned savanna beast that gores."],
  ["river_salmon", "Blunt / Mail", "Blunt / Leather", "Fish scales are light; mail made a 1-hit fish resist swords."],
  ["muskellunge", "Slash / Mail", "Slash / Leather", "Fish scales are light."],
  ["northern_pike", "Slash / Mail", "Slash / Leather", "Fish scales are light."],
  ["sidewinder", "Slash / Mail", "Slash / Leather", "A 1-hit desert snake; light scales."]
];

const out: string[] = [];
out.push("# Damage matrix v4 review");
out.push("");
out.push("Generated by `apps/server/src/game/combat/damageMatrixV4Report.ts` (`pnpm --filter @ash-atlas/server report:damage-matrix-v4`).");
out.push("Spec: `docs/plans/class-roster-v2.md` section 6. Flag: `DAMAGE_MATRIX_V4_ENABLED` (default off).");
out.push("");
out.push("## 1. Old versus new hits to kill (player into mob)");
out.push("");
out.push(`Equal level ${LEVEL} (weapon level = mob level), no rings or class bonuses, every hit lands. Mob HP is today's`);
out.push("(target hits x 9, unchanged). Each cell: hits (seconds of swinging at today's attack-profile cadence).");
out.push("Old = v3 table + 1 raw per level; new = v4 base x multiplier x 5%-per-level factor. Then the combo/shot factor.");
out.push("");
out.push("Cadence used: " + WEAPONS.map((weapon) => `${weapon.label} = ${weapon.cadence.label}`).join("; ") + ".");
out.push("");
for (const archetype of SAMPLE_MOBS) {
  const matchup = MOB_MATCHUPS[archetype];
  const v4Types = MOB_V4_TYPES[archetype];
  const health = resolveMobCombatProfile(archetype, LEVEL).maxHealth;
  out.push(`### ${archetype} (${health} HP; v3 ${MATCHUP_ARMOR_TYPE_LABELS[matchup.armorType]} -> v4 ${ARMOUR_TYPE_V4_LABELS[v4Types.armourType]})`);
  out.push("");
  out.push("| Weapon | v4 type | Old | New | Change |");
  out.push("|---|---|---|---|---|");
  for (const weapon of WEAPONS) {
    const v3 = weapon.v3;
    const old = v3 === null ? null : toKill(health, weapon.cadence, (factor) => resolveMatchupDamage({
      weaponType: v3, armorType: matchup.armorType, attackerLevel: LEVEL, defenderLevel: LEVEL, multiplier: factor
    }).finalDamage);
    const fresh = toKill(health, weapon.cadence, (factor) => resolveDamageMatrixV4({
      ...WEAPON_PROFILES_V4[weapon.v4], armourType: v4Types.armourType, attackerLevel: LEVEL, defenderLevel: LEVEL, multiplier: factor
    }).finalDamage);
    out.push(`| ${weapon.label} | ${DAMAGE_TYPE_V4_LABELS[WEAPON_PROFILES_V4[weapon.v4].damageType]} | ${cell(old)} | ${cell(fresh)} | ${change(old, fresh)} |`);
  }
  out.push("");
}

out.push("## 2. Mob into player: hits to kill by tier and armour (v4)");
out.push("");
out.push(`Owner rule (2026-10-21): a mob's base hit comes from its tier, tuned so an equal-level hit at matrix`);
out.push("multiplier 1.0 kills a 100 HP player in about 14 hits (low), 8 (medium) or 4 (strong) (owner 2026-10-21).");
out.push("Base hit: " + MOB_V4_TIERS.map((tier) => `${tier} ${MOB_V4_TIER_BASE_DAMAGE[tier]}`).join(", ") +
  ". The mob's damageMultiplier (bosses x1.25-x2) applies on top, then armour and the 5%-per-level rule.");
out.push("Tiers were drafted from the mob value pass labels: elite or boss spawn rarity, damageMultiplier above 1, or a");
out.push("miniboss -> strong; rare spawn or 9+ target hits (Hunt) -> medium; Critter and Game -> low.");
out.push("");
const PLAYER_V4_ARMOURS = ["unarmoured", "cloth", "leather", "mail", "plate"] as const;
for (const health of [PLAYER_HEALTH, 55]) {
  out.push(`### ${health} HP player, equal level, damageMultiplier 1, no shield`);
  out.push("");
  out.push(`| Tier | Mob damage type | ${PLAYER_V4_ARMOURS.map((armour) => ARMOUR_TYPE_V4_LABELS[armour]).join(" | ")} |`);
  out.push(`|---|---|${PLAYER_V4_ARMOURS.map(() => "---").join("|")}|`);
  for (const tier of MOB_V4_TIERS) {
    for (const damageType of DAMAGE_TYPES_V4.filter((type) => type !== "radiant")) {
      const cells = PLAYER_V4_ARMOURS.map((armour) => Math.ceil(health / resolveDamageMatrixV4({
        damageType, baseDamage: MOB_V4_TIER_BASE_DAMAGE[tier], armourType: armour, attackerLevel: LEVEL, defenderLevel: LEVEL
      }).finalDamage));
      out.push(`| ${tier} | ${DAMAGE_TYPE_V4_LABELS[damageType]} | ${cells.join(" | ")} |`);
    }
  }
  out.push("");
}
out.push("Level shifts: each level the mob is above the armour adds 5% damage (cap +50%), each level below takes 5% off (cap -50%).");
out.push("");
out.push("### Sample mobs, old (v3) -> new (v4) hits to kill a 100 HP player");
out.push("");
out.push(`Equal level ${LEVEL} (mob level = body-armour level), no shield, each mob's own multiplier. A smaller number means the mob kills faster.`);
out.push("");
const PLAYER_ARMOURS = ["unarmored", "martial_tunic", "leather", "chainmail", "breastplate"] as const;
out.push(`| Mob (tier) | v3 weapon -> v4 type | ${PLAYER_ARMOURS.map((armour) => ARMOUR_TYPE_V4_LABELS[V3_BODY_PROFILE_TO_V4_ARMOUR[armour]]).join(" | ")} |`);
out.push(`|---|---|${PLAYER_ARMOURS.map(() => "---").join("|")}|`);
for (const archetype of SAMPLE_MOBS) {
  const matchup = MOB_MATCHUPS[archetype];
  const profile = mobV4Profile(archetype);
  const cells = PLAYER_ARMOURS.map((armour) => {
    const old = resolveMatchupDamage({
      weaponType: matchup.weaponType, armorType: armour, attackerLevel: LEVEL, defenderLevel: LEVEL,
      multiplier: matchup.damageMultiplier
    }).finalDamage;
    const fresh = resolveDamageMatrixV4({
      damageType: profile.damageType, baseDamage: profile.baseDamage, armourType: V3_BODY_PROFILE_TO_V4_ARMOUR[armour],
      attackerLevel: LEVEL, defenderLevel: LEVEL, multiplier: profile.damageMultiplier
    }).finalDamage;
    return `${Math.ceil(PLAYER_HEALTH / old)} -> ${Math.ceil(PLAYER_HEALTH / fresh)}`;
  });
  out.push(`| ${archetype} (${profile.tier}) | ${MATCHUP_WEAPON_TYPE_LABELS[matchup.weaponType]} -> ${DAMAGE_TYPE_V4_LABELS[profile.damageType]} | ${cells.join(" | ")} |`);
}
out.push("");

out.push("## 3. Every archetype's v4 assignment");
out.push("");
out.push("Drafted from the flavor names with the spec defaults, then reviewed row by row (`packages/shared/src/mobMatchupsV4.ts`).");
out.push("Edit a row there to change it. The mob's base hit is its tier's; its boss/tier multiplier is unchanged.");
out.push("");
out.push("### Review changes (common-sense pass, 2026-10-21)");
out.push("");
out.push("| Archetype | Was | Now | Why |");
out.push("|---|---|---|---|");
for (const [archetype, was, now, why] of REVIEW_CHANGES) out.push(`| ${archetype} | ${was} | ${now} | ${why} |`);
out.push("");
out.push("All other rows were checked and kept (big beetles, crabs, turtles and golems stay Plate; crocodilians, sea serpents and dragons stay Mail).");
out.push("");
const tierCounts = new Map<string, number>();
for (const types of Object.values(MOB_V4_TYPES)) tierCounts.set(types.tier, (tierCounts.get(types.tier) ?? 0) + 1);
out.push("Tier totals: " + [...tierCounts].map(([tier, count]) => `${tier} ${count}`).join(", ") + ".");
const counts = new Map<string, number>();
for (const types of Object.values(MOB_V4_TYPES)) {
  counts.set(types.armourType, (counts.get(types.armourType) ?? 0) + 1);
}
out.push("Armour totals: " + [...counts].map(([armour, count]) => `${ARMOUR_TYPE_V4_LABELS[armour as keyof typeof ARMOUR_TYPE_V4_LABELS]} ${count}`).join(", ") + ".");
out.push("");
out.push("| Archetype | Attack (flavor) | v3 weapon | v4 damage type | Tier | v4 base | Armour (flavor) | v3 armour | v4 armour | Multiplier |");
out.push("|---|---|---|---|---|---|---|---|---|---|");
for (const [archetype, matchup] of Object.entries(MOB_MATCHUPS) as [MobArchetypeKey, (typeof MOB_MATCHUPS)[MobArchetypeKey]][]) {
  const profile = mobV4Profile(archetype);
  out.push(`| ${archetype} | ${matchup.weaponName} | ${MATCHUP_WEAPON_TYPE_LABELS[matchup.weaponType]} | ${DAMAGE_TYPE_V4_LABELS[profile.damageType]} | ${profile.tier} | ${profile.baseDamage} | ${matchup.armorName} | ${MATCHUP_ARMOR_TYPE_LABELS[matchup.armorType]} | ${ARMOUR_TYPE_V4_LABELS[profile.armourType]} | ${matchup.damageMultiplier} |`);
}
out.push("");

process.stdout.write(out.join("\n"));
