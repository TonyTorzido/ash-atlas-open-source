import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Graphics } from "pixi.js";
import { describe, expect, it } from "vitest";

import { DEV_PNG_ASSETS } from "../developer/devPngCatalog.js";
import { MOB_ARTWORK_URLS, mobArtworkKey } from "./mobArtwork.js";
import { createMobSprite } from "./pixiOverlay.js";
import {
  MOB_VISUAL_DESCRIPTORS,
  mobVisualDescriptor
} from "./mobSpriteSources.js";

const overlaySource = readFileSync(new URL("./pixiOverlay.ts", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");
const themeSource = readFileSync(new URL("../ashAtlasTheme.css", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");

describe("legacy generic mob presentation cleanup", () => {
  it("removes generic Goblin and Bandit descriptors and fallback drawing branches", () => {
    // A bare Goblin archetype now resolves to the Goblin Basic art, not a vector goblin.
    expect(mobVisualDescriptor("goblin")).toMatchObject({ kind: "image", artworkKey: "goblinBasic" });
    expect(Object.hasOwn(MOB_VISUAL_DESCRIPTORS, "goblin")).toBe(true);
    // Bandit now has real world art instead of a generic fallback.
    expect(mobVisualDescriptor("bandit")).toMatchObject({ kind: "image", artworkKey: "bandit" });

    const createMobSpriteSource = sourceBetween(
      overlaySource,
      "export function createMobSprite(",
      "export function shouldRecreateRetainedMobArtwork"
    );
    expect(createMobSpriteSource).not.toContain('silhouette === "goblin"');
    expect(createMobSpriteSource).not.toContain('silhouette === "bandit"');
    expect(createMobSpriteSource).not.toContain("const goblin = new Graphics()");
    expect(createMobSpriteSource).toContain("const unknown = new Graphics()");

    // An archetype with no artwork key still draws the single unknown marker.
    const artwork = createMobSprite(
      "goblin",
      null,
      0x84cc16,
      {} as Parameters<typeof createMobSprite>[3]
    );
    expect(artwork.children).toHaveLength(1);
    expect(artwork.children[0]).toBeInstanceOf(Graphics);
  });

  it("removes CSS selectors left behind by the deleted mob spawner panel", () => {
    expect(stylesSource).not.toContain(".mob-spawner-");
    expect(themeSource).not.toContain(".mob-spawner-");
  });

  it("preserves keyed Goblin artwork for City, Dungeon, and Village paths", () => {
    expect(mobArtworkKey("goblin", "goblin")).toBe("goblinBasic");
    expect(mobArtworkKey("goblin", "goblin_warrior")).toBe("goblinWarrior");
    expect(mobArtworkKey("goblin", "goblin_archer")).toBe("goblinArcher");
    expect(mobArtworkKey("goblin", "goblin_healer")).toBe("goblinHealer");
    expect(MOB_ARTWORK_URLS.goblinBasic).toMatch(/\/assets\/goblins\/goblin-basic\.png$/);
    expect(MOB_ARTWORK_URLS.goblinWarrior).toMatch(/\/assets\/goblins\/goblin-warrior\.png$/);
    expect(MOB_ARTWORK_URLS.goblinArcher).toMatch(/\/assets\/goblins\/goblin-archer\.png$/);
    expect(MOB_ARTWORK_URLS.goblinHealer).toMatch(/\/assets\/goblins\/goblin-healer\.png$/);

    expect(DEV_PNG_ASSETS.filter(({ sourcePath }) => sourcePath.includes("/goblins/"))
      .sort(({ sourcePath: left }, { sourcePath: right }) => left.localeCompare(right))
      .map(({ sourcePath, productionSource }) => [sourcePath, productionSource]))
      .toEqual([
        ["apps/client/src/assets/goblins/goblin-archer.png", "SPRITE_PRESENTATION.goblinArcher"],
        ["apps/client/src/assets/goblins/goblin-basic.png", "SPRITE_PRESENTATION.goblinBasic"],
        ["apps/client/src/assets/goblins/goblin-hall.png", "SPRITE_PRESENTATION.goblinHall"],
        ["apps/client/src/assets/goblins/goblin-healer.png", "SPRITE_PRESENTATION.goblinHealer"],
        [
          "apps/client/src/assets/goblins/goblin-market.png",
          "WORLD_PNG_PRESENTATION.cityStructures.goblin_market"
        ],
        ["apps/client/src/assets/goblins/goblin-warrior.png", "SPRITE_PRESENTATION.goblinWarrior"]
      ]);

    for (const filename of [
      "goblin-basic.png", "goblin-warrior.png", "goblin-archer.png", "goblin-healer.png",
      "goblin-hall.png", "goblin-market.png"
    ]) {
      expect(existsSync(fileURLToPath(new URL(`../assets/goblins/${filename}`, import.meta.url))), filename)
        .toBe(true);
    }
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
