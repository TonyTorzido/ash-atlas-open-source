/**
 * Plans and writes the stub entries a new mob archetype needs in every file
 * that keys data by MobArchetypeKey. The plan is computed in memory first; if
 * any anchor is missing nothing is written. See docs/adding-a-monster.md.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  MAX_EQUIPMENT_LEVEL,
  MATCHUP_ARMOR_TYPES,
  MATCHUP_WEAPON_TYPES,
  MOB_ARCHETYPE_KEYS,
  RESOURCE_TYPES,
  UNIVERSAL_FOOD_ITEM_IDS,
  MOB_HEALTH_UNIT,
  equalLevelSwordSwings,
  type MobArmorType,
  type MatchupWeaponType,
  type UniversalFoodItemId
} from "../../packages/shared/src/index.js";

export const MOB_SCAFFOLD_SURFACES = ["land", "lake", "river", "ocean"] as const;
export type MobScaffoldSurface = (typeof MOB_SCAFFOLD_SURFACES)[number];
export const MOB_SCAFFOLD_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
/** Mob armor types: the universal table's body armor (shields are player-only). */
export const MOB_SCAFFOLD_ARMOR_TYPES: readonly MobArmorType[] = MATCHUP_ARMOR_TYPES.filter(
  (type): type is MobArmorType => type !== "shield" && type !== "wyrm_shield"
);
export type MobScaffoldRarity = (typeof MOB_SCAFFOLD_RARITIES)[number];
export const MOB_SCAFFOLD_BOOK_HABITATS = ["forest", "wetland", "grassland", "nearshore", "ocean"] as const;
export type MobScaffoldBookHabitat = (typeof MOB_SCAFFOLD_BOOK_HABITATS)[number];

/** Kill count that unlocks the habitat page, by rarity (matches the roster). */
export const BOOK_HABITAT_THRESHOLD: Readonly<Record<MobScaffoldRarity, number | null>> = {
  common: 100, uncommon: 50, rare: 25, epic: 10, legendary: null
};

export type MobScaffoldSpec = Readonly<{
  key: string;
  name: string;
  /** Definition level: fixed for dungeon/event/dev spawns; world spawns take the zone level. */
  level: number;
  weapon: Readonly<{ type: MatchupWeaponType; name: string }>;
  armor: Readonly<{ type: MobArmorType; name: string }>;
  boss: boolean;
  /** Damage multiplier on the universal table. 1 unless a boss or elite. */
  damageMultiplier: number;
  /** Target hit count; health = hits x the neutral hit (MOB_HEALTH_UNIT, 9). */
  targetHits: number;
  rewards: Readonly<{
    gold: number;
    cityCoins: number;
    items: readonly Readonly<{ itemId: string; quantity: number }>[];
  }>;
  food: UniversalFoodItemId;
  spawn:
    | Readonly<{
        kind: "population";
        surface: MobScaffoldSurface;
        /** 1 = single mob; 2+ = fixed-size pack. */
        packSize: number;
        densityPerKm2: number;
      }>
    | Readonly<{ kind: "none"; reason: string }>;
  creatureBook:
    | Readonly<{
        kind: "entry";
        rarity: MobScaffoldRarity;
        habitat: MobScaffoldBookHabitat;
        huntNames: readonly [string, string, string];
      }>
    | Readonly<{ kind: "excluded"; reason: string }>;
  /** PNG under apps/client/src/assets (e.g. "frost-hare.png"). Wired only if the file exists. */
  art: string;
}>;

export type MobScaffoldEdit = Readonly<{
  file: string;
  summary: string;
  before: string;
  after: string;
}>;

export type MobScaffoldPlan = Readonly<{
  spec: MobScaffoldSpec;
  edits: readonly MobScaffoldEdit[];
  warnings: readonly string[];
  checklist: readonly string[];
  derived: Readonly<{ maxHealth: number; swordSwings: number; artPending: boolean; camelKey: string }>;
}>;

export class MobScaffoldError extends Error {}

