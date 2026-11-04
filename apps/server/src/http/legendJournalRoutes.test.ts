import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import { registerLegendJournalRoutes } from "./legendJournalRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("legend journal HTTP authority", () => {
  it("reads only the authenticated character and prevents shared caching", async () => {
    const { app, snapshot } = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/legends", headers: { cookie: "session=valid" } });
    expect(response.statusCode).toBe(200);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith("journal-player");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json().playerId).toBe("journal-player");
  });

  it("denies unauthenticated requests before reading or awarding anything", async () => {
    const { app, snapshot } = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/legends" });
    expect(response.statusCode).toBe(401);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("rejects a supplied player ID rather than inspecting someone else's progress", async () => {
    const { app, snapshot } = await fixture();
    const response = await app.inject({
      method: "GET", url: "/api/legends?playerId=other-player", headers: { cookie: "session=valid" }
    });
    expect(response.statusCode).toBe(400);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("returns a retryable failure without exposing database errors", async () => {
    const { app, snapshot } = await fixture();
    snapshot.mockRejectedValueOnce(new Error("private database detail"));
    const response = await app.inject({ method: "GET", url: "/api/legends", headers: { cookie: "session=valid" } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private database detail");
    expect(response.json().error.code).toBe("JOURNAL_UNAVAILABLE");
  });
});

async function fixture() {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const auth = {
    sessionCookieName: "session",
    authenticateSession: vi.fn(async (value: string | null) => value === "valid"
      ? { player: { id: "journal-player" }, account: { id: "journal-account" } }
      : null),
    requireGameplayReady: vi.fn(async () => undefined)
  } as unknown as AuthService;
  installAuthGuard(app, { AUTH_REQUIRED: true } as AppConfig, auth);
  const snapshot = vi.fn(async (playerId: string) => ({
    playerId, metrics: {}, completed: {}, newlyCompletedIds: [], serverTime: 100
  }));
  registerLegendJournalRoutes(app, { snapshot });
  await app.ready();
  return { app, snapshot };
}
