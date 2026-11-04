import { useEffect, useState, useSyncExternalStore } from "react";

import { AshAtlasBrandLogo } from "../ui/AshAtlasBrandLogo.js";
import {
  initializeWebInstallPrompt,
  isAndroidBrowser,
  isInstallPromptAvailable,
  isIosSafari,
  isRunningAsInstalledApp,
  promptToInstall,
  subscribeInstallAvailability
} from "./installPrompt.js";
import "./pwaInstall.css";

const IOS_HINT_DISMISSED_KEY = "ash-atlas:pwa-install-hint-dismissed";

export function PwaInstallPrompt({
  instructionsPage = false,
  placement = "login"
}: {
  instructionsPage?: boolean;
  placement?: "login" | "game";
}): React.JSX.Element | null {
  const browserAvailable = typeof window !== "undefined";
  useEffect(() => {
    if (browserAvailable) initializeWebInstallPrompt();
  }, [browserAvailable]);
  const installAvailable = useSyncExternalStore(
    subscribeInstallAvailability,
    isInstallPromptAvailable,
    () => false
  );
  const [hintDismissed, setHintDismissed] = useState(() => browserAvailable && readIosHintDismissed());
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const iosSafari = browserAvailable && isIosSafari();
  const showIosInstructions = instructionsPage ? iosSafari : (!hintDismissed && iosSafari);
  const showAndroidInstructions = instructionsPage && browserAvailable && isAndroidBrowser();
  const showAndroidInstallButton = placement === "login" && installAvailable &&
    browserAvailable && isAndroidBrowser();

  if (!browserAvailable) return null;
  if (isRunningAsInstalledApp()) return null;
  if (!instructionsPage && !showAndroidInstallButton && !showIosInstructions && !installStatus) return null;
  if (instructionsPage && !showIosInstructions && !showAndroidInstructions) return null;

  const installApp = async (): Promise<void> => {
    try {
      const outcome = await promptToInstall();
      if (outcome === "accepted") setInstallStatus("Ash Atlas is installed. Open it from your Home screen or app list.");
    } catch {
      setInstallStatus("Chrome could not open the install prompt. Try Install app from Chrome’s menu.");
    }
  };

  if (instructionsPage) {
    return (
      <main className="auth-screen pwa-install-page">
        <section className="auth-card" aria-labelledby="pwa-install-title">
          <div className="auth-brand">
            <AshAtlasBrandLogo className="auth-brand-logo" />
            <span>Ash Atlas</span>
          </div>
          <h1 id="pwa-install-title">Install Ash Atlas</h1>
          {showIosInstructions ? <IosInstallInstructions /> : (
            <div className="pwa-install-guide-copy">
              <h2>On Android</h2>
              <p>Install Ash Atlas from Chrome, then open it from your Home screen or app list.</p>
              {installAvailable ? (
                <InstallButton onInstall={() => void installApp()} />
              ) : (
                <p>In Chrome, open the menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>
              )}
            </div>
          )}
          {installStatus ? <p role="status" className="pwa-install-status">{installStatus}</p> : null}
          <a className="auth-primary pwa-install-continue" href={continueUrl()}>
            Continue to Ash Atlas
          </a>
        </section>
      </main>
    );
  }

  return (
    <aside
      className={placement === "game" ? "pwa-install-prompt pwa-install-prompt-game" : "pwa-install-prompt"}
      aria-label="Install Ash Atlas"
    >
      {showAndroidInstallButton ? <InstallButton onInstall={() => void installApp()} /> : null}
      {showIosInstructions ? (
        <IosInstallHint
          gameHint={placement === "game"}
          onDismiss={() => {
            setHintDismissed(true);
            saveIosHintDismissed();
          }}
        />
      ) : null}
      {installStatus ? <span role="status" className="pwa-install-status">{installStatus}</span> : null}
    </aside>
  );
}

function InstallButton({ onInstall }: { onInstall(): void }): React.JSX.Element {
  return <button type="button" className="auth-primary pwa-install-button" onClick={onInstall}>Install Ash Atlas</button>;
}

function IosInstallInstructions(): React.JSX.Element {
  return (
    <div className="pwa-install-guide-copy">
      <h2>On iPhone</h2>
      <p>Tap Share, then <strong>Add to Home Screen</strong>.</p>
      <ShareIcon />
      <p>Tap <strong>Add</strong> to place Ash Atlas on your Home Screen.</p>
    </div>
  );
}

function IosInstallHint({ onDismiss, gameHint }: { onDismiss(): void; gameHint: boolean }): React.JSX.Element {
  return (
    <div className={gameHint ? "pwa-ios-install-hint pwa-ios-install-game-hint" : "pwa-ios-install-hint"} role="note">
      <ShareIcon />
      <span>Install: tap Share, then Add to Home Screen.</span>
      <button type="button" aria-label="Dismiss install instructions" className="menu-text-close" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

function ShareIcon(): React.JSX.Element {
  return (
    <svg className="pwa-share-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v8h14v-8" />
    </svg>
  );
}

function readIosHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(IOS_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveIosHintDismissed(): void {
  try {
    window.localStorage.setItem(IOS_HINT_DISMISSED_KEY, "1");
  } catch {
    // The hint remains dismissed for this view when browser storage is unavailable.
  }
}

function continueUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("install");
  return `${url.pathname}${url.search}${url.hash}`;
}
