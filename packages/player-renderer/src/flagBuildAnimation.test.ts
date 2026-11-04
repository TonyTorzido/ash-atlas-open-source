import type { EquipmentDefinitionId, PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { Container, MeshPlane, Texture, TextureSource } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import {
  FLAG_BUILD_PROGRAM,
  createFlagBuildPose,
  sampleFlagBuild
} from "./flagBuildAnimation.js";
import { impactsBetween, type ArmCut, type ArmCutter } from "./gatherAnimation.js";
import { PlayerRenderer } from "./renderer.js";

function fakeTexture(width = 40, height = 42): Texture {
  return new Texture({ source: new TextureSource({ width, height }) });
}

describe("flag build program", () => {
  it("loops seamlessly", () => {
    const program = FLAG_BUILD_PROGRAM;
    for (const track of [program.arm, program.bend, program.offArm, program.offBend, program.tilt, program.lean, program.squash, program.lift]) {
      expect(track[0]![1]).toBeCloseTo(track[track.length - 1]![1]);
    }
    const start = sampleFlagBuild(0, 1, createFlagBuildPose());
    const end = sampleFlagBuild(program.cycleMs - 0.01, 1, createFlagBuildPose());
    for (const key of Object.keys(start) as (keyof typeof start)[]) {
      expect(end[key]).toBeCloseTo(start[key], 2);
    }
  });

  it("lifts the pole, then rams it down past the neutral hold once per cycle", () => {
    const program = FLAG_BUILD_PROGRAM;
    const raised = sampleFlagBuild(program.cycleMs * 0.47, 1, createFlagBuildPose());
    expect(raised.arm).toBeGreaterThan(program.hold.arm + 25);
    expect(raised.bend).toBeGreaterThan(program.hold.bend + 40);
    expect(raised.lift).toBeGreaterThan(0);
    const impact = sampleFlagBuild(program.cycleMs * program.impactAt, 1, createFlagBuildPose());
    expect(impact.bend).toBeLessThan(program.hold.bend - 25);
    expect(impact.cloth).toBeCloseTo(-1);
    expect(impactsBetween(program, 1, 0, program.cycleMs * 10)).toBe(10);
  });
});

const axeSnapshot: PlayerAppearanceSnapshot = {
  schemaVersion: 1,
  catalogRevision: 1,
  revision: 1,
  bodyVariantId: "default",
  poseId: "idle",
  activeHand: "melee",
  slots: {
    melee: {
      equipmentDefinitionId: "double_axe" as EquipmentDefinitionId,
      appearanceId: "double_axe",
      cosmeticAppearanceId: null
    }
  }
};

function fakeCutter() {
  const cuts: ArmCut[] = [];
  const cut = vi.fn<ArmCutter>((texture, _placement, signs) => {
    const made = {
      armless: fakeTexture(texture.width, texture.height),
      pieces: signs.map(() => fakeTexture(texture.width, texture.height))
    };
    cuts.push(made);
    return made;
  });
  return { cut, release: vi.fn((_cut: ArmCut) => undefined), cuts };
}

async function builder() {
  const cutter = fakeCutter();
  const renderer = new PlayerRenderer({
    local: true,
    color: 0x38bdf8,
    textureLoader: { load: vi.fn(async () => fakeTexture()) },
    armCutter: cutter
  });
  await renderer.updateAppearance(axeSnapshot);
  renderer.setFlagBuildArt({ pole: fakeTexture(241, 320), cloth: fakeTexture(241, 320), baseX: 0.12, baseY: 0.98, clothTint: 0xd83a3a });
  return { renderer, cutter };
}

function run(renderer: PlayerRenderer, fromMs: number, durationMs: number, stepMs = 16): number {
  let now = fromMs;
  for (let t = 0; t < durationMs; t += stepMs) renderer.updateAnimation(now += stepMs);
  return now;
}

describe("PlayerRenderer flag building", () => {
  it("bends both arms with meshes, holds the flag, then restores the exact rest state", async () => {
    const { renderer, cutter } = await builder();
    const root = renderer.visualRoot;
    const rest = {
      rotation: root.rotation,
      y: root.position.y,
      scaleY: root.scale.y,
      bodyChildren: renderer.layers.body.children.length,
      weaponAlpha: renderer.equipmentSprite("melee")?.alpha
    };
    renderer.setGatheringAction({ kind: "flag", tool: null, side: "right", startedAtMs: 0 });
    let now = run(renderer, 0, 2400);
    expect(cutter.cut.mock.calls.at(-1)?.[2]).toEqual([1, -1]);
    expect(renderer.flagBuildPoleVisible).toBe(true);
    expect(renderer.equipmentSprite("melee")?.alpha).toBe(0);
    expect(renderer.gatherImpactCount).toBe(2);
    // No rigid rotating arm containers: the arms are bent meshes on the shared arm rig.
    expect(renderer.layers.body.children.some((child) => child.constructor === Container)).toBe(false);
    const rig = root.children.find((child) => child.label === "arm-rig") as Container;
    expect(rig.children.filter((child) => child instanceof MeshPlane).length).toBeGreaterThanOrEqual(2);
    // The held flag is drawn over the arms.
    expect(root.getChildIndex(root.children.find((child) => child.label === "flag-build-held")!))
      .toBeGreaterThan(root.getChildIndex(rig));

    renderer.setGatheringAction(null);
    now = run(renderer, now, 1000);
    expect(renderer.updateAnimation(now + 16)).toBe(false);
    expect(renderer.flagBuildPoleVisible).toBe(false);
    expect(root.rotation).toBe(rest.rotation);
    expect(root.position.y).toBe(rest.y);
    expect(root.scale.y).toBe(rest.scaleY);
    expect(renderer.layers.body.children.length).toBe(rest.bodyChildren);
    expect(rig.children.filter((child) => child instanceof MeshPlane).length).toBe(0);
    expect(renderer.equipmentSprite("melee")?.alpha).toBe(rest.weaponAlpha);
    expect(cutter.release).toHaveBeenCalledTimes(cutter.cuts.length);
  });

  it("plays no impacts or dust under reduced motion", async () => {
    const { renderer } = await builder();
    renderer.setGatheringAction({ kind: "flag", tool: null, side: "left", startedAtMs: 0, reducedMotion: true });
    run(renderer, 0, 3000);
    expect(renderer.gatherImpactCount).toBe(0);
    expect(renderer.flagBuildPoleVisible).toBe(true);
  });
});
