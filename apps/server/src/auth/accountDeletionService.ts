import type pg from "pg";

import { AuthError } from "./types.js";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT" as const;

export type AccountDeletionRequestStatus =
  | "pending_verification"
  | "pending_processing"
  | "processing"
  | "completed"
  | "rejected"
  | "cancelled";

export type AccountDeletionRequestResult = Readonly<{
  requestId: string;
  status: AccountDeletionRequestStatus;
  repeated: boolean;
}>;

export type AccountDeletionProcessResult = Readonly<{
  requestId: string;
  accountId: string;
  status: "completed";
  repeated: boolean;
}>;

type DeletionRequestRow = {
  id: string;
  status: AccountDeletionRequestStatus;
};

type ProcessDeletionRequestRow = DeletionRequestRow & {
  account_id: string | null;
  email_normalized: string | null;
};

type AccountDeletionAccountRow = {
  id: string;
  status: "active" | "suspended" | "deleted";
};

type PlayerRow = { id: string };

type PlayerCascadeReference = {
  schema_name: string;
  table_name: string;
  column_name: string;
};

type AccountDeletionQueryable = Pick<pg.Pool, "query" | "connect">;

/**
 * Owns both the player-facing deletion request and the explicit operator
 * completion step. Shared-world rows intentionally retain their tombstone
 * player foreign key; private rows with a CASCADE player reference are removed
 * in the same transaction and authored shared content is anonymized.
 */
export class AccountDeletionService {
  constructor(
    private readonly pool: AccountDeletionQueryable,
    private readonly now: () => Date = () => new Date()
  ) {}

