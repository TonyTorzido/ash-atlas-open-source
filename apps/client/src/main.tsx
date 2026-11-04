import "maplibre-gl/dist/maplibre-gl.css";
import "pixi.js/unsafe-eval";

import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { PwaInstallPrompt } from "./pwa/PwaInstallPrompt.js";
import { initializeWebInstallPrompt, shouldOpenInstallInstructions } from "./pwa/installPrompt.js";
import { initializeNativePush } from "./native/nativePush.js";
import { recordNativeDiagnostic } from "./native/nativeDiagnostics.js";
import { migrateBrowserStateBeforeGameplay } from "./browserStateMigration.js";
import { clientConfig, runtimeDocumentTitle } from "./config.js";
import { preventDocumentGestureZoom, preventDocumentWheelZoom } from "./documentZoom.js";
import { applyUiScale, readUiScale } from "./ui/uiScale.js";
import { installSoftKeyboardTracking } from "./ui/softKeyboard.js";
import { startPerfProbe } from "./perf/perfProbe.js";
import { readClickDelayMs } from "./movement/clickDelayPreference.js";
import { setWorldMapClickConfirmationMs } from "./movement/worldMapClickArbitrator.js";
import {
  configureNativeSystemBars,
  configureNativeTextureLoading,
  initializeNativeViewportRootState,
  installNativeFetchBridge,
  isNativeApp,
  nativePlatform
} from "./native/nativeApp.js";
import {
  markNativeLiveUpdateReady,
  prepareNativeLiveUpdate,
  readNativeUpdateDownloadBytes,
  restoreKeptNativeBundle,
  type NativeLiveUpdateProgress
} from "./native/nativeLiveUpdate.js";
import type { NativeBundleDescriptor } from "@ash-atlas/shared";
import { applyClientUpdate, navigateToFreshClient } from "./freshClientNavigation.js";
import { sanitizeTransientMobileChatState } from "./mobileKeyboardDocking.js";
import { PresentationShell } from "./PresentationShell.js";
import { ConnectionRecoveryScreen } from "./ui/ConnectionRecoveryScreen.js";
import { ClientUpdateHelpScreen } from "./ui/ClientUpdateStatus.js";
import { WikiApp } from "./wiki/WikiApp.js";
import {
  initializeUiEnvironmentRootState,
  UiEnvironmentProvider
} from "./uiEnvironment.js";
import "./styles.css";
import "./ashAtlasTheme.css";
import "./phoneBottomDock.css";
import "./presentationShell.css";
import "./menuAppearance.css";
import "./desktopPresentation.css";
import "./hudLanes.css";
import "./medievalFinish.css";

document.addEventListener("gesturestart", preventDocumentGestureZoom, { passive: false });
document.addEventListener("gesturechange", preventDocumentGestureZoom, { passive: false });
document.addEventListener("wheel", preventDocumentWheelZoom, { passive: false });
installSoftKeyboardTracking();
applyUiScale(readUiScale());
setWorldMapClickConfirmationMs(readClickDelayMs());

document.title = runtimeDocumentTitle(document.title || "Ash Atlas", clientConfig.runtimeIdentity);
initializeWebInstallPrompt();
configureNativeTextureLoading();
initializeNativeViewportRootState();
void configureNativeSystemBars();
installNativeFetchBridge([
  clientConfig.serverHttpBase,
  clientConfig.worldApiBase
]);
initializeUiEnvironmentRootState();
startPerfProbe();
void initializeNativePush();
recordNativeDiagnostic("launch");

const rootElement = document.getElementById("root") as HTMLElement;
const root = createRoot(rootElement);
const updateTarget = {
  platform: isNativeApp() ? nativePlatform() ?? "ios" : "web",
  reason: "preload-error"
} as const;
const showClientUpdateHelp = (): void => {
  root.render(
    <StrictMode>
      <ClientUpdateHelpScreen
        onTryAgain={() => {
          void applyClientUpdate({
            ...updateTarget,
            reason: "manual",
            restartAttempts: true
          }).then((result) => {
            if (result === "exhausted") showClientUpdateHelp();
          });
        }}
      />
    </StrictMode>
  );
};
window.addEventListener("vite:preloadError", (event) => {
  if (updateTarget.platform !== "web") {
    void applyClientUpdate(updateTarget);
    return;
  }
  event.preventDefault();
  void applyClientUpdate(updateTarget).then((result) => {
    if (result === "exhausted") showClientUpdateHelp();
  });
});
// A store install starts from the seed bundle (src/native/nativeSeedBundle.ts),
// which holds no game art and so never starts the game: it asks before
// downloading the full signed bundle and blocks until that bundle reloads in.
const nativeSeedBundle = clientConfig.nativeSeedBundle === true && isNativeApp();
const isWikiRoute = !nativeSeedBundle &&
  (window.location.pathname === "/wiki" || window.location.pathname.startsWith("/wiki/"));
