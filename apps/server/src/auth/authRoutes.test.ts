import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryAuthStore } from "../__tests__/authTestStore.js";
import { loadConfig, type AppConfig } from "../config.js";
import { installAuthGuard } from "./authGuard.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { AuthService } from "./authService.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import type { OnboardingService } from "./onboardingService.js";
import type { VerifiedGoogleIdentity } from "./types.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authentication HTTP routes", () => {
  it("sets an HttpOnly device cookie and reports anonymous development capability", async () => {
    const { app } = await buildAuthApp(devLoginEnv());
    const response = await app.inject({ method: "GET", url: "/api/auth/session" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: false,
      developmentAuthEnabled: true
    });
    const cookies = setCookieLines(response.headers["set-cookie"]).join(";");
    expect(cookies).toContain("aa_device_dev=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Lax");
    expect(cookies).toContain("Path=/");
    expect(cookies).not.toContain("Secure");
    expect(cookies).not.toContain("Domain=");
  });

  it("authenticates all four allowlisted profiles with their preset player so setup is skipped", async () => {
    const { app, store } = await buildAuthApp(devLoginEnv());
    const profiles = ["default", "player2", "player3", "player4"];
    const presets: Record<string, { displayName: string; personalFlagColor: string }> = {
      default: { displayName: "Developer", personalFlagColor: "red" },
      player2: { displayName: "DevTwo", personalFlagColor: "blue" },
      player3: { displayName: "DevThree", personalFlagColor: "green" },
      player4: { displayName: "DevFour", personalFlagColor: "gold" }
    };
    const logins = new Map<string, Awaited<ReturnType<FastifyInstance["inject"]>>>();

    for (const profile of profiles) {
      const login = await developerLogin(app, profile);
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({
        authenticated: true,
        onboardingRequired: false,
        player: presets[profile],
        developerCapabilities: profile === "default"
          ? [
              "developer:wiki-manage",
      "developer:observe",
      "developer:appearance-studio",
              "developer:world-mutate",
              "developer:assets-grant",
              "developer:packages-send",
              "developer:economy-mutate"
            ]
          : []
      });
      logins.set(profile, login);
    }

    const accountIds = [...logins.values()].map((login) => login.json().account.id as string);
    expect(new Set(accountIds).size).toBe(4);
    expect(store.accountsBySubject.size).toBe(4);
    expect([...store.accountsBySubject.keys()]).toEqual([
      "ash-atlas-dev:developer@example.com",
      "ash-atlas-dev:player2",
      "ash-atlas-dev:player3",
      "ash-atlas-dev:player4"
    ]);

    for (const login of logins.values()) {
      const restored = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: requestCookieHeader(login.headers["set-cookie"]) }
      });
      expect(restored.json()).toMatchObject({
        account: { id: login.json().account.id }
      });
    }

    const repeat = await developerLogin(app, "player2");
    expect(repeat.json()).toMatchObject({
      account: { id: logins.get("player2")?.json().account.id },
      player: presets.player2
    });
    expect(store.accountsBySubject.size).toBe(4);
  });

  it("rejects unknown profiles and all client-supplied identity metadata", async () => {
    const { app, store } = await buildAuthApp(devLoginEnv());
    for (const payload of [
      { profile: "admin" },
      { profile: "player2", playerId: "attacker-player" },
      { profile: "player3", accountId: "attacker-account" },
      { profile: "player4", email: "attacker@example.com", username: "Admin" }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/dev",
        headers: { origin: "http://127.0.0.1:5173" },
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_DEV_LOGIN" } });
    }
    expect(store.accountsBySubject.size).toBe(0);
    expect(store.playersByAccount.size).toBe(0);
  });

  it("does not register development login when its explicit flag is absent", async () => {
    const { app } = await buildAuthApp({ AUTH_MODE: "dev" });
    const response = await developerLogin(app, "default");
    expect(response.statusCode).toBe(404);
  });

  it("logs out one development profile without revoking the other profiles", async () => {
    const { app } = await buildAuthApp(devLoginEnv());
    const first = await developerLogin(app, "default");
    const second = await developerLogin(app, "player2");
    const firstSession = first.json();

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: requestCookieHeader(first.headers["set-cookie"]),
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": firstSession.csrfToken
      }
    });
    expect(logout.statusCode).toBe(200);

    const [firstAfter, secondAfter] = await Promise.all(
      [first, second].map((login) =>
        app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: requestCookieHeader(login.headers["set-cookie"]) }
        })
      )
    );
    expect(firstAfter?.json().authenticated).toBe(false);
    expect(secondAfter?.json()).toMatchObject({
      authenticated: true,
      onboardingRequired: true
    });
  });

  it("requires an allowed Origin for Google credential login", async () => {
    const { app } = await buildAuthApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: { origin: "https://attacker.example" },
      payload: { credential: "valid-google-token" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_FORBIDDEN" } });
  });

  it("rejects a missing production Origin", async () => {
    const { app } = await buildAuthApp(validProductionEnv());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      payload: { credential: "valid-google-token" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_FORBIDDEN" } });
  });

  it("issues and reuses a device cookie even when Google verification fails", async () => {
    const { app, store } = await buildAuthApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { credential: "invalid-token" }
    });
    expect(first.statusCode).toBe(401);
    expect(setCookieLines(first.headers["set-cookie"]).join(";")).toContain("aa_device_dev=");

    const second = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: {
        origin: "http://127.0.0.1:5173",
        cookie: requestCookieHeader(first.headers["set-cookie"])
      },
      payload: { credential: "invalid-token" }
    });
    expect(second.statusCode).toBe(401);
    expect(store.devicesByHash.size).toBe(1);
  });

  it("replaces malformed device cookies and ignores malformed session cookies", async () => {
    const { app, store } = await buildAuthApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: {
        cookie: "aa_device_dev=attacker-selected; aa_session_dev=malformed"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().authenticated).toBe(false);
    expect(setCookieLines(response.headers["set-cookie"]).join(";")).toContain(
      "aa_device_dev="
    );
    expect(store.findSessionCount).toBe(0);
  });

  it("creates a session exposing only the signed-in user's verified email", async () => {
    const { app } = await buildAuthApp();
    const response = await googleLogin(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: true,
      onboardingRequired: true,
      account: { status: "active", trustTier: "new" }
    });
    expect(response.body).not.toContain("google-subject");
    expect(response.json().verifiedEmail).toBe("player@example.com");
    expect(response.body).not.toContain("valid-google-token");
  });

  it("does not adopt an attacker-selected session cookie", async () => {
    const { app } = await buildAuthApp();
    const attackerToken = "A".repeat(43);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: {
        origin: "http://127.0.0.1:5173",
        cookie: `aa_session_dev=${attackerToken}`
      },
      payload: { credential: "valid-google-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(setCookieLines(response.headers["set-cookie"]).join(";")).not.toContain(
      `aa_session_dev=${attackerToken}`
    );
  });

  it("rejects exact Google credential replay", async () => {
    const { app } = await buildAuthApp();
    const first = await googleLogin(app);
    expect(first.statusCode).toBe(200);

    const replay = await googleLogin(app);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "INVALID_GOOGLE_LOGIN" } });
  });

  it("rejects an oversized Google login body before verification", async () => {
    const { app } = await buildAuthApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: { origin: "http://127.0.0.1:5173", "content-type": "application/json" },
      payload: JSON.stringify({ credential: "x".repeat(21_000) })
    });

    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain("x".repeat(100));
  });

  it("returns a neutral suspended-account result for an existing session", async () => {
    const { app, store } = await buildAuthApp();
    const login = await googleLogin(app);
    store.accountForSubject("google-subject").status = "suspended";
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: requestCookieHeader(login.headers["set-cookie"]) }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "ACCOUNT_SUSPENDED", message: "Account suspended" }
    });
  });

  it("enforces Origin and CSRF while allowing first-login player onboarding", async () => {
    const { app } = await buildAuthApp();
    const login = await googleLogin(app);
    const cookieHeader = requestCookieHeader(login.headers["set-cookie"]);
    const csrfToken = login.json().csrfToken as string;

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/account/onboarding",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken },
      payload: { displayName: "ScoutOne", personalFlagColor: "purple" }
    });
    expect(missingOrigin.statusCode).toBe(403);

    const wrongCsrf = await app.inject({
      method: "POST",
      url: "/api/account/onboarding",
      headers: {
        cookie: cookieHeader,
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": "not-base64url!".repeat(20)
      },
      payload: { displayName: "ScoutOne", personalFlagColor: "purple" }
    });
    expect(wrongCsrf.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/account/onboarding",
      headers: {
        cookie: cookieHeader,
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": csrfToken
      },
      payload: { displayName: "ScoutOne", personalFlagColor: "purple" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      player: { displayName: "ScoutOne", personalFlagColor: "purple" }
    });

    const legacy = await app.inject({
      method: "POST",
      url: "/api/account/player-name",
      headers: {
        cookie: cookieHeader,
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": csrfToken
      },
      payload: { displayName: "Bypass" }
    });
    expect(legacy.statusCode).toBeGreaterThanOrEqual(400);
  });

  it.each(["pending", "denied", "revoked"] as const)(
    "allows a %s session to read its status and log out but blocks onboarding and gameplay",
    async (status) => {
      const { app, store } = await buildAuthApp();
      store.newAccountTestAccessStatus = status;
      const login = await googleLogin(app);
      const cookieHeader = requestCookieHeader(login.headers["set-cookie"]);
      const csrfToken = login.json().csrfToken as string;

      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({
        authenticated: true,
        testAccessStatus: status,
        verifiedEmail: "player@example.com",
        onboardingRequired: true
      });
      const gameplay = await app.inject({
        method: "GET",
        url: "/api/test/gameplay-probe",
        headers: { cookie: cookieHeader }
      });
      expect(gameplay.statusCode).toBe(403);
      expect(gameplay.json()).toMatchObject({
        error: {
          code: status === "pending"
            ? "TEST_ACCESS_PENDING"
            : status === "denied"
              ? "TEST_ACCESS_DENIED"
              : "TEST_ACCESS_REVOKED"
        }
      });
      const onboarding = await app.inject({
        method: "POST",
        url: "/api/account/onboarding",
        headers: {
          cookie: cookieHeader,
          origin: "http://127.0.0.1:5173",
          "x-csrf-token": csrfToken
        },
        payload: { displayName: "Scout", personalFlagColor: "blue" }
      });
      expect(onboarding.statusCode).toBe(403);
      expect(store.playersByAccount.size).toBe(0);

      const logout = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          cookie: cookieHeader,
          origin: "http://127.0.0.1:5173",
          "x-csrf-token": csrfToken
        }
      });
      expect(logout.statusCode).toBe(200);
    }
  );

  it("revokes logout sessions, clears the session cookie, and closes gameplay", async () => {
    const { app, service, connections } = await buildAuthApp(devLoginEnv());
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { profile: "default" }
    });
    const session = login.json();
    const cookieHeader = requestCookieHeader(login.headers["set-cookie"]);
    const finalization = deferredVoid();
    connections.finalizeAccountConnections.mockImplementationOnce(
      () => finalization.promise
    );
    const revoke = vi.spyOn(service, "logout");
    const logoutPending = app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: cookieHeader,
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": session.csrfToken
      }
    });
    await vi.waitFor(() =>
      expect(connections.finalizeAccountConnections).toHaveBeenCalled()
    );
    expect(revoke).not.toHaveBeenCalled();
    finalization.resolve();
    const logout = await logoutPending;

    expect(logout.statusCode).toBe(200);
    expect(setCookieLines(logout.headers["set-cookie"]).join(";")).toContain(
      "aa_session_dev=;"
    );
    expect(connections.finalizeAccountConnections).toHaveBeenCalledWith(
      session.account.id,
      4001,
      "logged out"
    );
    const after = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: cookieHeader }
    });
    expect(after.json().authenticated).toBe(false);
  });

  it("logout-all revokes every account session", async () => {
    const { app, service, connections } = await buildAuthApp(devLoginEnv());
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { profile: "default" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { profile: "default" }
    });
    const secondSession = second.json();
    const finalization = deferredVoid();
    connections.finalizeAccountConnections.mockImplementationOnce(
      () => finalization.promise
    );
    const revokeAll = vi.spyOn(service, "logoutAll");
    const logoutPending = app.inject({
      method: "POST",
      url: "/api/auth/logout-all",
      headers: {
        cookie: requestCookieHeader(second.headers["set-cookie"]),
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": secondSession.csrfToken
      }
    });
    await vi.waitFor(() =>
      expect(connections.finalizeAccountConnections).toHaveBeenCalled()
    );
    expect(revokeAll).not.toHaveBeenCalled();
    finalization.resolve();
    const logout = await logoutPending;
    expect(logout.statusCode).toBe(200);

    for (const login of [first, second]) {
      const session = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: requestCookieHeader(login.headers["set-cookie"]) }
      });
      expect(session.json().authenticated).toBe(false);
    }
    expect(connections.finalizeAccountConnections).toHaveBeenCalledWith(
      secondSession.account.id,
      4001,
      "all sessions revoked"
    );
  });

  it("uses __Host secure SameSite=Lax cookies in production", async () => {
    const { app } = await buildAuthApp(validProductionEnv());
    const response = await googleLogin(app, "https://game.example");
    const cookies = setCookieLines(response.headers["set-cookie"]).join(";");
    expect(cookies).toContain("__Host-aa_session=");
    expect(cookies).toContain("__Host-aa_device=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("SameSite=Lax");
    expect(cookies).toContain("Path=/");
    expect(cookies).not.toContain("Domain=");
  });

  it("does not register the developer-login endpoint in production", async () => {
    const { app } = await buildAuthApp(validProductionEnv());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: "https://game.example" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns production economy capability only from the allowlisted authenticated session", async () => {
    const { app } = await buildAuthApp({
      ...validProductionEnv(),
      DEV_TOOLS_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true",
      DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: "true",
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: "google-subject",
      RUNTIME_SHA: "f".repeat(40)
    });
    const login = await googleLogin(app, "https://game.example");
    expect(login.statusCode).toBe(200);
    expect(login.json().developerCapabilities).toEqual([
      "developer:wiki-manage",
      "developer:observe",
      "developer:appearance-studio",
      "developer:world-mutate",
      "developer:assets-grant",
      "developer:packages-send",
      "developer:economy-mutate"
    ]);

    const restored = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: requestCookieHeader(login.headers["set-cookie"]) }
    });
    expect(restored.json().developerCapabilities).toEqual(
      login.json().developerCapabilities
    );
  });
});

