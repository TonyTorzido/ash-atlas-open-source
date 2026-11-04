import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { registerDeveloperShopCatalogRoutes } from "./developerShopCatalogRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const OPERATION_KEY = "00000000-0000-4000-8000-000000900009";

function setup(allowed: boolean) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    request.authSession = { player: { id: allowed ? "admin" : "player" } } as unknown as AuthenticatedSession;
  });
  const auth = {
    authorizeDeveloperCommand: vi.fn(async () => {
      if (!allowed) throw new Error("forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => {})
  };
  const shop = {
    adminCatalog: vi.fn(async () => []),
    editCatalogItem: vi.fn(async () => ({ item: { sku: "runestar", priceGlimmer: 1200 }, replayed: false }))
  };
  registerDeveloperShopCatalogRoutes(app, auth as unknown as AuthService, shop as never);
  return { app, auth, shop };
}

describe("developer shop catalog routes", () => {
  it("lets an admin edit a row and records the developer audit entry", async () => {
    const { app, auth, shop } = setup(true);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/dev/shop/catalog/runestar",
      payload: { operationKey: OPERATION_KEY, priceGlimmer: 1200, source: "shop" }
    });
    expect(response.statusCode).toBe(200);
    expect(shop.editCatalogItem).toHaveBeenCalledWith("admin", "runestar", { operationKey: OPERATION_KEY, priceGlimmer: 1200, source: "shop" });
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capability: "developer:economy-mutate", command: "shop.catalog.edit", target: "runestar" })
    );
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: "shop.catalog.edit", outcome: "succeeded" })
    );
  });

  it("denies a normal player without touching the catalog", async () => {
    const { app, shop } = setup(false);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/dev/shop/catalog/runestar",
      payload: { operationKey: OPERATION_KEY, priceGlimmer: 1 }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
    expect(shop.editCatalogItem).not.toHaveBeenCalled();
    const list = await app.inject({ method: "GET", url: "/api/dev/shop/catalog" });
    expect(list.statusCode).toBe(403);
    expect(shop.adminCatalog).not.toHaveBeenCalled();
  });
});
