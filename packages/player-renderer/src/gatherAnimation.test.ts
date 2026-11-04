import type { EquipmentDefinitionId, PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { Container, MeshPlane, Texture, TextureSource } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import {
  GATHER_PROGRAMS,
  GATHER_TUNING,
  armGeometryForBody,
  armPolygonInTexture,
  createArmGeometry,
  createCachedArmCutter,
  createGatherPose,
  gatherFishPhaseForEncounter,
  gatherSideForTarget,
  impactsBetween,
  sampleProgram,
  sampleTrack,
  type ArmCut,
  type ArmCutter
} from "./gatherAnimation.js";
import { PlayerRenderer } from "./renderer.js";

function fakeTexture(width = 40, height = 42): Texture {
  return new Texture({ source: new TextureSource({ width, height }) });
}

function fakeCutter() {
  const cuts: ArmCut[] = [];
  const cut = vi.fn<ArmCutter>((texture, _placement, signs) => {
    const made = {
      armless: fakeTexture(texture.width, texture.height),
      pieces: signs.map(() => fakeTexture(texture.width, texture.height)),
      caps: signs.map(() => fakeTexture(texture.width, texture.height))
    };
    cuts.push(made);
    return made;
  });
  const release = vi.fn((_cut: ArmCut) => undefined);
  return { cut, release, cuts };
}

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

async function gatherer(cutter = fakeCutter()) {
  const renderer = new PlayerRenderer({
    local: true,
    color: 0x38bdf8,
    textureLoader: { load: vi.fn(async () => fakeTexture()) },
    armCutter: cutter
  });
  await renderer.updateAppearance(axeSnapshot);
  return { renderer, cutter };
}

function restState(renderer: PlayerRenderer) {
  const root = renderer.visualRoot;
  return {
    rotation: root.rotation,
    x: root.position.x,
    y: root.position.y,
    scaleX: root.scale.x,
    scaleY: root.scale.y,
    bodyChildren: renderer.layers.body.children.length,
    handsChildren: renderer.layers.hands.children.filter((child) => child.visible).length,
    bodyTexture: renderer.layers.body.children[0] && "texture" in renderer.layers.body.children[0]
      ? renderer.layers.body.children[0].texture
      : null,
    weaponAlpha: renderer.equipmentSprite("melee")?.alpha ?? null
  };
}

function run(renderer: PlayerRenderer, fromMs: number, durationMs: number, stepMs = 16): number {
  let now = fromMs;
  for (let t = 0; t < durationMs; t += stepMs) renderer.updateAnimation(now += stepMs);
  return now;
}

describe("gather animation math", () => {
  it("samples key tracks with eased segments and clamps at the ends", () => {
    const track = [[0, 0], [0.5, 10], [1, 0]] as const;
    expect(sampleTrack(track, -1)).toBe(0);
    expect(sampleTrack(track, 0.25)).toBeCloseTo(5);
    expect(sampleTrack(track, 0.5)).toBe(10);
    expect(sampleTrack(track, 2)).toBe(0);
  });

  it("loops every program seamlessly (first key equals last key)", () => {
    for (const program of Object.values(GATHER_PROGRAMS)) {
      if (program === GATHER_PROGRAMS.fish_cast) continue;
      const tracks = [program.arm, program.tool, program.lean, program.squash, program.lift,
        program.bend, program.offArm, program.offBend].filter((track) => track !== undefined);
      for (const track of tracks) {
        expect(track[0]![1]).toBeCloseTo(track[track.length - 1]![1]);
      }
    }
  });

  it("strikes at a steady cadence: chop about once a second, mine slower", () => {
    expect(GATHER_PROGRAMS.chop.cycleMs).toBeGreaterThanOrEqual(900);
    expect(GATHER_PROGRAMS.chop.cycleMs).toBeLessThanOrEqual(1100);
    expect(GATHER_PROGRAMS.mine.cycleMs).toBeGreaterThan(GATHER_PROGRAMS.chop.cycleMs);
    expect(impactsBetween(GATHER_PROGRAMS.chop, 1, 0, 10_000)).toBe(10);
    expect(impactsBetween(GATHER_PROGRAMS.mine, 1, 0, 13_000)).toBe(10);
    // Split into frames, the impacts still add up to one per cycle.
    let total = 0;
    for (let t = 0; t < 10_000; t += 16) total += impactsBetween(GATHER_PROGRAMS.chop, 1, t, t + 16);
    expect(total).toBe(10);
  });

  it("winds up above the shoulder before the strike lands beside the body", () => {
    const pose = createGatherPose();
    const chop = GATHER_PROGRAMS.chop;
    sampleProgram(chop, chop.cycleMs * 0.4, 1, pose);
    // Upper arm raised out with the elbow cocked: the fist is up by the head.
    expect(pose.arm).toBeGreaterThan(55);
    expect(pose.bend).toBeGreaterThan(80);
    sampleProgram(chop, chop.cycleMs * chop.impactAt!, 1, pose);
    expect(pose.arm).toBeGreaterThan(45);
    expect(pose.bend).toBeLessThan(15);
    expect(pose.arm).toBeLessThan(100);
    expect(pose.squash).toBeGreaterThan(0);
  });

  it("maps the template arm through the body placement and back into a sprite's texture", () => {
    const body = { x: 0, y: 32, scaleX: 0.05, scaleY: 0.05, rotation: 0, pivotX: 543, pivotY: 1448 };
    const geometry = armGeometryForBody(body, 1086, 1448, createArmGeometry());
    expect(geometry.centerX).toBeCloseTo(0);
    expect(geometry.shoulderX).toBeCloseTo((GATHER_TUNING.arm.shoulderU - 543) * 0.05);
    // Mapping back into the body texture recovers the template polygon.
    const points = armPolygonInTexture(geometry, body, 1, []);
    expect(points[0]).toBeCloseTo(GATHER_TUNING.arm.polygon[0]!);
    expect(points[1]).toBeCloseTo(GATHER_TUNING.arm.polygon[1]!);
    const mirrored = armPolygonInTexture(geometry, body, -1, []);
    expect(mirrored[0]).toBeCloseTo(1086 - GATHER_TUNING.arm.polygon[0]!);
  });

  it("picks the hand on the target's screen side with hysteresis", () => {
    expect(gatherSideForTarget(100, 140, null)).toBe("right");
    expect(gatherSideForTarget(100, 60, null)).toBe("left");
    expect(gatherSideForTarget(100, 97, "right")).toBe("right");
    expect(gatherSideForTarget(100, 90, "right")).toBe("left");
    expect(gatherSideForTarget(100, 104, "left")).toBe("left");
  });

  it("maps fishing encounter phases to presentation phases", () => {
    expect(gatherFishPhaseForEncounter("cast", false)).toBe("ready");
    expect(gatherFishPhaseForEncounter("cast", true)).toBe("wait");
    expect(gatherFishPhaseForEncounter("bite", true)).toBe("bite");
    expect(gatherFishPhaseForEncounter("fighting", true)).toBe("fight");
    expect(gatherFishPhaseForEncounter("landed", true)).toBeNull();
  });

  it("shares one cut per texture and side, and frees idle cuts beyond the limit", () => {
    const destroy = vi.fn();
    const base = vi.fn<ArmCutter>(() => ({
      armless: { destroy } as unknown as Texture,
      pieces: []
    }));
    const cache = createCachedArmCutter(base, 1);
    const texture = fakeTexture();
    const otherTexture = fakeTexture();
    const placement = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0 };
    const geometry = createArmGeometry();
    const first = cache.cutter(texture, placement, [1], geometry)!;
    expect(cache.cutter(texture, placement, [1], geometry)).toBe(first);
    expect(base).toHaveBeenCalledTimes(1);
    cache.release(first);
    cache.release(first);
    const second = cache.cutter(otherTexture, placement, [1], geometry)!;
    cache.release(second);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });

  it("shares one cut for the same two sides in either order", () => {
    const right = fakeTexture();
    const left = fakeTexture();
    const base = vi.fn<ArmCutter>((_texture, _placement, signs) => ({
      armless: fakeTexture(),
      pieces: signs.map((sign) => (sign > 0 ? right : left))
    }));
    const cache = createCachedArmCutter(base);
    const placement = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: 0, pivotY: 0 };
    const geometry = createArmGeometry();
    const forward = cache.cutter(fakeTexture(), placement, [1, -1], geometry)!;
    expect(forward.pieces).toEqual([right, left]);
    const texture = fakeTexture();
    const leftFirst = cache.cutter(texture, placement, [-1, 1], geometry)!;
    expect(cache.cutter(texture, placement, [1, -1], geometry)!.armless).toBe(leftFirst.armless);
    expect(leftFirst.pieces).toEqual([left, right]);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1]![2]).toEqual([1, -1]);
  });
});

