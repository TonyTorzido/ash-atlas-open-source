type AnimationFrameScheduler = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;

export function paintSynchronizedOverlayFrame(update: () => void, paint: () => void): void {
  update();
  paint();
}

export function paintMapSynchronizedOverlayFrame(
  updateStaticTransform: () => void,
  reprojectDynamicEntities: () => void,
  paint: () => void
): void {
  updateStaticTransform();
  reprojectDynamicEntities();
  paint();
}

export type AnimationFrameLoop = {
  setActive(active: boolean): void;
  isActive(): boolean;
  restart(): void;
  stop(): void;
};

export function createAnimationFrameLoop(
  drawFrame: (frameTimeMs?: number) => void,
  scheduler: AnimationFrameScheduler = window
): AnimationFrameLoop {
  let active = true;
  let stopped = false;
  let animationFrameId: number | null = null;
  let generation = 0;
  const schedule = (): void => {
    if (!active || stopped || animationFrameId !== null) return;
    const scheduledGeneration = generation;
    animationFrameId = scheduler.requestAnimationFrame((frameTimeMs?: number) => runFrame(scheduledGeneration, frameTimeMs));
  };
  const runFrame = (scheduledGeneration: number, frameTimeMs?: number): void => {
    if (scheduledGeneration !== generation) return;
    animationFrameId = null;
    if (!active || stopped) return;
    drawFrame(frameTimeMs);
    schedule();
  };
  schedule();
  return {
    setActive(nextActive): void {
      if (stopped || active === nextActive) return;
      active = nextActive;
      generation += 1;
      if (!active && animationFrameId !== null) {
        scheduler.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      schedule();
    },
    isActive: () => active && !stopped,
    restart(): void {
      if (stopped || !active) return;
      generation += 1;
      if (animationFrameId !== null) scheduler.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
      schedule();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      active = false;
      generation += 1;
      if (animationFrameId !== null) scheduler.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  };
}

export function startAnimationFrameLoop(
  drawFrame: () => void,
  scheduler: AnimationFrameScheduler = window
): () => void {
  const loop = createAnimationFrameLoop(drawFrame, scheduler);
  return () => loop.stop();
}
