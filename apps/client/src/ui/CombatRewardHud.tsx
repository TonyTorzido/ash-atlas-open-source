import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { CombatPresentationController } from "../combat/combatPresentation.js";
import { floatingFeedbackFamily } from "../combat/damageFloaters.js";
import { buildLootFeedRows, lootFeedRowPresentation, type LootFeedRow } from "../combat/lootFeed.js";
import { playLootHaptic } from "../combat/combatFeedback.js";
import { isPillRarity, lootGoldHold, lootPillAlpha, type LootLaunch, type LootPill } from "../combat/lootFly.js";
import { lootItemName } from "../combat/lootItemLookup.js";
import { itemArtworkSource, itemArtworkStyle } from "./ItemArtwork.js";
import { LootFlyRunner, type LootFlyTargets } from "./lootFlyRunner.js";

type Props = {
  controller: CombatPresentationController;
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function reducedMotionPreferred(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function CoinGlyph(): React.JSX.Element {
  return <svg className="hud-loot-coin" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="6.5" rx="5.5" ry="2.5" />
    <path d="M6.5 6.5v5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-5" />
    <path d="M6.5 11.5v3c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-3" />
  </svg>;
}

/**
 * The loot feed: every reward source (mob drops, harvests, chests, gold, XP) lands here as compact
 * rows in its own HUD lane (see `hudLanes.css`). Floating combat numbers are a separate system.
 */
export function CombatRewardHud({ controller }: Props): React.JSX.Element | null {
  const [, setRevision] = useState(0);
  const [, setFrameTick] = useState(0);
  useEffect(() => controller.subscribe(() => {
    setRevision((revision) => revision + 1);
  }), [controller]);

  const rewards = controller.floatingFeedback.floaters().filter((floater) =>
    floatingFeedbackFamily(floater.kind) === "reward"
  );
  const pillCount = controller.lootFly.pills.active(nowMs()).length;
  const animating = rewards.length + pillCount;
  useEffect(() => {
    if (animating === 0 || typeof requestAnimationFrame !== "function") return;
    let frameId: number | null = null;
    const tick = (): void => {
      const nextNow = nowMs();
      controller.floatingFeedback.prune(nextNow);
      controller.lootFly.pills.prune(nextNow);
      setFrameTick((tick) => tick + 1);
      if (controller.floatingFeedback.floaters().some((floater) =>
        floatingFeedbackFamily(floater.kind) === "reward"
      ) || controller.lootFly.pills.active(nextNow).length > 0) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [controller, animating]);

  const frameNowMs = nowMs();
  const rows = buildLootFeedRows(rewards, frameNowMs, lootItemName);
  const pills = controller.lootFly.pills.active(frameNowMs);
  const reducedMotion = reducedMotionPreferred();
  return <>
    <LootFlyLayer controller={controller} />
    <LootPillStack pills={pills} nowMs={frameNowMs} />
    {rows.length === 0 ? null : <div
      className="hud-loot-feed"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Loot and experience"
      data-combat-reward-count={rows.length}
    >
      <LootFeedRows rows={rows} nowMs={frameNowMs} reducedMotion={reducedMotion} />
    </div>}
  </>;
}

/**
 * Rare and better drops: one compact parchment pill each, bottom-left above the left quick slots.
 * Same-item drops inside a second merge into one pill; pills never take pointer input.
 */
export function LootPillStack({ pills, nowMs: now }: Readonly<{
  pills: readonly LootPill[];
  nowMs: number;
}>): React.JSX.Element | null {
  if (pills.length === 0) return null;
  return <div className="hud-loot-pills" role="log" aria-live="polite" aria-label="Rare finds">
    {pills.map((pill) => <div
      key={pill.key}
      className="hud-loot-pill"
      data-rarity={pill.rarity}
      data-loot-pill-key={pill.key}
      style={{ opacity: lootPillAlpha(pill, now) }}
    >
      <span className="hud-loot-pill-dot" aria-hidden="true" />
      <span className="hud-loot-pill-name">{pill.name}{pill.quantity > 1 ? ` ×${pill.quantity.toLocaleString()}` : ""}</span>
    </div>)}
  </div>;
}

/** Locates the HUD pieces that react when loot reaches the player (gold counter, carry readout). */
export function findLootFlyTargets(root: ParentNode = document): LootFlyTargets {
  const visible = (element: HTMLElement | null): HTMLElement | null =>
    element && element.getClientRects().length > 0 ? element : null;
  return {
    gold: visible(root.querySelector<HTMLElement>(".phone-economy-gold")),
    // The backpack / carry readout just left of the gold counter (shows free weight in kg).
    item: visible(root.querySelector<HTMLElement>(".phone-economy-storage"))
      ?? visible(root.querySelector<HTMLElement>(".phone-menu-trigger"))
  };
}

/** 36px on a phone, 40px on desktop. */
function lootFlyIconPx(): number {
  const root = document.documentElement;
  return root.dataset.uiProfile === "phone" && root.dataset.presentation !== "desktop" ? 36 : 40;
}

function createLootIcon(launch: LootLaunch): HTMLElement {
  // Gold uses the same coin art as the rest of the game; items use their own art.
  const artId = launch.kind === "gold" || !launch.itemId ? "gold" : launch.itemId;
  const image = document.createElement("img");
  image.src = itemArtworkSource(artId);
  image.alt = "";
  image.draggable = false;
  // Rare and better: a soft glow in the rarity colour on the art itself.
  if (isPillRarity(launch.rarity)) image.style.filter = `drop-shadow(0 0 5px var(--aa-item-rarity-${launch.rarity}))`;
  return image;
}

/** The icon layer: owns a fixed, click-through div and a runner that drains the controller's queue. */
function LootFlyLayer({ controller }: Readonly<{ controller: CombatPresentationController }>): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const runner = new LootFlyRunner({
      layer,
      createIcon: createLootIcon,
      findTargets: () => findLootFlyTargets(),
      pulseKind: (launch) => launch.kind === "gold" ? "pulse" : "bob",
      iconPx: lootFlyIconPx,
      playerPoint: () => controller.playerScreenPoint(),
      onArrive: () => playLootHaptic(),
      origin: () => controller.playerScreenPoint() ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.45 },
      reducedMotion: reducedMotionPreferred,
      goldHold: lootGoldHold
    });
    const drain = (): void => runner.launch(controller.lootFly.takeLaunches(runner.activeCount(), nowMs()));
    drain();
    const unsubscribe = controller.subscribe(drain);
    layer.addEventListener("loot-fly-landed", drain);
    return () => {
      unsubscribe();
      layer.removeEventListener("loot-fly-landed", drain);
      runner.dispose();
    };
  }, [controller]);
  return <div ref={layerRef} className="hud-loot-fly" aria-hidden="true" />;
}

/** The feed rows themselves; the UI Standards gallery renders the same component with sample rows. */
export function LootFeedRows({ rows, nowMs: now, reducedMotion }: Readonly<{
  rows: readonly LootFeedRow[];
  nowMs: number;
  reducedMotion: boolean;
}>): React.JSX.Element {
  return <>
    {rows.map((row) => {
      const motion = lootFeedRowPresentation(row, now, reducedMotion);
      const style: CSSProperties = {
        opacity: motion.alpha,
        transform: motion.slidePx === 0 ? undefined : `translateX(${motion.slidePx}px)`
      };
      return <div
        key={row.key}
        className={`hud-loot-row hud-loot-row-${row.kind}`}
        data-combat-reward-event-id={row.key}
        style={style}
      >
        {row.kind === "gold" ? <CoinGlyph /> : null}
        {row.icon ? <img
          className="hud-loot-icon item-artwork"
          style={itemArtworkStyle(row.icon)}
          src={itemArtworkSource(row.icon)}
          alt=""
          aria-hidden="true"
          draggable={false}
        /> : null}
        <span className="hud-loot-text">{row.text}</span>
      </div>;
    })}
  </>;
}
