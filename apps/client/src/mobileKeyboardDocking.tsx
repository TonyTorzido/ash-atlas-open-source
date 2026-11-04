import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type HTMLAttributes,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { flushSync } from "react-dom";

import { mobileMenuViewFromHistoryState } from "./mobileGameMenu.js";

export type MobileKeyboardPhase = "closed" | "opening" | "open" | "closing";
export type MobileChatType = "public" | "direct" | "none";

export type MobileKeyboardDockingSnapshot = {
  timestamp: number;
  phase: MobileKeyboardPhase;
  focused: boolean;
  standalone: boolean;
  orientation: "portrait" | "landscape";
  baselineHeight: number;
  keyboardOcclusion: number;
  viewport: {
    top: number;
    left: number;
    width: number;
    height: number;
    bottom: number;
  };
  activeChatType: MobileChatType;
  windowScrollX: number;
  windowScrollY: number;
  documentScrollLeft: number;
  documentScrollTop: number;
  iosStandaloneChatRootLockActive: boolean;
  lockedScrollPosition: ScrollPosition | null;
  overlayRect: RectSnapshot | null;
  composerRect: RectSnapshot | null;
  rawCandidateBoundary: number;
  rawCandidateInset: number;
  candidateAccepted: boolean;
  candidateDecisionReason: string;
  keyboardBoundary: number;
  keyboardInset: number;
  acceptedCandidateInset: number;
  committedKeyboardInset: number;
  appliedDockInset: number;
  rawCandidateChangeCount: number;
  committedInsetUpdateCount: number;
  keyboardGeneration: number;
  activeTextElement: string | null;
  focusToFirstContractedMs: number | null;
  focusToCommittedInsetMs: number | null;
  composerRectBeforeCommit: RectSnapshot | null;
  composerRectAfterCommit: RectSnapshot | null;
  messageRegionRect: RectSnapshot | null;
  fullOverlayGeometryStable: boolean;
  overlayHeightChanged: boolean;
  composerGap: number | null;
  lastEvent: string;
};

export type KeyboardDiagnosticEvent = {
  sequence: number;
  timestamp: number;
  event: string;
  phase: MobileKeyboardPhase;
  focused: boolean;
  activeChatType: MobileChatType;
  innerHeight: number;
  clientHeight: number;
  windowScrollX: number;
  windowScrollY: number;
  documentScrollLeft: number;
  documentScrollTop: number;
  iosStandaloneChatRootLockActive: boolean;
  lockedScrollPosition: ScrollPosition | null;
  visualViewport: {
    width: number;
    height: number;
    offsetTop: number;
    offsetLeft: number;
    bottom: number;
  } | null;
  overlayRect: RectSnapshot | null;
  composerRect: RectSnapshot | null;
  messageRegionRect: RectSnapshot | null;
  baselineHeight: number;
  keyboardOcclusion: number;
  rawCandidateBoundary: number;
  rawCandidateInset: number;
  candidateAccepted: boolean;
  candidateDecisionReason: string;
  keyboardBoundary: number;
  keyboardInset: number;
  acceptedCandidateInset: number;
  committedKeyboardInset: number;
  appliedDockInset: number;
  rawCandidateChangeCount: number;
  committedInsetUpdateCount: number;
  keyboardGeneration: number;
  activeTextElement: string | null;
  overlayHeightChanged: boolean;
  composerGap: number | null;
};

type RectSnapshot = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

type ScrollPosition = {
  x: number;
  y: number;
};

type OverlayRegistration = {
  element: HTMLElement;
  protection: HTMLElement;
  type: Exclude<MobileChatType, "none">;
  order: number;
  onInvalid(reason: string): void;
};

type MobileKeyboardTransitionSnapshot = Pick<
  MobileKeyboardDockingSnapshot,
  "phase" | "focused" | "activeChatType"
>;

type IosStandaloneOpeningSample = {
  scheduledAtMs: number;
  elapsedMs: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  boundary: number;
  inset: number;
  valid: boolean;
};

const KEYBOARD_OCCLUSION_THRESHOLD_PX = 48;
const GEOMETRY_STABLE_TOLERANCE_PX = 1;
const GEOMETRY_STABLE_FRAME_COUNT = 2;
const OPENING_GRACE_MS = 180;
const OPENING_COMMIT_FALLBACK_MS = 180;
const IOS_STANDALONE_OPENING_SAMPLE_DELAYS_MS = [50, 100, 150, 250] as const;
const IOS_STANDALONE_MIN_COMMIT_DELAY_MS = 75;
const IOS_STANDALONE_ZERO_TOP_PROVISIONAL_MS = 150;
const IOS_STANDALONE_SAMPLE_MIN_SEPARATION_MS = 25;
const IOS_STANDALONE_BOUNDARY_TOLERANCE_PX = 4;
const KEYBOARD_CLOSED_BOUNDARY_TOLERANCE_PX = 4;
const IOS_STANDALONE_LARGE_CORRECTION_PX = 64;
const SETTLING_FRAME_BUDGET = 12;
const CLOSING_FALLBACK_MS = 650;
const MAX_DOCK_FRACTION = 0.65;
const DIAGNOSTIC_HISTORY_LIMIT = 160;
const CHAT_PROTECTION_OPEN_FRAME_BUDGET = 4;
const CHAT_PROTECTION_FAILURE_FRAME_LIMIT = 2;
const CHAT_PROTECTION_DIAGNOSTIC_LIMIT = 20;
export const MOBILE_KEYBOARD_SETTLED_EVENT = "ashatlas:mobile-keyboard-settled";
export const MOBILE_KEYBOARD_COMMITTED_EVENT = "ashatlas:mobile-keyboard-committed";

const listeners = new Set<() => void>();
const overlays = new Map<HTMLElement, OverlayRegistration>();
const baselineByOrientation = new Map<"portrait" | "landscape", number>();
const acceptedBoundaryByOrientation = new Map<"portrait" | "landscape", number>();
const committedInsetByOrientation = new Map<"portrait" | "landscape", number>();
const diagnosticHistory: KeyboardDiagnosticEvent[] = [];
const protectionDiagnosticHistory: ChatProtectionDiagnosticEvent[] = [];
let registrationOrder = 0;
let diagnosticSequence = 0;
let diagnosticEnabled = false;
let controllerUsers = 0;
let animationFrameId: number | null = null;
let settlingFramesRemaining = 0;
let stableFrameCount = 0;
let lastMeasuredViewport: MobileKeyboardDockingSnapshot["viewport"] | null = null;
let phaseStartedAt = 0;
let safeAreaProbe: HTMLDivElement | null = null;
let committedKeyboardInset = 0;
let appliedDockInset = 0;
let rawCandidateChangeCount = 0;
let committedInsetUpdateCount = 0;
let focusStartedAt = 0;
let firstContractedAt = 0;
let committedAt = 0;
let lastOpeningRawBoundary: number | null = null;
let composerRectBeforeCommit: RectSnapshot | null = null;
let composerRectAfterCommit: RectSnapshot | null = null;
let openingOverlayRect: RectSnapshot | null = null;
let fullOverlayGeometryStable = true;
let keyboardGeneration = 0;
let closingGeneration: number | null = null;
let closingFallbackTimer: number | null = null;
let pendingFocusOutFrame: number | null = null;
let iosStandaloneOpeningAttempt = 0;
let iosStandaloneOpeningActive = false;
let iosStandaloneOpeningVerified = false;
let iosStandaloneOpeningOrientationChanged = false;
let iosStandaloneOpeningSamples: IosStandaloneOpeningSample[] = [];
const iosStandaloneOpeningTimers = new Set<number>();
let lockedScrollPosition: ScrollPosition | null = null;
let pendingPointerDownScrollPosition: ScrollPosition | null = null;
let protectionGuardFrame: number | null = null;
let protectionFailureFrames = 0;
let protectionActive = false;
let protectionObserver: MutationObserver | null = null;
let protectionReconcileFrame: number | null = null;

export type ChatProtectionDiagnosticEvent = {
  timestamp: number;
  reason: string;
  layoutMode: string | null;
  viewport: { width: number; height: number };
  overlay: ProtectionLayerDiagnostic | null;
  protection: ProtectionLayerDiagnostic | null;
  releaseSha: string;
};

type ProtectionLayerDiagnostic = {
  connected: boolean;
  rect: RectSnapshot;
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
  zIndex: string;
};

let snapshot: MobileKeyboardDockingSnapshot = {
  timestamp: 0,
  phase: "closed",
  focused: false,
  standalone: false,
  orientation: "portrait",
  baselineHeight: 0,
  keyboardOcclusion: 0,
  viewport: { top: 0, left: 0, width: 1, height: 1, bottom: 1 },
  activeChatType: "none",
  windowScrollX: 0,
  windowScrollY: 0,
  documentScrollLeft: 0,
  documentScrollTop: 0,
  iosStandaloneChatRootLockActive: false,
  lockedScrollPosition: null,
  overlayRect: null,
  composerRect: null,
  rawCandidateBoundary: 1,
  rawCandidateInset: 0,
  candidateAccepted: true,
  candidateDecisionReason: "initial",
  keyboardBoundary: 1,
  keyboardInset: 0,
  acceptedCandidateInset: 0,
  committedKeyboardInset: 0,
  appliedDockInset: 0,
  rawCandidateChangeCount: 0,
  committedInsetUpdateCount: 0,
  keyboardGeneration: 0,
  activeTextElement: null,
  focusToFirstContractedMs: null,
  focusToCommittedInsetMs: null,
  composerRectBeforeCommit: null,
  composerRectAfterCommit: null,
  messageRegionRect: null,
  fullOverlayGeometryStable: true,
  overlayHeightChanged: false,
  composerGap: null,
  lastEvent: "initial"
};
let transitionSnapshot: MobileKeyboardTransitionSnapshot = {
  phase: "closed",
  focused: false,
  activeChatType: "none"
};

