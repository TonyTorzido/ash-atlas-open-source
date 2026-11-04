import { performance } from "node:perf_hooks";
import type pg from "pg";
import type {
  DevAccessAccountAdminView,
  DevAccessStatus,
  TestAccessAccountAdminView,
  TestAccessAdminListResponse,
  TestAccessEmailGrantAdminView,
  TestAccessMode,
  TestAccessModeResponse,
  TestAccessStatus
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import { canonicalEmail } from "./email/emailDomainPolicy.js";
import { AuthError, type AuthenticatedSession } from "./types.js";

type AccountAdminRow = {
  account_id: string;
  verified_email: string;
  test_access_status: TestAccessStatus;
  created_at: Date;
  last_login_at: Date | null;
  test_access_requested_at: Date;
  test_access_decided_at: Date | null;
  player_name: string | null;
  dev_access_status: DevAccessStatus | null;
  full_count: string;
};

type DevAdminRow = {
  account_id: string;
  verified_email: string | null;
  dev_access_status: DevAccessStatus;
  test_access_status: TestAccessStatus;
  requested_at: Date | null;
  decided_at: Date | null;
  last_login_at: Date | null;
  player_name: string | null;
  full_count: string;
};

export type DevAccessAction = "approve" | "deny" | "revoke";

type GrantAdminRow = {
  grant_id: string;
  email_display: string;
  status: "active" | "claimed" | "revoked";
  created_at: Date;
  claimed_account_id: string | null;
  claimed_at: Date | null;
  full_count: string;
};

export type TestAccessListFilter = TestAccessStatus | "unclaimed" | "dev";

export type TestAccessModeQueryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
export type TestAccessModeReader = {
  getAccessMode(
    queryable?: TestAccessModeQueryable,
    lock?: "share"
  ): Promise<TestAccessMode>;
  /** True only for an explicit administrator-approved dev-list entry. */
  hasDevAccess?(accountId: string): Promise<boolean>;
  /** Records a pending dev-list request; never grants anything. */
  recordDevAccessRequest?(accountId: string): Promise<void>;
};

type AccessModeRow = {
  access_mode: TestAccessMode;
  updated_at: Date;
};

export class TestAccessService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Pick<AppConfig, "RUNTIME_SHA">
  ) {}

  async getAccessMode(
    queryable: TestAccessModeQueryable = this.pool,
    lock?: "share"
  ): Promise<TestAccessMode> {
    const result = await queryable.query<AccessModeRow>(
      `SELECT access_mode, updated_at
       FROM test_access_settings
       WHERE singleton = true${lock === "share" ? " FOR SHARE" : ""}`
    );
    return modeResponse(result.rows[0]).mode;
  }

  async hasDevAccess(
    accountId: string,
    queryable: TestAccessModeQueryable = this.pool
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM dev_access_entries
       WHERE account_id = $1 AND status = 'approved'`,
      [accountId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordDevAccessRequest(accountId: string): Promise<void> {
    // One statement: the request row and its audit event land together, and a
    // replay (or any existing decision) inserts nothing.
    await this.pool.query(
      `WITH requested AS (
         INSERT INTO dev_access_entries (account_id, status, requested_at)
         SELECT a.id, 'pending', now()
         FROM accounts a
         WHERE a.id = $1 AND a.status = 'active' AND a.test_access_status = 'approved'
         ON CONFLICT (account_id) DO NOTHING
         RETURNING account_id
       )
       INSERT INTO test_access_events (
         id, event_type, target_account_id, new_status, runtime_release_sha
       )
       SELECT $2, 'dev_access_requested', account_id, 'pending', $3
       FROM requested`,
      [accountId, crypto.randomUUID(), this.config.RUNTIME_SHA ?? null]
    );
  }

  async readAccessMode(
    queryable: TestAccessModeQueryable = this.pool
  ): Promise<TestAccessModeResponse> {
    const result = await queryable.query<AccessModeRow>(
      `SELECT access_mode, updated_at
       FROM test_access_settings
       WHERE singleton = true`
    );
    return modeResponse(result.rows[0]);
  }

  async setAccessMode(
    actor: AuthenticatedSession,
    mode: TestAccessMode
  ): Promise<TestAccessModeResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<AccessModeRow>(
        `SELECT access_mode, updated_at
         FROM test_access_settings
         WHERE singleton = true
         FOR UPDATE`
      );
      const previous = current.rows[0];
      if (!previous) throw new Error("test-access mode setting is unavailable");
      if (previous.access_mode === mode) {
        await client.query("COMMIT");
        return {
          mode: previous.access_mode,
          updatedAt: new Date(previous.updated_at).toISOString()
        };
      }
      const changed = await client.query<AccessModeRow>(
        `UPDATE test_access_settings
         SET access_mode = $1,
             updated_at = now()
         WHERE singleton = true
         RETURNING access_mode, updated_at`,
        [mode]
      );
      await insertEvent(client, this.config, {
        eventType: "access_mode_changed",
        actingAccountId: actor.account.id,
        previousStatus: previous.access_mode,
        newStatus: mode,
        reason: "administrator changed test access mode"
      });
      await client.query("COMMIT");
      const row = requireRow(changed.rows[0]);
      return {
        mode: row.access_mode,
        updatedAt: new Date(row.updated_at).toISOString()
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(input: {
    filter: TestAccessListFilter;
    search: string;
    page: number;
    pageSize: number;
  }): Promise<TestAccessAdminListResponse> {
    const startedAt = performance.now();
    const offset = (input.page - 1) * input.pageSize;
    if (input.filter === "dev") {
      const result = await this.pool.query<DevAdminRow>(
        `SELECT
           d.account_id,
           identity.email AS verified_email,
           d.status AS dev_access_status,
           a.test_access_status,
           d.requested_at,
           d.decided_at,
           a.last_login_at,
           player.username AS player_name,
           count(*) OVER()::text AS full_count
         FROM dev_access_entries d
         JOIN accounts a ON a.id = d.account_id
         LEFT JOIN LATERAL (
           SELECT verified.email, verified.email_normalized
           FROM account_identities verified
           WHERE verified.account_id = a.id
             AND verified.provider IN ('google', 'email')
             AND verified.email_verified = true
           ORDER BY (verified.provider = 'google') DESC
           LIMIT 1
         ) identity ON true
         LEFT JOIN players player ON player.account_id = a.id
         WHERE ($1 = '' OR identity.email_normalized LIKE '%' || $1 || '%')
         ORDER BY
           CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
           COALESCE(d.requested_at, d.created_at) ASC,
           d.account_id ASC
         LIMIT $2 OFFSET $3`,
        [normalizeApprovalEmail(input.search), input.pageSize, offset]
      );
      return {
        items: result.rows.map(devView),
        page: input.page,
        pageSize: input.pageSize,
        total: Number(result.rows[0]?.full_count ?? 0),
        queryDurationMs: performance.now() - startedAt
      };
    }
    if (input.filter === "unclaimed") {
      const result = await this.pool.query<GrantAdminRow>(
        `SELECT
           id AS grant_id, email_display, status, created_at,
           claimed_account_id, claimed_at, count(*) OVER()::text AS full_count
         FROM test_access_email_grants
         WHERE status = 'active'
           AND ($1 = '' OR email_normalized LIKE '%' || $1 || '%')
         ORDER BY created_at ASC, id ASC
         LIMIT $2 OFFSET $3`,
        [normalizeApprovalEmail(input.search), input.pageSize, offset]
      );
      return {
        items: result.rows.map(grantView),
        page: input.page,
        pageSize: input.pageSize,
        total: Number(result.rows[0]?.full_count ?? 0),
        queryDurationMs: performance.now() - startedAt
      };
    }

    const result = await this.pool.query<AccountAdminRow>(
      `SELECT
         a.id AS account_id,
         identity.email AS verified_email,
         a.test_access_status,
         a.created_at,
         a.last_login_at,
         a.test_access_requested_at,
         a.test_access_decided_at,
         player.username AS player_name,
         dev.status AS dev_access_status,
         count(*) OVER()::text AS full_count
       FROM accounts a
       JOIN LATERAL (
         SELECT verified.email, verified.email_normalized
         FROM account_identities verified
         WHERE verified.account_id = a.id
           AND verified.provider IN ('google', 'email')
           AND verified.email_verified = true
         ORDER BY (verified.provider = 'google') DESC
         LIMIT 1
       ) identity ON true
       LEFT JOIN players player ON player.account_id = a.id
       LEFT JOIN dev_access_entries dev ON dev.account_id = a.id
       WHERE a.test_access_status = $1
         AND ($2 = '' OR identity.email_normalized LIKE '%' || $2 || '%')
       ORDER BY
         CASE WHEN $1 = 'pending' THEN a.test_access_requested_at ELSE a.created_at END ASC,
         a.id ASC
       LIMIT $3 OFFSET $4`,
      [input.filter, normalizeApprovalEmail(input.search), input.pageSize, offset]
    );
    return {
      items: result.rows.map(accountView),
      page: input.page,
      pageSize: input.pageSize,
      total: Number(result.rows[0]?.full_count ?? 0),
      queryDurationMs: performance.now() - startedAt
    };
  }

  async preapprove(
    actor: AuthenticatedSession,
    emailDisplayInput: string,
    reason: string | null,
    operationKey: string | null
  ): Promise<{
    outcome: "account_approved" | "account_already_decided" | "grant_active" | "grant_claimed";
    accountId?: string;
    accountStatus?: TestAccessStatus;
    grantId?: string;
    grantStatus?: "active" | "claimed";
  }> {
    const emailDisplay = emailDisplayInput.trim();
    const emailNormalized = normalizeApprovalEmail(emailDisplayInput);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockEmail(client, emailNormalized);
      const accounts = await client.query<{
        id: string;
        test_access_status: TestAccessStatus;
      }>(
        `SELECT a.id, a.test_access_status
         FROM accounts a
         WHERE a.id IN (
           SELECT identity.account_id
           FROM account_identities identity
           WHERE identity.provider IN ('google', 'email')
             AND identity.email_verified = true
             AND (identity.email_normalized = $1
               OR (identity.provider = 'email'
                 AND identity.email_canonical = auth_canonical_email($1)))
         )
         ORDER BY a.created_at, a.id
         FOR UPDATE OF a`,
        [emailNormalized]
      );
      if (accounts.rowCount && accounts.rowCount > 1) {
        throw new AuthError(
          "TEST_ACCESS_INVALID_TRANSITION",
          "More than one account has that verified email",
          409
        );
      }
      const existing = accounts.rows[0];
      if (existing) {
        if (existing.test_access_status === "pending") {
          await updateAccountDecision(
            client,
            this.config,
            actor.account.id,
            existing.id,
            "pending",
            "approved",
            "account_approved",
            reason ?? "approved through verified-email preapproval",
            operationKey
          );
          await client.query("COMMIT");
          return {
            outcome: "account_approved",
            accountId: existing.id,
            accountStatus: "approved"
          };
        }
        await client.query("COMMIT");
        return {
          outcome: "account_already_decided",
          accountId: existing.id,
          accountStatus: existing.test_access_status
        };
      }

      const existingGrant = await client.query<{
        id: string;
        status: "active" | "claimed" | "revoked";
      }>(
        `SELECT id, status
         FROM test_access_email_grants
         WHERE email_normalized = $1
         FOR UPDATE`,
        [emailNormalized]
      );
      let row = existingGrant.rows[0];
      let changed = false;
      if (!row) {
        const inserted = await client.query<{
          id: string;
          status: "active";
        }>(
          `INSERT INTO test_access_email_grants (
             id, email_display, email_normalized, status, created_by_account_id
           )
           VALUES ($1, $2, $3, 'active', $4)
           RETURNING id, status`,
          [crypto.randomUUID(), emailDisplay, emailNormalized, actor.account.id]
        );
        row = requireRow(inserted.rows[0]);
        changed = true;
      } else if (row.status === "revoked") {
        const reactivated = await client.query<{
          id: string;
          status: "active";
        }>(
          `UPDATE test_access_email_grants
           SET email_display = $2,
               status = 'active',
               created_at = now(),
               created_by_account_id = $3,
               revoked_at = NULL,
               revoked_by_account_id = NULL
           WHERE id = $1
           RETURNING id, status`,
          [row.id, emailDisplay, actor.account.id]
        );
        row = requireRow(reactivated.rows[0]);
        changed = true;
      }
      if (changed) {
        await insertEvent(client, this.config, {
          eventType: "preapproval_created",
          actingAccountId: actor.account.id,
          grantId: row.id,
          previousStatus: null,
          newStatus: "active",
          reason,
          operationKey
        });
      }
      await client.query("COMMIT");
      const resultRow = requireRow(row);
      return resultRow.status === "claimed"
        ? { outcome: "grant_claimed", grantId: resultRow.id, grantStatus: "claimed" }
        : { outcome: "grant_active", grantId: resultRow.id, grantStatus: "active" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  decideAccount(
    actor: AuthenticatedSession,
    accountId: string,
    action: "approve" | "deny" | "revoke" | "restore",
    reason: string | null,
    operationKey: string | null
  ): Promise<{ accountId: string; previousStatus: TestAccessStatus; status: TestAccessStatus }> {
    return this.withAccountDecision(actor, accountId, action, reason, operationKey);
  }

  async revokeGrant(
    actor: AuthenticatedSession,
    grantId: string,
    reason: string | null,
    operationKey: string | null
  ): Promise<{ grantId: string; status: "revoked" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        status: "active" | "claimed" | "revoked";
      }>(
        "SELECT status FROM test_access_email_grants WHERE id = $1 FOR UPDATE",
        [grantId]
      );
      const row = result.rows[0];
      if (!row) {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Preapproval does not exist", 404);
      }
      if (row.status === "claimed") {
        throw new AuthError(
          "TEST_ACCESS_GRANT_NOT_REVOCABLE",
          "Claimed preapproval cannot revoke account access",
          409
        );
      }
      if (row.status === "active") {
        await client.query(
          `UPDATE test_access_email_grants
           SET status = 'revoked', revoked_at = now(), revoked_by_account_id = $2
           WHERE id = $1`,
          [grantId, actor.account.id]
        );
        await insertEvent(client, this.config, {
          eventType: "preapproval_revoked",
          actingAccountId: actor.account.id,
          grantId,
          previousStatus: "active",
          newStatus: "revoked",
          reason,
          operationKey
        });
      }
      await client.query("COMMIT");
      return { grantId, status: "revoked" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Dev-list membership changes only through this explicit administrator
   * decision on one existing account. Approval requires approved test access,
   * so the dev list is always a subset of the approved list.
   */
  async decideDevAccess(
    actor: AuthenticatedSession,
    accountId: string,
    action: DevAccessAction,
    reason: string | null,
    operationKey: string | null
  ): Promise<DevAccessDecision> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await applyDevAccessDecision(
        client,
        this.config,
        actor,
        accountId,
        action,
        reason,
        operationKey
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Resolves one existing account by verified email, then approves it. */
  async grantDevAccessByEmail(
    actor: AuthenticatedSession,
    emailInput: string,
    reason: string | null,
    operationKey: string | null
  ): Promise<DevAccessDecision> {
    const emailNormalized = normalizeApprovalEmail(emailInput);
    const accounts = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT identity.account_id AS id
       FROM account_identities identity
       WHERE identity.provider IN ('google', 'email')
         AND identity.email_verified = true
         AND (identity.email_normalized = $1
           OR (identity.provider = 'email'
             AND identity.email_canonical = auth_canonical_email($1)))`,
      [emailNormalized]
    );
    if (accounts.rows.length > 1) {
      throw new AuthError(
        "TEST_ACCESS_INVALID_TRANSITION",
        "More than one account has that verified email",
        409
      );
    }
    const account = accounts.rows[0];
    if (!account) {
      throw new AuthError(
        "ACCOUNT_UNAVAILABLE",
        "No account has signed in with that email yet",
        404
      );
    }
    return this.decideDevAccess(actor, account.id, "approve", reason, operationKey);
  }

  async recordUnauthorizedAttempt(
    session: AuthenticatedSession | null,
    command: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO test_access_events (
         id, event_type, acting_account_id, reason, runtime_release_sha
       ) VALUES ($1, 'unauthorized_admin_rejected', $2, $3, $4)`,
      [
        crypto.randomUUID(),
        session?.account.id ?? null,
        command,
        this.config.RUNTIME_SHA ?? null
      ]
    );
  }

  private async withAccountDecision(
    actor: AuthenticatedSession,
    accountId: string,
    action: "approve" | "deny" | "revoke" | "restore",
    reason: string | null,
    operationKey: string | null
  ): Promise<{ accountId: string; previousStatus: TestAccessStatus; status: TestAccessStatus }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ test_access_status: TestAccessStatus }>(
        "SELECT test_access_status FROM accounts WHERE id = $1 FOR UPDATE",
        [accountId]
      );
      const row = account.rows[0];
      if (!row) throw new AuthError("ACCOUNT_UNAVAILABLE", "Account does not exist", 404);
      const previous = row.test_access_status;
      const target = decisionTarget(action);
      if (!transitionAllowed(action, previous)) {
        if (previous === target) {
          await client.query("COMMIT");
          return { accountId, previousStatus: previous, status: target };
        }
        throw new AuthError(
          "TEST_ACCESS_INVALID_TRANSITION",
          `Cannot ${action} an account with ${previous} access`,
          409
        );
      }
      const eventType = action === "approve"
        ? "account_approved"
        : action === "deny"
          ? "account_denied"
          : action === "revoke"
            ? "account_revoked"
            : "account_restored";
      await updateAccountDecision(
        client,
        this.config,
        actor.account.id,
        accountId,
        previous,
        target,
        eventType,
        reason,
        operationKey
      );
      await client.query("COMMIT");
      return { accountId, previousStatus: previous, status: target };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function updateAccountDecision(
  client: pg.PoolClient,
  config: Pick<AppConfig, "RUNTIME_SHA">,
  actorAccountId: string,
  targetAccountId: string,
  previousStatus: TestAccessStatus,
  newStatus: TestAccessStatus,
  eventType: "account_approved" | "account_denied" | "account_revoked" | "account_restored",
  reason: string | null,
  operationKey: string | null
): Promise<void> {
  await client.query(
    `UPDATE accounts
     SET test_access_status = $2,
         test_access_decided_at = now(),
         test_access_decided_by_account_id = $3,
         test_access_decision_note = $4
     WHERE id = $1`,
    [targetAccountId, newStatus, actorAccountId, reason]
  );
  await insertEvent(client, config, {
    eventType,
    actingAccountId: actorAccountId,
    targetAccountId,
    previousStatus,
    newStatus,
    reason,
    operationKey
  });
}

async function insertEvent(
  queryable: Pick<pg.PoolClient, "query">,
  config: Pick<AppConfig, "RUNTIME_SHA">,
  input: {
    eventType: string;
    actingAccountId?: string | null;
    targetAccountId?: string | null;
    grantId?: string | null;
    previousStatus?: string | null;
    newStatus?: string | null;
    reason?: string | null;
    operationKey?: string | null;
  }
): Promise<void> {
  await queryable.query(
    `INSERT INTO test_access_events (
       id, event_type, acting_account_id, target_account_id, grant_id,
       previous_status, new_status, reason, runtime_release_sha, operation_key
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (event_type, operation_key)
       WHERE operation_key IS NOT NULL
     DO NOTHING`,
    [
      crypto.randomUUID(),
      input.eventType,
      input.actingAccountId ?? null,
      input.targetAccountId ?? null,
      input.grantId ?? null,
      input.previousStatus ?? null,
      input.newStatus ?? null,
      input.reason ?? null,
      config.RUNTIME_SHA ?? null,
      input.operationKey ?? null
    ]
  );
}

function decisionTarget(action: "approve" | "deny" | "revoke" | "restore"): TestAccessStatus {
  if (action === "deny") return "denied";
  if (action === "revoke") return "revoked";
  return "approved";
}

function transitionAllowed(
  action: "approve" | "deny" | "revoke" | "restore",
  current: TestAccessStatus
): boolean {
  if (action === "approve") return current === "pending" || current === "denied";
  if (action === "restore") return current === "revoked" || current === "denied";
  if (action === "deny") return current === "pending";
  return current === "approved";
}

function accountView(row: AccountAdminRow): TestAccessAccountAdminView {
  return {
    kind: "account",
    accountId: row.account_id,
    verifiedEmail: row.verified_email,
    status: row.test_access_status,
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    requestedAt: new Date(row.test_access_requested_at).toISOString(),
    decidedAt: row.test_access_decided_at
      ? new Date(row.test_access_decided_at).toISOString()
      : null,
    playerName: row.player_name,
    devAccessStatus: row.dev_access_status
  };
}

export type DevAccessDecision = {
  accountId: string;
  previousStatus: DevAccessStatus | null;
  status: DevAccessStatus;
};

async function applyDevAccessDecision(
  client: pg.PoolClient,
  config: Pick<AppConfig, "RUNTIME_SHA">,
  actor: AuthenticatedSession,
  accountId: string,
  action: DevAccessAction,
  reason: string | null,
  operationKey: string | null
): Promise<DevAccessDecision> {
  // Same lock order as test-access decisions: the account row first.
  const account = await client.query<{ test_access_status: TestAccessStatus }>(
    "SELECT test_access_status FROM accounts WHERE id = $1 FOR SHARE",
    [accountId]
  );
  const accountRow = account.rows[0];
  if (!accountRow) throw new AuthError("ACCOUNT_UNAVAILABLE", "Account does not exist", 404);
  const entry = await client.query<{ status: DevAccessStatus }>(
    "SELECT status FROM dev_access_entries WHERE account_id = $1 FOR UPDATE",
    [accountId]
  );
  const previous = entry.rows[0]?.status ?? null;
  const target: DevAccessStatus = action === "approve"
    ? "approved"
    : action === "deny"
      ? "denied"
      : "revoked";
  if (previous === target) {
    return { accountId, previousStatus: previous, status: target };
  }
  const allowed = action === "approve"
    ? true
    : action === "deny"
      ? previous === "pending"
      : previous === "approved";
  if (!allowed) {
    const current = previous ? `that is ${previous}` : "for an account not on the dev list";
    throw new AuthError(
      "TEST_ACCESS_INVALID_TRANSITION",
      `Cannot ${action} dev access ${current}`,
      409
    );
  }
  if (action === "approve" && accountRow.test_access_status !== "approved") {
    throw new AuthError(
      "TEST_ACCESS_INVALID_TRANSITION",
      "Approve this account's test access before granting dev access",
      409
    );
  }
  await client.query(
    `INSERT INTO dev_access_entries (
       account_id, status, decided_at, decided_by_account_id, decision_note, updated_at
     )
     VALUES ($1, $2, now(), $3, $4, now())
     ON CONFLICT (account_id) DO UPDATE
     SET status = EXCLUDED.status,
         decided_at = EXCLUDED.decided_at,
         decided_by_account_id = EXCLUDED.decided_by_account_id,
         decision_note = EXCLUDED.decision_note,
         updated_at = EXCLUDED.updated_at`,
    [accountId, target, actor.account.id, reason]
  );
  await insertEvent(client, config, {
    eventType: `dev_access_${target}`,
    actingAccountId: actor.account.id,
    targetAccountId: accountId,
    previousStatus: previous,
    newStatus: target,
    reason,
    operationKey
  });
  return { accountId, previousStatus: previous, status: target };
}

function devView(row: DevAdminRow): DevAccessAccountAdminView {
  return {
    kind: "dev",
    accountId: row.account_id,
    verifiedEmail: row.verified_email ?? "No verified email",
    devAccessStatus: row.dev_access_status,
    testAccessStatus: row.test_access_status,
    requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    playerName: row.player_name
  };
}

function grantView(row: GrantAdminRow): TestAccessEmailGrantAdminView {
  return {
    kind: "grant",
    grantId: row.grant_id,
    email: row.email_display,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    claimedAccountId: row.claimed_account_id,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null
  };
}

async function lockEmail(client: pg.PoolClient, normalizedEmail: string): Promise<void> {
  // Same order as sign-in: canonical mailbox first, then the exact address.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`email-canonical:${canonicalEmail(normalizedEmail)}`]
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`test-access-email:${normalizedEmail}`]
  );
}

export function normalizeApprovalEmail(value: string): string {
  return value.trim().toLowerCase();
}

function requireRow<T>(value: T | undefined): T {
  if (!value) throw new Error("test-access query did not return a row");
  return value;
}

function modeResponse(row: AccessModeRow | undefined): TestAccessModeResponse {
  if (!row) throw new Error("test-access mode setting is unavailable");
  return {
    mode: row.access_mode,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
