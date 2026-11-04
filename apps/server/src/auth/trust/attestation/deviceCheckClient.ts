import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";

// Apple DeviceCheck validate_device_token client (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.5).
// Used only when App Attest is unsupported. Never logs device tokens.

export type DeviceCheckResult = "valid" | "invalid" | "unavailable";
export type DeviceCheckValidator = (deviceToken: string) => Promise<DeviceCheckResult>;

const JWT_LIFETIME_MS = 40 * 60_000;

/** ES256 provider JWT (header kid, claims iss + iat), signed with node:crypto. */
export function deviceCheckJwt(key: KeyObject, keyId: string, teamId: string, nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) })).toString("base64url");
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${input}.${signature}`;
}

export type DeviceCheckBits = Readonly<{ bit0: boolean; bit1: boolean; lastUpdateTime: string | null }>;
/** Two-bit state, "unset" when Apple never stored bits for the device. */
export type DeviceCheckBitsResult = DeviceCheckBits | "unset" | "invalid" | "unavailable";
export type DeviceCheckBitsQuery = (deviceToken: string) => Promise<DeviceCheckBitsResult>;
export type DeviceCheckBitsUpdate = (
  deviceToken: string,
  bits: Readonly<{ bit0: boolean; bit1: boolean }>
) => Promise<"ok" | "invalid" | "unavailable">;

export type DeviceCheckClient = Readonly<{
  validate: DeviceCheckValidator;
  queryBits: DeviceCheckBitsQuery;
  updateBits: DeviceCheckBitsUpdate;
}>;

export type DeviceCheckClientOptions = Readonly<{
  teamId: string;
  keyId: string;
  // The .p8 file (PKCS#8 PEM), base64-encoded.
  privateKeyP8Base64: string;
  environment: "production" | "development";
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}>;

/** validate_device_token, query_two_bits and update_two_bits. Never logs device tokens. */
export function createDeviceCheckClient(options: DeviceCheckClientOptions): DeviceCheckClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const key = createPrivateKey(Buffer.from(options.privateKeyP8Base64, "base64"));
  const host = options.environment === "development"
    ? "https://api.development.devicecheck.apple.com"
    : "https://api.devicecheck.apple.com";
  let cached: { value: string; expiresAt: number } | undefined;
  const jwt = (): string => {
    const at = now();
    if (cached && cached.expiresAt > at) return cached.value;
    cached = { value: deviceCheckJwt(key, options.keyId, options.teamId, at), expiresAt: at + JWT_LIFETIME_MS };
    return cached.value;
  };
  const post = async <T>(
    path: string,
    body: Record<string, unknown>,
    read: (response: Response) => Promise<T>,
    failed: T
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetchImpl(`${host}${path}`, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, transaction_id: randomUUID(), timestamp: now() })
      });
      return await read(response);
    } catch {
      return failed;
    } finally {
      clearTimeout(timer);
    }
  };
  const status = async (response: Response): Promise<"ok" | "invalid" | "unavailable"> => {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 200) return "ok";
    if (response.status === 400) return "invalid";
    return "unavailable";
  };
  return {
    validate: async (deviceToken) => {
      const result = await post("/v1/validate_device_token", { device_token: deviceToken }, status, "unavailable" as const);
      return result === "ok" ? "valid" : result;
    },
    queryBits: (deviceToken) => post<DeviceCheckBitsResult>("/v1/query_two_bits", { device_token: deviceToken }, async (response) => {
      if (response.status === 400) {
        await response.body?.cancel().catch(() => undefined);
        return "invalid";
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return "unavailable";
      }
      // 200 with a plain-text "Failed to find bit state" body means never set.
      const text = (await response.text()).slice(0, 1024);
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.bit0 === "boolean" && typeof parsed.bit1 === "boolean") {
          return {
            bit0: parsed.bit0,
            bit1: parsed.bit1,
            lastUpdateTime: typeof parsed.last_update_time === "string" ? parsed.last_update_time.slice(0, 16) : null
          };
        }
      } catch {
        // Not JSON: the unset answer.
      }
      return "unset";
    }, "unavailable"),
    updateBits: (deviceToken, bits) =>
      post("/v1/update_two_bits", { device_token: deviceToken, bit0: bits.bit0, bit1: bits.bit1 }, status, "unavailable" as const)
  };
}

/** validate_device_token only (DeviceCheck as the attestation method). */
export function createDeviceCheckValidator(options: DeviceCheckClientOptions): DeviceCheckValidator {
  return createDeviceCheckClient(options).validate;
}