export function startMobileKeyboardDocking(): () => void {
  controllerUsers += 1;
  if (controllerUsers === 1) {
    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("focusout", handleFocusOut);
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("orientationchange", handleOrientationChange);
    window.addEventListener("focus", handleProtectionLifecycleReconcile);
    window.addEventListener("pagehide", handlePageLifecycleReset);
    window.addEventListener("pageshow", handlePageLifecycleReset);
    document.addEventListener("visibilitychange", handleProtectionLifecycleReconcile);
    window.visualViewport?.addEventListener("resize", handleVisualViewportResize);
    window.visualViewport?.addEventListener("scroll", handleVisualViewportScroll);
    startProtectionMutationObserver();
    reconcileMobileChatProtectionState("controller-start");
    scheduleMeasurement("controller-start");
  }
  return () => {
    controllerUsers = Math.max(0, controllerUsers - 1);
    if (controllerUsers !== 0) return;
    window.removeEventListener("focusin", handleFocusIn);
    window.removeEventListener("focusout", handleFocusOut);
    window.removeEventListener("resize", handleWindowResize);
    window.removeEventListener("orientationchange", handleOrientationChange);
    window.removeEventListener("focus", handleProtectionLifecycleReconcile);
    window.removeEventListener("pagehide", handlePageLifecycleReset);
    window.removeEventListener("pageshow", handlePageLifecycleReset);
    document.removeEventListener("visibilitychange", handleProtectionLifecycleReconcile);
    window.visualViewport?.removeEventListener("resize", handleVisualViewportResize);
    window.visualViewport?.removeEventListener("scroll", handleVisualViewportScroll);
    protectionObserver?.disconnect();
    protectionObserver = null;
    if (protectionReconcileFrame !== null) {
      window.cancelAnimationFrame(protectionReconcileFrame);
      protectionReconcileFrame = null;
    }
    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    cancelPendingFocusOut();
    cancelClosingFallback();
    clearIosStandaloneOpeningTimers();
  };
}

export function getMobileKeyboardDockingSnapshot(): MobileKeyboardDockingSnapshot {
  return snapshot;
}

export function subscribeMobileKeyboardDocking(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMobileChatProtectionActive(): boolean {
  return protectionActive;
}

export function getChatProtectionDiagnostics(): readonly ChatProtectionDiagnosticEvent[] {
  return [...protectionDiagnosticHistory];
}

export function sanitizeTransientMobileChatState(): void {
  overlays.clear();
  clearTransientMobileChatRootState(true);
  for (const property of [
    "--mobile-chat-keyboard-boundary",
    "--mobile-chat-keyboard-inset",
    "--mobile-chat-committed-keyboard-inset",
    "--mobile-chat-applied-keyboard-inset"
  ]) {
    document.documentElement.style.removeProperty(property);
  }
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>(".mobile-chat-protection")
  )) {
    element.dataset.mobileChatProtectionOwner = "false";
  }
  protectionActive = false;
  publishProtectionTransition();
}

export function reconcileMobileChatProtectionState(
  reason = "manual-reconcile"
): boolean {
  const registrations = getOrderedOverlayRegistrations();
  const active = registrations[0] ?? null;
  if (!active) {
    for (const protection of Array.from(
      document.querySelectorAll<HTMLElement>(".mobile-chat-protection")
    )) {
      if (protection.dataset.mobileChatProtectionOwner !== "false") {
        protection.dataset.mobileChatProtectionOwner = "false";
      }
    }
    clearTransientMobileChatRootState(true);
    const changed = protectionActive;
    protectionActive = false;
    if (changed) publishProtectionTransition();
    return false;
  }

  const result = validateProtectionOverlay(active.element, active.protection);
  if (!result.valid) {
    overlays.clear();
    for (const registration of registrations) {
      registration.protection.dataset.mobileChatProtectionOwner = "false";
    }
    clearTransientMobileChatRootState(true);
    protectionActive = false;
    publishProtectionTransition();
    recordProtectionDiagnostic(`${reason}:${result.reason}`, active.element, active.protection);
    active.onInvalid(result.reason);
    return false;
  }

  for (const registration of registrations) {
    const owner = registration === active ? "true" : "false";
    if (registration.protection.dataset.mobileChatProtectionOwner !== owner) {
      registration.protection.dataset.mobileChatProtectionOwner = owner;
    }
  }
  if (document.documentElement.dataset.mobileChatProtected !== "true") {
    document.documentElement.dataset.mobileChatProtected = "true";
  }
  for (const hud of Array.from(document.querySelectorAll<HTMLElement>(".phone-hud"))) {
    if (!hud.hasAttribute("inert")) hud.setAttribute("inert", "");
    if (hud.getAttribute("aria-hidden") !== "true") hud.setAttribute("aria-hidden", "true");
    if (hud.dataset.chatSuppressed !== "true") hud.dataset.chatSuppressed = "true";
  }
  const changed = !protectionActive;
  protectionActive = true;
  if (changed) publishProtectionTransition();
  startProtectionInvariantGuard();
  return true;
}

export function isMobileKeyboardTransitionActive(): boolean {
  return (
    document.documentElement.dataset.uiProfile === "phone" &&
    (snapshot.phase !== "closed" || isTextEntry(document.activeElement))
  );
}

export function isIosStandaloneMobileChat(): boolean {
  return readIosStandalone();
}

export function setKeyboardDiagnosticsEnabled(enabled: boolean): void {
  diagnosticEnabled = enabled;
  if (!enabled) {
    diagnosticHistory.length = 0;
    removeSafeAreaProbe();
    return;
  }
  recordDiagnosticEvent("diagnostics-enabled");
  scheduleMeasurement("diagnostics-enabled");
}

