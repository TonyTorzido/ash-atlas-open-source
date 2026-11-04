import { z } from "zod";

const requestId = z.string().min(1).max(128);
const portalId = z.string().min(1).max(256);

export const usePortalMessageSchema = z.object({
  type: z.literal("USE_PORTAL"), requestId, portalId,
  expectedPortalRevision: z.string().min(1).max(128).optional(),
  expectedLocationRevision: z.number().int().nonnegative(),
  approach: z.enum(["normal", "immediate"]).optional(),
  /** Dungeon entry: which lantern pays when the player carries both. */
  lantern: z.enum(["cinder", "challenger"]).optional()
}).strict();

export const cancelPortalTransitionMessageSchema = z.object({
  type: z.literal("CANCEL_PORTAL_TRANSITION"), requestId,
  transitionId: z.string().min(1).max(128)
}).strict();

export const portalDestinationReadyMessageSchema = z.object({
  type: z.literal("PORTAL_DESTINATION_READY"),
  transitionId: z.string().min(1).max(128),
  sceneKey: z.string().min(1).max(256)
}).strict();

export const portalClientMessageSchemas = [
  usePortalMessageSchema, cancelPortalTransitionMessageSchema,
  portalDestinationReadyMessageSchema
] as const;

export type PortalClientMessage = z.infer<(typeof portalClientMessageSchemas)[number]>;
