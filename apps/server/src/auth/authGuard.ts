import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { AuthError, type AuthenticatedSession } from "./types.js";
import type { AuthService } from "./authService.js";
import {
  CAPACITOR_NATIVE_REQUEST_HEADER,
  isCapacitorNativeRequestHeader
} from "./nativeAppAuthorization.js";

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthenticatedSession | null;
  }
}

const PUBLIC_ROUTES = new Set([
  "/health",
  "/ready",
  "/api/auth/session",
  "/api/auth/google",
  "/api/auth/email/start",
  "/api/auth/email/verify",
  "/api/auth/apple/status",
  "/api/auth/apple/start",
  "/api/auth/apple/callback",
  "/api/auth/apple/notifications",
  "/api/auth/dev",
  "/api/auth/native/status",
  "/api/auth/native/compatibility",
  "/api/auth/native/authorize",
  "/api/auth/native/token",
  "/api/auth/native/ticket",
  "/api/developer/appearance-studio/token",
  "/api/developer/appearance-studio/info",
  "/api/developer/appearance-studio/revoke",
  "/api/account/deletion-request/public",
  "/api/updates/subscribe",
  // Store and payment-provider webhooks authenticate by signature, not session.
  "/api/purchases/apple/notifications",
  "/api/purchases/google/rtdn",
  "/api/purchases/web/webhook",
  "/ws"
]);

// The native OTA descriptor stays public: installed shells read it before sign-in,
// and a logged-out app must still be able to reach a compatible bundle.
const PUBLIC_GET_ROUTES = new Set(["/api/native/bundle"]);

// Read-only game content (wiki, runtime art packs) is for signed-in accounts that pass
// the test-access gate (Open/Closed/Dev mode and the dev list); onboarding is not required.
const TEST_ACCESS_GET_ROUTES = new Set([
  "/api/wiki",
  "/api/wiki/:slug",
  "/api/runtime-png/v2/manifest/:registrationId",
  "/api/runtime-png/v2/blobs/:packId/:sha256"
]);

const RESTRICTED_SESSION_ROUTES = new Set([
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/account/deletion-request"
]);

const ONBOARDING_ROUTES = new Set(["/api/account/onboarding"]);

export function installAuthGuard(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService
): void {
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request, reply) => {
    const routeUrl = request.routeOptions.url ?? request.url;
    if (routeUrl === "/ws") {
      return;
    }
    request.authSession = null;
    if (
      PUBLIC_ROUTES.has(routeUrl) ||
      (request.method === "GET" && PUBLIC_GET_ROUTES.has(routeUrl)) ||
      !routeUrl.startsWith("/api/")
    ) {
      return;
    }
    if (!config.AUTH_REQUIRED) {
      return;
    }
    try {
      const session = await auth.authenticateSession(request.cookies[auth.sessionCookieName] ?? null);
      if (!session) {
        throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
      }
      request.authSession = session;
      if (isStateChanging(request.method)) {
        auth.assertOrigin(
          request.headers.origin,
          isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])
        );
        auth.assertCsrf(session, headerValue(request.headers["x-csrf-token"]));
      }
      if (RESTRICTED_SESSION_ROUTES.has(routeUrl)) return;
      if (
        ONBOARDING_ROUTES.has(routeUrl) ||
        routeUrl.startsWith("/api/admin/test-access") ||
        (request.method === "GET" && TEST_ACCESS_GET_ROUTES.has(routeUrl))
      ) {
        await auth.requireApprovedTestAccess(session);
        return;
      }
      await auth.requireGameplayReady(session);
    } catch (error) {
      sendAuthError(reply, error);
    }
  });
}

export function requireRequestSession(request: FastifyRequest): AuthenticatedSession {
  if (!request.authSession) {
    throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
  }
  return request.authSession;
}

export function sendAuthError(reply: FastifyReply, error: unknown): void {
  const authError =
    error instanceof AuthError
      ? error
      : new AuthError("ACCOUNT_UNAVAILABLE", "Authentication service unavailable", 503);
  reply.code(authError.statusCode).send({
    error: {
      code: authError.code,
      message: authError.message
    }
  });
}

function isStateChanging(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
