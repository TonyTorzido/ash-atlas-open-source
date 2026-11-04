import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const desktop = readFileSync(
  new URL("../ui/FlagAccessControls.tsx", import.meta.url),
  "utf8"
);
const mobile = readFileSync(
  new URL("../ui/MobileFlagActionSheet.tsx", import.meta.url),
  "utf8"
);

describe("Atlas Shrine jump request architecture", () => {
  it("keeps access diagnostics out of desktop and mobile travel commands", () => {
    expect(desktop).not.toContain("props.accessTraceId");
    expect(mobile).not.toContain("accessTraceId");
    expect(desktop).toContain(
      "props.onVisitFlag(props.flag.id, access.decision.tollGold)"
    );
    expect(mobile).toContain(
      "props.onVisit(props.flag.id, visitAction.expectedTollGold)"
    );
    expect(mobile).toMatch(/const visitAction =\s*access\s*\?\s*resolveFlagVisitAction\(\{\s*flag:\s*props.flag,\s*access,/);
  });

  it("installs World Map Atlas Shrine arrival bookkeeping with the prepared ID", () => {
    expect(app).toMatch(
      /destination\.kind === "atlas_shrine"[\s\S]*?visitWorldMapAtlasShrine\([\s\S]*?destination\.id,\s*requestId[\s\S]*?recordFlagTravelClicked\([\s\S]*?committedRequestId[\s\S]*?beginUnwatchedTravelRequest\(committedRequestId\)/
    );
    expect(app).toMatch(/const beginUnwatchedTravelRequest = useCallback\(\(requestId: string\): void => \{[^}]*pendingTravelRequestIdRef\.current = requestId;/);
  });
});
