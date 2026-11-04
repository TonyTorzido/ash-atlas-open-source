import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

import {
  isIosStandaloneMobileChat,
  isMobileKeyboardTransitionActive,
  MOBILE_KEYBOARD_SETTLED_EVENT,
  reconcileMobileChatProtectionState,
  startMobileKeyboardDocking
} from "./mobileKeyboardDocking.js";

export type UiPresentation = "touch" | "desktop";
export type PresentationPreview = "auto" | UiPresentation;
export const DESKTOP_PRESENTATION_MIN_WIDTH = 1100;

export type LayoutMode = "compact" | "wide";
export type LayoutPreference = "automatic" | LayoutMode;
export type InputMode = "touch" | "mouse" | "hybrid";
export type DisplayMode = "browser" | "standalone";
export type Orientation = "portrait" | "landscape";
export type Handedness = "right" | "left";

export const WIDE_LAYOUT_MIN_WIDTH = 768;
export const WIDE_LAYOUT_MIN_HEIGHT = 600;
export const FORCED_WIDE_SAFE_MIN_WIDTH = 700;
export const FORCED_WIDE_SAFE_MIN_HEIGHT = 520;
export const DESKTOP_MOBILE_STAGE_MAX_WIDTH = 1366;
export const DESKTOP_MOBILE_STAGE_MAX_HEIGHT = 1024;
export const DESKTOP_MOBILE_STAGE_INSET = 16;
export const DESKTOP_MOBILE_STAGE_ASPECT_RATIO =
  DESKTOP_MOBILE_STAGE_MAX_WIDTH / DESKTOP_MOBILE_STAGE_MAX_HEIGHT;

export type UiSignals = {
  width: number;
  height: number;
  hasTouch: boolean;
  hasFinePointer: boolean;
  hasCoarsePointer: boolean;
};

export type UiEnvironment = {
  profile: "phone";
  presentation: UiPresentation;
  presentationPreview: PresentationPreview;
  setPresentationPreview(value: PresentationPreview): void;
  automaticLayoutMode: LayoutMode;
  layoutMode: LayoutMode;
  layoutPreference: LayoutPreference;
  wideOverrideBlocked: boolean;
  inputMode: InputMode;
  hasTouch: boolean;
  hasFinePointer: boolean;
  hasCoarsePointer: boolean;
  displayMode: DisplayMode;
  orientation: Orientation;
  handedness: Handedness;
  viewport: { width: number; height: number };
  visualViewport: { width: number; height: number; offsetTop: number; offsetLeft: number } | null;
  setLayoutPreference(value: LayoutPreference): void;
  setHandedness(value: Handedness): void;
};

const LAYOUT_PREFERENCE_STORAGE_KEY = "ashAtlas.ui.layout";

export function resolveAutomaticLayoutMode(signals: UiSignals): LayoutMode {
  return signals.width >= WIDE_LAYOUT_MIN_WIDTH &&
    signals.height >= WIDE_LAYOUT_MIN_HEIGHT
    ? "wide"
    : "compact";
}

/** Tablets and hybrid touch devices retain the touch shell even at desktop widths. */
export function resolveUiPresentation(signals: UiSignals): UiPresentation {
  return signals.width >= DESKTOP_PRESENTATION_MIN_WIDTH && signals.height >= WIDE_LAYOUT_MIN_HEIGHT
    && signals.hasFinePointer && !signals.hasTouch && !signals.hasCoarsePointer ? "desktop" : "touch";
}

export function resolveInputMode(signals: UiSignals): InputMode {
  if (signals.hasTouch && signals.hasFinePointer) return "hybrid";
  if (signals.hasTouch) return "touch";
  return "mouse";
}

export function resolveEffectiveLayoutMode(
  automaticLayoutMode: LayoutMode,
  preference: LayoutPreference,
  viewport: { width: number; height: number }
): { layoutMode: LayoutMode; wideOverrideBlocked: boolean } {
  if (preference === "automatic") {
    return { layoutMode: automaticLayoutMode, wideOverrideBlocked: false };
  }
  if (preference === "compact") {
    return { layoutMode: "compact", wideOverrideBlocked: false };
  }
  const safeForWide =
    viewport.width >= FORCED_WIDE_SAFE_MIN_WIDTH &&
    viewport.height >= FORCED_WIDE_SAFE_MIN_HEIGHT;
  return {
    layoutMode: safeForWide ? "wide" : "compact",
    wideOverrideBlocked: !safeForWide
  };
}

