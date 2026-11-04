import {
  marketServerMessageSchema,
  type MarketServerMessage
} from "@ash-atlas/shared";

export function isMarketServerMessageCandidate(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && value.type.startsWith("MARKET_");
}

/** Runtime guard for the market-only portion of the otherwise legacy typed server protocol. */
export function isRuntimeMarketServerMessage(value: unknown): value is MarketServerMessage {
  return marketServerMessageSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
