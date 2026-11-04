import {
  type PlayerLocationSnapshot,
  type ManorSpaceId,
  type PortalDefinition,
  type PortalServerMessage
} from "@ash-atlas/shared";

import { DungeonError, type CisternWarrensRuntime } from "../../game/dungeon.js";
import type { CinderLanternService } from "../../game/cinderLanterns.js";
import { DungeonRepeatError } from "../../game/dungeonRepeatLedger.js";
import type { ManorRuntime } from "../../game/manor.js";
import type { GreenhouseRuntime } from "../../game/greenhouseRuntime.js";
import type { PlayerLocationService } from "../../game/locations/playerLocationService.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { PortalRegistry } from "../../game/locations/portalRegistry.js";
import {
  PortalTransitionCoordinator,
  PortalTransitionError,
  type PortalDestinationAdapter,
  type PortalMovementAdapter,
  type PortalTransitionEffects
} from "../../game/locations/portalTransitionCoordinator.js";
import type { SalonRuntime } from "../../game/salon.js";
import type { GameState } from "../../game/state.js";
import type { FlagRepairCoordinator } from "../../game/flagRepairing.js";
import { packageIdForPosition } from "../../game/spatialZones.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { XoralEventService } from "../../game/xoralEvents.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";

export type PortalFamilyHandler = RealtimeFamilyHandler<"portal"> & {
  disconnect(playerId: string): Promise<void>;
  recoverToWorldAnchor(playerId: string, requestId: string): Promise<PlayerLocationSnapshot>;
};

export type PortalHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  registry: ConnectionRegistry;
  gameState: GameState;
  locations: PlayerLocationService;
  portals: PortalRegistry;
  playerAuthorityFence?: PlayerAuthorityFence;
  cinderLanterns?: CinderLanternService | undefined;
  worldRuntime?: WorldRuntime | undefined;
  manorRuntime?: ManorRuntime | undefined;
  greenhouseRuntime?: GreenhouseRuntime | undefined;
  salonRuntime?: SalonRuntime | undefined;
  dungeon?: CisternWarrensRuntime | undefined;
  xoralEvents?: XoralEventService | undefined;
  flagRepairs?: FlagRepairCoordinator | undefined;
  effects: PortalTransitionEffects;
  authorizeManorEntry(playerId: string, manorId: string): Promise<void>;
  authorizeGreenhouseEntry?(playerId: string, greenhouseId: string): Promise<void>;
  projectManorEntry(input: Readonly<{
    playerId: string;
    requestId: string;
    manorId: string;
    expectedPlacementRevision: number;
    spaceId?: ManorSpaceId;
  }>): Promise<void>;
  projectManorExit(input: Readonly<{ playerId: string; requestId: string }>): Promise<void>;
  projectSalonEntry(input: Readonly<{
    playerId: string;
    requestId: string;
    structureId: string;
    expectedPlacementRevision: string;
  }>): Promise<void>;
  projectSalonExit(input: Readonly<{ playerId: string; requestId: string }>): Promise<void>;
  projectGreenhouseEntry?(input: Readonly<{ playerId: string; requestId: string; greenhouseId: string; position: { x: number; y: number } }>): Promise<void>;
  projectGreenhouseExit?(input: Readonly<{ playerId: string; requestId: string }>): Promise<void>;
  cancelGreenhouseWaterFill?(playerId: string): Promise<void>;
}>;

