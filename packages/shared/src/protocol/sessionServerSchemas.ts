import { z } from "zod";

import { DEVELOPER_CAPABILITIES } from "../auth.js";
import { bugReportSubmitResultServerSchema } from "../bugReports.js";
import { RESOURCE_TYPES } from "../collectibles.js";
import { MOB_ARCHETYPE_KEYS } from "../combat.js";
import { marketIntegerSchema } from "../marketProtocol.js";
import { glimmerCostsSnapshotSchema, premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import { ashAtlasProtocolWelcomeMetadataSchema } from "../protocolCompatibility.js";
import { versionClientsSchema } from "../version.js";
import { WORLD_ZONE_BIOMES, WORLD_ZONE_DISCOVERABLE_BIOMES, WORLD_ZONE_TAGS } from "../worldZones.js";
import type { SessionServerMessage } from "./sessionMessages.js";
import {
  latLonServerSchema,
  optionalRequestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

const creatureBookHabitatRestrictionSchema = z.discriminatedUnion("groupId", [
  z.object({
    groupId: z.literal("environment"),
    categoryIds: z.array(z.enum([
      "jungle",
      "pinewild",
      "greenwood",
      "frostwood",
      "plains",
      "savanna",
      "marsh",
      "highmeadow",
      "scrubland",
      "badlands",
      "steppe",
      "tundra",
      "frozen_waste"
    ])).min(1),
    label: z.string().min(1)
  }).strict(),
  z.object({
    groupId: z.literal("elevation"),
    categoryIds: z.array(z.enum(["low", "moderate", "high", "extreme"])).min(1),
    label: z.string().min(1)
  }).strict(),
  z.object({
    groupId: z.literal("terrain"),
    categoryIds: z.array(z.enum(["flat", "hilly", "mountainous"])).min(1),
    label: z.string().min(1)
  }).strict(),
  z.object({
    groupId: z.literal("ocean_depth"),
    categoryIds: z.array(z.enum(["nearshore", "shallow", "deep", "abyssal"])).min(1),
    label: z.string().min(1)
  }).strict()
]);
const creatureBookHabitatRestrictionsSchema = z.array(creatureBookHabitatRestrictionSchema)
  .min(1)
  .superRefine((restrictions, context) => {
    const seenGroupIds = new Set<string>();
    for (const [index, restriction] of restrictions.entries()) {
      if (seenGroupIds.has(restriction.groupId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Habitat restriction group IDs must be unique",
          path: [index, "groupId"]
        });
      }
      seenGroupIds.add(restriction.groupId);
    }
  });

export const sessionServerMessageSchemas = {
  BUG_REPORT_SUBMIT_RESULT: bugReportSubmitResultServerSchema,
  SESSION_REPLACED: serverFrame("SESSION_REPLACED", { message: wireStringSchema }),
  BIOME_DISCOVERY_SNAPSHOT: serverFrame("BIOME_DISCOVERY_SNAPSHOT", {
    biomes: z.array(z.enum(WORLD_ZONE_DISCOVERABLE_BIOMES)).max(WORLD_ZONE_DISCOVERABLE_BIOMES.length),
    newlyDiscovered: z.enum(WORLD_ZONE_DISCOVERABLE_BIOMES).nullable(),
    current: z.object({
      biome: z.enum(WORLD_ZONE_BIOMES),
      tags: z.array(z.enum(WORLD_ZONE_TAGS)).max(WORLD_ZONE_TAGS.length),
      heightWord: z.string().max(32).nullable(),
      authority: z.enum(["world", "fallback"])
    }).strict().nullable(),
    celebration: z.object({
      biome: z.enum(WORLD_ZONE_DISCOVERABLE_BIOMES),
      achievements: z.array(z.object({
        id: z.string().min(1).max(64),
        title: z.string().min(1).max(120),
        points: z.number().int().min(0).max(10_000),
        honor: z.string().min(1).max(120).optional()
      }).strict()).max(32)
    }).strict().nullable()
  }),
  CREATURE_BOOK_SNAPSHOT: serverFrame("CREATURE_BOOK_SNAPSHOT", {
    snapshot: z.object({
      slots: z.array(z.union([
        z.object({ bookOrder: wireNonnegativeIntegerSchema, unlocked: z.literal(false) }).strict(),
        z.object({
          bookOrder: wireNonnegativeIntegerSchema,
          unlocked: z.literal(true),
          archetypeKey: z.enum(MOB_ARCHETYPE_KEYS),
          name: wireStringSchema,
          rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]),
          ashenUnlocked: z.boolean(),
          habitat: z.union([
            z.object({ kind: z.literal("natural"), progress: wireNonnegativeIntegerSchema, threshold: wireNonnegativeIntegerSchema, restrictions: creatureBookHabitatRestrictionsSchema.nullable(), active: z.enum(["any_time", "day", "night"]) }).strict(),
            z.object({ kind: z.literal("legendary"), habitat: z.literal("N/A"), active: z.literal("any_time") }).strict()
          ]),
          killCount: wireNonnegativeIntegerSchema.nullable(),
          drops: z.array(z.union([
            z.object({ slotOrder: wireNonnegativeIntegerSchema, observed: z.literal(false) }).strict(),
            z.object({ slotOrder: wireNonnegativeIntegerSchema, observed: z.literal(true), itemId: wireStringSchema, displayName: wireStringSchema, occurrenceCount: wireNonnegativeIntegerSchema, observedRate: wireNumberSchema }).strict()
          ]))
        }).strict()
      ])),
      plants: z.array(z.union([
        z.object({ bookOrder: wireNonnegativeIntegerSchema, unlocked: z.literal(false) }).strict(),
        z.object({
          bookOrder: wireNonnegativeIntegerSchema,
          unlocked: z.literal(true),
          plantKey: wireStringSchema,
          name: wireStringSchema,
          rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]),
          active: wireNonnegativeIntegerSchema,
          totalHarvests: wireNonnegativeIntegerSchema,
          habitat: z.object({
            kind: z.literal("natural"),
            progress: wireNonnegativeIntegerSchema,
            threshold: wireNonnegativeIntegerSchema,
            restrictions: creatureBookHabitatRestrictionsSchema.nullable()
          }).strict()
        }).strict()
      ])).optional()
    }).strict()
  }),
  AUTH_SESSION_INVALID: serverFrame("AUTH_SESSION_INVALID", {
    code: z.enum([
      "SESSION_EXPIRED",
      "ACCOUNT_SUSPENDED",
      "SESSION_REVOKED",
      "TEST_ACCESS_PENDING",
      "TEST_ACCESS_DENIED",
      "TEST_ACCESS_REVOKED"
    ]),
    message: wireStringSchema
  }),
  WELCOME: serverFrame("WELCOME", { playerId: wireStringSchema, username: wireStringSchema, spawn: latLonServerSchema, anchor: latLonServerSchema, moveLeashRadiusM: wireNumberSchema, flagClaimRadiusM: wireNumberSchema, flagBuildRecipe: z.array(z.object({ itemId: z.enum(RESOURCE_TYPES), quantity: wireNonnegativeIntegerSchema }).strict()).optional(), buoyBuildRecipe: z.array(z.object({ itemId: z.enum(RESOURCE_TYPES), quantity: wireNonnegativeIntegerSchema }).strict()).optional(), playerSpeedMps: wireNumberSchema, serverTickHz: wireNumberSchema, regionCode: wireStringSchema, zoneId: wireStringSchema, worldAuthorityEpoch: wireStringSchema.optional(), connectionId: wireStringSchema.optional(), connectionGeneration: wireNonnegativeIntegerSchema.optional(), gameplayViewGeneration: wireNonnegativeIntegerSchema.optional(), relocationRevision: wireNonnegativeIntegerSchema.optional(), resourceVisionRevision: wireNonnegativeIntegerSchema.optional(), developerCapabilities: z.array(z.enum(DEVELOPER_CAPABILITIES)), bugReportsEnabled: wireBooleanSchema.optional(), actionCombat: wireBooleanSchema.optional(), clericArc: wireBooleanSchema.optional(), wallet: z.object({ playerId: wireStringSchema, gold: marketIntegerSchema, revision: marketIntegerSchema }).strict().optional(), premiumWallet: premiumWalletSnapshotSchema.optional(), glimmerCosts: glimmerCostsSnapshotSchema.optional(), hunger: z.object({ current: wireNonnegativeIntegerSchema, baseCapacity: wireNonnegativeIntegerSchema }).strict().optional(), serverTime: wireNumberSchema, releaseSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), protocol: ashAtlasProtocolWelcomeMetadataSchema.optional(), clients: versionClientsSchema.optional(), serverVersion: z.string().min(1).max(80).nullable().optional(), protocolMin: z.number().int().positive().max(1_000_000).optional(), protocolMax: z.number().int().positive().max(1_000_000).optional(), publicVersion: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u).nullable().optional(), generation: z.string().regex(/^test\/t[0-9]{3,}$/u).nullable().optional() }),
  PRESENTATION_SNAPSHOT_COMPLETE: serverFrame("PRESENTATION_SNAPSHOT_COMPLETE", {
    connectionId: wireStringSchema,
    connectionGeneration: wireNonnegativeIntegerSchema,
    gameplayViewGeneration: wireNonnegativeIntegerSchema,
    relocationRevision: wireNonnegativeIntegerSchema,
    resourceVisionRevision: wireNonnegativeIntegerSchema,
    populationPreparationGeneration: wireNonnegativeIntegerSchema
  }),
  ERROR: serverFrame("ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema, retryable: wireBooleanSchema.optional(), details: z.object({ dropId: wireStringSchema.optional(), nodeId: wireStringSchema.optional(), sessionId: wireStringSchema.optional(), remainingQuantity: wireNonnegativeIntegerSchema.optional(), retryAfterMs: wireNonnegativeIntegerSchema.optional(), stateRevision: wireNonnegativeIntegerSchema.optional(), populationV2StateRevision: wireNonnegativeIntegerSchema.optional(), authoritativeDistanceM: wireNonnegativeIntegerSchema.optional(), maximumDistanceM: wireNonnegativeIntegerSchema.optional(), reconciliation: z.enum(["remove-node", "refresh-node"]).optional(), sessionStatusBeforeCleanup: z.enum(["active", "completed", "cancelled", "expired"]).optional(), sessionStatusAfterCleanup: z.enum(["active", "completed", "cancelled", "expired"]).optional(), terminalCleanupOutcome: z.enum(["cancelled", "expired", "already-terminal", "completed", "not-found"]).optional(), currentTollGold: marketIntegerSchema.optional(), requiredGold: marketIntegerSchema.optional(), targetEntityId: wireStringSchema.optional(), relocationRevision: wireNonnegativeIntegerSchema.optional(), resourceVisionRevision: wireNonnegativeIntegerSchema.optional(), gameplayViewGeneration: wireNonnegativeIntegerSchema.optional(), presentationOwner: z.enum(["population", "repeatable-resource", "resource-vision"]).optional(), combatValidationPredicate: wireStringSchema.optional(), attackerZoneId: wireStringSchema.optional(), targetZoneId: wireStringSchema.optional(), attackerRegionCode: wireStringSchema.optional(), targetRegionCode: wireStringSchema.optional(), attackerInsideAuthoritativeView: wireBooleanSchema.optional(), targetInsideAuthoritativeView: wireBooleanSchema.optional() }).passthrough().optional() }),
  PONG: serverFrame("PONG", { clientTime: wireNumberSchema, serverTime: wireNumberSchema })
} satisfies Record<SessionServerMessage["type"], z.ZodTypeAny>;
