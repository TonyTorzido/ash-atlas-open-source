import type {
  DeveloperCapability,
  FlagEnvironmentDetails,
  FlagEnvironmentDiagnostics,
  FlagSnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import type { DevTeleportThroughTravel } from "../http/routes/playerRoutes.js";
import { distanceMeters, resolveTerritoryAtPoint } from "@ash-atlas/shared";
import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import { hasDeveloperCapability } from "../auth/developerAuthorization.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { CityService } from "../game/cities.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import type { FlagService } from "../game/flags.js";
import type { PlayerService } from "../game/players.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import type { WorldMapService } from "../game/worldMap.js";
import type { RepeatableResourceService } from "../game/repeatableResources.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import { WorldRuntime } from "../game/worldRuntime.js";
import { registerRoutes } from "../http/routes.js";
import type { AppLogger } from "../logger.js";
import {
  ConnectionRegistry,
  type SocketLike
} from "../realtime/connectionRegistry.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";

const DEV_PLAYER_SPEED_MPS = 500;
const DEV_FLAG_CLAIM_RADIUS_M = 500;
const DEV_MOVE_LEASH_RADIUS_M = 600;
const OWNED_FLAG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_FLAG_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_FLAG_ID = "33333333-3333-4333-8333-333333333333";

describe("dev flag routes", () => {
  it("prepares a compact quote from authoritative state despite a rendered-coordinate difference", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });
    const player = harness.gameState.getPlayer("player-1")!;
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/flags/placement-quote",
        payload: {
          quoteRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          trigger: "background",
          requestedPosition: {
            lat: player.position.lat + 0.000001,
            lon: player.position.lon - 0.000001
          },
          movementRevision: player.movementRevision,
          relocationRevision: player.relocationRevision ?? 0
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        outcome: "QUOTE_READY",
        placementQuote: { quoteId: "quote-authoritative" },
        authoritativePosition: player.position
      });
      expect(harness.tryCreatePlacementQuote).toHaveBeenCalledOnce();
      expect(harness.richLookup).not.toHaveBeenCalled();
      expect(harness.compactLookup).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("returns structured retryable movement and stale-revision outcomes without rich lookup", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });
    const player = harness.gameState.getPlayer("player-1")!;
    try {
      player.target = { lat: player.position.lat, lon: player.position.lon + 0.01 };
      const moving = await harness.app.inject({
        method: "POST",
        url: "/api/flags/placement-quote",
        payload: {
          quoteRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          trigger: "build",
          movementRevision: player.movementRevision
        }
      });
      expect(moving.json()).toMatchObject({
        outcome: "PLAYER_MOVING",
        retryable: true
      });

      player.target = null;
      const stale = await harness.app.inject({
        method: "POST",
        url: "/api/flags/placement-quote",
        payload: {
          quoteRequestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          trigger: "refresh",
          movementRevision: player.movementRevision + 1
        }
      });
      expect(stale.json()).toMatchObject({
        outcome: "REVISION_STALE",
        retryable: true
      });
      expect(harness.tryCreatePlacementQuote).not.toHaveBeenCalled();
      expect(harness.richLookup).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("preserves a nonretryable territory domain rejection without World data", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      {
        placementQuoteResult: {
          failure: {
            code: "FLAG_PLACEMENT_REJECTED",
            domainCode: "FLAG_PLACEMENT_REJECTED",
            message: "Cannot build here: inside your claimed territory",
            retryable: false,
            failureStage: "territory",
            errorClass: "FlagPlacementError"
          }
        }
      }
    );
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/flags/placement-quote",
        payload: {
          quoteRequestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          trigger: "build"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: false,
        outcome: "FLAG_PLACEMENT_REJECTED",
        placementFailure: {
          code: "FLAG_PLACEMENT_REJECTED",
          retryable: false,
          failureStage: "territory",
          errorClass: "FlagPlacementError"
        }
      });
      expect(response.body).not.toContain("INTERNAL_ERROR");
      expect(harness.richLookup).not.toHaveBeenCalled();
      expect(harness.compactLookup).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("keeps gameplay trace controls owner-only and returns only sanitized bounded events", async () => {
    const owner = createHarness({
      DEV_TOOLS_ENABLED: true,
      RUNTIME_SHA: "a".repeat(40),
      RUNTIME_GENERATION: "test/t993"
    });
    const ordinary = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { developerSubject: null }
    );
    try {
      expect((await ordinary.app.inject({
        method: "POST",
        url: "/api/diagnostics/gameplay-latency-trace/start"
      })).statusCode).toBe(403);

      expect((await owner.app.inject({
        method: "POST",
        url: "/api/diagnostics/gameplay-latency-trace/start"
      })).json()).toMatchObject({ active: true });
      const posted = await owner.app.inject({
        method: "POST",
        url: "/api/diagnostics/gameplay-latency-trace/events",
        payload: {
          events: [{
            source: "client",
            category: "flag-preparation",
            name: "quote_response_received",
            wallTimeIso: new Date().toISOString(),
            monotonicMs: 12,
            details: {
              outcome: "QUOTE_READY",
              email: "private@example.test",
              oauthToken: "secret"
            }
          }]
        }
      });
      expect(posted.statusCode).toBe(200);
      const serialized = JSON.stringify(posted.json());
      expect(serialized).toContain("QUOTE_READY");
      expect(serialized).not.toContain("private@example.test");
      expect(serialized).not.toContain("secret");
    } finally {
      await owner.app.close();
      await ordinary.app.close();
    }
  });

  it("does not expose obsolete sampled placement-surface routes", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/world/flag-placement-surface",
        payload: { cells: [] }
      });
      expect(response.statusCode).toBe(404);
      const coastLakeResponse = await harness.app.inject({
        method: "POST",
        url: "/api/world/coast-lake-placement-surface",
        payload: { cells: [] }
      });
      expect(coastLakeResponse.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  });

  it("serves comprehensive flag details lazily and returns 404 for missing flags", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/flags/${OWNED_FLAG_ID}/environment`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        identity: { flagId: OWNED_FLAG_ID, ownerName: "Ash" },
        ecology: { ecoregionId: "651", resolution: "nearest_land_fallback" },
        water: { supportingRiver: { id: "20287927" } },
        provenance: { snapshotStatus: "current" }
      });
      const missing = await harness.app.inject({
        method: "GET",
        url: `/api/flags/${MISSING_FLAG_ID}/environment`
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await harness.app.close();
    }
  });

  it.each([
    [{ legacy: true }, "legacy"],
    [null, "unavailable"],
    [{}, "unavailable"]
  ] as const)("returns HTTP 200 for legacy or unavailable snapshot %#", async (snapshot, status) => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: false },
      { environmentSnapshot: snapshot }
    );

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/flags/${OWNED_FLAG_ID}/environment`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        provenance: { snapshotStatus: status },
        rawSnapshot: snapshot
      });
    } finally {
      await harness.app.close();
    }
  });

  it("runs a dev-only bounded environment refresh and broadcasts only FlagSnapshot fields", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/flags/environment/refresh",
        payload: { flagId: OWNED_FLAG_ID }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        requested: 1,
        refreshed: 1,
        refreshedFlagIds: [OWNED_FLAG_ID],
        failures: [],
        truncated: false
      });
      expect(harness.refreshCalls()).toEqual([OWNED_FLAG_ID]);
      expect(harness.broadcasts).toHaveLength(1);
      const broadcast = harness.broadcasts[0] as Extract<ServerMessage, { type: "FLAG_UPDATED" }>;
      expect(broadcast.type).toBe("FLAG_UPDATED");
      expect(broadcast.flag).not.toHaveProperty("environmentSnapshot");
      expect(broadcast.flag).not.toHaveProperty("rawSnapshot");
    } finally {
      await harness.app.close();
    }
  });

  it("protects diagnostics and returns stored and live views without refreshing", async () => {
    const disabled = createHarness({ DEV_TOOLS_ENABLED: false });
    try {
      const forbidden = await disabled.app.inject({
        method: "GET",
        url: `/api/dev/flags/${OWNED_FLAG_ID}/environment-diagnostics`
      });
      expect(forbidden.statusCode).toBe(403);
      expect(disabled.diagnosticCalls()).toEqual([]);
    } finally {
      await disabled.app.close();
    }

    const enabled = createHarness({ DEV_TOOLS_ENABLED: true });
    try {
      const response = await enabled.app.inject({
        method: "GET",
        url: `/api/dev/flags/${OWNED_FLAG_ID}/environment-diagnostics`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        stored: { identity: { flagId: OWNED_FLAG_ID } },
        live: { details: { provenance: { snapshotStatus: "current" } } },
        refreshRecommended: false
      });
      expect(enabled.diagnosticCalls()).toEqual([OWNED_FLAG_ID]);
      expect(enabled.refreshCalls()).toEqual([]);

      const missing = await enabled.app.inject({
        method: "GET",
        url: `/api/dev/flags/${MISSING_FLAG_ID}/environment-diagnostics`
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await enabled.app.close();
    }
  });

  it("supports bounded refresh of only legacy or incomplete snapshots", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/flags/environment/refresh",
        payload: { all: true, onlyNeedsRefresh: true, limit: 25 }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, requested: 1, refreshed: 1 });
      expect(harness.eligibleRefreshLimits()).toEqual([25]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects environment refresh when dev tools are disabled", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/flags/environment/refresh",
        payload: { all: true, limit: 10 }
      });
      expect(response.statusCode).toBe(403);
      expect(harness.refreshCalls()).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("clears flags and broadcasts revisioned deletions when dev tools are enabled", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "DELETE",
        url: "/api/dev/flags"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        deletedCount: 3
      });
      expect(harness.clearCalls()).toBe(1);
      expect(harness.legendaryDespawns()).toEqual(["legendary-clear-entity"]);
      expect(harness.broadcasts).toEqual([
        { type: "FLAG_DELETED", flagId: OWNED_FLAG_ID },
        { type: "FLAG_DELETED", flagId: OTHER_FLAG_ID },
        {
          type: "FLAG_DELETED",
          flagId: "33333333-3333-4333-8333-333333333333"
        }
      ]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects flag clearing when dev tools are disabled", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "DELETE",
        url: "/api/dev/flags"
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: {
          code: "DEVELOPER_COMMAND_FORBIDDEN"
        }
      });
      expect(harness.clearCalls()).toBe(0);
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
});

