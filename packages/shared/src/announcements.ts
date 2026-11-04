import { z } from "zod";

export const PLAYER_ANNOUNCEMENT_TITLE_MAX_LENGTH = 80;
export const PLAYER_ANNOUNCEMENT_MESSAGE_MAX_LENGTH = 2_000;
export const PLAYER_ANNOUNCEMENT_LIST_LIMIT = 50;

export const playerAnnouncementSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(PLAYER_ANNOUNCEMENT_TITLE_MAX_LENGTH),
  message: z.string().trim().min(1).max(PLAYER_ANNOUNCEMENT_MESSAGE_MAX_LENGTH),
  publishedAt: z.string().datetime()
}).strict();

export type PlayerAnnouncement = z.infer<typeof playerAnnouncementSchema>;

export const playerAnnouncementListResponseSchema = z.object({
  announcements: z.array(playerAnnouncementSchema).max(PLAYER_ANNOUNCEMENT_LIST_LIMIT),
  latestAnnouncementId: z.string().uuid().nullable(),
  latestAnnouncementDismissed: z.boolean()
}).strict();

export type PlayerAnnouncementListResponse = z.infer<
  typeof playerAnnouncementListResponseSchema
>;

export const publishPlayerAnnouncementRequestSchema = z.object({
  operationKey: z.string().uuid(),
  title: z.string().trim().min(1).max(PLAYER_ANNOUNCEMENT_TITLE_MAX_LENGTH),
  message: z.string().trim().min(1).max(PLAYER_ANNOUNCEMENT_MESSAGE_MAX_LENGTH)
}).strict();

export type PublishPlayerAnnouncementRequest = z.infer<
  typeof publishPlayerAnnouncementRequestSchema
>;

export const publishPlayerAnnouncementResponseSchema = z.object({
  announcement: playerAnnouncementSchema,
  replayed: z.boolean()
}).strict();

export type PublishPlayerAnnouncementResponse = z.infer<
  typeof publishPlayerAnnouncementResponseSchema
>;

export const dismissPlayerAnnouncementResponseSchema = z.object({
  announcementId: z.string().uuid(),
  dismissed: z.literal(true),
  dismissedAt: z.string().datetime()
}).strict();

export type DismissPlayerAnnouncementResponse = z.infer<
  typeof dismissPlayerAnnouncementResponseSchema
>;
