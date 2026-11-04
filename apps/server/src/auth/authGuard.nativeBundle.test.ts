import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { installAuthGuard } from "./authGuard.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

it("allows the native bundle GET before sign-in but protects other methods", async () => {
  const app = Fastify(); apps.push(app);
  app.decorateRequest("cookies", { getter: () => ({}) });
  const authenticateSession = vi.fn(async () => null);
  installAuthGuard(app, { AUTH_REQUIRED: true } as unknown as AppConfig, {
    sessionCookieName: "session", authenticateSession
  } as never);
  app.get("/api/native/bundle", async () => ({ ok: true }));
  app.post("/api/native/bundle", async () => ({ ok: true }));
  await app.ready();

  expect((await app.inject({ method: "GET", url: "/api/native/bundle" })).statusCode).toBe(200);
  expect(authenticateSession).not.toHaveBeenCalled();
  const mutation = await app.inject({ method: "POST", url: "/api/native/bundle" });
  expect(mutation.statusCode).toBe(401);
  expect(authenticateSession).toHaveBeenCalledOnce();
});
