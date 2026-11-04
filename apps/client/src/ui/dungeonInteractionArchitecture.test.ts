import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const client = readFileSync(
  fileURLToPath(new URL("../client/domains/dungeonClient.ts", import.meta.url)),
  "utf8"
);

describe("dungeon object interaction architecture", () => {
  it("walks to out-of-range fixtures and interacts on arrival from a single action", () => {
    expect(app).not.toContain('key: "approach-fixture"');
    expect(app).not.toContain('label: "Approach"');
    expect(app).toContain('key: "interact-fixture"');
    expect(app).toContain("label: dungeonObjectActionLabel(currentSelectedDungeonObject)");
    expect(app).toContain("setPendingDungeonInteraction({");
    expect(app).toContain("clientRef.current?.dungeonInteract(");
    // Arrival completes the interaction instead of re-opening a second prompt.
    const arrival = app.indexOf("Arrived: complete the single walk-then-act action");
    expect(arrival).toBeGreaterThanOrEqual(0);
    expect(app.slice(arrival, arrival + 500)).toContain("dungeonInteract(dungeonSnapshot.sessionId, object.id)");
    expect(app.slice(arrival, arrival + 500)).not.toContain("setSelectedDungeonObject(object)");
    expect(client).toContain('type: "DUNGEON_INTERACT"');
  });

  it("keeps portals on the universal portal controller", () => {
    expect(app).toContain('key: "use-portal"');
    expect(app).toContain("clientRef.current?.usePortal(portalId)");
    expect(app).toContain('dungeonSnapshot.portalLocks[currentSelectedDungeonObject.portalId] === true');
    expect(app).toContain('"This passage is currently locked."');
  });

  it("routes world dungeon entrance actions through the universal portal controller", () => {
    expect(app).toContain('key: "enter"');
    expect(app).toContain("const portalId = selectedDungeonEntrance.portalId");
    expect(app).toContain("setSelectedDungeonEntranceId(null)");
    expect(app).toContain(
      "clientRef.current?.usePortal(portalId, selectedDungeonEntrance.portalRevision)"
    );
    const entranceActionStart = app.indexOf("const portalId = selectedDungeonEntrance.portalId");
    expect(entranceActionStart).toBeGreaterThanOrEqual(0);
    expect(app.slice(entranceActionStart, entranceActionStart + 600))
      .not.toContain("CISTERN_WARRENS_CLOSURE_MESSAGE");
  });

  it("refreshes an open prompt from the current object snapshot and closes missing objects", () => {
    expect(app).toContain("dungeonSnapshot.objects.find((object) => object.id === selectedDungeonObject.id)");
    expect(app).toContain("if (dungeonSnapshot && selectedDungeonObject && !currentSelectedDungeonObject)");
    expect(app).toContain("if (dungeonSnapshot && currentSelectedDungeonObject)");
  });
});
