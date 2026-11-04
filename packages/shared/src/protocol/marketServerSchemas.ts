import type { z } from "zod";

import {
  marketServerMessageSchema,
  type MarketServerMessage
} from "../marketProtocol.js";

export const marketServerMessageSchemas = {
  MARKET_OPEN_RESULT: marketServerMessageSchema,
  MARKET_BROWSE_RESULT: marketServerMessageSchema,
  MARKET_BOOK_RESULT: marketServerMessageSchema,
  MARKET_QUOTE_RESULT: marketServerMessageSchema,
  MARKET_MUTATION_RESULT: marketServerMessageSchema,
  MARKET_SUBSCRIPTIONS_SET: marketServerMessageSchema,
  MARKET_ITEM_SUMMARY_CHANGED: marketServerMessageSchema,
  MARKET_BOOK_CHANGED: marketServerMessageSchema,
  MARKET_PLAYER_STATE_CHANGED: marketServerMessageSchema,
  MARKET_ASSETS_CHANGED: marketServerMessageSchema,
  MARKET_ERROR: marketServerMessageSchema
} satisfies Record<MarketServerMessage["type"], z.ZodTypeAny>;
