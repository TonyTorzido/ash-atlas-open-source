import { deathDropSummaryText, type DeathDropSummary } from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import { GameActionPrompt } from "./GameActionPrompt.js";

export type DeathScreenDrop = DeathDropSummary | null;

export function DeathScreen(props: Readonly<{
  open: boolean;
  expectedXpLoss: number | null;
  /** What the death left on the ground (lowest backpack plus overflow), when known. */
  deathDrop?: DeathScreenDrop;
  respawnAvailableAt: number | null;
  connected: boolean;
  error: string | null;
  onRespawn(): string | null;
}>): React.JSX.Element | null {
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clockMs, setClockMs] = useState(Date.now);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    setClockMs(now);
    if (!props.open || props.respawnAvailableAt === null || props.respawnAvailableAt <= now) return;
    const intervalId = window.setInterval(() => {
      const next = Date.now();
      setClockMs(next);
      if (next >= props.respawnAvailableAt!) window.clearInterval(intervalId);
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [props.open, props.respawnAvailableAt]);

  useEffect(() => {
    if (props.open) return;
    setPendingRequestId(null);
    setError(null);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, [props.open]);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  useEffect(() => {
    if (props.connected && props.error === null) return;
    setPendingRequestId(null);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, [props.connected, props.error]);

  const busy = pendingRequestId !== null;
  const respawnSeconds = props.respawnAvailableAt === null
    ? 0
    : Math.max(0, Math.ceil((props.respawnAvailableAt - clockMs) / 1_000));
  const respawnReady = respawnSeconds === 0;
  const status = !props.connected
    ? "Reconnect to respawn."
    : props.error ?? error;
  const xpDetail = props.expectedXpLoss === null
    ? null
    : props.expectedXpLoss === 0
      ? "No EXP was lost"
      : `Lost 3% EXP (${props.expectedXpLoss.toLocaleString("en-US")} EXP)`;
  const dropDetail = deathDropSummaryText(props.deathDrop);
  const detail = [xpDetail, dropDetail].filter(Boolean).join(". ") || null;

  if (!props.open) return null;
  return <GameActionPrompt
    forced
    title="YOU FELL"
    detail={detail}
    ariaLabel="You fell"
    message={status ? { text: status, tone: "error" } : null}
    actions={[{
      key: "respawn",
      label: busy ? "Respawning…" : respawnReady ? "Respawn" : `Respawn (${respawnSeconds})`,
      enabled: props.connected && respawnReady,
      busy,
      onSelect: () => {
          if (!props.connected || !respawnReady || busy) return;
          setError(null);
          const requestId = props.onRespawn();
          if (!requestId) {
            setError("Respawn could not be sent. Try again.");
            return;
          }
          setPendingRequestId(requestId);
          timeoutRef.current = window.setTimeout(() => {
            setPendingRequestId((current) => current === requestId ? null : current);
            setError("Respawn is taking longer than expected. Try again.");
            timeoutRef.current = null;
          }, 8_000);
      }
    }]}
    onCancel={() => {}}
  />;
}
