import { Sprite, Texture, TextureSource } from "pixi.js";
import { describe, expect, it } from "vitest";
import {
  isOverlaySpriteAssetPath,
  injectSizeTable
} from "../../overlaySpriteDerivativesPlugin.js";
import { applyLogicalTextureSize } from "./overlaySpriteDerivatives.js";
import {
  overlaySpriteAssetKey,
  overlaySpriteDerivativeUrl,
  overlaySpriteSource
} from "./overlaySpriteDerivativeNaming.js";
import { textureScaleForHeight } from "./spritePresentation.js";

const textureOf = (width: number, height: number): Texture =>
  new Texture({ source: new TextureSource({ width, height }) });

describe("overlay sprite derivative naming", () => {
  it("maps dev and production URLs to the same kind of key", () => {
    expect(overlaySpriteAssetKey("/src/assets/mobs/wolf.png")).toBe("mobs/wolf.png");
    expect(overlaySpriteAssetKey("/assets/wolf-AbC123.png?x=1")).toBe("wolf-AbC123.png");
    expect(overlaySpriteAssetKey("./assets/wolf-AbC123.png")).toBe("wolf-AbC123.png");
    expect(overlaySpriteAssetKey("/assets/dungeons/shared/orc-cave-entrance.png"))
      .toBe("dungeons/shared/orc-cave-entrance.png");
    expect(overlaySpriteAssetKey("blob:http://x/1")).toBeNull();
    expect(overlaySpriteAssetKey("data:image/png;base64,AA")).toBeNull();
    expect(overlaySpriteAssetKey("/assets/icon.svg")).toBeNull();
  });

  it("only offers a derivative for sources in the size table", () => {
    const table = { "wolf-AbC123.png": [1536, 1024] as const };
    expect(overlaySpriteSource(table, "/assets/wolf-AbC123.png")).toEqual({
      url: "/assets/wolf-AbC123.s1024.png",
      width: 1536,
      height: 1024
    });
    expect(overlaySpriteSource(table, "/assets/other-1.png")).toBeNull();
    expect(overlaySpriteDerivativeUrl("/a/b.png?v=2")).toBe("/a/b.s1024.png?v=2");
  });
});

describe("downscaled overlay textures", () => {
  it("present at the same world size as the source texture", () => {
    const source = textureOf(1536, 1024);
    const downscaled = textureOf(1024, 683);
    applyLogicalTextureSize(downscaled, 1536, 1024);

    expect(downscaled.width).toBe(source.width);
    expect(downscaled.height).toBe(source.height);
    expect(textureScaleForHeight(96, downscaled.height))
      .toBe(textureScaleForHeight(96, source.height));

    const fromSource = new Sprite(source);
    const fromDownscaled = new Sprite(downscaled);
    fromSource.scale.set(textureScaleForHeight(96, source.height));
    fromDownscaled.scale.set(textureScaleForHeight(96, downscaled.height));
    expect(fromDownscaled.width).toBeCloseTo(fromSource.width, 6);
    expect(fromDownscaled.height).toBeCloseTo(fromSource.height, 6);
    expect(fromDownscaled.getLocalBounds().width).toBeCloseTo(fromSource.getLocalBounds().width, 6);
    expect(fromDownscaled.getLocalBounds().height).toBeCloseTo(fromSource.getLocalBounds().height, 6);
  });

  it("keeps the UV frame on the real pixels", () => {
    const downscaled = textureOf(1024, 683);
    applyLogicalTextureSize(downscaled, 1536, 1024);
    expect(downscaled.frame.width).toBe(1024);
    expect(downscaled.frame.height).toBe(683);
    expect(downscaled.uvs.x1).toBeCloseTo(1, 6);
    expect(downscaled.uvs.y2).toBeCloseTo(1, 6);
  });
});

describe("overlay derivative build plugin helpers", () => {
  it("limits derivatives to overlay sprite folders", () => {
    expect(isOverlaySpriteAssetPath("tree.png")).toBe(true);
    expect(isOverlaySpriteAssetPath("structures/manor.png")).toBe(true);
    expect(isOverlaySpriteAssetPath("mobs/ashen/wolf.png")).toBe(true);
    expect(isOverlaySpriteAssetPath("items/enchantment-stones/ruby.png")).toBe(true);
    expect(isOverlaySpriteAssetPath("structures/greenhouse-overlays/a.png")).toBe(false);
    expect(isOverlaySpriteAssetPath("fishing/OceanBackground.png")).toBe(false);
    expect(isOverlaySpriteAssetPath("world-environment-overlays/x.png")).toBe(false);
    expect(isOverlaySpriteAssetPath("plants/wheat-full.png")).toBe(false);
  });

  it("injects the size table into a quoted marker", () => {
    const code = 'const t = parse("__ASH_ATLAS_OVERLAY_SPRITE_SIZES__");';
    const injected = injectSizeTable(code, { "a.png": [2, 3] });
    expect(injected).not.toContain("__ASH_ATLAS");
    expect(JSON.parse(injected.match(/parse\((.*)\);/)![1]!)).toBe('{"a.png":[2,3]}');
  });
});
