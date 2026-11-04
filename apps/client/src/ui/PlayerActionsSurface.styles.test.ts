import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../ashAtlasTheme.css", import.meta.url), "utf8");
const component = readFileSync(new URL("./PlayerActionsSurface.tsx", import.meta.url), "utf8");

describe("PlayerActionsSurface styles", () => {
  it("delegates the action layout to the canonical compact prompt", () => {
    expect(component).toContain("<GameActionPrompt");
    expect(component).not.toContain("player-actions-primary-actions");
    expect(styles).toMatch(/\.player-actions-prompt-stack > \.game-compact-prompt/);
  });

  it("uses the established bronze treatment for sent feedback", () => {
    expect(theme).toMatch(
      /\.player-actions-success\s*\{[^}]*border:\s*1px solid var\(--aa-ui-active-bronze\);[^}]*background:\s*var\(--aa-ui-active-bronze\);/s
    );
    expect(theme).toMatch(/\[data-action-key="travel-invite"\]/);
  });
});
