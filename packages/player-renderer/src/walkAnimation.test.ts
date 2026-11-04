import { Texture, TextureSource } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import { PlayerRenderer } from "./renderer.js";
import {
  LegMesh,
  WALK_TUNING,
  deformLegMesh,
  legWeight,
  strideBob,
  strideLeft,
  strideRight
} from "./walkAnimation.js";

function bodyTexture(): Texture {
  return new Texture({ source: new TextureSource({ width: 40, height: 42 }) });
}

async function walkerRenderer(): Promise<PlayerRenderer> {
  const texture = bodyTexture();
  const renderer = new PlayerRenderer({
    local: true,
    color: 0x38bdf8,
    textureLoader: { load: vi.fn(async () => texture) }
  });
  await renderer.updateAppearance(undefined);
  return renderer;
}

function bodyMesh(renderer: PlayerRenderer): LegMesh {
  const mesh = renderer.layers.body.children.find(
    (child): child is LegMesh => child instanceof LegMesh
  );
  if (!mesh) throw new Error("body mesh missing");
  return mesh;
}

describe("walk animation math", () => {
  it("alternates feet and bobs twice per stride cycle", () => {
    expect(strideLeft(Math.PI / 2)).toBe(1);
    expect(strideRight(Math.PI / 2)).toBe(0);
    expect(strideLeft((3 * Math.PI) / 2)).toBe(0);
    expect(strideRight((3 * Math.PI) / 2)).toBe(1);
    expect(strideBob(0)).toBe(0);
    expect(strideBob(Math.PI / 2)).toBe(1);
    expect(strideBob(Math.PI)).toBeCloseTo(0);
  });

  it("ramps the leg weight from zero at the hip to one at the ground", () => {
    expect(legWeight(0, 5, 20)).toBe(0);
    expect(legWeight(5, 5, 20)).toBe(0);
    expect(legWeight(12.5, 5, 20)).toBeCloseTo(0.5);
    expect(legWeight(20, 5, 20)).toBe(1);
    expect(legWeight(30, 5, 20)).toBe(1);
  });
});

describe("PlayerRenderer walk cycle", () => {
  it("lifts one foot at a time, leaves the upper body alone, and restores the rest pose exactly", async () => {
    const renderer = await walkerRenderer();
    const mesh = bodyMesh(renderer);
    const rest = Float32Array.from(mesh.rest);
    expect(renderer.walkAnimating).toBe(false);

    renderer.setLocomotion(true);
    const peak = Math.round(1000 / WALK_TUNING.strideHz / 4);
    let now = 1000;
    renderer.updateAnimation(now);
    for (let t = 0; t < 400; t += 16) renderer.updateAnimation(now += 16);
    expect(renderer.walkAnimating).toBe(true);
    // Run to a quarter cycle past a full ease-in and compare sides.
    const positions = mesh.geometry.positions;
    let leftMax = 0;
    let rightMax = 0;
    let topMoved = false;
    for (let step = 0; step < 80; step += 1) {
      renderer.updateAnimation(now += peak / 10);
      for (let i = 0; i < rest.length; i += 2) {
        const dy = positions[i + 1]! - rest[i + 1]!;
        if (rest[i + 1]! < 6 && dy !== 0) topMoved = true;
        const x = rest[i]! - 20;
        if (x < -6) leftMax = Math.max(leftMax, -dy);
        if (x > 6) rightMax = Math.max(rightMax, -dy);
      }
    }
    expect(topMoved).toBe(false);
    expect(leftMax).toBeGreaterThan(0.5);
    expect(rightMax).toBeGreaterThan(0.5);
    expect(renderer.visualRoot.position.y).toBeLessThanOrEqual(0);

    renderer.setLocomotion(false);
    for (let t = 0; t < 400; t += 16) renderer.updateAnimation(now += 16);
    expect(renderer.walkAnimating).toBe(false);
    expect(Array.from(mesh.geometry.positions)).toEqual(Array.from(rest));
    expect(renderer.visualRoot.position.y).toBe(0);
    expect(renderer.layers.front_hand.rotation).toBe(0);
    expect(renderer.layers.front_hand.pivot.x).toBe(0);
    renderer.destroy();
  });

  it("does no work while idle", async () => {
    const renderer = await walkerRenderer();
    const mesh = bodyMesh(renderer);
    const spy = vi.spyOn(mesh, "geometryChanged");
    expect(renderer.updateAnimation(100)).toBe(false);
    expect(renderer.updateAnimation(200)).toBe(false);
    renderer.setLocomotion(false);
    expect(renderer.walkAnimating).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("rotates held-weapon layers about the hand anchor and yields in attack poses", async () => {
    const renderer = await walkerRenderer();
    renderer.setLocomotion(true);
    let now = 0;
    renderer.updateAnimation(now);
    for (let t = 0; t < 300; t += 16) renderer.updateAnimation(now += 16);
    expect(Math.abs(renderer.layers.front_hand.rotation)).toBeGreaterThan(0);
    expect(renderer.layers.front_hand.pivot.x).toBe(renderer.layers.front_hand.position.x);
    renderer.setPose("attack_action");
    for (let t = 0; t < 300; t += 16) renderer.updateAnimation(now += 16);
    expect(renderer.layers.front_hand.rotation).toBeCloseTo(0, 10);
    expect(renderer.walkAnimating).toBe(true);
    renderer.destroy();
  });

  it("stops and restores when the player goes down and never animates while downed", async () => {
    const renderer = await walkerRenderer();
    renderer.setLocomotion(true);
    renderer.updateAnimation(0);
    renderer.updateAnimation(100);
    renderer.setPose("downed");
    expect(renderer.walkAnimating).toBe(false);
    renderer.setLocomotion(true);
    expect(renderer.walkAnimating).toBe(false);
    renderer.destroy();
  });

  it("leaves rotated meshes at rest", () => {
    const mesh = new LegMesh(bodyTexture());
    mesh.rotation = 0.3;
    deformLegMesh(mesh, {
      liftLeft: 1, liftRight: 0, compensation: 0, hipY: 0, groundY: 40, centerX: 0,
      sideBlendUnits: 4
    });
    expect(Array.from(mesh.geometry.positions)).toEqual(Array.from(mesh.rest));
  });
});
