import type { z } from "zod";

import type { PartyServerMessage } from "./partyMessages.js";
import {
  partyCombatDeltaSchema,
  partyCombatSnapshotSchema,
  partyReadyCheckServerMessageSchema,
  partyServerMessageSchema
} from "./partySchemas.js";

export const partyServerMessageSchemas = {
  PARTY_SNAPSHOT: partyServerMessageSchema,
  PARTY_COMBAT_SNAPSHOT: partyCombatSnapshotSchema,
  PARTY_COMBAT_DELTA: partyCombatDeltaSchema,
  PARTY_READY_CHECK_SNAPSHOT: partyReadyCheckServerMessageSchema
} satisfies Record<PartyServerMessage["type"], z.ZodTypeAny>;