describe("permanent mine developer routes", () => {
  it("rejects every crafted HTTP developer route for an ordinary authenticated player", async () => {
    const harness = createHarness(
      {
        DEV_TOOLS_ENABLED: true,
        DEV_ADMIN_TOOLS_ENABLED: true
      },
      {
        collectibles: createCollectiblesStub(),
        repeatableResources: {
          listDeveloperMines: vi.fn(async () => ({ mines: [], total: 0, page: 1, limit: 50 }))
        } as unknown as RepeatableResourceService,
        developerSubject: "ordinary-subject"
      }
    );
    const requests = [
      { method: "GET", url: "/api/dev/flags/count" },
      { method: "GET", url: "/api/dev/diagnostics/database" },
      { method: "GET", url: "/api/dev/permanent-mines" },
      { method: "DELETE", url: "/api/dev/flags" },
      {
        method: "POST",
        url: "/api/dev/flags/environment/refresh",
        payload: { flagId: OWNED_FLAG_ID }
      },
      {
        method: "GET",
        url: `/api/dev/flags/${OWNED_FLAG_ID}/environment-diagnostics`
      },
      { method: "GET", url: "/api/dev/spawns/count" },
      {
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: { playerId: "player-1", lat: 35.0843, lon: -106.6205 }
      }
    ] as const;

    try {
      for (const request of requests) {
        const response = await harness.app.inject(request);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          ok: false,
          error: {
            code: "DEVELOPER_COMMAND_FORBIDDEN",
            message: "Developer command is unavailable"
          }
        });
      }
      expect(harness.clearCalls()).toBe(0);
      expect(harness.refreshCalls()).toEqual([]);
      expect(harness.broadcasts).toEqual([]);
      expect(harness.developerAudit).toHaveLength(requests.length);
      expect(harness.developerAudit.every((event) => event.outcome === "rejected")).toBe(true);
    } finally {
      await harness.app.close();
    }
  });

  it("lists only through the authenticated development-admin gate and forwards bounded filters", async () => {
    const listDeveloperMines = vi.fn(async () => ({ mines: [], total: 0, page: 2, limit: 10 }));
    const repeatableResources = { listDeveloperMines } as unknown as RepeatableResourceService;
    const enabled = {
      NODE_ENV: "development" as const,
      DEV_TOOLS_ENABLED: true,
      DEV_ADMIN_TOOLS_ENABLED: true,
      AUTH_MODE: "dev" as const,
      AUTH_DEV_LOGIN_ENABLED: true
    };
    const unauthorized = createHarness(
      enabled,
      { repeatableResources, authenticatedRequests: false }
    );
    const ordinaryPlayer = createHarness(
      enabled,
      { repeatableResources, developerSubject: "ordinary-subject" }
    );
    const authorized = createHarness(enabled, { repeatableResources });
    try {
      expect((await unauthorized.app.inject({ method: "GET", url: "/api/dev/permanent-mines" })).statusCode).toBe(403);
      expect((await ordinaryPlayer.app.inject({ method: "GET", url: "/api/dev/permanent-mines" })).statusCode).toBe(403);
      const response = await authorized.app.inject({
        method: "GET",
        url: "/api/dev/permanent-mines?state=depleted&page=2&limit=10&search=NM"
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ mines: [], total: 0, page: 2, limit: 10 });
      expect(listDeveloperMines).toHaveBeenCalledTimes(1);
      expect(listDeveloperMines).toHaveBeenCalledWith({ state: "depleted", page: 2, limit: 10, search: "NM" });
    } finally {
      await unauthorized.app.close();
      await ordinaryPlayer.app.close();
      await authorized.app.close();
    }
  });
});

