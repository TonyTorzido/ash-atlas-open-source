import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { registerAccountDeletionRoutes } from "./accountDeletionRoutes.js";
import type { AccountDeletionService } from "./accountDeletionService.js";
import type { AuthService } from "./authService.js";
import type { AccountConnectionCloser } from "./authRoutes.js";
import type { AuthenticatedSession } from "./types.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const session = {
  sessionId: "session-1",
  verifiedEmail: "player@example.com",
  account: { id: "account-1", status: "active" },
  player: null,
  deviceInstallationId: null,
  csrfToken: "csrf-token"
} as unknown as AuthenticatedSession;

function setup(authenticated = true): {
  app: FastifyInstance;
  auth: { assertOrigin: ReturnType<typeof vi.fn>; logoutAll: ReturnType<typeof vi.fn> };
  deletion: {
    requestAuthenticated: ReturnType<typeof vi.fn>;
    requestPublic: ReturnType<typeof vi.fn>;
  };
  connections: { finalizeAccountConnections: ReturnType<typeof vi.fn> };
} {
  const app = Fastify();
  apps.push(app);
  const auth = {
    sessionCookieName: "session",
    assertOrigin: vi.fn(),
    logoutAll: vi.fn(async () => undefined)
  };
  const deletion = {
    requestAuthenticated: vi.fn(async () => ({
      requestId: "request-1",
      status: "pending_processing" as const,
      repeated: false
    })),
    requestPublic: vi.fn(async () => ({
      requestId: "request-2",
      status: "pending_verification" as const,
      repeated: false
    }))
  };
  const connections = { finalizeAccountConnections: vi.fn(async () => undefined) };
  void app.register(cookie);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    if (authenticated && request.routeOptions.url === "/api/account/deletion-request") {
      request.authSession = session;
    }
  });
  registerAccountDeletionRoutes(
    app,
    auth as unknown as AuthService,
    deletion as unknown as AccountDeletionService,
    { NODE_ENV: "development" } as unknown as AppConfig,
    connections as unknown as AccountConnectionCloser
  );
  return { app, auth, deletion, connections };
}

describe("account deletion request routes", () => {
  it("requires the authenticated session and exact confirmation phrase", async () => {
    const unauthenticated = setup(false);
    const denied = await unauthenticated.app.inject({
      method: "POST",
      url: "/api/account/deletion-request",
      headers: { origin: "http://localhost" },
      payload: { confirmation: "DELETE MY ACCOUNT" }
    });
    expect(denied.statusCode).toBe(401);
    expect(unauthenticated.deletion.requestAuthenticated).not.toHaveBeenCalled();

    const authenticated = setup();
    const invalid = await authenticated.app.inject({
      method: "POST",
      url: "/api/account/deletion-request",
      headers: { origin: "http://localhost", "x-csrf-token": "csrf-token" },
      payload: { confirmation: "delete my account" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("DELETION_CONFIRMATION_REQUIRED");
    expect(authenticated.deletion.requestAuthenticated).not.toHaveBeenCalled();
  });

  it("ties an authenticated request to the session, closes connections, and revokes sessions", async () => {
    const { app, auth, deletion, connections } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/account/deletion-request",
      headers: { origin: "http://localhost", "x-csrf-token": "csrf-token" },
      payload: { confirmation: "DELETE MY ACCOUNT" }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      requestId: "request-1",
      status: "pending_processing"
    });
    expect(deletion.requestAuthenticated).toHaveBeenCalledWith({
      accountId: "account-1",
      verifiedEmail: "player@example.com"
    });
    expect(connections.finalizeAccountConnections).toHaveBeenCalledWith(
      "account-1",
      4002,
      "account deletion requested"
    );
    expect(auth.logoutAll).toHaveBeenCalledWith(session);
    expect(response.headers["set-cookie"]).toBeTruthy();
  });

  it("accepts a public email for verification without exposing account existence", async () => {
    const { app, auth, deletion } = setup(false);
    const response = await app.inject({
      method: "POST",
      url: "/api/account/deletion-request/public",
      headers: { origin: "http://localhost" },
      payload: { email: "  stranger@example.com " }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      message: expect.stringContaining("verify ownership")
    });
    expect(response.json().requestId).toBeUndefined();
    expect(response.json().status).toBeUndefined();
    expect(auth.assertOrigin).toHaveBeenCalledWith("http://localhost", false);
    expect(deletion.requestPublic).toHaveBeenCalledWith("stranger@example.com");
  });
});
