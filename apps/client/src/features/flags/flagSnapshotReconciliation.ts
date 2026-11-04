import {
  gameplayCircleFlagScopeId,
  type FlagServerMessage,
  type FlagSnapshot
} from "@ash-atlas/shared";

export type RefCell<T> = { current: T };

export const MAX_ACTIVE_FLAG_SNAPSHOT_ASSEMBLIES = 2;
export const MAX_FLAG_SNAPSHOT_CHUNKS_PER_ASSEMBLY = 1_024;
export const MAX_TOTAL_FLAG_SNAPSHOT_CHUNKS = 2_048;
export const MAX_FLAGS_PER_SNAPSHOT_ASSEMBLY = 100_000;
export const MAX_FLAG_MUTATION_JOURNAL_ENTRIES = 8_192;
export const MAX_FLAG_MUTATION_TOMBSTONES = 2_048;

const MAX_FLAG_MUTATION_JOURNAL_AGE_MS = 5 * 60_000;
const MAX_FLAG_SNAPSHOT_ASSEMBLY_AGE_MS = 30_000;
const MAX_REQUESTED_FLAG_RESYNCS = 64;
const MAX_RETIRED_FLAG_SNAPSHOT_IDS = 64;
const MAX_COMPLETED_FLAG_FEEDBACK_IDS = 256;

export interface FlagSnapshotAssembly {
  authorityKey: string;
  assemblyEpoch: number;
  flagSetRevision: number;
  chunks: Map<number, readonly FlagSnapshot[]>;
  flagCount: number;
  finalIndex: number | null;
  declaredChunkCount: number | null;
  startedAt: number;
}

interface CurrentFlagAuthority {
  authorityKey: string;
  connectionId: string | null;
  connectionGeneration: number;
  scopeKind: "global-flags" | "gameplay-circle-flags";
  scopeId: string;
}

export interface FlagMutationJournalEntry extends CurrentFlagAuthority {
  flagId: string;
  revision: number;
  operation: FlagMutationOperation;
  flag?: FlagSnapshot;
  arrivalOrder: number;
  receivedAt: number;
}

type FlagMutationOperation =
  | "create"
  | "upsert"
  | "reinforce"
  | "update"
  | "delete";

export function replayableFlagMutation(
  message: FlagServerMessage
): Readonly<{
  flagId: string;
  operation: FlagMutationOperation;
  flag?: FlagSnapshot;
}> | null {
  switch (message.type) {
    case "FLAG_CREATED":
      return { flagId: message.flag.id, operation: "create", flag: message.flag };
    case "FLAG_UPSERTED":
      return { flagId: message.flag.id, operation: "upsert", flag: message.flag };
    case "FLAG_REINFORCED":
      return { flagId: message.flag.id, operation: "reinforce", flag: message.flag };
    case "FLAG_UPDATED":
      return { flagId: message.flag.id, operation: "update", flag: message.flag };
    case "FLAG_DELETED":
      return { flagId: message.flagId, operation: "delete" };
    default:
      return null;
  }
}

export function currentFlagAuthority(input: Readonly<{
  connectionId: string | null;
  connectionGeneration: number;
  scopedSnapshots?: boolean;
  relocationRevision?: number;
  gameplayViewGeneration?: number;
}>): CurrentFlagAuthority {
  const scopeKind = input.scopedSnapshots
    ? "gameplay-circle-flags"
    : "global-flags";
  const scopeId = input.scopedSnapshots
    ? gameplayCircleFlagScopeId({
        relocationRevision: input.relocationRevision ?? 0,
        gameplayViewGeneration: input.gameplayViewGeneration ?? 0
      })
    : "global-flags";
  return {
    connectionId: input.connectionId,
    connectionGeneration: input.connectionGeneration,
    scopeKind,
    scopeId,
    authorityKey: [
      input.connectionId ?? "",
      input.connectionGeneration,
      scopeKind,
      scopeId
    ].join("|")
  };
}

export function sameFlagMutation(
  left: FlagMutationJournalEntry,
  right: FlagMutationJournalEntry
): boolean {
  return left.authorityKey === right.authorityKey
    && left.flagId === right.flagId
    && left.revision === right.revision
    && left.operation === right.operation
    && (left.operation === "delete" || JSON.stringify(left.flag) === JSON.stringify(right.flag));
}

export function resetFlagSnapshotState(input: Readonly<{
  snapshotAssemblies: Map<string, FlagSnapshotAssembly>;
  mutationJournal: FlagMutationJournalEntry[];
  latestMutationByFlagId: Map<string, FlagMutationJournalEntry>;
  mutationTombstoneCount: RefCell<number>;
  acceptedSnapshotRevision: RefCell<number>;
  minimumSafeSnapshotRevision: RefCell<number>;
  requestedSnapshotResyncs: Set<string>;
}>): void {
  input.snapshotAssemblies.clear();
  input.mutationJournal.length = 0;
  input.latestMutationByFlagId.clear();
  input.mutationTombstoneCount.current = 0;
  input.acceptedSnapshotRevision.current = 0;
  input.minimumSafeSnapshotRevision.current = 0;
  input.requestedSnapshotResyncs.clear();
}

