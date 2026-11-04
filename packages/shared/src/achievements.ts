export const BITTER_BLOOD_ACHIEVEMENT_ID = "bitter_blood" as const;
export const POISON_DAMAGE_TAKEN_STAT_KEY = "poison_damage_taken" as const;
export const BITTER_BLOOD_POISON_DAMAGE_REQUIRED = 250;

export type AchievementId = typeof BITTER_BLOOD_ACHIEVEMENT_ID;
export type PlayerStatKey = typeof POISON_DAMAGE_TAKEN_STAT_KEY;

export type AchievementProgressSnapshot = Readonly<{
  achievementId: AchievementId;
  title: string;
  badgeId: string;
  completed: boolean;
  completedAt: string | null;
  statKey: PlayerStatKey;
  value: number;
  requiredValue: number;
}>;

export type AchievementSnapshot = Readonly<{
  playerId: string;
  achievements: readonly AchievementProgressSnapshot[];
  serverTime: number;
}>;
