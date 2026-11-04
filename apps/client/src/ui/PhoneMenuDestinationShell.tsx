import { createContext, useContext, type ReactNode } from "react";

import {
  MOBILE_MENU_DESTINATIONS,
  requestMobileMenuReturnToGame,
  type MobileMenuDestinationId
} from "../mobileGameMenu.js";
import { MenuDestinationGlyph } from "./MenuDestinationGlyph.js";
import { useModalBehavior } from "./useModalBehavior.js";
import { useUiPresentation } from "../uiEnvironment.js";
import { DesktopWindow, DesktopWindowTitle } from "./DesktopWindow.js";

/** The single most useful figure for an app, shown at the right of its header. */
export type PhoneMenuHeaderStatus = Readonly<{ value: ReactNode; label: string }>;

type Props = {
  open?: boolean;
  id?: string;
  /** Game Menu app this screen belongs to: sets the header medallion. */
  menuId?: MobileMenuDestinationId;
  headerStatus?: PhoneMenuHeaderStatus | null;
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  headerAction?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  showFooter?: boolean;
  showBack?: boolean;
  showBackGlyph?: boolean;
  showReturnToGame?: boolean;
  navigationDisabled?: boolean;
  /** Extra action(s) in the footer nav row, after Back and Return to Game (same framed button style). */
  navTrailing?: ReactNode;
  initialFocus?: "first" | "container";
  backLabel?: string;
  onBack(): void;
  onEscape?(): void;
  onReturnToGame?(): void;
};

type FrameProps = Omit<Props, "open" | "className"> & {
  titleId: string;
};

const ICON_BY_MENU_ID = new Map(MOBILE_MENU_DESTINATIONS.map((destination) => [destination.id, destination.icon]));

export function PhoneMenuDestinationFrame({
  menuId,
  headerStatus = null,
  eyebrow,
  title,
  titleId,
  subtitle,
  headerAction,
  bodyClassName = "",
  children,
  showFooter = true,
  showBack = true,
  showBackGlyph = true,
  showReturnToGame = true,
  navigationDisabled = false,
  navTrailing,
  backLabel = "Back to Game Menu",
  onBack,
  onReturnToGame = requestMobileMenuReturnToGame
}: FrameProps): React.JSX.Element {
  // Game Menu apps share one header anatomy: medallion, title and
  // one status figure; any descriptive subtitle becomes the page's intro line.
  const icon = menuId ? ICON_BY_MENU_ID.get(menuId) : undefined;
    return (
    <>
      <header className={`phone-menu-header${icon ? " phone-menu-header--ledger" : ""}`}>
        {icon ? <span className="phone-menu-header-medallion" aria-hidden="true"><MenuDestinationGlyph icon={icon} /></span> : null}
        <div>{eyebrow ? <span>{eyebrow}</span> : null}<h1 id={titleId} aria-label={title}><DesktopWindowTitle>{title}</DesktopWindowTitle></h1></div>
        {headerAction ?? (headerStatus ? <p className="phone-menu-header-status">
          <strong>{headerStatus.value}</strong>
          <small>{headerStatus.label}</small>
        </p> : !icon && subtitle ? <small>{subtitle}</small> : null)}
      </header>
      <div className={`phone-destination-body ${bodyClassName}`.trim()}>
        {icon && subtitle ? <p className="phone-destination-intro">{subtitle}</p> : null}
        {children}
      </div>
      {showFooter ? <PhoneMenuFooter
        backLabel={backLabel}
        onBack={onBack}
        onReturnToGame={onReturnToGame}
        showBack={showBack}
        showBackGlyph={showBackGlyph}
        showReturnToGame={showReturnToGame}
        navigationDisabled={navigationDisabled}
        navTrailing={navTrailing}
      /> : null}
    </>
  );
}

export function PhoneMenuFooter({
  backLabel = "Back to Game Menu",
  onBack,
  onReturnToGame = requestMobileMenuReturnToGame,
  showBack = true,
  showBackGlyph = true,
  showReturnToGame = true,
  navigationDisabled = false,
  navTrailing
}: Pick<Props, "backLabel" | "onBack" | "onReturnToGame" | "showBack" | "showBackGlyph" | "showReturnToGame" | "navigationDisabled" | "navTrailing">): React.JSX.Element {
  return (
    <footer className="phone-menu-footer">
      <PhoneMenuFooterButtons
        backLabel={backLabel}
        onBack={onBack}
        onReturnToGame={onReturnToGame}
        showBack={showBack}
        showBackGlyph={showBackGlyph}
        showReturnToGame={showReturnToGame}
        navigationDisabled={navigationDisabled}
      />
      {navTrailing}
    </footer>
  );
}

/**
 * Canonical Back / Return actions shared by the phone footer and desktop app
 * footer. The caller owns the containing footer element so these controls do
 * not create invalid nested footer markup when a desktop shell reuses them.
 */
/**
 * True while the open phone destination came from a HUD shortcut (dock bag, vitals
 * hold). No Game Menu sits underneath it, so its footer offers only Return to Game.
 */
export const PhoneMenuShortcutContext = createContext(false);

