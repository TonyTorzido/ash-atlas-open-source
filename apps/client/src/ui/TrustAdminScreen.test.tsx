// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustAdminAccountDetail, TrustAdminAlertView } from "@ash-atlas/shared";

import { TrustAdminScreen } from "./TrustAdminScreen.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000201";
const NOW = "2026-10-02T12:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Trust admin Alerts tab", () => {
  it("lists alerts with severity, account, kind, rounded location, count and status", async () => {
    const { fetchMock } = stubFetch([alert()]);
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(await screen.findByText(/Red zone relocation · Scout/)).toBeTruthy();
    expect(screen.getByText("Severity 3")).toBeTruthy();
    expect(screen.getByText(/pending · -80\.53, 20\.27 · 2 times/)).toBeTruthy();
    expect(screen.getByText(ACCOUNT_ID)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quarantine arrivals" })).toBeNull();
    const listCall = fetchMock.mock.calls.map(([input]) => new URL(String(input))).find((url) => url.pathname === "/api/dev/trust/alerts");
    expect(listCall?.searchParams.get("status")).toBe("pending");
    expect(listCall?.searchParams.get("limit")).toBe("25");
    expect(listCall?.searchParams.get("offset")).toBe("0");
  });

  it("approves with the CSRF token and reloads", async () => {
    const { fetchMock } = stubFetch([alert()]);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeTruthy();
      expect(new URL(String(post![0])).pathname).toBe("/api/dev/trust/alerts/alert-1/approve");
      expect((post![1]!.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-token");
    });
    await waitFor(() => {
      const lists = fetchMock.mock.calls.filter(([input, init]) =>
        new URL(String(input)).pathname === "/api/dev/trust/alerts" && isGet(init));
      expect(lists.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("asks before locking and only posts after the confirmation", async () => {
    const { fetchMock } = stubFetch([alert()]);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Lock" }));

    expect(await screen.findByText("Lock this account?")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Lock account" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(new URL(String(post![0])).pathname).toBe("/api/dev/trust/alerts/alert-1/lock");
    });
  });

  it("quarantines arrivals only after a dry-run count and passes that count on confirm", async () => {
    const { fetchMock } = stubFetch([alert({ kind: "mass_arrival", severity: 3 })]);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Quarantine arrivals" }));

    expect(await screen.findByText("Arrivals since")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Count arrivals" }));
    expect(await screen.findByText("3 active accounts would be suspended.")).toBeTruthy();
    const dry = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(dry![1]!.body))).toMatchObject({ confirm: false });

    fireEvent.click(screen.getByRole("button", { name: "Suspend 3 accounts" }));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(new URL(String(posts[1]![0])).pathname).toBe(`/api/dev/trust/accounts/${ACCOUNT_ID}/quarantine-arrivals`);
      expect(JSON.parse(String(posts[1]![1]!.body))).toMatchObject({ confirm: true, expectedCount: 3 });
    });
  });

  it("shows Settled status, attestations and arrivals in the account detail", async () => {
    stubFetch([alert()]);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));

    expect(await screen.findByRole("heading", { name: "Settled" })).toBeTruthy();
    expect(screen.getByText("Not settled")).toBeTruthy();
    expect(screen.getByText(/Checks 10\/33 · days 3\/8 · positions 2 · difficulty 1\.50/)).toBeTruthy();
    expect(screen.getByText(/Home 40\.12, -105\.57 · Settled home none/)).toBeTruthy();
    expect(screen.getByText("Last fix assurance: device_checked")).toBeTruthy();
    expect(screen.getByText("play_integrity · fail · flagged")).toBeTruthy();
    expect(screen.getByText(/Host One · invite/)).toBeTruthy();
    expect(screen.getByText(/Guest Two · party_manual/)).toBeTruthy();
    expect(screen.getByText(/emulator: goldfish · VPN · developer options · device activity LEVEL_4/)).toBeTruthy();
    expect(screen.getByText(/GPS US · SIM RU · time zone RU/)).toBeTruthy();
    expect(screen.getByText(/Same install as: Alt Three/)).toBeTruthy();
    const settledRow = screen.getByText("Not settled").closest("article, div.test-access-row") as HTMLElement;
    fireEvent.click(within(settledRow).getByRole("button", { name: "Settle" }));
    expect(await screen.findByText("Mark this account Settled?")).toBeTruthy();
  });
});

