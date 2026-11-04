import { z } from "zod";

import { requestIdSchema } from "./serverSchemaPrimitives.js";

/**
 * Device coordinates intentionally remain unknown at the wire boundary. The
 * server performs the authoritative finite WGS84 validation so malformed
 * clients receive a normal, attributable relocation failure instead of a
 * parser-level disconnect. `deviceTimeZone` (IANA name from the device) is a
 * trust-ledger feature only; the server ignores it when malformed. `native`
 * (see nativeLocationSignalsSchema) and `attestationRef` are optional device
 * trust fields, sent only when the session advertises
 * `trustNativeSignalsAccepted`; the server parses them leniently.
 */
export const relocateToCurrentLocationMessageSchema = z.object({
  type: z.literal("RELOCATE_TO_CURRENT_LOCATION"),
  requestId: requestIdSchema,
  lat: z.unknown(),
  lon: z.unknown(),
  accuracy: z.unknown().optional(),
  deviceTimeZone: z.unknown().optional(),
  native: z.unknown().optional(),
  attestationRef: z.unknown().optional()
}).strict();

/**
 * Passive device fix for the location trust ledger. Sent only when the
 * session advertises `trustPassiveFixEnabled` and the device already holds
 * location permission. Fire-and-forget: the server never replies, rate-limits
 * silently, and ignores malformed fields for the same reason as above.
 * `reason` is one of LOCATION_FIX_REASONS; any other value is ignored.
 */
export const locationFixMessageSchema = z.object({
  type: z.literal("LOCATION_FIX"),
  lat: z.unknown(),
  lon: z.unknown(),
  accuracy: z.unknown().optional(),
  deviceTimeZone: z.unknown().optional(),
  reason: z.unknown().optional(),
  native: z.unknown().optional(),
  attestationRef: z.unknown().optional()
}).strict();

// "pre_action" is no longer sent; old clients may still send it and the server
// treats it like "periodic". action_* fixes are fire-and-forget native checks
// sent beside a land action by unsettled accounts (never PvP or combat).
export const LOCATION_FIX_REASONS = [
  "periodic",
  "pre_action",
  "action_flag_place",
  "action_flag_attack",
  "action_city_found"
] as const;
export type LocationFixReason = (typeof LOCATION_FIX_REASONS)[number];
