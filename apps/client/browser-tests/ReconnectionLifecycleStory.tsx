import { useEffect, useRef, useState } from "react";

import { ConnectionRecoveryScreen } from "../src/ui/ConnectionRecoveryScreen.js";

type RecoveryState = "reconnecting" | "offline" | "ended" | null;

declare global {
  interface Window {
    reconnectStoryAttempts: number;
    setReconnectStoryState(state: RecoveryState): void;
  }
}

export function ReconnectionLifecycleStory(): React.JSX.Element {
  const [recovery, setRecovery] = useState<RecoveryState>(null);
  const instanceId = useRef(crypto.randomUUID());
  window.reconnectStoryAttempts ??= 0;

  useEffect(() => {
    window.setReconnectStoryState = setRecovery;
  }, []);

  return (
    <main data-testid="game-shell" data-instance-id={instanceId.current}>
      <section aria-label="Ash Atlas map">
        <strong>Sandia Foothills</strong>
        <span>Map center 35.0844, -106.6504 · zoom 14</span>
      </section>
      <aside aria-label="Open inventory panel">
        <label>
          Selected item
          <input defaultValue="Pine timber" />
        </label>
      </aside>
      {recovery ? (
        <ConnectionRecoveryScreen
          state={recovery}
          onReconnect={() => {
            window.reconnectStoryAttempts += 1;
            setRecovery("reconnecting");
          }}
        />
      ) : null}
    </main>
  );
}
