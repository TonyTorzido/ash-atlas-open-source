import {
  BASE_PLAYER_MAX_HEALTH,
  CLASS_DEFINITIONS,
  CREATURE_BOOK_ROSTER,
  CURRENT_LEVEL_CAP,
  EQUIPMENT_BALANCE_VERSION,
  EQUIPMENT_CRAFT_RECIPES,
  EQUIPMENT_DEFINITIONS,
  FURNACE_MAX_BATCH_SIZE,
  FURNACE_MAX_MANOR_DISTANCE_M,
  FURNACE_MIN_BATCH_SIZE,
  FURNACE_QUEUE_CAPACITY,
  FURNACE_RECIPES,
  FURNACE_INTERACTION_RADIUS_M,
  KINGDOM_LEVELS,
  KINGDOM_LEVEL_DEFINITION_VERSION,
  KINGDOM_ROLE_PERMISSIONS,
  KINGDOM_ROLES,
  LAUNCH_CLASS_IDS,
  INVENTORY_CATALOG,
  MAX_EQUIPMENT_LEVEL,
  CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE,
  CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE,
  EQUIPMENT_GAMEPLAY_FAMILIES,
  MATCHUP_ARMOR_DISPLAY_ORDER,
  MATCHUP_ARMOR_TYPE_LABELS,
  MATCHUP_IN_GAME_WEAPON_TYPES,
  MATCHUP_WEAPON_TYPE_LABELS,
  MATCHUP_WEAPON_TYPES,
  MOB_ARCHETYPE_KEYS,
  MOB_MATCHUPS,
  PVP_RAW_MATRIX_V3,
  PROGRESSION_CURVE_VERSION,
  TOTAL_XP_FOR_LEVEL,
  WORLD_TIME_CYCLE_MS
} from "../../packages/shared/src/index.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MOB_DEFINITIONS, COMBAT_XP_POLICY_VERSION, resolveMobCombatProfile } from "../../apps/server/src/game/combat/mobDefinitions.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const generatedPath = path.join(repositoryRoot, "apps/server/src/wiki/generatedWikiData.ts");
const json = (value: unknown) => JSON.stringify(value, null, 2);

const classes = LAUNCH_CLASS_IDS.map((id) => {
  const definition = CLASS_DEFINITIONS[id];
  return { id, name: definition.name, resource: definition.resourceDisplayName, innate: definition.innate?.name ?? "—" };
}).sort((left, right) => left.name.localeCompare(right.name));

