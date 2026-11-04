export type CameraCenterTrigger =
  | "recenter"
  | "visit-flag"
  | "visit-city"
  | "fishing-cast"
  | "dev-teleport"
  | "player-update"
  | "map-interaction";

export function shouldCenterCamera(trigger: CameraCenterTrigger): boolean {
  return trigger === "recenter" || trigger === "visit-flag" || trigger === "visit-city" || trigger === "fishing-cast" || trigger === "dev-teleport";
}

/** MapLibre offset that places a cast point around one-third down the viewport. */
export function fishingCastCameraOffset(usableHeight: number): [number, number] {
  return [0, -Math.max(1, Math.round(Math.max(1, usableHeight) / 6))];
}

export type FishingCastCameraRequest = Readonly<{
  key: string;
  width: number;
  height: number;
  profile: string;
}>;

/** Keep one accepted cast anchored until its cast point or viewport materially changes. */
export function shouldRequestFishingCastCamera(
  previous: FishingCastCameraRequest | null,
  next: FishingCastCameraRequest
): boolean {
  if (!previous) return true;
  return previous.key !== next.key
    || previous.profile !== next.profile
    || Math.abs(previous.width - next.width) >= 80
    || Math.abs(previous.height - next.height) >= 80;
}
