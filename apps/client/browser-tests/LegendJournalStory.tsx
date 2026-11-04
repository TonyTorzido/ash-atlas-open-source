import { SkillTreeV3Panel } from "../src/ui/SkillTreeV3Panel.js";

const ignore = (): void => {};
export function LegendJournalStory({ layout }: Readonly<{ layout: "desktop" | "phone" }>): React.JSX.Element {
  return <SkillTreeV3Panel
    open layout={layout} snapshot={null} busy={false} error={null} masteries={null}
    selection={{ section: "achievements" }} serverHttpBase={window.location.origin}
    achievements={{ playerId: "journal-browser", serverTime: 1_800_000_000_000, achievements: [{
      achievementId: "bitter_blood", title: "Bitter Blood", badgeId: "bitter_blood", completed: false,
      completedAt: null, statKey: "poison_damage_taken", value: 184, requiredValue: 250
    }] }}
    onSelectionChange={ignore} onSpend={ignore} onActivate={ignore} onEquip={ignore} onUse={ignore}
    onRespec={ignore} onRequest={ignore} onClose={ignore} onReturnToGame={ignore}
  />;
}
