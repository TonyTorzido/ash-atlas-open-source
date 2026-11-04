import { describe, expect, it, vi } from "vitest";

import { startFlagVisitOperation } from "./flagVisitIntent.js";

describe("flag visit operation identity", () => {
  it("creates a fresh operation ID for every distinct accepted jump", () => {
    const sent: string[] = [];
    const send = (requestId: string): string => {
      sent.push(requestId);
      return requestId;
    };
    const options = {
      connected: true,
      pendingRequestId: null,
      send,
      beforeSend: vi.fn(),
      showError: vi.fn()
    };

    startFlagVisitOperation(options);
    startFlagVisitOperation(options);

    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
  });

  it("preserves a legitimate caller-supplied operation ID", () => {
    const send = vi.fn((requestId: string) => requestId);
    expect(startFlagVisitOperation({
      connected: true,
      pendingRequestId: null,
      preferredRequestId: "prepared-world-map-request",
      send,
      beforeSend: vi.fn(),
      showError: vi.fn()
    })).toBe("prepared-world-map-request");
    expect(send).toHaveBeenCalledWith("prepared-world-map-request");
  });

  it("reports failed sends and blocks overlapping operations", () => {
    const showError = vi.fn();
    const send = vi.fn(() => null);
    expect(startFlagVisitOperation({
      connected: true,
      pendingRequestId: null,
      send,
      beforeSend: vi.fn(),
      showError
    })).toBeNull();
    expect(showError).toHaveBeenCalledWith(
      "Cannot travel while disconnected or reconnecting."
    );

    send.mockClear();
    expect(startFlagVisitOperation({
      connected: true,
      pendingRequestId: "pending-request",
      send,
      beforeSend: vi.fn(),
      showError
    })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(showError).toHaveBeenLastCalledWith("Travel is already in progress.");
  });
});
