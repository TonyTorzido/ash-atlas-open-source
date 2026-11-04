import {
  CLASS_DEFINITIONS,
  CURRENT_LEVEL_CAP,
  type HungerSnapshot,
  type ClassSnapshot,
  type CombatEntitySnapshot,
  type ProgressionSnapshot
} from "@ash-atlas/shared";
import type { ReactNode } from "react";
import { formatAggressiveSeconds } from "../combat/aggressive.js";
import { useDeadlineRemainingMs } from "./useDeadlineRemainingMs.js";
import { isCriticalHealth } from "../combat/healthBarPresentation.js";
import { HealthBarTrack } from "./HealthBarTrack.js";
import { StatGlyph } from "./MenuDestinationGlyph.js";

type ProgressionHudProps = {
  progression: ProgressionSnapshot | null;
  combat: CombatEntitySnapshot | null;
  classSnapshot: ClassSnapshot | null;
  /** The authoritative hunger snapshot used by the phone dock. */
  hunger?: HungerSnapshot | null;
  aggressiveRemainingMs?: number;
  flagArrivalProtectionRemainingMs?: number;
  /** Absolute deadlines: when set, this HUD runs its own countdown and ignores the *RemainingMs props. */
  aggressiveUntilMs?: number;
  flagArrivalProtectionUntilMs?: number;
  /** PvP fights and marked aggressors the player may attack back, already formatted ("Ada struck you: attack back · 21h 40m"). */
  pvpTimerLines?: readonly string[];
  variant?: "default" | "phoneDock";
  /** Touch dock: hunger renders in the right-hand compartment instead (PhoneDockHunger). */
  omitHunger?: boolean;
};

