import type pg from "pg";
import { DEFAULT_NATIVE_PUSH_PREFERENCES } from "@ash-atlas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLogger } from "../logger.js";
import type { AppConfig } from "../config.js";
import type { NativePushService } from "./nativePushService.js";
import { NativePushWorker, sourceStillRelevant } from "./nativePushWorker.js";
import { createNativePushSender, type PushEnvelope, type PushSendResult } from "./nativePushProviders.js";

const providerMocks = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getClient = providerMocks.getClient; } }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-19T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture(options: { target?: boolean; relevant?: boolean; current?: boolean; capped?: boolean; coalesced?: boolean; attempts?: number; kind?: string; decryptError?: boolean; databaseError?: boolean; preference?: Partial<typeof DEFAULT_NATIVE_PUSH_PREFERENCES> } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const delivery = { id: "delivery", binding_id: "binding", binding_epoch: 2, player_id: "player", kind: options.kind ?? "direct_message",
    source_id: "source", collapse_key: "collapse", expires_at: new Date(Date.now()+3_600_000), attempts: options.attempts ?? 1, lease_id: "owned-lease" };
  let claimed = false;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    let rows: unknown[] = [];
    if (sql.startsWith("SELECT b.id")) { if (!claimed) rows = [{ id: "binding" }]; claimed = true; }
    else if (sql.includes("RETURNING *")) rows = [delivery];
    else if (sql.startsWith("SELECT b.token_encrypted")) {
      if (options.databaseError) throw Error("private database diagnostic");
      if (options.target !== false) rows = [{ account_id:"00000000-0000-4000-8000-000000000111", token_encrypted: {}, token_version: 3, provider: "fcm", environment: "production" }];
    } else if (sql.includes("AS capped")) rows = [{ capped: options.capped ?? false, coalesced: options.coalesced ?? false }];
    else if (sql.startsWith("UPDATE native_push_deliveries d")) { if (options.current !== false) rows = [{ leased_until: new Date(Date.now()+60_000) }]; }
    else if (sql.startsWith("SELECT m.id") || sql.startsWith("SELECT i.id") || sql.startsWith("SELECT id FROM player_packages")) { if (options.relevant !== false) rows = [{ id: "source" }]; }
    return { rows, rowCount: rows.length };
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool;
  const preferences = { ...DEFAULT_NATIVE_PUSH_PREFERENCES, enabled: true, revision: 4, ...options.preference };
  const service = { pool, config: { NATIVE_PUSH_DELIVERY_ENABLED: true, AUTH_SESSION_INACTIVITY_DAYS: 14, NATIVE_PUSH_ACCOUNT_ALLOWLIST:["00000000-0000-4000-8000-000000000111"],NATIVE_PUSH_CATEGORY_ALLOWLIST:["direct_message","party_invite","kingdom_invite","package"], DEV_AUTHORIZED_GOOGLE_SUBJECTS:["dev-subject"], TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS:["admin-subject","dev-subject"] },
    preferences: vi.fn(async () => preferences), decryptToken: vi.fn(() => { if (options.decryptError) throw Error("private-key-data"); return "private-token"; }) } as unknown as NativePushService;
  const transmitted = vi.fn();
  const send = vi.fn(async (message: PushEnvelope): Promise<PushSendResult> => {
    if (!await message.beforeDispatch()) return { outcome: "suppressed", code: "state_changed" };
    transmitted(); return { outcome: "sent", code: "accepted" };
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { calls, delivery, send, transmitted, service, logger, worker: new NativePushWorker(service, send, logger as unknown as AppLogger) };
}

describe("native notification worker boundaries", () => {
  it.each(["account","category"])("suppresses removal of the %s allowlist while provider credentials wait",async (kind) => {
    const f=fixture();
    let resolveToken!:(value:{token:string})=>void;
    providerMocks.getClient.mockResolvedValue({getAccessToken:() => new Promise<{token:string}>((resolve) => {resolveToken=resolve;})});
    vi.stubGlobal("fetch",vi.fn());
    f.send.mockImplementation(createNativePushSender({NATIVE_PUSH_FCM_PROJECT_ID:"fixture"} as AppConfig));
    const pending=f.worker.tick();await vi.advanceTimersByTimeAsync(5_000);
    if(kind==="account") f.service.config.NATIVE_PUSH_ACCOUNT_ALLOWLIST=[];
    else f.service.config.NATIVE_PUSH_CATEGORY_ALLOWLIST=[];
    resolveToken({token:"fixture-token"});await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.values[2]==="suppressed" && call.values[3]==="state_changed")).toBe(true);
  });
  it("rechecks canonical account/session/access/source state in the atomic live-lease presend operation", async () => {
    const f = fixture();
    await f.worker.tick();
    expect(f.send).toHaveBeenCalledOnce();
    const presend = f.calls.find((call) => call.sql.startsWith("UPDATE native_push_deliveries d"))!;
    for (const guard of ["s.last_seen_at>clock_timestamp()-$4*interval '1 day'", "a.test_access_status='approved'", "a.test_access_status='pending'",
      "access_mode='open'", "access_mode='dev'", "identity.provider_subject=ANY($12::text[])", "dev.status='approved'", "identity.identity_status='active'", "installation.native_push_session_id=s.id", "s.revoked_at IS NULL",
      "a.session_version=s.account_session_version", "d.lease_id=$6", "d.leased_until>clock_timestamp()", "d.status='pending'",
      "b.token_version=$7", "preferences.revision=$8", "m.moderation_status='clear'"]) expect(presend.sql).toContain(guard);
    expect(presend.values).toEqual(["binding", 2, "player", 14, "delivery", "owned-lease", 3, 4, "source",f.service.config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,f.service.config.NATIVE_PUSH_CATEGORY_ALLOWLIST,["dev-subject","admin-subject"]]);
    expect(presend.sql).toContain("a.id=ANY($10::uuid[]) AND d.kind=ANY($11::text[])");
    expect(f.send.mock.calls[0]![0]).toMatchObject({ id: "delivery", targetId: "binding", deadlineAt: Date.now()+10_000 });
  });

  it("never submits when the presend lease or current registration/preference state was lost", async () => {
    const f = fixture({ current: false });
    await f.worker.tick();
    expect(f.transmitted).not.toHaveBeenCalled();
    const finish = f.calls.find((call) => call.values[3] === "state_changed")!;
    expect(finish.sql).toContain("lease_id=$2 AND status='pending'");
    expect(finish.values.slice(0, 2)).toEqual(["delivery", "owned-lease"]);
  });

  it.each(["logout", "token reset", "preferences disabled", "source read"])("does not transmit when the atomic guard reports %s during credential loading", async () => {
    const state = { current: true };
    const f = fixture(state);
    let resolveToken!: (value: { token: string }) => void;
    providerMocks.getClient.mockResolvedValue({ getAccessToken: () => new Promise<{ token: string }>((resolve) => { resolveToken = resolve; }) });
    vi.stubGlobal("fetch", vi.fn());
    f.send.mockImplementation(createNativePushSender({ NATIVE_PUSH_FCM_PROJECT_ID: "fixture" } as AppConfig));
    const pending = f.worker.tick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.calls.some((call) => call.sql.startsWith("UPDATE native_push_deliveries d"))).toBe(false);
    state.current = false; // The SQL predicate rejects the newly changed state.
    resolveToken({ token: "fixture-token" });
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.values[2] === "suppressed" && call.values[3] === "state_changed")).toBe(true);
  });

  it("does not transmit after stop while credentials are loading", async () => {
    const f = fixture();
    let resolveToken!: (value: { token: string }) => void;
    providerMocks.getClient.mockResolvedValue({ getAccessToken: () => new Promise<{ token: string }>((resolve) => { resolveToken = resolve; }) });
    vi.stubGlobal("fetch", vi.fn());
    f.send.mockImplementation(createNativePushSender({ NATIVE_PUSH_FCM_PROJECT_ID: "fixture" } as AppConfig));
    const pending = f.worker.tick();
    await vi.advanceTimersByTimeAsync(5_000);
    await f.worker.stop();
    resolveToken({ token: "fixture-token" });
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.sql.startsWith("UPDATE native_push_deliveries d"))).toBe(false);
  });

  it.each([{ target: false }, { relevant: false }, { capped: true }, { coalesced: true },
    { preference: { enabled: false } }, { preference: { quietStart: 720, quietEnd: 780, timeZone: "UTC" } }])("suppresses an ineligible target/source/preference/quota: %j", async (options) => {
    const f = fixture(options);
    await f.worker.tick();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("contains a missing encryption key without leaking it or indefinitely reclaiming the row", async () => {
    const f = fixture({ decryptError: true });
    await f.worker.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.values[2] === "failed" && call.values[3] === "token_key_unavailable")).toBe(true);
    expect(JSON.stringify(f.calls)).not.toContain("private-key-data");
  });

  it("limits expired-lease attempts even when an earlier database read threw before a provider response", async () => {
    const f = fixture({ databaseError: true });
    await expect(f.worker.tick()).rejects.toThrow("private database diagnostic");
    expect(f.send).not.toHaveBeenCalled();
    const cleanup = f.calls.find((call) => call.sql.includes("attempts_exhausted"))!;
    expect(cleanup.sql).toContain("leased_until IS NULL OR leased_until<=now()");
    expect(cleanup.sql).toContain("attempts>=$1");
    expect(cleanup.values).toEqual([5]);
  });

  it.each([[1, 10], [2, 30], [3, 120], [4, 300]])("backs off attempt %s by %s seconds with the original lease CAS", async (attempts, seconds) => {
    const f = fixture({ attempts });
    f.send.mockResolvedValue({ outcome: "retry", code: "provider_timeout" });
    await f.worker.tick();
    const retry = f.calls.find((call) => call.sql.includes("next_attempt_at=GREATEST"))!;
    expect(retry.values).toEqual(["delivery", "owned-lease", seconds, "provider_timeout"]);
    expect(retry.sql).toContain("lease_id=$2 AND status='pending'");
    expect(retry.sql).toContain("THEN leased_until ELSE NULL END");
  });

  it("stops retrying at the fifth attempt, including ambiguous outcomes", async () => {
    const f = fixture({ attempts: 5 });
    f.send.mockResolvedValue({ outcome: "retry", code: "provider_timeout" });
    await f.worker.tick();
    expect(f.calls.some((call) => call.sql.includes("next_attempt_at=GREATEST"))).toBe(false);
    const finish = f.calls.find((call) => call.values[2] === "failed" && call.values[3] === "provider_timeout")!;
    expect(finish.sql).toContain("THEN leased_until ELSE NULL END");
    const claim = f.calls.find((call) => call.sql.startsWith("SELECT b.id"))!;
    expect(claim.sql).toContain("d.binding_id=b.id AND d.leased_until>now()");
  });

  it("invalidates a rejected token only while its original lease, epoch and token version are still owned", async () => {
    const f = fixture();
    f.send.mockResolvedValue({ outcome: "invalid_token", code: "unregistered" });
    await f.worker.tick();
    const invalidation = f.calls.find((call) => call.sql.startsWith("UPDATE native_push_bindings"))!;
    expect(invalidation.sql).toContain("binding_epoch=$2 AND token_version=$3");
    expect(invalidation.sql).toContain("id=$4 AND lease_id=$5 AND status='pending'");
    expect(invalidation.values).toEqual(["binding", 2, 3, "delivery", "owned-lease"]);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain("private-token");
  });

  it.each(["party_invite", "kingdom_invite"])("checks canonical exact-revision read receipts both before and at submission for %s", async (kind) => {
    const f = fixture({ kind });
    await f.worker.tick();
    const sourceQueries = f.calls.filter((call) => call.sql.includes("player_inbox_read_receipts"));
    expect(sourceQueries).toHaveLength(2);
    for (const { sql } of sourceQueries) {
      expect(sql).toContain("receipt.read_revision=to_char(date_trunc('milliseconds'");
      expect(sql).toContain(kind === "party_invite" ? "i.updated_at" : "COALESCE(i.responded_at,i.created_at)");
      expect(sql).toContain(kind === "party_invite" ? "receipt.entry_key='party:'" : "receipt.entry_key='kingdom:'");
      expect(sql).toContain("AT TIME ZONE 'UTC'");
    }
  });

  it("fails closed for an unknown source kind without issuing a query", async () => {
    const query = vi.fn();
    await expect(sourceStillRelevant({ query } as unknown as pg.Pool, { kind: "unknown", player_id: "player", source_id: "source" })).rejects.toThrow("Unknown notification source");
    expect(query).not.toHaveBeenCalled();
  });
});
