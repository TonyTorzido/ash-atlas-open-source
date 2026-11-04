import { z } from "zod";

/**
 * Wallet-held premium currencies. Balances are server-authoritative and
 * account-scoped. There are no free sources: only audited admin/developer
 * grants credit them until purchase and membership paths exist.
 *
 * Lumen is not a wallet currency: since 0917 it is a carried, droppable
 * inventory item (`LUMEN_ITEM_ID`) traded like any other item.
 */
export const PREMIUM_CURRENCIES = ["glimmer"] as const;
export type PremiumCurrency = (typeof PREMIUM_CURRENCIES)[number];

export const LUMEN_ITEM_ID = "lumen" as const;

export const PREMIUM_CURRENCY_NAMES: Readonly<Record<PremiumCurrency, string>> = {
  glimmer: "Glimmer"
};

export type PremiumCurrencyBalance = Readonly<{
  /**
   * Integer balance as a decimal string. Negative only while a refund
   * clawback left the account in arrears (plan §6.7); spending is blocked then.
   */
  balance: string;
  /** Monotonic per-currency wallet version. */
  revision: string;
}>;

export type PremiumWalletSnapshot = Readonly<{
  accountId: string;
  balances: Readonly<Record<PremiumCurrency, PremiumCurrencyBalance>> & Readonly<{
    /**
     * Retired wallet balance (zero once 0917 moved it to inventory). Still sent
     * so clients built before 0917 keep parsing the snapshot; never read it.
     */
    lumen?: PremiumCurrencyBalance;
  }>;
}>;

const premiumIntegerSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/u);

export const premiumCurrencyBalanceSchema = z.object({
  balance: z.string().regex(/^(0|-?[1-9]\d{0,18})$/u),
  revision: premiumIntegerSchema
}).strict();

// Passthrough keeps older clients compatible when a later server adds a currency.
export const premiumWalletSnapshotSchema = z.object({
  accountId: z.string().min(1),
  balances: z.object({
    glimmer: premiumCurrencyBalanceSchema,
    lumen: premiumCurrencyBalanceSchema.optional()
  }).passthrough()
}).strict();

/**
 * Merges an authoritative snapshot into the current one per currency, keeping
 * the newer revision so stale frames cannot roll a balance back.
 */
export function mergePremiumWalletSnapshot(
  current: PremiumWalletSnapshot | null,
  next: PremiumWalletSnapshot
): PremiumWalletSnapshot {
  if (!current || current.accountId !== next.accountId) return next;
  let changed = false;
  const balances = { ...current.balances };
  for (const currency of PREMIUM_CURRENCIES) {
    const before = current.balances[currency];
    const after = next.balances[currency];
    if (BigInt(after.revision) > BigInt(before.revision)) {
      balances[currency] = after;
      changed = true;
    }
  }
  return changed ? { accountId: current.accountId, balances } : current;
}

/**
 * Exchange: Glimmer has its own Gold-priced order book. The market
 * item id equals the currency id; custody stays in the premium wallet.
 */
export const PREMIUM_MARKET_SELLER_FEE_BPS = 500;

export function premiumCurrencyForMarketItem(itemId: string | null | undefined): PremiumCurrency | null {
  return (PREMIUM_CURRENCIES as readonly string[]).includes(itemId ?? "")
    ? itemId as PremiumCurrency
    : null;
}

export function premiumMarketIdentity(currency: PremiumCurrency): string {
  return `currency:${currency}`;
}

/** Seller's currency fee for a cumulative filled quantity, rounded up. */
export function premiumMarketSellerFee(
  filledQuantity: bigint,
  feeBps: number = PREMIUM_MARKET_SELLER_FEE_BPS
): bigint {
  const scaled = filledQuantity * BigInt(feeBps);
  return scaled === 0n ? 0n : (scaled + 9_999n) / 10_000n;
}

/** Largest listing whose quantity plus fee fits in the balance. */
export function premiumMarketMaxSellQuantity(
  balance: bigint,
  feeBps: number = PREMIUM_MARKET_SELLER_FEE_BPS
): bigint {
  if (balance <= 0n) return 0n;
  let quantity = (balance * 10_000n) / (10_000n + BigInt(feeBps));
  while (quantity + 1n + premiumMarketSellerFee(quantity + 1n, feeBps) <= balance) quantity += 1n;
  while (quantity > 0n && quantity + premiumMarketSellerFee(quantity, feeBps) > balance) quantity -= 1n;
  return quantity;
}

/** Glimmer progression costs. Each is behind its own server flag. */
export const LEVEL_UP_GLIMMER_FEE = 70;
export const FULL_SKILL_RESET_GLIMMER_FEE = 560;
export const FULL_SKILL_RESET_ATLAS_PASS_GLIMMER_FEE = 336;

export function fullSkillResetGlimmerFee(atlasPass: boolean): number {
  return atlasPass ? FULL_SKILL_RESET_ATLAS_PASS_GLIMMER_FEE : FULL_SKILL_RESET_GLIMMER_FEE;
}

/**
 * Effective Glimmer costs the server reports on WELCOME. A null cost means
 * that fee is off on this server (the action is free / automatic).
 */
export type GlimmerCostsSnapshot = Readonly<{
  levelUp: number | null;
  skillReset: number | null;
}>;

export const glimmerCostsSnapshotSchema = z.object({
  levelUp: z.number().int().positive().nullable(),
  skillReset: z.number().int().positive().nullable()
}).strict();
