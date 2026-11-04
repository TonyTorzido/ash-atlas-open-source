import type { MonolithStateSnapshot, MonolithType } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";

import { MonolithMapPresenter } from "../../map/monolithMap.js";
import { requestIdCrypto as crypto } from "../../requestId.js";

const POLL_MS = 15_000;
const CLOCK_MS = 30_000;

type MutationResponse = { message: string; replayed: boolean; state: MonolithStateSnapshot };

async function monolithRequest<T>(serverHttpBase: string, csrfToken: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, serverHttpBase), {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-csrf-token": csrfToken
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? "Monolith request failed.");
  return payload as T;
}

export type MonolithFeature = Readonly<{
  state: MonolithStateSnapshot | null;
  /** Server clock now, re-derived every 30 s for lifetime labels. */
  serverNowMs: number;
  pending: boolean;
  refresh(): void;
  place(type: MonolithType): void;
  recharge(monolithId: string): void;
  ignite(monolithId: string): void;
}>;

/**
 * Field Engineering monoliths on the client: polls the nearby list while
 * the player is online on the world map, draws ranges on the map, and
 * sends the server-authoritative actions (the server uses the live
 * position; the client never sends coordinates).
 */
export function useMonolithFeature(input: Readonly<{
  activeMap: maplibregl.Map | null;
  serverHttpBase: string;
  csrfToken: string;
  enabled: boolean;
  onMessage(message: string): void;
  onError(message: string): void;
}>): MonolithFeature {
  const [state, setState] = useState<MonolithStateSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [localNowMs, setLocalNowMs] = useState(() => Date.now());
  const presenterRef = useRef<MonolithMapPresenter | null>(null);
  const callbacksRef = useRef(input);
  callbacksRef.current = input;
  const { serverHttpBase, csrfToken, enabled, activeMap } = input;

  const receive = useCallback((next: MonolithStateSnapshot) => {
    setState(next);
    setClockOffsetMs(Date.parse(next.serverTime) - Date.now());
    setLocalNowMs(Date.now());
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void monolithRequest<{ state: MonolithStateSnapshot }>(serverHttpBase, csrfToken, "/api/monoliths")
      .then((result) => receive(result.state))
      .catch(() => undefined);
  }, [csrfToken, enabled, receive, serverHttpBase]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const poll = window.setInterval(refresh, POLL_MS);
    const clock = window.setInterval(() => setLocalNowMs(Date.now()), CLOCK_MS);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!activeMap) return undefined;
    const presenter = new MonolithMapPresenter(activeMap);
    presenterRef.current = presenter;
    return () => {
      presenter.destroy();
      if (presenterRef.current === presenter) presenterRef.current = null;
    };
  }, [activeMap]);

  useEffect(() => {
    presenterRef.current?.update(enabled ? state?.monoliths ?? [] : []);
  }, [activeMap, enabled, state]);

  const mutate = useCallback((path: string, body: Record<string, unknown>) => {
    if (pending) return;
    setPending(true);
    void monolithRequest<MutationResponse>(serverHttpBase, csrfToken, path, { ...body, requestId: crypto.randomUUID() })
      .then((result) => {
        receive(result.state);
        callbacksRef.current.onMessage(result.message);
      })
      .catch((error: unknown) => {
        callbacksRef.current.onError(error instanceof Error ? error.message : "Monolith request failed.");
        refresh();
      })
      .finally(() => setPending(false));
  }, [csrfToken, pending, receive, refresh, serverHttpBase]);

  return {
    state,
    serverNowMs: localNowMs + clockOffsetMs,
    pending,
    refresh,
    place: (type) => mutate("/api/monoliths/place", { type }),
    recharge: (monolithId) => mutate("/api/monoliths/recharge", { monolithId }),
    ignite: (monolithId) => mutate("/api/monoliths/ignite", { monolithId })
  };
}