describe("database developer diagnostics", () => {
  it("returns pool metrics only through developer authorization", async () => {
    const metrics = {
      configuration: { max: 10 },
      connections: { total: 3, idle: 2, waiting: 0 }
    };
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { databaseMetrics: () => metrics }
    );
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/dev/diagnostics/database"
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(metrics);
    } finally {
      await harness.app.close();
    }
  });
});

describe("dev spawn routes", () => {
  it("counts ambient spawn cells and node states when dev tools are enabled", async () => {
    const collectibles = createCollectiblesStub();
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      {
        collectibles
      }
    );

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/dev/spawns/count"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        spawnCellCount: 12,
        availableNodeCount: 7,
        harvestedNodeCount: 3,
        resourceVisionStatusCounts: {
          pending: 0,
          generating: 0,
          ready: 2,
          failed: 1
        }
      });
      expect(collectibles.countSpawns).toHaveBeenCalledOnce();
    } finally {
      await harness.app.close();
    }
  });

});

describe("collectible listing routes", () => {
  it("keeps survey route list-only for existing nearby nodes", async () => {
    const collectibles = createCollectiblesStub();
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      {
        collectibles
      }
    );

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/collectibles/survey",
        payload: {
          playerId: "player-1"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        nodes: [],
        resourceVision: null,
        resourceVisionStatus: null,
        generatedCells: 0,
        generatedNodes: 0
      });
      expect(collectibles.listAvailableInVision).toHaveBeenCalledOnce();
      expect(collectibles.listAvailableInVision).toHaveBeenCalledWith(
        "world_v1_lat35_lon-107",
        null
      );
    } finally {
      await harness.app.close();
    }
  });

  it("keeps nearby collectible refresh read-only", async () => {
    const collectibles = createCollectiblesStub();
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      {
        collectibles
      }
    );

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/collectibles/nearby?playerId=player-1"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        nodes: [],
        resourceVision: null,
        resourceVisionStatus: null
      });
      expect(collectibles.listAvailableInVision).toHaveBeenCalledOnce();
      expect(collectibles.listAvailableInVision).toHaveBeenCalledWith(
        "world_v1_lat35_lon-107",
        null
      );
    } finally {
      await harness.app.close();
    }
  });

  it("rejects the legacy direct-pickup endpoint", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { collectibles: createCollectiblesStub() }
    );

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/collectibles/pickup",
        payload: {
          playerId: "player-1",
          nodeId: "node-1"
        }
      });

      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({
        ok: false,
        error: { code: "HARVEST_SESSION_REQUIRED" }
      });
    } finally {
      await harness.app.close();
    }
  });
});

describe("flag creation resource prewarm", () => {
  it("queues Resource Vision prewarm after creating a flag", async () => {
    const resourceVisionJobs = {
      ensureQueued: vi.fn(async () => ({
        queued: true,
        status: null,
        resourceVision: null
      }))
    } as unknown as ResourceVisionJobQueue;
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      {
        collectibles: createCollectiblesStub(),
        resourceVisionJobs
      }
    );

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/flags",
        payload: {
          ownerId: "player-1",
          name: "Warm Flag"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(resourceVisionJobs.ensureQueued).toHaveBeenCalledWith(
        expect.objectContaining({
          flag: expect.objectContaining({
            name: "Warm Flag"
          }),
          regionCode: "world_v1_lat35_lon-107",
          movementLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
          reason: "flag-created"
        })
      );
    } finally {
      await harness.app.close();
    }
  });
});

describe("strategic anchor vision", () => {
  it("loads intersecting flag claims, cities, and own landmarks from the authenticated player's anchor", async () => {
    const cities = {
      listCitiesNear: vi.fn(async () => [])
    } as unknown as Pick<CityService, "listCitiesNear">;
    const worldMap = {
      strategicLandmarks: vi.fn(async () => [{
        kind: "manor" as const,
        id: "manor-1",
        name: "Your Manor",
        lat: 36,
        lon: -105
      }])
    } as unknown as Pick<WorldMapService, "strategicLandmarks">;
    const harness = createHarness({}, { cities, worldMap });
    const center = harness.gameState.getPlayer("player-1")!.anchor;
    const pointNorthAt = (distanceM: number) => ({
      lat: center.lat + distanceM / 6_371_008.8 * 180 / Math.PI,
      lon: center.lon
    });
    Object.assign(
      harness.getFlag(OWNED_FLAG_ID)!,
      pointNorthAt(2_999.9)
    );
    Object.assign(
      harness.getFlag(OTHER_FLAG_ID)!,
      pointNorthAt(3_000.1)
    );

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/map/strategic-vision"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        authority: {
          center: harness.gameState.getPlayer("player-1")!.anchor,
          radiusM: 3_000
        },
        flags: expect.arrayContaining([
          expect.objectContaining({ id: OWNED_FLAG_ID })
        ]),
        cities: [],
        landmarks: [expect.objectContaining({ kind: "manor", id: "manor-1" })],
        complete: true
      });
      expect(response.json().flags.map((flag: FlagSnapshot) => flag.id))
        .toContain(OTHER_FLAG_ID);
      const legacyResponse = await harness.app.inject({
        method: "GET",
        url: "/api/flags?limit=1000"
      });
      expect(legacyResponse.statusCode).toBe(200);
      expect(legacyResponse.json().flags.map((flag: FlagSnapshot) => flag.id))
        .toEqual([OWNED_FLAG_ID, OTHER_FLAG_ID]);
      expect(cities.listCitiesNear).toHaveBeenCalledWith(
        harness.gameState.getPlayer("player-1")!.anchor,
        3_000,
        1_000
      );
      expect(worldMap.strategicLandmarks).toHaveBeenCalledWith("player-1");
    } finally {
      await harness.app.close();
    }
  });

  it("rejects unauthenticated strategic and legacy flag enumeration", async () => {
    const cities = {
      listCitiesNear: vi.fn(async () => [])
    } as unknown as Pick<CityService, "listCitiesNear">;
    const worldMap = {
      strategicLandmarks: vi.fn(async () => [])
    } as unknown as Pick<WorldMapService, "strategicLandmarks">;
    const harness = createHarness({}, {
      authenticatedRequests: false,
      cities,
      worldMap
    });

    try {
      const [strategic, legacy] = await Promise.all([
        harness.app.inject({ method: "GET", url: "/api/map/strategic-vision" }),
        harness.app.inject({ method: "GET", url: "/api/flags" })
      ]);
      expect(strategic.statusCode).toBe(401);
      expect(legacy.statusCode).toBe(401);
      expect(cities.listCitiesNear).not.toHaveBeenCalled();
      expect(worldMap.strategicLandmarks).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });
});

