import type {
  AuthPlayerView,
  AuthSessionResponse,
  PersonalFlagColor
} from "@ash-atlas/shared";
import type { NativeAuthorizationResult } from "../native/nativeApp.js";
import { confirmNativeSessionReconciled, nativeAuthRequest, NativeRequestError, NativeAuthRestartRequiredError } from "../native/nativeRequest.js";
import { recordNativeDiagnostic } from "../native/nativeDiagnostics.js";

export type AuthApiErrorCode =
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_UNAVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_GOOGLE_LOGIN"
  | "PLAYER_NAME_INVALID"
  | "PLAYER_NAME_TAKEN"
  | "PERSONAL_FLAG_COLOR_INVALID"
  | "TEST_ACCESS_PENDING"
  | "TEST_ACCESS_DENIED"
  | "TEST_ACCESS_REVOKED"
  | "TEST_ACCESS_DEV_ONLY"
  | "TOO_MANY_ACCOUNT_CREATION_ATTEMPTS"
  | "TOO_MANY_LOGIN_ATTEMPTS"
  | "VERIFIED_GMAIL_REQUIRED"
  | "EMAIL_INVALID"
  | "EMAIL_DOMAIN_NOT_ALLOWED"
  | "EMAIL_CODE_INVALID"
  | "TOO_MANY_EMAIL_CODE_REQUESTS"
  | "ACCOUNT_LINK_REQUIRED"
  | "ACCOUNT_LINK_CONFLICT"
  | "SERVER_UNAVAILABLE"
  | string;

export type EmailCodeIssued = {
  ok: true;
  /** Epoch milliseconds after which another code may be requested. */
  resendAvailableAt: number;
  codeTtlSeconds: number;
};

export type DevelopmentProfileKey = "default" | "player2" | "player3" | "player4";

export class AuthApiError extends Error {
  constructor(
    readonly code: AuthApiErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export class AuthApiClient {
  constructor(private readonly serverHttpBase: string) {}

  async getSession(): Promise<AuthSessionResponse> {
    const session = await this.request<AuthSessionResponse>("/api/auth/session", { method: "GET" });
    confirmNativeSessionReconciled();
    return session;
  }

  loginWithGoogle(credential: string): Promise<AuthSessionResponse> {
    return this.request<AuthSessionResponse>("/api/auth/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential })
    });
  }

  startEmailLogin(email: string): Promise<EmailCodeIssued> {
    return this.request<EmailCodeIssued>("/api/auth/email/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email })
    });
  }

  verifyEmailLogin(email: string, code: string): Promise<AuthSessionResponse> {
    return this.request<AuthSessionResponse>("/api/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code })
    });
  }

  startEmailLink(email: string, csrfToken: string): Promise<EmailCodeIssued> {
    return this.request<EmailCodeIssued>("/api/auth/email/link/start", {
      method: "POST",
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ email })
    });
  }

  verifyEmailLink(email: string, code: string, csrfToken: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/auth/email/link/verify", {
      method: "POST",
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ email, code })
    });
  }

  linkGoogle(credential: string, csrfToken: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/auth/google/link", {
      method: "POST",
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ credential })
    });
  }

  loginAsDeveloper(profile: DevelopmentProfileKey): Promise<AuthSessionResponse> {
    return this.request<AuthSessionResponse>("/api/auth/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile })
    });
  }

  loginNative(authorization: NativeAuthorizationResult): Promise<AuthSessionResponse> {
    return this.request<AuthSessionResponse>("/api/auth/native/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authorization)
    });
  }

  async completeOnboarding(
    displayName: string,
    personalFlagColor: PersonalFlagColor,
    csrfToken: string
  ): Promise<AuthPlayerView> {
    const response = await this.request<{ player: AuthPlayerView }>("/api/account/onboarding", {
      method: "POST",
      headers: mutationHeaders(csrfToken),
      body: JSON.stringify({ displayName, personalFlagColor })
    });
    return response.player;
  }

  logout(csrfToken: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/auth/logout", {
      method: "POST",
      headers: csrfHeaders(csrfToken)
    });
  }

  logoutAll(csrfToken: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/auth/logout-all", {
      method: "POST",
      headers: csrfHeaders(csrfToken)
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await nativeAuthRequest(new URL(path, this.serverHttpBase), {
        ...init,
        credentials: "include"
      });
    } catch (error) {
      recordNativeDiagnostic("auth_request_failed");
      if (error instanceof NativeRequestError || error instanceof NativeAuthRestartRequiredError) {
        throw new AuthApiError("SERVER_UNAVAILABLE",error.message,0);
      }
      throw new AuthApiError("SERVER_UNAVAILABLE", "Server unavailable", 0);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const error = getErrorPayload(payload);
      throw new AuthApiError(
        error?.code ?? "SERVER_UNAVAILABLE",
        error?.message ?? "Authentication service unavailable",
        response.status
      );
    }
    if (payload === null) {
      throw new AuthApiError(
        "SERVER_UNAVAILABLE",
        "Authentication service returned an invalid response",
        response.status
      );
    }
    return payload as T;
  }
}

export function mutationHeaders(csrfToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-csrf-token": csrfToken
  };
}

export function csrfHeaders(csrfToken: string): Record<string, string> {
  return { "x-csrf-token": csrfToken };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function getErrorPayload(payload: unknown): { code?: string; message?: string } | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null;
  }
  const error = payload.error;
  if (!error || typeof error !== "object") {
    return null;
  }
  return {
    ...(typeof (error as { code?: unknown }).code === "string"
      ? { code: (error as { code: string }).code }
      : {}),
    ...(typeof (error as { message?: unknown }).message === "string"
      ? { message: (error as { message: string }).message }
      : {})
  };
}
