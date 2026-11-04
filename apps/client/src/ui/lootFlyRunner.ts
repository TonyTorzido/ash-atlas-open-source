import {
  LOOT_BURST_REBOUND_PX, LOOT_BURST_RISE_PX, LOOT_MAGNET_END_SCALE, lootBurstPoint, lootCountStackOffset,
  lootLaunchLabel, lootMagnetEase, type LootGoldHold, type LootLaunch
} from "../combat/lootFly.js";

/** Burst (arc + one ground rebound), hang on the ground, then the magnet pull. */
export const LOOT_POP_MS = 310;
export const LOOT_HANG_MS = 200;
export const LOOT_MAGNET_MS = 240;
const STAGGER_MS = 60;
const PULSE_MS = 300;
const COUNT_MS = 900;
const COUNT_RISE_PX = 20;
const COUNT_ABOVE_HEAD_PX = 44;

export type LootFlyPoint = Readonly<{ x: number; y: number }>;
export type LootFlyTargets = Readonly<{ gold: HTMLElement | null; item: HTMLElement | null }>;

export type LootFlyRunnerOptions = Readonly<{
  layer: HTMLElement;
  /** Builds the icon node for a drop (item art or the coin). */
  createIcon(launch: LootLaunch): HTMLElement;
  /** HUD pieces that react when a drop reaches the player (gold counter, carry readout). */
  findTargets(): LootFlyTargets;
  /** Fallback source position when a drop has none. */
  origin(): LootFlyPoint;
  /** The player's live screen position, read once per frame; null when unknown. */
  playerPoint(): LootFlyPoint | null;
  /** Icon edge in CSS px (36 on phone, 40 on desktop). */
  iconPx(): number;
  reducedMotion(): boolean;
  /** "pulse" scales the target; "bob" scales and hops it (carry readout, where the number is weight). */
  pulseKind?(launch: LootLaunch): "pulse" | "bob";
  /** Called on every arrival (haptic tick). */
  onArrive?(launch: LootLaunch): void;
  goldHold: LootGoldHold;
  /** Test seam; defaults to Math.random. */
  random?(): number;
  /** Test seam; defaults to performance.now. */
  now?(): number;
}>;

/** Quick scale-up-and-back on the HUD target a drop paid into. Transform only. */
export function pulseTarget(element: HTMLElement | null, kind: "pulse" | "bob" = "pulse"): void {
  element?.animate?.(kind === "bob"
    ? [
      { transform: "translateY(0) scale(1)" },
      { transform: "translateY(-4px) scale(1.25)", offset: 0.35 },
      { transform: "translateY(1px) scale(1.1)", offset: 0.65 },
      { transform: "translateY(0) scale(1)" }
    ]
    : [{ transform: "scale(1)" }, { transform: "scale(1.25)", offset: 0.4 }, { transform: "scale(1)" }],
  { duration: PULSE_MS, easing: "ease-out" });
}

type Magnet = {
  icon: HTMLElement;
  launch: LootLaunch;
  from: LootFlyPoint;
  startedAtMs: number;
};

