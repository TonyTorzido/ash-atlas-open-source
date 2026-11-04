import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ConnectionRecoveryScreen } from "../ui/ConnectionRecoveryScreen.js";
import {
  prepareRuntimePngContent,
  type RuntimePngContentPreparationResult,
  type RuntimePngContentProgress
} from "./runtimePngContent.js";

type GateState =
  | { kind: "loading"; progress?: RuntimePngContentProgress }
  | { kind: "failed"; message: string }
  | { kind: "ready" };

// Art packs are signed-in content, so they are prepared once per page load after
// sign-in instead of at boot; re-mounting the game (re-sign-in) reuses the result.
let contentSettled = false;
let preparation: Promise<RuntimePngContentPreparationResult> | null = null;
const progressListeners = new Set<(progress: RuntimePngContentProgress) => void>();

function prepareOnce(): Promise<RuntimePngContentPreparationResult> {
  preparation ??= prepareRuntimePngContent({
    onProgress: (progress) => { for (const listener of progressListeners) listener(progress); }
  }).finally(() => { preparation = null; });
  return preparation;
}

export function RuntimePngContentGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<GateState>(contentSettled ? { kind: "ready" } : { kind: "loading" });
  const lastPaintAt = useRef(0);

  const prepare = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    const result = await prepareOnce();
    if (result.kind === "ready") {
      contentSettled = true;
      setState({ kind: "ready" });
    } else {
      setState({ kind: "failed", message: result.message });
    }
  }, []);

  useEffect(() => {
    if (contentSettled) return;
    const onProgress = (progress: RuntimePngContentProgress): void => {
      if (progress.phase !== "downloading") return;
      if (progress.loadedBytes === 0 || progress.totalBytes === progress.loadedBytes ||
        performance.now() - lastPaintAt.current >= 100) {
        lastPaintAt.current = performance.now();
        setState({ kind: "loading", progress });
      }
    };
    progressListeners.add(onProgress);
    void prepare();
    return () => { progressListeners.delete(onProgress); };
  }, [prepare]);

  if (state.kind === "ready") return <>{children}</>;
  if (state.kind === "failed") {
    return (
      <ConnectionRecoveryScreen
        state="content_failed"
        detail={state.message}
        onReconnect={() => void prepare()}
        onContinue={() => { contentSettled = true; setState({ kind: "ready" }); }}
      />
    );
  }
  return (
    <ConnectionRecoveryScreen
      state="content_loading"
      {...(state.progress ? { progress: state.progress } : {})}
      onReconnect={() => void prepare()}
    />
  );
}
