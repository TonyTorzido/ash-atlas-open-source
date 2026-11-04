import type { BossDefinition } from "./boss.js";
import type { MobArchetypeKey } from "./mobContracts.js";

/**
 * Reward policy used by the generic dungeon bosses. Dungeon boss defeats always settle through the
 * server's normal combat defeat settlement for the boss mob's archetype (the policy object is passed
 * to the settle callback, which ignores it for dungeon hosts), so this carries no extra rewards.
 * Add dungeon rewards with the encounter's reward table instead.
 */
export const DUNGEON_GENERIC_BOSS_REWARD_POLICY_ID = "dungeon_mob_standard";

const GENERIC_DUNGEON_BOSS_ARCHETYPES: readonly (readonly [MobArchetypeKey, string])[] = [
  ["slime_miniboss", "Slime Miniboss"],
  ["fire_bird", "Fire Bird"],
  ["ice_bird", "Ice Bird"],
  ["lightning_bird", "Lightning Bird"],
  ["ogre", "Ogre"],
  ["orc_brute", "Orc Brute"],
  ["bear", "Bear"],
  ["alligator", "Alligator"],
  ["skeleton", "Skeleton"]
];

/**
 * Canonical dungeon boss definitions shared by the server runtime (which registers them) and Studio
 * (which lists them). Published ids are permanent. Generic bosses use the "dungeon" controller (cone
 * cleave) and `dungeon_`-prefixed ids so they can never be claimed by overworld boss handlers
 * (legendary birds use `legendary_*` ids with host kind "overworld").
 */
