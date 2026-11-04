import type { MarketInteger } from "@ash-atlas/shared";

const MARKET_INTEGER_PATTERN = /^(0|[1-9]\d{0,18})$/;
const POSITIVE_MARKET_INTEGER_PATTERN = /^[1-9]\d{0,18}$/;

export function parseMarketInteger(value: MarketInteger): bigint {
  if (!MARKET_INTEGER_PATTERN.test(value)) {
    throw new Error("Invalid market integer");
  }
  return BigInt(value);
}

export function formatMarketInteger(value: MarketInteger | bigint): string {
  const parsed = typeof value === "bigint" ? value : parseMarketInteger(value);
  return parsed.toLocaleString("en-US");
}

export function formatGold(value: MarketInteger | bigint): string {
  return `${formatMarketInteger(value)} gold`;
}

/** Formats an amount in a book's price currency (Gold when omitted). */
export function formatPrice(value: MarketInteger | bigint, priceCurrency: "gold" | "glimmer" = "gold"): string {
  return priceCurrency === "glimmer" ? `${formatMarketInteger(value)} Glimmer` : formatGold(value);
}

export function normalizePositiveMarketInput(value: string): MarketInteger | null {
  const normalized = value.trim().replace(/^0+(?=\d)/, "");
  return POSITIVE_MARKET_INTEGER_PATTERN.test(normalized) ? normalized : null;
}

export function multiplyMarketIntegers(
  left: MarketInteger,
  right: MarketInteger
): bigint {
  return parseMarketInteger(left) * parseMarketInteger(right);
}

export function calculateMarketFee(value: bigint, basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    return 0n;
  }
  return (value * BigInt(basisPoints)) / 10_000n;
}

export function compareMarketIntegers(
  left: MarketInteger | null,
  right: MarketInteger | null,
  nullsLast = true
): number {
  if (left === right) return 0;
  if (left === null) return nullsLast ? 1 : -1;
  if (right === null) return nullsLast ? -1 : 1;
  const leftValue = parseMarketInteger(left);
  const rightValue = parseMarketInteger(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function isQuoteExpired(expiresAt: string, now = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  return !Number.isFinite(expires) || expires <= now;
}
