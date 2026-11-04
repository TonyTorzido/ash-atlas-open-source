import { useWorldTargetSwapCue } from "./worldTargetExitGhost.js";
import { useEffect, useRef, useState } from "react";

const POINTER_MOVE_THRESHOLD_PX = 8;

export type GameTargetChoice = Readonly<{
  key: string;
  name: string;
  category: string;
  meta?: string;
  detail?: string | null;
  /** This row is what the player is acting on right now (attacking, chopping...). */
  focused?: boolean;
  quickAction?: Readonly<{
    label: string;
    enabled: boolean;
    disabledReason?: string;
    busy?: boolean;
  }>;
}>;

export function GameInteractionRow({
  choice,
  onSelect,
  onQuickAction,
  highlighted,
  onHoverChange,
  onFocusChange,
  onControlPointerDown,
  onControlPointerMove,
  onControlPointerUp,
  onControlPointerCancel,
  onControlClick
}: Readonly<{
  choice: GameTargetChoice;
  onSelect(): void;
  onQuickAction(): void;
  highlighted?: boolean;
  onHoverChange?(hovered: boolean): void;
  onFocusChange?(focused: boolean): void;
  onControlPointerDown?(event: React.PointerEvent<HTMLButtonElement>): void;
  onControlPointerMove?(event: React.PointerEvent<HTMLButtonElement>): void;
  onControlPointerUp?(event: React.PointerEvent<HTMLButtonElement>): void;
  onControlPointerCancel?(event: React.PointerEvent<HTMLButtonElement>): void;
  onControlClick?(event: React.MouseEvent<HTMLButtonElement>): boolean;
}>): React.JSX.Element {
  const quickVisible = Boolean(choice.quickAction && (choice.quickAction.enabled || choice.quickAction.busy === true));
  return <div
    className={`game-interaction-row mobile-world-target-row${quickVisible ? " has-quick-action" : ""}${highlighted ? " is-highlighted" : ""}`}
    onPointerEnter={(event) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") {
        onHoverChange?.(true);
      }
    }}
    onPointerLeave={(event) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") {
        onHoverChange?.(false);
      }
    }}
    onFocusCapture={() => onFocusChange?.(true)}
    onBlurCapture={(event) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      onFocusChange?.(false);
    }}
  >
    <button
      type="button"
      className="game-interaction-detail mobile-world-target-detail"
      data-target-key={choice.key}
      data-target-action="detail"
      onPointerDown={onControlPointerDown}
      onPointerMove={onControlPointerMove}
      onPointerUp={onControlPointerUp}
      onPointerCancel={onControlPointerCancel}
      onClick={(event) => {
        if (!onControlClick?.(event)) onSelect();
      }}
    >
      <span className="game-interaction-detail-copy">
        <strong>
          {choice.focused ? <i className="game-target-focus-dot" aria-hidden="true" /> : null}
          {choice.name}
          {choice.focused ? <small className="sr-only"> (current target)</small> : null}
        </strong>
        <span className="game-interaction-context">
          <small className="sr-only">{choice.category}</small>
          {choice.meta ? <span className="game-interaction-meta">{choice.meta}</span> : null}
          {choice.detail ? <span className="game-interaction-detail-status">{choice.detail}</span> : null}
        </span>
      </span>
    </button>
    {choice.quickAction && quickVisible ? <button
      type="button"
      className="game-interaction-quick mobile-world-target-quick"
      disabled={!choice.quickAction.enabled || choice.quickAction.busy === true}
      aria-busy={choice.quickAction.busy === true}
      data-target-key={choice.key}
      data-target-action="quick"
      onPointerDown={onControlPointerDown}
      onPointerMove={onControlPointerMove}
      onPointerUp={onControlPointerUp}
      onPointerCancel={onControlPointerCancel}
      onClick={(event) => {
        if (!onControlClick?.(event)) onQuickAction();
      }}
    >
      {choice.quickAction.label}
    </button> : null}
  </div>;
}