export function resetMobileKeyboardDockingForTests(): void {
  if (controllerUsers !== 0) {
    throw new Error("mobile keyboard docking must be stopped before test reset");
  }
  if (animationFrameId !== null) {
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  overlays.clear();
  protectionDiagnosticHistory.length = 0;
  baselineByOrientation.clear();
  acceptedBoundaryByOrientation.clear();
  committedInsetByOrientation.clear();
  diagnosticHistory.length = 0;
  diagnosticSequence = 0;
  registrationOrder = 0;
  settlingFramesRemaining = 0;
  stableFrameCount = 0;
  lastMeasuredViewport = null;
  phaseStartedAt = 0;
  committedKeyboardInset = 0;
  appliedDockInset = 0;
  rawCandidateChangeCount = 0;
  committedInsetUpdateCount = 0;
  focusStartedAt = 0;
  firstContractedAt = 0;
  committedAt = 0;
  lastOpeningRawBoundary = null;
  composerRectBeforeCommit = null;
  composerRectAfterCommit = null;
  openingOverlayRect = null;
  fullOverlayGeometryStable = true;
  keyboardGeneration = 0;
  closingGeneration = null;
  cancelPendingFocusOut();
  cancelClosingFallback();
  iosStandaloneOpeningAttempt = 0;
  iosStandaloneOpeningActive = false;
  iosStandaloneOpeningVerified = false;
  iosStandaloneOpeningOrientationChanged = false;
  iosStandaloneOpeningSamples = [];
  clearIosStandaloneOpeningTimers();
  pendingPointerDownScrollPosition = null;
  if (protectionGuardFrame !== null) {
    window.cancelAnimationFrame(protectionGuardFrame);
    protectionGuardFrame = null;
  }
  protectionFailureFrames = 0;
  releaseIosStandaloneChatRootLock(true);
  snapshot = {
    timestamp: 0,
    phase: "closed",
    focused: false,
    standalone: false,
    orientation: "portrait",
    baselineHeight: 0,
    keyboardOcclusion: 0,
    viewport: { top: 0, left: 0, width: 1, height: 1, bottom: 1 },
    activeChatType: "none",
    windowScrollX: 0,
    windowScrollY: 0,
    documentScrollLeft: 0,
    documentScrollTop: 0,
    iosStandaloneChatRootLockActive: false,
    lockedScrollPosition: null,
    overlayRect: null,
    composerRect: null,
    rawCandidateBoundary: 1,
    rawCandidateInset: 0,
    candidateAccepted: true,
    candidateDecisionReason: "initial",
    keyboardBoundary: 1,
    keyboardInset: 0,
    acceptedCandidateInset: 0,
    committedKeyboardInset: 0,
    appliedDockInset: 0,
    rawCandidateChangeCount: 0,
    committedInsetUpdateCount: 0,
    keyboardGeneration: 0,
    activeTextElement: null,
    focusToFirstContractedMs: null,
    focusToCommittedInsetMs: null,
    composerRectBeforeCommit: null,
    composerRectAfterCommit: null,
    messageRegionRect: null,
    fullOverlayGeometryStable: true,
    overlayHeightChanged: false,
    composerGap: null,
    lastEvent: "initial"
  };
  transitionSnapshot = {
    phase: "closed",
    focused: false,
    activeChatType: "none"
  };
  const root = document.documentElement;
  delete root.dataset.mobileKeyboardPhase;
  delete root.dataset.virtualKeyboard;
  delete root.dataset.textEntryFocused;
  delete root.dataset.mobileKeyboardCommitted;
  delete root.dataset.mobileChatProtected;
  delete root.dataset.iosStandaloneChatLocked;
  for (const property of [
    "--mobile-chat-keyboard-boundary",
    "--mobile-chat-keyboard-inset",
    "--mobile-chat-committed-keyboard-inset",
    "--mobile-chat-applied-keyboard-inset"
  ]) {
    root.style.removeProperty(property);
  }
  removeSafeAreaProbe();
}

export function noteMobileChatEvent(event: string): void {
  recordDiagnosticEvent(event);
  scheduleMeasurement(event);
}

export function dismissMobileKeyboard(): void {
  const active = document.activeElement;
  if (isTextEntry(active) && active instanceof HTMLElement) {
    noteMobileChatEvent("keyboard-dismiss-request");
    active.blur();
  }
}

export function getKeyboardDiagnosticReport(): {
  current: MobileKeyboardDockingSnapshot & {
    coordinateSystem: "layout-viewport CSS px";
    windowInnerHeight: number;
    documentClientHeight: number;
    visualViewport: {
      width: number;
      height: number;
      offsetTop: number;
      offsetLeft: number;
      bottom: number;
    } | null;
    safeArea: { top: number; right: number; bottom: number; left: number };
    cssProperties: Record<string, string>;
    layers: Record<string, LayerSnapshot | null>;
    invariants: {
      protectionCoversLayoutViewport: boolean;
      gameplayHudSuppressed: boolean;
      gameplayBelowProtection: boolean;
      fullOverlayGeometryStable: boolean;
      committedInsetUpdateCount: number;
      composerOnlyDocking: boolean;
    };
  };
  events: readonly KeyboardDiagnosticEvent[];
} {
  const rootStyle = getComputedStyle(document.documentElement);
  const visual = window.visualViewport;
  const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
  const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
  const protection = readLayer(".mobile-chat-protection");
  const phoneHud = readLayer(".phone-hud");
  const protectionZ = numericZIndex(protection?.zIndex);
  const hudZ = numericZIndex(phoneHud?.zIndex);
  const hudElement = document.querySelector<HTMLElement>(".phone-hud");
  return {
    current: {
      ...snapshot,
      coordinateSystem: "layout-viewport CSS px",
      windowInnerHeight: window.innerHeight,
      documentClientHeight: document.documentElement.clientHeight,
      ...readDocumentScrollSnapshot(),
      iosStandaloneChatRootLockActive: isIosStandaloneChatRootLocked(),
      lockedScrollPosition: lockedScrollPosition ? { ...lockedScrollPosition } : null,
      visualViewport: visual
        ? {
            width: visual.width,
            height: visual.height,
            offsetTop: visual.offsetTop,
            offsetLeft: visual.offsetLeft,
            bottom: visual.offsetTop + visual.height
          }
        : null,
      safeArea: readSafeAreaInsets(),
      cssProperties: Object.fromEntries(
        [
          "--app-viewport-height",
          "--mobile-chat-keyboard-boundary",
          "--mobile-chat-keyboard-inset",
          "--mobile-chat-committed-keyboard-inset",
          "--mobile-chat-applied-keyboard-inset",
          "--hud-chat-protection-z"
        ].map((name) => [name, rootStyle.getPropertyValue(name).trim()])
      ),
      layers: {
        gameplay: readLayer(".map-root"),
        phoneHud,
        protection,
        publicChat: readLayer('[data-mobile-chat-type="public"]'),
        directMessages: readLayer('[data-mobile-chat-type="direct"]'),
        composer: readLayer('[data-mobile-chat-active="true"] [data-mobile-chat-composer]'),
        messageRegion: readLayer('[data-mobile-chat-active="true"] [data-mobile-chat-message-region]')
      },
      invariants: {
        protectionCoversLayoutViewport:
          protection !== null &&
          protection.rect.top <= 0 &&
          protection.rect.left <= 0 &&
          protection.rect.right >= layoutWidth &&
          protection.rect.bottom >= layoutHeight,
        gameplayHudSuppressed:
          phoneHud === null ||
          (phoneHud.visibility === "hidden" &&
            phoneHud.pointerEvents === "none" &&
            hudElement?.hasAttribute("inert") === true),
        gameplayBelowProtection:
          protection !== null && (phoneHud === null || hudZ < protectionZ),
        fullOverlayGeometryStable: snapshot.fullOverlayGeometryStable,
        committedInsetUpdateCount: snapshot.committedInsetUpdateCount,
        composerOnlyDocking:
          snapshot.fullOverlayGeometryStable &&
          (
            snapshot.activeChatType === "none" ||
            rootStyle.getPropertyValue("--mobile-chat-applied-keyboard-inset").trim() ===
              `${snapshot.appliedDockInset}px`
          )
      }
    },
    events: [...diagnosticHistory]
  };
}

export type MobileChatOverlayProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  open: boolean;
  type: Exclude<MobileChatType, "none">;
  overlayRef?: MutableRefObject<HTMLElement | null>;
  onRequestClose?: () => void;
  onProtectionFailure?: (reason: string) => void;
  manageHistory?: boolean;
  children: ReactNode;
};

type MobileChatTextEntry = HTMLInputElement | HTMLTextAreaElement;
export function prepareMobileChatInputPointerDown(
  event: ReactPointerEvent<MobileChatTextEntry>
): void {
  if (
    !readIosStandalone() ||
    !isTargetInsideActiveMobileChatOverlay(event.currentTarget)
  ) {
    return;
  }
  const target = event.currentTarget;
  pendingPointerDownScrollPosition = { x: window.scrollX, y: window.scrollY };
  try {
    if (document.activeElement !== target) {
      target.focus();
    }
    if (document.activeElement === target) activateIosStandaloneChatRootLock();
  } finally {
    pendingPointerDownScrollPosition = null;
  }
  recordDiagnosticEvent("chat-input-pointerdown");
}

export function handleMobileChatInputFocus(
  event: ReactFocusEvent<MobileChatTextEntry>
): void {
  if (
    !readIosStandalone() ||
    !isTargetInsideActiveMobileChatOverlay(event.currentTarget)
  ) {
    return;
  }
  activateIosStandaloneChatRootLock();
}

