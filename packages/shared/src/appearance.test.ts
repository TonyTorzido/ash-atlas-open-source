import { describe, expect, it } from "vitest";

import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "./appearanceCatalog.js";
import {
  activeProjectileAssetKey,
  activeProjectilePresentation,
  activeShotProfile,
  appearanceCompatibleWithEquipment,
  appearanceCategory,
  baseAppearanceForEquipment,
  equipmentGemSocket,
  PLAYER_AUTHORABLE_OVERLAY_SLOT_IDS,
  PLAYER_OVERLAY_SLOT_IDS,
  PLAYER_ATTACHMENT_ANCHOR_IDS,
  parsePlayerAppearanceCatalog,
  playerBodyAssetKey,
  playerSkinToneAssetKey,
  playerHeadAssetKey,
  playerBodyPose,
  playerMainAnchor,
  playerOverallScale,
  normalizePlayerSalonStyles,
  playerAppearanceSnapshotSchema,
  playerTemplateTransform,
  playerOverlaySlotForFamily,
  projectPlayerAppearance,
  resolveAppearanceLocalTransform,
  resolveFaceFeaturePoint,
  faceFeatureArea,
  resolveAppearancePlacement,
  salonAppearanceCategory,
  salonAppearanceOptions,
  salonAppearanceSelectable,
  type AppearanceDefinition,
  type AppearanceFamily,
  type PlayerAppearanceCatalog
} from "./appearance.js";
import type {
  EquipmentInstanceV2,
  EquipmentSnapshotV2
} from "./equipment.js";
import { requireEquipmentDefinition } from "./equipment.js";