export const DUNGEON_BOSS_DEFINITIONS: readonly BossDefinition[] = [
  {
    id: "xoral",
    revision: 1,
    archetypeKey: "xoral",
    appearanceId: "xoral",
    controllerId: "xoral",
    rewardPolicy: { id: "xoral_bespoke", minimumContribution: 1 },
    displayName: "Xoral"
  },
  {
    id: "sewer_rat_miniboss",
    revision: 1,
    archetypeKey: "sewer_rat_miniboss",
    appearanceId: "sewer_rat_miniboss",
    controllerId: "sewer_rat_miniboss",
    rewardPolicy: { id: "sewer_rat_miniboss", minimumContribution: 1, fixedGold: 150 },
    displayName: "Sewer Rat Miniboss"
  },
  {
    id: "brood_matriarch",
    revision: 1,
    archetypeKey: "brood_matriarch",
    appearanceId: "brood_matriarch",
    controllerId: "brood_matriarch",
    // Brood Silk and gold come from the mob definition via normal dungeon defeat settlement.
    rewardPolicy: { id: "brood_matriarch", minimumContribution: 1, fixedGold: 220 },
    displayName: "Brood Matriarch"
  },
  {
    id: "raptor_chieftain",
    revision: 1,
    archetypeKey: "raptor_chieftain",
    appearanceId: "raptor_chieftain",
    controllerId: "raptor_chieftain",
    // Raptor Scale and gold come from the mob definition via normal dungeon defeat settlement.
    rewardPolicy: { id: "raptor_chieftain", minimumContribution: 1, fixedGold: 180 },
    displayName: "Raptor Chieftain"
  },
  {
    id: "thunderwing",
    revision: 1,
    archetypeKey: "thunderwing",
    appearanceId: "thunderwing",
    controllerId: "thunderwing",
    // The Giant Egg and gold come from the mob definition via normal dungeon defeat settlement.
    rewardPolicy: { id: "thunderwing", minimumContribution: 1, fixedGold: 260 },
    displayName: "Thunderwing"
  },
  {
    id: "hollow_elder",
    revision: 1,
    archetypeKey: "hollow_elder",
    appearanceId: "hollow_elder",
    controllerId: "hollow_elder",
    // Elder Acorns and gold come from the mob definition via normal dungeon defeat settlement.
    rewardPolicy: { id: "hollow_elder", minimumContribution: 1, fixedGold: 340 },
    displayName: "Hollow Elder"
  },
  {
    id: "centurion",
    revision: 1,
    archetypeKey: "centurion",
    controllerId: "fallen_prison_centurion",
    // Edict Seals come from the Barracks chest (one claim per party member).
    rewardPolicy: { id: "centurion", minimumContribution: 1, fixedGold: 600 },
    displayName: "The Cohort Marshal"
  },
  {
    id: "brood_matron",
    revision: 1,
    archetypeKey: "brood_matron",
    controllerId: "fallen_prison_brood_matron",
    rewardPolicy: { id: "brood_matron", minimumContribution: 1, fixedGold: 900 },
    displayName: "The Brood Matron"
  },
  {
    id: "trifang_warden",
    revision: 1,
    archetypeKey: "trifang_warden",
    controllerId: "fallen_prison_trifang_warden",
    rewardPolicy: { id: "trifang_warden", minimumContribution: 1, fixedGold: 1500 },
    displayName: "Trifang Warden"
  },
  {
    id: "elder_dragon",
    revision: 1,
    archetypeKey: "elder_dragon",
    appearanceId: "elder_dragon",
    controllerId: "elder_dragon",
    // The guaranteed Wyrm Egg, Dragon Scales and gold come from the mob definition via normal dungeon defeat settlement.
    rewardPolicy: { id: "elder_dragon", minimumContribution: 1, fixedGold: 520 },
    displayName: "Elder Dragon"
  },
  // Drowned City (docs/design/DROWNED_CITY_SPEC.md). Orbs and most gold come from each boss's
  // hidden chest (one claim per party member).
  {
    id: "the_watcher",
    revision: 1,
    archetypeKey: "the_watcher",
    controllerId: "drowned_city_the_watcher",
    rewardPolicy: { id: "the_watcher", minimumContribution: 1, fixedGold: 900 },
    displayName: "The Watcher"
  },
  {
    id: "drowned_admiral",
    revision: 1,
    archetypeKey: "drowned_admiral",
    controllerId: "drowned_city_drowned_admiral",
    rewardPolicy: { id: "drowned_admiral", minimumContribution: 1, fixedGold: 900 },
    displayName: "The Drowned Admiral"
  },
  {
    id: "tidemaw",
    revision: 1,
    archetypeKey: "tidemaw",
    controllerId: "tidemaw",
    rewardPolicy: { id: "tidemaw", minimumContribution: 1, fixedGold: 900 },
    displayName: "Tidemaw"
  },
  {
    id: "abyssal_one",
    revision: 1,
    archetypeKey: "abyssal_one",
    controllerId: "abyssal_one",
    rewardPolicy: { id: "abyssal_one", minimumContribution: 1, fixedGold: 1500 },
    displayName: "The Abyssal One"
  },
  // Golem Forge (docs/design/GOLEM_FORGE_PLAN.md). Each boss has a bespoke controller (apps/server/src/game/golemForgeBosses.ts).
  {
    id: "granite_bull",
    revision: 1,
    archetypeKey: "granite_bull",
    controllerId: "granite_bull",
    rewardPolicy: { id: "granite_bull", minimumContribution: 1, fixedGold: 900 },
    displayName: "Granite Bull"
  },
  {
    id: "corrupted_core",
    revision: 1,
    archetypeKey: "corrupted_core",
    controllerId: "corrupted_core",
    rewardPolicy: { id: "corrupted_core", minimumContribution: 1, fixedGold: 900 },
    displayName: "The Corrupted Core"
  },
  {
    id: "forgemaster",
    revision: 1,
    archetypeKey: "forgemaster",
    controllerId: "forgemaster",
    rewardPolicy: { id: "forgemaster", minimumContribution: 1, fixedGold: 1500 },
    displayName: "The Forgemaster"
  },
  {
    id: "grandmaster",
    revision: 1,
    archetypeKey: "grandmaster",
    appearanceId: "grandmaster",
    controllerId: "grandmaster",
    // Zephyr (one per party member) and more gold come from the Grandmaster's Offering chest.
    rewardPolicy: { id: "grandmaster", minimumContribution: 1, fixedGold: 400 },
    displayName: "The Grandmaster"
  },
  ...GENERIC_DUNGEON_BOSS_ARCHETYPES.map(([archetypeKey, displayName]): BossDefinition => ({
    id: `dungeon_${archetypeKey}`,
    revision: 1,
    archetypeKey,
    controllerId: "dungeon",
    rewardPolicy: { id: DUNGEON_GENERIC_BOSS_REWARD_POLICY_ID, minimumContribution: 1 },
    displayName
  }))
];

export function dungeonBossDefinition(id: string): BossDefinition | undefined {
  return DUNGEON_BOSS_DEFINITIONS.find((definition) => definition.id === id);
}
