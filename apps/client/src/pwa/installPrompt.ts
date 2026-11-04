export type InstallPromptOutcome = "accepted" | "dismissed" | "unavailable";

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type StandaloneNavigator = Navigator & { standalone?: boolean };

let installEvent: BeforeInstallPromptEvent | null = null;
let attachedWindow: Window | null = null;
const subscribers = new Set<() => void>();

function publish(): void {
  for (const subscriber of subscribers) subscriber();
}

export function initializeWebInstallPrompt(targetWindow: Window = window): void {
  if (attachedWindow === targetWindow) return;
  attachedWindow?.removeEventListener("beforeinstallprompt", captureInstallPrompt);
  attachedWindow?.removeEventListener("appinstalled", clearInstallPrompt);
  attachedWindow = targetWindow;
  installEvent = null;
  targetWindow.addEventListener("beforeinstallprompt", captureInstallPrompt as EventListener);
  targetWindow.addEventListener("appinstalled", clearInstallPrompt);
}

function captureInstallPrompt(event: Event): void {
  event.preventDefault();
  installEvent = event as BeforeInstallPromptEvent;
  publish();
}

function clearInstallPrompt(): void {
  installEvent = null;
  publish();
}

export function subscribeInstallAvailability(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function isInstallPromptAvailable(): boolean {
  return installEvent !== null;
}

export async function promptToInstall(): Promise<InstallPromptOutcome> {
  const current = installEvent;
  if (!current) return "unavailable";
  installEvent = null;
  publish();
  await current.prompt();
  const { outcome } = await current.userChoice;
  return outcome;
}

export function isRunningAsInstalledApp(targetWindow: Window = window): boolean {
  return Boolean(
    targetWindow.matchMedia?.("(display-mode: standalone)").matches ||
    (targetWindow.navigator as StandaloneNavigator).standalone
  );
}

export function isIosSafari(targetWindow: Window = window): boolean {
  const userAgent = targetWindow.navigator.userAgent;
  const isAppleTouchDevice = /iPad|iPhone|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && targetWindow.navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(userAgent) &&
    !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(userAgent);
  return isAppleTouchDevice && isSafari && !isRunningAsInstalledApp(targetWindow);
}

export function isAndroidBrowser(targetWindow: Window = window): boolean {
  return /Android/i.test(targetWindow.navigator.userAgent) &&
    !isRunningAsInstalledApp(targetWindow);
}

export function shouldOpenInstallInstructions(targetWindow: Window = window): boolean {
  return new URLSearchParams(targetWindow.location.search).get("install") === "1" &&
    !isRunningAsInstalledApp(targetWindow) &&
    (isIosSafari(targetWindow) || isAndroidBrowser(targetWindow));
}
