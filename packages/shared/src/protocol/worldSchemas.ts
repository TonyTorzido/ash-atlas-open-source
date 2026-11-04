import { z } from "zod";

import { SWING_LAG_HINT_MAX_MS } from "../actionCombat.js";
import { worldViewAuthorityServerSchema } from "./serverSchemaPrimitives.js";

const requestIdSchema = z.string().min(1).max(128);

const worldMapSocialAudienceSchema = z.enum([
  "friends",
  "kingdom_members",
  "city_members"
]);

export const moveToMessageSchema = z.object({
  type: z.literal("MOVE_TO"),
  requestId: requestIdSchema,
  boundTravelRequestId: requestIdSchema.optional(),
  /** Confirms a "Launch Raft" prompt: pay the raft cost once for this request id. */
  launchRaft: z.boolean().optional(),
  /**
   * Walking input (joystick, keys, pad). An unrafted walker never gets a raft prompt: the server stops
   * the leg at the shore and slides it along the shore. Taps omit it, so a tap on open water still asks.
   */
  walk: z.boolean().optional(),
  lat: z.number().finite(),
  lon: z.number().finite()
}).strict();

/**
 * Overworld dash. `dirX`/`dirY` is a WORLD-space unit vector (dirX = east, dirY = north),
 * already rotated by the map bearing on the client; the unit length is checked in
 * clientMessageSchema. The server never takes a position from the client.
 * `lastDash` optionally reports the client's measurement of the previous dash so the server logs it.
 */
export const dashMessageSchema = z.object({
  type: z.literal("DASH"),
  requestId: requestIdSchema,
  dirX: z.number().finite().min(-1.05).max(1.05),
  dirY: z.number().finite().min(-1.05).max(1.05),
  lastDash: z.object({
    requestId: requestIdSchema,
    pressToAcceptMs: z.number().finite().min(0).max(60_000),
    correctionM: z.number().finite().min(0).max(100_000),
    startOffsetM: z.number().finite().min(0).max(100_000).optional()
  }).strict().optional()
}).strict();

/**
 * Action combat swing. `dirX`/`dirY` is a WORLD-space unit vector (dirX = east, dirY = north),
 * the same convention as DASH; the unit length is checked in clientMessageSchema. `seq` is
 * per-connection monotonic. `lagMs` is the client's lag hint (rtt/2 + mob render delay), which
 * the server clamps further. No position, target or combo index: the server owns all of those.
 */
export const swingMessageSchema = z.object({
  type: z.literal("SWING"),
  requestId: requestIdSchema,
  seq: z.number().int().nonnegative(),
  dirX: z.number().finite().min(-1.05).max(1.05),
  dirY: z.number().finite().min(-1.05).max(1.05),
  lagMs: z.number().finite().min(0).max(SWING_LAG_HINT_MAX_MS)
}).strict();

export const requestWorldMapDestinationsMessageSchema = z.object({
  type: z.literal("REQUEST_WORLD_MAP_DESTINATIONS"),
  requestId: requestIdSchema
}).strict();

export const setWorldMapDestinationVisibilityDispatchSchema = z.object({
  type: z.literal("SET_WORLD_MAP_DESTINATION_VISIBILITY"),
  requestId: requestIdSchema,
  destinationKind: z.enum(["city", "manor", "kingdom", "atlas_shrine", "hollin_hut"]),
  destinationId: z.string().min(1).max(64),
  visible: z.boolean()
}).strict();
export const setWorldMapDestinationVisibilityMessageSchema =
  setWorldMapDestinationVisibilityDispatchSchema.superRefine(validateDestinationIdentity);

const mapMarkerNameSchema = z.string().min(1).max(100);
const mapMarkerIdSchema = z.string().uuid();