const translate = (point: LootFlyPoint, half: number, scale: number): string =>
  `translate3d(${(point.x - half).toFixed(1)}px, ${(point.y - half).toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;

/**
 * Runs the loot of one HUD: icons burst from their source with a WAAPI arc, hang, then a single
 * requestAnimationFrame loop pulls every magnetised icon into the player's live position (so a
 * moving player or camera never detaches them). Arrival lifts the gold hold, pulses the HUD target,
 * ticks the haptic and floats a "+N" off the player. Transform and opacity only.
 */
export class LootFlyRunner {
  private active = 0;
  private readonly magnets: Magnet[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly landings: number[] = [];
  private frameId: number | null = null;
  private disposed = false;

  constructor(private readonly options: LootFlyRunnerOptions) {}

  activeCount(): number {
    return this.active;
  }

  private now(): number {
    return this.options.now ? this.options.now() : performance.now();
  }

  launch(launches: readonly LootLaunch[]): void {
    if (launches.length === 0 || this.disposed) return;
    const reduced = this.options.reducedMotion() || typeof this.options.layer.animate !== "function";
    launches.forEach((launch, index) => {
      if (reduced) {
        this.arrive(launch);
        return;
      }
      this.burst(launch, index, launches.length);
    });
  }

  private burst(launch: LootLaunch, index: number, count: number): void {
    const { layer } = this.options;
    const random = this.options.random ?? Math.random;
    const origin = launch.origin ?? this.options.origin();
    const px = this.options.iconPx();
    const half = px / 2;
    const landing = lootBurstPoint(origin, index, count, random);
    const peak: LootFlyPoint = {
      x: origin.x + (landing.x - origin.x) * 0.45,
      y: Math.min(origin.y, landing.y) - LOOT_BURST_RISE_PX
    };
    const icon = document.createElement("div");
    icon.className = "loot-fly-icon";
    icon.style.width = icon.style.height = `${px}px`;
    icon.append(this.options.createIcon(launch));
    layer.append(icon);
    this.active += 1;

    const frame = (point: LootFlyPoint, scale: number, opacity: number, offset: number, easing: string): Keyframe =>
      ({ offset, opacity, easing, transform: translate(point, half, scale) });
    const bounce: LootFlyPoint = { x: landing.x, y: landing.y - LOOT_BURST_REBOUND_PX };
    const pop = icon.animate([
      frame(origin, 0.5, 0, 0, "ease-out"),
      frame(peak, 1, 1, 0.42, "ease-in"),
      frame(landing, 1, 1, 0.72, "ease-out"),
      frame(bounce, 1, 1, 0.86, "ease-in"),
      frame(landing, 1, 1, 1, "linear")
    ], { duration: LOOT_POP_MS, delay: index * STAGGER_MS, fill: "both", easing: "ease-out" });

    const startMagnet = (): void => {
      if (this.disposed) return;
      // Hand the final pose to inline style before dropping the animation, so nothing flickers.
      icon.style.opacity = "1";
      icon.style.transform = translate(landing, half, 1);
      this.magnets.push({ icon, launch, from: landing, startedAtMs: this.now() });
      pop.cancel();
      this.ensureLoop();
    };
    pop.addEventListener("finish", () => this.later(startMagnet, LOOT_HANG_MS), { once: true });
    pop.addEventListener("cancel", () => {
      if (!this.magnets.some((magnet) => magnet.icon === icon) && icon.isConnected) {
        icon.remove();
        this.active = Math.max(0, this.active - 1);
        this.options.goldHold.release(launch.holdIds);
      }
    }, { once: true });
  }

  private later(callback: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
  }

  private ensureLoop(): void {
    if (this.frameId !== null || typeof requestAnimationFrame !== "function") return;
    this.frameId = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.frameId = null;
    if (this.disposed) return;
    const now = this.now();
    const half = this.options.iconPx() / 2;
    const player = this.options.playerPoint() ?? this.options.origin();
    for (let index = this.magnets.length - 1; index >= 0; index -= 1) {
      const magnet = this.magnets[index]!;
      const t = Math.min(1, (now - magnet.startedAtMs) / LOOT_MAGNET_MS);
      const eased = lootMagnetEase(t);
      const point: LootFlyPoint = {
        x: magnet.from.x + (player.x - magnet.from.x) * eased,
        y: magnet.from.y + (player.y - magnet.from.y) * eased
      };
      magnet.icon.style.transform = translate(point, half, 1 + (LOOT_MAGNET_END_SCALE - 1) * eased);
      if (t >= 1) {
        this.magnets.splice(index, 1);
        magnet.icon.remove();
        this.active = Math.max(0, this.active - 1);
        this.arrive(magnet.launch);
        this.options.layer.dispatchEvent(new CustomEvent("loot-fly-landed"));
      }
    }
    if (this.magnets.length > 0) this.ensureLoop();
  };

  /** Arrival at the player: HUD reacts, haptic ticks, "+N" floats off the player's head. */
  private arrive(launch: LootLaunch): void {
    const targets = this.options.findTargets();
    this.options.goldHold.release(launch.holdIds);
    pulseTarget(launch.kind === "gold" ? targets.gold : targets.item, this.options.pulseKind?.(launch) ?? "pulse");
    this.options.onArrive?.(launch);
    this.showCount(launch);
  }

  private showCount(launch: LootLaunch): void {
    const { layer } = this.options;
    const player = this.options.playerPoint() ?? this.options.origin();
    const now = this.now();
    const lift = lootCountStackOffset(this.landings, now);
    this.landings.push(now);
    while (this.landings.length > 12) this.landings.shift();
    const label = document.createElement("span");
    label.className = `loot-fly-count${launch.kind === "gold" ? " is-gold" : ""}`;
    label.textContent = lootLaunchLabel(launch);
    layer.append(label);
    const x = player.x;
    const y = player.y - COUNT_ABOVE_HEAD_PX - lift;
    const at = (dy: number): string => `translate3d(calc(${x.toFixed(1)}px - 50%), ${(y - dy).toFixed(1)}px, 0)`;
    const animation = label.animate?.([
      { offset: 0, opacity: 0, transform: at(0) },
      { offset: 0.12, opacity: 1, transform: at(3) },
      { offset: 0.7, opacity: 1, transform: at(COUNT_RISE_PX * 0.85) },
      { offset: 1, opacity: 0, transform: at(COUNT_RISE_PX) }
    ], { duration: COUNT_MS, fill: "both", easing: "ease-out" });
    if (!animation) {
      label.remove();
      return;
    }
    animation.addEventListener("finish", () => label.remove(), { once: true });
    animation.addEventListener("cancel", () => label.remove(), { once: true });
  }

  /** Cancels everything in flight; held gold is released so the counter never sticks low. */
  dispose(): void {
    this.disposed = true;
    if (this.frameId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frameId);
    this.frameId = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const magnet of this.magnets) this.options.goldHold.release(magnet.launch.holdIds);
    this.magnets.length = 0;
    for (const animation of this.options.layer.getAnimations?.({ subtree: true }) ?? []) animation.cancel();
  }
}
