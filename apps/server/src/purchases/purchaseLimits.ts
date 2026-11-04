import type { PurchaseDenialReason } from "@ash-atlas/shared";
import type pg from "pg";

/**
 * Fraud caps from premium-currency-plan.md §6.7/§6.8: new accounts may spend
 * at most $20 in their first 7 days and $100 in their first 30, every account
 * at most $250 per rolling 24 hours, and two refunds in 180 days stop purchases.
 */
export const PURCHASE_LIMITS = Object.freeze({
  firstWeekCents: 2_000,
  firstMonthCents: 10_000,
  dailyCents: 25_000,
  refundWindowDays: 180,
  maxRefunds: 2
});

const DAY_MS = 86_400_000;
const COUNTED_STATES = ["granted", "refunded_clawed_back", "refunded_in_arrears"];

type LimitRow = {
  account_created_at: Date | null;
  first_week_cents: string;
  first_month_cents: string;
  daily_cents: string;
  recent_refunds: string;
};

/** The reason a purchase of `addCents` must not start now, or null. */
export async function purchaseLimitDenial(
  queryable: Pick<pg.PoolClient, "query">,
  accountId: string,
  addCents: number,
  now: Date
): Promise<PurchaseDenialReason | null> {
  const result = await queryable.query<LimitRow>(
    `SELECT account.created_at AS account_created_at,
            coalesce(sum(p.usd_cents) FILTER (
              WHERE p.purchased_at < account.created_at + interval '7 days'), 0)::text AS first_week_cents,
            coalesce(sum(p.usd_cents) FILTER (
              WHERE p.purchased_at < account.created_at + interval '30 days'), 0)::text AS first_month_cents,
            coalesce(sum(p.usd_cents) FILTER (
              WHERE p.purchased_at > $3::timestamptz - interval '24 hours'), 0)::text AS daily_cents,
            count(*) FILTER (
              WHERE p.refunded_at > $3::timestamptz - ($4::integer * interval '1 day'))::text AS recent_refunds
     FROM accounts account
     LEFT JOIN premium_purchases p
       ON p.account_id = account.id AND p.state = ANY($2::text[])
     WHERE account.id = $1
     GROUP BY account.created_at`,
    [accountId, COUNTED_STATES, now.toISOString(), PURCHASE_LIMITS.refundWindowDays]
  );
  const row = result.rows[0];
  if (!row?.account_created_at) return "product_unavailable";
  if (Number(row.recent_refunds) >= PURCHASE_LIMITS.maxRefunds) return "refund_limit";
  const ageMs = now.getTime() - new Date(row.account_created_at).getTime();
  if (ageMs < 7 * DAY_MS && Number(row.first_week_cents) + addCents > PURCHASE_LIMITS.firstWeekCents) {
    return "new_account_limit";
  }
  if (ageMs < 30 * DAY_MS && Number(row.first_month_cents) + addCents > PURCHASE_LIMITS.firstMonthCents) {
    return "new_account_limit";
  }
  if (Number(row.daily_cents) + addCents > PURCHASE_LIMITS.dailyCents) return "daily_limit";
  return null;
}
