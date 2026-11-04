import { isDungeonResourceNodeId, type CollectibleNode } from "@ash-atlas/shared";
import { GameActionPrompt, type GamePromptPresentationState } from "./GameActionPrompt.js";

import {
  HARVEST_RANGE_M,
  collectibleDisplayName,
  collectibleProduceAvailable,
  harvestActionLabel,
  treeProduceActionLabel,
  harvestActivityLabel,
  harvestRemainingMs,
  type HarvestTask
} from "../collectibles/harvest.js";

type CollectiblePromptProps = {
  collectible: CollectibleNode | null;
  distanceM: number | null;
  task: HarvestTask | null;
  nowMs: number;
  disabled: boolean;
  otherHarvestBusy?: boolean;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  onHarvest(action: "primary" | "resin"): void;
  onClaim?(): void;
  onManageAccess?(): void;
  manageAccessBusy?: boolean;
  manageAccessError?: string | null;
  onCancel(): void;
};

export function CollectiblePrompt({
  collectible,
  distanceM,
  task,
  nowMs,
  disabled,
  otherHarvestBusy = false,
  presentationState,
  actionsReady = true,
  onHarvest,
  onClaim,
  onManageAccess,
  manageAccessBusy = false,
  manageAccessError = null,
  onCancel
}: CollectiblePromptProps): React.JSX.Element | null {
  if (!collectible) {
    return null;
  }

  const name = collectibleDisplayName(collectible, nowMs);
  const remainingSeconds = task
    ? harvestRemainingMs(task, nowMs) / 1_000
    : 0;
  const isTree = collectible.type === "wood" && !collectible.repeatableNodeType;
  const isMine = collectible.repeatableNodeType !== undefined;
  const canManageAccess = isMine && collectible.repeatableCanManage === true && Boolean(onManageAccess);
  const managementDisabledReason = !canManageAccess
    ? null
    : manageAccessBusy
      ? "Updating access…"
      : disabled
        ? "Access management is unavailable while disconnected or gathering."
        : otherHarvestBusy
          ? "Finish gathering before changing access."
        : distanceM === null || distanceM > HARVEST_RANGE_M
          ? `Move within ${HARVEST_RANGE_M} meters of this mine to change access.`
          : null;
  const resinTask = task?.action === "resin";
  const action = resinTask
    ? treeProduceActionLabel(collectible).toUpperCase()
    : harvestActionLabel(collectible).toUpperCase();
  const activity = resinTask
    ? treeProduceActionLabel(collectible).replace(/^(Harvest|Gather)/u, "Harvesting").toUpperCase()
    : harvestActivityLabel(collectible).toUpperCase();
  const depleted = isMine && collectible.repeatableState === "depleted";
  const privateMine = isMine && collectible.repeatableOwnerPlayerId !== null
    && collectible.repeatableAccessMode === "private" && !collectible.repeatableCanManage;
  const depletedCountdown =
    depleted && collectible.repeatableTimerVisibility === "visible"
    ? formatRemainingDuration(collectible.repeatableReadyAt, nowMs)
    : null;
  const depletedLabel = depleted
    ? depletedCountdown
      ? `Depleted — Ready in ${depletedCountdown}`
      : "Depleted"
    : null;
  const buttonLabel = depletedLabel ?? (task
    ? task.phase === "approaching"
      ? `Moving into range for ${action}...`
      : task.phase === "starting"
        ? `Starting ${activity}...`
        : task.phase === "harvesting"
        ? `${activity} — ${remainingSeconds.toFixed(1)}s`
        : `Completing ${activity}...`
    : action);

  return <GameActionPrompt
    title={name}
    category={isMine ? "HARVESTABLE MINE" : "HARVESTABLE RESOURCE"}
    message={manageAccessError
      ? { text: manageAccessError, tone: "error" }
      : depletedLabel ? { text: depletedLabel, tone: "muted" } : null}
    presentationState={presentationState}
    actionsReady={actionsReady}
    content={<>
      <div className="interaction-prompt-meta">Type: {collectible.type}</div>
      <div className="interaction-prompt-meta">Available: {collectible.quantity}</div>
      {isMine ? <div className="interaction-prompt-meta">
        {collectible.repeatableOwnerPlayerId
          ? `${collectible.repeatableAccessMode === "public" ? "Public" : "Private"} · Owner: ${collectible.repeatableOwnerUsername ?? "Player"}${!collectible.repeatableCanManage && collectible.repeatableAccessMode === "public" ? ` · Toll: ${collectible.repeatableTollGold ?? "0"} Gold` : ""}`
          : isDungeonResourceNodeId(collectible.id) ? "Dungeon vein · Gone when the dungeon resets" : "Unclaimed · Anyone may mine"}
        {collectible.repeatableBonusExtractionAvailable ? " · Unbroken vein: mine again" : ""}
      </div> : null}
      <div className="interaction-prompt-meta">
        Distance: {distanceM === null ? "unknown" : `${distanceM.toFixed(1)} m`} / Interaction range: {HARVEST_RANGE_M} m
      </div>
    </>}
    actions={[
      {
        key: "harvest",
        label: isTree && resinTask ? "CHOP" : buttonLabel,
        enabled: !(disabled || depleted || privateMine),
        onSelect: () => onHarvest("primary")
      },
      ...(isTree && (resinTask || collectibleProduceAvailable(collectible, nowMs)) ? [{
        key: "resin", label: resinTask ? buttonLabel : treeProduceActionLabel(collectible),
        enabled: !disabled, tone: "secondary" as const,
        onSelect: () => onHarvest("resin" as const)
      }] : []),
      ...(isMine && collectible.repeatableOwnerPlayerId === null && onClaim ? [{
        key: "claim", label: "Claim Mine · 3 Stone + 10 Wood",
        enabled: !(disabled || task !== null || otherHarvestBusy), tone: "secondary" as const,
        onSelect: onClaim
      }] : []),
      ...(canManageAccess ? [{
        key: "manage-access",
        label: `Make ${collectible.repeatableAccessMode === "private" ? "Public" : "Private"}`,
        enabled: managementDisabledReason === null,
        busy: manageAccessBusy,
        tone: "secondary" as const,
        onSelect: onManageAccess!
      }] : [])
    ]}
    onCancel={onCancel}
  />;
}

export function formatRemainingDuration(
  readyAt: string | null | undefined,
  nowMs: number
): string | null {
  if (!readyAt) return null;
  const deadlineMs = Date.parse(readyAt);
  if (!Number.isFinite(deadlineMs)) return null;
  const remainingMs = Math.max(0, deadlineMs - nowMs);
  if (remainingMs === 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes >= 60) {
    return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  }
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.ceil((remainingMs % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
