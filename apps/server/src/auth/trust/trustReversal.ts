import { randomUUID } from "node:crypto";

import type pg from "pg";

import { decayLogodds, shadowTierFor, staticPrior, type LadderThresholds } from "./trustScore.js";
import { PostgresTrustStateStore } from "./trustStore.js";

export type TrustReversalOptions = Readonly<{
  // Exactly one of rules / allRules selects the signals to reverse.
  rules: readonly string[];
  allRules: boolean;
  since: Date | null;
  until: Date | null;
  reason: string;
  apply: boolean;
  now: Date;
  tauDays: number;
  // null when TRUST_QUARANTINE_MODE=off: shadow tiers are left untouched.
  thresholds: LadderThresholds | null;
}>;

export type TrustReversalAccountResult = Readonly<{
  accountId: string;
  events: number;
  weight: number;
  logoddsBefore: number;
  logoddsAfter: number;
  shadowTierBefore: number;
  shadowTierAfter: number;
}>;

export type TrustReversalResult = Readonly<{
  mode: "dry-run" | "apply";
  accounts: readonly TrustReversalAccountResult[];
  eventsReversed: number;
}>;

// Reverses unreversed ledger signals and refreshes each affected account's
// score with the store's recompute (sum of unreversed signals, decayed to now).
// Idempotent: reversed events are never selected again, so a second run finds
// nothing to change. The shadow tier only ever drops here; a reversal is a
// correction, so it takes effect immediately instead of through the exit delay.
export async function reverseTrustSignals(
  pool: pg.Pool,
  options: TrustReversalOptions
): Promise<TrustReversalResult> {
  const store = new PostgresTrustStateStore(pool);
  const accountIds = await pool.query<{ account_id: string }>(
    `SELECT DISTINCT account_id
       FROM account_trust_events
      WHERE kind = 'signal'
        AND reversed_at IS NULL
        AND ($1::boolean OR rule = ANY($2::text[]))
        AND ($3::timestamptz IS NULL OR created_at >= $3)
        AND ($4::timestamptz IS NULL OR created_at < $4)
      ORDER BY account_id`,
    [options.allRules, options.rules, options.since, options.until]
  );
  const accounts: TrustReversalAccountResult[] = [];
  for (const { account_id: accountId } of accountIds.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The state-row lock serializes against live scoring for this account.
      const state = await client.query<{ logodds: number; logodds_updated_at: Date; shadow_tier: number }>(
        "SELECT logodds, logodds_updated_at, shadow_tier FROM account_trust_state WHERE account_id = $1 FOR UPDATE",
        [accountId]
      );
      const events = await client.query<{ id: string; rule: string; weight: number }>(
        `SELECT id, rule, weight
           FROM account_trust_events
          WHERE account_id = $1
            AND kind = 'signal'
            AND reversed_at IS NULL
            AND ($2::boolean OR rule = ANY($3::text[]))
            AND ($4::timestamptz IS NULL OR created_at >= $4)
            AND ($5::timestamptz IS NULL OR created_at < $5)
          FOR UPDATE`,
        [accountId, options.allRules, options.rules, options.since, options.until]
      );
      if (events.rows.length === 0) {
        await client.query("ROLLBACK");
        continue;
      }
      const reversalId = randomUUID();
      const ids = events.rows.map((row) => row.id);
      await client.query(
        "UPDATE account_trust_events SET reversed_at = $2, reversal_id = $3 WHERE id = ANY($1::uuid[])",
        [ids, options.now, reversalId]
      );
      // Recompute inside the same transaction, with the events marked reversed.
      const logoddsAfter = await store.recomputeLogodds(accountId, options.now, options.tauDays, client);
      const weight = events.rows.reduce((total, row) => total + row.weight, 0);
      const tierBefore = state.rows[0]?.shadow_tier ?? 0;
      let tierAfter = tierBefore;
      if (options.thresholds && state.rows[0]) {
        const context = await client.query<{
          trust_tier: "new" | "standard" | "trusted" | "restricted";
          created_at: Date;
          risk_score: number;
          providers: Array<{ provider: string; email: string | null }> | null;
        }>(
          `SELECT a.trust_tier, a.created_at, a.risk_score,
                  (SELECT json_agg(json_build_object('provider', i.provider, 'email', i.email))
                     FROM account_identities i WHERE i.account_id = a.id) AS providers
             FROM accounts a WHERE a.id = $1`,
          [accountId]
        );
        const account = context.rows[0];
        if (account) {
          const effective = logoddsAfter + staticPrior({
            providers: account.providers ?? [],
            createdAt: account.created_at,
            riskScore: account.risk_score,
            now: options.now
          });
          tierAfter = Math.min(tierBefore, shadowTierFor(effective, account.trust_tier, options.thresholds));
        }
      }
      if (state.rows[0]) {
        await client.query(
          `INSERT INTO account_trust_events (id, account_id, kind, rule, weight, logodds_after, metadata, created_at)
           VALUES ($1, $2, 'reversal', 'operator_reversal', $3, $4, $5::jsonb, $6)`,
          [
            reversalId,
            accountId,
            -weight,
            logoddsAfter,
            JSON.stringify({
              reason: options.reason,
              events: ids.length,
              rules: [...new Set(events.rows.map((row) => row.rule))].sort()
            }),
            options.now
          ]
        );
        if (tierAfter !== tierBefore) {
          await client.query(
            `INSERT INTO account_trust_events (id, account_id, kind, rule, weight, logodds_after, metadata, created_at)
             VALUES ($1, $2, 'shadow_tier_change', 'shadow_tier', 0, $3, $4::jsonb, $5)`,
            [randomUUID(), accountId, logoddsAfter, JSON.stringify({ from: tierBefore, to: tierAfter, reversalId }), options.now]
          );
        }
        await client.query(
          `UPDATE account_trust_state
              SET logodds = $2,
                  logodds_updated_at = $3,
                  shadow_tier = $4,
                  tier_entered_at = CASE WHEN $4 <> shadow_tier THEN $3 ELSE tier_entered_at END,
                  tier_exit_eligible_at = CASE WHEN $4 <> shadow_tier THEN NULL ELSE tier_exit_eligible_at END,
                  updated_at = now()
            WHERE account_id = $1`,
          [accountId, logoddsAfter, options.now, tierAfter]
        );
      }
      accounts.push({
        accountId,
        events: ids.length,
        weight,
        logoddsBefore: state.rows[0]
          ? decayLogodds(state.rows[0].logodds, state.rows[0].logodds_updated_at, options.now, options.tauDays)
          : 0,
        logoddsAfter,
        shadowTierBefore: tierBefore,
        shadowTierAfter: tierAfter
      });
      await client.query(options.apply ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    mode: options.apply ? "apply" : "dry-run",
    accounts,
    eventsReversed: accounts.reduce((total, account) => total + account.events, 0)
  };
}
