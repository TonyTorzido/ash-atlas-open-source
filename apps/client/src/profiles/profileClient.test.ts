import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_API_CONTRACT_HEADER,
  PROFILE_API_CONTRACT_VERSION
} from "@ash-atlas/shared";
import { ProfileApiClient } from "./profileClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProfileApiClient", () => {
  it("negotiates the appearance-capable profile contract", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({
        profile: {
          playerId: "player-1",
          displayName: "Atlas",
          level: 4,
          portrait: { kind: "player_sprite", displayColor: null },
          title: null,
          biography: null,
          presence: "hidden",
          class: null,
          kingdom: null,
          settlement: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isSelf: true,
          relationship: { friendship: "none", enemyMarkedByViewer: false }
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new ProfileApiClient("http://127.0.0.1:3001", "csrf").getProfile("player-1");

    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get(PROFILE_API_CONTRACT_HEADER))
      .toBe(PROFILE_API_CONTRACT_VERSION);
  });
});