export function detectDisplayMode(input: {
  standaloneMedia: boolean;
  navigatorStandalone?: boolean;
}): DisplayMode {
  return input.standaloneMedia || input.navigatorStandalone === true ? "standalone" : "browser";
}

type BrowserNavigator = Navigator & { standalone?: boolean };
type UiEnvironmentSnapshot = Omit<UiEnvironment, "setLayoutPreference" | "setHandedness" | "presentationPreview" | "setPresentationPreview"> & { browserViewport: { width: number; height: number } };

export function resolveApplicationViewport(
  viewport: { width: number; height: number },
  layoutMode: LayoutMode
): { width: number; height: number } {
  if (layoutMode === "compact") return viewport;
  const availableWidth = Math.max(1, viewport.width - DESKTOP_MOBILE_STAGE_INSET * 2);
  const availableHeight = Math.max(1, viewport.height - DESKTOP_MOBILE_STAGE_INSET * 2);
  const height = Math.min(
    DESKTOP_MOBILE_STAGE_MAX_HEIGHT,
    availableHeight,
    availableWidth / DESKTOP_MOBILE_STAGE_ASPECT_RATIO
  );
  return {
    width: Math.min(
      DESKTOP_MOBILE_STAGE_MAX_WIDTH,
      availableWidth,
      height * DESKTOP_MOBILE_STAGE_ASPECT_RATIO
    ),
    height
  };
}

function readBrowserSnapshot(): UiEnvironmentSnapshot {
  const visual = window.visualViewport;
  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  const signals = {
    width,
    height,
    hasTouch: (navigator.maxTouchPoints ?? 0) > 0,
    hasFinePointer: window.matchMedia("(any-pointer: fine)").matches,
    hasCoarsePointer: window.matchMedia("(any-pointer: coarse)").matches
  };
  const automaticLayoutMode = resolveAutomaticLayoutMode(signals);
  const layoutPreference = readLayoutPreference();
  const { layoutMode, wideOverrideBlocked } = resolveEffectiveLayoutMode(
    automaticLayoutMode,
    layoutPreference,
    { width, height }
  );
  const inputMode = resolveInputMode(signals);
  const displayMode = detectDisplayMode({
    standaloneMedia: window.matchMedia("(display-mode: standalone)").matches,
    ...((navigator as BrowserNavigator).standalone === undefined
      ? {}
      : { navigatorStandalone: (navigator as BrowserNavigator).standalone })
  });
  const viewport = resolveApplicationViewport({ width, height }, layoutMode);
  const orientation =
    layoutMode === "wide"
      ? (viewport.width >= viewport.height ? "landscape" : "portrait")
      : displayMode === "standalone"
      ? (window.screen.width >= window.screen.height ? "landscape" : "portrait")
      : (width >= height ? "landscape" : "portrait");
  return {
    profile: "phone",
    browserViewport: { width, height },
    presentation: resolveUiPresentation(signals),
    automaticLayoutMode,
    layoutMode,
    layoutPreference,
    wideOverrideBlocked,
    inputMode,
    hasTouch: signals.hasTouch,
    hasFinePointer: signals.hasFinePointer,
    hasCoarsePointer: signals.hasCoarsePointer,
    displayMode,
    orientation,
    handedness: "right",
    viewport,
    visualViewport: layoutMode === "wide" ? {
      ...viewport,
      offsetTop: 0,
      offsetLeft: 0
    } : visual ? {
      width: visual.width,
      height: visual.height,
      offsetTop: visual.offsetTop,
      offsetLeft: visual.offsetLeft
    } : null
  };
}

