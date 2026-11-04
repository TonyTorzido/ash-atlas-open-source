import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Longest address the landing sign-up accepts (RFC 5321 path limit). */
export const UPDATE_SUBSCRIBER_EMAIL_MAX_LENGTH = 254;
export const UPDATE_SUBSCRIBER_USER_AGENT_MAX_LENGTH = 256;

export type UpdateSubscription = Readonly<{
  email: string;
  source: string | null;
  userAgent: string | null;
  ipHash: string | null;
}>;

export type UpdateSubscriber = Readonly<{
  email: string;
  source: string | null;
  userAgent: string | null;
  createdAt: string;
  unsubscribedAt: string | null;
}>;

type UpdateSubscriberRow = {
  email: string;
  source: string | null;
  user_agent: string | null;
  created_at: Date;
  unsubscribed_at: Date | null;
};

export class UpdateSubscriberService {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  /**
   * Records an update-notice sign-up. A repeat email keeps its first row untouched (including a
   * past unsubscribe), so callers get the same result whether or not the address was known.
   */
  async subscribe(subscription: UpdateSubscription): Promise<void> {
    await this.pool.query(
      `INSERT INTO update_subscribers (id, email, source, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING`,
      [
        randomUUID(),
        subscription.email,
        subscription.source,
        subscription.userAgent?.slice(0, UPDATE_SUBSCRIBER_USER_AGENT_MAX_LENGTH) ?? null,
        subscription.ipHash
      ]
    );
  }

  async list(): Promise<UpdateSubscriber[]> {
    const result = await this.pool.query<UpdateSubscriberRow>(
      `SELECT email, source, user_agent, created_at, unsubscribed_at
         FROM update_subscribers
        ORDER BY created_at ASC, email ASC`
    );
    return result.rows.map((row) => ({
      email: row.email,
      source: row.source,
      userAgent: row.user_agent,
      createdAt: row.created_at.toISOString(),
      unsubscribedAt: row.unsubscribed_at?.toISOString() ?? null
    }));
  }
}
