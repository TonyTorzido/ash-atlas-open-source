import { Container, Graphics } from "pixi.js";

export const PLAYER_BASE_HEIGHT_PX = 42;
export const DEFAULT_PLAYER_DISPLAY_COLOR = 0x38bdf8;

export function playerDisplayColorNumber(value: string | null): number {
  if (!value || !/^#[0-9a-f]{6}$/iu.test(value)) {
    return DEFAULT_PLAYER_DISPLAY_COLOR;
  }
  return Number.parseInt(value.slice(1), 16);
}

export function createProceduralPlayerBody(options: {
  local: boolean;
  color: number;
}): Container {
  const playerSprite = new Container();
  const x = 0;
  const groundY = 0;
  const bodyCenterY = -21;
  const headY = bodyCenterY - 14;
  const neckY = bodyCenterY - 7;
  const hipY = bodyCenterY + 10;
  const footY = bodyCenterY + 21;
  const armY = bodyCenterY;
  const fillColor = options.local ? 0xf8fafc : 0xe0f2fe;
  const accentColor = options.color;

  const halo = new Graphics()
    .circle(x, bodyCenterY, 20)
    .fill({ color: accentColor, alpha: options.local ? 0.22 : 0.18 })
    .stroke({ color: accentColor, width: 1.4, alpha: 0.58 });

  const outline = new Graphics()
    .moveTo(x, headY)
    .circle(x, headY, 7.2)
    .moveTo(x, neckY)
    .lineTo(x, hipY)
    .moveTo(x - 12, armY)
    .lineTo(x + 12, armY)
    .moveTo(x, hipY)
    .lineTo(x - 9, footY)
    .moveTo(x, hipY)
    .lineTo(x + 9, footY)
    .stroke({ color: 0x020617, width: 5, alpha: 0.95 });

  const shirt = new Graphics()
    .poly([
      x - 5.8, neckY + 1,
      x + 5.8, neckY + 1,
      x + 6.8, hipY - 1.5,
      x - 6.8, hipY - 1.5
    ], true)
    .fill({ color: accentColor, alpha: 0.95 })
    .stroke({ color: 0x020617, width: 1.1, alpha: 0.82 });

  const body = new Graphics()
    .circle(x, headY, 6)
    .fill({ color: fillColor })
    .stroke({ color: accentColor, width: 1.8, alpha: 0.98 })
    .moveTo(x, neckY)
    .lineTo(x, hipY)
    .moveTo(x - 11, armY)
    .lineTo(x + 11, armY)
    .moveTo(x, hipY)
    .lineTo(x - 8, footY)
    .moveTo(x, hipY)
    .lineTo(x + 8, footY)
    .stroke({ color: fillColor, width: 3, alpha: 1 });

  const colorSpots = new Graphics()
    .circle(x - 11, armY, 2.4)
    .circle(x + 11, armY, 2.4)
    .circle(x - 8, footY, 2.4)
    .circle(x + 8, footY, 2.4)
    .circle(x, neckY + 9, 2.6)
    .fill({ color: accentColor, alpha: 0.98 })
    .stroke({ color: 0x020617, width: 0.9, alpha: 0.82 });

  const accent = new Graphics()
    .moveTo(x - 7, armY)
    .lineTo(x + 7, armY)
    .moveTo(x, neckY + 1)
    .lineTo(x, hipY - 1)
    .stroke({ color: accentColor, width: 2.03, alpha: 0.98 });

  playerSprite.addChild(halo, outline, shirt, body, colorSpots, accent);
  if (options.local) {
    playerSprite.addChild(new Graphics()
      .circle(x, groundY, 5)
      .fill({ color: 0x020617, alpha: 0.98 })
      .circle(x, groundY, 3.2)
      .fill({ color: 0xfacc15, alpha: 1 })
      .circle(x, groundY, 1.2)
      .fill({ color: 0xffffff, alpha: 1 }));
  }
  return playerSprite;
}
