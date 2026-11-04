import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAYER_CAMERA,
  combatZoomTarget,
  framingPan,
  hardRect,
  indicatorPlacement,
  limitPanToKeepPlayer,
  safeRect,
  smoothingShare,
  smootherstep,
  zoomFramingCenter
} from "./playerFollow.js";
import { PlayerFollowController, type PlayerFollowDeps, type PlayerFollowMap } from "./playerFollowController.js";
import { setCameraFilterMode } from "./cameraDriverMode.js";

describe("player camera framing", () => {
  const size = { width: 400, height: 800 };
  const center = { x: 200, y: 400 };

  it("centres the target when the player stays in the safe area", () => {
    const pan = framingPan({ x: 260, y: 300 }, { x: 220, y: 420 }, center, safeRect(size));
    expect(pan.x).toBeCloseTo(60);
    expect(pan.y).toBeCloseTo(-100);
  });

  it("never pans the player out of the safe area", () => {
    const safe = safeRect(size);
    const pan = framingPan({ x: 620, y: 400 }, { x: safe.minX + 10, y: 400 }, center, safe);
    expect(safe.minX + 10 - pan.x).toBeGreaterThanOrEqual(safe.minX - 1e-9);
  });

  it("limits a pan to the hard rect", () => {
    const hard = hardRect(size);
    const limited = limitPanToKeepPlayer({ x: 500, y: 0 }, { x: 300, y: 400 }, hard);
    expect(300 - limited.x).toBeGreaterThanOrEqual(hard.minX - 1e-9);
  });

  it("settles in about the configured time", () => {
    let remaining = 1;
    for (let t = 0; t < PLAYER_CAMERA.settleMs; t += 16) remaining *= 1 - smoothingShare(16);
    expect(remaining).toBeLessThan(0.03);
    expect(remaining).toBeGreaterThan(0.005);
  });
});

describe("off-screen player indicator", () => {
  const size = { width: 400, height: 800 };

  it("hides while the player is on screen", () => {
    expect(indicatorPlacement({ x: 100, y: 100 }, size).visible).toBe(false);
  });

  it("clamps to the inset edge and points at the player", () => {
    const right = indicatorPlacement({ x: 1200, y: 400 }, size);
    expect(right.visible).toBe(true);
    expect(right.x).toBeCloseTo(size.width - PLAYER_CAMERA.indicator.insetPx.right);
    expect(right.angleDeg).toBeCloseTo(0);
    const above = indicatorPlacement({ x: 200, y: -900 }, size);
    expect(above.y).toBeCloseTo(PLAYER_CAMERA.indicator.insetPx.top);
    expect(above.angleDeg).toBeCloseTo(-90);
    const below = indicatorPlacement({ x: 200, y: 2000 }, size);
    expect(below.y).toBeCloseTo(size.height - PLAYER_CAMERA.indicator.insetPx.bottom);
    expect(below.angleDeg).toBeCloseTo(90);
  });

  it("slides along the edge as the direction changes", () => {
    const a = indicatorPlacement({ x: 900, y: 100 }, size);
    const b = indicatorPlacement({ x: 900, y: 700 }, size);
    expect(a.x).toBeCloseTo(b.x);
    expect(b.y).toBeGreaterThan(a.y);
  });
});

describe("combat zoom target", () => {
  const size = { width: 932, height: 430 };

  it("steps in a moderate amount on a landscape phone and keeps 280 m on screen", () => {
    const target = combatZoomTarget(15, size);
    expect(target).toBeGreaterThan(15.3);
    expect(target - 15).toBeLessThanOrEqual(PLAYER_CAMERA.combatZoom.stepLevels + 1e-9);
    const metersPerPx = 78_271.517 / 2 ** target;
    expect(metersPerPx * (size.height / 2) * PLAYER_CAMERA.combatZoom.edgeFill).toBeGreaterThanOrEqual(PLAYER_CAMERA.combatZoom.keepVisibleRadiusM - 1);
  });

  it("is cut back, or skipped, when the player is already zoomed in", () => {
    expect(combatZoomTarget(15.7, size)).toBeLessThan(15.7 + PLAYER_CAMERA.combatZoom.stepLevels);
    expect(combatZoomTarget(16.5, size)).toBe(16.5);
  });

  it("smootherstep runs 0 to 1 with zero speed at both ends", () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5);
    expect(smootherstep(0.02)).toBeLessThan(0.0001);
    expect(smootherstep(1.4)).toBe(1);
  });
});

