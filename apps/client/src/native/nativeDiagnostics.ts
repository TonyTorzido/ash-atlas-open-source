import { Capacitor } from "@capacitor/core";
import { clientConfig } from "../config.js";
import { bugReportDiagnostics } from "../diagnostics/bugReportDiagnostics.js";

type NativeEvent = "launch" | "active" | "inactive" | "auth_request_failed" | "push_received" | "push_tapped" | "push_registered" | "push_failed" | "ota_rollback";
let runId: string | undefined;
/** No new telemetry destination: these breadcrumbs enter the existing opt-in bug report. */
export function recordNativeDiagnostic(event: NativeEvent, previousBundleId?: string): void {
  if (!Capacitor.isNativePlatform()) return;
  runId ??= `native:${Array.from(crypto.getRandomValues(new Uint8Array(16)),(byte) => byte.toString(16).padStart(2,"0")).join("")}`;
  const identity=[Capacitor.getPlatform(),clientConfig.nativeVersion,clientConfig.nativeBuild,clientConfig.buildSha?.slice(0,12) ?? "unknown"];
  const bundle = event === "ota_rollback" ? `:${(previousBundleId || "default").slice(0,128)}` : "";
  bugReportDiagnostics.recordNativeBoundary(`${event}:${identity.join(":")}${bundle}`,runId);
}
