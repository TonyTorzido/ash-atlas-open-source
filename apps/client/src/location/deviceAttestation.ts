import {
  buildAttestClientData,
  type AttestBoundFix,
  type AttestPurpose,
  type DeviceEnvironment,
  type TrustAttestChallengeResponse,
  type TrustAttestResultResponse,
  type TrustAttestationSessionConfig
} from "@ash-atlas/shared";

import { subscribeNativeAppStateChange } from "../native/nativeApp.js";
import {
  detectDeviceTrust,
  deviceTrustClientError,
  deviceTrustErrorCode,
  nativeShellBuild,
  readDeviceEnvironment,
  type DeviceTrustBridge
} from "../native/nativeDeviceTrust.js";

// Device attestation (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.1-8.3). Native app only,
// with the DeviceTrust plugin: warm-up when the socket is online, a session
// attestation refreshed while in the foreground, and a fix-bound attestation per
// relocation under a 6 s budget. Never prompts, never runs in the background,
// never throws into gameplay. Every failure backs off; a 404 (server off or the
// platform disabled) stops attesting until the next start().

export const RELOCATION_ATTEST_BUDGET_MS = 6_000;
export const ATTEST_BACKOFF_BASE_MS = 30_000;
export const ATTEST_BACKOFF_MAX_MS = 30 * 60_000;
export const ATTEST_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
export const APP_ATTEST_KEY_REGEN_MIN_MS = 24 * 60 * 60_000;
// Warm-up waits this long after the socket comes online.
export const ATTEST_WARMUP_DELAY_MS = 2_000;
// The environment block and DeviceCheck token may take at most this long per request.
export const ATTEST_ENVIRONMENT_BUDGET_MS = 1_500;
const MIN_REFRESH_MS = 60_000;
export const APP_ATTEST_KEY_STORAGE = "ash-atlas-app-attest-key-v1";

export type AttestPlatform = "android" | "ios";
type SessionPurpose = "session" | "relocation";

