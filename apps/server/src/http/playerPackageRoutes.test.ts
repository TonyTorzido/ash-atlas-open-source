import cookie from "@fastify/cookie";
import {
  PLAYER_PACKAGE_ADMIN_API_BASE,
  type CreatePlayerPackageCampaignInput
} from "@ash-atlas/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import { installAuthGuard } from "../auth/authGuard.js";
import { AuthError, type AuthenticatedSession } from "../auth/types.js";
import { loadConfig } from "../config.js";
import type { PlayerPackageService } from "../game/playerPackages.js";
import { registerPlayerPackageRoutes } from "./playerPackageRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("player package admin HTTP routes", () => {
  it("registers owner catalog, character-search, and campaign-history GETs at the public admin base", async () => {
    const service = packageService();
    const app = await createApp(service);

    const catalog = await app.inject({
      method: "GET",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`,
      headers: ownerHeaders()
    });
    const exactSearch = await app.inject({
      method: "GET",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/characters?search=Ranger`,
      headers: ownerHeaders()
    });
    const blankPage = await app.inject({
      method: "GET",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/characters?search=&cursor=25`,
      headers: ownerHeaders()
    });
    const history = await app.inject({
      method: "GET",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`,
      headers: ownerHeaders()
    });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ eligibleCharacterCount: 3 });
    expect(exactSearch.statusCode).toBe(200);
    expect(service.searchCharacters).toHaveBeenNthCalledWith(
      1,
      "Ranger",
      25,
      undefined
    );
    expect(blankPage.statusCode).toBe(200);
    expect(service.searchCharacters).toHaveBeenNthCalledWith(2, "", 25, "25");
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ campaigns: [{ title: "Launch package" }] });
    expect((await app.inject({
      method: "GET",
      url: "/api/dev/packages/catalog",
      headers: ownerHeaders()
    })).statusCode).toBe(404);
  });

  it("rejects unauthenticated and ordinary-player catalog access", async () => {
    const service = packageService();
    const app = await createApp(service);

    const unauthenticated = await app.inject({
      method: "GET",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`
    });
    const ordinary = await app.inject({
      method: "GET",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`,
      headers: { cookie: "session=ordinary" }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(ordinary.statusCode).toBe(403);
    expect(service.eligibleCharacterCount).not.toHaveBeenCalled();
  });

  it("requires CSRF and verified owner identity before creating a campaign", async () => {
    const service = packageService();
    const app = await createApp(service);
    const payload = campaignInput();

    const missingCsrf = await app.inject({
      method: "POST",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`,
      headers: {
        cookie: "session=owner",
        origin: "https://playashatlas.com"
      },
      payload
    });
    const created = await app.inject({
      method: "POST",
      url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`,
      headers: {
        ...ownerHeaders(),
        origin: "https://playashatlas.com",
        "x-csrf-token": "owner-csrf"
      },
      payload
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      campaignId: "campaign-1",
      recipientCount: 1,
      replayed: true
    });
    expect(service.createCampaign).toHaveBeenCalledWith({
      subject: "owner-subject",
      playerId: "owner-player"
    }, payload);
  });
});

async function createApp(service: ReturnType<typeof packageService>): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  const auth = authService();
  installAuthGuard(app, loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    AUTH_RUNTIME_MODE: "public",
    GOOGLE_CLIENT_ID: "client-id"
  }), auth);
  registerPlayerPackageRoutes(
    app,
    auth,
    service as unknown as PlayerPackageService,
    { send: vi.fn() } as never,
    { warn: vi.fn() } as never
  );
  await app.ready();
  return app;
}

function authService(): AuthService {
  return {
    sessionCookieName: "session",
    authenticateSession: vi.fn(async (token: string | null) => {
      if (token === "owner") return session("owner-subject", "owner-player", "owner-csrf");
      if (token === "ordinary") return session("ordinary-subject", "ordinary-player", "ordinary-csrf");
      return null;
    }),
    assertOrigin: vi.fn((origin: string | undefined) => {
      if (origin !== "https://playashatlas.com") {
        throw new AuthError("ORIGIN_FORBIDDEN", "Request origin is not allowed", 403);
      }
    }),
    assertCsrf: vi.fn((authenticated: AuthenticatedSession, supplied: string | undefined) => {
      if (authenticated.csrfToken !== supplied) {
        throw new AuthError("CSRF_INVALID", "Invalid CSRF token", 403);
      }
    }),
    requireApprovedTestAccess: vi.fn(),
    requireGameplayReady: vi.fn(),
    authorizeDeveloperCommand: vi.fn(async (authenticated: AuthenticatedSession) => {
      if (authenticated.verifiedGoogleSubject !== "owner-subject") {
        throw new Error("forbidden");
      }
    }),
    recordDeveloperCommandResult: vi.fn(async () => {})
  } as unknown as AuthService;
}

function session(
  subject: string,
  playerId: string,
  csrfToken: string
): AuthenticatedSession {
  return {
    sessionId: `${playerId}-session`,
    verifiedGoogleSubject: subject,
    verifiedEmail: `${playerId}@example.com`,
    account: {
      id: `${playerId}-account`,
      status: "active",
      trustTier: "standard",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date(0),
      testAccessDecidedAt: new Date(0),
      createdAt: new Date(0),
      lastLoginAt: null
    },
    player: {
      id: playerId,
      accountId: `${playerId}-account`,
      displayName: playerId,
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date(0)
    },
    deviceInstallationId: null,
    csrfToken
  };
}

function packageService() {
  return {
    catalog: vi.fn(() => [{
      itemId: "wood",
      displayName: "Wood",
      kind: "resource",
      assetType: "physical",
      category: "material",
      iconKey: "wood",
      stackable: true,
      maxStack: 250,
      supportedVariants: ["default"],
      packageGrantable: true
    }]),
    eligibleCharacterCount: vi.fn(async () => 3),
    searchCharacters: vi.fn(async () => ({
      characters: [{
        playerId: "owner-player",
        displayName: "Ranger",
        identityHint: "r-player",
        online: true
      }],
      nextCursor: null
    })),
    campaignHistory: vi.fn(async () => [{
      campaignId: "campaign-1",
      title: "Launch package",
      targetMode: "specific" as const,
      recipientCount: 1,
      unopenedCount: 1,
      partialCount: 0,
      claimedCount: 0,
      createdAt: new Date(0).toISOString()
    }]),
    createCampaign: vi.fn(async () => ({
      campaignId: "campaign-1",
      recipientCount: 1,
      packageCount: 1,
      replayed: true,
      recipientPlayerIds: ["owner-player"],
      packages: []
    }))
  };
}

function campaignInput(): CreatePlayerPackageCampaignInput {
  return {
    operationKey: "11111111-1111-4111-8111-111111111111",
    targetMode: "specific",
    recipientPlayerIds: ["owner-player"],
    title: "Launch package",
    message: "Welcome",
    items: [{ itemKind: "resource", itemId: "wood", variant: "default", quantity: 1 }]
  };
}

function ownerHeaders(): { cookie: string } {
  return { cookie: "session=owner" };
}
