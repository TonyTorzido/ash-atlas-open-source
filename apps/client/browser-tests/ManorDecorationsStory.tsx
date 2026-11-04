import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  emptyInventoryTotals,
  MANOR_MAIN_ROOM,
  type ClientMessage,
  type ManorPosition,
  type ManorServerMessage
} from "@ash-atlas/shared";
import { StrictMode, useEffect, useRef, useState } from "react";

import type { ClientCommandPort, ClientSendOutcome } from "../src/client/clientCommandPort.js";
import { ManorClient } from "../src/client/domains/manorClient.js";
import { useManorFeature } from "../src/features/manor/useManorFeature.js";
import { defaultHotbarSlots } from "../src/hotbar/hotbarModel.js";
import { Hotbar } from "../src/ui/Hotbar.js";
import { PresentationShell } from "../src/PresentationShell.js";
import { ManorScene } from "../src/ui/ManorScene.js";
import { UiEnvironmentProvider } from "../src/uiEnvironment.js";

const SESSION_ID = "browser-manor-decorations-session";
const PLAYER_ID = "browser-manor-decorations-player";
const START_POSITION: ManorPosition = { x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0 };
function snapshotFor(typeId: string) {
  const template = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === typeId)!;
  return {
    manorId: "browser-manor",
    roomWidth: MANOR_MAIN_ROOM.roomWidth,
    roomHeight: MANOR_MAIN_ROOM.roomHeight,
    definitions: template.decorations.map((definition) => ({ definition, ownedQuantity: 2, availableQuantity: 2 })),
    placements: []
  };
}

class DecorationsPort implements ClientCommandPort {
  constructor(private readonly typeId: string) {}
  onServerMessage: ((message: ManorServerMessage) => void) | null = null;
  onSend: ((message: ClientMessage) => void) | null = null;
  send(message: ClientMessage): ClientSendOutcome {
    this.onSend?.(message);
    if (message.type === "REQUEST_MANOR_DECORATIONS") {
      window.setTimeout(() => this.onServerMessage?.({
        type: "MANOR_DECORATIONS_SNAPSHOT",
        requestId: message.requestId,
        snapshot: snapshotFor(this.typeId)
      }), 0);
    }
    return { status: "sent", readiness: "ready", connectionGeneration: 1 };
  }
}

type StoryProps = { layout?: "desktop" | "phone"; typeId?: string; spaceId?: string };

export function ManorDecorationsStory(props: StoryProps): React.JSX.Element {
  return <StrictMode><UiEnvironmentProvider><PresentationShell><Inner {...props} /></PresentationShell></UiEnvironmentProvider></StrictMode>;
}

function Inner({ layout = "desktop", typeId = "manor_lobby", spaceId = "manor_main_room" }: StoryProps): React.JSX.Element {
  const portRef = useRef<DecorationsPort | null>(null);
  if (!portRef.current) portRef.current = new DecorationsPort(typeId);
  const port = portRef.current;
  const [requests, setRequests] = useState(0);
  const client = useRef(new ManorClient(port)).current;
  const manor = useManorFeature({
    connectionStatus: "online",
    ownPlayerId: PLAYER_ID,
    getCommands: () => client,
    showActionError: () => undefined,
    onEntered: () => undefined,
    onExited: () => undefined,
    onBeforeEnter: () => undefined
  });
  const installedRef = useRef(false);
  useEffect(() => {
    port.onServerMessage = manor.handleServerMessage;
    port.onSend = (message) => {
      if (message.type === "REQUEST_MANOR_DECORATIONS") setRequests((count) => count + 1);
    };
    if (!installedRef.current) {
      installedRef.current = true;
      manor.handleServerMessage({
        type: "MANOR_ENTERED",
        manorId: "browser-manor",
        manorSessionId: SESSION_ID,
        displayColor: "#38bdf8",
        position: START_POSITION,
        movementSequence: 0,
        serverTime: Date.now(),
        spaceId,
        manorTypeId: typeId,
        accessSource: "OWNER",
        storage: null
      });
    }
    return () => { port.onServerMessage = null; port.onSend = null; };
  }, [manor.handleServerMessage, port]);

  return (
    <div>
      <ManorScene
        timeline={manor.refs.movementTimeline.current}
        displayColor="#38bdf8"
        disabled={false}
        movementDisabled={false}
        layout={layout}
        occupants={[]}
        ownPlayerId={PLAYER_ID}
        canKick={false}
        interactionIntent={manor.view.interactionIntent}
        decorations={manor.view.decorations}
        canEditDecorations
        onRequestDecorations={manor.actions.requestManorDecorations}
        onMove={manor.actions.requestMove}
        onInteract={() => undefined}
        onCancelInteraction={manor.actions.cancelInteraction}
        onKick={() => false}
        manorId="browser-manor"
        manorTypeId={typeId}
        spaceId={spaceId}
      />
      <Hotbar
        slots={defaultHotbarSlots()}
        inventory={{ playerId: PLAYER_ID, revision: 0, items: [], totals: emptyInventoryTotals() }}
        inventorySnapshotAvailable
        online
        onSlotsChange={() => undefined}
        onUseConsumable={() => false}
        onFishWithRod={() => false}
      />
      <output data-testid="decoration-requests" style={{ position: "fixed", left: 0, top: 0, zIndex: 100 }}>
        {requests}
      </output>
    </div>
  );
}
