import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { classifyApnsResponse, createNativePushSender, PUSH_SEND_TIMEOUT_MS, type PushEnvelope } from "./nativePushProviders.js";

const mocks = vi.hoisted(() => ({ getClient: vi.fn(), connect: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getClient = mocks.getClient; } }));
vi.mock("node:http2", () => ({ connect: mocks.connect }));

const config = { NATIVE_PUSH_FCM_PROJECT_ID: "test-project", NATIVE_PUSH_APNS_TOPIC: "com.ashatlas.game" } as AppConfig;
const message = (): PushEnvelope => ({ id: "opaque-delivery", targetId: "binding-1", token: "private-device-token", provider: "fcm", environment: "production",
  kind: "direct_message", collapseKey: "opaque-collapse", expiresAt: new Date(Date.now()+3_600_000), beforeDispatch: async () => true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  mocks.getClient.mockReset().mockResolvedValue({ getAccessToken: vi.fn().mockResolvedValue({ token: "test-access-token" }) });
  mocks.connect.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded native provider transport", () => {
  it("bounds ADC discovery, holds the installation fence across token rotation, and never dispatches late credentials", async () => {
    const adc = deferred<{ getAccessToken: ReturnType<typeof vi.fn> }>();
    mocks.getClient.mockReturnValueOnce(adc.promise);
    const sender = createNativePushSender(config);
    const pending = sender(message());
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ outcome: "retry", code: "provider_timeout" });
    expect(await sender({ ...message(), token: "rotated-token" })).toEqual({ outcome: "retry", code: "provider_in_flight" });
    const access = vi.fn().mockResolvedValue({ token: "late-token" });
    adc.resolve({ getAccessToken: access });
    await vi.advanceTimersByTimeAsync(0);
    expect(access).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await sender(message())).toEqual({ outcome: "sent", code: "accepted" });
  });

  it("bounds access-token loading and prevents a late token result from sending", async () => {
    const auth = deferred<{ token: string }>();
    mocks.getClient.mockResolvedValue({ getAccessToken: () => auth.promise });
    const pending = createNativePushSender(config)(message());
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS);
    expect((await pending).outcome).toBe("retry");
    auth.resolve({ token: "late-token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a hung transport and prevents overlap until it actually settles", async () => {
    const transport = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(transport.promise);
    const sender = createNativePushSender(config);
    const pending = sender(message());
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ outcome: "retry", code: "provider_timeout" });
    const options = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(options.signal?.aborted).toBe(true);
    expect(await sender(message())).toEqual({ outcome: "retry", code: "provider_in_flight" });
    expect(fetch).toHaveBeenCalledTimes(1);
    transport.resolve(new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await sender(message())).outcome).toBe("sent");
  });

  it("honors an expired lease deadline before loading credentials", async () => {
    expect(await createNativePushSender(config)({ ...message(), deadlineAt: Date.now()-1 })).toEqual({ outcome: "retry", code: "provider_deadline" });
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks current authority after credentials arrive within the deadline", async () => {
    const auth = deferred<{ token: string }>();
    mocks.getClient.mockResolvedValue({ getAccessToken: () => auth.promise });
    const beforeDispatch = vi.fn(async () => false);
    const pending = createNativePushSender(config)({ ...message(), beforeDispatch });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(beforeDispatch).not.toHaveBeenCalled();
    auth.resolve({ token: "test-access-token" });
    expect(await pending).toEqual({ outcome: "suppressed", code: "state_changed" });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a hung final authority check and never dispatches its late approval", async () => {
    const approval = deferred<boolean>();
    const beforeDispatch = vi.fn(() => approval.promise);
    const sender = createNativePushSender(config);
    const pending = sender({ ...message(), beforeDispatch });
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(await pending).toEqual({ outcome: "retry", code: "provider_timeout" });
    expect(await sender(message())).toEqual({ outcome: "retry", code: "provider_in_flight" });
    approval.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [404, "UNREGISTERED", "invalid_token"], [404, "OTHER", "failed"], [400, "INVALID_ARGUMENT", "failed"],
    [429, "QUOTA_EXCEEDED", "retry"], [503, "UNAVAILABLE", "retry"]
  ])("classifies FCM %s/%s without echoing provider data", async (status, errorCode, outcome) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: { message: "private-diagnostic", details: [{ errorCode }] } }), { status }));
    const result = await createNativePushSender(config)(message());
    expect(result.outcome).toBe(outcome);
    expect(JSON.stringify(result)).not.toContain("private-diagnostic");
  });

  it("sends only generic notification text and an opaque destination", async () => {
    await createNativePushSender(config)(message());
    const request = vi.mocked(fetch).mock.calls[0]![1]!;
    const body = JSON.parse(String(request.body));
    expect(body.message.data).toEqual({ deliveryId: "opaque-delivery" });
    expect(body.message.notification).toEqual({ title: "Ash Atlas", body: "You have an update in Messages." });
    expect(request.redirect).toBe("error");
    expect(body.message.android.collapse_key).toBe("direct_message");
  });

  it("destroys hung APNs transport at the whole-operation deadline", async () => {
    const stream = Object.assign(new EventEmitter(), { end: vi.fn() });
    const session = Object.assign(new EventEmitter(), { request: vi.fn(() => stream), destroy: vi.fn() });
    mocks.connect.mockReturnValue(session);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sender = createNativePushSender({ ...config, NATIVE_PUSH_APNS_TEAM_ID: "test-team", NATIVE_PUSH_APNS_KEY_ID: "test-key",
      NATIVE_PUSH_APNS_PRIVATE_KEY_BASE64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64") });
    const pending = sender({ ...message(), provider: "apns" });
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS);
    expect((await pending).outcome).toBe("retry");
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(JSON.parse(stream.end.mock.calls[0]![0])).toEqual({ aps: { alert: { title: "Ash Atlas", body: "You have an update in Messages." } }, deliveryId: "opaque-delivery" });
  });

  it.each([
    [410, "Unregistered", "invalid_token"], [400, "BadDeviceToken", "invalid_token"],
    [400, "DeviceTokenNotForTopic", "failed"], [403, "InvalidProviderToken", "failed"],
    [410, "unknown-private-response", "failed"], [429, "TooManyRequests", "retry"], [503, "Shutdown", "retry"]
  ])("classifies APNs %s/%s from a safe reason allowlist", (status, reason, outcome) => {
    const result = classifyApnsResponse(status, reason);
    expect(result.outcome).toBe(outcome);
    expect(result.code).not.toContain(reason);
  });
});
