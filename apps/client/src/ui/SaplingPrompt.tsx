import {
  GIVING_SAPLING_DISPLAY_NAME,
  GIVING_SAPLING_GROWN_DISPLAY_NAME,
  SAPLING_PULL_GROVE_LORE_RANK
} from "@ash-atlas/shared";

import type { NearbySapling } from "../features/pets/useSaplingFeature.js";
import { GameActionPrompt, type GameActionPromptProps } from "./GameActionPrompt.js";

function remaining(ms: number | null): string {
  if (ms === null) return "";
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Status line: when it needs tending, or that it can be tended now. */
export function saplingTendingLine(entry: NearbySapling): string | null {
  if (entry.sapling.state !== "sapling") return null;
  if (entry.phase === "dying") return `Dying: tend within ${remaining(entry.diesInMs)}`;
  if (entry.phase === "needs_tending") return "Tend now";
  return `Needs tending in ${remaining(entry.tendReadyInMs)}`;
}

/** Tapping a planted sapling or grown player tree on the map. */
export function SaplingPrompt(props: Readonly<{
  entry: NearbySapling;
  ownPlayerId: string | null;
  groveLoreRank: number;
  /** A Shovel in the inventory uproots any growing sapling, anyone's, anywhere. */
  hasShovel: boolean;
  online: boolean;
  busy: boolean;
  onTend(): void;
  onPull(): void;
  onGather(): void;
  onChop(): void;
  onClose(): void;
}>): React.JSX.Element {
  const { entry } = props;
  const { sapling } = entry;
  const grown = sapling.state === "grown";
  const owner = sapling.ownerPlayerId === props.ownPlayerId ? "You" : sapling.ownerUsername ?? "Another player";
  const offline = props.online ? null : "Disconnected";
  const tendingLine = saplingTendingLine(entry);
  const tendBlock = offline ?? (entry.phase === "healthy" ? `Can be tended in ${remaining(entry.tendReadyInMs)}` : null);
  const berryReady = entry.berryReadyInMs === null;
  const chop = {
    key: "chop",
    label: "Chop",
    tone: "secondary" as const,
    enabled: !props.busy && !offline,
    busy: props.busy,
    disabledReason: offline,
    onSelect: props.onChop
  };
  const actions: GameActionPromptProps["actions"] = grown
    ? [{
        key: "gather",
        label: "Gather berry",
        enabled: !props.busy && !offline && berryReady,
        busy: props.busy,
        disabledReason: offline ?? (berryReady ? null : `Berries regrow in ${remaining(entry.berryReadyInMs)}`),
        onSelect: props.onGather
      }, chop]
    : [{
        key: "tend",
        label: "Tend",
        enabled: !props.busy && tendBlock === null,
        busy: props.busy,
        disabledReason: tendBlock,
        onSelect: props.onTend
      }, ...(props.hasShovel || props.groveLoreRank >= SAPLING_PULL_GROVE_LORE_RANK ? [{
        key: "pull",
        label: "Pull up",
        tone: "secondary" as const,
        enabled: !props.busy && !offline,
        busy: props.busy,
        disabledReason: offline,
        onSelect: props.onPull
      }] : [])];
  const details = grown
    ? [
        "Stage: Grown Giving Tree",
        berryReady ? "Berries: ready to gather" : `Berries regrow in ${remaining(entry.berryReadyInMs)}`
      ]
    : [
        "Stage: Sapling",
        `Growth: ${entry.growthPercent ?? 0}%`,
        `Matures in ${remaining(entry.maturesInMs)}${sapling.fastGrowth ? " (Grove Lore)" : ""}`,
        ...(tendingLine ? [tendingLine] : []),
        ...(entry.phase !== "healthy" ? ["Sick: it does not heal until tended"] : [])
      ];
  return <GameActionPrompt
    title={grown ? GIVING_SAPLING_GROWN_DISPLAY_NAME : GIVING_SAPLING_DISPLAY_NAME}
    category={`Planted by ${owner}`}
    content={<div className="sapling-prompt-details" role="group" aria-label="Sapling status">
      {details.map((line) => <p key={line} style={{ margin: "2px 0" }}>{line}</p>)}
      {!grown && entry.growthPercent !== null ? <div
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={entry.growthPercent}
        aria-label="Growth" style={{ height: 6, borderRadius: 3, background: "rgba(148, 163, 184, 0.25)", marginTop: 6 }}>
        <div style={{ width: `${entry.growthPercent}%`, height: "100%", borderRadius: 3, background: "#4ade80" }} />
      </div> : null}
    </div>}
    actions={actions}
    onCancel={props.onClose}
  />;
}