export function MobileChatOverlay({
  open,
  type,
  overlayRef,
  onRequestClose,
  onProtectionFailure,
  manageHistory = true,
  className,
  children,
  ...props
}: MobileChatOverlayProps): React.JSX.Element | null {
  const docking = useSyncExternalStore(
    subscribeMobileKeyboardDocking,
    getMobileKeyboardTransitionSnapshot,
    getMobileKeyboardTransitionSnapshot
  );
  const [present, setPresent] = useState(open);
  const elementRef = useRef<HTMLElement | null>(null);
  const protectionRef = useRef<HTMLDivElement | null>(null);
  const closeRequestedRef = useRef(false);
  const requestCloseRef = useRef(onRequestClose);
  const protectionFailureRef = useRef(onProtectionFailure);
  requestCloseRef.current = onRequestClose;
  protectionFailureRef.current = onProtectionFailure;
  const visible = open || present;
  const requestClose = useCallback((): void => {
    const close = requestCloseRef.current;
    if (!close) return;
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    dismissMobileKeyboard();
    close();
  }, []);
  const setElement = useCallback((element: HTMLElement | null): void => {
    elementRef.current = element;
    if (overlayRef) overlayRef.current = element;
  }, [overlayRef]);

  useLayoutEffect(() => {
    if (open) {
      closeRequestedRef.current = false;
      setPresent(true);
      return;
    }
    if (present) dismissMobileKeyboard();
  }, [open, present]);

  useEffect(() => {
    if (open || !present) return;
    const phone = document.documentElement.dataset.uiProfile === "phone";
    if (phone && (docking.phase !== "closed" || docking.focused)) return;
    const frame = window.requestAnimationFrame(() => setPresent(false));
    return () => window.cancelAnimationFrame(frame);
  }, [docking.focused, docking.phase, open, present]);

  useEffect(() => {
    const element = elementRef.current;
    if (!open || !element) return;
    const containComposerDrag = (event: TouchEvent): void => {
      if (!isIosStandaloneChatRootLocked()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const composer = target.closest<HTMLElement>("[data-mobile-chat-composer]");
      if (!composer || !element.contains(composer)) return;
      if (target.closest("textarea, input, [contenteditable='true']")) return;
      event.preventDefault();
    };
    element.addEventListener("touchmove", containComposerDrag, { passive: false });
    return () => element.removeEventListener("touchmove", containComposerDrag);
  }, [open]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    const protection = protectionRef.current;
    if (!open || !element || !protection) return;
    let cancelled = false;
    let frame: number | null = null;
    let unregister: (() => void) | null = null;
    let attempts = 0;
    const abort = (reason: string): void => {
      if (cancelled) return;
      if (overlays.size > 0) syncProtectionState();
      else clearTransientMobileChatRootState(true);
      recordProtectionDiagnostic(reason, element, protection);
      if (protectionFailureRef.current) protectionFailureRef.current(reason);
      else requestCloseRef.current?.();
    };
    const verify = (): void => {
      if (cancelled) return;
      attempts += 1;
      const result = validateProtectionOverlay(element, protection);
      if (result.valid) {
        unregister = registerOverlay(element, protection, type, abort);
        noteMobileChatEvent(`overlay-mount:${type}`);
        return;
      }
      if (attempts < CHAT_PROTECTION_OPEN_FRAME_BUDGET) {
        frame = window.requestAnimationFrame(verify);
        return;
      }
      abort(result.reason);
    };
    verify();
    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      unregister?.();
      if (unregister) noteMobileChatEvent(`overlay-unmount:${type}`);
    };
  }, [open, type]);

  useEffect(() => {
    if (!open || !requestCloseRef.current) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };
    document.addEventListener("keydown", close);
    if (!manageHistory) {
      return () => document.removeEventListener("keydown", close);
    }
    const historyToken = `${type}:${Date.now()}:${Math.random()}`;
    const currentHistoryState =
      history.state && typeof history.state === "object" ? history.state : {};
    history.pushState(
      { ...currentHistoryState, ashAtlasChatOverlay: historyToken },
      "",
      window.location.href
    );
    let popped = false;
    const historyChanged = (event: PopStateEvent): void => {
      // Back from a screen opened on top of the chat (a player profile) lands on
      // the chat's own entry again: the chat stays where the player left it.
      const landed = event.state as { ashAtlasChatOverlay?: unknown } | null;
      if (landed?.ashAtlasChatOverlay === historyToken) return;
      popped = true;
      if (
        (event as PopStateEvent & { hasUAVisualTransition?: boolean })
          .hasUAVisualTransition === true
      ) {
        flushSync(requestClose);
        return;
      }
      requestClose();
    };
    const pageTransition = (): void => requestClose();
    document.addEventListener("keydown", close);
    window.addEventListener("popstate", historyChanged);
    window.addEventListener("pagehide", pageTransition);
    return () => {
      document.removeEventListener("keydown", close);
      window.removeEventListener("popstate", historyChanged);
      window.removeEventListener("pagehide", pageTransition);
      if (!popped && history.state?.ashAtlasChatOverlay === historyToken) {
        if (mobileMenuViewFromHistoryState(history.state) !== "gameplay") {
          const nextState = { ...history.state };
          delete nextState.ashAtlasChatOverlay;
          history.replaceState(nextState, "");
        } else {
          history.back();
        }
      }
    };
  }, [manageHistory, open, requestClose, type]);

  useEffect(() => {
    noteMobileChatEvent(`${open ? "chat-open-request" : "chat-close-request"}:${type}`);
    const element = elementRef.current;
    if (element && overlays.has(element)) {
      syncProtectionState();
      publishProtectionTransition();
    }
  }, [open, type]);

  if (!visible) return null;

  return (
    <>
      <div
        ref={protectionRef}
        className="mobile-chat-protection"
        data-mobile-chat-protection={type}
        data-mobile-chat-protection-owner="false"
        data-mobile-chat-presence={open ? "open" : "exiting"}
        aria-hidden="true"
      />
      <aside
        {...props}
        ref={setElement}
        className={`mobile-chat-overlay ${className ?? ""}`.trim()}
        data-mobile-chat-type={type}
        data-mobile-chat-active={docking.activeChatType === type ? "true" : "false"}
        data-mobile-chat-presence={open ? "open" : "exiting"}
        aria-hidden={open ? undefined : true}
        inert={open ? undefined : true}
      >
        {children}
      </aside>
    </>
  );
}

function registerOverlay(
  element: HTMLElement,
  protection: HTMLElement,
  type: Exclude<MobileChatType, "none">,
  onInvalid: (reason: string) => void
): () => void {
  registrationOrder += 1;
  const registration = {
    element,
    protection,
    type,
    order: registrationOrder,
    onInvalid
  };
  overlays.set(element, registration);
  syncProtectionState();
  publishProtectionTransition();
  scheduleMeasurement(`overlay-register:${type}`);
  return () => {
    if (overlays.get(element) === registration) overlays.delete(element);
    syncProtectionState();
    publishProtectionTransition();
    const active = document.activeElement;
    if (
      snapshot.phase !== "closed" &&
      snapshot.phase !== "closing" &&
      !isTextEntry(active)
    ) {
      beginClosingSession();
    }
    scheduleMeasurement(`overlay-remove:${type}`);
  };
}

function getOrderedOverlayRegistrations(): OverlayRegistration[] {
  return [...overlays.values()].sort((left, right) => {
    const presenceDifference =
      Number(right.element.dataset.mobileChatPresence === "open") -
      Number(left.element.dataset.mobileChatPresence === "open");
    return presenceDifference || right.order - left.order;
  });
}

function syncProtectionState(): void {
  reconcileMobileChatProtectionState("registry-sync");
  if (!protectionActive) maybeReleaseIosStandaloneChatRootLock();
}

function clearTransientMobileChatRootState(restoreHud = false): void {
  const root = document.documentElement;
  delete root.dataset.mobileChatProtected;
  delete root.dataset.mobileKeyboardPhase;
  delete root.dataset.mobileKeyboardCommitted;
  delete root.dataset.virtualKeyboard;
  delete root.dataset.textEntryFocused;
  delete root.dataset.iosStandaloneChatLocked;
  if (restoreHud) {
    for (const hud of Array.from(document.querySelectorAll<HTMLElement>(".phone-hud"))) {
      if (hud.hasAttribute("inert")) hud.removeAttribute("inert");
      if (hud.getAttribute("aria-hidden") !== "false") hud.setAttribute("aria-hidden", "false");
      if (hud.dataset.chatSuppressed !== "false") hud.dataset.chatSuppressed = "false";
      hud.style.removeProperty("visibility");
      hud.style.removeProperty("pointer-events");
    }
  }
  if (protectionGuardFrame !== null) {
    window.cancelAnimationFrame(protectionGuardFrame);
    protectionGuardFrame = null;
  }
  protectionFailureFrames = 0;
}

function startProtectionInvariantGuard(): void {
  if (isUnitTestEnvironment()) return;
  if (protectionGuardFrame !== null) return;
  const verify = (): void => {
    protectionGuardFrame = null;
    const registrations = getOrderedOverlayRegistrations();
    if (registrations.length === 0) {
      reconcileMobileChatProtectionState("invariant-empty-registry");
      return;
    }
    const active = registrations[0]!;
    const activeOwnerCount = registrations.filter(
      ({ protection }) => protection.dataset.mobileChatProtectionOwner === "true"
    ).length;
    const result = validateProtectionOverlay(active.element, active.protection);
    if (activeOwnerCount === 1 && result.valid) {
      protectionFailureFrames = 0;
    } else {
      protectionFailureFrames += 1;
      if (protectionFailureFrames > CHAT_PROTECTION_FAILURE_FRAME_LIMIT) {
        const reason = activeOwnerCount === 1 ? result.reason : "invalid-protection-owner-count";
        const invalid = [...overlays.values()];
        overlays.clear();
        for (const registration of invalid) {
          registration.protection.dataset.mobileChatProtectionOwner = "false";
        }
        clearTransientMobileChatRootState(true);
        protectionActive = false;
        publishProtectionTransition();
        recordProtectionDiagnostic(reason, active.element, active.protection);
        active.onInvalid(reason);
        return;
      }
    }
    protectionGuardFrame = window.requestAnimationFrame(verify);
  };
  protectionGuardFrame = window.requestAnimationFrame(verify);
}

function startProtectionMutationObserver(): void {
  if (protectionObserver || typeof MutationObserver === "undefined") return;
  protectionObserver = new MutationObserver(() => {
    if (protectionReconcileFrame !== null) return;
    protectionReconcileFrame = window.requestAnimationFrame(() => {
      protectionReconcileFrame = null;
      reconcileMobileChatProtectionState("dom-mutation");
    });
  });
  protectionObserver.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: [
      "data-mobile-chat-protected",
      "data-mobile-chat-protection-owner",
      "data-chat-suppressed"
    ]
  });
}

function handleProtectionLifecycleReconcile(): void {
  reconcileMobileChatProtectionState("lifecycle");
}

function validateProtectionOverlay(
  overlay: HTMLElement,
  protection: HTMLElement
): { valid: boolean; reason: string } {
  if (!overlay.isConnected || !protection.isConnected) {
    return { valid: false, reason: "overlay-disconnected" };
  }
  if (overlay.parentElement !== protection.parentElement) {
    return { valid: false, reason: "stacking-context-mismatch" };
  }
  if (isUnitTestEnvironment()) return { valid: true, reason: "unit-test-layout-unavailable" };
  const overlayRect = overlay.getBoundingClientRect();
  if (overlayRect.width <= 0 || overlayRect.height <= 0) {
    return { valid: false, reason: "overlay-zero-sized" };
  }
  const overlayStyle = getComputedStyle(overlay);
  if (
    overlayStyle.display === "none" ||
    overlayStyle.visibility !== "visible" ||
    Number(overlayStyle.opacity) <= 0 ||
    overlayStyle.pointerEvents === "none"
  ) {
    return { valid: false, reason: "overlay-not-visible" };
  }
  const close = overlay.querySelector<HTMLElement>(
    '[data-mobile-chat-close="true"], button[aria-label^="Close"], button[data-phone-label="Back"], .phone-menu-back, .phone-menu-return'
  );
  if (!close || close.matches(":disabled")) {
    return { valid: false, reason: "overlay-close-unavailable" };
  }
  const closeRect = close.getBoundingClientRect();
  const closeStyle = getComputedStyle(close);
  if (
    closeRect.width <= 0 ||
    closeRect.height <= 0 ||
    closeStyle.display === "none" ||
    closeStyle.visibility !== "visible" ||
    Number(closeStyle.opacity) <= 0 ||
    closeStyle.pointerEvents === "none"
  ) {
    return { valid: false, reason: "overlay-close-unreachable" };
  }
  const overlayZ = numericZIndex(overlayStyle.zIndex);
  const protectionZ = numericZIndex(getComputedStyle(protection).zIndex);
  if (!Number.isFinite(overlayZ) || !Number.isFinite(protectionZ) || overlayZ <= protectionZ) {
    return { valid: false, reason: "overlay-not-above-protection" };
  }
  return { valid: true, reason: "valid" };
}

