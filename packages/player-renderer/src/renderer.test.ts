import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  PLAYER_RENDER_LAYERS,
  playerBodyPose,
  type PlayerAppearanceCatalog,
  type PlayerAppearanceSnapshot,
  type EquipmentAppearanceEnhancement
} from "@ash-atlas/shared";
import { Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import {
  PlayerRenderer,
  applyAppearanceTransform
} from "./renderer.js";

describe("shared Pixi player renderer", () => {
  it("owns the canonical named layers and applies exact anchors, pivots, flips, and rotation", async () => {
    const catalog = testCatalog();
    catalog.bodyVariants[0]!.overallScale = 1.5;
    catalog.bodyVariants[0]!.mainAnchor = { x: 3, y: 29 };
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });

    await renderer.updateAppearance(snapshot(1, "sword_test"));
    const sprite = renderer.equipmentSprite("melee")!;
    const leftHand = playerBodyPose(catalog, "default", "idle").anchors.left_hand;
    expect(Object.keys(renderer.layers)).toEqual(PLAYER_RENDER_LAYERS);
    expect(renderer.overallScale).toBe(1.5);
    expect(renderer.visualRoot.scale.x).toBe(1.5);
    expect(renderer.visualRoot.scale.y).toBe(1.5);
    expect(renderer.root.position).toMatchObject({ x: 0, y: 0 });
    expect(renderer.visualRoot.pivot).toMatchObject({ x: 3, y: 29 });
    expect(sprite.parent).toBe(renderer.layers.front_hand);
    expect(sprite.position.x).toBe(leftHand.x + 5);
    expect(sprite.position.y).toBe(leftHand.y - 3);
    expect(sprite.anchor.x).toBe(0.2);
    expect(sprite.anchor.y).toBe(0.8);
    expect(sprite.scale.x).toBe(-1.25);
    expect(sprite.scale.y).toBe(0.75);
    expect(sprite.rotation).toBeCloseTo(Math.PI / 2);
    catalog.bodyVariants[0]!.mainAnchor = { x: -2, y: 31 };
    renderer.setCatalog(catalog);
    expect(renderer.visualRoot.pivot).toMatchObject({ x: -2, y: 31 });
    expect(renderer.root.position).toMatchObject({ x: 0, y: 0 });
    catalog.bodyVariants[0]!.mainAnchor = { x: 7, y: 33 };
    await renderer.updateAppearance(snapshot(2, "sword_test"));
    expect(renderer.visualRoot.pivot).toMatchObject({ x: 7, y: 33 });
    expect(renderer.root.position).toMatchObject({ x: 0, y: 0 });
    expect(sprite.position.x).toBe(leftHand.x + 5);
    expect(sprite.position.y).toBe(leftHand.y - 3);
    renderer.destroy();
  });

  it("composites visible character categories in the requested front-to-back order", () => {
    expect(PLAYER_RENDER_LAYERS.filter((layer) => [
      "boots",
      "feet",
      "legs",
      "chest_armor",
      "gloves",
      "hands",
      "eyes",
      "mask",
      "hair"
    ].includes(layer))).toEqual([
      "boots",
      "feet",
      "legs",
      "chest_armor",
      "gloves",
      "hands",
      "eyes",
      "mask",
      "hair"
    ]);
  });

  it("renders the gemstone above enhanced equipment and hues only Venomsteel weapons", async () => {
    const catalog = testCatalog();
    const load = vi.fn(async () => Texture.EMPTY);
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load }
    });

    await renderer.updateAppearance(snapshot(1, "sword_test", {
      gemstone: "diamond",
      coreId: "venomsteel"
    }));

    const equipment = renderer.equipmentSprite("melee")!;
    const gem = renderer.equipmentGemSprite("melee")!;
    expect(equipment.tint).toBe(0x58b86f);
    expect(gem.tint).toBe(0xffffff);
    expect(gem.parent).toBe(equipment.parent);
    expect(gem.position.x).toBe(equipment.position.x);
    expect(gem.position.y).toBe(equipment.position.y);
    expect(gem.scale.x).toBe(3);
    expect(load).toHaveBeenCalledWith("enhancements/gems/diamond.png");

    expect(await renderer.updateAppearance(snapshot(1, "sword_test", {
      gemstone: "diamond",
      coreId: "venomsteel"
    }), { showGemstones: false })).toBe(true);
    expect(renderer.equipmentSprite("melee")!.tint).toBe(0x58b86f);
    expect(renderer.equipmentGemSprite("melee")).toBeNull();

    expect(await renderer.updateAppearance(snapshot(1, "sword_test", {
      gemstone: "diamond",
      coreId: "venomsteel"
    }), { showGemstones: true })).toBe(true);
    expect(renderer.equipmentGemSprite("melee")).not.toBeNull();
    renderer.destroy();
  });

  it("updates transforms and layers without rebuilding an unchanged asset identity", async () => {
    const catalog = testCatalog();
    const load = vi.fn(async () => Texture.EMPTY);
    const renderer = new PlayerRenderer({
      local: false,
      color: 0xfb7185,
      catalog,
      textureLoader: { load }
    });
    await renderer.updateAppearance(snapshot(1, "sword_test"));
    const original = renderer.equipmentSprite("melee")!;
    catalog.appearances[0]!.placements = {
      ...catalog.appearances[0]!.placements,
      idle: {
        ...catalog.appearances[0]!.placements?.idle,
        offsetX: -4,
        layer: "back_weapon"
      }
    };
    renderer.setCatalog(catalog);

    await renderer.updateAppearance(snapshot(2, "sword_test"));
    expect(renderer.equipmentSprite("melee")).toBe(original);
    expect(original.position.x).toBe(
      playerBodyPose(catalog, "default", "idle").anchors.left_hand.x - 4
    );
    expect(original.parent).toBe(renderer.layers.back_weapon);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await renderer.updateAppearance(snapshot(2, "sword_test"))).toBe(false);
    expect(renderer.appearanceBuildCount).toBe(2);
    renderer.destroy();
  });

  it("keeps a usable degraded appearance when replacement textures fail", async () => {
    const diagnostic = vi.fn();
    const renderer = new PlayerRenderer({
      local: false,
      color: 0xfb7185,
      catalog: testCatalog(),
      textureLoader: { load: vi.fn(async () => {
        throw new Error("missing");
      }) },
      diagnostic
    });
    await renderer.updateAppearance(snapshot(1, "sword_test"));
    await renderer.updateAppearance(snapshot(2, "sword_test"));
    expect(renderer.equipmentSprite("melee")).toBeNull();
    expect(renderer.appearanceComplete).toBe(true);
    expect(diagnostic).toHaveBeenCalledTimes(1);

    const working = new PlayerRenderer({
      local: false,
      color: 0xfb7185,
      catalog: testCatalog(),
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });
    await working.updateAppearance(snapshot(1, "sword_test"));
    await working.updateAppearance({ ...snapshot(2, "sword_test"), slots: {} });
    expect(working.equipmentSprite("melee")).toBeNull();
    renderer.destroy();
    working.destroy();
  });

  it("retries a failed texture load after the backoff instead of keeping the mannequin for good", async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const load = vi.fn(async () => {
        if (fail) throw new Error("transient");
        return Texture.EMPTY;
      });
      const renderer = new PlayerRenderer({ local: false, color: 0xfb7185, catalog: testCatalog(), textureLoader: { load } });
      await renderer.updateAppearance(snapshot(1, "sword_test"));
      expect(renderer.equipmentSprite("melee")).toBeNull();
      const callsAfterFailure = load.mock.calls.length;
      await renderer.updateAppearance(snapshot(1, "sword_test"));
      expect(load.mock.calls.length, "no retry storm inside the backoff").toBe(callsAfterFailure);
      fail = false;
      vi.advanceTimersByTime(2_500);
      await renderer.updateAppearance(snapshot(1, "sword_test"));
      expect(renderer.equipmentSprite("melee"), "the art loads once the backoff passed").not.toBeNull();
      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits the player template and equipment only after every texture is ready", async () => {
    const catalog = testCatalog();
    const body = catalog.bodyVariants[0]!;
    body.bodyAssetKeys = { idle: "body.png" };
    const resolvers = new Map<string, (texture: Texture) => void>();
    const load = vi.fn((assetKey: string) => new Promise<Texture>((resolve) => {
      resolvers.set(assetKey, resolve);
    }));
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load }
    });

    const update = renderer.updateAppearance(snapshot(1, "sword_test"));
    expect(renderer.appearanceComplete).toBe(false);
    expect(renderer.equipmentSprite("melee")).toBeNull();
    expect(renderer.layers.head.children).toHaveLength(0);

    resolvers.get("body.png")!(Texture.EMPTY);
    await Promise.resolve();
    expect(renderer.equipmentSprite("melee")).toBeNull();
    expect(renderer.layers.head.children).toHaveLength(0);

    resolvers.get("weapons/sword_test.png")!(Texture.EMPTY);
    await update;
    expect(renderer.appearanceComplete).toBe(true);
    expect(renderer.equipmentSprite("melee")).not.toBeNull();
    expect(renderer.layers.body.children).toHaveLength(1);
    expect(renderer.layers.head.children).toHaveLength(0);
    expect(load.mock.calls.map(([assetKey]) => assetKey)).toEqual([
      "body.png",
      "weapons/sword_test.png"
    ]);
    renderer.destroy();
  });

  it("retries a pending appearance when the initial combat pose changes", async () => {
    let resolveTexture: ((texture: Texture) => void) | undefined;
    const textureReady = new Promise<Texture>((resolve) => {
      resolveTexture = resolve;
    });
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog: DEFAULT_PLAYER_APPEARANCE_CATALOG,
      textureLoader: { load: vi.fn(async () => textureReady) }
    });

    const update = renderer.updateAppearance({
      schemaVersion: 1,
      catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
      revision: 1,
      bodyVariantId: "default",
      poseId: "idle",
      slots: {
        secondary: {
          equipmentDefinitionId: "starter_shuriken",
          appearanceId: "starter-shuriken",
          cosmeticAppearanceId: null
        }
      },
      activeHand: "secondary"
    });
    expect(renderer.appearanceComplete).toBe(false);
    renderer.setPose("combat_ready");
    resolveTexture!(Texture.EMPTY);

    await update;
    await vi.waitFor(() => {
      expect(renderer.equipmentSprite("secondary")).not.toBeNull();
    });
    expect(renderer.appearanceComplete).toBe(true);
    renderer.destroy();
  });

  it("exposes the same transform helper used by studio and game", () => {
    const target = {
      position: { set: vi.fn() },
      rotation: 0,
      scale: { set: vi.fn() },
      anchor: { set: vi.fn() },
      visible: false
    };
    const resolved = applyAppearanceTransform(
      target as never,
      testCatalog(),
      "sword_test"
    );
    const leftHand = playerBodyPose(testCatalog(), "default", "idle").anchors.left_hand;
    expect(target.position.set).toHaveBeenCalledWith(leftHand.x + 5, leftHand.y - 3);
    expect(target.scale.set).toHaveBeenCalledWith(-1.25, 0.75);
    expect(target.anchor.set).toHaveBeenCalledWith(0.2, 0.8);
    expect(target.visible).toBe(true);
    expect(resolved.layer).toBe("front_hand");
  });

  it("changes combat poses on retained body and equipment containers", async () => {
    const catalog = testCatalog();
    catalog.bodyVariants[0]!.mainAnchor = { x: 1, y: 29 };
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });
    await renderer.updateAppearance(snapshot(1, "sword_test"));
    const root = renderer.root;
    const sprite = renderer.equipmentSprite("melee")!;
    const buildCount = renderer.appearanceBuildCount;
    renderer.root.position.set(41, 73);

    expect(renderer.setPose("combat_ready")).toBe(true);
    expect(renderer.visualRoot.pivot).toMatchObject({ x: 1, y: 29 });
    expect(renderer.root.position).toMatchObject({ x: 41, y: 73 });
    expect(renderer.root).toBe(root);
    expect(renderer.equipmentSprite("melee")).toBe(sprite);
    expect(renderer.appearanceBuildCount).toBe(buildCount);
    expect(sprite.rotation).toBeCloseTo(90 * Math.PI / 180);

    renderer.setPose("attack_action");
    expect(renderer.visualRoot.pivot).toMatchObject({ x: 1, y: 29 });
    expect(renderer.root.position).toMatchObject({ x: 41, y: 73 });
    expect(renderer.root).toBe(root);
    expect(renderer.equipmentSprite("melee")).toBe(sprite);
    expect(sprite.rotation).toBeCloseTo(90 * Math.PI / 180);
    renderer.setPose("downed");
    expect(renderer.visualRoot.pivot).toMatchObject({ x: 1, y: 29 });
    expect(renderer.root.position).toMatchObject({ x: 41, y: 73 });
    expect(renderer.visualRoot.rotation).toBeCloseTo(Math.PI / 2);
    expect(renderer.visualRoot.position.x).toBeCloseTo(-renderer.baseHeightPx * 0.35);
    expect(renderer.visualRoot.position.y).toBe(-4);
    renderer.setPose("idle");
    expect(renderer.visualRoot.rotation).toBe(0);
    expect(renderer.visualRoot.position).toMatchObject({ x: 0, y: 0 });
    renderer.destroy();
  });

  it("swaps pose bodies and resolves equipment against the player template without rebuilding root", async () => {
    const catalog = testCatalog();
    const body = catalog.bodyVariants.find(({ bodyVariantId }) =>
      bodyVariantId === "default"
    )!;
    body.bodyAssetKeys = {
      idle: "bodies/player-idle.png",
      combat_ready: "bodies/player-ready.png",
      attack_action: "bodies/player-action.png"
    };
    body.bodyTransforms = {
      idle: { offsetX: 4, offsetY: -2, scale: 1.5 },
      combat_ready: { offsetX: 6, offsetY: -3, scale: 1.25 }
    };
    const idlePose = body.poses.find(({ poseId }) => poseId === "idle")!;
    idlePose.anchors = {
      ...idlePose.anchors,
      left_hand: { ...idlePose.anchors.left_hand, x: 30 }
    };
    const load = vi.fn(async (_assetKey: string) => { void _assetKey; return Texture.EMPTY; });
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load }
    });
    const root = renderer.root;
    await renderer.updateAppearance({
      ...snapshot(1, "sword_test")
    });
    const idleBody = renderer.layers.body.children[0];
    expect(idleBody?.position).toMatchObject({ x: 4, y: -2 });
    expect(idleBody?.scale.x).toBe(63);
    expect(renderer.layers.head.children).toHaveLength(0);
    expect(renderer.equipmentSprite("melee")!.position.x).toBe(35);
    expect(PLAYER_RENDER_LAYERS.indexOf("chest_armor"))
      .toBeLessThan(PLAYER_RENDER_LAYERS.indexOf("head"));
    expect(PLAYER_RENDER_LAYERS.indexOf("head"))
      .toBeLessThan(PLAYER_RENDER_LAYERS.indexOf("head_armor"));

    renderer.setPose("combat_ready");
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("bodies/player-ready.png");
      expect(renderer.layers.body.children[0]).not.toBe(idleBody);
    });
    expect(renderer.layers.body.children[0]?.position).toMatchObject({ x: 6, y: -3 });
    expect(load.mock.calls.some(([assetKey]) => assetKey.startsWith("heads/"))).toBe(false);
    expect(renderer.root).toBe(root);
    expect(renderer.appearanceBuildCount).toBe(1);
    renderer.destroy();
  });

  it("swaps linked skin-tone body art while retaining equipment sprites", async () => {
    const catalog = testCatalog();
    catalog.bodyVariants[0]!.skinToneAssetKeys = {
      light: "bodies/player-light.png",
      medium: "bodies/player-medium.png",
      dark: "bodies/player-dark.png"
    };
    const load = vi.fn(async (_assetKey: string) => {
      void _assetKey;
      return Texture.EMPTY;
    });
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load }
    });
    await renderer.updateAppearance(snapshot(1, "sword_test"), { skinToneId: "medium" });
    const equipment = renderer.equipmentSprite("melee");
    await renderer.updateAppearance(snapshot(2, "sword_test"), { skinToneId: "dark" });
    expect(load).toHaveBeenCalledWith("bodies/player-medium.png");
    expect(load).toHaveBeenCalledWith("bodies/player-dark.png");
    expect(renderer.equipmentSprite("melee")).toBe(equipment);
    renderer.destroy();
  });

  it("draws an optional separate head with the body transform, per-tone, between armor and face layers", async () => {
    const catalog = testCatalog();
    const variant = catalog.bodyVariants[0]!;
    variant.bodyAssetKeys = { idle: "bodies/body.png" };
    variant.bodyTransforms = { idle: { offsetX: 4, offsetY: 32, scale: 1.65 } };
    variant.skinToneAssetKeys = { medium: "bodies/body-medium.png" };
    variant.headAssetKeys = { idle: "bodies/head.png" };
    variant.headSkinToneAssetKeys = { medium: "bodies/head-medium.png" };
    const load = vi.fn(async (_assetKey: string) => {
      void _assetKey;
      return Texture.EMPTY;
    });
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load }
    });
    await renderer.updateAppearance(snapshot(1, "sword_test"), { skinToneId: "light" });
    expect(load).toHaveBeenCalledWith("bodies/head.png");
    const body = renderer.layers.body.children[0]!;
    const head = renderer.layers.head.children[0]!;
    expect(head.position.x).toBe(body.position.x);
    expect(head.position.y).toBe(body.position.y);
    expect(head.scale.x).toBe(body.scale.x);
    expect(head.scale.y).toBe(body.scale.y);
    const order = (layer: string) => PLAYER_RENDER_LAYERS.indexOf(layer as never);
    expect(order("chest_armor")).toBeLessThan(order("head"));
    for (const above of ["eyes", "nose_mouth", "face_accessory", "mask", "hair"]) {
      expect(order("head")).toBeLessThan(order(above));
    }
    await renderer.updateAppearance(snapshot(2, "sword_test"), { skinToneId: "medium" });
    expect(load).toHaveBeenCalledWith("bodies/head-medium.png");
    expect(renderer.layers.head.children).toHaveLength(1);
    renderer.destroy();
  });

  it("renders no head sprite when the body variant has no head asset", async () => {
    const catalog = testCatalog();
    catalog.bodyVariants[0]!.bodyAssetKeys = { idle: "bodies/body.png" };
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });
    await renderer.updateAppearance(snapshot(1, "sword_test"));
    expect(renderer.layers.head.children).toHaveLength(0);
    renderer.destroy();
  });

  it("renders the canonical face beneath beard, mask, and hair overlays", async () => {
    const catalog = testCatalog();
    catalog.appearances.push(
      {
        appearanceId: "brown-eyes",
        displayName: "Face",
        familyId: "eyes",
        assetKey: "eyes/test.png",
        cosmetic: true
      },
      {
        appearanceId: "alternate-face",
        displayName: "Alternate Face",
        familyId: "eyes",
        assetKey: "eyes/alternate.png",
        cosmetic: true
      },
      {
        appearanceId: "nose_test",
        displayName: "Nose",
        familyId: "nose_mouth",
        assetKey: "nose-mouth/test.png",
        cosmetic: true
      },
      {
        appearanceId: "mask_test",
        displayName: "Mask",
        familyId: "mask",
        assetKey: "masks/test.png",
        cosmetic: true
      },
      {
        appearanceId: "hair_test",
        displayName: "Hair",
        familyId: "hair",
        assetKey: "hair/test.png",
        cosmetic: true
      },
      {
        appearanceId: "beard_test",
        displayName: "Beard",
        familyId: "beard",
        assetKey: "cosmetics/beard_test.png",
        cosmetic: true
      }
    );
    const load = vi.fn(async () => Texture.EMPTY);
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load }
    });
    await renderer.updateAppearance({
      ...snapshot(1, "sword_test"),
      styles: {
        eyes: null,
        nose_mouth: "nose_test",
        hair: "hair_test"
      }
    });
    expect(renderer.appearanceSprite("style:eyes")?.parent).toBe(renderer.layers.eyes);
    expect(renderer.appearanceSprite("style:nose_mouth")).toBeNull();
    await renderer.updateAppearance({
      ...snapshot(2, "sword_test"),
      styles: { eyes: "alternate-face", hair: "hair_test" }
    });
    expect(renderer.appearanceSprite("style:eyes")?.parent).toBe(renderer.layers.eyes);
    expect(load).toHaveBeenCalledWith("eyes/alternate.png");
    await renderer.updateAppearance({
      ...snapshot(3, "sword_test"),
      styles: {
        nose_mouth: "nose_test",
        beard: "beard_test",
        mask: "mask_test",
        hair: "hair_test"
      }
    });
    expect(renderer.appearanceSprite("style:eyes")?.parent).toBe(renderer.layers.eyes);
    expect(renderer.appearanceSprite("style:beard")?.parent)
      .toBe(renderer.layers.face_accessory);
    expect(renderer.appearanceSprite("style:mask")?.parent).toBe(renderer.layers.mask);
    expect(renderer.appearanceSprite("style:hair")?.parent).toBe(renderer.layers.hair);
    expect(PLAYER_RENDER_LAYERS.indexOf("head")).toBeLessThan(
      PLAYER_RENDER_LAYERS.indexOf("mask")
    );
    expect(PLAYER_RENDER_LAYERS.indexOf("eyes")).toBeLessThan(
      PLAYER_RENDER_LAYERS.indexOf("face_accessory")
    );
    expect(PLAYER_RENDER_LAYERS.indexOf("face_accessory")).toBeLessThan(
      PLAYER_RENDER_LAYERS.indexOf("hair")
    );
    expect(PLAYER_RENDER_LAYERS.indexOf("mask")).toBeLessThan(
      PLAYER_RENDER_LAYERS.indexOf("hair")
    );
    renderer.destroy();
  });

  it("renders standalone Legs alongside Gear chest and rejects standalone chest styles", async () => {
    const catalog = testCatalog();
    const legsFamily = catalog.families.find(({ familyId }) => familyId === "legs")!;
    catalog.families.push({
      ...structuredClone(legsFamily),
      familyId: "standalone_chest",
      displayName: "Standalone Chest",
      categoryId: "body_armor",
      authoringLayer: "chest",
      playerOverlaySlot: "chest"
    });
    catalog.appearances = [
      {
        appearanceId: "equipped_tunic",
        displayName: "Equipped Tunic",
        familyId: "chest_tunic",
        assetKey: "armor/chest/equipped.png",
        cosmetic: false,
        equipmentDefinitionId: "padded_tunic"
      },
      {
        appearanceId: "pants_overlay",
        displayName: "Pants Overlay",
        familyId: "legs",
        assetKey: "cosmetics/pants-overlay.png",
        cosmetic: false,
      },
      {
        appearanceId: "standalone_chest_overlay",
        displayName: "Standalone Chest Overlay",
        familyId: "standalone_chest",
        assetKey: "cosmetics/standalone-chest-overlay.png",
        cosmetic: false
      }
    ];
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });

    await renderer.updateAppearance({
      ...snapshot(1, "equipped_tunic"),
      activeHand: null,
      slots: {
        chest: {
          equipmentDefinitionId: "padded_tunic",
          appearanceId: "equipped_tunic",
          cosmeticAppearanceId: null
        }
      },
      styles: { legs: "pants_overlay", chest: "standalone_chest_overlay" }
    });

    expect(renderer.appearanceSprite("chest")?.parent).toBe(renderer.layers.chest_armor);
    expect(renderer.appearanceSprite("style:legs")?.parent).toBe(renderer.layers.legs);
    expect(renderer.appearanceSprite("style:chest")).toBeNull();
    renderer.destroy();
  });

  it("renders paired glove parts from one item variant on independent hand anchors", async () => {
    const catalog = testCatalog();
    catalog.appearances = [{
      appearanceId: "paired_gloves",
      displayName: "Paired Gloves",
      familyId: "gloves",
      cosmetic: false,
      equipmentDefinitionId: "training_heavy_gloves",
      parts: [
        {
          partId: "left",
          assetKey: "armor/gloves/left.png",
          placements: { idle: { anchorId: "left_hand" } }
        },
        {
          partId: "right",
          assetKey: "armor/gloves/right.png",
          placements: { idle: { anchorId: "right_hand" } }
        }
      ]
    }];
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });
    await renderer.updateAppearance({
      ...snapshot(1, "paired_gloves"),
      activeHand: null,
      slots: {
        gloves: {
          equipmentDefinitionId: "training_heavy_gloves",
          appearanceId: "paired_gloves",
          cosmeticAppearanceId: null
        }
      }
    });
    expect(renderer.appearanceSprite("gloves", "left")?.position.x).toBe(
      playerBodyPose(catalog, "default", "idle").anchors.left_hand.x
    );
    expect(renderer.appearanceSprite("gloves", "right")?.position.x).toBe(
      playerBodyPose(catalog, "default", "idle").anchors.right_hand.x
    );
    renderer.destroy();
  });

  it("provides canonical face, legs, feet, and shield overlay layers", async () => {
    const catalog = testCatalog();
    catalog.appearances = [
      {
        appearanceId: "brown-eyes",
        displayName: "Face",
        familyId: "eyes",
        assetKey: "eyes/face.png",
        cosmetic: true
      },
      {
        appearanceId: "paired_boots",
        displayName: "Paired Boots",
        familyId: "boots",
        cosmetic: false,
        equipmentDefinitionId: "training_heavy_boots",
        parts: [
          { partId: "left", assetKey: "armor/boots/left.png", placements: {
            idle: { anchorId: "left_foot" }
          } },
          { partId: "right", assetKey: "armor/boots/right.png", placements: {
            idle: { anchorId: "right_foot" }
          } }
        ]
      },
      {
        appearanceId: "shield_test",
        displayName: "Shield",
        familyId: "shield",
        assetKey: "shields/test.png",
        cosmetic: false,
        equipmentDefinitionId: "training_shield"
      }
    ];
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });
    await renderer.updateAppearance({
      ...snapshot(1, "shield_test"),
      activeHand: null,
      styles: { eyes: null },
      slots: {
        boots: {
          equipmentDefinitionId: "training_heavy_boots",
          appearanceId: "paired_boots",
          cosmeticAppearanceId: null
        },
        secondary: {
          equipmentDefinitionId: "training_shield",
          appearanceId: "shield_test",
          cosmeticAppearanceId: null
        }
      }
    });
    expect(renderer.appearanceSprite("style:eyes")?.parent).toBe(renderer.layers.eyes);
    expect(renderer.appearanceSprite("boots", "left")?.parent).toBe(renderer.layers.feet);
    expect(renderer.appearanceSprite("boots", "right")?.position.x).toBe(
      playerBodyPose(catalog, "default", "idle").anchors.right_foot.x
    );
    expect(renderer.appearanceSprite("secondary")?.parent).toBe(renderer.layers.shield);
    expect(renderer.layers.legs).toBeDefined();
    expect(PLAYER_RENDER_LAYERS.indexOf("shield"))
      .toBeLessThan(PLAYER_RENDER_LAYERS.indexOf("body"));
    renderer.destroy();
  });

  it("renders Beard through the dedicated face-accessory overlay layer", async () => {
    const catalog = testCatalog();
    catalog.appearances.push({
      appearanceId: "beard_test",
      displayName: "Beard test",
      familyId: "beard",
      assetKey: "cosmetics/beard_test.png",
      cosmetic: false,
      placements: {}
    });
    const renderer = new PlayerRenderer({
      local: true,
      color: 0x38bdf8,
      catalog,
      textureLoader: { load: vi.fn(async () => Texture.EMPTY) }
    });
    await renderer.updateAppearance({
      ...snapshot(1, "sword_test"),
      styles: { beard: "beard_test" }
    });
    expect(renderer.appearanceSprite("style:beard")?.parent)
      .toBe(renderer.layers.face_accessory);
    renderer.destroy();
  });
});

function testCatalog(): PlayerAppearanceCatalog {
  const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
  for (const body of catalog.bodyVariants) delete body.bodyAssetKeys;
  catalog.appearances = [{
    appearanceId: "sword_test",
    displayName: "Sword test",
    familyId: "one_handed_sword",
    assetKey: "weapons/sword_test.png",
    cosmetic: false,
    equipmentDefinitionId: "starter_sword",
    placements: {
      idle: {
        offsetX: 5,
        offsetY: -3,
        rotationDegrees: 90,
        scaleX: -1.25,
        scaleY: 0.75,
        pivotX: 0.2,
        pivotY: 0.8
      }
    }
  }];
  return catalog;
}

function snapshot(
  revision: number,
  appearanceId: string,
  enhancement?: EquipmentAppearanceEnhancement
): PlayerAppearanceSnapshot {
  return {
    schemaVersion: 1,
    catalogRevision: 2,
    revision,
    bodyVariantId: "default",
    poseId: "idle",
    activeHand: "melee",
    slots: {
      melee: {
        equipmentDefinitionId: "starter_sword",
        appearanceId,
        cosmeticAppearanceId: null,
        ...(enhancement ? { enhancement } : {})
      }
    }
  };
}
