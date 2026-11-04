import {
  DEFAULT_PLAYER_DISPLAY_COLOR,
  PLAYER_BASE_HEIGHT_PX,
  createProceduralPlayerBody,
  playerDisplayColorNumber
} from "@ash-atlas/player-renderer";
import { Assets, Container, Sprite, type Texture } from "pixi.js";

import raftUrl from "../assets/water/raft.png";
import { PLAYER_RAFT_PRESENTATION } from "./raftPresentation.js";

export {
  DEFAULT_PLAYER_DISPLAY_COLOR,
  PLAYER_BASE_HEIGHT_PX,
  playerDisplayColorNumber
};

export function createPlayerSprite(
  x: number,
  y: number,
  heightPx: number,
  options: { local: boolean; color: number; groundAtPosition?: boolean }
): Container {
  const root = new Container();
  const body = createProceduralPlayerBody({
    local: options.local,
    color: options.color
  });
  const scale = heightPx / PLAYER_BASE_HEIGHT_PX;
  body.scale.set(scale);
  body.position.set(
    x,
    options.groundAtPosition === false ? y + 21 * scale : y
  );
  root.addChild(body);
  return root;
}

export { PLAYER_RAFT_PRESENTATION };

let raftTexture: Texture | null = null;
let raftTextureState: "idle" | "loading" | "ready" | "failed" = "idle";

function requestRaftTexture(
  load: (url: string) => Promise<Texture>,
  url: string
): void {
  if (raftTextureState !== "idle") return;
  raftTextureState = "loading";
  void load(url).then((texture) => {
    raftTexture = texture;
    raftTextureState = "ready";
  }, (error: unknown) => {
    // No fallback shape: an afloat player without art shows nothing extra.
    raftTextureState = "failed";
    console.warn("Raft texture could not be loaded.", { url, error });
  });
}

export type PlayerRaftFrame = Readonly<{
  afloat: boolean;
  bodyHeightPx: number;
  nowMs: number;
  reducedMotion: boolean;
}>;

/** One per rendered player; add `root` behind the body artwork. */
export class PlayerRaft {
  readonly root = new Container();
  private sprite: Sprite | null = null;

  constructor(
    private readonly load: (url: string) => Promise<Texture> = (url) => Assets.load<Texture>({ src: url }),
    private readonly url: string = raftUrl
  ) {
    this.root.visible = false;
    this.root.eventMode = "none";
  }

  update(frame: PlayerRaftFrame): void {
    if (!frame.afloat || !(frame.bodyHeightPx > 0)) {
      this.root.visible = false;
      return;
    }
    if (!this.sprite) {
      requestRaftTexture(this.load, this.url);
      if (!raftTexture) {
        this.root.visible = false;
        return;
      }
      this.sprite = new Sprite(raftTexture);
      this.sprite.anchor.set(PLAYER_RAFT_PRESENTATION.anchorX, PLAYER_RAFT_PRESENTATION.anchorY);
      this.root.addChild(this.sprite);
    }
    const presentation = PLAYER_RAFT_PRESENTATION;
    const widthPx = frame.bodyHeightPx * presentation.bodyWidthToHeight * presentation.widthToBodyWidth;
    this.sprite.scale.set(widthPx / (this.sprite.texture.width || presentation.canvasWidthPx));
    this.sprite.y = frame.reducedMotion
      ? 0
      : Math.sin(frame.nowMs * 2 * Math.PI / presentation.bobPeriodMs) * presentation.bobAmplitudePx;
    this.root.visible = true;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.sprite = null;
  }
}

/** Test seam: forget the shared texture so a fresh load can be observed. */
export function resetPlayerRaftTextureForTests(): void {
  raftTexture = null;
  raftTextureState = "idle";
}
