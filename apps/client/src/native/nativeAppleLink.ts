import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import type { PluginListenerHandle } from "@capacitor/core";
import { nativeAuthRequest } from "./nativeRequest.js";

export async function linkAppleInNativeBrowser(base: string, csrfToken: string, signal?: AbortSignal): Promise<void> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  let listener: PluginListenerHandle | undefined;
  let browserListener: PluginListenerHandle | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let browserOpened = false;
  let abort = (): void => {};
  try {
    const started = await nativeAuthRequest(new URL("/api/auth/apple/link/start",base), { method:"POST",
      ...(signal ? { signal } : {}),
      headers: { "content-type":"application/json", "x-csrf-token":csrfToken },
      body: JSON.stringify({ nativeReturn:true,nativeReturnState:state }) });
    if (!started.ok) throw new Error("Apple linking could not be started. Try again.");
    const payload = await started.json() as { authorizationUrl: string };
    const url = new URL(payload.authorizationUrl);
    if (url.origin !== "https://appleid.apple.com") throw new Error("Apple linking returned an invalid destination.");
    signal?.throwIfAborted();
    let finish!: () => void;
    let reject!: (error: Error) => void;
    const returned = new Promise<void>((resolve,rejectPromise) => { finish=resolve; reject=rejectPromise; });
    void returned.catch(() => undefined);
    abort = () => reject(new Error("Apple linking was cancelled."));
    signal?.addEventListener("abort",abort,{ once:true });
    listener = await App.addListener("appUrlOpen",({ url: returnedUrl }) => {
      try {
        const callback = new URL(returnedUrl);
        if (callback.protocol === "com.ashatlas.game:" && callback.host === "auth" && callback.pathname === "/apple-link" && callback.searchParams.get("state") === state) finish();
      } catch { /* Ignore unrelated or malformed URLs. */ }
    });
    browserListener = await Browser.addListener("browserFinished",finish);
    timeout = setTimeout(() => reject(new Error("Apple linking timed out. You can try again.")),300_000);
    signal?.throwIfAborted();
    browserOpened = true;
    await Browser.open({ url:url.toString() });
    await returned;
    signal?.throwIfAborted();
    // A deep link is only a wake-up signal; the current authenticated session is
    // the authority for whether this exact linking transaction succeeded.
    const statusUrl = new URL("/api/auth/apple/link/status",base);
    statusUrl.searchParams.set("state",state);
    const response = await nativeAuthRequest(statusUrl,{ method:"GET",...(signal ? { signal } : {}) });
    const status = await response.json() as { status?: string };
    signal?.throwIfAborted();
    if (!response.ok || status.status !== "linked") throw new Error("Apple linking is not confirmed. Check your sign-in methods before trying again.");
  } finally {
    clearTimeout(timeout); signal?.removeEventListener("abort",abort);
    await listener?.remove(); await browserListener?.remove();
    if (browserOpened) await Browser.close().catch(() => undefined);
  }
}
