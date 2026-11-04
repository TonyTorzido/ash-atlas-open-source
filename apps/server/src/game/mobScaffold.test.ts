import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_EQUIPMENT_LEVEL } from "@ash-atlas/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  MOB_SCAFFOLD_FILES,
  MobScaffoldError,
  applyMobScaffold,
  describeMobScaffoldPlan,
  planMobScaffold,
  type MobScaffoldSpec
} from "../../../../tools/mob-scaffold/mobScaffold.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const FROST_HARE: MobScaffoldSpec = {
  key: "frost_hare",
  name: "Frost Hare",
  level: 6,
  weapon: { type: "dagger", name: "Teeth" },
  armor: { type: "martial_tunic", name: "Fur" },
  boss: false,
  damageMultiplier: 1,
  targetHits: 2,
  rewards: { gold: 3, cityCoins: 0, items: [{ itemId: "leather", quantity: 2 }] },
  food: "field_ration",
  spawn: { kind: "population", surface: "land", packSize: 2, densityPerKm2: 0.4 },
  creatureBook: {
    kind: "entry",
    rarity: "common",
    habitat: "forest",
    huntNames: ["Hare Today", "Gone Tomorrow", "Hare Apparent"]
  },
  art: "frost-hare.png"
};

const temporaryRoots: string[] = [];

function temporaryCopy(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ash-atlas-mob-scaffold-"));
  temporaryRoots.push(root);
  for (const file of Object.values(MOB_SCAFFOLD_FILES)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), readFileSync(path.join(repositoryRoot, file)));
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mob scaffold", () => {
  it("dry-runs against the real repository without writing", () => {
    const before = Object.values(MOB_SCAFFOLD_FILES).map((file) => readFileSync(path.join(repositoryRoot, file), "utf8"));
    const plan = planMobScaffold(FROST_HARE, repositoryRoot);
    expect(Object.values(MOB_SCAFFOLD_FILES).map((file) => readFileSync(path.join(repositoryRoot, file), "utf8")))
      .toEqual(before);
    expect(new Set(plan.edits.map(({ file }) => file))).toEqual(new Set([
      MOB_SCAFFOLD_FILES.contracts,
      MOB_SCAFFOLD_FILES.matchups,
      MOB_SCAFFOLD_FILES.food,
      MOB_SCAFFOLD_FILES.definitions,
      MOB_SCAFFOLD_FILES.registry,
      MOB_SCAFFOLD_FILES.creatureBook,
      MOB_SCAFFOLD_FILES.legend,
      MOB_SCAFFOLD_FILES.artworkSlots,
      MOB_SCAFFOLD_FILES.artwork
    ]));
    // 2 neutral hits (9) = 18 health; a sword needs 3 swings through a martial tunic (8).
    expect(plan.derived).toMatchObject({ maxHealth: 18, swordSwings: 3, artPending: true, camelKey: "frostHare" });
    const description = describeMobScaffoldPlan(plan, { dryRun: true });
    expect(description).toContain("Dry run: would scaffold frost_hare");
    expect(description).toContain('frost_hare: matchup("Teeth", "dagger", "Fur", "martial_tunic")');
    expect(description).toContain("Art pending: add apps/client/src/assets/frost-hare.png");
  });

  it("writes every stub into a copy of the files and refuses to run twice", () => {
    const root = temporaryCopy();
    const written = applyMobScaffold(planMobScaffold(FROST_HARE, root), root);
    expect(written).toHaveLength(9);
    const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
    expect(read(MOB_SCAFFOLD_FILES.contracts)).toMatch(/",\r?\n {2}"frost_hare"\r?\n\] as const;/u);
    expect(read(MOB_SCAFFOLD_FILES.definitions)).toContain("frost_hare: 2");
    expect(read(MOB_SCAFFOLD_FILES.definitions)).toContain('chanceItems: [universalFoodReward("frost_hare")]');
    expect(read(MOB_SCAFFOLD_FILES.registry)).toContain('createPackPopulationV2MobCandidateBuilder("frost_hare", FROST_HARE_PACK_FORMATION)');
    expect(read(MOB_SCAFFOLD_FILES.creatureBook)).toContain('archetypeKey: "frost_hare", name: "Frost Hare", rarity: "common", habitatThreshold: 100');
    expect(read(MOB_SCAFFOLD_FILES.creatureBook)).toContain("frost_hare: [FOREST_HABITAT]");
    expect(read(MOB_SCAFFOLD_FILES.legend)).toContain('frost_hare: ["Hare Today", "Gone Tomorrow", "Hare Apparent"]');
    expect(read(MOB_SCAFFOLD_FILES.artwork)).toContain("frost_hare: null");

    expect(() => planMobScaffold(FROST_HARE, root)).toThrow(/already has an entry for frost_hare/u);
  });

  it("wires present art and explicit exclusions for a non-world, non-book mob", () => {
    const root = temporaryCopy();
    mkdirSync(path.join(root, "apps/client/src/assets/mobs"), { recursive: true });
    writeFileSync(path.join(root, "apps/client/src/assets/mobs/cellar-imp.png"), "");
    const plan = planMobScaffold({
      ...FROST_HARE,
      key: "cellar_imp",
      name: "Cellar Imp",
      boss: true,
      damageMultiplier: 1.5,
      spawn: { kind: "none", reason: "Dungeon roster" },
      creatureBook: { kind: "excluded", reason: "Dungeon actor" },
      art: "mobs/cellar-imp.png"
    }, root);
    expect(plan.warnings).toEqual([]);
    applyMobScaffold(plan, root);
    const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
    expect(read(MOB_SCAFFOLD_FILES.registry)).toContain('cellar_imp: "Dungeon roster"');
    expect(read(MOB_SCAFFOLD_FILES.creatureBook)).toContain('cellar_imp: "Dungeon actor"');
    expect(read(MOB_SCAFFOLD_FILES.matchups)).toContain('cellar_imp: matchup("Teeth", "dagger", "Fur", "martial_tunic", 1.5)');
    expect(read(MOB_SCAFFOLD_FILES.artwork)).toContain('import cellarImp from "../assets/mobs/cellar-imp.png";');
    expect(read(MOB_SCAFFOLD_FILES.artwork)).toContain('cellar_imp: "cellarImp"');
    expect(read(MOB_SCAFFOLD_FILES.presentation)).toContain("cellarImp: SPRITE_PRESENTATION.genericMob");
  });

  it("refuses existing keys and invalid specs, and warns on non-boss multipliers", () => {
    expect(() => planMobScaffold({ ...FROST_HARE, key: "wolf" }, repositoryRoot))
      .toThrow(/already exists in MOB_ARCHETYPE_KEYS/u);
    expect(() => planMobScaffold({ ...FROST_HARE, key: "Bad-Key", targetHits: 0 }, repositoryRoot))
      .toThrow(MobScaffoldError);
    expect(() => planMobScaffold({ ...FROST_HARE, level: MAX_EQUIPMENT_LEVEL + 1 }, repositoryRoot))
      .toThrow(`level must be an integer from 0 to ${MAX_EQUIPMENT_LEVEL}`);
    expect(planMobScaffold({ ...FROST_HARE, damageMultiplier: 1.5 }, repositoryRoot).warnings)
      .toEqual([expect.stringContaining("multipliers are for bosses and elites")]);
  });
});
