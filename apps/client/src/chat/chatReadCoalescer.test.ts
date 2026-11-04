import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_READ_COALESCE_MS, ChatReadUpdateCoalescer } from "./chatReadCoalescer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatReadUpdateCoalescer", () => {
  it("keeps one bounded pending cursor and flushes the maximum sequence", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const coalescer = new ChatReadUpdateCoalescer(send);

    coalescer.enqueue("public:general", 4);
    coalescer.enqueue("public:general", 7);
    coalescer.enqueue("public:general", 6);
    expect(coalescer.size).toBe(1);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CHAT_READ_COALESCE_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("public:general", 7);
    expect(coalescer.size).toBe(0);
  });

  it("flushes the old channel before accepting a new channel", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const coalescer = new ChatReadUpdateCoalescer(send);

    coalescer.enqueue("public:general", 5);
    coalescer.enqueue("public:trading", 2);
    expect(send).toHaveBeenCalledWith("public:general", 5);
    expect(coalescer.size).toBe(1);

    coalescer.flush();
    expect(send).toHaveBeenLastCalledWith("public:trading", 2);
    expect(coalescer.size).toBe(0);
  });
});
