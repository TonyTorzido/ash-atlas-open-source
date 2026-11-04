import { describe, expect, it } from "vitest";

import { ARCANE_BLAST_SHOT_PROFILE, DEFAULT_ATTACK_PROFILE, SWING_COMBO_RESET_MS, type AttackProfile } from "@ash-atlas/shared";

import { SWING_PENDING_TIMEOUT_MS, SwingClientState, swingPoseComboIndex } from "./swing.js";

const east = { dirX: 1, dirY: 0 };

function swing(state: SwingClientState, id: string, at: number) {
  return state.started({ requestId: id, seq: state.nextSeq(), pressedAtMs: at, ...east });
}

describe("swing combo and recovery", () => {
  it("cycles 0, 1, 2, 0 inside the reset window and restarts after idling", () => {
    const state = new SwingClientState();
    expect(swing(state, "a", 1_000).comboIndex).toBe(0);
    expect(state.nextSwingAtMs).toBe(1_700);
    expect(swing(state, "b", 1_700).comboIndex).toBe(1);
    expect(swing(state, "c", 2_400).comboIndex).toBe(2);
    expect(state.nextSwingAtMs).toBe(2_400 + 900);
    expect(swing(state, "d", 3_300).comboIndex).toBe(0);
    expect(state.predictCombo(3_300 + SWING_COMBO_RESET_MS)).toBe(1);
    expect(state.predictCombo(3_300 + SWING_COMBO_RESET_MS + 1)).toBe(0);
  });

  it("numbers seqs from 0 per connection and starts over on reset", () => {
    const state = new SwingClientState();
    expect([state.nextSeq(), state.nextSeq()]).toEqual([0, 1]);
    state.reset();
    expect(state.nextSeq()).toBe(0);
  });

  it("a dash clears the recovery", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    expect(state.press(1_100, east)).toBe("ignored");
    state.dashStarted();
    expect(state.press(1_100, east)).toBe("send");
  });
});

describe("swing buffer", () => {
  it("drops an older buffered press when a newer press goes out at once", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    expect(state.press(1_600, east)).toBe("buffered");
    // A late correction moved the recovery end; the next press finds recovery over and sends.
    expect(state.press(1_700, east)).toBe("send");
    expect(state.buffered).toBeNull();
  });

  it("sends when ready, buffers within 150 ms of the end, ignores earlier presses", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    expect(state.press(1_100, east)).toBe("ignored");
    expect(state.press(1_550, east)).toBe("buffered");
    expect(state.press(1_600, { dirX: 0, dirY: 1 })).toBe("buffered");
    // One slot: the later press replaced the earlier one.
    expect(state.buffered).toMatchObject({ dirX: 0, dirY: 1 });
    expect(state.bufferedDelayMs(1_600)).toBe(100);
    expect(state.takeBuffered(1_650)).toBeNull();
    expect(state.takeBuffered(1_700)).toMatchObject({ dirY: 1 });
    expect(state.takeBuffered(1_700)).toBeNull();
    expect(state.press(1_700, east)).toBe("send");
  });
});

describe("swing reconciliation", () => {
  it("corrects combo and recovery from SWING_RESULT, reports hits and missed predictions", () => {
    const state = new SwingClientState();
    const pending = swing(state, "a", 1_000);
    pending.predictedHitIds.add("m1").add("m2");
    // Result arrives 120 ms later; server says the next swing is 200 ms after receipt.
    const resolution = state.result(
      { requestId: "a", seq: 0, comboIndex: 0, nextSwingAt: 50_200, hits: [{ entityId: "m1" }] },
      1_120,
      50_000
    );
    expect(resolution).toMatchObject({ pressToResultMs: 120, rejected: null, confirmedHitIds: ["m1"], missedPredictedIds: ["m2"] });
    expect(state.nextSwingAtMs).toBe(1_320);
    expect(state.pending.size).toBe(0);
  });

  it("takes the server combo when the local guess differed", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    state.result({ requestId: "a", seq: 0, comboIndex: 2, nextSwingAt: 50_450, hits: [] }, 1_050, 50_000);
    expect(state.predictCombo(1_100)).toBe(0);
  });

  it("a refused swing restores the previous combo and takes the server recovery", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    state.result({ requestId: "a", seq: 0, comboIndex: 0, nextSwingAt: 50_300, hits: [] }, 1_050, 50_000);
    swing(state, "b", 1_300);
    const refused = state.result(
      { requestId: "b", seq: 1, comboIndex: 1, nextSwingAt: 50_500, hits: [], rejected: "too_soon" },
      1_340,
      50_000
    );
    expect(refused?.rejected).toBe("too_soon");
    expect(state.lastSwingAtMs).toBe(1_000);
    expect(state.predictCombo(1_340)).toBe(1);
    expect(state.nextSwingAtMs).toBe(1_340 + 500);
  });

  it("ignores unknown request ids", () => {
    const state = new SwingClientState();
    expect(state.result({ requestId: "zzz", seq: 0, comboIndex: 0, nextSwingAt: 0, hits: [] }, 1, 1)).toBeNull();
  });
});

