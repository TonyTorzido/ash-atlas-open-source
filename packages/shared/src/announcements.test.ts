import { describe, expect, it } from "vitest";

import {
  PLAYER_ANNOUNCEMENT_LIST_LIMIT,
  playerAnnouncementListResponseSchema,
  publishPlayerAnnouncementRequestSchema
} from "./announcements.js";
import { parseServerMessage } from "./protocol.js";

describe("player announcement contracts", () => {
  it("trims valid publication input and enforces bounded nonblank fields", () => {
    expect(publishPlayerAnnouncementRequestSchema.parse({
      operationKey: "11111111-1111-4111-8111-111111111111",
      title: "  Welcome  ",
      message: "  Hello players.\n\nHave fun.  "
    })).toMatchObject({ title: "Welcome", message: "Hello players.\n\nHave fun." });
    expect(publishPlayerAnnouncementRequestSchema.safeParse({
      operationKey: "bad", title: " ", message: "x"
    }).success).toBe(false);
    expect(publishPlayerAnnouncementRequestSchema.safeParse({
      operationKey: "11111111-1111-4111-8111-111111111111",
      title: "x".repeat(81), message: "x".repeat(2_001)
    }).success).toBe(false);
  });

  it("limits list responses and rejects author identity fields", () => {
    const announcement = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Title",
      message: "Message",
      publishedAt: "2026-08-31T12:00:00.000Z"
    };
    expect(playerAnnouncementListResponseSchema.safeParse({
      announcements: Array.from({ length: PLAYER_ANNOUNCEMENT_LIST_LIMIT + 1 }, () => announcement),
      latestAnnouncementId: announcement.id,
      latestAnnouncementDismissed: false
    }).success).toBe(false);
    expect(playerAnnouncementListResponseSchema.safeParse({
      announcements: [{ ...announcement, createdByAccountId: "secret" }],
      latestAnnouncementId: announcement.id,
      latestAnnouncementDismissed: false
    }).success).toBe(false);
    expect(playerAnnouncementListResponseSchema.parse({
      announcements: [announcement],
      latestAnnouncementId: announcement.id,
      latestAnnouncementDismissed: true
    })).toMatchObject({ latestAnnouncementDismissed: true });
  });

  it("runtime-validates published announcement websocket frames", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "PLAYER_ANNOUNCEMENT_PUBLISHED",
      announcement: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Live notice",
        message: "Hello players",
        publishedAt: "2026-09-01T12:00:00.000Z"
      }
    }))).toMatchObject({ type: "PLAYER_ANNOUNCEMENT_PUBLISHED" });
  });
});
