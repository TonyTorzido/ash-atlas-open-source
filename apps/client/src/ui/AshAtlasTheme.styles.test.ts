import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const theme = `${readFileSync(fileURLToPath(new URL("../ashAtlasTheme.css", import.meta.url)), "utf8")}\n${readFileSync(fileURLToPath(new URL("./GameThemeTokens.css", import.meta.url)), "utf8")}`;
const baseStyles = `${readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")}\n${readFileSync(fileURLToPath(new URL("./DungeonScene.css", import.meta.url)), "utf8")}`;
const dockStyles = readFileSync(fileURLToPath(new URL("../phoneBottomDock.css", import.meta.url)), "utf8");
const directMessageStyles = readFileSync(
  fileURLToPath(new URL("./DirectMessagesPanel.css", import.meta.url)),
  "utf8"
);
const phoneHud = readFileSync(fileURLToPath(new URL("./PhoneHud.tsx", import.meta.url)), "utf8");

describe("Ash Atlas shared visual theme contract", () => {
  it("defines the maintainable material, text, state, spacing, and radius tokens", () => {
    for (const token of [
      "--aa-ui-ink-950",
      "--aa-ui-leather-900",
      "--aa-ui-leather-800",
      "--aa-ui-wood-800",
      "--aa-ui-parchment-100",
      "--aa-ui-parchment-200",
      "--aa-ui-parchment-300",
      "--aa-ui-bronze-500",
      "--aa-ui-bronze-700",
      "--aa-ui-iron-500",
      "--aa-ui-text",
      "--aa-ui-text-bright",
      "--aa-ui-text-muted",
      "--aa-ui-iron",
      "--aa-ui-active-bronze",
      "--aa-ui-danger",
      "--aa-ui-border",
      "--aa-ui-shadow",
      "--aa-ui-space-1",
      "--aa-ui-space-7",
      "--aa-ui-radius-frame",
      "--aa-ui-radius-control",
      "--aa-ui-radius-panel"
    ]) {
      expect(theme).toContain(`${token}:`);
    }
  });

  it("keeps the gameplay dock enclosed around three cohesive columns", () => {
    expect(dockStyles).toMatch(/\.phone-bottom-bar\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--hud-menu-width\) minmax\(0, 1fr\);/s);
    expect(dockStyles).toMatch(/\.phone-bottom-bar\s*\{[^}]*background: var\(--aa-ui-leather-900\);[^}]*box-shadow:/s);
    expect(dockStyles).toMatch(/\.phone-bottom-status,[\s\S]*?\.phone-menu-trigger\s*\{[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(dockStyles).toMatch(/\.phone-menu-trigger\s*\{[^}]*var\(--aa-ui-active-bronze\)/s);
  });

  it("preserves the locked mobile keyboard variables and composer geometry selectors", () => {
    for (const variable of [
      "--mobile-chat-keyboard-inset",
      "--mobile-chat-committed-keyboard-inset",
      "--mobile-chat-applied-keyboard-inset",
      "--mobile-chat-composer-bottom-padding",
      "--mobile-chat-standalone-focus-drop"
    ]) {
      expect(baseStyles).toContain(variable);
    }
    expect(baseStyles).toMatch(/data-mobile-chat-composer\]\s*\{[^}]*transform: none;/s);
    expect(baseStyles).toMatch(/data-mobile-chat-dock-layout\][^{]*\{[^}]*padding-bottom: var\(--mobile-chat-applied-keyboard-inset\);/s);
    expect(baseStyles).toMatch(/data-ui-profile="phone"\] \.chat-composer textarea\s*\{[^}]*font-size: 16px;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer\s*\{[^}]*padding: var\(--aa-ui-space-2\) 10px;/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer textarea\s*\{[^}]*display: block;/s);
    expect(directMessageStyles).toMatch(/\.direct-messages-panel--phone \.direct-message-composer textarea\s*\{[^}]*font-size: 16px;/s);
  });

  it("uses only opaque medieval materials for full-screen ordinary surfaces", () => {
    expect(theme).toMatch(/\.phone-menu-layer\s*\{[^}]*background: var\(--aa-ui-material-ink\);/s);
    expect(theme).toMatch(/\.chat-panel\s*\{[^}]*background: var\(--aa-ui-material-ink\);/s);
    expect(theme).toMatch(/\.direct-messages-panel--phone\s*\{[^}]*background: var\(--aa-ui-ink-950\);/s);
    expect(theme).not.toMatch(/(?:green|lime|moss|contamination)/i);
  });

  it("keeps direct conversations grid-free and uses compact Atlas ledger controls", () => {
    expect(theme).toMatch(/\.direct-message-history\s*\{[^}]*background: var\(--aa-ui-material-ink\);/s);
    expect(theme).not.toMatch(/\.direct-message-history\s*\{[^}]*(?:repeating-)?linear-gradient\(90deg/s);
    expect(theme).toMatch(/\.direct-message-bubble\s*\{[^}]*background: var\(--aa-ui-material-leather\);/s);
    expect(theme).toMatch(/\.direct-message-bubble::before\s*\{[^}]*background: var\(--aa-ui-bronze-500\);/s);
    expect(theme).toMatch(/data-mobile-chat-composer\]\s*\{[^}]*padding-bottom: var\(--aa-ui-space-2\);/s);
    expect(directMessageStyles).toMatch(/\.direct-message-composer textarea\s*\{[^}]*max-height: 92px;/s);
  });

  it("keeps Atlas Chats flat with canonical tabs and time-gap dividers", () => {
    expect(baseStyles).toMatch(/html\[data-ui-profile\] \.chat-panel-header\.phone-menu-header\s*\{/);
    expect(baseStyles).toMatch(/html \.chat-room-tab-strip \.game-app-tabs\.game-app-tabs button\[aria-selected="true"\]\s*\{[^}]*border-bottom-color: var\(--aa-ui-active-bronze\);[^}]*color: var\(--aa-ui-active-bronze\);/s);
    expect(baseStyles).toMatch(/\.chat-room-tab-strip \.game-app-tabs\s*\{[^}]*overflow-x: auto;[^}]*scrollbar-width: none;/s);
    expect(baseStyles).toMatch(/\.chat-settings-trigger,\s*\.chat-panel-header \.panel-close,\s*\.chat-send-button\s*\{[^}]*height: 32px;/s);
    expect(baseStyles).not.toMatch(/html\[data-ui-profile="phone"\] \.chat-(panel-header|follow-live|room-tab-strip|composer-actions)/);
    expect(theme).toMatch(/\.chat-message-list\s*\{[^}]*background: var\(--aa-ui-ink-950\);/s);
    expect(theme).not.toMatch(/\.chat-message-list\s*\{[^}]*(?:repeating-)?linear-gradient/s);
    expect(theme).toMatch(/\.chat-message-time-gap\s*\{[^}]*border-top-color: color-mix\(in srgb, var\(--aa-ui-bronze-500\) 22%, transparent\);/s);
    expect(baseStyles).toMatch(/html\[data-ui-profile="phone"\] \.chat-settings-popover\s*\{[^}]*position: fixed;[^}]*right: max\(8px, env\(safe-area-inset-right\)\);[^}]*left: max\(8px, env\(safe-area-inset-left\)\);[^}]*width: auto;[^}]*max-width: calc\(100vw - 16px\);[^}]*box-sizing: border-box;[^}]*overflow-y: auto;/s);
    expect(baseStyles).toMatch(/\.chat-message \+ \.chat-message-group-continuation\s*\{[^}]*margin-top: 0;/s);
    expect(baseStyles).toMatch(/\.chat-message \+ \.chat-message-group-start,\s*\.chat-message \+ \.chat-message-time-gap\s*\{[^}]*margin-top: 10px;/s);
    expect(baseStyles).toMatch(/\.chat-message\s*\{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*touch-action: pan-y;/s);
    expect(baseStyles).toMatch(/\.chat-message-actions\s*\{[^}]*position: absolute;[^}]*opacity: 0;[^}]*pointer-events: none;/s);
    expect(baseStyles).toMatch(/@media \(any-hover: hover\) \{[\s\S]*?\.chat-message:hover \.chat-message-actions,[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/s);
    expect(baseStyles).not.toContain("@media (hover: none), (pointer: coarse)");
    expect(baseStyles).toMatch(/@media \(any-hover: none\) and \(any-pointer: coarse\) \{[\s\S]*?\.chat-message\s*\{[^}]*-webkit-touch-callout: none;[^}]*user-select: none;[\s\S]*?-webkit-user-select: none;/s);
    expect(baseStyles).toMatch(/\.chat-message\[data-mobile-actions-revealed="true"\] \.chat-message-actions,[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/s);
    expect(baseStyles).toMatch(/\.chat-message-actions button\s*\{[^}]*width: 44px;[^}]*height: 44px;/s);
    expect(baseStyles).not.toMatch(/html\[data-ui-profile="phone"\] \.chat-message:not\(\[data-mobile-actions-revealed/);
  });

  it("bounds chat popovers to a contained vertical scroller with an Ash scrollbar", () => {
    expect(baseStyles).toMatch(/\.chat-settings-popover\s*\{[^}]*position: fixed;[^}]*max-height: min\(420px, calc\(100dvh - 16px\)\);[^}]*overflow-x: hidden;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*touch-action: pan-y;/s);
    expect(baseStyles).toMatch(/\.chat-message-actions-menu\s*\{[^}]*max-height: min\(320px, calc\(100dvh - 16px\)\);[^}]*overflow-x: hidden;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*touch-action: pan-y;/s);
    expect(baseStyles).toMatch(/\.chat-reaction-picker\s*\{[^}]*max-height: min\(320px, calc\(100dvh - 16px\)\);[^}]*overflow-x: hidden;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*touch-action: pan-y;/s);
    expect(theme).toMatch(/\.chat-settings-popover,\s*\.chat-message-actions-menu,\s*\.chat-reaction-picker\s*\{[^}]*scrollbar-color: var\(--aa-ui-bronze-700\) var\(--aa-ui-ink-950\);[^}]*scrollbar-width: thin;/s);
    expect(theme).toMatch(/\.chat-settings-popover::-webkit-scrollbar,[\s\S]*?\.chat-reaction-picker::-webkit-scrollbar\s*\{[^}]*width: 8px;[^}]*height: 8px;/s);
    expect(theme).toMatch(/\.chat-settings-popover::-webkit-scrollbar-thumb,[\s\S]*?\.chat-reaction-picker::-webkit-scrollbar-thumb\s*\{[^}]*border: 2px solid var\(--aa-ui-ink-950\);[^}]*border-radius: 999px;[^}]*background: var\(--aa-ui-bronze-700\);/s);
  });

  it("uses flat mobile app chrome and Manor-style button interaction states", () => {
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-menu-header,[\s\S]*?background: var\(--aa-ui-wood-800\);/);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-shell button,[\s\S]*?font-family: var\(--aa-ui-font-body\);/);
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-housed button,[^{]*\{[^}]*background: var\(--aa-ui-leather-800\);/);
    expect(theme).not.toMatch(/\.game-app-tabs\.game-app-tabs-housed button,[^{]*\{[^}]*(?:--aa-ui-material-wood|background-image)/);
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-housed button:active:not\(:disabled\),[\s\S]*?\{[^}]*transform: translateY\(1px\);/);
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-housed button\[aria-selected="true"\],[\s\S]*?\{[^}]*inset 0 -3px var\(--aa-ui-active-bronze\)/);
    expect(theme).toMatch(/\.profile-ledger-shell \.profile-connections \.game-app-tabs button\[aria-selected="true"\]\s*\{[^}]*background: var\(--aa-ui-wood-700\);[^}]*inset 0 -3px var\(--aa-ui-active-bronze\);/s);
    expect(theme).toMatch(/\.profile-ledger-shell \.profile-ledger \.social-list-profile\s*\{[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(theme).toMatch(/\.profile-hero\s*\{[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(theme).toMatch(/\.profile-character-pane\s*\{[^}]*min-height: 240px;[^}]*background: transparent;/s);
    expect(theme).toMatch(/\.profile-connections \.game-app-tabs button\s*\{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*font-size: 11px;/s);
    expect(theme).toMatch(/\.phone-progression-body \.launch-class-selector button\[aria-pressed="true"\],[\s\S]*?\.class-skill-slot-actions button\[aria-pressed="true"\],[\s\S]*?background: var\(--aa-ui-wood-700\);[\s\S]*?opacity: 1;/);
    expect(theme).toMatch(/\.phone-destination-shell \.mobile-inbox-categories\s*\{[^}]*scrollbar-width: none;/s);
  });

  it("keeps scrollable housed tabs at max-content width on phone", () => {
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-housed\.game-app-tabs-housed-scrollable\s*\{[^}]*grid-auto-columns: minmax\(96px, max-content\);[^}]*overflow-x: auto;/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-shell:not\(\.world-map-phone-shell\) \.game-app-tabs\.game-app-tabs-housed\.game-app-tabs-housed-scrollable button:not\(:disabled\)\s*\{[^}]*width: max-content;[^}]*min-width: 96px;[^}]*white-space: nowrap;/s);
  });

  it("keeps inventory item art on one mobile-equivalent frame across profiles", () => {
    expect(theme).toContain("--aa-ui-inventory-item-frame: 34px;");
    expect(theme).toContain("--aa-ui-dungeon-object-min-hit-frame: 44px;");
    expect(theme).toContain("grid-template-columns: var(--aa-ui-inventory-item-frame) minmax(0, 1fr) minmax(30px, auto) minmax(43px, auto) 6px;");
    expect(theme).toContain(".inventory-entry-row > .item-artwork { width: var(--aa-ui-inventory-item-frame); height: var(--aa-ui-inventory-item-frame); }");
    expect(theme).not.toMatch(/@media \(max-width: 480px\)[\s\S]*?\.inventory-entry-row \{ grid-template-columns: 34px/);
    expect(baseStyles).toContain(".manor-ground-equipment { position: absolute; z-index: 4; min-width: 0; min-height: 0");
    expect(baseStyles).toContain(".dungeon-ground-loot { z-index: 60; min-width: 0; min-height: 0");
  });

  it("puts grouped backpack quantity at the end of the shared inventory row", () => {
    expect(theme).toMatch(/\.inventory-entry-row--backpack\s*\{[^}]*grid-template-columns: var\(--aa-ui-inventory-item-frame\) minmax\(0, 1fr\) minmax\(30px, auto\);/s);
    expect(theme).toMatch(/\.inventory-entry-row--backpack \.inventory-entry-quantity\s*\{[^}]*grid-column: 3;[^}]*justify-self: end;/s);
    expect(theme).toMatch(/\.inventory-entry-row--backpack \.inventory-entry-weight, \.inventory-entry-row--backpack \.inventory-entry-chevron\s*\{[^}]*display: none;/s);
  });

  it("uses a flat equal-fit segmented ledger for canonical subtabs", () => {
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-subtabs\s*\{[^}]*grid-template-columns: repeat\(var\(--game-app-tab-columns\), minmax\(0, 1fr\)\);[^}]*gap: 0;[^}]*overflow: hidden;[^}]*border: 1px solid var\(--aa-ui-border-muted\);/s);
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-subtabs button,[^{]*\{[^}]*min-height: 44px;[^}]*border: 0;[^}]*border-inline-end: 1px solid var\(--aa-ui-border-muted\);[^}]*background: transparent;[^}]*font-size: clamp\(10px, 2\.8vw, 11px\);/s);
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-subtabs button\[aria-selected="true"\],[^{]*\{[^}]*background: var\(--aa-ui-leather-800\);[^}]*inset 0 -3px var\(--aa-ui-active-bronze\);/s);
    expect(theme).toMatch(/\.game-app-tabs\.game-app-tabs-subtabs button:focus-visible\s*\{[^}]*outline: 2px solid var\(--aa-ui-parchment-100\);[^}]*outline-offset: -2px;/s);
  });

  it("defines the shared menu primitive contract and narrow touch-safe presentation", () => {
    for (const token of [
      "--aa-ui-space-8",
      "--aa-ui-control-height",
      "--aa-ui-touch-target",
      "--aa-ui-divider",
      "--aa-ui-focus-ring"
    ]) {
      expect(theme).toContain(`${token}:`);
    }
    for (const selector of [
      ".game-app-section-header",
      ".game-app-text",
      ".game-app-button",
      ".game-app-icon-button",
      ".game-app-close-button",
      ".game-app-back-button",
      ".game-app-divider",
      ".game-app-state",
      ".game-app-scroll-region"
    ]) {
      expect(theme).toContain(selector);
    }
    expect(theme).toMatch(/\.game-app-button\.game-app-button-destructive\s*\{[^}]*var\(--aa-ui-danger\)/s);
    expect(theme).toMatch(/\.game-app-scroll-region\s*\{[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/s);
    expect(theme).toMatch(/@media \(max-width: 480px\)\s*\{[\s\S]*?\.game-app-button \{[^}]*min-height: var\(--aa-ui-touch-target\);/s);
    expect(theme).toMatch(/\.ui-standards-state-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(theme).toMatch(/@media \(max-width: 480px\)\s*\{[\s\S]*?\.ui-standards-state-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/s);
  });

  it("keeps long mobile destinations scrollable without shrinking leaderboard rows away", () => {
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-body\s*\{[^}]*min-height: 0;[^}]*overflow: hidden auto;[^}]*-webkit-overflow-scrolling: touch;/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.weekly-leaderboards-shell \.phone-destination-body\s*\{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;[^}]*touch-action: pan-y;[^}]*-webkit-overflow-scrolling: touch;/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.weekly-leaderboards-shell \.phone-destination-body > \*\s*\{[^}]*flex-shrink: 0;/s);
    expect(theme).toMatch(/\.weekly-leaderboards-period-rail\s*\{[^}]*position: sticky;[^}]*z-index: 2;[^}]*background: var\(--aa-menu-paper\);/s);
    expect(theme).toMatch(/\.phone-flags-body > \.flag-management-section,[\s\S]*?overflow: hidden auto;/);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.character-workspace\s*\{[^}]*overflow: auto;/s);
    expect(theme).toMatch(/\.inventory-grid-shell\s*\{[^}]*overflow: auto;/s);
  });

  it("keeps phone tab rails opaque across the complete scroll boundary", () => {
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-shell\.harvest-tolls-app \.phone-destination-body\s*\{[^}]*padding: 0 10px max\(18px, env\(safe-area-inset-bottom\)\);/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-shell\.harvest-tolls-app \.game-app-tabs\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*padding: var\(--aa-ui-space-4\) 0 var\(--aa-ui-space-2\);[^}]*background: var\(--aa-ui-ink-950\);[^}]*box-shadow: 0 var\(--aa-ui-space-2\) 0 var\(--aa-ui-ink-950\);/s);
    expect(baseStyles).toMatch(/data-ui-profile="phone"\] \.phone-build-list\s*\{[^}]*padding: 0 var\(--aa-kit-body-pad\) var\(--aa-kit-body-pad\);/s);
    expect(baseStyles).toMatch(/data-ui-profile="phone"\] \.phone-build-tabs\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*padding: var\(--aa-kit-body-pad\) 0 8px;[^}]*background: var\(--aa-menu-page\);/s);
    expect(baseStyles).toMatch(/\.market-app \.game-app-body,[\s\S]*?\.market-app\.phone-destination-shell \.phone-destination-body\s*\{[^}]*padding: 0;[^}]*background: var\(--aa-ui-ink-950\);/s);
    expect(baseStyles).toMatch(/\.market-app-navigation\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*background: var\(--aa-ui-material-ink\);/s);
  });

  it("keeps inventory slots square, responsive on desktop, and four-wide on phone", () => {
    expect(theme).toMatch(/\.inventory-grid-shell\s*\{[^}]*overflow: auto;[^}]*touch-action: pan-y;/s);
    expect(theme).toMatch(/\.inventory-destination-layout\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(theme).toMatch(/\.inventory-item-grid\s*\{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(112px, 100%\), 1fr\)\);/s);
    expect(theme).toMatch(/\.inventory-item-tile\s*\{[^}]*aspect-ratio: 1;/s);
    expect(theme).toMatch(/\.inventory-detail-pane\s*\{[^}]*position: absolute;[^}]*display: none;/s);
    expect(theme).toMatch(/\.inventory-detail-pane\.open\s*\{[^}]*display: block;/s);
    expect(theme).toMatch(/\.inventory-item-tile\.draggable\s*\{[^}]*touch-action: pan-y;/s);
    expect(theme).toMatch(/\.inventory-item-grid\.reorder-active \.inventory-item-tile\.draggable\s*\{[^}]*touch-action: pan-y;/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.inventory-item-grid\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/s);
    expect(theme).toMatch(/\.inventory-detail-close\s*\{[^}]*min-height: 44px;[^}]*var\(--aa-ui-leather-800\)/s);
    expect(theme).toMatch(/\.inventory-item-action-dialog\s*\{[^}]*var\(--aa-ui-material-leather\)/s);
  });

  it("contains no prohibited imagery or iconography", () => {
    expect(`${theme}\n${phoneHud}`).not.toMatch(/[☢☣⚠]/u);
    expect(`${theme}\n${phoneHud}`).not.toMatch(/\b(?:radiation|hazard|nuclear)\b/i);
  });
});
