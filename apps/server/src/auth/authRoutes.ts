import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import type { AuthService } from "./authService.js";
import { NativeAppleLinkFailure, type AppleAuthService } from "./appleAuth.js";
import type { OnboardingService } from "./onboardingService.js";
import { requireRequestSession, sendAuthError } from "./authGuard.js";
import { developmentProfile, isDevelopmentProfileKey } from "./developmentProfiles.js";
import { AuthError, type LoginRequestContext } from "./types.js";
import {
  CAPACITOR_NATIVE_REQUEST_HEADER,
  isCapacitorNativeRequestHeader,
  type NativeAppAuthorization
} from "./nativeAppAuthorization.js";

function nativeAppleReturnUrl(state: string, outcome: "completed" | "cancelled" | "failed"): string {
  const url = new URL("com.ashatlas.game://auth/apple-link");
  url.searchParams.set("state", state);
  url.searchParams.set("outcome", outcome);
  return url.toString();
}

const googleLoginBodySchema = z.object({
  credential: z.string().min(1).max(16_384)
}).strict();

const emailStartBodySchema = z.object({
  email: z.string().min(1).max(320)
}).strict();

const emailVerifyBodySchema = z.object({
  email: z.string().min(1).max(320),
  code: z.string().min(1).max(16)
}).strict();

const onboardingBodySchema = z.object({
  displayName: z.string().min(1).max(64),
  personalFlagColor: z.enum(["red", "blue", "green", "gold", "purple"])
}).strict();

const developmentLoginBodySchema = z.object({
  profile: z.string()
}).strict();

const appleStartQuerySchema = z.object({
  return_to: z.string().max(1024).optional()
}).strict();

const appleLinkBodySchema = z.object({
  returnTo: z.string().max(1024).optional(),
  nativeReturn: z.boolean().optional(),
  nativeReturnState: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()
}).strict();

const appleCallbackBodySchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4_000).optional(),
  error: z.string().max(128).optional()
}).passthrough().refine((body) => Boolean(body.code) || Boolean(body.error), {
  message: "Apple callback is missing a result"
});

const appleNotificationBodySchema = z.object({
  signedPayload: z.string().min(1).max(4_000_000).optional(),
  payload: z.string().min(1).max(4_000_000).optional()
}).strict().refine((body) => Boolean(body.signedPayload ?? body.payload), {
  message: "Apple notification payload is missing"
});

