import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLIENT_SOURCE = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_EXTENSIONS = new Set([".css", ".tsx"]);
const WORD_BANS = /\b(?:green|lime|chartreuse|moss|contamination)\b/i;
const LEGACY_BANS = /(?:--hud-green|--chat-green|--aa-ui-moss|--aa-ui-contamination|#9bea4e|#b8ff65|#b7ff74|#7eae58|#718d49|#9edb5f)/i;

// Existing health/status indicators approved in docs/ui/DESIGN.md. Match exact
// declarations and selectors in their owning file, not whole UI stylesheets.
const APPROVED_STATUS_LINES: Record<string, readonly string[]> = {
  "ashAtlasTheme.css": [
    ":root | --aa-ui-success: #4fd173;",
    ":root | --aa-health-fill-top: #35c766;",
    ":root | --aa-health-fill-bottom: #17833c;",
    ":root | --aa-health-fill-highlight: rgb(167 239 183 / 48%);",
    // Smithing readiness, successful action feedback and positive stat changes.
    ".smithing-station-item-status.ready | border-color: rgb(90 137 86 / 68%);",
    ".smithing-station-item-status.ready | color: #bed6b8;",
    ".smithing-station-item-status.ready | background: #172418;",
    ".smithing-station-feedback.success | border-left-color: #6e9968;",
    ".smithing-station-feedback.success | color: #c6ddc1;",
    ".smithing-station-stat-panel dd em | color: #a8c89f;",
    ".smithing-station-requirement.ready | border-left-color: #6e9968;",
    ".smithing-station-requirement.ready | color: #c6ddc1;",
    ".smithing-station-requirement.ready | background: #172018;"
  ],
  "phoneBottomDock.css": [
    'html[data-ui-profile="phone"] .phone-bottom-status .player-status-hud-phone-dock | --status-health: #22a951;',
    'html[data-ui-profile="phone"] .phone-bottom-status .status-bar-health .hp-bar-fill | inset 0 -1px rgb(4 42 18 / 42%);',
    'html[data-ui-profile="phone"] .phone-economy-protection | background: rgb(25 78 43 / 38%);'
  ],
  "styles.css": [
    ".chat-top-bar-online > span | background: #6f9b59;",
    ".population-preparation-progress i | background: linear-gradient(90deg, #58654a, #829268);",
    ".flag-build-progress i | background: linear-gradient(90deg, #58654a, #829268);",
    ".world-activity-timer-progress i, .flag-build-progress i | background: linear-gradient(90deg, #58654a, #829268);",
    ".test-access-mode-panel.is-open | border-left-color: #4e9f69;",
    ".test-access-inline-result | color: #bbf7d0;",
    ".hp-bar-fill | inset 0 -1px rgb(4 42 18 / 42%);",
    ".party-class-sigil.class-hunter { background: #8fb474; }",
    ".party-health-track i, .party-health-track .party-ward-fill | background: linear-gradient(90deg, #397846, #6fb15d);",
    ".party-priority-effects .is-beneficial { background: #417b68; }",
    ".fishing-meter-landing-band | border-top: 2px solid rgb(107 173 109 / 45%);",
    ".fishing-meter-landing-band | border-bottom: 2px solid rgb(107 173 109 / 45%);",
    ".fishing-meter-landing-band | background: rgb(107 173 109 / 25%);"
  ],
  "menuAppearance.css": [
    ":root | --aa-menu-success-surface: #dce2c5;",
    ":root | --aa-menu-success-text: #37543b;",
    "html[data-menu-theme=\"dark\"] | --aa-menu-success-surface: #303c2b;",
    "html[data-menu-theme=\"dark\"] | --aa-menu-success-text: #b9d2a8;"
  ],
  "ui/HealthBarTrack.css": [
    ".hp-bar-fill | inset 0 -1px rgb(4 42 18 / 42%);"
  ],
  "ui/GameThemeTokens.css": [
    ":root | --aa-ui-success: #4fd173;",
    ":root | --aa-health-fill-top: #35c766;",
    ":root | --aa-health-fill-bottom: #17833c;",
    ":root | --aa-health-fill-highlight: rgb(167 239 183 / 48%);"
  ],
  "ui/KingdomPanel.css": [
    ".kingdom-ledger-entry.deposit { border-left: 3px solid #4ade80; padding-left: 8px; }"
  ],
  "ui/PetChamber.viewport.css": [
    ".dog-health-bar i | background: linear-gradient(90deg, #a24d3d, #d0ad61, #79a06f);"
  ]
};

describe("ordinary UI no-green guard", () => {
  it("allows approved health/status indicators and world artwork while rejecting ordinary green chrome", () => {
    const violations: string[] = [];
    for (const file of walk(CLIENT_SOURCE)) {
      const local = relative(CLIENT_SOURCE, file).replaceAll("\\", "/");
      // The standalone player wiki owns a separate editorial palette; this guard covers game chrome.
      if (local.startsWith("map/") || local.startsWith("wiki/") || local.endsWith(".test.tsx")) continue;
      if (!SCANNED_EXTENSIONS.has(extname(file))) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      let precedingSource = "";
      lines.forEach((rawLine, index) => {
        const selector = extname(file) === ".css" && containsGreenColor(rawLine)
          ? enclosingCssSelector(precedingSource)
          : "";
        if (violatesGreenPolicy(local, rawLine, selector)) {
          violations.push(`${local}:${index + 1}: ${rawLine.trim()}`);
        }
        precedingSource += `${rawLine}\n`;
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("keeps unapproved declarations and additional green styles guarded", () => {
    expect(violatesGreenPolicy("ashAtlasTheme.css", "--aa-health-fill-top: #35c766;", ":root")).toBe(false);
    expect(violatesGreenPolicy("ui/Other.css", "--aa-health-fill-top: #35c766;", ":root")).toBe(true);
    expect(violatesGreenPolicy("ashAtlasTheme.css", "background: #172418;", ".menu")).toBe(true);
    expect(violatesGreenPolicy("ashAtlasTheme.css", ".menu.active { color: #35c766; }")).toBe(true);
    expect(violatesGreenPolicy("ashAtlasTheme.css", "--aa-health-fill-top: #35c766; background: #00ff00;")).toBe(true);
    expect(violatesGreenPolicy("styles.css", ".player-status-hud { --status-health: #22a951; background: #00ff00; }")).toBe(true);
    expect(violatesGreenPolicy("styles.css", ".green-menu { color: #eee5d3; }")).toBe(true);
  });
});

function violatesGreenPolicy(local: string, rawLine: string, selector = ""): boolean {
  const declaration = rawLine.includes("{") ? rawLine.trim() : `${selector} | ${rawLine.trim()}`;
  if (allowedWorldGreen(local, rawLine) || APPROVED_STATUS_LINES[local]?.includes(declaration)) return false;
  // This existing rule is on one line; remove only its approved health declaration.
  const line = local === "styles.css" && rawLine.trimStart().startsWith(".player-status-hud {")
    ? rawLine.replace("--status-health: #22a951;", "")
    : rawLine;
  return WORD_BANS.test(line) || LEGACY_BANS.test(line) || containsGreenColor(line);
}

function enclosingCssSelector(source: string): string {
  const opening = source.lastIndexOf("{");
  if (opening < 0) return "";
  const boundary = Math.max(source.lastIndexOf("}", opening), source.lastIndexOf("{", opening - 1), source.lastIndexOf(";", opening));
  return source.slice(boundary + 1, opening).replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " ");
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function allowedWorldGreen(local: string, line: string): boolean {
  // Dungeon silhouettes are world artwork even though their renderer lives in ui/.
  if (local === "ui/DungeonRoomPresentation.tsx") {
    return [
      '<path d="m-13-14-10-10 4 16m32-6 10-10-4 16" fill="#65a30d" stroke="#111827" strokeWidth="2" />',
      '<path d="M-10 5H10L13 25H-13Z" fill="#3f6212" stroke="#111827" strokeWidth="2" />',
      '<path d="M-22-8Q-16-29 0-29T22-8L17 8H-17Z" fill="currentColor" stroke="#17230b" strokeWidth="3" />',
      '<path d="M-25 6Q0-4 25 6L29 25H-29Z" fill="#365314" stroke="#17230b" strokeWidth="3" />'
    ].includes(line.trim());
  }
  return local === "ui/PetChamber.tsx" && line.includes('"moss-green":');
}

function containsGreenColor(line: string): boolean {
  const colors = [
    ...line.matchAll(/#([\da-f]{6})(?![\da-f])/gi),
    ...line.matchAll(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/[^)]*)?\)/gi)
  ];
  return colors.some((match) => {
    const rgb = match[1]?.length === 6
      ? [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)].map((value) => Number.parseInt(value, 16))
      : [Number(match[1]), Number(match[2]), Number(match[3])];
    return hue(rgb[0]!, rgb[1]!, rgb[2]!) >= 70 && hue(rgb[0]!, rgb[1]!, rgb[2]!) <= 165;
  });
}

function hue(red: number, green: number, blue: number): number {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  if (delta === 0) return 0;
  if (maximum === r) return 60 * (((g - b) / delta) % 6 + 6) % 6;
  if (maximum === g) return 60 * ((b - r) / delta + 2);
  return 60 * ((r - g) / delta + 4);
}
