import { useCallback, useEffect, useState } from "react";

const PLANNED_RESTART_BLOCKING_DELAY_MS = 10_000;
const UNEXPECTED_DISCONNECT_BLOCKING_DELAY_MS = 2_500;

type RecoveryPresentationState = Readonly<{
  blocking: boolean;
  ended: boolean;
  plannedRestart: boolean;
}>;

const CLEAR_PRESENTATION: RecoveryPresentationState = {
  blocking: false,
  ended: false,
  plannedRestart: false
};

export function useConnectionRecoveryPresentation(input: Readonly<{
  authoritativeOnline: boolean;
  hasCompletedBootstrap: boolean;
}>): Readonly<{
  blocking: boolean;
  ended: boolean;
  plannedNotice: boolean;
  beginBlockingReconnect(): void;
  noteDisconnect(code: number): void;
  noteRecoveryEnded(): void;
  resetForAuthoritativeOnline(): void;
}> {
  const [state, setState] = useState<RecoveryPresentationState>(CLEAR_PRESENTATION);

  const noteDisconnect = useCallback((code: number): void => {
    setState((current) => {
      if (code !== 1012 || current.plannedRestart) return current;
      return { ...current, plannedRestart: true };
    });
  }, []);
  const noteRecoveryEnded = useCallback((): void => {
    setState((current) => ({ ...current, blocking: true, ended: true }));
  }, []);
  const beginBlockingReconnect = useCallback((): void => {
    setState({ blocking: true, ended: false, plannedRestart: false });
  }, []);
  const resetForAuthoritativeOnline = useCallback((): void => {
    setState(CLEAR_PRESENTATION);
  }, []);

  useEffect(() => {
    if (input.authoritativeOnline) return;
    if (!input.hasCompletedBootstrap || state.blocking || state.ended) return;
    const timer = window.setTimeout(() => {
      setState((current) => current.blocking
        ? current
        : { ...current, blocking: true });
    }, state.plannedRestart
      ? PLANNED_RESTART_BLOCKING_DELAY_MS
      : UNEXPECTED_DISCONNECT_BLOCKING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    input.authoritativeOnline,
    input.hasCompletedBootstrap,
    state.blocking,
    state.ended,
    state.plannedRestart
  ]);

  return {
    blocking: state.blocking,
    ended: state.ended,
    plannedNotice: input.hasCompletedBootstrap &&
      !input.authoritativeOnline &&
      state.plannedRestart &&
      !state.blocking &&
      !state.ended,
    beginBlockingReconnect,
    noteDisconnect,
    noteRecoveryEnded,
    resetForAuthoritativeOnline
  };
}
