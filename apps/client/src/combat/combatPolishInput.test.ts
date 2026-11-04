import { describe, expect, it } from "vitest";

import {
  ATTACK_AIM_DECISION_PX,
  ATTACK_BUTTON_RELEASE_PX,
  ATTACK_GRACE_MOVING_PX,
  ATTACK_HOLD_REPEAT_MS,
  ATTACK_TOUCH_GRACE_MAX_MS,
  attackTouchGraceMs,
  classifyAttackDrag
} from "./swingAim.js";
import { AimAttackRepeater, nextAttackButtonMode } from "./twinStick.js";
import {
  KICK_OUT_SHARE,
  KICK_TUNING,
  SHAKE_REDUCED_SCALE,
  SHAKE_TUNING,
  ScreenShakeState,
  kickFraction,
  shakeScale
} from "./hitFeedback.js";
import {
  ATTACK_STRIKE_APPROACH_DURATION_MS,
  ATTACK_STRIKE_DISTANCE_PX,
  PLAYER_SWING_LUNGE_PX,
  PlayerAppearancePoseController
} from "./playerAppearancePose.js";
import { SwingEffectsState } from "./swingEffects.js";

describe("attack button on touch-down", () => {
  it("150 ms grace: a fresh press waits, a still hold turns auto at 150 ms, a still-travelling finger waits to 250 ms", () => {
    expect(ATTACK_HOLD_REPEAT_MS).toBe(150);
    expect(nextAttackButtonMode("pending", "idle", 0, ATTACK_HOLD_REPEAT_MS)).toBe("pending");
    expect(nextAttackButtonMode("pending", "idle", 149, attackTouchGraceMs(0))).toBe("pending");
    expect(nextAttackButtonMode("pending", "idle", 150, attackTouchGraceMs(2))).toBe("auto");
    expect(nextAttackButtonMode("pending", "idle", 200, attackTouchGraceMs(ATTACK_GRACE_MOVING_PX))).toBe("pending");
    expect(nextAttackButtonMode("pending", "idle", ATTACK_TOUCH_GRACE_MAX_MS, attackTouchGraceMs(6))).toBe("auto");
  });

  it("a pull past the decision distance inside the grace aims at once toward the pull (walking left, pull right)", () => {
    // Map north up: a pull to the right of the landing point is due east.
    const drag = classifyAttackDrag(ATTACK_AIM_DECISION_PX, 0, 0, false, ATTACK_AIM_DECISION_PX);
    expect(drag.kind).toBe("aim");
    if (drag.kind !== "aim") return;
    expect(drag.direction.dirX).toBeCloseTo(1, 5);
    expect(nextAttackButtonMode("pending", "aim", 20, ATTACK_HOLD_REPEAT_MS)).toBe("aim");
    // Once aimed it never falls back to the auto swing when the grace would have ended.
    expect(nextAttackButtonMode("aim", "idle", 400, ATTACK_HOLD_REPEAT_MS)).toBe("aim");
    // A settling thumb under the decision distance keeps waiting; after the grace the full dead zone applies again.
    expect(classifyAttackDrag(ATTACK_AIM_DECISION_PX - 1, 0, 0, false, ATTACK_AIM_DECISION_PX).kind).toBe("idle");
    expect(classifyAttackDrag(12, 0, 0, false).kind).toBe("idle");
    // Hysteresis sits below the decision distance, so an early-caught pull does not pause on a small wobble.
    expect(ATTACK_BUTTON_RELEASE_PX).toBeLessThan(ATTACK_AIM_DECISION_PX);
    expect(classifyAttackDrag(ATTACK_AIM_DECISION_PX - 2, 0, 0, true).kind).toBe("aim");
  });

  it("a tap cannot double-fire: the repeater waits out the recovery the touch-down swing started", () => {
    const repeater = new AimAttackRepeater();
    const nextSwingAtMs = 1_000 + 700;
    for (let now = 1_016; now <= 1_120; now += 16) expect(repeater.due(now, nextSwingAtMs)).toBe(false);
    expect(repeater.due(nextSwingAtMs, nextSwingAtMs)).toBe(true);
  });
});

describe("directional screen kick", () => {
  it("pushes along the direction, peaks early, and settles to zero", () => {
    expect(kickFraction(-1, 90)).toBe(0);
    expect(kickFraction(0, 90)).toBe(0);
    expect(kickFraction(90 * KICK_OUT_SHARE, 90)).toBeCloseTo(1, 5);
    expect(kickFraction(90, 90)).toBe(0);
    const shake = new ScreenShakeState();
    const out = { x: 0, y: 0 };
    expect(shake.kick(100, 1, 0, "hit", 1)).toBe(true);
    shake.sample(50, out);
    expect(out).toEqual({ x: 0, y: 0 });
    expect(shake.sample(100 + KICK_TUNING.hit.durationMs * KICK_OUT_SHARE, out)).toBe(true);
    expect(out.x).toBeCloseTo(KICK_TUNING.hit.px, 5);
    expect(out.y).toBe(0);
    expect(shake.sample(100 + KICK_TUNING.hit.durationMs, out)).toBe(false);
  });

  it("is bigger on a kill, follows the shake setting, and is off at scale 0", () => {
    expect(KICK_TUNING.kill.px).toBeGreaterThan(KICK_TUNING.hit.px);
    expect(SHAKE_TUNING.kill.amplitudePx).toBeGreaterThan(SHAKE_TUNING.finisher.amplitudePx);
    const shake = new ScreenShakeState();
    expect(shake.kick(0, 0, 1, "hit", shakeScale("off", false))).toBe(false);
    expect(shake.kick(0, 0, 1, "hit", shakeScale("full", true))).toBe(false);
    expect(shake.kick(0, 0, 0, "hit", 1)).toBe(false);
    const out = { x: 0, y: 0 };
    expect(shake.kick(0, 0, 1, "kill", shakeScale("reduced", false))).toBe(true);
    shake.sample(KICK_TUNING.kill.durationMs * KICK_OUT_SHARE, out);
    expect(out.y).toBeCloseTo(KICK_TUNING.kill.px * SHAKE_REDUCED_SCALE, 5);
  });

  it("a shake scheduled for the contact frame waits instead of being retired", () => {
    const shake = new ScreenShakeState();
    const out = { x: 0, y: 0 };
    expect(shake.start(200, "finisher", 1)).toBe(true);
    expect(shake.sample(100, out)).toBe(false);
    expect(shake.sample(220, out)).toBe(true);
    expect(shake.sample(200 + SHAKE_TUNING.finisher.durationMs, out)).toBe(false);
  });
});