export interface AccountConnectionCloser {
  finalizeAccountConnections(accountId: string, code: number, reason: string): Promise<void>;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  onboarding: OnboardingService,
  config: AppConfig,
  connections: AccountConnectionCloser,
  nativeAuthorization?: NativeAppAuthorization,
  apple?: AppleAuthService
): void {
  // Apple posts its callback as application/x-www-form-urlencoded. Keep the
  // parser local to the auth registration so JSON API contracts are unchanged.
  try {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      }
    );
  } catch {
    // The application may already have installed the parser in a test host.
  }

  if (apple) {
    app.get("/api/auth/apple/link/status", async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        const query = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(request.query);
        return { status: await apple.nativeLinkStatus(session.account.id, session.sessionId, query.state) };
      } catch (error) { sendAuthError(reply, error); }
    });
    app.get("/api/auth/apple/status", async () => ({ enabled: apple.enabled }));
    app.get("/api/auth/apple/start", async (request, reply) => {
      try {
        if (!apple.enabled) throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple login is not enabled", 404);
        const query = appleStartQuerySchema.parse(request.query);
        const device = await ensureDeviceCookie(request, reply, auth, config);
        const url = await apple.begin({
          intent: "signin",
          returnTo: query.return_to,
          deviceInstallationId: device.deviceInstallationId,
          networkHash: auth.networkHashForRequest(request.ip),
        });
        return reply.redirect(url);
      } catch (error) {
        sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/apple/link/start", { bodyLimit: 2_048 }, async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        const body = appleLinkBodySchema.parse(request.body ?? {});
        const rawToken = request.cookies[auth.sessionCookieName];
        if (!rawToken) throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
        const device = await ensureDeviceCookie(request, reply, auth, config);
        const url = await apple.begin({
          intent: "link",
          nativeReturn: body.nativeReturn === true && Boolean(body.nativeReturnState) && isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER]),
          ...(body.nativeReturnState ? { nativeReturnState:body.nativeReturnState } : {}),
          returnTo: body.returnTo,
          accountId: session.account.id,
          sessionId: session.sessionId,
          deviceInstallationId: device.deviceInstallationId,
          networkHash: auth.networkHashForRequest(request.ip)
        });
        return reply.code(200).send({ authorizationUrl: url });
      } catch (error) {
        sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/apple/callback", { bodyLimit: 4_100_000 }, async (request, reply) => {
      try {
        const body = appleCallbackBodySchema.parse(request.body);
        if (body.error) {
          let location: string;
          try {
            const cancellation = await apple.cancel(body.state, body.error);
            location = cancellation.nativeReturn && cancellation.nativeReturnState ? nativeAppleReturnUrl(cancellation.nativeReturnState, "cancelled") : safeAppleReturnUrl(
              config.APP_PUBLIC_ORIGIN,
              cancellation.returnPath,
              cancellation.outcome
            );
          } catch {
            // A replayed, expired, or otherwise invalid error callback has no
            // trusted transaction path left. Keep the provider browser out of
            // the JSON API surface and return to the fixed public fallback.
            location = safeAppleReturnUrl(
              config.APP_PUBLIC_ORIGIN,
              "/play/",
              "provider_error"
            );
          }
          return reply.code(303).header("location", location).send();
        }
        if (!body.code) throw new AuthError("INVALID_APPLE_LOGIN", "Apple login code is missing", 400);
        const device = await ensureDeviceCookie(request, reply, auth, config);
        const result = await apple.handleCallback({
          state: body.state,
          code: body.code,
          deviceInstallationId: device.deviceInstallationId,
          networkHash: auth.networkHashForRequest(request.ip),
          context: {
            ip: request.ip,
            userAgent: request.headers["user-agent"],
            deviceToken: device.deviceToken,
            existingSessionToken: request.cookies[auth.sessionCookieName] ?? null
          }
        });
        if (result.login) setAuthCookies(reply, auth, config, result.login);
        const location = result.kind === "link" && result.nativeReturn && result.nativeReturnState
          ? nativeAppleReturnUrl(result.nativeReturnState, "completed")
          : safeAppleReturnUrl(config.APP_PUBLIC_ORIGIN, result.returnPath);
        return reply.code(303).header("location", location).send();
      } catch (error) {
        if (error instanceof NativeAppleLinkFailure) return reply.code(303).header("location", nativeAppleReturnUrl(error.returnState, "failed")).send();
        sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/apple/notifications", { bodyLimit: 4_100_000 }, async (request, reply) => {
      try {
        const body = appleNotificationBodySchema.parse(request.body);
        await apple.handleNotification(body.signedPayload ?? body.payload!);
        return reply.code(200).send({ ok: true });
      } catch (error) {
        sendAuthError(reply, error);
      }
    });
    app.post("/api/auth/apple/disconnect", { bodyLimit: 1_024 }, async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        await apple.disconnect(session.account.id);
        return { ok: true };
      } catch (error) {
        sendAuthError(reply, error);
      }
    });
  }

  app.get("/api/auth/session", async (request, reply) => {
    try {
      await ensureDeviceCookie(
        request,
        reply,
        auth,
        config,
        isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])
      );
      const rawSessionToken = request.cookies[auth.sessionCookieName] ?? null;
      const session = await auth.authenticateSession(rawSessionToken);
      const response = await auth.sessionResponse(session, {
        nativeClient: isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])
      });
      if (
        nativeAuthorization &&
        session &&
        rawSessionToken &&
        isCapacitorNativeRequestHeader(request.headers[CAPACITOR_NATIVE_REQUEST_HEADER])
      ) {
        return {
          ...response,
          webSocketTicket: nativeAuthorization.issueWebSocketTicket(rawSessionToken)
        };
      }
      return response;
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post(
    "/api/auth/google",
    {
      config: {
        rateLimit: {
          max: config.AUTH_LOGIN_IP_MAX,
          timeWindow: "10 minutes"
        }
      },
      bodyLimit: 20_000
    },
    async (request, reply) => {
      try {
        auth.assertOrigin(request.headers.origin);
        const device = await ensureDeviceCookie(request, reply, auth, config);
        const body = googleLoginBodySchema.safeParse(request.body);
        if (!body.success) {
          throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 400);
        }
        const result = await auth.loginWithGoogle(
          body.data.credential,
          loginContext(request, auth, device.deviceToken)
        );
        setAuthCookies(reply, auth, config, result);
        return await auth.sessionResponse(result.session);
      } catch (error) {
        sendAuthError(reply, error);
      }
    }
  );

  const emailRateLimit = {
    config: {
      rateLimit: {
        max: config.AUTH_LOGIN_IP_MAX,
        timeWindow: "10 minutes"
      }
    },
    bodyLimit: 1_024
  };

  app.post("/api/auth/email/start", emailRateLimit, async (request, reply) => {
    try {
      auth.assertOrigin(request.headers.origin);
      const body = emailStartBodySchema.safeParse(request.body);
      if (!body.success) throw new AuthError("EMAIL_INVALID", "Enter a valid email address", 400);
      const device = await ensureDeviceCookie(request, reply, auth, config);
      const result = await auth.startEmailLogin(
        body.data.email,
        loginContext(request, auth, device.deviceToken)
      );
      return emailCodeIssuedResponse(result.resendAvailableAt, config);
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/email/verify", emailRateLimit, async (request, reply) => {
    try {
      auth.assertOrigin(request.headers.origin);
      const body = emailVerifyBodySchema.safeParse(request.body);
      if (!body.success) {
        throw new AuthError("EMAIL_CODE_INVALID", "That code is invalid or has expired", 400);
      }
      const device = await ensureDeviceCookie(request, reply, auth, config);
      const result = await auth.verifyEmailLogin(
        body.data,
        loginContext(request, auth, device.deviceToken)
      );
      setAuthCookies(reply, auth, config, result);
      return await auth.sessionResponse(result.session);
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/email/link/start", emailRateLimit, async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      const body = emailStartBodySchema.safeParse(request.body);
      if (!body.success) throw new AuthError("EMAIL_INVALID", "Enter a valid email address", 400);
      const result = await auth.startEmailLink(session, body.data.email, loginContext(request, auth));
      return emailCodeIssuedResponse(result.resendAvailableAt, config);
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/email/link/verify", emailRateLimit, async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      const body = emailVerifyBodySchema.safeParse(request.body);
      if (!body.success) {
        throw new AuthError("EMAIL_CODE_INVALID", "That code is invalid or has expired", 400);
      }
      await auth.verifyEmailLink(session, body.data, loginContext(request, auth));
      return { ok: true };
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post(
    "/api/auth/google/link",
    { ...emailRateLimit, bodyLimit: 20_000 },
    async (request, reply) => {
      try {
        const session = requireRequestSession(request);
        const body = googleLoginBodySchema.safeParse(request.body);
        if (!body.success) {
          throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 400);
        }
        await auth.linkGoogleIdentity(session, body.data.credential, loginContext(request, auth));
        return { ok: true };
      } catch (error) {
        sendAuthError(reply, error);
      }
    }
  );

  if (auth.developmentAuthEnabled) {
    app.post(
      "/api/auth/dev",
      {
        config: {
          rateLimit: {
            max: config.AUTH_LOGIN_IP_MAX,
            timeWindow: "10 minutes"
          }
        },
        bodyLimit: 1_024
      },
      async (request, reply) => {
        try {
          auth.assertOrigin(request.headers.origin);
          const device = await ensureDeviceCookie(request, reply, auth, config);
          const body = developmentLoginBodySchema.safeParse(request.body);
          if (!body.success || !isDevelopmentProfileKey(body.data.profile)) {
            throw new AuthError("INVALID_DEV_LOGIN", "Invalid development login", 400);
          }
          const result = await auth.loginAsDeveloper(
            body.data.profile,
            loginContext(request, auth, device.deviceToken)
          );
          let session = result.session;
          if (!session.player) {
            const preset = developmentProfile(
              body.data.profile,
              config.AUTH_DEV_ACCOUNT_EMAIL,
              config.AUTH_DEV_PLAYER_NAME
            );
            try {
              const player = await onboarding.complete(session, preset);
              session = { ...session, player };
            } catch {
              // Preset name taken or not allowed: fall back to the normal setup screen.
            }
          }
          setAuthCookies(reply, auth, config, result);
          return await auth.sessionResponse(session);
        } catch (error) {
          sendAuthError(reply, error);
        }
      }
    );
  }

  app.post("/api/account/onboarding", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      const body = onboardingBodySchema.safeParse(request.body);
      if (!body.success) {
        throw new AuthError("PLAYER_NAME_INVALID", "Invalid player setup", 400);
      }
      const player = await onboarding.complete(session, body.data);
      return {
        player: {
          id: player.id,
          displayName: player.displayName,
          personalFlagColor: player.personalFlagColor
        }
      };
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/logout", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      const rawToken = request.cookies[auth.sessionCookieName];
      if (!rawToken) {
        throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
      }
      await connections.finalizeAccountConnections(session.account.id, 4001, "logged out");
      await auth.logout(rawToken, session);
      clearSessionCookie(reply, auth, config);
      return { ok: true };
    } catch (error) {
      sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/logout-all", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const session = requireRequestSession(request);
      await connections.finalizeAccountConnections(
        session.account.id,
        4001,
        "all sessions revoked"
      );
      await auth.logoutAll(session);
      clearSessionCookie(reply, auth, config);
      return { ok: true };
    } catch (error) {
      sendAuthError(reply, error);
    }
  });
}

