import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchFlagEnvironment,
  FlagEnvironmentRequestError
} from "./flagEnvironment.js";

const normalizeFlagEnvironmentDetails = vi.hoisted(() => vi.fn());

vi.mock("@ash-atlas/shared", () => ({
  normalizeFlagEnvironmentDetails
}));

describe("fetchFlagEnvironment", () => {
  beforeEach(() => {
    normalizeFlagEnvironmentDetails.mockImplementation((value) => value);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("includes the session cookie policy and optional abort signal", async () => {
    const payload = { identity: { flagId: "flag/id" } };
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse(payload));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      fetchFlagEnvironment("https://game.example", "flag/id", {
        signal: controller.signal
      })
    ).resolves.toEqual(payload);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://game.example/api/flags/flag%2Fid/environment");
    expect(init).toEqual({
      credentials: "include",
      signal: controller.signal
    });
    expect(normalizeFlagEnvironmentDetails).toHaveBeenCalledWith(payload);
  });

  it("uses valid credentialed fetch options when no signal is supplied", async () => {
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetcher);

    await fetchFlagEnvironment("https://game.example", "flag-id");

    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toEqual({ credentials: "include" });
    expect(init).not.toHaveProperty("signal");
  });

  it.each([
    [404, "This flag no longer exists."],
    [500, "The server could not load advanced flag details. Try again shortly."]
  ])("preserves HTTP %i error behavior", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, status)));

    await expect(fetchFlagEnvironment("https://game.example", "flag-id")).rejects.toEqual(
      new FlagEnvironmentRequestError(message, status)
    );
  });

  it("preserves invalid-response handling", async () => {
    normalizeFlagEnvironmentDetails.mockImplementation(() => {
      throw new Error("invalid");
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ malformed: true })));

    await expect(fetchFlagEnvironment("https://game.example", "flag-id")).rejects.toEqual(
      new FlagEnvironmentRequestError("Advanced flag details returned an invalid response.")
    );
  });

  it("wraps transport failures unless the request was aborted", async () => {
    const transportError = new Error("offline");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(transportError)));
    await expect(fetchFlagEnvironment("https://game.example", "flag-id")).rejects.toEqual(
      new FlagEnvironmentRequestError("Advanced flag details are unavailable.")
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchFlagEnvironment("https://game.example", "flag-id", { signal: controller.signal })
    ).rejects.toBe(transportError);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}
