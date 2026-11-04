import {
  MANOR_MAIN_ROOM,
  type ClientMessage,
  type ManorPosition,
  type ManorServerMessage
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import type {
  ClientCommandPort,
  ClientSendOutcome
} from "../src/client/clientCommandPort.js";
import { ManorClient } from "../src/client/domains/manorClient.js";
import { useManorFeature } from "../src/features/manor/useManorFeature.js";
import { ManorScene } from "../src/ui/ManorScene.js";

const SESSION_ID = "browser-manor-session";
const PLAYER_ID = "browser-manor-player";
const START_POSITION: ManorPosition = {
  x: 500,
  y: 790,
  targetX: null,
  targetY: null,
  moving: false,
  revision: 0
};

class ManorMovementCommandPort implements ClientCommandPort {
  readonly sent: ClientMessage[] = [];
  onServerMessage: ((message: ManorServerMessage) => void) | null = null;
  onSend: ((message: ClientMessage) => void) | null = null;
  private movementSequence = 0;
  private position = { ...START_POSITION };

  send(message: ClientMessage): ClientSendOutcome {
    this.sent.push(message);
    this.onSend?.(message);
    if (message.type === "MANOR_MOVE_TO") {
      if (message.x > MANOR_MAIN_ROOM.roomWidth - 100 || message.y < 100) {
        window.setTimeout(() => this.onServerMessage?.({
          type: "MANOR_ERROR",
          requestId: message.requestId,
          code: "BLOCKED_TARGET",
          message: "That target is blocked by a manor fixture."
        }), 0);
      } else {
        this.movementSequence += 1;
        this.position = {
          x: message.x,
          y: message.y,
          targetX: message.x,
          targetY: message.y,
          moving: true,
          revision: this.position.revision + 1
        };
        window.setTimeout(() => this.onServerMessage?.({
          type: "MANOR_POSITION",
          manorSessionId: SESSION_ID,
          spaceId: "manor_main_room",
          position: { ...this.position },
          movementSequence: this.movementSequence,
          serverTime: Date.now()
        }), 0);
      }
    }
    return { status: "sent", readiness: "ready", connectionGeneration: 1 };
  }
}

export function ManorMovementLiveStory(): React.JSX.Element {
  const portRef = useRef<ManorMovementCommandPort | null>(null);
  if (!portRef.current) portRef.current = new ManorMovementCommandPort();
  const port = portRef.current;
  const [sent, setSent] = useState<ClientMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const client = useRef(new ManorClient(port)).current;
  const manor = useManorFeature({
    connectionStatus: "online",
    ownPlayerId: PLAYER_ID,
    getCommands: () => client,
    showActionError: setActionError,
    onEntered: () => undefined,
    onExited: () => undefined,
    onBeforeEnter: () => undefined
  });
  const installedRef = useRef(false);

  useEffect(() => {
    port.onServerMessage = manor.handleServerMessage;
    port.onSend = (message) => setSent((current) => [...current, message]);
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
        accessSource: "OWNER",
        storage: null
      });
      setReady(true);
    }
    return () => {
      port.onServerMessage = null;
      port.onSend = null;
    };
  }, [manor.handleServerMessage, port]);

  const timeline = manor.refs.movementTimeline.current;
  const authority = timeline.latestAuthorityPosition() ?? START_POSITION;
  const movementMessages = sent.filter((message) => message.type === "MANOR_MOVE_TO");
  const lastMovement = movementMessages.at(-1);
  return (
    <div>
      <ManorScene
        timeline={timeline}
        displayColor="#38bdf8"
        disabled={false}
        movementDisabled={false}
        occupants={[]}
        ownPlayerId={PLAYER_ID}
        canKick={false}
        interactionIntent={manor.view.interactionIntent}
        onMove={manor.actions.requestMove}
        onInteract={() => undefined}
        onCancelInteraction={manor.actions.cancelInteraction}
        onKick={() => false}
        manorId="browser-manor"
        spaceId="manor_main_room"
      />
      <div style={{ position: "fixed", zIndex: 100, left: 0, top: 0, display: "grid" }}>
        <output data-testid="movement-count">{movementMessages.length}</output>
        <output data-testid="manor-ready">{ready ? "ready" : "loading"}</output>
        <output data-testid="movement-sequence">{manor.refs.movementTimeline.current.currentSequence()}</output>
        <output data-testid="authority-position">{JSON.stringify({ x: authority.x, y: authority.y })}</output>
        <output data-testid="last-request-id">
          {lastMovement?.type === "MANOR_MOVE_TO" ? lastMovement.requestId : "none"}
        </output>
        <output data-testid="active-session-id">
          {lastMovement?.type === "MANOR_MOVE_TO" ? lastMovement.manorSessionId : "none"}
        </output>
        <output data-testid="action-error">{actionError ?? "none"}</output>
        <button type="button" onClick={() => manor.actions.requestMove(MANOR_MAIN_ROOM.roomWidth, 500)}>
          Send rejected target
        </button>
      </div>
    </div>
  );
}
