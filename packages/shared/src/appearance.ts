import { z } from "zod";
import { shotProfileForWeapon, type ShotProfile, type ShotProfileFlags } from "./actionCombat.js";

import {
  EQUIPMENT_DEFINITIONS,
  equipmentDefinitionIdSchema,
  type EquipmentDefinitionId,
  type EquipmentSnapshotV2
} from "./equipment.js";
import {
  EQUIPMENT_SLOTS,
  isGatheringToolSlot,
  type EquipmentSlot
} from "./equipmentContracts.js";
import {
  EQUIPMENT_CORE_IDS,
  equipmentAppearanceEnhancement,
  type EquipmentAppearanceEnhancement,
  type EquipmentCoreId
} from "./equipmentEnhancements.js";
import {
  ENCHANTMENT_STONE_VARIANTS,
  type EnchantmentStoneVariant
} from "./progression.js";

export const PLAYER_APPEARANCE_SCHEMA_VERSION = 2 as const;
export const PLAYER_APPEARANCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PLAYER_BODY_VARIANT_ID = "default";
export const DEFAULT_PLAYER_FACE_APPEARANCE_ID = "brown-eyes";
export const PLAYER_COMBAT_POSE_IDS = [
  "idle",
  "combat_ready",
  "attack_action",
  "downed"
] as const;
export type PlayerCombatPoseId = (typeof PLAYER_COMBAT_POSE_IDS)[number];
export const DEFAULT_PLAYER_POSE_ID: PlayerCombatPoseId = "idle";
export const PLAYER_ATTACK_ACTION_WINDOW_MS = 700;

export const PLAYER_BODY_VARIANT_IDS = [
  DEFAULT_PLAYER_BODY_VARIANT_ID
] as const;
export type PlayerBodyVariantId = (typeof PLAYER_BODY_VARIANT_IDS)[number];

/** The three authorable player base skin-tone links. A null link falls back to the base asset. */
export const PLAYER_SKIN_TONE_IDS = [
  "light",
  "medium",
  "dark"
] as const;
export type PlayerSkinToneId = (typeof PLAYER_SKIN_TONE_IDS)[number];
export const DEFAULT_PLAYER_SKIN_TONE_ID: PlayerSkinToneId = "light";
export const PLAYER_SKIN_TONE_LABELS: Readonly<Record<PlayerSkinToneId, string>> =
  Object.freeze({ light: "Light", medium: "Medium", dark: "Dark" });

export function normalizePlayerBodyVariantId(_value: unknown): PlayerBodyVariantId {
  void _value;
  return DEFAULT_PLAYER_BODY_VARIANT_ID;
}

export const PLAYER_POSE_IDS = PLAYER_COMBAT_POSE_IDS;
export type PlayerPoseId = PlayerCombatPoseId | (string & {});

export const PLAYER_OVERLAY_SLOT_IDS = [
  "face",
  "mask",
  "hair",
  "chest",
  "hands",
  "legs",
  "feet",
  "shield",
  "beard"
] as const;
export type PlayerOverlaySlotId = (typeof PLAYER_OVERLAY_SLOT_IDS)[number];

export const PLAYER_AUTHORABLE_OVERLAY_SLOT_IDS = [
  "face",
  "mask",
  "hair",
  "legs",
  "beard"
] as const;
export type PlayerAuthorableOverlaySlotId =
  (typeof PLAYER_AUTHORABLE_OVERLAY_SLOT_IDS)[number];

export const PLAYER_ATTACHMENT_ANCHOR_IDS = [
  "face",
  "chest",
  "legs",
  "left_hand",
  "right_hand",
  "left_foot",
  "right_foot"
] as const;
export type PlayerAttachmentAnchorId =
  (typeof PLAYER_ATTACHMENT_ANCHOR_IDS)[number];

export const PLAYER_RENDER_LAYERS = [
  "back_accessory",
  "back_weapon",
  "rear_hand",
  "shield",
  "body",
  "boots",
  "feet",
  "legs",
  "chest_armor",
  "gloves",
  "hands",
  "head",
  "eyes",
  "nose_mouth",
  "face_accessory",
  "mask",
  "hair",
  "head_armor",
  "front_hand",
  "front_accessory",
  "effects"
] as const;
export type PlayerRenderLayer = (typeof PLAYER_RENDER_LAYERS)[number];

export const PLAYER_AUTHORING_LAYER_IDS = [
  "hair",
  "eyes",
  "nose_mouth",
  "face",
  "mask",
  "body",
  "chest",
  "boots",
  "feet",
  "gloves",
  "hands",
  "legs",
  "primary_weapon",
  "shield"
] as const;
export type PlayerAuthoringLayerId =
  (typeof PLAYER_AUTHORING_LAYER_IDS)[number];

export const PLAYER_AUTHORING_RENDER_LAYER: Readonly<
  Record<PlayerAuthoringLayerId, PlayerRenderLayer>
> = Object.freeze({
  hair: "hair",
  eyes: "eyes",
  nose_mouth: "nose_mouth",
  face: "eyes",
  mask: "mask",
  body: "chest_armor",
  chest: "chest_armor",
  boots: "boots",
  feet: "feet",
  gloves: "gloves",
  hands: "hands",
  legs: "legs",
  primary_weapon: "front_hand",
  shield: "shield"
});

export const PLAYER_APPEARANCE_CATEGORY_IDS = [
  "hair",
  "eyes",
  "nose_mouth",
  "nose",
  "mouth",
  "mask",
  "body_armor",
  "gloves",
  "boots",
  "weapon",
  "shield"
] as const;
export type PlayerAppearanceCategoryId =
  (typeof PLAYER_APPEARANCE_CATEGORY_IDS)[number];

export const PLAYER_STYLE_CATEGORY_IDS = [
  "hair",
  "eyes",
  "nose_mouth",
  "nose",
  "mouth",
  "mask"
] as const;
export type PlayerStyleCategoryId = (typeof PLAYER_STYLE_CATEGORY_IDS)[number];

export const SALON_APPEARANCE_CATEGORY_IDS = [
  "hair",
  "eyes",
  "nose_mouth",
  "nose",
  "mouth",
  "beard",
  "mask",
  "chest",
  "hands",
  "legs",
  "feet",
  "shield"
] as const;
export type SalonAppearanceCategoryId =
  (typeof SALON_APPEARANCE_CATEGORY_IDS)[number];
export const SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS = [
  "hair",
  "eyes",
  "nose",
  "mouth",
  "beard",
  "mask",
  "legs"
] as const satisfies readonly SalonAppearanceCategoryId[];
export type SalonSelectableAppearanceCategoryId =
  (typeof SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS)[number];
export const PLAYER_APPEARANCE_STYLE_IDS = [
  ...SALON_APPEARANCE_CATEGORY_IDS
] as const;
export type PlayerAppearanceStyleId = (typeof PLAYER_APPEARANCE_STYLE_IDS)[number];
export const SALON_APPEARANCE_STATES = [
  "selectable",
  "disabled",
  "retired"
] as const;
export type SalonAppearanceState =
  (typeof SALON_APPEARANCE_STATES)[number];

/** Face features a player may slide inside their category's authored area. */
export const FACE_FEATURE_CATEGORY_IDS = ["eyes", "nose", "mouth"] as const;
export type FaceFeatureCategoryId = (typeof FACE_FEATURE_CATEGORY_IDS)[number];
/** Player-chosen feature points, in face-anchor local units (like placement offsets). */
export type FaceFeaturePoints = Partial<Record<FaceFeatureCategoryId, PlayerAnchorPoint>>;
/** One universal movement area per face category, in face-anchor local units. */
export type FaceFeatureArea = {
  defaultPoint: PlayerAnchorPoint;
  polygon: PlayerAnchorPoint[];
};
export const FACE_FEATURE_COORDINATE_LIMIT = 512;
export const FACE_FEATURE_POLYGON_MAX_VERTICES = 32;

export type SalonAppearanceMetadata = {
  state: SalonAppearanceState;
  sortOrder?: number;
  accessType: "free";
  gameCreditPrice: 0;
  productId: null;
};

export type PlayerSalonStyles = Partial<
  Record<SalonAppearanceCategoryId, AppearanceDefinitionId | null>
> & {
  skinToneId?: PlayerSkinToneId;
  featurePoints?: FaceFeaturePoints;
};

/** Snapshot-only overlay styles that are not part of the durable Salon contract. */
export type PlayerAppearanceStyles = Partial<
  Record<PlayerAppearanceStyleId, AppearanceDefinitionId | null>
> & {
  skinToneId?: PlayerSkinToneId;
  featurePoints?: FaceFeaturePoints;
};

