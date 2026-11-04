/**
 * The one live puzzle session: the runtime plus the browser sensor hub, and a
 * tiny listener bus the Pixi layer, the HUD, the NPC talk action and the
 * server-report path share. No React and no Pixi in here.
 */
import { HeartPuzzleRuntime } from "./heartPuzzleRuntime.js";
import { SensorHub } from "./sensorHub.js";
import { vaultSfx } from "./vault/vaultSfx.js";
import type { VaultEvent } from "./vault/vaultTypes.js";

type SolveReport = Readonly<{ sessionId: string; roomId: string; solveMs: number }>;

const solveListeners = new Set<(report: SolveReport) => void>();
const talkListeners = new Set<(npcObjectId: string) => void>();

let hub: SensorHub | null = null;
export const heartPuzzleHub = (): SensorHub => (hub ??= new SensorHub());

const eventListeners = new Set<(event: VaultEvent) => void>();

/** Visual layer and HUD subscribe here; haptics and sound are played by this module. */
export const onVaultEvent = (listener: (event: VaultEvent) => void): (() => void) => {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
};

const feedbackFor = (event: VaultEvent): void => {
  const h = heartPuzzleHub();
  switch (event.type) {
    // Impact ticks scale with how hard the marble hit.
    case "bump": h.haptic(Math.round(6 + event.strength * 24)); vaultSfx.bump(event.strength); break;
    case "fell": h.haptic([30, 40, 20]); vaultSfx.fall(); break;
    case "respawned": vaultSfx.respawn(); break;
    case "crack-broke": h.haptic([18, 24, 30]); vaultSfx.crumble(); break;
    case "wall-chip": h.haptic(35); vaultSfx.chip(); break;
    case "wall-broke": h.haptic([40, 30, 60]); vaultSfx.wallBreak(); break;
    case "plate": break; // the layer clicks per plate, on the press itself
    case "won": h.haptic([20, 40, 20, 40, 60, 60, 90]); vaultSfx.sealChime(); break;
  }
};

export const heartPuzzleRuntime = new HeartPuzzleRuntime({
  readInput: () => ({ tilt: heartPuzzleHub().read().tilt }),
  onEvent: (event) => {
    feedbackFor(event);
    for (const listener of eventListeners) listener(event);
  },
  onSolved: (report) => { for (const listener of solveListeners) listener(report); }
});

/** Old Pell's speech bubble: the HUD asks, the Pixi layer shows it beside him and reports back. */
export type PellBubble = { text: string; from: number; until: number };
let bubble: PellBubble | null = null;
let bubbleDrawnAt = 0;
export const pellBubble = (): PellBubble | null => (bubble && bubble.until > performance.now() ? bubble : null);
export const showPellBubble = (text: string, ms = 9000): void => { bubble = { text, from: performance.now(), until: performance.now() + ms }; };
export const hidePellBubble = (): void => { bubble = null; };
/** The layer calls this each frame it actually draws the bubble; the HUD falls back to its panel if it never does. */
export const markPellBubbleDrawn = (): void => { bubbleDrawnAt = performance.now(); };
export const pellBubbleIsDrawn = (): boolean => performance.now() - bubbleDrawnAt < 400;

export const onHeartPuzzleSolved = (listener: (report: SolveReport) => void): (() => void) => {
  solveListeners.add(listener);
  return () => { solveListeners.delete(listener); };
};

type ActiveRequest = Readonly<{ sessionId: string; roomId: string; active: boolean }>;
const activeListeners = new Set<(request: ActiveRequest) => void>();

/** App sends DUNGEON_PUZZLE_ACTIVE for these (Start in Old Pell's popup, Give up). */
export const onHeartPuzzleActiveRequest = (listener: (request: ActiveRequest) => void): (() => void) => {
  activeListeners.add(listener);
  return () => { activeListeners.delete(listener); };
};

/** Ask the server to start or quit the current room's puzzle. */
export const requestHeartPuzzleActive = (active: boolean): boolean => {
  const context = heartPuzzleRuntime.context;
  if (!context) return false;
  for (const listener of activeListeners) listener({ sessionId: context.sessionId, roomId: context.roomId, active });
  return activeListeners.size > 0;
};

/** True while this player is at a running puzzle: the joystick, double-tap and dash stay still (the server agrees). */
export const heartPuzzleLocked = (): boolean => heartPuzzleRuntime.status()?.active === true;

export const onHeartPuzzleTalk = (listener: (npcObjectId: string) => void): (() => void) => {
  talkListeners.add(listener);
  return () => { talkListeners.delete(listener); };
};

export const talkToHeartPuzzleNpc = (npcObjectId: string): void => {
  for (const listener of talkListeners) listener(npcObjectId);
};

// Dev-server hook so the full-app e2e can read the sim and drive tilt; absent from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.assign(window, { __heartPuzzle: { runtime: heartPuzzleRuntime, hub: heartPuzzleHub, talk: talkToHeartPuzzleNpc, setActive: requestHeartPuzzleActive } });
}
