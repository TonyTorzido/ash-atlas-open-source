import { z } from "zod";

import { playerAppearanceSnapshotSchema } from "../appearance.js";
import { RESOURCE_TYPES } from "../collectibles.js";
import { SWING_MAX_TARGETS, SWING_REJECT_REASONS } from "../actionCombat.js";

import {
  POPULATION_PREPARATION_REASONS,
  type WorldServerMessage
} from "./worldMessages.js";
import {
  latLonServerSchema,
  optionalRequestIdSchema,
  playerDeltaUpsertServerSchema,
  playerSnapshotServerSchema,
  populationEntityServerSchema,
  requestIdSchema,
  serverFrame,
  inventoryServerSchema,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireStringArraySchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

const populationZoneSnapshotServerSchema = z.object({
  zoneId: wireStringSchema,
  generationId: wireStringSchema.nullable(),
  entityIds: wireStringArraySchema
}).passthrough();

const populationZoneEntityServerSchema = populationEntityServerSchema.extend({
  generationId: wireStringSchema.nullable()
});

export const worldServerMessageSchemas = {
  MAP_MARKERS_STATE: serverFrame("MAP_MARKERS_STATE", {
    requestId: optionalRequestIdSchema,
    state: z.object({
      markers: z.array(z.object({ id: wireStringSchema, name: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema, createdAt: wireNumberSchema }).strict()),
      waypoint: z.object({ markerId: wireStringSchema.nullable(), label: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema }).strict().nullable(),
      compass: z.object({ held: wireBooleanSchema, daysUsed: wireNonnegativeIntegerSchema, maxDays: wireNonnegativeIntegerSchema }).strict(),
      kitCount: wireNonnegativeIntegerSchema,
      cartographyRank: wireNonnegativeIntegerSchema,
      markerCap: wireNonnegativeIntegerSchema,
      voyager: z.object({
        rank: wireNonnegativeIntegerSchema,
        recordCost: wireNonnegativeIntegerSchema,
        recordCap: wireNonnegativeIntegerSchema,
        locations: z.array(z.object({ id: wireStringSchema, name: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema, createdAt: wireNumberSchema }).strict())
      }).strict().optional()
    }).strict(),
    notice: wireStringSchema.optional(),
    inventory: inventoryServerSchema.optional()
  }),
  MAP_MARKERS_ERROR: serverFrame("MAP_MARKERS_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema }),
  WORLD_MAP_DESTINATIONS: serverFrame("WORLD_MAP_DESTINATIONS", { requestId: optionalRequestIdSchema, snapshot: z.object({ destinations: z.array(z.object({ kind: z.enum(["city", "manor", "kingdom", "atlas_shrine", "hollin_hut"]), id: wireStringSchema, name: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema, visible: wireBooleanSchema, seatId: wireStringSchema.optional(), region: wireStringSchema.optional() }).passthrough()), markers: z.array(z.object({ kind: z.literal("map_marker"), id: wireStringSchema, name: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema, visible: wireBooleanSchema.optional() }).passthrough()).optional(), caves: z.array(z.object({ id: wireStringSchema, name: wireStringSchema, lat: wireNumberSchema, lon: wireNumberSchema }).passthrough()).optional(), serverTime: wireNumberSchema, socialPlayers: z.array(z.object({ playerId: wireStringSchema, username: wireStringSchema, displayColor: wireStringSchema.nullable().optional(), lat: wireNumberSchema, lon: wireNumberSchema, publishedAt: wireStringSchema, appearance: playerAppearanceSnapshotSchema.optional() }).passthrough()).optional(), socialVisibility: z.object({ friends: wireBooleanSchema, kingdom_members: wireBooleanSchema, city_members: wireBooleanSchema }).optional() }).passthrough() }),
  PLAYER_SNAPSHOT: serverFrame("PLAYER_SNAPSHOT", { serverTime: wireNumberSchema, sequence: wireNonnegativeIntegerSchema, players: z.array(playerSnapshotServerSchema) }),
  PLAYER_DELTA: serverFrame("PLAYER_DELTA", { serverTime: wireNumberSchema, sequence: wireNonnegativeIntegerSchema, upserts: z.array(playerDeltaUpsertServerSchema), removedPlayerIds: wireStringArraySchema }),
  MOVE_ACCEPTED: serverFrame("MOVE_ACCEPTED", {
    requestId: requestIdSchema,
    movementRevision: wireNonnegativeIntegerSchema,
    target: latLonServerSchema,
    speedMps: wireNumberSchema.positive().optional(),
    speedOrigin: latLonServerSchema.optional(),
    speedSegments: z.array(z.object({
      startM: wireNumberSchema.nonnegative(),
      multiplier: wireNumberSchema.positive()
    }).strict()).max(512).optional()
  }),
  DASH_ACCEPTED: serverFrame("DASH_ACCEPTED", {
    requestId: requestIdSchema,
    movementRevision: wireNonnegativeIntegerSchema,
    from: latLonServerSchema,
    to: latLonServerSchema,
    startedAt: wireNumberSchema,
    until: wireNumberSchema,
    cooldownUntil: wireNumberSchema,
    iframeUntil: wireNumberSchema
  }),
  SWING_RESULT: serverFrame("SWING_RESULT", {
    requestId: requestIdSchema,
    seq: wireNonnegativeIntegerSchema,
    serverTick: wireNonnegativeIntegerSchema,
    comboIndex: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    nextSwingAt: wireNumberSchema,
    hits: z.array(z.object({
      entityId: wireStringSchema,
      damage: wireNonnegativeIntegerSchema,
      currentHealth: wireNonnegativeIntegerSchema
    }).strict()).max(SWING_MAX_TARGETS),
    rejected: z.enum(SWING_REJECT_REASONS).optional()
  }),
  RAFT_REQUIRED: serverFrame("RAFT_REQUIRED", {
    requestId: requestIdSchema,
    target: latLonServerSchema,
    cost: z.array(z.object({
      itemId: z.enum(RESOURCE_TYPES),
      quantity: wireNonnegativeIntegerSchema
    }).strict()).max(8)
  }),
  POPULATION_ZONE_DELTA: serverFrame("POPULATION_ZONE_DELTA", {
    playerId: wireStringSchema,
    connectionId: wireStringSchema,
    connectionGeneration: wireNonnegativeIntegerSchema,
    preparationGeneration: wireNonnegativeIntegerSchema,
    preparationTrigger: z.enum([
      "world-entry",
      "reconnect",
      "flag-travel",
      "party-travel",
      "flag-placement",
      "separate-space-exit",
      "administrative-relocation",
      "explicit-relocation",
      "flag-construction"
    ]),
    preparationScope: z.enum([
      "required-visible",
      "prepared-radius",
      "neighbor-preload"
    ]),
    requiredForGameplay: wireBooleanSchema,
    relocationRevision: wireNonnegativeIntegerSchema,
    resourceVisionRevision: wireNonnegativeIntegerSchema,
    gameplayViewGeneration: wireNonnegativeIntegerSchema,
    retainedZoneIds: wireStringArraySchema,
    activatedZoneIds: wireStringArraySchema,
    releasedZoneIds: wireStringArraySchema,
    withheldZoneIds: wireStringArraySchema,
    upserts: z.array(populationZoneEntityServerSchema),
    removedEntityIds: wireStringArraySchema,
    visibleZoneCount: wireNonnegativeIntegerSchema,
    readyVisibleZoneCount: wireNonnegativeIntegerSchema,
    backgroundZoneCount: wireNonnegativeIntegerSchema,
    readyBackgroundZoneCount: wireNonnegativeIntegerSchema,
    zoneSnapshots: z.array(populationZoneSnapshotServerSchema),
    preparationReason: z.enum(POPULATION_PREPARATION_REASONS),
    preparationResult: z.enum([
      "pending",
      "ready",
      "degraded",
      "retryable-failure",
      "stale",
      "cancelled"
    ]),
    partial: wireBooleanSchema,
    terminal: wireBooleanSchema
  }).superRefine((frame, context) => {
    if (frame.readyVisibleZoneCount > frame.visibleZoneCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ready visible population zone count exceeds the visible zone count",
        path: ["readyVisibleZoneCount"]
      });
    }
    if (frame.readyBackgroundZoneCount > frame.backgroundZoneCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ready background population zone count exceeds the background zone count",
        path: ["readyBackgroundZoneCount"]
      });
    }
    if (
      frame.preparationScope === "required-visible" &&
      !frame.requiredForGameplay
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "required visible population preparation must be gameplay-required",
        path: ["requiredForGameplay"]
      });
    }
    if (frame.preparationResult === "degraded") {
      if (frame.withheldZoneIds.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "degraded population preparation must withhold a zone",
          path: ["withheldZoneIds"]
        });
      }
      const released = new Set(frame.releasedZoneIds);
      if (frame.withheldZoneIds.some((zoneId) => !released.has(zoneId))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "withheld population zones must also be released",
          path: ["withheldZoneIds"]
        });
      }
    }
    if (
      frame.preparationResult === "pending"
        ? frame.terminal
        : !frame.terminal
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "population preparation terminal flag does not match its result",
        path: ["terminal"]
      });
    }
  }),
  POPULATION_RESYNC_RESULT: serverFrame("POPULATION_RESYNC_RESULT", {
    requestId: requestIdSchema,
    outcome: z.enum([
      "republished",
      "relocation-started",
      "already-current",
      "rate-limited",
      "ignored-stale",
      "unavailable"
    ]),
    playerId: wireStringSchema,
    connectionId: wireStringSchema,
    connectionGeneration: wireNonnegativeIntegerSchema,
    requestedPreparationGeneration: wireNonnegativeIntegerSchema,
    currentPreparationGeneration: wireNonnegativeIntegerSchema.nullable(),
    requestedRelocationRevision: wireNonnegativeIntegerSchema,
    currentRelocationRevision: wireNonnegativeIntegerSchema,
    requestedResourceVisionRevision: wireNonnegativeIntegerSchema,
    currentResourceVisionRevision: wireNonnegativeIntegerSchema,
    preparationReason: z.enum(POPULATION_PREPARATION_REASONS).nullable(),
    preparationResult: z.enum([
      "pending",
      "ready",
      "degraded",
      "retryable-failure",
      "stale",
      "cancelled"
    ]).nullable(),
    visibleZoneCount: wireNonnegativeIntegerSchema,
    readyVisibleZoneCount: wireNonnegativeIntegerSchema,
    terminal: wireBooleanSchema
  }).superRefine((frame, context) => {
    if (frame.readyVisibleZoneCount > frame.visibleZoneCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ready visible population zone count exceeds the visible zone count",
        path: ["readyVisibleZoneCount"]
      });
    }
  }),
} satisfies Record<WorldServerMessage["type"], z.ZodTypeAny>;
