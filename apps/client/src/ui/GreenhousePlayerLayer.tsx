import {
  GREENHOUSE_ROOM_HEIGHT,
  GREENHOUSE_ROOM_WIDTH,
  STANDARD_INDOOR_SPATIAL_PROFILE,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import { useRef } from "react";

import type { GreenhouseMovementTimeline } from "../movement/greenhouseMovementTimeline.js";
import { IndoorPlayerLayer, type IndoorPositionSource } from "./IndoorPlayerLayer.js";

export function GreenhousePlayerLayer({
  timeline,
  displayColor,
  appearance
}: {
  timeline: GreenhouseMovementTimeline;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
}): React.JSX.Element {
  const positionSourceRef = useRef<IndoorPositionSource>({
    render: (renderNow) => timeline.render(renderNow)
  });

  return <IndoorPlayerLayer
    roomWidth={GREENHOUSE_ROOM_WIDTH}
    roomHeight={GREENHOUSE_ROOM_HEIGHT}
    playerVisualHeightUnits={STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits}
    positionSource={positionSourceRef.current}
    displayColor={displayColor}
    {...(appearance ? { appearance } : {})}
    className="greenhouse-player-layer"
    canvasClassName="greenhouse-player-canvas"
    ariaLabel="Your character"
  />;
}