describe("dev player teleport route", () => {
  it("rejects teleport when dev tools are disabled", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: {
          playerId: "player-1",
          lat: 35.0843,
          lon: -106.6205
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: {
          code: "DEVELOPER_COMMAND_FORBIDDEN"
        }
      });
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects invalid or uncovered global teleport coordinates", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const invalid = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: {
          playerId: "player-1",
          lat: "bad",
          lon: -106.6205
        }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          message: "Cannot teleport outside authoritative world coverage"
        }
      });

      harness.setWorldCovered(false);
      const outside = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: {
          playerId: "player-1",
          lat: 35.0843,
          lon: -106.6205
        }
      });
      expect(outside.statusCode).toBe(400);
      expect(outside.json()).toMatchObject({
        error: {
          code: "TELEPORT_REJECTED",
          message: "Cannot teleport outside authoritative world coverage"
        }
      });
    } finally {
      await harness.app.close();
    }
  });

  it("teleports a connected player and lets bounded world deltas replicate the change", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });
    harness.gameState.setTarget("player-1", { lat: 35.0845, lon: -106.6502 });

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: {
          playerId: "player-1",
          lat: 35.0843,
          lon: -106.6205
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload).toMatchObject({
        ok: true,
        player: {
          playerId: "player-1",
          lat: 35.0843,
          lon: -106.6205,
          anchorLat: 35.0843,
          anchorLon: -106.6205,
          targetLat: null,
          targetLon: null,
          moving: false
        }
      });
      expect(harness.gameState.getPlayer("player-1")?.target).toBeNull();
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("schedules population v2 relocation after the teleported player is persisted", async () => {
    const schedulePopulationV2Relocation = vi.fn();
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { schedulePopulationV2Relocation }
    );

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: {
          playerId: "player-1",
          lat: 35.0843,
          lon: -106.6205
        }
      });

      expect(response.statusCode).toBe(200);
      expect(schedulePopulationV2Relocation).toHaveBeenCalledOnce();
      expect(schedulePopulationV2Relocation).toHaveBeenCalledWith("player-1");
      expect(
        vi.mocked(harness.persistPlayerSnapshot).mock.invocationCallOrder[0]
      ).toBeLessThan(schedulePopulationV2Relocation.mock.invocationCallOrder[0]!);
    } finally {
      await harness.app.close();
    }
  });;

  it("grants an area resource vision centred on the arrival, so harvesting is not outside vision", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });
    const destination = { lat: 35.0843, lon: -106.6205 };

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: { playerId: "player-1", ...destination }
      });

      expect(response.statusCode).toBe(200);
      const vision = harness.gameState.getResourceVision("player-1");
      expect(vision).not.toBeNull();
      expect(vision).toMatchObject({ destinationKind: "area", center: destination });
      expect(vision!.radiusM).toBeGreaterThan(0);
    } finally {
      await harness.app.close();
    }
  });

  it("routes a connected teleport through the real travel path", async () => {
    const devTeleport = vi.fn(async () => ({ success: true as const }));
    const schedulePopulationV2Relocation = vi.fn();
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { withWorldRuntime: true, devTeleport, schedulePopulationV2Relocation }
    );
    const destination = { lat: 35.0843, lon: -106.6205 };

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: { playerId: "player-1", ...destination }
      });

      expect(response.statusCode).toBe(200);
      expect(devTeleport).toHaveBeenCalledWith("player-1", expect.any(String), destination);
      expect(schedulePopulationV2Relocation).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("orders an active-runtime teleport before movement issued while the route is pending", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { withWorldRuntime: true }
    );
    const destination = { lat: 35.0843, lon: -106.6205 };
    const laterTarget = { lat: 35.0843, lon: -106.6195 };

    try {
      const responsePromise = harness.app.inject({
        method: "POST",
        url: "/api/dev/player/teleport",
        payload: {
          playerId: "player-1",
          ...destination
        }
      });
      await vi.waitFor(() => {
        expect(harness.worldRuntime?.commands.metricsSnapshot().depth).toBe(1);
      });
      harness.worldRuntime!.enqueue({
        kind: "move",
        playerId: "player-1",
        accountId: "account-player-1",
        connectionId: harness.connectionId!,
        requestId: "move-after-dev-teleport",
        target: laterTarget
      });

      harness.worldRuntime!.tick(0);
      const response = await responsePromise;

      expect(response.statusCode).toBe(200);
      expect(harness.gameState.getPlayer("player-1")).toMatchObject({
        position: destination,
        anchor: destination,
        target: laterTarget
      });
    } finally {
      await harness.app.close();
    }
  });
});

describe("player presence routes", () => {
  it("returns the aggregate online player count", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/players/online"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        count: 1,
        revision: 0,
        observedAt: expect.any(String)
      });
    } finally {
      await harness.app.close();
    }
  });

  it("returns a player by id", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/players/player-1"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        player: {
          playerId: "player-1",
          username: "Ash",
          regionCode: "world_v1_lat35_lon-107",
          online: true
        }
      });
    } finally {
      await harness.app.close();
    }
  });

  it("redacts exact coordinates and movement anchors from unrelated authenticated accounts", async () => {
    const harness = createHarness(
      { NODE_ENV: "production", DEV_TOOLS_ENABLED: false },
      { authenticatedRequests: true }
    );
    const asPlayer = (playerId: string) => ({ "x-test-player-id": playerId });

    try {
      const unrelated = await harness.app.inject({
        method: "GET",
        url: "/api/players/player-1",
        headers: asPlayer("player-2")
      });
      expect(unrelated.statusCode).toBe(200);
      expect(unrelated.json()).toMatchObject({
        player: {
          playerId: "player-1",
          username: "Ash",
          regionCode: "world_v1_lat35_lon-107"
        }
      });
      for (const field of [
        "lat", "lon", "anchorLat", "anchorLon", "moveLeashRadiusM",
        "targetLat", "targetLon", "moving"
      ]) {
        expect(unrelated.json().player).not.toHaveProperty(field);
      }

      const own = await harness.app.inject({
        method: "GET",
        url: "/api/players/player-1",
        headers: asPlayer("player-1")
      });
      expect(own.json().player).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });

      const online = await harness.app.inject({
        method: "GET",
        url: "/api/players/online",
        headers: asPlayer("player-2")
      });
      expect(online.json()).toEqual({
        count: 1,
        revision: 0,
        observedAt: expect.any(String)
      });
      expect(online.json()).not.toHaveProperty("players");
    } finally {
      await harness.app.close();
    }
  });
});

