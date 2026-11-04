import type { CollectibleNode } from "@ash-atlas/shared";

export const ELAPSED_REPEATABLE_TIMER_REFRESH_MS = 5_000;

export type RepeatableTimerReconciliationMemory = Readonly<{
  nodeId: string;
  authorityRevision: number | null;
  mode: "elapsed" | "malformed";
  requestedAt: number;
}>;

export function repeatableTimerReconciliation(
  node: CollectibleNode | null,
  nowMs: number,
  previous: RepeatableTimerReconciliationMemory | null
): Readonly<{
  request: boolean;
  memory: RepeatableTimerReconciliationMemory | null;
}> {
  if (
    node?.repeatableState !== "depleted"
    || node.repeatableTimerVisibility === "redacted"
  ) {
    return { request: false, memory: null };
  }

  const deadlineMs = node.repeatableReadyAt
    ? Date.parse(node.repeatableReadyAt)
    : Number.NaN;
  const authorityRevision = node.repeatableRevision ?? null;
  const mode = Number.isFinite(deadlineMs) ? "elapsed" : "malformed";
  if (mode === "elapsed" && deadlineMs > nowMs) {
    return { request: false, memory: null };
  }

  const samePresentation =
    previous?.nodeId === node.id
    && previous.authorityRevision === authorityRevision
    && previous.mode === mode;
  const request = mode === "malformed"
    ? !samePresentation
    : !samePresentation
      || nowMs - previous.requestedAt >=
        ELAPSED_REPEATABLE_TIMER_REFRESH_MS;
  return {
    request,
    memory: request
      ? {
          nodeId: node.id,
          authorityRevision,
          mode,
          requestedAt: nowMs
        }
      : previous
  };
}