function isUnitTestEnvironment(): boolean {
  return Boolean((import.meta.env as Record<string, unknown>).VITEST);
}

function recordProtectionDiagnostic(
  reason: string,
  overlay: HTMLElement | null,
  protection: HTMLElement | null
): void {
  protectionDiagnosticHistory.push({
    timestamp: Date.now(),
    reason,
    layoutMode: document.documentElement.dataset.layoutMode ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overlay: readProtectionLayerDiagnostic(overlay),
    protection: readProtectionLayerDiagnostic(protection),
    releaseSha: import.meta.env.VITE_GAME_BUILD_SHA ?? "development"
  });
  if (protectionDiagnosticHistory.length > CHAT_PROTECTION_DIAGNOSTIC_LIMIT) {
    protectionDiagnosticHistory.splice(
      0,
      protectionDiagnosticHistory.length - CHAT_PROTECTION_DIAGNOSTIC_LIMIT
    );
  }
}

function readProtectionLayerDiagnostic(
  element: HTMLElement | null
): ProtectionLayerDiagnostic | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    connected: element.isConnected,
    rect: {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height
    },
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    zIndex: style.zIndex
  };
}

function handlePageLifecycleReset(): void {
  const active = [...overlays.values()];
  overlays.clear();
  for (const registration of active) {
    registration.protection.dataset.mobileChatProtectionOwner = "false";
  }
  clearTransientMobileChatRootState(true);
  protectionActive = false;
  publishProtectionTransition();
  for (const registration of active) registration.onInvalid("page-lifecycle-reset");
}

function activateIosStandaloneChatRootLock(): void {
  if (!readIosStandalone() || isIosStandaloneChatRootLocked()) return;
  lockedScrollPosition ??= pendingPointerDownScrollPosition ?? {
    x: window.scrollX,
    y: window.scrollY
  };
  document.documentElement.dataset.iosStandaloneChatLocked = "true";
  recordDiagnosticEvent("ios-standalone-chat-root-lock");
}

function maybeReleaseIosStandaloneChatRootLock(): void {
  if (
    snapshot.phase !== "closed" ||
    isTextEntry(document.activeElement)
  ) {
    return;
  }
  releaseIosStandaloneChatRootLock();
}

function releaseIosStandaloneChatRootLock(force = false): void {
  if (force) {
    delete document.documentElement.dataset.iosStandaloneChatLocked;
    lockedScrollPosition = null;
    return;
  }
  if (!isIosStandaloneChatRootLocked()) return;
  delete document.documentElement.dataset.iosStandaloneChatLocked;
  lockedScrollPosition = null;
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  recordDiagnosticEvent("ios-standalone-chat-root-unlock");
}

function isIosStandaloneChatRootLocked(): boolean {
  return document.documentElement.dataset.iosStandaloneChatLocked === "true";
}

function isTargetInsideActiveMobileChatOverlay(target: Element): boolean {
  const overlay = target.closest<HTMLElement>(".mobile-chat-overlay");
  if (!overlay || !overlays.has(overlay)) return false;
  const activeOverlay = getOrderedOverlayRegistrations()[0] ?? null;
  return activeOverlay?.element === overlay;
}

function publishProtectionTransition(): void {
  const activeOverlay = getOrderedOverlayRegistrations()[0] ?? null;
  const nextType = activeOverlay?.type ?? "none";
  if (transitionSnapshot.activeChatType !== nextType) {
    transitionSnapshot = { ...transitionSnapshot, activeChatType: nextType };
  }
  for (const listener of listeners) listener();
}

function handleFocusIn(event: FocusEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  recordDiagnosticEvent("focusin");
  if (isTextEntry(target)) {
    cancelPendingFocusOut();
    cancelClosingFallback();
    if (snapshot.phase === "closed" || snapshot.phase === "closing") {
      beginOpeningAttempt();
      beginPhase("opening", "focusin");
    }
    recordDiagnosticEvent("input-focus");
  }
  scheduleMeasurement("focusin");
}

function beginOpeningAttempt(): void {
  keyboardGeneration += 1;
  closingGeneration = null;
  cancelClosingFallback();
  focusStartedAt = performance.now();
  firstContractedAt = 0;
  committedAt = 0;
  rawCandidateChangeCount = 0;
  committedInsetUpdateCount = 0;
  lastOpeningRawBoundary = snapshot.rawCandidateBoundary;
  composerRectBeforeCommit = null;
  composerRectAfterCommit = null;
  const activeOverlay = getOrderedOverlayRegistrations()[0] ?? null;
  openingOverlayRect = activeOverlay ? readRect(activeOverlay.element) : snapshot.overlayRect;
  fullOverlayGeometryStable = true;
  const orientation = readOrientation();
  iosStandaloneOpeningAttempt += 1;
  iosStandaloneOpeningActive = readIosStandalone();
  iosStandaloneOpeningVerified = false;
  iosStandaloneOpeningOrientationChanged = orientation !== snapshot.orientation;
  iosStandaloneOpeningSamples = [];
  clearIosStandaloneOpeningTimers();
  if (iosStandaloneOpeningActive) {
    const cachedInset = committedInsetByOrientation.get(orientation);
    if (cachedInset !== undefined && cachedInset > 0) {
      committedKeyboardInset = cachedInset;
      committedInsetUpdateCount = 1;
      committedAt = focusStartedAt;
    }
    scheduleIosStandaloneOpeningSamples(iosStandaloneOpeningAttempt);
  }
}

function handleFocusOut(event: FocusEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  recordDiagnosticEvent("focusout");
  if (!isTextEntry(target)) return;
  recordDiagnosticEvent("input-blur");
  cancelPendingFocusOut();
  const generationAtBlur = keyboardGeneration;
  pendingFocusOutFrame = window.requestAnimationFrame(() => {
    pendingFocusOutFrame = null;
    const active = document.activeElement;
    if (generationAtBlur !== keyboardGeneration) return;
    if (isTextEntry(active)) {
      recordDiagnosticEvent("focus-transfer");
      scheduleMeasurement("focus-transfer");
      return;
    }
    clearIosStandaloneOpeningTimers();
    if (snapshot.phase !== "closed") beginClosingSession();
    scheduleMeasurement("focusout-classified");
  });
}

function beginClosingSession(): void {
  keyboardGeneration += 1;
  closingGeneration = keyboardGeneration;
  beginPhase("closing", "focusout");
  releaseIosStandaloneChatRootLock();
  cancelClosingFallback();
  const generation = keyboardGeneration;
  closingFallbackTimer = window.setTimeout(() => {
    closingFallbackTimer = null;
    if (
      controllerUsers === 0 ||
      closingGeneration !== generation ||
      keyboardGeneration !== generation ||
      snapshot.phase !== "closing"
    ) {
      return;
    }
    const active = document.activeElement;
    if (isTextEntry(active)) return;
    measure("close-fallback", undefined, true);
  }, CLOSING_FALLBACK_MS);
}

function cancelPendingFocusOut(): void {
  if (pendingFocusOutFrame === null) return;
  window.cancelAnimationFrame(pendingFocusOutFrame);
  pendingFocusOutFrame = null;
}

function cancelClosingFallback(): void {
  if (closingFallbackTimer === null) return;
  window.clearTimeout(closingFallbackTimer);
  closingFallbackTimer = null;
}

function handleWindowResize(): void {
  recordDiagnosticEvent("window.resize");
  scheduleMeasurement("window.resize");
}

function handleVisualViewportResize(): void {
  recordDiagnosticEvent("visualViewport.resize");
  scheduleMeasurement("visualViewport.resize");
}

function handleVisualViewportScroll(): void {
  recordDiagnosticEvent("visualViewport.scroll");
  scheduleMeasurement("visualViewport.scroll");
}

function handleOrientationChange(): void {
  stableFrameCount = 0;
  lastMeasuredViewport = null;
  const active = document.activeElement;
  if (isTextEntry(active) && readIosStandalone()) {
    beginOpeningAttempt();
    beginPhase("opening", "orientationchange");
  }
  recordDiagnosticEvent("orientationchange");
  scheduleMeasurement("orientationchange");
}

function beginPhase(phase: MobileKeyboardPhase, event: string): void {
  if (snapshot.phase === phase) return;
  phaseStartedAt = performance.now();
  const active = document.activeElement;
  publishSnapshot({
    ...snapshot,
    phase,
    focused: isTextEntry(active),
    committedKeyboardInset,
    appliedDockInset,
    committedInsetUpdateCount,
    keyboardGeneration,
    activeTextElement: describeTextEntry(document.activeElement),
    lastEvent: event
  });
  recordDiagnosticEvent(`keyboard-${phase}-classification`);
}

