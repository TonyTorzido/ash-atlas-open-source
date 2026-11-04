import { z } from "zod";

import { playerAnnouncementSchema } from "../announcements.js";
import { serverFrame } from "./serverSchemaPrimitives.js";

export const announcementServerMessageSchemas = {
  PLAYER_DEATH_MESSAGE: serverFrame("PLAYER_DEATH_MESSAGE", { message: z.string().min(1).max(200) }),
  PLAYER_ANNOUNCEMENT_PUBLISHED: serverFrame("PLAYER_ANNOUNCEMENT_PUBLISHED", {
    announcement: playerAnnouncementSchema
  })
};