export function normalizePlayerSalonStyles(
  styles: PlayerSalonStyles = {}
): PlayerSalonStyles {
  const {
    nose_mouth: _legacyNoseMouth,
    nose,
    mouth,
    featurePoints,
    ...current
  } = styles;
  void _legacyNoseMouth;
  // Nose, Mouth, and feature points are omitted while unset so snapshots for
  // players who never used them stay byte-identical to the previous contract.
  const points = Object.fromEntries(FACE_FEATURE_CATEGORY_IDS.flatMap((categoryId) => {
    const point = featurePoints?.[categoryId];
    return point ? [[categoryId, { x: point.x, y: point.y }]] : [];
  })) as FaceFeaturePoints;
  return {
    ...current,
    eyes: current.eyes ?? DEFAULT_PLAYER_FACE_APPEARANCE_ID,
    ...(nose ? { nose } : {}),
    ...(mouth ? { mouth } : {}),
    ...(Object.keys(points).length > 0 ? { featurePoints: points } : {}),
    skinToneId: current.skinToneId ?? DEFAULT_PLAYER_SKIN_TONE_ID
  };
}

export const APPEARANCE_PART_IDS = ["main", "left", "right"] as const;
export type AppearancePartId = (typeof APPEARANCE_PART_IDS)[number];

export const APPEARANCE_FAMILY_IDS = [
  "one_handed_sword",
  "one_handed_axe",
  "bow",
  "staff",
  "shield",
  "hair",
  "eyes",
  "nose_mouth",
  "nose",
  "mouth",
  "beard",
  "mask",
  "head_armor",
  "chest_armor",
  "gloves",
  "boots",
  "back_item"
] as const;
export type AppearanceFamilyId =
  (typeof APPEARANCE_FAMILY_IDS)[number] | (string & {});
export type AppearanceDefinitionId = string & {};

export type PlayerAnchorPoint = Readonly<{ x: number; y: number }>;

export type PlayerPoseDefinition = {
  poseId: PlayerPoseId;
  anchors: Record<PlayerAttachmentAnchorId, PlayerAnchorPoint>;
};

export type PlayerTemplateTransform = Readonly<{
  offsetX: number;
  offsetY: number;
  scale: number;
}>;

export const DEFAULT_PLAYER_TEMPLATE_TRANSFORM: PlayerTemplateTransform =
  Object.freeze({ offsetX: 0, offsetY: 0, scale: 1 });

export type PlayerBodyVariantDefinition = {
  bodyVariantId: PlayerBodyVariantId;
  displayName: string;
  mainAnchor?: PlayerAnchorPoint;
  overallScale?: number;
  bodyAssetKeys?: Partial<Record<PlayerCombatPoseId, string>>;
  /** Exactly three linked tone slots; null means this tone still uses the base asset. */
  skinToneAssetKeys?: Partial<Record<PlayerSkinToneId, string | null>>;
  bodyTransforms?: Partial<Record<PlayerCombatPoseId, PlayerTemplateTransform>>;
  /**
   * Optional separate head image per pose. Shares the body canvas and the body
   * transform exactly (no head offset/scale); drawn on the "head" layer so chest
   * armor tucks under it. Absent = the head stays baked into the body image.
   */
  headAssetKeys?: Partial<Record<PlayerCombatPoseId, string>>;
  /** Same tone semantics as skinToneAssetKeys, for the head image. */
  headSkinToneAssetKeys?: Partial<Record<PlayerSkinToneId, string | null>>;
  poses: PlayerPoseDefinition[];
};

export type AppearanceTransform = {
  offsetX: number;
  offsetY: number;
  rotationDegrees: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  pivotY: number;
  visible: boolean;
};

export type AppearancePlacement = AppearanceTransform & {
  anchorId: PlayerAttachmentAnchorId;
  layer: PlayerRenderLayer;
};

export type AppearancePlacementOverride = Partial<AppearancePlacement>;
export type AppearancePosePlacements =
  Partial<Record<PlayerCombatPoseId, AppearancePlacementOverride>>;

export type ProjectileTransform = {
  offsetX: number;
  offsetY: number;
  rotationDegrees: number;
  scaleX: number;
  scaleY: number;
  impactX: number;
  impactY: number;
  tailX: number;
  tailY: number;
};

export const DEFAULT_PROJECTILE_TRANSFORM: Readonly<ProjectileTransform> = {
  offsetX: 0,
  offsetY: 0,
  rotationDegrees: 0,
  scaleX: 1,
  scaleY: 1,
  impactX: 0.5,
  impactY: 0.5,
  tailX: 0,
  tailY: 0.5
};

export type AppearanceFamily = {
  familyId: AppearanceFamilyId;
  displayName: string;
  categoryId: PlayerAppearanceCategoryId;
  authoringLayer: PlayerAuthoringLayerId;
  /** Canonical player overlay target; null means equipment-only artwork such as weapons. */
  playerOverlaySlot?: PlayerOverlaySlotId | null;
  compatibleEquipmentDefinitionIds: EquipmentDefinitionId[];
  inheritsFamilyId?: AppearanceFamilyId;
  placements: Record<PlayerCombatPoseId, AppearancePlacementOverride>;
  /** Eyes/Nose/Mouth only: where players may move this category's feature. */
  featureArea?: FaceFeatureArea;
};

export type AppearanceDefinition = {
  appearanceId: AppearanceDefinitionId;
  displayName: string;
  familyId: AppearanceFamilyId;
  assetKey?: string;
  parts?: AppearancePartDefinition[];
  cosmetic: boolean;
  equipmentDefinitionId?: EquipmentDefinitionId;
  compatibleEquipmentDefinitionIds?: EquipmentDefinitionId[];
  inheritAppearanceId?: AppearanceDefinitionId;
  projectileAssetKey?: string;
  projectileTransform?: ProjectileTransform;
  gemSocket?: EquipmentGemSocket;
  /**
   * Eyes/Nose/Mouth only: the texture point (0..1) that snaps to the player's feature
   * point. Absent = the appearance renders from its placements exactly as before.
   */
  featureAnchor?: PlayerAnchorPoint;
  placements?: AppearancePosePlacements;
  salon?: SalonAppearanceMetadata;
  /** Hidden from authoring menus while retained so existing equipment still renders. */
  retired?: boolean;
};

export type AppearancePartDefinition = {
  partId: AppearancePartId;
  assetKey: string;
  placements?: AppearancePosePlacements;
};

export type EquipmentGemSocket = {
  partId: AppearancePartId;
  x: number;
  y: number;
};

export type EquipmentEnhancementPresentation = {
  gemSizePx: number;
  gemstoneAssetKeys: Record<EnchantmentStoneVariant, string>;
  coreHues: Record<EquipmentCoreId, string>;
};

export const DEFAULT_EQUIPMENT_ENHANCEMENT_PRESENTATION: Readonly<
  EquipmentEnhancementPresentation
> = Object.freeze({
  gemSizePx: 3,
  gemstoneAssetKeys: Object.freeze({
    diamond: "enhancements/gems/diamond.png",
    onyx: "enhancements/gems/onyx.png",
    opal: "enhancements/gems/opal.png",
    amethyst: "enhancements/gems/amethyst.png",
    topaz: "enhancements/gems/topaz.png",
    sapphire: "enhancements/gems/sapphire.png",
    ruby: "enhancements/gems/ruby.png",
    emerald: "enhancements/gems/emerald.png"
  }),
  coreHues: Object.freeze({
    venomsteel: "#58b86f"
  })
});

export type PlayerAppearanceCatalog = {
  schemaVersion: typeof PLAYER_APPEARANCE_SCHEMA_VERSION;
  catalogRevision: number;
  bodyVariants: PlayerBodyVariantDefinition[];
  families: AppearanceFamily[];
  appearances: AppearanceDefinition[];
  enhancementPresentation: EquipmentEnhancementPresentation;
};

export type AppearanceSlotSnapshot = {
  equipmentDefinitionId: EquipmentDefinitionId;
  appearanceId: AppearanceDefinitionId | null;
  cosmeticAppearanceId: AppearanceDefinitionId | null;
  enhancement?: EquipmentAppearanceEnhancement;
};

export type PlayerAppearanceLoadout = {
  bodyVariantId: PlayerBodyVariantId;
  poseId: PlayerPoseId;
  slots: Partial<Record<EquipmentSlot, AppearanceDefinitionId>>;
  selectedCosmetics: Partial<Record<EquipmentSlot, AppearanceDefinitionId | null>>;
};

export type PlayerAppearanceSnapshot = {
  schemaVersion: typeof PLAYER_APPEARANCE_SNAPSHOT_SCHEMA_VERSION;
  catalogRevision: number;
  revision: number;
  bodyVariantId: PlayerBodyVariantId;
  poseId: PlayerPoseId;
  slots: Partial<Record<EquipmentSlot, AppearanceSlotSnapshot>>;
  styles?: PlayerAppearanceStyles;
  activeHand: "melee" | "secondary" | null;
};

const idSchema = z.string().regex(
  /^[a-z0-9][a-z0-9_-]{0,63}$/u,
  "IDs use lowercase letters, digits, underscores, and hyphens"
);
const finiteSchema = z.number().finite();
const assetKeySchema = z.string().min(5).max(240).superRefine((value, context) => {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value) ||
    value.startsWith("//") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !value.toLowerCase().endsWith(".png")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "asset keys must be normalized relative PNG paths"
    });
  }
});

