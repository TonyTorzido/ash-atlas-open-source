import {
  BASIC_ATTACK_INTERVAL_MS,
  CLASS_IDS,
  SUBCLASS_CLASS_IDS,
  SUBCLASS_IDS,
  WARRIOR_LEVEL_XP,
  type ClassLoadoutView,
  type ClassSnapshot,
  type MasterySnapshot,
  type ProgressionSnapshot
} from "@ash-atlas/shared";
import { useState } from "react";

import { WarriorClassPanel } from "../src/ui/WarriorClassPanel.js";

export function WarriorLoadoutStory({ phone = false }: { phone?: boolean }): React.JSX.Element {
  const [loadout, setLoadout] = useState<ClassLoadoutView>({
    resetActives: [null, null],
    normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
    passiveTiers: ["warrior_heavy_handed", "warrior_relentless", null],
    ultimateActive: null
  });
  return <WarriorClassPanel
    open
    initialSection="warrior"
    layout={phone ? "phone" : "desktop"}
    snapshot={{ ...snapshot, loadout }}
    progression={progression}
    masteries={masteries}
    combatResource={null}
    busy={false}
    devProgressionVisible={false}
    devProgressionOpen={false}
    devProgressionPendingType={null}
    devProgressionError={null}
    devSubclassPending={null}
    onClose={() => undefined}
    onLoadout={setLoadout}
    onClass={() => undefined}
    onSubclass={() => undefined}
    onSetDevSubclassUnlock={() => undefined}
    onAdjustDevProgression={() => undefined}
    onToggleDevProgression={() => undefined}
  />;
}

const classes = CLASS_IDS.map((classId) => ({
  classId,
  level: classId === "warrior" ? 25 : 0,
  xp: classId === "warrior" ? WARRIOR_LEVEL_XP[25]! : 0,
  nextLevelXp: null,
  completedAt: null
}));

const snapshot: ClassSnapshot = {
  playerId: "warrior-story",
  characterLevel: 15,
  activeClassId: "warrior",
  activeSubclassId: null,
  warrior: classes[0]!,
  hunter: classes.find((entry) => entry.classId === "hunter")!,
  classes,
  subclasses: SUBCLASS_IDS.map((subclassId) => ({
    classId: SUBCLASS_CLASS_IDS[subclassId],
    subclassId,
    unlocked: false
  })),
  loadout: {
    resetActives: [null, null],
    normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
    passiveTiers: ["warrior_heavy_handed", "warrior_relentless", null],
    ultimateActive: null
  },
  legacyIds: [],
  rage: 0,
  maximumRage: 0,
  queuedAbility: null,
  cooldownEndsAt: {},
  serverTime: 0,
  revision: 1
};

const progression: ProgressionSnapshot = {
  playerId: "warrior-story",
  totalXp: 200_000,
  level: 15,
  curveVersion: 2,
  persistenceVersion: 1,
  xpIntoLevel: 0,
  xpForNextLevel: 0,
  nextLevelTotalXp: 200_000,
  atCap: false,
  pveStats: {
    maxHealth: 100,
    attackPower: 12,
    defense: 4,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: 75
  }
};

const masteries: MasterySnapshot = {
  playerId: "warrior-story",
  warrior: {
    trackId: "warrior",
    xp: 38_000,
    rank: 25,
    maximumRank: 25,
    nextRankXp: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    mastered: true,
    title: "Master Warrior"
  },
  professions: {
    woodcutter: profession("woodcutter", "Master Woodcutter"),
    miner: profession("miner", "Master Miner"),
    builder: profession("builder", "Master Builder"),
    oil_worker: profession("oil_worker", "Master Oil Worker"),
    metallurgy: profession("metallurgy", "Master Metallurgy")
  },
  achievementIds: ["mastery:warrior"],
  equippedTitle: "Master Warrior",
  serverTime: 0
};

function profession(
  trackId: "woodcutter" | "miner" | "builder" | "oil_worker" | "metallurgy",
  title: string
): MasterySnapshot["professions"]["woodcutter"] {
  return {
    trackId,
    xp: trackId === "oil_worker" ? 25_000 : 100_000,
    rank: 8,
    maximumRank: 8,
    nextRankXp: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    mastered: true,
    title
  };
}
