import {
  classEquipmentCompatibility,
  isPortableEquipmentCraft,
  RING_TIER_RULES,
  UTILITY_GEAR,
  type ClassSnapshot,
  type CombatKitIndex,
  type EquipmentSnapshotV2,
  type LatLon,
  type ProgressionSnapshot,
  type ServerMessage,
  type SkillSystemV3Snapshot
} from "@ash-atlas/shared";

import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppLogger } from "../../logger.js";
import { ClassRequestError, type ClassService } from "../../game/classes/classService.js";
import type {
  CombatEngine,
  EquipmentCombatUpdateKind
} from "../../game/combat/combatEngine.js";
import { EquipmentError, type EquipmentService } from "../../game/equipment.js";
import { installAuthoritativePlayerAppearance } from "../../game/appearanceProjection.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import {
  ManorError,
  type ManorPresenceService,
  type ManorRuntime
} from "../../game/manor.js";
import type { DungeonSkillService } from "../../game/dungeonSkills.js";
import type { InventoryService } from "../../game/inventory.js";
import { offerGeneralSkill } from "../../game/skills/skillOfferings.js";
import { ProgressionRequestError, type ProgressionService } from "../../game/progression.js";
import {
  SkillRequestError,
  type SkillService,
  type SpecializationService
} from "../../game/skills/index.js";
import { WalletOperationError } from "../../game/wallet.js";
import type { WorldCommandInput } from "../../game/worldCommandQueue.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { GameState } from "../../game/state.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { GoblinVillageService } from "../../game/goblinVillage.js";
import type { TravelBlockReason } from "../../game/travelEligibility.js";
import { XoralEventError, type XoralEventService } from "../../game/xoralEvents.js";
import type { ClassRealtimeState } from "../classRealtimeState.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";
import type { LandActionGate } from "../../auth/trust/trustService.js";
import type { HostileActionGate } from "../../auth/trust/hostileGate.js";
import { landActionAllowed, noteLandAction } from "./landActionGuard.js";

type ConnectionWorldCommand = WorldCommandInput extends infer Command
  ? Command extends WorldCommandInput
    ? Omit<Command, "playerId" | "accountId" | "connectionId">
    : never
  : never;

export type CombatEquipmentHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId" | "connectionId">;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  landActions?: LandActionGate | undefined;
  hostileGate?: HostileActionGate | undefined;
  logger?: Pick<AppLogger, "warn"> | undefined;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  /** Water travel: warm the surface cache so the combat approach can apply the raft rule. */
  prewarmWaterPath?: ((playerId: string, target: LatLon) => Promise<void>) | undefined;
  goblinVillage?: GoblinVillageService | undefined;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
  classes?: ClassService | undefined;
  skills?: SkillService | undefined;
  dungeonSkills?: DungeonSkillService | undefined;
  inventory?: InventoryService | undefined;
  specializations?: SpecializationService | undefined;
  xoralEvents?: XoralEventService | undefined;
  manorPresence?: ManorPresenceService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  classRealtimeState: ClassRealtimeState;
  playerAuthorityFence?: PlayerAuthorityFence | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  applyLiveClassMutationState(
    playerId: string,
    snapshot: ClassSnapshot,
    equipment: EquipmentSnapshotV2
  ): Promise<ProgressionSnapshot | null>;
  applyLiveSkillMutationState(
    playerId: string,
    snapshot: SkillSystemV3Snapshot,
    equipment: EquipmentSnapshotV2,
    options?: Readonly<{ preserveHealthPercentage?: boolean }>
  ): Promise<ProgressionSnapshot | null>;
  cancelPendingManorEntry(
    playerId: string,
    options?: { stopMovement?: boolean; notify?: boolean; message?: string }
  ): boolean;
  enforcePlayerClassRate(key: string, maximum: number, windowMs: number): void;
  enqueueWorldCommand(command: ConnectionWorldCommand): boolean;
  refreshAuthoritativePlayerStats(playerId: string): Promise<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }>;
  settleAndRespawnPlayer?: ((
    playerId: string,
    complete: (operationKey: string) => Promise<boolean>
  ) => Promise<boolean>) | undefined;
  recoverPlayerToWorldAnchor?: ((playerId: string, requestId: string) => Promise<unknown>) | undefined;
  /** True when the player's death respawns them inside their current dungeon room, skipping the world recovery. */
  respawnsInRoomOnDeath?: ((playerId: string) => boolean) | undefined;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  sendCombatError(
    socket: SocketLike,
    requestId: string,
    code: string,
    message: string,
    details?: {
      retryAfterMs?: number;
      retryable?: boolean;
      currentTollGold?: string;
      requiredGold?: string;
    }
  ): void;
  stageEquipmentSnapshot(
    playerId: string,
    requestId: string,
    kind: EquipmentCombatUpdateKind,
    snapshot: EquipmentSnapshotV2,
    options?: Readonly<{ maxHealth?: number | null }>
  ): boolean;
  /** Max health (before Vigor Serum and the PvP penalty) with `snapshot` worn; null when unknown. */
  resolvePveMaxHealth?(playerId: string, snapshot: EquipmentSnapshotV2): Promise<number | null>;
  recenterXoralParticipant(
    playerId: string,
    anchor: Readonly<{ lat: number; lon: number }>,
    requestId: string
  ): Promise<
    | { success: true }
    | { success: false; reason: TravelBlockReason }
  >;
}>;