export function PhoneMenuFooterButtons({
  backLabel = "Back to Game Menu",
  onBack,
  onReturnToGame = requestMobileMenuReturnToGame,
  showBack = true,
  showReturnToGame = true,
  navigationDisabled = false
}: Pick<Props, "backLabel" | "onBack" | "onReturnToGame" | "showBack" | "showBackGlyph" | "showReturnToGame" | "navigationDisabled">): React.JSX.Element {
  const openedFromShortcut = useContext(PhoneMenuShortcutContext);
  const desktop = useUiPresentation() === "desktop";
  // In-app steps ("Back to Inventory") still show; only the way back to a menu that was never opened goes.
  // On desktop a window opened from the dock is top-level: no Back to a Game Menu, and the one
  // footer action is Close ("Return to Game" is phone language for leaving a full-screen menu).
  const backVisible = showBack && !((openedFromShortcut || desktop) && backLabel === "Back to Game Menu");
  const exitLabel = desktop ? "Close" : "Return to Game";
  // Phone shows these as round floating buttons (glyph only); the desktop window keeps the
  // labelled plaques. Both share one markup: CSS hides the label or the Return glyph.
  return <>
    {backVisible ? (
      <button type="button" className="phone-menu-back" aria-label={backLabel} onClick={() => onBack()} disabled={navigationDisabled}>
        <PhoneMenuBackGlyph /><span className="phone-menu-nav-label" data-short="Back">{backLabel}</span>
      </button>
    ) : null}
    {showReturnToGame || desktop ? (
      <button type="button" className="phone-menu-return" aria-label={exitLabel} onClick={() => onReturnToGame()} disabled={navigationDisabled}>
        <span className="phone-menu-nav-label">{exitLabel}</span>
      </button>
    ) : null}
  </>;
}

export function PhoneMenuDestinationShell({
  open = true,
  id,
  menuId,
  headerStatus = null,
  eyebrow,
  title,
  subtitle,
  headerAction,
  className = "",
  bodyClassName = "",
  children,
  showFooter = true,
  showBack = true,
  showBackGlyph = true,
  showReturnToGame = true,
  navigationDisabled = false,
  navTrailing,
  initialFocus = "first",
  backLabel = "Back to Game Menu",
  onBack,
  onEscape,
  onReturnToGame
}: Props): React.JSX.Element | null {
  const floating = useUiPresentation() === "desktop";
  const dialogRef = useModalBehavior<HTMLElement>({
    open: open && !floating,
    onClose: onEscape ?? (navigationDisabled ? () => {} : onBack),
    closeOnEscape: Boolean(onEscape) || !navigationDisabled,
    initialFocus
  });
  if (!open) return null;
  const titleId = `phone-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;
  // Desktop: Esc closes a top-level window and steps back inside an in-app sub-page.
  const desktopEscape = onEscape ?? (navigationDisabled ? () => {} : backLabel === "Back to Game Menu" ? (onReturnToGame ?? requestMobileMenuReturnToGame) : onBack);
  if (floating) return <DesktopWindow windowKey={`app:${id ?? (className || title)}`} aria-labelledby={titleId}
    {...(id ? { id } : {})} className={`phone-menu-layer phone-destination-shell ${className}`}
    onRequestClose={desktopEscape}>
    <PhoneMenuDestinationFrame title={title} titleId={titleId} {...(menuId ? { menuId } : {})} headerStatus={headerStatus} {...(eyebrow ? { eyebrow } : {})}
      {...(subtitle ? { subtitle } : {})} {...(headerAction ? { headerAction } : {})} bodyClassName={bodyClassName}
      showFooter={showFooter} showBack={showBack} showBackGlyph={showBackGlyph} showReturnToGame={showReturnToGame}
      navigationDisabled={navigationDisabled} navTrailing={navTrailing} backLabel={backLabel} onBack={onBack}
      {...(onReturnToGame ? { onReturnToGame } : {})}>{children}</PhoneMenuDestinationFrame>
  </DesktopWindow>;
  return (
    <section
      ref={dialogRef}
      {...(id ? { id } : {})}
      className={`phone-menu-layer phone-destination-shell ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <PhoneMenuDestinationFrame
        {...(menuId ? { menuId } : {})}
        headerStatus={headerStatus}
        {...(eyebrow ? { eyebrow } : {})}
        title={title}
        titleId={titleId}
        {...(subtitle ? { subtitle } : {})}
        {...(headerAction ? { headerAction } : {})}
        bodyClassName={bodyClassName}
        showFooter={showFooter}
        showBack={showBack}
        showBackGlyph={showBackGlyph}
        showReturnToGame={showReturnToGame}
        navigationDisabled={navigationDisabled}
        navTrailing={navTrailing}
        backLabel={backLabel}
        onBack={onBack}
        {...(onReturnToGame ? { onReturnToGame } : {})}
      >
        {children}
      </PhoneMenuDestinationFrame>
    </section>
  );
}

export function PhoneMenuBackGlyph(): React.JSX.Element {
  return <svg className="phone-menu-back-glyph" viewBox="6 4 10 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m14 6-6 6 6 6" /></svg>;
}
