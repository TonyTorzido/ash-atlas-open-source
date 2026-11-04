import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  fileURLToPath(new URL("../../App.tsx", import.meta.url)),
  "utf8"
);

describe("World Map travel navigation", () => {
  it("keeps the overlay mounted while sending and closes phone travel directly to gameplay", () => {
    expect(appSource).toMatch(
      /const completeWorldMapTravel[\s\S]*?mobileMenuNavigation\.close\(\);[\s\S]*?\}, \[/
    );
    const completionStart = appSource.indexOf("const completeWorldMapTravel");
    const completion = appSource.slice(
      completionStart,
      appSource.indexOf("  const closeCollectiblePrompt", completionStart)
    );
    expect(completion).toContain("localPlayerRef.current");
    expect(completion).toContain("window.requestAnimationFrame");
    expect(completion).toMatch(/centerCamera\(\s*"recenter"\s*,/);
    const travelHandler = appSource.slice(
      appSource.indexOf("onTravel={(destination: WorldMapDestination)"),
      appSource.indexOf("onPresentationComplete=")
    );
    expect(travelHandler).not.toContain("setWorldMapOpen(false)");
    expect(travelHandler).not.toContain("mobileMenuNavigation.back()");
    expect(travelHandler).toContain("worldMapTravel.begin");
  });
});
