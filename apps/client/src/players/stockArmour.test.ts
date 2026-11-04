import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import type * as PixiModule from "pixi.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", async (importOriginal) => {
  const pixi = await importOriginal<typeof PixiModule>();
  // Sheet pages without a GPU or network: big empty sources every frame rectangle fits in.
  const load = vi.fn(async () => new pixi.Texture({ source: new pixi.TextureSource({ width: 8192, height: 8192 }) }));
  return { ...pixi, Assets: { ...pixi.Assets, load, unload: vi.fn(async () => undefined) } };
});
vi.mock("./playerSheetUpload.js", () => ({ queuePlayerSheetUpload: vi.fn(async () => undefined) }));

const { Assets } = await import("pixi.js");
const { JacketSheetRig } = await import("./jacketRig.js");
const { JacketGatherLayer } = await import("./jacketGather.js");
const { stockArmourForAppearance, stockClipState, STOCK_ARMOURS } = await import("./stockArmour.js");
const { RELEASE_AFTER_MS } = await import("./jacketSheets.js");
const bodySheets = (await import("../assets/player-rig/stock-body/stock-body-sheets.json")).default as unknown as {
  clips: Record<string, { frames: unknown[]; flip: boolean }>;
};
const layerSheets = {
  cloth: (await import("../assets/player-rig/stock-armour/cloth/cloth-layers.json")).default,
  leather: (await import("../assets/player-rig/stock-armour/leather/leather-layers.json")).default,
  chainmail: (await import("../assets/player-rig/stock-armour/chainmail/chainmail-layers.json")).default,
  breastplate: (await import("../assets/player-rig/stock-armour/breastplate/breastplate-layers.json")).default
} as unknown as Record<string, { clips: Record<string, { frames: unknown[]; flip: boolean }> }>;

type Frame = Parameters<InstanceType<typeof JacketSheetRig>["update"]>[0];
const frame = (nowMs: number, extra: Partial<Frame> = {}): Frame => ({
  lat: 35, lon: -106, walking: false, nowMs, bearingDeg: 0, targetHeight: 60, inputX: null, ...extra
});
const chest = (equipmentDefinitionId: string, appearanceId: string | null, cosmeticAppearanceId: string | null = null) => ({
  slots: { chest: { equipmentDefinitionId, appearanceId, cosmeticAppearanceId } }
}) as unknown as PlayerAppearanceSnapshot;
/** Any Jacket B sheet page (none may load any more: the tank top is the default look). */
const jacketBPage = (u: string) => u.includes("jacketb");
const loadedUrls = () => vi.mocked(Assets.load).mock.calls.map(([arg]) => String((arg as unknown as { src: string }).src));

describe("stock armour look", () => {
  it.each([
    ["padded_tunic", "non-swag-cloth", "cloth"],
    ["leather_armor", "non-swag-leather", "leather"],
    ["chain_armor", "non-swag-chainmail", "chainmail"],
    ["breast_plate", "non-swag-breastplate", "breastplate"]
  ] as const)("%s (%s) shows the %s layer", (item, look, armour) => {
    expect(stockArmourForAppearance(chest(item, look))).toBe(armour);
    // an item without an appearance falls back to its definition id
    expect(stockArmourForAppearance(chest(item, null))).toBe(armour);
  });

  it("no chest armour, another chest look, or a cosmetic over a stock item shows the bare tank top (null)", () => {
    expect(stockArmourForAppearance(undefined)).toBeNull();
    expect(stockArmourForAppearance({ slots: {} } as unknown as PlayerAppearanceSnapshot)).toBeNull();
    expect(stockArmourForAppearance(chest("padded_tunic", "non-swag-cloth", "some-swag-coat"))).toBeNull();
    expect(stockArmourForAppearance(chest("other_coat", "other-coat"))).toBeNull();
    // a stock look chosen as the cosmetic shows that armour
    expect(stockArmourForAppearance(chest("other_coat", "other-coat", "non-swag-leather"))).toBe("leather");
  });

  it("every armour layer clip matches the body clip frame for frame", () => {
    for (const item of STOCK_ARMOURS) {
      expect(Object.keys(layerSheets[item]!.clips).sort()).toEqual(Object.keys(bodySheets.clips).sort());
      for (const [id, body] of Object.entries(bodySheets.clips)) {
        const layer = layerSheets[item]!.clips[id]!;
        expect([id, layer.frames.length, layer.flip]).toEqual([id, body.frames.length, body.flip]);
      }
    }
  });
});