export const playerAttachmentAnchorIdSchema = z.enum(PLAYER_ATTACHMENT_ANCHOR_IDS);
export const playerRenderLayerSchema = z.enum(PLAYER_RENDER_LAYERS);
export const playerAuthoringLayerIdSchema = z.enum(PLAYER_AUTHORING_LAYER_IDS);
export const playerOverlaySlotIdSchema = z.enum(PLAYER_OVERLAY_SLOT_IDS);
export const playerAppearanceCategoryIdSchema = z.enum(PLAYER_APPEARANCE_CATEGORY_IDS);
export const playerStyleCategoryIdSchema = z.enum(PLAYER_STYLE_CATEGORY_IDS);
export const appearancePartIdSchema = z.enum(APPEARANCE_PART_IDS);

export const appearancePlacementOverrideSchema = z.object({
  anchorId: playerAttachmentAnchorIdSchema.optional(),
  layer: playerRenderLayerSchema.optional(),
  offsetX: finiteSchema.min(-512).max(512).optional(),
  offsetY: finiteSchema.min(-512).max(512).optional(),
  rotationDegrees: finiteSchema.min(-3600).max(3600).optional(),
  scaleX: finiteSchema.min(-20).max(20).refine((value) => Math.abs(value) >= 0.01).optional(),
  scaleY: finiteSchema.min(-20).max(20).refine((value) => Math.abs(value) >= 0.01).optional(),
  pivotX: finiteSchema.min(0).max(1).optional(),
  pivotY: finiteSchema.min(0).max(1).optional(),
  visible: z.boolean().optional()
}).strict();

const anchorRecordSchema = z.object(Object.fromEntries(
  PLAYER_ATTACHMENT_ANCHOR_IDS.map((anchorId) => [
    anchorId,
    z.object({ x: finiteSchema, y: finiteSchema }).strict()
  ])
) as unknown as Record<PlayerAttachmentAnchorId, z.ZodTypeAny>).strict();

const templateTransformSchema = z.object({
  offsetX: finiteSchema.min(-512).max(512),
  offsetY: finiteSchema.min(-512).max(512),
  scale: finiteSchema.min(0.05).max(20)
}).strict();

const templateTransformsSchema = z.object({
  idle: templateTransformSchema.optional(),
  combat_ready: templateTransformSchema.optional(),
  attack_action: templateTransformSchema.optional()
}).strict().optional();

const skinToneAssetKeysSchema = z.object(Object.fromEntries(
  PLAYER_SKIN_TONE_IDS.map((skinToneId) => [
    skinToneId,
    assetKeySchema.nullable().optional()
  ])
) as unknown as Record<PlayerSkinToneId, z.ZodTypeAny>).strict().optional();

const bodyVariantSchema = z.object({
  bodyVariantId: z.enum(PLAYER_BODY_VARIANT_IDS),
  displayName: z.string().trim().min(1).max(80),
  mainAnchor: z.object({ x: finiteSchema, y: finiteSchema }).strict().optional(),
  overallScale: finiteSchema.min(0.05).max(20).optional(),
  bodyAssetKeys: z.object({
    idle: assetKeySchema.optional(),
    combat_ready: assetKeySchema.optional(),
    attack_action: assetKeySchema.optional()
  }).strict().optional(),
  skinToneAssetKeys: skinToneAssetKeysSchema,
  bodyTransforms: templateTransformsSchema,
  headAssetKeys: z.object({
    idle: assetKeySchema.optional(),
    combat_ready: assetKeySchema.optional(),
    attack_action: assetKeySchema.optional()
  }).strict().optional(),
  headSkinToneAssetKeys: skinToneAssetKeysSchema,
  poses: z.array(z.object({
    poseId: idSchema,
    anchors: anchorRecordSchema
  }).strict()).min(1)
}).strict();

const faceFeatureCoordinateSchema = finiteSchema
  .min(-FACE_FEATURE_COORDINATE_LIMIT)
  .max(FACE_FEATURE_COORDINATE_LIMIT);
export const faceFeaturePointSchema = z.object({
  x: faceFeatureCoordinateSchema,
  y: faceFeatureCoordinateSchema
}).strict();
export const faceFeaturePointsSchema = z.object({
  eyes: faceFeaturePointSchema.optional(),
  nose: faceFeaturePointSchema.optional(),
  mouth: faceFeaturePointSchema.optional()
}).strict();
const faceFeatureAreaSchema = z.object({
  defaultPoint: faceFeaturePointSchema,
  polygon: z.array(faceFeaturePointSchema).min(3).max(FACE_FEATURE_POLYGON_MAX_VERTICES)
}).strict().superRefine((area, context) => {
  const polygonIssue = faceFeaturePolygonIssue(area.polygon);
  if (polygonIssue) {
    issue(context, ["polygon"], polygonIssue);
    return;
  }
  if (!faceFeaturePointInPolygon(area.defaultPoint, area.polygon)) {
    issue(context, ["defaultPoint"], "the default feature point must be inside the area");
  }
});

const familySchema = z.object({
  familyId: idSchema,
  displayName: z.string().trim().min(1).max(80),
  categoryId: playerAppearanceCategoryIdSchema,
  authoringLayer: playerAuthoringLayerIdSchema,
  playerOverlaySlot: playerOverlaySlotIdSchema.nullable().optional(),
  compatibleEquipmentDefinitionIds: z.array(equipmentDefinitionIdSchema),
  inheritsFamilyId: idSchema.optional(),
  placements: z.object({
    idle: appearancePlacementOverrideSchema,
    combat_ready: appearancePlacementOverrideSchema,
    attack_action: appearancePlacementOverrideSchema
  }).strict(),
  featureArea: faceFeatureAreaSchema.optional()
}).strict();

const appearancePosePlacementsSchema = z.object({
  idle: appearancePlacementOverrideSchema.optional(),
  combat_ready: appearancePlacementOverrideSchema.optional(),
  attack_action: appearancePlacementOverrideSchema.optional()
}).strict().optional();

const appearancePartSchema = z.object({
  partId: appearancePartIdSchema,
  assetKey: assetKeySchema,
  placements: appearancePosePlacementsSchema
}).strict();

const equipmentGemSocketSchema = z.object({
  partId: appearancePartIdSchema,
  x: finiteSchema.min(0).max(1),
  y: finiteSchema.min(0).max(1)
}).strict();

const enhancementPresentationSchema = z.object({
  gemSizePx: finiteSchema.min(0.25).max(32),
  gemstoneAssetKeys: z.object(Object.fromEntries(
    ENCHANTMENT_STONE_VARIANTS.map((gemstone) => [gemstone, assetKeySchema])
  ) as unknown as Record<EnchantmentStoneVariant, z.ZodTypeAny>).strict(),
  coreHues: z.object(Object.fromEntries(
    EQUIPMENT_CORE_IDS.map((coreId) => [
      coreId,
      z.string().regex(/^#[0-9a-f]{6}$/iu, "core hues use six-digit hex colors")
    ])
  ) as unknown as Record<EquipmentCoreId, z.ZodTypeAny>).strict()
}).strict();

const projectileTransformSchema = z.object({
  offsetX: finiteSchema.min(-512).max(512),
  offsetY: finiteSchema.min(-512).max(512),
  rotationDegrees: finiteSchema.min(-3600).max(3600),
  scaleX: finiteSchema.min(-20).max(20).refine((value) => Math.abs(value) >= 0.01),
  scaleY: finiteSchema.min(-20).max(20).refine((value) => Math.abs(value) >= 0.01),
  impactX: finiteSchema.min(0).max(1),
  impactY: finiteSchema.min(0).max(1),
  tailX: finiteSchema.min(0).max(1),
  tailY: finiteSchema.min(0).max(1)
}).strict().superRefine((transform, context) => {
  if (Math.hypot(
    transform.impactX - transform.tailX,
    transform.impactY - transform.tailY
  ) < 0.001) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectile impact and tail points must be different"
    });
  }
});

const appearanceDefinitionSchema = z.object({
  appearanceId: idSchema,
  displayName: z.string().trim().min(1).max(80),
  familyId: idSchema,
  assetKey: assetKeySchema.optional(),
  parts: z.array(appearancePartSchema).min(1).optional(),
  cosmetic: z.boolean(),
  equipmentDefinitionId: equipmentDefinitionIdSchema.optional(),
  compatibleEquipmentDefinitionIds: z.array(equipmentDefinitionIdSchema).optional(),
  inheritAppearanceId: idSchema.optional(),
  projectileAssetKey: assetKeySchema.optional(),
  projectileTransform: projectileTransformSchema.optional(),
  gemSocket: equipmentGemSocketSchema.optional(),
  featureAnchor: z.object({
    x: finiteSchema.min(0).max(1),
    y: finiteSchema.min(0).max(1)
  }).strict().optional(),
  placements: appearancePosePlacementsSchema,
  salon: z.object({
    state: z.enum(SALON_APPEARANCE_STATES),
    sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
    accessType: z.literal("free"),
    gameCreditPrice: z.literal(0),
    productId: z.null()
  }).strict().optional(),
  retired: z.boolean().optional()
}).strict();