function scheduleIosStandaloneOpeningSamples(attempt: number): void {
  for (const delay of IOS_STANDALONE_OPENING_SAMPLE_DELAYS_MS) {
    const timer = window.setTimeout(() => {
      iosStandaloneOpeningTimers.delete(timer);
      if (
        controllerUsers === 0 ||
        attempt !== iosStandaloneOpeningAttempt ||
        !iosStandaloneOpeningActive ||
        !isTextEntry(document.activeElement)
      ) {
        return;
      }
      measure(`ios-standalone-opening-sample:${delay}`, delay);
    }, delay);
    iosStandaloneOpeningTimers.add(timer);
  }
}

function clearIosStandaloneOpeningTimers(): void {
  for (const timer of iosStandaloneOpeningTimers) {
    window.clearTimeout(timer);
  }
  iosStandaloneOpeningTimers.clear();
}

function scheduleMeasurement(event: string): void {
  if (controllerUsers === 0) return;
  settlingFramesRemaining = SETTLING_FRAME_BUDGET;
  if (animationFrameId !== null) return;
  animationFrameId = window.requestAnimationFrame(() => {
    animationFrameId = null;
    measure(event);
  });
}

function measure(
  event: string,
  iosStandaloneSampleAtMs?: number,
  forceClose = false
): void {
  const now = performance.now();
  const visual = window.visualViewport;
  const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
  const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
  const viewport = {
    top: visual?.offsetTop ?? 0,
    left: visual?.offsetLeft ?? 0,
    width: visual?.width ?? layoutWidth,
    height: visual?.height ?? layoutHeight,
    bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight)
  };
  const orientation = readOrientation();
  const standalone = readStandalone();
  const activeElement = document.activeElement;
  const focused = isTextEntry(activeElement);
  const viewportStable =
    lastMeasuredViewport !== null &&
    Math.abs(lastMeasuredViewport.top - viewport.top) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(lastMeasuredViewport.left - viewport.left) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(lastMeasuredViewport.width - viewport.width) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(lastMeasuredViewport.height - viewport.height) <= GEOMETRY_STABLE_TOLERANCE_PX;
  stableFrameCount = viewportStable ? stableFrameCount + 1 : 0;
  lastMeasuredViewport = viewport;

  let baselineHeight = baselineByOrientation.get(orientation);
  if (baselineHeight === undefined) {
    baselineHeight = layoutHeight;
    baselineByOrientation.set(orientation, baselineHeight);
  }
  if (
    !focused &&
    (forceClose || snapshot.phase === "closed") &&
    isPlausibleClosedBoundary(viewport.bottom, layoutWidth, viewport)
  ) {
    baselineHeight = viewport.bottom;
    baselineByOrientation.set(orientation, baselineHeight);
    acceptedBoundaryByOrientation.set(orientation, baselineHeight);
  }
  const rawCandidateBoundary = viewport.bottom;
  const rawCandidateInset = Math.max(0, baselineHeight - rawCandidateBoundary);
  if (
    focused &&
    (snapshot.phase === "opening" || snapshot.phase === "open") &&
    lastOpeningRawBoundary !== null &&
    Math.abs(lastOpeningRawBoundary - rawCandidateBoundary) > GEOMETRY_STABLE_TOLERANCE_PX
  ) {
    rawCandidateChangeCount += 1;
  }
  if (focused && (snapshot.phase === "opening" || snapshot.phase === "open")) {
    lastOpeningRawBoundary = rawCandidateBoundary;
  }
  const previousAccepted = acceptedBoundaryByOrientation.get(orientation) ?? baselineHeight;
  const candidateDecision = validateBoundaryCandidate({
    rawCandidateBoundary,
    baselineHeight,
    layoutWidth,
    viewport,
    focused,
    phase: snapshot.phase,
    previousAccepted
  });
  let keyboardBoundary = candidateDecision.accepted
    ? rawCandidateBoundary
    : previousAccepted;
  if (candidateDecision.accepted) {
    acceptedBoundaryByOrientation.set(orientation, keyboardBoundary);
  }
  let acceptedCandidateInset = Math.max(0, baselineHeight - keyboardBoundary);
  let keyboardOcclusion = acceptedCandidateInset;
  let keyboardInset = acceptedCandidateInset;
  let occluded = acceptedCandidateInset > KEYBOARD_OCCLUSION_THRESHOLD_PX;
  if (occluded && firstContractedAt === 0 && focusStartedAt > 0) {
    firstContractedAt = now;
  }

  const activeOverlay = getOrderedOverlayRegistrations()[0] ?? null;
  const overlayRect = activeOverlay ? readRect(activeOverlay.element) : null;
  const composer = activeOverlay?.element.querySelector<HTMLElement>("[data-mobile-chat-composer]") ?? null;
  const composerRect = composer ? readRect(composer) : null;
  const messageRegion = activeOverlay?.element.querySelector<HTMLElement>("[data-mobile-chat-message-region]") ?? null;
  const messageRegionRect = messageRegion ? readRect(messageRegion) : null;
  if (openingOverlayRect === null && focused) {
    openingOverlayRect = overlayRect;
  } else if (openingOverlayRect && overlayRect && !rectsMatch(openingOverlayRect, overlayRect)) {
    fullOverlayGeometryStable = false;
  }
  const overlayHeightChanged =
    openingOverlayRect !== null &&
    overlayRect !== null &&
    Math.abs(openingOverlayRect.height - overlayRect.height) > GEOMETRY_STABLE_TOLERANCE_PX;
  const actualDockCandidate = calculateActualDockInset(overlayRect, viewport.bottom);

  let phase = snapshot.phase;
  let committedInsetChanged = false;
  let dockInsetChanged = false;
  const iosStandaloneCommitInset =
    iosStandaloneOpeningActive &&
    iosStandaloneSampleAtMs !== undefined &&
    focused &&
    (phase === "opening" || phase === "open")
      ? sampleIosStandaloneOpening({
          scheduledAtMs: iosStandaloneSampleAtMs,
          now,
          baselineHeight,
          layoutWidth,
          viewport,
        })
      : null;
  const openingCommitReady =
    phase === "opening" &&
    occluded &&
    candidateDecision.accepted &&
    !iosStandaloneOpeningActive &&
    (
      stableFrameCount >= GEOMETRY_STABLE_FRAME_COUNT ||
      (focusStartedAt > 0 && now - focusStartedAt >= OPENING_COMMIT_FALLBACK_MS)
    );
  const committedAdjustmentReady =
    phase === "open" &&
    !iosStandaloneOpeningActive &&
    occluded &&
    candidateDecision.accepted &&
    stableFrameCount >= GEOMETRY_STABLE_FRAME_COUNT &&
    Math.abs(acceptedCandidateInset - committedKeyboardInset) > 64 &&
    (
      orientation !== snapshot.orientation ||
      (committedAt > 0 && now - committedAt >= 250)
    );

  const standaloneCommitReady =
    iosStandaloneCommitInset !== null &&
    (
      committedKeyboardInset === 0 ||
      iosStandaloneOpeningOrientationChanged ||
      Math.abs(iosStandaloneCommitInset - committedKeyboardInset) >
        IOS_STANDALONE_LARGE_CORRECTION_PX
    );
  const nextAppliedDockInset = iosStandaloneOpeningActive
    ? 0
    : reconcileActualDockInset(
        actualDockCandidate,
        appliedDockInset,
        composerRect,
        viewport.bottom
      );
  const dockAdjustmentReady =
    phase === "open" &&
    focused &&
    candidateDecision.accepted &&
    stableFrameCount >= GEOMETRY_STABLE_FRAME_COUNT &&
    Math.abs(nextAppliedDockInset - appliedDockInset) > GEOMETRY_STABLE_TOLERANCE_PX;

  if (openingCommitReady || committedAdjustmentReady || standaloneCommitReady) {
    if (composerRectBeforeCommit === null) composerRectBeforeCommit = composerRect;
    committedKeyboardInset = iosStandaloneCommitInset ?? acceptedCandidateInset;
    if (Math.abs(nextAppliedDockInset - appliedDockInset) > GEOMETRY_STABLE_TOLERANCE_PX) {
      appliedDockInset = nextAppliedDockInset;
      dockInsetChanged = true;
    }
    committedInsetUpdateCount += 1;
    committedAt = now;
    committedInsetChanged = true;
    if (iosStandaloneOpeningActive) {
      committedInsetByOrientation.set(orientation, committedKeyboardInset);
    }
  } else if (dockAdjustmentReady) {
    appliedDockInset = nextAppliedDockInset;
    dockInsetChanged = true;
  } else if (
    committedAt > 0 &&
    composerRectAfterCommit === null &&
    committedKeyboardInset > 0
  ) {
    composerRectAfterCommit = composerRect;
  }

  if (occluded && focused) {
    if (phase === "closed") {
      phase = "opening";
      phaseStartedAt = now;
    } else if (
      phase === "opening" &&
      (openingCommitReady || standaloneCommitReady || committedKeyboardInset > 0)
    ) {
      phase = "open";
    }
  } else if (
    phase === "open" &&
    focused &&
    candidateDecision.accepted &&
    stableFrameCount >= GEOMETRY_STABLE_FRAME_COUNT
  ) {
    phase = "closing";
    phaseStartedAt = now;
  } else if (
    phase === "closing" &&
    (
      forceClose ||
      (
        candidateDecision.accepted &&
        acceptedCandidateInset <= KEYBOARD_CLOSED_BOUNDARY_TOLERANCE_PX &&
        stableFrameCount >= GEOMETRY_STABLE_FRAME_COUNT
      )
    )
  ) {
    phase = "closed";
  } else if (
    phase === "opening" &&
    now - phaseStartedAt >= OPENING_GRACE_MS &&
    stableFrameCount >= GEOMETRY_STABLE_FRAME_COUNT &&
    (!iosStandaloneOpeningActive || iosStandaloneOpeningVerified)
  ) {
    phase = "closed";
  }

  if (phase === "closed") {
    if (isPlausibleClosedBoundary(viewport.bottom, layoutWidth, viewport)) {
      baselineHeight = viewport.bottom;
      keyboardBoundary = baselineHeight;
      acceptedCandidateInset = 0;
      keyboardOcclusion = 0;
      keyboardInset = 0;
      occluded = false;
      baselineByOrientation.set(orientation, baselineHeight);
      acceptedBoundaryByOrientation.set(orientation, baselineHeight);
    }
    if (committedKeyboardInset !== 0) {
      committedKeyboardInset = 0;
      committedInsetChanged = true;
    }
    if (appliedDockInset !== 0) {
      appliedDockInset = 0;
      dockInsetChanged = true;
    }
    closingGeneration = null;
    cancelClosingFallback();
  }

  const composerGap = composerRect ? viewport.bottom - composerRect.bottom : null;
  const previousPhase = snapshot.phase;
  const previousComposerGap = snapshot.composerGap;
  const next: MobileKeyboardDockingSnapshot = {
    timestamp: Date.now(),
    phase,
    focused,
    standalone,
    orientation,
    baselineHeight,
    keyboardOcclusion,
    viewport,
    activeChatType: activeOverlay?.type ?? "none",
    ...readDocumentScrollSnapshot(),
    iosStandaloneChatRootLockActive: isIosStandaloneChatRootLocked(),
    lockedScrollPosition: lockedScrollPosition ? { ...lockedScrollPosition } : null,
    overlayRect,
    composerRect,
    rawCandidateBoundary,
    rawCandidateInset,
    candidateAccepted: candidateDecision.accepted,
    candidateDecisionReason: candidateDecision.reason,
    keyboardBoundary,
    keyboardInset,
    acceptedCandidateInset,
    committedKeyboardInset,
    appliedDockInset,
    rawCandidateChangeCount,
    committedInsetUpdateCount,
    keyboardGeneration,
    activeTextElement: describeTextEntry(document.activeElement),
    focusToFirstContractedMs:
      firstContractedAt > 0 && focusStartedAt > 0 ? firstContractedAt - focusStartedAt : null,
    focusToCommittedInsetMs:
      committedAt > 0 && focusStartedAt > 0 ? committedAt - focusStartedAt : null,
    composerRectBeforeCommit,
    composerRectAfterCommit,
    messageRegionRect,
    fullOverlayGeometryStable,
    overlayHeightChanged,
    composerGap,
    lastEvent: event
  };
  publishSnapshot(next);
  maybeReleaseIosStandaloneChatRootLock();
  if (committedInsetChanged || dockInsetChanged) {
    window.dispatchEvent(new Event(MOBILE_KEYBOARD_COMMITTED_EVENT));
  }

  if (previousPhase !== phase) {
    phaseStartedAt = now;
    recordDiagnosticEvent(`keyboard-${phase}-classification`);
    recordDiagnosticEvent(`transition-completion:${phase}`);
    if (phase === "closed") {
      window.dispatchEvent(new Event(MOBILE_KEYBOARD_SETTLED_EVENT));
    }
  }
  if (
    diagnosticEnabled &&
    composerGap !== null &&
    (previousComposerGap === null || Math.abs(previousComposerGap - composerGap) > 0.5)
  ) {
    recordDiagnosticEvent("composer-position-update");
  }

  settlingFramesRemaining = Math.max(0, settlingFramesRemaining - 1);
  if (
    settlingFramesRemaining > 0 &&
    (
      phase === "opening" ||
      phase === "closing" ||
      !candidateDecision.accepted ||
      committedInsetChanged ||
      dockInsetChanged
    ) &&
    animationFrameId === null
  ) {
    animationFrameId = window.requestAnimationFrame(() => {
      animationFrameId = null;
      measure("settling-frame");
    });
  }
}

