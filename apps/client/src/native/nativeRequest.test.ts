// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeRequestApi from "./nativeRequest.js";
const transport = vi.hoisted(() => ({ request: vi.fn(), identity: vi.fn(), native: true }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => transport.native, getPlatform: () => "ios" },
  CapacitorHttp: transport,
  registerPlugin: () => ({ getProcessIdentity: transport.identity })
}));
let api: typeof NativeRequestApi;
const key = "ash-atlas-native-auth-uncertain-v1";
const tokenUrl = new URL("https://playashatlas.com/api/auth/native/token");
const sessionUrl = new URL("https://playashatlas.com/api/auth/session");
const ok = { status: 200, data: {}, headers: {} };
const post = { method: "POST", body: "{}" };
function storedIntent(processId = "test-process", settled = false): string {
  return JSON.stringify({ processId, mutationId: "previous-intent", settled });
}
async function reconcile(): Promise<void> {
  transport.request.mockResolvedValueOnce(ok);
  await api.nativeAuthRequest(sessionUrl, { method: "GET" });
  api.confirmNativeSessionReconciled();
}
beforeEach(async () => {
  vi.resetModules();
  transport.native = true;
  transport.identity.mockResolvedValue({ id: "test-process" });
  api = await import("./nativeRequest.js");
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); transport.request.mockReset(); transport.identity.mockReset(); vi.unstubAllGlobals(); });
describe("native authentication transport", () => {
  it("serializes simultaneous mutations and never dispatches a timed-out queued mutation", async () => {
    vi.useFakeTimers();
    let complete!: (value: { status: number; data: unknown; headers: Record<string, string> }) => void;
    transport.request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const first = api.nativeAuthRequest(tokenUrl, post);
    const second = api.nativeAuthRequest(new URL("https://playashatlas.com/api/auth/logout"), post);
    const rejected = Promise.all([expect(first).rejects.toMatchObject({ uncertain: true }), expect(second).rejects.toMatchObject({ uncertain: true })]);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(transport.request).toHaveBeenCalledTimes(1);
    complete({ status: 200, data: {}, headers: {} });
    await api.waitForNativeAuthTransport();
    expect(transport.request).toHaveBeenCalledTimes(1);
    await reconcile();
  });
  it("quarantines late cookie-setting mutations until the native request settles and session is reconciled", async () => {
    vi.useFakeTimers();
    let complete!: (value: { status: number; data: unknown; headers: Record<string, string> }) => void;
    transport.request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const request = api.nativeAuthRequest(tokenUrl, {
      method: "POST", body: JSON.stringify({ code: "opaque" })
    });
    const rejected = expect(request).rejects.toMatchObject({ uncertain: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 5_000, readTimeout: 20_000 }));
    let settled = false;
    const waiting = api.waitForNativeAuthTransport().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    complete({ status: 200, data: { authenticated: true }, headers: {} });
    await waiting;
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    api.confirmNativeSessionReconciled();
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    await reconcile();
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
  });

  it("persists intent before native dispatch, without auth material", async () => {
    transport.request.mockImplementationOnce(async () => {
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
        processId: "test-process", mutationId: expect.any(String), settled: false
      });
      return ok;
    });
    await api.nativeAuthRequest(tokenUrl, { method: "post", body: JSON.stringify({ code: "secret-code" }) });
    expect(localStorage.getItem(key)).not.toContain("secret-code");
    expect(JSON.parse(localStorage.getItem(key)!).settled).toBe(true);
  });

  it("refuses both a GET and new mutation after same-process WebView restart", async () => {
    localStorage.setItem(key, storedIntent());
    await expect(api.nativeAuthRequest(sessionUrl, {})).rejects.toBeInstanceOf(api.NativeAuthRestartRequiredError);
    await expect(api.nativeAuthRequest(tokenUrl, post)).rejects.toThrow("Fully close Ash Atlas");
    api.confirmNativeSessionReconciled();
    expect(localStorage.getItem(key)).toBe(storedIntent());
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("permits a new native process but retains intent until successful session reconciliation", async () => {
    localStorage.setItem(key, storedIntent("old-process"));
    await api.waitForNativeAuthTransport();
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    transport.request.mockResolvedValueOnce({ ...ok, status: 503 });
    await api.nativeAuthRequest(sessionUrl, {});
    api.confirmNativeSessionReconciled();
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    await reconcile();
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
  });

  it("allows settled intent to reconcile after WebView restart in the same process", async () => {
    localStorage.setItem(key, storedIntent("test-process", true));
    await reconcile();
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
  });

  it.each(["true", "{", "", JSON.stringify({ processId: "test-process", mutationId: "id", settled: "yes" })])(
    "quarantines malformed or legacy intent %s until a known process boundary", async (raw) => {
      localStorage.setItem(key, raw);
      await expect(api.nativeAuthRequest(sessionUrl, {})).rejects.toBeInstanceOf(api.NativeAuthRestartRequiredError);
      expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ processId: "test-process", settled: false });
      vi.resetModules();
      transport.identity.mockResolvedValue({ id: "next-process" });
      api = await import("./nativeRequest.js");
      await reconcile();
      expect(api.nativeAuthNeedsReconciliation()).toBe(false);
    }
  );

  it("does not clear a newer settled mutation with an older session result", async () => {
    localStorage.setItem(key, storedIntent("test-process", true));
    transport.request.mockResolvedValue(ok);
    await api.nativeAuthRequest(sessionUrl, {});
    await api.nativeAuthRequest(tokenUrl, post);
    api.confirmNativeSessionReconciled();
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    await reconcile();
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
  });

  it("fails closed before dispatch when intent persistence or reading is unavailable", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await expect(api.nativeAuthRequest(tokenUrl, post)).rejects.toThrow("storage unavailable");
    expect(transport.request).not.toHaveBeenCalled();
    set.mockRestore();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(api.nativeAuthNeedsReconciliation()).toBe(true);
    await expect(api.nativeAuthRequest(sessionUrl, {})).rejects.toThrow("storage unavailable");
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("does not persist harmless account mutations as native cookie uncertainty", async () => {
    transport.request.mockResolvedValue(ok);
    await api.nativeAuthRequest(new URL("https://playashatlas.com/api/account/onboarding"), post);
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("does not dispatch an already cancelled mutation and permits reconciliation afterward", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.nativeAuthRequest(tokenUrl, { ...post, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.request).not.toHaveBeenCalled();
    await reconcile();
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
  });

  it("bounds a missing native identity response without dispatching auth", async () => {
    vi.useFakeTimers();
    transport.identity.mockReturnValue(new Promise(() => {}));
    const request = api.nativeAuthRequest(tokenUrl, post);
    const rejected = expect(request).rejects.toBeInstanceOf(api.NativeRequestError);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(transport.request).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("retains pending intent if recording native settlement fails", async () => {
    transport.request.mockImplementationOnce(async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
      return ok;
    });
    await api.nativeAuthRequest(tokenUrl, post);
    expect(JSON.parse(localStorage.getItem(key)!).settled).toBe(false);
    await expect(api.nativeAuthRequest(sessionUrl, {})).rejects.toBeInstanceOf(api.NativeAuthRestartRequiredError);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("keeps browser requests unchanged and never calls native identity", async () => {
    transport.native = false;
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    localStorage.setItem(key, storedIntent());
    await api.nativeAuthRequest(tokenUrl, post);
    expect(fetcher).toHaveBeenCalledWith(tokenUrl, post);
    expect(transport.identity).not.toHaveBeenCalled();
    expect(api.nativeAuthNeedsReconciliation()).toBe(false);
  });
});