export function createPortalHandler(context: PortalHandlerContext): PortalFamilyHandler {
  const send = (playerId: string, message: PortalServerMessage): void => {
    context.registry.send(playerId, message);
  };
  const movement = createMovementFactory(context);
  const destination = createDestinationFactory(context);
  const coordinator = new PortalTransitionCoordinator({
    locations: context.locations,
    portals: context.portals,
    movementFor: movement,
    destinationFor: destination,
    effects: context.effects,
    send,
    ...(context.playerAuthorityFence ? {
      runWithPlayerAuthority: <T>(playerId: string, operation: () => Promise<T>) =>
        context.playerAuthorityFence!.run(playerId, operation)
    } : {})
  });

  const handler: RealtimeFamilyHandler<"portal"> = async (message) => {
    requireHello(context.state.playerId);
    const playerId = context.state.playerId!;
    try {
      if (message.type === "USE_PORTAL") {
        await context.cancelGreenhouseWaterFill?.(playerId);
        context.flagRepairs?.cancelPlayer(playerId, "portal-transition");
        const xoralRole = context.xoralEvents?.exitRole(playerId) ?? null;
        if (xoralRole) {
          throw new PortalTransitionError(
            xoralRole === "leader"
              ? "XORAL_LEADER_EXIT_CONFIRMATION_REQUIRED"
              : "XORAL_FOLLOWER_EXIT_CONFIRMATION_REQUIRED",
            xoralRole === "leader"
              ? "Using this portal will cancel The Xoral event for the entire locked party. Confirm before leaving."
              : "Using this portal will permanently remove you from The Xoral event. Confirm before leaving."
          );
        }
        await context.cinderLanterns?.chooseEntryLantern(playerId, message.lantern ?? null);
        await coordinator.usePortal({
          playerId, requestId: message.requestId, portalId: message.portalId,
          expectedLocationRevision: message.expectedLocationRevision,
          ...(message.expectedPortalRevision ? { expectedPortalRevision: message.expectedPortalRevision } : {}),
          ...(message.approach ? { approach: message.approach } : {})
        });
      } else if (message.type === "PORTAL_DESTINATION_READY") {
        coordinator.destinationReady(playerId, message.transitionId, message.sceneKey);
      } else {
        await coordinator.cancel(playerId, message.transitionId);
      }
    } catch (error) {
      if (
        error instanceof PortalTransitionError &&
        (error.code === "XORAL_LEADER_EXIT_CONFIRMATION_REQUIRED" ||
          error.code === "XORAL_FOLLOWER_EXIT_CONFIRMATION_REQUIRED")
      ) {
        context.registry.send(playerId, {
          type: "ERROR",
          requestId: "requestId" in message ? message.requestId : message.transitionId,
          code: error.code,
          message: error.message
        });
      }
      const location = await context.locations.load(playerId);
      send(playerId, {
        type: "PORTAL_TRANSITION_FAILED",
        ...(message.type === "PORTAL_DESTINATION_READY" ? {} : { requestId: message.requestId }),
        ...(message.type === "USE_PORTAL" ? {} : { transitionId: message.transitionId }),
        code: error instanceof PortalTransitionError ? error.code : "PORTAL_TRANSITION_FAILED",
        message: error instanceof Error ? error.message : "Portal transition failed.",
        location
      });
    }
  };
  return Object.assign(handler, {
    disconnect: (playerId: string) => coordinator.disconnect(playerId),
    recoverToWorldAnchor: (playerId: string, requestId: string) => {
      const player = context.gameState.getPlayer(playerId);
      if (!player) throw new PortalTransitionError("PLAYER_NOT_FOUND", "Player recovery is unavailable.");
      return coordinator.recoverToWorldAnchor({
        playerId,
        requestId,
        regionCode: packageIdForPosition(player.anchor),
        anchor: player.anchor
      });
    }
  });
}

export function registerPortalHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"portal">
): void {
  router.register("portal", handler);
}

