import { timingSafeEqual } from "node:crypto";

import type pg from "pg";

import type { AppConfig } from "../config.js";
import type {
  AccountDeviceLinkResult,
  AccountIdentityResult,
  AuthAccountRecord,
  AuthEventInput,
  AuthPlayerRecord,
  AppleAccountIdentityResult,
  AuthIdentityProvider,
  DeviceInstallationRecord,
  EmailAccountIdentityResult,
  EmailLoginCodePurpose,
  RiskEventInput,
  StoredAuthSession,
  VerifiedAppleIdentity,
  VerifiedEmailIdentity,
  VerifiedGoogleIdentity
} from "./types.js";
import type { RiskEventStore } from "./riskService.js";
import { canonicalEmail } from "./email/emailDomainPolicy.js";
import { EMAIL_LOGIN_CODE_MAX_ATTEMPTS } from "./email/loginCodes.js";

export type RecentAuthEventFilter = {
  eventTypes: string[];
  since: Date;
  deviceInstallationId?: string;
  networkHash?: string;
  networkPrefixHash?: string;
  accountId?: string;
};

export type EmailLoginCodeCreation =
  | { status: "created" }
  | { status: "throttled"; retryAt: Date };

export type EmailLoginCodeSendOutcome = {
  status: "sent" | "logged" | "failed";
  provider: string;
  messageId?: string | null;
  error?: string | null;
};

/**
 * Email one-time-code persistence. Optional on AuthStore (like Apple) so
 * lightweight test stores need not implement it; the service fails closed.
 */
export interface EmailLoginStore {
  findAccountByEmailIdentity(emailNormalized: string): Promise<AuthAccountRecord | null>;
  createOrLoadEmailAccount(identity: VerifiedEmailIdentity): Promise<EmailAccountIdentityResult>;
  linkEmailIdentity(input: {
    accountId: string;
    sessionId: string;
    identity: VerifiedEmailIdentity;
    now: Date;
  }): Promise<{ identityId: string }>;
  linkGoogleIdentity(input: {
    accountId: string;
    identity: VerifiedGoogleIdentity;
    now: Date;
  }): Promise<{ identityId: string }>;
  reserveEmailCodeRequest(input: {
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }): Promise<RateLimitReservation>;
  /**
   * Under a per-email lock: enforces the resend gap and per-email windows,
   * supersedes earlier active codes for (email, purpose), and inserts the new one.
   */
  createEmailLoginCode(input: {
    id: string;
    emailNormalized: string;
    codeHash: string;
    purpose: EmailLoginCodePurpose;
    accountId?: string | null;
    sessionId?: string | null;
    deviceInstallationId: string | null;
    networkHash: string | null;
    now: Date;
    expiresAt: Date;
    limits: {
      resendAfterSeconds: number;
      perTenMinutes: number;
      perDay: number;
    };
  }): Promise<EmailLoginCodeCreation>;
  /** One transaction: lock newest active code; match consumes, mismatch counts an attempt. */
  consumeEmailLoginCode(input: {
    emailNormalized: string;
    purpose: EmailLoginCodePurpose;
    codeHash: string;
    accountId?: string | null;
    now: Date;
  }): Promise<"consumed" | "invalid">;
  markEmailLoginCodeSent(id: string, outcome: EmailLoginCodeSendOutcome): Promise<void>;
  listActiveIdentityProviders(accountId: string): Promise<AuthIdentityProvider[]>;
}

export interface AuthStore extends RiskEventStore, Partial<EmailLoginStore> {
  findAccountByGoogleSubject(subject: string): Promise<AuthAccountRecord | null>;
  createOrLoadGoogleAccount(identity: VerifiedGoogleIdentity): Promise<AccountIdentityResult>;
  findAccountByAppleSubject?(subject: string): Promise<AuthAccountRecord | null>;
  createOrLoadAppleAccount?(identity: VerifiedAppleIdentity): Promise<AppleAccountIdentityResult>;
  linkAppleIdentity?(input: {
    accountId: string;
    sessionId: string;
    identity: VerifiedAppleIdentity;
    now: Date;
  }): Promise<{ identityId: string }>;
  updateLastLogin(accountId: string, now: Date): Promise<void>;
  findPlayerByAccountId(accountId: string): Promise<AuthPlayerRecord | null>;
  ensureDevice(input: {
    tokenHash: string;
    browserFamily: string;
    osFamily: string;
    now: Date;
  }): Promise<DeviceInstallationRecord>;
  linkAccountDevice(accountId: string, deviceInstallationId: string, now: Date): Promise<AccountDeviceLinkResult>;
  countRecentAuthEvents(filter: RecentAuthEventFilter): Promise<number>;
  countRecentDistinctAccounts(input: {
    eventTypes: string[];
    since: Date;
    deviceInstallationId: string;
  }): Promise<number>;
  reserveLoginAttempt(input: {
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }): Promise<RateLimitReservation>;
  reserveAccountCreationAttempt(input: {
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }): Promise<RateLimitReservation>;
  insertAuthEvent(input: AuthEventInput, now?: Date): Promise<void>;
  consumeGoogleCredential(input: {
    credentialHash: string;
    deviceInstallationId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<boolean>;
  createSession(input: {
    id: string;
    accountId: string;
    identityId?: string | null;
    tokenHash: string;
    deviceInstallationId: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<StoredAuthSession | null>;
  touchSession(sessionId: string, now: Date): Promise<void>;
  revokeSessionByTokenHash(tokenHash: string, reason: string, now: Date): Promise<string | null>;
  revokeAllSessions(accountId: string, reason: string, now: Date): Promise<string[]>;
  cleanup(before: {
    sessionExpiry: Date;
    telemetryCreatedAt: Date;
    credentialExpiry: Date;
    emailLoginCodeExpiry?: Date;
  }): Promise<{
    sessionsDeleted: number;
    authEventsDeleted: number;
    credentialUsesDeleted: number;
    emailLoginCodesDeleted?: number;
  }>;
}

export type RateLimitReservation = {
  allowed: boolean;
  deviceCount: number;
  networkCount: number;
};

type AccountRow = {
  id: string;
  status: "active" | "suspended" | "deleted";
  trust_tier: "new" | "standard" | "trusted" | "restricted";
  risk_score: number;
  test_access_status: "pending" | "approved" | "denied" | "revoked";
  test_access_requested_at: Date;
  test_access_decided_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
};

type PlayerRow = {
  id: string;
  account_id: string;
  username: string;
  personal_flag_color: "red" | "blue" | "green" | "gold" | "purple";
  onboarding_completed_at: Date;
};

type SessionRow = AccountRow & {
  session_id: string;
  identity_id: string;
  identity_provider: AuthIdentityProvider;
  verified_google_subject: string | null;
  verified_email: string;
  device_installation_id: string | null;
  session_created_at: Date;
  session_last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  player_id: string | null;
  player_account_id: string | null;
  player_username: string | null;
  player_personal_flag_color: "red" | "blue" | "green" | "gold" | "purple" | null;
  player_onboarding_completed_at: Date | null;
  account_session_version: string | number;
  session_account_session_version: string | number;
};

export class PostgresAuthStore implements AuthStore, EmailLoginStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig
  ) {}

  findAccountByGoogleSubject(subject: string): Promise<AuthAccountRecord | null> {
    return findAccountBySubject(this.pool, subject);
  }

  async createOrLoadGoogleAccount(
    identity: VerifiedGoogleIdentity
  ): Promise<AccountIdentityResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const emailNormalized = normalizeEmail(identity.email);
      const emailCanonical = canonicalEmail(emailNormalized);
      await lockCanonicalEmail(client, emailCanonical);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`test-access-email:${emailNormalized}`]
      );
      const existing = await findAccountBySubject(client, identity.subject);
      if (existing) {
        await updateIdentity(client, existing.id, identity);
        await applyIdentityAccessDecision(client, this.config, existing, googleAccessIdentity(identity));
        const refreshed = await findAccountBySubject(client, identity.subject);
        if (!refreshed) throw new Error("updated Google account disappeared");
        const identityRow = await findIdentityBySubject(client, "google", identity.subject);
        await client.query("COMMIT");
        return {
          account: refreshed,
          created: false,
          ...(identityRow ? { identityId: identityRow.id } : {})
        };
      }