describe("player swing lunge", () => {
  it("steps further forward than the mob lunge", () => {
    expect(PLAYER_SWING_LUNGE_PX).toBeGreaterThanOrEqual(14);
    expect(PLAYER_SWING_LUNGE_PX).toBeLessThanOrEqual(18);
    const controller = new PlayerAppearancePoseController();
    controller.beginLocalSwing("me", 1_000, { x: 1, y: 0 });
    const peak = controller.localSwingMotionFor("me", 1_000 + ATTACK_STRIKE_APPROACH_DURATION_MS)!;
    expect(peak.offsetX).toBeCloseTo(PLAYER_SWING_LUNGE_PX);
    expect(ATTACK_STRIKE_DISTANCE_PX).toBeLessThan(PLAYER_SWING_LUNGE_PX);
  });
});

describe("contact-frame scheduling", () => {
  it("a predicted hit ahead of its contact frame neither holds nor pushes yet, and reports the wait", () => {
    const fx = new SwingEffectsState();
    fx.addPredictedHit("mob", "me", 1_105, 1, 0, "swing");
    expect(fx.contactWaitMs("mob", 1_000)).toBe(105);
    expect(fx.isHeld("mob", 1_050)).toBe(false);
    expect(fx.isHeld("me", 1_050)).toBe(false);
    expect(fx.sampleNowMs("me", 1_050)).toBe(1_050);
    expect(fx.hitElapsedMs("mob", 1_000)).toBeLessThan(0);
    const out = { x: 0, y: 0 };
    expect(fx.nudge("mob", 1_050, out)).toBe(false);
    expect(fx.isHeld("mob", 1_106)).toBe(true);
    expect(fx.isHeld("me", 1_106)).toBe(true);
    expect(fx.contactWaitMs("mob", 1_110)).toBe(0);
  });

  it("incoming records never delay a melee number", () => {
    const fx = new SwingEffectsState();
    fx.addIncomingHit("me", "mob", 5_000, 1, 0);
    expect(fx.contactWaitMs("me", 4_990)).toBe(0);
  });

  it("the attacker's windup is never frozen: the hitstop starts at the contact frame, after the windup", () => {
    const fx = new SwingEffectsState();
    fx.addPredictedHit("mob", "me", 105, 1, 0, "swing");
    for (let t = 0; t < 105; t += 5) expect(fx.sampleNowMs("me", t)).toBe(t);
  });
});

describe("Phase C input windows", () => {
  it("buffers a press up to SWING_BUFFER_WINDOW_MS early, re-aims it on release, and ignores earlier ones", async () => {
    const { SwingClientState, SWING_BUFFER_WINDOW_MS } = await import("./swing.js");
    const state = new SwingClientState();
    state.started({ requestId: "a", seq: state.nextSeq(), pressedAtMs: 1000, dirX: 1, dirY: 0 });
    const endsAt = state.nextSwingAtMs;
    expect(SWING_BUFFER_WINDOW_MS).toBeGreaterThanOrEqual(250);
    // Too early: ignored, and the ignored counter bumps (the HUD blinks the ring).
    const before = state.ignoredRevision;
    expect(state.press(endsAt - SWING_BUFFER_WINDOW_MS - 20, { dirX: 1, dirY: 0 })).toBe("ignored");
    expect(state.ignoredRevision).toBe(before + 1);
    // Inside the window: buffered with a re-aim hook that the release returns.
    const reaim = () => ({ dirX: 0, dirY: 1 });
    expect(state.press(endsAt - SWING_BUFFER_WINDOW_MS + 20, { dirX: 1, dirY: 0 }, reaim)).toBe("buffered");
    expect(state.takeBuffered(endsAt - 1)).toBeNull();
    const taken = state.takeBuffered(endsAt);
    expect(taken?.reaim?.()).toEqual({ dirX: 0, dirY: 1 });
  });

  it("holds a dash pressed inside the queue window and drops one pressed earlier", async () => {
    const { dashClientState, DASH_INPUT_QUEUE_MS, DASH_QUEUE_SLACK_MS } = await import("../movement/dash.js");
    dashClientState.reset();
    expect(dashClientState.queueDelayMs(5000)).toBe(0);
    dashClientState.cooldownUntilMs = 10_000;
    expect(dashClientState.queueDelayMs(10_000 - DASH_INPUT_QUEUE_MS - 1)).toBeNull();
    expect(dashClientState.acceptsInput(10_000 - DASH_INPUT_QUEUE_MS - 1)).toBe(false);
    expect(dashClientState.queueDelayMs(10_000 - 100)).toBe(100 + DASH_QUEUE_SLACK_MS);
    expect(dashClientState.acceptsInput(10_000 - 100)).toBe(true);
    expect(dashClientState.queueDelayMs(10_001)).toBe(0);
    dashClientState.reset();
  });
});
