import { useWorldTargetExitGhost } from "./worldTargetExitGhost.js";
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

import { useModalBehavior } from "./useModalBehavior.js";
import { useUiPresentation } from "../uiEnvironment.js";
import { DesktopWindow, DesktopWindowTitle } from "./DesktopWindow.js";

export type GamePromptAction = Readonly<{
  key: string;
  label: string;
  enabled?: boolean;
  busy?: boolean;
  /** Cooling down: stays visible but disabled, with the remaining seconds in its label. */
  cooling?: boolean;
  disabledReason?: string | null;
  /** Stays on screen while disabled, with its disabledReason shown beside it (e.g. broken armour). */
  keepVisible?: boolean;
  tone?: "primary" | "secondary" | "danger";
  /** Optional small badge before the label (pet ability icons). */
  icon?: string;
  onSelect(): void;
}>;

const OUTSIDE_TAP_SLOP_PX = 8;

export type GamePromptPresentationState = "entering" | "visible" | "exiting";
export type GamePromptActionLayout = "stacked" | "primary-quick" | "military-main-merge";

export const GamePromptButton = forwardRef<
  HTMLButtonElement,
  Readonly<{ tone?: "primary" | "secondary" | "danger" }> & ButtonHTMLAttributes<HTMLButtonElement>
>(function GamePromptButton({ tone = "primary", className, ...props }, ref) {
  return <button
    {...props}
    ref={ref}
    type="button"
    className={[
      "game-prompt-button",
      "game-interaction-action",
      "mobile-world-action-primary",
      tone,
      className ?? ""
    ].filter(Boolean).join(" ")}
  />;
});

export type GameActionPromptProps = Readonly<{
  title: string;
  category?: string | null;
  artwork?: ReactNode;
  detail?: string | null;
  message?: Readonly<{ text: string; tone?: "muted" | "error" }> | null;
  content?: ReactNode;
  actions: readonly GamePromptAction[];
  /** Skills and abilities usable on this target: split rows of three below the main bar. */
  skills?: readonly GamePromptAction[];
  actionLayout?: GamePromptActionLayout;
  cancelLabel?: string;
  ariaLabel?: string;
  dismissOnOutsideClick?: boolean;
  elevated?: boolean;
  forced?: boolean;
  modal?: boolean;
  movable?: boolean;
  presentationState?: GamePromptPresentationState | undefined;
  actionsReady?: boolean;
  className?: string;
  /** Phone bottom sheet only: the title stays on one line. */
  compact?: boolean;
  /** Keep Cancel usable while an action is busy (Cancel then stops that action). */
  cancelWhileBusy?: boolean;
  onCancel(): void;
}>;

