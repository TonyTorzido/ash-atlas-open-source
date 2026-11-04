import type { FlagAccessSnapshot } from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import { fetchFlagAccess } from "./flagAccess.js";

const FLAG_ACCESS_REQUEST_TIMEOUT_MS = 10_000;

type ResolvedAccess = Readonly<{
  flagId: string;
  revision: number;
  access: FlagAccessSnapshot;
  traceId: string;
}>;

type Options = Readonly<{
  flagId: string | null;
  accessRevision: number;
  serverHttpBase: string;
  onFailure(flagId: string, message: string): void;
}>;

export function useFlagAccessMenu(options: Options): Readonly<{
  access: FlagAccessSnapshot | null;
  traceId: string | null;
  updateAccess(access: FlagAccessSnapshot): void;
}> {
  const cacheRef = useRef(new Map<string, ResolvedAccess>());
  const [resolved, setResolved] = useState<ResolvedAccess | null>(null);
  const cacheKey = options.flagId
    ? `${options.serverHttpBase}\u0000${options.flagId}`
    : null;
  const cached = cacheKey ? cacheRef.current.get(cacheKey) ?? null : null;
  const current = matchesSelection(resolved, options)
    ? resolved
    : matchesSelection(cached, options)
      ? cached
      : null;

  useEffect(() => {
    if (!options.flagId || !cacheKey) {
      setResolved(null);
      return;
    }
    const cachedAccess = cacheRef.current.get(cacheKey);
    if (matchesSelection(cachedAccess, options)) {
      setResolved(cachedAccess);
      return;
    }

    const flagId = options.flagId;
    const controller = new AbortController();
    const traceId = crypto.randomUUID();
    const timeoutId = window.setTimeout(() => {
      gameplayLatencyTrace.record("networking", "flag_access_failed", {
        flagId,
        reason: "timeout"
      }, { traceId, failure: true });
      options.onFailure(flagId, "Flag access request timed out. Try again.");
      controller.abort();
    }, FLAG_ACCESS_REQUEST_TIMEOUT_MS);
    setResolved(null);
    gameplayLatencyTrace.record("networking", "flag_access_loading", {
      flagId
    }, { traceId });
    void fetchFlagAccess(options.serverHttpBase, flagId, controller.signal)
      .then((access) => {
        window.clearTimeout(timeoutId);
        if (controller.signal.aborted) return;
        const next = {
          flagId,
          revision: options.accessRevision,
          access,
          traceId
        };
        cacheRef.current.set(cacheKey, next);
        setResolved(next);
        gameplayLatencyTrace.record("networking", "flag_access_ready", {
          flagId,
          mode: access.mode
        }, { traceId });
      })
      .catch((cause: unknown) => {
        window.clearTimeout(timeoutId);
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : "Flag access is unavailable.";
        gameplayLatencyTrace.record("networking", "flag_access_failed", {
          flagId
        }, { traceId, failure: true });
        options.onFailure(flagId, message);
      });
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    cacheKey,
    options.accessRevision,
    options.flagId,
    options.onFailure,
    options.serverHttpBase
  ]);

  const updateAccess = useCallback((access: FlagAccessSnapshot): void => {
    const key = `${options.serverHttpBase}\u0000${access.flagId}`;
    const next = {
      flagId: access.flagId,
      revision: options.accessRevision,
      access,
      traceId: current?.traceId ?? crypto.randomUUID()
    };
    cacheRef.current.set(key, next);
    if (access.flagId === options.flagId) setResolved(next);
  }, [
    current?.traceId,
    options.accessRevision,
    options.flagId,
    options.serverHttpBase
  ]);

  return {
    access: current?.access ?? null,
    traceId: current?.traceId ?? null,
    updateAccess
  };
}

function matchesSelection(
  resolved: ResolvedAccess | null | undefined,
  options: Pick<Options, "flagId" | "accessRevision">
): resolved is ResolvedAccess {
  return Boolean(
    resolved &&
    resolved.flagId === options.flagId &&
    resolved.revision === options.accessRevision
  );
}
