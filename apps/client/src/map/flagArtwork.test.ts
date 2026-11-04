import { describe, expect, it } from "vitest";
import { Texture } from "pixi.js";
import type { Sprite } from "pixi.js";
import {
  TERRITORY_STRUCTURE_CATALOG, TERRITORY_STRUCTURE_TYPES,
  territoryStructureInteractionBounds, territoryStructurePieceBounds, territoryStructureVisual
} from "@ash-atlas/shared";
import { BUOY_ARTWORK_URLS, TERRITORY_ARTWORK_URLS } from "./flagArtwork.js";
import { createTerritoryStructureRoot } from "./territoryStructureRenderer.js";
import { flagHealthBarOffsetBelowAnchor, flagInteractionHitBox } from "./pixiOverlay.js";
import { SPRITE_BASE_ZOOM, SPRITE_PRESENTATION, spriteLayoutForZoom } from "./spritePresentation.js";
import type { FlagSnapshot } from "@ash-atlas/shared";

describe("authored territory structures", () => {
  it("does not move the health bar for a hidden decorative component", () => {
    const flag = { anchorKind: "flag", upgradeTier: "base" } as const;
    const baseline = flagHealthBarOffsetBelowAnchor(flag);
    const visual = territoryStructureVisual("soft_flag");
    visual.pieces.push({ ...visual.pieces[0]!, id: "hidden-decoration", role: "decoration", visible: false, offsetY: 500 });
    try {
      expect(flagHealthBarOffsetBelowAnchor(flag)).toBe(baseline);
    } finally {
      visual.pieces.pop();
    }
  });

  it("retains buoy artwork and bundles every separate Stock PNG", () => {
    expect(BUOY_ARTWORK_URLS.canvas).toEqual({ width: 40, height: 41 });
    for (const type of TERRITORY_STRUCTURE_TYPES) {
      for (const piece of territoryStructureVisual(type).pieces) {
        expect(TERRITORY_ARTWORK_URLS[piece.asset]).toMatch(/\.png/);
      }
    }
  });

  it("scales and moves every PNG and state overlay beneath one ground-root transform", () => {
    const visual = structuredClone(territoryStructureVisual("soft_flag"));
    visual.root = { scale: 0.4, offsetX: 5, offsetY: -3 };
    const root = createTerritoryStructureRoot(visual, () => Texture.WHITE, { controlColor: 0xff0000, burning: true, emblem: "K" });
    expect(root.scale.x).toBe(0.4);
    expect(root.position.x).toBe(5);
    expect(root.position.y).toBe(-3);
    expect(root.children.map((child) => child.label)).toEqual(["hardware", "cloth", "burning", "emblem"]);
    for (const child of root.children) expect(child.parent).toBe(root);
    expect(root.children[0]!.position).toMatchObject({ x: 0, y: 0 });
    expect(root.children[1]!.position).toMatchObject({ x: 0, y: 0 });
    root.destroy({ children: true });
  });

  it.each([
    ["soft_flag", "base"], ["bastion_flag", "stone"], ["tower", "tower"], ["atlas_shrine", "atlas_shrine"]
  ] as const)("selects upper, middle and ground portions of %s through the game hitbox at all zooms", (type, upgradeTier) => {
    for (const zoom of [12, SPRITE_BASE_ZOOM, 18]) {
      const flag = { anchorKind: "flag", upgradeTier } as FlagSnapshot;
      const hit = flagInteractionHitBox(flag, { x: 240, y: 360 }, zoom);
      expect(hit.shape).toBe("rectangle");
      if (hit.shape !== "rectangle") throw new Error("Land flags require authored full rectangles");
      const layout = spriteLayoutForZoom(240, 360, 25, zoom, SPRITE_PRESENTATION.flag);
      for (const piece of territoryStructurePieceBounds(territoryStructureVisual(type))) {
        const x = 240 + (piece.left + piece.width / 2) * layout.scaleX;
        for (const localY of [piece.top + piece.height * 0.25, piece.top + piece.height / 2, 0]) {
          const y = 360 + localY * layout.scaleY;
          expect(x).toBeGreaterThanOrEqual(hit.left);
          expect(x).toBeLessThanOrEqual(hit.right);
          expect(y).toBeGreaterThanOrEqual(hit.top);
          expect(y).toBeLessThanOrEqual(hit.bottom);
        }
      }
    }
  });

  it("keeps a comfortable type-owned target after cosmetic scale and offsets change", () => {
    const changed = structuredClone(TERRITORY_STRUCTURE_CATALOG);
    changed.packs.stock!.structures.soft_flag!.root = { scale: 0.1, offsetX: 20, offsetY: -10 };
    changed.packs.alternate = structuredClone(changed.packs.stock!);
    changed.packs.alternate.structures.soft_flag!.root.scale = 2;
    expect(territoryStructureInteractionBounds("soft_flag", changed))
      .toEqual(territoryStructureInteractionBounds("soft_flag"));
    expect(territoryStructureVisual("soft_flag", "alternate", changed).root.scale).toBe(2);
  });

  it("faithfully renders component visibility, independent scale, color modes, order and attachment scale", () => {
    const visual = structuredClone(territoryStructureVisual("soft_flag"));
    visual.pieces[0]!.visible = false;
    const cloth = visual.pieces[1]!;
    cloth.scale = 1.5; cloth.tint = "fixed"; cloth.tintColor = "#9933cc"; cloth.zIndex = 6;
    visual.attachments.burning.scale = 0.75;
    visual.attachments.emblem.zIndex = -1;
    const root = createTerritoryStructureRoot(visual, () => Texture.WHITE, { controlColor: 0xff0000, burning: true, emblem: "R" });
    const png = root.children.find((child) => child.label === "cloth") as Sprite;
    expect(root.children.find((child) => child.label === "hardware")!.visible).toBe(false);
    expect(png.width).toBeCloseTo(cloth.width * cloth.scale);
    expect(png.height).toBeCloseTo(cloth.height * cloth.scale);
    expect(png.tint).toBe(0x9933cc);
    expect(root.children.find((child) => child.label === "burning")!.scale.x).toBe(0.75);
    root.sortChildren();
    expect(root.children.map((child) => child.label)).toEqual(["emblem", "hardware", "burning", "cloth"]);
    const bounds = territoryStructurePieceBounds(visual).find((piece) => piece.id === "cloth")!;
    expect(bounds.width).toBeCloseTo(cloth.width * cloth.scale * visual.root.scale);
    root.destroy({ children: true });
  });
});
