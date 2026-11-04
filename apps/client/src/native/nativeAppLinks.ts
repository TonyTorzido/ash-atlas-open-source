import { App, type URLOpenListenerEvent } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Universal Links (iOS associated domain) and verified Android App Links for
 * https://playashatlas.com/link/... arrive through @capacitor/app: a cold start
 * exposes the URL via getLaunchUrl(), a running app gets "appUrlOpen".
 * Nothing subscribes yet; the link scheme is dormant until the server emits
 * /link/ URLs (hosted association files: apps/client/public/.well-known).
 */

export const APP_LINK_ORIGIN = "https://playashatlas.com";
export const APP_LINK_PATH_PREFIX = "/link/";

export function parseAppLink(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.origin === APP_LINK_ORIGIN && url.pathname.startsWith(APP_LINK_PATH_PREFIX) ? url : null;
  } catch {
    return null;
  }
}

/** Delivers the launch link (if any) and every later app link to `handler`. */
export async function listenForAppLinks(handler: (url: URL) => void): Promise<PluginListenerHandle> {
  const listener = await App.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
    const url = parseAppLink(event.url);
    if (url) handler(url);
  });
  const launch = await App.getLaunchUrl().catch(() => undefined);
  const launchUrl = launch?.url ? parseAppLink(launch.url) : null;
  if (launchUrl) handler(launchUrl);
  return listener;
}