describe("player color route", () => {
  it("updates a player's flag color and leaves player replication to world deltas", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: "/api/players/player-1/color",
        payload: {
          playerId: "player-1",
          color: "#3366cc"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        player: {
          playerId: "player-1",
          displayColor: "#3366cc"
        }
      });
      expect(harness.gameState.snapshotForPlayer("player-1").displayColor).toBe("#3366cc");
      expect(harness.broadcasts).toEqual([
        expect.objectContaining({
          type: "FLAG_UPDATED"
        })
      ]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects invalid player flag colors", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: "/api/players/player-1/color",
        payload: {
          playerId: "player-1",
          color: "blue"
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "BAD_PLAYER_COLOR"
        }
      });
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects updating another player's color when dev tools are disabled", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: "/api/players/player-2/color",
        payload: {
          playerId: "player-1",
          color: "#3366cc"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: {
          code: "DEVELOPER_COMMAND_FORBIDDEN"
        }
      });
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
});

describe("territory resolve route", () => {
  it("returns open land", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/territory/resolve?lat=35.2&lon=-106.6504"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        claimed: false,
        ownerPlayerId: null
      });
    } finally {
      await harness.app.close();
    }
  });

  it("returns claimed land with owner metadata", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/territory/resolve?lat=35.0844&lon=-106.6504"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        claimed: true,
        ownerPlayerId: "player-1",
        ownerUsername: "Ash",
        ownerColor: "#38bdf8",
        nearestFlagId: OWNED_FLAG_ID
      });
    } finally {
      await harness.app.close();
    }
  });

  it("validates bad lat/lon", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/territory/resolve?lat=bad&lon=-106.6504"
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "BAD_TERRITORY_QUERY"
        }
      });
    } finally {
      await harness.app.close();
    }
  });
});

describe("flag delete route", () => {
  it("deletes an existing owned flag and broadcasts the deletion", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "DELETE",
        url: `/api/flags/${OWNED_FLAG_ID}?playerId=player-1`,
        payload: { requestId: "00000000-0000-4000-8000-000000000901" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        flagId: OWNED_FLAG_ID,
        replayed: false,
        inventory: null,
        droppedItems: []
      });
      expect(harness.hasFlag(OWNED_FLAG_ID)).toBe(false);
      expect(harness.broadcasts).toEqual([
        {
          type: "FLAG_DELETED",
          flagId: OWNED_FLAG_ID
        }
      ]);
    } finally {
      await harness.app.close();
    }
  });

  it("returns 404 when deleting a missing flag", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "DELETE",
        url: `/api/flags/${MISSING_FLAG_ID}?playerId=player-1`,
        payload: { requestId: "00000000-0000-4000-8000-000000000902" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        ok: false,
        error: {
          code: "FLAG_NOT_FOUND"
        }
      });
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects deleting someone else's flag when dev tools are disabled", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: false });

    try {
      const response = await harness.app.inject({
        method: "DELETE",
        url: `/api/flags/${OTHER_FLAG_ID}?playerId=player-1`,
        payload: { requestId: "00000000-0000-4000-8000-000000000903" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: {
          code: "DEVELOPER_COMMAND_FORBIDDEN"
        }
      });
      expect(harness.hasFlag(OTHER_FLAG_ID)).toBe(true);
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("allows deleting someone else's flag in dev mode", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });

    try {
      const response = await harness.app.inject({
        method: "DELETE",
        url: `/api/flags/${OTHER_FLAG_ID}?playerId=player-1`,
        payload: { requestId: "00000000-0000-4000-8000-000000000904" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        flagId: OTHER_FLAG_ID,
        replayed: false,
        inventory: null,
        droppedItems: []
      });
      expect(harness.hasFlag(OTHER_FLAG_ID)).toBe(false);
      expect(harness.broadcasts).toEqual([
        {
          type: "FLAG_DELETED",
          flagId: OTHER_FLAG_ID
        }
      ]);
    } finally {
      await harness.app.close();
    }
  });
});

