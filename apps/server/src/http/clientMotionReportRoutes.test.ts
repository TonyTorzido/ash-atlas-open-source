import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerClientAttackAimReportRoutes, registerClientDungeonStuckReportRoutes, registerClientMotionReportRoutes } from "./clientAudioReportRoutes.js";

describe("client motion report", () => {
  it("logs a bounded report and rejects anything else", async () => {
    const info = vi.fn();
    const app = Fastify();
    registerClientMotionReportRoutes(app, { info });
    const report = { frameP50Ms: 8.3, refreshHz: 120, camReversals: 4, driver: "overlay", gpu: null, filter: true };
    const ok = await app.inject({ method: "POST", url: "/api/diagnostics/motion", payload: { kind: "jitter", report } });
    expect(ok.statusCode).toBe(204);
    expect(info).toHaveBeenCalledWith({ motionReport: report, motionReportKind: "jitter" }, "client motion report");
    const bad = await app.inject({ method: "POST", url: "/api/diagnostics/motion", payload: { kind: "session", report: { nested: [1] } } });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({ method: "POST", url: "/api/diagnostics/motion", payload: { kind: "audio", report: {} } });
    expect(extra.statusCode).toBe(400);
    expect(info).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("client attack aim report", () => {
  it("logs a bounded batch of rows and rejects anything else", async () => {
    const info = vi.fn();
    const app = Fastify();
    registerClientAttackAimReportRoutes(app, { info });
    const report = { batch: 0, graceMs: 150, decisionPx: 9, build: null, platform: "android", rows: 2, p0: "drag,48,112,9,9,R,L,1", p1: "tap,-,80,0,0,L,L,1" };
    const ok = await app.inject({ method: "POST", url: "/api/diagnostics/attack-aim", payload: { kind: "batch", report } });
    expect(ok.statusCode).toBe(204);
    expect(info).toHaveBeenCalledWith({ attackAimReport: report, attackAimReportKind: "batch" }, "client attack aim report");
    const bad = await app.inject({ method: "POST", url: "/api/diagnostics/attack-aim", payload: { kind: "batch", report: { nested: [1] } } });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({ method: "POST", url: "/api/diagnostics/attack-aim", payload: { kind: "session", report: {} } });
    expect(extra.statusCode).toBe(400);
    expect(info).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("client dungeon stuck report", () => {
  it("logs a bounded flat report and rejects anything else", async () => {
    const info = vi.fn();
    const app = Fastify();
    registerClientDungeonStuckReportRoutes(app, { info });
    const report = { reason: "no-move", room: "vault_r1", serverX: 890, serverY: 1379, puzzleLocked: false, seals: "on,on,on,on" };
    const ok = await app.inject({ method: "POST", url: "/api/diagnostics/dungeon-stuck", payload: { kind: "stuck", report } });
    expect(ok.statusCode).toBe(204);
    expect(info).toHaveBeenCalledWith({ dungeonStuckReport: report }, "client dungeon stuck report");
    const bad = await app.inject({ method: "POST", url: "/api/diagnostics/dungeon-stuck", payload: { kind: "stuck", report: { nested: [1] } } });
    expect(bad.statusCode).toBe(400);
    expect(info).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
