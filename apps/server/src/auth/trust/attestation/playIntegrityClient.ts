import { GoogleAuth } from "google-auth-library";

// Play Integrity decodeIntegrityToken client (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.5).
// Never logs tokens or raw responses.

export type PlayIntegrityDecodeResult =
  | Readonly<{ status: "ok"; payload: unknown }>
  // Google rejected the token itself (malformed, forged, or for another app).
  | Readonly<{ status: "invalid"; code: string }>
  // Outage, quota, timeout, credentials: neutral.
  | Readonly<{ status: "unavailable"; code: string }>;

export type PlayIntegrityDecoder = (token: string) => Promise<PlayIntegrityDecodeResult>;

export type AccessTokenSource = Readonly<{ getAccessToken(): Promise<string | null> }>;

const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const MAX_RESPONSE_BYTES = 16_384;

/** GoogleAuth with base64 service-account JSON, or Application Default Credentials when empty. */
export function googleAccessTokenSource(credentialsJsonBase64: string): AccessTokenSource {
  const credentials = credentialsJsonBase64.trim()
    ? JSON.parse(Buffer.from(credentialsJsonBase64, "base64").toString("utf8")) as Record<string, unknown>
    : undefined;
  const auth = new GoogleAuth({ scopes: [PLAY_INTEGRITY_SCOPE], ...(credentials ? { credentials } : {}) });
  return {
    async getAccessToken() {
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      return token.token ?? null;
    }
  };
}

export function createPlayIntegrityDecoder(options: Readonly<{
  packageName: string;
  timeoutMs: number;
  auth: AccessTokenSource;
  fetch?: typeof fetch;
}>): PlayIntegrityDecoder {
  const fetchImpl = options.fetch ?? fetch;
  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(options.packageName)}:decodeIntegrityToken`;
  return async (token) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Credential loading may not honour abort, so the deadline races the whole call.
    const timeout = new Promise<PlayIntegrityDecodeResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "unavailable", code: "timeout" });
      }, options.timeoutMs);
    });
    const operation = (async (): Promise<PlayIntegrityDecodeResult> => {
      try {
        const accessToken = await options.auth.getAccessToken();
        if (!accessToken) return { status: "unavailable", code: "auth_unavailable" };
        if (controller.signal.aborted) return { status: "unavailable", code: "timeout" };
        const response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          redirect: "error",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ integrity_token: token })
        });
        if (response.status === 400) {
          await response.body?.cancel().catch(() => undefined);
          return { status: "invalid", code: "http_400" };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { status: "unavailable", code: `http_${response.status}` };
        }
        const payload = await boundedJson(response);
        return payload === null ? { status: "unavailable", code: "bad_response" } : { status: "ok", payload };
      } catch {
        return { status: "unavailable", code: controller.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    })();
    return Promise.race([operation, timeout]);
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) return null;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
