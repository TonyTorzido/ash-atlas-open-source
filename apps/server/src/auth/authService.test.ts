import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION } from "@ash-atlas/shared";

import { loadConfig, type AppConfig } from "../config.js";
import { InMemoryAuthStore } from "../__tests__/authTestStore.js";
import { AuthService, validatePlayerName } from "./authService.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import { hashAuthToken, isSecureToken } from "./tokens.js";
import type { LoginRequestContext, VerifiedAppleIdentity, VerifiedGoogleIdentity } from "./types.js";
import type { TestAccessModeReader } from "./testAccessService.js";

describe("AuthService identity and session lifecycle", () => {
  it("creates and restores an Apple-only session without a Google capability subject", async () => {
    const harness = createHarness({
      env: {
        APPLE_SIGN_IN_ENABLED: "true",
        APP_PUBLIC_ORIGIN: "https://game.example",
        AUTH_ALLOWED_ORIGINS: "https://game.example",
        APPLE_TEAM_ID: "team",
        APPLE_SERVICES_ID: "com.ashatlas.web",
        APPLE_KEY_ID: "key",
        APPLE_PRIVATE_KEY_P8_BASE64: Buffer.from("not-used-in-service-test").toString("base64"),
        APPLE_REFRESH_TOKEN_KEY_ID: "v1",
        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_BASE64: Buffer.from("a".repeat(32)).toString("base64")
      }
    });
    const login = await harness.service.loginWithAppleIdentity(
      appleIdentity("apple-subject", "relay@privaterelay.appleid.com"),
      context()
    );
    expect(login.session.identityProvider).toBe("apple");
    expect(login.session.verifiedGoogleSubject).toBeNull();
    const restored = await harness.service.authenticateSession(login.session.rawToken);
    expect(restored).toMatchObject({
      identityProvider: "apple",
      verifiedGoogleSubject: null,
      account: { id: login.session.account.id }
    });
  });

  it("names non-production cookies by stable runtime-label hashes", () => {
    const first = createHarness({ env: { RUNTIME_LABEL: "map-ruler-building__t970" } }).service;
    const same = createHarness({ env: { RUNTIME_LABEL: "map-ruler-building__t970" } }).service;
    const other = createHarness({ env: { RUNTIME_LABEL: "market-mobile-refine__t970" } }).service;

    expect(first.sessionCookieName).toMatch(/^aa_session_dev_[a-f0-9]{12}$/);
    expect(first.deviceCookieName).toMatch(/^aa_device_dev_[a-f0-9]{12}$/);
    expect(same.sessionCookieName).toBe(first.sessionCookieName);
    expect(same.deviceCookieName).toBe(first.deviceCookieName);
    expect(other.sessionCookieName).not.toBe(first.sessionCookieName);
    expect(other.deviceCookieName).not.toBe(first.deviceCookieName);
    expect(first.sessionCookieName.slice("aa_session_dev".length)).toBe(
      first.deviceCookieName.slice("aa_device_dev".length)
    );
    expect(first.sessionCookieName).not.toContain("map-ruler-building");
  });

  it("preserves legacy unlabeled development and exact production cookie names", () => {
    const development = createHarness().service;
    const productionHarness = createHarness({ env: { RUNTIME_LABEL: "production" } });
    productionHarness.config.NODE_ENV = "production";

    expect(development.sessionCookieName).toBe("aa_session_dev");
    expect(development.deviceCookieName).toBe("aa_device_dev");
    expect(productionHarness.service.sessionCookieName).toBe("__Host-aa_session");
    expect(productionHarness.service.deviceCookieName).toBe("__Host-aa_device");
  });

  it("runs the login trust hook and never fails login when it throws", async () => {
    const harness = createHarness();
    const hook = vi.fn(async () => {
      throw new Error("trust ledger unavailable");
    });
    harness.service.setLoginTrustHook(hook);

    const login = await harness.service.loginWithGoogle("credential-one", context());

    expect(login.session.account.id).toBeTruthy();
    expect(hook).toHaveBeenCalledWith(login.session.account.id);
  });

  it("projects the required client contract and onboarding requirements", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());

    expect(await harness.service.sessionResponse(null)).toMatchObject({
      authenticated: false,
      requiredClientContractVersion: AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION
    });
    expect(await harness.service.sessionResponse(login.session)).toMatchObject({
      authenticated: true,
      requiredClientContractVersion: AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION,
      onboardingRequired: true,
    });

    login.session.player = {
      id: "player-1",
      accountId: login.session.account.id,
      displayName: "Scout",
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date()
    };
    expect(await harness.service.sessionResponse(login.session)).toMatchObject({
      onboardingRequired: false,
      player: { id: "player-1" }
    });
  });

  it("asks only unsettled native sessions for action fixes and never sends Settled targets", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());
    expect(await harness.service.sessionResponse(login.session, { nativeClient: true }))
      .toMatchObject({ trustActionFixes: false, trustNativeSignalsAccepted: true });
    let settled = false;
    harness.service.setSettlementStatusHook(async () => settled);
    expect((await harness.service.sessionResponse(login.session, { nativeClient: true })).trustActionFixes).toBe(true);
    expect((await harness.service.sessionResponse(login.session)).trustActionFixes).toBe(false);
    settled = true;
    expect((await harness.service.sessionResponse(login.session, { nativeClient: true })).trustActionFixes).toBe(false);
    settled = false;
    const json = JSON.stringify(await harness.service.sessionResponse(login.session, { nativeClient: true }));
    for (const secret of ["target", "counted", "settle", "provisional", "distinct", "difficulty", "TRUST_SETTLE"]) {
      expect(json.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    const disabled = createHarness({ env: { TRUST_PASSIVE_FIX_ENABLED: "false" } });
    const other = await disabled.service.loginWithGoogle("credential-one", context());
    disabled.service.setSettlementStatusHook(async () => false);
    expect((await disabled.service.sessionResponse(other.session, { nativeClient: true })).trustActionFixes).toBe(false);
  });

  it("sends trustAttestation only to native sessions and only when enabled", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());
    expect(await harness.service.sessionResponse(login.session, { nativeClient: true })).not.toHaveProperty("trustAttestation");
    const state: { enabled?: { mode: "shadow"; ios: { appAttest: boolean; deviceCheck: boolean }; refreshSeconds: number } } = {};
    harness.service.setAttestationSessionConfig(() => state.enabled);
    expect(await harness.service.sessionResponse(login.session, { nativeClient: true })).not.toHaveProperty("trustAttestation");
    state.enabled = { mode: "shadow", ios: { appAttest: true, deviceCheck: false }, refreshSeconds: 1500 };
    expect((await harness.service.sessionResponse(login.session, { nativeClient: true })).trustAttestation).toEqual(state.enabled);
    expect(await harness.service.sessionResponse(login.session)).not.toHaveProperty("trustAttestation");
  });

  it("tells only web sessions that relocation is phone-only, and only when that is enforced", async () => {
    const shadow = createHarness();
    const shadowLogin = await shadow.service.loginWithGoogle("credential-one", context());
    expect(await shadow.service.sessionResponse(shadowLogin.session)).not.toHaveProperty("trustRelocationPhoneOnly");
    const enforce = createHarness({ env: { TRUST_RELOCATION_NATIVE_ONLY_MODE: "enforce" } });
    const login = await enforce.service.loginWithGoogle("credential-one", context());
    expect((await enforce.service.sessionResponse(login.session)).trustRelocationPhoneOnly).toBe(true);
    expect(await enforce.service.sessionResponse(login.session, { nativeClient: true })).not.toHaveProperty("trustRelocationPhoneOnly");
  });

  it("allows the legacy client window only for a fully onboarded existing player", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());
    login.session.account.testAccessStatus = "approved";

    await expect(harness.service.requireGameplayReady(login.session)).rejects.toMatchObject({
      code: "ACCOUNT_UNAVAILABLE"
    });
    login.session.player = {
      id: "player-1",
      accountId: login.session.account.id,
      displayName: "Scout",
      personalFlagColor: "blue",
      onboardingCompletedAt: undefined as never
    };
    await expect(harness.service.requireGameplayReady(login.session)).rejects.toMatchObject({
      code: "ACCOUNT_UNAVAILABLE"
    });
    const player = login.session.player;
    if (!player) throw new Error("Expected player record");
    player.onboardingCompletedAt = new Date();
    await expect(harness.service.requireGameplayReady(login.session)).resolves.toBeUndefined();
  });

  it.each(["Avery", "Rowan", "Redmere", "Wolfhunter"])(
    "accepts the strict ASCII player name %s",
    (displayName) => {
      expect(validatePlayerName(displayName)).toEqual({
        displayName,
        normalizedName: displayName.toLowerCase()
      });
    }
  );

  it.each([
    "Jo",
    "Avery1",
    "Avery_C",
    "Avery!",
    "Jasón",
    "Ｊａｓｏｎ",
    "Wolf Hunter",
    "🔥Avery🔥",
    " Avery",
    "Avery "
  ])("rejects the invalid player name %s without rewriting it", (displayName) => {
    expect(() => validatePlayerName(displayName)).toThrow(
      expect.objectContaining({ code: "PLAYER_NAME_INVALID" })
    );
  });

  it("loads the same account for the same Google sub and distinct accounts for distinct subs", async () => {
    const harness = createHarness();
    const first = await harness.service.loginWithGoogle("credential-one", context());
    const again = await harness.service.loginWithGoogle("credential-one-refresh", context());
    const other = await harness.service.loginWithGoogle("credential-two", context());

    expect(again.session.account.id).toBe(first.session.account.id);
    expect(other.session.account.id).not.toBe(first.session.account.id);
    expect(harness.store.accountsById.size).toBe(2);
  });

  it("makes concurrent first logins converge on exactly one account and identity", async () => {
    const harness = createHarness();
    const logins = await Promise.all([
      harness.service.loginWithGoogle("credential-one", context()),
      harness.service.loginWithGoogle("credential-one-concurrent", context())
    ]);

    expect(logins[0]?.session.account.id).toBe(logins[1]?.session.account.id);
    expect(harness.store.accountsById.size).toBe(1);
    expect(harness.store.playersByAccount.size).toBe(0);
  });

  it("accepts a verified non-Gmail Google identity by default", async () => {
    const harness = createHarness({
      identities: new Map([
        ["workspace", identity("subject-workspace", "user@workspace.example")]
      ])
    });
    const login = await harness.service.loginWithGoogle("workspace", context());
    expect(login.accountCreated).toBe(true);
    expect(login.session.verifiedEmail).toBe("user@workspace.example");
    expect(login.session.verifiedGoogleSubject).toBe("subject-workspace");
  });

  it("still rejects an unverified Google email", async () => {
    const harness = createHarness({
      identities: new Map([
        ["unverified", { ...identity("subject-unverified", "user@workspace.example"), emailVerified: false as true }]
      ])
    });
    await expect(harness.service.loginWithGoogle("unverified", context())).rejects.toMatchObject({
      code: "INVALID_GOOGLE_LOGIN"
    });
  });

  it("requires an exact Gmail identity when AUTH_REQUIRE_GMAIL=true", async () => {
    const harness = createHarness({
      env: { AUTH_REQUIRE_GMAIL: "true" },
      identities: new Map([
        ["bad", identity("subject-bad", "player@gmail.com.example.com")]
      ])
    });
    await expect(harness.service.loginWithGoogle("bad", context())).rejects.toMatchObject({
      code: "VERIFIED_GMAIL_REQUIRED"
    });
  });

  it("uses the authoritative mode for pending accounts without converting them to approved", async () => {
    let mode: "open" | "closed" = "closed";
    const accessMode: TestAccessModeReader = {
      getAccessMode: vi.fn(async () => mode)
    };
    const harness = createHarness({ accessMode });
    const first = await harness.service.loginWithGoogle("credential-one", context());

    await expect(harness.service.requireApprovedTestAccess(first.session)).rejects.toMatchObject({
      code: "TEST_ACCESS_PENDING"
    });
    mode = "open";
    await expect(harness.service.requireApprovedTestAccess(first.session)).resolves.toBeUndefined();
    expect((await harness.service.sessionResponse(first.session)).testAccessAllowed).toBe(true);
    expect(first.session.account.testAccessStatus).toBe("pending");

    const returning = await harness.service.loginWithGoogle("credential-one-refresh", context());
    expect(returning.session.account.testAccessStatus).toBe("pending");
    await expect(
      harness.service.requireApprovedTestAccess(returning.session)
    ).resolves.toBeUndefined();

    mode = "closed";
    await expect(
      harness.service.requireApprovedTestAccess(returning.session)
    ).rejects.toMatchObject({ code: "TEST_ACCESS_PENDING" });
  });

  it("admits only developer subjects and admin-approved dev-list accounts in dev mode", async () => {
    const devList = new Set<string>();
    const recordDevAccessRequest = vi.fn(async () => undefined);
    const accessMode: TestAccessModeReader = {
      getAccessMode: async () => "dev",
      hasDevAccess: async (accountId) => devList.has(accountId),
      recordDevAccessRequest
    };
    const harness = createHarness({
      accessMode,
      env: {
        DEV_AUTHORIZED_GOOGLE_SUBJECTS: "subject-one",
        TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "subject-three"
      }
    });
    const developer = await harness.service.loginWithGoogle("credential-one", context());
    const admin = await harness.service.loginWithGoogle("credential-three", context());
    const approved = await harness.service.loginWithGoogle("credential-two", context());
    // Developer and admin subjects pass even before any test-access approval.
    expect(developer.session.account.testAccessStatus).toBe("pending");
    await expect(
      harness.service.requireApprovedTestAccess(developer.session)
    ).resolves.toBeUndefined();
    await expect(harness.service.requireApprovedTestAccess(admin.session)).resolves.toBeUndefined();

    approved.session.account.testAccessStatus = "approved";
    await expect(harness.service.requireApprovedTestAccess(approved.session)).rejects.toMatchObject({
      code: "TEST_ACCESS_DEV_ONLY"
    });
    expect(recordDevAccessRequest).toHaveBeenCalledWith(approved.session.account.id);
    expect(await harness.service.sessionResponse(approved.session)).toMatchObject({
      testAccessAllowed: false,
      testAccessDevOnly: true
    });

    devList.add(approved.session.account.id);
    await expect(harness.service.requireApprovedTestAccess(approved.session)).resolves.toBeUndefined();
    const allowed = await harness.service.sessionResponse(approved.session);
    expect(allowed.testAccessAllowed).toBe(true);
    expect(allowed.testAccessDevOnly).toBeUndefined();

    // Revoked test access wins over a dev-list entry and is never recorded.
    approved.session.account.testAccessStatus = "revoked";
    recordDevAccessRequest.mockClear();
    await expect(harness.service.requireApprovedTestAccess(approved.session)).rejects.toMatchObject({
      code: "TEST_ACCESS_REVOKED"
    });
    expect(recordDevAccessRequest).not.toHaveBeenCalled();
  });

  it.each(["denied", "revoked"] as const)(
    "keeps an administratively %s account blocked during open access",
    async (status) => {
      const harness = createHarness({
        accessMode: { getAccessMode: async () => "open" }
      });
      const login = await harness.service.loginWithGoogle("credential-one", context());
      login.session.account.testAccessStatus = status;

      await expect(harness.service.requireApprovedTestAccess(login.session)).rejects.toMatchObject({
        code: status === "denied" ? "TEST_ACCESS_DENIED" : "TEST_ACCESS_REVOKED"
      });
    }
  );

  it.each(["suspended", "deleted"] as const)("rejects a %s account", async (status) => {
    const harness = createHarness();
    await harness.service.loginWithGoogle("credential-one", context());
    harness.store.accountForSubject("subject-one").status = status;

    await expect(
      harness.service.loginWithGoogle("credential-one-refresh", context())
    ).rejects.toMatchObject({
      code: status === "suspended" ? "ACCOUNT_SUSPENDED" : "ACCOUNT_UNAVAILABLE"
    });
  });

  it("stores only a purpose-separated session hash", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());
    const expectedHash = hashAuthToken(
      login.session.rawToken,
      harness.config.AUTH_SESSION_TOKEN_HMAC_KEY,
      "session"
    );

    expect(harness.store.sessionsByHash.has(expectedHash)).toBe(true);
    expect(harness.store.sessionsByHash.has(login.session.rawToken)).toBe(false);
    expect([...harness.store.credentialUses.keys()]).not.toContain("credential-one");
    expect(JSON.stringify(harness.store.authEvents)).not.toContain("credential-one");
  });

  it("rejects revoked, absolutely expired, and inactive sessions", async () => {
    let now = new Date("2026-07-09T12:00:00.000Z");
    const harness = createHarness({ now: () => now });
    const revoked = await harness.service.loginWithGoogle("credential-one", context());
    await harness.service.logout(revoked.session.rawToken, revoked.session);
    await expect(harness.service.authenticateSession(revoked.session.rawToken)).resolves.toBeNull();

    const expired = await harness.service.loginWithGoogle("credential-one-refresh", context());
    now = new Date("2026-08-09T12:00:01.000Z");
    await expect(harness.service.authenticateSession(expired.session.rawToken)).resolves.toBeNull();

    now = new Date("2026-07-09T12:00:00.000Z");
    const inactive = await harness.service.loginWithGoogle("credential-two", context());
    now = new Date("2026-07-24T12:00:01.000Z");
    await expect(harness.service.authenticateSession(inactive.session.rawToken)).resolves.toBeNull();
  });

  it("throttles last-seen writes to at most once per five minutes", async () => {
    let now = new Date("2026-07-09T12:00:00.000Z");
    const harness = createHarness({ now: () => now });
    const login = await harness.service.loginWithGoogle("credential-one", context());

    await harness.service.authenticateSession(login.session.rawToken);
    now = new Date("2026-07-09T12:04:59.000Z");
    await harness.service.authenticateSession(login.session.rawToken);
    expect(harness.store.touchCount).toBe(0);
    now = new Date("2026-07-09T12:05:00.000Z");
    await harness.service.authenticateSession(login.session.rawToken);
    expect(harness.store.touchCount).toBe(1);
  });

  it("rejects session reuse immediately after account suspension", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());
    harness.store.accountForSubject("subject-one").status = "suspended";

    await expect(
      harness.service.authenticateSession(login.session.rawToken)
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED" });
  });

  it("keeps logout revocation successful when telemetry storage is unavailable", async () => {
    const harness = createHarness();
    const login = await harness.service.loginWithGoogle("credential-one", context());
    vi.spyOn(harness.store, "insertAuthEvent").mockRejectedValueOnce(
      new Error("database details that must not reach the client")
    );

    await expect(
      harness.service.logout(login.session.rawToken, login.session)
    ).resolves.toBeUndefined();
    await expect(harness.service.authenticateSession(login.session.rawToken)).resolves.toBeNull();
  });

  it("rotates an existing session and prevents fixation", async () => {
    const harness = createHarness();
    const first = await harness.service.loginWithGoogle("credential-one", context());
    const replacement = await harness.service.loginWithGoogle(
      "credential-one-refresh",
      context(first.deviceToken, first.session.rawToken)
    );

    expect(replacement.session.rawToken).not.toBe(first.session.rawToken);
    await expect(harness.service.authenticateSession(first.session.rawToken)).resolves.toBeNull();
    await expect(
      harness.service.authenticateSession(replacement.session.rawToken)
    ).resolves.not.toBeNull();
  });

  it("records multiple accounts on one installation as advisory risk without suspension", async () => {
    const harness = createHarness();
    const first = await harness.service.loginWithGoogle("credential-one", context());
    const second = await harness.service.loginWithGoogle(
      "credential-two",
      context(first.deviceToken)
    );
    await harness.service.loginWithGoogle("credential-two-refresh", context(first.deviceToken));

    expect(second.session.account.riskScore).toBe(25);
    expect(harness.store.riskEvents).toContainEqual(
      expect.objectContaining({ eventType: "multiple_accounts_same_device", weight: 25 })
    );
    expect(first.session.account.status).toBe("active");
    expect(second.session.account.status).toBe("active");
    expect(
      harness.store.riskEvents.filter(
        (event) => event.eventType === "multiple_accounts_same_device"
      )
    ).toHaveLength(1);
  });

  it("reuses a returning device installation and creates a new one for a new browser token", async () => {
    const harness = createHarness();
    const first = await harness.service.loginWithGoogle("credential-one", context());
    await harness.service.loginWithGoogle("credential-one-refresh", context(first.deviceToken));
    expect(harness.store.devicesByHash.size).toBe(1);

    await harness.service.loginWithGoogle("credential-one-third", context());
    expect(harness.store.devicesByHash.size).toBe(2);
    expect([...harness.store.devicesByHash.keys()]).not.toContain(first.deviceToken);
  });

  it("records only HMAC network values, never the raw address", async () => {
    const harness = createHarness();
    await harness.service.loginWithGoogle("credential-one", context());
    expect(JSON.stringify(harness.store.authEvents)).not.toContain("203.0.113.42");
    expect(harness.store.authEvents.some((event) => event.networkHash?.startsWith("v1:"))).toBe(
      true
    );
  });

  it("does not let a new-account network limit block an existing identity", async () => {
    const harness = createHarness({
      env: { AUTH_NEW_ACCOUNT_NETWORK_MAX: "2" }
    });
    const first = await harness.service.loginWithGoogle("credential-one", context());
    await harness.service.loginWithGoogle("credential-two", context());
    await expect(
      harness.service.loginWithGoogle("credential-three", context())
    ).rejects.toMatchObject({ code: "TOO_MANY_ACCOUNT_CREATION_ATTEMPTS" });
    await expect(
      harness.service.loginWithGoogle("credential-one-refresh", context(first.deviceToken))
    ).resolves.toMatchObject({ session: { account: { id: first.session.account.id } } });
  });

  it("enforces account-creation limits across concurrent signup requests", async () => {
    const harness = createHarness({
      env: {
        AUTH_NEW_ACCOUNT_DEVICE_MAX: "10",
        AUTH_NEW_ACCOUNT_NETWORK_MAX: "2"
      }
    });
    const results = await Promise.allSettled([
      harness.service.loginWithGoogle("credential-one", context()),
      harness.service.loginWithGoogle("credential-two", context()),
      harness.service.loginWithGoogle("credential-three", context())
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(harness.store.accountsById.size).toBe(2);
  });

  it.each([
    ["IPv4 /24", ["203.0.113.10", "203.0.113.99", "203.0.113.200"]],
    [
      "IPv6 /56",
      ["2001:db8:abcd:1201::1", "2001:db8:abcd:12aa::2", "2001:db8:abcd:12ff::3"]
    ]
  ])("keeps the new-account network limit across %s address changes", async (_label, ips) => {
    const harness = createHarness({
      env: {
        AUTH_NEW_ACCOUNT_DEVICE_MAX: "10",
        AUTH_NEW_ACCOUNT_NETWORK_MAX: "2"
      }
    });
    await harness.service.loginWithGoogle("credential-one", context(null, null, ips[0]));
    await harness.service.loginWithGoogle("credential-two", context(null, null, ips[1]));
    await expect(
      harness.service.loginWithGoogle("credential-three", context(null, null, ips[2]))
    ).rejects.toMatchObject({ code: "TOO_MANY_ACCOUNT_CREATION_ATTEMPTS" });
  });

  it("applies configurable login attempt limits per device and network", async () => {
    const deviceLimited = createHarness({
      env: { AUTH_LOGIN_DEVICE_MAX: "2", AUTH_LOGIN_IP_MAX: "20" }
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        deviceLimited.service.loginWithGoogle("invalid", context("fixed-device-token"))
      ).rejects.toMatchObject({ code: "INVALID_GOOGLE_LOGIN" });
    }
    await expect(
      deviceLimited.service.loginWithGoogle("invalid", context("fixed-device-token"))
    ).rejects.toMatchObject({ code: "TOO_MANY_LOGIN_ATTEMPTS" });

    const networkLimited = createHarness({
      env: { AUTH_LOGIN_DEVICE_MAX: "20", AUTH_LOGIN_IP_MAX: "2" }
    });
    await expect(
      networkLimited.service.loginWithGoogle("invalid", context("device-one"))
    ).rejects.toMatchObject({ code: "INVALID_GOOGLE_LOGIN" });
    await expect(
      networkLimited.service.loginWithGoogle("invalid", context("device-two"))
    ).rejects.toMatchObject({ code: "INVALID_GOOGLE_LOGIN" });
    await expect(
      networkLimited.service.loginWithGoogle("invalid", context("device-three"))
    ).rejects.toMatchObject({ code: "TOO_MANY_LOGIN_ATTEMPTS" });
  });

  it("records deterministic rapid-switching and network-burst evidence without banning", async () => {
    const identities = new Map<string, VerifiedGoogleIdentity>();
    for (let index = 1; index <= 5; index += 1) {
      identities.set(
        `credential-${index}`,
        identity(`subject-${index}`, `player${index}@example.com`)
      );
    }
    const deviceHarness = createHarness({ identities });
    const first = await deviceHarness.service.loginWithGoogle("credential-1", context());
    await deviceHarness.service.loginWithGoogle(
      "credential-2",
      context(first.deviceToken, null, "203.0.114.42")
    );
    const third = await deviceHarness.service.loginWithGoogle(
      "credential-3",
      context(first.deviceToken, null, "203.0.115.42")
    );
    expect(third.session.account.riskScore).toBe(35);
    expect(deviceHarness.store.riskEvents).toContainEqual(
      expect.objectContaining({ eventType: "rapid_account_switching", weight: 20 })
    );

    const networkHarness = createHarness({
      identities,
      env: { AUTH_NEW_ACCOUNT_NETWORK_MAX: "6" }
    });
    const logins = [];
    for (let index = 1; index <= 5; index += 1) {
      logins.push(
        await networkHarness.service.loginWithGoogle(`credential-${index}`, context())
      );
    }
    expect(logins[2]?.session.account.riskScore).toBe(20);
    expect(logins[4]?.session.account.riskScore).toBe(40);
    expect(logins.every((login) => login.session.account.status === "active")).toBe(true);
  });

  it("approves development login without creating gameplay state", async () => {
    const harness = createHarness({
      env: {
        AUTH_RUNTIME_MODE: "local",
        AUTH_MODE: "dev",
        AUTH_DEV_LOGIN_ENABLED: "true"
      }
    });
    const login = await harness.service.loginAsDeveloper("default", context());
    expect(login.session.account.testAccessStatus).toBe("approved");
    expect(login.session.player).toBeNull();
    await expect(harness.service.authenticateSession(login.session.rawToken)).resolves.toMatchObject({
      player: null
    });
  });

  it("rejects exact Google credential replay, including concurrent replay", async () => {
    const sequential = createHarness();
    await sequential.service.loginWithGoogle("credential-one", context());
    await expect(
      sequential.service.loginWithGoogle("credential-one", context())
    ).rejects.toMatchObject({ code: "INVALID_GOOGLE_LOGIN" });

    const concurrent = createHarness();
    const results = await Promise.allSettled([
      concurrent.service.loginWithGoogle("credential-one", context()),
      concurrent.service.loginWithGoogle("credential-one", context())
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects malformed cookies without hashing or querying them", async () => {
    const harness = createHarness();
    await expect(harness.service.authenticateSession("malformed-cookie")).resolves.toBeNull();
    expect(harness.store.findSessionCount).toBe(0);

    const prepared = await harness.service.ensureDeviceForRequest({
      ip: "203.0.113.42",
      userAgent: "Mozilla/5.0",
      deviceToken: "attacker-selected-cookie"
    });
    expect(prepared.created).toBe(true);
    expect(isSecureToken(prepared.deviceToken)).toBe(true);
  });

  it("keeps the network login limit effective when every device cookie is discarded", async () => {
    const harness = createHarness({
      env: { AUTH_LOGIN_DEVICE_MAX: "20", AUTH_LOGIN_IP_MAX: "2" }
    });
    await expect(harness.service.loginWithGoogle("invalid", context())).rejects.toMatchObject({
      code: "INVALID_GOOGLE_LOGIN"
    });
    await expect(harness.service.loginWithGoogle("invalid", context())).rejects.toMatchObject({
      code: "INVALID_GOOGLE_LOGIN"
    });
    await expect(harness.service.loginWithGoogle("invalid", context())).rejects.toMatchObject({
      code: "TOO_MANY_LOGIN_ATTEMPTS"
    });
  });
});

describe("AuthService public update sign-up surface", () => {
  it("tells signed-out clients only the access mode, and omits it when the read fails", async () => {
    const dev = createHarness({ accessMode: { getAccessMode: async () => "dev" } });
    const response = await dev.service.sessionResponse(null);
    expect(response).toMatchObject({ authenticated: false, testAccessMode: "dev" });
    const failing = createHarness({ accessMode: { getAccessMode: async () => { throw new Error("db down"); } } });
    const fallback = await failing.service.sessionResponse(null);
    expect(fallback.authenticated).toBe(false);
    expect(fallback).not.toHaveProperty("testAccessMode");
  });

  it("accepts the app's native origins and native header, and rejects anything else", () => {
    const { service } = createHarness();
    expect(() => service.assertOrigin("http://127.0.0.1:5173")).not.toThrow();
    expect(() => service.assertOrigin("capacitor://localhost")).not.toThrow();
    expect(() => service.assertOrigin("https://localhost")).not.toThrow();
    expect(() => service.assertOrigin(undefined, true)).not.toThrow();
    expect(() => service.assertOrigin(undefined)).toThrow(/origin/u);
    expect(() => service.assertOrigin("https://evil.example")).toThrow(/origin/u);
    expect(() => service.assertOrigin("http://localhost")).toThrow(/origin/u);
  });
});

function createHarness(options: {
  env?: NodeJS.ProcessEnv;
  identities?: ReadonlyMap<string, VerifiedGoogleIdentity>;
  now?: () => Date;
  accessMode?: TestAccessModeReader;
} = {}): {
  config: AppConfig;
  store: InMemoryAuthStore;
  service: AuthService;
} {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "test-client-id",
    ...options.env
  });
  const store = new InMemoryAuthStore();
  if (options.accessMode) store.newAccountTestAccessStatus = "pending";
  const identities = options.identities ?? new Map([
    ["credential-one", identity("subject-one", "one@example.com")],
    ["credential-one-refresh", identity("subject-one", "one@example.com")],
    ["credential-one-concurrent", identity("subject-one", "one@example.com")],
    ["credential-one-third", identity("subject-one", "one@example.com")],
    ["credential-two", identity("subject-two", "two@example.com")],
    ["credential-two-refresh", identity("subject-two", "two@example.com")],
    ["credential-three", identity("subject-three", "three@example.com")]
  ]);
  const service = new AuthService(
    config,
    store,
    new FakeGoogleIdentityVerifier(identities),
    { warn: vi.fn() } as never,
    options.now,
    options.accessMode
  );
  return { config, store, service };
}

function identity(subject: string, email: string): VerifiedGoogleIdentity {
  return {
    subject,
    email,
    emailVerified: true,
    authTime: null,
    authMethods: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z")
  };
}

function appleIdentity(subject: string, email: string): VerifiedAppleIdentity {
  return {
    provider: "apple",
    subject,
    email,
    emailVerified: true,
    isPrivateEmail: true,
    authTime: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z")
  };
}

function context(
  deviceToken: string | null = null,
  existingSessionToken: string | null = null,
  ip = "203.0.113.42"
): LoginRequestContext {
  return {
    ip,
    userAgent: "Mozilla/5.0 Chrome/135.0 Windows NT 10.0",
    deviceToken:
      deviceToken && !isSecureToken(deviceToken)
        ? createHash("sha256").update(deviceToken).digest("base64url")
        : deviceToken,
    existingSessionToken
  };
}
