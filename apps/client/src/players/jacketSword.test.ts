import { readFileSync } from "node:fs";
import { ATTACK_PROFILES, DEFAULT_ATTACK_PROFILE, SWING_COMBO_RESET_MS, SWING_RECOVERY_TICKS, attackStepCycleTicks } from "@ash-atlas/shared";
import { SWING_CONTACT_MS } from "@ash-atlas/player-renderer";
import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { SwingClientState, SWING_TICK_MS, swingPoseComboIndex } from "../combat/swing.js";
import { PlayerAppearancePoseController } from "../combat/playerAppearancePose.js";
import {
  heldSwordTexture, jacketSwordFrame, jacketSwordInput, jacketSwordPose, swordFollowEndMs, swordPoseSetFor, swordSwingMs,
  swordTrailPolygons, type SwordPoseId
} from "./jacketSword.js";
import { STOCK_ARMOURS, type StockArmourId } from "./stockArmour.js";
import { swingTimeline, SWORD_STYLE_PROFILE, SWORD_STYLE_TIMING, SWORD_STYLE_WEAPON, SWORD_STYLES, swordStyleFor, type SwordStyle } from "./swordStyles.js";
import jacketb from "../assets/player-rig/jacketb-sword/jacketb-sword.json";

/** Stock armours with their own redrawn key poses per sword style (sword-poses/<style>-<armour>/); "tank" always ships. */
const SHIPPED_ARMOUR_POSES: Readonly<Record<SwordStyle, readonly StockArmourId[]>> = {
  generic: ["cloth", "leather", "chainmail", "breastplate"], ronin: ["cloth", "chainmail", "leather", "breastplate"],
  // Axes: tank top only for now (armour variants later); armoured looks draw the axe tank-top set.
  "axe-generic": [], "axe-warrior": []
};
type ComboTiming = { swings: Record<string, [string, number][]>; sweep: Record<string, number>; flat: Record<string, number> };
const POSE_MANIFESTS = import.meta.glob<{ style: string; look: string; scale: number; fps: number; combo?: ComboTiming; keyposes: { view: { frames: unknown[] }; poses: Record<string, { cell: number; grip: number[]; deg: number; len: number }> } }>(
  ["../assets/player-rig/sword-poses/*/*-sword.json", "../assets/player-rig/axe-poses/*/*-axe.json"], { eager: true, import: "default" });
/**
 * Approved timing (docs/plans/player-sword-keyposes/class-combos.md): contact and the swing's own frames in ms per
 * step (generic: wind-up to the end of its ready frames; Ronin, held: wind-up to the end of its follow-through).
 */
const APPROVED: Readonly<Record<SwordStyle, { contactMs: number[]; swingFramesMs: number[] }>> = {
  generic: { contactMs: [100, 100, 133], swingFramesMs: [300, 300, 400] },
  ronin: { contactMs: [133, 133, 200], swingFramesMs: [467, 533, 833] },
  // docs/plans/player-axe-keyposes/axe-combos.md (generic: through its ready frames; Warrior: sweeps held, finisher readies)
  "axe-generic": { contactMs: [200, 200, 300], swingFramesMs: [800, 800, 1100] },
  "axe-warrior": { contactMs: [233, 133, 367], swingFramesMs: [800, 600, 1200] }
};

const sword = { texture: Texture.WHITE, familyId: "one_handed_sword" };

