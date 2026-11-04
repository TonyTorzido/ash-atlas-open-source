import type { PlayerAnnouncement } from "../announcements.js";

export type AnnouncementServerMessage = {
  type: "PLAYER_DEATH_MESSAGE";
  message: string;
} | {
  type: "PLAYER_ANNOUNCEMENT_PUBLISHED";
  announcement: PlayerAnnouncement;
};
