import {
  appleVerifyRequestSchema,
  googleVerifyRequestSchema,
  purchaseCapabilitiesQuerySchema,
  purchasePreflightRequestSchema,
  webCheckoutRequestSchema
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession, sendAuthError } from "../auth/authGuard.js";
import { sendError } from "../http/errors.js";
import { PurchaseRequestError, type PurchaseService } from "./purchaseService.js";

// Real-money purchase endpoints (premium-currency-plan.md §6). Player routes go
// through the shared session/origin/CSRF guard. Store webhooks are public and
// authenticate by signature. Every route except the capability answers 404
// while its flag is off.

export const PURCHASE_WEBHOOK_ROUTES = [
  "/api/purchases/apple/notifications",
  "/api/purchases/google/rtdn",
  "/api/purchases/web/webhook"
] as const;

const PLAYER = { bodyLimit: 65_536, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
const WEBHOOK = { bodyLimit: 262_144, config: { rateLimit: { max: 600, timeWindow: "1 minute" } } };
const appleNotificationSchema = z.object({ signedPayload: z.string().min(16).max(200_000) }).passthrough();

export function registerPurchaseRoutes(app: FastifyInstance, service: PurchaseService): void {
  const player = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    schema: z.ZodType<T> | null,
    input: unknown,
    run: (accountId: string, body: T) => Promise<unknown>
  ) => (async () => {
    let session;
    try {
      session = requireRequestSession(request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
    const parsed = schema ? schema.safeParse(input) : { success: true as const, data: undefined as T };
    if (!parsed.success) return sendError(reply, 400, "PURCHASE_INVALID", "Purchase request is invalid");
    try {
      return await run(session.account.id, parsed.data);
    } catch (error) {
      if (error instanceof PurchaseRequestError) return sendError(reply, error.statusCode, error.code, error.message);
      request.log.error({ err: error }, "purchase request failed");
      return sendError(reply, 503, "PURCHASE_UNAVAILABLE", "Purchases are temporarily unavailable");
    }
  })();

  // Always answers: tells the client which purchase path and shop link it may show.
  app.get("/api/purchases/capabilities", PLAYER, (request, reply) =>
    player(request, reply, purchaseCapabilitiesQuerySchema, request.query, (accountId, query) =>
      service.capabilities(accountId, query)));

  app.post("/api/purchases/preflight", PLAYER, (request, reply) =>
    player(request, reply, purchasePreflightRequestSchema, request.body, async (accountId, body) => {
      if (!service.enabled(body.platform)) throw new PurchaseRequestError(404, "NOT_FOUND", "Not found");
      return service.preflight(accountId, body);
    }));

  app.post("/api/purchases/apple", PLAYER, (request, reply) =>
    player(request, reply, appleVerifyRequestSchema, request.body, (accountId, body) =>
      service.verifyApple(accountId, body.signedTransaction)));

  app.post("/api/purchases/google", PLAYER, (request, reply) =>
    player(request, reply, googleVerifyRequestSchema, request.body, (accountId, body) =>
      service.verifyGoogle(accountId, body)));

  app.post("/api/purchases/web/checkout", PLAYER, (request, reply) =>
    player(request, reply, webCheckoutRequestSchema, request.body, (accountId, body) =>
      service.createWebCheckout(accountId, body.sku)));

  app.get("/api/purchases/atlas-pass", PLAYER, (request, reply) =>
    player(request, reply, null, undefined, (accountId) => service.atlasPass(accountId)));

  app.post(PURCHASE_WEBHOOK_ROUTES[0], WEBHOOK, async (request, reply) => {
    if (!service.enabled("apple")) return sendError(reply, 404, "NOT_FOUND", "Not found");
    const parsed = appleNotificationSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "PURCHASE_INVALID", "Notification is invalid");
    const status = await service.handleAppleNotification(parsed.data.signedPayload);
    return reply.code(status).send(status === 200 ? { ok: true } : undefined);
  });

  app.post(PURCHASE_WEBHOOK_ROUTES[1], WEBHOOK, async (request, reply) => {
    if (!service.enabled("google")) return sendError(reply, 404, "NOT_FOUND", "Not found");
    const status = await service.handleGoogleRtdn(request.headers.authorization, request.body);
    return reply.code(status).send();
  });

  // The provider signs the exact bytes, so this route parses JSON itself.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
    scope.post(PURCHASE_WEBHOOK_ROUTES[2], WEBHOOK, async (request, reply) => {
      if (!service.enabled("web")) return sendError(reply, 404, "NOT_FOUND", "Not found");
      if (!Buffer.isBuffer(request.body)) return sendError(reply, 400, "PURCHASE_INVALID", "Notification is invalid");
      const result = await service.handleWebWebhook(request.body, request.headers);
      return reply.code(result.status).send(result.body ?? undefined);
    });
  });
}
