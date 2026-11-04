import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  MAX_EQUIPMENT_LEVEL,
  MATCHUP_WEAPON_TYPES,
  UNIVERSAL_FOOD_ITEM_IDS,
  type MatchupWeaponType,
  type UniversalFoodItemId
} from "../../packages/shared/src/index.js";
import {
  MOB_SCAFFOLD_ARMOR_TYPES,
  MOB_SCAFFOLD_BOOK_HABITATS,
  MOB_SCAFFOLD_RARITIES,
  MOB_SCAFFOLD_SURFACES,
  MobScaffoldError,
  applyMobScaffold,
  defaultArtPath,
  describeMobScaffoldPlan,
  planMobScaffold,
  type MobScaffoldBookHabitat,
  type MobScaffoldRarity,
  type MobScaffoldSpec,
  type MobScaffoldSurface
} from "./mobScaffold.js";

const USAGE = `Usage: pnpm mob:scaffold <key> [options] [--dry-run] [--yes]

Asks for anything not given as a flag (unless --yes). --dry-run prints the plan and writes nothing.

  --name "Frost Hare"          display name (default: from the key)
  --level 12                   definition level, 0-${MAX_EQUIPMENT_LEVEL} (world spawns use the zone level)
  --weapon claws:dagger        flavor name : universal weapon type
  --armor fur:martial_tunic    flavor name : universal armor type
  --hits 4                     target hit count (health = hits x the neutral hit, 9)
  --boss                       mark as a boss (only bosses/elites get multipliers)
  --multiplier 1.5             damage multiplier (default 1)
  --gold 5 --city-coins 1      currency rewards
  --item leather:4             guaranteed item reward (repeatable)
  --food field_ration          universal food drop
  --spawn land|lake|river|ocean|none
  --pack 3                     pack size (default 1 = single)
  --density 0.5                spawns per eligible km2
  --spawn-reason "..."         with --spawn none: which system spawns it
  --book common|uncommon|rare|epic|legendary|none
  --book-habitat forest|wetland|grassland|nearshore|ocean
  --hunt-names "First|Second|Third"
  --book-reason "..."          with --book none: why it is excluded
  --art frost-hare.png         PNG under apps/client/src/assets (wired only if present)

Weapon types: ${MATCHUP_WEAPON_TYPES.join(", ")}
Armor types:  ${MOB_SCAFFOLD_ARMOR_TYPES.join(", ")}`;

type Flags = Map<string, string[]>;
const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "boss", "help"]);

function parseArguments(args: readonly string[]): { key: string | null; flags: Flags } {
  const flags: Flags = new Map();
  let key: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      if (key !== null) throw new MobScaffoldError(`unexpected argument "${argument}"`);
      key = argument;
      continue;
    }
    const [rawName, inline] = argument.slice(2).split(/=(.*)/su) as [string, string | undefined];
    const value = BOOLEAN_FLAGS.has(rawName) ? "true" : inline ?? args[++index];
    if (value === undefined) throw new MobScaffoldError(`--${rawName} needs a value`);
    flags.set(rawName, [...(flags.get(rawName) ?? []), value]);
  }
  return { key, flags };
}

class Asker {
  private readonly rl;
  constructor(private readonly interactive: boolean) {
    this.rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  }
  async text(question: string, fallback: string | null): Promise<string> {
    if (!this.rl) {
      if (fallback === null) throw new MobScaffoldError(`missing required value: ${question}`);
      return fallback;
    }
    const answer = (await this.rl.question(`${question}${fallback !== null ? ` [${fallback}]` : ""}: `)).trim();
    if (answer) return answer;
    if (fallback !== null) return fallback;
    return this.text(question, fallback);
  }
  close(): void {
    this.rl?.close();
  }
}