const canonicalPlayerAppearanceCatalogSchema = z.object({
  schemaVersion: z.literal(PLAYER_APPEARANCE_SCHEMA_VERSION),
  catalogRevision: z.number().int().nonnegative(),
  bodyVariants: z.array(bodyVariantSchema).min(1),
  families: z.array(familySchema).min(1),
  appearances: z.array(appearanceDefinitionSchema),
  enhancementPresentation: enhancementPresentationSchema
}).strict().superRefine((catalog, context) => {
  uniqueIds(catalog.bodyVariants, "bodyVariantId", context, ["bodyVariants"]);
  uniqueIds(catalog.families, "familyId", context, ["families"]);
  uniqueIds(catalog.appearances, "appearanceId", context, ["appearances"]);

  const bodies = new Map(catalog.bodyVariants.map((body) => [body.bodyVariantId, body]));
  const families = new Map(catalog.families.map((family) => [family.familyId, family]));
  const appearances = new Map(
    catalog.appearances.map((appearance) => [appearance.appearanceId, appearance])
  );
  if (!bodies.has(DEFAULT_PLAYER_BODY_VARIANT_ID)) {
    issue(context, ["bodyVariants"], "the default body variant is required");
  }

  for (const [bodyIndex, body] of catalog.bodyVariants.entries()) {
    uniqueIds(body.poses, "poseId", context, ["bodyVariants", bodyIndex, "poses"]);
    if (
      body.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID &&
      !body.poses.some((pose) => pose.poseId === DEFAULT_PLAYER_POSE_ID)
    ) {
      issue(
        context,
        ["bodyVariants", bodyIndex, "poses"],
        "the default body must provide the world_idle pose"
      );
    }
  }

  const featureAreaCategories = new Set<string>();
  for (const [familyIndex, family] of catalog.families.entries()) {
    if (family.featureArea) {
      const categoryId = salonCategoryForStandaloneFamily(family);
      if (!isFaceFeatureCategory(categoryId)) {
        issue(
          context,
          ["families", familyIndex, "featureArea"],
          "feature areas are only valid for Eyes, Nose, and Mouth families"
        );
      } else if (featureAreaCategories.has(categoryId)) {
        issue(
          context,
          ["families", familyIndex, "featureArea"],
          "each face category has exactly one feature area"
        );
      } else {
        featureAreaCategories.add(categoryId);
      }
    }
    if (family.inheritsFamilyId && !families.has(family.inheritsFamilyId)) {
      issue(
        context,
        ["families", familyIndex, "inheritsFamilyId"],
        "unknown inherited appearance family"
      );
    }
  }
  reportCycles(
    catalog.families,
    (family) => family.familyId,
    (family) => family.inheritsFamilyId,
    context,
    ["families"],
    "appearance family inheritance cycle"
  );

  for (const [appearanceIndex, appearance] of catalog.appearances.entries()) {
    const family = families.get(appearance.familyId);
    if (!family) {
      issue(
        context,
        ["appearances", appearanceIndex, "familyId"],
        "unknown appearance family"
      );
    }
    if (appearance.projectileTransform && !appearance.projectileAssetKey) {
      issue(
        context,
        ["appearances", appearanceIndex, "projectileTransform"],
        "a projectile transform requires projectile artwork"
      );
    }
    if (
      appearance.inheritAppearanceId &&
      !appearances.has(appearance.inheritAppearanceId)
    ) {
      issue(
        context,
        ["appearances", appearanceIndex, "inheritAppearanceId"],
        "unknown inherited appearance"
      );
    }
    if (!appearance.assetKey && !appearance.parts?.length) {
      issue(
        context,
        ["appearances", appearanceIndex],
        "appearances require an asset or at least one positioned part"
      );
    }
    if (appearance.parts) {
      uniqueIds(appearance.parts, "partId", context, [
        "appearances",
        appearanceIndex,
        "parts"
      ]);
    }
    if (appearance.gemSocket) {
      const availableParts = appearance.parts?.length
        ? appearance.parts.map((part) => part.partId)
        : appearance.assetKey ? ["main"] : [];
      if (!availableParts.includes(appearance.gemSocket.partId)) {
        issue(
          context,
          ["appearances", appearanceIndex, "gemSocket", "partId"],
          "gem socket part must reference artwork on the appearance"
        );
      }
    }
    const compatible = new Set([
      ...(family?.compatibleEquipmentDefinitionIds ?? []),
      ...(appearance.compatibleEquipmentDefinitionIds ?? []),
      ...(appearance.equipmentDefinitionId ? [appearance.equipmentDefinitionId] : [])
    ]);
    if (
      appearance.cosmetic && compatible.size === 0 &&
      family && salonCategoryForStandaloneFamily(family) === null
    ) {
      issue(
        context,
        ["appearances", appearanceIndex],
        "cosmetic appearances require explicit or family equipment compatibility"
      );
    }
    if (appearance.featureAnchor && (
      !family || !isFaceFeatureCategory(salonCategoryForStandaloneFamily(family))
    )) {
      issue(
        context,
        ["appearances", appearanceIndex, "featureAnchor"],
        "feature anchors are only valid for Eyes, Nose, and Mouth appearances"
      );
    }
    if (appearance.salon && (
      !family ||
      appearance.equipmentDefinitionId !== undefined ||
      (appearance.compatibleEquipmentDefinitionIds?.length ?? 0) > 0 ||
      salonCategoryForStandaloneFamily(family) === null
    )) {
      issue(
        context,
        ["appearances", appearanceIndex, "salon"],
        "Salon metadata is only valid for standalone player overlay appearances"
      );
    }
  }
  reportCycles(
    catalog.appearances,
    (appearance) => appearance.appearanceId,
    (appearance) => appearance.inheritAppearanceId,
    context,
    ["appearances"],
    "appearance inheritance cycle"
  );
});

export const playerAppearanceCatalogSchema = z.preprocess(
  migrateLegacyPlayerAppearanceCatalog,
  canonicalPlayerAppearanceCatalogSchema
);

export const appearanceSlotSnapshotSchema = z.object({
  equipmentDefinitionId: equipmentDefinitionIdSchema,
  appearanceId: idSchema.nullable(),
  cosmeticAppearanceId: idSchema.nullable(),
  enhancement: z.object({
    gemstone: z.enum(ENCHANTMENT_STONE_VARIANTS),
    coreId: z.enum(EQUIPMENT_CORE_IDS).nullable()
  }).strict().optional()
}).strict();

export const playerAppearanceSnapshotSchema = z.object({
  schemaVersion: z.literal(PLAYER_APPEARANCE_SNAPSHOT_SCHEMA_VERSION),
  catalogRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  bodyVariantId: idSchema,
  poseId: idSchema,
  slots: z.object(Object.fromEntries(
    EQUIPMENT_SLOTS.map((slot) => [slot, appearanceSlotSnapshotSchema.optional()])
  ) as unknown as Record<EquipmentSlot, z.ZodTypeAny>).strict(),
  styles: z.object(Object.fromEntries(
    PLAYER_APPEARANCE_STYLE_IDS.map((categoryId) => [
      categoryId,
      idSchema.nullable().optional()
    ])
  ) as unknown as Record<PlayerAppearanceStyleId, z.ZodTypeAny>).extend({
    skinToneId: z.enum(PLAYER_SKIN_TONE_IDS).optional(),
    featurePoints: faceFeaturePointsSchema.optional()
  }).strict().optional(),
  activeHand: z.enum(["melee", "secondary"]).nullable()
}).strict();

export function parsePlayerAppearanceCatalog(value: unknown): PlayerAppearanceCatalog {
  return playerAppearanceCatalogSchema.parse(value) as PlayerAppearanceCatalog;
}

export function parsePlayerAppearanceSnapshot(value: unknown): PlayerAppearanceSnapshot {
  return playerAppearanceSnapshotSchema.parse(value) as PlayerAppearanceSnapshot;
}

export function authoringLayerForFamilyId(
  familyId: AppearanceFamilyId
): PlayerAuthoringLayerId {
  if (familyId === "head_armor" || familyId === "hair") return "hair";
  if (familyId === "eyes") return "eyes";
  if (familyId === "nose_mouth" || familyId === "nose" || familyId === "mouth") {
    return "nose_mouth";
  }
  if (familyId === "beard") return "face";
  if (familyId === "face") return "face";
  if (familyId === "mask") return "mask";
  if (familyId.startsWith("chest_") || familyId === "body" || familyId === "back_item") {
    return "body";
  }
  if (familyId === "chest") return "chest";
  if (familyId === "hands") return "hands";
  if (familyId === "legs") return "legs";
  if (familyId === "feet") return "feet";
  if (familyId === "boots") return "boots";
  if (familyId === "gloves") return "gloves";
  if (familyId === "shield") return "shield";
  return "primary_weapon";
}

