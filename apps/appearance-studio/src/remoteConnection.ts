import { createHash, randomBytes } from "node:crypto";

import type { RemoteStudioInfo } from "./bridgeTypes.js";

type PendingAuthorization = {
  serverBase: string;
  state: string;
  verifier: string;
  expiresAt: number;
};

type RemoteSession = {
  serverBase: string;
  token: string;
  expiresAt: number;
};

export class RemoteStudioConnection {
  private pending: PendingAuthorization | null = null;
  private session: RemoteSession | null = null;

  begin(serverBaseInput: string, callbackOrigin: string): string {
    const serverBase = normalizeServerBase(serverBaseInput);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.pending = {
      serverBase,
      state,
      verifier,
      expiresAt: Date.now() + 5 * 60_000
    };
    const url = new URL("/api/developer/appearance-studio/authorize", serverBase);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("redirect_uri", `${callbackOrigin}/auth/callback`);
    return url.toString();
  }

  async exchange(code: string, state: string, callbackOrigin: string): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      !timingSafeText(pending.state, state)
    ) {
      throw new Error("Remote authorization state is invalid or expired");
    }
    const response = await fetch(
      new URL("/api/developer/appearance-studio/token", pending.serverBase),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          codeVerifier: pending.verifier,
          redirectUri: `${callbackOrigin}/auth/callback`
        })
      }
    );
    if (!response.ok) throw new Error(`Remote token exchange failed (${response.status})`);
    const payload = await response.json() as {
      token?: string;
      expiresAt?: number;
    };
    if (!payload.token || !Number.isFinite(payload.expiresAt)) {
      throw new Error("Remote server returned an invalid studio token");
    }
    this.session = {
      serverBase: pending.serverBase,
      token: payload.token,
      expiresAt: payload.expiresAt!
    };
  }

  async status(): Promise<RemoteStudioInfo> {
    const session = this.session;
    if (!session || session.expiresAt <= Date.now()) {
      this.session = null;
      return { connected: false };
    }
    try {
      const response = await fetch(
        new URL("/api/developer/appearance-studio/info", session.serverBase),
        { headers: { authorization: `Bearer ${session.token}` } }
      );
      if (response.status === 401 || response.status === 403) {
        this.session = null;
        return {
          connected: false,
          serverBase: session.serverBase,
          error: "Remote authorization expired or was revoked"
        };
      }
      if (!response.ok) throw new Error(`Remote info failed (${response.status})`);
      return {
        connected: true,
        serverBase: session.serverBase,
        ...await response.json() as Omit<RemoteStudioInfo, "connected" | "serverBase">
      };
    } catch (error) {
      return {
        connected: true,
        serverBase: session.serverBase,
        error: error instanceof Error ? error.message : "Remote info failed"
      };
    }
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    this.pending = null;
    this.session = null;
    if (!session) return;
    try {
      await fetch(
        new URL("/api/developer/appearance-studio/revoke", session.serverBase),
        {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}` }
        }
      );
    } catch {
      // Local token erasure is authoritative for the studio process.
    }
  }
}

function normalizeServerBase(input: string): string {
  const url = new URL(input);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote servers require HTTPS; HTTP is allowed only for loopback");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Server URL must not contain credentials, query parameters, or fragments");
  }
  url.pathname = "/";
  return url.toString().replace(/\/$/u, "");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function timingSafeText(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return leftHash.equals(rightHash);
}
