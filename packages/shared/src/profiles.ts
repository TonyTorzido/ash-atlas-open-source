import { z } from "zod";

import {
  PLAYER_BODY_VARIANT_IDS,
  playerAppearanceSnapshotSchema,
  type PlayerAppearanceSnapshot
} from "./appearance.js";
import { CURRENT_LEVEL_CAP } from "./progression.js";

export const PROFILE_TITLES = ["Alpha Tester", "Noob", "Yo Mama"] as const;
export type ProfileTitle = (typeof PROFILE_TITLES)[number];
export const PROFILE_API_CONTRACT_HEADER = "x-ash-atlas-profile-contract" as const;
export const PROFILE_API_CONTRACT_VERSION = "2" as const;
export const PROFILE_BIOGRAPHY_MAX_CHARACTERS = 280;
export const SOCIAL_LIST_DEFAULT_LIMIT = 25;
export const SOCIAL_LIST_MAX_LIMIT = 50;
export const RECENT_PLAYERS_DEFAULT_LIMIT = 25;
export const RECENT_PLAYERS_MAX_LIMIT = 30;
export const PLAYER_PRESENCE_STATES = [
  "online",
  "recently_active",
  "offline",
  "hidden"
] as const;
export type PlayerPresenceState = (typeof PLAYER_PRESENCE_STATES)[number];
export const playerPresenceStateSchema = z.enum(PLAYER_PRESENCE_STATES);

export const RECENT_PLAYER_INTERACTION_TYPES = [
  "nearby",
  "local_chat",
  "party",
  "trade"
] as const;
export type RecentPlayerInteractionType = (typeof RECENT_PLAYER_INTERACTION_TYPES)[number];

export const FRIENDSHIP_STATES = [
  "none",
  "outgoing_request",
  "incoming_request",
  "friends",
  "blocked_by_viewer",
  "unavailable"
] as const;
export type FriendshipState = (typeof FRIENDSHIP_STATES)[number];

export const SOCIAL_ACTIONS = [
  "send_friend_request",
  "accept_friend_request",
  "decline_friend_request",
  "cancel_friend_request",
  "remove_friend",
  "mark_enemy",
  "request_neutrality",
  "accept_neutrality",
  "reject_neutrality",
  "cancel_neutrality",
  "block",
  "unblock"
] as const;
export type SocialAction = (typeof SOCIAL_ACTIONS)[number];

export const SOCIAL_LIST_KINDS = [
  "friends",
  "incoming_requests",
  "outgoing_requests",
  "enemies",
  "blocked"
] as const;
export type SocialListKind = (typeof SOCIAL_LIST_KINDS)[number];

export const playerIdSchema = z.string().min(1).max(160);
export const profileTargetPlayerIdSchema = z.string().uuid();

export const profileTextUpdateSchema = z.object({
  title: z.enum(PROFILE_TITLES).nullable().optional(),
  biography: z.string().nullable().optional()
}).strict().refine(
  (value) =>
    value.title !== undefined ||
    value.biography !== undefined,
  {
  message: "At least one profile field is required"
  }
);
export type ProfileTextUpdate = z.infer<typeof profileTextUpdateSchema>;

export const socialMutationRequestSchema = z.object({
  targetPlayerId: profileTargetPlayerIdSchema,
  action: z.enum(SOCIAL_ACTIONS)
}).strict();
export type SocialMutationRequest = z.infer<typeof socialMutationRequestSchema>;

export const SOCIAL_INBOX_ENTRY_KINDS = [
  "friend_request",
  "enemy_declaration"
] as const;
export type SocialInboxEntryKind = (typeof SOCIAL_INBOX_ENTRY_KINDS)[number];

export const SOCIAL_INBOX_ENTRY_STATES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "notice"
] as const;
export type SocialInboxEntryState = (typeof SOCIAL_INBOX_ENTRY_STATES)[number];

export const socialInboxEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(SOCIAL_INBOX_ENTRY_KINDS),
  actorPlayerId: playerIdSchema,
  actorDisplayName: z.string().min(1).max(64),
  state: z.enum(SOCIAL_INBOX_ENTRY_STATES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type SocialInboxEntry = z.infer<typeof socialInboxEntrySchema>;

export const socialInboxResponseSchema = z.object({
  entries: z.array(socialInboxEntrySchema).max(200),
  pendingIncomingFriendRequestCount: z.number().int().nonnegative()
}).strict();
export type SocialInboxResponse = z.infer<typeof socialInboxResponseSchema>;

export const socialListQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(SOCIAL_LIST_MAX_LIMIT).default(SOCIAL_LIST_DEFAULT_LIMIT)
}).strict();

export const profileAffiliationSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(120),
  iconKey: z.string().min(1).max(120).nullable().optional(),
  emblemKey: z.string().min(1).max(120).nullable().optional(),
  tier: z.enum(["village", "town", "city"]).nullable().optional(),
  memberRole: z.string().min(1).max(80).nullable().optional(),
  joinedAt: z.string().datetime().nullable().optional()
}).strict();
export type ProfileAffiliation = z.infer<typeof profileAffiliationSchema>;

