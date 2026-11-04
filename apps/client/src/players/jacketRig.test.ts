import { describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", async (importOriginal) => {
  const pixi = await importOriginal<typeof import("pixi.js")>();
  // Sheet pages without a GPU or network: big empty sources every frame rectangle fits in.
  const load = vi.fn(async () => new pixi.Texture({ source: new pixi.TextureSource({ width: 8192, height: 8192 }) }));
  return { ...pixi, Assets: { ...pixi.Assets, load, unload: vi.fn(async () => undefined) } };
});
vi.mock("./playerSheetUpload.js", () => ({ queuePlayerSheetUpload: vi.fn(async () => undefined) }));

const { JacketFacing, JacketSheetRig } = await import("./jacketRig.js");
const { stockBaseClips } = await import("./stockArmour.js");
/** The stock body's base clips (every look draws them) on the (mocked) GPU. */
const loadBase = () => vi.waitFor(() => expect(stockBaseClips(null)).not.toBeNull(), { timeout: 10_000 });
type Frame = Parameters<InstanceType<typeof JacketSheetRig>["update"]>[0];

const frame = (nowMs: number, extra: Partial<Frame> = {}): Frame => ({
  lat: 35, lon: -106, walking: false, nowMs, bearingDeg: 0, targetHeight: 60, inputX: null, ...extra
});

describe("jacket facing", () => {
  it("flips the moment the held input crosses the middle", () => {
    const facing = new JacketFacing();
    facing.observe(frame(0, { inputX: 0.5 }));
    expect(facing.facing).toBe("R");
    facing.observe(frame(16, { inputX: -0.05 }));
    expect(facing.facing).toBe("L");
    facing.observe(frame(32, { inputX: 0.05 }));
    expect(facing.facing).toBe("R");
  });

  it("near-vertical input keeps the side; leaving the deadzone needs the larger share (hysteresis)", () => {
    const facing = new JacketFacing();
    facing.observe(frame(0, { inputX: -0.5 }));
    expect(facing.facing).toBe("L");
    // Into the deadzone (|x| < 0.04): keeps L.
    facing.observe(frame(16, { inputX: 0.02 }));
    expect(facing.facing).toBe("L");
    // Wobbling just past the entry share does not leave it.
    facing.observe(frame(32, { inputX: 0.05 }));
    expect(facing.facing).toBe("L");
    facing.observe(frame(48, { inputX: 0.06 }));
    expect(facing.facing).toBe("L");
    // Past the leave share: flips.
    facing.observe(frame(64, { inputX: 0.07 }));
    expect(facing.facing).toBe("R");
    // Out of the deadzone again, a small crossing flips at once.
    facing.observe(frame(80, { inputX: -0.045 }));
    expect(facing.facing).toBe("L");
  });
});

describe("jacket sheet rig clips", () => {
  const rig = async () => {
    await loadBase();
    return new JacketSheetRig();
  };
  const run = (r: InstanceType<typeof JacketSheetRig>, fromMs: number, toMs: number, extra: Partial<Frame>) => {
    for (let t = fromMs; t <= toMs; t += 16) r.update(frame(t, extra));
  };

  it("stands turned for 5 s after a walk, then the front idle", async () => {
    const r = await rig();
    run(r, 0, 1000, { walking: true, inputX: 1 });
    expect(r.debugState.view).toBe("walkR");
    r.update(frame(1016));
    expect(r.debugState.view).toBe("standR");
    r.update(frame(1000 + 4990));
    expect(r.debugState.view).toBe("standR");
    r.update(frame(1000 + 5010));
    expect(r.debugState.view).toBe("idle");
  });

  it("a walk resumed within 300 ms keeps its stride; a later one starts over", async () => {
    const r = await rig();
    run(r, 0, 400, { walking: true, inputX: -1 });
    const before = r.debugState.frame;
    expect(before).toBeGreaterThan(5);
    // One-frame stop (walk detector flicker), then walking again: the stride continues.
    r.update(frame(416));
    expect(r.debugState.view).toBe("standL");
    r.update(frame(432, { walking: true, inputX: -1 }));
    expect(r.debugState.view).toBe("walkL");
    expect(r.debugState.frame).toBe(before);
    // Stopped longer than the resume window: the walk starts from its first frame.
    run(r, 448, 900, {});
    r.update(frame(916, { walking: true, inputX: -1 }));
    expect(r.debugState.frame).toBe(0);
  });

  it("turning L <-> R mid-walk keeps the stride phase", async () => {
    const r = await rig();
    run(r, 0, 300, { walking: true, inputX: -1 });
    const before = r.debugState.frame;
    r.update(frame(316, { walking: true, inputX: 1 }));
    expect(r.debugState.view).toBe("walkR");
    expect(r.debugState.frame).toBe(before);
  });
});

