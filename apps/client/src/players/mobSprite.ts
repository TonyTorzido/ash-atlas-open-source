import type { CombatEntitySnapshot } from "@ash-atlas/shared";
import { Container, Graphics } from "pixi.js";

export function createMobSprite(
  archetypeKey: CombatEntitySnapshot["archetypeKey"],
  color: number
): Container {
  const sprite = new Container();
  if (archetypeKey === "training_dummy") {
    sprite.addChild(new Graphics().rect(-4, -16, 8, 31).fill({ color: 0x92400e })
      .circle(0, -18, 8).fill({ color }).moveTo(-15, -6).lineTo(15, -6)
      .stroke({ color: 0xfef3c7, width: 4 }).moveTo(-10, 19).lineTo(10, 19)
      .stroke({ color: 0x451a03, width: 5 }));
    return sprite;
  }
  if (archetypeKey === "wolf") {
    sprite.addChild(new Graphics().poly([-16, -5, -9, -15, -3, -7, 8, -11, 17, -4, 10, 5, -8, 7], true)
      .fill({ color: 0x6b7280 }).poly([8, -11, 13, -20, 17, -9], true)
      .poly([-7, -9, -12, -18, -2, -12], true).fill({ color: 0x4b5563 })
      .circle(11, -7, 1.8).fill({ color: 0xfef08a }).moveTo(-11, 5).lineTo(-13, 15)
      .moveTo(7, 5).lineTo(9, 15).stroke({ color: 0x374151, width: 4 })
      .moveTo(-15, -3).bezierCurveTo(-25, -9, -24, -18, -18, -18)
      .stroke({ color: 0x4b5563, width: 4 }));
    return sprite;
  }
  sprite.addChild(new Graphics().poly([-13, -14, -6, -25, -2, -13], true)
    .poly([13, -14, 6, -25, 2, -13], true).fill({ color: 0x65a30d })
    .circle(0, -7, 14).fill({ color }).circle(-5, -9, 2).circle(5, -9, 2)
    .fill({ color: 0xfef08a }).rect(-9, 7, 18, 18).fill({ color: 0x3f6212 })
    .stroke({ color: 0x111827, width: 2 }));
  return sprite;
}
