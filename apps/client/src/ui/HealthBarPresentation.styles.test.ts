import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = `${readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")}\n${readFileSync(fileURLToPath(new URL("./HealthBarTrack.css", import.meta.url)), "utf8")}`;
const theme = `${readFileSync(
  fileURLToPath(new URL("../ashAtlasTheme.css", import.meta.url)),
  "utf8"
)}\n${readFileSync(fileURLToPath(new URL("./GameThemeTokens.css", import.meta.url)), "utf8")}`;
const phone = readFileSync(
  fileURLToPath(new URL("../phoneBottomDock.css", import.meta.url)),
  "utf8"
);

describe("health bar styles", () => {
  it("uses a restrained shared frame and unmistakably green layered fill", () => {
    expect(theme).toContain("--aa-health-frame: #181512");
    expect(theme).toContain("--aa-health-track: #0d0b08");
    expect(theme).toContain("--aa-health-fill-top: #35c766");
    expect(theme).toContain("--aa-health-fill-bottom: #17833c");
    expect(styles).toContain("linear-gradient(180deg, var(--aa-health-fill-top), var(--aa-health-fill-bottom))");
    expect(styles).toContain("clip-path: polygon(");
  });

  it("keeps restrained transition timing and a reduced-motion fallback", () => {
    expect(styles).toContain("transition: width 160ms");
    expect(styles).toContain("transition: width 400ms");
    expect(styles).toContain("325ms");
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.hp-bar-damage-trail \{ display: none; \}/
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.hp-bar-track\.is-critical[\s\S]*animation: none;/
    );
  });

  it("retains readable desktop, target, and phone size differences", () => {
    expect(styles).toContain(".status-bar-track { height: 11px;");
    expect(styles).toMatch(/\.combat-health-track\s*\{\s*height: 9px;/);
    expect(phone).toContain("height: var(--phone-dock-resource-track-height);");
    expect(phone).toContain("height: var(--phone-dock-secondary-track-height);");
  });
});
