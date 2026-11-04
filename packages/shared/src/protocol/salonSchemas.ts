import { z } from "zod";

import { faceFeaturePointsSchema, PLAYER_SKIN_TONE_IDS } from "../appearance.js";

const requestId = z.string().min(1).max(128);
const sessionId = z.string().uuid();
const appearanceId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).nullable();

export const enterSalonMessageSchema = z.object({
  type: z.literal("ENTER_SALON"),
  requestId,
  structureId: z.string().uuid(),
  expectedPlacementRevision: z.string().regex(/^[1-9]\d*$/u)
}).strict();

export const salonMoveToMessageSchema = z.object({
  type: z.literal("SALON_MOVE_TO"),
  requestId,
  salonSessionId: sessionId,
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

export const exitSalonMessageSchema = z.object({
  type: z.literal("EXIT_SALON"),
  requestId,
  salonSessionId: sessionId
}).strict();

export const beginSalonCustomizeMessageSchema = z.object({
  type: z.literal("BEGIN_SALON_CUSTOMIZE"),
  requestId,
  salonSessionId: sessionId,
  movementSequence: z.number().int().nonnegative()
}).strict();

export const saveSalonAppearanceMessageSchema = z.object({
  type: z.literal("SAVE_SALON_APPEARANCE"),
  requestId,
  editorSessionId: sessionId,
  expectedAppearanceRevision: z.number().int().nonnegative(),
  catalogRevision: z.number().int().nonnegative(),
  changes: z.object({
    hair: appearanceId.optional(),
    eyes: appearanceId.optional(),
    nose_mouth: appearanceId.optional(),
    nose: appearanceId.optional(),
    mouth: appearanceId.optional(),
    beard: appearanceId.optional(),
    mask: appearanceId.optional(),
    chest: appearanceId.optional(),
    hands: appearanceId.optional(),
    legs: appearanceId.optional(),
    feet: appearanceId.optional(),
    shield: appearanceId.optional(),
    skinToneId: z.enum(PLAYER_SKIN_TONE_IDS).optional(),
    featurePoints: faceFeaturePointsSchema.optional()
  }).strict().refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one appearance change is required"
  })
}).strict();

/**
 * Wear a mask from the inventory (Glimmer Shop, 1200), or take it off with null. Works anywhere;
 * the server refuses a mask the player does not hold.
 */
export const equipMaskMessageSchema = z.object({
  type: z.literal("EQUIP_MASK"),
  requestId,
  /** The face_mask copy (its inventory variant) to wear, or null to take the mask off. */
  copyId: z.string().uuid().nullable()
}).strict();

export const cancelSalonCustomizeMessageSchema = z.object({
  type: z.literal("CANCEL_SALON_CUSTOMIZE"),
  requestId,
  editorSessionId: sessionId
}).strict();
