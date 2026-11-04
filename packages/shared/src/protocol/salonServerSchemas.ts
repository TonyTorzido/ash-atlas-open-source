import { z } from "zod";

import { playerAppearanceSnapshotSchema } from "../appearance.js";
import type { SalonServerMessage } from "./salonMessages.js";
import {
  optionalRequestIdSchema,
  requestIdSchema,
  playerSnapshotServerSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";
import { faceFeaturePointsSchema, PLAYER_SKIN_TONE_IDS } from "../appearance.js";

const position = z.object({
  x: wireNumberSchema,
  y: wireNumberSchema,
  targetX: wireNumberSchema.nullable(),
  targetY: wireNumberSchema.nullable(),
  moving: wireBooleanSchema,
  revision: wireNonnegativeIntegerSchema
}).strict();
const styles = z.object({
  hair: wireStringSchema.nullable().optional(),
  eyes: wireStringSchema.nullable().optional(),
  nose_mouth: wireStringSchema.nullable().optional(),
  nose: wireStringSchema.nullable().optional(),
  mouth: wireStringSchema.nullable().optional(),
  beard: wireStringSchema.nullable().optional(),
  mask: wireStringSchema.nullable().optional(),
  chest: wireStringSchema.nullable().optional(),
  hands: wireStringSchema.nullable().optional(),
  legs: wireStringSchema.nullable().optional(),
  feet: wireStringSchema.nullable().optional(),
  shield: wireStringSchema.nullable().optional(),
  skinToneId: z.enum(PLAYER_SKIN_TONE_IDS).optional(),
  featurePoints: faceFeaturePointsSchema.optional()
}).strict();

export const salonServerMessageSchemas = {
  SALON_ENTERED: serverFrame("SALON_ENTERED", { requestId: optionalRequestIdSchema, structureId: wireStringSchema, salonSessionId: wireStringSchema, displayColor: wireStringSchema.nullable(), appearance: playerAppearanceSnapshotSchema.optional(), position, movementSequence: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema }),
  SALON_POSITION: serverFrame("SALON_POSITION", { salonSessionId: wireStringSchema, position, movementSequence: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema }),
  SALON_EDITOR_OPENED: serverFrame("SALON_EDITOR_OPENED", { requestId: requestIdSchema, editorSessionId: wireStringSchema, releaseSha: wireStringSchema.nullable(), catalogRevision: wireNonnegativeIntegerSchema, schemaVersion: wireNonnegativeIntegerSchema, appearanceRevision: wireNonnegativeIntegerSchema, styles }),
  SALON_EDITOR_CANCELLED: serverFrame("SALON_EDITOR_CANCELLED", { requestId: optionalRequestIdSchema }),
  SALON_APPEARANCE_SAVED: serverFrame("SALON_APPEARANCE_SAVED", { requestId: requestIdSchema, appearanceRevision: wireNonnegativeIntegerSchema, styles, appearance: playerAppearanceSnapshotSchema, replayed: wireBooleanSchema, price: z.literal(0) }),
  SALON_EXITED: serverFrame("SALON_EXITED", { requestId: optionalRequestIdSchema, reason: wireStringSchema.optional(), player: playerSnapshotServerSchema }),
  MASK_EQUIPPED: serverFrame("MASK_EQUIPPED", { requestId: requestIdSchema, maskAppearanceId: wireStringSchema.nullable(), maskCopyId: z.string().uuid().nullable(), appearanceRevision: wireNonnegativeIntegerSchema, styles, appearance: playerAppearanceSnapshotSchema, replayed: wireBooleanSchema, message: wireStringSchema }),
  SALON_ERROR: serverFrame("SALON_ERROR", { requestId: optionalRequestIdSchema, code: wireStringSchema, message: wireStringSchema })
} satisfies Record<SalonServerMessage["type"], z.ZodTypeAny>;
