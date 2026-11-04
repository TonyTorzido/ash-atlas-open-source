import { z } from "zod";

export const WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS = [
  { key: "flags_built", label: "Flags Built", group: "overall" },
  { key: "cities_founded", label: "Cities Founded", group: "overall" },
  { key: "trees_chopped", label: "Trees Chopped", group: "overall" },
  { key: "exp_earned", label: "EXP Earned", group: "overall" },
  { key: "folios_studied", label: "Folios Studied", group: "overall" },
  {
    key: "mysterious_travelers_killed",
    label: "Mysterious Travelers",
    group: "hunting"
  },
  { key: "ogres_killed", label: "Ogres", group: "hunting" },
  { key: "deer_killed", label: "Deer", group: "hunting" },
  { key: "wolves_killed", label: "Wolves", group: "hunting" },
  { key: "resin_crawlers_killed", label: "Resin Crawlers", group: "hunting" }
] as const;

export type WeeklyLeaderboardCategory =
  (typeof WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS)[number]["key"];

export type WeeklyLeaderboardCategoryGroup =
  (typeof WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS)[number]["group"];

export const WEEKLY_LEADERBOARD_CATEGORIES =
  WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS.map(({ key }) => key) as [
    WeeklyLeaderboardCategory,
    ...WeeklyLeaderboardCategory[]
  ];

export const weeklyLeaderboardCategorySchema = z.enum(
  WEEKLY_LEADERBOARD_CATEGORIES
);

export const weeklyLeaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  playerId: z.string().min(1),
  displayName: z.string().min(1),
  value: z.number().int().nonnegative(),
  reachedAt: z.string().datetime()
});

export type WeeklyLeaderboardEntry = z.infer<
  typeof weeklyLeaderboardEntrySchema
>;

export const weeklyLeaderboardPersonalRankSchema = z.object({
  category: weeklyLeaderboardCategorySchema,
  value: z.number().int().nonnegative(),
  rank: z.number().int().positive().nullable(),
  reachedAt: z.string().datetime().nullable(),
  nearby: z.array(weeklyLeaderboardEntrySchema).max(5)
});

export const weeklyLeaderboardBoardSchema = z.object({
  category: weeklyLeaderboardCategorySchema,
  top: z.array(weeklyLeaderboardEntrySchema).max(100),
  personal: weeklyLeaderboardPersonalRankSchema
});

export const weeklyLeaderboardSnapshotSchema = z.object({
  timezone: z.literal("America/Denver"),
  weekStart: z.string().date(),
  weekStartAt: z.string().datetime(),
  nextWeekStart: z.string().datetime(),
  previousWeekStart: z.string().date(),
  serverNow: z.string().datetime(),
  remainingSeconds: z.number().int().nonnegative(),
  archived: z.boolean(),
  boards: z.array(weeklyLeaderboardBoardSchema).length(
    WEEKLY_LEADERBOARD_CATEGORIES.length
  )
});

export type WeeklyLeaderboardSnapshot = z.infer<
  typeof weeklyLeaderboardSnapshotSchema
>;

export const developerLeaderboardPlayerSchema = z.object({
  playerId: z.string().min(1),
  displayName: z.string().min(1),
  eligible: z.boolean()
});

export const developerLeaderboardPlayerSearchSchema = z.object({
  players: z.array(developerLeaderboardPlayerSchema).max(25)
});

export const developerLeaderboardMetricBreakdownSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.number().int().nonnegative()
});

export const developerLeaderboardMetricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  group: z.string().min(1),
  visibility: z.enum(["public", "owner_only"]),
  value: z.number().int().nonnegative(),
  rank: z.number().int().positive().nullable(),
  reachedAt: z.string().datetime().nullable(),
  breakdown: z.array(developerLeaderboardMetricBreakdownSchema).optional()
});

export const developerLeaderboardPeriodSchema = z.object({
  timezone: z.literal("America/Denver"),
  weekStart: z.string().date(),
  weekStartAt: z.string().datetime(),
  nextWeekStart: z.string().datetime(),
  archived: z.boolean()
});

export const developerLeaderboardPlayerInspectorSchema = z.object({
  period: developerLeaderboardPeriodSchema,
  player: developerLeaderboardPlayerSchema,
  metrics: z.array(developerLeaderboardMetricSchema)
});

export const developerLeaderboardRankingEntrySchema = z.object({
  rank: z.number().int().positive(),
  playerId: z.string().min(1),
  displayName: z.string().min(1),
  value: z.number().int().nonnegative(),
  reachedAt: z.string().datetime()
});

export const developerLeaderboardPrivateRankingSchema = z.object({
  period: developerLeaderboardPeriodSchema,
  metric: z.object({
    key: z.string().min(1),
    label: z.string().min(1)
  }),
  entries: z.array(developerLeaderboardRankingEntrySchema).max(100)
});

export type DeveloperLeaderboardPlayer = z.infer<
  typeof developerLeaderboardPlayerSchema
>;
export type DeveloperLeaderboardMetric = z.infer<
  typeof developerLeaderboardMetricSchema
>;
export type DeveloperLeaderboardPlayerInspector = z.infer<
  typeof developerLeaderboardPlayerInspectorSchema
>;
export type DeveloperLeaderboardPrivateRanking = z.infer<
  typeof developerLeaderboardPrivateRankingSchema
>;