/** Survey Stake Kit / Compass commands; one frame, discriminated by `action`. */
export const mapMarkerCommandMessageSchema = z.object({
  type: z.literal("MAP_MARKER_COMMAND"),
  requestId: requestIdSchema,
  command: z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }).strict(),
    z.object({ action: z.literal("open_compass") }).strict(),
    z.object({ action: z.literal("craft"), item: z.enum(["survey_stake_kit", "compass"]) }).strict(),
    z.object({
      action: z.literal("create"),
      name: mapMarkerNameSchema,
      spot: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("here") }).strict(),
        z.object({ kind: z.literal("point"), lat: z.number().finite(), lon: z.number().finite() }).strict()
      ])
    }).strict(),
    z.object({ action: z.literal("rename"), markerId: mapMarkerIdSchema, name: mapMarkerNameSchema }).strict(),
    z.object({ action: z.literal("delete"), markerId: mapMarkerIdSchema }).strict(),
    z.object({
      action: z.literal("set_waypoint"),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("marker"), markerId: mapMarkerIdSchema }).strict(),
        z.object({ kind: z.literal("recorded"), locationId: mapMarkerIdSchema }).strict(),
        z.object({
          kind: z.literal("destination"),
          destinationKind: z.enum(["city", "manor", "kingdom", "atlas_shrine"]),
          destinationId: z.string().min(1).max(64)
        }).strict()
      ])
    }).strict(),
    z.object({ action: z.literal("clear_waypoint") }).strict(),
    /** Voyager: record the current position (pays refined oil) / forget a recorded location. */
    z.object({ action: z.literal("record_location"), name: mapMarkerNameSchema }).strict(),
    z.object({ action: z.literal("delete_recorded_location"), locationId: mapMarkerIdSchema }).strict()
  ])
}).strict();

export const setWorldMapSocialVisibilityMessageSchema = z.object({
  type: z.literal("SET_WORLD_MAP_SOCIAL_VISIBILITY"),
  requestId: requestIdSchema,
  audience: worldMapSocialAudienceSchema,
  visible: z.boolean()
}).strict();

export const prepareWorldMapTravelDispatchSchema = z.object({
  type: z.literal("PREPARE_WORLD_MAP_TRAVEL"),
  requestId: requestIdSchema,
  destinationKind: z.enum(["city", "manor", "kingdom", "atlas_shrine", "hollin_hut", "pathfinder_mark"]),
  destinationId: z.string().min(1).max(64)
}).strict();
export const prepareWorldMapTravelMessageSchema =
  prepareWorldMapTravelDispatchSchema.superRefine(validateDestinationIdentity);

export function isWorldDestinationIdentityValid(
  destinationKind: "city" | "manor" | "kingdom" | "atlas_shrine" | "hollin_hut" | "pathfinder_mark",
  destinationId: string
): boolean {
  if (destinationKind === "hollin_hut") return /^hollin-hut:[0-9a-f-]{36}$/u.test(destinationId);
  return z.string().uuid().safeParse(destinationId).success;
}

function validateDestinationIdentity(
  value: { destinationKind: "city" | "manor" | "kingdom" | "atlas_shrine" | "hollin_hut" | "pathfinder_mark"; destinationId: string },
  context: z.RefinementCtx
): void {
  if (isWorldDestinationIdentityValid(value.destinationKind, value.destinationId)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["destinationId"],
    message: "Invalid UUID destination id"
  });
}

export const cancelWorldMapTravelMessageSchema = z.object({
  type: z.literal("CANCEL_WORLD_MAP_TRAVEL"),
  requestId: requestIdSchema
}).strict();

export const requestWorldResyncMessageSchema = z.object({
  type: z.literal("REQUEST_WORLD_RESYNC"),
  requestId: requestIdSchema,
  combatSequence: z.number().int().nonnegative(),
  playerSequence: z.number().int().nonnegative(),
  expectedWorldViewAuthority: worldViewAuthorityServerSchema.optional()
}).strict();

export const requestPopulationResyncMessageSchema = z.object({
  type: z.literal("REQUEST_POPULATION_RESYNC"),
  requestId: requestIdSchema,
  connectionId: z.string().min(1).max(160),
  connectionGeneration: z.number().int().nonnegative(),
  preparationGeneration: z.number().int().nonnegative(),
  relocationRevision: z.number().int().nonnegative(),
  resourceVisionRevision: z.number().int().nonnegative(),
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
  ])
}).strict();
