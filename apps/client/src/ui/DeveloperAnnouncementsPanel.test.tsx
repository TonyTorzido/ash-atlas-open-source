// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperAnnouncementsPanel } from "./DeveloperAnnouncementsPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeveloperAnnouncementsPanel", () => {
  it("requires review and retains one operation key across a failed publication retry", async () => {
    const operationKey = "11111111-1111-4111-8111-111111111111";
    const requests: string[] = [];
    let publicationAttempt = 0;
    vi.stubGlobal("crypto", { randomUUID: () => operationKey });
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push(String(init.body));
        publicationAttempt += 1;
        if (publicationAttempt === 1) {
          return new Response(JSON.stringify({ error: { message: "Temporary failure" } }), { status: 503 });
        }
        return new Response(JSON.stringify({
          announcement: { id: "22222222-2222-4222-8222-222222222222", title: "Welcome", message: "Hello", publishedAt: "2026-08-31T12:00:00.000Z" },
          replayed: false
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        announcements: [], latestAnnouncementId: null, latestAnnouncementDismissed: false
      }), { status: 200 });
    }));

    render(<DeveloperAnnouncementsPanel serverHttpBase="https://game.example" csrfToken="csrf" />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Welcome" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello" } });
    expect(screen.queryByRole("button", { name: "Publish Announcement" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review Announcement" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish Announcement" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Publish Announcement" }));
    await screen.findByText("Announcement published.");
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((body) => JSON.parse(body).operationKey)).toEqual([operationKey, operationKey]);
  });
});
