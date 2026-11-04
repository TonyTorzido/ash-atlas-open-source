import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { AccountDeletionService } from "./accountDeletionService.js";
import { AuthService } from "./authService.js";
import { PostgresAuthStore } from "./authStore.js";
import { canonicalEmail } from "./email/emailDomainPolicy.js";
import type { EmailMessage, EmailSender } from "./email/emailSender.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import { TestAccessService } from "./testAccessService.js";
import type { LoginRequestContext, VerifiedGoogleIdentity } from "./types.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const START = new Date("2026-10-01T12:00:00.000Z");

class CapturingEmailSender implements EmailSender {
  readonly provider = "log";
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage) {
    this.sent.push(message);
    return { provider: this.provider, messageId: null };
  }

  lastCode(): string {
    const code = this.sent.at(-1)?.diagnostics?.code;
    if (!code) throw new Error("no code was sent");
    return code;
  }
}

describeDatabase("email one-time-code sign-in (PostgreSQL)", () => {
  let pool: pg.Pool;
  let clock: Date;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
  }, 120_000);

  beforeEach(async () => {
    clock = new Date(START);
    await pool.query("TRUNCATE accounts, device_installations, email_login_codes CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
  });

  function harness(
    identities: Map<string, VerifiedGoogleIdentity> = new Map(),
    env: NodeJS.ProcessEnv = {}
  ): { auth: AuthService; sender: CapturingEmailSender; config: AppConfig } {
    const config = loadConfig({
      NODE_ENV: "test",
      AUTH_RUNTIME_MODE: "public",
      AUTH_MODE: "google",
      GOOGLE_CLIENT_ID: "test-client-id",
      AUTH_EMAIL_LOGIN_ENABLED: "true",
      // Added on top of the built-in mainstream-provider allowlist.
      AUTH_EMAIL_DOMAIN_ALLOWLIST: "example.com",
      AUTH_LOGIN_DEVICE_MAX: "1000",
      AUTH_LOGIN_IP_MAX: "1000",
      AUTH_NEW_ACCOUNT_EMAIL_DEVICE_MAX: "100",
      AUTH_NEW_ACCOUNT_EMAIL_NETWORK_MAX: "100",
      AUTH_NEW_ACCOUNT_DEVICE_MAX: "100",
      AUTH_NEW_ACCOUNT_NETWORK_MAX: "100",
      // An email address configured as a privileged Google subject must still
      // grant nothing to an email-code account.
      DEV_TOOLS_ENABLED: "true",
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: "owner@example.com,owner-google-subject",
      TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "owner@example.com",
      ...env
    });
    const sender = new CapturingEmailSender();
    const auth = new AuthService(
      config,
      new PostgresAuthStore(pool, config),
      new FakeGoogleIdentityVerifier(identities),
      { warn: vi.fn() } as never,
      () => new Date(clock),
      new TestAccessService(pool, config),
      sender
    );
    return { auth, sender, config };
  }

  async function signIn(h: ReturnType<typeof harness>, email: string) {
    await h.auth.startEmailLogin(email, context());
    return h.auth.verifyEmailLogin({ email, code: h.sender.lastCode() }, context());
  }

  function advance(seconds: number): void {
    clock = new Date(clock.getTime() + seconds * 1_000);
  }

  it("creates an email account with an email session and zero developer capabilities", async () => {
    const h = harness();
    const login = await signIn(h, "  Owner@Example.com ");

    expect(login.accountCreated).toBe(true);
    expect(login.session.identityProvider).toBe("email");
    expect(login.session.verifiedGoogleSubject).toBeNull();
    expect(login.session.verifiedEmail).toBe("owner@example.com");
    expect(login.session.account.testAccessStatus).toBe("pending");
    expect(h.auth.developerCapabilities(login.session)).toEqual([]);

    const restored = await h.auth.authenticateSession(login.session.rawToken);
    expect(restored).toMatchObject({ identityProvider: "email", verifiedGoogleSubject: null });
    const response = await h.auth.sessionResponse(restored);
    expect(response).toMatchObject({
      emailSignInEnabled: true,
      linkedProviders: ["email"],
      developerCapabilities: []
    });

    const again = await (async () => {
      advance(61);
      return signIn(h, "owner@example.com");
    })();
    expect(again.accountCreated).toBe(false);
    expect(again.session.account.id).toBe(login.session.account.id);
    const stored = await pool.query(
      "SELECT code_hash, send_status FROM email_login_codes ORDER BY created_at"
    );
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) {
      expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.send_status).toBe("logged");
    }
  });

  it("returns identical start results for new and existing addresses", async () => {
    const h = harness();
    await signIn(h, "existing@example.com");
    advance(61);
    const existing = await h.auth.startEmailLogin("existing@example.com", context());
    const fresh = await h.auth.startEmailLogin("fresh@example.com", context());
    expect(fresh).toEqual(existing);
  });

  it("rejects replay, including a concurrent double verify", async () => {
    const h = harness();
    await h.auth.startEmailLogin("replay@example.com", context());
    const code = h.sender.lastCode();
    const results = await Promise.allSettled([
      h.auth.verifyEmailLogin({ email: "replay@example.com", code }, context()),
      h.auth.verifyEmailLogin({ email: "replay@example.com", code }, context())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "EMAIL_CODE_INVALID" }
    });
    await expect(
      h.auth.verifyEmailLogin({ email: "replay@example.com", code }, context())
    ).rejects.toMatchObject({ code: "EMAIL_CODE_INVALID" });
    expect((await pool.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n).toBe(1);
  });

  it("invalidates a code after five wrong attempts", async () => {
    const h = harness();
    await h.auth.startEmailLogin("guess@example.com", context());
    const code = h.sender.lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        h.auth.verifyEmailLogin({ email: "guess@example.com", code: wrong }, context())
      ).rejects.toMatchObject({ code: "EMAIL_CODE_INVALID" });
    }
    await expect(
      h.auth.verifyEmailLogin({ email: "guess@example.com", code }, context())
    ).rejects.toMatchObject({ code: "EMAIL_CODE_INVALID" });
    const row = await pool.query(
      "SELECT attempt_count, invalidation_reason FROM email_login_codes"
    );
    expect(row.rows[0]).toEqual({ attempt_count: 5, invalidation_reason: "attempts_exhausted" });
  });

  it("rejects expired and superseded codes and throttles resends", async () => {
    const h = harness();
    await h.auth.startEmailLogin("timing@example.com", context());
    const first = h.sender.lastCode();
    await expect(h.auth.startEmailLogin("timing@example.com", context()))
      .rejects.toMatchObject({ code: "TOO_MANY_EMAIL_CODE_REQUESTS", statusCode: 429 });
    advance(61);
    await h.auth.startEmailLogin("timing@example.com", context());
    const second = h.sender.lastCode();
    if (first !== second) {
      await expect(
        h.auth.verifyEmailLogin({ email: "timing@example.com", code: first }, context())
      ).rejects.toMatchObject({ code: "EMAIL_CODE_INVALID" });
    }
    advance(601);
    await expect(
      h.auth.verifyEmailLogin({ email: "timing@example.com", code: second }, context())
    ).rejects.toMatchObject({ code: "EMAIL_CODE_INVALID" });
    const reasons = await pool.query(
      "SELECT invalidation_reason FROM email_login_codes ORDER BY created_at"
    );
    expect(reasons.rows.map((row) => row.invalidation_reason)).toEqual(["superseded", null]);
  });

  it("requires explicit linking instead of merging across providers in both directions", async () => {
    const h = harness(new Map([
      ["google-shared", googleIdentity("google-shared-subject", "shared@example.com")],
      ["google-late", googleIdentity("google-late-subject", "late@example.com")]
    ]));
    await h.auth.loginWithGoogle("google-shared", context());
    await h.auth.startEmailLogin("shared@example.com", context());
    await expect(
      h.auth.verifyEmailLogin({ email: "shared@example.com", code: h.sender.lastCode() }, context())
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_REQUIRED", statusCode: 409 });

    await signIn(h, "late@example.com");
    await expect(h.auth.loginWithGoogle("google-late", context()))
      .rejects.toMatchObject({ code: "ACCOUNT_LINK_REQUIRED", statusCode: 409 });
    expect((await pool.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n).toBe(2);
  });

  it("links email to a Google account and Google to an email account, refusing conflicts", async () => {
    const h = harness(new Map([
      ["google-owner", googleIdentity("google-owner-subject", "gowner@example.com")],
      ["google-owner-again", googleIdentity("google-owner-subject", "gowner@example.com")],
      ["google-match", googleIdentity("google-match-subject", "emailfirst@example.com")],
      ["google-match-login", googleIdentity("google-match-subject", "emailfirst@example.com")],
      ["google-mismatch", googleIdentity("google-mismatch-subject", "elsewhere@example.com")]
    ]));
    const google = await h.auth.loginWithGoogle("google-owner", context());
    await h.auth.startEmailLink(google.session, "alt@example.com", context());
    await h.auth.verifyEmailLink(
      google.session,
      { email: "alt@example.com", code: h.sender.lastCode() },
      context()
    );
    expect((await h.auth.sessionResponse(google.session)).linkedProviders).toEqual(["email", "google"]);

    const emailFirst = await signIn(h, "emailfirst@example.com");
    advance(61);
    await h.auth.startEmailLink(emailFirst.session, "alt@example.com", context());
    await expect(h.auth.verifyEmailLink(
      emailFirst.session,
      { email: "alt@example.com", code: h.sender.lastCode() },
      context()
    )).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT", statusCode: 409 });

    await expect(h.auth.linkGoogleIdentity(emailFirst.session, "google-mismatch", context()))
      .rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
    await expect(h.auth.linkGoogleIdentity(emailFirst.session, "google-owner-again", context()))
      .rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
    await h.auth.linkGoogleIdentity(emailFirst.session, "google-match", context());
    const viaGoogle = await h.auth.loginWithGoogle("google-match-login", context());
    expect(viaGoogle.session.account.id).toBe(emailFirst.session.account.id);
  });

  it("claims a test-access preapproval for an email identity", async () => {
    const h = harness();
    const adminId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, risk_score, test_access_status, test_access_requested_at)
       VALUES ($1, 'active', 'new', 0, 'approved', now())`,
      [adminId]
    );
    await pool.query(
      `INSERT INTO test_access_email_grants (id, email_display, email_normalized, created_by_account_id)
       VALUES ($1, 'Invited@Example.com', 'invited@example.com', $2)`,
      [randomUUID(), adminId]
    );
    const login = await signIn(h, "invited@example.com");
    expect(login.session.account.testAccessStatus).toBe("approved");
    const grant = await pool.query(
      `SELECT status, claimed_provider, claimed_subject, claimed_google_subject, claimed_account_id
       FROM test_access_email_grants`
    );
    expect(grant.rows[0]).toEqual({
      status: "claimed",
      claimed_provider: "email",
      claimed_subject: "invited@example.com",
      claimed_google_subject: null,
      claimed_account_id: login.session.account.id
    });
  });

  it("deletes an email account within the identity constraints and kills its codes", async () => {
    const h = harness();
    const login = await signIn(h, "leaving@example.com");
    advance(61);
    await h.auth.startEmailLogin("leaving@example.com", context());
    const deletion = new AccountDeletionService(pool, () => new Date(clock));
    // Public path: support selects the account; ownership is checked by verified email.
    const request = await deletion.requestPublic("leaving@example.com");
    await deletion.processRequest({ requestId: request.requestId, accountId: login.session.account.id });

    const identity = await pool.query(
      "SELECT provider, provider_subject, email_normalized FROM account_identities WHERE account_id = $1",
      [login.session.account.id]
    );
    expect(identity.rows[0]).toMatchObject({
      provider: "email",
      provider_subject: `deleted:email:${login.session.account.id}`
    });
    const active = await pool.query(
      `SELECT count(*)::int AS n FROM email_login_codes
       WHERE consumed_at IS NULL AND invalidated_at IS NULL`
    );
    expect(active.rows[0].n).toBe(0);
  });

  it("suspends a signed-in account on a deletion request, then deletes it", async () => {
    const h = harness();
    const login = await signIn(h, "self-delete@example.com");
    const accountId = login.session.account.id;
    const deletion = new AccountDeletionService(pool, () => new Date(clock));

    const request = await deletion.requestAuthenticated({
      accountId,
      verifiedEmail: "self-delete@example.com"
    });
    expect(request.status).toBe("pending_processing");
    const suspended = await pool.query(
      "SELECT status, suspended_at, suspension_reason FROM accounts WHERE id = $1",
      [accountId]
    );
    expect(suspended.rows[0]).toMatchObject({
      status: "suspended",
      suspension_reason: "account_deletion_requested"
    });
    expect(suspended.rows[0].suspended_at).toBeInstanceOf(Date);

    // The suspended account can no longer file requests of its own.
    await expect(deletion.requestAuthenticated({
      accountId,
      verifiedEmail: "self-delete@example.com"
    })).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });

    await deletion.processRequest({ requestId: request.requestId, accountId });
    const deleted = await pool.query(
      "SELECT status, suspended_at FROM accounts WHERE id = $1",
      [accountId]
    );
    expect(deleted.rows[0]).toEqual({ status: "deleted", suspended_at: null });
  });

  it("deletes location, trust, settlement and attestation rows when processing a deletion", async () => {
    const h = harness();
    const login = await signIn(h, "trust-delete@example.com");
    const accountId = login.session.account.id;
    const otherId = randomUUID();
    const thirdId = randomUUID();
    for (const id of [otherId, thirdId]) {
      await pool.query(
        `INSERT INTO accounts (id, status, trust_tier, risk_score) VALUES ($1, 'active', 'new', 0)`,
        [id]
      );
    }
    const reportId = randomUUID();
    const otherReportId = randomUUID();
    for (const [id, account] of [[reportId, accountId], [otherReportId, otherId]]) {
      await pool.query(
        `INSERT INTO location_reports (id, account_id, seq, source, lat, lon, verdict)
         VALUES ($1, $2, 1, 'passive', 35.1, -106.6, 'accepted')`,
        [id, account]
      );
    }
    const challengeId = randomUUID();
    const attestationId = randomUUID();
    const otherAttestationId = randomUUID();
    const ownKey = "own-key-" + randomUUID();
    const sharedKey = "shared-key-" + randomUUID();
    for (const key of [ownKey, sharedKey]) {
      await pool.query(
        `INSERT INTO app_attest_keys (key_id, first_account_id, environment, public_key_spki)
         VALUES ($1, $2, 'production', '\x01')`,
        [key, accountId]
      );
    }
    await pool.query(
      `INSERT INTO attestation_challenges (id, account_id, platform, purpose, challenge, expires_at)
       VALUES ($1, $2, 'ios', 'session', decode(repeat('ab', 32), 'hex'), now() + interval '5 minutes')`,
      [challengeId, accountId]
    );
    for (const [id, account, key] of [
      [attestationId, accountId, ownKey],
      [otherAttestationId, otherId, sharedKey]
    ]) {
      await pool.query(
        `INSERT INTO device_attestations
           (id, account_id, platform, method, purpose, app_attest_key_id, outcome, assurance, ref_hash, expires_at)
         VALUES ($1, $2, 'ios', 'app_attest', 'session', $3, 'pass', 'attested', $4, now() + interval '1 day')`,
        [id, account, key, "ref-" + id]
      );
    }
    await pool.query(
      "INSERT INTO account_location_state (account_id, last_accepted_report_id) VALUES ($1, $2), ($3, $4)",
      [accountId, reportId, otherId, otherReportId]
    );
    await pool.query(
      `INSERT INTO account_regions (account_id, region_cell, last_counted_day)
       VALUES ($1, '10:20', current_date), ($2, '10:20', current_date)`,
      [accountId, otherId]
    );
    await pool.query(
      "INSERT INTO account_trust_state (account_id) VALUES ($1), ($2)",
      [accountId, otherId]
    );
    await pool.query(
      `INSERT INTO account_trust_events (id, account_id, kind, rule, logodds_after, location_report_id)
       VALUES ($1, $2, 'signal', 'test_rule', 0, $3), ($4, $5, 'signal', 'test_rule', 0, $6)`,
      [randomUUID(), accountId, reportId, randomUUID(), otherId, otherReportId]
    );
    await pool.query(
      `INSERT INTO account_settlement (account_id, target_checks, target_days)
       VALUES ($1, 10, 3), ($2, 10, 3)`,
      [accountId, otherId]
    );
    const alertId = randomUUID();
    const decidedAlertId = randomUUID();
    await pool.query(
      `INSERT INTO trust_alerts (id, account_id, kind, severity) VALUES ($1, $2, 'zone_red', 4)`,
      [alertId, accountId]
    );
    await pool.query(
      `INSERT INTO trust_alerts (id, account_id, kind, severity, status, decided_by, decided_at)
       VALUES ($1, $2, 'mismatch', 2, 'dismissed', $3, now())`,
      [decidedAlertId, otherId, accountId]
    );
    await pool.query(
      `INSERT INTO trust_arrivals (id, host_account_id, guest_account_id, kind)
       VALUES ($1, $2, $3, 'invite'), ($4, $3, $2, 'invite'), ($5, $3, $6, 'invite')`,
      [randomUUID(), accountId, otherId, randomUUID(), randomUUID(), thirdId]
    );

    const deletion = new AccountDeletionService(pool, () => new Date(clock));
    const request = await deletion.requestAuthenticated({
      accountId,
      verifiedEmail: "trust-delete@example.com"
    });
    await deletion.processRequest({ requestId: request.requestId, accountId });

    for (const table of [
      "location_reports",
      "account_location_state",
      "account_regions",
      "account_trust_state",
      "account_trust_events",
      "account_settlement",
      "trust_alerts",
      "device_attestations",
      "attestation_challenges"
    ]) {
      const gone = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`,
        [accountId]
      );
      expect(gone.rows[0].n, table).toBe(0);
      const kept = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`,
        [otherId]
      );
      expect(kept.rows[0].n, table + " (other account)").toBe(table === "attestation_challenges" ? 0 : 1);
    }
    const arrivals = await pool.query<{ host_account_id: string; guest_account_id: string }>(
      "SELECT host_account_id, guest_account_id FROM trust_arrivals"
    );
    expect(arrivals.rows).toEqual([{ host_account_id: otherId, guest_account_id: thirdId }]);

    // Keys: the account's own unreferenced key is dropped; a key another
    // account's attestation still uses stays, unlinked from the deleted account.
    const keys = await pool.query<{ key_id: string; first_account_id: string | null }>(
      "SELECT key_id, first_account_id FROM app_attest_keys ORDER BY key_id"
    );
    expect(keys.rows).toEqual([{ key_id: sharedKey, first_account_id: null }]);

    // Admin decisions the deleted account made stay, without the link.
    const decided = await pool.query(
      "SELECT decided_by FROM trust_alerts WHERE id = $1",
      [decidedAlertId]
    );
    expect(decided.rows[0].decided_by).toBeNull();
  });

  it("keeps the SQL canonical email function identical to canonicalEmail", async () => {
    const inputs = [
      "player@gmail.com",
      " Player+Alt@Gmail.COM ",
      "p.l.a.y.e.r@gmail.com",
      "p.layer+x+y@googlemail.com",
      "first.last+game@outlook.com",
      "first.last@hotmail.co.uk",
      "a.b+c@yahoo.com",
      "x.y@mail.gmail.com",
      "x.y+z@gmail.com.evil.com",
      "+only@gmail.com",
      "plus+@example.com",
      "trailing@",
      "@leading.com",
      "no-at-sign",
      "deleted+00000000-0000-0000-0000-000000000000@invalid.local"
    ];
    const result = await pool.query<{ input: string; canonical: string }>(
      `SELECT input, auth_canonical_email(input) AS canonical
       FROM unnest($1::text[]) WITH ORDINALITY AS t(input, ord) ORDER BY ord`,
      [inputs]
    );
    expect(result.rows.map((row) => row.canonical)).toEqual(inputs.map(canonicalEmail));
    expect((await pool.query("SELECT auth_canonical_email(NULL) AS c")).rows[0].c).toBeNull();
  });

  it("signs aliases of an existing mailbox in to the same account and sends to the typed address", async () => {
    const h = harness();
    const first = await signIn(h, "player@gmail.com");
    expect(first.accountCreated).toBe(true);

    // Per-email throttling is shared across aliases of one mailbox.
    await expect(h.auth.startEmailLogin("player+alt@gmail.com", context()))
      .rejects.toMatchObject({ code: "TOO_MANY_EMAIL_CODE_REQUESTS" });

    for (const alias of ["Player+alt@gmail.com", "p.layer@googlemail.com"]) {
      advance(61);
      const again = await signIn(h, alias);
      expect(h.sender.sent.at(-1)?.to).toBe(alias.toLowerCase());
      expect(again.accountCreated).toBe(false);
      expect(again.session.account.id).toBe(first.session.account.id);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n).toBe(1);
    const identity = await pool.query(
      "SELECT provider_subject, email, email_canonical FROM account_identities"
    );
    expect(identity.rows).toEqual([{
      provider_subject: "player@gmail.com",
      email: "player@gmail.com",
      email_canonical: "player@gmail.com"
    }]);

    await expect(h.auth.startEmailLogin("+tag@gmail.com", context()))
      .rejects.toMatchObject({ code: "EMAIL_INVALID" });
    await expect(h.auth.startEmailLogin("someone@proton.me", context()))
      .rejects.toMatchObject({
        code: "EMAIL_DOMAIN_NOT_ALLOWED",
        message: "Email sign-in supports Gmail, Outlook/Hotmail, Yahoo, iCloud, AOL and GMX. You can also continue with Google or Apple."
      });
  });

  it("requires linking when an alias matches a dotted Google address, in both directions", async () => {
    const h = harness(new Map([
      ["google-dotted", googleIdentity("google-dotted-subject", "P.Layer@Gmail.com")],
      ["google-googlemail", googleIdentity("google-gm-subject", "altplayer@googlemail.com")]
    ]));
    await h.auth.loginWithGoogle("google-dotted", context());
    await h.auth.startEmailLogin("player+game@gmail.com", context());
    await expect(
      h.auth.verifyEmailLogin({ email: "player+game@gmail.com", code: h.sender.lastCode() }, context())
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_REQUIRED", statusCode: 409 });

    await signIn(h, "alt.player+1@gmail.com");
    await expect(h.auth.loginWithGoogle("google-googlemail", context()))
      .rejects.toMatchObject({ code: "ACCOUNT_LINK_REQUIRED", statusCode: 409 });
    expect((await pool.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n).toBe(2);
  });

  it("claims a test-access preapproval for an alias of the granted mailbox", async () => {
    const h = harness();
    const adminId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, risk_score, test_access_status, test_access_requested_at)
       VALUES ($1, 'active', 'new', 0, 'approved', now())`,
      [adminId]
    );
    await pool.query(
      `INSERT INTO test_access_email_grants (id, email_display, email_normalized, created_by_account_id)
       VALUES ($1, 'Pre.Approved@gmail.com', 'pre.approved@gmail.com', $2)`,
      [randomUUID(), adminId]
    );
    const login = await signIn(h, "preapproved+ash@gmail.com");
    expect(login.session.account.testAccessStatus).toBe("approved");
  });

  it("is unavailable when the flag is off", async () => {
    const h = harness(new Map(), { AUTH_EMAIL_LOGIN_ENABLED: "false" });
    await expect(h.auth.startEmailLogin("off@example.com", context()))
      .rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE", statusCode: 404 });
    expect((await h.auth.sessionResponse(null)).emailSignInEnabled).toBe(false);
  });
});

function googleIdentity(subject: string, email: string): VerifiedGoogleIdentity {
  return {
    subject,
    email,
    emailVerified: true,
    authTime: null,
    authMethods: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z")
  };
}

function context(): LoginRequestContext {
  return {
    ip: "203.0.113.42",
    userAgent: "Mozilla/5.0",
    deviceToken: null,
    existingSessionToken: null
  };
}

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must use local PostgreSQL");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database");
  }
  return value;
}