  async requestAuthenticated(input: {
    accountId: string;
    verifiedEmail: string;
  }): Promise<AccountDeletionRequestResult> {
    const now = this.now();
    const email = normalizeEmail(input.verifiedEmail);
    const requestKey = `account:${input.accountId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM accounts WHERE id = $1 FOR UPDATE",
        [input.accountId]
      );
      const accountRow = account.rows[0];
      if (!accountRow || accountRow.status !== "active") {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
      }

      const existingByAccount = await client.query<DeletionRequestRow>(
        `SELECT id, status
         FROM account_deletion_requests
         WHERE account_id = $1
           AND status IN ('pending_verification', 'pending_processing', 'processing')
         ORDER BY requested_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.accountId]
      );
      const existing = existingByAccount.rows[0];
      if (existing) {
        await client.query(
          `UPDATE account_deletion_requests
           SET email_normalized = $2,
               status = CASE WHEN status = 'pending_verification'
                 THEN 'pending_processing' ELSE status END,
               verified_at = COALESCE(verified_at, $3),
               apple_revocation_required = EXISTS (
                 SELECT 1 FROM account_identities i
                 WHERE i.account_id = $4 AND i.provider = 'apple' AND i.identity_status = 'active'
               ),
               updated_at = $3
           WHERE id = $1`,
          [existing.id, email, now, input.accountId]
        );
        await suspendAccount(client, input.accountId, now);
        await queueAppleRevocations(client, existing.id, input.accountId, now);
        await client.query("COMMIT");
        return {
          requestId: existing.id,
          status: existing.status === "pending_verification" ? "pending_processing" : existing.status,
          repeated: true
        };
      }

      const existingByEmail = await client.query<DeletionRequestRow>(
        `SELECT id, status
         FROM account_deletion_requests
         WHERE email_normalized = $1
           AND status IN ('pending_verification', 'pending_processing', 'processing')
         ORDER BY requested_at DESC
         LIMIT 1
         FOR UPDATE`,
        [email]
      );
      const emailRequest = existingByEmail.rows[0];
      if (emailRequest) {
        await client.query(
          `UPDATE account_deletion_requests
           SET account_id = $2,
               request_key = $3,
               request_source = 'authenticated',
               status = CASE WHEN status = 'pending_verification'
                 THEN 'pending_processing' ELSE status END,
               apple_revocation_required = EXISTS (
                 SELECT 1 FROM account_identities i
                 WHERE i.account_id = $2 AND i.provider = 'apple' AND i.identity_status = 'active'
               ),
               verified_at = COALESCE(verified_at, $4),
               updated_at = $4
           WHERE id = $1`,
          [emailRequest.id, input.accountId, requestKey, now]
        );
        await suspendAccount(client, input.accountId, now);
        await queueAppleRevocations(client, emailRequest.id, input.accountId, now);
        await client.query("COMMIT");
        return {
          requestId: emailRequest.id,
          status: emailRequest.status === "pending_verification"
            ? "pending_processing"
            : emailRequest.status,
          repeated: false
        };
      }

      const inserted = await client.query<DeletionRequestRow>(
        `INSERT INTO account_deletion_requests (
           id, account_id, request_key, email_normalized, request_source,
           status, requested_at, verified_at, updated_at, apple_revocation_required
         )
         VALUES ($1, $2, $3, $4, 'authenticated', 'pending_processing', $5, $5, $5,
                 EXISTS (SELECT 1 FROM account_identities i WHERE i.account_id = $2 AND i.provider = 'apple' AND i.identity_status = 'active'))
         RETURNING id, status`,
        [crypto.randomUUID(), input.accountId, requestKey, email, now]
      );
      await suspendAccount(client, input.accountId, now);
      await queueAppleRevocations(client, requireRow(inserted.rows[0]).id, input.accountId, now);
      await client.query("COMMIT");
      const row = requireRow(inserted.rows[0]);
      return { requestId: row.id, status: row.status, repeated: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async requestPublic(emailInput: string): Promise<AccountDeletionRequestResult> {
    const now = this.now();
    const email = normalizeEmail(emailInput);
    const requestKey = `email:${email}`;
    const result = await this.pool.query<DeletionRequestRow>(
      `INSERT INTO account_deletion_requests (
         id, request_key, email_normalized, request_source,
         status, requested_at, updated_at
       )
       VALUES ($1, $2, $3, 'public', 'pending_verification', $4, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, status`,
      [crypto.randomUUID(), requestKey, email, now]
    );
    const inserted = result.rows[0];
    if (inserted) {
      return {
        requestId: inserted.id,
        status: inserted.status,
        repeated: false
      };
    }
    const existing = await this.pool.query<DeletionRequestRow>(
      `SELECT id, status
       FROM account_deletion_requests
       WHERE email_normalized = $1
         AND status IN ('pending_verification', 'pending_processing', 'processing')
       ORDER BY requested_at DESC
       LIMIT 1`,
      [email]
    );
    const row = requireRow(existing.rows[0]);
    return {
      requestId: row.id,
      status: row.status,
      repeated: true
    };
  }

  /**
   * Complete one request after support has verified ownership. Public requests
   * must provide the account selected by the operator; the service verifies
   * that account's active identity email before linking it. The operation is
   * transactionally idempotent so a retried CLI invocation cannot repeat
   * cleanup or recreate a login path.
   */
  async processRequest(input: {
    requestId: string;
    accountId: string;
    processingNote?: string;
  }): Promise<AccountDeletionProcessResult> {
    const now = this.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query<ProcessDeletionRequestRow>(
        `SELECT id, account_id, email_normalized, status
         FROM account_deletion_requests
         WHERE id = $1
         FOR UPDATE`,
        [input.requestId]
      );
      const request = requestResult.rows[0];
      if (!request) {
        throw new AuthError("DELETION_REQUEST_NOT_FOUND", "Deletion request not found", 404);
      }
      if (request.status === "completed") {
        if (request.account_id !== input.accountId) {
          throw new AuthError(
            "DELETION_OWNERSHIP_MISMATCH",
            "Deletion request is linked to another account",
            409
          );
        }
        await client.query("COMMIT");
        return {
          requestId: request.id,
          accountId: input.accountId,
          status: "completed",
          repeated: true
        };
      }
      if (request.status === "cancelled" || request.status === "rejected") {
        throw new AuthError("DELETION_REQUEST_CLOSED", "Deletion request is already closed", 409);
      }
      if (request.account_id && request.account_id !== input.accountId) {
        throw new AuthError(
          "DELETION_OWNERSHIP_MISMATCH",
          "Deletion request is linked to another account",
          409
        );
      }

      const accountResult = await client.query<AccountDeletionAccountRow>(
        `SELECT id, status
         FROM accounts
         WHERE id = $1
         FOR UPDATE`,
        [input.accountId]
      );
      const account = accountResult.rows[0];
      if (!account) {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 404);
      }

      if (!request.account_id) {
        const identity = await client.query<{ account_id: string }>(
          `SELECT account_id
           FROM account_identities
           WHERE account_id = $1
             AND email_normalized = $2
             AND email_verified = true
             AND identity_status = 'active'
           FOR UPDATE`,
          [input.accountId, request.email_normalized]
        );
        // A linked Google + email pair can carry the same verified address.
        if (!identity.rowCount) {
          throw new AuthError(
            "DELETION_OWNERSHIP_REQUIRED",
            "Support must verify ownership before processing this request",
            403
          );
        }
        await client.query(
          `UPDATE account_deletion_requests
           SET account_id = $2,
               status = 'pending_processing',
               verified_at = COALESCE(verified_at, $3),
               updated_at = $3
           WHERE id = $1`,
          [request.id, input.accountId, now]
        );
      }

      const pendingAppleRevocations = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM apple_revocation_jobs
         WHERE account_id = $1 AND status <> 'completed'`,
        [input.accountId]
      );
      if (Number(pendingAppleRevocations.rows[0]?.count ?? 0) > 0) {
        throw new AuthError(
          "APPLE_REVOCATION_PENDING",
          "Apple identity revocation must complete before account deletion",
          409
        );
      }

      const player = await client.query<PlayerRow>(
        "SELECT id FROM players WHERE account_id = $1 FOR UPDATE",
        [input.accountId]
      );
      const playerId = player.rows[0]?.id ?? null;

      await client.query(
        `UPDATE account_deletion_requests
         SET status = 'processing', updated_at = $2
         WHERE id = $1`,
        [request.id, now]
      );

      await client.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, $2),
             revoke_reason = COALESCE(revoke_reason, 'account_deleted')
         WHERE account_id = $1`,
        [input.accountId, now]
      );
      await client.query(
        "DELETE FROM account_device_links WHERE account_id = $1",
        [input.accountId]
      );
      await client.query(
        `UPDATE auth_events
         SET account_id = NULL, device_installation_id = NULL
         WHERE account_id = $1`,
        [input.accountId]
      );
      await client.query(
        `UPDATE account_risk_events
         SET account_id = NULL, device_installation_id = NULL
         WHERE account_id = $1`,
        [input.accountId]
      );

      if (playerId) {
        await deleteCascadePlayerRows(client, playerId);
        await anonymizePlayerContent(client, playerId, now);
        await client.query(
          `UPDATE players
           SET username = 'Deleted Player',
               username_normalized = NULL,
               display_color = NULL,
               online = false,
               last_seen_at = $2,
               updated_at = $2
           WHERE id = $1`,
          [playerId, now]
        );
      }

      await deleteTrustRows(client, input.accountId);
      await anonymizePurchaseRows(client, input.accountId, now);

      await client.query(
        `UPDATE email_login_codes code
         SET invalidated_at = $2, invalidation_reason = 'account_deleted'
         FROM account_identities identity
         WHERE identity.account_id = $1
           AND identity.email_canonical IS NOT NULL
           AND code.email_normalized = identity.email_canonical
           AND code.consumed_at IS NULL AND code.invalidated_at IS NULL`,
        [input.accountId, now]
      );
      await client.query(
        `UPDATE account_identities
         SET provider_subject = 'deleted:' || provider || ':' || $2,
             email = CASE WHEN provider IN ('google', 'email')
               THEN 'deleted+' || $2 || '@invalid.local' ELSE NULL END,
             email_normalized = CASE WHEN provider IN ('google', 'email')
               THEN 'deleted+' || $2 || '@invalid.local' ELSE NULL END,
             email_verified = CASE WHEN provider IN ('google', 'email') THEN true ELSE NULL END,
             identity_status = 'revoked',
             revoked_at = COALESCE(revoked_at, $3),
             revocation_reason = 'account_deleted',
             apple_refresh_token_key_id = NULL,
             apple_refresh_token_iv = NULL,
             apple_refresh_token_tag = NULL,
             apple_refresh_token_ciphertext = NULL,
             apple_refresh_token_validated_at = NULL,
             updated_at = $3
         WHERE account_id = $1`,
        [input.accountId, input.accountId, now]
      );
      await client.query(
        `UPDATE accounts
         SET status = 'deleted',
             session_version = session_version + 1,
             suspended_at = NULL,
             suspension_reason = 'account_deleted',
             test_access_status = 'revoked',
             test_access_decided_at = COALESCE(test_access_decided_at, $2),
             test_access_decision_note = 'account_deleted',
             updated_at = $2
         WHERE id = $1`,
        [input.accountId, now]
      );
      await client.query(
        `UPDATE account_deletion_requests
         SET status = 'completed',
             processed_at = $2,
             updated_at = $2,
             processing_note = $3
         WHERE id = $1`,
        [
          request.id,
          now,
          input.processingNote?.trim().slice(0, 1_000) || "completed_by_operator"
        ]
      );
      await client.query("COMMIT");
      return {
        requestId: request.id,
        accountId: input.accountId,
        status: "completed",
        repeated: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Accounts are soft-deleted, so ON DELETE CASCADE never fires. Location, trust,
 * settlement and attestation records are personal data with no retention
 * obligation, so they are removed outright (the trust score and its signal
 * ledger included: they exist only to judge this account). Only
 * auth_events/account_risk_events keep an anonymised security trail, handled
 * above.
 */
async function deleteTrustRows(
  client: Pick<pg.PoolClient, "query">,
  accountId: string
): Promise<void> {
  const byAccount = [
    "account_trust_events",
    "account_trust_state",
    "account_regions",
    "account_location_state",
    "location_reports",
    "account_settlement",
    "trust_alerts",
    "device_environment_reports",
    "devicecheck_device_tokens",
    "device_attestations",
    "attestation_challenges"
  ];
  // Foreign keys pointing at these rows (last accepted report, trust event
  // report, attestation id) are ON DELETE SET NULL, so order is not critical.
  for (const table of byAccount) {
    await client.query(`DELETE FROM ${table} WHERE account_id = $1`, [accountId]);
  }
  await client.query(
    "DELETE FROM trust_arrivals WHERE host_account_id = $1 OR guest_account_id = $1",
    [accountId]
  );
  // Admin decisions this account made on other alerts stay, without the link.
  await client.query("UPDATE trust_alerts SET decided_by = NULL WHERE decided_by = $1", [accountId]);
  // An App Attest key belongs to a device, not an account: drop it unless
  // another account's attestation still references it, in which case only the
  // link to this account is cleared.
  await client.query(
    `DELETE FROM app_attest_keys k
      WHERE k.first_account_id = $1
        AND NOT EXISTS (SELECT 1 FROM device_attestations a WHERE a.app_attest_key_id = k.key_id)`,
    [accountId]
  );
  await client.query("UPDATE app_attest_keys SET first_account_id = NULL WHERE first_account_id = $1", [accountId]);
}

/**
 * Real-money purchase records are kept for tax and refund handling but lose
 * every link to the person: the owner, the store account token and the local
 * price detail. A refund that arrives later is still recorded by its store
 * transaction id. The account's store token is removed so no new purchase can
 * be matched to it.
 */
async function anonymizePurchaseRows(
  client: Pick<pg.PoolClient, "query">,
  accountId: string,
  now: Date
): Promise<void> {
  await client.query(
    `UPDATE premium_purchases
     SET account_id = NULL, app_account_token = NULL, store_price_milli = NULL,
         price_currency = NULL, anonymized_at = $2
     WHERE account_id = $1`,
    [accountId, now]
  );
  await client.query(
    "UPDATE premium_subscriptions SET account_id = NULL, anonymized_at = $2 WHERE account_id = $1",
    [accountId, now]
  );
  await client.query(
    "UPDATE premium_web_checkouts SET account_id = NULL, anonymized_at = $2 WHERE account_id = $1",
    [accountId, now]
  );
  await client.query("DELETE FROM premium_account_store_tokens WHERE account_id = $1", [accountId]);
}

async function deleteCascadePlayerRows(
  client: Pick<pg.PoolClient, "query">,
  playerId: string
): Promise<void> {
  const references = await client.query<PlayerCascadeReference>(
    `SELECT ns.nspname AS schema_name,
            child.relname AS table_name,
            attribute.attname AS column_name
     FROM pg_constraint constraint_row
     JOIN pg_class child ON child.oid = constraint_row.conrelid
     JOIN pg_namespace ns ON ns.oid = child.relnamespace
     JOIN pg_attribute attribute
       ON attribute.attrelid = child.oid
      AND attribute.attnum = constraint_row.conkey[1]
     WHERE constraint_row.contype = 'f'
       AND constraint_row.confrelid = 'public.players'::regclass
       AND constraint_row.confdeltype = 'c'
       AND array_length(constraint_row.conkey, 1) = 1
       AND child.relname <> 'players'
     ORDER BY ns.nspname, child.relname, attribute.attname`,
    []
  );
  for (const reference of references.rows) {
    const table = quoteIdentifier(reference.schema_name) + "." + quoteIdentifier(reference.table_name);
    const column = quoteIdentifier(reference.column_name);
    await client.query("SAVEPOINT account_deletion_player_cleanup");
    try {
      await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [playerId]);
      await client.query("RELEASE SAVEPOINT account_deletion_player_cleanup");
    } catch {
      // A table can have a second shared-world dependency added after the
      // original CASCADE declaration. Keep that record as an auditable
      // tombstone reference and continue the rest of the private cleanup.
      await client.query("ROLLBACK TO SAVEPOINT account_deletion_player_cleanup");
      await client.query("RELEASE SAVEPOINT account_deletion_player_cleanup");
    }
  }
}