describe("player appearance catalog", () => {
  it("preserves the selected Face while defaulting missing Face and dropping legacy nose/mouth", () => {
    expect(normalizePlayerSalonStyles({
      eyes: "alternate-face",
      nose_mouth: "legacy-face"
    })).toEqual({ eyes: "alternate-face", skinToneId: "light" });
    expect(normalizePlayerSalonStyles({ eyes: null })).toEqual({
      eyes: "brown-eyes",
      skinToneId: "light"
    });
    expect(normalizePlayerSalonStyles()).toEqual({
      eyes: "brown-eyes",
      skinToneId: "light"
    });
  });

  it("publishes the canonical overlay slots and authorable Beard family", () => {
    expect(PLAYER_OVERLAY_SLOT_IDS).toEqual([
      "face", "mask", "hair", "chest", "hands", "legs", "feet", "shield", "beard"
    ]);
    expect(PLAYER_AUTHORABLE_OVERLAY_SLOT_IDS).toEqual([
      "face", "mask", "hair", "legs", "beard"
    ]);
  });

  it("keeps the separate head optional with the same tone fallback as the body", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    expect(playerHeadAssetKey(catalog, "default", "idle", "light")).toBeNull();
    expect(() => parsePlayerAppearanceCatalog(catalog)).not.toThrow();
    const body = catalog.bodyVariants[0]!;
    body.headAssetKeys = { idle: "bodies/head.png" };
    body.headSkinToneAssetKeys = { light: null, medium: "bodies/head-medium.png" };
    expect(() => parsePlayerAppearanceCatalog(catalog)).not.toThrow();
    expect(playerHeadAssetKey(catalog, "default", "idle", "light")).toBe("bodies/head.png");
    expect(playerHeadAssetKey(catalog, "default", "attack_action", "dark")).toBe("bodies/head.png");
    expect(playerHeadAssetKey(catalog, "default", "idle", "medium")).toBe("bodies/head-medium.png");
    expect(() => parsePlayerAppearanceCatalog({
      ...catalog,
      bodyVariants: [{ ...body, headAssetKeys: { walk: "bodies/head.png" } }]
    })).toThrow();
  });

  it("keeps one Player Base with three linked tone slots and shared transform lookup", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const body = catalog.bodyVariants[0]!;
    expect(Object.keys(body.skinToneAssetKeys ?? {})).toEqual([
      "light", "medium", "dark"
    ]);
    expect(playerSkinToneAssetKey(
      catalog,
      "default",
      "light"
    )).toBeNull();
    body.skinToneAssetKeys = {
      ...body.skinToneAssetKeys,
      medium: "bodies/player-medium.png"
    };
    expect(playerSkinToneAssetKey(
      catalog,
      "default",
      "medium"
    )).toBe("bodies/player-medium.png");
    expect(playerTemplateTransform(
      catalog,
      "default",
      "idle"
    )).toEqual({ offsetX: 0, offsetY: 32, scale: 1.65 });
  });

  it("publishes standalone Legs and Beard overlay families", () => {
    expect(DEFAULT_PLAYER_APPEARANCE_CATALOG.families.filter(({ familyId }) =>
      ["chest", "hands", "legs", "feet", "player_shield", "beard"].includes(familyId)
    ).map(({ familyId, compatibleEquipmentDefinitionIds }) => ({
      familyId,
      compatibleEquipmentDefinitionIds
    }))).toEqual([
      { familyId: "beard", compatibleEquipmentDefinitionIds: [] },
      { familyId: "legs", compatibleEquipmentDefinitionIds: [] }
    ]);
    expect(DEFAULT_PLAYER_APPEARANCE_CATALOG.families.find(({ familyId }) =>
      familyId === "beard"
    )?.playerOverlaySlot).toBe("beard");
    expect(playerOverlaySlotForFamily({
      familyId: "beard",
      categoryId: "nose_mouth",
      authoringLayer: "face"
    })).toBe("beard");
    expect(DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find(({ appearanceId }) =>
      appearanceId === "black-pants"
    )?.familyId).toBe("legs");
  });

  it("classifies styles and standalone Legs for Salon but rejects standalone chest", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const legs = catalog.appearances.find(({ appearanceId }) =>
      appearanceId === "black-pants"
    )!;
    const disabled = {
      ...legs,
      appearanceId: "disabled_legs",
      displayName: "Disabled Legs",
      salon: {
        state: "disabled" as const,
        accessType: "free" as const,
        gameCreditPrice: 0 as const,
        productId: null
      }
    };
    const equipmentBound = {
      ...legs,
      appearanceId: "bound_legs",
      displayName: "Bound Legs",
      equipmentDefinitionId: "padded_tunic" as const
    };
    catalog.appearances.push(disabled, equipmentBound);

    expect(salonAppearanceCategory(catalog, legs)).toBe("legs");
    expect(salonAppearanceSelectable(legs)).toBe(true);
    expect(salonAppearanceCategory(catalog, disabled)).toBe("legs");
    expect(salonAppearanceSelectable(disabled)).toBe(false);
    expect(salonAppearanceCategory(catalog, equipmentBound)).toBeNull();
    expect(salonAppearanceOptions(catalog, "legs").map(({ appearanceId }) => appearanceId))
      .toContain("black-pants");
    const standaloneChestFamily: AppearanceFamily = {
      ...structuredClone(catalog.families.find(({ familyId }) => familyId === "legs")!),
      familyId: "standalone_chest",
      displayName: "Standalone Chest",
      categoryId: "body_armor",
      authoringLayer: "chest",
      compatibleEquipmentDefinitionIds: [],
      playerOverlaySlot: "chest" as const
    };
    const standaloneChest: AppearanceDefinition = {
      appearanceId: "standalone_chest",
      displayName: "Standalone Chest",
      familyId: standaloneChestFamily.familyId,
      assetKey: "cosmetics/standalone-chest.png",
      cosmetic: false
    };
    catalog.families.push(standaloneChestFamily);
    catalog.appearances.push(standaloneChest);
    expect(salonAppearanceCategory(catalog, standaloneChest)).toBeNull();
    expect(playerAppearanceSnapshotSchema.parse({
      schemaVersion: 1,
      catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
      revision: 2,
      bodyVariantId: "default",
      poseId: "idle",
      slots: {},
      styles: { chest: "legacy_chest", shield: null, legs: "black-pants" },
      activeHand: null
    }).styles).toEqual({ chest: "legacy_chest", shield: null, legs: "black-pants" });
  });

  it("deterministically maps legacy authoring families without losing face content", () => {
    const mapped = Object.fromEntries(DEFAULT_PLAYER_APPEARANCE_CATALOG.families.map(
      (family) => [family.familyId, playerOverlaySlotForFamily(family)]
    ));
    expect(mapped).toMatchObject({
      hair: "hair",
      eyes: "face",
      mask: "mask",
      chest_tunic: "chest",
      gloves: "hands",
      legs: "legs",
      boots: "feet",
      shield: "shield",
      one_handed_sword: null,
      back_item: null,
      head_armor: "hair"
    });
    expect(DEFAULT_PLAYER_APPEARANCE_CATALOG.schemaVersion).toBe(2);
    const legacy = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG) as unknown as {
      schemaVersion: number;
      families: Array<Record<string, unknown>>;
    };
    legacy.schemaVersion = 1;
    for (const family of legacy.families) delete family.playerOverlaySlot;
    const migrated = parsePlayerAppearanceCatalog(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.families.find(({ familyId }) => familyId === "eyes")
      ?.playerOverlaySlot).toBe("face");
    expect(migrated.families.find(({ familyId }) => familyId === "one_handed_sword")
      ?.playerOverlaySlot).toBeNull();
  });
  it("resolves the starter staff to staff artwork instead of the retired hammer", () => {
    expect(baseAppearanceForEquipment(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      "starter_staff"
    )).toMatchObject({
      appearanceId: "starter-staff",
      assetKey: "weapons/staff.png",
      equipmentDefinitionId: "starter_staff"
    });
  });

  it.each([
    ["padded_tunic", "non-swag-cloth", "armor/chest/nonswagcloth.png"],
    ["leather_armor", "non-swag-leather", "armor/chest/nonswagleather.png"],
    ["breast_plate", "non-swag-breastplate", "armor/chest/nonswagbreastplate.png"]
  ] as const)(
    "projects %s through its active authored replacement",
    (equipmentDefinitionId, appearanceId, assetKey) => {
      const definitionId = requireEquipmentDefinition(equipmentDefinitionId).definitionId;
      const projected = projectPlayerAppearance(
        equipmentSnapshot({
          chest: equipmentItem(definitionId, "chest_armor")
        }),
        DEFAULT_PLAYER_APPEARANCE_CATALOG
      );

      expect(projected.slots.chest?.appearanceId).toBe(appearanceId);
      expect(baseAppearanceForEquipment(
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        definitionId
      )?.assetKey).toBe(assetKey);
    }
  );

  it("falls back to a retired appearance when no active compatible appearance exists", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    catalog.appearances = catalog.appearances.filter(
      ({ appearanceId }) => appearanceId === "padded_tunic"
    );

    expect(baseAppearanceForEquipment(catalog, "padded_tunic")).toMatchObject({
      appearanceId: "padded_tunic",
      assetKey: "armor/chest/00000000-0000-4000-8000-000000900014.png",
      retired: true
    });
  });

  it("publishes the new equipment artwork in the canonical content groups", () => {
    const doubleAxe = DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find(
      ({ appearanceId }) => appearanceId === "double_axe"
    );
    const breastPlate = DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find(
      ({ appearanceId }) => appearanceId === "breast_plate"
    );
    const doubleAxeDefinitionId = requireEquipmentDefinition("double_axe").definitionId;
    const breastPlateDefinitionId = requireEquipmentDefinition("breast_plate").definitionId;

    expect(doubleAxe).toMatchObject({
      assetKey: "weapons/double-axe.png",
      equipmentDefinitionId: "double_axe",
      familyId: "one_handed_axe"
    });
    expect(breastPlate).toMatchObject({
      assetKey: "armor/chest/00000000-0000-4000-8000-000000900015.png",
      equipmentDefinitionId: "breast_plate",
      familyId: "chest_breastplate"
    });
    expect(appearanceCategory(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      "double_axe"
    )).toBe("weapon");
    expect(appearanceCategory(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      "breast_plate"
    )).toBe("body_armor");
    expect(appearanceCompatibleWithEquipment(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      "double_axe",
      doubleAxeDefinitionId
    )).toBe(true);
    expect(appearanceCompatibleWithEquipment(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      "breast_plate",
      breastPlateDefinitionId
    )).toBe(true);
  });

  it("publishes the Eyes, Nose, and Mouth families and the Eyes Salon options", () => {
    const faceFamilies = DEFAULT_PLAYER_APPEARANCE_CATALOG.families.filter(
      (family) => playerOverlaySlotForFamily(family) === "face"
    );
    expect(faceFamilies.map(({ familyId, displayName }) => ({ familyId, displayName })))
      .toEqual([
        { familyId: "eyes", displayName: "Eyes" },
        { familyId: "nose", displayName: "Nose" },
        { familyId: "mouth", displayName: "Mouth" }
      ]);
    expect(salonAppearanceOptions(DEFAULT_PLAYER_APPEARANCE_CATALOG, "nose")).toEqual([]);
    expect(salonAppearanceOptions(DEFAULT_PLAYER_APPEARANCE_CATALOG, "mouth")).toEqual([]);
    expect(salonAppearanceOptions(DEFAULT_PLAYER_APPEARANCE_CATALOG, "eyes")
      .map(({ appearanceId, assetKey, displayName }) => ({ appearanceId, assetKey, displayName })))
      .toEqual([
        { appearanceId: "blue-eyes", assetKey: "eyes/blueeyes.png", displayName: "Blue" },
        { appearanceId: "brown-eyes", assetKey: "eyes/browneyes.png", displayName: "Brown" },
        { appearanceId: "green-eyes", assetKey: "eyes/greeneyes.png", displayName: "Green" },
        { appearanceId: "grey-eyes", assetKey: "eyes/greyeyes.png", displayName: "Grey" },
        { appearanceId: "hazel-eyes", assetKey: "eyes/hazeleyes.png", displayName: "Hazel" },
        { appearanceId: "purple-eyes", assetKey: "eyes/purpleeyes.png", displayName: "Purple" },
        { appearanceId: "red-eyes", assetKey: "eyes/redeyes.png", displayName: "Red" }
      ]);
    expect(DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.some(
      ({ familyId }) => familyId === "nose_mouth"
    )).toBe(false);
    expect(resolveAppearancePlacement(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      "brown-eyes",
      "idle"
    )).toMatchObject({ offsetY: 13, scaleX: 0.03, scaleY: 0.03 });
  });

  it("snaps an artist anchor to the player's point and falls back inside the area", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const area = faceFeatureArea(catalog, "eyes")!;
    const legacy = resolveAppearanceLocalTransform(catalog, "brown-eyes", "idle", "default", "main", area.defaultPoint);
    expect(legacy).toMatchObject({ offsetY: 13, pivotX: 0.5, pivotY: 0.5 });
    catalog.appearances.find(({ appearanceId }) => appearanceId === "brown-eyes")!
      .featureAnchor = { x: 0.5, y: 0.4 };
    const moved = { x: area.defaultPoint.x + 1, y: area.defaultPoint.y };
    const anchored = resolveAppearanceLocalTransform(catalog, "brown-eyes", "idle", "default", "main", moved);
    expect(anchored).toMatchObject({
      x: anchored.anchor.x + moved.x,
      y: anchored.anchor.y + moved.y,
      pivotX: 0.5,
      pivotY: 0.4,
      scaleX: 0.03
    });
    expect(resolveFaceFeaturePoint(catalog, "eyes", { eyes: moved })).toEqual(moved);
    expect(resolveFaceFeaturePoint(catalog, "eyes", { eyes: { x: 400, y: 400 } }))
      .toEqual(area.defaultPoint);
    expect(() => parsePlayerAppearanceCatalog({
      ...catalog,
      families: catalog.families.map((family) => family.familyId === "nose"
        ? { ...family, featureArea: { defaultPoint: { x: 50, y: 50 }, polygon: family.featureArea!.polygon } }
        : family)
    })).toThrow(/default feature point/u);
  });

  it("parses the canonical catalog and resolves inherited family and item placement", () => {
    const catalog = catalogWith([
      appearance({
        appearanceId: "sword_base",
        familyId: "one_handed_sword",
        equipmentDefinitionId: "starter_sword",
        placements: { idle: { offsetX: 5 } }
      }),
      appearance({
        appearanceId: "sword_cosmetic",
        familyId: "one_handed_sword",
        cosmetic: true,
        inheritAppearanceId: "sword_base",
        placements: { idle: { offsetY: 4, scaleX: -1 } }
      })
    ]);

    expect(parsePlayerAppearanceCatalog(catalog)).toEqual(catalog);
    expect(resolveAppearancePlacement(catalog, "sword_cosmetic")).toMatchObject({
      anchorId: "left_hand",
      layer: "front_hand",
      offsetX: 5,
      offsetY: 4,
      scaleX: -1,
      pivotX: 0.5002,
      pivotY: 0.2866
    });
    const leftHand = playerBodyPose(catalog, "default", "idle").anchors.left_hand;
    expect(resolveAppearanceLocalTransform(catalog, "sword_cosmetic")).toMatchObject({
      anchor: leftHand,
      x: leftHand.x + 5,
      y: leftHand.y + 4
    });
    expect(appearanceCompatibleWithEquipment(
      catalog,
      "sword_cosmetic",
      "starter_sword"
    )).toBe(true);
    expect(appearanceCompatibleWithEquipment(
      catalog,
      "sword_cosmetic",
      "starter_bow"
    )).toBe(false);
  });

  it("resolves the active visible weapon's optional projectile artwork", () => {
    const catalog = catalogWith([
      appearance({
        appearanceId: "bow_base",
        familyId: "bow",
        equipmentDefinitionId: "starter_bow",
        projectileAssetKey: "projectiles/arrow.png"
      }),
      appearance({
        appearanceId: "bow_cosmetic",
        familyId: "bow",
        cosmetic: true,
        projectileAssetKey: "projectiles/ember-arrow.png",
        projectileTransform: {
          offsetX: 2,
          offsetY: -1,
          rotationDegrees: 3,
          scaleX: 0.5,
          scaleY: 0.4,
          impactX: 0.9,
          impactY: 0.5,
          tailX: 0.1,
          tailY: 0.5
        }
      })
    ]);
    const snapshot = {
      schemaVersion: 1 as const,
      catalogRevision: catalog.catalogRevision,
      revision: 1,
      bodyVariantId: "default" as const,
      poseId: "idle" as const,
      slots: {
        secondary: {
          equipmentDefinitionId: "starter_bow" as const,
          appearanceId: "bow_base",
          cosmeticAppearanceId: "bow_cosmetic"
        }
      },
      activeHand: "secondary" as const
    };

    expect(parsePlayerAppearanceCatalog(catalog)).toEqual(catalog);
    expect(activeProjectileAssetKey(catalog, snapshot)).toBe(
      "projectiles/ember-arrow.png"
    );
    expect(activeProjectilePresentation(catalog, snapshot)).toMatchObject({
      assetKey: "projectiles/ember-arrow.png",
      transform: { impactX: 0.9, tailX: 0.1, scaleX: 0.5 }
    });
    expect(activeProjectileAssetKey(catalog, { ...snapshot, activeHand: null })).toBeNull();
  });

  it("picks the readied weapon's shot rules: arcane blast for a staff or wand, the bow's for a bow, none for a sword", () => {
    const snapshotWith = (slot: "melee" | "secondary", equipmentDefinitionId: string) => ({
      schemaVersion: 1 as const,
      catalogRevision: 1,
      revision: 1,
      bodyVariantId: "default" as const,
      poseId: "idle" as const,
      slots: { [slot]: { equipmentDefinitionId, appearanceId: null, cosmeticAppearanceId: null } },
      activeHand: slot
    }) as never;
    expect(activeShotProfile(snapshotWith("melee", "starter_staff"))?.id).toBe("arcane_blast");
    expect(activeShotProfile(snapshotWith("melee", "livingwood_staff"))?.id).toBe("arcane_blast");
    expect(activeShotProfile(snapshotWith("secondary", "starter_wand"))?.id).toBe("arcane_blast");
    expect(activeShotProfile(snapshotWith("secondary", "starter_bow"))?.id).toBe("arrow");
    expect(activeShotProfile(snapshotWith("melee", "starter_sword"))).toBeNull();
    expect(activeShotProfile({ ...(snapshotWith("melee", "starter_staff") as object), activeHand: null } as never)).toBeNull();
  });

  it.each([
    ["invalid schema versions", (catalog: PlayerAppearanceCatalog) => {
      catalog.schemaVersion = 3 as never;
    }],
    ["duplicate IDs", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances.push({ ...catalog.appearances[0]! });
    }],
    ["unknown family inheritance", (catalog: PlayerAppearanceCatalog) => {
      catalog.families[0]!.inheritsFamilyId = "missing";
    }],
    ["family inheritance cycles", (catalog: PlayerAppearanceCatalog) => {
      catalog.families[0]!.inheritsFamilyId = catalog.families[1]!.familyId;
      catalog.families[1]!.inheritsFamilyId = catalog.families[0]!.familyId;
    }],
    ["appearance cycles", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.inheritAppearanceId = "sword_cosmetic";
      catalog.appearances[1]!.inheritAppearanceId = "sword_base";
    }],
    ["unknown body variants", (catalog: PlayerAppearanceCatalog) => {
      catalog.bodyVariants[0]!.bodyVariantId = "missing" as never;
    }],
    ["invalid pivots", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.placements = { idle: { pivotX: 1.01 } };
    }],
    ["non-finite transforms", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.placements = { idle: { offsetX: Number.NaN } };
    }],
    ["unknown layers", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.placements = { idle: { layer: "middle" as never } };
    }],
    ["unknown anchors", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.placements = { idle: { anchorId: "elbow" as never } };
    }],
    ["cosmetics without compatibility", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.familyId = "back_item";
      catalog.appearances[0]!.cosmetic = true;
      delete catalog.appearances[0]!.equipmentDefinitionId;
      delete catalog.appearances[0]!.compatibleEquipmentDefinitionIds;
    }],
    ["unsafe asset keys", (catalog: PlayerAppearanceCatalog) => {
      catalog.appearances[0]!.assetKey = "../sword.png";
    }]
  ])("rejects %s", (_label, mutate) => {
    const catalog = catalogWith([
      appearance({ appearanceId: "sword_base" }),
      appearance({ appearanceId: "sword_cosmetic", cosmetic: true })
    ]);
    mutate(catalog);
    expect(() => parsePlayerAppearanceCatalog(catalog)).toThrow();
  });

  it("migrates old single-pose catalog data into Idle and generates family combat defaults", () => {
    const legacy = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG) as unknown as {
      bodyVariants: Array<Record<string, unknown>>;
      families: Array<Record<string, unknown>>;
      appearances: Array<Record<string, unknown>>;
    };
    legacy.bodyVariants[0]!.poses = [{
      ...(DEFAULT_PLAYER_APPEARANCE_CATALOG.bodyVariants[0]!.poses[0] as unknown as object),
      poseId: "world_idle"
    }];
    legacy.families = DEFAULT_PLAYER_APPEARANCE_CATALOG.families.map((family) => ({
      ...family,
      placement: family.placements.idle,
      placements: undefined
    }));
    legacy.appearances = [{
      appearanceId: "legacy_sword",
      displayName: "Legacy sword",
      familyId: "one_handed_sword",
      assetKey: "weapons/legacy-sword.png",
      cosmetic: false,
      equipmentDefinitionId: "starter_sword",
      placement: { offsetX: 9 }
    }];

    const migrated = parsePlayerAppearanceCatalog(legacy);
    expect(migrated.appearances[0]!.placements).toEqual({
      idle: { offsetX: 9 }
    });
    expect(migrated.families[0]!.placements.combat_ready.rotationDegrees)
      .toBe(-55);
    expect(migrated.families[0]!.placements.attack_action.rotationDegrees)
      .toBe(55);
    expect(migrated.bodyVariants[0]!.poses.map(({ poseId }) => poseId))
      .toEqual(["idle", "combat_ready", "attack_action"]);
    const poses = migrated.bodyVariants[0]!.poses;
    expect(Object.keys(poses[0]!.anchors)).toEqual([...PLAYER_ATTACHMENT_ANCHOR_IDS]);
    expect(poses.every((pose) =>
      JSON.stringify(pose.anchors) === JSON.stringify(poses[0]!.anchors)
    )).toBe(true);
  });

  it("migrates legacy template fields and falls Action back through Ready to Idle", () => {
    const legacy = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG) as unknown as {
      bodyVariants: Array<Record<string, unknown>>;
    };
    legacy.bodyVariants[0]!.bodyAssetKey = "bodies/legacy-player.png";
    delete legacy.bodyVariants[0]!.bodyAssetKeys;
    legacy.bodyVariants[0]!.headAssetKey = "heads/legacy-player.png";
    legacy.bodyVariants[0]!.headAssetKeys = { idle: "heads/player-idle.png" };
    legacy.bodyVariants[0]!.headTransforms = {
      idle: { offsetX: 1, offsetY: 2, scale: 1.1 }
    };
    const migrated = parsePlayerAppearanceCatalog(legacy);
    expect(migrated.bodyVariants[0]!.bodyAssetKeys).toEqual({
      idle: "bodies/legacy-player.png"
    });
    expect(playerBodyAssetKey(migrated, "default", "attack_action"))
      .toBe("bodies/legacy-player.png");
    expect(migrated.bodyVariants[0]).not.toHaveProperty("headAssetKey");
    expect(migrated.bodyVariants[0]).not.toHaveProperty("headAssetKeys");
    expect(migrated.bodyVariants[0]).not.toHaveProperty("headTransforms");

    migrated.bodyVariants[0]!.bodyAssetKeys = {
      idle: "bodies/player-idle.png",
      combat_ready: "bodies/player-ready.png"
    };
    expect(playerBodyAssetKey(migrated, "default", "attack_action"))
      .toBe("bodies/player-ready.png");
    migrated.bodyVariants[0]!.bodyTransforms = {
      idle: { offsetX: 0, offsetY: 0, scale: 1 },
      combat_ready: { offsetX: 3, offsetY: -2, scale: 1.2 }
    };
    expect(playerTemplateTransform(migrated, "default", "attack_action"))
      .toEqual({ offsetX: 3, offsetY: -2, scale: 1.2 });
    migrated.bodyVariants[0]!.poses = migrated.bodyVariants[0]!.poses.filter(
      ({ poseId }) => poseId !== "attack_action"
    );
    expect(playerBodyPose(migrated, "default", "attack_action").poseId)
      .toBe("combat_ready");
  });

  it("defaults the overall player scale and validates an authored scale", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    delete catalog.bodyVariants[0]!.overallScale;
    expect(playerOverallScale(catalog, "default")).toBe(1);
    catalog.bodyVariants[0]!.overallScale = 1.5;
    expect(parsePlayerAppearanceCatalog(catalog)).toEqual(catalog);
    expect(playerOverallScale(catalog, "default")).toBe(1.5);
  });

  it("validates an optional body main anchor and falls back to the default body or origin", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    expect(playerMainAnchor(catalog, "default")).toEqual({ x: 0, y: 23.04032156808036 });
    expect(playerMainAnchor(catalog, "missing" as never)).toEqual({ x: 0, y: 23.04032156808036 });
    delete catalog.bodyVariants[0]!.mainAnchor;
    expect(parsePlayerAppearanceCatalog(catalog)).toEqual(catalog);
    expect(playerMainAnchor(catalog, "default")).toEqual({ x: 0, y: 0 });
    expect(PLAYER_ATTACHMENT_ANCHOR_IDS).not.toContain("main");

    const invalidPoseAnchor = structuredClone(catalog) as unknown as {
      bodyVariants: Array<{ poses: Array<Record<string, unknown>> }>;
    };
    invalidPoseAnchor.bodyVariants[0]!.poses[0]!.mainAnchor = { x: 1, y: 2 };
    expect(() => parsePlayerAppearanceCatalog(invalidPoseAnchor)).toThrow();
  });

  it("uses Idle as the item source frame until Ready or Action overrides a field", () => {
    const catalog = catalogWith([appearance({
      appearanceId: "pose_sword",
      placements: {
        idle: { offsetX: 40, scaleX: 1.25 },
        combat_ready: { offsetX: 22 }
      }
    })]);
    expect(resolveAppearancePlacement(catalog, "pose_sword", "idle").offsetX)
      .toBe(40);
    expect(resolveAppearancePlacement(catalog, "pose_sword", "combat_ready"))
      .toMatchObject({ offsetX: 22, scaleX: 1.25 });
    expect(resolveAppearancePlacement(catalog, "pose_sword", "attack_action"))
      .toMatchObject({ offsetX: 40, scaleX: 1.25 });
  });

  it("projects only authoritative active equipment, preserves shields, and filters cosmetics", () => {
    const catalog = catalogWith([
      appearance({
        appearanceId: "sword_base",
        equipmentDefinitionId: "starter_sword"
      }),
      appearance({
        appearanceId: "sword_cosmetic",
        cosmetic: true
      }),
      appearance({
        appearanceId: "shield_base",
        familyId: "shield",
        equipmentDefinitionId: "training_shield"
      }),
      appearance({
        appearanceId: "bow_base",
        familyId: "bow",
        equipmentDefinitionId: "starter_bow"
      })
    ]);
    const equipment = equipmentSnapshot({
      melee: equipmentItem("starter_sword", "melee_weapon"),
      secondary: equipmentItem("training_shield", "shield")
    });
    const projected = projectPlayerAppearance(equipment, catalog, {
      melee: "sword_cosmetic",
      secondary: "sword_cosmetic"
    });

    expect(projected.activeHand).toBe("melee");
    expect(projected.slots.melee).toEqual({
      equipmentDefinitionId: "starter_sword",
      appearanceId: "sword_base",
      cosmeticAppearanceId: "sword_cosmetic"
    });
    expect(projected.slots.secondary).toEqual({
      equipmentDefinitionId: "training_shield",
      appearanceId: "shield_base",
      cosmeticAppearanceId: null
    });
    expect(projected.slots.ring).toBeUndefined();

    const switched = projectPlayerAppearance(
      equipmentSnapshot({
        melee: equipmentItem("starter_sword", "melee_weapon"),
        secondary: equipmentItem("starter_bow", "ranged_weapon")
      }),
      catalog,
      {},
      "secondary"
    );
    expect(switched.slots.melee).toBeUndefined();
    expect(switched.slots.secondary?.appearanceId).toBe("bow_base");
  });

  it("projects enhancement visuals and resolves weapon and armor socket defaults", () => {
    const sword = appearance({
      appearanceId: "sword_base",
      equipmentDefinitionId: "starter_sword",
      placements: { idle: { pivotX: 0.25, pivotY: 0.7 } }
    });
    const armor = appearance({
      appearanceId: "armor_base",
      familyId: "chest_tunic",
      assetKey: "armor/chest/armor_base.png",
      equipmentDefinitionId: "padded_tunic"
    });
    const catalog = catalogWith([sword, armor]);
    const enchantedSword = {
      ...equipmentItem("starter_sword", "melee_weapon"),
      enchantmentIdentity: "enh:v1:emerald:venomsteel"
    } as EquipmentInstanceV2;
    const projected = projectPlayerAppearance(
      equipmentSnapshot({ melee: enchantedSword }),
      catalog,
      {}
    );

    expect(projected.slots.melee?.enhancement).toEqual({
      gemstone: "emerald",
      coreId: "venomsteel"
    });
    expect(equipmentGemSocket(catalog, "sword_base")).toEqual({
      partId: "main",
      x: 0.25,
      y: 0.7
    });
    expect(equipmentGemSocket(catalog, "armor_base")).toEqual({
      partId: "main",
      x: 0.5,
      y: 0.5
    });
  });
});

function catalogWith(appearances: AppearanceDefinition[]): PlayerAppearanceCatalog {
  return {
    ...structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
    appearances
  };
}

function appearance(
  overrides: Partial<AppearanceDefinition> & Pick<AppearanceDefinition, "appearanceId">
): AppearanceDefinition {
  const { appearanceId, ...rest } = overrides;
  return {
    appearanceId,
    displayName: appearanceId,
    familyId: "one_handed_sword",
    assetKey: `weapons/${appearanceId}.png`,
    cosmetic: false,
    ...rest
  };
}

function equipmentItem(
  definitionId: EquipmentInstanceV2["definitionId"],
  category: EquipmentInstanceV2["category"]
): EquipmentInstanceV2 {
  return { definitionId, category } as EquipmentInstanceV2;
}

function equipmentSnapshot(
  slots: Partial<EquipmentSnapshotV2["active"]>
): EquipmentSnapshotV2 {
  return {
    playerId: "player-1",
    activeRevision: 7,
    readiedWeaponSlot: "melee",
    active: {
      head: null,
      chest: null,
      gloves: null,
      boots: null,
      ring: null,
      melee: null,
      secondary: null,
      ...slots
    }
  } as EquipmentSnapshotV2;
}
