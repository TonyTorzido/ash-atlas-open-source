export type ScreenPoint = Readonly<{ x: number; y: number }>;

export type FlagTravelPlayerMotionPlan = Readonly<{
  captureId: number;
  cameraGeneration: number;
  originScreen: ScreenPoint;
  destinationScreen: ScreenPoint;
  destination: Readonly<{ lat: number; lon: number }>;
  startedAtMs: number;
  durationMs: number;
  easing: (progress: number) => number;
}>;

export function flagTravelPlayerPositionAt(
  plan: FlagTravelPlayerMotionPlan,
  nowMs: number
): ScreenPoint {
  const rawProgress = Math.max(
    0,
    Math.min(1, (nowMs - plan.startedAtMs) / plan.durationMs)
  );
  const progress = plan.easing(rawProgress);
  return {
    x:
      plan.originScreen.x +
      (plan.destinationScreen.x - plan.originScreen.x) * progress,
    y:
      plan.originScreen.y +
      (plan.destinationScreen.y - plan.originScreen.y) * progress
  };
}

export function isCurrentFlagTravelPlayerMotion(
  plan: FlagTravelPlayerMotionPlan,
  cameraGeneration: number | null
): boolean {
  return cameraGeneration !== null &&
    plan.cameraGeneration === cameraGeneration;
}

export function paddedViewportCenter(input: Readonly<{
  width: number;
  height: number;
  padding: Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
  }>;
}>): ScreenPoint {
  return {
    x:
      input.padding.left +
      (input.width - input.padding.left - input.padding.right) / 2,
    y:
      input.padding.top +
      (input.height - input.padding.top - input.padding.bottom) / 2
  };
}
