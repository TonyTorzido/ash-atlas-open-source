import type { ConnectionRegistry } from "./connectionRegistry.js";

const TERRITORY_COLLAPSE_CAPABILITY = "territory-collapse-v1";

/**
 * Publishes one batch of broken territory flags. Clients that announce
 * `territory-collapse-v1` receive a single FLAGS_COLLAPSED frame; older clients
 * receive the FLAG_DELETED frames they already understand.
 */
export function publishBrokenFlags(
  registry: Pick<ConnectionRegistry, "records" | "connectionSupports" | "sendToConnectionIds">,
  input: Readonly<{
    flagIds: readonly string[];
    collapseId: string | null;
    reason: string;
    completed: boolean;
    flagSetRevision?: number;
  }>
): void {
  const flagIds = [...new Set(input.flagIds)];
  if (flagIds.length === 0) return;
  const batched: string[] = [];
  const legacy: string[] = [];
  for (const record of registry.records()) {
    (registry.connectionSupports(record.connectionId, TERRITORY_COLLAPSE_CAPABILITY)
      ? batched
      : legacy).push(record.connectionId);
  }
  const revision = input.flagSetRevision === undefined ? {} : { flagSetRevision: input.flagSetRevision };
  if (batched.length > 0) {
    registry.sendToConnectionIds(batched, {
      type: "FLAGS_COLLAPSED",
      flagIds,
      collapseId: input.collapseId,
      reason: input.reason,
      completed: input.completed,
      ...revision
    });
  }
  if (legacy.length > 0) {
    for (const flagId of flagIds) {
      registry.sendToConnectionIds(legacy, {
        type: "FLAG_DELETED",
        flagId,
        reason: "destroyed",
        ...revision
      });
    }
  }
}

export function publishTerritoryCollapseStarted(
  registry: Pick<ConnectionRegistry, "records" | "connectionSupports" | "sendToConnectionIds">,
  input: Readonly<{
    collapseId: string;
    kind: "city" | "kingdom";
    name: string;
    reason: string;
    flagCount: number;
    playerIds: readonly string[];
  }>
): void {
  const audience = new Set(input.playerIds);
  const connectionIds = registry.records()
    .filter((record) =>
      audience.has(record.playerId) &&
      registry.connectionSupports(record.connectionId, TERRITORY_COLLAPSE_CAPABILITY))
    .map((record) => record.connectionId);
  if (connectionIds.length === 0) return;
  registry.sendToConnectionIds(connectionIds, {
    type: "TERRITORY_COLLAPSE_STARTED",
    collapseId: input.collapseId,
    kind: input.kind,
    name: input.name,
    reason: input.reason,
    flagCount: input.flagCount
  });
}
