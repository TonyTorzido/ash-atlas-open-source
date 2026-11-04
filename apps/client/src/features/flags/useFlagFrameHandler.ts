import type {
  FlagServerMessage,
  FlagSnapshot,
  ResourceVision,
  ResourceVisionStatus,
  WaterSourceHighlight
} from "@ash-atlas/shared";
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";

import { upsertFlagSnapshot } from "../../flags/flagDisplay.js";
import {
  removeFlagById,
  upsertFlag
} from "../../flags/flagFrameUtilities.js";
import { perfMetrics } from "../../perf/perfMetrics.js";
import { perfRecorder } from "../../perf/perfRecorder.js";
import {
  currentFlagAuthority,
  expireUnsafeFlagSnapshotState,
  MAX_ACTIVE_FLAG_SNAPSHOT_ASSEMBLIES,
  MAX_FLAGS_PER_SNAPSHOT_ASSEMBLY,
  MAX_FLAG_MUTATION_JOURNAL_ENTRIES,
  MAX_FLAG_MUTATION_TOMBSTONES,
  MAX_FLAG_SNAPSHOT_CHUNKS_PER_ASSEMBLY,
  MAX_TOTAL_FLAG_SNAPSHOT_CHUNKS,
  mergeFlagSnapshots,
  recoverFromFlagJournalBound,
  rememberRetiredSnapshotIds,
  replayableFlagMutation,
  requestSnapshotResyncOnce,
  resetFlagSnapshotState,
  retireFlagSnapshot,
  sameFlagChunk,
  sameFlagMutation,
  type FlagMutationJournalEntry,
  type FlagSnapshotAssembly,
  type RefCell
} from "./flagSnapshotReconciliation.js";
import {
  handleFlagBuildFrame,
  type FlagBuildFrameHandlerOptions
} from "./flagBuildFrameHandler.js";
import { recordFlagFrameFeedback } from "./flagFrameFeedback.js";

export type { ActiveFlagBuild, ActiveFlagHardening } from "./flagBuildFrameHandler.js";

const FLAG_FRAME_TYPES = new Set<string>([
  "FLAGS_SNAPSHOT",
  "FLAG_BUILD_QUEUED",
  "FLAG_BUILD_STARTED",
  "FLAG_BUILD_CANCELLED",
  "FLAG_REINFORCEMENT_STARTED",
  "FLAG_REINFORCEMENT_CANCELLED",
  "FLAG_BURN_STARTED",
  "FLAG_BURN_CANCELLED",
  "FLAG_BURN_NOTICE",
  "FLAG_REPAIR_STARTED",
  "FLAG_REPAIR_CANCELLED",
  "FLAG_REPAIRED",
  "FLAG_REPAIR_DISRUPT_STARTED",
  "FLAG_REPAIR_DISRUPT_CANCELLED",
  "FLAG_REPAIR_DISRUPTED",
  "TORCHES_CRAFTED",
  "FLAG_CREATED",
  "FLAG_UPSERTED",
  "FLAG_REINFORCED",
  "FLAG_DELETED",
  "FLAGS_COLLAPSED",
  "TERRITORY_COLLAPSE_STARTED",
  "FLAG_UPDATED",
  "FLAG_ACCESS_CHANGED"
]);

export function isFlagServerMessage(
  message: { type: string }
): message is FlagServerMessage {
  return FLAG_FRAME_TYPES.has(message.type);
}

