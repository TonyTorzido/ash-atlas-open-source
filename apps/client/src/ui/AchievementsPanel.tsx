import type { AchievementSnapshot } from "@ash-atlas/shared";

import { GameAppCard } from "./GameAppShell.js";
import { JournalProgress, LegendJournalContent, type JournalBackOverride } from "./LegendJournalContent.js";
import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";

export function AchievementsPanel(props: Readonly<{
  achievements: AchievementSnapshot | null;
  serverHttpBase?: string;
  onBack(): void;
}>): React.JSX.Element {
  return <PhoneMenuDestinationShell
    title="Achievements"
    className="achievements-app"
    bodyClassName={props.serverHttpBase ? "achievements-journal-body" : "achievements-body"}
    onBack={props.onBack}
  >
    <AchievementsContent achievements={props.achievements}
      {...(props.serverHttpBase ? { serverHttpBase: props.serverHttpBase } : {})} />
  </PhoneMenuDestinationShell>;
}

export function AchievementsContent({ achievements, serverHttpBase, playerId, layout, onBackChange }: Readonly<{
  achievements: AchievementSnapshot | null;
  serverHttpBase?: string;
  playerId?: string;
  layout?: "desktop" | "phone";
  onBackChange?(override: JournalBackOverride | null): void;
}>): React.JSX.Element {
  const currentPlayerId = playerId ?? achievements?.playerId;
  const currentAchievements = achievements && (!currentPlayerId || achievements.playerId === currentPlayerId) ? achievements : null;
  return serverHttpBase
    ? <LegendJournalContent key={serverHttpBase + ":" + (currentPlayerId ?? "session")}
      serverHttpBase={serverHttpBase} {...(currentPlayerId ? { playerId: currentPlayerId } : {})}
      achievements={currentAchievements} {...(layout ? { layout } : {})} {...(onBackChange ? { onBackChange } : {})} />
    : <div className="achievements-workspace"><LegacyAchievements achievements={currentAchievements} /></div>;
}

function LegacyAchievements({ achievements }: Readonly<{ achievements: AchievementSnapshot | null }>): React.JSX.Element {
  return <>{!achievements ? <GameAppCard title="Loading achievements" badge="Waiting">
    <p className="achievements-supporting-copy" role="status">Waiting for authoritative achievement progress.</p>
  </GameAppCard> : achievements.achievements.map((achievement) => <GameAppCard
    key={achievement.achievementId}
    title={achievement.title}
    badge={achievement.completed ? "Completed" : "In progress"}
  >
    <div className="legend-journal-detail">
      <div className="achievement-objective">
        <span>Objective</span>
        <strong>Take {achievement.requiredValue.toLocaleString()} poison damage</strong>
        <small>Poison damage taken: {achievement.value.toLocaleString()} / {achievement.requiredValue.toLocaleString()}</small>
      </div>
      <JournalProgress label={achievement.title + " progress"} value={achievement.value} target={achievement.requiredValue} />
      <p className="achievements-supporting-copy">
        {achievement.completed
          ? "Unlocked" + (achievement.completedAt ? " " + formatCompletedAt(achievement.completedAt) : "") + "."
          : Math.max(0, achievement.requiredValue - achievement.value).toLocaleString() + " poison damage remaining."}
      </p>
      <p className="achievements-supporting-copy">Reward: unlocks Venom Core application and eligibility to equip Venomsteel gear.</p>
    </div>
  </GameAppCard>)}</>;
}

function formatCompletedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