export const MOB_SCAFFOLD_FILES = {
  contracts: "packages/shared/src/mobContracts.ts",
  matchups: "packages/shared/src/mobMatchups.ts",
  food: "packages/shared/src/universalFood.ts",
  creatureBook: "packages/shared/src/creatureBook.ts",
  legend: "packages/shared/src/legendCatalog.ts",
  definitions: "apps/server/src/game/combat/mobDefinitions.ts",
  registry: "apps/server/src/game/populationV2MobRegistry.ts",
  artwork: "apps/client/src/map/mobArtwork.ts",
  presentation: "apps/client/src/map/mobSpritePresentation.ts",
  artworkSlots: "apps/appearance-studio/src/mobArtworkSlots.ts"
} as const;

const CLIENT_ASSETS = "apps/client/src/assets";

export function camelCaseKey(key: string): string {
  return key.replace(/_([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase());
}

export function defaultArtPath(key: string): string {
  return `${key.replaceAll("_", "-")}.png`;
}

export function validateMobScaffoldSpec(spec: MobScaffoldSpec): readonly string[] {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!/^[a-z][a-z0-9_]{1,40}$/u.test(spec.key)) {
    problems.push(`key "${spec.key}" must be snake_case (a-z, 0-9, _), starting with a letter`);
  }
  if ((MOB_ARCHETYPE_KEYS as readonly string[]).includes(spec.key)) {
    problems.push(`"${spec.key}" already exists in MOB_ARCHETYPE_KEYS; the scaffold only adds new mobs`);
  }
  if (spec.name.trim().length === 0) problems.push("name is required");
  if (!Number.isInteger(spec.level) || spec.level < 0 || spec.level > MAX_EQUIPMENT_LEVEL) {
    problems.push(`level must be an integer from 0 to ${MAX_EQUIPMENT_LEVEL} (the monster level cap)`);
  }
  if (!MATCHUP_WEAPON_TYPES.includes(spec.weapon.type)) {
    problems.push(`weapon type must be one of: ${MATCHUP_WEAPON_TYPES.join(", ")}`);
  }
  if (!MOB_SCAFFOLD_ARMOR_TYPES.includes(spec.armor.type)) {
    problems.push(`armor type must be one of: ${MOB_SCAFFOLD_ARMOR_TYPES.join(", ")}`);
  }
  if (!spec.weapon.name.trim() || !spec.armor.name.trim()) problems.push("weapon and armor flavor names are required");
  if (!Number.isFinite(spec.damageMultiplier) || spec.damageMultiplier < 0) {
    problems.push("damage multiplier must be a number >= 0");
  } else if (spec.damageMultiplier !== 1 && !spec.boss) {
    warnings.push(
      `damage multiplier ${spec.damageMultiplier} on a non-boss: multipliers are for bosses and elites; set difficulty with level and hit count instead`
    );
  }
  if (!Number.isInteger(spec.targetHits) || spec.targetHits < 1) problems.push("target hit count must be a positive integer");
  if (!Number.isInteger(spec.rewards.gold) || spec.rewards.gold < 0) problems.push("gold must be a whole number >= 0");
  if (!Number.isInteger(spec.rewards.cityCoins) || spec.rewards.cityCoins < 0) problems.push("city coins must be a whole number >= 0");
  for (const item of spec.rewards.items) {
    if (!(RESOURCE_TYPES as readonly string[]).includes(item.itemId)) problems.push(`unknown reward item "${item.itemId}"`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) problems.push(`reward ${item.itemId} quantity must be a positive integer`);
  }
  if (!UNIVERSAL_FOOD_ITEM_IDS.includes(spec.food)) {
    problems.push(`food must be one of: ${UNIVERSAL_FOOD_ITEM_IDS.join(", ")}`);
  }
  if (spec.spawn.kind === "population") {
    if (!MOB_SCAFFOLD_SURFACES.includes(spec.spawn.surface)) problems.push(`surface must be one of: ${MOB_SCAFFOLD_SURFACES.join(", ")}`);
    if (!Number.isInteger(spec.spawn.packSize) || spec.spawn.packSize < 1 || spec.spawn.packSize > 6) {
      problems.push("pack size must be 1 (single) to 6");
    }
    if (!Number.isFinite(spec.spawn.densityPerKm2) || spec.spawn.densityPerKm2 <= 0) problems.push("density must be > 0 per km2");
  } else if (!spec.spawn.reason.trim()) {
    problems.push("a mob that is not world-spawned needs a reason (which system spawns it)");
  }
  if (spec.creatureBook.kind === "entry") {
    if (!MOB_SCAFFOLD_RARITIES.includes(spec.creatureBook.rarity)) problems.push(`rarity must be one of: ${MOB_SCAFFOLD_RARITIES.join(", ")}`);
    if (!MOB_SCAFFOLD_BOOK_HABITATS.includes(spec.creatureBook.habitat)) {
      problems.push(`book habitat must be one of: ${MOB_SCAFFOLD_BOOK_HABITATS.join(", ")}`);
    }
    if (spec.creatureBook.huntNames.length !== 3 || spec.creatureBook.huntNames.some((name) => !name.trim())) {
      problems.push("a Creature Book entry needs three hunt achievement names");
    }
  } else if (!spec.creatureBook.reason.trim()) {
    problems.push("a mob left out of the Creature Book needs a reason");
  }
  if (!/^[a-zA-Z0-9_./-]+\.png$/u.test(spec.art) || spec.art.includes("..")) {
    problems.push(`art "${spec.art}" must be a .png path under ${CLIENT_ASSETS}`);
  }
  if (problems.length > 0) throw new MobScaffoldError(problems.map((problem) => `- ${problem}`).join("\n"));
  return warnings;
}

export function planMobScaffold(spec: MobScaffoldSpec, repositoryRoot: string): MobScaffoldPlan {
  const warnings = validateMobScaffoldSpec(spec);
  const files = new Map<string, string>();
  const read = (file: string): string => {
    const cached = files.get(file);
    if (cached !== undefined) return cached;
    const absolute = path.join(repositoryRoot, file);
    if (!existsSync(absolute)) throw new MobScaffoldError(`${file} is missing`);
    const source = readFileSync(absolute, "utf8");
    files.set(file, source);
    return source;
  };
  const edits: MobScaffoldEdit[] = [];
  const edit = (file: string, summary: string, change: (source: string) => string): void => {
    const before = read(file);
    let after: string;
    try {
      after = change(before);
    } catch (error) {
      throw new MobScaffoldError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Keep the file's own line endings (Windows checkouts use CRLF).
    if (before.includes("\r\n")) after = after.replace(/\r?\n/gu, "\r\n");
    files.set(file, after);
    edits.push({ file, summary, before, after });
  };

  const { key, name } = spec;
  const camelKey = camelCaseKey(key);
  const q = (value: string): string => JSON.stringify(value);
  const maxHealth = MOB_HEALTH_UNIT * spec.targetHits;
  const swordSwings = equalLevelSwordSwings(maxHealth, spec.armor.type);
  const artFile = path.posix.join(CLIENT_ASSETS, spec.art);
  const artPending = !existsSync(path.join(repositoryRoot, artFile));
  const pack = spec.spawn.kind === "population" && spec.spawn.packSize > 1;
  const F = MOB_SCAFFOLD_FILES;

  edit(F.contracts, "MOB_ARCHETYPE_KEYS", (s) => appendEntry(s, "MOB_ARCHETYPE_KEYS", q(key), key));

  const multiplier = spec.damageMultiplier === 1 ? "" : `, ${spec.damageMultiplier}`;
  edit(F.matchups, `MOB_MATCHUPS: ${spec.weapon.name} (${spec.weapon.type}) / ${spec.armor.name} (${spec.armor.type})`, (s) =>
    appendEntry(s, "MOB_MATCHUPS", `${key}: matchup(${q(spec.weapon.name)}, ${q(spec.weapon.type)}, ${q(spec.armor.name)}, ${q(spec.armor.type)}${multiplier})`, key));

  edit(F.food, `UNIVERSAL_FOOD_BY_MOB: ${spec.food}`, (s) =>
    appendEntry(s, "UNIVERSAL_FOOD_BY_MOB", `${key}: foodFor(${q(spec.food)})`, key));

  edit(F.definitions, "MOB_AI_PROFILES", (s) => appendEntry(s, "MOB_AI_PROFILES", pack
    ? `${key}: Object.freeze({\n  ...ATTACKED_SINGLE,\n  onAttacked: Object.freeze({ group: "exact_pack" })\n})`
    : `${key}: ATTACKED_SINGLE`, key));
  edit(F.definitions, `MOB_TARGET_BASIC_HIT_COUNTS: ${spec.targetHits}`, (s) =>
    appendEntry(s, "MOB_TARGET_BASIC_HIT_COUNTS", `${key}: ${spec.targetHits}`, key));
  const rewardItems = spec.rewards.items.length === 0
    ? "[]"
    : `[${spec.rewards.items.map((item) => `{ itemId: ${q(item.itemId)}, quantity: ${item.quantity} }`).join(", ")}]`;
  const habitat = spec.spawn.kind === "population" ? `\n  habitat: ${q(spec.spawn.surface)},` : "";
  edit(F.definitions, `MOB_DEFINITIONS: level ${spec.level}, ${maxHealth} HP, ${spec.boss ? "boss" : "not a boss"}`, (s) =>
    appendEntry(s, "MOB_DEFINITIONS", `${key}: {
  key: ${q(key)},
  name: ${q(name)},
  level: ${spec.level},
  // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
  maxHealth: ${maxHealth},
  attackPower: ${10 + spec.level},
  defense: 0,
  attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
  attackRangeM: BASIC_ATTACK_RANGE_M,
  movementSpeedMultiplier: 0.55,
  combatSeparationM: 0,
  retaliates: true,
  leashRadiusM: 160,
  legacyV2BaseXpPool: ${maxHealth},
  balanceVersion: 2,
  spriteKey: ${q(key)},${spec.boss ? "\n  boss: true," : ""}${habitat}
  rewards: {
    items: ${rewardItems},
    chanceItems: [universalFoodReward(${q(key)})],
    gold: ${spec.rewards.gold},
    cityCoins: ${spec.rewards.cityCoins}
  }
}`, key));

  if (spec.spawn.kind === "population") {
    const spawn = spec.spawn;
    const formation = `${key.toUpperCase()}_PACK_FORMATION`;
    if (pack) {
      edit(F.registry, `${formation} (${spawn.packSize} members)`, (s) =>
        insertBefore(s, "export const POPULATION_V2_MOB_DEFINITIONS = [", `const ${formation}: PopulationV2MobPackFormation = Object.freeze({
  allowedMemberCounts: Object.freeze([${spawn.packSize}]),
  minimumRadiusM: 30,
  maximumRadiusM: 45,
  targetMinimumPairwiseSeparationM: 25,
  memberCountForCandidate: () => ${spawn.packSize}
});

`));
    }
    edit(F.registry, `POPULATION_V2_MOB_DEFINITIONS: ${pack ? `pack of ${spawn.packSize}` : "single"} on ${spawn.surface}, ${spawn.densityPerKm2}/km2 (registered_overlay)`, (s) => {
      const priority = Math.max(0, ...[...s.matchAll(/plannerPriority: (\d+)/gu)].map((match) => Number(match[1]))) + 5;
      return appendEntry(s, "POPULATION_V2_MOB_DEFINITIONS", `{
  mobKind: ${q(key)},
  combatArchetype: ${q(key)},
  placementRevision: ${q(`overlay-v1-${key.replaceAll("_", "-")}-${pack ? "pack" : "single"}-v1`)},
  generationPlacement: "registered_overlay",
  spawnModel: ${q(pack ? "pack" : "single")},
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: ${q(spawn.surface)},
  plannerPriority: ${priority},
  density: {
    model: "common",
    densityPerEligibleKm2: ${spawn.densityPerKm2},
    candidateOversamplingFactor: 2
  },
${SURFACE_HABITAT[spawn.surface]}
  candidateBuilder: ${pack
    ? `createPackPopulationV2MobCandidateBuilder(${q(key)}, ${formation}),\n  packFormation: ${formation},`
    : `createSinglePopulationV2MobCandidateBuilder(${q(key)}),`}
  spacingClass: ${q(pack ? "small_hostile_pack" : spawn.surface === "land" ? "large_hostile" : "passive_single")},
  suppressionClass: ${q(pack ? "hostile-pack" : spawn.surface === "land" ? "hostile-ogre" : "none")},
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: ${q(pack ? `${name} pack` : name)}
}`, key, `mobKind: ${q(key)}`);
    });
  } else {
    const reason = spec.spawn.reason;
    edit(F.registry, `NON_POPULATION_V2_MOB_ARCHETYPES: ${reason}`, (s) =>
      appendEntry(s, "NON_POPULATION_V2_MOB_ARCHETYPES", `${key}: ${q(reason)}`, key));
  }

  if (spec.creatureBook.kind === "entry") {
    const book = spec.creatureBook;
    const threshold = BOOK_HABITAT_THRESHOLD[book.rarity];
    edit(F.creatureBook, `CREATURE_BOOK_ROSTER: ${book.rarity}`, (s) => {
      const order = Math.max(-1, ...[...s.matchAll(/bookOrder: (\d+)/gu)].map((match) => Number(match[1]))) + 1;
      return appendEntry(s, "CREATURE_BOOK_ROSTER",
        `{ bookOrder: ${order}, archetypeKey: ${q(key)}, name: ${q(name)}, rarity: ${q(book.rarity)}, habitatThreshold: ${threshold ?? "null"} }`,
        key, `archetypeKey: ${q(key)}`);
    });
    if (threshold !== null) {
      edit(F.creatureBook, `CREATURE_BOOK_HABITATS: ${book.habitat}`, (s) =>
        appendEntry(s, "CREATURE_BOOK_HABITATS", `${key}: [${book.habitat.toUpperCase()}_HABITAT]`, key));
    }
    edit(F.legend, "huntNames (Legend journal hunts)", (s) =>
      appendEntry(s, "huntNames", `${key}: [${book.huntNames.map(q).join(", ")}]`, key));
    edit(F.artworkSlots, "normalArtworkByArchetype (Asset Studio mob slot)", (s) =>
      appendEntry(s, "normalArtworkByArchetype", `${key}: [${q(artFile)}, ${q(camelKey)}]`, key));
  } else {
    const reason = spec.creatureBook.reason;
    edit(F.creatureBook, `CREATURE_BOOK_EXCLUDED_ARCHETYPES: ${reason}`, (s) =>
      appendEntry(s, "CREATURE_BOOK_EXCLUDED_ARCHETYPES", `${key}: ${q(reason)}`, key));
  }

  if (artPending) {
    edit(F.artwork, "MOB_ARCHETYPE_ARTWORK: null (art pending)", (s) =>
      appendEntry(s, "MOB_ARCHETYPE_ARTWORK", `${key}: null`, key));
  } else {
    edit(F.artwork, `import ${camelKey} from ${artFile}`, (s) =>
      insertAfterLastImport(s, `import ${camelKey} from ${q(`../assets/${spec.art}`)};`));
    edit(F.artwork, "MOB_ARTWORK_URLS", (s) => appendEntry(s, "MOB_ARTWORK_URLS", camelKey, camelKey));
    edit(F.artwork, `MOB_ARCHETYPE_ARTWORK: ${camelKey}`, (s) =>
      appendEntry(s, "MOB_ARCHETYPE_ARTWORK", `${key}: ${q(camelKey)}`, key));
    edit(F.presentation, "MOB_SPRITE_PRESENTATION: genericMob (tune in Asset Studio)", (s) =>
      appendEntry(s, "MOB_SPRITE_PRESENTATION", `${camelKey}: SPRITE_PRESENTATION.genericMob`, camelKey));
  }

  const checklist = [
    artPending
      ? `Art pending: add ${artFile} (1254px square, transparent, framed like wolf.png/ogre.png), then wire it in ${F.artwork} (import, MOB_ARTWORK_URLS, MOB_ARCHETYPE_ARTWORK) and ${F.presentation}. Until then the mob draws as a generic marker; list it in the art backlog.`
      : `Tune the sprite presentation (size/anchor/hit box) in Asset Studio; it starts on genericMob.`,
    "Register the PNG for the dev PNG lab and Asset Studio if you want it editable there: apps/client/src/developer/devPngCatalog.ts, apps/appearance-studio/src/runtimeAssetCatalog.ts.",
    spec.spawn.kind === "population"
      ? "Review the registry entry (spacingClass, suppressionClass, behaviorCategory, density) and add the focused Population V2 tests in docs/population-v2-adding-a-mob.md."
      : `Spawn it from its system (${spec.spawn.reason}).`,
    "Proactive aggression, custom movement or leash: edit its MOB_AI_PROFILES entry (it retaliates only when attacked).",
    "Update tests that pin the exact roster: apps/server/src/game/populationV2MobRegistry.test.ts (registry list) and apps/server/src/game/creatureBook.test.ts (roster length).",
    "Run the completeness tests: pnpm --filter @ash-atlas/server exec vitest run src/game/mobCompleteness.test.ts and pnpm --filter @ash-atlas/client exec vitest run src/map/mobArtCompleteness.test.ts, then typecheck shared/server/client/appearance-studio."
  ];
  return { spec, edits, warnings, checklist, derived: { maxHealth, swordSwings, artPending, camelKey } };
}

/** Human-readable plan: each edit with the lines it adds, then warnings and the manual checklist. */
export function describeMobScaffoldPlan(plan: MobScaffoldPlan, options: Readonly<{ dryRun: boolean }>): string {
  const { spec, derived } = plan;
  const lines = [
    `${options.dryRun ? "Dry run: would scaffold" : "Scaffolding"} ${spec.key} ("${spec.name}"): ${spec.weapon.type} vs ${spec.armor.type}, ${spec.targetHits} hits = ${derived.maxHealth} HP (${derived.swordSwings} equal-level sword swings through ${spec.armor.type})${spec.boss ? ", boss" : ""}`,
    ""
  ];
  for (const change of plan.edits) {
    lines.push(`${change.file}  +  ${change.summary}`);
    for (const added of addedText(change.before, change.after).split(/\r?\n/u)) lines.push(`    + ${added}`);
  }
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:", ...plan.warnings.map((warning) => `  ! ${warning}`));
  }
  lines.push("", "Still manual:", ...plan.checklist.map((item, index) => `  ${index + 1}. ${item}`));
  return lines.join("\n");
}

function addedText(before: string, after: string): string {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < before.length - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end += 1;
  return after.slice(start, after.length - end).replace(/^[,\r\n]+|[\r\n]+$/gu, "").trim();
}

export function applyMobScaffold(plan: MobScaffoldPlan, repositoryRoot: string): readonly string[] {
  const finalByFile = new Map<string, string>();
  for (const change of plan.edits) finalByFile.set(change.file, change.after);
  for (const [file, source] of finalByFile) writeFileSync(path.join(repositoryRoot, file), source, "utf8");
  return [...finalByFile.keys()];
}

const LAND_ANCHOR = `  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "land" || (
      site.surfaceType === undefined
      && !site.isSaltwater
      && !site.insideMajorLake
      && site.weights.eligibleLand > 0
    ),`;

const SURFACE_HABITAT: Readonly<Record<MobScaffoldSurface, string>> = {
  land: `  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2,
${LAND_ANCHOR}`,
  lake: `  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.lake ?? 0,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "lake" || site.insideMajorLake,`,
  river: `  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.river ?? 0,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "river" && site.surfaceAuthority != null,`,
  ocean: `  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.ocean ?? 0,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "ocean" || site.isSaltwater,`
};

/** Locates `name = ...{` or `name = ...[` and returns the open/close bracket offsets. */
export function findLiteral(source: string, name: string): Readonly<{ open: number; close: number }> {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\b`, "u").exec(source);
  if (!declaration) throw new Error(`could not find "${name}"`);
  const equals = source.indexOf("= ", declaration.index);
  if (equals < 0) throw new Error(`"${name}" has no initializer`);
  let open = -1;
  for (let index = equals; index < source.length; index += 1) {
    if (source[index] === "{" || source[index] === "[") { open = index; break; }
  }
  if (open < 0) throw new Error(`"${name}" has no object or array literal`);
  return { open, close: matchingBracket(source, open) };
}

function matchingBracket(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") { index = source.indexOf("\n", index); if (index < 0) break; continue; }
    if (char === "/" && next === "*") { index = source.indexOf("*/", index + 2) + 1; continue; }
    if (char === "\"" || char === "'" || char === "`") { index = skipString(source, index); continue; }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unbalanced brackets");
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === quote) return index;
  }
  throw new Error("unterminated string");
}

