import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  bossOverallScale,
  requireBossAppearance,
  resolveBossWeaponTransform,
  type BossAppearanceCatalog,
  type BossAppearanceId,
  type PlayerCombatPoseId
} from "@ash-atlas/shared";
import { Container, Sprite } from "pixi.js";

import type { PlayerTextureLoader } from "./renderer.js";

export type BossRendererOptions = {
  bossId: BossAppearanceId;
  catalog?: BossAppearanceCatalog;
  textureLoader: PlayerTextureLoader;
  diagnostic?: (
    message: string,
    detail: Readonly<{ assetKey: string; bossId: BossAppearanceId; error?: unknown }>
  ) => void;
};

export class BossRenderer {
  readonly root = new Container();
  readonly visualRoot = new Container();
  readonly body = new Sprite();
  readonly weapon = new Sprite();
  private catalog: BossAppearanceCatalog;
  private readonly bossId: BossAppearanceId;
  private readonly textureLoader: PlayerTextureLoader;
  private readonly diagnostic: NonNullable<BossRendererOptions["diagnostic"]>;
  private currentPose: PlayerCombatPoseId = "idle";
  private bodyAssetKey = "";
  private weaponAssetKey: string | null = null;
  private updateGeneration = 0;

  constructor(options: BossRendererOptions) {
    this.catalog = options.catalog ?? DEFAULT_BOSS_APPEARANCE_CATALOG;
    this.bossId = options.bossId;
    this.textureLoader = options.textureLoader;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.body.visible = false;
    this.weapon.visible = false;
    this.visualRoot.addChild(this.body, this.weapon);
    this.root.addChild(this.visualRoot);
    this.visualRoot.scale.set(this.overallScale);
    void this.refreshAssets();
  }

  get baseHeightPx(): number {
    return requireBossAppearance(this.catalog, this.bossId).presentation.baseHeightPx;
  }

  get overallScale(): number {
    return bossOverallScale(this.catalog, this.bossId);
  }

  setCatalog(catalog: BossAppearanceCatalog): void {
    this.catalog = catalog;
    this.visualRoot.scale.set(this.overallScale);
    void this.refreshAssets();
  }

  setPose(poseId: PlayerCombatPoseId): boolean {
    if (poseId === this.currentPose) return false;
    this.currentPose = poseId;
    this.applyWeaponTransform();
    return true;
  }

  destroy(): void {
    this.updateGeneration += 1;
    this.root.destroy({ children: true });
  }

  private async refreshAssets(): Promise<void> {
    const generation = ++this.updateGeneration;
    const boss = requireBossAppearance(this.catalog, this.bossId);
    const bodyChanged = this.bodyAssetKey !== boss.bodyAssetKey;
    const weaponChanged = this.weaponAssetKey !== boss.weapon.assetKey;
    this.bodyAssetKey = boss.bodyAssetKey;
    this.weaponAssetKey = boss.weapon.assetKey;

    if (bodyChanged || !this.body.visible) {
      try {
        const texture = await this.textureLoader.load(boss.bodyAssetKey);
        if (generation !== this.updateGeneration) return;
        this.body.texture = texture;
        this.body.anchor.set(boss.presentation.anchorX, boss.presentation.anchorY);
        this.body.scale.set(
          boss.presentation.baseHeightPx / (texture.height || boss.presentation.baseHeightPx)
        );
        this.body.visible = true;
      } catch (error) {
        if (generation !== this.updateGeneration) return;
        this.body.visible = false;
        this.diagnostic("Boss body texture could not be loaded.", {
          assetKey: boss.bodyAssetKey,
          bossId: boss.bossId,
          error
        });
      }
    }

    if (!boss.weapon.assetKey) {
      this.weapon.visible = false;
      this.applyWeaponTransform();
      return;
    }
    if (weaponChanged || !this.weapon.visible) {
      try {
        const texture = await this.textureLoader.load(boss.weapon.assetKey);
        if (generation !== this.updateGeneration) return;
        this.weapon.texture = texture;
      } catch (error) {
        if (generation !== this.updateGeneration) return;
        this.weapon.visible = false;
        this.diagnostic("Boss weapon texture could not be loaded.", {
          assetKey: boss.weapon.assetKey,
          bossId: boss.bossId,
          error
        });
        return;
      }
    }
    this.applyWeaponTransform();
  }

  private applyWeaponTransform(): void {
    const boss = requireBossAppearance(this.catalog, this.bossId);
    const transform = resolveBossWeaponTransform(
      this.catalog,
      this.bossId,
      this.currentPose
    );
    this.weapon.position.set(transform.offsetX, transform.offsetY);
    this.weapon.rotation = transform.rotationDegrees * Math.PI / 180;
    this.weapon.scale.set(transform.scaleX, transform.scaleY);
    this.weapon.anchor.set(transform.pivotX, transform.pivotY);
    this.weapon.visible = Boolean(boss.weapon.assetKey) && transform.visible;
  }
}