describe("jacket sword combo", () => {
  it("maps the server combo step to swing 1 -> 2 -> 3 -> 1 (its wind-up pose first), and resets after a pause", () => {
    const state = new SwingClientState();
    const ids: string[] = [];
    let at = 1000;
    const press = () => {
      const pending = state.started({ requestId: `r${at}`, seq: 0, pressedAtMs: at, dirX: 1, dirY: 0 });
      ids.push(jacketSwordFrame({ comboIndex: swingPoseComboIndex(pending.comboIndex, pending.finisher), startedAtMs: at }, at).pose);
      at += attackStepCycleTicks(DEFAULT_ATTACK_PROFILE.combo[pending.comboIndex]!) * SWING_TICK_MS;
    };
    for (let i = 0; i < 4; i += 1) press();
    at += SWING_COMBO_RESET_MS + 1;
    press();
    expect(ids).toEqual(["11-swing1-windup", "21-swing2-windup", "31-swing3-windup", "11-swing1-windup", "11-swing1-windup"]);
  });

  it("the default attack profile's windups are the drawn contact frames", () => {
    expect(DEFAULT_ATTACK_PROFILE.combo.map((step) => step.windupMs))
      .toEqual([SWING_CONTACT_MS.swing, SWING_CONTACT_MS.swing, SWING_CONTACT_MS.finisher]);
    const state = new SwingClientState();
    const windups: number[] = [];
    let at = 1000;
    for (let i = 0; i < 3; i += 1) {
      const pending = state.started({ requestId: `w${i}`, seq: i, pressedAtMs: at, dirX: 1, dirY: 0 });
      windups.push(pending.windupMs);
      at += SWING_RECOVERY_TICKS[pending.comboIndex as 0 | 1 | 2] * SWING_TICK_MS;
    }
    expect(windups).toEqual([SWING_CONTACT_MS.swing, SWING_CONTACT_MS.swing, SWING_CONTACT_MS.finisher]);
  });

  it.each(SWORD_STYLES)("%s: the drawn contact frame is on screen when the server lands the hit (attack profile windup), and each swing ends by the next press", (style) => {
    const profile = ATTACK_PROFILES[SWORD_STYLE_PROFILE[style]];
    expect(profile.hitTiming).toBe("contact");
    profile.combo.forEach((step, comboIndex) => {
      const t = swingTimeline(style, comboIndex as 0 | 1 | 2);
      // the server lands it on a whole tick: windupMs rounded to 50 ms
      const serverHitMs = Math.round(step.windupMs / SWING_TICK_MS) * SWING_TICK_MS;
      // the contact frame is on screen at the client's contact time (within 1 ms: 133 vs 133.3)
      expect((t.contactFrame * 1000) / 30).toBeLessThanOrEqual(step.windupMs + 1);
      expect(((t.contactFrame + 1) * 1000) / 30).toBeGreaterThan(step.windupMs);
      // ... and the server's hit tick lands within half a frame of it (the 20 Hz grid: the Warrior barge's 367 ms
      // contact is hit on the 350 ms tick; every other step is exact)
      expect(Math.abs((t.contactFrame * 1000) / 30 - serverHitMs)).toBeLessThanOrEqual(1000 / 60 + 1e-6);
      // the swing's own frames end by the next press (a held style then holds its last pose up to that press)
      expect((t.phases.length * 1000) / 30).toBeLessThanOrEqual(attackStepCycleTicks(step) * SWING_TICK_MS + 1000 / 30);
    });
  });

  it.each(SWORD_STYLES)("%s: each step's hit pose lands at the approved contact time, then the follow-through", (style) => {
    for (const comboIndex of [0, 1, 2] as const) {
      const t = swingTimeline(style, comboIndex);
      const contactMs = APPROVED[style].contactMs[comboIndex]!;
      expect(Math.round((t.contactFrame * 1000) / 30)).toBe(contactMs);
      expect(Math.round((t.phases.length * 1000) / 30)).toBe(APPROVED[style].swingFramesMs[comboIndex]);
      const n = comboIndex + 1;
      expect(jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, contactMs - 1).phase).toMatch(/^(windup|raise)$/);
      expect(jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, contactMs + 1).pose).toBe(`${n}2-swing${n}-hit`);
      expect(jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, swordFollowEndMs(style, comboIndex) - 1).phase).toBe("follow");
      expect(jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, swordSwingMs(style, comboIndex) - 1).done).toBe(false);
      expect(jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, swordSwingMs(style, comboIndex) + 1).done).toBe(true);
    }
  });

  it.each(SWORD_STYLES.filter((style) => SWORD_STYLE_TIMING[style].hold))("%s flow (owner 2026-10-21): each cut holds its follow-through until the next press, never the ready guard", (style) => {
    const resetMs = ATTACK_PROFILES[SWORD_STYLE_PROFILE[style]].comboResetMs;
    for (const comboIndex of [0, 1, 2] as const) {
      const n = comboIndex + 1;
      const profile = ATTACK_PROFILES[SWORD_STYLE_PROFILE[style]].combo[comboIndex]!;
      const nextPressMs = attackStepCycleTicks(profile) * SWING_TICK_MS;
      // The Warrior axe finisher is the one held-style step that recovers to the ready carry (its last frames).
      const heldPose = style === "axe-warrior" && comboIndex === 2 ? "00-ready" : `${n}3-swing${n}-follow`;
      // from the end of the follow-through to the next press (and on to the reset window): the follow pose, no ready
      for (let ms = swordFollowEndMs(style, comboIndex) + 1; ms < resetMs; ms += 17) {
        const f = jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, ms);
        expect([ms, f.pose, f.done]).toEqual([ms, heldPose, false]);
      }
      expect(nextPressMs).toBeLessThan(resetMs);
      // the combo ended (no press within the reset window): ease back to ready (through the raise after a low finish)
      const after = jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, resetMs + 1);
      if (style !== "ronin" || comboIndex === 0) expect(after.done).toBe(true);
      else expect([after.pose, after.done]).toEqual(["90-raise", false]);
      expect(jacketSwordFrame({ comboIndex, style, startedAtMs: 0 }, swordSwingMs(style, comboIndex) + 1).done).toBe(true);
    }
    if (style !== "ronin") return;
    // swing 3 lifts from the low kesa finish through the raise, then jodan; contact unchanged at f6
    expect(jacketSwordFrame({ comboIndex: 2, style: "ronin", startedAtMs: 0 }, 10).pose).toBe("90-raise");
    expect(jacketSwordFrame({ comboIndex: 2, style: "ronin", startedAtMs: 0 }, 110).pose).toBe("31-swing3-windup");
    expect(jacketSwordFrame({ comboIndex: 2, style: "ronin", startedAtMs: 0 }, 201).pose).toBe("32-swing3-hit");
  });

  it("each axe style's timing equals the packed art drop's combo.json (pack-sword-keyposes.py --weapon axe)", () => {
    for (const style of SWORD_STYLES.filter((s) => SWORD_STYLE_WEAPON[s] === "axe")) {
      const combo = Object.values(POSE_MANIFESTS).find((m) => m.style === style && m.look === "tank")!.combo!;
      const t = SWORD_STYLE_TIMING[style];
      expect(t.swings).toEqual([combo.swings["1"], combo.swings["2"], combo.swings["3"]]);
      expect(t.sweep).toEqual([combo.sweep["1"], combo.sweep["2"], combo.sweep["3"]]);
      expect(t.flat).toEqual([combo.flat["1"], combo.flat["2"], combo.flat["3"]]);
    }
  });

  it("the client timing equals the approved previews (class-<style>/combo.json)", () => {
    for (const style of SWORD_STYLES.filter((s) => SWORD_STYLE_WEAPON[s] === "sword")) {
      const combo = JSON.parse(readFileSync(new URL(`../../../../docs/plans/player-sword-keyposes/class-${style}/combo.json`, import.meta.url), "utf8")) as {
        swings: Record<string, [string, number][]>; sweep: Record<string, number>; flat: Record<string, number>;
        hold?: { resetMs: number; ease: Record<string, [string, number][]> };
      };
      const t = SWORD_STYLE_TIMING[style];
      expect(t.swings).toEqual([combo.swings["1"], combo.swings["2"], combo.swings["3"]]);
      expect(t.hold ? { resetMs: t.hold.resetMs, ease: t.hold.ease } : undefined)
        .toEqual(combo.hold ? { resetMs: combo.hold.resetMs, ease: [combo.hold.ease["1"], combo.hold.ease["2"], combo.hold.ease["3"]] } : undefined);
      expect(t.sweep).toEqual([combo.sweep["1"], combo.sweep["2"], combo.sweep["3"]]);
      expect(t.flat).toEqual([combo.flat["1"], combo.flat["2"], combo.flat["3"]]);
    }
  });

  it("the style seam: the server-sent combat style (sword:ronin = Ronin, anything else generic)", () => {
    expect(swordStyleFor({})).toBe("generic");
    expect(swordStyleFor(null)).toBe("generic");
    expect(swordStyleFor({ combatStyle: "sword:ronin" })).toBe("ronin");
    expect(swordStyleFor({ combatStyle: "sword:generic" })).toBe("generic");
    expect(swordStyleFor({ combatStyle: "default" })).toBe("generic");
    expect(swordStyleFor({ combatStyle: "axe:generic" }, "one_handed_axe")).toBe("axe-generic");
    expect(swordStyleFor({ combatStyle: "axe:warrior" }, "one_handed_axe")).toBe("axe-warrior");
    // a style for the other weapon (the snapshot lags a swap) draws the held weapon's plain style
    expect(swordStyleFor({ combatStyle: "sword:ronin" }, "one_handed_axe")).toBe("axe-generic");
    expect(swordStyleFor({ combatStyle: "axe:warrior" }, "one_handed_sword")).toBe("generic");
    expect(swordStyleFor({ combatStyle: "sword:ronin" }, "one_handed_sword")).toBe("ronin");
    expect(jacketSwordInput({ variant: "swing", comboIndex: 0, side: "left", startedAtMs: 0, cancelled: false }, sword, "ronin")).toMatchObject({ style: "ronin" });
  });

  it.each(SWORD_STYLES)("%s: every pose ships grip and blade data, and each swing has a closed trail band", (style) => {
    for (const swing of [0, 1, 2] as const) {
      for (const phase of ["windup", "hit", "follow"] as const) {
        const n = swing + 1;
        const id = `${n}${phase === "windup" ? 1 : phase === "hit" ? 2 : 3}-swing${n}-${phase}` as SwordPoseId;
        const pose = jacketSwordPose(id, null, style);
        expect(pose.grip).toHaveLength(2);
        expect(Number.isFinite(pose.deg)).toBe(true);
      }
      const { rim, core } = swordTrailPolygons(swing, 8, null, style);
      expect(rim).toHaveLength(2 * 2 * 9);
      expect(core).toHaveLength(2 * 2 * 9);
      expect(rim.every(Number.isFinite)).toBe(true);
    }
  });

  it("swing playback carries the combo step (local press and remote swing_N events)", () => {
    const poses = new PlayerAppearancePoseController();
    poses.beginLocalSwing("p", 100, { x: -1, y: 0 }, "swing", 1);
    expect(jacketSwordInput(poses.swingPlaybackFor("p"), sword)).toMatchObject({ comboIndex: 1, side: "left", startedAtMs: 100 });
    poses.beginLocalSwing("p", 900, { x: 1, y: 0 }, "finisher");
    expect(jacketSwordInput(poses.swingPlaybackFor("p"), sword)).toMatchObject({ comboIndex: 2, side: "right" });
  });

  it("every style x look set has the 10 poses (same ids, scale, fps); a look without its own set draws the style's tank top", () => {
    const sets = Object.values(POSE_MANIFESTS);
    const expected = SWORD_STYLES.flatMap((style) => [`${style}-tank`, ...SHIPPED_ARMOUR_POSES[style].map((a) => `${style}-${a}`)]);
    expect(sets.map((m) => `${m.style}-${m.look}`).sort()).toEqual(expected.sort());
    const ids = Object.keys(jacketb.keyposes.poses).sort();
    for (const m of sets) {
      expect([m.scale, m.fps]).toEqual([jacketb.scale, jacketb.fps]);
      // every sword set has the 8 drawn guard-walk frames; the Ronin sets add the two-handed raise
      const walk = Array.from({ length: SWORD_STYLE_TIMING[m.style as SwordStyle].guardWalkFrames ?? 0 }, (_, i) => `walk-${i}`);
      const own = (m.style === "ronin" ? [...ids, "90-raise", ...walk] : [...ids, ...walk]).sort();
      expect(Object.keys(m.keyposes.poses).sort()).toEqual(own);
      expect(new Set(Object.values(m.keyposes.poses).map((p) => p.cell)).size).toBe(own.length);
      expect(m.keyposes.view.frames).toHaveLength(own.length);
    }
    for (const style of SWORD_STYLES) {
      for (const armour of STOCK_ARMOURS) {
        const own = SHIPPED_ARMOUR_POSES[style].includes(armour);
        expect(swordPoseSetFor(armour, style)).toBe(`${style}-${own ? armour : "tank"}`);
        for (const id of ids as SwordPoseId[]) expect(Number.isFinite(jacketSwordPose(id, armour, style).deg)).toBe(true);
        for (const swing of [0, 1, 2] as const) expect(swordTrailPolygons(swing, 8, armour, style).rim.every(Number.isFinite)).toBe(true);
      }
      expect(swordPoseSetFor(null, style)).toBe(`${style}-tank`);
    }
  });

  it("only the sword and axe families are drawn in hand", () => {
    expect(heldSwordTexture(sword)).toBe(Texture.WHITE);
    expect(heldSwordTexture({ ...sword, familyId: "one_handed_axe" })).toBe(Texture.WHITE);
    expect(heldSwordTexture({ ...sword, familyId: "bow" })).toBeNull();
    expect(heldSwordTexture(null)).toBeNull();
  });

  it("only swords and axes play the poses; shots, cancelled swings and no weapon do not", () => {
    const playback = { variant: "swing" as const, comboIndex: 0 as const, side: "left" as const, startedAtMs: 0, cancelled: false };
    expect(jacketSwordInput(playback, sword)).not.toBeNull();
    expect(jacketSwordInput(playback, { ...sword, familyId: "one_handed_axe" }, "axe-warrior")).toMatchObject({ style: "axe-warrior" });
    expect(jacketSwordInput(playback, { ...sword, familyId: "bow" })).toBeNull();
    expect(jacketSwordInput(playback, null)).toBeNull();
    expect(jacketSwordInput({ ...playback, cancelled: true }, sword)).toBeNull();
    expect(jacketSwordInput({ ...playback, variant: "shot" }, sword)).toBeNull();
  });
});

