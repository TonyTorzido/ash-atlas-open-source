import { useEffect, useRef, useState } from "react";

import { BootScreen } from "./BootScreen.js";

// The scrim and pill wait a beat before appearing so brief reconnects don't flash.
function useDelayedFlag(delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (delayMs <= 0) {
      setShown(true);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  return shown;
}

export const UPDATE_AUTO_APPLY_DELAY_MS = 10_000;
// While playing, the update waits a little longer behind a compact banner.
export const IN_GAME_UPDATE_AUTO_APPLY_DELAY_MS = 15_000;

export type UpdateReadyDetails = Readonly<{
  version: string | null;
  sizeBytes: number | null;
  autoApplyAt: number;
}>;

type ConnectionRecoveryScreenProps = {
  state:
    | "reconnecting"
    | "offline"
    | "ended"
    | "startup_failed"
    | "content_loading"
    | "content_failed"
    | "bundle_loading"
    | "bundle_failed"
    | "bundle_blocked"
    | "update_applying"
    | "update_unreachable"
    | "update_ready"
    // A native seed bundle's one-time download of the full game (main.tsx).
    | "first_run_ready"
    | "first_run_loading";
  detail?: string;
  progress?: Readonly<{ loadedBytes: number; totalBytes: number | null }>;
  // Bundle downloads report their phase so an unknown size still reads as a download.
  phase?: "checking" | "downloading";
  update?: UpdateReadyDetails;
  // first_run_ready: the bytes the first-run download will fetch.
  downloadBytes?: number;
  presentation?: "blocking" | "embedded";
  onReconnect(): void;
  onContinue?(): void;
};

export function ConnectionRecoveryScreen({
  state,
  detail,
  progress,
  phase,
  update,
  downloadBytes,
  presentation = "blocking",
  onReconnect,
  onContinue
}: ConnectionRecoveryScreenProps): React.JSX.Element {
  const shown = useDelayedFlag(state === "offline" ? 0 : 700);
  const embedded = presentation === "embedded";
  if (state === "update_ready" && update) {
    return <UpdateReadyScreen update={update} embedded={embedded} onApply={onReconnect} />;
  }
  if (state === "first_run_ready" && downloadBytes !== undefined) {
    return <FirstRunDownloadScreen downloadBytes={downloadBytes} embedded={embedded} onDownload={onReconnect} />;
  }
  if (state === "update_applying") {
    return (
      <BootScreen
        title="Updating…"
        detail="Installing the latest version. Your progress is saved."
        progress={null}
        embedded={embedded}
      />
    );
  }
  if (state === "content_loading" || state === "bundle_loading" || state === "first_run_loading") {
    // Byte counts only show once the total is known; until then the bar is indeterminate.
    const totalBytes = progress?.totalBytes && progress.totalBytes > 0 ? progress.totalBytes : null;
    const loadedBytes = Math.min(progress?.loadedBytes ?? 0, totalBytes ?? Number.MAX_SAFE_INTEGER);
    const downloading = totalBytes !== null || phase === "downloading";
    const firstRun = state === "first_run_loading";
    return (
      <BootScreen
        title={firstRun
          ? downloading ? "Downloading Ash Atlas…" : "Preparing Ash Atlas…"
          : downloading ? "Downloading update…" : "Checking for updates…"}
        detail={totalBytes !== null
          ? `${formatContentBytes(loadedBytes)} of ${formatContentBytes(totalBytes)}`
          : firstRun
            ? downloading ? "Getting the game files." : "Checking the game download."
            : downloading
              ? "Getting the latest version."
              : "Making sure you have the latest version."}
        progress={totalBytes === null ? null : loadedBytes / totalBytes}
        progressLabel={firstRun ? "Game download progress" : "Update download progress"}
        embedded={embedded}
      />
    );
  }
  if (state === "reconnecting" || state === "offline") {
    // The world stays visible but paused under a light scrim; only a compact
    // status pill explains why input is held.
    const visible = embedded || shown;
    return (
      <div className={`connection-recovery${embedded ? " connection-recovery--embedded" : ""}${visible ? " is-shown" : ""}`}>
        {visible && (
          <ConnectionStatusPill
            label={state === "offline" ? "Offline" : "Reconnecting…"}
            detail={state === "offline" ? "Waiting for network" : undefined}
          />
        )}
      </div>
    );
  }
  const failure = state === "update_unreachable"
    ? {
        title: "Can’t reach Ash Atlas",
        detail: detail ?? "Check your connection. The game needs the latest version before it can start.",
        retry: "Try Again"
      }
    : state === "bundle_failed" || state === "bundle_blocked" || state === "content_failed"
    ? {
        title: state === "bundle_blocked" ? "Update blocked" : "Update unavailable",
        detail: detail ?? "Ash Atlas couldn’t finish the update.",
        retry: state !== "bundle_blocked" ? "Try Again" : null
      }
    : state === "startup_failed"
      ? {
          title: "Couldn’t finish loading",
          detail: "Something interrupted loading your world. Your progress is safe.",
          technical: detail,
          retry: "Try Again"
        }
      : { title: "Connection lost", detail: "Your progress is saved. Reconnect to continue where you left off.", retry: "Reconnect" };
  return (
    <BootScreen role="alert" title={failure.title} detail={failure.detail} showBar={false} embedded={embedded}>
      <div className="initial-curtain__update">
        {failure.retry ? (
          <button className="initial-curtain__action" type="button" onClick={onReconnect}>{failure.retry}</button>
        ) : null}
        {onContinue ? (
          <button className="initial-curtain__secondary" type="button" onClick={onContinue}>
            Continue with Current Version
          </button>
        ) : null}
        {"technical" in failure && failure.technical ? (
          <small className="initial-curtain__error">{failure.technical}</small>
        ) : null}
      </div>
    </BootScreen>
  );
}

// Compact top-center connection status, shared by reconnect, offline, and the
// passive planned-restart notice.
export function ConnectionStatusPill({
  label,
  detail
}: {
  label: string;
  detail?: string | undefined;
}): React.JSX.Element {
  return (
    <section
      className="connection-status-pill"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={detail ? `${label} · ${detail}` : label}
    >
      <span className="connection-status-pill__spinner" aria-hidden="true" />
      <strong>{label}</strong>
      {detail ? <small>{detail}</small> : null}
    </section>
  );
}

function formatContentBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const kilobytes = value / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

// A store install starts from a small seed bundle. Before anything downloads,
// the player sees the download size and chooses to start it (App Store 4.2.3).
function FirstRunDownloadScreen({
  downloadBytes,
  embedded,
  onDownload
}: {
  downloadBytes: number;
  embedded: boolean;
  onDownload(): void;
}): React.JSX.Element {
  const [started, setStarted] = useState(false);
  const cellular = (navigator as Navigator & { connection?: { type?: string } }).connection?.type === "cellular";
  return (
    <BootScreen
      role="alertdialog"
      title="Download Ash Atlas"
      detail="The rest of the game downloads once before you can play."
      showBar={false}
      embedded={embedded}
    >
      <div className="initial-curtain__update">
        <ul className="initial-curtain__facts" aria-label="Download details">
          <li>{formatContentBytes(downloadBytes)}</li>
          <li>{cellular ? "On mobile data" : "Wi-Fi recommended"}</li>
        </ul>
        <button
          type="button"
          onClick={() => {
            if (started) return;
            setStarted(true);
            onDownload();
          }}
          disabled={started}
          autoFocus
        >
          {started ? "Starting…" : "Download"}
        </button>
        <small>
          {cellular ? "Connect to Wi-Fi to avoid using mobile data." : "Keep Ash Atlas open until the download finishes."}
        </small>
      </div>
    </BootScreen>
  );
}

// A new build is ready. Play stays blocked here: the update applies itself when
// the countdown ends, or immediately when the player chooses Update now.
function UpdateReadyScreen({
  update,
  embedded,
  onApply
}: {
  update: UpdateReadyDetails;
  embedded: boolean;
  onApply(): void;
}): React.JSX.Element {
  const { remainingMs, seconds, applied, applyNow } = useUpdateCountdown(update.autoApplyAt, onApply);
  return (
    <BootScreen
      role="alertdialog"
      title="Update available"
      detail="A new version of Ash Atlas is ready. Your progress is saved."
      progress={1 - remainingMs / UPDATE_AUTO_APPLY_DELAY_MS}
      progressLabel="Time until the update starts"
      embedded={embedded}
    >
      <div className="initial-curtain__update">
        <ul className="initial-curtain__facts" aria-label="Update details">
          <li>{update.version ? `Version ${update.version}` : "New version"}</li>
          {update.sizeBytes ? <li>{formatContentBytes(update.sizeBytes)}</li> : null}
        </ul>
        <button type="button" onClick={applyNow} disabled={applied} autoFocus>
          {applied ? "Updating…" : "Update now"}
        </button>
        <small aria-live="off">
          {applied ? "Restarting with the new version…" : `Updating automatically in ${seconds}s`}
        </small>
      </div>
    </BootScreen>
  );
}

// Counts down to the update deadline and applies exactly once: at the deadline,
// or earlier when the player chooses to.
function useUpdateCountdown(autoApplyAt: number, onApply: () => void): Readonly<{
  remainingMs: number;
  seconds: number;
  applied: boolean;
  applyNow(): void;
}> {
  const [now, setNow] = useState(() => Date.now());
  const [applied, setApplied] = useState(false);
  const appliedRef = useRef(false);
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  useEffect(() => {
    appliedRef.current = false;
    setApplied(false);
    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      if (current >= autoApplyAt && !appliedRef.current) {
        appliedRef.current = true;
        setApplied(true);
        onApplyRef.current();
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [autoApplyAt]);

  const remainingMs = Math.max(0, autoApplyAt - now);
  return {
    remainingMs,
    seconds: Math.ceil(remainingMs / 1000),
    applied,
    applyNow: () => {
      if (appliedRef.current) return;
      appliedRef.current = true;
      setApplied(true);
      onApplyRef.current();
    }
  };
}

// In-game update notice: a compact banner under the chat bar with a countdown
// ring. The update applies itself when the countdown ends; Update now applies it
// immediately. The server stops admitting the old build shortly afterwards.
export function UpdateBanner({
  update,
  delayMs = IN_GAME_UPDATE_AUTO_APPLY_DELAY_MS,
  embedded = false,
  onApply
}: {
  update: UpdateReadyDetails;
  delayMs?: number;
  embedded?: boolean;
  onApply(): void;
}): React.JSX.Element {
  const { remainingMs, seconds, applied, applyNow } = useUpdateCountdown(update.autoApplyAt, onApply);
  const top = useTopBelowChatBar(embedded);
  const fraction = Math.min(1, Math.max(0, remainingMs / delayMs));
  const facts = [
    update.version ? `v${update.version}` : null,
    update.sizeBytes ? formatContentBytes(update.sizeBytes) : null
  ].filter(Boolean).join(" · ");
  return (
    <section
      className={`update-banner${embedded ? " update-banner--embedded" : ""}`}
      style={top === null ? undefined : { top }}
      role="status"
      aria-live="polite"
      aria-label={applied ? "Updating Ash Atlas" : `Update ready${facts ? `, ${facts}` : ""}. Updating automatically in ${seconds} seconds.`}
    >
      <span className="update-banner__ring" aria-hidden="true" data-applied={applied ? "" : undefined}>
        <svg viewBox="0 0 36 36">
          <circle className="update-banner__ring-track" cx="18" cy="18" r="15.5" />
          <circle
            className="update-banner__ring-fill"
            cx="18"
            cy="18"
            r="15.5"
            pathLength={100}
            strokeDasharray={`${applied ? 100 : fraction * 100} 100`}
          />
        </svg>
        <b>{applied ? "" : seconds}</b>
      </span>
      <span className="update-banner__copy" aria-hidden="true">
        <strong>{applied ? "Updating…" : "Update ready"}</strong>
        <small>{applied ? "Restarting with the new version" : facts || "A new version of Ash Atlas"}</small>
      </span>
      <button type="button" onClick={applyNow} disabled={applied}>
        {applied ? "Updating…" : "Update now"}
      </button>
    </section>
  );
}

// The chat bar's height and position differ by device and screen, so the
// banner measures it rather than hard-coding an offset.
function useTopBelowChatBar(disabled: boolean): number | null {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    if (disabled) return;
    const measure = (): void => {
      const bar = document.querySelector<HTMLElement>(".chat-top-bar");
      const rect = bar && bar.offsetParent !== null ? bar.getBoundingClientRect() : null;
      setTop(rect && rect.height > 0 ? Math.round(rect.bottom + 8) : null);
    };
    measure();
    const timer = window.setInterval(measure, 1000);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [disabled]);
  return top;
}
