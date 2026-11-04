import type { ChatChannelKey } from "@ash-atlas/shared";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";

import type { ChatStoreSnapshot } from "../chat/chatStore.js";

type ChatTopBarProps = {
  snapshot: ChatStoreSnapshot;
  disabled?: boolean;
  open?: boolean;
  hiddenSenderIds?: ReadonlySet<string>;
  blockFilterReady?: boolean;
  blockLoadError?: boolean;
  unreadMessageCount?: number;
  messageAttentionRevision?: number;
  messageNotice?: ReactNode;
  developerAccessEnabled?: boolean;
  onOpen(): void;
  onOpenDeveloperTools?(): void;
  onOpenOnlinePlayers?(): void;
  onOpenMessages?(): void;
  onRetryBootstrap(): void;
  onSelectChannel(channelKey: ChatChannelKey): void;
  utility?: ReactNode;
};

export function ChatTopBar({
  snapshot,
  disabled = false,
  open = false,
  hiddenSenderIds,
  blockFilterReady = true,
  blockLoadError = false,
  unreadMessageCount = 0,
  messageAttentionRevision = 0,
  messageNotice = null,
  developerAccessEnabled = false,
  onOpen,
  onOpenDeveloperTools,
  onOpenOnlinePlayers = () => undefined,
  onOpenMessages,
  onRetryBootstrap,
  onSelectChannel,
  utility
}: ChatTopBarProps): React.JSX.Element {
  const selected = snapshot.selectedChannel;
  const ready = snapshot.bootstrapState === "ready";
  const unavailable = snapshot.bootstrapState === "unavailable";
  const preview = selected?.preview;
  const previewHidden = preview
    ? !blockFilterReady || hiddenSenderIds?.has(preview.senderPlayerId) === true
    : false;
  const unreadCount = selected?.unreadCount ?? 0;
  const [channelMenuOpen, setChannelMenuOpen] = useState(false);
  const [activeChannelIndex, setActiveChannelIndex] = useState(0);
  const [messageAttentionActive, setMessageAttentionActive] = useState(false);
  const channelPickerRef = useRef<HTMLDivElement | null>(null);
  const channelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const channelOptions = ready ? snapshot.channels : [];
  const selectedIndex = Math.max(0, channelOptions.findIndex(
    ({ channel }) => channel.key === snapshot.selectedChannelKey
  ));
  const channelPickerDisabled = disabled || !ready || channelOptions.length === 0;
  const holdTimerRef = useRef<number | null>(null);
  const holdPointerIdRef = useRef<number | null>(null);
  const holdStartRef = useRef<{ x: number; y: number } | null>(null);
  const holdTriggeredRef = useRef(false);
  const holdCancelledRef = useRef(false);
  const suppressClickRef = useRef(false);
  const developerAccessRef = useRef(developerAccessEnabled);
  const openDeveloperToolsRef = useRef(onOpenDeveloperTools);
  developerAccessRef.current = developerAccessEnabled;
  openDeveloperToolsRef.current = onOpenDeveloperTools;

  const clearHoldTimer = (): void => {
    if (holdTimerRef.current === null) return;
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  useEffect(() => () => {
    clearHoldTimer();
  }, []);

  useEffect(() => {
    if (developerAccessEnabled) return;
    clearHoldTimer();
    holdPointerIdRef.current = null;
    holdStartRef.current = null;
    holdTriggeredRef.current = false;
    holdCancelledRef.current = false;
    suppressClickRef.current = false;
  }, [developerAccessEnabled]);

  const releasePointerCapture = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelHold = (event: ReactPointerEvent<HTMLButtonElement>, suppressClick: boolean): void => {
    if (holdPointerIdRef.current !== event.pointerId) return;
    clearHoldTimer();
    holdCancelledRef.current = true;
    if (suppressClick) suppressClickRef.current = true;
    releasePointerCapture(event);
    holdPointerIdRef.current = null;
    holdStartRef.current = null;
  };

  const handleOpenPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (
      !developerAccessEnabled ||
      !onOpenDeveloperTools ||
      disabled ||
      (event.button !== undefined && event.button !== 0) ||
      event.isPrimary === false
    ) return;
    clearHoldTimer();
    holdPointerIdRef.current = event.pointerId;
    holdStartRef.current = { x: event.clientX, y: event.clientY };
    holdTriggeredRef.current = false;
    holdCancelledRef.current = false;
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      if (
        holdPointerIdRef.current !== event.pointerId ||
        holdCancelledRef.current ||
        !developerAccessRef.current ||
        !openDeveloperToolsRef.current
      ) return;
      holdTriggeredRef.current = true;
      suppressClickRef.current = true;
      openDeveloperToolsRef.current();
    }, 500);
  };

  const handleOpenPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (holdPointerIdRef.current !== event.pointerId || holdTriggeredRef.current) return;
    const start = holdStartRef.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 10) {
      cancelHold(event, true);
    }
  };

  const handleOpenPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (holdPointerIdRef.current !== event.pointerId) return;
    clearHoldTimer();
    releasePointerCapture(event);
    if (!holdTriggeredRef.current && !holdCancelledRef.current) {
      suppressClickRef.current = false;
    }
    holdPointerIdRef.current = null;
    holdStartRef.current = null;
  };

  const handleOpenClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current || holdTriggeredRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
      holdTriggeredRef.current = false;
      holdCancelledRef.current = false;
      return;
    }
    if (unavailable) onRetryBootstrap();
    else onOpen();
  };

  useEffect(() => {
    if (!channelMenuOpen) return;
    const handleOutsidePointer = (event: PointerEvent): void => {
      if (!channelPickerRef.current?.contains(event.target as Node)) setChannelMenuOpen(false);
    };
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setChannelMenuOpen(false);
      channelTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [channelMenuOpen]);

  useEffect(() => {
    if (channelPickerDisabled) setChannelMenuOpen(false);
  }, [channelPickerDisabled]);

  useEffect(() => {
    if (messageAttentionRevision === 0) return;
    setMessageAttentionActive(true);
    const timer = window.setTimeout(() => setMessageAttentionActive(false), 900);
    return () => window.clearTimeout(timer);
  }, [messageAttentionRevision]);

  const openChannelMenu = (index = selectedIndex): void => {
    if (channelPickerDisabled) return;
    setActiveChannelIndex(index);
    setChannelMenuOpen(true);
  };
  const selectChannel = (index: number): void => {
    const channel = channelOptions[index]?.channel;
    if (!channel) return;
    onSelectChannel(channel.key);
    setChannelMenuOpen(false);
    channelTriggerRef.current?.focus();
  };
  const handleChannelKeyDown = (event: KeyboardEvent): void => {
    if (channelPickerDisabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const origin = channelMenuOpen ? activeChannelIndex : selectedIndex;
      openChannelMenu((origin + delta + channelOptions.length) % channelOptions.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      openChannelMenu(event.key === "Home" ? 0 : channelOptions.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (channelMenuOpen) selectChannel(activeChannelIndex);
      else openChannelMenu();
    }
  };

  return (
    <section className="chat-top-bar" aria-label="Chat" onPointerDown={(event) => event.stopPropagation()}>
      <div ref={channelPickerRef} className="chat-channel-picker" onClick={(event) => event.stopPropagation()}>
        <button
          ref={channelTriggerRef}
          type="button"
          className="chat-top-bar-room"
          aria-label="Select chat room"
          aria-haspopup="listbox"
          aria-expanded={channelMenuOpen}
          aria-controls="chat-channel-listbox"
          disabled={channelPickerDisabled}
          onClick={() => channelMenuOpen ? setChannelMenuOpen(false) : openChannelMenu()}
          onKeyDown={handleChannelKeyDown}
        >
          <span>{unavailable ? "Unavailable" : ready ? (selected?.channel.displayName ?? "Chat") : "Loading"}</span>
          <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1.5 5 5 5-5" /></svg>
        </button>
        {channelMenuOpen ? (
          <div
            id="chat-channel-listbox"
            className="chat-channel-listbox"
            role="listbox"
            aria-label="Chat rooms"
            aria-activedescendant={`chat-channel-option-${activeChannelIndex}`}
            tabIndex={-1}
            onKeyDown={handleChannelKeyDown}
          >
            {channelOptions.map(({ channel }, index) => (
              <button
                id={`chat-channel-option-${index}`}
                key={channel.key}
                type="button"
                role="option"
                aria-selected={channel.key === snapshot.selectedChannelKey}
                data-active={index === activeChannelIndex ? "true" : "false"}
                onPointerMove={() => setActiveChannelIndex(index)}
                onClick={() => selectChannel(index)}
              >
                <span>{channel.displayName}</span>
                {channel.key === snapshot.selectedChannelKey ? <span aria-hidden="true">&#10003;</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="chat-top-bar-open"
        disabled={disabled || (!ready && !unavailable) || (ready && selected === null)}
        onPointerDown={handleOpenPointerDown}
        onPointerMove={handleOpenPointerMove}
        onPointerUp={handleOpenPointerUp}
        onPointerCancel={(event) => cancelHold(event, true)}
        onPointerLeave={(event) => cancelHold(event, true)}
        onClick={handleOpenClick}
        aria-controls="public-chat-panel"
        aria-expanded={open}
        aria-label={unavailable ? "Retry chat" : selected ? `Open ${selected.channel.displayName} chat` : "Chat loading"}
      >
        <span className="chat-top-bar-room-name">
          {unavailable ? "Chat unavailable" : ready ? (selected?.channel.displayName ?? "Chat") : "Loading chat"}
        </span>
        <span className="chat-top-bar-preview">
          {unavailable ? (
            <span className="chat-empty-preview">Retry</span>
          ) : !ready ? (
            <span className="chat-empty-preview">Please wait</span>
          ) : previewHidden ? (
            blockLoadError
              ? "Safety settings unavailable"
              : blockFilterReady
                ? "Message hidden from blocked player"
                : "Loading chat safety settings"
          ) : preview ? (
            <><strong>{preview.senderDisplayName}:</strong> {preview.body}</>
          ) : (
            <span className="chat-empty-preview">Open chat</span>
          )}
        </span>
        {unreadCount > 0 ? (
          <span className="chat-unread-badge" aria-label={`${unreadCount} unread messages`}>
            {formatUnreadCount(unreadCount)}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="chat-top-bar-online"
        disabled={disabled || snapshot.onlinePlayerCount === null}
        onClick={onOpenOnlinePlayers}
        aria-label={
        snapshot.onlinePlayerCount
          ? `Open online players, ${snapshot.onlinePlayerCount.count} online`
          : "Online player count unavailable"
        }
      >
        <span aria-hidden="true" />
        {snapshot.onlinePlayerCount ? snapshot.onlinePlayerCount.count : "—"}
      </button>
      {onOpenMessages ? (
        <button
          type="button"
          className={[
            "chat-top-bar-messages",
            unreadMessageCount > 0 ? "has-unread" : "",
            messageAttentionActive ? "message-attention" : ""
          ].filter(Boolean).join(" ")}
          onClick={() => {
            setMessageAttentionActive(false);
            onOpenMessages();
          }}
          aria-label={unreadMessageCount > 0
            ? `Open Messages, ${unreadMessageCount} unread`
            : "Open Messages"}
          title="Messages"
        >
          <svg viewBox="0 0 20 16" aria-hidden="true">
            <path d="M1.5 2.5h17v11h-17zM2 3l8 6 8-6" />
          </svg>
          {unreadMessageCount > 0 ? (
            <span>{formatUnreadCount(unreadMessageCount)}</span>
          ) : null}
        </button>
      ) : null}
      {messageNotice ? <div className="chat-hud-notice-stack">{messageNotice}</div> : null}
      {utility ? <div className="chat-top-bar-utility">{utility}</div> : null}
    </section>
  );
}

export function formatUnreadCount(unreadCount: number): string {
  return unreadCount >= 10 ? "•" : String(Math.max(0, unreadCount));
}