export function safeAppleReturnUrl(
  publicOrigin: string,
  returnPath: string,
  outcome?: "cancelled" | "provider_error"
): string {
  const origin = new URL(publicOrigin);
  let location: URL;
  try {
    location = new URL(returnPath, origin);
    if (location.origin !== origin.origin || !returnPath.startsWith("/") || returnPath.startsWith("//")) {
      location = new URL("/play/", origin);
    }
  } catch {
    location = new URL("/play/", origin);
  }
  if (outcome) location.searchParams.set("apple_auth", outcome);
  return location.toString();
}


function emailCodeIssuedResponse(resendAvailableAt: Date, config: AppConfig) {
  return {
    ok: true as const,
    resendAvailableAt: resendAvailableAt.getTime(),
    codeTtlSeconds: config.AUTH_EMAIL_CODE_TTL_SECONDS
  };
}

function loginContext(
  request: FastifyRequest,
  auth: AuthService,
  deviceTokenOverride?: string
): LoginRequestContext {
  return {
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    deviceToken: deviceTokenOverride ?? request.cookies[auth.deviceCookieName] ?? null,
    existingSessionToken: request.cookies[auth.sessionCookieName] ?? null
  };
}

async function ensureDeviceCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
  config: AppConfig,
  forceSecure = false
): Promise<{ deviceToken: string; deviceInstallationId: string }> {
  const result = await auth.ensureDeviceForRequest({
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    deviceToken: request.cookies[auth.deviceCookieName] ?? null
  });
  if (result.created) {
    reply.setCookie(auth.deviceCookieName, result.deviceToken, {
      ...baseCookieOptions(config, forceSecure),
      maxAge: 365 * 24 * 60 * 60
    });
  }
  return result;
}

export function setAuthCookies(
  reply: FastifyReply,
  auth: AuthService,
  config: AppConfig,
  result: Awaited<ReturnType<AuthService["loginWithGoogle"]>>,
  forceSecure = false
): void {
  reply.setCookie(auth.sessionCookieName, result.session.rawToken, {
    ...baseCookieOptions(config, forceSecure),
    expires: result.session.expiresAt
  });
  if (result.deviceTokenCreated) {
    reply.setCookie(auth.deviceCookieName, result.deviceToken, {
      ...baseCookieOptions(config, forceSecure),
      maxAge: 365 * 24 * 60 * 60
    });
  }
}

function clearSessionCookie(reply: FastifyReply, auth: AuthService, config: AppConfig): void {
  reply.clearCookie(auth.sessionCookieName, baseCookieOptions(config));
}

function baseCookieOptions(config: AppConfig, forceSecure = false) {
  return {
    httpOnly: true,
    secure: forceSecure || config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/"
  };
}
