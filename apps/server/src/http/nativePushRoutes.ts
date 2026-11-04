import { nativePushDestinationSchema, nativePushPreferencesSchema, nativePushRegistrationSchema, nativePushResetSchema } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireRequestSession } from "../auth/authGuard.js";
import { CAPACITOR_NATIVE_REQUEST_HEADER, isCapacitorNativeRequestHeader } from "../auth/nativeAppAuthorization.js";
import { NativePushError, type NativePushService } from "../notifications/nativePushService.js";
import { sendError } from "./errors.js";

export function registerNativePushRoutes(app: FastifyInstance, service: NativePushService): void {
  const options = { bodyLimit: 8192, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const sessionFor = (request: FastifyRequest) => {
    // This header selects native behavior, not authentication. The shared guard
    // already checks the cookie, origin, CSRF, account status and player access.
    if (!isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])) throw new NativePushError(403, "Native client required.");
    return requireRequestSession(request);
  };
  app.get("/api/native-push", options, async (request, reply) => {
    try { return await service.status(sessionFor(request)); }
    catch (error) { failure(reply, error); }
  });
  app.post("/api/native-push/register", options, async (request, reply) => {
    try {
      const session = sessionFor(request);
      const parsed = nativePushRegistrationSchema.safeParse(request.body);
      if (!parsed.success) throw new NativePushError(400, "Invalid notification registration.");
      await service.register(session, parsed.data);
      return await service.status(session);
    } catch (error) { failure(reply, error); }
  });
  app.post("/api/native-push/reset", options, async (request, reply) => {
    try {
      const session = sessionFor(request);
      const parsed = nativePushResetSchema.safeParse(request.body);
      if (!parsed.success) throw new NativePushError(400, "Invalid notification reset.");
      await service.reset(session, parsed.data.expectedEpoch);
      return await service.status(session);
    } catch (error) { failure(reply, error); }
  });
  app.post("/api/native-push/preferences", options, async (request, reply) => {
    try {
      const session = sessionFor(request);
      const parsed = nativePushPreferencesSchema.safeParse(request.body);
      if (!parsed.success) throw new NativePushError(400, "Invalid notification preferences.");
      await service.setPreferences(session, parsed.data);
      return await service.status(session);
    } catch (error) { failure(reply, error); }
  });
  app.post("/api/native-push/destination", options, async (request, reply) => {
    try {
      const parsed = nativePushDestinationSchema.safeParse(request.body);
      if (!parsed.success) throw new NativePushError(400, "Invalid notification.");
      return await service.destination(sessionFor(request), parsed.data.deliveryId);
    } catch (error) { failure(reply, error); }
  });
}
function failure(reply: Parameters<typeof sendError>[0], error: unknown): void {
  // Never log request bodies, provider tokens, raw provider responses or credentials.
  sendError(reply, error instanceof NativePushError ? error.statusCode : 503, "NATIVE_PUSH_UNAVAILABLE",
    error instanceof NativePushError ? error.message : "Notifications are temporarily unavailable.");
}