const { jacketSwordPoseSheetState, preloadJacketSwordSheets, swordFollowEndMs, swordSwingMs } = await import("./jacketSword.js");
/** The generic style's first combo step (the tests' swings are step 0). */
const SWORD_SWING_MS = swordSwingMs("generic", 0);
const SWORD_FOLLOW_END_MS = swordFollowEndMs("generic", 0);
const { Texture, TextureSource } = await import("pixi.js");

describe("jacket sword sheathe (owner 2026-10-20)", () => {
  const weapon = new Texture({ source: new TextureSource({ width: 1024, height: 1024 }) });
  const swing = (startedAtMs: number, side: "left" | "right" = "right") => ({ comboIndex: 0 as const, startedAtMs, side, weapon });
  const rig = async () => {
    await loadBase();
    preloadJacketSwordSheets(0);
    await vi.waitFor(() => {
      // the key-pose sheet carries the drawn guard walk too (both styles walk with their own guard)
      expect(jacketSwordPoseSheetState(null)).toBe("ready");
    });
    return new JacketSheetRig();
  };
  type Rig = InstanceType<typeof JacketSheetRig>;
  // The swing playback persists after the swing (as playerAppearancePoses.swingPlaybackFor does).
  const run = (r: Rig, fromMs: number, toMs: number, extra: Partial<Frame>) => {
    for (let t = fromMs; t <= toMs; t += 16) r.update(frame(t, { heldSword: weapon, ...extra }));
  };
  const at = (r: Rig, t: number, extra: Partial<Frame>) => {
    r.update(frame(t, { heldSword: weapon, ...extra }));
    return r.debugState;
  };

  it("swing -> ready stand -> sheathed at +2 s (sword on the back) -> front idle at +4 s", async () => {
    const r = await rig();
    const end = 1000 + SWORD_SWING_MS;
    run(r, 1000, 1400, { sword: swing(1000) });
    expect(r.debugState.sword).toMatch(/^swing1R/);
    let s = at(r, end + 100, { sword: swing(1000) });
    expect([s.sword, s.swordOut]).toEqual(["readyR@generic-tank", true]);
    s = at(r, end + 1990, { sword: swing(1000) });
    expect([s.sword, s.swordOut]).toEqual(["readyR@generic-tank", true]);
    s = at(r, end + 2010, { sword: swing(1000) });
    expect([s.view, s.swordOut]).toEqual(["standR", false]);
    expect(s.sword).toMatch(/^back:standR:/);
    s = at(r, end + 3990, { sword: swing(1000) });
    expect(s.view).toBe("standR");
    s = at(r, end + 4010, { sword: swing(1000) });
    expect(s.view).toBe("idle");
    expect(s.sword).toMatch(/^back:idle:/);
  });

  it("walking away after the swing: the movement turns the sword walk at once (attack released)", async () => {
    const r = await rig();
    const end = 1000 + SWORD_SWING_MS;
    run(r, 1000, 1200, { sword: swing(1000, "right") });
    // Walking left (away from a target on the right) after the follow-through: faces L, sword still out.
    run(r, 1216, end + 1900, { sword: swing(1000, "right"), walking: true, inputX: -1 });
    let s = r.debugState;
    expect([s.view, s.facing, s.swordOut]).toEqual(["walkL", "L", true]);
    expect(s.sword).toMatch(/^guardwalkL:g[0-7]@generic-tank$/);
    // Holstered: the regular walk with the sword on the back, same side.
    s = at(r, end + 2010, { sword: swing(1000, "right"), walking: true, inputX: -1 });
    expect([s.view, s.facing, s.swordOut]).toEqual(["walkL", "L", false]);
    expect(s.sword).toMatch(/^back:walkL:/);
  });

  it("walking left + aim right: the swing's first frame already faces right", async () => {
    const r = await rig();
    run(r, 0, 500, { walking: true, inputX: -1 });
    expect(r.debugState.facing).toBe("L");
    // The press lands mid-walk; frame 0 of the clip is on the aim side (also before the sample clock reaches it).
    let s = at(r, 516, { sword: swing(520, "right"), walking: true, inputX: -1, attackHeld: true, attackAimX: 1 });
    expect([s.facing, s.sword]).toEqual(["R", "swing1R:windup:11-swing1-windup:f0@generic-tank"]);
    s = at(r, 532, { sword: swing(520, "right"), walking: true, inputX: -1, attackHeld: true, attackAimX: 1 });
    expect([s.facing, s.sword]).toEqual(["R", "swing1R:windup:11-swing1-windup:f0@generic-tank"]);
  });

  it("swing right, release, move left: flips on the first frame after the follow-through", async () => {
    const r = await rig();
    const followEnd = 1000 + SWORD_FOLLOW_END_MS;
    run(r, 1000, 1100, { sword: swing(1000, "right"), attackHeld: true, attackAimX: 1 });
    // Released; moving left during the clip: the swing still faces R to the end of its follow-through.
    let t = 1116;
    for (; t < followEnd; t += 16) {
      const s = at(r, t, { sword: swing(1000, "right"), walking: true, inputX: -1 });
      expect(s.facing).toBe("R");
    }
    const s = at(r, t, { sword: swing(1000, "right"), walking: true, inputX: -1 });
    expect([s.facing, s.view, s.swordOut]).toEqual(["L", "walkL", true]);
  });

  it("swing right, clip done, standing: keeps R; holding attack keeps R while moving; release flips at once", async () => {
    const r = await rig();
    const end = 1000 + SWORD_SWING_MS;
    run(r, 1000, end + 200, { sword: swing(1000, "right") });
    expect(r.debugState.facing).toBe("R");
    // Attack held (no new swing yet): the attack side wins over a left move.
    let s = at(r, end + 216, { sword: swing(1000, "right"), walking: true, inputX: -1, attackHeld: true, attackAimX: null });
    expect([s.facing, s.view]).toEqual(["R", "walkR"]);
    s = at(r, end + 232, { sword: swing(1000, "right"), walking: true, inputX: -1, attackHeld: true, attackAimX: null });
    expect(s.facing).toBe("R");
    // Released: the very next frame faces the move.
    s = at(r, end + 248, { sword: swing(1000, "right"), walking: true, inputX: -1 });
    expect([s.facing, s.view, s.swordOut]).toEqual(["L", "walkL", true]);
  });

  it("a new swing restarts the 2 s window", async () => {
    const r = await rig();
    run(r, 1000, 1500, { sword: swing(1000) });
    run(r, 1516, 2500, { sword: swing(1000) });
    run(r, 2500, 2600, { sword: swing(2500, "left") });
    const end2 = 2500 + SWORD_SWING_MS;
    // Past the first swing's window, inside the second's; the aim of the newer swing (left) wins.
    let s = at(r, 1000 + SWORD_SWING_MS + 2500, { sword: swing(2500, "left") });
    expect([s.sword, s.swordOut, s.facing]).toEqual(["readyL@generic-tank", true, "L"]);
    s = at(r, end2 + 2010, { sword: swing(2500, "left") });
    expect([s.view, s.swordOut]).toEqual(["standL", false]);
    s = at(r, end2 + 4010, { sword: swing(2500, "left") });
    expect(s.view).toBe("idle");
  });

  it("a sword held without a recent swing: regular clips with the sword on the back, the 5 s idle rule", async () => {
    const r = await rig();
    run(r, 0, 1000, { walking: true, inputX: 1 });
    expect(r.debugState.sword).toMatch(/^back:walkR:/);
    let s = at(r, 1016, {});
    expect([s.view, s.swordOut]).toEqual(["standR", false]);
    s = at(r, 1000 + 4990, {});
    expect(s.view).toBe("standR");
    s = at(r, 1000 + 5010, {});
    expect(s.view).toBe("idle");
  });
});