export function subscribeUiEnvironment(onChange: () => void): () => void {
  const mediaQueries = [
    window.matchMedia("(display-mode: standalone)"),
    window.matchMedia("(any-pointer: fine)"),
    window.matchMedia("(any-pointer: coarse)")
  ];
  const onResize = (): void => {
    if (!isMobileKeyboardTransitionActive()) onChange();
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onChange);
  window.addEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, onChange);
  for (const media of mediaQueries) media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onChange);
    window.removeEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, onChange);
    for (const media of mediaQueries) media.removeEventListener("change", onChange);
  };
}

const UiEnvironmentContext = createContext<UiEnvironment | null>(null);

export function UiEnvironmentProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(readBrowserSnapshot);
  // Developer preview is deliberately memory-only: reload always restores detection.
  const [presentationPreview, setPresentationPreview] = useState<PresentationPreview>("auto");
  const presentation = presentationPreview === "auto" ? snapshot.presentation : presentationPreview;
  const viewport = resolveApplicationViewport(snapshot.browserViewport, presentation === "desktop" ? "compact" : snapshot.layoutMode);
  useEffect(() => {
    const stopKeyboardDocking = startMobileKeyboardDocking();
    const unsubscribe = subscribeUiEnvironment(() => {
      const next = readBrowserSnapshot();
      setSnapshot(next);
    });
    return () => {
      unsubscribe();
      stopKeyboardDocking();
    };
  }, []);
  useLayoutEffect(() => {
    applyUiEnvironmentRootState({ ...snapshot, presentation });
    reconcileMobileChatProtectionState("ui-environment");
  }, [
    snapshot.displayMode,
    snapshot.handedness,
    snapshot.inputMode,
    snapshot.layoutMode,
    snapshot.orientation,
    snapshot.profile,
    presentation
  ]);

  const value = useMemo<UiEnvironment>(() => ({
    ...snapshot,
    presentation,
    presentationPreview,
    setPresentationPreview,
    viewport,
    visualViewport: presentation === "desktop" || snapshot.layoutMode === "wide" ? { ...viewport, offsetTop: 0, offsetLeft: 0 } : snapshot.visualViewport,
    setLayoutPreference: (layoutPreference) => {
      persistLayoutPreference(layoutPreference);
      setSnapshot(readBrowserSnapshot());
    },
    setHandedness: () => undefined
  }), [snapshot, presentation, presentationPreview]);
  return <UiEnvironmentContext.Provider value={value}>{children}</UiEnvironmentContext.Provider>;
}

function applyUiEnvironmentRootState(snapshot: UiEnvironmentSnapshot): void {
  const root = document.documentElement;
  root.dataset.uiProfile = snapshot.profile;
  root.dataset.layoutMode = snapshot.layoutMode;
  root.dataset.inputMode = snapshot.inputMode;
  root.dataset.presentation = snapshot.presentation;
  root.dataset.displayMode = snapshot.displayMode;
  if (isIosStandaloneMobileChat()) root.dataset.iosStandalone = "true";
  else delete root.dataset.iosStandalone;
  root.dataset.orientation = snapshot.orientation;
  root.dataset.handedness = snapshot.handedness;
}

export function initializeUiEnvironmentRootState(): void {
  applyUiEnvironmentRootState(readBrowserSnapshot());
}

export function useUiPresentation(): UiPresentation {
  return useContext(UiEnvironmentContext)?.presentation ?? "touch";
}

export function useUiEnvironment(): UiEnvironment {
  const value = useContext(UiEnvironmentContext);
  if (!value) throw new Error("useUiEnvironment must be used inside UiEnvironmentProvider");
  return value;
}

function parseLayoutPreference(value: string | null): LayoutPreference | null {
  return value === "automatic" || value === "compact" || value === "wide" ? value : null;
}

function readLayoutPreference(): LayoutPreference {
  return parseLayoutPreference(window.localStorage.getItem(LAYOUT_PREFERENCE_STORAGE_KEY)) ?? "automatic";
}

function persistLayoutPreference(value: LayoutPreference): void {
  if (value === "automatic") window.localStorage.removeItem(LAYOUT_PREFERENCE_STORAGE_KEY);
  else window.localStorage.setItem(LAYOUT_PREFERENCE_STORAGE_KEY, value);
}
