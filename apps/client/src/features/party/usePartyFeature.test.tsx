// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProfileApiClient } from "../../profiles/profileClient.js";
import { usePartyFeature } from "./usePartyFeature.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePartyFeature", () => {
  it("owns authoritative party snapshots and WELCOME reset", () => {
    const profileApi = {} as ProfileApiClient;
    const { result } = renderHook(() => usePartyFeature({
      connectionStatus: "offline",
      ownPlayerId: "player-1",
      profileApi
    }));

    act(() => result.current.handleServerMessage({
      type: "PARTY_SNAPSHOT",
      party: {
        partyId: "party-1",
        leaderPlayerId: "player-1",
        memberPlayerIds: ["player-1", "player-2"],
        allowTravel: true,
        autoFollowPlayerIds: [],
        revision: 1
      },
      invites: [],
      outgoingInvites: []
    }));
    expect(result.current.view.party?.partyId).toBe("party-1");
    expect(result.current.view.inviteContext.party?.revision).toBe(1);

    act(() => result.current.resetForWelcome());
    expect(result.current.view.party).toBeNull();
    expect(result.current.view.invites).toEqual([]);
    expect(result.current.view.outgoingInvites).toEqual([]);
  });

  it("cleans the outgoing-invite expiry timer on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { result, unmount } = renderHook(() => usePartyFeature({
      connectionStatus: "offline",
      ownPlayerId: "player-1",
      profileApi: {} as ProfileApiClient
    }));
    act(() => result.current.handleServerMessage({
      type: "PARTY_SNAPSHOT",
      party: null,
      invites: [],
      outgoingInvites: [{
        targetPlayerId: "player-2",
        expiresAt: "2026-01-01T00:00:10.000Z"
      }]
    }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