export function playerOverlaySlotForFamily(input: Pick<
  AppearanceFamily,
  "familyId" | "categoryId" | "authoringLayer" | "playerOverlaySlot"
>): PlayerOverlaySlotId | null {
  if (input.playerOverlaySlot !== undefined) return input.playerOverlaySlot;
  if (input.familyId === "beard") return "beard";
  if (input.familyId === "head_armor") return "hair";
  switch (input.authoringLayer) {
    case "hair": return "hair";
    case "eyes":
    case "face": return "face";
    case "nose_mouth": return input.familyId === "beard" ? "beard" : "face";
    case "mask": return "mask";
    case "body":
    case "chest": return input.familyId === "back_item" ? null : "chest";
    case "gloves":
    case "hands": return "hands";
    case "legs": return "legs";
    case "boots":
    case "feet": return "feet";
    case "shield": return "shield";
    case "primary_weapon": return null;
  }
}

export const PLAYER_OVERLAY_RENDER_LAYER: Readonly<Record<
  PlayerOverlaySlotId,
  PlayerRenderLayer
>> = Object.freeze({
  face: "eyes",
  beard: "face_accessory",
  mask: "mask",
  hair: "hair",
  chest: "chest_armor",
  hands: "hands",
  legs: "legs",
  feet: "feet",
  shield: "shield"
});

export const PLAYER_OVERLAY_ANCHOR: Readonly<Record<
  PlayerOverlaySlotId,
  PlayerAttachmentAnchorId
>> = Object.freeze({
  face: "face",
  beard: "face",
  mask: "face",
  hair: "face",
  chest: "chest",
  hands: "left_hand",
  legs: "legs",
  feet: "left_foot",
  shield: "left_hand"
});

export function appearanceCategoryForFamilyId(
  familyId: AppearanceFamilyId
): PlayerAppearanceCategoryId {
  if (familyId === "hair" || familyId === "head_armor") return "hair";
  if (familyId === "eyes" || familyId === "face") return "eyes";
  if (familyId === "nose_mouth") return "nose_mouth";
  if (familyId === "nose") return "nose";
  if (familyId === "mouth") return "mouth";
  if (familyId === "beard") return "nose_mouth";
  if (familyId === "mask") return "mask";
  if (familyId.startsWith("chest_") || familyId === "body" || familyId === "back_item" ||
    familyId === "chest" || familyId === "legs") {
    return "body_armor";
  }
  if (familyId === "gloves" || familyId === "hands") return "gloves";
  if (familyId === "boots" || familyId === "feet") return "boots";
  if (familyId === "shield") return "shield";
  return "weapon";
}

export function appearanceCategory(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId
): PlayerAppearanceCategoryId {
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) throw new Error(`Unknown appearance: ${appearanceId}`);
  return catalog.families.find((family) => family.familyId === appearance.familyId)
    ?.categoryId ?? appearanceCategoryForFamilyId(appearance.familyId);
}

export function appearanceAssetParts(
  appearance: AppearanceDefinition
): AppearancePartDefinition[] {
  if (appearance.parts?.length) return appearance.parts;
  return appearance.assetKey
    ? [{ partId: "main", assetKey: appearance.assetKey }]
    : [];
}

export function equipmentGemSocket(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId
): EquipmentGemSocket {
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) throw new Error(`Unknown appearance: ${appearanceId}`);
  if (appearance.gemSocket) return appearance.gemSocket;
  const partId = appearanceAssetParts(appearance)[0]?.partId ?? "main";
  if (appearanceCategory(catalog, appearanceId) === "weapon") {
    const placement = resolveAppearancePlacement(
      catalog,
      appearanceId,
      DEFAULT_PLAYER_POSE_ID,
      partId
    );
    return { partId, x: placement.pivotX, y: placement.pivotY };
  }
  return { partId, x: 0.5, y: 0.5 };
}

export function appearanceAuthoringLayer(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId
): PlayerAuthoringLayerId {
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) throw new Error(`Unknown appearance: ${appearanceId}`);
  return catalog.families.find((family) => family.familyId === appearance.familyId)
    ?.authoringLayer ?? authoringLayerForFamilyId(appearance.familyId);
}

export function playerBodyPose(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  poseId: PlayerPoseId
): PlayerPoseDefinition {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  const pose = poseFallbackOrder(
    PLAYER_COMBAT_POSE_IDS.includes(poseId as PlayerCombatPoseId)
      ? poseId as PlayerCombatPoseId
      : DEFAULT_PLAYER_POSE_ID
  ).map((candidate) => body?.poses.find((pose) => pose.poseId === candidate))
    .find((candidate) => candidate !== undefined);
  if (!pose) throw new Error("Appearance catalog has no compatible body pose");
  return pose;
}

export function playerBodyAssetKey(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  poseId: PlayerCombatPoseId
): string | null {
  return playerTemplateAssetKey(catalog, bodyVariantId, poseId);
}

export function playerSkinToneAssetKey(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  skinToneId: PlayerSkinToneId
): string | null {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  const assetKey = body?.skinToneAssetKeys?.[skinToneId];
  return typeof assetKey === "string" ? assetKey : null;
}

/** Head image for a tone/pose, or null when the variant has no separate head. */
export function playerHeadAssetKey(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  poseId: PlayerCombatPoseId,
  skinToneId: PlayerSkinToneId
): string | null {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  const toneKey = body?.headSkinToneAssetKeys?.[skinToneId];
  if (typeof toneKey === "string") return toneKey;
  for (const candidate of poseFallbackOrder(poseId)) {
    const assetKey = body?.headAssetKeys?.[candidate];
    if (assetKey) return assetKey;
  }
  return null;
}

export function playerOverallScale(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId
): number {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  return body?.overallScale ?? 1;
}

export function playerMainAnchor(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId
): PlayerAnchorPoint {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  return body?.mainAnchor ?? { x: 0, y: 0 };
}

export function playerTemplateTransform(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  poseId: PlayerCombatPoseId
): PlayerTemplateTransform {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  const transforms = body?.bodyTransforms;
  for (const candidate of poseFallbackOrder(poseId)) {
    const transform = transforms?.[candidate];
    if (transform) return transform;
  }
  return DEFAULT_PLAYER_TEMPLATE_TRANSFORM;
}

function playerTemplateAssetKey(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  poseId: PlayerCombatPoseId
): string | null {
  const body =
    catalog.bodyVariants.find((candidate) => candidate.bodyVariantId === bodyVariantId) ??
    catalog.bodyVariants.find(
      (candidate) => candidate.bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  for (const candidate of poseFallbackOrder(poseId)) {
    const assetKey = body?.bodyAssetKeys?.[candidate];
    if (assetKey) return assetKey;
  }
  return null;
}

export function resolveAppearancePlacement(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  poseId: PlayerCombatPoseId = DEFAULT_PLAYER_POSE_ID,
  partId: AppearancePartId = "main"
): AppearancePlacement {
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) throw new Error(`Unknown appearance: ${appearanceId}`);
  const family = resolveFamilyPlacement(
    catalog,
    appearance.familyId,
    poseId,
    new Set()
  );
  const inherited = appearance.inheritAppearanceId
    ? resolveAppearancePlacementInternal(
        catalog,
        appearance.inheritAppearanceId,
        poseId,
        new Set([appearance.appearanceId])
      )
    : {};
  const part = appearance.parts?.find((candidate) => candidate.partId === partId);
  return completePlacement({
    ...family,
    ...inherited,
    ...resolveAppearancePosePlacement(appearance.placements, poseId),
    ...resolveAppearancePosePlacement(part?.placements, poseId)
  });
}

export function resolveAppearanceLocalTransform(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  poseId: PlayerCombatPoseId = DEFAULT_PLAYER_POSE_ID,
  bodyVariantId: PlayerBodyVariantId = DEFAULT_PLAYER_BODY_VARIANT_ID,
  partId: AppearancePartId = "main",
  featurePoint: PlayerAnchorPoint | null = null
): AppearanceTransform & {
  x: number;
  y: number;
  anchor: PlayerAnchorPoint;
  layer: PlayerRenderLayer;
} {
  const placement = resolveAppearancePlacement(catalog, appearanceId, poseId, partId);
  const anchor = playerBodyPose(catalog, bodyVariantId, poseId).anchors[placement.anchorId];
  const featureAnchor = featurePoint
    ? catalog.appearances.find((candidate) => candidate.appearanceId === appearanceId)
      ?.featureAnchor
    : undefined;
  if (featurePoint && featureAnchor) {
    // Anchored face feature: the artist's texture anchor sits on the player's point.
    return {
      ...placement,
      offsetX: featurePoint.x,
      offsetY: featurePoint.y,
      pivotX: featureAnchor.x,
      pivotY: featureAnchor.y,
      x: anchor.x + featurePoint.x,
      y: anchor.y + featurePoint.y,
      anchor,
      layer: placement.layer
    };
  }
  return {
    ...placement,
    x: anchor.x + placement.offsetX,
    y: anchor.y + placement.offsetY,
    anchor,
    layer: placement.layer
  };
}