export function GameActionPrompt({
  title,
  category = null,
  artwork = null,
  detail = null,
  message = null,
  content = null,
  actions,
  skills = [],
  actionLayout = "stacked",
  cancelLabel = "Cancel",
  ariaLabel = `${title} actions`,
  dismissOnOutsideClick = false,
  elevated = false,
  forced = false,
  modal = false,
  movable = true,
  presentationState,
  actionsReady = true,
  className = "",
  compact = false,
  cancelWhileBusy = false,
  onCancel
}: GameActionPromptProps): React.JSX.Element {
  const presentation = useUiPresentation();
  const floating = presentation === "desktop" && !forced && !modal && movable;
  const compactSheet = compact && !floating && !forced && !modal;
  // Standard: an action that cannot be performed is hidden, never shown disabled with
  // explanatory text. Only an action that is running (busy) stays visible.
  // Forced (loss-of-control) prompts are the exception: their one recovery action, such as a
  // respawn countdown, stays on screen while it is not yet available.
  const visibleActions = forced
    ? actions
    : actions.filter((action) => action.enabled !== false || action.busy === true || action.keepVisible === true);
  // A skill on cooldown is the one temporary exception: visible, disabled, seconds in its label.
  const visibleSkills = skills.filter((skill) => skill.enabled !== false || skill.busy === true || skill.cooling === true);
  const skillRows: GamePromptAction[][] = [];
  for (let index = 0; index < visibleSkills.length; index += 3) skillRows.push(visibleSkills.slice(index, index + 3));
  const busy = visibleActions.some((action) => action.busy === true);
  const promptRef = useModalBehavior<HTMLElement>({
    open: forced || modal,
    onClose: () => { if (!busy) onCancel(); },
    closeOnEscape: false,
    containEscape: true
  });
  useWorldTargetExitGhost(promptRef);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const firstEnabledActionIndex = visibleActions.findIndex(
    (action) => action.enabled !== false && action.busy !== true
  );
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!floating || !dismissOnOutsideClick) return;
    const dismiss = (event: globalThis.PointerEvent): void => {
      if (!busyRef.current && event.target instanceof Node && !promptRef.current?.contains(event.target)) onCancelRef.current();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [floating, dismissOnOutsideClick, promptRef]);

  // Phone sheets close on a tap outside, while a drag outside still pans the map.
  // The tap still reaches the world, so a double-tap there moves the player.
  useEffect(() => {
    if (floating || !dismissOnOutsideClick) return;
    let start: { id: number; x: number; y: number } | null = null;
    const outside = (target: EventTarget | null): boolean =>
      target instanceof Node && !promptRef.current?.contains(target);
    const down = (event: globalThis.PointerEvent): void => {
      start = event.isPrimary !== false && outside(event.target)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
    };
    const up = (event: globalThis.PointerEvent): void => {
      if (!start || event.pointerId !== start.id) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > OUTSIDE_TAP_SLOP_PX;
      start = null;
      if (moved || busyRef.current || !outside(event.target)) return;
      onCancelRef.current();
    };
    const cancel = (): void => { start = null; };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
  }, [floating, dismissOnOutsideClick, promptRef]);

  useEffect(() => {
    if (!forced || firstEnabledActionIndex === -1) return;
    firstActionRef.current?.focus({ preventScroll: true });
  }, [firstEnabledActionIndex, forced]);

  useEffect(() => {
    if (forced || floating) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    (firstActionRef.current ?? promptRef.current)?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (busyRef.current) return;
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [forced, modal, floating]);

  const contentMarkup = <>
      <div className="game-compact-heading mobile-world-action-heading">
        {artwork ? <div className="game-compact-artwork mobile-world-action-artwork">{artwork}</div> : null}
        <div>
          <h2 aria-label={title}><DesktopWindowTitle>{title}</DesktopWindowTitle></h2>
          {category ? <small className="game-compact-category">{category}</small> : null}
          {detail ? <p>{detail}</p> : null}
        </div>
      </div>
      {message ? <p className={`game-compact-message ${message.tone ?? "muted"}`} role={message.tone === "error" ? "alert" : undefined}>
        {message.text}
      </p> : null}
      {content ? <div className="game-compact-content">{content}</div> : null}
      <div className={`game-compact-actions mobile-world-action-buttons game-compact-actions--${actionLayout}`}>
        {visibleActions.map((action, index) => {
          const disabled = action.enabled === false || action.busy === true;
          return <div className="game-compact-action" key={action.key}>
            <GamePromptButton
              ref={index === firstEnabledActionIndex ? firstActionRef : undefined}
              tone={action.tone ?? "primary"}
              data-action-key={action.key}
              disabled={disabled}
              aria-busy={action.busy === true}
              onClick={() => action.onSelect()}
            >
              {action.icon ? <img className="game-prompt-action-icon" src={action.icon} alt="" /> : null}
              {action.label}
            </GamePromptButton>
            {action.keepVisible && disabled && action.disabledReason ? <small className="game-compact-action-reason">{action.disabledReason}</small> : null}
          </div>;
        })}
        {skillRows.length > 0 ? <div className="game-compact-skills" role="group" aria-label="Skills">
          {skillRows.map((row) => <div
            key={row.map((skill) => skill.key).join("|")}
            className="game-compact-skill-row"
            style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
          >
            {row.map((skill) => <GamePromptButton
              key={skill.key}
              tone={skill.tone ?? "secondary"}
              data-action-key={skill.key}
              disabled={skill.enabled === false || skill.busy === true || skill.cooling === true}
              aria-busy={skill.busy === true}
              onClick={() => skill.onSelect()}
            >
              {skill.icon ? <img className="game-prompt-action-icon" src={skill.icon} alt="" /> : null}
              {skill.label}
            </GamePromptButton>)}
          </div>)}
        </div> : null}
        {!forced ? <button
          ref={firstEnabledActionIndex === -1 && !busy ? firstActionRef : undefined}
          type="button"
          className="game-compact-cancel mobile-world-action-cancel"
          disabled={busy && !cancelWhileBusy}
          onClick={() => onCancel()}
        >
          {cancelLabel}
        </button> : null}
      </div>
    </>;
  const promptClassName = `game-compact-prompt game-action-prompt mobile-world-action-sheet${compactSheet ? " game-compact-prompt--sheet" : ""}${elevated ? " game-compact-prompt-elevated" : ""}${className ? ` ${className}` : ""}`;
  const prompt = floating ? <DesktopWindow compact windowKey={`prompt:${className || category || "world"}`} className={promptClassName}
    overlayRef={promptRef}
    aria-label={ariaLabel} aria-busy={busy} data-world-target-presentation={presentationState}
    onRequestClose={() => { if (!busy) onCancel(); }}
    onClickCapture={actionsReady ? undefined : (event) => { event.preventDefault(); event.stopPropagation(); }}>
    {contentMarkup}
  </DesktopWindow> : <aside ref={promptRef} className={promptClassName} aria-label={ariaLabel} aria-busy={busy}
    role={forced || modal ? "dialog" : undefined} aria-modal={forced || modal ? "true" : undefined}
    data-world-target-presentation={presentationState} tabIndex={-1}
    onPointerDown={(event) => event.stopPropagation()}
    onClickCapture={actionsReady ? undefined : (event) => { event.preventDefault(); event.stopPropagation(); }}
    onClick={(event) => event.stopPropagation()}>{contentMarkup}</aside>;
  if (forced || modal) {
    const layer = <div
    className="game-action-prompt-forced-layer"
    role="presentation"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
  >{prompt}</div>;
    return presentation === "desktop" && typeof document !== "undefined" ? createPortal(layer, document.body) : layer;
  }
  return prompt;
}

export function GameConfirmationPrompt({
  title,
  category = "CONFIRM",
  detail = null,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmEnabled = true,
  busy = false,
  disabledReason = null,
  content = null,
  destructive = false,
  ariaLabel,
  onConfirm,
  onCancel
}: Readonly<{
  ariaLabel?: string;
  title: string;
  category?: string;
  detail?: string | null;
  confirmLabel: string;
  cancelLabel?: string;
  confirmEnabled?: boolean;
  busy?: boolean;
  disabledReason?: string | null;
  destructive?: boolean;
  content?: ReactNode;
  onConfirm(): void;
  onCancel(): void;
}>): React.JSX.Element {
  return <GameActionPrompt
    modal
    movable={false}
    {...(ariaLabel ? { ariaLabel } : {})}
    title={title}
    category={category}
    detail={detail}
    content={content}
    message={!confirmEnabled && disabledReason ? { text: disabledReason, tone: "muted" } : null}
    elevated
    cancelLabel={cancelLabel}
    actions={[{
      key: "confirm",
      label: confirmLabel,
      enabled: confirmEnabled,
      busy,
      disabledReason,
      tone: destructive ? "danger" : "primary",
      onSelect: onConfirm
    }]}
    onCancel={onCancel}
  />;
}