function sampleIosStandaloneOpening({
  scheduledAtMs,
  now,
  baselineHeight,
  layoutWidth,
  viewport,
}: {
  scheduledAtMs: number;
  now: number;
  baselineHeight: number;
  layoutWidth: number;
  viewport: MobileKeyboardDockingSnapshot["viewport"];
}): number | null {
  if (iosStandaloneOpeningVerified || focusStartedAt <= 0) return null;

  const elapsedMs = now - focusStartedAt;
  const inset = Math.max(0, baselineHeight - viewport.bottom);
  const contracted = inset > KEYBOARD_OCCLUSION_THRESHOLD_PX;
  const structurallyValid =
    Number.isFinite(viewport.bottom) &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width >= Math.max(160, layoutWidth * 0.6) &&
    viewport.height > 0 &&
    viewport.bottom >= 80 &&
    viewport.bottom <= baselineHeight + 24;
  const provisional =
    elapsedMs < IOS_STANDALONE_MIN_COMMIT_DELAY_MS ||
    (
      viewport.top === 0 &&
      contracted &&
      scheduledAtMs < IOS_STANDALONE_ZERO_TOP_PROVISIONAL_MS
    );
  const sample: IosStandaloneOpeningSample = {
    scheduledAtMs,
    elapsedMs,
    height: viewport.height,
    offsetTop: viewport.top,
    offsetLeft: viewport.left,
    boundary: viewport.bottom,
    inset,
    valid: structurallyValid && contracted && !provisional
  };
  iosStandaloneOpeningSamples.push(sample);

  if (elapsedMs < IOS_STANDALONE_MIN_COMMIT_DELAY_MS) return null;

  if (sample.valid) {
    const previousStableSample = [...iosStandaloneOpeningSamples]
      .slice(0, -1)
      .reverse()
      .find((previous) =>
        previous.valid &&
        sample.elapsedMs - previous.elapsedMs >= IOS_STANDALONE_SAMPLE_MIN_SEPARATION_MS &&
        Math.abs(sample.boundary - previous.boundary) <= IOS_STANDALONE_BOUNDARY_TOLERANCE_PX
      );
    if (previousStableSample) {
      iosStandaloneOpeningVerified = true;
      return Math.max(0, baselineHeight - average([previousStableSample.boundary, sample.boundary]));
    }
  }

  if (
    scheduledAtMs <
    IOS_STANDALONE_OPENING_SAMPLE_DELAYS_MS[
      IOS_STANDALONE_OPENING_SAMPLE_DELAYS_MS.length - 1
    ]!
  ) {
    return null;
  }

  const fallbackBoundaries = iosStandaloneOpeningSamples
    .filter((candidate) => candidate.valid)
    .slice(-3)
    .map((candidate) => candidate.boundary);
  iosStandaloneOpeningVerified = true;
  if (fallbackBoundaries.length === 0) return null;
  return Math.max(0, baselineHeight - median(fallbackBoundaries));
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? average([sorted[midpoint - 1]!, sorted[midpoint]!])
    : sorted[midpoint]!;
}

function validateBoundaryCandidate({
  rawCandidateBoundary,
  baselineHeight,
  layoutWidth,
  viewport,
  focused,
  phase,
  previousAccepted
}: {
  rawCandidateBoundary: number;
  baselineHeight: number;
  layoutWidth: number;
  viewport: MobileKeyboardDockingSnapshot["viewport"];
  focused: boolean;
  phase: MobileKeyboardPhase;
  previousAccepted: number;
}): { accepted: boolean; reason: string } {
  if (
    !Number.isFinite(rawCandidateBoundary) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { accepted: false, reason: "rejected-nonfinite-or-empty-viewport" };
  }
  if (
    viewport.width < Math.max(160, layoutWidth * 0.6) ||
    rawCandidateBoundary < 80 ||
    rawCandidateBoundary > baselineHeight + 24
  ) {
    return { accepted: false, reason: "rejected-outside-layout-bounds" };
  }
  if (!focused && phase === "closed" && baselineHeight - rawCandidateBoundary > KEYBOARD_OCCLUSION_THRESHOLD_PX) {
    return { accepted: false, reason: "rejected-closed-viewport-occlusion" };
  }
  if (
    focused &&
    (phase === "opening" || phase === "open") &&
    baselineHeight - previousAccepted > KEYBOARD_OCCLUSION_THRESHOLD_PX &&
    rawCandidateBoundary - previousAccepted > 96 &&
    stableFrameCount < GEOMETRY_STABLE_FRAME_COUNT
  ) {
    return { accepted: false, reason: "rejected-open-viewport-expansion" };
  }
  if (
    phase === "closing" &&
    previousAccepted - rawCandidateBoundary > 64
  ) {
    return { accepted: false, reason: "rejected-closing-viewport-reversal" };
  }
  return { accepted: true, reason: "accepted-advisory-boundary" };
}

