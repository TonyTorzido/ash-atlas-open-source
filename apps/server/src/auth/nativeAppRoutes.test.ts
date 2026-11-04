import { createHash } from "node:crypto";

import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryAuthStore } from "../__tests__/authTestStore.js";
import { loadConfig } from "../config.js";
import { installAuthGuard } from "./authGuard.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { AuthService } from "./authService.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import {
  CAPACITOR_IOS_CALLBACK,
  CAPACITOR_IOS_REQUEST_HEADER,
  CAPACITOR_IOS_REQUEST_HEADER_VALUE,
  NativeAppAuthorization
} from "./nativeAppAuthorization.js";
import { registerNativeAppRoutes } from "./nativeAppRoutes.js";
import type { OnboardingService } from "./onboardingService.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("native application authentication routes", () => {
  it("offers account choice even when the external browser already has a session", async () => {
    const app = await buildApp();
    const login = await app.inject({ method: "POST", url: "/api/auth/dev", headers: { origin: "http://127.0.0.1:5173" }, payload: { profile: "default" } });
    const query = new URLSearchParams({ state: "s".repeat(43), code_challenge: "c".repeat(43), redirect_uri: CAPACITOR_IOS_CALLBACK, choose_account: "true" });
    const response = await app.inject({ method: "GET", url: `/api/auth/native/authorize?${query}`, headers: { cookie: requestCookieHeader(login.headers["set-cookie"]) } });
    expect(response.statusCode).toBe(302);
    const target = new URL(response.headers.location ?? "");
    expect(target.pathname).toBe("/play/");
    expect(target.searchParams.get("choose_account")).toBe("true");
    expect(target.searchParams.has("code")).toBe(false);
  });
  it("advertises support and sends an unauthenticated browser through the website login", async () => {
    const app = await buildApp();
    const status = await app.inject({
      method: "GET",
      url: "/api/auth/native/status"
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ protocol: "ios-pkce-v1" });

    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = "s".repeat(43);
    const authorize = new URL("http://ash-atlas.test/api/auth/native/authorize");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("redirect_uri", CAPACITOR_IOS_CALLBACK);

    const response = await app.inject({
      method: "GET",
      url: `${authorize.pathname}${authorize.search}`
    });
    expect(response.statusCode).toBe(302);
    const login = new URL(response.headers.location ?? "");
    expect(`${login.origin}${login.pathname}`).toBe("http://127.0.0.1:5173/play/");
    expect(login.searchParams.get("native_auth")).toBe("ios");
    expect(login.searchParams.get("state")).toBe(state);
    expect(login.searchParams.get("code_challenge")).toBe(challenge);
    expect(login.searchParams.get("redirect_uri")).toBe(CAPACITOR_IOS_CALLBACK);
  });

  it("accepts the Android origin and evaluates the shared compatibility contract", async () => {
    const app = await buildApp();
    const compatibility = await app.inject({
      method: "GET",
      url: "/api/auth/native/compatibility?platform=android&version=1.0.0&build=42&wsMin=3&wsMax=3",
      headers: { origin: "https://localhost" }
    });
    expect(compatibility.statusCode).toBe(200);
    expect(compatibility.json()).toMatchObject({
      contractVersion: 1,
      build: "42",
      platform: "android",
      status: "supported",
      updateStatus: "ok",
      serverSha: null
    });
  });

  it("reports OTA bundle and shell requirements alongside the existing compatibility status", async () => {
    const app = await buildApp();
    const shellUpdate = await app.inject({
      method: "GET",
      url: "/api/auth/native/compatibility?platform=ios&version=1.0.0&build=7&wsMin=3&wsMax=3"
    });
    const bundleUpdate = await app.inject({
      method: "GET",
      url: "/api/auth/native/compatibility?platform=ios&version=1.0.0&build=8&wsMin=4&wsMax=4"
    });
    const current = await app.inject({
      method: "GET",
      url: "/api/auth/native/compatibility?platform=ios&version=1.0.0&build=8&wsMin=3&wsMax=3"
    });

    expect(shellUpdate.json()).toMatchObject({ status: "supported", updateStatus: "shell_update_required" });
    expect(bundleUpdate.json()).toMatchObject({ status: "required", updateStatus: "bundle_update_required" });
    expect(current.json()).toMatchObject({ status: "supported", updateStatus: "ok" });
  });

  it("applies independent platform marketing and build minimums", async () => {
    const app = await buildApp({
      NATIVE_IOS_HARD_MIN_VERSION: "1.0.0",
      NATIVE_IOS_HARD_MIN_BUILD: "2",
      NATIVE_IOS_RECOMMENDED_MIN_VERSION: "1.0.0",
      NATIVE_IOS_RECOMMENDED_MIN_BUILD: "3",
      NATIVE_IOS_LATEST_VERSION: "1.0.0",
      NATIVE_IOS_LATEST_BUILD: "3",
      NATIVE_IOS_STORE_URL: "https://apps.example/retired"
    });
    const ios = await app.inject({
      method: "GET",
      url: "/api/auth/native/compatibility?platform=ios&version=1.0.0&build=1&wsMin=3&wsMax=3"
    });
    const android = await app.inject({
      method: "GET",
      url: "/api/auth/native/compatibility?platform=android&version=1.0.0&build=1&wsMin=3&wsMax=3"
    });
    expect(ios.json()).toMatchObject({
      status: "required",
      hardMinimum: { build: 2 },
      storeUrl: "https://playashatlas.com/play/?install=1"
    });
    expect(android.json()).toMatchObject({ status: "supported", hardMinimum: { build: 0 } });
  });

  it("preserves explicit iOS authorization and accepts Android authorization", async () => {
    const app = await buildApp();
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = "s".repeat(43);
    for (const platform of ["ios", "android"] as const) {
      const authorize = new URL("http://ash-atlas.test/api/auth/native/authorize");
      authorize.searchParams.set("platform", platform);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("redirect_uri", CAPACITOR_IOS_CALLBACK);
      const response = await app.inject({
        method: "GET",
        url: `${authorize.pathname}${authorize.search}`
      });
      expect(response.statusCode).toBe(302);
      expect(new URL(response.headers.location ?? "").searchParams.get("native_auth")).toBe(platform);
    }
  });

  it("exchanges an authenticated browser session for an independent native session", async () => {
    const app = await buildApp();
    const browserLogin = await app.inject({
      method: "POST",
      url: "/api/auth/dev",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { profile: "default" }
    });
    expect(browserLogin.statusCode).toBe(200);

    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = "s".repeat(43);
    const authorize = new URL("http://ash-atlas.test/api/auth/native/authorize");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("redirect_uri", CAPACITOR_IOS_CALLBACK);

    const authorized = await app.inject({
      method: "GET",
      url: `${authorize.pathname}${authorize.search}`,
      headers: { cookie: requestCookieHeader(browserLogin.headers["set-cookie"]) }
    });
    expect(authorized.statusCode).toBe(302);
    const callback = new URL(authorized.headers.location ?? "");
    expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe(
      CAPACITOR_IOS_CALLBACK
    );
    expect(callback.searchParams.get("state")).toBe(state);

    const exchanged = await app.inject({
      method: "POST",
      url: "/api/auth/native/token",
      headers: {
        origin: "capacitor://localhost",
        [CAPACITOR_IOS_REQUEST_HEADER]: CAPACITOR_IOS_REQUEST_HEADER_VALUE
      },
      payload: {
        code: callback.searchParams.get("code"),
        codeVerifier: verifier,
        redirectUri: CAPACITOR_IOS_CALLBACK
      }
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json()).toMatchObject({
      authenticated: true,
      account: { id: browserLogin.json().account.id }
    });
    expect(exchanged.json().webSocketTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(requestCookieHeader(exchanged.headers["set-cookie"])).toContain("aa_session_dev=");
    const nativeSetCookies = Array.isArray(exchanged.headers["set-cookie"])
      ? exchanged.headers["set-cookie"]
      : [exchanged.headers["set-cookie"]];
    expect(nativeSetCookies.every((line) => /HttpOnly/u.test(line ?? ""))).toBe(true);
    expect(nativeSetCookies.join("\n")).toContain("Secure");

    const nativeSession = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: {
        cookie: requestCookieHeader(exchanged.headers["set-cookie"]),
        [CAPACITOR_IOS_REQUEST_HEADER]: CAPACITOR_IOS_REQUEST_HEADER_VALUE
      }
    });
    expect(nativeSession.statusCode).toBe(200);
    expect(nativeSession.json()).toMatchObject({
      authenticated: true,
      account: { id: browserLogin.json().account.id }
    });
    expect(nativeSession.json().webSocketTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const refreshedTicket = await app.inject({
      method: "GET",
      url: "/api/auth/native/ticket",
      headers: {
        origin: "https://localhost",
        cookie: requestCookieHeader(exchanged.headers["set-cookie"]),
        [CAPACITOR_IOS_REQUEST_HEADER]: "capacitor-android"
      }
    });
    expect(refreshedTicket.statusCode).toBe(200);
    expect(refreshedTicket.json().webSocketTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(refreshedTicket.headers["set-cookie"]).toBeUndefined();

    const authorizedBeforeRevocation = await app.inject({
      method: "GET",
      url: `${authorize.pathname}${authorize.search}`,
      headers: { cookie: requestCookieHeader(browserLogin.headers["set-cookie"]) }
    });
    const revokedCallback = new URL(authorizedBeforeRevocation.headers.location ?? "");
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: requestCookieHeader(browserLogin.headers["set-cookie"]),
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": browserLogin.json().csrfToken
      }
    });
    expect(logout.statusCode).toBe(200);
    const revokedExchange = await app.inject({
      method: "POST",
      url: "/api/auth/native/token",
      headers: { origin: "capacitor://localhost" },
      payload: {
        code: revokedCallback.searchParams.get("code"),
        codeVerifier: verifier,
        redirectUri: CAPACITOR_IOS_CALLBACK
      }
    });
    expect(revokedExchange.statusCode).toBe(401);
    expect(revokedExchange.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/native/token",
      headers: { origin: "capacitor://localhost" },
      payload: {
        code: callback.searchParams.get("code"),
        codeVerifier: verifier,
        redirectUri: CAPACITOR_IOS_CALLBACK
      }
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      error: { code: "NATIVE_AUTHORIZATION_FAILED" }
    });
  });
});

async function buildApp(overrides: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_RUNTIME_MODE: "local",
    AUTH_MODE: "dev",
    AUTH_DEV_LOGIN_ENABLED: "true",
    DEV_TOOLS_ENABLED: "true",
    GOOGLE_CLIENT_ID: "client-id",
    ...overrides
  });
  const auth = new AuthService(
    config,
    new InMemoryAuthStore(),
    new FakeGoogleIdentityVerifier(new Map()),
    { warn: vi.fn() } as never
  );
  const authorization = new NativeAppAuthorization();
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  installAuthGuard(app, config, auth);
  registerAuthRoutes(
    app,
    auth,
    { complete: vi.fn() } as unknown as OnboardingService,
    config,
    { finalizeAccountConnections: vi.fn(async () => undefined) },
    authorization
  );
  registerNativeAppRoutes(app, auth, config, authorization);
  await app.ready();
  return app;
}

function requestCookieHeader(value: string | string[] | undefined): string {
  const lines = Array.isArray(value) ? value : value ? [value] : [];
  return lines
    .map((line) => line.split(";", 1)[0])
    .filter((line): line is string => Boolean(line))
    .join("; ");
}
