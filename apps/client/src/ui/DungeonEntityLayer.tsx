import { type CombatEntitySnapshot, type DungeonPlayerSnapshot } from "@ash-atlas/shared";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { CombatPresentationController } from "../combat/combatPresentation.js";
import { DungeonMovementTimeline } from "../movement/dungeonMovementTimeline.js";
import { useIndoorPresentationClock } from "./IndoorPresentationClock.js";
import { IndoorPlayerLayer, type IndoorPositionSource } from "./IndoorPlayerLayer.js";

export function DungeonEntityLayer({
  player, occupants, displayColor, sessionId, spaceId, serverTime,
  roomWidth, roomHeight, playerVisualHeight, combatEntities = [], combatPresentation, ariaLabel
}: {
  player: DungeonPlayerSnapshot;
  occupants: readonly DungeonPlayerSnapshot[];
  displayColor: string | null;
  sessionId: string;
  spaceId: string;
  serverTime: number;
  roomWidth: number;
  roomHeight: number;
  playerVisualHeight: number;
  combatEntities?: readonly CombatEntitySnapshot[];
  combatPresentation?: CombatPresentationController;
  ariaLabel?: string;
}): React.JSX.Element {
  const presentationNow = useIndoorPresentationClock();
  const timelineRef = useRef(new DungeonMovementTimeline());
  const runId = `${sessionId}:${spaceId}`;
  useLayoutEffect(() => {
    const now = presentationNow();
    if (timelineRef.current.currentRunId() !== runId) {
      timelineRef.current.start(runId, player, serverTime, now);
    } else {
      timelineRef.current.applySnapshot(runId, player, serverTime, now);
    }
  }, [player, runId, serverTime, presentationNow]);
  const positionSourceRef = useRef<IndoorPositionSource>({
    render: (renderNow) => timelineRef.current.render(renderNow)
  });
  useEffect(() => () => timelineRef.current.clear(), []);
  const combatById = new Map(combatEntities.map((entity) => [entity.entityId, entity]));
  const poseFor = combatPresentation
    ? (playerId: string, nowMs: number) => combatPresentation.poseFor(
      playerId,
      combatById.get(playerId) ?? null,
      nowMs
    )
    : undefined;

  return <IndoorPlayerLayer
    roomWidth={roomWidth}
    roomHeight={roomHeight}
    playerVisualHeightUnits={playerVisualHeight}
    positionSource={positionSourceRef.current}
    displayColor={displayColor}
    localPlayerId={player.playerId}
    {...(poseFor ? { poseFor } : {})}
    {...(player.appearance ? { appearance: player.appearance } : {})}
    remoteActors={occupants
      .filter((occupant) => occupant.playerId !== player.playerId)
      .map((occupant) => ({
        playerId: occupant.playerId,
        x: occupant.x,
        y: occupant.y,
        displayColor: occupant.displayColor,
        ...(occupant.appearance ? { appearance: occupant.appearance } : {})
      }))}
    className="dungeon-entity-layer"
    canvasClassName="dungeon-entity-canvas"
    ariaLabel={ariaLabel ?? `${player.name} and dungeon occupants`}
  />;
}
