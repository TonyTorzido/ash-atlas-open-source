import { describe, expect, it, vi } from "vitest";

import { RemoteStudioConnection } from "./remoteConnection.js";

describe("local remote-server connection", () => {
  it("uses exact loopback callback, state, PKCE, memory-only bearer exchange, and revoke", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "token-value",
        expiresAt: Date.now() + 60_000
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        serverSha: "f".repeat(40),
        catalogRevision: 4
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: true }), {
        status: 200
      }));
    const connection = new RemoteStudioConnection();
    const authorize = new URL(connection.begin(
      "https://game.example",
      "http://127.0.0.1:5285"
    ));
    expect(authorize.pathname).toBe("/api/developer/appearance-studio/authorize");
    expect(authorize.searchParams.get("redirect_uri"))
      .toBe("http://127.0.0.1:5285/auth/callback");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/u);
    const state = authorize.searchParams.get("state")!;

    await connection.exchange(
      "authorization-code",
      state,
      "http://127.0.0.1:5285"
    );
    expect(await connection.status()).toMatchObject({
      connected: true,
      serverSha: "f".repeat(40),
      catalogRevision: 4
    });
    const tokenRequest = fetchMock.mock.calls[0]!;
    expect(String(tokenRequest[0])).not.toContain("token-value");
    expect(JSON.stringify(tokenRequest)).not.toContain(state);
    const infoHeaders = fetchMock.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(infoHeaders.authorization).toBe("Bearer token-value");

    await connection.disconnect();
    expect(await connection.status()).toEqual({ connected: false });
    fetchMock.mockRestore();
  });

  it("rejects state substitution and unsafe remote origins", async () => {
    const connection = new RemoteStudioConnection();
    const authorize = new URL(connection.begin(
      "http://127.0.0.1:3001",
      "http://127.0.0.1:5285"
    ));
    await expect(connection.exchange(
      "code",
      `${authorize.searchParams.get("state")}wrong`,
      "http://127.0.0.1:5285"
    )).rejects.toThrow(/state/u);
    expect(() => connection.begin(
      "http://game.example",
      "http://127.0.0.1:5285"
    )).toThrow(/HTTPS/u);
    expect(() => connection.begin(
      "https://user:secret@game.example",
      "http://127.0.0.1:5285"
    )).toThrow(/credentials/u);
  });

  it("clears an expired remote authorization instead of reporting it connected", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "expired-token",
        expiresAt: Date.now() + 60_000
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401
      }));
    const connection = new RemoteStudioConnection();
    const authorize = new URL(connection.begin(
      "https://game.example",
      "http://127.0.0.1:5285"
    ));
    await connection.exchange(
      "authorization-code",
      authorize.searchParams.get("state")!,
      "http://127.0.0.1:5285"
    );

    expect(await connection.status()).toMatchObject({
      connected: false,
      error: "Remote authorization expired or was revoked"
    });
    expect(await connection.status()).toEqual({ connected: false });
  });
});
