import { createHash, generateKeyPairSync, verify as verifySignature } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  APPLE_ISSUER,
  AppleAuthService,
  buildAppleAuthorizationUrl,
  createAppleClientSecret,
  decryptRefreshToken,
  encryptRefreshToken,
  appleAcceptedAudiences,
  appleIdentityFromClaims,
  validateAppleClaims
} from "./appleAuth.js";
import type { AuthService } from "./authService.js";

describe("gated Apple authentication contracts", () => {
  const key = Buffer.from("a".repeat(32)).toString("base64");

  it("builds the exact server-owned form_post authorization request", () => {
    const url = new URL(buildAppleAuthorizationUrl(
      { APPLE_SERVICES_ID: "com.ashatlas.web" },
      "state-value",
      "nonce-value",
      "https://playashatlas.com/api/auth/apple/callback"
    ));
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "com.ashatlas.web",
      redirect_uri: "https://playashatlas.com/api/auth/apple/callback",
      scope: "email",
      response_mode: "form_post",
      state: "state-value",
      nonce: "nonce-value"
    });
  });

  it("stores independent 256-bit state and nonce with the link account and session binding", async () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const stateBytes = Buffer.alloc(32, 1);
    const nonceBytes = Buffer.alloc(32, 2);
    const randomBytes = vi.fn()
      .mockReturnValueOnce(stateBytes)
      .mockReturnValueOnce(nonceBytes);
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const service = new AppleAuthService({
      APPLE_SIGN_IN_ENABLED: true,
      APP_PUBLIC_ORIGIN: "https://playashatlas.com",
      APPLE_SERVICES_ID: "com.ashatlas.web"
    } as ConstructorParameters<typeof AppleAuthService>[0], {
      query
    } as unknown as ConstructorParameters<typeof AppleAuthService>[1], {} as AuthService, {
      now: () => now,
      randomBytes
    });

    const authorizationUrl = new URL(await service.begin({
      intent: "link",
      returnTo: "/play/?linked=apple",
      accountId: "account-1",
      sessionId: "session-1",
      deviceInstallationId: "device-1",
      networkHash: "network-1"
    }));

    expect(randomBytes.mock.calls).toEqual([[32], [32]]);
    expect(authorizationUrl.searchParams.get("state")).toBe(stateBytes.toString("base64url"));
    expect(authorizationUrl.searchParams.get("nonce")).toBe(nonceBytes.toString("base64url"));
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      createHash("sha256").update(stateBytes.toString("base64url")).digest("hex"),
      createHash("sha256").update(nonceBytes.toString("base64url")).digest("hex"),
      "link",
      "/play/?linked=apple",
      "account-1",
      "session-1",
      "device-1",
      "network-1",
      now,
      new Date(now.getTime() + 10 * 60_000),
      false,
      null
    ]);
  });

  it("round-trips refresh tokens with versioned AES-256-GCM material", () => {
    const stored = encryptRefreshToken(
      { APPLE_REFRESH_TOKEN_KEY_ID: "v1", APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64: key },
      "refresh-token-value",
      () => Buffer.from("b".repeat(12))
    );
    expect(stored).toMatchObject({ keyId: "v1", iv: expect.any(String), tag: expect.any(String) });
    expect(decryptRefreshToken(
      { APPLE_REFRESH_TOKEN_KEY_ID: "v1", APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64: key },
      stored
    )).toBe("refresh-token-value");
    expect(() => decryptRefreshToken(
      { APPLE_REFRESH_TOKEN_KEY_ID: "v2", APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64: key },
      stored
    )).toThrow();
  });

  it("creates a bounded ES256 client secret without exposing key material", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const token = createAppleClientSecret({
      APPLE_TEAM_ID: "TEAMID1234",
      APPLE_KEY_ID: "KEYID1234",
      APPLE_SERVICES_ID: "com.ashatlas.web",
      APPLE_PRIVATE_KEY_P8_BASE64: privateKey
    }, new Date("2026-09-15T12:00:00.000Z"));
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toMatchObject({ alg: "ES256", kid: "KEYID1234" });
    const payloadClaims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payloadClaims).toMatchObject({
      iss: "TEAMID1234",
      aud: APPLE_ISSUER,
      sub: "com.ashatlas.web"
    });
    expect(Number(payloadClaims.exp) - Number(payloadClaims.iat)).toBe(180 * 24 * 60 * 60);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(verifySignature(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: pair.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url")
    )).toBe(true);
  });

  it("accepts the native bundle id audience only when configured", () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const claims = {
      iss: APPLE_ISSUER,
      aud: "com.ashatlas.game",
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 300,
      sub: "apple-subject"
    };
    const off = { APPLE_SERVICES_ID: "com.ashatlas.web", APPLE_NATIVE_BUNDLE_ID: "" };
    const on = { APPLE_SERVICES_ID: "com.ashatlas.web", APPLE_NATIVE_BUNDLE_ID: "com.ashatlas.game" };
    expect(() => validateAppleClaims(claims, { audience: appleAcceptedAudiences(off) }, now)).toThrow("audience");
    expect(() => validateAppleClaims(claims, { audience: appleAcceptedAudiences(on) }, now)).not.toThrow();
    expect(() => validateAppleClaims({ ...claims, aud: "com.ashatlas.web" }, { audience: appleAcceptedAudiences(on) }, now)).not.toThrow();
    expect(() => validateAppleClaims({ ...claims, aud: "com.other.app" }, { audience: appleAcceptedAudiences(on) }, now)).toThrow("audience");
  });

  it("rejects issuer, audience, expiry, nonce, and claim-shape violations", () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const claims = {
      iss: APPLE_ISSUER,
      aud: "com.ashatlas.web",
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 300,
      nonce: "nonce",
      sub: "apple-subject",
      email: "relay@privaterelay.appleid.com",
      email_verified: true,
      is_private_email: true
    };
    expect(() => validateAppleClaims(claims, {
      audience: "com.ashatlas.web",
      nonceHash: "bad-nonce-hash",
      requireSubject: true
    }, now)).toThrow("nonce");
    expect(() => validateAppleClaims({ ...claims, iss: "https://evil.example" }, { audience: "com.ashatlas.web" }, now)).toThrow("issuer");
    expect(() => validateAppleClaims({ ...claims, aud: "other" }, { audience: "com.ashatlas.web" }, now)).toThrow("audience");
    expect(() => validateAppleClaims({ ...claims, exp: Math.floor(now.getTime() / 1_000) - 1 }, { audience: "com.ashatlas.web" }, now)).toThrow("expired");
    expect(() => validateAppleClaims({ ...claims, email: 42 }, { audience: "com.ashatlas.web" }, now)).toThrow("email");
    expect(() => validateAppleClaims({ ...claims, email_verified: "true" }, { audience: "com.ashatlas.web" }, now)).toThrow("verification");
    expect(() => validateAppleClaims({ ...claims, is_private_email: "false" }, { audience: "com.ashatlas.web" }, now)).toThrow("relay");
    expect(appleIdentityFromClaims(claims)).toMatchObject({
      provider: "apple",
      subject: "apple-subject",
      email: "relay@privaterelay.appleid.com",
      isPrivateEmail: true
    });
  });

  it("completes a form_post callback without the initiating device or network bindings", async () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const state = "state-from-apple";
    const nonce = "nonce-from-apple";
    const login = {
      session: { token: "session-token" },
      deviceToken: "device-token",
      deviceTokenCreated: true,
      accountCreated: false
    };
    const loginWithAppleIdentity = vi.fn().mockResolvedValue(login);
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "transaction-1",
          state_hash: createHash("sha256").update(state).digest("hex"),
          nonce_hash: createHash("sha256").update(nonce).digest("hex"),
          intent: "signin",
          return_path: "/play/",
          account_id: null,
          session_id: null,
          device_installation_id: "device-from-start",
          network_hash: "network-from-start",
          created_at: now,
          expires_at: new Date(now.getTime() + 60_000)
        }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const verifyJws = vi.fn().mockResolvedValue({
      iss: APPLE_ISSUER,
      aud: "com.ashatlas.web",
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 300,
      nonce,
      sub: "apple-subject",
      email: "relay@privaterelay.appleid.com",
      email_verified: true,
      is_private_email: true
    });
    const service = new AppleAuthService({
      APPLE_SIGN_IN_ENABLED: true,
      APP_PUBLIC_ORIGIN: "https://playashatlas.com",
      APPLE_TEAM_ID: "TEAMID1234",
      APPLE_KEY_ID: "KEYID1234",
      APPLE_SERVICES_ID: "com.ashatlas.web",
      APPLE_PRIVATE_KEY_P8_BASE64: privateKey
    } as ConstructorParameters<typeof AppleAuthService>[0], {
      query
    } as unknown as ConstructorParameters<typeof AppleAuthService>[1], {
      loginWithAppleIdentity
    } as unknown as AuthService, {
      now: () => now,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ id_token: "signed-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })),
      verifyJws
    });
    const context = {
      ip: "203.0.113.25",
      userAgent: "Apple callback",
      deviceToken: null,
      existingSessionToken: null
    };

    await expect(service.handleCallback({
      state,
      code: "authorization-code",
      context,
      deviceInstallationId: null,
      networkHash: null
    })).resolves.toEqual({ kind: "login", returnPath: "/play/", login });

    expect(query.mock.calls[0]?.[0]).toContain("claimed_at IS NULL AND consumed_at IS NULL");
    expect(query.mock.calls[0]?.[0]).toContain("expires_at > $2");
    expect(query.mock.calls[0]?.[1]).toEqual([
      createHash("sha256").update(state).digest("hex"),
      now
    ]);
    expect(verifyJws).toHaveBeenCalledWith("signed-id-token", expect.objectContaining({
      nonceHash: createHash("sha256").update(nonce).digest("hex"),
      requireSubject: true
    }));
    expect(loginWithAppleIdentity).toHaveBeenCalledWith(expect.objectContaining({
      provider: "apple",
      subject: "apple-subject"
    }), context);
    expect(query.mock.calls[1]?.[0]).toContain("SET consumed_at");
  });

  it("consumes a cancelled Apple transaction so its state cannot be replayed", async () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "transaction-2",
          state_hash: "stored-state-hash",
          nonce_hash: "stored-nonce-hash",
          intent: "signin",
          return_path: "/play/",
          account_id: null,
          session_id: null,
          device_installation_id: null,
          network_hash: null,
          created_at: now,
          expires_at: new Date(now.getTime() + 60_000)
        }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const service = new AppleAuthService({
      APPLE_SIGN_IN_ENABLED: true
    } as ConstructorParameters<typeof AppleAuthService>[0], {
      query
    } as unknown as ConstructorParameters<typeof AppleAuthService>[1], {} as AuthService, {
      now: () => now
    });

    await expect(service.cancel("cancelled-state", "user_cancelled_authorize")).resolves.toEqual({
      returnPath: "/play/",
      outcome: "cancelled"
    });

    expect(query.mock.calls[0]?.[0]).toContain("claimed_at IS NULL AND consumed_at IS NULL");
    expect(query.mock.calls[1]?.[0]).toContain("SET consumed_at = $2, failure_code = $3");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "transaction-2",
      now,
      "user_cancelled_authorize"
    ]);
    await expect(service.cancel("cancelled-state", "user_cancelled_authorize"))
      .rejects.toThrow("invalid or expired");
  });

  it("sanitizes provider callback errors before recording and redirecting them", async () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "transaction-3",
          state_hash: "stored-state-hash",
          nonce_hash: "stored-nonce-hash",
          intent: "signin",
          return_path: "/play/?source=apple",
          account_id: null,
          session_id: null,
          device_installation_id: null,
          network_hash: null,
          created_at: now,
          expires_at: new Date(now.getTime() + 60_000)
        }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const service = new AppleAuthService({
      APPLE_SIGN_IN_ENABLED: true
    } as ConstructorParameters<typeof AppleAuthService>[0], {
      query
    } as unknown as ConstructorParameters<typeof AppleAuthService>[1], {} as AuthService, {
      now: () => now
    });

    await expect(service.cancel("provider-error-state", "bad\nheader=value"))
      .resolves.toEqual({
        returnPath: "/play/?source=apple",
        outcome: "provider_error"
      });
    expect(query.mock.calls[1]?.[1]).toEqual(["transaction-3", now, "provider_error"]);
  });

  it("processes the documented stringified events notification shape", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ account_id: "account-1", identity_status: "active" }], rowCount: 1 });
    const pool = { query } as unknown as ConstructorParameters<typeof AppleAuthService>[1];
    const config = {
      APPLE_SIGN_IN_ENABLED: true,
      APPLE_SERVICES_ID: "com.ashatlas.web"
    } as ConstructorParameters<typeof AppleAuthService>[0];
    const service = new AppleAuthService(config, pool, {} as AuthService, {
      verifyJws: async () => ({
        iss: APPLE_ISSUER,
        aud: "com.ashatlas.web",
        events: JSON.stringify({
          type: "email-disabled",
          sub: "apple-subject",
          is_private_email: true
        })
      })
    });

    await service.handleNotification("signed.payload");

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain("apple_email_private");
    expect(query.mock.calls[1]?.[0]).toContain("apple_email_forwarding_enabled");
    expect(query.mock.calls[1]?.[1]).toEqual(["apple-subject", false]);
  });
});
