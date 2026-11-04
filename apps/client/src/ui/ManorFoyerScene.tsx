import {
  MANOR_FOYER_ROOM,
  portalIds,
  type ManorOccupantPresenceSnapshot,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import { useRef, useState } from "react";

import { useIndoorMovementInput } from "../movement/indoorMovementInput.js";
import type { ManorMovementTimeline } from "../movement/manorMovementTimeline.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { IndoorSceneStage } from "./IndoorSceneStage.js";
import { IndoorSceneViewport } from "./IndoorSceneViewport.js";
import { ManorPlayerLayer } from "./ManorPlayerLayer.js";

export function ManorFoyerScene({
  manorId, timeline, displayColor, appearance, occupants, disabled, movementDisabled, onMove, onUsePortal
}: {
  manorId: string;
  timeline: ManorMovementTimeline;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot | undefined;
  occupants: ManorOccupantPresenceSnapshot[];
  disabled: boolean;
  movementDisabled: boolean;
  onMove(x: number, y: number): void;
  onUsePortal(portalId: string): void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<"outside" | "main" | null>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const movementInput = useIndoorMovementInput({
    stageRef: roomRef,
    roomWidth: MANOR_FOYER_ROOM.roomWidth,
    roomHeight: MANOR_FOYER_ROOM.roomHeight,
    movementDisabled,
    onBeforeMove: () => setSelected(null),
    onMove
  });
  const choose = (kind: "outside" | "main") => (event: React.MouseEvent): void => {
    event.stopPropagation();
    setSelected(kind);
  };
  const useSelected = (): void => {
    if (!selected) return;
    const portalId = selected === "outside"
      ? portalIds.manorFoyerToWorld(manorId)
      : portalIds.manorFoyerToMain(manorId);
    setSelected(null);
    onUsePortal(portalId);
  };
  return <IndoorSceneViewport className="manor-scene manor-foyer-scene" ariaLabel="Manor foyer">
    <IndoorSceneStage
      roomWidth={MANOR_FOYER_ROOM.roomWidth}
      roomHeight={MANOR_FOYER_ROOM.roomHeight}
      innerClassName="manor-room manor-foyer-room"
      frameClassName="manor-stage-wrap"
      stageRef={roomRef}
      onClick={movementInput.onClick}
      onDoubleClick={movementInput.onDoubleClick}
      onPointerDownCapture={movementInput.onPointerDownCapture}
      onPointerMove={movementInput.onPointerMove}
      onPointerUp={movementInput.onPointerUp}
      onPointerCancel={movementInput.onPointerCancel}
      onLostPointerCapture={movementInput.onLostPointerCapture}
    >
      <div className="manor-foyer-title">FOYER</div>
      <button type="button" className="manor-foyer-door exterior" onClick={choose("outside")}>Exterior Door</button>
      <button type="button" className="manor-foyer-door main-hall" onClick={choose("main")}>Main Hall</button>
      <ManorPlayerLayer
        room={MANOR_FOYER_ROOM}
        timeline={timeline}
        displayColor={displayColor}
        appearance={appearance}
        occupants={occupants}
      />
    </IndoorSceneStage>
    {selected ? <GameActionPrompt
      title={selected === "outside" ? "Exterior Door" : "Main Hall Door"}
      category="PORTAL"
      actions={[{
        key: selected === "outside" ? "exit-manor" : "enter-main-hall",
        label: selected === "outside" ? "Exit Manor" : "Enter Main Hall",
        enabled: !disabled,
        disabledReason: disabled ? "The doorway is unavailable while disconnected." : null,
        onSelect: useSelected
      }]}
      onCancel={() => setSelected(null)}
    /> : null}
  </IndoorSceneViewport>;
}
