import type { DeveloperServerMessage, DeveloperCapitalFoundingPlan } from "@ash-atlas/shared";
import { useCallback, useRef, useState } from "react";

import { requestIdCrypto as crypto } from "../../requestId.js";

type CapitalFoundingClient = {
  foundCapital(input: { requestId: string; dryRun: boolean; leaveCurrentCity: boolean }): boolean;
};

export type DeveloperCapitalFoundingState = Readonly<{
  busy: boolean;
  leaveCurrentCity: boolean;
  plan: DeveloperCapitalFoundingPlan | null;
  founded: Readonly<{ cityName: string; replayed: boolean }> | null;
  error: string | null;
}>;

type ResultMessage = Extract<DeveloperServerMessage, { type: "DEV_CAPITAL_FOUNDING_RESULT" }>;

/**
 * Dev Tools "Found Albuquerque": a dry run shows the authoritative plan, then Confirm
 * sends the real request. The confirm request ID is kept until the server answers so a
 * retry or double-click replays the same request instead of founding twice.
 */
export function useDeveloperCapitalFounding(
  clientRef: Readonly<{ current: CapitalFoundingClient | null }>
) {
  const [state, setState] = useState<DeveloperCapitalFoundingState>({
    busy: false,
    leaveCurrentCity: false,
    plan: null,
    founded: null,
    error: null
  });
  const pendingRef = useRef<{ requestId: string; dryRun: boolean } | null>(null);
  const confirmRequestIdRef = useRef<string | null>(null);

  const send = useCallback((dryRun: boolean, leaveCurrentCity: boolean): void => {
    if (pendingRef.current) return;
    const requestId = dryRun
      ? crypto.randomUUID()
      : (confirmRequestIdRef.current ??= crypto.randomUUID());
    pendingRef.current = { requestId, dryRun };
    const sent = clientRef.current?.foundCapital({ requestId, dryRun, leaveCurrentCity }) ?? false;
    if (!sent) {
      pendingRef.current = null;
      setState((current) => ({ ...current, busy: false, error: "Not connected." }));
      return;
    }
    setState((current) => ({
      ...current,
      busy: true,
      error: null,
      ...(dryRun ? { plan: null, founded: null } : {})
    }));
  }, [clientRef]);

  const setLeaveCurrentCity = useCallback((leaveCurrentCity: boolean): void => {
    confirmRequestIdRef.current = null;
    setState((current) => ({ ...current, leaveCurrentCity, plan: null }));
  }, []);

  const plan = useCallback((): void => {
    // A lost reply never wedges the panel: planning again clears any stale wait.
    pendingRef.current = null;
    confirmRequestIdRef.current = null;
    send(true, state.leaveCurrentCity);
  }, [send, state.leaveCurrentCity]);

  const confirm = useCallback((): void => {
    send(false, state.leaveCurrentCity);
  }, [send, state.leaveCurrentCity]);

  const handleResult = useCallback((message: ResultMessage): void => {
    if (pendingRef.current?.requestId !== message.requestId) return;
    pendingRef.current = null;
    if (!message.dryRun) confirmRequestIdRef.current = null;
    setState((current) => ({
      ...current,
      busy: false,
      error: null,
      plan: message.plan,
      founded: message.dryRun ? null : { cityName: message.plan.cityName, replayed: message.replayed }
    }));
  }, []);

  const handleError = useCallback((message: Readonly<{ requestId?: string; message: string }>): boolean => {
    if (!message.requestId || pendingRef.current?.requestId !== message.requestId) return false;
    pendingRef.current = null;
    setState((current) => ({ ...current, busy: false, error: message.message }));
    return true;
  }, []);

  return { state, plan, confirm, setLeaveCurrentCity, handleResult, handleError };
}
