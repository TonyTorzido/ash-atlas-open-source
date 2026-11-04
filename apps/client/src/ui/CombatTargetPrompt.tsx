import { type CombatEntitySnapshot } from "@ash-atlas/shared";
import { GameActionPrompt, type GamePromptAction, type GamePromptPresentationState } from "./GameActionPrompt.js";
import { HealthBarTrack } from "./HealthBarTrack.js";

type CombatTargetPromptProps = {
  target: CombatEntitySnapshot | null;
  distanceM: number | null;
  disabled: boolean;
  disabledReason?: string | null;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  primaryActionLabel?: string;
  /** Every skill and ability usable on this target (own skills, pet abilities, Net). */
  skillActions?: readonly GamePromptAction[];
  onAttack(): void;
  onClose(): void;
};

/** Desktop combat target: the standard compact popup with a health readout. */
export function CombatTargetPrompt({
  target,
  distanceM,
  disabled,
  disabledReason = null,
  presentationState,
  actionsReady = true,
  primaryActionLabel = "Attack",
  skillActions = [],
  onAttack,
  onClose
}: CombatTargetPromptProps): React.JSX.Element | null {
  if (!target) return null;
  const actions: GamePromptAction[] = [
    {
      key: "attack",
      label: primaryActionLabel,
      enabled: !disabled && target.lifeState === "alive" && disabledReason === null,
      onSelect: onAttack
    },
  ];
  return <GameActionPrompt
    title={target.name}
    category={target.kind === "mob"
      ? `${tierLabel(target.challengeTier)} · Lv ${target.level}`
      : `Level ${target.level} · ${target.kind === "player" ? "Player" : "Mob"}`}
    ariaLabel="Combat target"
    presentationState={presentationState}
    actionsReady={actionsReady}
    className="combat-target-window"
    content={<>
      <HealthBarTrack
        className="combat-health-track"
        label={`${target.currentHealth} of ${target.maxHealth} health`}
        current={target.currentHealth}
        maximum={target.maxHealth}
        ward={target.ward ?? 0}
      />
      <div className="combat-target-meta">
        <span>{target.currentHealth} / {target.maxHealth} HP{(target.ward ?? 0) > 0 ? ` · ${target.ward} Ward` : ""}</span>
        <span>{distanceM === null ? "" : `${Math.round(distanceM)} m`}</span>
      </div>
    </>}
    actions={actions}
    skills={skillActions}
    onCancel={onClose}
  />;
}

function tierLabel(tier: CombatEntitySnapshot["challengeTier"]): string {
  if (!tier) return "Common";
  return tier[0]!.toUpperCase() + tier.slice(1);
}
