import type { DirectMessageServerMessage } from "@ash-atlas/shared";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useRef } from "react";

import type { SocialClient } from "../../client/domains/socialClient.js";
import type {
  DirectMessageStore,
  OptimisticDirectMessage
} from "../../directMessages/directMessageStore.js";

export interface DirectMessageRuntimeOptions {
  store: DirectMessageStore;
  ownPlayerId: string;
  getCommands(): SocialClient | null;
  setWarning: Dispatch<SetStateAction<string | null>>;
  onMessageReceived(): void;
}

export function useDirectMessageRuntime({
  store,
  ownPlayerId,
  getCommands,
  setWarning,
  onMessageReceived
}: DirectMessageRuntimeOptions) {
  const bootstrappedRef = useRef(false);
  const recoveringRef = useRef(false);
  const panelVisibleRef = useRef(false);
  const combatSuppressionRef = useRef(false);
  const sendRequestsRef = useRef(new Map<string, string>());
  const openRequestsRef = useRef(new Map<string, string>());
  const notifiedEventsRef = useRef(new Set<string>());
  const lastReadRequestRef = useRef(new Map<string, string>());
  const readResultResolversRef = useRef(new Map<string, (confirmed: boolean) => void>());

  const sendCandidate = useCallback((candidate: OptimisticDirectMessage): boolean => {
    if (candidate.conversationId === null || recoveringRef.current) return false;
    const requestId = getCommands()?.sendDirectMessage(
      candidate.conversationId,
      candidate.clientMessageId,
      candidate.body
    );
    if (!requestId) return false;
    sendRequestsRef.current.set(requestId, candidate.clientMessageId);
    return true;
  }, [getCommands]);

  const requestOpen = useCallback((targetPlayerId: string): boolean => {
    const requestId = getCommands()?.openDirectMessage(targetPlayerId);
    if (!requestId) return false;
    openRequestsRef.current.set(requestId, targetPlayerId);
    return true;
  }, [getCommands]);

  const handleServerMessage = useCallback((frame: DirectMessageServerMessage): void => {
    if (frame.type === "DM_ERROR") {
      const clientMessageId = frame.requestId
        ? sendRequestsRef.current.get(frame.requestId)
        : undefined;
      if (frame.requestId) sendRequestsRef.current.delete(frame.requestId);
      const readResolver = frame.requestId
        ? readResultResolversRef.current.get(frame.requestId)
        : undefined;
      if (frame.requestId) readResultResolversRef.current.delete(frame.requestId);
      readResolver?.(false);
      if (clientMessageId) store.failMessage(clientMessageId, frame.code);
      const openPeerId = frame.requestId
        ? openRequestsRef.current.get(frame.requestId)
        : undefined;
      if (frame.requestId) openRequestsRef.current.delete(frame.requestId);
      if (openPeerId) store.failPendingSendsForRecipient(openPeerId, frame.code);
      setWarning(frame.message);
      if (frame.code === "sync_required") {
        const cursor = store.getSnapshot().gap.acknowledgedEventCursor;
        recoveringRef.current = true;
        store.setGapSyncing(true);
        getCommands()?.syncDirectMessages(cursor);
      }
      return;
    }

    const events = "events" in frame ? frame.events : [];
    const newlyObservedEvents = new Set<string>();
    for (const event of events) {
      if (!notifiedEventsRef.current.has(event.eventSequence)) {
        notifiedEventsRef.current.add(event.eventSequence);
        newlyObservedEvents.add(event.eventSequence);
      }
    }
    if (notifiedEventsRef.current.size > 512) {
      notifiedEventsRef.current.clear();
      for (const event of events) notifiedEventsRef.current.add(event.eventSequence);
    }

    store.applyServerMessage(frame);
    const snapshot = store.getSnapshot();
    for (const event of events) {
      if (event.kind !== "message_created" || event.message.senderPlayerId === ownPlayerId) continue;
      getCommands()?.acknowledgeDirectMessageDelivery(
        event.message.conversationId,
        event.message.sequence
      );
      if (frame.type !== "DM_EVENT" || !newlyObservedEvents.has(event.eventSequence)) continue;
      const conversation = store.getSnapshot().conversations.find(
        (candidate) => candidate.conversationId === event.message.conversationId
      );
      const viewingConversation = panelVisibleRef.current &&
        snapshot.selectedPeerId === event.conversation.peer.playerId;
      const suppressForCombat = snapshot.preferences.suppressBannersDuringCombat &&
        combatSuppressionRef.current;
      if (viewingConversation || conversation?.muted || suppressForCombat) continue;
      onMessageReceived();
    }

    const acknowledgedCursor = snapshot.gap.acknowledgedEventCursor;
    if (events.length > 0 && acknowledgedCursor !== "0") {
      getCommands()?.acknowledgeDirectMessageEvents(acknowledgedCursor);
    }
    if (frame.type === "DM_SEND_RESULT") sendRequestsRef.current.delete(frame.requestId);
    if (frame.type === "DM_READ_RESULT") {
      readResultResolversRef.current.get(frame.requestId)?.(true);
      readResultResolversRef.current.delete(frame.requestId);
    }

    if (frame.type === "DM_BOOTSTRAP_RESULT" || frame.type === "DM_SYNC_RESULT") {
      bootstrappedRef.current = true;
      if (frame.hasMore || snapshot.gap.needsSync) {
        recoveringRef.current = true;
        store.setGapSyncing(true);
        getCommands()?.syncDirectMessages(acknowledgedCursor);
        return;
      }
      recoveringRef.current = false;
      store.setGapSyncing(false);
      const selected = store.getSnapshot().selectedConversation;
      if (selected?.conversationId === null) requestOpen(selected.peer.playerId);
      return;
    }

    if (frame.type === "DM_OPEN_RESULT") {
      const openedPeerId = openRequestsRef.current.get(frame.requestId);
      openRequestsRef.current.delete(frame.requestId);
      if (openedPeerId && !recoveringRef.current) {
        for (const candidate of store.getPendingSendsForRecipient(openedPeerId)) {
          sendCandidate(candidate);
        }
      }
      return;
    }

    if (frame.type === "DM_EVENT" && (frame.hasMore || snapshot.gap.needsSync) && !snapshot.gap.syncing) {
      recoveringRef.current = true;
      store.setGapSyncing(true);
      getCommands()?.syncDirectMessages(acknowledgedCursor);
    }
  }, [getCommands, onMessageReceived, ownPlayerId, requestOpen, sendCandidate, setWarning, store]);

  const onWelcome = useCallback((): void => {
    recoveringRef.current = true;
    store.setGapSyncing(bootstrappedRef.current);
    if (bootstrappedRef.current) {
      getCommands()?.syncDirectMessages(store.getSnapshot().gap.acknowledgedEventCursor);
    } else {
      getCommands()?.bootstrapDirectMessages();
    }
  }, [getCommands, store]);

  const onDisconnected = useCallback((): void => {
    recoveringRef.current = true;
    openRequestsRef.current.clear();
    sendRequestsRef.current.clear();
    for (const resolve of readResultResolversRef.current.values()) resolve(false);
    readResultResolversRef.current.clear();
    store.failPendingSends();
  }, [store]);

  const updateRead = useCallback((conversationId: string, throughSequence: string): boolean => {
    if (lastReadRequestRef.current.get(conversationId) === throughSequence) return false;
    if (!getCommands()?.updateDirectMessageRead(conversationId, throughSequence)) return false;
    lastReadRequestRef.current.set(conversationId, throughSequence);
    return true;
  }, [getCommands]);

  const updateReads = useCallback(async (
    targets: readonly Readonly<{ conversationId: string; throughSequence: string }>[]
  ): Promise<boolean> => {
    const results = await Promise.all(targets.map((target) => {
      if (lastReadRequestRef.current.get(target.conversationId) === target.throughSequence) {
        return Promise.resolve(true);
      }
      const requestId = getCommands()?.updateDirectMessageRead(
        target.conversationId,
        target.throughSequence
      ) ?? null;
      if (!requestId) return Promise.resolve(false);
      lastReadRequestRef.current.set(target.conversationId, target.throughSequence);
      return new Promise<boolean>((resolve) => {
        readResultResolversRef.current.set(requestId, resolve);
      });
    }));
    return results.every(Boolean);
  }, [getCommands]);

  const setPanelVisible = useCallback((visible: boolean): void => {
    panelVisibleRef.current = visible;
  }, []);
  const setCombatSuppressed = useCallback((suppressed: boolean): void => {
    combatSuppressionRef.current = suppressed;
  }, []);

  return useMemo(() => ({
    sendCandidate,
    requestOpen,
    handleServerMessage,
    onWelcome,
    onDisconnected,
    updateRead,
    updateReads,
    setPanelVisible,
    setCombatSuppressed
  } as const), [
    handleServerMessage,
    onDisconnected,
    onWelcome,
    requestOpen,
    sendCandidate,
    setCombatSuppressed,
    setPanelVisible,
    updateRead,
    updateReads
  ]);
}

export type DirectMessageRuntime = ReturnType<typeof useDirectMessageRuntime>;
