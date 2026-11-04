import {
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";

import { useModalBehavior } from "./useModalBehavior.js";
import { PhoneMenuBackGlyph, PhoneMenuDestinationShell, type PhoneMenuHeaderStatus } from "./PhoneMenuDestinationShell.js";
import { requestMobileMenuReturnToGame, type MobileMenuDestinationId } from "../mobileGameMenu.js";
import { useUiPresentation } from "../uiEnvironment.js";
import { DesktopWindow, DesktopWindowTitle } from "./DesktopWindow.js";

export type GameAppShellProps = Readonly<{
  open: boolean;
  id?: string;
  title: string;
  eyebrow?: string;
  subtitle?: string;
  /** Game Menu app this screen belongs to (phone ledger header medallion and section). */
  menuId?: MobileMenuDestinationId;
  headerStatus?: PhoneMenuHeaderStatus | null;
  headerAction?: ReactNode;
  closeLabel: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
  layout?: "desktop" | "phone";
  phoneBackLabel?: string;
  phoneShowBack?: boolean;
  phoneOnBack?: () => void;
  phoneOnEscape?: () => void;
  phoneShowReturnToGame?: boolean;
  phoneOnReturnToGame?: () => void;
  initialFocus?: "first" | "container";
  closeDisabled?: boolean;
  /** Extra action(s) in the bottom nav row beside Back / Return to Game (phone) or Close (desktop). */
  navTrailing?: ReactNode;
  showDesktopClose?: boolean;
  onClose(): void;
}>;

const DESKTOP_TOP_LEVEL_BACK_LABELS = new Set(["Back to Game Menu", "Back to Game", "Back to World", "Back to Manor", "Back to Salon"]);

export function GameAppShell({
  open,
  id,
  title,
  eyebrow,
  subtitle,
  menuId,
  headerStatus = null,
  headerAction,
  closeLabel,
  className = "",
  children,
  footer,
  layout = "desktop",
  phoneBackLabel,
  phoneShowBack = true,
  phoneOnBack,
  phoneOnEscape,
  phoneShowReturnToGame = true,
  phoneOnReturnToGame,
  initialFocus = "first",
  closeDisabled = false,
  navTrailing,
  showDesktopClose = true,
  onClose
}: GameAppShellProps): React.JSX.Element | null {
  const floating = useUiPresentation() === "desktop";
  const dialogRef = useModalBehavior<HTMLElement>({
    open: open && layout === "desktop" && !floating,
    onClose: closeDisabled ? () => {} : onClose,
    closeOnEscape: !closeDisabled,
    initialFocus
  });
  if (!open) return null;
  if (layout === "phone") {
    return (
      <PhoneMenuDestinationShell
        open
        {...(id ? { id } : {})}
        title={title}
        {...(menuId ? { menuId } : {})}
        headerStatus={headerStatus}
        {...(eyebrow ? { eyebrow } : {})}
        {...(headerAction ? { headerAction } : {})}
        {...(subtitle ? { subtitle } : {})}
        className={className}
        {...(phoneBackLabel ? { backLabel: phoneBackLabel } : {})}
        showBack={phoneShowBack}
        showReturnToGame={phoneShowReturnToGame}
        initialFocus={initialFocus}
        navigationDisabled={closeDisabled}
        navTrailing={navTrailing}
        onBack={phoneOnBack ?? onClose}
        {...(phoneOnEscape ? { onEscape: phoneOnEscape } : {})}
        {...(phoneOnReturnToGame ? { onReturnToGame: phoneOnReturnToGame } : {})}
      >
        {children}
        {footer}
      </PhoneMenuDestinationShell>
    );
  }
  const titleId = `destination-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;
  // Desktop windows end in one Close action in the footer (beside any primary action row).
  // A window opened from the dock is top-level (Close only). Back appears only for a real in-app
  // sub-page ("Back to Inventory"), where it returns to the parent page and Close leaves the app.
  const subPageBack = phoneBackLabel && !DESKTOP_TOP_LEVEL_BACK_LABELS.has(phoneBackLabel) ? phoneBackLabel : null;
  const closeApp = (): void => {
    if (subPageBack && document.querySelector(".game-shell")?.getAttribute("data-mobile-menu-view") !== "gameplay") requestMobileMenuReturnToGame();
    else onClose();
  };
  const desktopClose = floating && showDesktopClose
    ? <>
      {subPageBack ? <button type="button" className="phone-menu-back" aria-label={subPageBack} onClick={() => (phoneOnBack ?? onClose)()} disabled={closeDisabled}><PhoneMenuBackGlyph /><span className="phone-menu-nav-label" data-short="Back">{subPageBack}</span></button> : null}
      <button type="button" className="phone-menu-return" aria-label={closeLabel ?? "Close"} onClick={closeApp} disabled={closeDisabled}><span className="phone-menu-nav-label">Close</span></button>
      {navTrailing}
    </>
    : null;
  if (floating) return <DesktopWindow windowKey={`app:${id ?? (className || title)}`} aria-labelledby={titleId}
    {...(id ? { id } : {})} className={`destination-shell phone-destination-shell desktop-destination-shell ${className}`}
    onRequestClose={closeDisabled ? () => {} : onClose}>
    <GameAppHeader title={title} titleId={titleId} {...(eyebrow ? { eyebrow } : {})} {...(subtitle ? { subtitle } : {})}
      {...(headerAction ? { headerAction } : {})} closeLabel={closeLabel} closeDisabled={closeDisabled} showClose={false} onClose={onClose} />
    <GameAppBody>{children}</GameAppBody>
    {footer || desktopClose || navTrailing ? <GameAppFooter {...(footer && desktopClose ? { className: "desktop-footer-actions" } : {})}>{footer}{desktopClose}{desktopClose ? null : navTrailing}</GameAppFooter> : null}
  </DesktopWindow>;
  return (
    <div className="modal-scrim destination-shell-scrim" role="presentation">
      <aside
        ref={dialogRef}
        {...(id ? { id } : {})}
        className={`destination-shell phone-destination-shell desktop-destination-shell ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <GameAppHeader
          title={title}
          titleId={titleId}
          {...(eyebrow ? { eyebrow } : {})}
          {...(subtitle ? { subtitle } : {})}
          {...(headerAction ? { headerAction } : {})}
          closeLabel={closeLabel}
          closeDisabled={closeDisabled}
          showClose={showDesktopClose}
          onClose={onClose}
        />
        <GameAppBody>{children}</GameAppBody>
        {footer || navTrailing ? <GameAppFooter>{footer}{navTrailing}</GameAppFooter> : null}
      </aside>
    </div>
  );
}

