import {
  EQUIPMENT_SWAG_CRAFT_RECIPES,
  MATCHUP_ARMOR_DISPLAY_ORDER,
  MATCHUP_IN_GAME_WEAPON_TYPES,
  MATCHUP_WEAPON_TYPES,
  MOB_ARCHETYPE_KEYS,
  MOB_HEALTH_UNIT,
  MOB_MATCHUPS,
  PVP_RAW_MATRIX_V3,
  type WikiContentNode
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { WIKI_ARTICLES } from "./articles.js";
import { builtInWikiContent } from "./builtInWiki.js";
import { GENERATED_WIKI_DATA as data } from "./generatedWikiData.js";

function walk(node: WikiContentNode, visit: (element: Exclude<WikiContentNode, string | number>) => void): void {
  if (typeof node === "string" || typeof node === "number") return;
  visit(node);
  for (const child of node.c ?? []) walk(child, visit);
}

describe("built-in wiki content", () => {
  it("keeps every article, category, order, and slug, and survives JSON transport unchanged", () => {
    const content = builtInWikiContent();
    expect(content.articles.map((article) => article.slug)).toEqual(WIKI_ARTICLES.map((article) => article.slug));
    expect(content.articles).toHaveLength(21);
    expect(new Set(content.articles.map((article) => article.slug)).size).toBe(21);
    expect(content.categories.map((category) => category.id)).toEqual(["getting-started", "character", "world", "activities", "kingdoms", "items"]);
    for (const article of content.articles) {
      expect(content.categories.some((category) => category.id === article.category), article.slug).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(content))).toEqual(content);
    // Provenance is code-only; players and scrapers never receive source paths.
    expect(JSON.stringify(content)).not.toContain("sourcePath");
    expect(JSON.stringify(content)).not.toContain("packages/shared/src");
  });

  it("links only to built-in slugs and expands authoring helpers into plain markup", () => {
    const content = builtInWikiContent();
    const slugs = new Set(content.articles.map((article) => article.slug));
    const tags = new Set<string>();
    let links = 0;
    for (const article of content.articles) {
      walk(article.content, (element) => {
        tags.add(element.t);
        if (element.t === "WikiLink") { links += 1; expect(slugs.has(String(element.p?.slug)), `${article.slug} -> ${String(element.p?.slug)}`).toBe(true); }
      });
    }
    expect(links).toBeGreaterThan(5);
    expect([...tags].filter((tag) => /^[A-Z]/.test(tag)).sort()).toEqual(["CreatureRoster", "MatchupExplorer", "WikiArt", "WikiLink"]);
    expect(tags.has("table")).toBe(true);
  });

  it("lists every swag weapon with its art, full recipe, and drop sources", () => {
    const article = builtInWikiContent().articles.find((candidate) => candidate.slug === "items/swag-weapons")!;
    const text = JSON.stringify(article.content);
    const art: string[] = [];
    walk(article.content, (element) => { if (element.t === "WikiArt") art.push(String(element.p?.id)); });
    expect(art.sort()).toEqual(EQUIPMENT_SWAG_CRAFT_RECIPES.map((recipe) => recipe.definitionId).sort());
    expect(text).toContain("10 Iron Bar, 50 Wood, 3 Rusted Legion Blade, 3 Ancient Coin");
    expect(text).toContain("Smithing Station");
  });

  it("renders data-driven articles from generated data on the server", () => {
    const text = JSON.stringify(builtInWikiContent());
    expect(text).toContain("Keep this page open while you play");
    expect(text).toContain(String(data.progress.levelCap));
    expect(text).toContain("7,194 XP");
    const creatures = builtInWikiContent().articles.find((article) => article.slug === "world/creatures")!;
    let roster: unknown;
    walk(creatures.content, (element) => { if (element.t === "CreatureRoster") roster = element.p?.creatures; });
    expect(roster).toHaveLength(data.creatures.length);
    expect(JSON.stringify(roster)).not.toContain("rewards");
    const matchups = builtInWikiContent().articles.find((article) => article.slug === "character/matchups")!;
    let explorer: unknown;
    walk(matchups.content, (element) => { if (element.t === "MatchupExplorer") explorer = element.p?.matchups; });
    expect(explorer).toEqual(data.matchups);
  });
});

describe("generated wiki data", () => {
  it("is generated from the live matchup rules, not legacy definition numbers", () => {
    for (const creature of data.creatures) {
      const matchup = MOB_MATCHUPS[creature.key];
      expect(creature).toMatchObject({
        weaponTypeId: matchup.weaponType,
        armorTypeId: matchup.armorType,
        damageMultiplier: matchup.damageMultiplier
      });
      expect(creature).not.toHaveProperty("attackPower");
      if (creature.key !== "xoral" && creature.key !== "jellyfish") {
        // Health is counted in neutral hits (9); armor only changes the swing count.
        expect(creature.maxHealth).toBe(creature.targetHits * MOB_HEALTH_UNIT);
      }
    }
    expect(data.creatures.find((creature) => creature.key === "xoral")).toMatchObject({ maxHealth: 5_000, fixedLevel: 25 });
  });

  it("is generated from the shared table, light-to-heavy armor order, and monster matchups", () => {
    expect(data.matchups.armors.map((armor) => armor.id)).toEqual([...MATCHUP_ARMOR_DISPLAY_ORDER]);
    expect(MATCHUP_ARMOR_DISPLAY_ORDER).toEqual(["unarmored", "martial_tunic", "leather", "chainmail", "breastplate", "shield", "wyrm_shield"]);
    expect(data.matchups.weapons.map((weapon) => weapon.id)).toEqual([...MATCHUP_WEAPON_TYPES]);
    for (const weapon of data.matchups.weapons) {
      expect(weapon.values).toEqual(MATCHUP_ARMOR_DISPLAY_ORDER.map((armor) => PVP_RAW_MATRIX_V3[weapon.id][armor]));
      expect(weapon.inGame).toBe(MATCHUP_IN_GAME_WEAPON_TYPES.includes(weapon.id));
    }
    expect(data.matchups.monsters.map((monster) => monster.key).sort())
      .toEqual(MOB_ARCHETYPE_KEYS.filter((key) => key !== "training_dummy").sort());
    for (const monster of data.matchups.monsters) {
      expect(monster).toMatchObject({
        weaponTypeId: MOB_MATCHUPS[monster.key].weaponType,
        armorTypeId: MOB_MATCHUPS[monster.key].armorType,
        damageMultiplier: MOB_MATCHUPS[monster.key].damageMultiplier
      });
    }
  });
});
