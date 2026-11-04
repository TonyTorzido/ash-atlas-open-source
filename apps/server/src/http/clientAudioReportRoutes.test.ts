import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerClientAudioReportRoutes } from "./clientAudioReportRoutes.js";

describe("client audio report", () => {
  it("logs a bounded report and rejects anything else", async () => {
    const info = vi.fn();
    const app = Fastify();
    registerClientAudioReportRoutes(app, { info });
    const ok = await app.inject({ method: "POST", url: "/api/diagnostics/audio", payload: { kind: "session", report: { ctxState: "running", sampleRate: 48000, error: null } } });
    expect(ok.statusCode).toBe(204);
    expect(info).toHaveBeenCalledWith({ audioReport: { ctxState: "running", sampleRate: 48000, error: null }, audioReportKind: "session" }, "client audio report");
    const bad = await app.inject({ method: "POST", url: "/api/diagnostics/audio", payload: { kind: "session", report: { nested: { a: 1 } } } });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({ method: "POST", url: "/api/diagnostics/audio", payload: { kind: "other", report: {} } });
    expect(extra.statusCode).toBe(400);
    expect(info).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
