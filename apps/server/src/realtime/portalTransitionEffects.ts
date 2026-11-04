import {
  interiorRegionCode,
  interiorZoneId,
  levelUpHealth,
  type EquipmentSnapshotV2,
  type ProgressionSnapshot
} from "@ash-atlas/shared";

import type { AuthenticatedSession } from "../auth/types.js";
import type { ClassService } from "../game/classes/classService.js";
import {
  playerEquipmentCombatStateFromSnapshot,
  type CombatEngine
} from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { FlagBuildCoordinator } from "../game/flagBuildCoordinator.js";
import type { CisternWarrensRuntime } from "../game/dungeon.js";
import {
  PortalTransitionError,
  type PortalTransitionEffects,
  type PortalTransitionEffectsInput
} from "../game/locations/portalTransitionCoordinator.js";
import type { PopulationTravelReservation } from "../game/populationTravelReservation.js";
import type { ManorRuntime } from "../game/manor.js";
import type { GreenhouseRuntime } from "../game/greenhouseRuntime.js";
import type { SalonRuntime } from "../game/salon.js";
import { zoneIdForPosition } from "../game/spatialZones.js";
import type { GameState, PlayerRecord } from "../game/state.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type {
  PopulationV2RealtimeHooks,
  ScheduledPopulationV2Relocation
} from "./populationRealtimeOperations.js";

type PreparedCombat = Readonly<{
  profile: Awaited<ReturnType<CombatProfileService["getOrCreate"]>> | null;
  progression: Readonly<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }> | null;
  classSnapshot: Awaited<ReturnType<ClassService["getOrCreate"]>> | null;
  classRuntime: Awaited<ReturnType<ClassService["loadRuntime"]>> | null;
}>;

type PreparedTransition = {
  worldTransitionToken: symbol | null;
  combat: PreparedCombat | null;
  populationReservation: PopulationTravelReservation | null;
  populationRelocation: ScheduledPopulationV2Relocation | null;
};

