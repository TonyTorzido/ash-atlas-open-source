import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncementClient } from "./announcementClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("AnnouncementClient", () => {
  it("loads validated history with credentials", async () => {
    const body = { announcements: [], latestAnnouncementId: null, latestAnnouncementDismissed: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new AnnouncementClient("https://game.example").list()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://game.example/api/announcements"),
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("persists dismissal with credentials, CSRF, and keepalive", async () => {
    const body = {
      announcementId: "22222222-2222-4222-8222-222222222222",
      dismissed: true,
      dismissedAt: "2026-09-01T12:00:00.000Z"
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new AnnouncementClient("https://game.example", "csrf-token").dismiss(body.announcementId)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`https://game.example/api/announcements/${body.announcementId}/dismiss`),
      expect.objectContaining({
        method: "POST", credentials: "include", keepalive: true,
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" })
      })
    );
  });

  it("publishes with CSRF and rejects invalid successful responses", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AnnouncementClient("https://game.example", "csrf-token");
    await expect(client.publish({
      operationKey: "11111111-1111-4111-8111-111111111111",
      title: "Welcome",
      message: "Hello"
    })).rejects.toThrow("invalid server response");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://game.example/api/admin/announcements"),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" })
      })
    );
  });
});