describe("player camera controller", () => {
  const SIZE = { width: 400, height: 800 };
  let rafQueue: Array<(t: number) => void>;
  let nowMs: number;
  let center: { lng: number; lat: number };
  let pans: number;
  let player: { lat: number; lon: number };
  let gesture: "drag" | "zoom" | null;
  let busy: boolean;
  let fighting: boolean;
  let moveHeld: boolean;
  let zoomEnabled: boolean;
  let controller: PlayerFollowController;
  let zoom: number;
  let bearingDeg: number;
  let play: number | null;
  let committed: number[];
  let jumps: Array<{ lng: number; lat: number; zoom: number }>;
  let useReal: boolean;

  // 1 degree = 1000 px in both axes keeps the arithmetic readable; y grows as lat falls.
  const map: PlayerFollowMap = {
    project: ([lng, lat]) => ({ x: SIZE.width / 2 + (lng - center.lng) * 1000, y: SIZE.height / 2 - (lat - center.lat) * 1000 }),
    getCenter: () => center,
    getCanvas: () => ({ clientWidth: SIZE.width, clientHeight: SIZE.height, width: SIZE.width, height: SIZE.height }) as HTMLCanvasElement,
    panBy: ([dx, dy]) => { pans += 1; center = { lng: center.lng + dx / 1000, lat: center.lat - dy / 1000 }; },
    getZoom: () => zoom,
    getBearing: () => bearingDeg,
    jumpTo: (o) => { jumps.push({ lng: o.center[0], lat: o.center[1], zoom: o.zoom }); center = { lng: o.center[0], lat: o.center[1] }; zoom = o.zoom; }
  };
  // A real-scale map for the combat zoom: 512 * 2^zoom / 360 px per degree near the equator, rotated by the bearing.
  const K = (): number => (512 * 2 ** zoom) / 360;
  const rot = (v: { x: number; y: number }, deg: number): { x: number; y: number } => {
    const a = (deg * Math.PI) / 180;
    return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
  };
  const realMap: PlayerFollowMap = {
    ...map,
    project: ([lng, lat]) => {
      const v = rot({ x: (lng - center.lng) * K(), y: -(lat - center.lat) * K() }, -bearingDeg);
      return { x: SIZE.width / 2 + v.x, y: SIZE.height / 2 + v.y };
    },
    panBy: ([dx, dy]) => {
      pans += 1;
      const w = rot({ x: dx, y: dy }, bearingDeg);
      center = { lng: center.lng + w.x / K(), lat: center.lat - w.y / K() };
    }
  };
  const depsOf = (): PlayerFollowDeps => ({
    getMap: () => (useReal ? realMap : map),
    playerPosition: () => player,
    inCombat: () => fighting,
    followEnabled: () => true,
    combatZoomEnabled: () => zoomEnabled,
    moveInputHeld: () => moveHeld,
    cameraBusy: () => busy,
    userGesture: () => gesture,
    playZoom: () => play,
    commitPlayZoom: (g) => { committed.push(g); play = g; },
    now: () => nowMs
  });

  const runFrames = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      const queue = rafQueue;
      rafQueue = [];
      nowMs += 16;
      for (const cb of queue) cb(nowMs);
    }
  };
  /** Advance the clock and fire the poll timer the way setInterval would. */
  const advance = (ms: number): void => {
    for (let t = 0; t < ms; t += 50) { nowMs += 50; vi.advanceTimersByTime(50); }
  };
  const playerPx = () => (useReal ? realMap : map).project([player.lon, player.lat]);
  const offCentre = (): number => Math.hypot(playerPx().x - SIZE.width / 2, playerPx().y - SIZE.height / 2);

  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = [];
    nowMs = 1_000;
    center = { lng: 0, lat: 0 };
    zoom = 15;
    pans = 0;
    jumps = [];
    committed = [];
    play = null;
    bearingDeg = 0;
    useReal = false;
    player = { lat: 0, lon: 0 };
    gesture = null;
    busy = false;
    fighting = false;
    moveHeld = false;
    zoomEnabled = true;
    vi.stubGlobal("window", { setInterval: (fn: () => void, ms: number) => setInterval(fn, ms), clearInterval: (id: number) => clearInterval(id) });
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { rafQueue.push(cb); return rafQueue.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { rafQueue = []; });
    controller = new PlayerFollowController(depsOf());
  });
  afterEach(() => { controller.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  describe("follow mode", () => {
    const walk = (frames: number, perFrame: number, record?: number[]): void => {
      for (let i = 0; i < frames; i++) {
        player = { lat: player.lat, lon: player.lon + perFrame / 1000 };
        runFrames(1);
        if (record) record.push(offCentre());
      }
    };
    const startWalking = (): void => { moveHeld = true; controller.noteMoveInput(true); };

    it("joystick movement starts a follow that keeps the player centred at walk speed with no snap", () => {
      expect(controller.phase).toBe("idle");
      startWalking();
      expect(controller.phase).toBe("following");
      const offsets: number[] = [];
      const xs: number[] = [];
      for (let i = 0; i < 90; i++) { walk(1, 4, offsets); xs.push(center.lng * 1000); }
      expect(Math.max(...offsets.slice(30)), "centred within a few px once walking").toBeLessThan(4);
      const steps = xs.slice(1).map((x, i) => x - xs[i]!);
      for (let i = 1; i < steps.length; i++) expect(Math.abs(steps[i]! - steps[i - 1]!), "no per-frame snap").toBeLessThan(1.5);
    });

    it("settles on the player after the input stops, then goes idle", () => {
      startWalking();
      walk(60, 4);
      moveHeld = false;
      runFrames(80);
      expect(controller.phase).toBe("idle");
      expect(offCentre()).toBeLessThan(2);
    });

    it("a drag stops the follow; it stays put until the joystick is used again, then glides back", () => {
      startWalking();
      walk(40, 4);
      gesture = "drag";
      runFrames(2);
      expect(controller.phase).toBe("idle");
      gesture = null;
      center = { lng: center.lng + 0.1, lat: center.lat }; // the user dragged the map away
      const parked = center;
      walk(30, 4);
      expect(center, "no follow while parked").toEqual(parked);
      controller.noteMoveInput(false);
      controller.noteMoveInput(true);
      expect(controller.phase).toBe("following");
      const before = offCentre();
      walk(120, 4);
      expect(offCentre()).toBeLessThan(Math.min(4, before));
    });

    it("a tap-to-move does not start or keep a follow", () => {
      moveHeld = false;
      walk(30, 4);
      expect(controller.phase).toBe("idle");
      expect(pans).toBe(0);
      startWalking();
      walk(10, 4);
      controller.noteTapMove();
      expect(controller.phase).toBe("idle");
    });

    it("a dash step does not jerk the camera", () => {
      startWalking();
      walk(40, 4);
      const xs: number[] = [];
      for (let i = 0; i < 40; i++) { walk(1, i === 5 ? 60 : 4); xs.push(center.lng * 1000); }
      const steps = xs.slice(1).map((x, i) => x - xs[i]!);
      for (let i = 1; i < steps.length; i++) expect(Math.abs(steps[i]! - steps[i - 1]!), "smooth through the dash").toBeLessThan(4);
    });

    /** Walk along x at 90 px/s with server snap-backs (3 px every other 50 ms) and noise; returns the per-frame camera x steps. */
    const jitteryWalk = (frameMs: (i: number) => number, frames: number): number[] => {
      startWalking();
      const xs: number[] = [];
      let t = 0;
      for (let i = 0; i < frames; i++) {
        const dt = frameMs(i);
        t += dt;
        const snapBack = Math.floor(t / 50) % 2 === 1 ? -3 : 0;
        player = { lat: Math.cos(i * 1.7) * 0.0006, lon: ((90 * t) / 1_000 + snapBack + Math.sin(i * 2.3) * 1.2) / 1000 };
        const queue = rafQueue;
        rafQueue = [];
        nowMs += dt;
        for (const cb of queue) cb(nowMs);
        xs.push(center.lng * 1000);
      }
      return xs.slice(1).map((x, i) => x - xs[i]!);
    };
    const reversals = (steps: number[]): number => {
      let last = 0;
      let flips = 0;
      for (const step of steps) {
        if (Math.abs(step) < 0.05) continue;
        const sign = Math.sign(step);
        if (last !== 0 && sign !== last) flips += 1;
        last = sign;
      }
      return flips;
    };

    it("a jittery predicted position (server snap-backs) never sends the camera backwards: 60 Hz, 120 Hz, dropped frames", () => {
      const cases: Array<[string, (i: number) => number, number]> = [
        ["60 Hz", () => 1000 / 60, 240],
        ["120 Hz", () => 1000 / 120, 480],
        ["ProMotion pacing", (i) => (i % 5 === 0 ? 1000 / 60 : 1000 / 120), 400],
        ["dropped frames", (i) => (i % 9 === 4 ? 50 : 1000 / 60), 240]
      ];
      for (const [name, frameMs, frames] of cases) {
        controller.dispose();
        center = { lng: 0, lat: 0 };
        player = { lat: 0, lon: 0 };
        rafQueue = [];
        controller = new PlayerFollowController(depsOf());
        const steps = jitteryWalk(frameMs, frames);
        expect(reversals(steps.slice(20)), name).toBe(0);
        expect(Math.min(...steps.slice(20)), `${name}: no backwards step`).toBeGreaterThanOrEqual(-0.05);
      }
    });

    it("with the filter switched off the same input does shake the camera (the A/B switch works)", () => {
      setCameraFilterMode("off");
      try {
        const steps = jitteryWalk(() => 1000 / 60, 240);
        expect(reversals(steps.slice(20))).toBeGreaterThan(0);
      } finally {
        setCameraFilterMode("on");
      }
    });

    it("a programmatic move only pauses the follow", () => {
      startWalking();
      player = { lat: 0, lon: 0.05 };
      busy = true;
      runFrames(5);
      expect(pans).toBe(0);
      busy = false;
      runFrames(2);
      expect(pans).toBeGreaterThan(0);
    });

    it("clear() (recenter) stops panning", () => {
      startWalking();
      controller.clear();
      expect(controller.phase).toBe("idle");
      player = { lat: 0, lon: 0.05 };
      runFrames(5);
      expect(pans).toBe(0);
    });
  });

  describe("combat zoom", () => {
    beforeEach(() => { useReal = true; });
    /** One 16 ms frame: the clock, the poll timer and the rAF callbacks together. */
    const tick = (): void => {
      const queue = rafQueue;
      rafQueue = [];
      nowMs += 16;
      vi.advanceTimersByTime(16);
      for (const cb of queue) cb(nowMs);
    };
    const runFor = (ms: number): void => { for (let t = 0; t < ms; t += 16) tick(); };
    /** Ground zoom at lat 0 is the camera zoom. */
    const FULL_MS = PLAYER_CAMERA.combatZoom.easeMs;

    it("zooms in over about a second, in the frame loop, never with a map ease, and commits the target as the play zoom", () => {
      runFor(300);
      expect(jumps).toHaveLength(0);
      fighting = true;
      runFor(200);
      expect(controller.zoomPhase).toBe("in");
      expect(controller.holdsZoom()).toBe(true);
      runFor(FULL_MS + 200);
      expect(controller.zoomPhase).toBe("held");
      expect(controller.holdsZoom()).toBe(false);
      expect(zoom).toBeGreaterThan(15.3);
      expect(zoom - 15).toBeLessThanOrEqual(PLAYER_CAMERA.combatZoom.stepLevels + 1e-9);
      expect(committed).toEqual([zoom]);
      expect(jumps.length, "one jump per frame for the whole zoom").toBeGreaterThan(40);
    });

    it("is monotonic and smooth: no step above 2.2x the mean, tiny jerk, zero speed at both ends", () => {
      fighting = true;
      runFor(200);
      const zs = jumps.map((j) => j.zoom);
      const steps = zs.slice(1).map((z, i) => z - zs[i]!);
      expect(steps.every((d) => d >= -1e-9), "monotonic").toBe(true);
      runFor(FULL_MS);
      const all = jumps.map((j) => j.zoom);
      const dz = all.slice(1).map((z, i) => z - all[i]!);
      const avg = (all[all.length - 1]! - 15) / dz.length;
      expect(Math.max(...dz)).toBeLessThan(avg * 2.2);
      const jerk = dz.slice(1).map((d, i) => Math.abs(d - dz[i]!));
      expect(Math.max(...jerk)).toBeLessThan(avg * 0.35);
      expect(dz[0]!, "starts at near-zero speed").toBeLessThan(avg * 0.05);
      expect(dz[dz.length - 1]!, "ends at near-zero speed").toBeLessThan(avg * 0.05);
    });

    it("keeps the player's screen point put through the zoom, centred or off-centre, at any bearing", () => {
      for (const bearing of [0, 33]) {
        for (const startPx of [0, 30]) {
          bearingDeg = bearing;
          zoom = 15;
          jumps.length = 0;
          center = { lng: startPx / K(), lat: 0 };
          controller.dispose();
          controller = new PlayerFollowController(depsOf());
          fighting = true;
          const before = offCentre();
          let worst = 0;
          for (let i = 0; i < 80; i++) { tick(); worst = Math.max(worst, offCentre()); }
          fighting = false;
          expect(zoom, "the zoom ran").toBeGreaterThan(15.3);
          expect(worst, `bearing ${bearing}, start ${startPx}px: the zoom never pushes the player off the centre`).toBeLessThanOrEqual(before + 0.5);
          expect(offCentre(), `bearing ${bearing}, start ${startPx}px: ends centred`).toBeLessThan(3);
        }
      }
    });

    it("never zooms back out: not when the fight ends, not later", () => {
      fighting = true;
      runFor(FULL_MS + 400);
      const zoomed = zoom;
      fighting = false;
      runFor(PLAYER_CAMERA.combatZoom.exitDelayMs + 3_000);
      expect(zoom).toBe(zoomed);
      expect(controller.zoomPhase).toBe("off");
    });

    it("does not ratchet across repeated fights", () => {
      for (let fight = 0; fight < 4; fight++) {
        fighting = true;
        runFor(FULL_MS + 400);
        fighting = false;
        runFor(PLAYER_CAMERA.combatZoom.exitDelayMs + 500);
      }
      expect(zoom - 15).toBeLessThanOrEqual(PLAYER_CAMERA.combatZoom.stepLevels + 1e-9);
      expect(committed, "committed once").toHaveLength(1);
    });

    it("after the player zooms out by hand, the next fight eases back up to play zoom plus one step, not further", () => {
      fighting = true;
      runFor(FULL_MS + 400);
      fighting = false;
      runFor(PLAYER_CAMERA.combatZoom.exitDelayMs + 500);
      zoom = 14.2; // the player zoomed out; App records it as the play zoom
      play = 14.2;
      fighting = true;
      runFor(FULL_MS + 400);
      expect(zoom).toBeCloseTo(14.2 + PLAYER_CAMERA.combatZoom.stepLevels, 2);
    });

    it("does not zoom when the player is already at or past the target", () => {
      zoom = 16.8;
      play = 16.8;
      fighting = true;
      runFor(1_500);
      expect(jumps).toHaveLength(0);
      expect(zoom).toBe(16.8);
    });

    it("a pinch cancels the zoom at once, commits nothing and zooms back out never", () => {
      fighting = true;
      runFor(400);
      expect(controller.zoomPhase).toBe("in");
      gesture = "zoom";
      runFor(32);
      expect(controller.zoomPhase).toBe("pinched");
      const jumpsAtPinch = jumps.length;
      gesture = null;
      zoom = 16.2; // the player's own zoom
      runFor(3_000);
      expect(jumps.length, "no zoom writes after the pinch").toBe(jumpsAtPinch);
      expect(committed).toHaveLength(0);
      fighting = false;
      runFor(PLAYER_CAMERA.combatZoom.exitDelayMs + 2_000);
      expect(zoom).toBe(16.2);
      expect(controller.zoomPhase).toBe("off");
    });

    it("a zoom set by someone else mid-ease (a pinch whose flag was lost) cancels the zoom too", () => {
      fighting = true;
      runFor(400);
      expect(controller.zoomPhase).toBe("in");
      zoom = zoom - 0.2;
      runFor(32);
      expect(controller.zoomPhase).toBe("pinched");
      const at = zoom;
      runFor(2_000);
      expect(zoom).toBe(at);
      expect(committed).toHaveLength(0);
    });

    it("a second finger or the wheel on the map cancels the zoom at once (the map may not report its own zoom flag)", () => {
      const listeners = new Map<string, (e: unknown) => void>();
      const canvas = { clientWidth: SIZE.width, clientHeight: SIZE.height, width: SIZE.width, height: SIZE.height, addEventListener: (t: string, f: (e: unknown) => void) => { listeners.set(t, f); }, removeEventListener: (t: string) => { listeners.delete(t); } } as unknown as HTMLCanvasElement;
      const spy: PlayerFollowMap = { ...realMap, getCanvas: () => canvas };
      controller.dispose();
      controller = new PlayerFollowController({ ...depsOf(), getMap: () => spy });
      fighting = true;
      runFor(400);
      expect(controller.zoomPhase).toBe("in");
      listeners.get("touchstart")?.({ touches: { length: 1 } });
      expect(controller.zoomPhase, "one finger is a drag, not a zoom").toBe("in");
      listeners.get("touchstart")?.({ touches: { length: 2 } });
      expect(controller.zoomPhase).toBe("pinched");
      expect([...listeners.keys()].filter((t) => t === "touchstart" || t === "wheel"), "pinch listeners removed").toEqual([]);
      const at = zoom;
      runFor(1_500);
      expect(zoom).toBe(at);
      expect(committed).toHaveLength(0);
    });

    it("a landed hit counts as combat before the server marks the player engaged", () => {
      controller.noteCombatActivity();
      runFor(300);
      expect(controller.zoomPhase).toBe("in");
    });

    it("does nothing when combat zoom is off, and turning it off mid-zoom stops without a write", () => {
      zoomEnabled = false;
      fighting = true;
      runFor(1_000);
      expect(jumps).toHaveLength(0);
      zoomEnabled = true;
      runFor(400);
      expect(controller.zoomPhase).toBe("in");
      zoomEnabled = false;
      runFor(400);
      expect(controller.holdsZoom()).toBe(false);
    });

    it("the follow keeps working during and after the zoom: a walking player stays centred", () => {
      moveHeld = true;
      controller.noteMoveInput(true);
      fighting = true;
      for (let i = 0; i < 120; i++) { player = { lat: player.lat, lon: player.lon + 0.00001 }; tick(); }
      expect(controller.zoomPhase).toBe("held");
      expect(offCentre()).toBeLessThan(6);
    });
  });
});
