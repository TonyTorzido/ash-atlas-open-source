import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  createPrivateKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
  sign as signJwt
} from "node:crypto";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { AuthService } from "./authService.js";
import { AuthError, type LoginRequestContext, type VerifiedAppleIdentity } from "./types.js";

export const APPLE_CALLBACK_PATH = "/api/auth/apple/callback";
export const APPLE_AUTHORIZATION_ENDPOINT = "https://appleid.apple.com/auth/authorize";
export const APPLE_TOKEN_ENDPOINT = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_ENDPOINT = "https://appleid.apple.com/auth/revoke";
export const APPLE_JWKS_ENDPOINT = "https://appleid.apple.com/auth/keys";
export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_STATE_TTL_MS = 10 * 60_000;
export const APPLE_CLIENT_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60;

type FetchLike = typeof fetch;

type AppleAuthDependencies = Readonly<{
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  fetch?: FetchLike;
  verifyJws?: (token: string, options: VerifyJwsOptions) => Promise<Record<string, unknown>>;
}>;

type VerifyJwsOptions = Readonly<{
  audience?: string | readonly string[];
  nonceHash?: string;
  requireSubject?: boolean;
  maxAgeMs?: number;
}>;

type AppleTransaction = {
  id: string;
  state_hash: string;
  nonce_hash: string;
  intent: "signin" | "link";
  return_path: string;
  native_return: boolean;
  native_return_state: string | null;
  account_id: string | null;
  session_id: string | null;
  device_installation_id: string | null;
  network_hash: string | null;
  created_at: Date;
  expires_at: Date;
};

type AppleTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
};

type AppleJwk = {
  kty?: unknown;
  kid?: unknown;
  use?: unknown;
  alg?: unknown;
  crv?: unknown;
  x?: unknown;
  y?: unknown;
};

type StoredRefreshToken = Readonly<{
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}>;

export type AppleCallbackResult = Readonly<{
  kind: "login" | "link";
  returnPath: string;
  nativeReturn?: boolean;
  nativeReturnState?: string;
  login?: Awaited<ReturnType<AuthService["loginWithAppleIdentity"]>>;
}>;

export type AppleCallbackCancellation = Readonly<{
  returnPath: string;
  nativeReturn?: boolean;
  nativeReturnState?: string;
  outcome: "cancelled" | "provider_error";
}>;

export class NativeAppleLinkFailure extends Error {
  constructor(readonly returnState: string) { super("Apple linking was not completed"); }
}