async function anonymizePlayerContent(
  client: Pick<pg.PoolClient, "query">,
  playerId: string,
  now: Date
): Promise<void> {
  await client.query(
    `UPDATE chat_messages
     SET sender_display_name = 'Deleted Player',
         body = '[Message deleted]',
         message_status = 'deleted',
         deleted_at = COALESCE(deleted_at, $2),
         deletion_reason = COALESCE(deletion_reason, 'account_deleted'),
         updated_at = $2
     WHERE sender_player_id = $1`,
    [playerId, now]
  );
  await client.query(
    `UPDATE kingdom_chat_messages
     SET content = '[Message deleted]'
     WHERE sender_player_id = $1`,
    [playerId]
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

// accounts CHECK: a suspended row must carry suspended_at.
async function suspendAccount(
  client: Pick<pg.PoolClient, "query">,
  accountId: string,
  now: Date
): Promise<void> {
  await client.query(
    `UPDATE accounts
     SET status = 'suspended',
         suspended_at = $2,
         suspension_reason = 'account_deletion_requested',
         updated_at = $2
     WHERE id = $1 AND status = 'active'`,
    [accountId, now]
  );
}

async function queueAppleRevocations(
  client: Pick<pg.PoolClient, "query">,
  deletionRequestId: string,
  accountId: string,
  now: Date
): Promise<void> {
  await client.query(
    `INSERT INTO apple_revocation_jobs (
       id, account_id, identity_id, deletion_request_id,
       status, next_attempt_at, created_at
     )
     SELECT gen_random_uuid(), i.account_id, i.id, $1, 'pending', $3, $3
     FROM account_identities i
     WHERE i.account_id = $2 AND i.provider = 'apple' AND i.identity_status = 'active'
     ON CONFLICT (identity_id) WHERE status IN ('pending', 'processing', 'retry')
       DO UPDATE SET deletion_request_id = COALESCE(
         apple_revocation_jobs.deletion_request_id, EXCLUDED.deletion_request_id
       )`,
    [deletionRequestId, accountId, now]
  );
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("account deletion request row was not returned");
  return row;
}
