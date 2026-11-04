import {
  MANOR_PLAYER_VISUAL_HEIGHT_UNITS,
  type IndoorRoomNavigation,
  type ManorOccupantPresenceSnapshot,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";

import type { ManorMovementTimeline } from "../movement/manorMovementTimeline.js";
import {
  IndoorPlayerLayer,
  indoorPlayerLayerDebugSnapshot
} from "./IndoorPlayerLayer.js";

export const manorPlayerLayerDebugSnapshot = indoorPlayerLayerDebugSnapshot;

export function ManorPlayerLayer({ room, timeline, displayColor, appearance, occupants = [] }: {
  room: Pick<IndoorRoomNavigation, "roomWidth" | "roomHeight">;
  timeline: ManorMovementTimeline;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot | undefined;
  occupants?: readonly ManorOccupantPresenceSnapshot[];
}): React.JSX.Element {
  return <IndoorPlayerLayer
    roomWidth={room.roomWidth}
    roomHeight={room.roomHeight}
    playerVisualHeightUnits={MANOR_PLAYER_VISUAL_HEIGHT_UNITS}
    positionSource={timeline}
    displayColor={displayColor}
    {...(appearance ? { appearance } : {})}
    remoteActors={occupants.map((occupant) => ({
      playerId: occupant.playerId,
      x: occupant.position.x,
      y: occupant.position.y,
      displayColor: occupant.displayColor,
      ...(occupant.appearance ? { appearance: occupant.appearance } : {})
    }))}
    className="manor-player-layer"
    canvasClassName="manor-player-canvas"
    ariaLabel="Manor occupants"
  />;
}