export class AttestHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Attestation request failed (${status} ${code})`);
    this.name = "AttestHttpError";
  }
}

/** The /api/trust/attest/* endpoints (deviceTrustRoutes.ts). */
export type AttestationApi = Readonly<{
  challenge(body: { platform: AttestPlatform; purpose: AttestPurpose }): Promise<TrustAttestChallengeResponse>;
  android(body: {
    challengeId: string;
    purpose: SessionPurpose;
    shellBuild: number;
    token?: string;
    clientError?: string;
    fix?: AttestBoundFix;
    environment?: DeviceEnvironment;
  }): Promise<TrustAttestResultResponse>;
  iosKey(body: {
    challengeId: string;
    keyId: string;
    attestationObject: string;
    environment?: DeviceEnvironment;
    deviceCheckToken?: string;
  }): Promise<TrustAttestResultResponse>;
  iosAssert(body: {
    challengeId: string;
    purpose: SessionPurpose;
    keyId: string;
    assertion: string;
    shellBuild: number;
    fix?: AttestBoundFix;
    environment?: DeviceEnvironment;
    deviceCheckToken?: string;
  }): Promise<TrustAttestResultResponse>;
  iosDeviceCheck(body: {
    challengeId: string;
    purpose: SessionPurpose;
    deviceToken: string;
    shellBuild: number;
    environment?: DeviceEnvironment;
  }): Promise<TrustAttestResultResponse>;
}>;

export type AttestationPlan =
  | Readonly<{ kind: "play_integrity"; cloudProjectNumber: string }>
  | Readonly<{ kind: "app_attest"; deviceCheckFallback: boolean }>
  | Readonly<{ kind: "device_check" }>;

type StoredKey = { keyId: string; registered: boolean; generatedAtMs: number };

type TimerHandle = ReturnType<typeof setTimeout>;

export type AttestationManagerDeps = Readonly<{
  detect(): Promise<DeviceTrustBridge | null>;
  shellBuild(): Promise<number | undefined>;
  storage: Readonly<{ get(key: string): string | null; set(key: string, value: string | null): void }>;
  isForeground(): boolean;
  subscribeForeground(handler: (foreground: boolean) => void): () => void;
  now(): number;
  /** Uniform in [0, 1); jitters backoff. */
  random(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}>;

type SessionRef = { ref: string; expiresAtMs: number; refreshAtMs: number };

/** Chooses the attestation method from the server config and the plugin's capabilities. */
export function attestationPlan(
  config: TrustAttestationSessionConfig,
  bridge: DeviceTrustBridge | null
): AttestationPlan | null {
  if (!bridge || config.mode === "off") return null;
  const caps = bridge.capabilities;
  if (caps.platform === "android") {
    const project = config.android?.cloudProjectNumber;
    return project && caps.playIntegrity ? { kind: "play_integrity", cloudProjectNumber: project } : null;
  }
  const deviceCheck = config.ios?.deviceCheck === true && caps.deviceCheck;
  if (config.ios?.appAttest === true && caps.appAttest) return { kind: "app_attest", deviceCheckFallback: deviceCheck };
  return deviceCheck ? { kind: "device_check" } : null;
}

function withBudget<T>(work: Promise<T>, ms: number, deps: AttestationManagerDeps): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = deps.setTimer(() => resolve(undefined), ms);
    work.then(
      (value) => {
        deps.clearTimer(timer);
        resolve(value);
      },
      () => {
        deps.clearTimer(timer);
        resolve(undefined);
      }
    );
  });
}

export class AttestationManager {
  private api: AttestationApi | null = null;
  private config: TrustAttestationSessionConfig | null = null;
  private sessionKey: string | null = null;
  private plan: AttestationPlan | null = null;
  private bridge: DeviceTrustBridge | null = null;
  private shellBuild = 0;
  private generation = 0;
  private started = false;
  private disabled = false;
  private prepared = false;
  private foreground = true;
  private sessionRef: SessionRef | null = null;
  private failures = 0;
  private nextAttemptAtMs = 0;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;
  private unsubscribeForeground: (() => void) | null = null;

  constructor(private readonly deps: AttestationManagerDeps) {}

  /**
   * Starts for an online native session that advertises attestation. A new
   * sessionKey (other account or sign-in) drops the cached reference.
   */
  start(config: TrustAttestationSessionConfig, api: AttestationApi, sessionKey: string): void {
    this.stop();
    if (sessionKey !== this.sessionKey) {
      this.sessionRef = null;
      this.failures = 0;
      this.nextAttemptAtMs = 0;
    }
    this.sessionKey = sessionKey;
    this.config = config;
    this.api = api;
    this.started = true;
    this.disabled = false;
    const generation = ++this.generation;
    this.foreground = this.deps.isForeground();
    this.unsubscribeForeground = this.deps.subscribeForeground((foreground) => this.setForeground(foreground));
    void this.prepare(generation);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.clearTimer();
    this.unsubscribeForeground?.();
    this.unsubscribeForeground = null;
  }

  /** The current session attestation reference, when one is unexpired. */
  currentRef(): string | undefined {
    const current = this.sessionRef;
    return current && current.expiresAtMs > this.deps.now() ? current.ref : undefined;
  }

  /** Diagnostics/tests. */
  state(): Readonly<{ plan: AttestationPlan | null; failures: number; nextAttemptAtMs: number; disabled: boolean; started: boolean }> {
    return { plan: this.plan, failures: this.failures, nextAttemptAtMs: this.nextAttemptAtMs, disabled: this.disabled, started: this.started };
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      this.clearTimer();
      return;
    }
    this.scheduleNext();
  }

  /**
   * A fix-bound attestation for a relocation, within the 6 s budget. Resolves
   * undefined on any failure, timeout, or when attestation is unavailable; the
   * relocation then goes out without a reference. Never throws.
   */
  async attestRelocation(fix: AttestBoundFix): Promise<string | undefined> {
    if (!this.started || this.disabled || !this.foreground || !this.api) return undefined;
    const generation = this.generation;
    return withBudget((async () => {
      await this.ready(generation);
      const plan = this.plan;
      if (!plan || this.disabled || generation !== this.generation) return undefined;
      if (plan.kind === "device_check") {
        // DeviceCheck tokens cannot bind a fix; the server accepts the session reference.
        return this.currentRef() ?? (await this.attestOnce("relocation", null, generation))?.attestationRef;
      }
      return (await this.attestOnce("relocation", fix, generation))?.attestationRef;
    })(), RELOCATION_ATTEST_BUDGET_MS, this.deps);
  }

  private ready(generation: number): Promise<void> {
    return this.readyPromise ??= (async () => {
      const [bridge, shellBuild] = await Promise.all([this.deps.detect(), this.deps.shellBuild()]);
      if (generation !== this.generation) {
        this.readyPromise = null;
        return;
      }
      this.bridge = bridge;
      this.shellBuild = shellBuild ?? 0;
      this.plan = this.config ? attestationPlan(this.config, bridge) : null;
    })();
  }

  // Warm-up: pick the method, prepare Play Integrity, then attest the session.
  private async prepare(generation: number): Promise<void> {
    this.readyPromise = null;
    try {
      await this.ready(generation);
    } catch {
      return;
    }
    if (generation !== this.generation || !this.plan) return;
    this.scheduleNext(ATTEST_WARMUP_DELAY_MS);
  }

  private scheduleNext(minDelayMs = 0): void {
    this.clearTimer();
    if (!this.started || this.disabled || !this.foreground || !this.plan) return;
    const now = this.deps.now();
    const due = this.sessionRef ? this.sessionRef.refreshAtMs : now;
    const at = Math.max(due, this.nextAttemptAtMs, now + minDelayMs);
    const generation = this.generation;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      void this.refreshSession(generation);
    }, Math.max(0, at - now));
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private async refreshSession(generation: number): Promise<void> {
    if (this.inFlight || !this.started || this.disabled || !this.foreground) return;
    if (this.deps.now() < this.nextAttemptAtMs) {
      this.scheduleNext();
      return;
    }
    const run = this.attestOnce("session", null, generation).then(() => undefined);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
    if (generation === this.generation) this.scheduleNext();
  }

  /** One attestation round trip. Session results are cached; failures back off. */
  private async attestOnce(
    purpose: SessionPurpose,
    fix: AttestBoundFix | null,
    generation: number
  ): Promise<TrustAttestResultResponse | null> {
    const api = this.api;
    const plan = this.plan;
    const bridge = this.bridge;
    if (!api || !plan || !bridge) return null;
    try {
      let result: TrustAttestResultResponse | null;
      switch (plan.kind) {
        case "play_integrity":
          result = await this.attestAndroid(api, bridge, plan, purpose, fix);
          break;
        case "app_attest":
          result = await this.attestAppAttest(api, bridge, plan, purpose, fix, generation);
          break;
        case "device_check":
          result = await this.attestDeviceCheck(api, bridge, purpose);
          break;
      }
      if (generation !== this.generation) return result;
      if (!result) {
        this.fail();
        return null;
      }
      this.succeed(result, purpose);
      return result;
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      return null;
    }
  }

  private async attestAndroid(
    api: AttestationApi,
    bridge: DeviceTrustBridge,
    plan: Extract<AttestationPlan, { kind: "play_integrity" }>,
    purpose: SessionPurpose,
    fix: AttestBoundFix | null
  ): Promise<TrustAttestResultResponse | null> {
    if (!this.prepared) {
      try {
        await bridge.plugin.prepareIntegrity({ cloudProjectNumber: plan.cloudProjectNumber });
        this.prepared = true;
      } catch (error) {
        if (deviceTrustErrorCode(error) === "UNIMPLEMENTED" || deviceTrustErrorCode(error) === "UNSUPPORTED") {
          this.disable();
          return null;
        }
        // Report the failure once the challenge is in hand so the server records it.
      }
    }
    const [challenge, extras] = await Promise.all([
      api.challenge({ platform: "android", purpose }),
      this.extras(bridge, false)
    ]);
    const clientData = buildAttestClientData(purpose, challenge.challenge, fix);
    let token: string | undefined;
    let clientError: string | undefined;
    try {
      const response = await bridge.plugin.requestIntegrityToken({ clientData });
      if (typeof response?.token === "string" && response.token.length > 0) token = response.token;
      else clientError = "EMPTY_TOKEN";
    } catch (error) {
      clientError = deviceTrustClientError(error);
      if (clientError === "NOT_PREPARED") this.prepared = false;
    }
    const result = await api.android({
      challengeId: challenge.challengeId,
      purpose,
      shellBuild: this.shellBuild,
      ...(token === undefined ? { clientError: clientError ?? "UNKNOWN" } : { token }),
      ...(fix ? { fix: boundFixBody(fix) } : {}),
      ...(extras.environment ? { environment: extras.environment } : {})
    });
    // A client-side failure is recorded (neutral) but retried with backoff.
    if (token === undefined) {
      this.sessionRefFrom(result, purpose);
      return null;
    }
    return result;
  }

  private async attestAppAttest(
    api: AttestationApi,
    bridge: DeviceTrustBridge,
    plan: Extract<AttestationPlan, { kind: "app_attest" }>,
    purpose: SessionPurpose,
    fix: AttestBoundFix | null,
    generation: number
  ): Promise<TrustAttestResultResponse | null> {
    const key = await this.ensureAppAttestKey(api, bridge, plan, generation);
    if (!key) {
      return this.plan?.kind === "device_check" ? this.attestDeviceCheck(api, bridge, purpose) : null;
    }
    if (key.registration && purpose === "session") return key.registration;
    const [challenge, extras] = await Promise.all([
      api.challenge({ platform: "ios", purpose }),
      this.extras(bridge, true)
    ]);
    let assertion: string;
    try {
      const response = await bridge.plugin.generateAssertion({
        keyId: key.keyId,
        clientData: buildAttestClientData(purpose, challenge.challenge, fix)
      });
      if (typeof response?.assertion !== "string" || response.assertion.length === 0) return null;
      assertion = response.assertion;
    } catch (error) {
      if (deviceTrustErrorCode(error) === "KEY_INVALID") this.forgetKey();
      return null;
    }
    try {
      return await api.iosAssert({
        challengeId: challenge.challengeId,
        purpose,
        keyId: key.keyId,
        assertion,
        shellBuild: this.shellBuild,
        ...(fix ? { fix: boundFixBody(fix) } : {}),
        ...extras
      });
    } catch (error) {
      if (error instanceof AttestHttpError && error.code === "ATTEST_KEY_UNKNOWN") {
        this.forgetKey();
        return null;
      }
      throw error;
    }
  }

  /**
   * The registered App Attest key, generating (at most once per 24 h once a
   * key existed) and registering it as needed. `registration` is the session
   * result of a registration done in this call.
   */
  private async ensureAppAttestKey(
    api: AttestationApi,
    bridge: DeviceTrustBridge,
    plan: Extract<AttestationPlan, { kind: "app_attest" }>,
    generation: number
  ): Promise<{ keyId: string; registration: TrustAttestResultResponse | null } | null> {
    let stored = this.loadKey();
    const now = this.deps.now();
    if (!stored) {
      const last = this.lastKeyGeneratedAt();
      if (last !== null && now - last < APP_ATTEST_KEY_REGEN_MIN_MS) return null;
      try {
        const generated = await bridge.plugin.generateKey();
        if (typeof generated?.keyId !== "string" || generated.keyId.length === 0) return null;
        stored = { keyId: generated.keyId, registered: false, generatedAtMs: now };
        this.saveKey(stored);
      } catch (error) {
        const code = deviceTrustErrorCode(error);
        if (code === "UNSUPPORTED" || code === "UNIMPLEMENTED") {
          // App Attest is not available on this device: DeviceCheck or nothing.
          this.plan = plan.deviceCheckFallback ? { kind: "device_check" } : null;
          if (!this.plan) this.disable();
        }
        return null;
      }
    }
    if (stored.registered) return { keyId: stored.keyId, registration: null };
    if (generation !== this.generation) return null;
    const [challenge, extras] = await Promise.all([
      api.challenge({ platform: "ios", purpose: "ios_key" }),
      this.extras(bridge, true)
    ]);
    let attestationObject: string;
    try {
      const response = await bridge.plugin.attestKey({
        keyId: stored.keyId,
        clientData: buildAttestClientData("ios_key", challenge.challenge)
      });
      if (typeof response?.attestationObject !== "string" || response.attestationObject.length === 0) return null;
      attestationObject = response.attestationObject;
    } catch (error) {
      if (deviceTrustErrorCode(error) === "KEY_INVALID") this.forgetKey();
      return null;
    }
    let registration: TrustAttestResultResponse | null = null;
    try {
      registration = await api.iosKey({ challengeId: challenge.challengeId, keyId: stored.keyId, attestationObject, ...extras });
    } catch (error) {
      if (!(error instanceof AttestHttpError && error.code === "ATTEST_KEY_EXISTS")) throw error;
    }
    this.saveKey({ ...stored, registered: true });
    return { keyId: stored.keyId, registration };
  }

  private async attestDeviceCheck(
    api: AttestationApi,
    bridge: DeviceTrustBridge,
    purpose: SessionPurpose
  ): Promise<TrustAttestResultResponse | null> {
    let deviceToken: string;
    try {
      const response = await bridge.plugin.deviceCheckToken();
      if (typeof response?.token !== "string" || response.token.length === 0) return null;
      deviceToken = response.token;
    } catch (error) {
      const code = deviceTrustErrorCode(error);
      if (code === "UNSUPPORTED" || code === "UNIMPLEMENTED") this.disable();
      return null;
    }
    const [challenge, extras] = await Promise.all([
      api.challenge({ platform: "ios", purpose }),
      this.extras(bridge, false)
    ]);
    return api.iosDeviceCheck({
      challengeId: challenge.challengeId,
      purpose,
      deviceToken,
      shellBuild: this.shellBuild,
      ...(extras.environment ? { environment: extras.environment } : {})
    });
  }

  /**
   * The environment block (plan §8.9) and, on iOS with DeviceCheck enabled, a
   * DeviceCheck token for the server's two-bit check. Bounded; never throws.
   */
  private async extras(
    bridge: DeviceTrustBridge,
    withDeviceCheck: boolean
  ): Promise<{ environment?: DeviceEnvironment; deviceCheckToken?: string }> {
    const wantToken = withDeviceCheck && bridge.capabilities.deviceCheck && this.config?.ios?.deviceCheck === true;
    const [environment, token] = await Promise.all([
      withBudget(readDeviceEnvironment(bridge), ATTEST_ENVIRONMENT_BUDGET_MS, this.deps),
      wantToken
        ? withBudget(bridge.plugin.deviceCheckToken(), ATTEST_ENVIRONMENT_BUDGET_MS, this.deps)
        : Promise.resolve(undefined)
    ]);
    return {
      ...(environment ? { environment } : {}),
      ...(typeof token?.token === "string" && token.token.length > 0 ? { deviceCheckToken: token.token } : {})
    };
  }

  private succeed(result: TrustAttestResultResponse, purpose: SessionPurpose): void {
    this.failures = 0;
    this.nextAttemptAtMs = 0;
    this.sessionRefFrom(result, purpose);
  }

  // Relocation references are fix-bound: only session ones are reused.
  private sessionRefFrom(result: TrustAttestResultResponse, purpose: SessionPurpose): void {
    if (purpose !== "session" && this.plan?.kind !== "device_check") return;
    const now = this.deps.now();
    const expiresAtMs = Date.parse(result.expiresAt);
    if (typeof result.attestationRef !== "string" || !Number.isFinite(expiresAtMs)) return;
    const refreshSeconds = Number.isFinite(result.refreshAfterSeconds) && result.refreshAfterSeconds > 0
      ? result.refreshAfterSeconds
      : this.config?.refreshSeconds ?? 0;
    this.sessionRef = {
      ref: result.attestationRef,
      expiresAtMs,
      refreshAtMs: now + Math.max(MIN_REFRESH_MS, refreshSeconds * 1000)
    };
  }

  private fail(error?: unknown): void {
    if (error instanceof AttestHttpError && error.status === 404) {
      this.disable();
      return;
    }
    this.failures += 1;
    const exponential = Math.min(ATTEST_BACKOFF_MAX_MS, ATTEST_BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    const floor = error instanceof AttestHttpError && error.status === 429 ? ATTEST_RATE_LIMIT_BACKOFF_MS : 0;
    // Up to +20 % jitter so a fleet of clients does not retry in lockstep.
    const delay = Math.max(floor, Math.round(exponential * (1 + 0.2 * this.deps.random())));
    this.nextAttemptAtMs = this.deps.now() + delay;
  }

  private disable(): void {
    this.disabled = true;
    this.clearTimer();
  }

  private loadKey(): StoredKey | null {
    try {
      const raw = this.deps.storage.get(APP_ATTEST_KEY_STORAGE);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredKey> & { lastGeneratedAtMs?: number };
      if (typeof parsed.keyId !== "string" || parsed.keyId.length === 0) return null;
      return {
        keyId: parsed.keyId,
        registered: parsed.registered === true,
        generatedAtMs: typeof parsed.generatedAtMs === "number" ? parsed.generatedAtMs : 0
      };
    } catch {
      return null;
    }
  }

  private lastKeyGeneratedAt(): number | null {
    try {
      const raw = this.deps.storage.get(APP_ATTEST_KEY_STORAGE);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { generatedAtMs?: unknown };
      return typeof parsed.generatedAtMs === "number" ? parsed.generatedAtMs : null;
    } catch {
      return null;
    }
  }

  private saveKey(key: StoredKey): void {
    try {
      this.deps.storage.set(APP_ATTEST_KEY_STORAGE, JSON.stringify(key));
    } catch {
      // Storage unavailable: the key is regenerated next launch (rate limited).
    }
  }

  // Drops the key but remembers when it was made, so regeneration stays ≤ 1 / 24 h.
  private forgetKey(): void {
    const stored = this.loadKey();
    try {
      this.deps.storage.set(
        APP_ATTEST_KEY_STORAGE,
        JSON.stringify({ generatedAtMs: stored?.generatedAtMs ?? this.deps.now() })
      );
    } catch {
      // Best effort.
    }
  }
}

function boundFixBody(fix: AttestBoundFix): AttestBoundFix {
  return {
    lat: fix.lat,
    lon: fix.lon,
    ...(typeof fix.accuracy === "number" ? { accuracy: fix.accuracy } : {}),
    fixTimestampMs: Math.trunc(fix.fixTimestampMs)
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** fetch-backed AttestationApi; session cookie + CSRF like the other API clients. */
export function createAttestationHttpApi(
  serverHttpBase: string,
  csrfToken: string,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)
): AttestationApi {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(new URL(path, serverHttpBase).toString(), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body)
      });
    } catch {
      throw new AttestHttpError(0, "NETWORK");
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const code = (payload as { error?: { code?: unknown }; code?: unknown } | null);
      const value = typeof code?.error?.code === "string" ? code.error.code : typeof code?.code === "string" ? code.code : "UNKNOWN";
      throw new AttestHttpError(response.status, value);
    }
    if (!payload || typeof payload !== "object") throw new AttestHttpError(response.status, "MALFORMED");
    return payload as T;
  };
  return {
    challenge: (body) => post("/api/trust/attest/challenge", body),
    android: (body) => post("/api/trust/attest/android", body),
    iosKey: (body) => post("/api/trust/attest/ios/key", body),
    iosAssert: (body) => post("/api/trust/attest/ios/assert", body),
    iosDeviceCheck: (body) => post("/api/trust/attest/ios/devicecheck", body)
  };
}

function browserStorage(): AttestationManagerDeps["storage"] {
  return {
    get: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        if (value === null) globalThis.localStorage?.removeItem(key);
        else globalThis.localStorage?.setItem(key, value);
      } catch {
        // Best effort.
      }
    }
  };
}

function subscribeForeground(handler: (foreground: boolean) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onVisibility = (): void => handler(document.visibilityState !== "hidden");
  document.addEventListener("visibilitychange", onVisibility);
  const unsubscribeNative = subscribeNativeAppStateChange(handler);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    unsubscribeNative();
  };
}

/** The app-wide manager: App.tsx starts/stops it. */
export const deviceAttestation = new AttestationManager({
  detect: detectDeviceTrust,
  shellBuild: nativeShellBuild,
  storage: browserStorage(),
  isForeground: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  subscribeForeground,
  now: () => Date.now(),
  random: () => Math.random(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle)
});
