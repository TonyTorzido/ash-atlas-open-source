import {
  CLASS_DEFINITIONS,
  PROFESSION_IDS,
  type AchievementSnapshot,
  type ClassSnapshot,
  type CombatEntitySnapshot,
  type CombatEquipmentServerMessage,
  type CombatKitIndex,
  type CombatStateBatch,
  type DeathDropSummary,
  type DevProgressionType,
  type EquipmentSnapshotV2,
  type MasterySnapshot,
  type PlayerInventorySnapshot,
  type PremiumWalletSnapshot,
  type ProgressionSnapshot,
  type PlayerAppearanceSnapshot,
  type SkillSystemV3ServerMessage,
  type SkillSystemV3Snapshot,
  type SkillUnlockState,
  type SubclassId,
  type XoralRingDropSnapshot
} from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { CombatStore } from "../../combat/combatStore.js";
import type { CombatPresentationController } from "../../combat/combatPresentation.js";
import { killLootCard, ringLootEntries } from "../../combat/lootCards.js";
import { lootCardItemLookup } from "../../combat/lootItemLookup.js";
import {
  combatEventsForAcceptedDelta,
  type FloatingFeedbackInput
} from "../../combat/damageFloaters.js";
import type { PixiGameOverlay } from "../../map/pixiOverlay.js";
import { progressionRecorder } from "../../perf/progressionRecorder.js";
import type { StartupEvent } from "../../startupState.js";
import { reconcileEquipmentSnapshot } from "./equipmentSnapshotAcceptance.js";
import {
  reconcileEquipmentMutationRequest
} from "./equipmentFrameReconciliation.js";
import type {
  WorldViewConvergenceBarrier
} from "../../worldView/worldViewConvergenceBarrier.js";

type RefCell<T> = { current: T };

const COMBAT_EQUIPMENT_FRAME_TYPES = new Set<string>([
  "COMBAT_SNAPSHOT",
  "COMBAT_DELTA",
  "COMBAT_STARTED",
  "COMBAT_CANCELLED",
  "COMBAT_REWARD_GRANTED",
  "XORAL_EVENT_STARTED",
  "XORAL_REWARD_GRANTED",
  "LAND_BONUS_EARNED",
  "XORAL_EVENT_CANCELLED",
  "LEGENDARY_EVENT_ALERT",
  "XORAL_PARTICIPANT_EXITED",
  "XORAL_RING_DROPS_SNAPSHOT",
  "XORAL_RING_DROP_PICKED_UP",
  "PROGRESSION_SNAPSHOT",
  "PVP_STATUS",
  "MASTERY_SNAPSHOT",
  "ACHIEVEMENT_SNAPSHOT",
  "ACHIEVEMENT_UNLOCKED",
  "CLASS_SNAPSHOT",
  "DEV_PROGRESSION_ADJUSTED",
  "CLASS_MUTATION_CONFIRMED",
  "SKILL_TREE_SNAPSHOT",
  "SKILL_MUTATION_CONFIRMED",
  "SPECIALIZATION_MUTATION_CONFIRMED",
  "SKILL_UNLOCK_STATE",
  "ABILITY_QUEUE_UPDATED",
  "CLASS_MASTERY_GRANTED",
  "XP_GRANTED",
  "LEVEL_UP",
  "EQUIPMENT_SNAPSHOT",
  "EQUIPMENT_UPDATED",
  "EQUIPMENT_UPGRADE_RESULT",
  "EQUIPMENT_ACQUIRED",
  "EQUIPMENT_REPAIRED",
  "REPAIR_KIT_CRAFTED",
  "RING_OPERATION_RESULT",
  "COMBAT_KIT_SNAPSHOT",
  "COMBAT_KIT_ACTIVATED",
  "COMBAT_KIT_INVALIDATED"
]);

