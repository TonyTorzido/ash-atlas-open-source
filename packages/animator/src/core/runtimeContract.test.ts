/*
 * Runtime-correctness fixes and the runtime behaviour contract (docs/plans/atlas-animator.md,
 * "Runtime behaviour contract").
 * Original minimal fixtures, one per finding / policy.
 */
import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData, MAX_TRACKS, type TrackEntry } from "./animationState.js";
import type { AnimDocumentInput } from "./format.js";
import { parseAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";
import { AnimationLibrary, ContinuousTimeline } from "./timelines.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;

const raw = (sections: Sections) => ({ format: "atlas-anim@1", name: "t", canvas: { width: 100, height: 100, originX: 0, originY: 0 }, ...sections });

/** root -> arm, one IK chain, one transform and one physics constraint, a mesh slot for deform. */
function richSections(clip: Record<string, unknown>): Sections {
  return {
    bones: [{ name: "root" }, { name: "a", parent: "root", length: 10 }, { name: "b", parent: "a", x: 10, length: 10 }, { name: "t", parent: "root", x: 20 }],
    slots: [{ name: "s", bone: "a", attachment: "m" }],
    skins: {
      body: {
        attachments: {
          s: { m: { type: "mesh", path: "m", width: 10, height: 10, uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 0, 10], hull: 3 } }
        }
      }
    },
    ik: [{ name: "ik", bones: ["a", "b"], target: "t" }],
    transform: [{ name: "tc", bones: ["b"], target: "t" }],
    physics: [{ name: "ph", bone: "b", x: 1 }],
    animations: { c: { duration: 1, ...clip } }
  } as Sections;
}

describe("F1: empty continuous timelines", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["bone rotate", { bones: { a: { rotate: [] } } }],
    ["bone translate", { bones: { a: { translate: [] } } }],
    ["bone scale", { bones: { a: { scale: [] } } }],
    ["bone shear", { bones: { a: { shear: [] } } }],
    ["slot color", { slots: { s: { color: [] } } }],
    ["ik", { ik: { ik: [] } }],
    ["transform", { transform: { tc: [] } }],
    ["physics mix", { physics: { ph: { mix: [] } } }],
    ["deform", { deform: { body: { s: { m: [] } } } }]
  ];
  for (const [label, clip] of cases) {
    it(`rejects an empty ${label} timeline at validation`, () => {
      const result = parseAnimDocument(raw(richSections(clip)));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((issue) => issue.message).join("\n")).toMatch(/at least one key/);
    });
  }

  it("the compiler refuses an empty continuous timeline from callers that bypass the loader", () => {
    const doc = testDocument(richSections({ bones: { a: { rotate: [{ time: 0, value: 5 }] } } }));
    const bypass = { ...doc, animations: { c: { ...doc.animations.c, bones: { a: { rotate: [] } } } } } as unknown as typeof doc;
    expect(() => new AnimationLibrary(bypass)).toThrow(/at least one key/);
    const library = new AnimationLibrary(doc);
    const property = library.get("c").continuous[0]!.property;
    expect(() => new ContinuousTimeline(property, new Float64Array(0), new Float64Array(0), library.get("c").continuous[0]!.curves)).toThrow(/at least one key/);
  });
});

/** root -> arm; clips: spin (1 s, rotate 0 -> 90, event "hit" at 0.5, loops), pose (1 s, no loop), short (1/60 s loop). */
function stateRig(extra: Record<string, unknown> = {}) {
  return testDocument({
    bones: [{ name: "root" }, { name: "arm", parent: "root", length: 10 }],
    events: { hit: {} },
    animations: {
      spin: { duration: 1, loop: true, bones: { arm: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 90 }] } }, events: [{ time: 0.5, name: "hit" }] },
      pose: { duration: 1, bones: { arm: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 90 }] } } },
      ...extra
    }
  } as Sections);
}

