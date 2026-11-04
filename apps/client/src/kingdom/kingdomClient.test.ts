import type { KingdomStateSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KingdomApiClient } from "./kingdomClient.js";

describe("KingdomApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads private state with authenticated cookies", async () => {
    const fetchMock = vi.fn<FetchFunction>(async () => response({ state: emptyState() }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KingdomApiClient("https://game.example", "csrf").getState())
      .resolves.toMatchObject({ membership: null, freeConstruction: true });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://game.example/api/kingdom/state");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("loads one privacy-safe public Kingdom by stable ID", async () => {
    const kingdomId = "00000000-0000-4000-8000-000000000010";
    const fetchMock = vi.fn<FetchFunction>(async () => response({
      kingdom: {
        id: kingdomId,
        displayName: "Remote Wardens",
        description: null,
        emblemKey: "sun",
        founderPlayerId: "00000000-0000-4000-8000-000000000001",
        leaderPlayerId: "00000000-0000-4000-8000-000000000001",
        level: 2,
        memberCount: 4,
        status: "active",
        seat: null,
        createdAt: "2026-07-10T00:00:00.000Z"
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KingdomApiClient("https://game.example", "csrf").getPublicKingdom(kingdomId))
      .resolves.toMatchObject({ id: kingdomId, displayName: "Remote Wardens" });
    expect(String(fetchMock.mock.calls[0]?.[0]))
      .toBe(`https://game.example/api/kingdom/${kingdomId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("requests an authoritative founding quote without client coordinates or policy claims", async () => {
    const fetchMock = vi.fn<FetchFunction>(async () => response({
      foundingQuote: {
        requestId: "quote-request",
        position: { lat: 35.1, lon: -106.6 },
        seatPosition: { lat: 35.101, lon: -106.601 },
        territoryRadiusM: 200,
        absorbedFlagCount: 2,
        sourceFlag: {
          id: "00000000-0000-4000-8000-000000000009",
          name: "Home Flag",
          ownerColor: "#38bdf8",
          lat: 35.1,
          lon: -106.6,
          claimRadiusM: 200
        },
        eligible: true,
        disabledReason: null,
        environment: environment(),
        quote: constructionQuote()
      }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new KingdomApiClient("https://game.example", "csrf-token");

    const quote = await api.getFoundingQuote({
      requestId: "quote-request",
      displayName: "Mesa Wardens",
      description: "A social home",
      emblemKey: "sun"
    });

    expect(quote.position).toEqual({ lat: 35.101, lon: -106.601 });
    expect(quote.seatPosition).toEqual({ lat: 35.101, lon: -106.601 });
    expect(quote.absorbedFlagCount).toBe(2);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://game.example/api/kingdom/founding-quote");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-csrf-token": "csrf-token"
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      requestId: "quote-request",
      displayName: "Mesa Wardens",
      description: "A social home",
      emblemKey: "sun"
    });
    expect(body).not.toHaveProperty("lat");
    expect(body).not.toHaveProperty("lon");
    expect(body).not.toHaveProperty("freeConstruction");
    expect(body).not.toHaveProperty("terrainClass");
  });

  it("uses the complete CSRF-protected REST surface for mutations", async () => {
    const fetchMock = vi.fn<FetchFunction>(async () => response({ state: emptyState() }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new KingdomApiClient("https://game.example", "csrf-token");

    await api.found({
      requestId: "found",
      sourceFlagId: "00000000-0000-4000-8000-000000000009",
      displayName: "Mesa Wardens"
    });
    await api.invite("00000000-0000-4000-8000-000000000001", "invite");
    await api.respondToInvitation({ requestId: "respond", invitationId: "00000000-0000-4000-8000-000000000002", response: "accept" });
    await api.cancelInvitation("00000000-0000-4000-8000-000000000002", "cancel");
    await api.memberAction("00000000-0000-4000-8000-000000000003", "promote", "member");
    await api.leave("leave");
    await api.updateIdentity({ requestId: "identity", description: "Updated" });
    await api.muteMember("00000000-0000-4000-8000-000000000003", "mute", null, "mute");
    await api.donate({ requestId: "donate", resourceType: "wood", quantity: 2 });
    await api.placeCot(15, "cot");
    await api.cotAction({ requestId: "cot-action", cotId: "00000000-0000-4000-8000-000000000005", action: "pack" });
    await api.placeDecoration({ requestId: "decoration", typeId: "banner", kingdomOwned: false });
    await api.decorationAction({ requestId: "decoration-action", decorationId: "00000000-0000-4000-8000-000000000004", action: "remove" });
    await api.convertFlag("00000000-0000-4000-8000-000000000006", "flag-convert");
    await api.removeFlag("00000000-0000-4000-8000-000000000006", "42", "flag-remove");
    await api.dissolve("dissolve");

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/kingdom/found",
      "/api/kingdom/invite",
      "/api/kingdom/invitation/respond",
      "/api/kingdom/invitation/cancel",
      "/api/kingdom/member/action",
      "/api/kingdom/leave",
      "/api/kingdom/identity",
      "/api/kingdom/mute",
      "/api/kingdom/donate",
      "/api/kingdom/cot",
      "/api/kingdom/cot/action",
      "/api/kingdom/decoration",
      "/api/kingdom/decoration/action",
      "/api/kingdom/flags/convert",
      "/api/kingdom/flags/remove",
      "/api/kingdom/dissolve"
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: "POST", credentials: "include" });
      expect(init?.headers).toMatchObject({ "x-csrf-token": "csrf-token" });
    }
  });

  it("surfaces stable server error codes for UI rejection guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      error: {
        code: "KINGDOM_TERRITORY_OVERLAP",
        message: "Territory overlaps another Kingdom"
      }
    }, 409)));

    await expect(new KingdomApiClient("https://game.example", "csrf").found({
      displayName: "Mesa Wardens"
    })).rejects.toMatchObject({
      code: "KINGDOM_TERRITORY_OVERLAP",
      status: 409
    });
  });

  it("reuses the original request id for one ambiguous transport retry", async () => {
    const fetchMock = vi.fn<FetchFunction>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(response({ state: emptyState(), replayed: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KingdomApiClient("https://game.example", "csrf").donate({
      requestId: "stable-donation-request",
      resourceType: "wood",
      quantity: 1
    })).resolves.toMatchObject({ replayed: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].requestId).toBe("stable-donation-request");
    expect(bodies[1].requestId).toBe("stable-donation-request");
  });

  it("represents a committed mutation with unavailable state without fabricating a snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      state: null,
      stateRefreshRequired: true,
      replayed: false
    })));
    await expect(new KingdomApiClient("https://game.example", "csrf").donate({
      requestId: "degraded-request",
      resourceType: "wood",
      quantity: 1
    })).resolves.toMatchObject({
      state: null,
      stateRefreshRequired: true,
      replayed: false
    });
  });
});

function emptyState(): KingdomStateSnapshot {
  return {
    spatialRevision: "1",
    membership: null,
    kingdom: null,
    permissions: [],
    roster: [],
    invitations: [],
    chatHistory: [],
    treasury: [],
    donationHistory: null,
    treasuryExpenditureHistory: null,
    progression: null,
    advancementProject: null,
    activityHistory: [],
    cots: [],
    decorations: [],
    decorationCatalog: [],
    nearbyKingdoms: [],
    freeConstruction: true,
    perkQualificationSeconds: 300
  };
}

function constructionQuote() {
  return {
    action: "found" as const,
    freeConstruction: true,
    intendedCost: [{ resourceType: "wood" as const, quantity: 10 }],
    intendedConstructionSeconds: 60,
    adjustedCost: [{ resourceType: "wood" as const, quantity: 8 }],
    adjustedConstructionSeconds: 48,
    modifiers: []
  };
}

function environment() {
  return {
    terrainClass: "plains",
    biome: "grassland",
    ecoregion: "test",
    elevationM: 1_500,
    elevationBand: "high",
    slope: 2,
    slopeBand: "gentle",
    isLand: true,
    isSaltwater: false,
    insideMajorLake: false,
    worldReleaseId: "release-1",
    worldReleaseVersion: "2026.07",
    worldPackageId: "nm",
    environmentSchemaVersion: "1",
    environmentRulesVersion: 1,
    sourceVersions: {},
    lookedUpAt: "2026-07-10T00:00:00.000Z"
  };
}

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}

type FetchFunction = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;
