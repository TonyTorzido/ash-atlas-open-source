import { Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type { TerritoryStructureVisual } from "@ash-atlas/shared";

/** The game and Studio call this same compositor; all artwork/state pieces share one root. */
export function createTerritoryStructureRoot(
  visual: TerritoryStructureVisual,
  textureFor: (asset: string) => Texture,
  state: { controlColor: number; burning?: boolean; emblem?: string; resolution?: number }
): Container {
  const root = new Container();
  root.label = visual.id;
  root.position.set(visual.root.offsetX, visual.root.offsetY);
  root.scale.set(visual.root.scale);
  root.sortableChildren = true;
  root.eventMode = "none";
  for (const piece of visual.pieces) {
    const texture = textureFor(piece.asset);
    texture.source.scaleMode = "linear";
    const sprite = new Sprite(texture);
    sprite.label = piece.id;
    sprite.anchor.set(piece.anchorX, piece.anchorY);
    sprite.position.set(piece.offsetX, piece.offsetY);
    sprite.width = piece.width * piece.scale;
    sprite.height = piece.height * piece.scale;
    sprite.visible = piece.visible;
    sprite.zIndex = piece.zIndex;
    if (piece.tint === "control") sprite.tint = state.controlColor;
    if (piece.tint === "fixed") sprite.tint = Number.parseInt(piece.tintColor.slice(1), 16);
    root.addChild(sprite);
  }
  if (state.burning) {
    const attachment = visual.attachments.burning;
    const burning = new Graphics()
      .poly([-8, -30, -3, -40, 0, -33, 5, -43, 9, -30, 5, -24, -4, -24])
      .fill({ color: 0xff6b00, alpha: 0.95 })
      .stroke({ color: 0xffd166, width: 1.5, alpha: 0.95 });
    burning.label = "burning";
    burning.position.set(attachment.x, attachment.y);
    burning.scale.set(attachment.scale);
    burning.zIndex = attachment.zIndex;
    root.addChild(burning);
  }
  if (state.emblem) {
    const attachment = visual.attachments.emblem;
    const emblem = new Text({
      text: Array.from(state.emblem)[0]?.toUpperCase() ?? "K",
      resolution: state.resolution ?? 2,
      roundPixels: true,
      style: { fill: 0xffffff, fontFamily: "system-ui, sans-serif", fontSize: 10, fontWeight: "800" }
    });
    emblem.label = "emblem";
    emblem.anchor.set(0.5);
    emblem.position.set(attachment.x, attachment.y);
    emblem.scale.set(attachment.scale);
    emblem.zIndex = attachment.zIndex;
    root.addChild(emblem);
  }
  return root;
}