function createMovementFactory(context: PortalHandlerContext) {
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const worldStops = new Map<string, () => void>();
  const manorStops = new Map<string, () => void>();
  const greenhouseStops = new Map<string, () => void>();
  return (location: PlayerLocationSnapshot): PortalMovementAdapter => ({
    approach({ playerId, transitionId, portal, onThreshold, onFailure }) {
      try {
        if (location.kind === "world") {
          if (!context.worldRuntime || !("lat" in portal.sourceThreshold)) {
            throw new PortalTransitionError("MOVEMENT_UNAVAILABLE", "World portal movement is unavailable.");
          }
          const unsubscribe = context.worldRuntime.subscribeMovementSettled(playerId, () => {
            unsubscribe();
            worldStops.delete(transitionId);
            onThreshold();
          });
          worldStops.set(transitionId, unsubscribe);
          context.gameState.setTarget(playerId, portal.sourceThreshold);
          return;
        }
        if (!("x" in portal.sourceThreshold)) {
          throw new PortalTransitionError("INVALID_PORTAL", "Interior portal threshold is invalid.");
        }
        const target = portal.sourceThreshold;
        if (location.locationType === "manor") {
          const session = context.manorRuntime?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Manor session is unavailable.");
          context.manorRuntime!.moveTo(playerId, session.sessionId, target.x, target.y);
          const unsubscribe = context.manorRuntime!.subscribeMovementSettled(playerId, () => {
            manorStops.delete(transitionId);
            onThreshold();
          });
          manorStops.set(transitionId, unsubscribe);
          return;
        } else if (location.locationType === "greenhouse") {
          const session = context.greenhouseRuntime?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Greenhouse session is unavailable.");
          context.greenhouseRuntime!.moveTo(playerId, session.sessionId, target.x, target.y);
          const unsubscribe = context.greenhouseRuntime!.subscribeMovementSettled(playerId, () => {
            greenhouseStops.delete(transitionId);
            onThreshold();
          });
          greenhouseStops.set(transitionId, unsubscribe);
          return;
        } else if (location.locationType === "salon") {
          const session = context.salonRuntime?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Salon session is unavailable.");
          context.salonRuntime!.moveTo(playerId, session.sessionId, target.x, target.y);
        } else {
          const session = context.dungeon?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Sewer session is unavailable.");
          context.dungeon!.moveTo(playerId, session.sessionId, target.x, target.y);
        }
        const timer = setInterval(() => {
          try {
            const current = localPosition(context, location, playerId);
            if (!current || current.moving || Math.hypot(current.x - target.x, current.y - target.y) > 2) return;
            clearInterval(timer);
            timers.delete(transitionId);
            onThreshold();
          } catch (error) {
            clearInterval(timer);
            timers.delete(transitionId);
            onFailure(error);
          }
        }, 50);
        timers.set(transitionId, timer);
      } catch (error) {
        onFailure(error);
      }
    },
    stop(playerId, transitionId) {
      const timer = timers.get(transitionId);
      if (timer) clearInterval(timer);
      timers.delete(transitionId);
      worldStops.get(transitionId)?.();
      worldStops.delete(transitionId);
      manorStops.get(transitionId)?.();
      manorStops.delete(transitionId);
      greenhouseStops.get(transitionId)?.();
      greenhouseStops.delete(transitionId);
      if (location.kind === "world") context.gameState.stopPlayer(playerId);
      else if (location.locationType === "manor") context.manorRuntime?.stop(playerId);
      else if (location.locationType === "greenhouse") context.greenhouseRuntime?.stop(playerId);
      else if (location.locationType === "salon") context.salonRuntime?.stop(playerId);
      else context.dungeon?.stop(playerId);
    }
  });
}

