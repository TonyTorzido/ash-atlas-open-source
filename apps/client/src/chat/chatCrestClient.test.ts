import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatCrestApi } from "./chatCrestClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatCrestApi", () => {
  it("loads the server-owned selection and equips with the session CSRF token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({
          crests: [{ id: "stag", label: "Stag", assetKey: "chat-crests/stag.png" }],
          equippedCrestId: "stag"
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        crests: [{ id: "leaf", label: "Leaf", assetKey: "chat-crests/leaf.png" }],
        equippedCrestId: "leaf"
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatCrestApi("https://server.test", "csrf-token");

    await expect(api.list()).resolves.toMatchObject({ equippedCrestId: "leaf" });
    await expect(api.equip("stag")).resolves.toMatchObject({ equippedCrestId: "stag" });
    const [, init] = fetchMock.mock.calls[1]!;
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://server.test/api/chat/crests");
    expect(init?.credentials).toBe("include");
    expect((init?.headers as Headers).get("x-csrf-token")).toBe("csrf-token");
    expect(JSON.parse(String(init?.body))).toEqual({ crestId: "stag" });
  });

  it("rejects invalid IDs before network access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatCrestApi("https://server.test", "csrf-token");
    await expect(api.equip("not-registered")).rejects.toMatchObject({
      code: "CHAT_CREST_INVALID",
      status: 400
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