export function createPortalTransitionEffects(context: Readonly<{
  logger: AppLogger;
  authenticatedSession: AuthenticatedSession | null | undefined;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  manorRuntime?: ManorRuntime | undefined;
  greenhouseRuntime?: GreenhouseRuntime | undefined;
  salonRuntime?: SalonRuntime | undefined;
  dungeon?: CisternWarrensRuntime | undefined;
  combat: CombatEngine;
  combatProfiles?: CombatProfileService | undefined;
  classes?: ClassService | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  populationV2?: PopulationV2RealtimeHooks | undefined;
  connectionGenerations: ConnectionGenerationLedger;
  connectionId(): string | null;
  refreshAuthoritativePlayerStats(playerId: string): Promise<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }>;
  reservePopulationV2CurrentArea(input: Readonly<{
    playerId: string;
    requestId: string;
    kind: "separate-space-exit";
  }>): PopulationTravelReservation | null;
  schedulePopulationV2RelocationForActivePlayer(
    playerId: string,
    trigger: "separate-space-exit" | "explicit-relocation"
  ): ScheduledPopulationV2Relocation | null;
  waitForRelocationPopulationV2(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: { lat: number; lon: number };
    transitionToken: symbol;
    relocation: ScheduledPopulationV2Relocation | null;
  }>): Promise<unknown>;
  sendWorldBootstrapForPlayer(
    player: PlayerRecord,
    trigger: "separate-space-exit" | "death-respawn",
    scheduleRuntimeRelocation: boolean
  ): Promise<void>;
}>): PortalTransitionEffects {
  const preparedByTransition = new Map<string, PreparedTransition>();

  return {
    async prepare(input) {
      const prepared: PreparedTransition = {
        worldTransitionToken: null,
        combat: null,
        populationReservation: null,
        populationRelocation: null
      };
      preparedByTransition.set(input.transitionId, prepared);
      if (input.source.kind === "world" || input.portal.destination.kind === "world") {
        if (!context.worldRuntime) {
          throw new PortalTransitionError("MOVEMENT_UNAVAILABLE", "World portal transitions are unavailable.");
        }
        const token = input.source.kind === "world" && input.portal.destination.kind === "interior"
          ? context.worldRuntime.beginPlayerWorldTransition(
              input.playerId,
              input.requestId,
              { withholdPlayerReplication: false }
            )
          : context.worldRuntime.beginPlayerWorldTransition(
              input.playerId,
              input.requestId
            );
        if (!token) {
          throw new PortalTransitionError(
            "TRANSITION_PENDING",
            "Finish the current world action before using this portal."
          );
        }
        prepared.worldTransitionToken = token;
      }
      if (input.source.kind !== "interior" || input.portal.destination.kind !== "world") return;

      if (input.source.locationType === "manor") {
        const connectionId = context.connectionId();
        if (!connectionId || !context.registry.isActivePlayerConnection(input.playerId, connectionId)) {
          throw new PortalTransitionError("STALE_CONNECTION", "This connection no longer controls the player.");
        }
        prepared.populationReservation = context.reservePopulationV2CurrentArea({
          playerId: input.playerId,
          requestId: input.requestId,
          kind: "separate-space-exit"
        });
        void prepared.populationReservation?.preparation.catch((error: unknown) => {
          context.logger.warn(
            { err: error, playerId: input.playerId },
            "portal exit population reservation failed; relocation fallback remains active"
          );
        });
      }
      if (input.source.locationType === "cistern_warrens" || input.source.locationType === "dungeon") return;
      const [profile, progression, classSnapshot, classRuntime] = await Promise.all([
        context.combatProfiles?.getOrCreate(input.playerId) ?? null,
        context.refreshAuthoritativePlayerStats(input.playerId),
        context.classes?.getOrCreate(input.playerId) ?? null,
        context.classes?.loadRuntime(input.playerId) ?? null
      ]);
      prepared.combat = { profile, progression, classSnapshot, classRuntime };
    },

    async apply(input) {
      stopSource(context, input);
      if (input.destination.kind === "interior") {
        if (input.source.kind === "world") context.combat.cancelCombat(input.playerId);
        context.gameState.setPlayerLocationKind(input.playerId, "interior");
        if (input.destination.locationType !== "cistern_warrens" && input.destination.locationType !== "dungeon") {
          context.combat.disconnectPlayer(input.playerId);
        }
        context.worldRuntime?.replication.removePlayer(input.playerId);
        context.registry.updateSpatialMembership({
          playerId: input.playerId,
          regionCode: interiorRegionCode(input.destination.instanceId),
          zoneId: interiorZoneId(input.destination.instanceId, input.destination.spaceId),
          interestZoneIds: []
        });
        if (input.source.kind === "world" && input.destination.locationType === "manor") {
          releasePopulationConnection(context, input.playerId);
        }
        return;
      }

      // Death recovery returns the player to the anchor they already own, so the
      // active Resource Vision must survive it. A plain teleport clears the vision,
      // which empties the collectible view and rejects every later harvest.
      const player = input.portal.portalId === "recovery:death-anchor"
        ? context.gameState.restoreWorldPosition(
            input.playerId,
            input.destination.position,
            input.destination.regionCode
          )
        : context.gameState.teleportPlayer(
            input.playerId,
            input.destination.position,
            input.destination.regionCode
          );
      context.gameState.setPlayerLocationKind(input.playerId, "world");
      const prepared = preparedByTransition.get(input.transitionId);
      if (
        input.source.kind === "interior" &&
        input.source.locationType !== "cistern_warrens" && input.source.locationType !== "dungeon" &&
        prepared?.combat
      ) {
        connectWorldCombat(context, player, prepared.combat);
      } else {
        context.combat.syncPlayer({
          playerId: input.playerId,
          position: input.destination.position,
          regionCode: input.destination.regionCode,
          zoneId: zoneIdForPosition(input.destination.position)
        });
      }
      context.worldRuntime?.replication.resetPlayer(input.playerId);
      context.registry.updateSpatialMembership({
        playerId: input.playerId,
        regionCode: input.destination.regionCode,
        zoneId: zoneIdForPosition(input.destination.position),
        interestZoneIds: []
      });
      if (input.source.kind === "interior" && input.source.locationType === "manor" && prepared) {
        prepared.populationRelocation =
          context.schedulePopulationV2RelocationForActivePlayer(
            input.playerId,
            "separate-space-exit"
          );
        if (prepared.populationReservation && prepared.populationRelocation?.isCurrent()) {
          prepared.populationReservation.adopt({
            relocationRevision: prepared.populationRelocation.relocationRevision,
            resourceVisionRevision: prepared.populationRelocation.resourceVisionRevision,
            gameplayViewGeneration: prepared.populationRelocation.gameplayViewGeneration,
            area: prepared.populationRelocation.area
          });
        }
      }
    },

    async complete(input) {
      if (input.isSuperseded?.()) return;
      if (input.portal.portalId === "recovery:death-anchor") {
        const prepared = preparedByTransition.get(input.transitionId);
        const player = context.gameState.getPlayer(input.playerId);
        if (!player) return;

        // Recovery advances the world authority in apply(). Re-establish the
        // population authority before releasing the transition, then use the
        // canonical bootstrap to republish trees and other world objects.
        if (input.isSuperseded?.()) return;
        const relocation = prepared?.populationRelocation ??
          context.schedulePopulationV2RelocationForActivePlayer(
            input.playerId,
            "explicit-relocation"
          );
        if (prepared) prepared.populationRelocation = relocation;
        if (prepared?.worldTransitionToken) {
          await context.waitForRelocationPopulationV2({
            playerId: input.playerId,
            requestId: input.requestId,
            destination: { ...player.anchor },
            transitionToken: prepared.worldTransitionToken,
            relocation
          });
        }
        if (input.isSuperseded?.()) return;
        await context.sendWorldBootstrapForPlayer(player, "death-respawn", false);
        return;
      }
      if (input.source.kind !== "interior" || input.source.locationType !== "manor") return;
      const prepared = preparedByTransition.get(input.transitionId);
      const player = context.gameState.getPlayer(input.playerId);
      if (!prepared || !player) return;
      if (input.isSuperseded?.()) return;
      if (prepared.worldTransitionToken) {
        await context.waitForRelocationPopulationV2({
          playerId: input.playerId,
          requestId: input.requestId,
          destination: { ...player.anchor },
          transitionToken: prepared.worldTransitionToken,
          relocation: prepared.populationRelocation
        });
      }
      if (input.isSuperseded?.()) return;
      try {
        await context.sendWorldBootstrapForPlayer(player, "separate-space-exit", false);
      } catch (error) {
        context.logger.warn(
          { err: error, playerId: input.playerId },
          "failed to complete portal exit world bootstrap"
        );
      }
      context.flagBuilds?.refreshQuoteForPlayer(input.playerId, "manor-exit-completed");
    },

    release(input) {
      const prepared = preparedByTransition.get(input.transitionId);
      if (!prepared) return;
      preparedByTransition.delete(input.transitionId);
      const outcome = input.committed ? "committed" : "failed";
      const releaseReason = input.committed
        ? "portal-transition-complete"
        : "portal-transition-cancelled";
      prepared.populationReservation?.release(releaseReason);
      if (prepared.worldTransitionToken && context.worldRuntime) {
        context.worldRuntime.endPlayerWorldTransition(
          input.playerId,
          prepared.worldTransitionToken,
          outcome,
          releaseReason
        );
      }
    }
  };
}