export function GameTargetPicker({
  ariaLabel = "Choose a target",
  title = "Choose Target",
  choices,
  onSelect,
  onQuickAction,
  footerAction = null,
  onFooterAction,
  onChoiceHighlight,
  onCancel,
  className = ""
}: Readonly<{
  ariaLabel?: string;
  title?: string;
  choices: readonly GameTargetChoice[];
  onSelect(key: string): void;
  onQuickAction(key: string): void;
  footerAction?: Readonly<{
    label: string;
    enabled: boolean;
    busy?: boolean;
    disabledReason?: string;
  }> | null;
  onFooterAction?(): void;
  onChoiceHighlight?(key: string | null): void;
  onCancel(): void;
  className?: string;
}>): React.JSX.Element {
  const pickerRef = useRef<HTMLElement>(null);
  useWorldTargetSwapCue(pickerRef, choices.map((choice) => choice.key).join("|"));
  const onCancelRef = useRef(onCancel);
  const onChoiceHighlightRef = useRef(onChoiceHighlight);
  const pointerSequenceRef = useRef<{
    pointerId: number;
    source: HTMLButtonElement;
    startX: number;
    startY: number;
    cancelled: boolean;
  } | null>(null);
  const suppressedClickSourceRef = useRef<HTMLButtonElement | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  onCancelRef.current = onCancel;
  onChoiceHighlightRef.current = onChoiceHighlight;
  const reportChoiceHighlight = (key: string): void => {
    setHighlightedKey(key);
    onChoiceHighlight?.(key);
  };
  const clearPointerSequence = (releaseCapture: boolean): void => {
    const sequence = pointerSequenceRef.current;
    if (!sequence) return;
    if (releaseCapture && sequence.source.hasPointerCapture?.(sequence.pointerId)) {
      sequence.source.releasePointerCapture(sequence.pointerId);
    }
    pointerSequenceRef.current = null;
  };
  const suppressClickFor = (source: HTMLButtonElement): void => {
    suppressedClickSourceRef.current = source;
    window.setTimeout(() => {
      if (suppressedClickSourceRef.current === source) {
        suppressedClickSourceRef.current = null;
      }
    }, 0);
  };
  const elementAtPoint = (clientX: number, clientY: number): Element | null =>
    document.elementFromPoint?.(clientX, clientY) ?? null;
  const releasedElementFor = (event: React.PointerEvent<HTMLButtonElement>): Element | null => {
    const canResolvePoint = typeof document.elementFromPoint === "function"
      && Number.isFinite(event.clientX)
      && Number.isFinite(event.clientY);
    if (canResolvePoint) return elementAtPoint(event.clientX, event.clientY);
    return event.target instanceof Element ? event.target : event.currentTarget;
  };
  const onControlPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const isMouse = event.pointerType === "mouse";
    const isTouchLike = event.pointerType === "touch" || event.pointerType === "pen";
    if ((!isMouse && !isTouchLike) || (isMouse && event.button !== 0)) return;
    if (event.currentTarget.disabled) return;
    clearPointerSequence(true);
    const source = event.currentTarget;
    pointerSequenceRef.current = {
      pointerId: event.pointerId,
      source,
      startX: event.clientX,
      startY: event.clientY,
      cancelled: false
    };
    source.setPointerCapture?.(event.pointerId);
  };
  const onControlPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const sequence = pointerSequenceRef.current;
    if (!sequence || sequence.pointerId !== event.pointerId || sequence.cancelled) return;
    const deltaX = event.clientX - sequence.startX;
    const deltaY = event.clientY - sequence.startY;
    if (Math.hypot(deltaX, deltaY) > POINTER_MOVE_THRESHOLD_PX) {
      sequence.cancelled = true;
    }
  };
  const onControlPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const sequence = pointerSequenceRef.current;
    if (!sequence || sequence.pointerId !== event.pointerId) return;
    const { source, cancelled } = sequence;
    const releasedElement = releasedElementFor(event);
    const releasedControl = releasedElement?.closest<HTMLButtonElement>("button");
    const releasedInsidePicker = releasedElement !== null && Boolean(pickerRef.current?.contains(releasedElement));
    const releasedOnSource = releasedControl === source;
    clearPointerSequence(true);
    event.stopPropagation();
    if (cancelled || !releasedOnSource || !releasedInsidePicker) {
      event.preventDefault();
      suppressClickFor(source);
    }
    if (!releasedInsidePicker) {
      onCancelRef.current();
    }
  };
  const onControlPointerCancel = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const sequence = pointerSequenceRef.current;
    if (!sequence || sequence.pointerId !== event.pointerId) return;
    const { source } = sequence;
    clearPointerSequence(false);
    event.preventDefault();
    event.stopPropagation();
    suppressClickFor(source);
  };
  const onControlClick = (event: React.MouseEvent<HTMLButtonElement>): boolean => {
    if (suppressedClickSourceRef.current !== event.currentTarget) return false;
    suppressedClickSourceRef.current = null;
    event.preventDefault();
    return true;
  };

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    pickerRef.current?.querySelector<HTMLElement>("button:not([disabled])")
      ?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearPointerSequence(true);
      onChoiceHighlightRef.current?.(null);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <aside
      ref={pickerRef}
      className={`game-compact-prompt game-target-picker mobile-world-action-sheet mobile-world-target-picker${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <h2 aria-label={title}>
        {title}
        {/* The count tells players when more rows are waiting below the scroll. */}
        <span className="game-target-count" aria-hidden="true">{choices.length}</span>
      </h2>
      <div className="game-target-list mobile-world-target-list">
        {choices.map((choice) => <GameInteractionRow
          key={choice.key}
          choice={choice}
          highlighted={highlightedKey === choice.key}
          onSelect={() => onSelect(choice.key)}
          onQuickAction={() => onQuickAction(choice.key)}
          onHoverChange={(hovered) => {
            if (hovered) reportChoiceHighlight(choice.key);
          }}
          onFocusChange={(focused) => {
            if (focused) reportChoiceHighlight(choice.key);
          }}
          onControlPointerDown={onControlPointerDown}
          onControlPointerMove={onControlPointerMove}
          onControlPointerUp={onControlPointerUp}
          onControlPointerCancel={onControlPointerCancel}
          onControlClick={onControlClick}
        />)}
      </div>
      <div className="game-compact-actions mobile-world-action-buttons">
        {footerAction && onFooterAction ? <button
          type="button"
          className="game-interaction-action mobile-world-action-primary primary"
          disabled={!footerAction.enabled || footerAction.busy === true}
          aria-busy={footerAction.busy === true}
          title={footerAction.disabledReason}
          onPointerDown={onControlPointerDown}
          onPointerMove={onControlPointerMove}
          onPointerUp={onControlPointerUp}
          onPointerCancel={onControlPointerCancel}
          onClick={(event) => {
            if (!onControlClick(event)) onFooterAction();
          }}
        >
          {footerAction.label}
        </button> : null}
        <button
          type="button"
          className="game-compact-cancel mobile-world-action-cancel"
          onPointerDown={onControlPointerDown}
          onPointerMove={onControlPointerMove}
          onPointerUp={onControlPointerUp}
          onPointerCancel={onControlPointerCancel}
          onClick={(event) => {
            if (!onControlClick(event)) onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </aside>
  );
}
