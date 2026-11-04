import { setCombatSfxHandler, type CombatCueName } from "../combat/combatFeedback.js";
import { clientConfig } from "../config.js";
import { subscribeNativeAppStateChange } from "../native/nativeApp.js";
import track from "./hearthlightLoop.json";
import { sendAudioReport } from "./audioReport.js";
import { MusicEngine, defaultCreateContext, defaultLoadBuffer, isIosWebKit, type MusicStats, type TrackManifest } from "./musicEngine.js";
import { soundSettings, subscribeSoundSettings } from "./soundSettings.js";

/**
 * The game's audio wiring: one MusicEngine, started by the first user gesture, paused while the tab is hidden, the
 * window is blurred or the native app is inactive, ducked in combat, and fed by the combat cue hook.
 */

/** Combat cue sounds: none ship yet. Drop a decoded buffer in here and `playCombatCue` routes it through the sfx bus. */
const CUE_SOUNDS: Partial<Record<CombatCueName, AudioBuffer>> = {};

let engine: MusicEngine | null = null;
let installed = false;
let documentHidden = false;
let windowBlurred = false;
let nativeInactive = false;

export function gameAudio(): MusicEngine | null {
  return engine;
}

function syncHidden(): void {
  engine?.setHidden(documentHidden || windowBlurred || nativeInactive);
}

/** Installs the engine and its listeners once (called from App on mount). Returns the cleanup. */
export function installGameAudio(): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;
  const music = new MusicEngine(track as TrackManifest, {
    createContext: defaultCreateContext,
    // Last resort inside the native app: the same file from the live web build (the native CSP allows the web origin).
    loadBuffer: (ctx, url, note) => defaultLoadBuffer(ctx, url, note,
      clientConfig.nativePlatform === true && url.startsWith("/") ? new URL(`/play${url}`, clientConfig.serverHttpBase).toString() : undefined),
    baseUrl: import.meta.env.BASE_URL,
    // The native WebViews allow audio without a gesture (Capacitor sets no user-action requirement), so try at boot there.
    autoplay: clientConfig.nativePlatform === true
  });
  engine = music;
  // The loading screens are not the place for music: it waits for the world to appear (App calls setGameReady).
  music.setGameReady(false);
  music.setSettings(soundSettings());
  documentHidden = document.visibilityState === "hidden";
  syncHidden();

  // Browsers block audio until a real gesture; the engine preloads at boot and a gesture resumes it. Later gestures re-resume a suspended context.
  // Only events iOS accepts as user activation (touchend, click, keydown; pointerup for mouse/pen): pointerdown and
  // touchstart do not unlock WebKit audio, and a context created in them stays suspended.
  const onGesture = (event: Event): void => {
    // A real touch proves the app is on screen: drop any blur/inactive state that never got its matching focus/active event.
    windowBlurred = false;
    nativeInactive = false;
    documentHidden = document.visibilityState === "hidden";
    syncHidden();
    music.unlock(event.type);
  };
  const gestureEvents = ["touchend", "click", "keydown", "pointerup"] as const;
  for (const name of gestureEvents) window.addEventListener(name, onGesture, { capture: true, passive: true });

  const onVisibility = (): void => { documentHidden = document.visibilityState === "hidden"; syncHidden(); };
  // WKWebView fires window blur without a matching focus (keyboard, sheets), which would mute the music for good.
  const trustWindowFocus = !isIosWebKit();
  const onBlur = (): void => { windowBlurred = trustWindowFocus; syncHidden(); };
  const onFocus = (): void => { windowBlurred = false; syncHidden(); };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  const stopNative = subscribeNativeAppStateChange((active) => { nativeInactive = !active; syncHidden(); });
  music.setReporter(sendAudioReport, () => ({
    ua: navigator.userAgent.slice(0, 160),
    native: clientConfig.nativePlatform === true,
    nativeVersion: clientConfig.nativeVersion ?? null,
    build: clientConfig.buildSha?.slice(0, 12) ?? null,
    baseUrl: import.meta.env.BASE_URL,
    docVisibility: document.visibilityState,
    docHasFocus: document.hasFocus(),
    flagDocumentHidden: documentHidden,
    flagWindowBlurred: windowBlurred,
    flagNativeInactive: nativeInactive,
    touchPoints: navigator.maxTouchPoints
  }));
  // Create the context and start fetching now; the native app also tries to start playing without a gesture.
  music.preload();
  const stopSettings = subscribeSoundSettings(() => music.setSettings(soundSettings()));

  setCombatSfxHandler((name, detail) => {
    const buffer = CUE_SOUNDS[name];
    if (buffer) music.playSfx(buffer, detail.heavy ? 1 : 0.8);
  });

  const probe = window as unknown as { __ASH_ATLAS_AUDIO__?: () => MusicStats };
  probe.__ASH_ATLAS_AUDIO__ = () => music.snapshot();

  return () => {
    for (const name of gestureEvents) window.removeEventListener(name, onGesture, { capture: true });
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    stopNative();
    stopSettings();
    setCombatSfxHandler(null);
    delete probe.__ASH_ATLAS_AUDIO__;
    engine = null;
    installed = false;
  };
}
