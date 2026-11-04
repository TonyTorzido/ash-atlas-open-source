import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthApiClient } from "./authClient.js";

describe("AuthApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a Google credential once in a credentialed POST body", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      response({
        authenticated: false,
        csrfToken: "",
        developmentAuthEnabled: false
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new AuthApiClient("https://game.example").loginWithGoogle("temporary-id-token");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://game.example/api/auth/google");
    expect(String(url)).not.toContain("temporary-id-token");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(init?.body))).toEqual({ credential: "temporary-id-token" });
  });

  it("sends CSRF protection for onboarding and logout", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({
        player: { id: "player-1", displayName: "Scout", personalFlagColor: "purple" }
      }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new AuthApiClient("https://game.example");

    await api.completeOnboarding("Scout", "purple", "csrf-token");
    await api.logout("csrf-token");

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-csrf-token": "csrf-token"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      displayName: "Scout",
      personalFlagColor: "purple"
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-csrf-token": "csrf-token"
    });
  });

  it("sends only an allowlisted development profile key", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      response({ authenticated: false, csrfToken: "", developmentAuthEnabled: true })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new AuthApiClient("http://127.0.0.1:3001").loginAsDeveloper("player3");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:3001/api/auth/dev");
    expect(JSON.parse(String(init?.body))).toEqual({ profile: "player3" });
  });

  it("posts email sign-in start and verify without CSRF and returns the session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true, resendAvailableAt: 1_700_000_060_000, codeTtlSeconds: 600 }))
      .mockResolvedValueOnce(response({ authenticated: false, csrfToken: "", developmentAuthEnabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new AuthApiClient("https://game.example");

    await expect(api.startEmailLogin("a@example.com")).resolves.toMatchObject({
      resendAvailableAt: 1_700_000_060_000,
      codeTtlSeconds: 600
    });
    await api.verifyEmailLogin("a@example.com", "123456");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://game.example/api/auth/email/start");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://game.example/api/auth/email/verify");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ email: "a@example.com" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      email: "a@example.com",
      code: "123456"
    });
  });

  it("sends CSRF protection for email and Google linking", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true, resendAvailableAt: 1, codeTtlSeconds: 600 }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new AuthApiClient("https://game.example");

    await api.startEmailLink("a@example.com", "csrf-token");
    await api.verifyEmailLink("a@example.com", "123456", "csrf-token");
    await api.linkGoogle("google-credential", "csrf-token");

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://game.example/api/auth/email/link/start",
      "https://game.example/api/auth/email/link/verify",
      "https://game.example/api/auth/google/link"
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ "x-csrf-token": "csrf-token" });
    }
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      credential: "google-credential"
    });
  });

  it("surfaces email error codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: { code: "EMAIL_CODE_INVALID", message: "bad" } }, 400))
    );
    await expect(
      new AuthApiClient("https://game.example").verifyEmailLogin("a@example.com", "000000")
    ).rejects.toEqual(expect.objectContaining({ code: "EMAIL_CODE_INVALID", status: 400 }));
  });

  it("converts server failures to sanitized authentication errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          { error: { code: "VERIFIED_GMAIL_REQUIRED", message: "Verified Gmail required" } },
          403
        )
      )
    );

    await expect(
      new AuthApiClient("https://game.example").loginAsDeveloper("default")
    ).rejects.toEqual(
      expect.objectContaining({
        code: "VERIFIED_GMAIL_REQUIRED",
        message: "Verified Gmail required",
        status: 403
      })
    );
  });
});

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}