export function ProgressionHud({
  progression,
  combat,
  classSnapshot,
  hunger,
  aggressiveRemainingMs: aggressiveRemainingMsProp = 0,
  flagArrivalProtectionRemainingMs: flagArrivalProtectionRemainingMsProp = 0,
  aggressiveUntilMs,
  flagArrivalProtectionUntilMs,
  pvpTimerLines = [],
  variant = "default",
  omitHunger = false
}: ProgressionHudProps): React.JSX.Element {
  const aggressiveRemainingMs = useDeadlineRemainingMs(aggressiveUntilMs, aggressiveRemainingMsProp);
  const flagArrivalProtectionRemainingMs = useDeadlineRemainingMs(
    flagArrivalProtectionUntilMs,
    flagArrivalProtectionRemainingMsProp
  );
  if (!progression) {
    const loadingExperience = <StatusBar
      label="Experience"
      phoneLabel="EXP"
      current={0}
      maximum={0}
      kind="experience"
      variant={variant}
      thin
    />;
    const loadingHunger = variant === "phoneDock" && hunger !== undefined && !omitHunger
      ? <StatusBar
          label="Hunger"
          phoneLabel="Hunger"
          current={finiteNonnegative(hunger?.current) ?? 0}
          maximum={finiteNonnegative(hunger?.baseCapacity) ?? 0}
          kind="hunger"
          variant={variant}
        />
      : null;
    return (
      <aside className={`player-status-hud${variant === "phoneDock" ? " player-status-hud-phone-dock" : ""}`} aria-label="Player status" aria-busy="true">
        <div className="player-status-heading"><strong>Loading</strong><span>Adventurer</span></div>
        <StatusBar label="Health" phoneLabel="HP" current={0} maximum={0} kind="health" variant={variant} />
        {variant === "phoneDock" ? <>{loadingExperience}{loadingHunger}</> : loadingExperience}
      </aside>
    );
  }
  const healthCurrent = combat?.currentHealth ?? progression.pveStats.maxHealth;
  const healthMaximum = combat?.maxHealth ?? progression.pveStats.maxHealth;
  const resource = combat?.classCombat?.resource ?? classSnapshot?.resource ?? null;
  const xpMaximum = progression.xpForNextLevel ?? progression.xpIntoLevel;
  const lowHealth = isCriticalHealth(healthCurrent, healthMaximum);
  const className = classSnapshot ? CLASS_DEFINITIONS[classSnapshot.activeClassId].name : "Adventurer";
  const resourceDefinition = classSnapshot ? CLASS_DEFINITIONS[classSnapshot.activeClassId] : CLASS_DEFINITIONS.warrior;
  const resourceLabel = resource?.displayName ?? resourceDefinition.resourceDisplayName;
  const resourceCurrent = resource?.current ?? classSnapshot?.rage ?? 0;
  const resourceMaximum = resource?.maximum ?? classSnapshot?.maximumRage ?? 100;
  const resourceKind = resource?.resourceId ?? resourceDefinition.resourceId;
  const usePhoneHunger = variant === "phoneDock" && hunger !== undefined;
  const hungerCurrent = finiteNonnegative(hunger?.current) ?? 0;
  const hungerMaximum = finiteNonnegative(hunger?.baseCapacity) ?? 0;
  const weaponStatus = combat?.weaponCombat
    ? combat.weaponCombat.switchingToSlot
      ? `Switching to ${combat.weaponCombat.switchingToSlot === "melee" ? "melee" : "ranged"}…`
      : combat.weaponCombat.activeWeaponInstanceId === null
        ? "Auto · Unarmed"
        : `Auto · ${combat.weaponCombat.activeWeaponSlot === "melee" ? "Melee" : "Ranged"}`
    : null;

  const experienceStatus = <StatusBar
    label="Experience"
    phoneLabel="EXP"
    current={progression.xpIntoLevel}
    maximum={xpMaximum}
    kind="experience"
    variant={variant}
    thin
    phoneAdornment={variant === "default" && aggressiveRemainingMs > 0 ? (
      <em className="aggressive-timer" role="status" aria-label={`Aggressive for ${formatAggressiveSeconds(aggressiveRemainingMs)}`}>
        AGG {formatAggressiveSeconds(aggressiveRemainingMs)}
      </em>
    ) : null}
  />;
  const secondaryStatus = usePhoneHunger
    ? omitHunger ? null : <StatusBar
        label="Hunger"
        phoneLabel="Hunger"
        current={hungerCurrent}
        maximum={hungerMaximum}
        kind="hunger"
        variant={variant}
      />
    : resourceKind !== "none" ? <StatusBar
        label={resourceLabel}
        phoneLabel={resourceLabel.toUpperCase()}
        current={resourceCurrent}
        maximum={resourceMaximum}
        kind={resourceKind}
        variant={variant}
      /> : null;

  return (
    <aside className={`player-status-hud${variant === "phoneDock" ? " player-status-hud-phone-dock" : ""}${lowHealth ? " low-health" : ""}`} aria-label="Player status">
      <div className="player-status-heading">
        <strong>Level {progression.atCap ? CURRENT_LEVEL_CAP : progression.level}</strong>
        <span>{className}</span>
      </div>
      {variant === "default" && weaponStatus
        ? <div className="weapon-combat-status" role="status">{weaponStatus}</div>
        : null}
      {variant === "default" && flagArrivalProtectionRemainingMs > 0
        ? (
            <div
              className="flag-arrival-protection-status"
              role="status"
              aria-label={`Arrival protection · ${formatArrivalProtectionRemaining(flagArrivalProtectionRemainingMs)} · Move or attack to end`}
            >
              Arrival protection · {formatArrivalProtectionRemaining(flagArrivalProtectionRemainingMs)} · Move or attack to end
            </div>
          )
        : null}
      {variant === "default" && pvpTimerLines.length > 0
        ? (
            <ul className="pvp-timer-status" role="status" aria-label="PvP timers">
              {pvpTimerLines.slice(0, 3).map((line) => <li key={line}>{line}</li>)}
              {pvpTimerLines.length > 3 ? <li>+{pvpTimerLines.length - 3} more</li> : null}
            </ul>
          )
        : null}
      <StatusBar
        label="Health"
        phoneLabel="HP"
        current={healthCurrent}
        maximum={healthMaximum}
        ward={combat?.ward ?? 0}
        kind="health"
        variant={variant}
        transitionKey={combat ? `combat:${combat.entityId}` : "progression"}
        note={combat?.maxHealthPenalty ? `−${combat.maxHealthPenalty} max HP (recovers 1/hr)` : null}
      />
      {variant === "phoneDock" ? <>{experienceStatus}{secondaryStatus}</> : <>{secondaryStatus}{experienceStatus}</>}
    </aside>
  );
}