function calculateActualDockInset(
  overlayRect: RectSnapshot | null,
  visibleViewportBottom: number
): number {
  if (
    overlayRect === null ||
    !Number.isFinite(overlayRect.bottom) ||
    !Number.isFinite(overlayRect.height) ||
    !Number.isFinite(visibleViewportBottom) ||
    overlayRect.height <= 0
  ) {
    return 0;
  }
  const physicallyOccluded = Math.max(0, overlayRect.bottom - visibleViewportBottom);
  return Math.min(physicallyOccluded, overlayRect.height * MAX_DOCK_FRACTION);
}

function reconcileActualDockInset(
  measuredDockInset: number,
  currentDockInset: number,
  composerRect: RectSnapshot | null,
  visibleViewportBottom: number
): number {
  if (
    currentDockInset <= 0 ||
    composerRect === null ||
    !Number.isFinite(composerRect.bottom) ||
    !Number.isFinite(composerRect.height) ||
    composerRect.height <= 0 ||
    !Number.isFinite(visibleViewportBottom)
  ) {
    return measuredDockInset;
  }
  const visibleGap = visibleViewportBottom - composerRect.bottom;
  if (visibleGap <= GEOMETRY_STABLE_TOLERANCE_PX) return measuredDockInset;
  return Math.max(0, Math.min(measuredDockInset, currentDockInset - visibleGap));
}

function isPlausibleClosedBoundary(
  boundary: number,
  layoutWidth: number,
  viewport: MobileKeyboardDockingSnapshot["viewport"]
): boolean {
  return (
    Number.isFinite(boundary) &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width >= Math.max(160, layoutWidth * 0.6) &&
    viewport.height > 0 &&
    boundary >= 80
  );
}

function publishSnapshot(next: MobileKeyboardDockingSnapshot): void {
  snapshot = next;
  if (
    transitionSnapshot.phase !== next.phase ||
    transitionSnapshot.focused !== next.focused ||
    transitionSnapshot.activeChatType !== next.activeChatType
  ) {
    transitionSnapshot = {
      phase: next.phase,
      focused: next.focused,
      activeChatType: next.activeChatType
    };
  }
  const root = document.documentElement;
  root.dataset.mobileKeyboardPhase = next.phase;
  root.dataset.virtualKeyboard = next.phase === "closed" ? "closed" : "open";
  root.dataset.textEntryFocused = next.focused ? "true" : "false";
  root.dataset.mobileKeyboardCommitted =
    next.committedKeyboardInset > 0 && !(next.phase === "closing" && readIosStandalone())
      ? "true"
      : "false";
  root.style.setProperty("--mobile-chat-keyboard-boundary", `${next.keyboardBoundary}px`);
  root.style.setProperty("--mobile-chat-keyboard-inset", `${next.keyboardInset}px`);
  root.style.setProperty(
    "--mobile-chat-committed-keyboard-inset",
    `${next.committedKeyboardInset}px`
  );
  root.style.setProperty(
    "--mobile-chat-applied-keyboard-inset",
    `${next.appliedDockInset}px`
  );
  for (const listener of listeners) listener();
}

function getMobileKeyboardTransitionSnapshot(): MobileKeyboardTransitionSnapshot {
  return transitionSnapshot;
}

function recordDiagnosticEvent(event: string): void {
  if (!diagnosticEnabled) return;
  const visual = window.visualViewport;
  const active = document.activeElement;
  diagnosticSequence += 1;
  diagnosticHistory.push({
    sequence: diagnosticSequence,
    timestamp: Date.now(),
    event,
    phase: snapshot.phase,
    focused: isTextEntry(active),
    activeChatType: snapshot.activeChatType,
    innerHeight: window.innerHeight,
    clientHeight: document.documentElement.clientHeight,
    ...readDocumentScrollSnapshot(),
    iosStandaloneChatRootLockActive: isIosStandaloneChatRootLocked(),
    lockedScrollPosition: lockedScrollPosition ? { ...lockedScrollPosition } : null,
    visualViewport: visual
      ? {
          width: visual.width,
          height: visual.height,
          offsetTop: visual.offsetTop,
          offsetLeft: visual.offsetLeft,
          bottom: visual.offsetTop + visual.height
        }
      : null,
    overlayRect: snapshot.overlayRect,
    composerRect: snapshot.composerRect,
    messageRegionRect: snapshot.messageRegionRect,
    baselineHeight: snapshot.baselineHeight,
    keyboardOcclusion: snapshot.keyboardOcclusion,
    rawCandidateBoundary: snapshot.rawCandidateBoundary,
    rawCandidateInset: snapshot.rawCandidateInset,
    candidateAccepted: snapshot.candidateAccepted,
    candidateDecisionReason: snapshot.candidateDecisionReason,
    keyboardBoundary: snapshot.keyboardBoundary,
    keyboardInset: snapshot.keyboardInset,
    acceptedCandidateInset: snapshot.acceptedCandidateInset,
    committedKeyboardInset: snapshot.committedKeyboardInset,
    appliedDockInset: snapshot.appliedDockInset,
    rawCandidateChangeCount: snapshot.rawCandidateChangeCount,
    committedInsetUpdateCount: snapshot.committedInsetUpdateCount,
    keyboardGeneration: snapshot.keyboardGeneration,
    activeTextElement: describeTextEntry(active),
    overlayHeightChanged: snapshot.overlayHeightChanged,
    composerGap: snapshot.composerGap
  });
  if (diagnosticHistory.length > DIAGNOSTIC_HISTORY_LIMIT) {
    diagnosticHistory.splice(0, diagnosticHistory.length - DIAGNOSTIC_HISTORY_LIMIT);
  }
}

function readDocumentScrollSnapshot(): Pick<
  MobileKeyboardDockingSnapshot,
  "windowScrollX" | "windowScrollY" | "documentScrollLeft" | "documentScrollTop"
> {
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  return {
    windowScrollX: window.scrollX,
    windowScrollY: window.scrollY,
    documentScrollLeft: scrollingElement.scrollLeft,
    documentScrollTop: scrollingElement.scrollTop
  };
}

function readOrientation(): "portrait" | "landscape" {
  return window.screen.width >= window.screen.height ? "landscape" : "portrait";
}

function readStandalone(): boolean {
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function readIosStandalone(): boolean {
  if (!readStandalone()) return false;
  const iosUserAgent = /iPad|iPhone|iPod/i.test(navigator.userAgent);
  const ipadDesktopMode =
    navigator.platform === "MacIntel" &&
    navigator.maxTouchPoints > 1;
  return iosUserAgent || ipadDesktopMode;
}

function isTextEntry(value: unknown): value is HTMLElement {
  return (
    value instanceof HTMLInputElement ||
    value instanceof HTMLTextAreaElement ||
    (value instanceof HTMLElement && value.isContentEditable === true)
  );
}

function describeTextEntry(value: unknown): string | null {
  if (
    !(value instanceof HTMLInputElement) &&
    !(value instanceof HTMLTextAreaElement) &&
    !(value instanceof HTMLElement && value.isContentEditable)
  ) {
    return null;
  }
  const overlay = value.closest<HTMLElement>("[data-mobile-chat-type]");
  const chatType = overlay?.dataset.mobileChatType ?? "outside-chat";
  const inputType =
    value instanceof HTMLInputElement
      ? value.type || "text"
      : value instanceof HTMLTextAreaElement
        ? "textarea"
        : "contenteditable";
  return `${chatType}:${value.tagName.toLowerCase()}:${inputType}`;
}

function readRect(element: HTMLElement): RectSnapshot {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
}

function rectsMatch(left: RectSnapshot, right: RectSnapshot): boolean {
  return (
    Math.abs(left.top - right.top) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(left.right - right.right) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(left.bottom - right.bottom) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(left.left - right.left) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(left.width - right.width) <= GEOMETRY_STABLE_TOLERANCE_PX &&
    Math.abs(left.height - right.height) <= GEOMETRY_STABLE_TOLERANCE_PX
  );
}

type LayerSnapshot = {
  rect: RectSnapshot;
  zIndex: string;
  visibility: string;
  display: string;
  opacity: string;
  pointerEvents: string;
  inert: boolean;
};

function readLayer(selector: string): LayerSnapshot | null {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const style = getComputedStyle(element);
  return {
    rect: readRect(element),
    zIndex: style.zIndex,
    visibility: style.visibility,
    display: style.display,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    inert: element.hasAttribute("inert")
  };
}

function numericZIndex(value: string | undefined): number {
  if (!value || value === "auto") return 0;
  return Number.parseFloat(value) || 0;
}

function readSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  if (!diagnosticEnabled) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!safeAreaProbe) {
    safeAreaProbe = document.createElement("div");
    safeAreaProbe.setAttribute("aria-hidden", "true");
    safeAreaProbe.style.cssText = [
      "position:fixed",
      "visibility:hidden",
      "pointer-events:none",
      "padding-top:env(safe-area-inset-top)",
      "padding-right:env(safe-area-inset-right)",
      "padding-bottom:env(safe-area-inset-bottom)",
      "padding-left:env(safe-area-inset-left)"
    ].join(";");
    document.body.append(safeAreaProbe);
  }
  const style = getComputedStyle(safeAreaProbe);
  return {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0
  };
}

function removeSafeAreaProbe(): void {
  safeAreaProbe?.remove();
  safeAreaProbe = null;
}