describe("F4: playback controls and deltas are validated", () => {
  const state = () => new AnimationState(new AnimationStateData(stateRig()));

  it("rejects non-finite update deltas with a clear error (no hang on Infinity)", () => {
    const s = state();
    s.setAnimation(0, "spin");
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) expect(() => s.update(bad)).toThrow(/delta must be a finite/);
    const doc = stateRig();
    expect(() => new Skeleton(doc).update(Number.NaN)).toThrow(/delta must be a finite/);
  });

  it("a huge finite delta terminates (event catch-up is bounded) and keeps the clip time finite", () => {
    const s = state();
    const entry = s.setAnimation(0, "spin");
    let events = 0;
    s.addListener({ event: () => events++ });
    s.update(1e300);
    expect(Number.isFinite(entry.trackTime)).toBe(true);
    expect(events).toBeLessThanOrEqual(1001);
  });

  it("rejects negative and non-finite speeds, at play time and when mutated (zero stays valid)", () => {
    const s = state();
    expect(() => s.setAnimation(0, "spin", { timeScale: -1 })).toThrow(/timeScale/);
    expect(() => s.setAnimation(0, "spin", { timeScale: Number.POSITIVE_INFINITY })).toThrow(/timeScale/);
    const entry = s.setAnimation(0, "spin", { timeScale: 0 });
    expect(() => (entry.timeScale = -1)).toThrow(/timeScale/);
    expect(() => (s.timeScale = -0.5)).toThrow(/timeScale/);
    expect(() => (s.timeScale = Number.NaN)).toThrow(/timeScale/);
    s.timeScale = 0;
    s.update(1);
    expect(entry.trackTime).toBe(0);
  });

  it("rejects non-finite mix durations, out-of-range alphas and thresholds, and bad delays / hitstops", () => {
    const s = state();
    const data = s.data;
    expect(() => s.setAnimation(0, "spin", { mix: Number.POSITIVE_INFINITY })).toThrow(/mix/);
    expect(() => data.setMix("spin", "pose", Number.POSITIVE_INFINITY)).toThrow(/mix/);
    expect(() => (data.defaultMix = -1)).toThrow(/defaultMix/);
    expect(() => s.setAnimation(0, "spin", { eventThreshold: Number.NaN })).toThrow(/eventThreshold/);
    expect(() => s.setAnimation(0, "spin", { discreteThreshold: 2 })).toThrow(/discreteThreshold/);
    const entry = s.setAnimation(0, "spin");
    expect(() => (entry.alpha = 1.5)).toThrow(/alpha/);
    expect(() => (entry.mixDuration = Number.NaN)).toThrow(/mixDuration/);
    expect(() => (entry.eventThreshold = -0.1)).toThrow(/eventThreshold/);
    expect(() => (entry.discreteThreshold = Number.POSITIVE_INFINITY)).toThrow(/discreteThreshold/);
    expect(() => s.addAnimation(0, "pose", { delay: Number.NaN })).toThrow(/delay/);
    expect(() => s.addAnimation(0, "pose", { delay: -1 })).toThrow(/delay/);
    expect(() => s.hitstop(Number.POSITIVE_INFINITY)).toThrow(/hitstop/);
  });
});

describe("F5: outgoing event thresholds do not depend on frame partitioning", () => {
  /** Out clip (applied once, so the fade really mixes from it) with events at `eventTimes`; a 1 s fade into `in` starts at out-clip time `start`. */
  function runApplied(eventTimes: number[], start: number, partition: number[]): string[] {
    const doc = testDocument({
      bones: [{ name: "root" }],
      events: { e: {} },
      animations: { out: { duration: 2, events: eventTimes.map((time) => ({ time, name: "e", float: time })) }, in: { duration: 2 } }
    } as Sections);
    const state = new AnimationState(new AnimationStateData(doc));
    const skeleton = new Skeleton(doc);
    const fired: string[] = [];
    state.addListener({ event: (entry, event) => fired.push(`${entry.clip.name}@${event.float}`) });
    state.setAnimation(0, "out", { eventThreshold: 0.5 });
    state.update(start);
    state.apply(skeleton);
    fired.length = 0;
    state.setAnimation(0, "in", { mix: 1 });
    for (const dt of partition) state.update(dt);
    return fired;
  }

  const partitions = [[1], Array.from({ length: 10 }, () => 0.1), [0.05, 0.37, 0.13, 0.25, 0.2]];

  it("an event after the threshold never fires; one before it always fires (memo reproduction)", () => {
    for (const partition of partitions) {
      expect(runApplied([0.9], 0.2, partition), `partition ${partition}`).toEqual([]);
      expect(runApplied([0.4], 0.2, partition), `partition ${partition}`).toEqual(["out@0.4"]);
    }
  });

  it("boundary: an event exactly where the newer mix reaches the threshold fires (inclusive)", () => {
    for (const partition of [[1], [0.25, 0.25, 0.25, 0.25], [0.125, 0.375, 0.5]]) {
      expect(runApplied([0.75], 0.25, partition), `partition ${partition}`).toEqual(["out@0.75"]);
      expect(runApplied([0.875], 0.25, partition), `partition ${partition}`).toEqual([]);
    }
  });
});