export function expireUnsafeFlagSnapshotState(input: Readonly<{
  now: number;
  currentAuthorityKey: string;
  assemblyEpoch: number;
  snapshotAssemblies: Map<string, FlagSnapshotAssembly>;
  retiredSnapshotIds: Set<string>;
  mutationJournal: FlagMutationJournalEntry[];
  latestMutationByFlagId: Map<string, FlagMutationJournalEntry>;
  mutationTombstoneCount: RefCell<number>;
  minimumSafeSnapshotRevision: RefCell<number>;
  observedRevision: number;
  requestedSnapshotResyncs: Set<string>;
  requestFlagResync: ((reason: string) => void) | undefined;
}>): void {
  for (const [snapshotId, assembly] of input.snapshotAssemblies) {
    if (input.now - assembly.startedAt <= MAX_FLAG_SNAPSHOT_ASSEMBLY_AGE_MS) continue;
    retireFlagSnapshot(input.retiredSnapshotIds, input.snapshotAssemblies, snapshotId);
    requestSnapshotResyncOnce(
      input.requestedSnapshotResyncs,
      snapshotId,
      input.requestFlagResync,
      "flag-snapshot-assembly-expired"
    );
  }
  if (
    input.mutationJournal.length === 0
    || input.now - input.mutationJournal[0]!.receivedAt <= MAX_FLAG_MUTATION_JOURNAL_AGE_MS
  ) return;
  recoverFromFlagJournalBound({ ...input, reason: "flag-mutation-journal-expired" });
}

export function recoverFromFlagJournalBound(input: Readonly<{
  currentAuthorityKey: string;
  assemblyEpoch: number;
  snapshotAssemblies: Map<string, FlagSnapshotAssembly>;
  retiredSnapshotIds: Set<string>;
  mutationJournal: FlagMutationJournalEntry[];
  latestMutationByFlagId: Map<string, FlagMutationJournalEntry>;
  mutationTombstoneCount: RefCell<number>;
  minimumSafeSnapshotRevision: RefCell<number>;
  observedRevision: number;
  requestedSnapshotResyncs: Set<string>;
  requestFlagResync: ((reason: string) => void) | undefined;
  reason: string;
}>): void {
  rememberRetiredSnapshotIds(input.retiredSnapshotIds, input.snapshotAssemblies.keys());
  input.snapshotAssemblies.clear();
  input.mutationJournal.length = 0;
  input.latestMutationByFlagId.clear();
  input.mutationTombstoneCount.current = 0;
  input.minimumSafeSnapshotRevision.current = Math.max(
    input.minimumSafeSnapshotRevision.current,
    input.observedRevision
  );
  requestSnapshotResyncOnce(
    input.requestedSnapshotResyncs,
    `journal:${input.currentAuthorityKey}:${input.assemblyEpoch}:${input.minimumSafeSnapshotRevision.current}`,
    input.requestFlagResync,
    input.reason
  );
}

export function sameFlagChunk(
  left: readonly FlagSnapshot[],
  right: readonly FlagSnapshot[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((flag, index) =>
    flag.id === right[index]?.id && JSON.stringify(flag) === JSON.stringify(right[index])
  );
}

export function requestSnapshotResyncOnce(
  requested: Set<string>,
  snapshotId: string,
  request: ((reason: string) => void) | undefined,
  reason: string
): void {
  if (requested.has(snapshotId)) return;
  if (requested.size >= MAX_REQUESTED_FLAG_RESYNCS) {
    requested.delete(requested.values().next().value!);
  }
  requested.add(snapshotId);
  request?.(reason);
}

export function rememberRetiredSnapshotIds(
  retired: Set<string>,
  snapshotIds: Iterable<string>
): void {
  for (const snapshotId of snapshotIds) {
    if (retired.size >= MAX_RETIRED_FLAG_SNAPSHOT_IDS) {
      retired.delete(retired.values().next().value!);
    }
    retired.add(snapshotId);
  }
}

export function rememberCompletedFlagFeedback(
  completed: Set<string>,
  feedbackId: string
): void {
  if (completed.size >= MAX_COMPLETED_FLAG_FEEDBACK_IDS) {
    completed.delete(completed.values().next().value!);
  }
  completed.add(feedbackId);
}

export function retireFlagSnapshot(
  retired: Set<string>,
  assemblies: Map<string, FlagSnapshotAssembly>,
  snapshotId: string
): void {
  rememberRetiredSnapshotIds(retired, [snapshotId]);
  assemblies.delete(snapshotId);
}

export function mergeFlagSnapshots(
  current: readonly FlagSnapshot[],
  incoming: readonly FlagSnapshot[]
): FlagSnapshot[] {
  const merged = new Map(current.map((flag) => [flag.id, flag]));
  for (const flag of incoming) merged.set(flag.id, flag);
  return [...merged.values()];
}
