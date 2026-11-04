import type {
  TestAccessAdminListResponse,
  TestAccessMode,
  TestAccessModeResponse,
  TestAccessStatus
} from "@ash-atlas/shared";

export type TestAccessFilter = TestAccessStatus | "unclaimed" | "dev";

export class TestAccessAdminClient {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  getAccessMode(): Promise<TestAccessModeResponse> {
    return this.request<TestAccessModeResponse>("/api/admin/test-access/mode", {
      method: "GET"
    });
  }

  setAccessMode(mode: TestAccessMode): Promise<TestAccessModeResponse> {
    return this.mutate<TestAccessModeResponse>("/api/admin/test-access/mode", { mode });
  }

  list(input: {
    status: TestAccessFilter;
    search: string;
    page: number;
    pageSize?: number;
  }): Promise<TestAccessAdminListResponse> {
    const url = new URL("/api/admin/test-access", this.serverHttpBase);
    url.searchParams.set("status", input.status);
    url.searchParams.set("search", input.search);
    url.searchParams.set("page", String(input.page));
    url.searchParams.set("pageSize", String(input.pageSize ?? 25));
    return this.request<TestAccessAdminListResponse>(url.pathname + url.search, {
      method: "GET"
    });
  }

  preapprove(email: string): Promise<Record<string, unknown>> {
    return this.mutate("/api/admin/test-access/preapprove", { email });
  }

  decide(
    accountId: string,
    action: "approve" | "deny" | "revoke" | "restore"
  ): Promise<Record<string, unknown>> {
    return this.mutate(
      `/api/admin/test-access/accounts/${encodeURIComponent(accountId)}/${action}`,
      {}
    );
  }

  grantDevAccess(email: string): Promise<Record<string, unknown>> {
    return this.mutate("/api/admin/test-access/dev/grant", { email });
  }

  decideDevAccess(
    accountId: string,
    action: "approve" | "deny" | "revoke"
  ): Promise<Record<string, unknown>> {
    return this.mutate(
      `/api/admin/test-access/dev/accounts/${encodeURIComponent(accountId)}/${action}`,
      {}
    );
  }

  revokeGrant(grantId: string): Promise<Record<string, unknown>> {
    return this.mutate(
      `/api/admin/test-access/grants/${encodeURIComponent(grantId)}/revoke`,
      {}
    );
  }

  private mutate<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.csrfToken
      },
      body: JSON.stringify(body)
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.serverHttpBase), {
      ...init,
      credentials: "include"
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(errorMessage(payload) ?? "Test-access request failed");
    }
    return payload as T;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = value.error;
  if (!error || typeof error !== "object" || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}
