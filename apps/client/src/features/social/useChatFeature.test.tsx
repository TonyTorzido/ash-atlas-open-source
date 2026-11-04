// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SocialClient } from "../../client/domains/socialClient.js";
import { useChatFeature } from "./useChatFeature.js";

afterEach(cleanup);

describe("useChatFeature", () => {
  it("owns chat bootstrap, frame application, error recovery, and disconnect cleanup", () => {
    const commands = {
      selectChatChannel: vi.fn(() => "select-1")
    } as unknown as SocialClient;
    const onSocialStateChanged = vi.fn();
    const { result } = renderHook(() => useChatFeature({
      ownPlayerId: "player-1",
      getCommands: () => commands,
      onSocialStateChanged
    }));

    act(() => result.current.beginBootstrap());
    expect(result.current.store.getSnapshot().bootstrapState).toBe("loading");

    act(() => result.current.handleServerMessage({
      type: "CHAT_UNAVAILABLE",
      message: "Unavailable",
      retryable: true
    }));
    expect(result.current.store.getSnapshot().bootstrapState).toBe("unavailable");

    expect(result.current.handleError({
      requestId: "chat-1",
      code: "CHAT_RATE_LIMITED",
      details: { retryAfterMs: 1000 }
    }, "Slow down.")).toBe(true);

    act(() => result.current.handleServerMessage({
      type: "SOCIAL_STATE_CHANGED",
      playerId: "player-2",
      message: "Social state changed."
    }));
    expect(onSocialStateChanged).toHaveBeenCalledExactlyOnceWith();

    act(() => result.current.onDisconnected());
    expect(result.current.store.getDiagnostics().pendingCount).toBe(0);
  });
});
