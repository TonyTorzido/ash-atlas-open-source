// @vitest-environment jsdom

import type { FlagAccessSnapshot } from "@ash-atlas/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFlagAccessMenu } from "./useFlagAccessMenu.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("flag access menu resolution", () => {
  it("renders no unfinished menu and opens directly with resolved actions", async () => {
    const request = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => request.promise));

    render(<Harness flagId="flag-1" onFailure={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/checking access/i)).toBeNull();

    request.resolve(response(snapshot("flag-1", true)));

    expect(await screen.findByRole("button", { name: "Jump" })).toBeTruthy();
    expect(screen.queryByText(/checking access/i)).toBeNull();
  });

  it("cannot open a stale menu after a newer flag is selected", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness flagId="flag-1" onFailure={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(<Harness flagId="flag-2" onFailure={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    first.resolve(response(snapshot("flag-1", true)));
    await Promise.resolve();
    expect(screen.queryByRole("dialog")).toBeNull();

    second.resolve(response(snapshot("flag-2", false)));
    expect(await screen.findByRole("button", { name: "Private Flag" })).toBeTruthy();
    expect(screen.queryByText("flag-1")).toBeNull();
  });

  it("reports failed access without leaving a disabled or stuck menu", async () => {
    const onFailure = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Access endpoint failed");
    }));

    render(<Harness flagId="flag-1" onFailure={onFailure} />);

    await waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith("flag-1", "Access endpoint failed")
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/checking access/i)).toBeNull();
  });

  it("fails a flag access request that never resolves instead of loading forever", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness flagId="flag-1" onFailure={onFailure} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(onFailure).toHaveBeenCalledWith(
      "flag-1",
      expect.stringMatching(/timed out/i)
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reopens a previously resolved flag from the authoritative cache", async () => {
    const fetchMock = vi.fn(async () => response(snapshot("flag-1", true)));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness flagId="flag-1" onFailure={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Jump" })).toBeTruthy();
    view.rerender(<Harness flagId={null} onFailure={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<Harness flagId="flag-1" onFailure={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function Harness(props: Readonly<{
  flagId: string | null;
  onFailure(flagId: string, message: string): void;
}>): React.JSX.Element | null {
  const resolved = useFlagAccessMenu({
    flagId: props.flagId,
    accessRevision: 1,
    serverHttpBase: "https://game.example",
    onFailure: props.onFailure
  });
  if (!props.flagId || !resolved.access) return null;
  return <div role="dialog">
    <span>{props.flagId}</span>
    <button type="button">
      {resolved.access.decision.allowed ? "Jump" : "Private Flag"}
    </button>
  </div>;
}

function snapshot(flagId: string, allowed: boolean): FlagAccessSnapshot {
  return {
    flagId,
    ownerPlayerId: "owner",
    mode: allowed ? "public" : "private",
    jumpTollGold: "0",
    accessRevision: "1",
    requestPending: false,
    decision: {
      allowed,
      requestable: false,
      reasonCode: allowed ? "ALLOWED_PUBLIC" : "PRIVATE_OWNER_ONLY",
      tollGold: "0"
    },
    management: null
  };
}

function response(access: FlagAccessSnapshot): Response {
  return new Response(JSON.stringify({ access }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
