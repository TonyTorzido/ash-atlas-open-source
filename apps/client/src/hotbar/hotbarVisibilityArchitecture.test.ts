import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("GameApp hotbar visibility ownership", () => {
  it("keeps one default-open App state wired to the PhoneHud toggle and Hotbar rails", () => {
    expect(app).toContain("const [hotbarVisible, setHotbarVisible] = useState(true);");
    expect(app).toContain("hotbarVisible={hotbarVisible}");
    expect(app).toContain("hotbarRowPositions={hotbarRowPositions}");
    expect(app).toContain("onToggleHotbar={() => setHotbarVisible((visible) => !visible)}");
    expect(app).toContain("visible={hotbarVisible && !rulerMode}");
  });

  it("queues newer layout edits until the in-flight save settles", () => {
    expect(app).toContain("const [hotbarSaveWake, setHotbarSaveWake] = useState(0);");
    expect(app).toContain("const hotbarPendingLayoutRef = useRef<{");
    expect(app).toContain("hotbarPendingLayoutRef.current = normalized;");
    expect(app).toContain("if (hotbarPendingLayoutRef.current === null)");
    expect(app).toContain("if (wakePendingSave) setHotbarSaveWake((current) => current + 1);");
    expect(app).toMatch(/: hotbarPendingSlots \|\| hotbarPendingLayout\s*\n\s*\? "saving"/);
  });
});
