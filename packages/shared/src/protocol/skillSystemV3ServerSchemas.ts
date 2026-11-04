import { z } from "zod";

import {
  GENERAL_SKILL_IDS,
  SPECIALIZATION_IDS,
  WORLD_KNOWLEDGE_SKILL_IDS
} from "../skillSystemV3.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import type { SkillSystemV3ServerMessage } from "./skillSystemV3Messages.js";

const requestIdSchema = z.string().min(1).max(128);
const integerSchema = z.number().int().safe().nonnegative();
const generalSkillIdSchema = z.enum(GENERAL_SKILL_IDS);
const specializationIdSchema = z.enum(SPECIALIZATION_IDS);

export const skillSystemV3SnapshotSchema = z.object({
  playerId: z.string().min(1),
  characterLevel: integerSchema,
  pointState: z.object({
    totalEarned: integerSchema.max(50),
    totalSpent: integerSchema.max(50),
    available: integerSchema.max(50),
    revision: integerSchema
  }).strict(),
  generalSkills: z.array(z.object({
    skillId: generalSkillIdSchema,
    rank: integerSchema.max(3),
    pointsSpent: integerSchema.max(4)
  }).strict()).max(GENERAL_SKILL_IDS.length),
  specializations: z.array(z.object({
    specializationId: specializationIdSchema,
    rank: integerSchema.max(5),
    pointsSpent: integerSchema.max(9),
    grandfathered: z.boolean(),
    masteryQuestCompleted: z.boolean()
  }).strict()).max(SPECIALIZATION_IDS.length),
  committedSpecializationId: specializationIdSchema.nullable(),
  activeSpecializationId: specializationIdSchema.nullable(),
  equippedClassTechniqueId: z.null(),
  fullBuildRespecAvailable: z.boolean(),
  fullClassRosterEnabled: z.boolean(),
  ultimatesEnabled: z.boolean(),
  generalActiveLoadout: z.tuple([generalSkillIdSchema.nullable(), generalSkillIdSchema.nullable()]),
  ultimate: z.object({
    id: z.string().min(1).max(160),
    specializationId: specializationIdSchema,
    status: z.enum(["ready", "cooldown", "pending_design"])
  }).strict().nullable(),
  cooldownEndsAt: z.record(z.string().min(1).max(160), z.number().finite().nonnegative()),
  worldKnowledge: z.array(z.object({
    skillId: z.enum(WORLD_KNOWLEDGE_SKILL_IDS),
    revealed: z.boolean(),
    rank: integerSchema.max(3),
    pointsSpent: integerSchema.max(4)
  }).strict()).max(WORLD_KNOWLEDGE_SKILL_IDS.length),
  serverTime: z.number().finite().nonnegative(),
  revision: integerSchema
}).strict().superRefine((snapshot, context) => {
  if (snapshot.pointState.available !== snapshot.pointState.totalEarned - snapshot.pointState.totalSpent) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pointState", "available"], message: "Available Skill Points must equal earned minus spent" });
  }
  if (snapshot.revision !== snapshot.pointState.revision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "Snapshot and point-state revisions must match" });
  }
  if (new Set(snapshot.generalSkills.map(({ skillId }) => skillId)).size !== snapshot.generalSkills.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["generalSkills"], message: "General skills must be unique" });
  }
  if (new Set(snapshot.specializations.map(({ specializationId }) => specializationId)).size !== snapshot.specializations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["specializations"], message: "Specializations must be unique" });
  }
  if (snapshot.committedSpecializationId !== null && snapshot.activeSpecializationId !== null && snapshot.activeSpecializationId !== snapshot.committedSpecializationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeSpecializationId"], message: "Only the committed specialization may be active" });
  }
  if (!snapshot.ultimatesEnabled && snapshot.ultimate !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ultimate"], message: "Ultimate projection must be empty while Ultimates are disabled" });
  }
  if (snapshot.ultimate?.status !== "pending_design") {
    const active = snapshot.specializations.find((entry) => entry.specializationId === snapshot.activeSpecializationId);
    if (snapshot.ultimate !== null && (active?.rank ?? 0) < 5) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["ultimate"], message: "Ultimate requires specialization Rank 5" });
    }
    if (snapshot.ultimate !== null && active?.masteryQuestCompleted !== true) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["ultimate"], message: "Implemented Ultimate requires Mastery Trial completion" });
    }
  }
});

export const skillSystemV3ServerMessageSchemas = {
  SKILL_TREE_SNAPSHOT: z.object({
    type: z.literal("SKILL_TREE_SNAPSHOT"),
    requestId: requestIdSchema,
    snapshot: skillSystemV3SnapshotSchema
  }).strict(),
  SKILL_MUTATION_CONFIRMED: z.object({
    type: z.literal("SKILL_MUTATION_CONFIRMED"),
    requestId: requestIdSchema,
    action: z.enum(["spend", "refund", "equip", "use", "respec", "dev_reset", "offer"]),
    replayed: z.boolean(),
    snapshot: skillSystemV3SnapshotSchema,
    /** Only after a paid respec (sent only to clients that sent expectedGlimmerCost). */
    premiumWallet: premiumWalletSnapshotSchema.optional()
  }).strict(),
  SPECIALIZATION_MUTATION_CONFIRMED: z.object({
    type: z.literal("SPECIALIZATION_MUTATION_CONFIRMED"),
    requestId: requestIdSchema,
    action: z.enum(["spend", "refund", "activate"]),
    specializationId: specializationIdSchema.nullable(),
    replayed: z.boolean(),
    snapshot: skillSystemV3SnapshotSchema
  }).strict(),
  SKILL_UNLOCK_STATE: z.object({
    type: z.literal("SKILL_UNLOCK_STATE"),
    discoveredGeneralSkills: z.array(generalSkillIdSchema).max(GENERAL_SKILL_IDS.length),
    classWrits: z.array(specializationIdSchema).max(SPECIALIZATION_IDS.length)
  }).strict()
} satisfies Record<SkillSystemV3ServerMessage["type"], z.ZodTypeAny>;