export interface FlagFrameHandlerOptions extends FlagBuildFrameHandlerOptions {
  firstFlagsSnapshotRef: RefCell<boolean>;
  setSelectedFlagId: Dispatch<SetStateAction<string | null>>;
  setResourceVision: Dispatch<SetStateAction<ResourceVision | null>>;
  setResourceVisionStatus: Dispatch<SetStateAction<ResourceVisionStatus | null>>;
  setWaterHighlights: Dispatch<SetStateAction<WaterSourceHighlight[]>>;
  setFlagAccessRevision: Dispatch<SetStateAction<number>>;
  requestHarvestCancellation(stopMovement?: boolean): void;
  flagSetRevisionRef?: RefCell<number>;
  connectionIdRef?: RefCell<string | null>;
  connectionGenerationRef?: RefCell<number>;
  scopedFlagSnapshotsRef?: RefCell<boolean>;
  relocationRevisionRef?: RefCell<number>;
  gameplayViewGenerationRef?: RefCell<number>;
  snapshotAssemblyEpochRef?: RefCell<number>;
  strategicFlagIdsRef?: RefCell<ReadonlySet<string>>;
  requestFlagResync?(reason: string): void;
  onSnapshotCommitted?(flags: readonly FlagSnapshot[]): void;
  onFlagBurnNotice?(message: Extract<FlagServerMessage, { type: "FLAG_BURN_NOTICE" }>): void;
  onFlagBurnStarted?(message: Extract<FlagServerMessage, { type: "FLAG_BURN_STARTED" }>): void;
  onFlagRepairStarted?(message: Extract<FlagServerMessage, { type: "FLAG_REPAIR_STARTED" }>): void;
  onFlagRepairCancelled?(message: Extract<FlagServerMessage, { type: "FLAG_REPAIR_CANCELLED" }>): void;
  onFlagRepaired?(message: Extract<FlagServerMessage, { type: "FLAG_REPAIRED" }>): void;
  onFlagRepairDisruptStarted?(message: Extract<FlagServerMessage, { type: "FLAG_REPAIR_DISRUPT_STARTED" }>): void;
  onFlagRepairDisruptCancelled?(message: Extract<FlagServerMessage, { type: "FLAG_REPAIR_DISRUPT_CANCELLED" }>): void;
  onFlagRepairDisrupted?(message: Extract<FlagServerMessage, { type: "FLAG_REPAIR_DISRUPTED" }>): void;
  onTorchesCraftedSettled?(requestId: string): void;
  onTorchesCrafted?(quantity: number): void;
  /** Flag id of the player's open resource vision (their active harvest flag). */
  resourceVisionFlagIdRef?: RefCell<string | null>;
  /** Called with a collapse batch before the flags leave state (for the crumble effect). */
  onFlagsCollapsed?(flagIds: readonly string[]): void;
  onTerritoryCollapseStarted?(
    message: Extract<FlagServerMessage, { type: "TERRITORY_COLLAPSE_STARTED" }>
  ): void;
}

