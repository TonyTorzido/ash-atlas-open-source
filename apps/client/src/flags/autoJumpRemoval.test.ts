import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const buildHandler = readFileSync(
  `${sourceRoot}/features/flags/flagBuildFrameHandler.ts`,
  "utf8"
);

describe("built-flag auto-jump removal", () => {
  it("keeps authoritative flag creation in place without issuing travel", () => {
    const handler = readFileSync(`${sourceRoot}/features/flags/useFlagFrameHandler.ts`, "utf8");
    const createdDispatch = handler.slice(
      handler.indexOf('case "FLAG_CREATED"'),
      handler.indexOf('case "FLAG_UPSERTED"')
    );
    const createdCase = buildHandler.slice(buildHandler.indexOf('case "FLAG_CREATED"'));
    expect(createdDispatch).toContain("return handleFlagBuildFrame(message");
    expect(createdCase).toContain("upsertFlagSnapshot");
    for (const source of [createdDispatch, createdCase]) {
      expect(source).not.toContain("showActionError");
      expect(source).not.toContain("visitFlag(");
      expect(source).not.toMatch(/auto.?jump/i);
    }
  });

  it("retains manual flag travel and removes preference plumbing", () => {
    const app = readFileSync(`${sourceRoot}/App.tsx`, "utf8");
    const phoneHud = readFileSync(`${sourceRoot}/ui/PhoneHud.tsx`, "utf8");
    const bottomBar = readFileSync(`${sourceRoot}/ui/BottomActionBar.tsx`, "utf8");
    expect(app).toMatch(/const visitFlag = \(\s*flagId: string,\s*expectedTollGold\?: string,/);
    expect(app).toMatch(
      /clientRef\.current\?\.commitVisibleFlagVisit\(\s*flagId,\s*authority,\s*requestId,/
    );
    expect(`${app}\n${phoneHud}\n${bottomBar}`).not.toMatch(/autoJump|auto-jump/i);
    expect(app).not.toContain("ashAtlas.autoJumpToBuiltFlags");
  });

  it("does not install builder or Resource Vision authority", () => {
    const app = readFileSync(`${sourceRoot}/App.tsx`, "utf8");
    const handler = readFileSync(
      `${sourceRoot}/features/flags/useFlagFrameHandler.ts`,
      "utf8"
    );
    const createdDispatch = handler.slice(
      handler.indexOf('case "FLAG_CREATED"'),
      handler.indexOf('case "FLAG_UPSERTED"')
    );
    const createdCase = buildHandler.slice(buildHandler.indexOf('case "FLAG_CREATED"'));
    expect(app).not.toContain("onBuilderPromoted:");
    for (const source of [createdDispatch, createdCase]) {
      expect(source).not.toContain("setResourceVision(");
      expect(source).not.toContain("resourceVisionRevision");
    }
  });
});
