import {
  PROFILE_API_CONTRACT_HEADER,
  PROFILE_API_CONTRACT_VERSION,
  SOCIAL_LIST_KINDS,
  profileTargetPlayerIdSchema,
  profileTextUpdateSchema,
  recentPlayersQuerySchema,
  socialListQuerySchema,
  socialMutationRequestSchema,
  type PublicProfile,
  type SocialAction
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import type { AppConfig } from "../config.js";
import {
  ProfileSocialError,
  type ExpiredNeutralityRequest,
  type ProfileSocialService
} from "../game/profiles.js";
import { RecentPlayersError, type RecentPlayersService } from "../game/recentPlayers.js";
import type { GameState } from "../game/state.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";

const profileParamsSchema = z.object({ playerId: profileTargetPlayerIdSchema }).strict();
const listParamsSchema = z.object({ kind: z.enum(SOCIAL_LIST_KINDS) }).strict();
const playerListParamsSchema = z.object({
  playerId: profileTargetPlayerIdSchema,
  kind: z.enum(["friends", "enemies"])
}).strict();

type ActionRateGroup = "friend_send" | "friend_state" | "enemy" | "block";

export class SocialActionRateGate {
  private readonly requests = new Map<string, { timestamps: number[]; touchedAt: number }>();
  private lastSweepAt = 0;

  constructor(
    private readonly maximumKeys = 50_000,
    private readonly sweepIntervalMs = 60_000
  ) {}

  consume(playerId: string, group: ActionRateGroup, maximum: number, windowMs: number): boolean {
    const now = Date.now();
    if (now - this.lastSweepAt >= this.sweepIntervalMs) {
      this.sweep(now, windowMs);
    }
    const key = `${playerId}:${group}`;
    const existing = this.requests.get(key);
    const recent = (existing?.timestamps ?? []).filter((timestamp) => timestamp > now - windowMs);
    if (recent.length >= maximum) {
      this.requests.set(key, { timestamps: recent, touchedAt: now });
      return false;
    }
    if (!existing && this.requests.size >= this.maximumKeys) {
      this.evictOldest();
    }
    recent.push(now);
    this.requests.set(key, { timestamps: recent, touchedAt: now });
    return true;
  }

  size(): number {
    return this.requests.size;
  }

  private sweep(now: number, windowMs: number): void {
    this.lastSweepAt = now;
    for (const [key, bucket] of this.requests) {
      if (bucket.touchedAt <= now - windowMs) this.requests.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.requests) {
      if (bucket.touchedAt < oldestTimestamp) {
        oldestKey = key;
        oldestTimestamp = bucket.touchedAt;
      }
    }
    if (oldestKey) this.requests.delete(oldestKey);
  }
}

export function registerProfileRoutes(
  app: FastifyInstance,
  service: ProfileSocialService,
  config: AppConfig,
  connections: ConnectionRegistry,
  actionGate = new SocialActionRateGate(),
  recentPlayers?: RecentPlayersService,
  gameState?: GameState
): void {
  void gameState;
  app.get(
    "/api/profile/me",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.PROFILE_LOOKUP_RATE_MAX,
        "1 minute",
        "profile-lookup"
      )
    },
    async (request, reply) => {
      try {
        const playerId = authenticatedPlayerId(request);
        return profileResponse(request, await service.getProfile(playerId, playerId));
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  app.get(
    "/api/profile/:playerId",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.PROFILE_LOOKUP_RATE_MAX,
        "1 minute",
        "profile-lookup"
      )
    },
    async (request, reply) => {
      try {
        const params = profileParamsSchema.safeParse(request.params);
        if (!params.success) throw new ProfileSocialError("BAD_PLAYER_ID", "Invalid player id", 400);
        return profileResponse(
          request,
          await service.getProfile(authenticatedPlayerId(request), params.data.playerId)
        );
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  app.patch(
    "/api/profile/me",
    {
      bodyLimit: 4_096,
      preHandler: authenticatedRateLimit(
        app,
        config.PROFILE_EDIT_RATE_MAX,
        "10 minutes",
        "profile-edit"
      )
    },
    async (request, reply) => {
      try {
        const body = profileTextUpdateSchema.safeParse(request.body);
        if (!body.success) throw new ProfileSocialError("INVALID_PROFILE_UPDATE", "Invalid profile update", 400);
        const playerId = authenticatedPlayerId(request);
        const profile = await service.updateProfile(playerId, body.data);
        return profileResponse(request, profile);
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  app.post(
    "/api/social/relationship",
    {
      bodyLimit: 2_048,
      preHandler: authenticatedRateLimit(
        app,
        config.SOCIAL_RELATIONSHIP_RATE_MAX,
        "10 minutes",
        "social-relationship"
      )
    },
    async (request, reply) => {
      try {
        const body = socialMutationRequestSchema.safeParse(request.body);
        if (!body.success) throw new ProfileSocialError("INVALID_SOCIAL_ACTION", "Invalid social action", 400);
        const actorId = authenticatedPlayerId(request);
        const [group, maximum] = actionLimit(body.data.action, config);
        if (!actionGate.consume(actorId, group, maximum, 10 * 60_000)) {
          throw new ProfileSocialError("SOCIAL_RATE_LIMITED", "Too many social actions; try again later", 429);
        }
        let changed = false;
        const profile = await service.mutate(
          actorId,
          body.data.targetPlayerId,
          body.data.action,
          (didChange) => { changed = didChange; }
        );
        const bilateral = isBilateralSocialAction(body.data.action);
        if (shouldNotifyTarget(body.data.action) && (!bilateral || changed)) {
          const notification = socialNotification(
            body.data.action,
            authenticatedPlayerDisplayName(request)
          );
          connections.send(body.data.targetPlayerId, {
            type: "SOCIAL_STATE_CHANGED",
            playerId: actorId,
            ...(notification ? { message: notification } : {})
          });
        }
        if (bilateral && changed) {
          connections.send(actorId, {
            type: "SOCIAL_STATE_CHANGED",
            playerId: body.data.targetPlayerId
          });
        }
        return profileResponse(request, profile);
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  if (recentPlayers) app.get(
    "/api/social/recent",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.SOCIAL_LIST_RATE_MAX,
        "1 minute",
        "recent-players"
      )
    },
    async (request, reply) => {
      try {
        const query = recentPlayersQuerySchema.safeParse(request.query);
        if (!query.success) {
          throw new RecentPlayersError("INVALID_RECENT_PLAYERS", "Invalid recent players request", 400);
        }
        return await recentPlayers.list(
          authenticatedPlayerId(request),
          query.data.limit
        );
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  if (recentPlayers) app.get(
    "/api/social/player/:playerId",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.PROFILE_LOOKUP_RATE_MAX,
        "1 minute",
        "social-player-summary"
      )
    },
    async (request, reply) => {
      try {
        const params = profileParamsSchema.safeParse(request.params);
        if (!params.success) throw new RecentPlayersError("BAD_PLAYER_ID", "Invalid player id", 400);
        return {
          player: await recentPlayers.summary(
            authenticatedPlayerId(request),
            params.data.playerId
          )
        };
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  app.get(
    "/api/social/inbox",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.SOCIAL_LIST_RATE_MAX,
        "1 minute",
        "social-inbox"
      )
    },
    async (request, reply) => {
      try {
        return await service.inbox(authenticatedPlayerId(request));
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  app.get(
    "/api/social/lists/:kind",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.SOCIAL_LIST_RATE_MAX,
        "1 minute",
        "social-list"
      )
    },
    async (request, reply) => {
      try {
        const params = listParamsSchema.safeParse(request.params);
        const query = socialListQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) {
          throw new ProfileSocialError("INVALID_SOCIAL_LIST", "Invalid social list request", 400);
        }
        return await service.list(
          authenticatedPlayerId(request),
          params.data.kind,
          query.data.offset,
          query.data.limit
        );
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );

  app.get(
    "/api/social/player/:playerId/lists/:kind",
    {
      preHandler: authenticatedRateLimit(
        app,
        config.SOCIAL_LIST_RATE_MAX,
        "1 minute",
        "social-player-list"
      )
    },
    async (request, reply) => {
      try {
        const params = playerListParamsSchema.safeParse(request.params);
        const query = socialListQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) {
          throw new ProfileSocialError("INVALID_SOCIAL_LIST", "Invalid social list request", 400);
        }
        return await service.listForPlayer(
          authenticatedPlayerId(request),
          params.data.playerId,
          params.data.kind,
          query.data.offset,
          query.data.limit
        );
      } catch (error) {
        sendProfileError(reply, error);
      }
    }
  );
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new ProfileSocialError("PLAYER_REQUIRED", "Player onboarding is required", 409);
  return session.player.id;
}

function profileResponse(
  request: FastifyRequest,
  profile: PublicProfile
): { profile: PublicProfile } {
  if (request.headers[PROFILE_API_CONTRACT_HEADER] === PROFILE_API_CONTRACT_VERSION) {
    return { profile };
  }
  const legacyProfile = structuredClone(profile);
  delete legacyProfile.appearance;
  return { profile: legacyProfile };
}

function authenticatedPlayerDisplayName(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new ProfileSocialError("PLAYER_REQUIRED", "Player onboarding is required", 409);
  return session.player.displayName;
}

function authenticatedRateLimit(
  app: FastifyInstance,
  maximum: number,
  timeWindow: string,
  groupId: string
) {
  return app.rateLimit({
    max: maximum,
    timeWindow,
    groupId,
    keyGenerator: (request: FastifyRequest) => `player:${authenticatedPlayerId(request)}`
  });
}

function actionLimit(action: SocialAction, config: AppConfig): [ActionRateGroup, number] {
  if (action === "send_friend_request") return ["friend_send", config.FRIEND_REQUEST_SEND_RATE_MAX];
  if (action === "mark_enemy" || action.endsWith("_neutrality")) {
    return ["enemy", config.ENEMY_MARK_RATE_MAX];
  }
  if (action === "block" || action === "unblock") return ["block", config.BLOCK_RATE_MAX];
  return ["friend_state", config.FRIEND_STATE_RATE_MAX];
}

function shouldNotifyTarget(action: SocialAction): boolean {
  return !["block", "unblock"].includes(action);
}

function isBilateralSocialAction(action: SocialAction): boolean {
  return action === "mark_enemy" || action.endsWith("_neutrality");
}

function socialNotification(action: SocialAction, actorDisplayName: string): string | null {
  switch (action) {
    case "mark_enemy":
      return `${actorDisplayName} declared you an enemy.`;
    case "request_neutrality":
      return `${actorDisplayName} has requested neutrality.`;
    case "accept_neutrality":
      return `${actorDisplayName} accepted your neutrality request. You are now neutral.`;
    case "reject_neutrality":
      return `${actorDisplayName} rejected your neutrality request. You remain enemies.`;
    case "cancel_neutrality":
      return `${actorDisplayName} canceled the neutrality request. You remain enemies.`;
    default:
      return null;
  }
}

export function publishExpiredNeutralityRequests(
  connections: ConnectionRegistry,
  expired: readonly ExpiredNeutralityRequest[]
): void {
  for (const request of expired) {
    const message = "Neutrality request expired. You remain enemies.";
    connections.send(request.playerLowId, {
      type: "SOCIAL_STATE_CHANGED",
      playerId: request.playerHighId,
      message
    });
    connections.send(request.playerHighId, {
      type: "SOCIAL_STATE_CHANGED",
      playerId: request.playerLowId,
      message
    });
  }
}

function sendProfileError(reply: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof ProfileSocialError || error instanceof RecentPlayersError) {
    sendError(reply, error.statusCode, error.code, error.message);
    return;
  }
  sendError(reply, 500, "PROFILE_SERVICE_ERROR", "Profile service unavailable");
}