function createDestinationFactory(context: PortalHandlerContext) {
  return (portal: PortalDefinition): PortalDestinationAdapter => ({
    async authorize({ playerId, source }) {
      // The coordinator's internal death recovery targets the world anchor, not a catalog door.
      // External USE_PORTAL requests must resolve through the registry, which has no recovery portal.
      const isDeathRecovery = portal.portalId === "recovery:death-anchor" && portal.destination.kind === "world";
      if (source.kind === "world" && portal.destination.kind === "interior" &&
          portal.destination.locationType === "manor") {
        await context.authorizeManorEntry(playerId, portal.destination.locationId);
      }
      if (source.kind === "world" && portal.destination.kind === "interior" &&
          portal.destination.locationType === "greenhouse") {
        if (!context.authorizeGreenhouseEntry) {
          throw new PortalTransitionError("SESSION_MISSING", "Greenhouse entry is unavailable.");
        }
        await context.authorizeGreenhouseEntry(playerId, portal.destination.locationId);
      }
      if (source.kind === "world" && portal.destination.kind === "interior" &&
          (portal.destination.locationType === "cistern_warrens" || portal.destination.locationType === "dungeon")) {
        if (!context.dungeon) {
          throw new PortalTransitionError("SESSION_MISSING", "Sewer entry is unavailable.");
        }
        try {
          await context.dungeon.authorizeEntry(playerId, portal.destination.locationId);
        } catch (error) {
          if (error instanceof DungeonRepeatError || error instanceof DungeonError) {
            throw new PortalTransitionError(error.code, error.message);
          }
          throw error;
        }
      }
      if (source.kind === "interior" && source.locationType === "manor" &&
          !isDeathRecovery && !context.manorRuntime?.get(playerId)) {
        throw new PortalTransitionError("SESSION_MISSING", "Manor session is unavailable.");
      }
      if (source.kind === "interior" && source.locationType === "salon" &&
          !isDeathRecovery && !context.salonRuntime?.get(playerId)) {
        throw new PortalTransitionError("SESSION_MISSING", "Salon session is unavailable.");
      }
      if (source.kind === "interior" && source.locationType === "greenhouse" &&
          !isDeathRecovery && !context.greenhouseRuntime?.get(playerId)) {
        throw new PortalTransitionError("SESSION_MISSING", "Greenhouse session is unavailable.");
      }
      if (source.kind === "interior" && (source.locationType === "cistern_warrens" || source.locationType === "dungeon") &&
          !isDeathRecovery && !context.dungeon?.get(playerId)) {
        throw new PortalTransitionError("SESSION_MISSING", "Dungeon session is unavailable.");
      }
      if (source.kind === "interior" && (source.locationType === "cistern_warrens" || source.locationType === "dungeon") &&
          !isDeathRecovery) {
        try {
          await context.dungeon!.refreshPortalAuthorities?.(playerId);
          context.dungeon!.authorizePortal(playerId, portal.portalId);
        } catch (error) {
          if (error instanceof DungeonError) throw new PortalTransitionError(error.code, error.message);
          throw error;
        }
      }
    },
    async commit({ playerId, requestId, source, destination }) {
      if (source.kind === "world" && destination.kind === "interior") {
        if (destination.locationType === "manor") {
          const expectedPlacementRevision = Number(portal.revision);
          if (!Number.isSafeInteger(expectedPlacementRevision)) {
            throw new PortalTransitionError("INVALID_PORTAL", "Manor portal revision is invalid.");
          }
          await context.projectManorEntry({
            playerId,
            requestId,
            manorId: destination.locationId,
            expectedPlacementRevision,
            spaceId: destination.spaceId as ManorSpaceId
          });
          if (!context.manorRuntime?.get(playerId)) throw new PortalTransitionError("DOMAIN_COMMIT_FAILED", "Manor entry did not complete.");
        } else if (destination.locationType === "greenhouse") {
          if (!context.projectGreenhouseEntry) {
            throw new PortalTransitionError("SESSION_MISSING", "Greenhouse entry is unavailable.");
          }
          await context.projectGreenhouseEntry({
            playerId,
            requestId,
            greenhouseId: destination.locationId,
            position: destination.position
          });
          if (!context.greenhouseRuntime?.get(playerId)) throw new PortalTransitionError("DOMAIN_COMMIT_FAILED", "Greenhouse entry did not complete.");
        } else if (destination.locationType === "salon") {
          await context.projectSalonEntry({
            playerId,
            requestId,
            structureId: destination.locationId,
            expectedPlacementRevision: portal.revision
          });
          if (!context.salonRuntime?.get(playerId)) throw new PortalTransitionError("DOMAIN_COMMIT_FAILED", "Salon entry did not complete.");
        } else {
          const player = context.gameState.getPlayer(playerId);
          if (!player || !context.dungeon) {
            throw new PortalTransitionError("SESSION_MISSING", "Sewer entry is unavailable.");
          }
          const snapshot = await context.dungeon.enter(player, destination.locationId, {
            spaceId: destination.spaceId,
            position: destination.position,
            instanceId: destination.instanceId,
            locationType: destination.locationType === "dungeon" ? "dungeon" : "cistern_warrens"
          });
          context.dungeon.portalUsed(playerId, portal.portalId);
          context.registry.send(playerId, { type: "DUNGEON_ENTERED", requestId, snapshot });
          return;
        }
        return;
      }
      if (source.kind === "interior" && destination.kind === "world") {
        if (source.locationType === "manor") {
          try {
            await context.projectManorExit({ playerId, requestId });
          } catch (error) {
            if (!isDeathRecoveryProjectionGap(portal, error)) throw error;
          }
        } else if (source.locationType === "salon") {
          try {
            await context.projectSalonExit({ playerId, requestId });
          } catch (error) {
            if (!isDeathRecoveryProjectionGap(portal, error)) throw error;
          }
        } else if (source.locationType === "greenhouse") {
          if (!context.projectGreenhouseExit) {
            throw new PortalTransitionError("SESSION_MISSING", "Greenhouse exit is unavailable.");
          }
          try {
            await context.projectGreenhouseExit({ playerId, requestId });
          } catch (error) {
            if (!isDeathRecoveryProjectionGap(portal, error)) throw error;
          }
        } else {
          const session = context.dungeon?.get(playerId);
          await context.dungeon!.leave(playerId, session?.sessionId, portal.portalId);
        }
        if (source.locationType === "cistern_warrens" || source.locationType === "dungeon") {
          context.registry.send(playerId, {
            type: "DUNGEON_EXITED",
            requestId,
            player: context.gameState.snapshotForPlayer(playerId)
          });
        }
        return;
      }
      if (source.kind === "interior" && destination.kind === "interior") {
        if (source.instanceId !== destination.instanceId) {
          throw new PortalTransitionError("INSTANCE_CHANGED", "This portal cannot replace the active location instance.");
        }
        if (source.locationType === "manor") {
          const session = context.manorRuntime?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Manor session is unavailable.");
          const changed = context.manorRuntime!.transferSpace(playerId, session.sessionId, destination.spaceId as ManorSpaceId, destination.position);
          context.registry.send(playerId, { type: "MANOR_POSITION", manorSessionId: changed.sessionId, spaceId: changed.spaceId, position: changed.position, movementSequence: changed.movementSequence, serverTime: Date.now() });
          context.worldRuntime?.sendManorOccupants(session.manorId);
        } else if (source.locationType === "greenhouse") {
          const session = context.greenhouseRuntime?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Greenhouse session is unavailable.");
          const changed = context.greenhouseRuntime!.moveTo(playerId, session.sessionId, destination.position.x, destination.position.y);
          context.registry.send(playerId, { type: "GREENHOUSE_POSITION", greenhouseSessionId: changed.sessionId, position: changed.position, movementSequence: changed.movementSequence, serverTime: Date.now() });
        } else if (source.locationType === "cistern_warrens" || source.locationType === "dungeon") {
          const session = context.dungeon?.get(playerId);
          if (!session) throw new PortalTransitionError("SESSION_MISSING", "Sewer session is unavailable.");
          const snapshot = context.dungeon!.transferSpace(playerId, session.sessionId, destination.spaceId, destination.position, portal.portalId);
          context.registry.send(playerId, { type: "DUNGEON_SNAPSHOT", snapshot });
        }
      }
    }
  });
}

function localPosition(
  context: PortalHandlerContext,
  location: Extract<PlayerLocationSnapshot, { kind: "interior" }>,
  playerId: string
): { x: number; y: number; moving: boolean } | null {
  if (location.locationType === "manor") {
    const position = context.manorRuntime?.get(playerId)?.position;
    return position ? { x: position.x, y: position.y, moving: position.moving } : null;
  }
  if (location.locationType === "salon") {
    const position = context.salonRuntime?.get(playerId)?.position;
    return position ? { x: position.x, y: position.y, moving: position.moving } : null;
  }
  if (location.locationType === "greenhouse") {
    const position = context.greenhouseRuntime?.get(playerId)?.position;
    return position ? { x: position.x, y: position.y, moving: position.moving } : null;
  }
  const position = context.dungeon?.get(playerId)?.player;
  return position ? { x: position.x, y: position.y, moving: position.targetX !== null } : null;
}

function isDeathRecoveryProjectionGap(portal: PortalDefinition, error: unknown): boolean {
  return portal.portalId === "recovery:death-anchor" &&
    typeof error === "object" && error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "NOT_INSIDE" ||
      (error as { code?: unknown }).code === "SESSION_MISSING");
}