      // Never auto-merge: a new Google sign-in whose verified mailbox (canonical
      // form) already belongs to an email-code account must be linked from there.
      const emailProviderConflict = await client.query(
        `SELECT 1 FROM account_identities
         WHERE provider = 'email' AND email_canonical = $1 AND email_verified = true
         LIMIT 1`,
        [emailCanonical]
      );
      if (emailProviderConflict.rowCount) {
        throw objectError(
          "ACCOUNT_LINK_REQUIRED",
          "This email already belongs to an email sign-in account; link Google from that account"
        );
      }

      const accountId = crypto.randomUUID();
      const accountResult = await client.query<AccountRow>(
        `
        INSERT INTO accounts (
          id, status, trust_tier, risk_score,
          test_access_status, test_access_requested_at
        )
        VALUES ($1, 'active', 'new', 0, 'pending', now())
        RETURNING id, status, trust_tier, risk_score,
                  test_access_status, test_access_requested_at, test_access_decided_at,
                  created_at, last_login_at
        `,
        [accountId]
      );
      const identityInsert = await client.query<{ id: string; account_id: string }>(
        `
        INSERT INTO account_identities (
          id, account_id, provider, provider_subject, email, email_normalized, email_verified,
          google_auth_time, google_auth_methods
        )
        VALUES ($1, $2, 'google', $3, $4, $5, true, $6, $7)
        ON CONFLICT (provider, provider_subject) DO NOTHING
        RETURNING id, account_id
        `,
        [
          crypto.randomUUID(),
          accountId,
          identity.subject,
          identity.email,
          emailNormalized,
          identity.authTime,
          identity.authMethods
        ]
      );
      if (identityInsert.rowCount === 0) {
        await client.query("DELETE FROM accounts WHERE id = $1", [accountId]);
        const winner = await findAccountBySubject(client, identity.subject);
        if (!winner) {
          throw new Error("concurrent Google account creation did not produce an identity");
        }
        await updateIdentity(client, winner.id, identity);
        await applyIdentityAccessDecision(client, this.config, winner, googleAccessIdentity(identity));
        const refreshedWinner = await findAccountBySubject(client, identity.subject);
        if (!refreshedWinner) throw new Error("concurrent Google account winner disappeared");
        const winnerIdentity = await findIdentityBySubject(client, "google", identity.subject);
        await client.query("COMMIT");
        return {
          account: refreshedWinner,
          created: false,
          ...(winnerIdentity ? { identityId: winnerIdentity.id } : {})
        };
      }

