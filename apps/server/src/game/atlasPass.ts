import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Atlas Pass perks: same active rule as PurchaseLedger.entitlement (active, or grace until it ends). */
export async function hasActiveAtlasPass(queryable: Queryable, playerId: string): Promise<boolean> {
  const result = await queryable.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM premium_subscriptions subscription
       JOIN players player ON player.account_id = subscription.account_id
       WHERE player.id = $1
         AND subscription.status IN ('active', 'grace')
         AND CASE
               WHEN subscription.status = 'grace' AND subscription.grace_until > subscription.current_period_end
                 THEN subscription.grace_until
               ELSE subscription.current_period_end
             END > clock_timestamp()
     ) AS active`,
    [playerId]
  );
  return result.rows[0]?.active === true;
}