/** Last character offset inside (open, close) that is code, not whitespace or comment. */
function lastCodeOffset(source: string, open: number, close: number): number {
  let last = open;
  for (let index = open + 1; index < close; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") { index = source.indexOf("\n", index); continue; }
    if (char === "/" && next === "*") { index = source.indexOf("*/", index + 2) + 1; continue; }
    if (char === "\"" || char === "'" || char === "`") { index = skipString(source, index); last = index; continue; }
    if (!/\s/u.test(char)) last = index;
  }
  return last;
}

/**
 * Appends one entry to the object/array literal assigned to `name`, matching
 * the indentation of its existing entries. Refuses when the entry exists.
 */
export function appendEntry(source: string, name: string, entry: string, key: string, presence?: string): string {
  const { open, close } = findLiteral(source, name);
  const body = source.slice(open + 1, close);
  const exists = presence
    ? body.includes(presence)
    : new RegExp(`(?:^|[\\s,{\\[])"?${key}"?\\s*(?:[:,]|$)`, "mu").test(body);
  if (exists) throw new Error(`"${name}" already has an entry for ${key}`);
  const indent = /\n([ \t]+)\S/u.exec(body)?.[1] ?? "  ";
  const last = lastCodeOffset(source, open, close);
  const comma = last !== open && source[last] !== "," ? "," : "";
  const closingLineStart = source.lastIndexOf("\n", close) + 1;
  if (source.slice(closingLineStart, close).trim() !== "") {
    // Single-line literal: `[a, b]` -> `[a, b, entry]`.
    return `${source.slice(0, last + 1)}${comma ? ", " : " "}${entry}${source.slice(last + 1)}`;
  }
  // Keep a trailing same-line comment with the entry it describes.
  const lineEnd = source.indexOf("\n", last);
  const text = entry.split("\n").map((line) => (line ? indent + line : line)).join("\n");
  return `${source.slice(0, last + 1)}${comma}${source.slice(last + 1, lineEnd)}\n${text}${source.slice(lineEnd)}`;
}

function insertBefore(source: string, anchor: string, text: string): string {
  const index = source.indexOf(anchor);
  if (index < 0) throw new Error(`could not find "${anchor}"`);
  return source.slice(0, index) + text + source.slice(index);
}

function insertAfterLastImport(source: string, line: string): string {
  const matches = [...source.matchAll(/^import [^\n]+ from "\.\.\/assets\/[^"]+\.png";$/gmu)];
  const last = matches.at(-1);
  if (!last) throw new Error("could not find the PNG imports");
  const end = last.index + last[0].length;
  return `${source.slice(0, end)}\n${line}${source.slice(end)}`;
}
