import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultHotbarSettings, HOTBAR_PLAYER_SLOT_IDS } from "@ash-atlas/shared";

import { ProfileApiClient } from "./profileClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("ProfileApiClient hotbar persistence", () => {
  it("loads the validated settings envelope", async () => {
    const hotbar = defaultHotbarSettings();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hotbar }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ProfileApiClient("https://game.example", "csrf-token").getHotbar()).resolves.toEqual(hotbar);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://game.example/api/profile/me/hotbar?bindings=actions"),
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
  });

  it("saves with CSRF and the expected revision payload", async () => {
    const input = {
      revision: 4,
      slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null })),
      rowCount: 4,
      rowPositions: [0, 12, 42, 54, 84]
    };
    const hotbar = {
      ...input,
      revision: 5,
      rowCount: 4,
      rowPositions: [0, 21, 42, 63, 84]
    };
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => new Response(JSON.stringify({ hotbar }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ProfileApiClient("https://game.example", "csrf-token").updateHotbar(input)).resolves.toEqual(hotbar);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("https://game.example/api/profile/me/hotbar?bindings=actions"));
    expect(init).toMatchObject({ method: "PATCH", credentials: "include", body: JSON.stringify(input) });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
  });
});
