import {
  PLAYER_PACKAGE_ADMIN_API_BASE,
  createPlayerPackageCampaignSchema,
  playerPackageCharacterSearchQuerySchema
} from "@ash-atlas/shared";
import type { FastifyInstance } from "fastify";

import type { AuthService } from "../auth/authService.js";
import type { PlayerPackageService } from "../game/playerPackages.js";
import { PlayerPackageError } from "../game/playerPackages.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";
import {
  authorizeDeveloperHttp,
  recordDeveloperHttpResult
} from "./routes/routeAuthentication.js";

export function registerPlayerPackageRoutes(
  app: FastifyInstance,
  auth: AuthService,
  packages: PlayerPackageService,
  registry: ConnectionRegistry,
  logger: AppLogger
): void {
  app.get(`${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`, {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request,
      reply,
      auth,
      "developer:packages-send",
      "packages.catalog"
    );
    if (!session) return;
    try {
      const [items, eligibleCharacterCount] = await Promise.all([
        Promise.resolve(packages.catalog()),
        packages.eligibleCharacterCount()
      ]);
      await recordDeveloperHttpResult(auth, session, {
        capability: "developer:packages-send",
        command: "packages.catalog",
        outcome: "succeeded"
      });
      return { items, eligibleCharacterCount };
    } catch (error) {
      await recordFailure(auth, session, "packages.catalog");
      packageRouteError(reply, error);
    }
  });

  app.get(`${PLAYER_PACKAGE_ADMIN_API_BASE}/characters`, {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request,
      reply,
      auth,
      "developer:packages-send",
      "packages.characters.search"
    );
    if (!session) return;
    try {
      const query = playerPackageCharacterSearchQuerySchema.safeParse(
        request.query
      );
      if (!query.success) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_SEARCH_INVALID",
          "Character search is invalid"
        );
      }
      const result = await packages.searchCharacters(
        query.data.search,
        query.data.limit,
        query.data.cursor
      );
      await recordDeveloperHttpResult(auth, session, {
        capability: "developer:packages-send",
        command: "packages.characters.search",
        outcome: "succeeded"
      });
      return result;
    } catch (error) {
      await recordFailure(auth, session, "packages.characters.search");
      packageRouteError(reply, error);
    }
  });

  app.get(`${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`, {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await authorizeDeveloperHttp(
      request,
      reply,
      auth,
      "developer:packages-send",
      "packages.campaigns.list"
    );
    if (!session) return;
    try {
      const campaigns = await packages.campaignHistory();
      await recordDeveloperHttpResult(auth, session, {
        capability: "developer:packages-send",
        command: "packages.campaigns.list",
        outcome: "succeeded"
      });
      return { campaigns };
    } catch (error) {
      await recordFailure(auth, session, "packages.campaigns.list");
      packageRouteError(reply, error);
    }
  });

  app.post(`${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`, {
    bodyLimit: 32_768,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const operationKey = operationKeyFromBody(request.body);
    const session = await authorizeDeveloperHttp(
      request,
      reply,
      auth,
      "developer:packages-send",
      "packages.campaigns.create",
      null,
      operationKey
    );
    if (!session) return;
    try {
      const body = createPlayerPackageCampaignSchema.safeParse(request.body);
      if (!body.success) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_SEND_INVALID",
          "Package request is invalid"
        );
      }
      if (!session.verifiedGoogleSubject) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_OWNER_IDENTITY_REQUIRED",
          "Verified owner identity is required",
          403
        );
      }
      const result = await packages.createCampaign({
        subject: session.verifiedGoogleSubject,
        playerId: session.player?.id ?? null
      }, body.data);
      if (!result.replayed) {
        result.recipientPlayerIds.forEach((playerId, index) => {
          const availablePackage = result.packages[index];
          if (availablePackage) {
            registry.send(playerId, {
              type: "PLAYER_PACKAGE_AVAILABLE",
              package: availablePackage
            });
          }
        });
      }
      await recordDeveloperHttpResult(auth, session, {
        capability: "developer:packages-send",
        command: "packages.campaigns.create",
        operationKey: body.data.operationKey,
        outcome: "succeeded"
      });
      return {
        campaignId: result.campaignId,
        recipientCount: result.recipientCount,
        packageCount: result.packageCount,
        replayed: result.replayed
      };
    } catch (error) {
      await recordFailure(
        auth,
        session,
        "packages.campaigns.create",
        operationKey
      );
      logger.warn(
        {
          err: error,
          operationKey
        },
        "player package campaign creation failed"
      );
      packageRouteError(reply, error);
    }
  });
}

async function recordFailure(
  auth: AuthService,
  session: Parameters<typeof recordDeveloperHttpResult>[1],
  command: string,
  operationKey: string | null = null
): Promise<void> {
  await recordDeveloperHttpResult(auth, session, {
    capability: "developer:packages-send",
    command,
    operationKey,
    outcome: "failed"
  });
}

function operationKeyFromBody(body: unknown): string | null {
  return body && typeof body === "object" && "operationKey" in body &&
    typeof body.operationKey === "string"
    ? body.operationKey
    : null;
}

function packageRouteError(
  reply: Parameters<typeof sendError>[0],
  error: unknown
): void {
  if (error instanceof PlayerPackageError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  sendError(
    reply,
    500,
    "PLAYER_PACKAGE_INTERNAL",
    "Package request could not be completed"
  );
}