export function useFlagFrameHandler(options: FlagFrameHandlerOptions) {
  // Separate from React state so batched/replayed updaters cannot emit feedback.
  const feedbackFlagsRef = useRef(new Map<string, FlagSnapshot>());
  const fallbackFlagSetRevisionRef = useRef(0);
  const snapshotAssembliesRef = useRef(new Map<string, FlagSnapshotAssembly>());
  const mutationJournalRef = useRef<FlagMutationJournalEntry[]>([]);
  const latestMutationByFlagIdRef = useRef(
    new Map<string, FlagMutationJournalEntry>()
  );
  const mutationArrivalOrderRef = useRef(0);
  const mutationTombstoneCountRef = useRef(0);
  const minimumSafeSnapshotRevisionRef = useRef(0);
  const acceptedSnapshotRevisionRef = useRef(0);
  const requestedSnapshotResyncsRef = useRef(new Set<string>());
  const retiredSnapshotIdsRef = useRef(new Set<string>());
  const activeFlagAttemptRef = useRef<{
    buildId: string;
    requestId: string;
  } | null>(null);
  const completedFlagFeedbackIdsRef = useRef(new Set<string>());
  const lastSnapshotAssemblyEpochRef = useRef(
    options.snapshotAssemblyEpochRef?.current ?? 0
  );
  const lastFlagAuthorityKeyRef = useRef(currentFlagAuthority({
    connectionId: options.connectionIdRef?.current ?? null,
    connectionGeneration: options.connectionGenerationRef?.current ?? 0,
    scopedSnapshots: options.scopedFlagSnapshotsRef?.current ?? false,
    relocationRevision: options.relocationRevisionRef?.current ?? 0,
    gameplayViewGeneration:
      options.gameplayViewGenerationRef?.current ?? 0
  }).authorityKey);
  const {
    ownPlayerId,
    overlayRef,
    firstFlagsSnapshotRef,
    flagPlacementValidationGateRef,
    flagBuildIntentRef,
    setFlags,
    setFlagBuildQueued,
    setFlagPlacementPreviewActive,
    setFlagBuild,
    setFlagHardening,
    setFlagBuildClock,
    setSelectedFlagId,
    setResourceVision,
    setResourceVisionStatus,
    setWaterHighlights,
    setFlagAccessRevision,
    setWarning,
    requestHarvestCancellation,
    receiveInventorySnapshot,
    flagSetRevisionRef = fallbackFlagSetRevisionRef,
    connectionIdRef,
    connectionGenerationRef,
    scopedFlagSnapshotsRef,
    relocationRevisionRef,
    gameplayViewGenerationRef,
    snapshotAssemblyEpochRef,
    strategicFlagIdsRef,
    requestFlagResync,
    onSnapshotCommitted,
    onFlagBurnNotice,
    onFlagBurnStarted,
    onFlagRepairStarted,
    onFlagRepairCancelled,
    onFlagRepaired,
    onFlagRepairDisruptStarted,
    onFlagRepairDisruptCancelled,
    onFlagRepairDisrupted,
    onTorchesCraftedSettled,
    onTorchesCrafted,
    resourceVisionFlagIdRef,
    onFlagsCollapsed,
    onTerritoryCollapseStarted,
    isFlagVisible
  } = options;

  return useCallback((message: FlagServerMessage): void => {
    const assemblyEpoch = snapshotAssemblyEpochRef?.current ?? 0;
    if (assemblyEpoch !== lastSnapshotAssemblyEpochRef.current) {
      feedbackFlagsRef.current.clear();
      lastSnapshotAssemblyEpochRef.current = assemblyEpoch;
      rememberRetiredSnapshotIds(
        retiredSnapshotIdsRef.current,
        snapshotAssembliesRef.current.keys()
      );
      resetFlagSnapshotState({
        snapshotAssemblies: snapshotAssembliesRef.current,
        mutationJournal: mutationJournalRef.current,
        latestMutationByFlagId: latestMutationByFlagIdRef.current,
        mutationTombstoneCount: mutationTombstoneCountRef,
        acceptedSnapshotRevision: acceptedSnapshotRevisionRef,
        minimumSafeSnapshotRevision: minimumSafeSnapshotRevisionRef,
        requestedSnapshotResyncs: requestedSnapshotResyncsRef.current
      });
    }
    const currentAuthority = currentFlagAuthority({
      connectionId: connectionIdRef?.current ?? null,
      connectionGeneration: connectionGenerationRef?.current ?? 0,
      scopedSnapshots: scopedFlagSnapshotsRef?.current ?? false,
      relocationRevision: relocationRevisionRef?.current ?? 0,
      gameplayViewGeneration: gameplayViewGenerationRef?.current ?? 0
    });
    if (currentAuthority.authorityKey !== lastFlagAuthorityKeyRef.current) {
      feedbackFlagsRef.current.clear();
      lastFlagAuthorityKeyRef.current = currentAuthority.authorityKey;
      rememberRetiredSnapshotIds(
        retiredSnapshotIdsRef.current,
        snapshotAssembliesRef.current.keys()
      );
      resetFlagSnapshotState({
        snapshotAssemblies: snapshotAssembliesRef.current,
        mutationJournal: mutationJournalRef.current,
        latestMutationByFlagId: latestMutationByFlagIdRef.current,
        mutationTombstoneCount: mutationTombstoneCountRef,
        acceptedSnapshotRevision: acceptedSnapshotRevisionRef,
        minimumSafeSnapshotRevision: minimumSafeSnapshotRevisionRef,
        requestedSnapshotResyncs: requestedSnapshotResyncsRef.current
      });
    }
    expireUnsafeFlagSnapshotState({
      now: Date.now(),
      currentAuthorityKey: currentAuthority.authorityKey,
      assemblyEpoch,
      snapshotAssemblies: snapshotAssembliesRef.current,
      retiredSnapshotIds: retiredSnapshotIdsRef.current,
      mutationJournal: mutationJournalRef.current,
      latestMutationByFlagId: latestMutationByFlagIdRef.current,
      mutationTombstoneCount: mutationTombstoneCountRef,
      minimumSafeSnapshotRevision: minimumSafeSnapshotRevisionRef,
      observedRevision: flagSetRevisionRef.current,
      requestedSnapshotResyncs: requestedSnapshotResyncsRef.current,
      requestFlagResync
    });
    const incomingRevision = "flagSetRevision" in message
      ? message.flagSetRevision
      : undefined;
    if (incomingRevision !== undefined && message.type !== "FLAGS_SNAPSHOT") {
      flagSetRevisionRef.current = Math.max(
        flagSetRevisionRef.current,
        incomingRevision
      );
      // A collapse batch journals one delete per broken flag.
      const incomingMutations: Array<ReturnType<typeof replayableFlagMutation>> =
        message.type === "FLAGS_COLLAPSED"
          ? message.flagIds.map((flagId) => ({ flagId, operation: "delete" as const }))
          : [replayableFlagMutation(message)];
      for (const incomingMutation of incomingMutations) {
      const mutation = incomingMutation?.flag && isFlagVisible?.(incomingMutation.flag) === false
        ? {
            flagId: incomingMutation.flagId,
            operation: "delete" as const
          }
        : incomingMutation;
      if (mutation) {
        if (
          incomingRevision < acceptedSnapshotRevisionRef.current
          || incomingRevision < minimumSafeSnapshotRevisionRef.current
        ) {
          if (message.type === "FLAGS_COLLAPSED") break;
          return;
        }
        const latest = latestMutationByFlagIdRef.current.get(mutation.flagId);
        if (latest && incomingRevision < latest.revision) {
          if (message.type === "FLAGS_COLLAPSED") continue;
          return;
        }
        const nextEntry: FlagMutationJournalEntry = {
          ...currentAuthority,
          flagId: mutation.flagId,
          revision: incomingRevision,
          operation: mutation.operation,
          ...(mutation.flag ? { flag: mutation.flag } : {}),
          arrivalOrder: mutationArrivalOrderRef.current += 1,
          receivedAt: Date.now()
        };
        if (latest && sameFlagMutation(latest, nextEntry)) {
          if (message.type === "FLAGS_COLLAPSED") continue;
          return;
        }
        if (
          mutationJournalRef.current.length >=
            MAX_FLAG_MUTATION_JOURNAL_ENTRIES
          || (
            nextEntry.operation === "delete"
            && mutationTombstoneCountRef.current >=
              MAX_FLAG_MUTATION_TOMBSTONES
          )
        ) {
          recoverFromFlagJournalBound({
            currentAuthorityKey: currentAuthority.authorityKey,
            assemblyEpoch,
            snapshotAssemblies: snapshotAssembliesRef.current,
            retiredSnapshotIds: retiredSnapshotIdsRef.current,
            mutationJournal: mutationJournalRef.current,
            latestMutationByFlagId: latestMutationByFlagIdRef.current,
            mutationTombstoneCount: mutationTombstoneCountRef,
            minimumSafeSnapshotRevision: minimumSafeSnapshotRevisionRef,
            observedRevision: flagSetRevisionRef.current,
            requestedSnapshotResyncs: requestedSnapshotResyncsRef.current,
            requestFlagResync,
            reason: "flag-mutation-journal-bounds-exceeded"
          });
          if (message.type === "FLAGS_COLLAPSED") break;
        } else {
          mutationJournalRef.current.push(nextEntry);
          latestMutationByFlagIdRef.current.set(mutation.flagId, nextEntry);
          if (nextEntry.operation === "delete") {
            mutationTombstoneCountRef.current += 1;
          }
        }
      }
      }
    }
    recordFlagFrameFeedback({
      feedbackFlagsRef,
      message,
      currentAuthorityKey: currentAuthority.authorityKey,
      overlayRef,
      isFlagVisible
    });
    switch (message.type) {
      case "FLAGS_SNAPSHOT": {
        if (!firstFlagsSnapshotRef.current) {
          firstFlagsSnapshotRef.current = true;
          perfMetrics.markLoadMilestone("first flags snapshot");
        }
        if (message.authority) {
          const authority = message.authority;
          if (retiredSnapshotIdsRef.current.has(authority.snapshotId)) return;
          if (
            authority.connectionId !== currentAuthority.connectionId
            || authority.connectionGeneration !==
              currentAuthority.connectionGeneration
            || authority.scopeKind !== currentAuthority.scopeKind
            || authority.scopeId !== currentAuthority.scopeId
            || (
              authority.scopeKind === "gameplay-circle-flags"
              && (
                authority.relocationRevision !==
                  (relocationRevisionRef?.current ?? 0)
                || authority.gameplayViewGeneration !==
                  (gameplayViewGenerationRef?.current ?? 0)
              )
            )
          ) {
            if (
              authority.connectionGeneration >=
                currentAuthority.connectionGeneration
            ) {
              requestSnapshotResyncOnce(
                requestedSnapshotResyncsRef.current,
                authority.snapshotId,
                requestFlagResync,
                "flag-snapshot-authority-mismatch"
              );
            }
            return;
          }
          const authorityKey = [
            authority.connectionId,
            authority.connectionGeneration,
            authority.scopeKind,
            authority.scopeId
          ].join("|");
          const snapshotRevision = message.flagSetRevision ?? 0;
          flagSetRevisionRef.current = Math.max(
            flagSetRevisionRef.current,
            snapshotRevision
          );
          let assembly = snapshotAssembliesRef.current.get(
            authority.snapshotId
          );
          if (!assembly) {
            if (
              snapshotRevision < acceptedSnapshotRevisionRef.current
              || snapshotRevision < minimumSafeSnapshotRevisionRef.current
            ) return;
            if (
              snapshotAssembliesRef.current.size >=
                MAX_ACTIVE_FLAG_SNAPSHOT_ASSEMBLIES
            ) {
              const oldest = snapshotAssembliesRef.current.keys().next().value;
              if (oldest) {
                retireFlagSnapshot(
                  retiredSnapshotIdsRef.current,
                  snapshotAssembliesRef.current,
                  oldest
                );
                requestSnapshotResyncOnce(
                  requestedSnapshotResyncsRef.current,
                  oldest,
                  requestFlagResync,
                  "flag-snapshot-assembly-bounds-exceeded"
                );
              }
            }
            assembly = {
              authorityKey,
              assemblyEpoch,
              flagSetRevision: snapshotRevision,
              chunks: new Map(),
              flagCount: 0,
              finalIndex: null,
              declaredChunkCount: authority.chunkCount ?? null,
              startedAt: Date.now()
            };
            snapshotAssembliesRef.current.set(
              authority.snapshotId,
              assembly
            );
          }
          if (
            assembly.authorityKey !== authorityKey
            || assembly.assemblyEpoch !== assemblyEpoch
            || assembly.flagSetRevision !== snapshotRevision
            || (
              authority.chunkCount !== undefined
              && assembly.declaredChunkCount !== null
              && authority.chunkCount !== assembly.declaredChunkCount
            )
          ) {
            requestSnapshotResyncOnce(
              requestedSnapshotResyncsRef.current,
              authority.snapshotId,
              requestFlagResync,
              "flag-snapshot-authority-mismatch"
            );
            retireFlagSnapshot(
              retiredSnapshotIdsRef.current,
              snapshotAssembliesRef.current,
              authority.snapshotId
            );
            return;
          }
          if (authority.chunkCount !== undefined) {
            assembly.declaredChunkCount = authority.chunkCount;
          }
          const existingChunk = assembly.chunks.get(authority.chunkIndex);
          if (existingChunk) {
            if (!sameFlagChunk(existingChunk, message.flags)) {
              requestSnapshotResyncOnce(
                requestedSnapshotResyncsRef.current,
                authority.snapshotId,
                requestFlagResync,
                "flag-snapshot-conflicting-duplicate"
              );
              retireFlagSnapshot(
                retiredSnapshotIdsRef.current,
                snapshotAssembliesRef.current,
                authority.snapshotId
              );
            }
            return;
          }
          const totalChunkCount = [...snapshotAssembliesRef.current.values()]
            .reduce((count, candidate) => count + candidate.chunks.size, 0);
          if (
            authority.chunkIndex >= MAX_FLAG_SNAPSHOT_CHUNKS_PER_ASSEMBLY
            || totalChunkCount >= MAX_TOTAL_FLAG_SNAPSHOT_CHUNKS
            || assembly.flagCount + message.flags.length >
              MAX_FLAGS_PER_SNAPSHOT_ASSEMBLY
            || (
              assembly.declaredChunkCount !== null
              && authority.chunkIndex >= assembly.declaredChunkCount
            )
          ) {
            requestSnapshotResyncOnce(
              requestedSnapshotResyncsRef.current,
              authority.snapshotId,
              requestFlagResync,
              "flag-snapshot-bounds-exceeded"
            );
            retireFlagSnapshot(
              retiredSnapshotIdsRef.current,
              snapshotAssembliesRef.current,
              authority.snapshotId
            );
            return;
          }
          assembly.chunks.set(authority.chunkIndex, message.flags);
          assembly.flagCount += message.flags.length;
          if (authority.finalChunk) {
            const declaredCount = authority.chunkCount
              ?? authority.chunkIndex + 1;
            if (declaredCount !== authority.chunkIndex + 1) {
              requestSnapshotResyncOnce(
                requestedSnapshotResyncsRef.current,
                authority.snapshotId,
                requestFlagResync,
                "flag-snapshot-invalid-final-chunk"
              );
              retireFlagSnapshot(
                retiredSnapshotIdsRef.current,
                snapshotAssembliesRef.current,
                authority.snapshotId
              );
              return;
            }
            assembly.declaredChunkCount = declaredCount;
            assembly.finalIndex = authority.chunkIndex;
          }
          if (assembly.finalIndex === null) return;
          for (let index = 0; index <= assembly.finalIndex; index += 1) {
            if (!assembly.chunks.has(index)) {
              requestSnapshotResyncOnce(
                requestedSnapshotResyncsRef.current,
                authority.snapshotId,
                requestFlagResync,
                "flag-snapshot-missing-chunk"
              );
              retireFlagSnapshot(
                retiredSnapshotIdsRef.current,
                snapshotAssembliesRef.current,
                authority.snapshotId
              );
              return;
            }
          }
          if (
            assembly.assemblyEpoch !==
              (snapshotAssemblyEpochRef?.current ?? 0)
            || authority.connectionId !== connectionIdRef?.current
            || authority.connectionGeneration !==
              (connectionGenerationRef?.current ?? 0)
            || authority.scopeId !== currentFlagAuthority({
              connectionId: connectionIdRef?.current ?? null,
              connectionGeneration: connectionGenerationRef?.current ?? 0,
              scopedSnapshots: scopedFlagSnapshotsRef?.current ?? false,
              relocationRevision: relocationRevisionRef?.current ?? 0,
              gameplayViewGeneration:
                gameplayViewGenerationRef?.current ?? 0
            }).scopeId
          ) {
            retireFlagSnapshot(
              retiredSnapshotIdsRef.current,
              snapshotAssembliesRef.current,
              authority.snapshotId
            );
            return;
          }
          if (
            assembly.flagSetRevision < acceptedSnapshotRevisionRef.current
          ) {
            retireFlagSnapshot(
              retiredSnapshotIdsRef.current,
              snapshotAssembliesRef.current,
              authority.snapshotId
            );
            requestedSnapshotResyncsRef.current.delete(authority.snapshotId);
            return;
          }
          const assembled = new Map<string, FlagSnapshot>();
          for (let index = 0; index <= assembly.finalIndex; index += 1) {
            for (const flag of assembly.chunks.get(index)!) {
              assembled.set(flag.id, flag);
            }
          }
          for (const mutation of mutationJournalRef.current) {
            if (
              mutation.authorityKey !== authorityKey
              || mutation.revision <= assembly.flagSetRevision
            ) continue;
            if (mutation.operation === "delete") {
              assembled.delete(mutation.flagId);
            } else if (mutation.flag) {
              assembled.set(mutation.flagId, mutation.flag);
            }
          }
          const committedFlags = [...assembled.values()];
          feedbackFlagsRef.current = new Map(committedFlags.map((flag) => [flag.id, flag]));
          setFlags((current) => authority.scopeKind === "gameplay-circle-flags"
            ? mergeFlagSnapshots(
                strategicFlagIdsRef
                  ? current.filter((flag) =>
                      strategicFlagIdsRef.current.has(flag.id)
                    )
                  : [],
                committedFlags
              )
            : [...assembled.values()]);
          perfMetrics.markLoadMilestone("flags snapshot committed");
          onSnapshotCommitted?.(committedFlags);
          flagSetRevisionRef.current = Math.max(
            flagSetRevisionRef.current,
            assembly.flagSetRevision
          );
          acceptedSnapshotRevisionRef.current = Math.max(
            acceptedSnapshotRevisionRef.current,
            assembly.flagSetRevision
          );
          for (const [
            snapshotId,
            candidate
          ] of snapshotAssembliesRef.current) {
            if (candidate.flagSetRevision <= acceptedSnapshotRevisionRef.current) {
              retireFlagSnapshot(
                retiredSnapshotIdsRef.current,
                snapshotAssembliesRef.current,
                snapshotId
              );
              requestedSnapshotResyncsRef.current.delete(snapshotId);
            }
          }
          mutationJournalRef.current = mutationJournalRef.current.filter(
            (mutation) =>
              mutation.revision > acceptedSnapshotRevisionRef.current
          );
          mutationTombstoneCountRef.current = mutationJournalRef.current.reduce(
            (count, mutation) =>
              count + (mutation.operation === "delete" ? 1 : 0),
            0
          );
          for (const [flagId, mutation] of latestMutationByFlagIdRef.current) {
            if (mutation.revision <= acceptedSnapshotRevisionRef.current) {
              latestMutationByFlagIdRef.current.delete(flagId);
            }
          }
          if (
            acceptedSnapshotRevisionRef.current >=
              minimumSafeSnapshotRevisionRef.current
          ) {
            minimumSafeSnapshotRevisionRef.current = 0;
          }
          requestedSnapshotResyncsRef.current.delete(authority.snapshotId);
          return;
        }
        if (
          message.flagSetRevision !== undefined
          && message.flagSetRevision < flagSetRevisionRef.current
        ) return;
        if (message.flagSetRevision !== undefined) {
          flagSetRevisionRef.current = message.flagSetRevision;
          acceptedSnapshotRevisionRef.current = Math.max(
            acceptedSnapshotRevisionRef.current,
            message.flagSetRevision
          );
        }
        if (message.complete !== false && message.truncated !== true) feedbackFlagsRef.current.clear();
        for (const flag of message.flags) feedbackFlagsRef.current.set(flag.id, flag);
        setFlags((current) =>
          message.complete === false || message.truncated === true
            ? mergeFlagSnapshots(current, message.flags)
            : message.flags
        );
        if (message.complete !== false && message.truncated !== true) {
          perfMetrics.markLoadMilestone("flags snapshot committed");
          onSnapshotCommitted?.(message.flags);
        }
        return;
      }
      case "FLAG_BUILD_QUEUED":
      case "FLAG_BUILD_STARTED":
      case "FLAG_BUILD_CANCELLED":
      case "FLAG_REINFORCEMENT_STARTED":
      case "FLAG_REINFORCEMENT_CANCELLED":
      case "FLAG_CREATED":
        return handleFlagBuildFrame(message, {
          ownPlayerId,
          overlayRef,
          flagPlacementValidationGateRef,
          flagBuildIntentRef,
          setFlags,
          setFlagBuildQueued,
          setFlagPlacementPreviewActive,
          setFlagBuild,
          setFlagBuildClock,
          setWarning,
          receiveInventorySnapshot,
          ...(setFlagHardening ? { setFlagHardening } : {}),
          ...(isFlagVisible ? { isFlagVisible } : {}),
          activeFlagAttemptRef,
          completedFlagFeedbackIdsRef
        });
      case "FLAG_BURN_STARTED":
        onFlagBurnStarted?.(message);
        return;
      case "FLAG_BURN_CANCELLED":
        return;
      case "FLAG_BURN_NOTICE":
        onFlagBurnNotice?.(message);
        return;
      case "FLAG_REPAIR_STARTED":
        onFlagRepairStarted?.(message);
        return;
      case "FLAG_REPAIR_CANCELLED":
        onFlagRepairCancelled?.(message);
        return;
      case "FLAG_REPAIRED":
        receiveInventorySnapshot(message.inventory);
        setFlags((current) => isFlagVisible?.(message.flag) === false
          ? removeFlagById(current, message.flag.id)
          : upsertFlagSnapshot(current, message.flag));
        onFlagRepaired?.(message);
        return;
      case "FLAG_REPAIR_DISRUPT_STARTED":
        onFlagRepairDisruptStarted?.(message);
        return;
      case "FLAG_REPAIR_DISRUPT_CANCELLED":
        onFlagRepairDisruptCancelled?.(message);
        return;
      case "FLAG_REPAIR_DISRUPTED":
        onFlagRepairDisrupted?.(message);
        return;
      case "TORCHES_CRAFTED":
        receiveInventorySnapshot(message.inventory);
        onTorchesCraftedSettled?.(message.requestId);
        onTorchesCrafted?.(message.quantity);
        return;
      case "FLAG_UPSERTED":
        setFlags((current) => isFlagVisible?.(message.flag) === false
          ? removeFlagById(current, message.flag.id)
          : upsertFlagSnapshot(current, message.flag));
        return;
      case "FLAG_REINFORCED":
        setFlagHardening?.((current) =>
          current?.requestId === message.requestId || current?.flagId === message.flag.id
            ? null
            : current
        );
        setFlags((current) => isFlagVisible?.(message.flag) === false
          ? removeFlagById(current, message.flag.id)
          : upsertFlag(current, message.flag));
        receiveInventorySnapshot(message.inventory);
        return;
      case "FLAG_DELETED":
        if (message.inventory) {
          receiveInventorySnapshot(message.inventory);
        }
        perfRecorder.recordEvent("flag_deleted", {
          flagId: message.flagId,
          source: "websocket"
        });
        setFlags((current) => removeFlagById(current, message.flagId));
        setSelectedFlagId((current) =>
          current === message.flagId ? null : current
        );
        setResourceVision((current) =>
          current?.flagId === message.flagId ? null : current
        );
        setResourceVisionStatus((current) =>
          current?.flagId === message.flagId ? null : current
        );
        requestHarvestCancellation();
        setWaterHighlights([]);
        setWarning(null);
        return;
      case "FLAGS_COLLAPSED": {
        // One state update per collapse batch. Harvesting and water highlights
        // are only reset when the player's own resource-vision flag broke.
        const brokenIds = new Set(message.flagIds);
        if (brokenIds.size === 0) return;
        perfRecorder.recordEvent("flags_collapsed", {
          count: brokenIds.size,
          source: "websocket"
        });
        onFlagsCollapsed?.(message.flagIds);
        setFlags((current) => current.some((flag) => brokenIds.has(flag.id))
          ? current.filter((flag) => !brokenIds.has(flag.id))
          : current);
        setSelectedFlagId((current) =>
          current !== null && brokenIds.has(current) ? null : current
        );
        const visionFlagId = resourceVisionFlagIdRef?.current ?? null;
        if (visionFlagId !== null && brokenIds.has(visionFlagId)) {
          setResourceVision((current) =>
            current?.flagId === visionFlagId ? null : current
          );
          setResourceVisionStatus((current) =>
            current?.flagId === visionFlagId ? null : current
          );
          requestHarvestCancellation();
          setWaterHighlights([]);
        }
        return;
      }
      case "TERRITORY_COLLAPSE_STARTED":
        onTerritoryCollapseStarted?.(message);
        return;
      case "FLAG_UPDATED":
        setFlags((current) => isFlagVisible?.(message.flag) === false
          ? removeFlagById(current, message.flag.id)
          : upsertFlagSnapshot(current, message.flag));
        setWarning(null);
        return;
      case "FLAG_ACCESS_CHANGED":
        setFlagAccessRevision((current) => current + 1);
        return;
    }
  }, [
    requestHarvestCancellation,
    overlayRef,
    firstFlagsSnapshotRef,
    flagBuildIntentRef,
    flagPlacementValidationGateRef,
    flagSetRevisionRef,
    connectionGenerationRef,
    connectionIdRef,
    scopedFlagSnapshotsRef,
    relocationRevisionRef,
    gameplayViewGenerationRef,
    onSnapshotCommitted,
    onFlagBurnNotice,
    onFlagBurnStarted,
    onFlagRepairStarted,
    onFlagRepairCancelled,
    onFlagRepaired,
    onFlagRepairDisruptStarted,
    onFlagRepairDisruptCancelled,
    onFlagRepairDisrupted,
    onTorchesCrafted,
    resourceVisionFlagIdRef,
    onFlagsCollapsed,
    onTerritoryCollapseStarted,
    isFlagVisible,
    receiveInventorySnapshot,
    requestFlagResync,
    snapshotAssemblyEpochRef,
    strategicFlagIdsRef,
    setFlagAccessRevision,
    setFlagBuild,
    setFlagHardening,
    setFlagBuildClock,
    setFlagBuildQueued,
    setFlagPlacementPreviewActive,
    setFlags,
    setResourceVision,
    setResourceVisionStatus,
    setSelectedFlagId,
    setWarning,
    setWaterHighlights
  ]);
}