export function appearanceCompatibleWithEquipment(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  equipmentDefinitionId: EquipmentDefinitionId
): boolean {
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) return false;
  if (appearance.equipmentDefinitionId === equipmentDefinitionId) return true;
  if (appearance.compatibleEquipmentDefinitionIds?.includes(equipmentDefinitionId)) {
    return true;
  }
  return Boolean(
    catalog.families.find((family) => family.familyId === appearance.familyId)
      ?.compatibleEquipmentDefinitionIds.includes(equipmentDefinitionId)
  );
}

export function baseAppearanceForEquipment(
  catalog: PlayerAppearanceCatalog,
  equipmentDefinitionId: EquipmentDefinitionId
): AppearanceDefinition | null {
  const linkedAppearanceId = EQUIPMENT_DEFINITIONS[equipmentDefinitionId]?.appearanceId;
  if (linkedAppearanceId) {
    const linked = catalog.appearances.find(
      (appearance) => appearance.appearanceId === linkedAppearanceId
    );
    if (linked && !linked.retired) return linked;
  }
  return catalog.appearances.find((appearance) =>
    !appearance.cosmetic &&
    !appearance.retired &&
    appearance.equipmentDefinitionId === equipmentDefinitionId
  ) ?? catalog.appearances.find((appearance) =>
    !appearance.cosmetic &&
    !appearance.retired &&
    appearanceCompatibleWithEquipment(
      catalog,
      appearance.appearanceId,
      equipmentDefinitionId
    )
  ) ?? (linkedAppearanceId
    ? catalog.appearances.find(
      (appearance) => appearance.appearanceId === linkedAppearanceId
    )
    : undefined) ?? catalog.appearances.find((appearance) =>
    !appearance.cosmetic &&
    appearance.equipmentDefinitionId === equipmentDefinitionId
  ) ?? catalog.appearances.find((appearance) =>
    !appearance.cosmetic &&
    appearanceCompatibleWithEquipment(
      catalog,
      appearance.appearanceId,
      equipmentDefinitionId
    )
  ) ?? null;
}

export function visibleAppearanceForSlot(
  catalog: PlayerAppearanceCatalog,
  slot: AppearanceSlotSnapshot
): AppearanceDefinition | null {
  const requestedId = slot.cosmeticAppearanceId ?? slot.appearanceId;
  const requested = requestedId
    ? catalog.appearances.find((appearance) => appearance.appearanceId === requestedId)
    : null;
  return requested ?? baseAppearanceForEquipment(catalog, slot.equipmentDefinitionId);
}

export function activeProjectileAssetKey(
  catalog: PlayerAppearanceCatalog,
  snapshot: PlayerAppearanceSnapshot
): string | null {
  if (!snapshot.activeHand) return null;
  const slot = snapshot.slots[snapshot.activeHand];
  return slot ? visibleAppearanceForSlot(catalog, slot)?.projectileAssetKey ?? null : null;
}

export type ActiveProjectilePresentation = {
  assetKey: string;
  transform: ProjectileTransform;
};

export function projectilePresentationForAppearance(
  appearance: AppearanceDefinition | null | undefined
): ActiveProjectilePresentation | null {
  if (!appearance?.projectileAssetKey) return null;
  return {
    assetKey: appearance.projectileAssetKey,
    transform: appearance.projectileTransform ?? { ...DEFAULT_PROJECTILE_TRANSFORM }
  };
}

export function activeProjectilePresentation(
  catalog: PlayerAppearanceCatalog,
  snapshot: PlayerAppearanceSnapshot
): ActiveProjectilePresentation | null {
  if (!snapshot.activeHand) return null;
  const slot = snapshot.slots[snapshot.activeHand];
  return slot
    ? projectilePresentationForAppearance(visibleAppearanceForSlot(catalog, slot))
    : null;
}

/**
 * The shot rules of the readied weapon in an appearance (actionCombat.ts `shotProfileForWeapon`, from the slot's
 * equipment definition, as the server picks it): the arcane blast for a staff or wand, the holy arc for a scepter
 * (with `flags.holyArc`), the bow's for another ranged
 * weapon, null for a weapon that swings (or none).
 */
export function activeShotProfile(snapshot: PlayerAppearanceSnapshot, flags: ShotProfileFlags = {}): ShotProfile | null {
  if (!snapshot.activeHand) return null;
  const slot = snapshot.slots[snapshot.activeHand];
  const definition = slot ? EQUIPMENT_DEFINITIONS[slot.equipmentDefinitionId] : undefined;
  if (!definition) return null;
  return shotProfileForWeapon(definition.weaponCategory, definition.category === "ranged_weapon", flags);
}

export function isFaceFeatureCategory(value: unknown): value is FaceFeatureCategoryId {
  return FACE_FEATURE_CATEGORY_IDS.includes(value as FaceFeatureCategoryId);
}

/** The one authored movement area for a face category, or null when none is authored. */
export function faceFeatureArea(
  catalog: PlayerAppearanceCatalog,
  categoryId: FaceFeatureCategoryId
): FaceFeatureArea | null {
  return catalog.families.find((family) =>
    family.featureArea !== undefined &&
    salonCategoryForStandaloneFamily(family) === categoryId
  )?.featureArea ?? null;
}

/** Whether a player point is finite and inside the category's current area. */
export function faceFeaturePointAllowed(
  catalog: PlayerAppearanceCatalog,
  categoryId: FaceFeatureCategoryId,
  point: PlayerAnchorPoint
): boolean {
  const area = faceFeatureArea(catalog, categoryId);
  return Boolean(area) &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    faceFeaturePointInPolygon(point, area!.polygon);
}

/**
 * The point a category's feature renders at: the player's point while it is still
 * inside the (possibly redrawn) area, otherwise the area default. Null = no area.
 */
export function resolveFaceFeaturePoint(
  catalog: PlayerAppearanceCatalog,
  categoryId: FaceFeatureCategoryId,
  points: FaceFeaturePoints | undefined
): PlayerAnchorPoint | null {
  const area = faceFeatureArea(catalog, categoryId);
  if (!area) return null;
  const point = points?.[categoryId];
  return point && faceFeaturePointAllowed(catalog, categoryId, point)
    ? { x: point.x, y: point.y }
    : { ...area.defaultPoint };
}

/** Drops stored points that are no longer inside their category's area. */
export function sanitizeFaceFeaturePoints(
  catalog: PlayerAppearanceCatalog,
  points: FaceFeaturePoints | undefined
): FaceFeaturePoints {
  return Object.fromEntries(FACE_FEATURE_CATEGORY_IDS.flatMap((categoryId) => {
    const point = points?.[categoryId];
    return point && faceFeaturePointAllowed(catalog, categoryId, point)
      ? [[categoryId, { x: point.x, y: point.y }]]
      : [];
  })) as FaceFeaturePoints;
}

/** Inclusive point-in-polygon test (points on an edge count as inside). */
export function faceFeaturePointInPolygon(
  point: PlayerAnchorPoint,
  polygon: readonly PlayerAnchorPoint[]
): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++) {
    const first = polygon[current]!;
    const second = polygon[previous]!;
    if (pointSegmentDistance(point, first, second) <= 1e-9) return true;
    if ((first.y > point.y) !== (second.y > point.y) &&
      point.x < (second.x - first.x) * (point.y - first.y) /
        (second.y - first.y) + first.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Null when the polygon is a usable simple area; otherwise the first problem. */
export function faceFeaturePolygonIssue(
  polygon: readonly PlayerAnchorPoint[]
): string | null {
  if (polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return "area coordinates must be finite";
  }
  if (new Set(polygon.map((point) => `${point.x}:${point.y}`)).size < 3) {
    return "an area needs at least 3 distinct points";
  }
  let doubledArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]!;
    const second = polygon[(index + 1) % polygon.length]!;
    doubledArea += first.x * second.y - second.x * first.y;
    if (first.x === second.x && first.y === second.y) {
      return "an area may not repeat a point back to back";
    }
  }
  if (Math.abs(doubledArea) <= 1e-9) return "an area must enclose some space";
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(
        polygon[first]!, polygon[firstNext]!, polygon[second]!, polygon[secondNext]!
      )) return "an area's edges may not cross";
    }
  }
  return null;
}

