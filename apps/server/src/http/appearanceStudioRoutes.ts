import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  EQUIPMENT_DEFINITIONS
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AppearanceStudioAuthorization,
  AppearanceStudioAuthorizationError,
  isAppearanceStudioCallback
} from "../auth/appearanceStudioAuthorization.js";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import type { GameState } from "../game/state.js";

const authorizeQuerySchema = z.object({
  state: z.string().min(32).max(256),
  code_challenge: z.string().regex(/^[a-zA-Z0-9_-]{43}$/u),
  redirect_uri: z.string().refine(isAppearanceStudioCallback)
}).strict();

const exchangeBodySchema = z.object({
  code: z.string().min(32).max(256),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().refine(isAppearanceStudioCallback)
}).strict();

export function registerAppearanceStudioRoutes(
  app: FastifyInstance,
  auth: AuthService,
  config: AppConfig,
  gameState: GameState,
  authorization = new AppearanceStudioAuthorization()
): AppearanceStudioAuthorization {
  app.get("/api/developer/appearance-studio/authorize", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      const query = authorizeQuerySchema.parse(request.query);
      const session = request.authSession ?? null;
      await auth.authorizeDeveloperCommand(session, {
        capability: "developer:appearance-studio",
        command: "appearance-studio.authorize",
        transport: "http",
        target: session?.player?.id ?? null
      });
      if (!session) throw new AppearanceStudioAuthorizationError(401, "Login required");
      const issued = authorization.issueCode({
        session,
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge
      });
      await auth.recordDeveloperCommandResult(session, {
        capability: "developer:appearance-studio",
        command: "appearance-studio.authorize",
        transport: "http",
        target: session.player?.id ?? null,
        outcome: "succeeded"
      });
      const callback = new URL(query.redirect_uri);
      callback.searchParams.set("code", issued.code);
      callback.searchParams.set("state", query.state);
      reply.redirect(callback.toString());
    } catch (error) {
      sendStudioError(reply, error);
    }
  });

  app.post("/api/developer/appearance-studio/token", {
    bodyLimit: 2_048,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      return authorization.exchange(exchangeBodySchema.parse(request.body));
    } catch (error) {
      sendStudioError(reply, error);
    }
  });

  app.get("/api/developer/appearance-studio/info", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      const studio = authorization.authenticate(bearerToken(request));
      return {
        serverSha: config.RUNTIME_SHA ?? null,
        catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
        compatibility: {
          schemaVersion: DEFAULT_PLAYER_APPEARANCE_CATALOG.schemaVersion,
          minimumStudioVersion: 1
        },
        equipmentDefinitions: Object.values(EQUIPMENT_DEFINITIONS).map((definition) => ({
          definitionId: definition.definitionId,
          displayName: definition.displayName,
          slot: definition.slot,
          category: definition.category
        })),
        bodyVariants: DEFAULT_PLAYER_APPEARANCE_CATALOG.bodyVariants.map(
          (body) => body.bodyVariantId
        ),
        poses: [...new Set(DEFAULT_PLAYER_APPEARANCE_CATALOG.bodyVariants.flatMap(
          (body) => body.poses.map((pose) => pose.poseId)
        ))],
        appearance: gameState.getPlayer(studio.playerId)?.appearance ?? null
      };
    } catch (error) {
      sendStudioError(reply, error);
    }
  });

  app.post("/api/developer/appearance-studio/revoke", {
    bodyLimit: 1,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    try {
      const token = bearerToken(request);
      authorization.authenticate(token);
      authorization.revoke(token);
      return { revoked: true };
    } catch (error) {
      sendStudioError(reply, error);
    }
  });
  return authorization;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/u.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function sendStudioError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown
): void {
  const statusCode = error instanceof AppearanceStudioAuthorizationError
    ? error.statusCode
    : error instanceof z.ZodError
      ? 400
      : 403;
  reply.code(statusCode).send({
    error: error instanceof Error ? error.message : "Appearance Studio authorization failed"
  });
}