describe("swing timeouts and admission refusals", () => {
  it("fail() drops the pending swing and undoes its combo step", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    expect(state.fail("a")?.requestId).toBe("a");
    expect(state.pending.size).toBe(0);
    expect(state.lastSwingAtMs).toBe(0);
    expect(state.press(1_001, east)).toBe("send");
    expect(state.fail("a")).toBeNull();
  });

  it("expires pending swings after the timeout only", () => {
    const state = new SwingClientState();
    swing(state, "a", 1_000);
    expect(state.expire(1_000 + SWING_PENDING_TIMEOUT_MS - 1)).toHaveLength(0);
    expect(state.expire(1_000 + SWING_PENDING_TIMEOUT_MS)).toHaveLength(1);
    expect(state.pending.size).toBe(0);
  });
});

describe("ranged shot rules", () => {
  it("an arcane blast never combos and recovers on its own profile (22 ticks, 1100 ms)", () => {
    const state = new SwingClientState();
    state.setRanged(true, ARCANE_BLAST_SHOT_PROFILE);
    const first = swing(state, "a1", 1000);
    expect(first.shot).toBe(true);
    expect(first.comboIndex).toBe(0);
    expect(state.nextSwingAtMs).toBe(1000 + ARCANE_BLAST_SHOT_PROFILE.recoveryTicks * 50);
    expect(state.nextSwingAtMs).toBe(2100);
    expect(state.press(2000, east)).toBe("buffered");
    expect(swing(state, "a2", 2100).comboIndex).toBe(0);
  });

  it("never combos and recovers in 20 ticks (1000 ms)", () => {
    const state = new SwingClientState();
    state.setRanged(true);
    const first = swing(state, "s1", 1000);
    expect(first.shot).toBe(true);
    expect(first.comboIndex).toBe(0);
    expect(state.nextSwingAtMs).toBe(2000);
    const second = swing(state, "s2", 2000);
    const third = swing(state, "s3", 3000);
    expect([second.comboIndex, third.comboIndex]).toEqual([0, 0]);
  });

  it("gates and buffers presses against the 1000 ms recovery", () => {
    const state = new SwingClientState();
    state.setRanged(true);
    swing(state, "s1", 1000);
    expect(state.press(1100, east)).toBe("ignored");
    expect(state.press(1860, east)).toBe("buffered");
    expect(state.bufferedDelayMs(1860)).toBe(140);
    expect(state.takeBuffered(2000)).not.toBeNull();
    expect(state.press(2000, east)).toBe("send");
  });

  it("switching back to melee uses the melee combo again", () => {
    const state = new SwingClientState();
    state.setRanged(true);
    swing(state, "s1", 1000);
    state.setRanged(false);
    const melee = swing(state, "s2", 2100);
    expect(melee.shot).toBe(false);
    expect(melee.comboIndex).toBe(1);
    expect(state.nextSwingAtMs).toBe(2100 + 14 * 50);
  });
});

describe("swing timing from the attack profile", () => {
  /** A made-up four-step combo (stands in for the animator's numbers). */
  const FOUR_STEP: AttackProfile = {
    id: "test:four",
    label: "Four-step test combo",
    combo: [
      { windupMs: 200, recoveryMs: 400, damageMultiplier: 0.5, knockbackM: 0 },
      { windupMs: 150, recoveryMs: 350, damageMultiplier: 0.4, knockbackM: 0 },
      { windupMs: 180, recoveryMs: 420, damageMultiplier: 0.5, knockbackM: 0 },
      { windupMs: 400, recoveryMs: 800, damageMultiplier: 1, knockbackM: 0 }
    ],
    comboResetMs: 1_500,
    hitTiming: "contact"
  };

  it("the default profile keeps today's contact frames and finisher", () => {
    const state = new SwingClientState();
    expect(state.profile).toBe(DEFAULT_ATTACK_PROFILE);
    const steps = [swing(state, "a", 1_000), swing(state, "b", 1_700), swing(state, "c", 2_400)];
    expect(steps.map((pending) => [pending.windupMs, pending.finisher])).toEqual([[105, false], [105, false], [119, true]]);
  });

  it("predicts the combo, cadence, contact and finisher of the set profile", () => {
    const state = new SwingClientState();
    state.setProfile(FOUR_STEP);
    let at = 1_000;
    const seen: Array<[number, number, boolean, number]> = [];
    for (let index = 0; index < 5; index += 1) {
      const pending = swing(state, `p${index}`, at);
      seen.push([pending.comboIndex, pending.windupMs, pending.finisher, state.nextSwingAtMs - at]);
      expect(pending.profileId).toBe("test:four");
      at = state.nextSwingAtMs;
    }
    expect(seen).toEqual([[0, 200, false, 600], [1, 150, false, 500], [2, 180, false, 600], [3, 400, true, 1_200], [0, 200, false, 600]]);
    // Its own reset window, counted from the last press (600 ms before `at`).
    expect(state.predictCombo(at - 600 + 1_500)).toBe(1);
    expect(state.predictCombo(at - 600 + 1_501)).toBe(0);
  });

  it("a shot ignores the profile: no windup, never a finisher", () => {
    const state = new SwingClientState();
    state.setProfile(FOUR_STEP);
    state.setRanged(true);
    const shot = swing(state, "s", 1_000);
    expect([shot.comboIndex, shot.windupMs, shot.finisher]).toEqual([0, 0, false]);
  });

  it("maps any combo step onto the three drawn swings until a profile has its own art", () => {
    expect([0, 1, 2].map((index) => swingPoseComboIndex(index, index === 2))).toEqual([0, 1, 2]);
    expect([0, 1, 2, 3].map((index) => swingPoseComboIndex(index, index === 3))).toEqual([0, 1, 0, 2]);
  });
});