async function buildSpec(key: string, flags: Flags, ask: Asker): Promise<MobScaffoldSpec> {
  const one = (name: string): string | null => flags.get(name)?.at(-1) ?? null;
  const value = async (name: string, question: string, fallback: string | null): Promise<string> =>
    one(name) ?? ask.text(question, fallback);
  const pair = async (name: string, question: string, fallback: string): Promise<[string, string]> => {
    const raw = await value(name, question, fallback);
    const [flavor, type] = raw.split(":").map((part) => part.trim());
    if (!flavor || !type) throw new MobScaffoldError(`--${name} must be "Flavor name:type", got "${raw}"`);
    return [flavor, type];
  };

  const name = await value("name", "Display name", key.split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "));
  const level = Number(await value("level", `Level (0-${MAX_EQUIPMENT_LEVEL}; world spawns use the zone level)`, "1"));
  const [weaponName, weaponType] = await pair("weapon", `Weapon "Flavor:type" (${MATCHUP_WEAPON_TYPES.join("/")})`, "Bite:dagger");
  const [armorName, armorType] = await pair("armor", `Armor "Flavor:type" (${MOB_SCAFFOLD_ARMOR_TYPES.join("/")})`, "Fur:martial_tunic");
  const boss = one("boss") === "true" || (await ask.text("Boss? (y/n)", "n")).toLowerCase().startsWith("y");
  const damageMultiplier = Number(await value("multiplier", "Damage multiplier (bosses/elites only)", "1"));
  const targetHits = Number(await value("hits", "Target hit count (health = hits x 9)", "3"));
  const gold = Number(await value("gold", "Gold reward", "0"));
  const cityCoins = Number(await value("city-coins", "City coin reward", "0"));
  const itemFlags = flags.get("item") ?? (await ask.text("Item rewards (item:qty, comma separated, blank for none)", "")).split(",").filter((part) => part.trim());
  const items = itemFlags.map((raw) => {
    const [itemId, quantity] = raw.split(":").map((part) => part.trim());
    return { itemId: itemId ?? "", quantity: Number(quantity ?? "1") };
  });
  const food = await value("food", `Universal food (${UNIVERSAL_FOOD_ITEM_IDS.join("/")})`, "field_ration") as UniversalFoodItemId;

  const spawnKind = await value("spawn", `World spawn surface (${MOB_SCAFFOLD_SURFACES.join("/")}/none)`, "land");
  const spawn: MobScaffoldSpec["spawn"] = spawnKind === "none"
    ? { kind: "none", reason: await value("spawn-reason", "Which system spawns it?", null) }
    : {
        kind: "population",
        surface: spawnKind as MobScaffoldSurface,
        packSize: Number(await value("pack", "Pack size (1 = single)", "1")),
        densityPerKm2: Number(await value("density", "Spawns per eligible km2", "0.5"))
      };

  const bookKind = await value("book", `Creature Book rarity (${MOB_SCAFFOLD_RARITIES.join("/")}/none)`, "common");
  const creatureBook: MobScaffoldSpec["creatureBook"] = bookKind === "none"
    ? { kind: "excluded", reason: await value("book-reason", "Why is it not in the Creature Book?", null) }
    : {
        kind: "entry",
        rarity: bookKind as MobScaffoldRarity,
        habitat: await value("book-habitat", `Book habitat (${MOB_SCAFFOLD_BOOK_HABITATS.join("/")})`, "forest") as MobScaffoldBookHabitat,
        huntNames: (await value("hunt-names", "Three hunt achievement names (A|B|C)", null))
          .split("|").map((part) => part.trim()) as unknown as readonly [string, string, string]
      };
  const art = await value("art", "Art PNG under apps/client/src/assets", defaultArtPath(key));

  return {
    key,
    name,
    level,
    weapon: { type: weaponType as MatchupWeaponType, name: weaponName },
    armor: { type: armorType as MobScaffoldSpec["armor"]["type"], name: armorName },
    boss,
    damageMultiplier,
    targetHits,
    rewards: { gold, cityCoins, items },
    food,
    spawn,
    creatureBook,
    art
  };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.flags.has("help") || !parsed.key) {
    console.error(USAGE);
    return parsed.key ? 0 : 2;
  }
  const dryRun = parsed.flags.has("dry-run");
  const ask = new Asker(!parsed.flags.has("yes") && Boolean(stdin.isTTY));
  const repositoryRoot = process.env.MOB_SCAFFOLD_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
  try {
    const spec = await buildSpec(parsed.key, parsed.flags, ask);
    const plan = planMobScaffold(spec, repositoryRoot);
    console.log(describeMobScaffoldPlan(plan, { dryRun }));
    if (!dryRun) {
      const written = applyMobScaffold(plan, repositoryRoot);
      console.log(`\nWrote ${written.length} files.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof MobScaffoldError) {
      console.error(`Cannot scaffold "${parsed.key}":\n${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    ask.close();
  }
}

process.exitCode = await main();
