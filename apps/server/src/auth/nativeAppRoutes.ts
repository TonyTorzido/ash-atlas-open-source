import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  evaluateNativeCompatibility,
  nativeCompatibilityRequestSchema
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import { setAuthCookies } from "./authRoutes.js";
import type { AuthService } from "./authService.js";
import {
  isCapacitorNativeCallback,
  isCapacitorNativeRequestHeader,
  CAPACITOR_NATIVE_REQUEST_HEADER,
  type NativeAppAuthorization,
  NativeAppAuthorizationError
} from "./nativeAppAuthorization.js";
import { AuthError, type LoginRequestContext } from "./types.js";

const authorizeQuerySchema = z.object({
  platform: z.enum(["ios", "android"]).default("ios"),
  choose_account: z.enum(["true", "false"]).optional(),
  state: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  redirect_uri: z.string().refine(isCapacitorNativeCallback)
}).strict();

const tokenBodySchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
  redirectUri: z.string().refine(isCapacitorNativeCallback)
}).strict();

const NATIVE_AUTHORIZATION_PROTOCOL = "ios-pkce-v1";
const RETIRED_NATIVE_WEB_INSTALL_URL = "https://playashatlas.com/play/?install=1";

export function registerNativeAppRoutes(
  app: FastifyInstance,
  auth: AuthService,
  config: AppConfig,
  authorization: NativeAppAuthorization
): void {
  app.get("/api/auth/native/status", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async () => ({ protocol: NATIVE_AUTHORIZATION_PROTOCOL }));

  app.get("/api/auth/native/compatibility", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      const query = nativeCompatibilityRequestSchema.parse(request.query);
      const prefix = query.platform === "ios" ? "NATIVE_IOS" : "NATIVE_ANDROID";
      const compatibility = evaluateNativeCompatibility(query, {
        hardMinimum: {
          version: config[`${prefix}_HARD_MIN_VERSION`],
          build: config[`${prefix}_HARD_MIN_BUILD`]
        },
        recommendedMinimum: {
          version: config[`${prefix}_RECOMMENDED_MIN_VERSION`],
          build: config[`${prefix}_RECOMMENDED_MIN_BUILD`]
        },
        latest: {
          version: config[`${prefix}_LATEST_VERSION`],
          build: config[`${prefix}_LATEST_BUILD`]
        },
        storeUrl: query.platform === "ios"
          ? config.NATIVE_IOS_STORE_URL ?? null
          : config.NATIVE_ANDROID_STORE_URL ?? null,
        wsMin: config.NATIVE_WS_MIN,
        wsMax: config.NATIVE_WS_MAX,
        serverSha: config.RUNTIME_SHA ?? null
      });
      return compatibility.status === "required"
        ? { ...compatibility, storeUrl: RETIRED_NATIVE_WEB_INSTALL_URL }
        : compatibility;
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400).send({
          error: { code: "NATIVE_COMPATIBILITY_INVALID", message: "Invalid native compatibility request" }
        });
        return;
      }
      reply.code(503).send({
        error: { code: "NATIVE_COMPATIBILITY_UNAVAILABLE", message: "Native compatibility is unavailable" }
      });
    }
  });

  app.get("/api/auth/native/authorize", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      const query = authorizeQuerySchema.parse(request.query);
      const rawSessionToken = request.cookies[auth.sessionCookieName] ?? null;
      const session = await auth.authenticateSession(
        rawSessionToken
      );
      if (!session || !rawSessionToken || query.choose_account === "true") {
        const login = new URL("/play/", config.APP_PUBLIC_ORIGIN);
        login.searchParams.set("native_auth", query.platform);
        login.searchParams.set("state", query.state);
        login.searchParams.set("code_challenge", query.code_challenge);
        login.searchParams.set("redirect_uri", query.redirect_uri);
        if (query.choose_account === "true") login.searchParams.set("choose_account", "true");
        return reply.redirect(login.toString());
      }
      const issued = authorization.issueCode({
        session,
        rawSessionToken,
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge
      });
      const callback = new URL(query.redirect_uri);
      callback.searchParams.set("code", issued.code);
      callback.searchParams.set("state", query.state);
      return reply.redirect(callback.toString());
    } catch (error) {
      sendNativeAuthError(reply, error);
    }
  });

  app.post("/api/auth/native/token", {
    bodyLimit: 2_048,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      const body = tokenBodySchema.parse(request.body);
      const sourceSessionToken = authorization.exchange(body);
      const sourceSession = await auth.authenticateSession(sourceSessionToken);
      if (!sourceSession) {
        throw new AuthError("AUTHENTICATION_REQUIRED", "Browser session expired", 401);
      }
      const result = await auth.createNativeSession(
        sourceSession,
        nativeLoginContext(request, auth)
      );
      setAuthCookies(reply, auth, config, result, true);
      return {
        ...await auth.sessionResponse(result.session, { nativeClient: true }),
        webSocketTicket: authorization.issueWebSocketTicket(result.session.rawToken)
      };
    } catch (error) {
      sendNativeAuthError(reply, error);
    }
  });

  app.get("/api/auth/native/ticket", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      if (!isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])) {
        throw new NativeAppAuthorizationError(403, "Native client required");
      }
      const rawSessionToken = request.cookies[auth.sessionCookieName] ?? null;
      const session = await auth.authenticateSession(rawSessionToken);
      if (!session || !rawSessionToken) {
        throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
      }
      return { webSocketTicket: authorization.issueWebSocketTicket(rawSessionToken) };
    } catch (error) {
      sendNativeAuthError(reply, error);
    }
  });
}

function nativeLoginContext(
  request: FastifyRequest,
  auth: AuthService
): LoginRequestContext {
  return {
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    deviceToken: request.cookies[auth.deviceCookieName] ?? null,
    existingSessionToken: null
  };
}

function sendNativeAuthError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError) {
    reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message }
    });
    return;
  }
  if (error instanceof NativeAppAuthorizationError) {
    reply.code(error.statusCode).send({
      error: { code: "NATIVE_AUTHORIZATION_FAILED", message: error.message }
    });
    return;
  }
  if (error instanceof z.ZodError) {
    reply.code(400).send({
      error: { code: "NATIVE_AUTHORIZATION_FAILED", message: "Invalid native authorization request" }
    });
    return;
  }
  reply.code(503).send({
    error: { code: "ACCOUNT_UNAVAILABLE", message: "Authentication service unavailable" }
  });
}