describe("F8: automatic queue delay under entry speed != 1", () => {
  function setup(speed: number) {
    const doc = testDocument({ bones: [{ name: "root" }], animations: { one: { duration: 1 }, two: { duration: 1 } } } as Sections);
    const state = new AnimationState(new AnimationStateData(doc));
    const skeleton = new Skeleton(doc);
    const ended: string[] = [];
    state.addListener({ end: (entry) => ended.push(entry.clip.name) });
    const first = state.setAnimation(0, "one", { timeScale: speed });
    state.apply(skeleton);
    const second = state.addAnimation(0, "two", { mix: 0.2 });
    return { state, first, second, ended };
  }

  for (const speed of [0.5, 1, 2]) {
    it(`speed ${speed}: the 0.2 s fade (real seconds) ends exactly when the old clip ends`, () => {
      const { state, first, second } = setup(speed);
      state.update(1 / speed - 0.1);
      expect(state.getCurrent(0)).toBe(second);
      expect(second.mixTime).toBeCloseTo(0.1, 9);
      state.update(0.1);
      expect(first.trackTime).toBeCloseTo(1, 9);
      expect(second.mixFraction).toBeCloseTo(1, 9);
    });
  }

  it("speed 0: the old clip never ends, so the queued entry never starts", () => {
    const { state, first } = setup(0);
    state.update(10);
    expect(state.getCurrent(0)).toBe(first);
  });

  it("a speed change after queuing moves the start so the fade still ends with the old clip", () => {
    const { state, first, second } = setup(1);
    state.update(0.1);
    first.timeScale = 2;
    state.update(0.45);
    expect(first.trackTime).toBeCloseTo(1, 9);
    expect(state.getCurrent(0)).toBe(second);
    expect(second.mixFraction).toBeCloseTo(1, 9);
  });

  it("lifecycle: the finished mix is dropped (end callback) on the next update, not the one that completed it", () => {
    const { state, second, ended } = setup(2);
    state.update(0.5);
    expect(second.mixFraction).toBeCloseTo(1, 9);
    expect(ended).toEqual([]);
    expect(second.mixingFrom).not.toBeNull();
    state.update(0);
    expect(ended).toEqual(["one"]);
    expect(second.mixingFrom).toBeNull();
  });
});

describe("F6: off-axis two-bone IK stretch reaches its target", () => {
  /** upper (length 10) -> lower at local (10, 8), length 10; target at (tx, ty). */
  function chain(ik: Record<string, unknown>, target: [number, number], root: Record<string, unknown> = {}) {
    const skeleton = new Skeleton(
      testDocument({
        bones: [
          { name: "root", ...root },
          { name: "upper", parent: "root", length: 10 },
          { name: "lower", parent: "upper", x: 10, y: 8, length: 10 },
          { name: "target", parent: "root", x: target[0], y: target[1] }
        ],
        ik: [{ name: "reach", bones: ["upper", "lower"], target: "target", stretch: true, ...ik }]
      } as Sections)
    );
    skeleton.updateWorldTransform();
    const lower = skeleton.getBone("lower");
    const w = lower.world;
    const tip = { x: w.x + w.a * lower.data.length, y: w.y + w.c * lower.data.length };
    const t = skeleton.getBone("target").world;
    return Math.hypot(tip.x - t.x, tip.y - t.y);
  }

  it("memo reproduction: target (40, 10), nonuniform stretch, full mix", () => {
    expect(chain({}, [40, 10])).toBeLessThan(1e-6);
  });

  it("both bend directions, uniform and nonuniform stretch, softened reach, reflected parents", () => {
    for (const bendPositive of [true, false]) {
      for (const uniform of [false, true]) {
        for (const softness of [0, 4]) {
          for (const root of [{}, { scaleY: -1 }, { scaleX: -1 }, { rotation: 30, scaleX: 1.5, scaleY: 0.75 }]) {
            for (const target of [[40, 10], [-5, 45], [30, -30]] as [number, number][]) {
              const label = JSON.stringify({ bendPositive, uniform, softness, root, target });
              expect(chain({ bendPositive, uniform, softness }, target, root), label).toBeLessThan(1e-6);
            }
          }
        }
      }
    }
  });
});