/** The dock hunger bar, rendered by the touch dock beside the bag and gold line. */
export function PhoneDockHunger({ hunger }: { hunger: HungerSnapshot | null | undefined }): React.JSX.Element | null {
  if (hunger === undefined) return null;
  return <StatusBar
    label="Hunger"
    phoneLabel="Hunger"
    current={finiteNonnegative(hunger?.current) ?? 0}
    maximum={finiteNonnegative(hunger?.baseCapacity) ?? 0}
    kind="hunger"
    variant="phoneDock"
  />;
}

function StatusBar({ label, phoneLabel, current, maximum, ward = 0, kind, variant, thin = false, phoneAdornment = null, transitionKey, note = null }: {
  label: string;
  phoneLabel: string;
  current: number;
  maximum: number;
  ward?: number;
  kind: string;
  variant: "default" | "phoneDock";
  thin?: boolean;
  phoneAdornment?: ReactNode;
  transitionKey?: string;
  /** Extra detail after the value (e.g. the PvP max-HP penalty). */
  note?: string | null;
}): React.JSX.Element {
  const safeMaximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 0;
  const safeCurrent = Number.isFinite(current) ? Math.max(0, current) : 0;
  const percent = safeMaximum === 0 ? 0 : Math.min(100, safeCurrent / safeMaximum * 100);
  const accessibleValue = `${formatAccessibleNumber(safeCurrent)} / ${formatAccessibleNumber(safeMaximum)}${ward > 0 ? ` +${formatAccessibleNumber(ward)} Ward` : ""}${note ? ` · ${note}` : ""}`;
  const compactValue = <strong
    className="status-bar-compact-value"
    title={accessibleValue}
  >
    {compactNumber(safeCurrent)}<span className="status-bar-compact-maximum">/{compactNumber(safeMaximum)}</span>{ward > 0 ? ` +${compactNumber(ward)} W` : ""}
  </strong>;
  const adornment = variant === "phoneDock" && phoneAdornment
    ? <span className="status-bar-adornment">{phoneAdornment}</span>
    : null;
  const track = kind === "health" ? (
    <HealthBarTrack
      key={transitionKey}
      className="status-bar-track"
      label={label}
      current={safeCurrent}
      maximum={safeMaximum}
      ward={ward}
    >
      {adornment}
    </HealthBarTrack>
  ) : (
    <div className="status-bar-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={safeMaximum} aria-valuenow={Math.min(safeCurrent, safeMaximum)}>
      <span className="status-bar-track-fill" style={{ width: `${percent}%` }} />
      {adornment}
    </div>
  );
  if (variant === "phoneDock") return (
    <div className={`status-bar status-bar-phone-dock status-bar-${kind}${thin ? " status-bar-thin" : ""}${phoneAdornment ? " status-bar-phone-adorned" : ""}`}>
      <span className="status-bar-compact-label">
        <StatusBarGlyph kind={kind} />
        <span className="sr-only">{phoneLabel}</span>
      </span>
      {compactValue}
      {track}
    </div>
  );
  return (
    <div className={`status-bar status-bar-${kind}${thin ? " status-bar-thin" : ""}${phoneAdornment ? " status-bar-phone-adorned" : ""}`}>
      <div className="status-bar-label"><span>{label}{phoneAdornment}</span><strong title={note ?? undefined}>{safeCurrent.toLocaleString()} / {safeMaximum.toLocaleString()}{ward > 0 ? ` · ${ward.toLocaleString()} Ward` : ""}{note ? ` · ${note}` : ""}</strong></div>
      {track}
    </div>
  );
}

function StatusBarGlyph({ kind }: { kind: string }): React.JSX.Element | null {
  if (kind !== "health" && kind !== "hunger" && kind !== "experience") return null;
  return <StatGlyph
    className={`status-bar-compact-icon status-bar-compact-icon-${kind}`}
    icon={kind === "health" ? "heart" : kind === "hunger" ? "bread" : "star"}
  />;
}

function finiteNonnegative(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Math.max(0, value as number) : null;
}

function compactNumber(value: number): string {
  const whole = Math.round(Math.max(0, value));
  if (whole < 10_000) return whole.toLocaleString();
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(whole);
}

function formatAccessibleNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** "9s" under a minute, otherwise "4m 52s" (jump protection lasts 4 minutes). */
function formatArrivalProtectionRemaining(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
