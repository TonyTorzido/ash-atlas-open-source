import {
  distanceMeters,
  foundKingdomInputSchema,
  kingdomAdvancementProjectCancelSchema,
  kingdomAdvancementProjectStartSchema,
  kingdomCancelInvitationSchema,
  kingdomCotMutationInputSchema,
  kingdomDecorationMutationInputSchema,
  kingdomDecorationPlacementInputSchema,
  kingdomDonationInputSchema,
  kingdomBrickDepositInputSchema,
  kingdomBrickFurnacePackageInputSchema,
  kingdomBrickFurnaceUpgradeInputSchema,
  kingdomWarStructurePlaceInputSchema,
  kingdomStructureDowngradeInputSchema,
  kingdomCommandBoardUpgradeInputSchema,
  kingdomFlagConversionInputSchema,
  kingdomFlagRemovalInputSchema,
  kingdomIdentityInputSchema,
  kingdomInvitationResponseSchema,
  kingdomInviteInputSchema,
  kingdomMemberActionSchema,
  kingdomMuteInputSchema,
  kingdomPerkActivateInputSchema,
  kingdomPerkChooseInputSchema,
  kingdomPlacementInputSchema,
  kingdomRevoltVoteInputSchema,
  kingdomSimpleActionSchema,
  type KingdomStateSnapshot,
  type KingdomSpatialWireChange
} from "@ash-atlas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireRequestSession } from "../auth/authGuard.js";
import type { AppConfig } from "../config.js";
import { flagSetRevisionMetadata, type FlagService } from "../game/flags.js";
import { publishBrokenFlags } from "../realtime/territoryCollapsePublisher.js";
import { KingdomBrickEconomyError } from "../game/kingdomBrickEconomy.js";
import {
  KingdomError,
  type KingdomErrorCode,
  type KingdomAdvancementProjectCancelInput,
  type KingdomAdvancementProjectStartInput,
  type FoundKingdomInput,
  type KingdomCotMutationInput,
  type KingdomDecorationMutationInput,
  type KingdomDonationInput,
  type KingdomIdentityInput,
  type KingdomMutationResult,
  type KingdomSpatialChange,
  type KingdomService
} from "../game/kingdoms.js";
import type { GameState, PlayerRecord } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import type { ChatRealtimeCoordinator } from "../chat/chatRealtime.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";

const kingdomIdParamsSchema = z.object({ kingdomId: z.string().uuid() }).strict();
const kingdomFlagParamsSchema = z.object({ flagId: z.string().uuid() }).strict();