describe("flag rename route", () => {
  it("renames an existing owned flag and broadcasts the update", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: false },
      { atlasShrineFlagIds: [OWNED_FLAG_ID] }
    );

    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: `/api/flags/${OWNED_FLAG_ID}`,
        payload: {
          playerId: "player-1",
          name: "  Renamed   Base  "
        }
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload).toMatchObject({
        ok: true,
        flag: {
          id: OWNED_FLAG_ID,
          name: "Renamed   Base"
        }
      });
      expect(harness.getFlag(OWNED_FLAG_ID)?.name).toBe("Renamed   Base");
      expect(harness.broadcasts).toEqual([
        {
          type: "FLAG_UPDATED",
          flag: expect.objectContaining({
            id: OWNED_FLAG_ID,
            name: "Renamed   Base"
          })
        }
      ]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects renaming an owned ordinary flag", async () => {
    const harness = createHarness({ DEV_TOOLS_ENABLED: true });
    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: `/api/flags/${OWNED_FLAG_ID}`,
        payload: { playerId: "player-1", name: "Ordinary Rename" }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "KINGDOM_PERMISSION_DENIED" }
      });
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("resets a blank shrine name and rejects names over 15 characters", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { atlasShrineFlagIds: [OWNED_FLAG_ID] }
    );

    try {
      const empty = await harness.app.inject({
        method: "PATCH",
        url: `/api/flags/${OWNED_FLAG_ID}`,
        payload: {
          playerId: "player-1",
          name: "   "
        }
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({
        flag: { name: "Atlas Shrine 1", atlasShrineSlotNumber: 1 }
      });

      const tooLong = await harness.app.inject({
        method: "PATCH",
        url: `/api/flags/${OWNED_FLAG_ID}`,
        payload: {
          playerId: "player-1",
          name: "x".repeat(16)
        }
      });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json()).toMatchObject({
        error: {
          code: "BAD_FLAG_RENAME_BODY"
        }
      });
      expect(harness.getFlag(OWNED_FLAG_ID)?.name).toBe("Atlas Shrine 1");
      expect(harness.broadcasts).toHaveLength(1);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects renaming someone else's Atlas Shrine when dev tools are disabled", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: false },
      { atlasShrineFlagIds: [OTHER_FLAG_ID] }
    );

    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: `/api/flags/${OTHER_FLAG_ID}`,
        payload: {
          playerId: "player-1",
          name: "Nope"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: {
          code: "KINGDOM_PERMISSION_DENIED"
        }
      });
      expect(harness.getFlag(OTHER_FLAG_ID)?.name).toBe("Test Flag");
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it("does not let developer override rename someone else's Atlas Shrine", async () => {
    const harness = createHarness(
      { DEV_TOOLS_ENABLED: true },
      { atlasShrineFlagIds: [OTHER_FLAG_ID] }
    );

    try {
      const response = await harness.app.inject({
        method: "PATCH",
        url: `/api/flags/${OTHER_FLAG_ID}`,
        payload: {
          playerId: "player-1",
          name: "Dev Rename"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: {
          code: "KINGDOM_PERMISSION_DENIED"
        }
      });
      expect(harness.getFlag(OTHER_FLAG_ID)?.name).toBe("Test Flag");
      expect(harness.broadcasts).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
});

function createHarness(
  overrides: Partial<AppConfig>,
  options: {
    collectibles?: CollectibleService;
    resourceVisionJobs?: ResourceVisionJobQueue;
    withWorldRuntime?: boolean;
    environmentSnapshot?: unknown;
    authenticatedRequests?: boolean;
    developerSubject?: string | null;
    repeatableResources?: RepeatableResourceService;
    placementQuoteResult?: Record<string, unknown>;
    schedulePopulationV2Relocation?: (playerId: string) => void;
    devTeleport?: DevTeleportThroughTravel;
    databaseMetrics?: () => unknown;
    atlasShrineFlagIds?: readonly string[];
    cities?: Pick<CityService, "listCitiesNear">;
    worldMap?: Pick<WorldMapService, "strategicLandmarks">;
  } = {}
) {
  const config = createConfig(overrides);
  const app = Fastify({ logger: false });
  const developerAudit: Array<{
    capability: DeveloperCapability;
    command: string;
    outcome: "authorized" | "rejected" | "succeeded" | "failed";
  }> = [];
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    if (options.authenticatedRequests === false) {
      request.authSession = null;
      return;
    }
      const playerId = String(request.headers["x-test-player-id"] ?? "player-1");
      request.authSession = {
        sessionId: `session-${playerId}`,
        verifiedEmail: "owner@example.com",
        account: {
          id: `account-${playerId}`,
          status: "active",
          trustTier: "new",
          riskScore: 0,
          testAccessStatus: "approved",
          testAccessRequestedAt: new Date(),
          testAccessDecidedAt: new Date(),
          createdAt: new Date(),
          lastLoginAt: null
        },
        player: {
          id: playerId,
          accountId: `account-${playerId}`,
          displayName: playerId,
          personalFlagColor: "blue",
          onboardingCompletedAt: new Date()
        },
        deviceInstallationId: `device-${playerId}`,
        csrfToken: "csrf",
        verifiedGoogleSubject: options.developerSubject === undefined
          ? "owner-subject"
          : options.developerSubject
      };
  });
  const auth = {
    hasDeveloperCapability: (
      session: AuthenticatedSession | null,
      capability: DeveloperCapability
    ) => hasDeveloperCapability(config, session, capability),
    authorizeDeveloperCommand: async (
      session: AuthenticatedSession | null,
      input: Parameters<AuthService["authorizeDeveloperCommand"]>[1]
    ) => {
      const outcome = hasDeveloperCapability(config, session, input.capability)
        ? "authorized"
        : "rejected";
      developerAudit.push({
        capability: input.capability,
        command: input.command,
        outcome
      });
      if (outcome === "rejected") {
        throw new Error("developer command forbidden");
      }
    },
    recordDeveloperCommandResult: async (
      _session: AuthenticatedSession,
      input: Parameters<AuthService["recordDeveloperCommandResult"]>[1]
    ) => {
      developerAudit.push({
        capability: input.capability,
        command: input.command,
        outcome: input.outcome
      });
    }
  } as unknown as AuthService;
  let clearCallCount = 0;
  const legendaryDespawns: string[] = [];
  const refreshCallIds: string[] = [];
  const diagnosticCallIds: string[] = [];
  const eligibleRefreshLimitValues: number[] = [];
  let worldCovered = true;
  const broadcasts: ServerMessage[] = [];
  const atlasShrineFlagIds = new Set(options.atlasShrineFlagIds ?? []);
  const flagRecords = new Map<string, FlagSnapshot>([
    [OWNED_FLAG_ID, withOptionalAtlasShrine(
      createFlag(OWNED_FLAG_ID, "player-1"),
      atlasShrineFlagIds.has(OWNED_FLAG_ID)
    )],
    [OTHER_FLAG_ID, withOptionalAtlasShrine(
      createFlag(OTHER_FLAG_ID, "player-2"),
      atlasShrineFlagIds.has(OTHER_FLAG_ID)
    )]
  ]);
  const flags = {
    countFlags: vi.fn(async () => 3),
    clearFlags: vi.fn(async () => {
      clearCallCount += 1;
      flagRecords.clear();
      return {
        deletedFlagIds: [
          OWNED_FLAG_ID,
          OTHER_FLAG_ID,
          "33333333-3333-4333-8333-333333333333"
        ],
        legendaryCombatEntityIds: ["legendary-clear-entity"]
      };
    }),
    listFlags: vi.fn(async () => [...flagRecords.values()]),
    streamFlagSnapshot: vi.fn(async (
      onChunk: Parameters<FlagService["streamFlagSnapshot"]>[0],
      _pageSize?: number,
      scope?: Parameters<FlagService["streamFlagSnapshot"]>[2]
    ) => {
      const chunkFlags = [...flagRecords.values()].filter((flag) =>
        !scope || distanceMeters(scope.center, flag) <= scope.radiusM + flag.claimRadiusM
      );
      await onChunk({
        flags: chunkFlags,
        flagSetRevision: 1,
        chunkIndex: 0,
        finalChunk: true
      });
      return {
        flagSetRevision: 1,
        chunksPublished: 1,
        flagsPublished: chunkFlags.length,
        completed: true
      };
    }),
    listFlagsForOwner: vi.fn(async (ownerId: string) =>
      [...flagRecords.values()].filter((flag) => flag.ownerId === ownerId)
    ),
    tryCreatePlacementQuote: vi.fn(async (player: PlayerRecord) =>
      options.placementQuoteResult ?? ({
      world: {
        ok: true,
        packageId: "nm-core",
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        flagPlacementWater: {
          blocked: false,
          kind: "land",
          sourceId: null,
          sourceName: null,
          distanceM: null,
          corridorRadiusM: null,
          reason: "authoritative land",
          releaseId: "world-packages-v1",
          resolution: "water-placement-surface-v1"
        },
        worldReleaseId: "world-packages-v1",
        raw: {}
      },
      placementQuote: {
        quoteId: "quote-authoritative",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        position: { ...player.position }
      }
      })),
    createForPlayer: vi.fn(async (player: PlayerRecord, name?: string) => {
      const flag = {
        ...createFlag("44444444-4444-4444-8444-444444444444", player.playerId),
        name: name ?? "New Flag",
        lat: player.position.lat,
        lon: player.position.lon
      };
      flagRecords.set(flag.id, flag);
      return { flag };
    }),
    resolveTerritoryAtPoint: vi.fn(async (lat: number, lon: number) =>
      resolveTerritoryAtPoint({
        lat,
        lon,
        flags: [...flagRecords.values()]
      })
    ),
    getFlag: vi.fn(async (flagId: string) => flagRecords.get(flagId) ?? null),
    getMapFlag: vi.fn(async (flagId: string) =>
      flagRecords.get(flagId) ?? null
    ),
    getEnvironmentDetails: vi.fn(async (flagId: string) =>
      flagRecords.has(flagId)
        ? environmentDetails(
            flagId,
            Object.prototype.hasOwnProperty.call(options, "environmentSnapshot")
              ? options.environmentSnapshot
              : { profile: { environment_schema_version: "world-profile-v2" } }
          )
        : null
    ),
    getEnvironmentDiagnostics: vi.fn(async (flagId: string) => {
      diagnosticCallIds.push(flagId);
      return flagRecords.has(flagId) ? environmentDiagnostics(flagId) : null;
    }),
    refreshEnvironment: vi.fn(async (flagId: string) => {
      if (!flagRecords.has(flagId)) throw new Error("flag does not exist");
      refreshCallIds.push(flagId);
    }),
    refreshAllEnvironments: vi.fn(async (limit = 1_000) => {
      const ids = [...flagRecords.keys()].slice(0, limit);
      refreshCallIds.push(...ids);
      return { requested: ids.length, refreshed: ids.length, refreshedFlagIds: ids, failures: [], truncated: flagRecords.size > limit };
    }),
    refreshEnvironmentsNeedingRefresh: vi.fn(async (limit = 100) => {
      eligibleRefreshLimitValues.push(limit);
      refreshCallIds.push(OWNED_FLAG_ID);
      return { requested: 1, refreshed: 1, refreshedFlagIds: [OWNED_FLAG_ID], failures: [], truncated: false };
    }),
    deleteFlag: vi.fn(async (flagId: string) => {
      if (!flagRecords.delete(flagId)) {
        throw new Error("flag does not exist");
      }
      return {
        affectedFlagIds: [],
        notificationPlayerIds: [],
        refundInventories: [],
        droppedItems: [],
        replayed: false
      };
    }),
    renameFlag: vi.fn(async (flagId: string, name: string) => {
      const flag = flagRecords.get(flagId);
      if (!flag) {
        throw new Error("flag does not exist");
      }
      const renamed = {
        ...flag,
        name: name || `Atlas Shrine ${flag.atlasShrineSlotNumber}`
      };
      flagRecords.set(flagId, renamed);
      return renamed;
    })
  } as unknown as FlagService;
  const registry = options.withWorldRuntime
    ? new ConnectionRegistry()
      : ({
        broadcast: (message: ServerMessage) => {
          broadcasts.push(message);
        },
        activePlayerIds: () => ["player-1"]
      } as unknown as ConnectionRegistry);
  const gameState = new GameState(config);
  gameState.helloPlayer("player-1", "Ash");
  gameState.helloPlayer("player-2", "Bex");
  const players = {
    listOnlinePlayers: vi.fn(async () => [gameState.snapshotForPlayer("player-1")]),
    loadPlayer: vi.fn(async (playerId: string) => gameState.getPlayer(playerId) ?? null),
    updatePlayerColor: vi.fn(async (playerId: string, color: string) => ({
      ...gameState.snapshotForPlayer(playerId),
      displayColor: color.toLowerCase()
    })),
    persistPlayerSnapshot: vi.fn(async () => undefined)
  } as unknown as PlayerService;
  const logger = {
    warn: vi.fn(),
    info: vi.fn()
  } as unknown as AppLogger;
  const worldLookup = createWorldLookupStub(() => worldCovered);
  let worldRuntime: WorldRuntime | undefined;
  let connectionId: string | undefined;
  let combat: CombatEngine | undefined;
  if (options.withWorldRuntime) {
    combat = new CombatEngine({
      tickRateHz: config.SERVER_TICK_HZ,
      isPlayerAuthorityActive: (playerId, accountId, activeConnectionId) =>
        registry.isActiveConnection(accountId, activeConnectionId) &&
        registry.isActivePlayerConnection(playerId, activeConnectionId),
      movePlayerToward: (playerId, target) => gameState.setCombatTarget(playerId, target),
      stopPlayer: (playerId) => gameState.stopPlayer(playerId)
    });
    connectionId = registry.add({
      accountId: "account-player-1",
      playerId: "player-1",
      username: "Ash",
      regionCode: "NM",
      zoneId: "world:NM",
      socket: routeSocket()
    });
    combat.connectPlayer({
      playerId: "player-1",
      name: "Ash",
      regionCode: "NM",
      zoneId: "world:NM",
      position: gameState.getPlayer("player-1")!.position,
      accountId: "account-player-1",
      connectionId,
      profile: {
        playerId: "player-1",
        maxHealth: 100,
        currentHealth: 100,
        baseAttackDamage: 10,
        persistenceVersion: 0
      }
    });
    worldRuntime = new WorldRuntime(config, registry, gameState, combat, logger);
  }

  registerRoutes({
      infrastructure: {
          app: app,
          pool: createPoolStub(),
          worldLookup: worldLookup,
          config: config,
          registry: registry,
          logger: logger
      },
      authority: {
          flags: flags,
          players: players,
          gameState: gameState,
          auth: auth
      },
      capabilities: {
          collectibles: options.collectibles,
          resourceVisionJobs: options.resourceVisionJobs,
          combat: combat ?? ({
            cancelCombat: vi.fn(),
            despawnMob: (entityId: string) => {
              legendaryDespawns.push(entityId);
              return true;
            }
          } as unknown as CombatEngine),
          worldRuntime: worldRuntime,
          repeatableResources: options.repeatableResources,
          cities: options.cities,
          worldMap: options.worldMap,
          schedulePopulationV2Relocation: options.schedulePopulationV2Relocation,
          devTeleport: options.devTeleport
      },
      operational: {
          ...(options.databaseMetrics ? { database: options.databaseMetrics } : {})
      }
  });

  return {
    app,
    broadcasts,
    connectionId,
    developerAudit,
    gameState,
    persistPlayerSnapshot: players.persistPlayerSnapshot,
    tryCreatePlacementQuote: flags.tryCreatePlacementQuote,
    richLookup: worldLookup.lookup,
    compactLookup: worldLookup.lookupGameplayEnvironment,
    worldRuntime,
    clearCalls: () => clearCallCount,
    legendaryDespawns: () => [...legendaryDespawns],
    diagnosticCalls: () => [...diagnosticCallIds],
    eligibleRefreshLimits: () => [...eligibleRefreshLimitValues],
    refreshCalls: () => [...refreshCallIds],
    hasFlag: (flagId: string) => flagRecords.has(flagId),
    getFlag: (flagId: string) => flagRecords.get(flagId) ?? null,
    setWorldCovered: (covered: boolean) => {
      worldCovered = covered;
    }
  };
}

