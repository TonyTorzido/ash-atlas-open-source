import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../auth/authService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppConfig } from "../../config.js";
import { createDiagnosticRoutes } from "./diagnosticRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup(allowed: boolean) {
  const app = Fastify(); apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    request.authSession = { player: { id: "owner" } } as unknown as AuthenticatedSession;
  });
  const auth = {
    authorizeDeveloperCommand: vi.fn(async () => { if (!allowed) throw new Error("forbidden"); }),
    hasDeveloperCapability: vi.fn(() => allowed)
  };
  const info = vi.fn();
  const warn = vi.fn();
  const combat = {
    metricsSnapshot: vi.fn(() => ({ activeCombatants: 7, lastTickDurationMs: 1.5 })),
    tickHistorySnapshot: vi.fn(() => ({ tickMs: { count: 3, p50: 1, p95: 2, max: 3 }, activeCombatants: 7 }))
  };
  const worldRuntime = { metricsSnapshot: vi.fn(() => ({ ticks: 3 })) };
  createDiagnosticRoutes({
    app,
    logger: { info, warn } as never,
    registry: { metricsSnapshot: () => ({ connections: 1 }), realtimePublisherMetricsSnapshot: () => ({ sent: 2 }) } as never,
    gameState: {} as never,
    auth: auth as unknown as AuthService,
    combat: combat as never,
    worldRuntime: worldRuntime as never,
    admission: {} as never,
    operational: {},
    config: { TELEMETRY_ENABLED: false } as unknown as AppConfig
  });
  return { app, combat, info, warn };
}

describe("perf diagnostics route", () => {
  it("is forbidden without developer observe access", async () => {
    const { app, combat } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/diagnostics/perf" });
    expect(response.statusCode).toBe(403);
    expect(combat.metricsSnapshot).not.toHaveBeenCalled();
  });

  it("returns combat and runtime snapshots for developers, with telemetry off", async () => {
    const { app } = setup(true);
    const response = await app.inject({ method: "GET", url: "/api/dev/diagnostics/perf" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      combat: { activeCombatants: 7, lastTickDurationMs: 1.5 },
      worldRuntime: { ticks: 3 },
      serverTicks: { tickMs: { p95: 2 }, activeCombatants: 7 },
      realtimePublisher: { sent: 2 }
    });
  });

  const sample = {
    clientAtMs: 1_790_000_000_000, fps: 58, frameP50Ms: 16, frameP95Ms: 20, frameP99Ms: 30, framesOver50Ms: 0,
    drawCallsPerFrame: 40, textureCount: 10, textureMb: 12, jsHeapMb: 80, retainedDisplayObjects: 100,
    combatEntities: 5, gameAppRendersPerSec: 2, eventLoopLagMs: 1, wsMsgsPerSec: 10, wsKbPerSec: 2,
    dpr: 3, overlayResolution: 2, legacyRenderQuality: false, rttMs: 40, deltaGapP95Ms: 60,
    longTasks: 0, userAgent: "test", build: "dev"
  };

  it("rejects sample uploads and reads without developer access", async () => {
    const { app, info } = setup(false);
    const post = await app.inject({ method: "POST", url: "/api/diagnostics/perf-sample", payload: sample });
    expect(post.statusCode).toBe(403);
    const get = await app.inject({ method: "GET", url: "/api/dev/diagnostics/perf/samples" });
    expect(get.statusCode).toBe(403);
    expect(info).not.toHaveBeenCalled();
  });

  it("stores, logs, reads back, validates and rate limits samples for developers", async () => {
    const { app, info, warn } = setup(true);
    const bad = await app.inject({ method: "POST", url: "/api/diagnostics/perf-sample", payload: { fps: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ playerId: "owner" }), "perf-sample rejected: invalid body");
    const ok = await app.inject({ method: "POST", url: "/api/diagnostics/perf-sample", payload: sample });
    expect(ok.statusCode).toBe(200);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ playerId: "owner" }), "perf-sample");
    const read = await app.inject({ method: "GET", url: "/api/dev/diagnostics/perf/samples" });
    expect(read.json().samples.owner).toHaveLength(1);
    expect(read.json().samples.owner[0]).toMatchObject({ fps: 58, rttMs: 40 });
    let limited = 0;
    for (let i = 0; i < 30; i += 1) {
      const response = await app.inject({ method: "POST", url: "/api/diagnostics/perf-sample", payload: sample });
      if (response.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
