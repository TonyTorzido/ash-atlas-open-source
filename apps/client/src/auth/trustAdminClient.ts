import type {
  TrustAdminAccountDetailResponse,
  TrustAdminAccountListResponse,
  TrustAdminAlertDecisionResponse,
  TrustAdminAlertListResponse,
  TrustAdminSettlementActionResponse,
  TrustAlertAction,
  TrustAlertKind,
  TrustAlertStatus,
  TrustLabDryRunResponse,
  TrustLabProfileInput,
  TrustQuarantineArrivalsResponse
} from "@ash-atlas/shared";

export class TrustAdminClient {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string = ""
  ) {}

  listAccounts(input: { limit: number; minLogodds: number }): Promise<TrustAdminAccountListResponse> {
    const url = new URL("/api/dev/trust/accounts", this.serverHttpBase);
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("minLogodds", String(input.minLogodds));
    return this.get<TrustAdminAccountListResponse>(url.pathname + url.search);
  }

  accountDetail(accountId: string): Promise<TrustAdminAccountDetailResponse> {
    return this.get<TrustAdminAccountDetailResponse>(
      `/api/dev/trust/accounts/${encodeURIComponent(accountId)}`
    );
  }

  listAlerts(input: {
    status: TrustAlertStatus | null;
    kind: TrustAlertKind | null;
    limit: number;
    offset: number;
  }): Promise<TrustAdminAlertListResponse> {
    const url = new URL("/api/dev/trust/alerts", this.serverHttpBase);
    if (input.status) url.searchParams.set("status", input.status);
    if (input.kind) url.searchParams.set("kind", input.kind);
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("offset", String(input.offset));
    return this.get<TrustAdminAlertListResponse>(url.pathname + url.search);
  }

  decideAlert(alertId: string, action: TrustAlertAction): Promise<TrustAdminAlertDecisionResponse> {
    return this.post<TrustAdminAlertDecisionResponse>(
      `/api/dev/trust/alerts/${encodeURIComponent(alertId)}/${action}`,
      {}
    );
  }

  settle(accountId: string): Promise<TrustAdminSettlementActionResponse> {
    return this.post(`/api/dev/trust/accounts/${encodeURIComponent(accountId)}/settle`, {});
  }

  unsettle(accountId: string): Promise<TrustAdminSettlementActionResponse> {
    return this.post(`/api/dev/trust/accounts/${encodeURIComponent(accountId)}/unsettle`, {});
  }

  /** confirm=false is the dry run: it only counts the guests that would be suspended. */
  quarantineArrivals(
    hostAccountId: string,
    input: { since: string; confirm: boolean; expectedCount?: number }
  ): Promise<TrustQuarantineArrivalsResponse> {
    return this.post(
      `/api/dev/trust/accounts/${encodeURIComponent(hostAccountId)}/quarantine-arrivals`,
      input
    );
  }

  /** Trust Lab: the live relocation + doorway decisions for a simulated profile. Writes nothing. */
  labDryRun(profile: TrustLabProfileInput): Promise<TrustLabDryRunResponse> {
    return this.post("/api/dev/trust/lab/dry-run", profile as Record<string, unknown>);
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": this.csrfToken },
      body: JSON.stringify(body)
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.serverHttpBase), {
      ...init,
      credentials: "include"
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(errorMessage(payload) ?? "Trust request failed");
    return payload as T;
  }
}

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = value.error;
  if (!error || typeof error !== "object" || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}
