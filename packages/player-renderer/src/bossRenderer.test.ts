import { DEFAULT_BOSS_APPEARANCE_CATALOG } from "@ash-atlas/shared";
import { Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import { BossRenderer } from "./bossRenderer.js";

describe("boss renderer", () => {
  it("loads Xoral's body and applies authored weapon transforms for each combat pose", async () => {
    const catalog = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    const xoral = catalog.bosses[0]!;
    xoral.weapon.assetKey = "xoral/weapons/blade.png";
    xoral.overallScale = 1.5;
    xoral.weapon.placements.idle = { offsetX: 3, offsetY: -7, pivotX: 0.25 };
    xoral.weapon.placements.combat_ready = { rotationDegrees: -40 };
    xoral.weapon.placements.attack_action = { offsetX: 20, rotationDegrees: 80 };
    const load = vi.fn(async () => Texture.EMPTY);
    const renderer = new BossRenderer({
      bossId: "xoral",
      catalog,
      textureLoader: { load }
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(renderer.weapon.visible).toBe(true));
    expect(renderer.overallScale).toBe(1.5);
    expect(renderer.visualRoot.scale.x).toBe(1.5);
    expect(renderer.body.parent).toBe(renderer.visualRoot);
    expect(renderer.weapon.parent).toBe(renderer.visualRoot);

    renderer.setPose("combat_ready");
    expect(renderer.weapon.position.x).toBe(3);
    expect(renderer.weapon.position.y).toBe(-7);
    expect(renderer.weapon.anchor.x).toBe(0.25);
    expect(renderer.weapon.rotation).toBeCloseTo(-40 * Math.PI / 180);

    renderer.setPose("attack_action");
    expect(renderer.weapon.position.x).toBe(20);
    expect(renderer.weapon.rotation).toBeCloseTo(80 * Math.PI / 180);
    renderer.destroy();
  });
});
