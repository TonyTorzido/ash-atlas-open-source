import { useEffect, useState } from "react";

import {
  bossCastRemainingMs,
  type BossCastSnapshot,
  type CombatEntitySnapshot,
  type BossEncounterProjection
} from "@ash-atlas/shared";

import { HealthBarTrack } from "./HealthBarTrack.js";
import { BossTelegraphLayer as GeometryTelegraphLayer } from "./BossTelegraphLayer.js";

export function BossTelegraphLayer({
  casts,
  roomWidth,
  roomHeight,
  now = Date.now()
}: Readonly<{
  casts: readonly BossCastSnapshot[];
  roomWidth: number;
  roomHeight: number;
  now?: number;
}>): React.JSX.Element | null {
  return <GeometryTelegraphLayer
    telegraphs={casts}
    roomWidth={roomWidth}
    roomHeight={roomHeight}
    serverNow={now}
  />;
}

export type BossEncounterHudState = CombatEntitySnapshot;

type Props = Readonly<{
  boss: BossEncounterHudState | null;
  synchronizedNow?: () => number;
}>;

function nowFrom(synchronizedNow?: () => number): number {
  return synchronizedNow?.() ?? Date.now();
}

function bossPhaseLabel(phaseId: string): string {
  // Golem Forge: the Granite Bull's standing monoliths and the Forgemaster's anvil strikes (golemForgeBosses.ts).
  const monoliths = /^(enraged_)?monoliths_(\d+)$/.exec(phaseId);
  if (monoliths) return `${monoliths[1] ? "Enraged · " : ""}Monoliths ${monoliths[2]}/4`;
  const strikes = /^anvil_strikes_(\d+)$/.exec(phaseId);
  if (strikes) return `Anvil strikes ${strikes[1]}/3`;
  // The Corrupted Core: which husk it possesses, or the Core thrown out and exposed (double damage).
  const core = /^(enraged_)?(possessing|exposed)_(\d+)$/.exec(phaseId);
  if (core) {
    const prefix = core[1] ? "Enraged · " : "";
    return core[2] === "exposed" ? `${prefix}Core exposed · x2 damage` : `${prefix}Husk ${core[3]}/4`;
  }
  switch (phaseId) {
    case "steam": return "Steam / Enraged";
    case "rest": return "Rest / Vulnerable";
    case "normal": return "Normal";
    default: return phaseId.replaceAll("_", " ").replaceAll("-", " ");
  }
}

export function isRenderableBoss(entity: CombatEntitySnapshot | null): entity is CombatEntitySnapshot & {
  bossEncounter: BossEncounterProjection;
} {
  return Boolean(
    entity?.kind === "mob" &&
    entity.bossEncounter &&
    entity.bossEncounter.lifecycleState === "active" &&
    entity.lifeState === "alive"
  );
}

export function BossEncounterHud({ boss, synchronizedNow }: Props): React.JSX.Element | null {
  const [now, setNow] = useState(() => nowFrom(synchronizedNow));
  useEffect(() => {
    if (!boss) return undefined;
    const update = (): void => setNow(nowFrom(synchronizedNow));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [boss, synchronizedNow]);

  if (!isRenderableBoss(boss)) {
    return null;
  }
  const encounter = boss.bossEncounter;
  const activeCast = [...encounter.activeCasts]
    .filter((cast) => cast.resolveTime > now)
    .sort((left, right) =>
      left.resolveTime - right.resolveTime || left.castInstanceId.localeCompare(right.castInstanceId)
    )[0] ?? null;
  const remainingMs = activeCast ? bossCastRemainingMs(activeCast, now) : 0;
  const phaseRemainingMs = encounter.phaseDeadlineAt === undefined
    ? null
    : Math.max(0, encounter.phaseDeadlineAt - now);
  return <section
    className="boss-encounter-hud"
    aria-label={`${boss.name} boss encounter`}
    data-boss-encounter-id={encounter.encounterId}
    data-boss-lifecycle={encounter.lifecycleState}
  >
    <header className="boss-encounter-hud-header">
      <span className="boss-encounter-hud-eyebrow">Boss encounter</span>
      <strong>{boss.name}</strong>
      {encounter.phaseId ? <span className="boss-encounter-hud-phase" data-phase-id={encounter.phaseId}>
        {bossPhaseLabel(encounter.phaseId)}
        {phaseRemainingMs === null ? "" : ` · ${(phaseRemainingMs / 1_000).toFixed(1)}s`}
      </span> : null}
    </header>
    <HealthBarTrack
      current={boss.currentHealth}
      maximum={boss.maxHealth}
      label={`${boss.name} health`}
      className="boss-encounter-health"
    />
    {!encounter.participation.canJoin ? <p
      className="boss-encounter-participation"
      role="status"
    >Participation unavailable</p> : null}
    {activeCast ? <p
      className="boss-encounter-cast-warning"
      role="status"
      aria-live="polite"
      data-cast-instance-id={activeCast.castInstanceId}
    >
      <span aria-hidden="true">!</span>
      {activeCast.abilityId.replaceAll("_", " ")} in {(remainingMs / 1_000).toFixed(1)}s
    </p> : null}
  </section>;
}
