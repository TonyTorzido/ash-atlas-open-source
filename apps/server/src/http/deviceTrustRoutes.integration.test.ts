import { createHash, randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import { buildAttestClientData, type AttestBoundFix, type AttestPurpose } from "@ash-atlas/shared";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { buildAssertion, buildAttestation, loadTestPki } from "../auth/trust/attestation/__fixtures__/appAttestFixtureBuilder.js";
import fixtures from "../auth/trust/attestation/__fixtures__/appAttestFixtures.json" with { type: "json" };
import { AttestationResolver } from "../auth/trust/attestation/attestationResolver.js";
import { AttestationService } from "../auth/trust/attestation/attestationService.js";
import { PostgresAttestationStore } from "../auth/trust/attestation/attestationStore.js";
import type { DeviceCheckResult } from "../auth/trust/attestation/deviceCheckClient.js";
import type { PlayIntegrityDecodeResult } from "../auth/trust/attestation/playIntegrityClient.js";
import { AuthError } from "../auth/types.js";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { registerDeviceTrustRoutes } from "./deviceTrustRoutes.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const NOW = new Date(fixtures.now);
const APP_ID = fixtures.appId;
const CERT_HEX = "ab".repeat(32);
const CERT_B64URL = Buffer.from(CERT_HEX, "hex").toString("base64url");
const pki = loadTestPki(fixtures);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();
// Token hashes are unique forever; reruns on the same database need fresh tokens.
const RUN = randomUUID().slice(0, 8);
const token = (name: string) => `${name}.${RUN}`;

describeDatabase("device trust routes (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresAttestationStore;
  const apps: ReturnType<typeof Fastify>[] = [];

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    store = new PostgresAttestationStore(pool);
  }, 120_000);
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function newSession() {
    const accountId = randomUUID();
    const identityId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    await pool.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')", [accountId]);
    await pool.query(
      `INSERT INTO account_identities (id, account_id, provider, provider_subject, email, email_verified)
       VALUES ($1, $2, 'google', $3, 'attest@example.invalid', true)`,
      [identityId, accountId, randomUUID()]
    );
    await pool.query("INSERT INTO device_installations (id, token_hash) VALUES ($1, $2)", [deviceId, randomUUID()]);
    await pool.query(
      `INSERT INTO auth_sessions (id, account_id, identity_id, device_installation_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
      [sessionId, accountId, identityId, deviceId, randomUUID()]
    );
    return { sessionId, account: { id: accountId }, deviceInstallationId: deviceId, csrfToken: "csrf", player: { id: "p" } };
  }

  async function fixture(options: {
    env?: Record<string, string>;
    decode?: (token: string) => Promise<PlayIntegrityDecodeResult>;
    deviceCheck?: (token: string) => Promise<DeviceCheckResult>;
    off?: boolean;
  } = {}) {
    const session = await newSession();
    const config = loadConfig({
      NODE_ENV: "test",
      TRUST_ATTESTATION_MODE: "enforce",
      TRUST_PLAY_INTEGRITY_ENABLED: "true",
      TRUST_PLAY_INTEGRITY_CERT_SHA256: CERT_HEX,
      TRUST_APP_ATTEST_ENABLED: "true",
      TRUST_DEVICECHECK_ENABLED: "true",
      ...options.env
    });
    const sink = { recordSignals: vi.fn<(input: { signals: ReadonlyArray<{ rule: string }> }) => Promise<void>>(async () => undefined) };
    const revoke = vi.fn(async () => undefined);
    let clock = NOW.getTime();
    const service = new AttestationService(store, config, {
      playIntegrity: options.decode ?? (async () => ({ status: "unavailable", code: "test" })),
      deviceCheck: options.deviceCheck ?? (async () => "valid"),
      appAttestRootPem: pki.rootPem,
      sink,
      revoke,
      // Ticks 1 ms per read so rows order by created_at.
      now: () => new Date(clock++)
    });
    const app = Fastify();
    apps.push(app);
    await app.register(cookie);
    const auth = {
      sessionCookieName: "session",
      authenticateSession: async (token: string) => (token === "valid" ? session : null),
      assertOrigin: () => {},
      assertCsrf: (_session: unknown, token: string) => {
        if (token !== "csrf") throw new AuthError("AUTHENTICATION_REQUIRED", "CSRF required", 403);
      },
      requireGameplayReady: async () => {}
    } as unknown as AuthService;
    installAuthGuard(app, { ...config, AUTH_REQUIRED: true }, auth);
    registerDeviceTrustRoutes(app, options.off ? null : service);
    await app.ready();
    const post = (url: string, payload: unknown, headers: Record<string, string> = { cookie: "session=valid", "x-csrf-token": "csrf" }) =>
      app.inject({ method: "POST", url: `/api/trust/attest/${url}`, headers, payload: payload as Record<string, unknown> });
    const challenge = async (platform: "ios" | "android", purpose: AttestPurpose) => {
      const response = await post("challenge", { platform, purpose });
      expect(response.statusCode).toBe(200);
      return response.json() as { challengeId: string; challenge: string; expiresAt: string };
    };
    return {
      session, service, sink, revoke, post, challenge,
      advance: (ms: number) => { clock += ms; },
      rows: async () => (await pool.query<{ outcome: string; assurance: string; reason: string | null; method: string; token_hash: string | null; bound_fix: unknown }>(
        "SELECT outcome, assurance, reason, method, token_hash, bound_fix FROM device_attestations WHERE account_id = $1 ORDER BY created_at, id",
        [session.account.id]
      )).rows,
      signals: () => sink.recordSignals.mock.calls.flatMap(([call]) => call.signals.map((signal) => signal.rule))
    };
  }

  const integrity = (requestHash: string, overrides: { device?: string[] } = {}) => ({
    tokenPayloadExternal: {
      requestDetails: { requestPackageName: "com.ashatlas.game", requestHash, timestampMillis: String(NOW.getTime() - 1000) },
      appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.ashatlas.game", certificateSha256Digest: [CERT_B64URL] },
      deviceIntegrity: { deviceRecognitionVerdict: overrides.device ?? ["MEETS_DEVICE_INTEGRITY"] }
    }
  });
  const requestHashFor = (purpose: "session" | "relocation", challenge: string, fix?: AttestBoundFix) =>
    createHash("sha256").update(buildAttestClientData(purpose, challenge, fix), "utf8").digest("base64url");

  it("returns 404 when attestation is off or the platform is disabled", async () => {
    const off = await fixture({ off: true });
    expect((await off.post("challenge", { platform: "android", purpose: "session" })).statusCode).toBe(404);
    expect((await off.post("android", {})).statusCode).toBe(404);
    const disabled = await fixture({ env: { TRUST_PLAY_INTEGRITY_ENABLED: "false", TRUST_APP_ATTEST_ENABLED: "false" } });
    expect((await disabled.post("challenge", { platform: "android", purpose: "session" })).statusCode).toBe(404);
    expect((await disabled.post("challenge", { platform: "ios", purpose: "ios_key" })).statusCode).toBe(404);
    // DeviceCheck alone still serves iOS session challenges.
    expect((await disabled.post("challenge", { platform: "ios", purpose: "session" })).statusCode).toBe(200);
    expect((await disabled.post("ios/key", { challengeId: randomUUID(), keyId: fixtures.golden.keyId, attestationObject: "AAAA" })).statusCode)
      .toBe(404);
  });

  it("requires a session and CSRF", async () => {
    const t = await fixture();
    expect((await t.post("challenge", { platform: "android", purpose: "session" }, {})).statusCode).toBe(401);
    expect((await t.post("challenge", { platform: "android", purpose: "session" }, { cookie: "session=valid" })).statusCode).toBe(403);
    expect((await t.post("challenge", { platform: "android", purpose: "session", accountId: "x" })).statusCode).toBe(400);
  });

  it("limits challenges to 20 per session per hour", async () => {
    const t = await fixture();
    for (let index = 0; index < 20; index += 1) await t.challenge("android", "session");
    const limited = await t.post("challenge", { platform: "android", purpose: "session" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "ATTEST_RATE_LIMITED" } });
    t.advance(61 * 60_000);
    expect((await t.post("challenge", { platform: "android", purpose: "session" })).statusCode).toBe(200);
  });

  it("Android pass and fail return identical bodies; challenges are single use and bound", async () => {
    const payloads = new Map<string, unknown>();
    const t = await fixture({ decode: async (token) => ({ status: "ok", payload: payloads.get(token) }) });
    const passChallenge = await t.challenge("android", "session");
    payloads.set(token("pass-token"), integrity(requestHashFor("session", passChallenge.challenge)));
    const pass = await t.post("android", { challengeId: passChallenge.challengeId, purpose: "session", shellBuild: 9, token: token("pass-token") });
    const failChallenge = await t.challenge("android", "session");
    payloads.set(token("fail-token"), integrity(requestHashFor("session", failChallenge.challenge), { device: ["MEETS_BASIC_INTEGRITY"] }));
    const fail = await t.post("android", { challengeId: failChallenge.challengeId, purpose: "session", shellBuild: 9, token: token("fail-token") });
    expect(pass.statusCode).toBe(200);
    expect(fail.statusCode).toBe(200);
    expect(Object.keys(pass.json()).sort()).toEqual(["attestationRef", "expiresAt", "refreshAfterSeconds"]);
    expect(Object.keys(fail.json()).sort()).toEqual(Object.keys(pass.json()).sort());
    expect(fail.json().refreshAfterSeconds).toBe(pass.json().refreshAfterSeconds);
    expect(pass.headers["content-length"]).toBe(fail.headers["content-length"]);
    expect(await t.rows()).toMatchObject([
      { outcome: "pass", assurance: "attested", method: "play_integrity" },
      { outcome: "fail", assurance: "unverified", reason: "device_integrity_basic_only" }
    ]);
    expect((await t.rows())[0]!.token_hash).toBe(createHash("sha256").update(token("pass-token")).digest("hex"));
    expect(t.signals()).toEqual(["attest_pass", "attest_device_fail"]);
    expect(t.revoke).not.toHaveBeenCalled();

    // Replaying a consumed challenge, or using it for another purpose/platform, is refused.
    const replay = await t.post("android", { challengeId: passChallenge.challengeId, purpose: "session", shellBuild: 9, token: token("pass-token") });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: { code: "ATTEST_CHALLENGE_INVALID" } });
    const iosChallenge = await t.challenge("ios", "session");
    expect((await t.post("android", { challengeId: iosChallenge.challengeId, purpose: "session", shellBuild: 9, token: "x" })).statusCode).toBe(409);
    const expiring = await t.challenge("android", "session");
    t.advance(301_000);
    expect((await t.post("android", { challengeId: expiring.challengeId, purpose: "session", shellBuild: 9, token: "x" })).statusCode).toBe(409);
  });

  it("a token replayed on a fresh challenge is tamper and revokes in enforce", async () => {
    const payloads = new Map<string, unknown>();
    const t = await fixture({ decode: async (token) => ({ status: "ok", payload: payloads.get(token) }) });
    const first = await t.challenge("android", "session");
    payloads.set(token("same-token"), integrity(requestHashFor("session", first.challenge)));
    await t.post("android", { challengeId: first.challengeId, purpose: "session", shellBuild: 9, token: token("same-token") });
    const second = await t.challenge("android", "session");
    expect((await t.post("android", { challengeId: second.challengeId, purpose: "session", shellBuild: 9, token: token("same-token") })).statusCode)
      .toBe(200);
    const rows = await t.rows();
    expect(rows.at(-1)).toMatchObject({ outcome: "fail", assurance: "flagged", reason: "token_replay", token_hash: null });
    expect(t.revoke).toHaveBeenCalledWith(t.session.account.id, "attest_tamper", expect.anything());
  });

  it("relocation attestations bind the fix and need it", async () => {
    const payloads = new Map<string, unknown>();
    const t = await fixture({ decode: async (token) => ({ status: "ok", payload: payloads.get(token) }) });
    const fix = { lat: 39.74, lon: -104.99, accuracy: 12.34, fixTimestampMs: 1_790_000_000_000 };
    const missing = await t.challenge("android", "relocation");
    expect((await t.post("android", { challengeId: missing.challengeId, purpose: "relocation", shellBuild: 9, token: "t" })).statusCode).toBe(400);
    payloads.set(token("reloc"), integrity(requestHashFor("relocation", missing.challenge, fix)));
    const body = (await t.post("android", { challengeId: missing.challengeId, purpose: "relocation", shellBuild: 9, token: token("reloc"), fix })).json();
    expect((await t.rows()).at(-1)).toMatchObject({
      outcome: "pass",
      bound_fix: { lat: "39.740000", lon: "-104.990000", accuracy: "12.3", fixTimestampMs: "1790000000000" }
    });
    const resolver = new AttestationResolver(store);
    const base = { ref: body.attestationRef, accountId: t.session.account.id, sessionId: t.session.sessionId, installationId: t.session.deviceInstallationId, now: NOW };
    expect(await resolver.resolve({ ...base, source: "relocation", fix })).toMatchObject({ assurance: "attested", tamper: false });
    expect(await resolver.resolve({ ...base, source: "relocation", fix: { ...fix, accuracy: 12.5 } })).toMatchObject({ tamper: true });
    expect(await resolver.resolve({ ...base, sessionId: randomUUID(), source: "passive", fix })).toBeNull();
    expect(await resolver.resolve({ ...base, now: new Date(NOW.getTime() + 1801_000), source: "passive", fix })).toBeNull();
  });

  it("iOS: key registration, ATTEST_KEY_EXISTS, ATTEST_KEY_UNKNOWN, assertion and counter regression", async () => {
    const t = await fixture();
    const keyChallenge = await t.challenge("ios", "ios_key");
    const built = buildAttestation(pki, { appId: APP_ID, clientDataHash: sha256(buildAttestClientData("ios_key", keyChallenge.challenge)), now: NOW });
    const register = await t.post("ios/key", {
      challengeId: keyChallenge.challengeId, keyId: built.keyId, attestationObject: built.attestationObject.toString("base64")
    });
    expect(register.statusCode).toBe(200);
    expect(Object.keys(register.json()).sort()).toEqual(["attestationRef", "expiresAt", "refreshAfterSeconds"]);

    const again = await t.challenge("ios", "ios_key");
    const second = buildAttestation(pki, { appId: APP_ID, clientDataHash: sha256(buildAttestClientData("ios_key", again.challenge)), now: NOW });
    // Same key id with a valid attestation for it is impossible without the key; reuse the first object to hit EXISTS.
    const reuse = await t.post("ios/key", { challengeId: again.challengeId, keyId: built.keyId, attestationObject: second.attestationObject.toString("base64") });
    expect(reuse.statusCode).toBe(200);
    expect((await t.rows()).at(-1)).toMatchObject({ outcome: "fail", reason: "key_id_mismatch" });

    const unknown = await t.challenge("ios", "session");
    const unknownResponse = await t.post("ios/assert", {
      challengeId: unknown.challengeId, purpose: "session", keyId: second.keyId, assertion: "AAAA", shellBuild: 9
    });
    expect(unknownResponse.statusCode).toBe(409);
    expect(unknownResponse.json()).toMatchObject({ error: { code: "ATTEST_KEY_UNKNOWN" } });

    const assertChallenge = await t.challenge("ios", "session");
    const assertion = buildAssertion({
      privateKey: built.privateKey, appId: APP_ID, counter: 1,
      clientData: Buffer.from(buildAttestClientData("session", assertChallenge.challenge), "utf8")
    });
    expect((await t.post("ios/assert", {
      challengeId: assertChallenge.challengeId, purpose: "session", keyId: built.keyId, assertion: assertion.toString("base64"), shellBuild: 9
    })).statusCode).toBe(200);
    expect((await t.rows()).at(-1)).toMatchObject({ outcome: "pass", assurance: "attested", method: "app_attest" });

    const regress = await t.challenge("ios", "session");
    const stale = buildAssertion({
      privateKey: built.privateKey, appId: APP_ID, counter: 1,
      clientData: Buffer.from(buildAttestClientData("session", regress.challenge), "utf8")
    });
    const regressed = await t.post("ios/assert", {
      challengeId: regress.challengeId, purpose: "session", keyId: built.keyId, assertion: stale.toString("base64"), shellBuild: 9
    });
    expect(regressed.statusCode).toBe(200);
    expect(Object.keys(regressed.json()).sort()).toEqual(["attestationRef", "expiresAt", "refreshAfterSeconds"]);
    expect((await t.rows()).at(-1)).toMatchObject({ outcome: "fail", assurance: "flagged", reason: "counter_regression" });
    expect(t.revoke).toHaveBeenCalledWith(t.session.account.id, "attest_tamper", expect.anything());
    const count = await pool.query<{ sign_count: string }>("SELECT sign_count FROM app_attest_keys WHERE key_id = $1", [built.keyId]);
    expect(Number(count.rows[0]!.sign_count)).toBe(1);

    // A second registration of an existing key id is refused.
    const dup = await t.challenge("ios", "ios_key");
    const dupKey = buildAttestation(pki, { appId: APP_ID, clientDataHash: sha256(buildAttestClientData("ios_key", dup.challenge)), now: NOW });
    await pool.query(
      "INSERT INTO app_attest_keys (key_id, environment, public_key_spki) VALUES ($1, 'production', $2)",
      [dupKey.keyId, Buffer.from([1])]
    );
    const exists = await t.post("ios/key", { challengeId: dup.challengeId, keyId: dupKey.keyId, attestationObject: dupKey.attestationObject.toString("base64") });
    expect(exists.statusCode).toBe(409);
    expect(exists.json()).toMatchObject({ error: { code: "ATTEST_KEY_EXISTS" } });
  });

  it("DeviceCheck maps valid to device_checked and invalid to fail", async () => {
    const goodToken = Buffer.from(`good-${RUN}`).toString("base64");
    const badToken = Buffer.from(`bad-${RUN}`).toString("base64");
    const t = await fixture({ deviceCheck: async (deviceToken) => (deviceToken === goodToken ? "valid" : "invalid") });
    const good = await t.challenge("ios", "session");
    expect((await t.post("ios/devicecheck", { challengeId: good.challengeId, purpose: "session", deviceToken: goodToken, shellBuild: 9 })).statusCode).toBe(200);
    const bad = await t.challenge("ios", "session");
    expect((await t.post("ios/devicecheck", { challengeId: bad.challengeId, purpose: "session", deviceToken: badToken, shellBuild: 9 })).statusCode).toBe(200);
    expect(await t.rows()).toMatchObject([
      { outcome: "pass", assurance: "device_checked", method: "devicecheck" },
      { outcome: "fail", assurance: "flagged", reason: "devicecheck_invalid" }
    ]);
  });

  it("retention removes old attestations, expired challenges and idle keys", async () => {
    const t = await fixture();
    const c = await t.challenge("ios", "ios_key");
    await pool.query("UPDATE attestation_challenges SET created_at = now() - interval '10 days', expires_at = now() - interval '2 days' WHERE id = $1", [c.challengeId]);
    const result = await store.cleanup({ now: new Date(), retentionDays: 90, challengeGraceDays: 1, keyIdleDays: 180 });
    expect(result.challenges).toBeGreaterThanOrEqual(1);
    expect((await pool.query("SELECT 1 FROM attestation_challenges WHERE id = $1", [c.challengeId])).rowCount).toBe(0);
  });
});

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must use local PostgreSQL");
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database");
  }
  return value;
}