export interface PendingKitActivation {
  requestId: string;
  kitIndex: CombatKitIndex;
  previousKitIndex: CombatKitIndex | null;
  expectedActiveRevision: number;
}

export function isCombatEquipmentServerMessage(
  message: { type: string }
): message is CombatEquipmentServerMessage | SkillSystemV3ServerMessage {
  return COMBAT_EQUIPMENT_FRAME_TYPES.has(message.type);
}

export interface CombatEquipmentFrameHandlerOptions {
  ownPlayerId: string;
  dispatchStartup(event: StartupEvent): void;
  setProgression: Dispatch<SetStateAction<ProgressionSnapshot | null>>;
  setDeathPenaltyXpLoss: Dispatch<SetStateAction<number | null>>;
  setDeathDropSummary?: Dispatch<SetStateAction<DeathDropSummary | null>>;
  setMasteries: Dispatch<SetStateAction<MasterySnapshot | null>>;
  setAchievements: Dispatch<SetStateAction<AchievementSnapshot | null>>;
  /** Shows an "Achievement unlocked" celebration card (queued, played when the screen settles). */
  announceAchievement(id: string, title: string): void;
  setClassSnapshot: Dispatch<SetStateAction<ClassSnapshot | null>>;
  setClassBusy: Dispatch<SetStateAction<boolean>>;
  setSkillSystemV3Snapshot: Dispatch<SetStateAction<SkillSystemV3Snapshot | null>>;
  /** Discovery offerings and class writs already made (SKILL_UNLOCK_STATE). */
  setSkillUnlockState?: Dispatch<SetStateAction<SkillUnlockState | null>>;
  setSkillSystemV3Busy: Dispatch<SetStateAction<boolean>>;
  setSkillSystemV3Error: Dispatch<SetStateAction<string | null>>;
  skillSystemV3RequestRef: RefCell<string | null>;
  setDevSubclassPending: Dispatch<SetStateAction<SubclassId | null>>;
  setDevProgressionError: Dispatch<SetStateAction<string | null>>;
  setDevProgressionPendingType: Dispatch<SetStateAction<DevProgressionType | null>>;
  receiveInventorySnapshot(inventory: PlayerInventorySnapshot): void;
  setWalletGold(gold: string, revision?: string): void;
  currentWalletGold: string | null;
  refreshMarket(): void;
  setLocalCombatEntity: Dispatch<SetStateAction<CombatEntitySnapshot | null>>;
  equipmentMutationRequestRef: RefCell<string | null>;
  pendingKitActivationRef: RefCell<PendingKitActivation | null>;
  setPendingKitActivation: Dispatch<SetStateAction<PendingKitActivation | null>>;
  setEquipment: Dispatch<SetStateAction<EquipmentSnapshotV2 | null>>;
  setXoralRingDrops: Dispatch<SetStateAction<XoralRingDropSnapshot[]>>;
  setEquipmentBusy: Dispatch<SetStateAction<boolean>>;
  combatStore: CombatStore;
  combatPresentation?: CombatPresentationController;
  appearanceForEntity?(entityId: string): PlayerAppearanceSnapshot | undefined;
  combatServerClockOffsetMsRef: RefCell<number>;
  overlayRef: RefCell<PixiGameOverlay | null>;
  snapRespawnedPlayers(state: CombatStateBatch): void;
  refreshCombatUi(): void;
  requestWorldResync(reason: string): void;
  /** Glimmer balance after a paid respec or level-up. */
  receivePremiumWallet?(snapshot: PremiumWalletSnapshot): void;
  /** Every LEVEL_UP frame (automatic or a confirmed Glimmer level-up). */
  onLevelUp?(message: Extract<CombatEquipmentServerMessage, { type: "LEVEL_UP" }>): void;
  setWarning: Dispatch<SetStateAction<string | null>>;
  showActionError(message: string): void;
  onPvpStatus?(
    message: Extract<CombatEquipmentServerMessage, { type: "PVP_STATUS" }>
  ): void;
  onLegendaryEventAlert?(
    message: Extract<CombatEquipmentServerMessage, { type: "LEGENDARY_EVENT_ALERT" }>
  ): void;
  onEquipmentUpgradeResult?(
    message: Extract<
      CombatEquipmentServerMessage,
      { type: "EQUIPMENT_UPGRADE_RESULT" }
    >
  ): void;
  onEquipmentAcquired?(
    message: Extract<
      CombatEquipmentServerMessage,
      { type: "EQUIPMENT_ACQUIRED" }
    >
  ): void;
  onEquipmentRepaired?(
    message: Extract<CombatEquipmentServerMessage, { type: "EQUIPMENT_REPAIRED" }>
  ): void;
  onRepairKitCrafted?(
    message: Extract<CombatEquipmentServerMessage, { type: "REPAIR_KIT_CRAFTED" }>
  ): void;
  onGearScrolls?(
    message: Extract<CombatEquipmentServerMessage, { type: "GEAR_SCROLLS_STATE" }>
  ): void;
  onRingOperation?(
    message: Extract<CombatEquipmentServerMessage, { type: "RING_OPERATION_RESULT" }>
  ): void;
  onXoralRingDropPickedUp?(
    message: Extract<
      CombatEquipmentServerMessage,
      { type: "XORAL_RING_DROP_PICKED_UP" }
    >
  ): void;
  worldViewBarrierRef?: RefCell<WorldViewConvergenceBarrier>;
}

