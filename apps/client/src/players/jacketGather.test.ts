import { FLAG_BUILD_PROGRAM, GATHER_PROGRAMS, GATHER_TUNING } from "@ash-atlas/player-renderer";
import { describe, expect, it } from "vitest";
import manifest from "../assets/player-rig/jacketb-gather/jacketb-gather.json";
import { FLAG_PLANT_MS, FlagPlantImpact, jacketGatherFrame, type JacketGatherInput } from "./jacketGather.js";

const contact = (id: string) => (manifest as { clips: Record<string, { contact: number | null }> }).clips[id]!.contact;
const input = (kind: JacketGatherInput["action"]["kind"], tool: string | null, extra: Partial<JacketGatherInput> = {}): JacketGatherInput => ({
  action: { kind, tool, side: "left", startedAtMs: 1000 },
  tool: null,
  flagArt: null,
  flagRemainingMs: null,
  ...extra
});

describe("jacket gather clip timing", () => {
  // The renderer counts an impact at startedAtMs + impactAt * cycleMs (+ whole cycles); the clip must show its
  // contact frame then, so particles and the node reaction land with the strike.
  it.each([
    ["chop", "axe", GATHER_PROGRAMS.chop, "chop"],
    ["chop", null, GATHER_PROGRAMS.chop_hand, "chop"],
    ["mine", "pick", GATHER_PROGRAMS.mine, "mine"],
    ["mine", null, GATHER_PROGRAMS.mine_hand, "mine"],
    ["harvest", null, GATHER_PROGRAMS.harvest, "harvest"]
  ] as const)("%s (tool %s) shows the contact frame on every impact", (kind, tool, program, clip) => {
    for (const cycle of [0, 1, 7]) {
      const at = 1000 + (cycle + program.impactAt!) * program.cycleMs;
      expect(jacketGatherFrame(input(kind, tool), at + 1).frame).toBe(contact(clip));
    }
  });

  it("reduced motion (x1.5 cadence) keeps the impact on the contact frame", () => {
    const action = { kind: "chop" as const, tool: "axe", side: "left" as const, startedAtMs: 1000, reducedMotion: true };
    const at = 1000 + GATHER_PROGRAMS.chop.impactAt! * GATHER_PROGRAMS.chop.cycleMs * GATHER_TUNING.reducedCadence;
    expect(jacketGatherFrame({ ...input("chop", "axe"), action }, at + 1).frame).toBe(contact("chop"));
  });

  it("flag: works until 1 s before completion, then plants (the ram on the plant contact frame)", () => {
    const at = 1000 + 3 * FLAG_BUILD_PROGRAM.cycleMs + FLAG_BUILD_PROGRAM.impactAt * FLAG_BUILD_PROGRAM.cycleMs;
    expect(jacketGatherFrame(input("flag", null, { flagRemainingMs: 5000 }), at + 1)).toEqual({ id: "flag_work", frame: contact("flag_work") });
    expect(jacketGatherFrame(input("flag", null, { flagRemainingMs: FLAG_PLANT_MS + 1 }), 2000).id).toBe("flag_work");
    expect(jacketGatherFrame(input("flag", null, { flagRemainingMs: FLAG_PLANT_MS }), 2000)).toEqual({ id: "flag_plant", frame: 0 });
    const plantMs = (contact("flag_plant")! + 0.5) * 1000 / 30;
    expect(jacketGatherFrame(input("flag", null, { flagRemainingMs: FLAG_PLANT_MS - plantMs }), 2000).frame).toBe(contact("flag_plant"));
    expect(jacketGatherFrame(input("flag", null, { flagRemainingMs: -50 }), 2000)).toEqual({ id: "flag_plant", frame: 30 });
  });

  it("flag plant: one impact, on the frame the clip drives the flag into the ground (audit M3)", () => {
    const edge = new FlagPlantImpact();
    const impacts: number[] = [];
    // ~60 fps through the work loop tail and the whole plant, then a second build.
    for (const build of [0, 1]) {
      for (let remaining = 1600; remaining >= -100; remaining -= 16.7) {
        const { id, frame } = jacketGatherFrame(input("flag", null, { flagRemainingMs: remaining }), 2000);
        edge.observe(id, frame);
        expect(edge.planting).toBe(id === "flag_plant");
        if (edge.take()) impacts.push(build * 100 + frame);
      }
      edge.observe(null, -1);
    }
    expect(impacts).toEqual([contact("flag_plant")!, 100 + contact("flag_plant")!]);
  });

  it("flag plant: a plant first drawn well after its contact (sheet loading) gets no late dust", () => {
    const edge = new FlagPlantImpact();
    edge.observe("flag_plant", -1);
    expect(edge.planting).toBe(false);
    edge.observe("flag_plant", contact("flag_plant")! + 6);
    expect(edge.take()).toBe(false);
    edge.observe("flag_plant", contact("flag_plant")! + 7);
    expect(edge.take()).toBe(false);
  });

  it("fish: the cast plays once, then the hold", () => {
    expect(jacketGatherFrame(input("fish", "pole"), 1000 + 300).id).toBe("fish_cast");
    expect(jacketGatherFrame(input("fish", "pole"), 1000 + GATHER_TUNING.fish.castMs + 10).id).toBe("fish_hold");
  });
});