function stopSource(
  context: Parameters<typeof createPortalTransitionEffects>[0],
  input: PortalTransitionEffectsInput
): void {
  if (input.source.kind === "world") {
    context.gameState.stopPlayer(input.playerId);
  } else if (input.source.locationType === "manor") {
    context.manorRuntime?.stop(input.playerId);
  } else if (input.source.locationType === "salon") {
    context.salonRuntime?.stop(input.playerId);
  } else if (input.source.locationType === "greenhouse") {
    context.greenhouseRuntime?.stop(input.playerId);
  } else {
    context.dungeon?.stop(input.playerId);
  }
}

function connectWorldCombat(
  context: Parameters<typeof createPortalTransitionEffects>[0],
  player: PlayerRecord,
  prepared: PreparedCombat
): void {
  const profile = prepared.profile;
  const session = context.authenticatedSession;
  if (!profile || !session) return;
  const stats = prepared.progression?.progression.pveStats;
  context.combat.connectPlayer({
    playerId: player.playerId,
    name: player.username,
    regionCode: player.regionCode,
    zoneId: zoneIdForPosition(player.position),
    position: player.position,
    accountId: session.account.id,
    connectionId: context.connectionId() ?? "portal-exit",
    profile: stats ? {
      ...profile,
      level: prepared.progression!.progression.level,
      maxHealth: stats.maxHealth,
      currentHealth: levelUpHealth(profile.currentHealth, profile.maxHealth, stats.maxHealth),
      baseAttackDamage: stats.attackPower,
      defense: stats.defense
    } : profile
  });
  if (prepared.progression) {
    context.combat.syncPlayerEquipmentCombatState(
      player.playerId,
      playerEquipmentCombatStateFromSnapshot(prepared.progression.equipment)
    );
    if (prepared.classSnapshot) {
      context.combat.updatePlayerClassState(
        player.playerId,
        prepared.classSnapshot,
        prepared.progression.equipment,
        prepared.classRuntime ?? undefined
      );
    }
  }
}

function releasePopulationConnection(
  context: Parameters<typeof createPortalTransitionEffects>[0],
  playerId: string
): void {
  const connectionId = context.connectionId();
  if (!connectionId || !context.populationV2) return;
  void Promise.resolve(context.populationV2.releaseConnection({
    playerId,
    connectionId,
    connectionGeneration: context.connectionGenerations.current(playerId) ?? 0
  })).catch((error: unknown) => {
    context.logger.warn(
      { err: error, playerId },
      "population v2 separate-space release failed"
    );
  });
}
