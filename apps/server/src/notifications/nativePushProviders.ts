import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";
import { GoogleAuth } from "google-auth-library";
import type { AppConfig } from "../config.js";

export const PUSH_SEND_TIMEOUT_MS = 10_000;
export type PushEnvelope = { id: string; targetId: string; token: string; provider: "apns" | "fcm"; environment: "sandbox" | "production"; kind: string; collapseKey: string; expiresAt: Date; deadlineAt?: number; beforeDispatch: () => Promise<boolean> };
export type PushSendResult = { outcome: "sent" | "retry" | "invalid_token" | "failed" | "suppressed"; code: string };
export type PushSender = (message: PushEnvelope) => Promise<PushSendResult>;

/** Only generic text and an opaque delivery ID leave the server. */
export function pushDisplayPayload(id: string) {
  return { title: "Ash Atlas", body: "You have an update in Messages.", data: { deliveryId: id } };
}

export function createNativePushSender(config: AppConfig): PushSender {
  let google: GoogleAuth | undefined;
  let appleJwt: { value: string; expiresAt: number } | undefined;
  // A deadline returns control to the worker, but never releases this fence until
  // the underlying operation settles. In particular, ADC may not support abort.
  const outstanding = new Set<string>();
  const jwt = (): string => {
    if (appleJwt && appleJwt.expiresAt > Date.now()) return appleJwt.value;
    if (!config.NATIVE_PUSH_APNS_PRIVATE_KEY_BASE64 || !config.NATIVE_PUSH_APNS_KEY_ID || !config.NATIVE_PUSH_APNS_TEAM_ID) throw new Error("APNs not configured");
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.NATIVE_PUSH_APNS_KEY_ID })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: config.NATIVE_PUSH_APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
    const key = createPrivateKey(Buffer.from(config.NATIVE_PUSH_APNS_PRIVATE_KEY_BASE64, "base64"));
    const input = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    appleJwt = { value: `${input}.${signature}`, expiresAt: Date.now() + 40 * 60_000 };
    return appleJwt.value;
  };
  return async (message) => {
    if (message.expiresAt.getTime() <= Date.now()) return { outcome: "failed", code: "expired" };
    const deadline = Math.min(Date.now() + PUSH_SEND_TIMEOUT_MS, message.deadlineAt ?? Infinity, message.expiresAt.getTime());
    if (deadline <= Date.now()) return { outcome: "retry", code: "provider_deadline" };
    if (outstanding.has(message.targetId)) return { outcome: "retry", code: "provider_in_flight" };
    outstanding.add(message.targetId);
    const controller = new AbortController();
    const active = (): void => {
      if (controller.signal.aborted || Date.now() >= deadline) throw new Error("Push deadline elapsed");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PushSendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ outcome: "retry", code: "provider_timeout" });
      }, Math.max(0, deadline - Date.now()));
    });
    const operation = (async (): Promise<PushSendResult> => {
      try {
        const payload = pushDisplayPayload(message.id);
        active();
        if (message.provider === "apns") {
          const token = jwt();
          active();
          if (!await message.beforeDispatch()) return { outcome: "suppressed", code: "state_changed" };
          active();
          return await sendApns(message, config.NATIVE_PUSH_APNS_TOPIC, token, payload, controller.signal);
        }
        if (!config.NATIVE_PUSH_FCM_PROJECT_ID) return { outcome: "retry", code: "provider_unconfigured" };
        google ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
        const client = await google.getClient();
        active();
        const token = await client.getAccessToken();
        active();
        if (!token.token) return { outcome: "retry", code: "provider_auth_unavailable" };
        // Credential loading may outlive logout, token rotation, or a source read.
        // Recheck authority after that wait, inside the same bounded operation.
        if (!await message.beforeDispatch()) return { outcome: "suppressed", code: "state_changed" };
        active();
        // Separate credential acquisition from transport so a late ADC/token result
        // cannot initiate a send after the lease deadline. No automatic HTTP retry.
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.NATIVE_PUSH_FCM_PROJECT_ID)}/messages:send`, {
          method: "POST", signal: controller.signal, redirect: "error",
          headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { token: message.token, notification: { title: payload.title, body: payload.body }, data: payload.data,
            android: { priority: "normal", ttl: `${Math.max(0, Math.floor((message.expiresAt.getTime() - Date.now()) / 1000))}s`,
              collapse_key: message.kind, notification: { channel_id: "messages", tag: message.collapseKey } } } })
        });
        if (response.ok) { await response.body?.cancel(); return { outcome: "sent", code: "accepted" }; }
        // Parse only a bounded diagnostic for classification; never log raw bodies.
        const diagnostic = await boundedJson(response);
        if (response.status === 404 && Array.isArray(diagnostic?.error?.details) && diagnostic.error.details.some((detail) => detail?.errorCode === "UNREGISTERED")) {
          return { outcome: "invalid_token", code: "unregistered" };
        }
        return { outcome: response.status === 429 || response.status >= 500 ? "retry" : "failed", code: `fcm_${response.status}` };
      } catch { return { outcome: "retry", code: controller.signal.aborted ? "provider_timeout" : "provider_unavailable" }; }
      finally { clearTimeout(timer); outstanding.delete(message.targetId); }
    })();
    return Promise.race([operation, timeout]);
  };
}

async function boundedJson(response: Response): Promise<{ error?: { details?: { errorCode?: string }[] } } | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 8192) return null;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
  finally { await reader.cancel().catch(() => undefined); }
}

export function classifyApnsResponse(status: number, reason: unknown): PushSendResult {
  if (status === 200) return { outcome: "sent", code: "accepted" };
  if ((status === 410 && reason === "Unregistered") || (status === 400 && reason === "BadDeviceToken")) {
    return { outcome: "invalid_token", code: reason === "Unregistered" ? "unregistered" : "bad_device_token" };
  }
  // Topic/auth/configuration errors must never revoke a good device token.
  return { outcome: status === 429 || status >= 500 ? "retry" : "failed", code: `apns_${status}` };
}

function sendApns(message: PushEnvelope, topic: string, jwt: string, payload: ReturnType<typeof pushDisplayPayload>, signal: AbortSignal): Promise<PushSendResult> {
  return new Promise((resolve) => {
    const session = connect(message.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
    let finished = false;
    let status = 0;
    let diagnostic = "";
    const finish = (result: PushSendResult): void => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort); session.destroy(); resolve(result);
    };
    const abort = (): void => finish({ outcome: "retry", code: "provider_timeout" });
    signal.addEventListener("abort", abort, { once: true });
    session.on("error", () => finish({ outcome: "retry", code: "apns_transport" }));
    if (signal.aborted) { abort(); return; }
    try {
      const request = session.request({ ":method": "POST", ":path": `/3/device/${message.token}`, authorization: `bearer ${jwt}`,
        "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "5", "apns-id": message.id,
        "apns-expiration": String(Math.floor(message.expiresAt.getTime() / 1000)), "apns-collapse-id": message.collapseKey });
      request.on("response", (headers) => { status = Number(headers[":status"]); });
      request.on("data", (chunk: Buffer) => {
        if (diagnostic.length + chunk.length > 1024) { finish({ outcome: "retry", code: "apns_response_invalid" }); return; }
        diagnostic += chunk.toString("utf8");
      });
      request.on("error", () => finish({ outcome: "retry", code: "apns_transport" }));
      request.on("end", () => {
        let reason: unknown;
        try { reason = JSON.parse(diagnostic).reason; } catch { /* Unknown response never invalidates a token. */ }
        finish(classifyApnsResponse(status, reason));
      });
      request.end(JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body } }, ...payload.data }));
    } catch { finish({ outcome: "retry", code: "apns_transport" }); }
  });
}