async function buildAuthApp(env: NodeJS.ProcessEnv = {}): Promise<{
  app: FastifyInstance;
  config: AppConfig;
  store: InMemoryAuthStore;
  service: AuthService;
  connections: { finalizeAccountConnections: ReturnType<typeof vi.fn> };
}> {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    ...env
  });
  const store = new InMemoryAuthStore();
  const service = new AuthService(
    config,
    store,
    new FakeGoogleIdentityVerifier(
      new Map([["valid-google-token", identity("google-subject", "player@example.com")]])
    ),
    { warn: vi.fn() } as never
  );
  const connections = {
    finalizeAccountConnections: vi.fn(async () => undefined)
  };
  const onboarding = {
    complete: vi.fn(async (session, input) => ({
      id: "player-id",
      accountId: session.account.id,
      displayName: input.displayName,
      personalFlagColor: input.personalFlagColor,
      onboardingCompletedAt: new Date()
    }))
  } as unknown as OnboardingService;
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  installAuthGuard(app, config, service);
  app.get("/api/test/gameplay-probe", async () => ({ ok: true }));
  registerAuthRoutes(app, service, onboarding, config, connections);
  await app.ready();
  return { app, config, store, service, connections };
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

function googleLogin(app: FastifyInstance, origin = "http://127.0.0.1:5173") {
  return app.inject({
    method: "POST",
    url: "/api/auth/google",
    headers: { origin },
    payload: { credential: "valid-google-token" }
  });
}