describe("PlayerRenderer gathering", () => {
  it("does no work while idle", async () => {
    const { renderer, cutter } = await gatherer();
    const before = restState(renderer);
    expect(renderer.animating).toBe(false);
    expect(renderer.updateAnimation(1000)).toBe(false);
    expect(restState(renderer)).toEqual(before);
    expect(cutter.cut).not.toHaveBeenCalled();
  });

  it("bends both arms and moves the tool, hides the weapon, then restores the exact rest state", async () => {
    const { renderer, cutter } = await gatherer();
    const rest = restState(renderer);
    const tool = fakeTexture(1024, 1024);
    renderer.setGatheringAction({ kind: "chop", tool, side: "right", startedAtMs: 1000 });
    expect(renderer.animating).toBe(true);
    let now = run(renderer, 1000, 1400);
    expect(cutter.cut).toHaveBeenCalled();
    expect(renderer.equipmentSprite("melee")?.alpha).toBe(0);
    // Chop bends mesh arms (both sides) on the arm rig; no rigid containers.
    const rig = renderer.visualRoot.children.find((child) => child.label === "arm-rig") as Container;
    expect(rig.children.filter((child) => child instanceof MeshPlane).length).toBeGreaterThanOrEqual(2);
    expect(renderer.layers.body.children.some((child) => child.constructor === Container)).toBe(false);
    expect(renderer.gatherImpactCount).toBeGreaterThan(0);
    // The turned-out arm keeps its shoulder cap in front of the torso.
    const caps = renderer.visualRoot.children.find((child) => child.label === "arm-rig-caps") as Container;
    expect(caps.children.some((child) => child.visible)).toBe(true);

    renderer.setGatheringAction(null);
    now = run(renderer, now, 1000);
    expect(renderer.updateAnimation(now + 16)).toBe(false);
    expect(renderer.animating).toBe(false);
    expect(restState(renderer)).toEqual(rest);
    expect(caps.children.length).toBe(0);
    expect(cutter.release).toHaveBeenCalledTimes(cutter.cuts.length);
  });

  it("mirrors the tool and arm swing for a target on the left", async () => {
    const right = (await gatherer()).renderer;
    const left = (await gatherer()).renderer;
    const tool = fakeTexture(1024, 1024);
    right.setGatheringAction({ kind: "mine", tool, side: "right", startedAtMs: 0 });
    left.setGatheringAction({ kind: "mine", tool, side: "left", startedAtMs: 0 });
    run(right, 0, 700);
    run(left, 0, 700);
    const rig = (renderer: PlayerRenderer) =>
      renderer.visualRoot.children.find((child) => child.label === "arm-rig") as Container;
    // The tool is held in the hands layer, in front of the torso.
    const rightTool = right.layers.hands.children.at(-1)!;
    const leftTool = left.layers.hands.children.at(-1)!;
    // The main arm's first mesh (attached first) bends to the mirror image.
    const rightArm = rig(right).children[0] as MeshPlane;
    const leftArm = rig(left).children[0] as MeshPlane;
    const rightPositions = rightArm.geometry.positions;
    const leftPositions = leftArm.geometry.positions;
    expect(leftPositions[40]).toBeCloseTo(-rightPositions[40]!);
    expect(leftPositions[41]).toBeCloseTo(rightPositions[41]!);
    expect(rightTool.scale.x).toBeGreaterThan(0);
    expect(leftTool.scale.x).toBeCloseTo(-rightTool.scale.x);
    expect(leftTool.position.x).toBeCloseTo(-rightTool.position.x);
    expect(leftTool.position.y).toBeCloseTo(rightTool.position.y);
    expect(leftTool.rotation).toBeCloseTo(-rightTool.rotation);
    expect(left.visualRoot.rotation).toBeCloseTo(-right.visualRoot.rotation);
  });

  it("cuts both arms for the bare-hand pound and the bare-hand chop", async () => {
    const { renderer, cutter } = await gatherer();
    renderer.setGatheringAction({ kind: "mine", tool: null, side: "right", startedAtMs: 0 });
    run(renderer, 0, 200);
    expect(cutter.cut.mock.calls.at(-1)?.[2]).toEqual([1, -1]);
    renderer.setGatheringAction({ kind: "chop", tool: null, side: "left", startedAtMs: 500 });
    run(renderer, 200, 200);
    expect(cutter.cut.mock.calls.at(-1)?.[2]).toEqual([-1, 1]);
  });

  it("keeps arms static (tool only) when a texture cannot be cut, and stays restorable", async () => {
    const failing = { cut: vi.fn<ArmCutter>(() => null), release: vi.fn((_cut: ArmCut) => undefined), cuts: [] };
    const { renderer } = await gatherer(failing);
    const rest = restState(renderer);
    renderer.setGatheringAction({ kind: "chop", tool: fakeTexture(1024, 1024), side: "right", startedAtMs: 0 });
    let now = run(renderer, 0, 600);
    expect(renderer.layers.hands.children.at(-1)?.visible).toBe(true);
    renderer.setGatheringAction(null);
    now = run(renderer, now, 1000);
    expect(restState(renderer)).toEqual(rest);
  });

  it("picks bare-handed, pops pieces off the plant clear of the fist, then restores the rest state", async () => {
    const { renderer } = await gatherer();
    const rest = restState(renderer);
    // A tool handed in by mistake is never shown: picking is bare-handed.
    renderer.setGatheringAction({ kind: "harvest", tool: fakeTexture(1024, 1024), side: "right", startedAtMs: 0 });
    const internals = renderer as unknown as {
      gatherParticles: { x: number; y: number; ageMs: number; lifeMs: number }[];
      gatherPoint: { x: number; y: number };
      gatherToolSprite: { visible: boolean } | null;
      visualToRoot(x: number, y: number, out: { x: number; y: number }): { x: number; y: number };
      armGeometry: { shoulderX: number; shoulderY: number; fistX: number; fistY: number };
    };
    const impactMs = GATHER_PROGRAMS.harvest.cycleMs * GATHER_PROGRAMS.harvest.impactAt!;
    let now = run(renderer, 0, impactMs + 8);
    expect(renderer.gatherImpactCount).toBe(1);
    expect(internals.gatherToolSprite?.visible ?? false).toBe(false);
    const fist = internals.visualToRoot(internals.gatherPoint.x, internals.gatherPoint.y, { x: 0, y: 0 });
    const geometry = internals.armGeometry;
    const armLength = Math.hypot(geometry.fistX - geometry.shoulderX, geometry.fistY - geometry.shoulderY) *
      renderer.visualRoot.scale.y;
    const live = internals.gatherParticles.filter((particle) => particle.ageMs < particle.lifeMs);
    expect(live.length).toBe(GATHER_TUNING.particles.harvest.count);
    for (const particle of live) {
      // Spawned past the fingers on the plant side, never over the fist.
      expect(particle.x - fist.x).toBeGreaterThan(0.25 * armLength);
    }
    renderer.setGatheringAction(null);
    now = run(renderer, now, 1000);
    expect(restState(renderer)).toEqual(rest);
  });

  it("holds the rest pose until the held tool's art has loaded, without jumping after it", async () => {
    let resolveTool: (texture: Texture) => void = () => undefined;
    const renderer = new PlayerRenderer({
      local: false,
      color: 0x38bdf8,
      textureLoader: {
        load: vi.fn(async (key: string) => key === "tools/axe.png"
          ? new Promise<Texture>((resolve) => { resolveTool = resolve; })
          : fakeTexture())
      },
      armCutter: fakeCutter()
    });
    await renderer.updateAppearance(axeSnapshot);
    const rest = restState(renderer);
    renderer.setGatheringAction({ kind: "chop", tool: "tools/axe.png", side: "right", startedAtMs: 0 });
    let now = run(renderer, 0, 400);
    expect(renderer.visualRoot.rotation).toBe(rest.rotation);
    expect(renderer.equipmentSprite("melee")?.alpha).toBe(rest.weaponAlpha);
    resolveTool(fakeTexture(1024, 1024));
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = run(renderer, now, 16);
    expect(renderer.equipmentSprite("melee")?.alpha).toBeGreaterThan(0.8);
    now = run(renderer, now, 300);
    expect(renderer.equipmentSprite("melee")?.alpha).toBe(0);
  });

  it("eases in by one frame after a slow first rig build, not by the stalled time", async () => {
    const { renderer } = await gatherer();
    renderer.setGatheringAction({ kind: "harvest", tool: null, side: "right", startedAtMs: 0 });
    renderer.updateAnimation(0);
    // The build froze the page for 150 ms before the next frame.
    renderer.updateAnimation(150);
    expect(renderer.equipmentSprite("melee")?.alpha).toBeGreaterThan(0.9);
  });

  it("blocks the walk cycle while gathering", async () => {
    const { renderer } = await gatherer();
    renderer.setGatheringAction({ kind: "fish", tool: fakeTexture(1024, 1024), side: "right", startedAtMs: 0 });
    renderer.setLocomotion(true);
    expect(renderer.walkAnimating).toBe(false);
  });
});