function renderScreen() {
  return render(<TrustAdminScreen serverHttpBase="http://localhost:3000" csrfToken="csrf-token" onClose={vi.fn()} />);
}

function alert(overrides: Partial<TrustAdminAlertView> = {}): TrustAdminAlertView {
  return {
    id: "alert-1",
    accountId: ACCOUNT_ID,
    playerName: "Scout",
    kind: "zone_red",
    severity: 3,
    status: "pending",
    lat: -80.53,
    lon: 20.27,
    count: 2,
    details: { count: 2 },
    allowanceExpiresAt: null,
    decidedAt: null,
    createdAt: NOW,
    ...overrides
  };
}

function detail(): TrustAdminAccountDetail {
  return {
    accountId: ACCOUNT_ID,
    playerName: "Scout",
    trustTier: "new",
    shadowTier: 1,
    effectiveLogodds: 1,
    decayedLogodds: 0.5,
    priorLogodds: 0.5,
    peakLogodds: 1,
    providers: ["google"],
    createdAt: NOW,
    lastSignalAt: null,
    landActionHoldUntil: null,
    landActionHoldReason: null,
    events: [],
    locationReports: [],
    settlement: {
      settled: false, settledAt: null, provisionalUntil: null,
      home: { lat: 40.12, lon: -105.57 }, settledHome: null,
      difficulty: 1.5, targetChecks: 33, targetDays: 8, countedChecks: 10, countedDays: 3, distinctPositions: 2,
      unsettledAt: null, unsettleReason: null
    },
    attestations: [{
      id: "att-1", method: "play_integrity", outcome: "fail", assurance: "flagged", reason: "device_integrity", createdAt: NOW
    }],
    lastFixAssurance: "device_checked",
    environments: [{
      id: "env-1", platform: "android", installIdHash: "abcdef0123456789", installIdPersistent: false, installSource: "sideload",
      emulatorHints: ["goldfish"], rootHints: [], debuggerAttached: false, devOptions: true, adbEnabled: null,
      autoTimeEnabled: null, vpnActive: true, simCountry: "RU", networkCountry: null, cellCountries: [],
      timeZoneCountries: ["RU"], localeCountry: null, gpsCountries: ["US"],
      playIntegrity: { deviceActivityLevel: "LEVEL_4" }, deviceCheckBit0: null, createdAt: NOW
    }],
    installLinkedAccounts: [{ accountId: "alt-1", playerName: "Alt Three", lastSeenAt: NOW }],
    broughtBy: [{
      id: "a1", otherAccountId: "host-1", otherPlayerName: "Host One", kind: "invite", lat: 12.34, lon: 56.78, createdAt: NOW
    }],
    broughtIn: [{
      id: "a2", otherAccountId: "guest-2", otherPlayerName: "Guest Two", kind: "party_manual", lat: null, lon: null, createdAt: NOW
    }]
  };
}

function isGet(init?: RequestInit): boolean {
  return !init?.method || init.method === "GET";
}

function stubFetch(alerts: TrustAdminAlertView[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const respond = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" }
    }));
    if (url.pathname === "/api/dev/trust/accounts" && isGet(init)) return respond({ accounts: [], generatedAt: NOW });
    if (url.pathname === "/api/dev/trust/alerts" && isGet(init)) {
      return respond({ alerts, total: alerts.length, limit: 25, offset: 0, generatedAt: NOW });
    }
    if (url.pathname === `/api/dev/trust/accounts/${ACCOUNT_ID}` && isGet(init)) {
      return respond({ account: detail(), generatedAt: NOW });
    }
    if (url.pathname.endsWith("/quarantine-arrivals")) {
      const body = JSON.parse(String(init?.body)) as { confirm: boolean };
      return respond({
        hostAccountId: ACCOUNT_ID, since: NOW, dryRun: !body.confirm, guestCount: 3, suspendedCount: body.confirm ? 3 : 0
      });
    }
    if (url.pathname.startsWith("/api/dev/trust/alerts/") && init?.method === "POST") {
      return respond({ alert: alerts[0], generatedAt: NOW });
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}