describe("stock armour on the rig", () => {
  it("draws the stock body + the armour layer (the bare body without armour) and never loads a Jacket B sheet", async () => {
    vi.mocked(Assets.load).mockClear();
    const rig = new JacketSheetRig();
    rig.update(frame(0, { armour: "leather" }));
    expect(rig.ready).toBe(false);
    await vi.waitFor(() => {
      rig.update(frame(16, { armour: "leather" }));
      expect(rig.ready).toBe(true);
    }, { timeout: 10_000 });
    expect(rig.debugState).toMatchObject({ view: "idle", armour: "leather", layer: true });
    const urls = loadedUrls();
    expect(urls.some((u) => u.includes("stock-body/idle-"))).toBe(true);
    expect(urls.some((u) => u.includes("stock-armour/leather/walkL-"))).toBe(true);
    expect(urls.some((u) => u.includes("jacketb"))).toBe(false);
    expect(urls.some((u) => /chop|mine|cloth|chainmail|breastplate/u.test(u))).toBe(false);
    rig.update(frame(32, { armour: "leather", walking: true, inputX: 1 }));
    expect(rig.debugState).toMatchObject({ view: "walkR", layer: true });
    // No stock armour: the bare stock body (tank top + black pants), no layer, and still no Jacket B sheet
    rig.update(frame(64, { armour: null }));
    expect(rig.debugState).toMatchObject({ armour: null, layer: false, view: "standR" });
    expect(loadedUrls().some((u) => u.includes("jacketb"))).toBe(false);
  });

  it("gathering in a stock armour draws the stock body's gather clip with the armour's gather layer", async () => {
    const layer = new JacketGatherLayer();
    const { Sprite } = await import("pixi.js");
    const body = new Sprite(), garment = new Sprite();
    const input = { action: { kind: "chop" as const, tool: "axe", side: "right" as const, startedAtMs: 0 }, tool: null, flagArt: null, flagRemainingMs: null };
    expect(layer.apply(input, 100, body, 0.1, 119, "chainmail", garment)).toBe(false);
    expect(stockClipState("chainmail", "chopR")).toEqual({ body: "loading", layer: "loading" });
    await vi.waitFor(() => expect(layer.apply(input, 100, body, 0.1, 119, "chainmail", garment)).toBe(true), { timeout: 10_000 });
    expect(garment.visible).toBe(true);
    // same root anchor point and flip (R is image-flipped) for the body and the layer
    expect(Math.sign(body.scale.x)).toBe(-1);
    expect(garment.scale.x).toBe(body.scale.x);
    expect(garment.position.y).toBe(body.position.y);
    const views = { body: bodySheets.clips.chopR as unknown as { rootX: number; frameWidth: number }, layer: layerSheets.chainmail!.clips.chopR as unknown as { rootX: number; frameWidth: number } };
    expect(body.anchor.x).toBeCloseTo(views.body.rootX / views.body.frameWidth);
    expect(garment.anchor.x).toBeCloseTo(views.layer.rootX / views.layer.frameWidth);
    // the lazy sets release after RELEASE_AFTER_MS unused (jacketSheets.test.ts)
    expect(RELEASE_AFTER_MS).toBe(45_000);
  });

  it.each(["generic", "ronin"] as const)("a %s sword swing and ready stand in a stock armour draw that style's set for the look", async (style) => {
    const { Texture, TextureSource } = await import("pixi.js");
    const { jacketSwordPoseSheetState, swordPoseSetFor, swordSwingMs } = await import("./jacketSword.js");
    const { swingTimeline } = await import("./swordStyles.js");
    const weapon = new Texture({ source: new TextureSource({ width: 1024, height: 1024 }) });
    const armour = "breastplate" as const;
    const set = swordPoseSetFor(armour, style);
    // the armour's own set of the style once it ships, else the style's tank top (never another style, never Jacket B)
    expect([`${style}-breastplate`, `${style}-tank`]).toContain(set);
    vi.mocked(Assets.load).mockClear();
    const rig = new JacketSheetRig();
    const swing = { comboIndex: 1 as const, style, startedAtMs: 100, side: "left" as const, weapon };
    const contact = swingTimeline(style, 1).contactFrame;
    await vi.waitFor(() => {
      rig.update(frame(100 + (contact * 1000) / 30 + 5, { armour, heldSword: weapon, sword: swing, swordStyle: style }));
      expect(rig.debugState.sword).toBe(`swing2L:hit:22-swing2-hit:f${contact}@${set}`);
    }, { timeout: 10_000 });
    expect(rig.debugState).toMatchObject({ armour, layer: false });
    expect(jacketSwordPoseSheetState(armour, style)).toBe("ready");
    const urls = loadedUrls();
    expect(urls.some((u) => u.includes(`sword-poses/${set}/keyposes-`))).toBe(true);
    expect(urls.some((u) => u.includes("jacketb") || u.includes("stock-armour-sword"))).toBe(false);
    // after the swing: the ready stand in the same set
    rig.update(frame(100 + swordSwingMs(style, 1) + 50, { armour, heldSword: weapon, sword: swing, swordStyle: style }));
    expect(rig.debugState.sword).toBe(`readyL@${set}`);
    // no stock armour: the style's tank-top poses
    expect(swordPoseSetFor(null, style)).toBe(`${style}-tank`);
  });

  it.each([["ronin", "chainmail"], ["ronin", null], ["generic", "chainmail"], ["generic", null]] as const)("the %s sword-out walk in %s is the style's drawn guard walk, not the stock arm-out walk", async (style, armour) => {
    const { Texture, TextureSource } = await import("pixi.js");
    const weapon = new Texture({ source: new TextureSource({ width: 1024, height: 1024 }) });
    vi.mocked(Assets.load).mockClear();
    const rig = new JacketSheetRig();
    const swing = { comboIndex: 0 as const, style, startedAtMs: 100, side: "left" as const, weapon };
    const look = armour ?? "tank";
    // after the rising cut's follow-through, a move: the held cut pose gives way to the guard walk at once
    await vi.waitFor(() => {
      rig.update(frame(700, { armour, heldSword: weapon, sword: swing, swordStyle: style, walking: true, inputX: -1 }));
      expect(rig.debugState.sword).toMatch(new RegExp(`^guardwalkL:g[0-7]@${style}-${look}$`));
    }, { timeout: 10_000 });
    expect(rig.debugState).toMatchObject({ armour, layer: false, swordOut: true });
    // the guard walk cycles through its 8 drawn frames over the stock walk's 28
    const seen = new Set<string>();
    for (let t = 716; t < 716 + 1000; t += 16) {
      rig.update(frame(t, { armour, heldSword: weapon, sword: swing, swordStyle: style, walking: true, inputX: -1 }));
      seen.add(String(rig.debugState.sword));
    }
    expect(seen.size).toBe(8);
    // stopped: the ready guard (pose 00)
    rig.update(frame(1732, { armour, heldSword: weapon, sword: swing, swordStyle: style }));
    expect(rig.debugState.sword).toBe(`readyL@${style}-${look}`);
    // a short move inside the reset window, then a stop: the guard, not the held cut again
    const rig2 = new JacketSheetRig();
    for (let t = 700; t <= 800; t += 16) rig2.update(frame(t, { armour, heldSword: weapon, sword: swing, swordStyle: style, walking: true, inputX: -1 }));
    expect(rig2.debugState.sword).toMatch(/^guardwalkL:/);
    rig2.update(frame(900, { armour, heldSword: weapon, sword: swing, swordStyle: style }));
    expect(rig2.debugState.sword).toBe(`readyL@${style}-${look}`);
    // a guard-walk style never loads the one-handed stock sword walk
    expect(loadedUrls().some((u) => u.includes("sword_walk"))).toBe(false);
  });

  it.each([["axe-generic", "chainmail"], ["axe-generic", null], ["axe-warrior", "breastplate"], ["axe-warrior", null]] as const)("the %s axe-out walk in %s is the drawn guard walk (the tank-top set for any armour), never the anchor walk", async (style, armour) => {
    const { Texture, TextureSource } = await import("pixi.js");
    const weapon = new Texture({ source: new TextureSource({ width: 1024, height: 1024 }) });
    vi.mocked(Assets.load).mockClear();
    const rig = new JacketSheetRig();
    const swing = { comboIndex: 0 as const, style, startedAtMs: 100, side: "left" as const, weapon };
    await vi.waitFor(() => {
      rig.update(frame(1000, { armour, heldSword: weapon, sword: swing, swordStyle: style, walking: true, inputX: -1 }));
      expect(rig.debugState.sword).toMatch(new RegExp(`^guardwalkL:g[0-7]@${style}-tank$`));
    }, { timeout: 10_000 });
    // all 8 drawn frames cycle over the stock walk's 28
    const seen = new Set<string>();
    for (let t = 1016; t < 1016 + 1000; t += 16) {
      rig.update(frame(t, { armour, heldSword: weapon, sword: swing, swordStyle: style, walking: true, inputX: -1 }));
      seen.add(String(rig.debugState.sword));
    }
    expect(seen.size).toBe(8);
    expect([...seen].every((d) => !d.includes(":axe") && !d.startsWith("walk"))).toBe(true);
    rig.update(frame(2100, { armour, heldSword: weapon, sword: swing, swordStyle: style }));
    expect(rig.debugState.sword).toBe(`readyL@${style}-tank`);
    expect(loadedUrls().some((u) => u.includes("sword_walk"))).toBe(false);
  });

  it("gathering with no stock armour draws the stock body's gather clip, no layer, no Jacket B sheet", async () => {
    const layer = new JacketGatherLayer();
    const { Sprite } = await import("pixi.js");
    const body = new Sprite(), garment = new Sprite();
    vi.mocked(Assets.load).mockClear();
    const input = { action: { kind: "mine" as const, tool: "pick", side: "left" as const, startedAtMs: 0 }, tool: null, flagArt: null, flagRemainingMs: null };
    await vi.waitFor(() => expect(layer.apply(input, 100, body, 0.1, 119, null, garment)).toBe(true), { timeout: 10_000 });
    expect(garment.visible).toBe(false);
    expect(stockClipState(null, "mineL")).toEqual({ body: "ready", layer: "none" });
    expect(loadedUrls().some(jacketBPage)).toBe(false);
  });
});