export function useCombatEquipmentFrameHandler(
  options: CombatEquipmentFrameHandlerOptions
) {
  const {
    ownPlayerId,
    dispatchStartup,
    setProgression,
    setDeathPenaltyXpLoss,
    setDeathDropSummary,
    setMasteries,
    setAchievements,
    announceAchievement,
    setClassSnapshot,
    setClassBusy,
    setSkillSystemV3Snapshot,
    setSkillSystemV3Busy,
    setSkillSystemV3Error,
    skillSystemV3RequestRef,
    setSkillUnlockState,
    setDevSubclassPending,
    setDevProgressionError,
    setDevProgressionPendingType,
    receiveInventorySnapshot,
    setWalletGold,
    currentWalletGold,
    refreshMarket,
    setLocalCombatEntity,
    equipmentMutationRequestRef,
    pendingKitActivationRef,
    setPendingKitActivation,
    setEquipment,
    setXoralRingDrops,
    setEquipmentBusy,
    combatStore,
    combatPresentation,
    appearanceForEntity,
    combatServerClockOffsetMsRef,
    overlayRef,
    snapRespawnedPlayers,
    refreshCombatUi,
    requestWorldResync,
    receivePremiumWallet,
    onLevelUp,
    setWarning,
    showActionError,
    onLegendaryEventAlert,
    onPvpStatus,
    onEquipmentUpgradeResult,
    onEquipmentAcquired,
    onEquipmentRepaired,
    onRepairKitCrafted,
    onRingOperation,
    onGearScrolls,
    onXoralRingDropPickedUp,
    worldViewBarrierRef
  } = options;
  const latestCombatWalletVersionRef = useRef<bigint | null>(null);

  const enqueueFloatingFeedback = useCallback((feedback: FloatingFeedbackInput): void => {
    if (combatPresentation) {
      combatPresentation.enqueueFloatingFeedback(feedback);
    } else {
      overlayRef.current?.enqueueFloatingFeedback(feedback);
    }
  }, [combatPresentation, overlayRef]);

  useEffect(() => {
    latestCombatWalletVersionRef.current = null;
  }, [ownPlayerId]);

  return useCallback((message: CombatEquipmentServerMessage | SkillSystemV3ServerMessage): void => {
    switch (message.type) {
      case "SKILL_TREE_SNAPSHOT":
      case "SKILL_MUTATION_CONFIRMED":
      case "SPECIALIZATION_MUTATION_CONFIRMED":
        setSkillSystemV3Snapshot((current) =>
          current === null || message.snapshot.revision >= current.revision
            ? message.snapshot
            : current
        );
        if (message.type === "SKILL_MUTATION_CONFIRMED" && message.premiumWallet) receivePremiumWallet?.(message.premiumWallet);
        if (skillSystemV3RequestRef.current === message.requestId) {
          skillSystemV3RequestRef.current = null;
          setSkillSystemV3Busy(false);
          setSkillSystemV3Error(null);
        }
        return;
      case "SKILL_UNLOCK_STATE":
        setSkillUnlockState?.({ discoveredGeneralSkills: message.discoveredGeneralSkills, classWrits: message.classWrits });
        return;
      case "PROGRESSION_SNAPSHOT":
        setProgression(message.progression);
        if (message.deathPenalty) setDeathDropSummary?.(message.deathPenalty.deathDrop ?? null);
        if (message.deathPenalty) setDeathPenaltyXpLoss(message.deathPenalty.xpLost);
        dispatchStartup({ type: "progression" });
        return;
      case "PVP_STATUS":
        if (message.walletGold !== undefined && message.walletVersion !== undefined) {
          setWalletGold(message.walletGold, message.walletVersion);
        }
        onPvpStatus?.(message);
        return;
      case "MASTERY_SNAPSHOT":
        setMasteries((current) => {
          if (current) {
            for (const track of PROFESSION_IDS) {
              const previous = current.professions[track];
              const next = message.masteries.professions[track];
              const gained = next.xp - previous.xp;
              if (gained > 0) {
                enqueueFloatingFeedback({
                  eventId: `profession-xp:${track}:${next.xp}`,
                  targetEntityId: ownPlayerId,
                  kind: "profession_xp",
                  amount: gained,
                  subject: track === "oil_worker" ? "Oil Worker" : `${track.charAt(0).toUpperCase()}${track.slice(1)}`,
                  label: `+${gained.toLocaleString()} ${track === "oil_worker" ? "Oil Worker" : `${track.charAt(0).toUpperCase()}${track.slice(1)}`} XP`
                });
              }
            }
          }
          return message.masteries;
        });
        return;
      case "ACHIEVEMENT_SNAPSHOT":
        setAchievements(message.achievements);
        return;
      case "ACHIEVEMENT_UNLOCKED":
        setAchievements(message.achievements);
        announceAchievement(message.achievementId, message.title);
        return;
      case "CLASS_SNAPSHOT":
        setClassSnapshot(message.snapshot);
        setClassBusy(false);
        return;
      case "CLASS_MUTATION_CONFIRMED":
        setClassSnapshot(message.snapshot);
        if (message.walletGold !== undefined && message.walletVersion !== undefined) {
          setWalletGold(message.walletGold, message.walletVersion);
        }
        setClassBusy(false);
        setDevSubclassPending(null);
        setDevProgressionError(null);
        return;
      case "DEV_PROGRESSION_ADJUSTED":
        setClassSnapshot(message.classSnapshot);
        setProgression(message.progression);
        if (message.masteries) setMasteries(message.masteries);
        setDevProgressionPendingType(null);
        setDevProgressionError(null);
        return;
      case "COMBAT_REWARD_GRANTED":
        if (message.playerId === ownPlayerId) {
          // Loot flies to the HUD; its gold is held back from the counter before the wallet updates so
          // the number counts up when the coin lands. Floaters stay the fallback for hosts without a
          // presentation controller.
          if (combatPresentation) {
            const card = killLootCard(message, lootCardItemLookup, performance.now());
            if (card) combatPresentation.enqueueLootCard(card);
          }
          receiveInventorySnapshot(message.inventory);
          const walletUpdate = authoritativeCombatWalletUpdate(
            message,
            latestCombatWalletVersionRef.current,
            currentWalletGold
          );
          if (walletUpdate) {
            latestCombatWalletVersionRef.current = walletUpdate.version;
            setWalletGold(walletUpdate.gold, walletUpdate.version.toString());
          }
          refreshMarket();
          if (!combatPresentation) {
            for (const item of message.items) {
              if (item.quantity <= 0) continue;
              enqueueFloatingFeedback({
                eventId: `combat-item:${message.settlementKey}:${item.itemId}`,
                targetEntityId: ownPlayerId,
                kind: "resource",
                amount: item.quantity,
                icon: item.itemId,
                label: `×${item.quantity.toLocaleString()}`
              });
            }
            for (const [index, ring] of (message.rings ?? []).entries()) {
              enqueueFloatingFeedback({
                eventId: `combat-ring:${message.settlementKey}:${index}`,
                targetEntityId: ownPlayerId,
                kind: "resource",
                amount: 1,
                icon: ring.definitionId,
                label: ringLootEntries(message.settlementKey, [ring])[0]!.name
              });
            }
            if (message.gold > 0) enqueueFloatingFeedback({
              eventId: `gold:${message.settlementKey}`,
              targetEntityId: ownPlayerId,
              kind: "gold",
              amount: message.gold
            });
          }
        }
        return;
      case "XORAL_EVENT_STARTED":
        setWarning("The Xoral event has begun. The party roster is now locked.");
        return;
      case "XORAL_REWARD_GRANTED":
        setWalletGold(message.walletGold, message.walletVersion);
        refreshMarket();
        setWarning(
          `${message.ringDefinitionId.replaceAll("_", " ")} awarded${
            message.ringDelivery === "ground" ? " on the ground because inventory is full" : ""
          }. +${message.gold.toLocaleString()} Gold.`
        );
        return;
      case "LAND_BONUS_EARNED": {
        // Batched by the server (at most one frame per window), so one notice is never spam.
        const walletUpdate = authoritativeCombatWalletUpdate(
          message,
          latestCombatWalletVersionRef.current,
          currentWalletGold
        );
        if (walletUpdate) {
          latestCombatWalletVersionRef.current = walletUpdate.version;
          setWalletGold(walletUpdate.gold, walletUpdate.version.toString());
        }
        refreshMarket();
        setWarning(
          `Your land earned +${message.gold.toLocaleString()} Gold from ${
            message.kills === 1 ? "a hunter" : `${message.kills.toLocaleString()} kills`
          }.`
        );
        return;
      }
      case "XORAL_EVENT_CANCELLED":
        showActionError(message.reason);
        return;
      case "LEGENDARY_EVENT_ALERT":
        onLegendaryEventAlert?.(message);
        return;
      case "XORAL_PARTICIPANT_EXITED":
        setWarning(message.reason);
        return;
      case "XORAL_RING_DROPS_SNAPSHOT":
        setXoralRingDrops(message.drops);
        return;
      case "XORAL_RING_DROP_PICKED_UP":
        setEquipment(message.equipment);
        setWarning("Xoral ring picked up.");
        onXoralRingDropPickedUp?.(message);
        return;
      case "CLASS_MASTERY_GRANTED":
        setClassSnapshot(message.snapshot);
        if (!message.replayed && message.grantedXp > 0) {
          enqueueFloatingFeedback({
            eventId: message.eventId,
            targetEntityId: ownPlayerId,
            kind: "class_xp",
            amount: message.grantedXp,
            subject: CLASS_DEFINITIONS[message.classId].name,
            label: `+${message.grantedXp.toLocaleString()} ${CLASS_DEFINITIONS[message.classId].name} XP`
          });
        }
        return;
      case "ABILITY_QUEUE_UPDATED":
        setLocalCombatEntity((current) => current
          ? {
              ...current,
              classCombat: message.classCombat,
              pveCombat: message.pveCombat
            }
          : current);
        return;
      case "XP_GRANTED":
        setProgression(message.grant.progression);
        if (message.grant.inventory) {
          receiveInventorySnapshot(message.grant.inventory);
        }
        progressionRecorder.recordEvent({
          type: "xp_granted",
          sourceType: message.grant.sourceType,
          sourceId: message.grant.sourceId,
          xpRequested: message.grant.requestedXp,
          xpGranted: message.grant.grantedXp,
          playerLevel: message.grant.progression.level
        });
        if (!message.grant.replayed && message.grant.grantedXp > 0) {
          enqueueFloatingFeedback({
            eventId: `character-xp:${message.grant.operationKey}`,
            targetEntityId: ownPlayerId,
            kind: "character_xp",
            amount: message.grant.grantedXp
          });
        }
        if (!message.grant.replayed) {
          message.grant.enchantmentStoneRewards?.forEach((reward, index) => {
            enqueueFloatingFeedback({
              eventId: `enchantment-stone:${message.grant.operationKey}:${index}`,
              targetEntityId: ownPlayerId,
              kind: "resource",
              amount: 1,
              subject: `${reward.variant[0]!.toUpperCase()}${reward.variant.slice(1)} Enchantment Stone`,
              label: `+1 ${reward.variant[0]!.toUpperCase()}${reward.variant.slice(1)} Enchantment Stone`
            });
          });
        }
        return;
      case "LEVEL_UP":
        setProgression(message.progression);
        if (message.premiumWallet) receivePremiumWallet?.(message.premiumWallet);
        onLevelUp?.(message);
        return;
      case "EQUIPMENT_SNAPSHOT": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        equipmentMutationRequestRef.current = request.activeRequestId;
        if (
          pendingKitActivationRef.current &&
          message.equipment.activeRevision >=
            pendingKitActivationRef.current.expectedActiveRevision
        ) {
          pendingKitActivationRef.current = null;
          setPendingKitActivation(null);
        }
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        setEquipmentBusy(
          equipmentMutationRequestRef.current !== null ||
            pendingKitActivationRef.current !== null
        );
        return;
      }
      case "EQUIPMENT_UPDATED": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        if (!request.accepted) return;
        equipmentMutationRequestRef.current = request.activeRequestId;
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        setProgression(message.progression);
        setEquipmentBusy(false);
        progressionRecorder.recordEvent({
          type: "equipment_changed",
          sourceId: message.requestId,
          playerLevel: message.progression.level
        });
        return;
      }
      case "EQUIPMENT_UPGRADE_RESULT": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        if (!request.accepted) return;
        equipmentMutationRequestRef.current = request.activeRequestId;
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        setWalletGold(message.goldBalance);
        setEquipmentBusy(false);
        onEquipmentUpgradeResult?.(message);
        return;
      }
      case "EQUIPMENT_ACQUIRED": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        if (!request.accepted) return;
        equipmentMutationRequestRef.current = request.activeRequestId;
        receiveInventorySnapshot(message.inventory);
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        if (message.walletGold !== undefined && message.walletVersion !== undefined) {
          setWalletGold(message.walletGold, message.walletVersion);
        }
        setEquipmentBusy(false);
        onEquipmentAcquired?.(message);
        return;
      }
      case "EQUIPMENT_REPAIRED": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        if (!request.accepted) return;
        equipmentMutationRequestRef.current = request.activeRequestId;
        receiveInventorySnapshot(message.inventory);
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        setEquipmentBusy(false);
        onEquipmentRepaired?.(message);
        return;
      }
      case "REPAIR_KIT_CRAFTED": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        if (!request.accepted) return;
        equipmentMutationRequestRef.current = request.activeRequestId;
        receiveInventorySnapshot(message.inventory);
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        setEquipmentBusy(false);
        onRepairKitCrafted?.(message);
        return;
      }
      case "GEAR_SCROLLS_STATE": {
        if (message.inventory) receiveInventorySnapshot(message.inventory);
        if (message.equipment) {
          const worn = message.equipment;
          setEquipment((current) => reconcileEquipmentSnapshot(current, worn));
        }
        onGearScrolls?.(message);
        return;
      }
      case "RING_OPERATION_RESULT": {
        const request = reconcileEquipmentMutationRequest(
          equipmentMutationRequestRef.current,
          message
        );
        if (!request.accepted) return;
        equipmentMutationRequestRef.current = request.activeRequestId;
        receiveInventorySnapshot(message.inventory);
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        setEquipmentBusy(false);
        onRingOperation?.(message);
        return;
      }
      case "COMBAT_KIT_SNAPSHOT":
        if (
          message.requestId !== undefined &&
          equipmentMutationRequestRef.current !== message.requestId
        ) {
          return;
        }
        if (message.requestId !== undefined) {
          equipmentMutationRequestRef.current = null;
          setEquipmentBusy(false);
        }
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        return;
      case "COMBAT_KIT_ACTIVATED": {
        const pending = pendingKitActivationRef.current;
        if (pending && pending.requestId !== message.requestId) return;
        if (pending) {
          pendingKitActivationRef.current = null;
          setPendingKitActivation(null);
        }
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        if (pending) {
          setEquipmentBusy(false);
        }
        return;
      }
      case "COMBAT_KIT_INVALIDATED": {
        const pending = pendingKitActivationRef.current;
        if (
          message.requestId !== undefined &&
          pending?.requestId !== message.requestId
        ) {
          return;
        }
        if (pending?.requestId === message.requestId) {
          pendingKitActivationRef.current = null;
          setPendingKitActivation(null);
          setEquipmentBusy(false);
        }
        setEquipment((current) =>
          reconcileEquipmentSnapshot(current, message.equipment)
        );
        showActionError(
          message.equipment.kits.find(
            ({ kitIndex }) => kitIndex === message.kitIndex
          )?.invalidReason
            ? `Kit ${message.kitIndex} is invalid: ${message.reason.replaceAll("_", " ")}.`
            : `Kit ${message.kitIndex} is invalid.`
        );
        return;
      }
      case "COMBAT_SNAPSHOT":
        recordProgressionCombatEvents(message.state, combatStore, ownPlayerId);
        if (combatStore.applySnapshot(message.state) === "applied") {
          if (
            message.worldViewAuthority &&
            message.combatSnapshotGeneration !== undefined
          ) {
            worldViewBarrierRef?.current.observeCombat(
              message.worldViewAuthority,
              message.combatSnapshotGeneration
            );
          }
          combatServerClockOffsetMsRef.current =
            message.state.serverTime - Date.now();
          if (combatPresentation) combatPresentation.clearScene();
          overlayRef.current?.clearCombatFeedback();
          snapRespawnedPlayers(message.state);
          refreshCombatUi();
        }
        return;
      case "COMBAT_DELTA": {
        recordProgressionCombatEvents(message.state, combatStore, ownPlayerId);
        const result = combatStore.applyDelta(message.state);
        if (result === "gap") {
          requestWorldResync("combat-sequence-gap");
        } else if (result === "applied") {
          combatServerClockOffsetMsRef.current =
            message.state.serverTime - Date.now();
          const events = combatEventsForAcceptedDelta(result, message.state.events);
          if (combatPresentation) {
            combatPresentation.enqueueCombatEvents(events, {
              localPlayerId: ownPlayerId,
              ...(appearanceForEntity ? { appearanceForEntity } : {}),
              pointForEntity: (entityId) => {
                const entity = combatStore.get(entityId);
                return entity ? { x: entity.lon, y: entity.lat } : null;
              },
              maxHealthForEntity: (entityId) => combatStore.get(entityId)?.maxHealth
            });
            overlayRef.current?.enqueueCombatAncillaryEvents?.(events);
          } else {
            overlayRef.current?.enqueueCombatEvents(events);
          }
          overlayRef.current?.removeCombatTargets(
            message.state.removedEntityIds
          );
          snapRespawnedPlayers(message.state);
          refreshCombatUi();
        }
        return;
      }
      case "COMBAT_STARTED":
        setWarning(null);
        progressionRecorder.recordEvent({
          type: "combat_engaged",
          sourceId: message.targetEntityId
        });
        return;
      case "COMBAT_CANCELLED":
        return;
    }
  }, [
    combatServerClockOffsetMsRef,
    combatPresentation,
    combatStore,
    currentWalletGold,
    dispatchStartup,
    equipmentMutationRequestRef,
    appearanceForEntity,
    overlayRef,
    enqueueFloatingFeedback,
    ownPlayerId,
    onEquipmentUpgradeResult,
    onEquipmentAcquired,
    onLegendaryEventAlert,
    onPvpStatus,
    onXoralRingDropPickedUp,
    pendingKitActivationRef,
    receiveInventorySnapshot,
    receivePremiumWallet,
    onLevelUp,
    refreshCombatUi,
    refreshMarket,
    requestWorldResync,
    setClassBusy,
    setClassSnapshot,
    setSkillSystemV3Snapshot,
    setSkillSystemV3Busy,
    setSkillSystemV3Error,
    skillSystemV3RequestRef,
    setSkillUnlockState,
    setDevProgressionError,
    setDevProgressionPendingType,
    setDevSubclassPending,
    setWalletGold,
    setEquipment,
    setEquipmentBusy,
    setLocalCombatEntity,
    setMasteries,
    setAchievements,
    announceAchievement,
    setPendingKitActivation,
    setProgression,
    setWarning,
    showActionError,
    snapRespawnedPlayers
  ]);
}

