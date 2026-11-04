import { useState } from "react";

import type { ClientVersionSnapshot } from "../clientRelease.js";

function shortSha(sha: string | null): string {
  return sha?.slice(0, 4) ?? "?";
}

function shortBundleId(bundleId: string | null): string {
  if (!bundleId) return "built-in";
  return bundleId.length > 20 ? `${bundleId.slice(0, 16)}…` : bundleId;
}

function fullDetails(version: ClientVersionSnapshot): string {
  return [
    `Ash Atlas ${version.publicVersion ?? "unknown version"}`,
    `Generation: ${version.generation ?? "unknown"}`,
    `Client running: ${version.currentClientSha ?? "unknown"}`,
    `Client published: ${version.publishedClientSha ?? "unknown"}`,
    `Server running: ${version.currentServerSha ?? "unknown"}`,
    `Server published: ${version.publishedServerSha ?? "unknown"}`,
    `Protocol compatible: ${version.protocolCompatible === null ? "unknown" : version.protocolCompatible}`,
    ...(version.nativeShellBuild ? [`Native app: ${version.nativeShellBuild}`] : []),
    ...(version.nativeShellBuild ? [`Native bundle: ${version.nativeBundleId ?? "built-in"}`, "OTA TEST 2"] : [])
  ].join("\n");
}

export function VersionWatermark({ version }: {
  version: ClientVersionSnapshot;
}): React.JSX.Element {
  const [copyStatus, setCopyStatus] = useState("");
  const mismatch = version.clientMatchesPublished === false ||
    version.serverMatchesPublished === false ||
    version.protocolCompatible === false;
  const label = [
    version.publicVersion ? `v${version.publicVersion}` : "v?",
    version.generation?.replace(/^test\//u, "") ?? "t?",
    `C:${shortSha(version.currentClientSha)}`,
    `S:${shortSha(version.currentServerSha ?? version.publishedServerSha)}`,
    ...(version.nativeShellBuild ? [
      "OTA TEST 2",
      `app ${version.nativeShellBuild}`,
      `bundle ${shortBundleId(version.nativeBundleId)}`
    ] : [])
  ].join(" · ");

  return (
    <div className="version-watermark" data-mismatch={mismatch ? "true" : undefined}>
      <button
        type="button"
        className="version-watermark__copy"
        aria-label="Copy Ash Atlas version details"
        title="Copy version details for a bug report"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (!navigator.clipboard?.writeText) {
            setCopyStatus("Could not copy version details");
            return;
          }
          void navigator.clipboard.writeText(fullDetails(version)).then(
            () => setCopyStatus("Version details copied"),
            () => setCopyStatus("Could not copy version details")
          );
        }}
      >
        {label}
      </button>
      <span className="sr-only" role="status">{copyStatus}</span>
    </div>
  );
}