function pointSegmentDistance(
  point: PlayerAnchorPoint,
  start: PlayerAnchorPoint,
  end: PlayerAnchorPoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function segmentsIntersect(
  a: PlayerAnchorPoint,
  b: PlayerAnchorPoint,
  c: PlayerAnchorPoint,
  d: PlayerAnchorPoint
): boolean {
  const orientation = (p: PlayerAnchorPoint, q: PlayerAnchorPoint, r: PlayerAnchorPoint) =>
    Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  const onSegment = (p: PlayerAnchorPoint, q: PlayerAnchorPoint, r: PlayerAnchorPoint) =>
    q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, c, b)) || (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) || (o4 === 0 && onSegment(c, b, d));
}

export function projectPlayerAppearance(
  equipment: EquipmentSnapshotV2,
  catalog: PlayerAppearanceCatalog,
  selectedCosmetics: Partial<Record<EquipmentSlot, AppearanceDefinitionId | null>> = {},
  activeHandOverride?: "melee" | "secondary" | null,
  bodyVariantId: PlayerBodyVariantId = DEFAULT_PLAYER_BODY_VARIANT_ID,
  styles: PlayerSalonStyles = {}
): PlayerAppearanceSnapshot {
  const slots: Partial<Record<EquipmentSlot, AppearanceSlotSnapshot>> = {};
  const activeHand = activeHandOverride === undefined
    ? activeHandFromEquipment(equipment)
    : activeHandOverride;
  for (const slot of EQUIPMENT_SLOTS) {
    const item = equipment.active[slot];
    // Rings are never drawn; gathering tools are drawn only while gathering (renderer API).
    if (!item || slot === "ring" || isGatheringToolSlot(slot)) continue;
    if (
      (slot === "melee" || slot === "secondary") &&
      item.category !== "shield" &&
      slot !== activeHand
    ) {
      continue;
    }
    const base = baseAppearanceForEquipment(catalog, item.definitionId);
    const selectedCosmetic = selectedCosmetics[slot] ?? null;
    const cosmeticAppearanceId =
      selectedCosmetic &&
      appearanceCompatibleWithEquipment(catalog, selectedCosmetic, item.definitionId)
        ? selectedCosmetic
        : null;
    const enhancement = equipmentAppearanceEnhancement(item.enchantmentIdentity);
    slots[slot] = {
      equipmentDefinitionId: item.definitionId,
      appearanceId: base?.appearanceId ?? null,
      cosmeticAppearanceId,
      ...(enhancement ? { enhancement } : {})
    };
  }
  return {
    schemaVersion: PLAYER_APPEARANCE_SNAPSHOT_SCHEMA_VERSION,
    catalogRevision: catalog.catalogRevision,
    revision: equipment.activeRevision,
    bodyVariantId,
    poseId: DEFAULT_PLAYER_POSE_ID,
    slots,
    styles: normalizePlayerSalonStyles({
      ...styles,
      featurePoints: sanitizeFaceFeaturePoints(catalog, styles.featurePoints)
    }),
    activeHand
  };
}

export function salonAppearanceOptions(
  catalog: PlayerAppearanceCatalog,
  categoryId: SalonAppearanceCategoryId
): AppearanceDefinition[] {
  return catalog.appearances
    .filter((appearance) =>
      salonAppearanceCategory(catalog, appearance) === categoryId &&
      salonAppearanceSelectable(appearance)
    )
    .sort((left, right) =>
      (left.salon?.sortOrder ?? 0) - (right.salon?.sortOrder ?? 0) ||
      left.displayName.localeCompare(right.displayName) ||
      left.appearanceId.localeCompare(right.appearanceId)
    );
}

/** Returns the Salon category for a standalone player overlay. */
export function salonAppearanceCategory(
  catalog: PlayerAppearanceCatalog,
  appearance: AppearanceDefinition
): SalonAppearanceCategoryId | null {
  if (
    appearance.equipmentDefinitionId !== undefined ||
    (appearance.compatibleEquipmentDefinitionIds?.length ?? 0) > 0
  ) {
    return null;
  }
  const family = catalog.families.find((candidate) =>
    candidate.familyId === appearance.familyId
  );
  return family ? salonCategoryForStandaloneFamily(family) : null;
}

/** Whether a mapped standalone overlay may be chosen for a new Salon save. */
export function salonAppearanceSelectable(
  appearance: AppearanceDefinition
): boolean {
  // Masks are paid Glimmer Shop items worn from the inventory (1200), never Salon picks.
  return !appearance.retired &&
    appearance.familyId !== "mask" &&
    appearance.salon?.state !== "disabled" &&
    appearance.salon?.state !== "retired";
}

function salonCategoryForStandaloneFamily(
  family: Pick<
    AppearanceFamily,
    "familyId" | "categoryId" | "authoringLayer" | "compatibleEquipmentDefinitionIds"
  > & { playerOverlaySlot?: PlayerOverlaySlotId | null | undefined }
): SalonAppearanceCategoryId | null {
  if (family.compatibleEquipmentDefinitionIds.length > 0) return null;
  if (family.familyId === "beard") return "beard";
  const overlaySlot = family.playerOverlaySlot !== undefined
    ? family.playerOverlaySlot
    : playerOverlaySlotForFamily({
        familyId: family.familyId,
        categoryId: family.categoryId,
        authoringLayer: family.authoringLayer
      });
  if (family.categoryId === "hair" && overlaySlot === "hair") return "hair";
  if (family.categoryId === "eyes" && overlaySlot === "face") return "eyes";
  if (family.categoryId === "nose_mouth" && overlaySlot === "face") return "nose_mouth";
  if (family.categoryId === "nose" && overlaySlot === "face") return "nose";
  if (family.categoryId === "mouth" && overlaySlot === "face") return "mouth";
  if (family.categoryId === "mask" && overlaySlot === "mask") return "mask";
  if (family.categoryId === "body_armor" && overlaySlot === "legs") return "legs";
  return null;
}

function activeHandFromEquipment(
  equipment: EquipmentSnapshotV2
): "melee" | "secondary" | null {
  const item = equipment.active[equipment.readiedWeaponSlot];
  return item && item.category !== "shield" ? equipment.readiedWeaponSlot : null;
}

function completePlacement(
  placement: AppearancePlacementOverride
): AppearancePlacement {
  return {
    anchorId: placement.anchorId ?? "chest",
    layer: placement.layer ?? "front_accessory",
    offsetX: placement.offsetX ?? 0,
    offsetY: placement.offsetY ?? 0,
    rotationDegrees: placement.rotationDegrees ?? 0,
    scaleX: placement.scaleX ?? 1,
    scaleY: placement.scaleY ?? 1,
    pivotX: placement.pivotX ?? 0.5,
    pivotY: placement.pivotY ?? 0.5,
    visible: placement.visible ?? true
  };
}

function resolveFamilyPlacement(
  catalog: PlayerAppearanceCatalog,
  familyId: AppearanceFamilyId,
  poseId: PlayerCombatPoseId,
  visited: Set<string>
): AppearancePlacementOverride {
  if (visited.has(familyId)) throw new Error("Appearance family inheritance cycle");
  visited.add(familyId);
  const family = catalog.families.find((candidate) => candidate.familyId === familyId);
  if (!family) throw new Error(`Unknown appearance family: ${familyId}`);
  return {
    ...(family.inheritsFamilyId
      ? resolveFamilyPlacement(catalog, family.inheritsFamilyId, poseId, visited)
      : {}),
    ...resolvePosePlacement(family.placements, poseId)
  };
}

function resolveAppearancePlacementInternal(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  poseId: PlayerCombatPoseId,
  visited: Set<string>
): AppearancePlacementOverride {
  if (visited.has(appearanceId)) throw new Error("Appearance inheritance cycle");
  visited.add(appearanceId);
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) throw new Error(`Unknown appearance: ${appearanceId}`);
  return {
    ...(appearance.inheritAppearanceId
      ? resolveAppearancePlacementInternal(
          catalog,
          appearance.inheritAppearanceId,
          poseId,
          visited
        )
      : {}),
    ...resolveAppearancePosePlacement(appearance.placements, poseId)
  };
}

function resolveAppearancePosePlacement(
  placements: AppearancePosePlacements | undefined,
  poseId: PlayerCombatPoseId
): AppearancePlacementOverride {
  if (!placements) return {};
  if (poseId === "idle") return placements.idle ?? {};
  return {
    ...placements.idle,
    ...placements[poseId]
  };
}

function resolvePosePlacement(
  placements: AppearancePosePlacements,
  poseId: PlayerCombatPoseId
): AppearancePlacementOverride {
  for (const candidate of poseFallbackOrder(poseId)) {
    const placement = placements[candidate];
    if (placement) return placement;
  }
  return {};
}

function poseFallbackOrder(poseId: PlayerCombatPoseId): PlayerCombatPoseId[] {
  if (poseId === "attack_action") return ["attack_action", "combat_ready", "idle"];
  if (poseId === "combat_ready") return ["combat_ready", "idle"];
  return ["idle"];
}

function migrateLegacyPlayerAppearanceCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const catalog = structuredClone(value) as Record<string, unknown>;
  if (catalog.schemaVersion === 1) catalog.schemaVersion = PLAYER_APPEARANCE_SCHEMA_VERSION;
  if (!catalog.enhancementPresentation) {
    catalog.enhancementPresentation = structuredClone(
      DEFAULT_EQUIPMENT_ENHANCEMENT_PRESENTATION
    );
  }
  if (Array.isArray(catalog.bodyVariants)) {
    catalog.bodyVariants = catalog.bodyVariants.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const body = entry as Record<string, unknown>;
      if (!body.bodyAssetKeys && typeof body.bodyAssetKey === "string") {
        body.bodyAssetKeys = { idle: body.bodyAssetKey };
      }
      if (!body.skinToneAssetKeys) {
        body.skinToneAssetKeys = Object.fromEntries(
          PLAYER_SKIN_TONE_IDS.map((skinToneId) => [skinToneId, null])
        );
      }
      delete body.bodyAssetKey;
      // Legacy split-head catalogs carried a separate headTransforms; current
      // heads share the body transform, so only drop head art from the legacy shape.
      if (body.headTransforms !== undefined) delete body.headAssetKeys;
      delete body.headTransforms;
      delete body.headAssetKey;
      const poses = Array.isArray(body.poses) ? body.poses : [];
      const legacyIdle = poses.find((pose) =>
        pose && typeof pose === "object" &&
        (pose as Record<string, unknown>).poseId === "world_idle"
      ) as Record<string, unknown> | undefined;
      const idle = poses.find((pose) =>
        pose && typeof pose === "object" &&
        (pose as Record<string, unknown>).poseId === "idle"
      ) as Record<string, unknown> | undefined;
      if (!idle && legacyIdle) {
        const idlePose = { ...legacyIdle, poseId: "idle" };
        body.poses = [
          idlePose,
          combatBodyPose(idlePose, "combat_ready"),
          combatBodyPose(idlePose, "attack_action")
        ];
      }
      const currentPoses = Array.isArray(body.poses) ? body.poses : [];
      const idlePose = currentPoses.find((pose) =>
        pose && typeof pose === "object" &&
        (pose as Record<string, unknown>).poseId === "idle"
      ) as Record<string, unknown> | undefined;
      if (idlePose) {
        const sharedAnchors = normalizeBodyAnchors(idlePose.anchors);
        body.poses = currentPoses.map((pose) => {
          if (!pose || typeof pose !== "object" || Array.isArray(pose)) return pose;
          return { ...pose, anchors: structuredClone(sharedAnchors) };
        });
      }
      return body;
    }).filter((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry) &&
      (entry as Record<string, unknown>).bodyVariantId === DEFAULT_PLAYER_BODY_VARIANT_ID
    );
  }
  if (Array.isArray(catalog.families)) {
    catalog.families = catalog.families.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const family = entry as Record<string, unknown>;
      if (!family.authoringLayer) {
        family.authoringLayer = authoringLayerForFamilyId(
          String(family.familyId ?? "")
        );
      }
      if (!family.categoryId) {
        family.categoryId = appearanceCategoryForFamilyId(
          String(family.familyId ?? "")
        );
      }
      if (!("playerOverlaySlot" in family)) {
        family.playerOverlaySlot = playerOverlaySlotForFamily({
          familyId: String(family.familyId ?? ""),
          categoryId: String(family.categoryId ?? "weapon") as PlayerAppearanceCategoryId,
          authoringLayer: String(family.authoringLayer ?? "primary_weapon") as PlayerAuthoringLayerId
        });
      }
      if (!family.placements && family.placement && typeof family.placement === "object") {
        const idle = withoutLegacyPose(family.placement as Record<string, unknown>);
        family.placements = {
          idle,
          combat_ready: generatedFamilyPlacement(
            String(family.familyId ?? ""),
            idle,
            "combat_ready"
          ),
          attack_action: generatedFamilyPlacement(
            String(family.familyId ?? ""),
            idle,
            "attack_action"
          )
        };
        delete family.placement;
      }
      stripPlacementBodyVariants(family.placements);
      normalizePlacementAnchors(family.placements);
      return family;
    });
  }
  if (Array.isArray(catalog.appearances)) {
    catalog.appearances = catalog.appearances.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const appearance = entry as Record<string, unknown>;
      if (!appearance.placements && appearance.placement) {
        appearance.placements = {
          idle: withoutLegacyPose(appearance.placement as Record<string, unknown>)
        };
        delete appearance.placement;
      }
      stripPlacementBodyVariants(appearance.placements);
      normalizePlacementAnchors(appearance.placements);
      if (Array.isArray(appearance.parts)) {
        for (const part of appearance.parts) {
          if (!part || typeof part !== "object" || Array.isArray(part)) continue;
          const record = part as Record<string, unknown>;
          stripPlacementBodyVariants(record.placements);
          normalizePlacementAnchors(record.placements);
        }
      }
      return appearance;
    });
  }
  return catalog;
}

function normalizeBodyAnchors(value: unknown): Record<PlayerAttachmentAnchorId, PlayerAnchorPoint> {
  const anchors = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, PlayerAnchorPoint | undefined>
    : {};
  const origin = { x: 0, y: 0 };
  return {
    face: structuredClone(anchors.face ?? anchors.head ?? origin),
    chest: structuredClone(anchors.chest ?? anchors.waist ?? anchors.back ?? origin),
    legs: structuredClone(anchors.legs ?? anchors.chest ?? anchors.waist ?? origin),
    left_hand: structuredClone(anchors.left_hand ?? origin),
    right_hand: structuredClone(anchors.right_hand ?? origin),
    left_foot: structuredClone(anchors.left_foot ?? anchors.feet_center ?? origin),
    right_foot: structuredClone(anchors.right_foot ?? anchors.feet_center ?? origin)
  };
}

function normalizePlacementAnchors(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const replacements: Record<string, PlayerAttachmentAnchorId> = {
    head: "face",
    waist: "chest",
    back: "chest",
    feet_center: "left_foot"
  };
  for (const placement of Object.values(value as Record<string, unknown>)) {
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) continue;
    const record = placement as Record<string, unknown>;
    if (typeof record.anchorId === "string" && replacements[record.anchorId]) {
      record.anchorId = replacements[record.anchorId];
    }
  }
}

function stripPlacementBodyVariants(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const placement of Object.values(value as Record<string, unknown>)) {
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) continue;
    delete (placement as Record<string, unknown>).bodyVariantId;
  }
}

function withoutLegacyPose(
  placement: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...placement };
  delete next.poseId;
  return next;
}

function combatBodyPose(
  idlePose: Record<string, unknown>,
  poseId: "combat_ready" | "attack_action"
): Record<string, unknown> {
  const anchors = structuredClone(idlePose.anchors) as Record<
    string,
    { x: number; y: number }
  >;
  return { ...idlePose, poseId, anchors };
}

function generatedFamilyPlacement(
  familyId: string,
  idle: Record<string, unknown>,
  poseId: "combat_ready" | "attack_action"
): Record<string, unknown> {
  const next = { ...idle };
  const ready = poseId === "combat_ready";
  switch (familyId) {
    case "one_handed_sword":
      return {
        ...next,
        offsetX: ready ? 1 : 5,
        offsetY: ready ? -2 : -1,
        rotationDegrees: ready ? -55 : 55
      };
    case "one_handed_axe":
      return {
        ...next,
        offsetX: ready ? 1 : 5,
        offsetY: ready ? -2 : -1,
        rotationDegrees: ready ? -50 : 65
      };
    case "bow":
      return {
        ...next,
        anchorId: "left_hand",
        offsetX: ready ? -1 : 1,
        offsetY: ready ? 0 : 1,
        rotationDegrees: ready ? -90 : -72
      };
    case "staff":
      return {
        ...next,
        offsetX: ready ? 1 : 5,
        offsetY: ready ? -2 : -1,
        rotationDegrees: ready ? -35 : 25
      };
    case "shield":
      return {
        ...next,
        offsetX: ready ? -1 : -2,
        offsetY: ready ? -1 : 0,
        rotationDegrees: ready ? -10 : -16
      };
    default:
      return next;
  }
}

function uniqueIds<T extends Record<Key, string>, Key extends keyof T & string>(
  entries: T[],
  key: Key,
  context: z.RefinementCtx,
  path: (string | number)[]
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry[key])) {
      issue(context, [...path, index, key], `duplicate ${key}: ${entry[key]}`);
    }
    seen.add(entry[key]);
  }
}

function reportCycles<T>(
  entries: T[],
  id: (entry: T) => string,
  parent: (entry: T) => string | undefined,
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string
): void {
  const byId = new Map(entries.map((entry) => [id(entry), entry]));
  for (const [index, entry] of entries.entries()) {
    const visited = new Set<string>();
    let current: T | undefined = entry;
    while (current) {
      const currentId = id(current);
      if (visited.has(currentId)) {
        issue(context, [...path, index], message);
        break;
      }
      visited.add(currentId);
      const next = parent(current);
      current = next ? byId.get(next) : undefined;
    }
  }
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