      const insertedAccount = accountFromRow(requireRow(accountResult.rows[0]));
      await insertTestAccessEvent(client, {
        eventType: "pending_requested",
        targetAccountId: accountId,
        previousStatus: null,
        newStatus: "pending",
        runtimeReleaseSha: this.config.RUNTIME_SHA ?? null,
        operationKey: `pending-requested:${accountId}`
      });
      await applyIdentityAccessDecision(client, this.config, insertedAccount, googleAccessIdentity(identity));
      const finalAccount = await findAccountBySubject(client, identity.subject);
      if (!finalAccount) throw new Error("created Google account disappeared");
      await client.query("COMMIT");
      return { account: finalAccount, created: true, identityId: requireRow(identityInsert.rows[0]).id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findAccountByAppleSubject(subject: string): Promise<AuthAccountRecord | null> {
    return findAccountBySubject(this.pool, subject, "apple");
  }

  async createOrLoadAppleAccount(
    identity: VerifiedAppleIdentity
  ): Promise<AppleAccountIdentityResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`apple-subject:${identity.subject}`]
      );
      const existing = await findIdentityBySubject(client, "apple", identity.subject);
      if (existing) {
        if (existing.identity_status === "revoked") {
          throw objectError("APPLE_IDENTITY_REVOKED", "Apple identity has been revoked");
        }
        await updateAppleIdentity(client, existing.id, identity);
        const account = await findAccountById(client, existing.account_id);
        if (!account) throw new Error("Apple account disappeared");
        await client.query("COMMIT");
        return { account, created: false, provider: "apple", identityId: existing.id };
      }
      const normalizedEmail = identity.email ? normalizeEmail(identity.email) : null;
      if (normalizedEmail) {
        const emailCanonical = canonicalEmail(normalizedEmail);
        await lockCanonicalEmail(client, emailCanonical);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`apple-email:${normalizedEmail}`]
        );
        const emailConflict = await client.query<{ account_id: string }>(
          `SELECT account_id FROM account_identities
           WHERE email_canonical = $1 AND email_verified = true
           LIMIT 1 FOR UPDATE`,
          [emailCanonical]
        );
        if (emailConflict.rowCount) {
          throw objectError("ACCOUNT_LINK_REQUIRED", "This email already belongs to an account; sign in with Google and link Apple explicitly");
        }
      }
      const accountId = crypto.randomUUID();
      const accountResult = await client.query<AccountRow>(
        `INSERT INTO accounts (
           id, status, trust_tier, risk_score,
           test_access_status, test_access_requested_at
         ) VALUES ($1, 'active', 'new', 0, 'pending', now())
         RETURNING id, status, trust_tier, risk_score,
                   test_access_status, test_access_requested_at,
                   test_access_decided_at, created_at, last_login_at`,
        [accountId]
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO account_identities (
           id, account_id, provider, provider_subject, email, email_normalized,
           email_verified, apple_email_private, identity_status, last_verified_at
         ) VALUES ($1, $2, 'apple', $3, $4, $5, $6, $7, 'active', $8)
         RETURNING id`,
        [
          crypto.randomUUID(),
          accountId,
          identity.subject,
          identity.email,
          normalizedEmail,
          identity.email ? identity.emailVerified : null,
          identity.isPrivateEmail,
          identity.authTime ?? new Date()
        ]
      );
      const account = accountFromRow(requireRow(accountResult.rows[0]));
      await insertTestAccessEvent(client, {
        eventType: "pending_requested",
        targetAccountId: accountId,
        previousStatus: null,
        newStatus: "pending",
        runtimeReleaseSha: this.config.RUNTIME_SHA ?? null,
        operationKey: `pending-requested:${accountId}`
      });
      await client.query("COMMIT");
      return { account, created: true, provider: "apple", identityId: requireRow(inserted.rows[0]).id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async linkAppleIdentity(input: {
    accountId: string;
    sessionId: string;
    identity: VerifiedAppleIdentity;
    now: Date;
  }): Promise<{ identityId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM accounts WHERE id = $1 FOR UPDATE",
        [input.accountId]
      );
      if (account.rowCount !== 1 || account.rows[0]?.status !== "active") {
        throw objectError("ACCOUNT_UNAVAILABLE", "Account unavailable");
      }
      const session = await client.query<{ id: string }>(
        `SELECT id FROM auth_sessions
         WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
           AND expires_at > $3 FOR UPDATE`,
        [input.sessionId, input.accountId, input.now]
      );
      if (session.rowCount !== 1) throw objectError("AUTHENTICATION_REQUIRED", "Recent account session required");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`apple-subject:${input.identity.subject}`]
      );
      const existing = await findIdentityBySubject(client, "apple", input.identity.subject);
      if (existing && existing.account_id !== input.accountId) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Apple identity is linked to another account");
      }
      if (existing) {
        if (existing.identity_status === "revoked") {
          throw objectError("APPLE_IDENTITY_REVOKED", "Apple identity has been revoked");
        }
        await updateAppleIdentity(client, existing.id, input.identity);
        await client.query("COMMIT");
        return { identityId: existing.id };
      }
      const normalizedEmail = input.identity.email ? normalizeEmail(input.identity.email) : null;
      if (normalizedEmail) {
        await lockCanonicalEmail(client, canonicalEmail(normalizedEmail));
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`apple-email:${normalizedEmail}`]
        );
      }
      const accountEmailConflict = normalizedEmail
        ? await client.query<{ account_id: string }>(
            `SELECT account_id FROM account_identities
             WHERE email_canonical = $1 AND email_verified = true
               AND account_id <> $2 LIMIT 1 FOR UPDATE`,
            [canonicalEmail(normalizedEmail), input.accountId]
          )
        : { rowCount: 0 };
      if (accountEmailConflict.rowCount) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Apple email belongs to another account");
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO account_identities (
           id, account_id, provider, provider_subject, email, email_normalized,
           email_verified, apple_email_private, identity_status, last_verified_at
         ) VALUES ($1, $2, 'apple', $3, $4, $5, $6, $7, 'active', $8)
         RETURNING id`,
        [
          crypto.randomUUID(),
          input.accountId,
          input.identity.subject,
          input.identity.email,
          normalizedEmail,
          input.identity.email ? input.identity.emailVerified : null,
          input.identity.isPrivateEmail,
          input.identity.authTime ?? new Date()
        ]
      );
      await client.query("COMMIT");
      return { identityId: requireRow(inserted.rows[0]).id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  findAccountByEmailIdentity(emailNormalized: string): Promise<AuthAccountRecord | null> {
    return findAccountBySubject(this.pool, emailNormalized, "email");
  }

  async createOrLoadEmailAccount(
    identity: VerifiedEmailIdentity
  ): Promise<EmailAccountIdentityResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The subject is the canonical mailbox, so aliases (+tags, Gmail dots)
      // of an existing address load that account instead of creating one.
      const emailCanonical = canonicalEmail(identity.subject);
      await lockEmailIdentity(client, emailCanonical, normalizeEmail(identity.email));
      const accessIdentity: AccessDecisionIdentity = {
        provider: "email",
        subject: emailCanonical,
        email: identity.email,
        authMethods: null
      };
      const existing = await findIdentityBySubject(client, "email", emailCanonical);
      if (existing) {
        if (existing.identity_status !== "active") {
          throw objectError("ACCOUNT_UNAVAILABLE", "Email identity is not active");
        }
        await client.query(
          "UPDATE account_identities SET last_verified_at = $2 WHERE id = $1",
          [existing.id, identity.authTime]
        );
        const account = await findAccountById(client, existing.account_id);
        if (!account) throw new Error("email account disappeared");
        await applyIdentityAccessDecision(client, this.config, account, accessIdentity);
        const refreshed = await findAccountById(client, existing.account_id);
        if (!refreshed) throw new Error("email account disappeared");
        await client.query("COMMIT");
        return { account: refreshed, created: false, provider: "email", identityId: existing.id };
      }
      const conflict = await client.query(
        `SELECT 1 FROM account_identities
         WHERE email_canonical = $1 AND email_verified = true
         LIMIT 1`,
        [emailCanonical]
      );
      if (conflict.rowCount) {
        throw objectError(
          "ACCOUNT_LINK_REQUIRED",
          "This email already belongs to an account; sign in there and link email explicitly"
        );
      }
      const accountId = crypto.randomUUID();
      const accountResult = await client.query<AccountRow>(
        `INSERT INTO accounts (
           id, status, trust_tier, risk_score,
           test_access_status, test_access_requested_at
         ) VALUES ($1, 'active', 'new', 0, 'pending', now())
         RETURNING id, status, trust_tier, risk_score,
                   test_access_status, test_access_requested_at,
                   test_access_decided_at, created_at, last_login_at`,
        [accountId]
      );
      const inserted = await insertEmailIdentity(client, accountId, emailCanonical, identity);
      await insertTestAccessEvent(client, {
        eventType: "pending_requested",
        targetAccountId: accountId,
        previousStatus: null,
        newStatus: "pending",
        runtimeReleaseSha: this.config.RUNTIME_SHA ?? null,
        operationKey: `pending-requested:${accountId}`
      });
      await applyIdentityAccessDecision(
        client,
        this.config,
        accountFromRow(requireRow(accountResult.rows[0])),
        accessIdentity
      );
      const account = await findAccountById(client, accountId);
      if (!account) throw new Error("created email account disappeared");
      await client.query("COMMIT");
      return { account, created: true, provider: "email", identityId: inserted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async linkEmailIdentity(input: {
    accountId: string;
    sessionId: string;
    identity: VerifiedEmailIdentity;
    now: Date;
  }): Promise<{ identityId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await requireActiveLinkSession(client, input.accountId, input.sessionId, input.now);
      const emailCanonical = canonicalEmail(input.identity.subject);
      await lockEmailIdentity(client, emailCanonical, normalizeEmail(input.identity.email));
      const existing = await findIdentityBySubject(client, "email", emailCanonical);
      if (existing && existing.account_id !== input.accountId) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Email is linked to another account");
      }
      if (existing) {
        await client.query(
          "UPDATE account_identities SET last_verified_at = $2 WHERE id = $1",
          [existing.id, input.identity.authTime]
        );
        await client.query("COMMIT");
        return { identityId: existing.id };
      }
      const current = await client.query(
        "SELECT 1 FROM account_identities WHERE account_id = $1 AND provider = 'email'",
        [input.accountId]
      );
      if (current.rowCount) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Account already has a different email sign-in");
      }
      const otherAccount = await client.query(
        `SELECT 1 FROM account_identities
         WHERE email_canonical = $1 AND email_verified = true AND account_id <> $2
         LIMIT 1`,
        [emailCanonical, input.accountId]
      );
      if (otherAccount.rowCount) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Email belongs to another account");
      }
      const identityId = await insertEmailIdentity(
        client,
        input.accountId,
        emailCanonical,
        input.identity
      );
      await client.query("COMMIT");
      return { identityId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async linkGoogleIdentity(input: {
    accountId: string;
    identity: VerifiedGoogleIdentity;
    now: Date;
  }): Promise<{ identityId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ status: string }>(
        "SELECT status FROM accounts WHERE id = $1 FOR UPDATE",
        [input.accountId]
      );
      if (account.rows[0]?.status !== "active") {
        throw objectError("ACCOUNT_UNAVAILABLE", "Account unavailable");
      }
      const emailNormalized = normalizeEmail(input.identity.email);
      const emailCanonical = canonicalEmail(emailNormalized);
      await lockCanonicalEmail(client, emailCanonical);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`test-access-email:${emailNormalized}`]
      );
      const existing = await findIdentityBySubject(client, "google", input.identity.subject);
      if (existing && existing.account_id !== input.accountId) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Google identity is linked to another account");
      }
      if (existing) {
        await updateIdentity(client, input.accountId, input.identity);
        await client.query("COMMIT");
        return { identityId: existing.id };
      }
      const current = await client.query(
        "SELECT 1 FROM account_identities WHERE account_id = $1 AND provider = 'google'",
        [input.accountId]
      );
      if (current.rowCount) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Account already has a different Google sign-in");
      }
      const emailMatch = await client.query(
        `SELECT 1 FROM account_identities
         WHERE account_id = $1 AND email_canonical = $2 AND email_verified = true
           AND identity_status = 'active'
         LIMIT 1`,
        [input.accountId, emailCanonical]
      );
      if (!emailMatch.rowCount) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Google email does not match this account");
      }
      const otherAccount = await client.query(
        `SELECT 1 FROM account_identities
         WHERE email_canonical = $1 AND email_verified = true AND account_id <> $2
         LIMIT 1`,
        [emailCanonical, input.accountId]
      );
      if (otherAccount.rowCount) {
        throw objectError("ACCOUNT_LINK_CONFLICT", "Google email belongs to another account");
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO account_identities (
           id, account_id, provider, provider_subject, email, email_normalized, email_verified,
           google_auth_time, google_auth_methods, identity_status, last_verified_at
         )
         VALUES ($1, $2, 'google', $3, $4, $5, true, $6, $7, 'active', $8)
         RETURNING id`,
        [
          crypto.randomUUID(),
          input.accountId,
          input.identity.subject,
          input.identity.email,
          emailNormalized,
          input.identity.authTime,
          input.identity.authMethods,
          input.now
        ]
      );
      await client.query("COMMIT");
      return { identityId: requireRow(inserted.rows[0]).id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  reserveEmailCodeRequest(input: {
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }): Promise<RateLimitReservation> {
    return reserveAuthAttempt(this.pool, {
      ...input,
      eventType: "email_code_request",
      networkScope: "full"
    });
  }

  async createEmailLoginCode(input: {
    id: string;
    emailNormalized: string;
    codeHash: string;
    purpose: EmailLoginCodePurpose;
    accountId?: string | null;
    sessionId?: string | null;
    deviceInstallationId: string | null;
    networkHash: string | null;
    now: Date;
    expiresAt: Date;
    limits: { resendAfterSeconds: number; perTenMinutes: number; perDay: number };
  }): Promise<EmailLoginCodeCreation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`email-login-code:${input.emailNormalized}`]
      );
      const nowMs = input.now.getTime();
      const recent = await client.query<{
        latest_same_purpose: Date | null;
        ten_minute_count: number;
        ten_minute_oldest: Date | null;
        day_count: number;
        day_oldest: Date | null;
      }>(
        `SELECT
           max(created_at) FILTER (WHERE purpose = $2) AS latest_same_purpose,
           count(*) FILTER (WHERE created_at > $3)::int AS ten_minute_count,
           min(created_at) FILTER (WHERE created_at > $3) AS ten_minute_oldest,
           count(*)::int AS day_count,
           min(created_at) AS day_oldest
         FROM email_login_codes
         WHERE email_normalized = $1 AND created_at > $4`,
        [
          input.emailNormalized,
          input.purpose,
          new Date(nowMs - 10 * 60_000),
          new Date(nowMs - 24 * 60 * 60_000)
        ]
      );
      const row = requireRow(recent.rows[0]);
      const retryCandidates: number[] = [];
      if (row.latest_same_purpose) {
        const resendAt = new Date(row.latest_same_purpose).getTime() +
          input.limits.resendAfterSeconds * 1_000;
        if (resendAt > nowMs) retryCandidates.push(resendAt);
      }
      if (row.ten_minute_count >= input.limits.perTenMinutes && row.ten_minute_oldest) {
        retryCandidates.push(new Date(row.ten_minute_oldest).getTime() + 10 * 60_000);
      }
      if (row.day_count >= input.limits.perDay && row.day_oldest) {
        retryCandidates.push(new Date(row.day_oldest).getTime() + 24 * 60 * 60_000);
      }
      if (retryCandidates.length > 0) {
        await client.query("COMMIT");
        return { status: "throttled", retryAt: new Date(Math.max(...retryCandidates)) };
      }
      await client.query(
        `UPDATE email_login_codes
         SET invalidated_at = $3, invalidation_reason = 'superseded'
         WHERE email_normalized = $1 AND purpose = $2
           AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [input.emailNormalized, input.purpose, input.now]
      );
      await client.query(
        `INSERT INTO email_login_codes (
           id, email_normalized, code_hash, purpose, account_id, session_id,
           device_installation_id, network_hash, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.id,
          input.emailNormalized,
          input.codeHash,
          input.purpose,
          input.accountId ?? null,
          input.sessionId ?? null,
          input.deviceInstallationId,
          input.networkHash,
          input.now,
          input.expiresAt
        ]
      );
      await client.query("COMMIT");
      return { status: "created" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeEmailLoginCode(input: {
    emailNormalized: string;
    purpose: EmailLoginCodePurpose;
    codeHash: string;
    accountId?: string | null;
    now: Date;
  }): Promise<"consumed" | "invalid"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query<{ id: string; code_hash: string; attempt_count: number }>(
        `SELECT id, code_hash, attempt_count
         FROM email_login_codes
         WHERE email_normalized = $1 AND purpose = $2
           AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > $3
           AND ($4::uuid IS NULL OR account_id = $4)
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.emailNormalized, input.purpose, input.now, input.accountId ?? null]
      );
      const code = active.rows[0];
      if (!code) {
        await client.query("COMMIT");
        return "invalid";
      }
      if (hexDigestsEqual(code.code_hash, input.codeHash)) {
        await client.query(
          "UPDATE email_login_codes SET consumed_at = $2 WHERE id = $1",
          [code.id, input.now]
        );
        await client.query("COMMIT");
        return "consumed";
      }
      await client.query(
        `UPDATE email_login_codes
         SET attempt_count = attempt_count + 1,
             invalidated_at = CASE WHEN attempt_count + 1 >= $3::int
               THEN $2::timestamptz ELSE NULL END,
             invalidation_reason = CASE WHEN attempt_count + 1 >= $3::int
               THEN 'attempts_exhausted' ELSE NULL END
         WHERE id = $1`,
        [code.id, input.now, EMAIL_LOGIN_CODE_MAX_ATTEMPTS]
      );
      await client.query("COMMIT");
      return "invalid";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markEmailLoginCodeSent(id: string, outcome: EmailLoginCodeSendOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE email_login_codes
       SET send_status = $2, send_provider = $3, send_message_id = $4, send_error = $5
       WHERE id = $1`,
      [
        id,
        outcome.status,
        outcome.provider.slice(0, 32),
        outcome.messageId?.slice(0, 256) ?? null,
        outcome.error?.slice(0, 1_000) ?? null
      ]
    );
  }

  async listActiveIdentityProviders(accountId: string): Promise<AuthIdentityProvider[]> {
    const result = await this.pool.query<{ provider: AuthIdentityProvider }>(
      `SELECT DISTINCT provider FROM account_identities
       WHERE account_id = $1 AND identity_status = 'active'
       ORDER BY provider`,
      [accountId]
    );
    return result.rows.map((row) => row.provider);
  }

  async updateLastLogin(accountId: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE accounts SET last_login_at = $2 WHERE id = $1", [accountId, now]);
  }

  async findPlayerByAccountId(accountId: string): Promise<AuthPlayerRecord | null> {
    const result = await this.pool.query<PlayerRow>(
      `SELECT id, account_id, username, personal_flag_color, onboarding_completed_at
       FROM players WHERE account_id = $1`,
      [accountId]
    );
    return result.rows[0] ? playerFromRow(result.rows[0]) : null;
  }

  async ensureDevice(input: {
    tokenHash: string;
    browserFamily: string;
    osFamily: string;
    now: Date;
  }): Promise<DeviceInstallationRecord> {
    const result = await this.pool.query<{ id: string; created: boolean }>(
      `
      INSERT INTO device_installations (
        id, token_hash, first_seen_at, last_seen_at, browser_family, os_family
      )
      VALUES ($1, $2, $3, $3, $4, $5)
      ON CONFLICT (token_hash) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at,
          browser_family = EXCLUDED.browser_family,
          os_family = EXCLUDED.os_family
      RETURNING id, (xmax = 0) AS created
      `,
      [crypto.randomUUID(), input.tokenHash, input.now, input.browserFamily, input.osFamily]
    );
    const row = requireRow(result.rows[0]);
    return { id: row.id, created: Boolean(row.created) };
  }

  async linkAccountDevice(
    accountId: string,
    deviceInstallationId: string,
    now: Date
  ): Promise<AccountDeviceLinkResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const device = await client.query(
        "SELECT id FROM device_installations WHERE id = $1 FOR UPDATE",
        [deviceInstallationId]
      );
      if (device.rowCount !== 1) {
        throw new Error("device installation does not exist");
      }
      const link = await client.query<{ created: boolean }>(
        `
        INSERT INTO account_device_links (
          account_id, device_installation_id, first_seen_at, last_seen_at, login_count
        )
        VALUES ($1, $2, $3, $3, 1)
        ON CONFLICT (account_id, device_installation_id) DO UPDATE
        SET last_seen_at = EXCLUDED.last_seen_at,
            login_count = account_device_links.login_count + 1
        RETURNING (xmax = 0) AS created
        `,
        [accountId, deviceInstallationId, now]
      );
      const count = await client.query<{ count: string }>(
        "SELECT count(DISTINCT account_id)::text AS count FROM account_device_links WHERE device_installation_id = $1",
        [deviceInstallationId]
      );
      await client.query("COMMIT");
      return {
        created: Boolean(requireRow(link.rows[0]).created),
        distinctAccountCount: Number(requireRow(count.rows[0]).count)
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async countRecentAuthEvents(filter: RecentAuthEventFilter): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_events
      WHERE event_type = ANY($1::text[])
        AND created_at >= $2
        AND ($3::uuid IS NULL OR device_installation_id = $3)
        AND ($4::text IS NULL OR network_hash = $4)
        AND ($5::text IS NULL OR network_prefix_hash = $5)
        AND ($6::uuid IS NULL OR account_id = $6)
      `,
      [
        filter.eventTypes,
        filter.since,
        filter.deviceInstallationId ?? null,
        filter.networkHash ?? null,
        filter.networkPrefixHash ?? null,
        filter.accountId ?? null
      ]
    );
    return Number(requireRow(result.rows[0]).count);
  }

  async countRecentDistinctAccounts(input: {
    eventTypes: string[];
    since: Date;
    deviceInstallationId: string;
  }): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
      SELECT count(DISTINCT account_id)::text AS count
      FROM auth_events
      WHERE event_type = ANY($1::text[])
        AND created_at >= $2
        AND device_installation_id = $3
        AND account_id IS NOT NULL
      `,
      [input.eventTypes, input.since, input.deviceInstallationId]
    );
    return Number(requireRow(result.rows[0]).count);
  }

  reserveLoginAttempt(input: {
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }): Promise<RateLimitReservation> {
    return reserveAuthAttempt(this.pool, {
      ...input,
      eventType: "google_login_attempt",
      networkScope: "full"
    });
  }

  reserveAccountCreationAttempt(input: {
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }): Promise<RateLimitReservation> {
    return reserveAuthAttempt(this.pool, {
      ...input,
      eventType: "account_creation_attempt",
      networkScope: "prefix"
    });
  }

  async insertAuthEvent(input: AuthEventInput, now = new Date()): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO auth_events (
        id, account_id, device_installation_id, event_type, network_hash,
        network_prefix_hash, network_key_version, metadata, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      `,
      [
        crypto.randomUUID(),
        input.accountId ?? null,
        input.deviceInstallationId ?? null,
        input.eventType,
        input.networkHash ?? null,
        input.networkPrefixHash ?? null,
        input.networkKeyVersion ?? null,
        serializeMetadata(input.metadata),
        now
      ]
    );
  }

  async consumeGoogleCredential(input: {
    credentialHash: string;
    deviceInstallationId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
      INSERT INTO auth_google_credential_uses (
        credential_hash, device_installation_id, created_at, expires_at
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (credential_hash) DO NOTHING
      `,
      [input.credentialHash, input.deviceInstallationId, input.now, input.expiresAt]
    );
    return result.rowCount === 1;
  }

  async createSession(input: {
    id: string;
    accountId: string;
    identityId?: string | null;
    tokenHash: string;
    deviceInstallationId: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ status: string; session_version: string | number }>(
        "SELECT status, session_version FROM accounts WHERE id = $1 FOR SHARE",
        [input.accountId]
      );
      const accountRow = account.rows[0];
      if (!accountRow || accountRow.status !== "active") {
        throw objectError("ACCOUNT_UNAVAILABLE", "account cannot create sessions");
      }
      const identityId = input.identityId ?? (await client.query<{ id: string }>(
        `SELECT id FROM account_identities
         WHERE account_id = $1 AND provider = 'google' AND identity_status = 'active'
         LIMIT 1`,
        [input.accountId]
      )).rows[0]?.id;
      if (!identityId) throw objectError("ACCOUNT_UNAVAILABLE", "account has no active login identity");
      await client.query(
        `
        INSERT INTO auth_sessions (
          id, account_id, identity_id, token_hash, device_installation_id,
          created_at, last_seen_at, expires_at, account_session_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
        `,
        [
          input.id,
          input.accountId,
          identityId,
          input.tokenHash,
          input.deviceInstallationId,
          input.createdAt,
          input.expiresAt,
          Number(accountRow.session_version)
        ]
      );
      await client.query(
        `
        INSERT INTO auth_events (
          id, account_id, device_installation_id, event_type, metadata, created_at
        )
        VALUES ($1, $2, $3, 'session_created', $4::jsonb, $5)
        `,
        [
          crypto.randomUUID(),
          input.accountId,
          input.deviceInstallationId,
          serializeMetadata({ sessionId: input.id }),
          input.createdAt
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredAuthSession | null> {
    const result = await this.pool.query<SessionRow>(
      `
      SELECT
        s.id AS session_id, s.device_installation_id,
        s.created_at AS session_created_at, s.last_seen_at AS session_last_seen_at,
        s.expires_at, s.revoked_at, s.revoke_reason,
         a.id, a.status, a.trust_tier, a.risk_score,
         a.test_access_status, a.test_access_requested_at, a.test_access_decided_at,
         a.created_at, a.last_login_at,
         i.id AS identity_id, i.provider AS identity_provider,
         CASE WHEN i.provider = 'google' THEN i.provider_subject ELSE NULL END AS verified_google_subject,
         COALESCE(i.email, '') AS verified_email,
         p.id AS player_id, p.account_id AS player_account_id, p.username AS player_username,
         p.personal_flag_color AS player_personal_flag_color,
         p.onboarding_completed_at AS player_onboarding_completed_at,
        a.session_version AS account_session_version,
        s.account_session_version AS session_account_session_version
      FROM auth_sessions s
      JOIN accounts a ON a.id = s.account_id
      JOIN account_identities i ON i.id = s.identity_id AND i.account_id = a.id
        AND i.identity_status = 'active'
      LEFT JOIN players p ON p.account_id = a.id
      WHERE s.token_hash = $1
      `,
      [tokenHash]
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1", [
      sessionId,
      now
    ]);
  }

  async revokeSessionByTokenHash(
    tokenHash: string,
    reason: string,
    now: Date
  ): Promise<string | null> {
    const result = await this.pool.query<{ account_id: string }>(
      `
      UPDATE auth_sessions
      SET revoked_at = COALESCE(revoked_at, $2),
          revoke_reason = COALESCE(revoke_reason, $3)
      WHERE token_hash = $1
      RETURNING account_id
      `,
      [tokenHash, now, reason]
    );
    return result.rows[0]?.account_id ?? null;
  }

  async revokeAllSessions(accountId: string, reason: string, now: Date): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query(
        "UPDATE accounts SET session_version = session_version + 1 WHERE id = $1 RETURNING id",
        [accountId]
      );
      if (account.rowCount !== 1) {
        throw objectError("ACCOUNT_UNAVAILABLE", "account does not exist");
      }
      const result = await client.query<{ id: string }>(
        `
        UPDATE auth_sessions
        SET revoked_at = $2, revoke_reason = $3
        WHERE account_id = $1 AND revoked_at IS NULL
        RETURNING id
        `,
        [accountId, now, reason]
      );
      await client.query("COMMIT");
      return result.rows.map((row) => row.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async insertRiskEvent(input: RiskEventInput): Promise<boolean> {
    const result = await this.pool.query(
      `
      INSERT INTO account_risk_events (
        id, account_id, device_installation_id, event_type, weight, dedupe_key, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      `,
      [
        crypto.randomUUID(),
        input.accountId,
        input.deviceInstallationId ?? null,
        input.eventType,
        input.weight,
        input.dedupeKey ?? null,
        serializeMetadata(input.metadata)
      ]
    );
    return result.rowCount === 1;
  }

  async recomputeAccountRiskScore(accountId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query(
        "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
        [accountId]
      );
      if (account.rowCount !== 1) {
        throw objectError("ACCOUNT_UNAVAILABLE", "account does not exist");
      }
      const result = await client.query<{ risk_score: number }>(
        `
        UPDATE accounts
        SET risk_score = LEAST(
          100,
          GREATEST(
            0,
            COALESCE((
              SELECT sum(weight)::integer
              FROM account_risk_events
              WHERE account_id = $1
            ), 0)
          )
        )
        WHERE id = $1
        RETURNING risk_score
        `,
        [accountId]
      );
      await client.query("COMMIT");
      return Number(requireRow(result.rows[0]).risk_score);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanup(before: {
    sessionExpiry: Date;
    telemetryCreatedAt: Date;
    credentialExpiry: Date;
    emailLoginCodeExpiry?: Date;
  }): Promise<{
    sessionsDeleted: number;
    authEventsDeleted: number;
    credentialUsesDeleted: number;
    emailLoginCodesDeleted: number;
  }> {
    // Codes reference auth_sessions (link purpose), so they go first.
    const emailCodes = before.emailLoginCodeExpiry
      ? await this.pool.query(
          "DELETE FROM email_login_codes WHERE expires_at < $1",
          [before.emailLoginCodeExpiry]
        )
      : { rowCount: 0 };
    const sessions = await this.pool.query(
      `
      DELETE FROM auth_sessions
      WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)
      `,
      [before.sessionExpiry]
    );
    const events = await this.pool.query(
      "DELETE FROM auth_events WHERE created_at < $1",
      [before.telemetryCreatedAt]
    );
    const credentialUses = await this.pool.query(
      "DELETE FROM auth_google_credential_uses WHERE expires_at < $1",
      [before.credentialExpiry]
    );
    return {
      sessionsDeleted: sessions.rowCount ?? 0,
      authEventsDeleted: events.rowCount ?? 0,
      credentialUsesDeleted: credentialUses.rowCount ?? 0,
      emailLoginCodesDeleted: emailCodes.rowCount ?? 0
    };
  }
}

async function reserveAuthAttempt(
  pool: pg.Pool,
  input: {
    eventType: "google_login_attempt" | "account_creation_attempt" | "email_code_request";
    networkScope: "full" | "prefix";
    deviceInstallationId: string;
    networkHash: string;
    networkPrefixHash: string;
    networkKeyVersion: string;
    since: Date;
    now: Date;
    deviceMax: number;
    networkMax: number;
  }
): Promise<RateLimitReservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const networkValue = input.networkScope === "full"
      ? input.networkHash
      : input.networkPrefixHash;
    const lockKeys = [
      `${input.eventType}:device:${input.deviceInstallationId}`,
      `${input.eventType}:network:${networkValue}`
    ].sort();
    for (const lockKey of lockKeys) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    }
    const counts = await client.query<{ device_count: string; network_count: string }>(
      `
      SELECT
        count(*) FILTER (WHERE device_installation_id = $3)::text AS device_count,
        count(*) FILTER (
          WHERE ($5 = 'full' AND network_hash = $4)
             OR ($5 = 'prefix' AND network_prefix_hash = $4)
        )::text AS network_count
      FROM auth_events
      WHERE event_type = $1
        AND created_at >= $2
        AND (
          device_installation_id = $3
          OR ($5 = 'full' AND network_hash = $4)
          OR ($5 = 'prefix' AND network_prefix_hash = $4)
        )
      `,
      [input.eventType, input.since, input.deviceInstallationId, networkValue, input.networkScope]
    );
    const row = requireRow(counts.rows[0]);
    const deviceCount = Number(row.device_count);
    const networkCount = Number(row.network_count);
    const allowed = deviceCount < input.deviceMax && networkCount < input.networkMax;
    if (allowed) {
      await client.query(
        `
        INSERT INTO auth_events (
          id, device_installation_id, event_type, network_hash,
          network_prefix_hash, network_key_version, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7)
        `,
        [
          crypto.randomUUID(),
          input.deviceInstallationId,
          input.eventType,
          input.networkHash,
          input.networkPrefixHash,
          input.networkKeyVersion,
          input.now
        ]
      );
    }
    await client.query("COMMIT");
    return { allowed, deviceCount, networkCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function findAccountBySubject(
  queryable: Pick<pg.PoolClient, "query">,
  subject: string,
  provider: AuthIdentityProvider = "google"
): Promise<AuthAccountRecord | null> {
  const result = await queryable.query<AccountRow>(
    `
    SELECT a.id, a.status, a.trust_tier, a.risk_score,
           a.test_access_status, a.test_access_requested_at, a.test_access_decided_at,
           a.created_at, a.last_login_at
    FROM account_identities i
    JOIN accounts a ON a.id = i.account_id
    WHERE i.provider = $2 AND i.provider_subject = $1
    `,
    [subject, provider]
  );
  return result.rows[0] ? accountFromRow(result.rows[0]) : null;
}

type IdentityRow = {
  id: string;
  account_id: string;
  provider: AuthIdentityProvider;
  provider_subject: string;
  email: string | null;
  email_verified: boolean | null;
  apple_email_private: boolean | null;
  identity_status: "active" | "revoked";
};

async function findIdentityBySubject(
  queryable: Pick<pg.PoolClient, "query">,
  provider: AuthIdentityProvider,
  subject: string
): Promise<IdentityRow | null> {
  const result = await queryable.query<IdentityRow>(
    `SELECT id, account_id, provider, provider_subject, email, email_verified,
            apple_email_private, identity_status
     FROM account_identities
     WHERE provider = $1 AND provider_subject = $2
     FOR UPDATE`,
    [provider, subject]
  );
  return result.rows[0] ?? null;
}

async function findAccountById(
  queryable: Pick<pg.PoolClient, "query">,
  accountId: string
): Promise<AuthAccountRecord | null> {
  const result = await queryable.query<AccountRow>(
    `SELECT id, status, trust_tier, risk_score,
            test_access_status, test_access_requested_at, test_access_decided_at,
            created_at, last_login_at
     FROM accounts WHERE id = $1`,
    [accountId]
  );
  return result.rows[0] ? accountFromRow(result.rows[0]) : null;
}

async function updateIdentity(
  queryable: Pick<pg.PoolClient, "query">,
  accountId: string,
  identity: VerifiedGoogleIdentity
): Promise<void> {
  await queryable.query(
    `
    UPDATE account_identities
    SET email = $2,
        email_normalized = $3,
        email_verified = true,
        google_auth_time = $4,
        google_auth_methods = $5
    WHERE account_id = $1 AND provider = 'google'
    `,
    [accountId, identity.email, normalizeEmail(identity.email), identity.authTime, identity.authMethods]
  );
}

async function updateAppleIdentity(
  queryable: Pick<pg.PoolClient, "query">,
  identityId: string,
  identity: VerifiedAppleIdentity
): Promise<void> {
  await queryable.query(
    `UPDATE account_identities
     SET email = COALESCE($2, email),
         email_normalized = COALESCE($3, email_normalized),
         email_verified = COALESCE($4, email_verified),
         apple_email_private = COALESCE($5, apple_email_private),
         last_verified_at = $6,
         identity_status = 'active',
         revoked_at = NULL,
         revocation_reason = NULL
     WHERE id = $1 AND provider = 'apple'`,
    [
      identityId,
      identity.email,
      identity.email ? normalizeEmail(identity.email) : null,
      identity.email ? identity.emailVerified : null,
      identity.isPrivateEmail,
      identity.authTime ?? new Date()
    ]
  );
}

/**
 * Serializes every identity creation/link (and test-access preapproval) for one
 * mailbox, whatever alias each provider reports. Always taken before the
 * test-access-email / apple-email locks to keep a single lock order.
 */
async function lockCanonicalEmail(
  queryable: Pick<pg.PoolClient, "query">,
  emailCanonical: string
): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`email-canonical:${emailCanonical}`]
  );
}

async function lockEmailIdentity(
  queryable: Pick<pg.PoolClient, "query">,
  emailCanonical: string,
  emailNormalized: string
): Promise<void> {
  await lockCanonicalEmail(queryable, emailCanonical);
  for (const key of [`test-access-email:${emailNormalized}`, `apple-email:${emailNormalized}`]) {
    await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

async function requireActiveLinkSession(
  queryable: Pick<pg.PoolClient, "query">,
  accountId: string,
  sessionId: string,
  now: Date
): Promise<void> {
  const account = await queryable.query<{ status: string }>(
    "SELECT status FROM accounts WHERE id = $1 FOR UPDATE",
    [accountId]
  );
  if (account.rows[0]?.status !== "active") {
    throw objectError("ACCOUNT_UNAVAILABLE", "Account unavailable");
  }
  const session = await queryable.query(
    `SELECT id FROM auth_sessions
     WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL AND expires_at > $3
     FOR UPDATE`,
    [sessionId, accountId, now]
  );
  if (session.rowCount !== 1) {
    throw objectError("AUTHENTICATION_REQUIRED", "Recent account session required");
  }
}

/** provider_subject is the canonical mailbox; email/email_normalized keep the typed address. */
async function insertEmailIdentity(
  queryable: Pick<pg.PoolClient, "query">,
  accountId: string,
  emailCanonical: string,
  identity: VerifiedEmailIdentity
): Promise<string> {
  const inserted = await queryable.query<{ id: string }>(
    `INSERT INTO account_identities (
       id, account_id, provider, provider_subject, email, email_normalized,
       email_verified, identity_status, last_verified_at
     ) VALUES ($1, $2, 'email', $3, $4, $5, true, 'active', $6)
     RETURNING id`,
    [
      crypto.randomUUID(),
      accountId,
      emailCanonical,
      identity.email,
      normalizeEmail(identity.email),
      identity.authTime
    ]
  );
  return requireRow(inserted.rows[0]).id;
}

function hexDigestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type AccessDecisionIdentity = {
  provider: "google" | "email";
  subject: string;
  email: string;
  authMethods: string[] | null;
};

function googleAccessIdentity(identity: VerifiedGoogleIdentity): AccessDecisionIdentity {
  return {
    provider: "google",
    subject: identity.subject,
    email: identity.email,
    authMethods: identity.authMethods
  };
}

async function applyIdentityAccessDecision(
  queryable: Pick<pg.PoolClient, "query">,
  config: AppConfig,
  account: AuthAccountRecord,
  identity: AccessDecisionIdentity
): Promise<void> {
  let grantId: string | null = null;
  if (account.testAccessStatus === "pending") {
    // Email identities match a grant by canonical mailbox, so a grant for
    // player@gmail.com also covers p.layer+game@gmail.com. Google stays exact.
    const grant = identity.provider === "email"
      ? await queryable.query<{ id: string }>(
          `SELECT id
           FROM test_access_email_grants
           WHERE auth_canonical_email(email_normalized) = $1 AND status = 'active'
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE`,
          [canonicalEmail(identity.email)]
        )
      : await queryable.query<{ id: string }>(
          `SELECT id
           FROM test_access_email_grants
           WHERE email_normalized = $1 AND status = 'active'
           FOR UPDATE`,
          [normalizeEmail(identity.email)]
        );
    grantId = grant.rows[0]?.id ?? null;
    if (grantId) {
      await queryable.query(
        `UPDATE test_access_email_grants
         SET status = 'claimed',
             claimed_account_id = $2,
             claimed_google_subject = CASE WHEN $4 = 'google' THEN $3 ELSE NULL END,
             claimed_provider = $4,
             claimed_subject = $3,
             claimed_at = now()
         WHERE id = $1 AND status = 'active'`,
        [grantId, account.id, identity.subject, identity.provider]
      );
      await insertTestAccessEvent(queryable, {
        eventType: "preapproval_claimed",
        targetAccountId: account.id,
        grantId,
        previousStatus: "active",
        newStatus: "claimed",
        runtimeReleaseSha: config.RUNTIME_SHA ?? null,
        operationKey: `preapproval-claimed:${grantId}`
      });
    }
  }

  const bootstrapAdmin =
    identity.provider === "google" &&
    config.TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS.includes(identity.subject);
  const developmentAutoApproval =
    identity.provider === "google" &&
    config.AUTH_RUNTIME_MODE !== "public" &&
    config.AUTH_MODE === "dev" &&
    identity.authMethods?.includes("dev") === true;
  const shouldApprove =
    bootstrapAdmin || developmentAutoApproval || grantId !== null;
  if (!shouldApprove) return;

  const previousStatus = account.testAccessStatus;
  const reason = bootstrapAdmin
    ? "configured_test_access_administrator_subject"
    : grantId
      ? "claimed_verified_email_preapproval"
      : "non_public_development_profile";
  await queryable.query(
    `UPDATE accounts
     SET test_access_status = 'approved',
         test_access_decided_at = now(),
         test_access_decided_by_account_id = NULL,
         test_access_decision_note = $2
     WHERE id = $1`,
    [account.id, reason]
  );
  const eventType = bootstrapAdmin
    ? "bootstrap_admin_approved"
    : developmentAutoApproval
      ? "development_auto_approved"
      : "account_approved";
  await insertTestAccessEvent(queryable, {
    eventType,
    targetAccountId: account.id,
    grantId,
    previousStatus,
    newStatus: "approved",
    reason,
    runtimeReleaseSha: config.RUNTIME_SHA ?? null,
    operationKey: `${eventType}:${account.id}`
  });
}

async function insertTestAccessEvent(
  queryable: Pick<pg.PoolClient, "query">,
  input: {
    eventType: string;
    actingAccountId?: string | null;
    targetAccountId?: string | null;
    grantId?: string | null;
    previousStatus?: string | null;
    newStatus?: string | null;
    reason?: string | null;
    runtimeReleaseSha?: string | null;
    operationKey?: string | null;
  }
): Promise<void> {
  await queryable.query(
    `INSERT INTO test_access_events (
       id, event_type, acting_account_id, target_account_id, grant_id,
       previous_status, new_status, reason, runtime_release_sha, operation_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      input.runtimeReleaseSha ?? null,
      input.operationKey ?? null
    ]
  );
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function accountFromRow(row: AccountRow): AuthAccountRecord {
  return {
    id: row.id,
    status: row.status,
    trustTier: row.trust_tier,
    riskScore: Number(row.risk_score),
    testAccessStatus: row.test_access_status,
    testAccessRequestedAt: new Date(row.test_access_requested_at),
    testAccessDecidedAt: row.test_access_decided_at
      ? new Date(row.test_access_decided_at)
      : null,
    createdAt: new Date(row.created_at),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null
  };
}

function playerFromRow(row: PlayerRow): AuthPlayerRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.username,
    personalFlagColor: row.personal_flag_color,
    onboardingCompletedAt: new Date(row.onboarding_completed_at)
  };
}

function sessionFromRow(row: SessionRow): StoredAuthSession {
  return {
    id: row.session_id,
    identityId: row.identity_id,
    identityProvider: row.identity_provider,
    verifiedGoogleSubject: row.verified_google_subject,
    verifiedEmail: row.verified_email,
    account: accountFromRow(row),
    player:
      row.player_id &&
        row.player_account_id &&
        row.player_username &&
        row.player_personal_flag_color &&
        row.player_onboarding_completed_at
        ? {
            id: row.player_id,
            accountId: row.player_account_id,
            displayName: row.player_username,
            personalFlagColor: row.player_personal_flag_color,
            onboardingCompletedAt: new Date(row.player_onboarding_completed_at)
          }
        : null,
    deviceInstallationId: row.device_installation_id,
    createdAt: new Date(row.session_created_at),
    lastSeenAt: new Date(row.session_last_seen_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    revokeReason: row.revoke_reason,
    accountSessionVersion: Number(row.account_session_version),
    sessionAccountVersion: Number(row.session_account_session_version)
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("auth query did not return a row");
  }
  return row;
}

function objectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string {
  const value = JSON.stringify(metadata ?? {});
  if (Buffer.byteLength(value, "utf8") > 12_000) {
    throw new Error("authentication metadata exceeds the storage limit");
  }
  return value;
}
