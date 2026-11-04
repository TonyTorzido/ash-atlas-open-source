import { z } from "zod";

import {
  GENERAL_SKILL_IDS,
  SPECIALIZATION_IDS,
  WORLD_KNOWLEDGE_SKILL_IDS,
  isGeneralActiveSlotId,
  type GeneralActiveSlotId
} from "../skillSystemV3.js";

const requestIdSchema = z.string().min(1).max(128);
const expectedRevisionSchema = z.number().int().safe().nonnegative();
const generalSkillIdSchema = z.enum(GENERAL_SKILL_IDS);
const specializationIdSchema = z.enum(SPECIALIZATION_IDS);
const targetModeSchema = z.enum(["hostile", "friendly", "self", "position", "direction"]);
const generalActiveSlotSchema = z.custom<GeneralActiveSlotId>(isGeneralActiveSlotId, "General Active slot must be 1 or 2");

export const requestSkillTreeSnapshotMessageSchema = z.object({
  type: z.literal("REQUEST_SKILL_TREE_SNAPSHOT"),
  requestId: requestIdSchema
}).strict();

const refundableSkillPointTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("general_skill"), skillId: generalSkillIdSchema }).strict(),
  z.object({ kind: z.literal("specialization"), specializationId: specializationIdSchema }).strict()
]);

const spendSkillPointTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("general_skill"), skillId: generalSkillIdSchema }).strict(),
  z.object({ kind: z.literal("specialization"), specializationId: specializationIdSchema }).strict(),
  z.object({ kind: z.literal("world_knowledge"), skillId: z.enum(WORLD_KNOWLEDGE_SKILL_IDS) }).strict()
]);

export const spendSkillPointMessageSchema = z.object({
  type: z.literal("SPEND_SKILL_POINT"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  target: spendSkillPointTargetSchema
}).strict();

export const refundSkillRankMessageSchema = z.object({
  type: z.literal("REFUND_SKILL_RANK"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  target: refundableSkillPointTargetSchema
}).strict();

export const activateSpecializationMessageSchema = z.object({
  type: z.literal("ACTIVATE_SPECIALIZATION"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  specializationId: specializationIdSchema.nullable()
}).strict();

export const equipGeneralActiveMessageSchema = z.object({
  type: z.literal("EQUIP_GENERAL_ACTIVE"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  slot: generalActiveSlotSchema,
  skillId: generalSkillIdSchema.nullable()
}).strict();

export const equipClassTechniqueMessageSchema = z.object({
  type: z.literal("EQUIP_CLASS_TECHNIQUE"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  techniqueId: z.string().min(1).max(64)
}).strict();

export const useGeneralActiveMessageSchema = z.object({
  type: z.literal("USE_GENERAL_ACTIVE"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  // Edict Stride is a World Knowledge active that shares this activation path.
  skillId: z.union([generalSkillIdSchema, z.literal("edict_stride")]),
  targetEntityId: z.string().min(1).max(160).optional(),
  targetMode: targetModeSchema.optional(),
  targetPosition: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180)
  }).strict().optional(),
  directionDegrees: z.number().finite().min(0).lt(360).optional()
}).strict();

export const resetOwnDevSkillTreeMessageSchema = z.object({
  type: z.literal("RESET_OWN_DEV_SKILL_TREE"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema
}).strict();

/** One-time discovery offering for an Advanced General skill (items from the overworld). */
export const offerSkillUnlockMessageSchema = z.object({
  type: z.literal("OFFER_SKILL_UNLOCK"),
  requestId: requestIdSchema,
  skillId: generalSkillIdSchema
}).strict();

export const respecSkillBuildMessageSchema = z.object({
  type: z.literal("RESPEC_SKILL_BUILD"),
  requestId: requestIdSchema,
  expectedRevision: expectedRevisionSchema,
  /** The Glimmer price shown on the confirm; required while the reset fee is on. */
  expectedGlimmerCost: z.number().int().nonnegative().max(1_000_000).optional()
}).strict();

export type SkillSystemV3ClientMessage =
  | z.infer<typeof requestSkillTreeSnapshotMessageSchema>
  | z.infer<typeof spendSkillPointMessageSchema>
  | z.infer<typeof refundSkillRankMessageSchema>
  | z.infer<typeof activateSpecializationMessageSchema>
  | z.infer<typeof equipGeneralActiveMessageSchema>
  | z.infer<typeof equipClassTechniqueMessageSchema>
  | z.infer<typeof useGeneralActiveMessageSchema>
  | z.infer<typeof respecSkillBuildMessageSchema>
  | z.infer<typeof offerSkillUnlockMessageSchema>
  | z.infer<typeof resetOwnDevSkillTreeMessageSchema>;
