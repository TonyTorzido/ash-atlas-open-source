import type { EquipmentDefinitionId, PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import { Texture, TextureSource } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import {
  GATHER_TUNING,
  REST_ARM_DEGREES,
  SWING_PROGRAMS,
  createGatherPose,
  sampleSwing,
  type ArmCut,
  type ArmCutter,
  type SwingVariant
} from "./gatherAnimation.js";
import { PlayerRenderer } from "./renderer.js";

function fakeTexture(width = 40, height = 42): Texture {
  return new Texture({ source: new TextureSource({ width, height }) });
}

function fakeCutter() {
  const cut = vi.fn<ArmCutter>((texture, _placement, signs): ArmCut => ({
    armless: fakeTexture(texture.width, texture.height),
    pieces: signs.map(() => fakeTexture(texture.width, texture.height)),
    caps: signs.map(() => fakeTexture(texture.width, texture.height))
  }));
  return { cut, release: vi.fn((_cut: ArmCut) => undefined) };
}

const swordSnapshot: PlayerAppearanceSnapshot = {
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

async function swinger() {
  const renderer = new PlayerRenderer({
    local: true,
    color: 0x38bdf8,
    textureLoader: { load: vi.fn(async () => fakeTexture()) },
    armCutter: fakeCutter()
  });
  await renderer.updateAppearance(swordSnapshot);
  return renderer;
}

function weaponState(renderer: PlayerRenderer) {
  const sprite = renderer.equipmentSprite("melee")!;
  return { x: sprite.position.x, y: sprite.position.y, rotation: sprite.rotation, scaleX: sprite.scale.x, alpha: sprite.alpha };
}

function bodyState(renderer: PlayerRenderer) {
  const root = renderer.visualRoot;
  return { rotation: root.rotation, x: root.position.x, y: root.position.y, scaleX: root.scale.x, scaleY: root.scale.y };
}

describe("swing programs", () => {
  const pose = createGatherPose();

  it("start and end at the exact rest pose for every variant", () => {
    for (const variant of ["swing", "finisher", "shot"] as const) {
      const program = SWING_PROGRAMS[variant];
      for (const elapsed of [0, program.cycleMs, program.cycleMs + 500]) {
        sampleSwing(variant, elapsed, pose);
        expect(pose.arm).toBeCloseTo(REST_ARM_DEGREES);
        expect(pose.bend).toBeCloseTo(0);
        expect(pose.tool).toBeCloseTo(GATHER_TUNING.tool.restDegrees);
        expect(pose.offArm).toBeCloseTo(REST_ARM_DEGREES);
        expect(pose.offBend).toBeCloseTo(0);
        expect(pose.lean).toBeCloseTo(0);
        expect(pose.squash).toBeCloseTo(0);
        expect(pose.lift).toBeCloseTo(0);
      }
    }
  });

  it("winds up, strikes across, then follows through (about 350 ms)", () => {
    const program = SWING_PROGRAMS.swing;
    expect(program.cycleMs).toBeGreaterThanOrEqual(330);
    expect(program.cycleMs).toBeLessThanOrEqual(370);
    sampleSwing("swing", program.cycleMs * 0.14, pose);
    // Windup: upper arm out, elbow cocked, weapon tipped back past upright.
    expect(pose.arm).toBeGreaterThan(55);
    expect(pose.bend).toBeGreaterThan(80);
    expect(pose.tool).toBeGreaterThan(GATHER_TUNING.tool.restDegrees);
    sampleSwing("swing", program.cycleMs * 0.3, pose);
    // Strike: the elbow snaps nearly straight and the weapon points across.
    expect(pose.bend).toBeLessThan(15);
    expect(pose.tool).toBeLessThan(110);
    sampleSwing("swing", program.cycleMs * 0.6, pose);
    // Follow-through is still extended, not yet at rest.
    expect(pose.arm).toBeGreaterThan(REST_ARM_DEGREES + 15);
  });

  it("makes the finisher longer with a bigger arc", () => {
    expect(SWING_PROGRAMS.finisher.cycleMs).toBeGreaterThan(SWING_PROGRAMS.swing.cycleMs);
    const reach = (variant: SwingVariant) => {
      let maxArm = 0;
      let maxBend = 0;
      let maxTool = 0;
      let minTool = 999;
      for (let t = 0; t <= 1; t += 0.01) {
        sampleSwing(variant, t * SWING_PROGRAMS[variant].cycleMs, pose);
        maxArm = Math.max(maxArm, pose.arm);
        maxBend = Math.max(maxBend, pose.bend);
        maxTool = Math.max(maxTool, pose.tool);
        minTool = Math.min(minTool, pose.tool);
      }
      return { maxArm, maxBend, sweep: maxTool - minTool };
    };
    const normal = reach("swing");
    const finisher = reach("finisher");
    expect(finisher.maxArm).toBeGreaterThan(normal.maxArm);
    expect(finisher.maxBend).toBeGreaterThan(normal.maxBend);
    expect(finisher.sweep).toBeGreaterThan(normal.sweep);
  });

  it("draws the off arm back and releases for a shot", () => {
    const program = SWING_PROGRAMS.shot;
    sampleSwing("shot", program.cycleMs * 0.55, pose);
    expect(pose.offBend).toBeGreaterThan(90);
    expect(pose.bend).toBeLessThan(20);
    const drawn = pose.offBend;
    sampleSwing("shot", program.cycleMs * 0.75, pose);
    expect(pose.offBend).toBeLessThan(drawn - 50);
  });

  it("allocates nothing per sample (writes into the given pose)", () => {
    const out = createGatherPose();
    expect(sampleSwing("swing", 120, out)).toBe(out);
  });
});

describe("renderer swing playback", () => {
  it("moves the weapon with the arm, then restores the exact rest state", async () => {
    const renderer = await swinger();
    const rest = { body: bodyState(renderer), weapon: weaponState(renderer) };
    expect(renderer.playSwing("swing", "right", 1000)).toBe(true);
    expect(renderer.swinging).toBe(true);
    expect(renderer.animating).toBe(true);
    // The weapon stays visible (it is not swapped for a gather tool) and moves with the fist.
    let moved = false;
    let now = 1000;
    for (let index = 0; index < 12; index += 1) {
      renderer.updateAnimation(now += 16);
      const weapon = weaponState(renderer);
      expect(weapon.alpha).toBe(1);
      if (Math.abs(weapon.rotation - rest.weapon.rotation) > 0.2) moved = true;
    }
    expect(moved).toBe(true);
    expect(bodyState(renderer)).not.toEqual(rest.body);
    for (let index = 0; index < 40; index += 1) renderer.updateAnimation(now += 16);
    expect(renderer.swinging).toBe(false);
    expect(renderer.updateAnimation(now + 16)).toBe(false);
    expect(renderer.animating).toBe(false);
    expect(bodyState(renderer)).toEqual(rest.body);
    expect(weaponState(renderer)).toEqual(rest.weapon);
  });

  it("mirrors the swing for the left arm", async () => {
    const right = await swinger();
    const left = await swinger();
    right.playSwing("swing", "right", 0);
    left.playSwing("swing", "left", 0);
    // 130 ms in, the windup is at its peak.
    right.updateAnimation(1);
    left.updateAnimation(1);
    right.updateAnimation(130);
    left.updateAnimation(130);
    const r = weaponState(right);
    const l = weaponState(left);
    expect(l.scaleX).toBeCloseTo(-r.scaleX);
    expect(l.rotation).toBeCloseTo(-r.rotation);
    expect(l.y).toBeCloseTo(r.y);
    expect(left.visualRoot.rotation).toBeCloseTo(-right.visualRoot.rotation);
  });

  it("cancel resets the pose, weapon and body at once", async () => {
    const renderer = await swinger();
    const rest = { body: bodyState(renderer), weapon: weaponState(renderer) };
    renderer.playSwing("finisher", "left", 0);
    renderer.updateAnimation(1);
    renderer.updateAnimation(120);
    expect(weaponState(renderer)).not.toEqual(rest.weapon);
    renderer.cancelSwing();
    expect(renderer.swinging).toBe(false);
    expect(bodyState(renderer)).toEqual(rest.body);
    expect(weaponState(renderer)).toEqual(rest.weapon);
    expect(renderer.updateAnimation(140)).toBe(false);
    expect(renderer.animating).toBe(false);
  });

  it("restarts on a new swing and ignores swings while gathering or downed", async () => {
    const renderer = await swinger();
    renderer.playSwing("swing", "right", 0);
    renderer.updateAnimation(1);
    renderer.updateAnimation(200);
    // A second press restarts the program from its rest start.
    renderer.playSwing("swing", "right", 210);
    renderer.updateAnimation(210);
    expect(weaponState(renderer).rotation).toBeCloseTo(renderer.equipmentSprite("melee")!.rotation);
    expect(renderer.swinging).toBe(true);
    renderer.cancelSwing();

    renderer.setGatheringAction({ kind: "chop", tool: fakeTexture(1024, 1024), side: "right", startedAtMs: 0 });
    expect(renderer.playSwing("swing", "right", 0)).toBe(false);
    renderer.setGatheringAction(null);
    renderer.setPose("downed");
    expect(renderer.playSwing("swing", "right", 0)).toBe(false);
  });
});
