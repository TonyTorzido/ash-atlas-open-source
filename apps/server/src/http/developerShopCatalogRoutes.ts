import { GLIMMER_SHOP_SKU_PATTERN, glimmerShopCatalogEditSchema } from "@ash-atlas/shared";
import type { FastifyInstance } from "fastify";

import type { AuthService } from "../auth/authService.js";
import { GlimmerShopError, type GlimmerShopService } from "../game/glimmerShop.js";
import { sendError } from "./errors.js";
import { authorizeDeveloperHttp, recordDeveloperHttpResult } from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:economy-mutate" as const;

/** Developer App -> Shop catalog: list every row and edit one, behind the economy capability. */
export function registerDeveloperShopCatalogRoutes(
  app: FastifyInstance,
  auth: AuthService,
  shop: Pick<GlimmerShopService, "adminCatalog" | "editCatalogItem">
): void {
  app.get("/api/dev/shop/catalog", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, "shop.catalog.list");
    if (!session) return;
    try {
      const items = await shop.adminCatalog();
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "shop.catalog.list", outcome: "succeeded" });
      return { items };
    } catch {
      await recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: "shop.catalog.list", outcome: "failed" });
      return sendError(reply, 500, "SHOP_CATALOG_UNAVAILABLE", "The shop catalog is temporarily unavailable");
    }
  });

  app.patch("/api/dev/shop/catalog/:sku", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const sku = (request.params as { sku?: unknown }).sku;
    const parsed = glimmerShopCatalogEditSchema.safeParse(request.body);
    const target = typeof sku === "string" ? sku.slice(0, 80) : null;
    const operationKey = parsed.success ? parsed.data.operationKey : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, "shop.catalog.edit", target, operationKey);
    if (!session) return;
    const audit = (outcome: "succeeded" | "failed") => recordDeveloperHttpResult(auth, session, {
      capability: CAPABILITY, command: "shop.catalog.edit", target, operationKey, outcome
    });
    if (!parsed.success || typeof sku !== "string" || !GLIMMER_SHOP_SKU_PATTERN.test(sku)) {
      await audit("failed");
      return sendError(reply, 400, "INVALID_SHOP_CATALOG_EDIT", "Shop catalog edit is invalid");
    }
    try {
      const result = await shop.editCatalogItem(session.player!.id, sku, parsed.data);
      await audit("succeeded");
      return result;
    } catch (error) {
      await audit("failed");
      if (error instanceof GlimmerShopError) {
        const status = error.code === "SHOP_ITEM_UNAVAILABLE" ? 404 : error.code === "SHOP_IDEMPOTENCY_CONFLICT" ? 409 : 400;
        return sendError(reply, status, error.code, error.message);
      }
      return sendError(reply, 500, "SHOP_CATALOG_UNAVAILABLE", "The shop catalog is temporarily unavailable");
    }
  });
}
