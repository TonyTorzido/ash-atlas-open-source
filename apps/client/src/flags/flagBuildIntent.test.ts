import { afterEach, describe, expect, it, vi } from "vitest";

import { FlagBuildIntent } from "./flagBuildIntent.js";
import {
  FlagPlacementQuoteError,
  type ReadyFlagPlacementQuote
} from "./flagPlacementPreview.js";

const QUOTE: ReadyFlagPlacementQuote = {
  anchorKind: "flag",
  quoteId: "quote-1",
  traceId: "trace-1",
  quoteRequestId: "quote-request-1",
  createdAt: 1_000,
  expiresAt: 61_000,
  position: { lat: 29.9511, lon: -90.0715 }
};

describe("FlagBuildIntent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits a ready quote exactly once", async () => {
    const ensure = vi.fn(async () => QUOTE);
    const submit = vi.fn(() => "request-1");
    const intent = createIntent(ensure, submit);

    await expect(intent.start()).resolves.toBe("request-1");

    expect(ensure).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith("quote-1", "flag");
  });

  it("does not submit before quote preparation resolves", async () => {
    let resolve!: (quote: ReadyFlagPlacementQuote) => void;
    const ensure = vi.fn(() => new Promise<ReadyFlagPlacementQuote>((done) => {
      resolve = done;
    }));
    const submit = vi.fn(() => "request-1");
    const intent = createIntent(ensure, submit);

    const pending = intent.start();
    expect(submit).not.toHaveBeenCalled();
    resolve(QUOTE);
    await pending;

    expect(submit).toHaveBeenCalledOnce();
  });

  it("attaches duplicate clicks to one active intent", async () => {
    let resolve!: (quote: ReadyFlagPlacementQuote) => void;
    const ensure = vi.fn(() => new Promise<ReadyFlagPlacementQuote>((done) => {
      resolve = done;
    }));
    const submit = vi.fn(() => "request-1");
    const intent = createIntent(ensure, submit);

    const first = intent.start();
    await expect(intent.start()).resolves.toBeNull();
    resolve(QUOTE);
    await first;

    expect(ensure).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("submits nothing when quote preparation fails", async () => {
    const error = new Error("World lookup unavailable");
    const ensure = vi.fn(async () => { throw error; });
    const submit = vi.fn(() => "request-1");
    const onError = vi.fn();
    const intent = createIntent(ensure, submit, onError);

    await expect(intent.start()).resolves.toBeNull();

    expect(submit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("retries a retryable quote failure within the click-owned intent", async () => {
    const retry = new FlagPlacementQuoteError(
      "unavailable",
      "World is busy.",
      true,
      "COMPACT_WORLD_OVERLOADED",
      75
    );
    const ensure = vi.fn()
      .mockRejectedValueOnce(retry)
      .mockResolvedValueOnce(QUOTE);
    const submit = vi.fn(() => "request-1");
    const delay = vi.fn(async () => undefined);
    const intent = new FlagBuildIntent(
      ensure,
      submit,
      vi.fn(),
      vi.fn(),
      delay
    );

    await expect(intent.start()).resolves.toBe("request-1");

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(75);
    expect(submit).toHaveBeenCalledExactlyOnceWith("quote-1", "flag");
  });

  it("keeps a server PLAYER_MOVING response pending until authoritative movement settles", async () => {
    const moving = new FlagPlacementQuoteError(
      "movement",
      "Finish moving before preparing this flag location.",
      true,
      "PLAYER_MOVING"
    );
    const ensure = vi.fn()
      .mockRejectedValueOnce(moving)
      .mockResolvedValueOnce(QUOTE);
    const submit = vi.fn(() => "request-1");
    const onError = vi.fn();
    const intent = createIntent(ensure, submit, onError);
    intent.updatePlayerState({
      moving: false,
      movementRevision: 7,
      relocationRevision: 3
    });

    const pending = intent.start();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    intent.updatePlayerState({
      moving: true,
      movementRevision: 8,
      relocationRevision: 3
    });
    intent.updatePlayerState({
      moving: false,
      movementRevision: 9,
      relocationRevision: 3
    });

    await expect(pending).resolves.toBe("request-1");
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledExactlyOnceWith("quote-1", "flag");
    expect(onError).not.toHaveBeenCalled();
  });

  it("waits for newer authority instead of exhausting retries on REVISION_STALE", async () => {
    const stale = new FlagPlacementQuoteError(
      "unavailable",
      "Your position changed. Preparing the latest location.",
      true,
      "REVISION_STALE",
      150
    );
    const ensure = vi.fn()
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce(QUOTE);
    const submit = vi.fn(() => "request-1");
    const onError = vi.fn();
    const delay = vi.fn(async () => undefined);
    const intent = new FlagBuildIntent(ensure, submit, vi.fn(), onError, delay);
    intent.updatePlayerState({
      moving: false,
      movementRevision: 7,
      relocationRevision: 3
    });

    const pending = intent.start();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(ensure).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    intent.updatePlayerState({
      moving: true,
      movementRevision: 8,
      relocationRevision: 3
    });
    intent.updatePlayerState({
      moving: false,
      movementRevision: 9,
      relocationRevision: 3
    });

    await expect(pending).resolves.toBe("request-1");
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledExactlyOnceWith("quote-1", "flag");
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps one click pending beyond the old retry window and submits at settlement", async () => {
    vi.useFakeTimers();
    const ensure = vi.fn(async () => QUOTE);
    const submit = vi.fn(() => "request-1");
    const intent = createIntent(ensure, submit);
    intent.updatePlayerState({
      moving: true,
      movementRevision: 12,
      relocationRevision: 4
    });

    const pending = intent.start();
    await vi.advanceTimersByTimeAsync(451);

    expect(intent.pending()).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    intent.updatePlayerState({
      moving: false,
      movementRevision: 13,
      relocationRevision: 4
    });
    await expect(pending).resolves.toBe("request-1");

    expect(ensure).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith("quote-1", "flag");
  });

  it("uses the latest settled movement binding without duplicate quote or Build requests", async () => {
    let authoritative = {
      moving: true,
      movementRevision: 20,
      relocationRevision: 6
    };
    const observedBindings: Array<typeof authoritative> = [];
    const ensure = vi.fn(async () => {
      observedBindings.push({ ...authoritative });
      return QUOTE;
    });
    const submit = vi.fn(() => "request-1");
    const intent = createIntent(ensure, submit);
    intent.updatePlayerState(authoritative);

    const first = intent.start();
    await expect(intent.start()).resolves.toBeNull();
    authoritative = {
      moving: true,
      movementRevision: 21,
      relocationRevision: 6
    };
    intent.updatePlayerState(authoritative);
    authoritative = {
      moving: true,
      movementRevision: 22,
      relocationRevision: 6
    };
    intent.updatePlayerState(authoritative);
    authoritative = {
      moving: false,
      movementRevision: 23,
      relocationRevision: 6
    };
    intent.updatePlayerState(authoritative);

    await expect(first).resolves.toBe("request-1");
    expect(observedBindings).toEqual([{
      moving: false,
      movementRevision: 23,
      relocationRevision: 6
    }]);
    expect(ensure).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith("quote-1", "flag");
  });

  it("times out continued movement once with a precise PLAYER_MOVING error", async () => {
    vi.useFakeTimers();
    const ensure = vi.fn(async () => QUOTE);
    const submit = vi.fn(() => "request-1");
    const onState = vi.fn();
    const onError = vi.fn();
    const intent = new FlagBuildIntent(
      ensure,
      submit,
      onState,
      onError,
      async () => undefined,
      8_000
    );
    intent.updatePlayerState({
      moving: true,
      movementRevision: 30,
      relocationRevision: 7
    });

    const pending = intent.start();
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toBeNull();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "PLAYER_MOVING",
      message: "Stop moving to place a flag."
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(intent.pending()).toBe(false);
    expect(onState).toHaveBeenLastCalledWith("idle");

    intent.updatePlayerState({
      moving: false,
      movementRevision: 31,
      relocationRevision: 7
    });
    await vi.runAllTimersAsync();
    expect(submit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("cancels a moving intent with the precise disconnect error", async () => {
    const ensure = vi.fn(async () => QUOTE);
    const submit = vi.fn(() => "request-1");
    const onError = vi.fn();
    const intent = createIntent(ensure, submit, onError);
    intent.updatePlayerState({
      moving: true,
      movementRevision: 40,
      relocationRevision: 8
    });

    const pending = intent.start();
    intent.cancel("disconnect");

    await expect(pending).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "CLIENT_DISCONNECTED"
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("invalidates a moving intent when its relocation binding changes", async () => {
    const ensure = vi.fn(async () => QUOTE);
    const submit = vi.fn(() => "request-1");
    const onError = vi.fn();
    const intent = createIntent(ensure, submit, onError);
    intent.updatePlayerState({
      moving: true,
      movementRevision: 50,
      relocationRevision: 9
    });

    const pending = intent.start();
    intent.updatePlayerState({
      moving: false,
      movementRevision: 51,
      relocationRevision: 10
    });

    await expect(pending).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "REVISION_STALE"
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not retry or movement-wait for a non-retryable territory rejection", async () => {
    const denied = new FlagPlacementQuoteError(
      "unavailable",
      "This territory is claimed.",
      false,
      "FLAG_PLACEMENT_REJECTED"
    );
    const ensure = vi.fn(async () => {
      throw denied;
    });
    const submit = vi.fn(() => "request-1");
    const onError = vi.fn();
    const delay = vi.fn(async () => undefined);
    const intent = new FlagBuildIntent(ensure, submit, vi.fn(), onError, delay);
    intent.updatePlayerState({
      moving: false,
      movementRevision: 60,
      relocationRevision: 11
    });

    await expect(intent.start()).resolves.toBeNull();

    expect(ensure).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(denied);
  });

  it("returns to idle without submitting after bounded retry exhaustion", async () => {
    const retry = new FlagPlacementQuoteError(
      "unavailable",
      "World is still busy.",
      true,
      "COMPACT_WORLD_OVERLOADED",
      25
    );
    const ensure = vi.fn(async () => {
      throw retry;
    });
    const submit = vi.fn(() => "request-1");
    const onState = vi.fn();
    const onError = vi.fn();
    const delay = vi.fn(async () => undefined);
    const intent = new FlagBuildIntent(ensure, submit, onState, onError, delay);

    await expect(intent.start()).resolves.toBeNull();

    expect(ensure).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(retry);
    expect(intent.pending()).toBe(false);
    expect(onState).toHaveBeenLastCalledWith("idle");
  });

  it("returns to idle without submitting when cancelled between retry attempts", async () => {
    const retry = new FlagPlacementQuoteError(
      "unavailable",
      "World is busy.",
      true,
      "COMPACT_WORLD_OVERLOADED",
      25
    );
    const ensure = vi.fn()
      .mockRejectedValueOnce(retry)
      .mockResolvedValueOnce(QUOTE);
    let releaseDelay!: () => void;
    const delay = vi.fn(() => new Promise<void>((resolve) => {
      releaseDelay = resolve;
    }));
    const submit = vi.fn(() => "request-1");
    const onState = vi.fn();
    const onError = vi.fn();
    const intent = new FlagBuildIntent(ensure, submit, onState, onError, delay);
    const pending = intent.start();
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());

    intent.cancel();
    releaseDelay();
    await expect(pending).resolves.toBeNull();

    expect(ensure).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(intent.pending()).toBe(false);
    expect(onState).toHaveBeenLastCalledWith("idle");
  });

  it.each([
    ["movement", (intent: FlagBuildIntent) => intent.cancel()],
    ["disconnect", (intent: FlagBuildIntent) => intent.cancel()],
    ["component destruction", (intent: FlagBuildIntent) => intent.destroy()]
  ])(
    "cancels a pending intent on %s",
    async (_reason, cancel) => {
      let resolve!: (quote: ReadyFlagPlacementQuote) => void;
      const ensure = vi.fn(() => new Promise<ReadyFlagPlacementQuote>((done) => {
        resolve = done;
      }));
      const submit = vi.fn(() => "request-1");
      const intent = createIntent(ensure, submit);
      const pending = intent.start();

      cancel(intent);
      resolve(QUOTE);
      await pending;

      expect(submit).not.toHaveBeenCalled();
      expect(intent.pending()).toBe(false);
    }
  );
});

function createIntent(
  ensure: () => Promise<ReadyFlagPlacementQuote>,
  submit: (quoteId: string) => string | null,
  onError = vi.fn()
): FlagBuildIntent {
  return new FlagBuildIntent(ensure, submit, vi.fn(), onError);
}