function environmentDiagnostics(flagId: string): FlagEnvironmentDiagnostics {
  const stored = environmentDetails(flagId, { profile: { environment_schema_version: "world-profile-v2" } });
  return {
    stored,
    live: {
      details: stored,
      rawLookup: { profile: { environment_schema_version: "world-profile-v2" } },
      lookupStartedAt: "2026-07-13T09:01:00.000Z",
      durationMs: 10,
      packageCacheState: "warm"
    },
    comparison: [],
    required: {
      environmentSchemaVersion: "world-profile-v2",
      worldReleaseId: "world-packages-v1",
      profileSetFingerprint: "a".repeat(64),
      buildContractFingerprint: "b".repeat(64),
      boundaryReleaseId: "world-boundaries-v1"
    },
    refreshRecommended: false
  };
}

function environmentDetails(flagId: string, rawSnapshot: unknown): FlagEnvironmentDetails {
  const snapshotRecord =
    typeof rawSnapshot === "object" && rawSnapshot !== null && !Array.isArray(rawSnapshot)
      ? rawSnapshot as Record<string, unknown>
      : null;
  const snapshotStatus = !snapshotRecord || Object.keys(snapshotRecord).length === 0
    ? "unavailable"
    : Object.prototype.hasOwnProperty.call(snapshotRecord, "legacy")
      ? "legacy"
      : "current";
  return {
    identity: { flagId, flagName: "Flag 9", ownerId: "player-1", ownerName: "Ash", ownerColor: "#38bdf8", createdAt: "2026-07-13T08:00:00.000Z", claimRadiusM: 700, cityId: null },
    coordinates: { latitude: 53.3498, longitude: -6.2603, packageId: "world_v1_lat53_lon-7" },
    administrative: { countryId: "IRL", countryName: "Ireland", countryCode: "IE", regionId: null, regionName: null, regionCode: null, cityId: null, cityName: null, insideCity: false, cityBoundaryDistanceM: null },
    terrain: { elevationM: 0, terrainClass: "flat", landCoverClass: "inland_water", sourceLandCoverCode: 210, isLand: true, isSaltwater: false, isCoastal: true, coastlineDistanceM: 2.311, landCoverConflict: true },
    ecology: { biomeId: "4", biomeName: "Temperate Broadleaf & Mixed Forests", ecoregionId: "651", ecoregionName: "Celtic broadleaf forests", resolution: "nearest_land_fallback", distanceM: 1795.604, sourcePackageId: "world_v1_lat53_lon-7", fallbackMaxM: 10000 },
    water: { nearest: { sourceType: "coast", sourceId: null, sourceName: null, kind: "salt", distanceM: 2.311, resolution: "within_search_radius", searchRadiusM: 25000, searchComplete: true }, namedRiver: { id: null, name: null, riverClass: null, distanceM: null, searchRadiusM: 25000, searchComplete: true }, supportingRiver: { id: "20287927", flowOrder: 6, dischargeCms: 2.692, drainageAreaSqKm: 9.36, distanceM: 3813.225, searchRadiusM: 25000, searchComplete: true }, majorLake: { id: null, name: null, inside: false, distanceM: null, searchRadiusM: 25000, searchComplete: true }, oceanDepthClass: "not_applicable" },
    provenance: { worldReleaseId: "world-packages-v1", profileSetFingerprint: "a".repeat(64), buildContractFingerprint: "b".repeat(64), boundaryReleaseId: "world-boundaries-v1", environmentSchemaVersion: "world-profile-v2", sourceVersions: { ecoregions: "2017" }, derivedTags: ["coastal_ecology_inferred"], warnings: [], snapshotStatus, snapshotStatusReason: snapshotStatus === "current" ? "Current comprehensive snapshot." : snapshotStatus === "legacy" ? "The stored snapshot uses an older unstructured format." : "No stored world snapshot is available for this flag.", snapshotUpdatedAt: "2026-07-13T09:00:00.000Z" },
    rawSnapshot
  };
}

