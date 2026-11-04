import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";

const READ_DEADLINE_MS = 15_000;
const MUTATION_DEADLINE_MS = 30_000;
const UNCERTAIN_KEY = "ash-atlas-native-auth-uncertain-v1";
const outstanding = new Set<Promise<unknown>>();
let dispatch: Promise<unknown> = Promise.resolve();
const runtime = registerPlugin<{ getProcessIdentity(): Promise<{ id: string }> }>("NativeRuntime");
let processIdentity: Promise<string> | undefined;
let latestMutationId: string | undefined;
let reconciledMarker: string | null | undefined;
type UncertainMarker = { processId: string; mutationId: string; settled: boolean };

function processId(): Promise<string> {
  return processIdentity ??= deadline(runtime.getProcessIdentity(), READ_DEADLINE_MS, false).then((value) => {
    if (typeof value.id !== "string" || !value.id.length) throw new Error("Native process identity unavailable");
    return value.id;
  });
}

function readMarker(): { raw: string | null; value: UncertainMarker | null } {
  // Unreadable storage is not evidence that a previous native mutation finished.
  const raw = localStorage.getItem(UNCERTAIN_KEY);
  if (raw === null) return { raw, value: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null &&
      "processId" in parsed && typeof parsed.processId === "string" && parsed.processId.length &&
      "mutationId" in parsed && typeof parsed.mutationId === "string" && parsed.mutationId.length &&
      "settled" in parsed && typeof parsed.settled === "boolean") {
      return { raw, value: parsed as UncertainMarker };
    }
  } catch { /* Legacy or damaged intent needs a known process boundary, not a GET. */ }
  return { raw, value: null };
}

export class NativeAuthRestartRequiredError extends Error {
  constructor() {
    super("A sign-in request was interrupted. Fully close Ash Atlas and reopen it before continuing." +
      (Capacitor.getPlatform() === "android" ? " On Android, use Force stop in app settings." : ""));
    this.name = "NativeAuthRestartRequiredError";
  }
}

export class NativeRequestError extends Error {
  constructor(readonly uncertain: boolean) {
    super(uncertain
      ? "Sign-in is still being checked. Try again before starting another sign-in."
      : "The connection took too long. Please try again.");
    this.name = "NativeRequestError";
  }
}

function writeMarker(value: UncertainMarker): void {
  localStorage.setItem(UNCERTAIN_KEY, JSON.stringify(value));
}

function mutationId(): string {
  // getRandomValues is available on the minimum iOS target; randomUUID is newer.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nativeAuthNeedsReconciliation(): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  try { return outstanding.size > 0 || localStorage.getItem(UNCERTAIN_KEY) !== null; }
  catch { return true; }
}

/** A timed-out native mutation can still set cookies. Do not race a newer login against it. */
export async function waitForNativeAuthTransport(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const currentProcess = await processId();
    const previous = readMarker();
    if (previous.raw !== null && !previous.value) {
      writeMarker({ processId: currentProcess, mutationId: mutationId(), settled: false });
      throw new NativeAuthRestartRequiredError();
    }
    if (previous.value && !previous.value.settled && !outstanding.size) {
      if (previous.value.processId === currentProcess) {
        throw new NativeAuthRestartRequiredError();
      }
      // Installed Capacitor HTTP uses ordinary process-owned tasks, not background
      // transfers. Only a new native process proves the old tasks cannot set cookies.
      // Keep the intent until an authoritative session GET succeeds in this process.
    }
  }
  if (outstanding.size) await deadline(Promise.allSettled([...outstanding]), READ_DEADLINE_MS, true);
}

export function confirmNativeSessionReconciled(): void {
  if (!Capacitor.isNativePlatform() || outstanding.size || reconciledMarker === undefined) return;
  if (readMarker().raw === reconciledMarker) localStorage.removeItem(UNCERTAIN_KEY);
  reconciledMarker = undefined;
}

export async function boundedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Response> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try {
    const operation = fetcher(input, { ...init, signal: controller.signal }).then(async (response) => {
      if (typeof response.arrayBuffer !== "function") return response;
      const body = await response.arrayBuffer();
      return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      });
    });
    return await deadline(operation, READ_DEADLINE_MS, false);
  } finally {
    controller.abort();
    init.signal?.removeEventListener("abort", abort);
  }
}

/** Native auth uses explicit native deadlines; Capacitor's patched fetch drops these options. */
export async function nativeAuthRequest(url: URL, init: RequestInit): Promise<Response> {
  if (!Capacitor.isNativePlatform()) return fetch(url, init);
  await waitForNativeAuthTransport();
  const method = (init.method ?? "GET").toUpperCase();
  const mutation = method !== "GET";
  const cookieMutation = mutation && ["/api/auth/google","/api/auth/dev","/api/auth/native/token","/api/auth/logout","/api/auth/logout-all"].includes(url.pathname);
  const currentProcess = await processId();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  headers["x-ash-atlas-native-client"] = Capacitor.getPlatform() === "android"
    ? "capacitor-android" : "capacitor-ios";
  if (cookieMutation) {
    // Persist BEFORE scheduling a native cookie mutation. If persistence is
    // unavailable, refuse it rather than lose the restart safety fence.
    const intentId = mutationId();
    writeMarker({ processId: currentProcess, mutationId: intentId, settled: false });
    latestMutationId = intentId;
    reconciledMarker = undefined;
  }
  let cancelledBeforeDispatch = false;
  let sessionMarker: string | null | undefined;
  const operation = dispatch.then(() => {
    if (cancelledBeforeDispatch) throw new NativeRequestError(false);
    init.signal?.throwIfAborted();
    if (!mutation && url.pathname === "/api/auth/session") sessionMarker = readMarker().raw;
    return CapacitorHttp.request({
      url: url.toString(), method, headers,
      ...(typeof init.body === "string" ? { data: JSON.parse(init.body) as unknown } : {}),
      connectTimeout: 5_000, readTimeout: mutation ? 20_000 : 10_000,
      responseType: "json", disableRedirects: true
    });
  }).then((response) => {
    if (sessionMarker !== undefined && response.status >= 200 && response.status < 300 && readMarker().raw === sessionMarker) {
      reconciledMarker = sessionMarker;
    }
    return new Response(response.status === 204 ? null : JSON.stringify(response.data), {
      status: response.status, headers: response.headers
    });
  });
  dispatch = operation.catch(() => undefined);
  if (cookieMutation) {
    outstanding.add(operation);
    const settled = (): void => {
      outstanding.delete(operation);
      if (!outstanding.size) {
        try {
          const previous = readMarker().value;
          if (previous?.processId === currentProcess && previous.mutationId === latestMutationId) {
            writeMarker({ ...previous, settled: true });
          }
        } catch { /* Preserve the pending intent; inability to persist settlement fails closed. */ }
      }
    };
    void operation.then(settled,settled);
  }
  try {
    return await deadline(operation, mutation ? MUTATION_DEADLINE_MS : READ_DEADLINE_MS, mutation);
  } finally {
    // A queued request whose caller timed out must never start later. Already-started
    // native requests cannot be aborted and stay in outstanding until they settle.
    cancelledBeforeDispatch = true;
  }
}

function deadline<T>(operation: Promise<T>, timeoutMs: number, uncertain: boolean): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new NativeRequestError(uncertain)), timeoutMs); })
  ]).finally(() => clearTimeout(timeout));
}