export function registerKingdomRoutes(
  app: FastifyInstance,
  service: KingdomService,
  flags: FlagService,
  gameState: GameState,
  connections: ConnectionRegistry,
  logger: AppLogger,
  config: AppConfig,
  refreshPlayerStats: (playerIds: string[]) => Promise<void> = async () => {},
  chats?: ChatRealtimeCoordinator
): void {
  const rateGate = new KingdomRouteRateGate();
  const notifyPlayers = async (
    targetConnections: ConnectionRegistry,
    state: KingdomStateSnapshot | null,
    extraPlayerIds: string[],
    profileChanged = false
  ): Promise<void> => {
    const playerIds = statePlayerIds(state, extraPlayerIds);
    notifyKingdomPlayers(targetConnections, state, extraPlayerIds, profileChanged);
    await Promise.all(playerIds.map((playerId) => chats?.refreshAuthorizedPlayer(playerId)));
  };
  const notifyExactPlayers = async (
    targetConnections: ConnectionRegistry,
    playerIds: string[],
    profileChanged = false
  ): Promise<void> => {
    notifyExactKingdomPlayers(targetConnections, playerIds, profileChanged);
    await Promise.all([...new Set(playerIds)].map((playerId) => chats?.refreshAuthorizedPlayer(playerId)));
  };
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || !request.url.startsWith("/api/kingdom/")) return;
    const playerId = authenticatedPlayerId(request);
    const quote = request.url.startsWith("/api/kingdom/founding-quote");
    const maximum = quote ? config.KINGDOM_FOUNDING_QUOTE_RATE_MAX : config.KINGDOM_MUTATION_RATE_MAX;
    if (rateGate.consume(playerId, quote ? "quote" : "mutation", maximum,
      config.KINGDOM_MUTATION_RATE_WINDOW_SECONDS * 1_000)) return;
    sendError(reply, 429, "KINGDOM_RATE_LIMITED", "Kingdom operation rate limit exceeded");
    return reply;
  });
  app.get("/api/kingdom/state", async (request, reply) => {
    try {
      const player = connectedPlayer(request, gameState, false);
      return { state: await service.getState(player ?? authenticatedPlayerId(request)) };
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.get("/api/kingdom/flags/:flagId/eligibility", async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const { flagId } = parseBody(kingdomFlagParamsSchema, request.params);
      return { eligibility: await service.getKingdomFlagEligibility(actorId, flagId) };
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.get("/api/kingdom/flags/:flagId/removal-preview", async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const { flagId } = parseBody(kingdomFlagParamsSchema, request.params);
      return { preview: await service.getKingdomFlagRemovalPreview(actorId, flagId) };
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/flags/convert", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomFlagConversionInputSchema, request.body);
      const result = await service.convertKingdomFlag(actorId, body);
      await runPostCommit(logger, "convert Kingdom flag", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [], "transformed")
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/flags/remove", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomFlagRemovalInputSchema, request.body);
      const result = await service.removeKingdomFlag(actorId, body);
      await runPostCommit(logger, "remove Kingdom flag", actorId, [
        () => notifyPlayers(connections, result.state, [actorId, ...(result.notificationPlayerIds ?? [])]),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.get("/api/kingdom/:kingdomId", async (request, reply) => {
    try {
      authenticatedPlayerId(request);
      const { kingdomId } = parseBody(kingdomIdParamsSchema, request.params);
      return { kingdom: await service.getPublicKingdom(kingdomId) };
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/founding-quote", { bodyLimit: 4_096 }, async (request, reply) => {
    try {
      const body = parseBody(foundKingdomInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      return {
        foundingQuote: {
          requestId: body.requestId,
          ...(await service.quoteFounding(player, body))
        }
      };
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/found", { bodyLimit: 4_096 }, async (request, reply) => {
    try {
      const body = parseBody(foundKingdomInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      const input: FoundKingdomInput = {
        requestId: body.requestId,
        ...(body.sourceFlagId !== undefined ? { sourceFlagId: body.sourceFlagId } : {}),
        displayName: body.displayName,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.emblemKey !== undefined ? { emblemKey: body.emblemKey } : {}),
        ...(body.displayColor !== undefined ? { displayColor: body.displayColor } : {})
      };
      const result = await service.foundKingdom(player, input);
      await runPostCommit(logger, "found", player.playerId, [
        () => notifyPlayers(connections, result.state, [player.playerId], true),
        () => sendInventorySnapshot(connections, service, player.playerId),
        () => refreshPlayerStats(statePlayerIds(result.state, [player.playerId])),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/invite", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomInviteInputSchema, request.body);
      const result = await service.invitePlayer(actorId, body);
      await runPostCommit(logger, "invite", actorId, [
        () => notifyExactPlayers(connections, result.notificationPlayerIds ?? [], true)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/invitation/respond", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomInvitationResponseSchema, request.body);
      const result = await service.respondToInvitation(actorId, body);
      await runPostCommit(logger, "respond invitation", actorId, [
        () => notifyExactPlayers(connections, result.notificationPlayerIds ?? [], true),
        () => refreshPlayerStats(statePlayerIds(result.state, [actorId])),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/invitation/cancel", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomCancelInvitationSchema, request.body);
      const result = await service.cancelInvitation(actorId, body);
      await runPostCommit(logger, "cancel invitation", actorId, [
        () => notifyExactPlayers(connections, result.notificationPlayerIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/member/action", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomMemberActionSchema, request.body);
      const result = await service.memberAction(actorId, body);
      await runPostCommit(logger, `member ${body.action}`, actorId, [
        () => notifyPlayers(connections, result.state, [actorId, body.targetPlayerId], true),
        () => refreshPlayerStats(statePlayerIds(result.state, [actorId, body.targetPlayerId])),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/leave", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const before = await service.getState(actorId);
      const body = parseBody(kingdomSimpleActionSchema, request.body);
      const result = await service.leaveKingdom(actorId, body.requestId);
      const affected = [actorId, ...before.roster.map(({ playerId }) => playerId)];
      await runPostCommit(logger, "leave", actorId, [
        () => notifyPlayers(connections, result.state, affected, true),
        () => refreshPlayerStats(statePlayerIds(result.state, affected)),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/identity", { bodyLimit: 4_096 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomIdentityInputSchema, request.body);
      const input: KingdomIdentityInput = {
        requestId: body.requestId,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.emblemKey !== undefined ? { emblemKey: body.emblemKey } : {}),
        ...(body.displayColor !== undefined ? { displayColor: body.displayColor } : {})
      };
      const result = await service.updateIdentity(actorId, input);
      await runPostCommit(logger, "identity", actorId, [
        () => notifyPlayers(connections, result.state, [actorId], true),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/mute", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomMuteInputSchema, request.body);
      const result = await service.muteMember(actorId, body);
      await runPostCommit(logger, "mute", actorId, [
        () => notifyPlayers(connections, result.state, [actorId, body.targetPlayerId])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/donate", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomDonationInputSchema, request.body);
      const input: KingdomDonationInput = {
        requestId: body.requestId,
        resourceType: body.resourceType,
        quantity: body.quantity,
        ...(body.variant !== undefined ? { variant: body.variant } : {})
      };
      const result = await service.donate(actorId, input);
      await runPostCommit(logger, "donate", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => sendInventorySnapshot(connections, service, actorId),
        () => refreshPlayerStats(statePlayerIds(result.state, [actorId])),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/bricks/deposit", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomBrickDepositInputSchema, request.body);
      const result = await service.depositBricks(actorId, body);
      await runPostCommit(logger, "deposit bricks", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => sendInventorySnapshot(connections, service, actorId)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/revolt/start", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomSimpleActionSchema, request.body);
      const result = await service.startRevolt(actorId, body.requestId);
      await runPostCommit(logger, "revolt start", actorId, [
        () => notifyPlayers(connections, result.state, [actorId], true)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/revolt/vote", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomRevoltVoteInputSchema, request.body);
      const result = await service.voteRevolt(actorId, body);
      await runPostCommit(logger, "revolt vote", actorId, [
        () => notifyPlayers(connections, result.state, [actorId], true)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/furnace/upgrade", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomBrickFurnaceUpgradeInputSchema, request.body);
      const result = await service.upgradeBrickFurnace(actorId, body);
      await runPostCommit(logger, "upgrade brick furnace", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => sendInventorySnapshot(connections, service, actorId)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/command-board/upgrade", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomCommandBoardUpgradeInputSchema, request.body);
      const result = await service.upgradeCommandBoard(actorId, body);
      await runPostCommit(logger, "upgrade command board", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => sendInventorySnapshot(connections, service, actorId)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  // The leader takes a Kingdom Tower, Obelisk, Brick Furnace or Command Board down
  // one level; the treasury gets 45% of that step's materials back.
  app.post("/api/kingdom/structure/downgrade", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomStructureDowngradeInputSchema, request.body);
      if (body.structure === "kingdom_tower" || body.structure === "obelisk") {
        const downgraded = await flags.downgradeKingdomStructure(
          actorId, body.flagId!, body.structure, body.fromLevel, body.requestId
        );
        const state = await service.getState(actorId);
        await runPostCommit(logger, "downgrade kingdom structure", actorId, [
          () => notifyPlayers(connections, state, [actorId]),
          () => publishFlagUpdates(flags, connections, [downgraded.flag.id])
        ]);
        return { state, stateRefreshRequired: false, quote: null, replayed: downgraded.replayed, flag: downgraded.flag };
      }
      const result = await service.downgradeKingdomFacility(actorId, body);
      await runPostCommit(logger, "downgrade kingdom facility", actorId, [
        () => notifyPlayers(connections, result.state, [actorId])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  // A member raises a War Tower or War Outpost at their live position.
  app.post("/api/kingdom/war-structure/place", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const body = parseBody(kingdomWarStructurePlaceInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      const placed = await flags.placeKingdomWarStructure(
        { playerId: player.playerId, lat: player.position.lat, lon: player.position.lon },
        body
      );
      const state = await service.getState(player.playerId);
      await runPostCommit(logger, "place war structure", player.playerId, [
        () => notifyPlayers(connections, state, [player.playerId]),
        () => sendInventorySnapshot(connections, service, player.playerId),
        () => publishFlagUpdates(flags, connections, [placed.flag.id])
      ]);
      return { state, flag: placed.flag, replayed: placed.replayed };
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/furnace/package", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomBrickFurnacePackageInputSchema, request.body);
      const result = await service.buyBrickFurnacePackage(actorId, body);
      await runPostCommit(logger, "buy brick furnace package", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => sendInventorySnapshot(connections, service, actorId)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/perks/choose", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomPerkChooseInputSchema, request.body);
      const result = await service.chooseKingdomPerk(actorId, body);
      await runPostCommit(logger, "choose kingdom perk", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => refreshPlayerStats(statePlayerIds(result.state, [actorId]))
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/perks/activate", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomPerkActivateInputSchema, request.body);
      const result = await service.activateKingdomPerk(actorId, body);
      await runPostCommit(logger, "activate kingdom perk", actorId, [
        () => notifyPlayers(connections, result.state, [actorId]),
        () => refreshPlayerStats(statePlayerIds(result.state, [actorId]))
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/project/start", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomAdvancementProjectStartSchema, request.body);
      const input: KingdomAdvancementProjectStartInput = {
        requestId: body.requestId,
        targetLevel: body.targetLevel
      };
      const result = await service.startAdvancementProject(actorId, input);
      await runPostCommit(logger, "start advancement project", actorId, [
        () => notifyPlayers(
          connections,
          result.state,
          result.notificationPlayerIds ?? [actorId]
        ),
        () => refreshPlayerStats(statePlayerIds(result.state, [actorId]))
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/project/cancel", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomAdvancementProjectCancelSchema, request.body);
      const input: KingdomAdvancementProjectCancelInput = {
        requestId: body.requestId,
        projectId: body.projectId
      };
      const result = await service.cancelAdvancementProject(actorId, input);
      await runPostCommit(logger, "cancel advancement project", actorId, [
        () => notifyPlayers(
          connections,
          result.state,
          result.notificationPlayerIds ?? [actorId]
        )
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/cot", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const body = parseBody(kingdomPlacementInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      const result = await service.placeCot(player, body);
      await runPostCommit(logger, "place cot", player.playerId, [
        () => notifyPlayers(connections, result.state, [player.playerId]),
        () => sendInventorySnapshot(connections, service, player.playerId),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/cot/action", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const body = parseBody(kingdomCotMutationInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      const input: KingdomCotMutationInput = {
        requestId: body.requestId,
        cotId: body.cotId,
        action: body.action,
        ...(body.rotation !== undefined ? { rotation: body.rotation } : {})
      };
      const result = await service.mutateCot(player, input);
      await runPostCommit(logger, `cot ${body.action}`, player.playerId, [
        () => notifyPlayers(connections, result.state, [player.playerId]),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/decoration", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const body = parseBody(kingdomDecorationPlacementInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      const result = await service.placeDecoration(player, body);
      await runPostCommit(logger, "place decoration", player.playerId, [
        () => notifyPlayers(connections, result.state, [player.playerId]),
        () => sendInventorySnapshot(connections, service, player.playerId),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/decoration/action", { bodyLimit: 2_048 }, async (request, reply) => {
    try {
      const body = parseBody(kingdomDecorationMutationInputSchema, request.body);
      const player = connectedPlayer(request, gameState, true)!;
      const input: KingdomDecorationMutationInput = {
        requestId: body.requestId,
        decorationId: body.decorationId,
        action: body.action,
        ...(body.rotation !== undefined ? { rotation: body.rotation } : {})
      };
      const result = await service.mutateDecoration(player, input);
      await runPostCommit(logger, `decoration ${body.action}`, player.playerId, [
        () => notifyPlayers(connections, result.state, [player.playerId]),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM)
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  // The leader rebuilds a Castle lying in rubble for the founding cost.
  app.post("/api/kingdom/castle/rebuild", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const body = parseBody(kingdomSimpleActionSchema, request.body);
      const result = await service.rebuildCastle(actorId, body.requestId);
      const affected = [actorId, ...(result.notificationPlayerIds ?? [])];
      await runPostCommit(logger, "rebuild castle", actorId, [
        () => notifyPlayers(connections, result.state, affected),
        () => refreshPlayerStats(statePlayerIds(result.state, affected)),
        () => sendInventorySnapshot(connections, service, actorId),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });

  app.post("/api/kingdom/dissolve", { bodyLimit: 1_024 }, async (request, reply) => {
    try {
      const actorId = authenticatedPlayerId(request);
      const before = await service.getState(actorId);
      const body = parseBody(kingdomSimpleActionSchema, request.body);
      const result = await service.dissolveKingdom(actorId, body.requestId);
      const affected = [actorId, ...before.roster.map(({ playerId }) => playerId)];
      await runPostCommit(logger, "dissolve", actorId, [
        () => notifyPlayers(connections, result.state, affected, true),
        () => refreshPlayerStats(statePlayerIds(result.state, affected)),
        () => deliverKingdomSpatialChanges(
          result.spatialChanges ?? [], gameState, connections, service.spatialInterestRadiusM),
        () => publishFlagUpdates(flags, connections, result.affectedFlagIds ?? [])
      ]);
      return publicMutationResult(result);
    } catch (error) {
      sendKingdomError(reply, error, logger);
    }
  });
}

export class KingdomRouteRateGate {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private lastSweepAt = 0;

  consume(
    playerId: string,
    bucket: string,
    maximum: number,
    windowMs: number,
    now = Date.now()
  ): boolean {
    const key = `${playerId}:${bucket}`;
    if (now - this.lastSweepAt >= windowMs) {
      for (const [entryKey, entry] of this.windows) {
        if (now - entry.startedAt >= windowMs) this.windows.delete(entryKey);
      }
      this.lastSweepAt = now;
    }
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= maximum) return false;
    current.count += 1;
    return true;
  }

  sizeForTests(): number {
    return this.windows.size;
  }
}

function authenticatedPlayerId(request: FastifyRequest): string {
  const session = requireRequestSession(request);
  if (!session.player) throw new KingdomError("KINGDOM_PLAYER_REQUIRED", "Player onboarding is required");
  return session.player.id;
}

function connectedPlayer(
  request: FastifyRequest,
  gameState: GameState,
  required: boolean
): PlayerRecord | null {
  const playerId = authenticatedPlayerId(request);
  const player = gameState.getPlayer(playerId) ?? null;
  if (!player && required) {
    throw new KingdomError(
      "KINGDOM_LIVE_POSITION_REQUIRED",
      "Connect to the game before performing this Kingdom placement action"
    );
  }
  return player;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new KingdomError("KINGDOM_INVALID_REQUEST", "Invalid Kingdom request");
  return parsed.data;
}

function notifyKingdomPlayers(
  connections: ConnectionRegistry,
  state: KingdomStateSnapshot | null,
  extraPlayerIds: string[],
  profileChanged = false
): void {
  const playerIds = new Set([
    ...extraPlayerIds,
    ...(state?.roster ?? []).filter(({ status }) => status === "active").map(({ playerId }) => playerId)
  ]);
  for (const playerId of playerIds) {
    connections.send(playerId, { type: "KINGDOM_STATE_CHANGED", playerId });
    if (profileChanged) connections.send(playerId, { type: "SOCIAL_STATE_CHANGED", playerId });
  }
}

export async function sendInventorySnapshot(
  connections: ConnectionRegistry,
  service: KingdomService,
  playerId: string
): Promise<void> {
  connections.send(playerId, {
    type: "PLAYER_RESOURCES_UPDATED",
    playerId,
    inventory: await service.inventorySnapshot(playerId),
    serverTime: Date.now()
  });
}

function notifyExactKingdomPlayers(
  connections: ConnectionRegistry,
  playerIds: string[],
  profileChanged = false
): void {
  for (const playerId of new Set(playerIds)) {
    connections.send(playerId, { type: "KINGDOM_STATE_CHANGED", playerId });
    if (profileChanged) connections.send(playerId, { type: "SOCIAL_STATE_CHANGED", playerId });
  }
}

function statePlayerIds(state: KingdomStateSnapshot | null, extraPlayerIds: string[]): string[] {
  return [...new Set([
    ...extraPlayerIds,
    ...(state?.roster ?? []).filter(({ status }) => status === "active").map(({ playerId }) => playerId)
  ])];
}

export function deliverKingdomSpatialChanges(
  changes: KingdomSpatialChange[],
  gameState: GameState,
  connections: ConnectionRegistry,
  interestRadiusM: number
): void {
  for (const record of connections.records()) {
    const player = gameState.getPlayer(record.playerId);
    if (!player) continue;
    const visibleChanges: KingdomSpatialWireChange[] = [];
    for (const change of changes) {
      const previousPosition = change.previous ? spatialEntityPosition(change.previous) : null;
      const currentPosition = change.current ? spatialEntityPosition(change.current) : null;
      const sawPrevious = Boolean(previousPosition &&
        distanceMeters(player.position, previousPosition) <= interestRadiusM);
      const seesCurrent = Boolean(currentPosition &&
        distanceMeters(player.position, currentPosition) <= interestRadiusM);
      if (seesCurrent && change.current) {
        visibleChanges.push({ action: "upsert" as const, entity: change.current });
      } else if (sawPrevious && change.previous) {
        const previous = change.previous;
        visibleChanges.push({
          action: "remove" as const,
          entity: previous.entityType === "seat"
            ? { entityType: "seat", id: previous.id, kingdomId: previous.kingdomId,
                spatialRevision: change.spatialRevision }
            : {
                entityType: "object",
                id: previous.id,
                kingdomId: previous.kingdomId,
                objectKind: previous.objectKind,
                spatialRevision: change.spatialRevision
              }
        });
      }
    }
    if (visibleChanges.length > 0) {
      connections.sendToConnection(record.connectionId, {
        type: "KINGDOM_SPATIAL_CHANGES",
        changes: visibleChanges
      }, "critical");
    }
  }
}

function spatialEntityPosition(entity: NonNullable<KingdomSpatialChange["current"]>): {
  lat: number;
  lon: number;
} {
  return entity.entityType === "seat"
    ? { lat: entity.kingdom.seat!.lat, lon: entity.kingdom.seat!.lon }
    : { lat: entity.object.lat, lon: entity.object.lon };
}

export function publicMutationResult<T extends KingdomMutationResult>(
  result: T
): Omit<T, "spatialChanges" | "notificationPlayerIds" | "affectedFlagIds"> {
  const publicResult = { ...result };
  delete publicResult.spatialChanges;
  delete publicResult.notificationPlayerIds;
  delete publicResult.affectedFlagIds;
  return publicResult;
}

export async function publishFlagUpdates(
  flags: FlagService,
  connections: ConnectionRegistry,
  flagIds: string[],
  removedReason: "deleted" | "transformed" = "deleted"
): Promise<void> {
  const revisionMetadata = await flagSetRevisionMetadata(flags);
  const removed: string[] = [];
  for (const flagId of new Set(flagIds)) {
    const flag = await flags.getMapFlag(flagId);
    if (flag) connections.broadcast({ type: "FLAG_UPDATED", flag, ...revisionMetadata });
    else removed.push(flagId);
  }
  if (removedReason === "transformed") {
    for (const flagId of removed) {
      connections.broadcast({ type: "FLAG_DELETED", flagId, reason: removedReason, ...revisionMetadata });
    }
    return;
  }
  // Released / cut-off Kingdom flags break: one batched frame per mutation.
  publishBrokenFlags(connections, {
    flagIds: removed,
    collapseId: null,
    reason: "disconnected",
    completed: true,
    ...revisionMetadata
  });
}

export async function runPostCommit(
  logger: AppLogger,
  operation: string,
  actorId: string,
  effects: Array<() => void | Promise<void>>
): Promise<void> {
  for (const effect of effects) {
    try {
      await effect();
    } catch (error) {
      logger.warn({ err: error, actorId, operation }, "Kingdom post-commit effect failed");
    }
  }
}

function sendKingdomError(
  reply: Parameters<typeof sendError>[0],
  error: unknown,
  logger: AppLogger
): void {
  if (error instanceof KingdomBrickEconomyError) {
    error = new KingdomError(error.code as KingdomErrorCode, error.message, error.details ?? {});
  }
  if (error instanceof KingdomError) {
    const spatialConflict = [
      "KINGDOM_TERRITORY_OVERLAP",
      "KINGDOM_SEAT_TOO_CLOSE",
      "KINGDOM_PENDING_RESERVATION_CONFLICT",
      "KINGDOM_FLAG_TERRITORY_OVERLAP"
    ].includes(error.code);
    if (spatialConflict) {
      logger.warn(
        { kingdomErrorCode: error.code, ...error.details },
        "Kingdom founding spatial conflict"
      );
    }
    sendError(
      reply,
      kingdomStatusCode(error.code),
      error.code,
      error.message,
      spatialConflict ? undefined : error.details
    );
    return;
  }
  logger.warn({ err: error }, "Kingdom request failed");
  sendError(reply, 500, "KINGDOM_SERVICE_ERROR", "Kingdom service unavailable");
}

function kingdomStatusCode(code: string): number {
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("PERMISSION") || code.includes("LEADER_PROTECTED") || code.includes("NOT_OWNER") ||
      code.includes("CANNOT_VOTE")) return 403;
  if (code.includes("ALREADY") || code.includes("CONFLICT") || code.includes("CAPACITY") ||
      code.includes("OVERLAP") || code.includes("TOO_CLOSE") || code.includes("EXPIRED") ||
      code.includes("BANNED") || code.includes("INSUFFICIENT") || code.includes("NETWORK_CHANGED") ||
      code.includes("LIFECYCLE_CHANGED") || code.includes("MEMBERSHIP_CHANGED") ||
      code.includes("CITY_AFFILIATED") || code.includes("NOT_CONNECTED") ||
      code.includes("INCOMPLETE") || code.includes("FOREIGN_AFFILIATION") ||
      code.includes("REVOLT_ANARCHY")) return 409;
  if (code.includes("WORLD_AUTHORITY")) return 503;
  if (code.includes("RATE_LIMITED")) return 429;
  return 400;
}
