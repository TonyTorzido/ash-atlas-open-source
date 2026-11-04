import { describe, expect, it, vi } from "vitest";

import { ChatHistoryRequestTracker } from "./chatHistoryRequestTracker.js";

function request(
  requestId = "req-1",
  channelKey = "public:general",
  beforeSequence = 50
) {
  return { requestId, channelKey, beforeSequence };
}

describe("ChatHistoryRequestTracker", () => {
  it("returns a stable snapshot and does not publish for no-op completions", () => {
    const tracker = new ChatHistoryRequestTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    const first = tracker.getSnapshot();
    expect(tracker.getSnapshot()).toBe(first);
    expect(tracker.completeResult({ requestId: "missing", channelKey: "public:general" })).toBe(false);
    expect(tracker.completeError({ requestId: "missing" })).toBe(false);
    tracker.cancel();
    expect(tracker.getSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();

    tracker.start(request("A"));
    const active = tracker.getSnapshot();
    expect(active).not.toBe(first);
    expect(tracker.getSnapshot()).toBe(active);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("H1: matching result clears the active request", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    expect(tracker.getSnapshot().active?.requestId).toBe("A");
    tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H2: matching empty result clears loading", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H3: matching error clears loading", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    tracker.completeError({ requestId: "A" });
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H4: duplicate-only result still clears the active request", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H5: stale A cannot clear B", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    tracker.start(request("B"));
    tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    expect(tracker.getSnapshot().active?.requestId).toBe("B");
    tracker.completeResult({ requestId: "B", channelKey: "public:general" });
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H6: wrong channel cannot clear the active request", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A", "public:general"));
    tracker.completeResult({ requestId: "A", channelKey: "public:trading" });
    expect(tracker.getSnapshot().active?.requestId).toBe("A");
    tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H7: channel switch cancels an active history request for a different channel", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A", "public:general"));
    tracker.cancelForChannelChange("public:trading");
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H7b: channel switch to same channel preserves the active request", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A", "public:general"));
    tracker.cancelForChannelChange("public:general");
    expect(tracker.getSnapshot().active?.requestId).toBe("A");
  });

  it("H8: cancel clears the active request", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    tracker.cancel();
    expect(tracker.getSnapshot().active).toBeNull();
  });

  it("H9: starting tracks a new active request", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("H9", "public:trading", 42));
    const snapshot = tracker.getSnapshot();
    expect(snapshot.active?.requestId).toBe("H9");
    expect(snapshot.active?.channelKey).toBe("public:trading");
    expect(snapshot.active?.beforeSequence).toBe(42);
  });

  it("emits to subscribers on state changes", () => {
    const tracker = new ChatHistoryRequestTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.start(request("A"));
    expect(listener).toHaveBeenCalledTimes(1);
    tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops receiving updates", () => {
    const tracker = new ChatHistoryRequestTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);
    unsubscribe();
    tracker.start(request("A"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("completeError with wrong requestId does not clear", () => {
    const tracker = new ChatHistoryRequestTracker();
    tracker.start(request("A"));
    tracker.completeError({ requestId: "B" });
    expect(tracker.getSnapshot().active?.requestId).toBe("A");
  });
});
