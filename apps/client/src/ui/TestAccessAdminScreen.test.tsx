// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestAccessAdminScreen } from "./TestAccessAdminScreen.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Test Access mode administration", () => {
  it("shows authoritative state, confirms the destination, and saves the server result", async () => {
    let resolveMutation: (response: Response) => void = () => {
      throw new Error("Mutation request was not started");
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/mode") && init?.method === "POST") {
        return new Promise<Response>((resolve) => { resolveMutation = resolve; });
      }
      if (url.pathname.endsWith("/mode")) {
        return Promise.resolve(jsonResponse({
          mode: "closed",
          updatedAt: "2026-08-09T00:00:00.000Z"
        }));
      }
      return Promise.resolve(jsonResponse(emptyList()));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TestAccessAdminScreen
      serverHttpBase="http://localhost:3000"
      csrfToken="csrf"
      onClose={vi.fn()}
    />);

    expect(screen.getByText("Loading authoritative mode...")).toBeTruthy();
    expect(await screen.findByText("CLOSED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("Enable Open Access?")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Enable Open Access" }));
    expect((screen.getByRole("button", { name: "Saving..." }) as HTMLButtonElement).disabled).toBe(
      true
    );
    resolveMutation(jsonResponse({
      mode: "open",
      updatedAt: "2026-08-09T00:01:00.000Z"
    }));

    expect(await screen.findByText("OPEN")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(screen.getByText("Enable Closed Access?")).toBeTruthy();
    expect(screen.getByText(/Accounts without approval or pre-approval/)).toBeTruthy();
    expect(screen.queryByText("Enable Open Access?")).toBeNull();
  });

  it("offers dev access as a third confirmed mode and manages the dev list by hand", async () => {
    let mode = "closed";
    const posts: Array<{ path: string; body: unknown }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        const body: unknown = JSON.parse(String(init.body ?? "{}"));
        posts.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/mode")) {
          mode = (body as { mode: string }).mode;
          return Promise.resolve(jsonResponse({ mode, updatedAt: "2026-10-02T00:00:00.000Z" }));
        }
        return Promise.resolve(jsonResponse({ status: "approved" }));
      }
      if (url.pathname.endsWith("/mode")) {
        return Promise.resolve(jsonResponse({ mode, updatedAt: "2026-10-02T00:00:00.000Z" }));
      }
      if (url.searchParams.get("status") === "dev") {
        return Promise.resolve(jsonResponse({
          ...emptyList(),
          total: 2,
          items: [
            devEntry("00000000-0000-4000-8000-000000000001", "asker@example.com", "pending"),
            devEntry("00000000-0000-4000-8000-000000000002", "tester@example.com", "approved")
          ]
        }));
      }
      return Promise.resolve(jsonResponse(emptyList()));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TestAccessAdminScreen
      serverHttpBase="http://localhost:3000"
      csrfToken="csrf"
      onClose={vi.fn()}
    />);
    await screen.findByText("CLOSED");
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    expect(screen.getByText("Enable Dev Access?")).toBeTruthy();
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Enable Dev Access" }));
    expect(await screen.findByText("DEV")).toBeTruthy();
    expect(screen.getByText("Only developer accounts can enter Ash Atlas.")).toBeTruthy();
    expect(posts).toEqual([{ path: "/api/admin/test-access/mode", body: { mode: "dev" } }]);

    fireEvent.click(screen.getByRole("button", { name: "Dev list" }));
    expect(await screen.findByText("asker@example.com")).toBeTruthy();
    expect(screen.getByText("On the Dev list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts.at(-1)?.path).toBe(
      "/api/admin/test-access/dev/accounts/00000000-0000-4000-8000-000000000001/approve"
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText("Remove from Dev List?")).toBeTruthy();
    const postsBeforeConfirm = posts.length;
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(posts).toHaveLength(postsBeforeConfirm + 1));
    expect(posts.at(-1)?.path).toBe(
      "/api/admin/test-access/dev/accounts/00000000-0000-4000-8000-000000000002/revoke"
    );
  });

  it("keeps the last authoritative mode when a change fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/mode") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({
          error: { message: "Mode change failed" }
        }, 500));
      }
      if (url.pathname.endsWith("/mode")) {
        return Promise.resolve(jsonResponse({
          mode: "closed",
          updatedAt: "2026-08-09T00:00:00.000Z"
        }));
      }
      return Promise.resolve(jsonResponse(emptyList()));
    }));

    render(<TestAccessAdminScreen
      serverHttpBase="http://localhost:3000"
      csrfToken="csrf"
      onClose={vi.fn()}
    />);
    await screen.findByText("CLOSED");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable Open Access" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Mode change failed"));
    expect(screen.getByText("CLOSED")).toBeTruthy();
    expect(screen.queryByText("OPEN")).toBeNull();
  });
});

function devEntry(accountId: string, verifiedEmail: string, devAccessStatus: string) {
  return {
    kind: "dev",
    accountId,
    verifiedEmail,
    devAccessStatus,
    testAccessStatus: "approved",
    requestedAt: "2026-10-01T00:00:00.000Z",
    decidedAt: null,
    lastLoginAt: null,
    playerName: null
  };
}

function emptyList() {
  return {
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
    queryDurationMs: 1
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