export class AppleAuthService {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly fetcher: FetchLike;
  private jwksCache: { keys: AppleJwk[]; expiresAt: number } | null = null;
  private jwksRefresh: Promise<AppleJwk[]> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly pool: Pick<pg.Pool, "query" | "connect">,
    private readonly auth: AuthService,
    dependencies: AppleAuthDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.randomBytes ?? randomBytes;
    this.fetcher = dependencies.fetch ?? fetch;
    this.verifyJws = dependencies.verifyJws ?? ((token, options) => this.verifyJwsWithAppleKeys(token, options));
  }

  private readonly verifyJws: (
    token: string,
    options: VerifyJwsOptions
  ) => Promise<Record<string, unknown>>;

  get enabled(): boolean {
    return this.config.APPLE_SIGN_IN_ENABLED;
  }

  callbackUrl(): string {
    return new URL(APPLE_CALLBACK_PATH, this.config.APP_PUBLIC_ORIGIN).toString();
  }

  async begin(input: {
    intent: "signin" | "link";
    returnTo: string | undefined;
    nativeReturn?: boolean;
    nativeReturnState?: string;
    accountId?: string;
    sessionId?: string;
    deviceInstallationId?: string | null;
    networkHash?: string | null;
  }): Promise<string> {
    this.requireEnabled();
    if (input.intent === "link" && (!input.accountId || !input.sessionId)) {
      throw new AuthError("AUTHENTICATION_REQUIRED", "A current account session is required", 401);
    }
    const returnPath = allowlistedReturnPath(this.config.APP_PUBLIC_ORIGIN, input.returnTo);
    const state = this.random(32).toString("base64url");
    const nonce = this.random(32).toString("base64url");
    const now = this.now();
    await this.pool.query(
      `INSERT INTO apple_auth_transactions (
         id, state_hash, nonce_hash, intent, return_path,
         account_id, session_id, device_installation_id, network_hash,
         created_at, expires_at, native_return, native_return_state
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        randomUUID(),
        hashValue(state),
        hashValue(nonce),
        input.intent,
        returnPath,
        input.accountId ?? null,
        input.sessionId ?? null,
        input.deviceInstallationId ?? null,
        input.networkHash ?? null,
        now,
        new Date(now.getTime() + APPLE_STATE_TTL_MS),
        input.intent === "link" && input.nativeReturn === true,
        input.intent === "link" && input.nativeReturn === true ? input.nativeReturnState : null
      ]
    );
    return buildAppleAuthorizationUrl(this.config, state, nonce, this.callbackUrl());
  }

  /**
   * Apple may return a form_post containing only `state` and an error when a
   * player cancels authorization. Claim that state just like a successful
   * callback so a cancelled transaction cannot be replayed later.
   */
  async cancel(
    state: string,
    errorCode = "user_cancelled_authorize"
  ): Promise<AppleCallbackCancellation> {
    this.requireEnabled();
    if (!isAppleOpaqueValue(state)) {
      throw new AuthError("INVALID_APPLE_LOGIN", "Invalid Apple login state", 400);
    }
    const transaction = await this.claimTransaction(state);
    const sanitizedError = sanitizeAppleProviderError(errorCode);
    await this.pool.query(
      `UPDATE apple_auth_transactions
       SET consumed_at = $2, failure_code = $3
       WHERE id = $1 AND consumed_at IS NULL`,
      [transaction.id, this.now(), sanitizedError]
    );
    return {
      returnPath: transaction.return_path,
      ...(transaction.native_return && transaction.native_return_state ? { nativeReturn: true, nativeReturnState: transaction.native_return_state } : {}),
      outcome: sanitizedError === "user_cancelled_authorize" ? "cancelled" : "provider_error"
    };
  }

  async handleCallback(input: {
    state: string;
    code: string;
    context: LoginRequestContext;
    /**
     * Retained in the request shape for existing callers. Apple completes
     * `form_post` with a cross-site POST, so SameSite=Lax may omit the device
     * cookie and the client network may legitimately change. These values are
     * not used for callback authorization; the hashed transaction state and
     * nonce are the callback binding.
     */
    deviceInstallationId?: string | null;
    networkHash?: string | null;
  }): Promise<AppleCallbackResult> {
    this.requireEnabled();
    if (!isAppleOpaqueValue(input.state) || !isAppleOpaqueValue(input.code)) {
      throw new AuthError("INVALID_APPLE_LOGIN", "Invalid Apple login", 400);
    }
    const transaction = await this.claimTransaction(input.state);
    try {
      const token = await this.exchangeAuthorizationCode(input.code);
      const claims = await this.verifyJws(token.idToken, {
        audience: appleAcceptedAudiences(this.config),
        nonceHash: transaction.nonce_hash,
        requireSubject: true,
        maxAgeMs: 10 * 60_000
      });
      const identity = appleIdentityFromClaims(claims);
      let result: AppleCallbackResult;
      if (transaction.intent === "link") {
        if (!transaction.account_id || !transaction.session_id) {
          throw new AuthError("ACCOUNT_LINK_CONFLICT", "Apple link transaction is invalid", 409);
        }
        await this.auth.linkAppleIdentityForAccount({
          accountId: transaction.account_id,
          sessionId: transaction.session_id,
          identity
        });
        result = { kind: "link", returnPath: transaction.return_path, ...(transaction.native_return && transaction.native_return_state ? { nativeReturn: true, nativeReturnState: transaction.native_return_state } : {}) };
      } else {
        const login = await this.auth.loginWithAppleIdentity(identity, input.context);
        result = { kind: "login", returnPath: transaction.return_path, login };
      }
      if (token.refreshToken) {
        await this.storeRefreshToken(identity.subject, token.refreshToken);
      }
      await this.consumeTransaction(transaction.id);
      return result;
    } catch (error) {
      if (transaction.intent === "link" && transaction.native_return && transaction.native_return_state) {
        await this.pool.query("UPDATE apple_auth_transactions SET consumed_at=$2,failure_code='native_link_failed' WHERE id=$1", [transaction.id,this.now()]);
        throw new NativeAppleLinkFailure(transaction.native_return_state);
      }
      throw error;
    }
  }

  async nativeLinkStatus(accountId: string, sessionId: string, state: string): Promise<"pending" | "linked" | "failed"> {
    const result = await this.pool.query<{ consumed_at: Date | null; failure_code: string | null; expires_at: Date }>(
      `SELECT consumed_at,failure_code,expires_at FROM apple_auth_transactions
       WHERE account_id=$1 AND session_id=$2 AND native_return_state=$3 AND native_return AND intent='link'`, [accountId,sessionId,state]);
    const row = result.rows[0];
    if (!row) throw new AuthError("ACCOUNT_LINK_CONFLICT", "Apple linking is not available for this session", 409);
    if (row.failure_code || (!row.consumed_at && row.expires_at.getTime() <= this.now().getTime())) return "failed";
    return row.consumed_at ? "linked" : "pending";
  }

  async handleNotification(signedPayload: string): Promise<void> {
    this.requireEnabled();
    if (!isAppleOpaqueValue(signedPayload, 4_000_000)) {
      throw new AuthError("INVALID_APPLE_LOGIN", "Invalid Apple notification", 400);
    }
    const claims = await this.verifyJws(signedPayload, {
      audience: appleAcceptedAudiences(this.config),
      maxAgeMs: 7 * 24 * 60 * 60_000
    });
    if (claims.iss !== APPLE_ISSUER) {
      throw new AuthError("INVALID_APPLE_LOGIN", "Invalid Apple notification", 400);
    }
    const event = appleNotificationEvent(claims);
    const notificationType = (stringClaim(event, "type")
      ?? stringClaim(claims, "notificationType")
      ?? "").toLowerCase();
    const data = objectClaim(claims, "data");
    const userInfo = objectClaim(data, "userInfo");
    const subject = stringClaim(event, "sub")
      ?? stringClaim(userInfo, "sub")
      ?? stringClaim(claims, "sub");
    if (!subject) throw new AuthError("INVALID_APPLE_LOGIN", "Apple notification subject missing", 400);
    const privateEmail = booleanClaim(event, "is_private_email")
      ?? booleanClaim(event, "isPrivateEmail")
      ?? booleanClaim(userInfo, "isPrivateEmail");
    if (privateEmail !== null) {
      await this.pool.query(
        `UPDATE account_identities
         SET apple_email_private = $2
         WHERE provider = 'apple' AND provider_subject = $1`,
        [subject, privateEmail]
      );
    }
    if (notificationType === "email-enabled" || notificationType === "email-disabled") {
      await this.pool.query(
        `UPDATE account_identities
         SET apple_email_forwarding_enabled = $2
         WHERE provider = 'apple' AND provider_subject = $1`,
        [subject, notificationType === "email-enabled"]
      );
    }
    const identity = await this.pool.query<{ account_id: string; identity_status: string }>(
      `SELECT account_id, identity_status FROM account_identities
       WHERE provider = 'apple' AND provider_subject = $1
       FOR UPDATE`,
      [subject]
    );
    const row = identity.rows[0];
    if (!row) return;
    if (notificationType.includes("consent") && notificationType.includes("revok")) {
      await this.revokeIdentityAndSessions(row.account_id, subject, "apple_consent_revoked");
      return;
    }
    if (notificationType.includes("account") && notificationType.includes("delet")) {
      await this.suspendForAppleDeletion(row.account_id, subject);
      return;
    }
    // Forwarding-enabled/disabled and unknown future notifications are
    // informational only; no login identity is reactivated by notification.
  }

  async processRevocationJob(jobId: string): Promise<"completed" | "retry"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        identity_id: string;
        status: string;
        attempt_count: number;
        key_id: string | null;
        iv: string | null;
        tag: string | null;
        ciphertext: string | null;
      }>(
        `SELECT j.id, j.identity_id, j.status, j.attempt_count,
                i.apple_refresh_token_key_id AS key_id,
                i.apple_refresh_token_iv AS iv,
                i.apple_refresh_token_tag AS tag,
                i.apple_refresh_token_ciphertext AS ciphertext
         FROM apple_revocation_jobs j
         JOIN account_identities i ON i.id = j.identity_id
         WHERE j.id = $1 AND j.status IN ('pending', 'retry')
         FOR UPDATE OF j, i`,
        [jobId]
      );
      const job = result.rows[0];
      if (!job) {
        await client.query("ROLLBACK");
        return "completed";
      }
      await client.query(
        `UPDATE apple_revocation_jobs
         SET status = 'processing', processing_started_at = $2, attempt_count = attempt_count + 1
         WHERE id = $1`,
        [job.id, this.now()]
      );
      await client.query("COMMIT");
      if (!job.ciphertext || !job.iv || !job.tag || !job.key_id) {
        await this.finishRevocationJob(job.id, null);
        return "completed";
      }
      let refreshToken: string;
      try {
        refreshToken = decryptRefreshToken(this.config, {
          keyId: job.key_id,
          iv: job.iv,
          tag: job.tag,
          ciphertext: job.ciphertext
        });
      } catch {
        await this.failRevocationJob(job.id, "encrypted Apple token could not be decrypted");
        return "retry";
      }
      const response = await this.fetcher(APPLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.APPLE_SERVICES_ID,
          client_secret: createAppleClientSecret(this.config, this.now()),
          token: refreshToken,
          token_type_hint: "refresh_token"
        })
      });
      if (response.ok || response.status === 400) {
        await this.finishRevocationJob(job.id, null);
        return "completed";
      }
      await this.failRevocationJob(job.id, `Apple revocation HTTP ${response.status}`);
      return "retry";
    } finally {
      client.release();
    }
  }

  async processDueRevocationJobs(limit = 8): Promise<number> {
    if (!this.enabled) return 0;
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    const due = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM apple_revocation_jobs
       WHERE status IN ('pending', 'retry') AND next_attempt_at <= $1
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT $2`,
      [this.now(), boundedLimit]
    );
    for (const job of due.rows) {
      await this.processRevocationJob(job.id);
    }
    return due.rows.length;
  }

  async disconnect(accountId: string): Promise<void> {
    this.requireEnabled();
    const identity = await this.pool.query<{ id: string; provider_subject: string; token_key_id: string | null; iv: string | null; tag: string | null; ciphertext: string | null }>(
      `SELECT i.id, i.provider_subject,
              i.apple_refresh_token_key_id AS token_key_id,
              i.apple_refresh_token_iv AS iv,
              i.apple_refresh_token_tag AS tag,
              i.apple_refresh_token_ciphertext AS ciphertext
       FROM account_identities i
       WHERE i.account_id = $1 AND i.provider = 'apple' AND i.identity_status = 'active'
       FOR UPDATE`,
      [accountId]
    );
    const apple = identity.rows[0];
    if (!apple) throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple login is not linked", 404);
    const other = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM account_identities
       WHERE account_id = $1 AND provider <> 'apple' AND identity_status = 'active'`,
      [accountId]
    );
    if (Number(other.rows[0]?.count ?? 0) < 1) {
      throw new AuthError("ACCOUNT_LINK_CONFLICT", "Keep another login method before disconnecting Apple", 409);
    }
    if (apple.ciphertext && apple.iv && apple.tag && apple.token_key_id) {
      const refreshToken = decryptRefreshToken(this.config, {
        keyId: apple.token_key_id,
        iv: apple.iv,
        tag: apple.tag,
        ciphertext: apple.ciphertext
      });
      const response = await this.fetcher(APPLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.APPLE_SERVICES_ID,
          client_secret: createAppleClientSecret(this.config, this.now()),
          token: refreshToken,
          token_type_hint: "refresh_token"
        })
      });
      if (!response.ok && response.status !== 400) {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple token revocation is temporarily unavailable", 503);
      }
    }
    await this.pool.query(
      `UPDATE account_identities
       SET identity_status = 'revoked', revoked_at = $2,
           revocation_reason = 'user_disconnected',
           apple_refresh_token_key_id = NULL,
           apple_refresh_token_iv = NULL,
           apple_refresh_token_tag = NULL,
           apple_refresh_token_ciphertext = NULL,
           apple_refresh_token_validated_at = NULL
       WHERE id = $1`,
      [apple.id, this.now()]
    );
  }

  private async claimTransaction(state: string): Promise<AppleTransaction> {
    const result = await this.pool.query<AppleTransaction>(
      `UPDATE apple_auth_transactions
       SET claimed_at = $2
       WHERE state_hash = $1 AND claimed_at IS NULL AND consumed_at IS NULL
         AND expires_at > $2
       RETURNING id, state_hash, nonce_hash, intent, return_path, native_return, native_return_state,
                 account_id, session_id, device_installation_id, network_hash,
                 created_at, expires_at`,
      [hashValue(state), this.now()]
    );
    const transaction = result.rows[0];
    if (!transaction) throw new AuthError("INVALID_APPLE_LOGIN", "Apple login state is invalid or expired", 400);
    return transaction;
  }

  private async consumeTransaction(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE apple_auth_transactions SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
      [id, this.now()]
    );
  }

  private async exchangeAuthorizationCode(code: string): Promise<{ idToken: string; refreshToken: string | null }> {
    const response = await this.fetcher(APPLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: this.config.APPLE_SERVICES_ID,
        client_secret: createAppleClientSecret(this.config, this.now()),
        code,
        grant_type: "authorization_code",
        redirect_uri: this.callbackUrl()
      })
    });
    if (!response.ok) throw new AuthError("INVALID_APPLE_LOGIN", "Apple login could not be verified", 401);
    const body = await response.json() as AppleTokenResponse;
    const idToken = typeof body.id_token === "string" ? body.id_token : null;
    if (!idToken) throw new AuthError("INVALID_APPLE_LOGIN", "Apple login did not return an identity token", 401);
    return {
      idToken,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null
    };
  }

  private async storeRefreshToken(subject: string, refreshToken: string): Promise<void> {
    const encrypted = encryptRefreshToken(this.config, refreshToken, this.random);
    await this.pool.query(
      `UPDATE account_identities
       SET apple_refresh_token_key_id = $2,
           apple_refresh_token_iv = $3,
           apple_refresh_token_tag = $4,
           apple_refresh_token_ciphertext = $5,
           apple_refresh_token_validated_at = $6
       WHERE provider = 'apple' AND provider_subject = $1 AND identity_status = 'active'`,
      [subject, encrypted.keyId, encrypted.iv, encrypted.tag, encrypted.ciphertext, this.now()]
    );
  }

  private async revokeIdentityAndSessions(accountId: string, subject: string, reason: string): Promise<void> {
    const now = this.now();
    await this.pool.query(
      `UPDATE account_identities
       SET identity_status = 'revoked', revoked_at = $3, revocation_reason = $4,
           apple_refresh_token_key_id = NULL,
           apple_refresh_token_iv = NULL,
           apple_refresh_token_tag = NULL,
           apple_refresh_token_ciphertext = NULL,
           apple_refresh_token_validated_at = NULL
       WHERE account_id = $1 AND provider = 'apple' AND provider_subject = $2`,
      [accountId, subject, now, reason]
    );
    await this.pool.query(
      `UPDATE accounts SET session_version = session_version + 1 WHERE id = $1`,
      [accountId]
    );
    await this.pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, $3)
       WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, now, reason]
    );
  }

  private async suspendForAppleDeletion(accountId: string, subject: string): Promise<void> {
    const now = this.now();
    await this.revokeIdentityAndSessions(accountId, subject, "apple_account_deleted");
    await this.pool.query(
      `UPDATE accounts SET status = 'suspended', suspended_at = COALESCE(suspended_at, $2),
           suspension_reason = COALESCE(suspension_reason, 'apple_account_deleted')
       WHERE id = $1 AND status <> 'deleted'`,
      [accountId, now]
    );
    await this.pool.query(
      `INSERT INTO account_deletion_requests (
         id, account_id, request_key, email_normalized, request_source,
         status, requested_at, verified_at, updated_at, apple_revocation_required
       )
       SELECT $1, $2, $3, i.email_normalized, 'authenticated',
              'pending_processing', $4, $4, $4, false
       FROM account_identities i
       WHERE i.account_id = $2 AND i.provider = 'apple'
       ON CONFLICT DO NOTHING`,
      [randomUUID(), accountId, `apple:${subject}`, now]
    );
  }

  private async finishRevocationJob(jobId: string, error: string | null): Promise<void> {
    const now = this.now();
    await this.pool.query(
      `UPDATE apple_revocation_jobs
       SET status = 'completed', completed_at = $2, last_error = $3
       WHERE id = $1`,
      [jobId, now, error]
    );
    await this.pool.query(
      `UPDATE account_deletion_requests d
       SET apple_revocation_completed_at = $2,
           updated_at = $2
       WHERE d.id = (
         SELECT deletion_request_id FROM apple_revocation_jobs WHERE id = $1
       )
         AND NOT EXISTS (
           SELECT 1 FROM apple_revocation_jobs j
           WHERE j.deletion_request_id = d.id AND j.status <> 'completed'
         )`,
      [jobId, now]
    );
  }

  private async failRevocationJob(jobId: string, error: string): Promise<void> {
    const now = this.now();
    await this.pool.query(
      `UPDATE apple_revocation_jobs
       SET status = 'retry', next_attempt_at = $2 + interval '15 minutes', last_error = $3
       WHERE id = $1`,
      [jobId, now, error]
    );
  }

  private async verifyJwsWithAppleKeys(
    token: string,
    options: VerifyJwsOptions
  ): Promise<Record<string, unknown>> {
    const first = parseCompactJws(token);
    let keys = await this.appleKeys(false);
    let key = keys.find((candidate) => candidate.kid === first.header.kid);
    if (!key) {
      keys = await this.appleKeys(true);
      key = keys.find((candidate) => candidate.kid === first.header.kid);
    }
    if (!key || !verifyCompactJws(first, key)) {
      throw new AuthError("INVALID_APPLE_LOGIN", "Apple signature could not be verified", 401);
    }
    validateAppleClaims(first.payload, options, this.now());
    return first.payload;
  }

  private async appleKeys(forceRefresh: boolean): Promise<AppleJwk[]> {
    const now = this.now().getTime();
    if (!forceRefresh && this.jwksCache && this.jwksCache.expiresAt > now) return this.jwksCache.keys;
    if (this.jwksRefresh) return this.jwksRefresh;
    this.jwksRefresh = (async () => {
      const response = await this.fetcher(APPLE_JWKS_ENDPOINT, { headers: { accept: "application/json" } });
      if (!response.ok) throw new AuthError("INVALID_APPLE_LOGIN", "Apple key verification is unavailable", 503);
      const body = await response.json() as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? body.keys.filter(isAppleJwk) : [];
      if (!keys.length) throw new AuthError("INVALID_APPLE_LOGIN", "Apple key verification is unavailable", 503);
      this.jwksCache = { keys, expiresAt: this.now().getTime() + 60 * 60_000 };
      return keys;
    })().finally(() => {
      this.jwksRefresh = null;
    });
    return this.jwksRefresh;
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple login is not enabled", 404);
  }
}

export function buildAppleAuthorizationUrl(
  config: Pick<AppConfig, "APPLE_SERVICES_ID">,
  state: string,
  nonce: string,
  redirectUri: string
): string {
  const url = new URL(APPLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.APPLE_SERVICES_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "email");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export function createAppleClientSecret(
  config: Pick<AppConfig, "APPLE_TEAM_ID" | "APPLE_KEY_ID" | "APPLE_SERVICES_ID" | "APPLE_PRIVATE_KEY_P8_BASE64">,
  now: Date
): string {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const header = base64UrlJson({ alg: "ES256", kid: config.APPLE_KEY_ID, typ: "JWT" });
  const payload = base64UrlJson({
    iss: config.APPLE_TEAM_ID,
    iat: issuedAt,
    exp: issuedAt + APPLE_CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_ISSUER,
    sub: config.APPLE_SERVICES_ID
  });
  const signingInput = `${header}.${payload}`;
  const privateKeyBytes = Buffer.from(config.APPLE_PRIVATE_KEY_P8_BASE64, "base64");
  const privateKey = privateKeyBytes.toString("utf8").includes("BEGIN")
    ? createPrivateKey(privateKeyBytes.toString("utf8"))
    : createPrivateKey({ key: privateKeyBytes, format: "der", type: "pkcs8" });
  const signature = signJwt("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function encryptRefreshToken(
  config: Pick<AppConfig, "APPLE_REFRESH_TOKEN_KEY_ID" | "APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64">,
  plaintext: string,
  random: (size: number) => Buffer = randomBytes
): StoredRefreshToken {
  const key = Buffer.from(config.APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64, "base64");
  if (key.length !== 32) throw new Error("Apple refresh-token key must decode to 32 bytes");
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: config.APPLE_REFRESH_TOKEN_KEY_ID,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptRefreshToken(
  config: Pick<AppConfig, "APPLE_REFRESH_TOKEN_KEY_ID" | "APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64">,
  stored: StoredRefreshToken
): string {
  if (stored.keyId !== config.APPLE_REFRESH_TOKEN_KEY_ID) throw new Error("Apple refresh-token key version is unavailable");
  const key = Buffer.from(config.APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64, "base64");
  if (key.length !== 32) throw new Error("Apple refresh-token key must decode to 32 bytes");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(stored.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(stored.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function appleIdentityFromClaims(claims: Record<string, unknown>): VerifiedAppleIdentity {
  const subject = stringClaim(claims, "sub");
  if (!subject) throw new AuthError("INVALID_APPLE_LOGIN", "Apple subject is invalid", 401);
  const emailValue = claims.email;
  if (emailValue !== undefined && emailValue !== null && typeof emailValue !== "string") {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple email claim is invalid", 401);
  }
  return {
    provider: "apple",
    subject,
    email: typeof emailValue === "string" ? emailValue : null,
    // Apple email is a provider-verified claim when present; absence is
    // treated as unknown while the raw relay address remains informational.
    emailVerified: booleanClaim(claims, "email_verified") ?? true,
    isPrivateEmail: booleanClaim(claims, "is_private_email"),
    authTime: numberClaim(claims, "auth_time")
      ? new Date(numberClaim(claims, "auth_time")! * 1_000)
      : null,
    expiresAt: new Date(numberClaim(claims, "exp")! * 1_000)
  };
}

export function validateAppleClaims(
  claims: Record<string, unknown>,
  options: VerifyJwsOptions,
  now: Date
): void {
  if (claims.iss !== APPLE_ISSUER) throw new AuthError("INVALID_APPLE_LOGIN", "Apple issuer is invalid", 401);
  if (options.audience && !audienceMatches(claims.aud, options.audience)) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple audience is invalid", 401);
  }
  const exp = numberClaim(claims, "exp");
  const iat = numberClaim(claims, "iat");
  if (!exp || !iat || exp * 1_000 <= now.getTime() || iat * 1_000 > now.getTime() + 60_000) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple token is expired or not yet valid", 401);
  }
  if (options.maxAgeMs !== undefined && now.getTime() - iat * 1_000 > options.maxAgeMs) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple token is too old", 401);
  }
  if (options.requireSubject && !stringClaim(claims, "sub")) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple subject is missing", 401);
  }
  const nonce = stringClaim(claims, "nonce");
  if (options.nonceHash && (!nonce || !constantText(hashValue(nonce), options.nonceHash))) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple nonce is invalid", 401);
  }
  if (claims.email !== undefined && claims.email !== null && typeof claims.email !== "string") {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple email claim is invalid", 401);
  }
  if (claims.email_verified !== undefined && booleanClaim(claims, "email_verified") === null) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple email verification claim is invalid", 401);
  }
  if (claims.is_private_email !== undefined && booleanClaim(claims, "is_private_email") === null) {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple relay-email claim is invalid", 401);
  }
}

function parseCompactJws(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("INVALID_APPLE_LOGIN", "Apple token format is invalid", 401);
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
    const signature = Buffer.from(encodedSignature!, "base64url");
    if (header.alg !== "ES256" || typeof header.kid !== "string" || signature.length !== 64) throw new Error("invalid");
    return { header, payload, signingInput: `${encodedHeader}.${encodedPayload}`, signature };
  } catch {
    throw new AuthError("INVALID_APPLE_LOGIN", "Apple token format is invalid", 401);
  }
}

function verifyCompactJws(
  parsed: ReturnType<typeof parseCompactJws>,
  jwk: AppleJwk
): boolean {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return false;
  try {
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      format: "jwk"
    });
    return verifySignature("sha256", Buffer.from(parsed.signingInput), {
      key,
      dsaEncoding: "ieee-p1363"
    }, parsed.signature);
  } catch {
    return false;
  }
}

function isAppleJwk(value: unknown): value is AppleJwk {
  return Boolean(value && typeof value === "object" &&
    (value as AppleJwk).kty === "EC" &&
    typeof (value as AppleJwk).kid === "string" &&
    (value as AppleJwk).crv === "P-256" &&
    typeof (value as AppleJwk).x === "string" &&
    typeof (value as AppleJwk).y === "string");
}

function allowlistedReturnPath(origin: string, returnTo: string | undefined): string {
  const fallback = "/play/";
  if (!returnTo) return fallback;
  try {
    const url = new URL(returnTo, origin);
    const expected = new URL(origin);
    if (url.origin !== expected.origin || !url.pathname.startsWith("/") || url.pathname.startsWith("//")) {
      return fallback;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isAppleOpaqueValue(value: string, max = 512): boolean {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9._~-]+$/u.test(value);
}

function sanitizeAppleProviderError(value: string): string {
  const normalized = value.trim().toLowerCase();
  return new Set([
    "user_cancelled_authorize",
    "access_denied",
    "invalid_request",
    "unauthorized_client",
    "unsupported_response_type",
    "invalid_scope",
    "server_error",
    "temporarily_unavailable"
  ]).has(normalized) ? normalized : "provider_error";
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function constantText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The web Services ID is always accepted. The native app's bundle id (the `aud`
 * of an on-device Sign in with Apple identity token) is accepted only when
 * APPLE_NATIVE_BUNDLE_ID is configured; it is empty (denied) by default.
 */
export function appleAcceptedAudiences(
  config: Pick<AppConfig, "APPLE_SERVICES_ID" | "APPLE_NATIVE_BUNDLE_ID">
): readonly string[] {
  return config.APPLE_NATIVE_BUNDLE_ID
    ? [config.APPLE_SERVICES_ID, config.APPLE_NATIVE_BUNDLE_ID]
    : [config.APPLE_SERVICES_ID];
}

function audienceMatches(value: unknown, expected: string | readonly string[]): boolean {
  const accepted = typeof expected === "string" ? [expected] : expected;
  const single = typeof value === "string" ? value : Array.isArray(value) && value.length === 1 ? value[0] : null;
  return typeof single === "string" && accepted.includes(single);
}

function stringClaim(value: Record<string, unknown> | null | undefined, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function numberClaim(value: Record<string, unknown> | null | undefined, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function booleanClaim(value: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const candidate = value?.[key];
  if (typeof candidate === "boolean") return candidate;
  return null;
}

function objectClaim(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const candidate = value?.[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function appleNotificationEvent(claims: Record<string, unknown>): Record<string, unknown> {
  const raw = claims.events;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown>
          ?? {};
      }
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  if (Array.isArray(raw)) {
    return raw.find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown>
      ?? {};
  }
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}
