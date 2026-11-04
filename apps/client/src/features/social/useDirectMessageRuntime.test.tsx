// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SocialClient } from "../../client/domains/socialClient.js";
import type { DirectMessageStore } from "../../directMessages/directMessageStore.js";
import { useDirectMessageRuntime } from "./useDirectMessageRuntime.js";

afterEach(cleanup);

describe("useDirectMessageRuntime", () => {
  it("owns bootstrap, sync recovery, read deduplication, and disconnect cleanup", () => {
    const snapshot = {
      gap: { acknowledgedEventCursor: "7", needsSync: false, syncing: false }
    };
    const store = {
      getSnapshot: vi.fn(() => snapshot),
      setGapSyncing: vi.fn(),
      failPendingSends: vi.fn(),
      failMessage: vi.fn(),
      failPendingSendsForRecipient: vi.fn()
    } as unknown as DirectMessageStore;
    const commands = {
      bootstrapDirectMessages: vi.fn(() => "bootstrap-1"),
      syncDirectMessages: vi.fn(() => "sync-1"),
      updateDirectMessageRead: vi.fn(() => true)
    } as unknown as SocialClient;
    const setWarning = vi.fn();
    const { result } = renderHook(() => useDirectMessageRuntime({
      store,
      ownPlayerId: "player-1",
      getCommands: () => commands,
      setWarning,
      onMessageReceived: vi.fn()
    }));

    act(() => result.current.onWelcome());
    expect(commands.bootstrapDirectMessages).toHaveBeenCalledOnce();

    act(() => result.current.handleServerMessage({
      type: "DM_ERROR",
      code: "sync_required",
      message: "Message history must be synchronized.",
      retryable: true
    }));
    expect(setWarning).toHaveBeenCalledWith("Message history must be synchronized.");
    expect(store.setGapSyncing).toHaveBeenLastCalledWith(true);
    expect(commands.syncDirectMessages).toHaveBeenCalledWith("7");

    act(() => {
      expect(result.current.updateRead("conversation-1", "8")).toBe(true);
      expect(result.current.updateRead("conversation-1", "8")).toBe(false);
      result.current.onDisconnected();
    });
    expect(commands.updateDirectMessageRead).toHaveBeenCalledOnce();
    expect(store.failPendingSends).toHaveBeenCalledOnce();
  });

  it("waits for authoritative acknowledgements for every Read All Personal cursor", async () => {
    const snapshot = {
      conversations: [],
      selectedPeerId: null,
      selectedConversation: null,
      preferences: { suppressBannersDuringCombat: false },
      gap: {
        acknowledgedEventCursor: "0",
        highestSeenEventCursor: "0",
        needsSync: false,
        syncing: false
      }
    };
    const store = {
      getSnapshot: vi.fn(() => snapshot),
      applyServerMessage: vi.fn(),
      failPendingSends: vi.fn()
    } as unknown as DirectMessageStore;
    const commands = {
      updateDirectMessageRead: vi.fn((conversationId: string) => `read:${conversationId}`)
    } as unknown as SocialClient;
    const { result } = renderHook(() => useDirectMessageRuntime({
      store,
      ownPlayerId: "player-1",
      getCommands: () => commands,
      setWarning: vi.fn(),
      onMessageReceived: vi.fn()
    }));

    const pending = result.current.updateReads([
      { conversationId: "conversation-a", throughSequence: "4" },
      { conversationId: "conversation-b", throughSequence: "9" }
    ]);
    expect(commands.updateDirectMessageRead).toHaveBeenCalledTimes(2);
    act(() => {
      result.current.handleServerMessage({
        type: "DM_READ_RESULT",
        requestId: "read:conversation-a",
        result: "ok",
        conversationId: "conversation-a",
        readThroughSequence: "4"
      });
      result.current.handleServerMessage({
        type: "DM_READ_RESULT",
        requestId: "read:conversation-b",
        result: "ok",
        conversationId: "conversation-b",
        readThroughSequence: "9"
      });
    });
    await expect(pending).resolves.toBe(true);
  });
});
