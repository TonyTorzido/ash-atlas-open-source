import { describe, expect, it } from "vitest";

import {
  announcementListPresentation,
  mergeAnnouncementHistory,
  shouldRestoreFailedDismissal
} from "./announcementPresentation.js";

const older = { id: "11111111-1111-4111-8111-111111111111", title: "Older", message: "Old", publishedAt: "2026-09-01T12:00:00.000Z" };
const newer = { id: "22222222-2222-4222-8222-222222222222", title: "Newer", message: "New", publishedAt: "2026-09-01T13:00:00.000Z" };

describe("announcement presentation races", () => {
  it("does not show a dismissed latest announcement", () => {
    expect(announcementListPresentation(null, {
      announcements: [newer, older], latestAnnouncementId: newer.id, latestAnnouncementDismissed: true
    }, new Set())?.hud).toBeNull();
  });

  it("keeps a newer live push when a stale list response arrives", () => {
    expect(announcementListPresentation(newer, {
      announcements: [older], latestAnnouncementId: older.id, latestAnnouncementDismissed: false
    }, new Set())).toBeNull();
    expect(mergeAnnouncementHistory([older], [newer])).toEqual([newer, older]);
  });

  it("never restores an old dismissal after a newer push", () => {
    expect(shouldRestoreFailedDismissal(older.id, newer)).toBe(false);
    expect(shouldRestoreFailedDismissal(newer.id, newer)).toBe(true);
  });
});