function setCookieLines(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function requestCookieHeader(value: string | string[] | undefined): string {
  return setCookieLines(value)
    .map((line) => line.split(";", 1)[0])
    .filter((line): line is string => Boolean(line))
    .join("; ");
}

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    APP_PUBLIC_ORIGIN: "https://game.example",
    AUTH_ALLOWED_ORIGINS: "https://game.example",
    AUTH_TRUST_PROXY: "127.0.0.1,::1",
    AUTH_SESSION_TOKEN_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa",
    AUTH_DEVICE_TOKEN_HMAC_KEY: "device-key-bbbbbbbbbbbbbbbbbbbbbbbbb",
    AUTH_NETWORK_HMAC_KEY: "network-key-ccccccccccccccccccccccccc",
    INITIAL_SPAWN_HMAC_KEY: "spawn-key-dddddddddddddddddddddddddd",
    DOG_GENETICS_HMAC_KEY: "dog-key-eeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "test-access-admin-subject",
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: "false",
    DEV_TOOLS_ENABLED: "false"
  };
}

function developerLogin(app: FastifyInstance, profile: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/dev",
    headers: { origin: "http://127.0.0.1:5173" },
    payload: { profile }
  });
}

function devLoginEnv(): NodeJS.ProcessEnv {
  return {
    AUTH_RUNTIME_MODE: "local",
    AUTH_MODE: "dev",
    AUTH_DEV_LOGIN_ENABLED: "true",
    DEV_TOOLS_ENABLED: "true",
    DEV_ADMIN_TOOLS_ENABLED: "true",
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: "ash-atlas-dev:developer@example.com"
  };
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