function routeSocket(): SocketLike {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn()
  };
}

function createFlag(id: string, ownerId: string): FlagSnapshot {
  const flag: FlagSnapshot = {
    id,
    controlType: "personal",
    ownerId,
    name: "Test Flag",
    lat: 35.0844,
    lon: -106.6504,
    packageId: "nm-core",
    elevationM: 1500,
    terrainClass: "urban",
    biome: "desert",
    ecoregion: "Chihuahuan Desert",
    claimRadiusM: DEV_FLAG_CLAIM_RADIUS_M,
    cityId: null,
    createdAt: "2026-07-08T09:00:00.000Z"
  };
  if (ownerId === "player-1") {
    flag.ownerUsername = "Ash";
    flag.ownerColor = "#38bdf8";
  } else {
    flag.ownerUsername = "Bex";
    flag.ownerColor = "#3366cc";
  }
  return flag;
}

function withOptionalAtlasShrine(
  flag: FlagSnapshot,
  atlasShrine: boolean
): FlagSnapshot {
  return atlasShrine
    ? {
        ...flag,
        reinforcementLevel: 2,
        upgradeTier: "atlas_shrine",
        atlasShrineSlotNumber: 1
      }
    : flag;
}

function createPoolStub(): pg.Pool {
  return {
    query: async () => ({
      rows: [],
      rowCount: 0
    })
  } as unknown as pg.Pool;
}

function createWorldLookupStub(isCovered: () => boolean): WorldLookupClient {
  const lookup = vi.fn(async () => ({
    ok: isCovered(),
    packageId: isCovered() ? "nm-core" : null,
    elevationM: 1500,
    terrainClass: "urban",
    biome: "desert",
    ecoregion: "Chihuahuan Desert",
    raw: {}
  }));
  return {
    isReachable: vi.fn(async () => true),
    lookup,
    lookupGameplayEnvironment: lookup,
    gameplayEnvironmentMetrics: vi.fn(() => ({
      entries: 0,
      negativeEntries: 0,
      inFlight: 0,
      inFlightBatches: 0,
      hits: 0,
      negativeHits: 0,
      misses: 0,
      builds: 0,
      upstreamAttempts: 0,
      sharedWaits: 0,
      batchBuilds: 0,
      batchUpstreamAttempts: 0,
      batchSharedWaits: 0,
      batchPoints: 0,
      evictions: 0,
      staleExpirations: 0,
      negativeExpirations: 0,
      authorityInvalidations: 0,
      failureClassifications: {}
    }))
  } as unknown as WorldLookupClient;
}

function createCollectiblesStub(): CollectibleService {
  return {
    countSpawns: vi.fn(async () => ({
      spawnCellCount: 12,
      availableNodeCount: 7,
      harvestedNodeCount: 3,
      resourceVisionStatusCounts: {
        pending: 0,
        generating: 0,
        ready: 2,
        failed: 1
      }
    })),
    inventoryForPlayer: vi.fn(async () => ({
      playerId: "player-1",
      items: [],
      totals: {
        wood: 0,
        stone: 0,
        food: 0,
        ore: 0,
        water: 0
      }
    })),
    listAvailableNear: vi.fn(async () => []),
    listAvailableInVision: vi.fn(async () => []),
    waterHighlightsForVision: vi.fn(async () => [])
  } as unknown as CollectibleService;
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: "test",
      PLAYER_SPEED_MPS: String(DEV_PLAYER_SPEED_MPS),
      FLAG_CLAIM_RADIUS_M: String(DEV_FLAG_CLAIM_RADIUS_M),
      MOVE_LEASH_RADIUS_M: String(DEV_MOVE_LEASH_RADIUS_M)
    }),
    DEV_ADMIN_TOOLS_ENABLED: true,
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: ["owner-subject"],
    ...overrides
  };
}