export function GameAppHeader({
  title,
  titleId,
  eyebrow,
  subtitle,
  headerAction,
  closeLabel,
  closeDisabled = false,
  showClose = true,
  onClose
}: Readonly<{
  title: string;
  titleId?: string;
  eyebrow?: string;
  subtitle?: string;
  headerAction?: ReactNode;
  closeLabel?: string;
  closeDisabled?: boolean;
  showClose?: boolean;
  onClose?: () => void;
}>): React.JSX.Element {
  return <header className="destination-shell-header game-app-header">
    <div>
      {eyebrow ? <span>{eyebrow}</span> : null}
      <h2 id={titleId} aria-label={title}><DesktopWindowTitle>{title}</DesktopWindowTitle></h2>
      {subtitle ? <small>{subtitle}</small> : null}
    </div>
    {headerAction || (showClose && onClose) ? <div className="destination-shell-header-actions">
      {headerAction}
      {showClose && onClose ? <GameAppCloseButton label={closeLabel ?? "Close"} disabled={closeDisabled} onClick={() => onClose()} /> : null}
    </div> : null}
  </header>;
}

export function GameAppBody({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return <div className="destination-shell-content game-app-body">{children}</div>;
}

export function GameAppFooter({ children, className = "" }: Readonly<{ children: ReactNode; className?: string }>): React.JSX.Element {
  return <footer className={`destination-shell-footer game-app-footer ${className}`.trim()}>{children}</footer>;
}

export function GameAppTabs({
  tabs,
  activeTab,
  onChange,
  ariaLabel = "App sections",
  variant,
  scrollable = false,
  className
}: Readonly<{
  tabs: readonly Readonly<{
    id: string;
    label: string;
    /** Optional glyph or picture shown above the label (e.g. the Skills discipline picker); decorative. */
    icon?: ReactNode;
    /** Optional second line under the label, such as a rank (2/3). */
    detail?: string;
    badge?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }>[];
  activeTab: string;
  onChange(id: string): void;
  ariaLabel?: string;
  variant?: "housed" | "subtabs";
  scrollable?: boolean;
  className?: string;
}>): React.JSX.Element {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabbableId = tabs.some((tab) => tab.id === activeTab && !tab.disabled)
    ? activeTab
    : tabs.find((tab) => !tab.disabled)?.id;
  const style = variant === "housed" || variant === "subtabs"
    ? { "--game-app-tab-columns": tabs.length } as CSSProperties
    : undefined;
  const variantClass = variant ? ` game-app-tabs-${variant}` : "";
  const scrollableClass = variant && scrollable ? ` game-app-tabs-${variant}-scrollable` : "";
  return <div
    className={`game-app-tabs${variantClass}${scrollableClass}${className ? ` ${className}` : ""}`}
    role="tablist"
    aria-label={ariaLabel}
    style={style}
  >
    {tabs.map((tab) => <button
      key={tab.id}
      ref={(node) => {
        if (node) tabRefs.current.set(tab.id, node);
        else tabRefs.current.delete(tab.id);
      }}
      type="button"
      role="tab"
      aria-label={tab.ariaLabel}
      aria-selected={tab.id === activeTab}
      tabIndex={tab.id === tabbableId ? 0 : -1}
      disabled={tab.disabled}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const enabled = tabs.filter((candidate) => !candidate.disabled);
        const currentIndex = enabled.findIndex((candidate) => candidate.id === tab.id);
        const next = event.key === "Home"
          ? enabled[0]
          : event.key === "End"
            ? enabled.at(-1)
            : enabled[(currentIndex + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
        if (!next) return;
        event.preventDefault();
        onChange(next.id);
        tabRefs.current.get(next.id)?.focus();
      }}
      onClick={() => onChange(tab.id)}
    >
      {tab.icon ? <span className="game-app-tab-icon" aria-hidden="true">{tab.icon}</span> : null}
      <span>{tab.label}</span>
      {tab.detail ? <small className="game-app-tab-detail" aria-hidden="true">{tab.detail}</small> : null}
      {tab.badge ? <span className="game-app-tab-badge" aria-hidden="true">{tab.badge}</span> : null}
    </button>)}
  </div>;
}

export function GameAppCard({
  title,
  badge,
  leading,
  status,
  description,
  children,
  action,
  className = ""
}: Readonly<{
  title: string;
  badge?: string;
  leading?: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}>): React.JSX.Element {
  const hasHeadingPresentation = leading !== undefined || status !== undefined || description !== undefined;
  return <article className={`game-app-card ${className}`.trim()}>
    <header className={hasHeadingPresentation ? "game-app-card-header-with-heading" : undefined}>
      {hasHeadingPresentation ? <div className="game-app-card-heading">
        {leading ? <div className="game-app-card-leading">{leading}</div> : null}
        <div className="game-app-card-heading-copy">
          <div className="game-app-card-title-row">
            <h3>{title}</h3>
            {status ? <span className="game-app-card-status">{status}</span> : null}
          </div>
          {description ? <p className="game-app-card-description">{description}</p> : null}
        </div>
      </div> : <h3>{title}</h3>}
      {badge ? <span className="game-app-badge">{badge}</span> : null}
    </header>
    <div>{children}</div>
    {action ? <footer>{action}</footer> : null}
  </article>;
}

export function GameAppActionBar({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return <div className="game-app-action-bar">{children}</div>;
}

export type GameAppSectionHeaderProps = Readonly<{
  title: ReactNode;
  titleId?: string;
  eyebrow?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string | undefined;
}>;

/**
 * Shared section heading for readable app bodies. Feature panels provide copy
 * and actions; the shell owns the heading hierarchy and responsive spacing.
 */
export function GameAppSectionHeader({
  title,
  titleId,
  eyebrow,
  description,
  meta,
  action,
  className = ""
}: GameAppSectionHeaderProps): React.JSX.Element {
  return <header className={`game-app-section-header ${className}`.trim()}>
    <div className="game-app-section-header-copy">
      {eyebrow ? <span className="game-app-section-eyebrow">{eyebrow}</span> : null}
      <h3 id={titleId}>{title}</h3>
      {description ? <p className="game-app-section-description">{description}</p> : null}
    </div>
    {meta || action ? <div className="game-app-section-header-side">
      {meta ? <span className="game-app-section-meta">{meta}</span> : null}
      {action}
    </div> : null}
  </header>;
}

export type GameAppTextProps = Readonly<{
  children: ReactNode;
  tone?: "body" | "helper" | "muted" | "error";
  as?: "p" | "small" | "span" | "div";
  className?: string | undefined;
  id?: string;
  role?: HTMLAttributes<HTMLElement>["role"];
  ariaLive?: "off" | "polite" | "assertive";
}>;

export function GameAppText({
  children,
  tone = "body",
  as = "p",
  className = "",
  id,
  role,
  ariaLive
}: GameAppTextProps): React.JSX.Element {
  const Tag = as;
  return <Tag
    id={id}
    role={role}
    aria-live={ariaLive}
    className={`game-app-text game-app-text-${tone} ${className}`.trim()}
  >{children}</Tag>;
}

export type GameAppButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & Readonly<{
  variant?: "standard" | "primary" | "destructive" | "quiet";
}>;

export function GameAppButton({
  variant = "standard",
  type = "button",
  className = "",
  ...buttonProps
}: GameAppButtonProps): React.JSX.Element {
  return <button {...buttonProps} type={type} className={`game-app-button game-app-button-${variant} ${className}`.trim()} />;
}

export type GameAppIconButtonProps = Omit<GameAppButtonProps, "children"> & Readonly<{
  label: string;
  children: ReactNode;
}>;

export function GameAppIconButton({
  label,
  children,
  className = "",
  ...buttonProps
}: GameAppIconButtonProps): React.JSX.Element {
  return <GameAppButton
    {...buttonProps}
    aria-label={label}
    className={`game-app-icon-button ${className}`.trim()}
  >{children}</GameAppButton>;
}

export function GameAppCloseButton({
  label = "Close",
  className = "",
  ...buttonProps
}: Omit<GameAppIconButtonProps, "children" | "label"> & Partial<Pick<GameAppIconButtonProps, "label">>): React.JSX.Element {
  return <GameAppIconButton
    {...buttonProps}
    label={label}
    className={`game-app-close-button destination-shell-close menu-text-close ${className}`.trim()}
  >
    <span aria-hidden="true">{label.startsWith("Dismiss") ? "Dismiss" : "Close"}</span>
  </GameAppIconButton>;
}

export function GameAppBackButton({
  label = "Back",
  className = "",
  children,
  ...buttonProps
}: Omit<GameAppButtonProps, "children"> & Readonly<{
  label?: string;
  children?: ReactNode;
}>): React.JSX.Element {
  return <GameAppButton
    {...buttonProps}
    aria-label={buttonProps["aria-label"] ?? label}
    className={`game-app-back-button ${className}`.trim()}
  >
    {children ?? <span aria-hidden="true">‹</span>}
    <span>{label}</span>
  </GameAppButton>;
}

export function GameAppDivider({ className = "" }: Readonly<{ className?: string }>): React.JSX.Element {
  return <hr className={`game-app-divider ${className}`.trim()} />;
}

export type GameAppStateVariant = "empty" | "loading" | "disabled" | "error";

export function GameAppState({
  variant = "empty",
  title,
  children,
  action,
  className = ""
}: Readonly<{
  variant?: GameAppStateVariant;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}>): React.JSX.Element {
  const role = variant === "error" ? "alert" : "status";
  return <section className={`game-app-state game-app-state-${variant} ${className}`.trim()} role={role}>
    {title ? <strong>{title}</strong> : null}
    {children ? <p>{children}</p> : null}
    {action ? <div className="game-app-state-action">{action}</div> : null}
  </section>;
}

export function GameAppEmptyState(props: Omit<React.ComponentProps<typeof GameAppState>, "variant">): React.JSX.Element {
  return <GameAppState {...props} variant="empty" />;
}

export function GameAppScrollRegion({
  children,
  ariaLabel,
  className = ""
}: Readonly<{
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}>): React.JSX.Element {
  return <div className={`game-app-scroll-region ${className}`.trim()} {...(ariaLabel ? { "aria-label": ariaLabel } : {})}>{children}</div>;
}
