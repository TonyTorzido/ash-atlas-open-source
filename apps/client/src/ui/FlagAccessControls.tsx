import type {
  FlagAccessMode,
  FlagAccessSnapshot,
  FlagSnapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import { flagVisitLockLabel } from "../combat/aggressive.js";
import {
  requestFlagPassage,
  saveFlagAccess
} from "../flags/flagAccess.js";

const ACCESS_MODES: ReadonlyArray<Readonly<{
  value: FlagAccessMode;
  label: string;
  description: string;
}>> = [
  { value: "public", label: "Public", description: "Anyone except blocked enemies can travel." },
  { value: "normal", label: "Normal", description: "Travelers need the owner’s Normal passage." },
  { value: "private", label: "Private", description: "Only the owner or an accepted invite can travel." }
];

type Props = Readonly<{
  flag: FlagSnapshot;
  player: PlayerSnapshot | null;
  walletGold: string | null;
  serverHttpBase: string;
  csrfToken: string;
  access: FlagAccessSnapshot;
  aggressiveRemainingMs: number;
  travelPending?: boolean;
  connected?: boolean;
  compact?: boolean;
  onVisitFlag(flagId: string, expectedTollGold?: string, requestId?: string): boolean;
  onAccessChange(access: FlagAccessSnapshot): void;
  onAccessSaved?(access: FlagAccessSnapshot): void;
}>;

export function FlagAccessControls(props: Props): React.JSX.Element {
  const [access, setAccess] = useState(props.access);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FlagAccessMode>(props.access.mode);
  const [toll, setToll] = useState(props.access.jumpTollGold);
  const owner = props.flag.controlType === "personal" &&
    props.flag.ownerId === props.player?.playerId;
  const connected = props.connected !== false;

  useEffect(() => {
    setAccess(props.access);
    setMode(props.access.mode);
    setToll(props.access.jumpTollGold);
    setError(null);
  }, [props.access]);

  const shortfall = useMemo(() => {
    if (!access || access.decision.tollGold === "0" || props.walletGold === null) return 0n;
    return BigInt(access.decision.tollGold) > BigInt(props.walletGold)
      ? BigInt(access.decision.tollGold) - BigInt(props.walletGold)
      : 0n;
  }, [access, props.walletGold]);

  const canVisit = connected &&
    !props.travelPending &&
    access.decision.allowed &&
    shortfall === 0n &&
    props.aggressiveRemainingMs <= 0;
  const save = async (): Promise<void> => {
    if (busy || !owner) return;
    setBusy(true);
    setError(null);
    try {
      const next = await saveFlagAccess(
        props.serverHttpBase,
        props.csrfToken,
        props.flag.id,
        { mode, jumpTollGold: mode === "public" || mode === "normal" ? toll : "0" }
      );
      setAccess(next);
      setMode(next.mode);
      setToll(next.jumpTollGold);
      (props.onAccessSaved ?? props.onAccessChange)(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Flag access update failed.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="flag-access-card" aria-label="Flag access">
    <div className="flag-access-summary">
      <strong>{accessSummary(access)}</strong>
      {!access.decision.allowed ? <span>{decisionMessage(access)}</span> : null}
      {shortfall > 0n ? <span>You need {shortfall.toString()} more gold to travel.</span> : null}
    </div>
    <button
      type="button"
      className="panel-action"
      disabled={!canVisit}
      onClick={() => props.onVisitFlag(props.flag.id, access.decision.tollGold)}
    >
      {props.travelPending
        ? "Traveling..."
        : props.aggressiveRemainingMs > 0
        ? flagVisitLockLabel(props.aggressiveRemainingMs)
        : !access.decision.allowed
          ? access.mode === "normal" ? "Passage required" : "Private flag"
          : access.decision.tollGold !== "0"
            ? `Travel — ${access.decision.tollGold} gold`
            : access.mode === "public" ? "Travel — Free" : "Travel"}
    </button>
    {!owner && access.decision.requestable ? <button
      type="button"
      className="panel-action panel-action-secondary"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setError(null);
        void requestFlagPassage(props.serverHttpBase, props.csrfToken, props.flag.id)
          .then(() => {
            const next: FlagAccessSnapshot = { ...access, requestPending: true, decision: {
              ...access.decision,
              requestable: false,
              reasonCode: "NORMAL_REQUEST_PENDING"
            }};
            setAccess(next);
            props.onAccessChange(next);
          })
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "Passage request failed."))
          .finally(() => setBusy(false));
      }}
    >Request Access</button> : !owner && !access.decision.allowed && access.mode === "normal" ? (
      <button type="button" className="panel-action panel-action-secondary" disabled>
        {access.requestPending ? "Request Pending" : "Request Access"}
      </button>
    ) : null}
    {owner && !props.compact ? <div className="flag-access-owner">
      <fieldset className="flag-access-mode-options" disabled={busy}>
        <legend>Access</legend>
        {ACCESS_MODES.map((option) => <button
          key={option.value}
          type="button"
          className={mode === option.value ? "active" : ""}
          aria-pressed={mode === option.value}
          onClick={() => {
            setMode(option.value);
            if (option.value === "private") setToll("0");
          }}
        >
          <strong>{option.label}</strong>
          <small>{option.description}</small>
        </button>)}
      </fieldset>
      {mode === "public" || mode === "normal" ? <label>
        {mode === "public" ? "Public toll" : "Normal toll"}
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={1_000_000}
          step={1}
          value={toll}
          disabled={busy}
          onChange={(event) => setToll(event.currentTarget.value.replace(/[^0-9]/g, ""))}
        />
        <small>{toll === "0" ? "Free" : `${toll || "0"} gold per traveler`}</small>
      </label> : null}
      <button
        type="button"
        className="panel-action"
        disabled={busy || ((mode === "public" || mode === "normal") && toll === "")}
        onClick={() => void save()}
      >{busy ? "Saving…" : "Save Access"}</button>
    </div> : null}
    {error ? <p className="panel-error" role="alert">{error}</p> : null}
  </section>;
}

function accessSummary(access: FlagAccessSnapshot): string {
  if (access.decision.reasonCode.endsWith("ENEMY_BLOCKED")) return "Enemy blocked";
  if (access.mode === "private") return "Private";
  const label = access.mode === "public" ? "Public" : "Normal";
  return access.decision.allowed
    ? access.decision.tollGold === "0"
      ? `${label} — Free`
      : `${label} — ${access.decision.tollGold} gold`
    : `${label} — Passage required`;
}

function decisionMessage(access: FlagAccessSnapshot): string {
  switch (access.decision.reasonCode) {
    case "PRIVATE_OWNER_ONLY": return "Only the flag owner can travel here.";
    case "PUBLIC_ENEMY_BLOCKED":
    case "NORMAL_ENEMY_BLOCKED": return "Enemies cannot travel to this flag.";
    case "NORMAL_REQUEST_PENDING": return "Your passage request is pending.";
    case "NORMAL_PASSAGE_REQUIRED": return "Request Normal passage from this owner.";
    default: return "You do not have access to this flag.";
  }
}