let seedDownloadAccepted = false;
class SeedDownloadSizeUnavailableError extends Error {}
const confirmSeedDownload = async (descriptor: NativeBundleDescriptor): Promise<void> => {
  if (seedDownloadAccepted) return;
  const downloadBytes = await readNativeUpdateDownloadBytes(descriptor);
  if (downloadBytes === null) throw new SeedDownloadSizeUnavailableError();
  await new Promise<void>((accept) => {
    root.render(
      <StrictMode>
        <ConnectionRecoveryScreen state="first_run_ready" downloadBytes={downloadBytes} onReconnect={accept} />
      </StrictMode>
    );
  });
  seedDownloadAccepted = true;
};
const showNativeUpdateProgress = (progress: NativeLiveUpdateProgress): void => {
  root.render(
    <StrictMode>
      <ConnectionRecoveryScreen
        state={nativeSeedBundle ? "first_run_loading" : "bundle_loading"}
        phase={progress.phase}
        progress={progress.phase === "checking"
          ? { loadedBytes: 0, totalBytes: null }
          : { loadedBytes: progress.loadedBytes, totalBytes: progress.totalBytes }}
        onReconnect={() => undefined}
      />
    </StrictMode>
  );
};
type NativeLaunchBlock = Readonly<{ state: "bundle_failed" | "update_unreachable"; detail: string }>;

// One launch check. Returns null when this bundle may start, or why it may not.
// A successful update reloads the page, so that path never resolves.
const runNativeLaunchUpdate = async (showProgress: boolean): Promise<NativeLaunchBlock | null> => {
  let lastPaintAt = 0;
  try {
    const result = await prepareNativeLiveUpdate({
      checkTimeoutMs: 4_000,
      applyOnDownload: true,
      reloadOnApply: true,
      ...(nativeSeedBundle ? { onUpdateFound: confirmSeedDownload } : {}),
      onProgress: (progress) => {
        if (showProgress && (progress.phase === "checking" || progress.loadedBytes === 0 ||
          progress.totalBytes === progress.loadedBytes || performance.now() - lastPaintAt >= 100)) {
          lastPaintAt = performance.now();
          showNativeUpdateProgress(progress);
        }
      }
    });
    switch (result.kind) {
      case "current":
        // The seed can't play; the server has no full bundle to offer right now.
        return nativeSeedBundle
          ? { state: "bundle_failed", detail: "The game download isn’t available right now. Try again shortly." }
          : null;
      case "skipped":
        return null;
      case "reloaded":
        return await new Promise<never>(() => undefined);
      case "unavailable":
        return {
          state: "update_unreachable",
          detail: nativeSeedBundle
            ? "Check your connection. Ash Atlas needs to download the rest of the game before it can start."
            : "Check your connection. The game needs the latest version before it can start."
        };
      case "shell_update_required":
        return { state: "bundle_failed", detail: `Update the Ash Atlas app to build ${result.requiredBuild} or newer, then try again.` };
      case "protocol_incompatible":
        return { state: "bundle_failed", detail: "The latest update isn’t compatible with the server yet. Try again shortly." };
      case "blocked":
        return { state: "bundle_failed", detail: "The latest update couldn’t start on this device. Try again, or reinstall the app if this keeps happening." };
      case "failed":
        return { state: "bundle_failed", detail: result.message };
      default:
        return { state: "bundle_failed", detail: "The latest update isn’t ready yet. Try again." };
    }
  } catch (error) {
    if (error instanceof SeedDownloadSizeUnavailableError) {
      return { state: "update_unreachable", detail: "Ash Atlas couldn’t check the download size. Check your connection and try again." };
    }
    return {
      state: "bundle_failed",
      detail: error instanceof Error && error.message ? error.message : "Ash Atlas couldn’t finish the update."
    };
  }
};
// Native launch never falls through to an older bundle: it resolves only when
// this bundle is current, and otherwise waits on a blocking screen for Try again.
const checkNativeLaunchUpdate = async (showProgress: boolean): Promise<void> => {
  if (!isNativeApp()) return;
  if (!showProgress) {
    await runNativeLaunchUpdate(false);
    return;
  }
  for (;;) {
    const block = await runNativeLaunchUpdate(true);
    if (!block) return;
    await new Promise<void>((retry) => {
      root.render(
        <StrictMode>
          <ConnectionRecoveryScreen state={block.state} detail={block.detail} onReconnect={retry} />
        </StrictMode>
      );
    });
  }
};
if (isWikiRoute) {
  flushSync(() => {
    root.render(
      <StrictMode>
        <WikiApp />
      </StrictMode>
    );
  });
  void markNativeLiveUpdateReady();
  void checkNativeLaunchUpdate(false);
} else if (!clientConfig.nativePlatform && shouldOpenInstallInstructions()) {
  root.render(
    <StrictMode>
      <PwaInstallPrompt instructionsPage />
    </StrictMode>
  );
} else {
  sanitizeTransientMobileChatState();
  if (isNativeApp()) {
    flushSync(() => {
      showNativeUpdateProgress({ phase: "checking", loadedBytes: 0, totalBytes: null });
    });
    if (nativeSeedBundle) {
      // After a store update, go back to the full bundle already on the device.
      if (await restoreKeptNativeBundle()) await new Promise<never>(() => undefined);
    } else {
      void markNativeLiveUpdateReady();
    }
    await checkNativeLaunchUpdate(true);
  }

  const browserStateMigration = await migrateBrowserStateBeforeGameplay();
  if (browserStateMigration.refreshRequired) {
    if (isNativeApp()) {
      navigateToFreshClient({ reason: "update" });
    } else {
      void applyClientUpdate({ platform: "web", reason: "manual" }).then((result) => {
        if (result === "exhausted") showClientUpdateHelp();
      });
    }
  } else {
    // Signed-in art packs load after sign-in (RuntimePngContentGate), never anonymously.
    root.render(
      <StrictMode><UiEnvironmentProvider><PresentationShell><App /></PresentationShell></UiEnvironmentProvider></StrictMode>
    );
  }
}
