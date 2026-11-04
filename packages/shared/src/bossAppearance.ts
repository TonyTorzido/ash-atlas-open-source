import { z } from "zod";

import {
  MOB_ARCHETYPE_KEYS,
  type MobArchetypeKey
} from "./combat.js";
import {
  PLAYER_COMBAT_POSE_IDS,
  type AppearancePlacementOverride,
  type AppearanceTransform,
  type PlayerCombatPoseId
} from "./appearance.js";
import { WORLD_OBJECT_ZOOM_POLICY } from "./runtimePngPresentation.js";

export const BOSS_APPEARANCE_SCHEMA_VERSION = 1 as const;
export type BossAppearanceId = string & {};

export type BossSpritePresentation = Readonly<{
  baseHeightPx: number;
  minHeightPx: number;
  maxHeightPx: number | null;
  zoomStrength: number;
  anchorX: number;
  anchorY: number;
  hitRadiusPx: number;
}>;

export type BossWeaponAppearance = {
  assetKey: string | null;
  placements: Partial<Record<PlayerCombatPoseId, AppearancePlacementOverride>>;
};

export type BossAppearanceDefinition = {
  bossId: BossAppearanceId;
  displayName: string;
  archetypeKey: MobArchetypeKey;
  bodyAssetKey: string;
  overallScale?: number;
  presentation: BossSpritePresentation;
  weapon: BossWeaponAppearance;
};

export type BossAppearanceCatalog = {
  schemaVersion: typeof BOSS_APPEARANCE_SCHEMA_VERSION;
  catalogRevision: number;
  bosses: BossAppearanceDefinition[];
};

export const DEFAULT_BOSS_WEAPON_TRANSFORM: Readonly<AppearanceTransform> =
  Object.freeze({
    offsetX: 0,
    offsetY: 0,
    rotationDegrees: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0.5,
    pivotY: 0.5,
    visible: true
  });

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
const transformOverrideSchema = z.object({
  offsetX: finiteSchema.optional(),
  offsetY: finiteSchema.optional(),
  rotationDegrees: finiteSchema.optional(),
  scaleX: finiteSchema.positive().optional(),
  scaleY: finiteSchema.positive().optional(),
  pivotX: finiteSchema.optional(),
  pivotY: finiteSchema.optional(),
  visible: z.boolean().optional()
}).strict();
const posePlacementsSchema = z.object(Object.fromEntries(
  PLAYER_COMBAT_POSE_IDS.map((poseId) => [poseId, transformOverrideSchema.optional()])
) as Record<PlayerCombatPoseId, z.ZodOptional<typeof transformOverrideSchema>>).strict();
const presentationSchema = z.object({
  baseHeightPx: finiteSchema.positive(),
  minHeightPx: finiteSchema.positive(),
  maxHeightPx: finiteSchema.positive().nullable(),
  zoomStrength: finiteSchema.nonnegative(),
  anchorX: finiteSchema,
  anchorY: finiteSchema,
  hitRadiusPx: finiteSchema.positive()
}).strict().superRefine((presentation, context) => {
  if (presentation.minHeightPx > presentation.baseHeightPx) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minimum boss height cannot exceed base height"
    });
  }
  if (presentation.maxHeightPx !== null && presentation.baseHeightPx > presentation.maxHeightPx) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "base boss height cannot exceed maximum height"
    });
  }
});
const bossDefinitionSchema = z.object({
  bossId: idSchema,
  displayName: z.string().trim().min(1).max(80),
  archetypeKey: z.enum(MOB_ARCHETYPE_KEYS),
  bodyAssetKey: assetKeySchema,
  overallScale: finiteSchema.min(0.05).max(20).optional(),
  presentation: presentationSchema,
  weapon: z.object({
    assetKey: assetKeySchema.nullable(),
    placements: posePlacementsSchema
  }).strict()
}).strict();
const bossAppearanceCatalogSchema = z.object({
  schemaVersion: z.literal(BOSS_APPEARANCE_SCHEMA_VERSION),
  catalogRevision: z.number().int().nonnegative(),
  bosses: z.array(bossDefinitionSchema).min(1)
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  const archetypes = new Set<string>();
  for (const [index, boss] of catalog.bosses.entries()) {
    if (ids.has(boss.bossId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bosses", index, "bossId"],
        message: `duplicate boss ID: ${boss.bossId}`
      });
    }
    if (archetypes.has(boss.archetypeKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bosses", index, "archetypeKey"],
        message: `duplicate boss archetype: ${boss.archetypeKey}`
      });
    }
    ids.add(boss.bossId);
    archetypes.add(boss.archetypeKey);
    if (Math.abs(
      boss.presentation.minHeightPx -
      boss.presentation.baseHeightPx * WORLD_OBJECT_ZOOM_POLICY.minScale
    ) > 1e-9) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["bosses", index, "presentation", "minHeightPx"], message: "Boss minimum height must follow the world-object zoom policy" });
    }
    const maxScale = WORLD_OBJECT_ZOOM_POLICY.maxScale;
    const maximumMatchesPolicy = maxScale === null
      ? boss.presentation.maxHeightPx === null
      : boss.presentation.maxHeightPx !== null &&
        Math.abs(
          boss.presentation.maxHeightPx - boss.presentation.baseHeightPx * maxScale
        ) <= 1e-9;
    if (!maximumMatchesPolicy) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["bosses", index, "presentation", "maxHeightPx"], message: "Boss maximum height must follow the world-object zoom policy" });
    }
    if (boss.presentation.zoomStrength !== WORLD_OBJECT_ZOOM_POLICY.zoomStrength) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["bosses", index, "presentation", "zoomStrength"], message: "Boss zoom strength must follow the world-object zoom policy" });
    }
  }
});

export function parseBossAppearanceCatalog(value: unknown): BossAppearanceCatalog {
  return bossAppearanceCatalogSchema.parse(value) as BossAppearanceCatalog;
}

export function bossAppearanceForArchetype(
  catalog: BossAppearanceCatalog,
  archetypeKey: MobArchetypeKey | null
): BossAppearanceDefinition | null {
  return catalog.bosses.find((boss) => boss.archetypeKey === archetypeKey) ?? null;
}

export function requireBossAppearance(
  catalog: BossAppearanceCatalog,
  bossId: BossAppearanceId
): BossAppearanceDefinition {
  const boss = catalog.bosses.find((candidate) => candidate.bossId === bossId);
  if (!boss) throw new Error(`Unknown designated boss: ${bossId}`);
  return boss;
}

export function resolveBossWeaponTransform(
  catalog: BossAppearanceCatalog,
  bossId: BossAppearanceId,
  poseId: PlayerCombatPoseId
): AppearanceTransform {
  const weapon = requireBossAppearance(catalog, bossId).weapon;
  const idle = weapon.placements.idle ?? {};
  const pose = poseId === "idle" ? {} : weapon.placements[poseId] ?? {};
  return {
    ...DEFAULT_BOSS_WEAPON_TRANSFORM,
    ...idle,
    ...pose
  };
}

export function bossOverallScale(
  catalog: BossAppearanceCatalog,
  bossId: BossAppearanceId
): number {
  return requireBossAppearance(catalog, bossId).overallScale ?? 1;
}

export function bossAppearanceAssetKeys(
  catalog: BossAppearanceCatalog
): string[] {
  return catalog.bosses.flatMap((boss) => [
    boss.bodyAssetKey,
    ...(boss.weapon.assetKey ? [boss.weapon.assetKey] : [])
  ]);
}