describe("F7: spring stability includes mass and step size; finite-state guard", () => {
  const physicsDoc = (physics: Record<string, unknown>) => ({
    bones: [{ name: "root" }, { name: "cape", parent: "root", length: 20 }],
    physics: [{ name: "sway", bone: "cape", x: 1, y: 1, rotate: 1, scaleX: 1, ...physics }]
  });

  it("rejects at load a spring past the integrator's bound (memo case: mass 1e-6), naming mass and fps", () => {
    const result = parseAnimDocument(raw(physicsDoc({ mass: 0.000001, strength: 100, damping: 0.9, wind: 60 }) as Sections));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.message).join("\n")).toMatch(/unstable.*mass/);
  });

  it("extreme valid settings just inside the bound stay finite and bounded, with long pauses and maximum catch-up", () => {
    // Bound: strength * h^2 / mass < 2 (1 + damping^(60 h)); h = 1/60, damping 1 -> strength / mass < 4 * 3600.
    const skeleton = new Skeleton(testDocument(physicsDoc({ mass: 0.01, strength: 0.99 * 4 * 3600 * 0.01, damping: 1, wind: 60, gravity: 60 }) as Sections));
    const cape = skeleton.getBone("cape");
    let worst = 0;
    for (let frame = 0; frame < 2000; frame++) {
      skeleton.update(frame % 100 === 0 ? 10 : 1 / 60); // long pause every 100 frames: 0.25 s clamp, 4-step cap
      skeleton.getBone("root").pose.x = Math.sin(frame / 7) * 30;
      skeleton.updateWorldTransform();
      const w = cape.world;
      for (const v of [w.a, w.b, w.c, w.d, w.x, w.y]) expect(Number.isFinite(v)).toBe(true);
      worst = Math.max(worst, Math.abs(w.x), Math.abs(w.y));
    }
    expect(worst).toBeLessThan(1e4);
  });

  it("recovers at runtime when a simulation bypassing the loader goes non-finite (snaps back to the pose)", () => {
    const doc = testDocument(physicsDoc({}) as Sections);
    const bypass = { ...doc, physics: [{ ...doc.physics[0]!, mass: 1e-9, strength: 100, wind: 60 }] } as typeof doc;
    const skeleton = new Skeleton(bypass);
    const constraint = skeleton.physicsConstraints[0]!;
    for (let frame = 0; frame < 120; frame++) {
      skeleton.update(1 / 60);
      skeleton.updateWorldTransform();
      const w = skeleton.getBone("cape").world;
      for (const v of [w.a, w.b, w.c, w.d, w.x, w.y]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(constraint.recoveries).toBeGreaterThan(0);
  });
});

describe("Runtime behaviour contract (section 3 policies)", () => {
  it("first key: a continuous timeline holds its first key backward to clip time 0", () => {
    const doc = stateRig({ late: { duration: 1, bones: { arm: { rotate: [{ time: 0.5, value: 30 }, { time: 1, value: 60 }] } } } });
    const state = new AnimationState(new AnimationStateData(doc));
    const skeleton = new Skeleton(doc);
    state.setAnimation(0, "late");
    state.update(0.2);
    state.apply(skeleton);
    expect(skeleton.getBone("arm").pose.rotation).toBeCloseTo(30, 12);
  });

  it("additive scale is multiplicative: current 2 with a full-weight factor 1.5 gives 3", () => {
    const doc = stateRig({
      big: { duration: 1, bones: { arm: { scale: [{ time: 0, x: 2, y: 2 }] } } },
      puff: { duration: 1, bones: { arm: { scale: [{ time: 0, x: 1.5, y: 1.5 }] } } }
    });
    const state = new AnimationState(new AnimationStateData(doc));
    const skeleton = new Skeleton(doc);
    state.setAnimation(0, "big");
    state.setAnimation(1, "puff", { blend: "add" });
    state.apply(skeleton);
    expect(skeleton.getBone("arm").pose.scaleX).toBeCloseTo(3, 12);
  });

  it("track limit: tracks 0..7 work, track 8 fails with a clear error", () => {
    const state = new AnimationState(new AnimationStateData(stateRig()));
    expect(MAX_TRACKS).toBe(8);
    expect(() => state.setAnimation(MAX_TRACKS - 1, "spin")).not.toThrow();
    expect(() => state.setAnimation(MAX_TRACKS, "spin")).toThrow(/track must be an integer from 0 to 7/);
  });

  it("event callbacks run during update(), before the new pose: bone reads see the preceding pose", () => {
    const doc = stateRig();
    const state = new AnimationState(new AnimationStateData(doc));
    const skeleton = new Skeleton(doc);
    state.setAnimation(0, "spin");
    state.update(0.25);
    state.apply(skeleton);
    let seen = Number.NaN;
    const after: string[] = [];
    state.addListener({
      event: (_entry, event) => {
        seen = skeleton.getBone("arm").pose.rotation;
        after.push(event.name); // the post-pose path: collect here, act after apply()
      }
    });
    state.update(0.5); // passes the event at 0.5
    expect(seen).toBeCloseTo(22.5, 12);
    state.apply(skeleton);
    expect(after).toEqual(["hit"]);
    expect(skeleton.getBone("arm").pose.rotation).toBeCloseTo(67.5, 12);
  });

  it("long pauses: event catch-up covers the latest 1000 loop cycles; older cycles' events are dropped", () => {
    const count = (delta: number) => {
      const state = new AnimationState(new AnimationStateData(stateRig()));
      state.setAnimation(0, "spin");
      let events = 0;
      let completes = 0;
      state.addListener({ event: () => events++, complete: () => completes++ });
      state.update(delta);
      return { events, completes };
    };
    expect(count(10)).toEqual({ events: 10, completes: 10 });
    expect(count(5000)).toEqual({ events: 1000, completes: 1000 });
  });
});
