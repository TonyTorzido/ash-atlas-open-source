import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getKeyboardDiagnosticReport,
  getMobileKeyboardDockingSnapshot,
  setKeyboardDiagnosticsEnabled,
  subscribeMobileKeyboardDocking
} from "../mobileKeyboardDocking.js";

export function KeyboardDebugPanel({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  useSyncExternalStore(
    subscribeMobileKeyboardDocking,
    getMobileKeyboardDockingSnapshot,
    getMobileKeyboardDockingSnapshot
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setKeyboardDiagnosticsEnabled(enabled);
    return () => setKeyboardDiagnosticsEnabled(false);
  }, [enabled]);

  const report = enabled ? getKeyboardDiagnosticReport() : null;
  if (!enabled || !report) return null;

  const current = report.current;
  const visual = current.visualViewport;
  const latestEvents = report.events.slice(-10);
  const copyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <aside
      className="keyboard-debug-panel"
      data-expanded={expanded ? "true" : "false"}
      aria-label="Mobile keyboard diagnostics"
    >
      {expanded ? (
        <header>
          <strong>Keyboard diagnostics</strong>
          <div className="keyboard-debug-actions">
            <button type="button" onClick={() => setExpanded(false)}>Hide</button>
            <button type="button" onClick={() => { void copyDiagnostics(); }}>
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy diagnostics"}
            </button>
          </div>
        </header>
      ) : (
        <button type="button" onClick={() => setExpanded(true)}>Show KB debug</button>
      )}
      {expanded ? <>
        <div className="keyboard-debug-grid">
          <span>time</span><b>{new Date(current.timestamp).toISOString()}</b>
          <span>mode</span><b>{current.standalone ? "standalone" : "browser"} / {current.orientation}</b>
          <span>coordinates</span><b>{current.coordinateSystem}</b>
          <span>transition</span><b>{current.phase} / focus {String(current.focused)}</b>
          <span>chat</span><b>{current.activeChatType}</b>
          <span>document scroll</span><b>window {round(current.windowScrollX)},{round(current.windowScrollY)} / root {round(current.documentScrollLeft)},{round(current.documentScrollTop)}</b>
          <span>root lock</span><b>{current.iosStandaloneChatRootLockActive ? "active" : "inactive"} / saved {current.lockedScrollPosition ? `${round(current.lockedScrollPosition.x)},${round(current.lockedScrollPosition.y)}` : "n/a"}</b>
          <span>window</span><b>{window.innerWidth}×{current.windowInnerHeight}; client {current.documentClientHeight}</b>
          <span>visual</span><b>{visual ? `${round(visual.width)}×${round(visual.height)} @ ${round(visual.offsetLeft)},${round(visual.offsetTop)}` : "unavailable"}</b>
          <span>safe area</span><b>{formatInsets(current.safeArea)}</b>
          <span>baseline</span><b>{round(current.baselineHeight)}px</b>
          <span>occlusion</span><b>{round(current.keyboardOcclusion)}px</b>
          <span>raw boundary</span><b>{round(current.rawCandidateBoundary)}px</b>
          <span>raw inset</span><b>{round(current.rawCandidateInset)}px</b>
          <span>candidate</span><b>{current.candidateAccepted ? "accepted" : "rejected"} / {current.candidateDecisionReason}</b>
          <span>selected boundary</span><b>{round(current.keyboardBoundary)}px</b>
          <span>accepted inset</span><b>{round(current.acceptedCandidateInset)}px</b>
          <span>committed inset</span><b>{round(current.committedKeyboardInset)}px</b>
          <span>opening changes</span><b>raw {current.rawCandidateChangeCount} / committed {current.committedInsetUpdateCount}</b>
          <span>first contraction</span><b>{formatDuration(current.focusToFirstContractedMs)}</b>
          <span>first commit</span><b>{formatDuration(current.focusToCommittedInsetMs)}</b>
          <span>composer before</span><b>{formatRect(current.composerRectBeforeCommit)}</b>
          <span>composer after</span><b>{formatRect(current.composerRectAfterCommit)}</b>
          <span>composer</span><b>{formatRect(current.composerRect)}</b>
          <span>message region</span><b>{formatRect(current.messageRegionRect)}</b>
          <span>overlay</span><b>{formatRect(current.overlayRect)}</b>
          <span>final gap</span><b>{current.composerGap === null ? "n/a" : `${round(current.composerGap)}px`}</b>
          <span>last event</span><b>{current.lastEvent}</b>
        </div>
        <details>
          <summary>CSS and layer state</summary>
          <pre>{JSON.stringify({
            css: current.cssProperties,
            layers: current.layers,
            invariants: current.invariants
          }, null, 2)}</pre>
        </details>
        <details open>
          <summary>Recent events ({report.events.length})</summary>
          <ol>
            {latestEvents.map((event) => (
              <li key={event.sequence}>
                {event.sequence} {event.event} · {event.phase} · gap {event.composerGap === null ? "n/a" : round(event.composerGap)}
              </li>
            ))}
          </ol>
        </details>
      </> : null}
    </aside>
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatRect(rect: { top: number; bottom: number; height: number } | null): string {
  return rect ? `${round(rect.top)}→${round(rect.bottom)} (${round(rect.height)}px)` : "n/a";
}

function formatInsets(insets: { top: number; right: number; bottom: number; left: number }): string {
  return `${round(insets.top)} ${round(insets.right)} ${round(insets.bottom)} ${round(insets.left)}`;
}

function formatDuration(value: number | null): string {
  return value === null ? "n/a" : `${round(value)}ms`;
}
