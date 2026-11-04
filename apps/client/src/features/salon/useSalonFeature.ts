import type {
  PlayerSalonStyles,
  SalonEditorSnapshot,
  SalonSessionSnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import {
  SALON_CHAIR,
  SALON_CHAIR_APPROACH,
  SALON_CHAIR_INTERACTION_RADIUS,
  isIndoorInteractionInRange
} from "@ash-atlas/shared";
import { useCallback, useRef, useState } from "react";

import type { GameClient } from "../../gameClient.js";
import { SalonMovementTimeline } from "../../movement/salonMovementTimeline.js";

export type SalonServerMessage = Extract<ServerMessage, { type: `SALON_${string}` | "MASK_EQUIPPED" }>;

export function isSalonServerMessage(message: ServerMessage): message is SalonServerMessage {
  return message.type.startsWith("SALON_") || message.type === "MASK_EQUIPPED";
}

export function useSalonFeature(
  client: React.RefObject<GameClient | null>,
  onError: (message: string) => void
) {
  const [session, setSession] = useState<SalonSessionSnapshot | null>(null);
  const [editor, setEditor] = useState<SalonEditorSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const movementTimelineRef = useRef(new SalonMovementTimeline());
  const chairApproachPendingRef = useRef(false);

  const handleServerMessage = useCallback((message: SalonServerMessage): void => {
    switch (message.type) {
      case "SALON_ENTERED":
        setError(null);
        movementTimelineRef.current.start(
          message.salonSessionId,
          message.position,
          message.movementSequence,
          message.serverTime,
          performance.now()
        );
        setSession({
          structureId: message.structureId,
          sessionId: message.salonSessionId,
          displayColor: message.displayColor,
          ...(message.appearance ? { appearance: message.appearance } : {}),
          position: message.position,
          movementSequence: message.movementSequence
        });
        setEditor(null);
        return;
      case "SALON_POSITION":
        if (movementTimelineRef.current.applySnapshot(
          message.salonSessionId,
          message.position,
          message.movementSequence,
          message.serverTime,
          performance.now()
        ) === "ignored") return;
        setSession((current) => current?.sessionId === message.salonSessionId
          ? { ...current, position: message.position, movementSequence: message.movementSequence }
          : current);
        if (
          chairApproachPendingRef.current && !message.position.moving &&
          isIndoorInteractionInRange(
            message.position,
            SALON_CHAIR,
            SALON_CHAIR_INTERACTION_RADIUS
          )
        ) {
          chairApproachPendingRef.current = false;
          const requestId = client.current?.beginSalonCustomize(
            message.salonSessionId,
            message.movementSequence
          ) ?? null;
          if (!requestId) {
            setCustomizing(false);
            setError("Cannot customize while disconnected.");
          }
        }
        return;
      case "SALON_EDITOR_OPENED":
        setCustomizing(false);
        setEditor({
          editorSessionId: message.editorSessionId,
          releaseSha: message.releaseSha,
          catalogRevision: message.catalogRevision,
          schemaVersion: message.schemaVersion,
          appearanceRevision: message.appearanceRevision,
          styles: message.styles
        });
        return;
      case "SALON_EDITOR_CANCELLED":
        setEditor(null);
        return;
      case "SALON_APPEARANCE_SAVED":
        setSaving(false);
        setSession((current) => current ? { ...current, appearance: message.appearance } : current);
        setEditor((current) => current ? {
          ...current,
          appearanceRevision: message.appearanceRevision,
          styles: message.styles
        } : current);
        return;
      case "MASK_EQUIPPED":
        setSession((current) => current ? { ...current, appearance: message.appearance } : current);
        return;
      case "SALON_EXITED":
        chairApproachPendingRef.current = false;
        movementTimelineRef.current.clear();
        setSession(null);
        setEditor(null);
        setSaving(false);
        setCustomizing(false);
        return;
      case "SALON_ERROR":
        chairApproachPendingRef.current = false;
        setSaving(false);
        setCustomizing(false);
        setError(message.message);
        onError(message.message);
        return;
    }
  }, [onError]);

  return {
    session,
    editor,
    saving,
    customizing,
    error,
    movementTimeline: movementTimelineRef.current,
    handleServerMessage,
    enter(structureId: string, placementRevision: string) {
      setError(null);
      const requestId = client.current?.enterSalon(structureId, placementRevision) ?? null;
      if (!requestId) setError("Cannot enter while disconnected.");
      return requestId;
    },
    move(x: number, y: number) {
      if (!session) return null;
      chairApproachPendingRef.current = false;
      setCustomizing(false);
      setEditor(null);
      return client.current?.salonMoveTo(session.sessionId, x, y) ?? null;
    },
    customize() {
      if (!session) return null;
      setError(null);
      setCustomizing(true);
      const nearChair = !session.position.moving && isIndoorInteractionInRange(
        session.position,
        SALON_CHAIR,
        SALON_CHAIR_INTERACTION_RADIUS
      );
      if (nearChair) {
        const requestId = client.current?.beginSalonCustomize(
          session.sessionId,
          session.movementSequence
        ) ?? null;
        if (!requestId) setCustomizing(false);
        return requestId;
      }
      const requestId = client.current?.salonMoveTo(
        session.sessionId,
        SALON_CHAIR_APPROACH.x,
        SALON_CHAIR_APPROACH.y
      ) ?? null;
      chairApproachPendingRef.current = Boolean(requestId);
      if (!requestId) setCustomizing(false);
      return requestId;
    },
    save(changes: PlayerSalonStyles) {
      if (!editor) return null;
      setSaving(true);
      return client.current?.saveSalonAppearance({
        editorSessionId: editor.editorSessionId,
        expectedAppearanceRevision: editor.appearanceRevision,
        catalogRevision: editor.catalogRevision,
        changes
      }) ?? null;
    },
    cancelEditor() {
      if (!editor) return null;
      setEditor(null);
      return client.current?.cancelSalonCustomize(editor.editorSessionId) ?? null;
    },
    exit() {
      if (!session) return null;
      chairApproachPendingRef.current = false;
      setCustomizing(false);
      return client.current?.exitSalon(session.sessionId) ?? null;
    }
  };
}