export function createCombatEquipmentHandler(
  context: CombatEquipmentHandlerContext
): RealtimeFamilyHandler<"combat-equipment"> {
  const handle: RealtimeFamilyHandler<"combat-equipment"> = async (message) => {
    const {
      state,
      socket,
      authenticatedSession,
      logger,
      registry,
      gameState,
      worldRuntime,
      combat,
      prewarmWaterPath,
      goblinVillage,
      progression,
      equipment,
      classes,
      skills,
      dungeonSkills,
      inventory,
      specializations,
      xoralEvents,
      manorPresence,
      manorRuntime,
      classRealtimeState,
      flagBuilds,
      applyLiveClassMutationState,
      applyLiveSkillMutationState,
      cancelPendingManorEntry,
      enforcePlayerClassRate,
      enqueueWorldCommand,
      refreshAuthoritativePlayerStats,
      recoverPlayerToWorldAnchor,
      respawnsInRoomOnDeath,
      settleAndRespawnPlayer,
      safeSendServerMessage,
      sendCombatError,
      stageEquipmentSnapshot,
      resolvePveMaxHealth,
      recenterXoralParticipant,
      landActions,
      hostileGate
    } = context;
    const sendClassError = (
      targetSocket: SocketLike,
      requestId: string,
      error: unknown
    ): void => {
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: error instanceof ClassRequestError ? error.code : "CLASS_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Class request rejected"
      });
    };
    /** Offerings already made, for clients that understand SKILL_UNLOCK_STATE. */
    const sendSkillUnlockState = async (): Promise<void> => {
      if (!skills || !state.playerId || !state.connectionId || !registry.connectionSupports(state.connectionId, "skill-unlock-offerings-v1")) return;
      const unlocks = await skills.unlockState(state.playerId);
      safeSendServerMessage(socket, { type: "SKILL_UNLOCK_STATE", ...unlocks });
    };
    const sendSkillError = (targetSocket: SocketLike, requestId: string, error: unknown): void => {
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: error instanceof SkillRequestError ? error.code : "SKILL_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Skill request rejected"
      });
    };
    const sendEquipmentError = (
      targetSocket: SocketLike,
      requestId: string,
      error: unknown,
      kitIndex?: CombatKitIndex,
      currentEquipment?: EquipmentSnapshotV2 | null
    ): void => {
      const equipmentError = error instanceof EquipmentError ? error : null;
      const walletError = error instanceof WalletOperationError ? error : null;
      if (equipmentError?.invalidReason && kitIndex && currentEquipment) {
        safeSendServerMessage(targetSocket, {
          type: "COMBAT_KIT_INVALIDATED",
          requestId,
          kitIndex,
          reason: equipmentError.invalidReason,
          equipment: currentEquipment
        });
      }
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId,
        code: equipmentError?.code ?? walletError?.code ?? "EQUIPMENT_REJECTED",
        message: error instanceof Error ? error.message : "Equipment request rejected"
      });
    };
    switch (message.type) {
      case "PICKUP_XORAL_RING_DROP": {
        requireHello(state.playerId);
        if (!xoralEvents) throw new Error("Xoral events are unavailable");
        try {
          await xoralEvents.pickupRingDrop(state.playerId, message.dropId, message.requestId);
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof XoralEventError ? error.code : "XORAL_DROP_PICKUP_FAILED",
            message: error instanceof Error ? error.message : "The Xoral ring could not be picked up"
          });
        }
        return;
      }
      case "CONFIRM_XORAL_EXIT": {
        requireHello(state.playerId);
        if (!xoralEvents) throw new Error("Xoral events are unavailable");
        try {
          const result = await xoralEvents.confirmExit(state.playerId);
          if (result.role === "follower") {
            registry.send(state.playerId, {
              type: "XORAL_PARTICIPANT_EXITED",
              requestId: message.requestId,
              eventId: result.eventId,
              reason: "You left The Xoral event and cannot rejoin it."
            });
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof XoralEventError ? error.code : "XORAL_EXIT_FAILED",
            message: error instanceof Error ? error.message : "The Xoral event could not be left"
          });
        }
        return;
      }
      case "START_XORAL_EVENT": {
        requireHello(state.playerId);
        if (!xoralEvents) throw new Error("Xoral events are unavailable");
        let started: Awaited<ReturnType<XoralEventService["start"]>> | null = null;
        try {
          const result = await xoralEvents.start(state.playerId, message.xoralEntityId);
          started = result;
          const failStart = async (
            code: string,
            reason: string,
            retryAfterMs?: number
          ): Promise<void> => {
            await xoralEvents.resetStartingEvent(result.eventId, result.participantIds);
            started = null;
            const retryableReason = `${reason} The Xoral remains available; try again.`;
            for (const participantId of result.participantIds) {
              registry.send(participantId, {
                type: "ERROR",
                requestId: message.requestId,
                code,
                message: retryableReason,
                retryable: true,
                ...(retryAfterMs === undefined
                  ? {}
                  : { details: { retryAfterMs } })
              });
            }
          };
          for (const participantId of result.participantIds) {
            if (!xoralEvents.isStartingPartyCurrent(result)) {
              await failStart(
                "XORAL_PARTY_CHANGED",
                "The party changed while The Xoral event was starting."
              );
              return;
            }
            if (!gameState.isWorldPresent(participantId)) continue;
            const moved = await recenterXoralParticipant(
              participantId,
              result.anchor,
              `xoral-start:${result.eventId}:${participantId}`.slice(0, 128)
            );
            if (!moved.success) {
              const participantName = gameState.getPlayer(participantId)?.username
                ?? "A party member";
              await failStart(
                moved.reason.code,
                `${participantName} could not load into The Xoral event: ${moved.reason.message}`,
                moved.reason.retryAfterMs
              );
              return;
            }
          }
          if (!xoralEvents.isStartingPartyCurrent(result)) {
            await failStart(
              "XORAL_PARTY_CHANGED",
              "The party changed while The Xoral event was starting."
            );
            return;
          }
          await xoralEvents.activateStartedEvent(result.eventId);
          started = null;
          for (const participantId of result.participantIds) {
            registry.send(participantId, {
              type: "XORAL_EVENT_STARTED",
              requestId: message.requestId,
              eventId: result.eventId,
              xoralEntityId: result.entityId,
              participantPlayerIds: result.participantIds
            });
          }
        } catch (error) {
          let resetForRetry = false;
          if (started) {
            const failedStart = started;
            try {
              resetForRetry = await xoralEvents.resetStartingEvent(
                failedStart.eventId,
                failedStart.participantIds
              );
              if (resetForRetry) {
                for (const participantId of failedStart.participantIds) {
                  if (participantId === state.playerId) continue;
                  registry.send(participantId, {
                    type: "ERROR",
                    requestId: message.requestId,
                    code: error instanceof XoralEventError ? error.code : "XORAL_START_FAILED",
                    message: "The Xoral event could not finish loading. The Xoral remains available; try again.",
                    retryable: true
                  });
                }
              }
            } catch {
              resetForRetry = false;
            }
          }
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof XoralEventError ? error.code : "XORAL_START_FAILED",
            message: resetForRetry
              ? `${error instanceof Error ? error.message : "The Xoral event could not start"} The Xoral remains available; try again.`
              : error instanceof Error ? error.message : "The Xoral event could not start",
            ...(resetForRetry ? { retryable: true } : {})
          });
        }
        return;
      }
      case "REQUEST_PROGRESSION_SNAPSHOT": {
        requireHello(state.playerId);
        const refreshed = await refreshAuthoritativePlayerStats(state.playerId);
        safeSendServerMessage(socket, {
          type: "PROGRESSION_SNAPSHOT",
          progression: refreshed.progression
        });
        safeSendServerMessage(socket, {
          type: "EQUIPMENT_SNAPSHOT",
          equipment: refreshed.equipment
        });
        return;
      }
      case "CONFIRM_LEVEL_UP": {
        requireHello(state.playerId);
        try {
          if (!progression) throw new ProgressionRequestError("LEVEL_UP_UNAVAILABLE", "Level up is unavailable right now.");
          enforcePlayerClassRate("level-up", 6, 10_000);
          const result = await progression.confirmLevelUp({
            playerId: state.playerId,
            targetLevel: message.targetLevel,
            expectedGlimmerCost: message.expectedGlimmerCost
          });
          const refreshed = await refreshAuthoritativePlayerStats(state.playerId);
          registry.send(state.playerId, {
            type: "LEVEL_UP",
            level: result.level,
            progression: refreshed.progression,
            requestId: message.requestId,
            replayed: result.replayed,
            ...(result.premiumWallet ? { premiumWallet: result.premiumWallet } : {})
          });
          registry.send(state.playerId, { type: "EQUIPMENT_SNAPSHOT", equipment: refreshed.equipment });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof ProgressionRequestError ? error.code : "LEVEL_UP_REJECTED",
            message: error instanceof ProgressionRequestError ? error.message : "Level up failed. Try again."
          });
        }
        return;
      }
      case "REQUEST_CLASS_SNAPSHOT": {
        requireHello(state.playerId);
        if (!classes) throw new Error("Class service is unavailable");
        enforcePlayerClassRate("query", 30, 60_000);
        safeSendServerMessage(socket, {
          type: "CLASS_SNAPSHOT",
          requestId: message.requestId,
          snapshot: await classes.getOrCreate(state.playerId)
        });
        return;
      }
      case "REQUEST_SKILL_TREE_SNAPSHOT": {
        requireHello(state.playerId);
        if (!skills || !equipment) throw new Error("Skill service is unavailable");
        enforcePlayerClassRate("skill-query", 30, 60_000);
        try {
          const snapshot = await skills.getOrCreate(state.playerId);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, snapshot, currentEquipment);
          safeSendServerMessage(socket, {
            type: "SKILL_TREE_SNAPSHOT",
            requestId: message.requestId,
            snapshot
          });
          await sendSkillUnlockState();
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        }
        return;
      }
      case "SPEND_SKILL_POINT": {
        requireHello(state.playerId);
        if (!skills || !specializations || !equipment) throw new Error("Skill service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("skill-spend", 12, 10_000);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          const result = message.target.kind === "general_skill"
            ? await skills.spendGeneralSkillPoint(
                state.playerId, message.target.skillId, message.requestId, message.expectedRevision
              )
            : message.target.kind === "world_knowledge"
              ? await skills.spendWorldKnowledgePoint(
                  state.playerId, message.target.skillId, message.requestId, message.expectedRevision
                )
              : await specializations.spendSpecializationPoint(
                  state.playerId, message.target.specializationId, message.requestId, message.expectedRevision,
                  {
                    inCombat: combat?.isInCombat(state.playerId) ?? false,
                    hasUnresolvedAction: (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                      (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
                    movementRestricted: Boolean(equipment.pendingActivation(state.playerId)),
                    locationRestricted: worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false
                  }
                );
          await applyLiveSkillMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, message.target.kind !== "specialization" ? {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "spend",
            replayed: result.replayed,
            snapshot: result.snapshot
          } : {
            type: "SPECIALIZATION_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "spend",
            specializationId: message.target.specializationId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
          // A class writ is debited with Rank 1: refresh the bag and the offered writs.
          if (message.target.kind === "specialization" && !result.replayed && inventory) {
            registry.send(state.playerId, {
              type: "INVENTORY_STACK_UPDATED", requestId: message.requestId, action: "reorganize",
              inventory: await inventory.getInventorySnapshot(state.playerId), serverTime: Date.now(),
              message: "Class writ offered."
            });
            await sendSkillUnlockState();
          }
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "OFFER_SKILL_UNLOCK": {
        requireHello(state.playerId);
        if (!skills || !inventory || !equipment) throw new Error("Skill service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("skill-offer", 6, 10_000);
          const offered = await offerGeneralSkill(skills, inventory, state.playerId, message.skillId, message.requestId);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, offered.result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "offer",
            replayed: offered.result.replayed,
            snapshot: offered.result.snapshot
          });
          registry.send(state.playerId, {
            type: "INVENTORY_STACK_UPDATED", requestId: message.requestId, action: "reorganize",
            inventory: offered.inventory, serverTime: Date.now(), message: offered.message
          });
          await sendSkillUnlockState();
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "REFUND_SKILL_RANK": {
        requireHello(state.playerId);
        if (!skills || !specializations || !equipment) throw new Error("Skill service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("skill-refund", 6, 60_000);
          const result = message.target.kind === "general_skill"
            ? await skills.refundGeneralSkillRank(
                state.playerId, message.target.skillId, message.requestId, message.expectedRevision
              )
            : await specializations.refundSpecializationRank(
                state.playerId, message.target.specializationId, message.requestId, message.expectedRevision
              );
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, message.target.kind === "general_skill" ? {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "refund",
            replayed: result.replayed,
            snapshot: result.snapshot
          } : {
            type: "SPECIALIZATION_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "refund",
            specializationId: message.target.specializationId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "ACTIVATE_SPECIALIZATION": {
        requireHello(state.playerId);
        if (!specializations || !equipment) throw new Error("Specialization service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("specialization-switch", 5, 60_000);
          const result = await specializations.activateSpecialization(
            state.playerId,
            message.specializationId,
            message.requestId,
            message.expectedRevision,
            {
              inCombat: combat?.isInCombat(state.playerId) ?? false,
              hasUnresolvedAction: (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
              movementRestricted: Boolean(equipment.pendingActivation(state.playerId)),
              locationRestricted: worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false
            }
          );
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "SPECIALIZATION_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "activate",
            specializationId: message.specializationId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "RESPEC_SKILL_BUILD": {
        requireHello(state.playerId);
        if (!skills || !equipment) throw new Error("Skill service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("skill-respec", 3, 60_000);
          const result = await skills.fullBuildRespec(
            state.playerId,
            message.requestId,
            message.expectedRevision,
            {
              inCombat: combat?.isInCombat(state.playerId) ?? false,
              deadOrDowned: combat ? !combat.isPlayerAlive(state.playerId) : false,
              hasUnresolvedAction: (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
              locationRestricted: worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false,
              equipmentMutationPending: Boolean(equipment.pendingActivation(state.playerId))
            },
            message.expectedGlimmerCost
          );
          if (!result.replayed) combat?.resetPlayerSkillV3Runtime(state.playerId);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(
            state.playerId,
            result.snapshot,
            currentEquipment,
            { preserveHealthPercentage: true }
          );
          registry.send(state.playerId, {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "respec",
            replayed: result.replayed,
            snapshot: result.snapshot,
            ...(result.premiumWallet ? { premiumWallet: result.premiumWallet } : {})
          });
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "EQUIP_GENERAL_ACTIVE": {
        requireHello(state.playerId);
        if (!skills || !equipment) throw new Error("Skill service is unavailable");
        try {
          enforcePlayerClassRate("skill-loadout", 12, 10_000);
          const result = await skills.equipGeneralActive(
            state.playerId,
            message.slot,
            message.skillId,
            message.requestId,
            message.expectedRevision,
            {
              inCombat: combat?.isInCombat(state.playerId) ?? false,
              hasUnresolvedAction: (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
              movementRestricted: (worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false) ||
                Boolean(equipment.pendingActivation(state.playerId))
            }
          );
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "equip",
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        }
        return;
      }
      case "EQUIP_CLASS_TECHNIQUE": {
        requireHello(state.playerId);
        if (!specializations || !equipment) throw new Error("Specialization service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("skill-loadout", 12, 10_000);
          const result = await specializations.equipClassTechnique(
            state.playerId,
            message.techniqueId,
            message.requestId,
            message.expectedRevision,
            {
              inCombat: combat?.isInCombat(state.playerId) ?? false,
              hasUnresolvedAction: (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
              movementRestricted: worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false,
              locationRestricted: worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false,
              equipmentActivationPending: Boolean(equipment.pendingActivation(state.playerId))
            }
          );
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "equip",
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "UPDATE_CLASS_LOADOUT": {
        requireHello(state.playerId);
        if (!classes || !equipment) throw new Error("Class service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
            throw new ClassRequestError("PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is pending");
          }
          if (equipment.pendingActivation(state.playerId)) {
            throw new ClassRequestError(
              "EQUIPMENT_ACTIVATION_PENDING",
              "Class loadout cannot change while a combat-kit activation is pending"
            );
          }
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("loadout", 12, 10_000);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          const result = await classes.updateLoadout(state.playerId, message.loadout, message.requestId, {
            inCombat: (combat?.isInCombat(state.playerId) ?? false) ||
              (combat?.hasQueuedAbility(state.playerId) ?? false) ||
              (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
            equipment: currentEquipment
          });
          await applyLiveClassMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "CLASS_MUTATION_CONFIRMED",
            requestId: message.requestId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "ACTIVATE_SUBCLASS": {
        requireHello(state.playerId);
        if (!classes || !equipment) throw new Error("Class service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
            throw new ClassRequestError("PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is pending");
          }
          if (equipment.pendingActivation(state.playerId)) {
            throw new ClassRequestError(
              "EQUIPMENT_ACTIVATION_PENDING",
              "Subclass cannot change while a combat-kit activation is pending"
            );
          }
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("switch", 5, 60_000);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          const result = await classes.activateSubclass(state.playerId, message.subclassId, message.requestId, {
            restricted: (combat?.isInCombat(state.playerId) ?? false) ||
              (combat?.hasQueuedAbility(state.playerId) ?? false) ||
              (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
            equipment: currentEquipment
          });
          await applyLiveClassMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "CLASS_MUTATION_CONFIRMED",
            requestId: message.requestId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "ACTIVATE_CLASS": {
        requireHello(state.playerId);
        if (!classes || !equipment) throw new Error("Class service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
            throw new ClassRequestError("PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is pending");
          }
          if (equipment.pendingActivation(state.playerId)) {
            throw new ClassRequestError(
              "EQUIPMENT_ACTIVATION_PENDING",
              "Class cannot change while a combat-kit activation is pending"
            );
          }
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("switch", 5, 60_000);
          const outgoingRuntime = combat?.peekDirtyClassRuntimes()
            .find((runtime) => runtime.playerId === state.playerId);
          if (outgoingRuntime) {
            await classes.persistRuntime(state.playerId, outgoingRuntime);
            combat?.markClassRuntimesPersisted([{ playerId: state.playerId, version: outgoingRuntime.version }]);
          }
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          const result = await classes.activateClass(state.playerId, message.classId, message.requestId, {
            restricted: (combat?.isInCombat(state.playerId) ?? false) ||
              (combat?.hasQueuedAbility(state.playerId) ?? false) ||
              (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
            equipment: currentEquipment
          });
          await applyLiveClassMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "CLASS_MUTATION_CONFIRMED",
            requestId: message.requestId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "UNLOCK_CLASS": {
        requireHello(state.playerId);
        if (!classes || !equipment) throw new Error("Class service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("unlock", 5, 60_000);
          const result = await classes.unlockClass(state.playerId, message.classId, message.requestId);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveClassMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "CLASS_MUTATION_CONFIRMED", requestId: message.requestId,
            replayed: result.replayed, snapshot: result.snapshot
          });
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "UPGRADE_EQUIPMENT": {
        requireHello(state.playerId);
        if (!equipment || !authenticatedSession) {
          throw new Error("Equipment service is unavailable");
        }
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          if (
            (message.facilityStructureId && message.manorSessionId) ||
            Boolean(message.manorSessionId) !==
              (message.manorMovementSequence !== undefined)
          ) {
            throw new EquipmentError(
              "EQUIPMENT_INVALID_REQUEST",
              "Choose one complete equipment-upgrade authority."
            );
          }
          const manorSmithAuthority = message.manorSessionId
            ? await prepareManorSmithAuthority({
                playerId: state.playerId,
                sessionId: message.manorSessionId,
                movementSequence: message.manorMovementSequence as number,
                manorPresence,
                manorRuntime
              })
            : null;
          const authority = manorSmithAuthority ??
            (message.facilityStructureId
              ? {
                  kind: "legacy_city_replay" as const,
                  facilityStructureId: message.facilityStructureId
                }
              : undefined);
          const result = await equipment.upgrade(
            {
              playerId: state.playerId,
              accountId: authenticatedSession.account.id
            },
            message.instanceId,
            message.expectedLevel,
            message.requestId,
            undefined,
            authority
          );
          const upgradedActiveItem = Object.values(result.equipment.active)
            .some((item) => item?.instanceId === result.instanceId);
          if (result.applied && upgradedActiveItem) {
            stageEquipmentSnapshot(
              state.playerId,
              message.requestId,
              "active_item_upgrade",
              result.equipment
            );
          }
          safeSendServerMessage(socket, {
            type: "EQUIPMENT_UPGRADE_RESULT",
            requestId: message.requestId,
            replayed: result.replayed,
            instanceId: result.instanceId,
            levelBefore: result.levelBefore,
            levelAfter: result.levelAfter,
            goldCost: result.goldCost,
            balanceVersion: result.balanceVersion,
            goldBalance: result.goldBalance,
            equipment: result.equipment
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "REPAIR_EQUIPMENT": {
        requireHello(state.playerId);
        if (!equipment || !authenticatedSession) {
          throw new Error("Equipment service is unavailable");
        }
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const authority = await prepareManorSmithAuthority({
            playerId: state.playerId,
            sessionId: message.manorSessionId,
            movementSequence: message.manorMovementSequence,
            manorPresence,
            manorRuntime
          });
          const result = await equipment.repairEquipment(
            {
              playerId: state.playerId,
              accountId: authenticatedSession.account.id
            },
            message.instanceId,
            message.expectedCondition,
            message.requestId,
            authority
          );
          safeSendServerMessage(socket, {
            type: "EQUIPMENT_REPAIRED",
            requestId: message.requestId,
            replayed: result.replayed,
            instanceId: result.instanceId,
            conditionBefore: result.conditionBefore,
            conditionAfter: result.conditionAfter,
            materialCosts: result.materialCosts,
            inventory: result.inventory,
            equipment: result.equipment,
            message: result.message
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "MEND_EQUIPMENT": {
        requireHello(state.playerId);
        if (!equipment || !authenticatedSession) {
          throw new Error("Equipment service is unavailable");
        }
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const result = await equipment.mendEquipmentWithResin(
            { playerId: state.playerId, accountId: authenticatedSession.account.id },
            message.instanceId,
            message.requestId,
            message.stackId
          );
          safeSendServerMessage(socket, {
            type: "EQUIPMENT_REPAIRED",
            requestId: message.requestId,
            replayed: result.replayed,
            instanceId: result.instanceId,
            conditionBefore: result.conditionBefore,
            conditionAfter: result.conditionAfter,
            materialCosts: result.materialCosts,
            inventory: result.inventory,
            equipment: result.equipment,
            message: result.message
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "CRAFT_UTILITY_GEAR": {
        requireHello(state.playerId);
        if (!equipment) throw new Error("Equipment service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const result = await equipment.craftUtilityGear(state.playerId, message.requestId, message.definitionId, authenticatedSession?.account.id);
          const spec = UTILITY_GEAR[result.definitionId];
          safeSendServerMessage(socket, {
            type: "EQUIPMENT_ACQUIRED",
            requestId: message.requestId,
            action: "craft",
            replayed: result.replayed,
            definitionId: result.definitionId,
            instanceId: result.instanceId,
            materialCosts: spec.materials.map((material) => ({ itemId: material.itemId, quantity: material.quantity })),
            goldCost: String(spec.goldCost ?? 0),
            ...(result.walletGold !== undefined && result.walletVersion !== undefined
              ? { walletGold: result.walletGold, walletVersion: result.walletVersion } : {}),
            inventory: result.inventory,
            equipment: result.equipment,
            message: result.replayed ? `${spec.displayName} craft already applied.` : `Crafted a ${spec.displayName}.`
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "CRAFT_GEAR_SCROLL":
      case "REQUEST_GEAR_SCROLLS":
      case "REMEMBER_GEAR_SCROLL": {
        requireHello(state.playerId);
        if (!equipment) throw new Error("Equipment service is unavailable");
        try {
          if (message.type === "CRAFT_GEAR_SCROLL") {
            const result = await equipment.craftGearScroll(state.playerId, message.requestId);
            safeSendServerMessage(socket, {
              type: "GEAR_SCROLLS_STATE", requestId: message.requestId, action: "craft",
              replayed: result.replayed, gearScrolls: result.gearScrolls, inventory: result.inventory
            });
          } else if (message.type === "REMEMBER_GEAR_SCROLL") {
            const gearScrolls = await equipment.rememberGearScroll(state.playerId, message.position, message.group);
            safeSendServerMessage(socket, { type: "GEAR_SCROLLS_STATE", requestId: message.requestId, action: "remember", gearScrolls });
          } else {
            const gearScrolls = await equipment.gearScrolls(state.playerId);
            safeSendServerMessage(socket, { type: "GEAR_SCROLLS_STATE", requestId: message.requestId, action: "snapshot", gearScrolls });
          }
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        }
        return;
      }
      case "EQUIP_GEAR_SCROLL": {
        requireHello(state.playerId);
        if (!equipment || !combat) throw new Error("Equipment service is unavailable");
        const playerId = state.playerId;
        if (!combat.isPlayerAlive(playerId) && !manorRuntime?.isInside(playerId)) {
          sendEquipmentError(socket, message.requestId, new EquipmentError(
            "EQUIPMENT_INVALID_REQUEST", "Gear can be swapped only while alive"
          ));
          return;
        }
        try {
          let activeClass: Awaited<ReturnType<ClassService["getOrCreate"]>> | null = null;
          const outcome = await equipment.equipGearScroll(playerId, message.position, message.requestId, {
            exclusive: async (work) => {
              if (classRealtimeState.hasActiveMutation(playerId)) {
                throw new EquipmentError("EQUIPMENT_MUTATION_PENDING", "Another equipment change is still pending");
              }
              const token = classRealtimeState.beginMutation(playerId);
              try {
                activeClass = classes ? await classes.getOrCreate(playerId) : null;
                return await work();
              } finally {
                classRealtimeState.endMutation(playerId, token);
              }
            },
            // Combat stats change at the next tick boundary, never in the middle of an attack.
            onApplied: async (worn, requestId) => {
              // The max health for the new set rides with the update; the engine rebuilds max HP from it.
              const maxHealth = resolvePveMaxHealth ? await resolvePveMaxHealth(playerId, worn).catch(() => null) : null;
              stageEquipmentSnapshot(playerId, requestId, "gear_scroll", worn, { maxHealth });
            },
            classAllows: (weapon, chest) => {
              const current = activeClass as Awaited<ReturnType<ClassService["getOrCreate"]>> | null;
              return !current || classEquipmentCompatibility({
                classId: current.activeClassId,
                subclassId: current.activeSubclassId,
                weaponCategory: weapon?.weaponCategory ?? null,
                armorCategory: chest?.armorCategory ?? null
              }).compatible;
            }
          });
          if (outcome.kind === "superseded") {
            safeSendServerMessage(socket, {
              type: "GEAR_SCROLLS_STATE", requestId: outcome.requestId, action: "equip",
              superseded: true, position: outcome.position
            });
          } else {
            const worn = equipment.runtimeSnapshot(playerId);
            safeSendServerMessage(socket, {
              type: "GEAR_SCROLLS_STATE", requestId: outcome.requestId, action: "equip",
              position: outcome.position, equipped: outcome.equipped, skipped: outcome.skipped,
              ...(outcome.changed && worn ? { equipment: worn } : {})
            });
          }
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        }
        return;
      }
      case "POLISH_RING":
      case "DUMP_RING": {
        requireHello(state.playerId);
        if (!equipment) throw new Error("Equipment service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const action = message.type === "POLISH_RING" ? "polish" : "dump";
          const result = action === "polish"
            ? await equipment.polishRing(state.playerId, message.instanceId, message.requestId)
            : await equipment.dumpRing(state.playerId, message.instanceId, message.requestId);
          const tierName = RING_TIER_RULES[result.tier].displayName;
          safeSendServerMessage(socket, {
            type: "RING_OPERATION_RESULT",
            requestId: message.requestId,
            replayed: result.replayed,
            action,
            instanceId: message.instanceId,
            tier: result.tier,
            oilSpent: result.oilSpent,
            shardsGranted: result.shardsGranted,
            inventory: result.inventory,
            equipment: result.equipment,
            message: action === "polish"
              ? `${tierName} polished${result.oilSpent > 0 ? ` for ${result.oilSpent} Glimmer Oil` : ""}.`
              : `${tierName} dumped for ${result.shardsGranted} Ring Shards.`
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "CRAFT_REPAIR_KIT": {
        requireHello(state.playerId);
        if (!equipment || !authenticatedSession) {
          throw new Error("Equipment service is unavailable");
        }
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const authority = await prepareManorSmithAuthority({
            playerId: state.playerId,
            sessionId: message.manorSessionId,
            movementSequence: message.manorMovementSequence,
            manorPresence,
            manorRuntime
          });
          const result = await equipment.craftRepairKit(
            {
              playerId: state.playerId,
              accountId: authenticatedSession.account.id
            },
            message.requestId,
            authority
          );
          safeSendServerMessage(socket, {
            type: "REPAIR_KIT_CRAFTED",
            requestId: message.requestId,
            replayed: result.replayed,
            quantity: result.quantity,
            materialCosts: result.materialCosts,
            inventory: result.inventory,
            equipment: result.equipment,
            message: result.message
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "CRAFT_EQUIPMENT":
      case "PURCHASE_LIMITED_EQUIPMENT": {
        requireHello(state.playerId);
        if (!equipment || !authenticatedSession) {
          throw new Error("Equipment service is unavailable");
        }
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const playerId = state.playerId;
          if (
            message.manorSessionId === undefined ||
            message.manorMovementSequence === undefined
          ) {
            // Only a portable craft (starter gathering tool) may omit the Smithing Station.
            if (
              message.type !== "CRAFT_EQUIPMENT" ||
              message.manorSessionId !== undefined ||
              message.manorMovementSequence !== undefined
            ) {
              throw new EquipmentError(
                "EQUIPMENT_INVALID_REQUEST",
                "Choose one complete Smithing Station authority."
              );
            }
            if (!isPortableEquipmentCraft(message.familyId, message.definitionId)) {
              throw new EquipmentError(
                "MANOR_SMITH_ACCESS_DENIED",
                "Craft that at your Manor's Smithing Station."
              );
            }
          }
          const authority = message.manorSessionId !== undefined &&
            message.manorMovementSequence !== undefined
            ? await prepareManorSmithAuthority({
                playerId,
                sessionId: message.manorSessionId,
                movementSequence: message.manorMovementSequence,
                manorPresence,
                manorRuntime
              })
            : {
                kind: "portable_craft" as const,
                authorize: async (): Promise<void> => {
                  if (worldRuntime?.hasPlayerWorldTransition(playerId)) {
                    throw new EquipmentError(
                      "EQUIPMENT_INVALID_REQUEST",
                      "Finish travelling before crafting."
                    );
                  }
                }
              };
          const actor = {
            playerId: state.playerId,
            accountId: authenticatedSession.account.id
          };
          const result = message.type === "CRAFT_EQUIPMENT"
            ? await equipment.craftStockEquipment(
                actor,
                message.familyId,
                message.requestId,
                authority,
                message.definitionId
              )
            : authority.kind === "manor_smith"
              ? await equipment.purchaseLimitedEquipment(
                  actor,
                  message.definitionId,
                  message.requestId,
                  authority
                )
              : (() => {
                  throw new EquipmentError(
                    "MANOR_SMITH_ACCESS_DENIED",
                    "Buy that at your Manor's Smithing Station."
                  );
                })();
          safeSendServerMessage(socket, {
            type: "EQUIPMENT_ACQUIRED",
            requestId: message.requestId,
            action: result.action,
            replayed: result.replayed,
            definitionId: result.definitionId,
            instanceId: result.instanceId,
            materialCosts: result.materialCosts,
            goldCost: result.goldCost,
            ...(result.walletGold !== undefined && result.walletVersion !== undefined
              ? {
                  walletGold: result.walletGold,
                  walletVersion: result.walletVersion
                }
              : {}),
            inventory: result.inventory,
            equipment: result.equipment,
            message: result.message
          });
        } catch (error) {
          sendEquipmentError(socket, message.requestId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "SAVE_COMBAT_KIT":
      case "RENAME_COMBAT_KIT":
      case "CLEAR_COMBAT_KIT": {
        requireHello(state.playerId);
        if (!equipment) throw new Error("Equipment service is unavailable");
        let mutationToken: symbol | null = null;
        const kitIndex = message.kitIndex as CombatKitIndex;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const before = equipment.runtimeSnapshot(state.playerId);
          const result = message.type === "SAVE_COMBAT_KIT"
            ? await equipment.saveCombatKit(
                state.playerId,
                kitIndex,
                message.expectedInventoryRevision,
                message.requestId
              )
            : message.type === "RENAME_COMBAT_KIT"
              ? await equipment.renameCombatKit(
                  state.playerId,
                  kitIndex,
                  message.name,
                  message.requestId
                )
              : await equipment.clearCombatKit(
                  state.playerId,
                  kitIndex,
                  message.expectedInventoryRevision,
                  message.requestId
                );
          if (
            result.applied &&
            (
              message.type === "SAVE_COMBAT_KIT" ||
              (
                message.type === "CLEAR_COMBAT_KIT" &&
                before?.activeKitIndex === kitIndex
              )
            )
          ) {
            stageEquipmentSnapshot(
              state.playerId,
              message.requestId,
              "direct_equipment",
              result.equipment
            );
          }
          safeSendServerMessage(socket, {
            type: "COMBAT_KIT_SNAPSHOT",
            requestId: message.requestId,
            equipment: result.equipment
          });
        } catch (error) {
          sendEquipmentError(
            socket,
            message.requestId,
            error,
            kitIndex,
            equipment.runtimeSnapshot(state.playerId)
          );
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "ACTIVATE_COMBAT_KIT": {
        requireHello(state.playerId);
        if (!equipment || !combat) throw new Error("Equipment service is unavailable");
        const kitIndex = message.kitIndex as CombatKitIndex;
        if (!combat.isPlayerAlive(state.playerId) && !manorRuntime?.isInside(state.playerId)) {
          combat.recordInvalidKitActivation(state.playerId);
          sendEquipmentError(
            socket,
            message.requestId,
            new EquipmentError(
              "EQUIPMENT_INVALID_REQUEST",
              "Combat kits can be activated only while the player is alive"
            ),
            kitIndex,
            equipment.runtimeSnapshot(state.playerId)
          );
          return;
        }
        let mutationToken: symbol | null = null;
        try {
          if (classRealtimeState.hasActiveMutation(state.playerId)) {
            throw new EquipmentError(
              "EQUIPMENT_MUTATION_PENDING",
              "Another equipment or class mutation is still pending"
            );
          }
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const staged = await equipment.stageKitActivation(state.playerId, {
            requestId: message.requestId,
            kitIndex,
            expectedInventoryRevision: message.expectedInventoryRevision
          });
          if (staged.activationTick !== null) {
            safeSendServerMessage(socket, {
              type: "COMBAT_KIT_ACTIVATED",
              requestId: staged.requestId,
              kitIndex: staged.kitIndex,
              inventoryRevision: staged.inventoryRevision,
              activeRevision: staged.activeRevision,
              activationTick: staged.activationTick,
              replayed: true,
              equipment: staged.equipment
            });
            return;
          }
          try {
            stageEquipmentSnapshot(
              state.playerId,
              message.requestId,
              "kit_activation",
              staged.equipment
            );
          } catch (error) {
            equipment.cancelPendingActivation(state.playerId, message.requestId);
            throw error;
          }
        } catch (error) {
          combat.recordInvalidKitActivation(state.playerId);
          sendEquipmentError(
            socket,
            message.requestId,
            error,
            kitIndex,
            equipment.runtimeSnapshot(state.playerId)
          );
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "TOGGLE_READIED_WEAPON": {
        requireHello(state.playerId);
        if (!equipment) throw new Error("Equipment service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          const before = equipment.runtimeSnapshot(state.playerId);
          const result = await equipment.toggleReadiedWeapon(
            state.playerId,
            message.readiedWeaponSlot,
            message.expectedInventoryRevision,
            message.requestId
          );
          if (
            result.applied &&
            result.equipment.activeRevision !== before?.activeRevision
          ) {
            const staged = stageEquipmentSnapshot(
              state.playerId,
              message.requestId,
              "readied_weapon",
              result.equipment
            );
            if (!staged) {
              installAuthoritativePlayerAppearance(gameState, result.equipment);
            }
          }
          safeSendServerMessage(socket, {
            type: "COMBAT_KIT_SNAPSHOT",
            requestId: message.requestId,
            equipment: result.equipment
          });
        } catch (error) {
          sendEquipmentError(
            socket,
            message.requestId,
            error,
            undefined,
            equipment.runtimeSnapshot(state.playerId)
          );
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "EQUIP_ITEM":
      case "UNEQUIP_ITEM": {
        requireHello(state.playerId);
        if (!progression || !equipment) throw new Error("Equipment service is unavailable");
        let mutationToken: symbol | null = null;
        try {
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          if (
            (combat?.isInCombat(state.playerId) ?? false) ||
            (combat?.hasQueuedAbility(state.playerId) ?? false) ||
            (worldRuntime?.hasPendingCommand(state.playerId) ?? false)
          ) {
            throw new ClassRequestError(
              "EQUIPMENT_COMBAT_LOCKED",
              "Equipment cannot change during combat or unresolved actions"
            );
          }
          const before = await equipment.getSnapshot(state.playerId);
          const classBefore = classes ? await classes.getOrCreate(state.playerId) : null;
          const changedInstance = before.instances.find((instance) => instance.instanceId === message.instanceId);
          if (classBefore && changedInstance) {
            const nextWeapon =
              message.type === "EQUIP_ITEM" &&
              message.slot === before.readiedWeaponSlot
              ? changedInstance
              : message.type === "UNEQUIP_ITEM" && before.weapon?.instanceId === message.instanceId
                ? null
                : before.weapon;
            const nextChest = message.type === "EQUIP_ITEM" && message.slot === "chest"
              ? changedInstance
              : message.type === "UNEQUIP_ITEM" && before.chest?.instanceId === message.instanceId
                ? null
                : before.chest;
            const compatibility = classEquipmentCompatibility({
              classId: classBefore.activeClassId,
              subclassId: classBefore.activeSubclassId,
              weaponCategory: nextWeapon?.weaponCategory ?? null,
              armorCategory: nextChest?.armorCategory ?? null
            });
            if (!compatibility.compatible) {
              throw new ClassRequestError(compatibility.code, compatibility.message);
            }
          }
          const result = message.type === "EQUIP_ITEM"
            ? await equipment.equip(state.playerId, message.instanceId, message.slot, message.requestId)
            : await equipment.unequip(state.playerId, message.instanceId, message.requestId);
          const classSnapshot = classes ? await classes.getOrCreate(state.playerId) : null;
          const refreshed = await refreshAuthoritativePlayerStats(state.playerId);
          installAuthoritativePlayerAppearance(gameState, refreshed.equipment);
          if (classSnapshot) {
            combat?.updatePlayerClassState(state.playerId, classSnapshot, refreshed.equipment);
          }
          registry.send(state.playerId, {
            type: "EQUIPMENT_UPDATED",
            requestId: message.requestId,
            replayed: result.replayed,
            equipment: refreshed.equipment,
            progression: refreshed.progression
          });
        } catch (error) {
          if (error instanceof ClassRequestError) {
            sendClassError(socket, message.requestId, error);
          } else {
            sendEquipmentError(socket, message.requestId, error);
          }
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "START_ATTACK": {
        requireHello(state.playerId);
        cancelPendingManorEntry(state.playerId, {
          stopMovement: true,
          notify: true,
          message: "Manor entry was cancelled by combat."
        });
        try {
          enforcePlayerClassRate("focus", 12, 5_000);
        } catch (error) {
          sendClassError(socket, message.requestId, error);
          return;
        }
        if (classRealtimeState.hasActiveMutation(state.playerId)) {
          sendCombatError(socket, message.requestId, "CLASS_MUTATION_PENDING", "Combat cannot start during a class mutation");
          return;
        }
        if (!combat || !worldRuntime || !authenticatedSession || !state.connectionId) {
          sendCombatError(socket, message.requestId, "COMBAT_UNAVAILABLE", "Combat is unavailable");
          return;
        }
        if (gameState.isMovementBlocked(state.playerId, "fishing")) {
          sendCombatError(socket, message.requestId, "FISHING_ACTIVE", "Leave the active Fishing encounter before entering combat");
          return;
        }
        const npcCityId = goblinVillage?.defenderCity(message.targetEntityId) ?? null;
        if (npcCityId && !combat.isNpcCityPlayerEnemy(npcCityId, state.playerId)) {
          if (message.confirmNpcHostility !== true) {
            sendCombatError(
              socket,
              message.requestId,
              "NPC_HOSTILITY_CONFIRMATION_REQUIRED",
              "Confirm hostility before attacking this neutral Goblin defender"
            );
            return;
          }
          try {
            await goblinVillage!.confirmHostility(npcCityId, state.playerId, message.requestId);
          } catch {
            sendCombatError(
              socket,
              message.requestId,
              "NPC_HOSTILITY_PERSISTENCE_FAILED",
              "Goblin hostility could not be recorded"
            );
            return;
          }
        }
        // Only PvP engagement is a land action; monsters and NPCs are never gated.
        const pvpLandAction = gameState.getPlayer(message.targetEntityId)
          ? {
              landActions,
              accountId: authenticatedSession.account.id,
              playerId: state.playerId,
              action: "pvp_engage" as const,
              position: gameState.getPlayer(state.playerId)?.position ?? null
            }
          : null;
        if (
          pvpLandAction
          && !(await landActionAllowed(pvpLandAction, socket, message.requestId, sendCombatError))
        ) return;
        if (pvpLandAction && hostileGate) {
          const hostile = await hostileGate.checkPvp({
            attackerPlayerId: state.playerId,
            targetPlayerId: message.targetEntityId
          });
          if (!hostile.allowed) {
            // An attack on a shielded builder still interrupts the build (no
            // damage), so the shield cannot claim land uncontested.
            if (hostile.role === "target") flagBuilds?.cancelPlayer(message.targetEntityId, "combat");
            sendCombatError(socket, message.requestId, hostile.code, hostile.message);
            return;
          }
        }
        const approachEntity = prewarmWaterPath ? combat.entity(message.targetEntityId) : null;
        const approachTarget = approachEntity ? { lat: approachEntity.lat, lon: approachEntity.lon } : null;
        if (approachTarget && prewarmWaterPath) {
          await prewarmWaterPath(state.playerId, approachTarget).catch(() => undefined);
        }
        if (enqueueWorldCommand({
          kind: "start-attack",
          requestId: message.requestId,
          targetEntityId: message.targetEntityId
        })) {
          flagBuilds?.cancelPlayer(state.playerId, "combat");
          if (pvpLandAction) noteLandAction(pvpLandAction);
        }
        return;
      }
      case "CANCEL_ATTACK": {
        requireHello(state.playerId);
        enqueueWorldCommand({ kind: "cancel-attack", requestId: message.requestId });
        return;
      }
      case "RESPAWN_PLAYER": {
        requireHello(state.playerId);
        if (!combat || !settleAndRespawnPlayer || !recoverPlayerToWorldAnchor) {
          sendCombatError(socket, message.requestId, "COMBAT_UNAVAILABLE", "Respawn is unavailable");
          return;
        }
        const readiness = combat.respawnReadiness(state.playerId);
        if (!readiness) {
          sendCombatError(socket, message.requestId, "RESPAWN_REJECTED", "You can respawn only after being defeated");
          return;
        }
        if (!readiness.ready) {
          const remainingSeconds = Math.max(1, Math.ceil(readiness.remainingMs / 1_000));
          sendCombatError(
            socket,
            message.requestId,
            "RESPAWN_DELAY_ACTIVE",
            `Respawn is available in ${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}.`,
            { retryable: true }
          );
          return;
        }
        try {
          if (!await settleAndRespawnPlayer(state.playerId, async (operationKey) => {
            // A room-respawn dungeon (the Tilted Vault) keeps the player inside; combat's onPlayerRespawn places them.
            if (respawnsInRoomOnDeath?.(state.playerId!) !== true) {
              await recoverPlayerToWorldAnchor(state.playerId!, operationKey);
            }
            return combat.respawnPlayer(state.playerId!) !== null;
          })) {
            sendCombatError(socket, message.requestId, "RESPAWN_REJECTED", "You can respawn only after being defeated");
          }
        } catch (error) {
          logger?.warn(
            { err: error, playerId: state.playerId, requestId: message.requestId },
            "player respawn recovery failed"
          );
          sendCombatError(
            socket,
            message.requestId,
            "RESPAWN_RETRY_REQUIRED",
            "Respawn could not be completed. Try again.",
            { retryable: true }
          );
        }
        return;
      }
      case "USE_GENERAL_ACTIVE": {
        requireHello(state.playerId);
        if (!skills || !equipment) throw new Error("Skill service is unavailable");
        cancelPendingManorEntry(state.playerId, {
          stopMovement: true,
          notify: true,
          message: "Manor entry was cancelled by combat."
        });
        if (classRealtimeState.hasActiveMutation(state.playerId)) {
          sendCombatError(socket, message.requestId, "SKILL_MUTATION_PENDING", "Skills cannot resolve during a build mutation");
          return;
        }
        try {
          enforcePlayerClassRate("skill-ability", 20, 5_000);
          if (message.skillId === "edict_stride") {
            // World Knowledge active: rank gate, then side-effect-free checks, then the Edict Seal, then the world command.
            if (!dungeonSkills || !combat) throw new Error("Edict Stride is unavailable");
            const rank = await dungeonSkills.edictStrideRank(state.playerId);
            if (rank < 1) throw new SkillRequestError("SKILL_ACTIVE_UNAVAILABLE", "Edict Stride is not learned");
            combat.checkEdictStride({
              playerId: state.playerId,
              ...(message.targetEntityId === undefined ? {} : { targetEntityId: message.targetEntityId }),
              ...(message.targetMode === undefined ? {} : { targetMode: message.targetMode })
            });
            const playerId = state.playerId;
            // The seal is charged only once the engine accepts the use; a rejected or dropped command costs nothing.
            if (enqueueWorldCommand({
              kind: "general-active",
              requestId: message.requestId,
              skillId: "edict_stride",
              worldKnowledgeRank: rank,
              onEdictStrideAccepted: () => {
                void (async () => {
                  try {
                    await dungeonSkills.chargeEdictSeal(playerId, message.requestId);
                    registry.send(playerId, {
                      type: "SKILL_MUTATION_CONFIRMED",
                      requestId: message.requestId,
                      action: "use",
                      replayed: false,
                      snapshot: await skills.getOrCreate(playerId)
                    });
                  } catch (chargeError) {
                    combat.cancelEdictStride(playerId);
                    sendSkillError(socket, message.requestId, chargeError);
                  }
                })();
              },
              ...(message.targetEntityId === undefined ? {} : { targetEntityId: message.targetEntityId }),
              ...(message.targetMode === "hostile" ? { targetMode: message.targetMode } : {})
            })) flagBuilds?.cancelPlayer(state.playerId, "combat");
            return;
          }
          const result = await skills.confirmGeneralActiveUse(
            state.playerId,
            message.skillId,
            message.requestId,
            message.expectedRevision
          );
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(state.playerId, result.snapshot, currentEquipment);
          registry.send(state.playerId, {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "use",
            replayed: result.replayed,
            snapshot: result.snapshot
          });
          if (enqueueWorldCommand({
            kind: "general-active",
            requestId: message.requestId,
            skillId: message.skillId,
            ...(message.targetEntityId === undefined ? {} : { targetEntityId: message.targetEntityId }),
            ...(message.targetMode === "hostile" || message.targetMode === "friendly" || message.targetMode === "self"
              ? { targetMode: message.targetMode }
              : {}),
            ...(message.targetPosition === undefined ? {} : { targetPosition: message.targetPosition }),
            ...(message.directionDegrees === undefined ? {} : { directionDegrees: message.directionDegrees })
          })) flagBuilds?.cancelPlayer(state.playerId, "combat");
        } catch (error) {
          sendSkillError(socket, message.requestId, error);
        }
        return;
      }
      case "USE_NORMAL_ABILITY": {
        requireHello(state.playerId);
        cancelPendingManorEntry(state.playerId, {
          stopMovement: true,
          notify: true,
          message: "Manor entry was cancelled by combat."
        });
        if (classRealtimeState.hasActiveMutation(state.playerId)) {
          sendCombatError(socket, message.requestId, "CLASS_MUTATION_PENDING", "Abilities cannot resolve during a class mutation");
          return;
        }
        try {
          enforcePlayerClassRate("ability", 20, 5_000);
          if (enqueueWorldCommand({
            kind: "normal-ability",
            requestId: message.requestId,
            abilityId: message.abilityId,
            ...(message.targetEntityId === undefined ? {} : { targetEntityId: message.targetEntityId }),
            ...(message.targetMode === undefined ? {} : { targetMode: message.targetMode }),
            ...(message.targetPosition === undefined ? {} : { targetPosition: message.targetPosition })
          })) flagBuilds?.cancelPlayer(state.playerId, "combat");
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        }
        return;
      }
      case "USE_ULTIMATE_ABILITY": {
        requireHello(state.playerId);
        if (classRealtimeState.hasActiveMutation(state.playerId)) {
          sendCombatError(socket, message.requestId, "CLASS_MUTATION_PENDING", "Abilities cannot resolve during a class mutation");
          return;
        }
        try {
          enforcePlayerClassRate("ability", 20, 5_000);
          if (enqueueWorldCommand({
            kind: "ultimate-ability",
            requestId: message.requestId,
            abilityId: message.abilityId,
            ...(message.targetEntityId === undefined ? {} : { targetEntityId: message.targetEntityId }),
            ...(message.targetMode === undefined ? {} : { targetMode: message.targetMode }),
            ...(message.targetPosition === undefined ? {} : { targetPosition: message.targetPosition })
          })) flagBuilds?.cancelPlayer(state.playerId, "combat");
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        }
        return;
      }
      case "USE_RESET_ABILITY": {
        requireHello(state.playerId);
        if (classRealtimeState.hasActiveMutation(state.playerId)) {
          sendCombatError(socket, message.requestId, "CLASS_MUTATION_PENDING", "Abilities cannot resolve during a class mutation");
          return;
        }
        try {
          enforcePlayerClassRate("ability", 20, 5_000);
          if (enqueueWorldCommand({
            kind: "reset-ability",
            requestId: message.requestId,
            abilityId: message.abilityId,
            ...(message.targetEntityId === undefined ? {} : { targetEntityId: message.targetEntityId }),
            ...(message.targetMode === undefined ? {} : { targetMode: message.targetMode })
          })) flagBuilds?.cancelPlayer(state.playerId, "combat");
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        }
        return;
      }
      case "USE_UNIVERSAL_TAUNT": {
        requireHello(state.playerId);
        if (classRealtimeState.hasActiveMutation(state.playerId)) {
          sendCombatError(socket, message.requestId, "CLASS_MUTATION_PENDING", "Taunt cannot resolve during a class mutation");
          return;
        }
        try {
          enforcePlayerClassRate("taunt", 4, 12_000);
          if (enqueueWorldCommand({ kind: "universal-taunt", requestId: message.requestId })) {
            flagBuilds?.cancelPlayer(state.playerId, "combat");
          }
        } catch (error) {
          sendClassError(socket, message.requestId, error);
        }
        return;
      }
    }
  };
  return context.playerAuthorityFence
    ? (message) => context.state.playerId && message.type !== "RESPAWN_PLAYER"
      ? context.playerAuthorityFence!.run(context.state.playerId, () => Promise.resolve(handle(message)))
      : handle(message)
    : handle;
}

async function prepareManorSmithAuthority(input: {
  playerId: string;
  sessionId: string;
  movementSequence: number;
  manorPresence?: ManorPresenceService | undefined;
  manorRuntime?: ManorRuntime | undefined;
}) {
  const { playerId, sessionId, movementSequence, manorPresence, manorRuntime } = input;
  if (!manorPresence || !manorRuntime) {
    throw new EquipmentError(
      "MANOR_SMITH_ACCESS_DENIED",
      "The Smithing Station is unavailable."
    );
  }
  let initial;
  try {
    initial = manorRuntime.authorizeSmith(playerId, sessionId, movementSequence);
  } catch (error) {
    throw manorSmithEquipmentError(error);
  }
  const manorId = initial.manorId;
  if (!await manorPresence.builtManor(manorId)) {
    throw new EquipmentError(
      "MANOR_SMITH_ACCESS_DENIED",
      "That manor no longer exists."
    );
  }
  return {
    kind: "manor_smith" as const,
    manorId,
    manorSessionId: sessionId,
    movementSequence,
    authorize: async (): Promise<void> => {
      if (!await manorPresence.builtManor(manorId)) {
        throw new EquipmentError(
          "MANOR_SMITH_ACCESS_DENIED",
          "That manor no longer exists."
        );
      }
      try {
        const current = manorRuntime.authorizeSmith(playerId, sessionId, movementSequence);
        if (current.manorId !== manorId) {
          throw new ManorError("STALE_SESSION", "That manor session was replaced.");
        }
      } catch (error) {
        throw manorSmithEquipmentError(error);
      }
    }
  };
}

function manorSmithEquipmentError(error: unknown): EquipmentError {
  return new EquipmentError(
    "MANOR_SMITH_ACCESS_DENIED",
    error instanceof ManorError
      ? error.message
      : "Smithing Station authorization failed."
  );
}

export function registerCombatEquipmentHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"combat-equipment">
): void {
  router.register("combat-equipment", handler);
}
