import {
  GENERAL_ACTIVE_SLOT_IDS,
  GENERAL_SKILL_DEFINITIONS,
  type GeneralSkillId,
  type SkillSystemV3Snapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import { ClassAbilityIcon } from "./ClassAbilityIcon.js";
import { shouldIgnoreSkillHotkey } from "./WarriorQuickSlots.js";
import "./SkillSystemV3CombatControls.css";

export type SkillSystemV3CombatControlsProps = {
  snapshot: SkillSystemV3Snapshot;
  layout: "desktop" | "phone";
  disabled: boolean;
  disabledReason?: string | null;
  runtimeCooldownEndsAt?: Readonly<Record<string, number>>;
  synchronizedNow(): number;
  onUseGeneral(skillId: GeneralSkillId): void;
};

type SlotState = Readonly<{
  disabled: boolean;
  reason: string;
  cooldownRemainingMs: number;
}>;

export function SkillSystemV3CombatControls({
  snapshot,
  layout,
  disabled,
  disabledReason = null,
  runtimeCooldownEndsAt = {},
  synchronizedNow,
  onUseGeneral
}: SkillSystemV3CombatControlsProps): React.JSX.Element {
  const [serverNow, setServerNow] = useState(() => synchronizedNow());
  const generalButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setServerNow(synchronizedNow()), 250);
    return () => window.clearInterval(timer);
  }, [synchronizedNow]);

  useEffect(() => {
    if (layout !== "desktop") return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (shouldIgnoreSkillHotkey(event)) return;
      const button = event.key.toLowerCase() === "q"
        ? generalButtonRefs.current[0]
        : event.key.toLowerCase() === "w"
          ? generalButtonRefs.current[1]
          : null;
      if (!button) return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layout]);

  const learnedRanks = new Map(snapshot.generalSkills.map(({ skillId, rank }) => [skillId, rank]));
  const cooldownEnd = (key: string): number => Math.max(
    snapshot.cooldownEndsAt[key] ?? 0,
    runtimeCooldownEndsAt[key] ?? 0
  );
  const globalReason = disabled ? disabledReason ?? "Combat controls unavailable" : null;
  const generalButtons = GENERAL_ACTIVE_SLOT_IDS.map((slotId, index) => {
    const skillId = snapshot.generalActiveLoadout[index] ?? null;
    const definition = skillId ? GENERAL_SKILL_DEFINITIONS[skillId] : null;
    const rank = skillId ? learnedRanks.get(skillId) ?? 0 : 0;
    const cooldownRemainingMs = skillId
      ? Math.max(0, cooldownEnd(`v3:general:${skillId}`) - serverNow)
      : 0;
    const slotState = generalSlotState({
      skillId,
      rank,
      status: definition?.status ?? null,
      cooldownRemainingMs,
      globalReason
    });
    const label = definition?.displayName ?? `Empty General ${slotId}`;
    return (
      <button
        key={`general-${slotId}`}
        ref={(button) => { generalButtonRefs.current[index] = button; }}
        type="button"
        data-skill-system-version={layout === "phone" ? "v3" : undefined}
        data-general-active-slot={slotId}
        className={layout === "phone"
          ? `legacy-control-button legacy-skill-button legacy-skill-${index === 0 ? "one" : "two"}-button skill-v3-general-slot`
          : "warrior-quick-slot skill-v3-general-slot"}
        style={layout === "phone" ? PHONE_TARGET_STYLE : undefined}
        disabled={slotState.disabled}
        aria-label={`General ${slotId}: ${label}. ${definition ? `Rank ${rank}. ${statusLabel(definition.status)}.` : "No skill equipped."}${slotState.reason ? ` ${slotState.reason}.` : " Ready."}`}
        title={slotState.reason || `General ${slotId} · ${label} · Rank ${rank} · Ready`}
        onClick={() => { if (skillId && !slotState.disabled) onUseGeneral(skillId); }}
      >
        <span className="ability-hotkey" aria-hidden="true">{index === 0 ? "Q" : "W"}</span>
        <span className={layout === "phone" ? "legacy-skill-glyph" : undefined} aria-hidden={layout === "phone" || undefined}><ClassAbilityIcon abilityId={skillId} className="ability-icon" /></span>
        <span className="ability-slot-copy">
          <span className="skill-v3-slot-label">General {slotId}</span>
          <strong>{label}</strong>
          <small>{definition ? `Rank ${rank} · ${slotState.reason || statusLabel(definition.status)}` : "Equip an active skill"}</small>
        </span>
        {slotState.cooldownRemainingMs > 0 ? <Cooldown value={slotState.cooldownRemainingMs} phone={layout === "phone"} /> : null}
      </button>
    );
  });

  if (layout === "phone") return <>{generalButtons}</>;

  return (
    <aside
      className="warrior-combat-controls class-combat-controls skill-v3-combat-controls skill-v3-combat-controls--desktop"
      aria-label="Skill System V3 combat loadout"
      data-skill-system-version="v3"
    >
      <button
        type="button"
        className="warrior-quick-slot skill-v3-basic-slot"
        aria-disabled="true"
        aria-label="Basic Attack. Select a hostile target in the world to attack."
        title="Basic Attack remains target-driven — select a hostile target in the world"
      >
        <ClassAbilityIcon abilityId={null} className="ability-icon" />
        <span className="ability-slot-copy"><span className="skill-v3-slot-label">Basic Attack</span><strong>Basic Attack</strong><small>Select hostile target</small></span>
      </button>
      <div className="warrior-normal-slots skill-v3-normal-slots" aria-label="Equipped General Active skills">
        {generalButtons}
      </div>
    </aside>
  );
}

function generalSlotState(input: Readonly<{
  skillId: GeneralSkillId | null;
  rank: number;
  status: string | null;
  cooldownRemainingMs: number;
  globalReason: string | null;
}>): SlotState {
  const reason = input.globalReason
    ?? (input.skillId === null
      ? "No skill equipped"
      : input.rank <= 0
        ? "Skill is not learned"
        : input.status !== "implemented"
          ? `Skill is ${input.status === null ? "unavailable" : statusLabel(input.status)}`
          : input.cooldownRemainingMs > 0
            ? "Skill is on cooldown"
            : "");
  return { disabled: reason !== "", reason, cooldownRemainingMs: input.cooldownRemainingMs };
}

function statusLabel(status: string): string {
  return status === "implemented" ? "Implemented" : status.replaceAll("_", " ");
}

function Cooldown({ value, phone = false }: { value: number; phone?: boolean }): React.JSX.Element {
  return <span className={phone ? "legacy-cooldown-overlay" : "cooldown-overlay"} aria-hidden="true">{Math.max(1, Math.ceil(value / 1_000))}s</span>;
}

const PHONE_TARGET_STYLE = Object.freeze({ minWidth: 44, minHeight: 44 });