const items = Object.values(INVENTORY_CATALOG)
  .map((item) => {
    const equipment = item.kind === "equipment" ? EQUIPMENT_DEFINITIONS[item.itemId as keyof typeof EQUIPMENT_DEFINITIONS] : null;
    return {
      id: item.itemId,
      name: item.displayName,
      kind: item.kind,
      category: item.category,
      rarity: item.rarity,
      stackable: item.stackable,
      maxStack: item.maxStack,
      marketTradable: item.marketTradable,
      equipmentRole: item.equipmentRole,
      slot: equipment?.slot ?? null
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const equipmentRecipes = EQUIPMENT_CRAFT_RECIPES.map((recipe) => ({
  familyId: recipe.familyId,
  name: recipe.displayName,
  materials: recipe.materials.map(({ itemId, quantity }) => ({ itemId, quantity }))
})).sort((left, right) => left.name.localeCompare(right.name));

const furnaceRecipes = Object.values(FURNACE_RECIPES).map((recipe) => ({
  id: recipe.recipeId,
  name: recipe.displayName,
  output: recipe.outputDisplayName,
  durationMinutes: recipe.durationMs / 60_000,
  completionMode: recipe.completionMode,
  inputs: recipe.inputs.map(({ itemId, displayName, quantity }) => ({ itemId, name: displayName, quantity }))
}));

// Creature combat values come from the live rules (resolveMobCombatProfile and the
// universal matchup table), never from legacy per-definition numbers.
const creatures = CREATURE_BOOK_ROSTER.map((book) => {
  const mob = MOB_DEFINITIONS[book.archetypeKey];
  const matchup = MOB_MATCHUPS[book.archetypeKey];
  const fixedLevel = mob.boss ? mob.level : null;
  const profile = resolveMobCombatProfile(book.archetypeKey, fixedLevel ?? 10);
  for (let level = 0; level <= MAX_EQUIPMENT_LEVEL; level += 1) {
    if (resolveMobCombatProfile(book.archetypeKey, level).maxHealth !== profile.maxHealth) {
      throw new Error(`${book.archetypeKey} health varies with level; the wiki roster assumes it does not`);
    }
  }
  return {
    key: book.archetypeKey,
    name: book.name,
    bookRarity: book.rarity,
    habitatThreshold: book.habitatThreshold,
    habitat: mob.habitat ?? "any",
    fixedLevel,
    maxHealth: profile.maxHealth,
    targetHits: profile.targetBasicHitCount,
    weaponName: matchup.weaponName,
    weaponTypeId: matchup.weaponType,
    weaponType: MATCHUP_WEAPON_TYPE_LABELS[matchup.weaponType],
    armorName: matchup.armorName,
    armorTypeId: matchup.armorType,
    armorType: MATCHUP_ARMOR_TYPE_LABELS[matchup.armorType],
    damageMultiplier: matchup.damageMultiplier,
    boss: mob.boss ?? false,
    rewards: [
      ...mob.rewards.items.map(({ itemId, quantity }) => `${itemId} × ${quantity}`),
      ...mob.rewards.chanceItems.map(({ itemId, quantity, probability }) => `${itemId} × ${quantity} (${probability * 100}% chance)`),
      ...(mob.rewards.gold ? [`${mob.rewards.gold} gold`] : [])
    ]
  };
});

// One universal weapon x armor table shared by PvP and PvE (equal-level raw hits).
const stockItemFor = (families: Readonly<Record<string, string>>, type: string): string | null => {
  for (const [familyId, mapped] of Object.entries(families)) {
    if (mapped !== type) continue;
    const family = EQUIPMENT_GAMEPLAY_FAMILIES[familyId as keyof typeof EQUIPMENT_GAMEPLAY_FAMILIES];
    if (family?.stockDefinitionId) return family.stockDefinitionId;
  }
  return null;
};
const matchups = {
  armors: MATCHUP_ARMOR_DISPLAY_ORDER.map((id) => ({
    id,
    name: MATCHUP_ARMOR_TYPE_LABELS[id],
    shield: id === "shield" || id === "wyrm_shield",
    artItemId: stockItemFor(CURRENT_EQUIPMENT_FAMILY_TO_V3_DEFENSE_PROFILE, id)
  })),
  weapons: MATCHUP_WEAPON_TYPES.map((id) => ({
    id,
    name: MATCHUP_WEAPON_TYPE_LABELS[id],
    inGame: MATCHUP_IN_GAME_WEAPON_TYPES.includes(id),
    artItemId: stockItemFor(CURRENT_EQUIPMENT_FAMILY_TO_V3_WEAPON_PROFILE, id),
    values: MATCHUP_ARMOR_DISPLAY_ORDER.map((armor) => PVP_RAW_MATRIX_V3[id][armor])
  })),
  monsters: MOB_ARCHETYPE_KEYS
    .filter((key) => key !== "training_dummy")
    .map((key) => {
      const matchup = MOB_MATCHUPS[key];
      return {
        key,
        name: MOB_DEFINITIONS[key].name,
        boss: MOB_DEFINITIONS[key].boss === true || matchup.damageMultiplier > 1,
        weaponName: matchup.weaponName,
        weaponTypeId: matchup.weaponType,
        weaponType: MATCHUP_WEAPON_TYPE_LABELS[matchup.weaponType],
        armorName: matchup.armorName,
        armorTypeId: matchup.armorType,
        armorType: MATCHUP_ARMOR_TYPE_LABELS[matchup.armorType],
        damageMultiplier: matchup.damageMultiplier
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name))
};

const payload = {
  sourceRevision: {
    progression: PROGRESSION_CURVE_VERSION,
    equipment: EQUIPMENT_BALANCE_VERSION,
    worldTimeCycleMs: WORLD_TIME_CYCLE_MS,
    kingdomLevels: KINGDOM_LEVEL_DEFINITION_VERSION,
    combat: COMBAT_XP_POLICY_VERSION
  },
  progress: {
    levelCap: CURRENT_LEVEL_CAP,
    baseMaxHealth: BASE_PLAYER_MAX_HEALTH,
    // The curve is defined past the cap for future raises; show only reachable levels.
    xpByLevel: Object.fromEntries(
      Object.entries(TOTAL_XP_FOR_LEVEL).filter(([level]) => Number(level) <= CURRENT_LEVEL_CAP)
    )
  },
  classes,
  items,
  equipmentRecipes,
  furnace: {
    maxManorDistanceM: FURNACE_MAX_MANOR_DISTANCE_M,
    interactionRadiusM: FURNACE_INTERACTION_RADIUS_M,
    queueCapacity: FURNACE_QUEUE_CAPACITY,
    batch: { min: FURNACE_MIN_BATCH_SIZE, max: FURNACE_MAX_BATCH_SIZE },
    recipes: furnaceRecipes
  },
  creatures,
  dayNight: [
    { phase: "day", start: "6:00 AM", end: "6:00 PM", mechanical: "DAY" },
    { phase: "dusk", start: "6:00 PM", end: "9:00 PM", mechanical: "DAY" },
    { phase: "night", start: "9:00 PM", end: "3:00 AM", mechanical: "NIGHT" },
    { phase: "dawn", start: "3:00 AM", end: "6:00 AM", mechanical: "NIGHT" }
  ],
  kingdom: {
    roles: KINGDOM_ROLES.map((role) => ({ role, permissions: [...KINGDOM_ROLE_PERMISSIONS[role]].sort() })),
    levels: KINGDOM_LEVELS.map(({ level, requiredLifetimeXp: requiredXp, memberCapacity: members, cotCapacity: cots, decorationCapacity: decorations }) => ({ level, requiredXp, members, cots, decorations }))
  },
  matchups
};

const source = `/* AUTO-GENERATED FILE. Do not edit by hand; run 'pnpm wiki:sync'. */\n\nexport const GENERATED_WIKI_DATA = ${json(payload)} as const;\n`;
await writeFile(generatedPath, source, "utf8");
console.log(`Wiki data synced to ${path.relative(repositoryRoot, generatedPath)} (${items.length} items, ${creatures.length} creatures).`);
