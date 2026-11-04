import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import {
  PlayerAnnouncementConflictError,
  PlayerAnnouncementService
} from "./playerAnnouncements.js";

const operationKey = "11111111-1111-4111-8111-111111111111";
const row = {
  id: "22222222-2222-4222-8222-222222222222",
  operation_key: operationKey,
  title: "Welcome",
  message: "Hello",
  published_at: new Date("2026-08-31T12:00:00.000Z"),
  latest_dismissed: true
};

describe("PlayerAnnouncementService", () => {
  it("lists at most 50 newest-first records", async () => {
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const service = new PlayerAnnouncementService({ query } as unknown as pg.Pool);
    await expect(service.list("player")).resolves.toEqual({
      announcements: [{ id: row.id, title: "Welcome", message: "Hello", publishedAt: row.published_at.toISOString() }],
      latestAnnouncementId: row.id,
      latestAnnouncementDismissed: true
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY announcement.published_at DESC"), ["player", 50]);
  });

  it("durably dismisses idempotently and rejects an unknown announcement", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ dismissed_at: row.published_at }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ dismissed_at: row.published_at }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const service = new PlayerAnnouncementService({ query } as unknown as pg.Pool);
    await expect(service.dismiss("player", row.id)).resolves.toMatchObject({ dismissed: true, announcementId: row.id });
    await expect(service.dismiss("player", row.id)).resolves.toMatchObject({ dismissed: true, announcementId: row.id });
    await expect(service.dismiss("player", "33333333-3333-4333-8333-333333333333")).rejects.toMatchObject({ code: "ANNOUNCEMENT_NOT_FOUND" });
  });

  it("publishes once and returns identical operation replays", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const service = new PlayerAnnouncementService({ query } as unknown as pg.Pool);
    const input = { operationKey, title: "Welcome", message: "Hello" };
    await expect(service.publish("account", input)).resolves.toMatchObject({ replayed: false });
    await expect(service.publish("account", input)).resolves.toMatchObject({ replayed: true });
  });

  it("fails safely when an operation key is reused with different terms", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const service = new PlayerAnnouncementService({ query } as unknown as pg.Pool);
    await expect(service.publish("account", {
      operationKey, title: "Changed", message: "Hello"
    })).rejects.toBeInstanceOf(PlayerAnnouncementConflictError);
  });
});