describe("jacket sword sheathe timeline", () => {
  it("out during the swing and 2 s after; front idle 2 s after the sheathe unless moved after it", async () => {
    const { frontIdleAtMs, markSwordSwing, swordOut } = await import("./jacketSword.js");
    const mark = markSwordSwing(null, { startedAtMs: 1000, side: "left", comboIndex: 0 });
    expect(mark).toEqual({ startedAtMs: 1000, followEndMs: 1000 + swordFollowEndMs("generic", 0), endMs: 1000 + swordSwingMs("generic", 0), side: "L" });
    expect(markSwordSwing(mark, { startedAtMs: 1000, side: "right", comboIndex: 0 })).toBe(mark);
    // a Ronin finisher holds zanshin to the reset window and eases up: the sword stays out from that (later) end
    expect(markSwordSwing(null, { startedAtMs: 0, side: "left", comboIndex: 2, style: "ronin" }).endMs).toBeCloseTo(swordSwingMs("ronin", 2), 6);
    expect(swordSwingMs("ronin", 2)).toBeCloseTo(1600, 6);
    const end = mark.endMs;
    expect(swordOut(mark, 1000)).toBe(true);
    expect(swordOut(mark, end + 1999)).toBe(true);
    expect(swordOut(mark, end + 2000)).toBe(false);
    expect(swordOut(null, 0)).toBe(false);
    // Stood still since the swing (the swing refreshes the last move): idle 4 s after the swing ends.
    expect(frontIdleAtMs(end, 5000, mark)).toBe(end + 4000);
    // Stopped inside the window: still 2 s after the sheathe.
    expect(frontIdleAtMs(end + 1000, 5000, mark)).toBe(end + 4000);
    // Moved after the sheathe, or never swung: the 5 s rule.
    expect(frontIdleAtMs(end + 3000, 5000, mark)).toBeCloseTo(end + 8000, 6);
    expect(frontIdleAtMs(500, 5000, null)).toBe(5500);
    // A re-swing moves the window.
    const again = markSwordSwing(mark, { startedAtMs: 2500, side: "right", comboIndex: 1 });
    expect(swordOut(again, end + 2500)).toBe(true);
    expect(again.side).toBe("R");
  });
});
