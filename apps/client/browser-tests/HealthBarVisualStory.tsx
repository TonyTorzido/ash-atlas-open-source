import type { CombatEntitySnapshot, ProgressionSnapshot } from "@ash-atlas/shared";
import { useState } from "react";

import { CombatTargetPrompt } from "../src/ui/CombatTargetPrompt.js";
import { HealthBarTrack } from "../src/ui/HealthBarTrack.js";
import { ProgressionHud } from "../src/ui/ProgressionHud.js";

const progression: ProgressionSnapshot = {
  playerId: "health-story-player",
  totalXp: 6_420,
  level: 4,
  curveVersion: 1,
  persistenceVersion: 1,
  xpIntoLevel: 420,
  xpForNextLevel: 1_000,
  nextLevelTotalXp: 7_000,
  atCap: false,
  pveStats: {
    maxHealth: 100,
    attackPower: 10,
    defense: 5,
    attackIntervalMs: 1_000,
    attackRangeM: 2
  }
};

export function HealthBarVisualStory({ phone = false }: { phone?: boolean }): React.JSX.Element {
  const [currentHealth, setCurrentHealth] = useState(100);
  const player = combatEntity("health-story-player", "player", currentHealth);
  const target = combatEntity("health-story-target", "mob", 18);

  return (
    <main className={`health-bar-story${phone ? " health-bar-story-phone" : ""}`}>
      <style>{`
        body { margin: 0; background: #0d0b08; }
        .health-bar-story { min-height: 100vh; padding: 28px; display: grid; align-content: start; gap: 22px; color: #e7dcc2; font-family: Inter, Arial, sans-serif; }
        .health-bar-story-surfaces { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
        .health-bar-story-surface { min-height: 270px; padding: 22px; display: grid; align-content: start; gap: 18px; border: 1px solid #595851; }
        .health-bar-story-surface.bright { background: linear-gradient(135deg, #c7b57d, #7f9567 54%, #b7c4ba); }
        .health-bar-story-surface.dark { background: linear-gradient(135deg, #17140f, #27311f 54%, #152934); }
        .health-bar-story .player-status-hud { position: static; width: min(304px, 100%); }
        .health-bar-story .combat-target-prompt { position: static; width: min(340px, 100%); transform: none; }
        .health-bar-story-transition { width: min(520px, 100%); display: grid; gap: 10px; }
        .health-bar-story-transition-controls { display: flex; gap: 8px; }
        .health-bar-story-transition button { padding: 7px 12px; }
        .health-bar-story-phone { width: 390px; min-height: 844px; padding: 12px; }
        .health-bar-story-phone .health-bar-story-surfaces { grid-template-columns: 1fr; }
        .health-bar-story-phone .health-bar-story-surface { min-height: 180px; padding: 12px; }
        .health-bar-story-phone .phone-bottom-status { width: 100%; height: 48px; display: flex; padding: 2px 5px; background: #271b14; }
      `}</style>
      <section className="health-bar-story-surfaces" aria-label="Terrain contrast samples">
        {(["bright", "dark"] as const).map((surface) => (
          <article className={`health-bar-story-surface ${surface}`} key={surface}>
            <ProgressionHud
              progression={progression}
              combat={surface === "bright" ? player : { ...player, currentHealth: 24 }}
              classSnapshot={null}
            />
            <CombatTargetPrompt
              target={target}
              distanceM={18}
              disabled={false}
              onAttack={() => undefined}
              onClose={() => undefined}
            />
          </article>
        ))}
      </section>
      {phone ? (
        <section className="phone-bottom-status" aria-label="Phone health bar">
          <ProgressionHud
            progression={progression}
            combat={player}
            classSnapshot={null}
            variant="phoneDock"
          />
        </section>
      ) : null}
      <section className="health-bar-story-transition" aria-label="Health transition sample">
        <HealthBarTrack label="Transition health" current={currentHealth} maximum={100} />
        <div className="health-bar-story-transition-controls">
          <button type="button" onClick={() => setCurrentHealth(45)}>Damage</button>
          <button type="button" onClick={() => setCurrentHealth(82)}>Heal</button>
          <button type="button" onClick={() => setCurrentHealth(0)}>Zero</button>
        </div>
      </section>
    </main>
  );
}

function combatEntity(
  entityId: string,
  kind: "player" | "mob",
  currentHealth: number
): CombatEntitySnapshot {
  return {
    entityId,
    kind,
    archetypeKey: kind === "mob" ? "goblin" : null,
    name: kind === "mob" ? "Goblin" : "Player",
    level: 4,
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35,
    lon: -106,
    maxHealth: 100,
    currentHealth,
    lifeState: "alive",
    activityState: "idle",
    targetEntityId: null,
    revision: 1,
    classCombat: kind === "player" ? {
      activeClassId: "warrior",
      resource: {
        resourceId: "rage",
        displayName: "Rage",
        current: 0,
        maximum: 100,
        reserved: 0
      },
      rage: 0,
      maximumRage: 100,
      reservedRage: 0,
      guard: 0,
      bloodlust: 0,
      queuedAbility: null,
      cooldownEndsAt: {}
    } : null
  };
}