export const viewerRelationshipSchema = z.object({
  friendship: z.enum(FRIENDSHIP_STATES),
  enemyMarkedByViewer: z.boolean(),
  neutralityRequest: z.enum(["none", "outgoing", "incoming"]).optional()
}).strict();
export type ViewerRelationship = z.infer<typeof viewerRelationshipSchema>;

const profileCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Public profile stat tiles. Gold is the current wallet balance. */
export const profileStatsSchema = z.object({
  gold: profileCountSchema,
  flags: profileCountSchema,
  oilWells: profileCountSchema,
  achievements: profileCountSchema,
  creaturesHunted: profileCountSchema,
  cityCoinsGiven: profileCountSchema,
  /** Lifetime combat record, counted from 2026-10 onward. */
  kills: profileCountSchema,
  deaths: profileCountSchema,
  pvpKills: profileCountSchema
}).strip();
export type ProfileStats = z.infer<typeof profileStatsSchema>;

export const profileWeeklyPlacementSchema = z.object({
  week: z.enum(["current", "previous"]),
  category: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  rank: z.number().int().min(1).max(100)
}).strip();
export type ProfileWeeklyPlacement = z.infer<typeof profileWeeklyPlacementSchema>;

export const profileRecentAchievementSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  unlockedAt: z.string()
}).strip();
export type ProfileRecentAchievement = z.infer<typeof profileRecentAchievementSchema>;

export const profilePetSchema = z.object({
  species: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  level: z.number().int().min(0).max(100)
}).strip();
export type ProfilePet = z.infer<typeof profilePetSchema>;

export const publicProfileSchema = z.object({
  playerId: playerIdSchema,
  displayName: z.string().min(1).max(64),
  level: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  /** Lifetime Library Folios; absent from older servers. */
  folios: z.number().int().nonnegative().optional(),
  portrait: z.object({
    kind: z.literal("player_sprite"),
    displayColor: z.string().nullable(),
    bodyVariantId: z.enum(PLAYER_BODY_VARIANT_IDS).optional()
  }).strict(),
  appearance: playerAppearanceSnapshotSchema
    .transform((value) => value as PlayerAppearanceSnapshot)
    .optional(),
  title: z.enum(PROFILE_TITLES).nullable(),
  biography: z.string().nullable(),
  presence: playerPresenceStateSchema,
  class: profileAffiliationSchema.nullable(),
  kingdom: profileAffiliationSchema.nullable(),
  settlement: profileAffiliationSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isSelf: z.boolean(),
  relationship: viewerRelationshipSchema,
  /** When the character was created (players.created_at). */
  playingSince: z.string().optional(),
  /** Only sent to the player and their friends, like presence. */
  lastSeenAt: z.string().nullable().optional(),
  legendRank: z.string().min(1).max(80).optional(),
  stats: profileStatsSchema.optional(),
  weeklyPlacements: z.array(profileWeeklyPlacementSchema).max(40).optional(),
  recentAchievements: z.array(profileRecentAchievementSchema).max(3).optional(),
  pet: profilePetSchema.nullable().optional()
}).strip();
export type PublicProfile = z.infer<typeof publicProfileSchema>;

export const socialListEntrySchema = publicProfileSchema.pick({
  playerId: true,
  displayName: true,
  level: true,
  portrait: true,
  title: true,
  presence: true,
  class: true,
  kingdom: true,
  settlement: true,
  relationship: true
});
export type SocialListEntry = z.infer<typeof socialListEntrySchema>;

export const socialListResponseSchema = z.object({
  kind: z.enum(SOCIAL_LIST_KINDS),
  entries: z.array(socialListEntrySchema).max(SOCIAL_LIST_MAX_LIMIT),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(SOCIAL_LIST_MAX_LIMIT),
  hasMore: z.boolean()
}).strict();
export type SocialListResponse = z.infer<typeof socialListResponseSchema>;

export const socialPlayerSummarySchema = z.object({
  playerId: playerIdSchema,
  displayName: z.string().min(1).max(64),
  portrait: z.object({
    kind: z.literal("player_sprite"),
    displayColor: z.string().nullable()
  }).strict(),
  presence: playerPresenceStateSchema,
  relationship: viewerRelationshipSchema
}).strict();
export type SocialPlayerSummary = z.infer<typeof socialPlayerSummarySchema>;

export const recentPlayerEntrySchema = socialPlayerSummarySchema.extend({
  interactionType: z.enum(RECENT_PLAYER_INTERACTION_TYPES),
  interactionAt: z.string().datetime()
}).strict();
export type RecentPlayerEntry = z.infer<typeof recentPlayerEntrySchema>;

export const recentPlayersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_PLAYERS_MAX_LIMIT)
    .default(RECENT_PLAYERS_DEFAULT_LIMIT)
}).strict();

export const recentPlayersResponseSchema = z.object({
  entries: z.array(recentPlayerEntrySchema).max(RECENT_PLAYERS_MAX_LIMIT)
}).strict();
export type RecentPlayersResponse = z.infer<typeof recentPlayersResponseSchema>;