function authoritativeCombatWalletUpdate(
  message: { gold: number; walletGold?: string; walletVersion?: string },
  latestVersion: bigint | null,
  currentWalletGold: string | null
): { gold: string; version: bigint } | null {
  if (
    message.gold <= 0 ||
    message.walletGold === undefined ||
    message.walletVersion === undefined
  ) {
    return null;
  }
  try {
    const gold = BigInt(message.walletGold);
    const version = BigInt(message.walletVersion);
    const currentGold = currentWalletGold === null ? null : BigInt(currentWalletGold);
    if (
      gold <= 0n ||
      version <= 0n ||
      (currentGold !== null && gold <= currentGold) ||
      (latestVersion !== null && version <= latestVersion)
    ) {
      return null;
    }
    return { gold: message.walletGold, version };
  } catch {
    return null;
  }
}

function recordProgressionCombatEvents(
  state: CombatStateBatch,
  store: CombatStore,
  localPlayerId: string
): void {
  for (const event of state.events) {
    if (event.type === "DAMAGE" && event.amount !== undefined) {
      if (
        event.sourceEntityId === localPlayerId ||
        event.targetEntityId === localPlayerId
      ) {
        progressionRecorder.recordEvent({
          type: "combat_damage",
          sourceId: event.targetEntityId,
          damageDealt: event.sourceEntityId === localPlayerId
            ? event.amount
            : null,
          damageReceived: event.targetEntityId === localPlayerId
            ? event.amount
            : null
        });
      }
      continue;
    }
    if (event.type !== "DEFEATED" || !event.targetEntityId) continue;
    const target = store.get(event.targetEntityId);
    if (target?.kind === "mob" && event.sourceEntityId === localPlayerId) {
      progressionRecorder.recordEvent({
        type: "mob_defeated",
        sourceId: target.entityId,
        mobArchetype: target.archetypeKey,
        mobLevel: target.level
      });
    } else if (event.targetEntityId === localPlayerId) {
      progressionRecorder.recordEvent({
        type: "player_defeated",
        sourceId: localPlayerId
      });
    }
  }
}
